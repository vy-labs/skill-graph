// Installer logic for `skill-graph init` / `uninstall`. The tricky parts (building the hook command,
// merging it into an existing settings.json without clobbering or duplicating, and removing exactly
// what we added) are PURE functions on plain objects/strings, exported for unit tests. The IO wrappers
// (runInit/runUninstall) read/write files and return a summary the CLI prints; they never prompt —
// the CLI resolves all choices first and passes them in.

import { readFileSync, writeFileSync, copyFileSync, mkdirSync, existsSync } from "node:fs"
import { join, dirname, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { homedir } from "node:os"
import { discoverWorkflowFiles } from "./core.mjs"

// The package root (…/skill-graph), resolved from this file's location: adapters/install.mjs → up one.
export const PACKAGE_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "..")

const ADAPTER_FILE = { claude: "claude-code.mjs", codex: "codex.mjs" }

// A hook whose command references one of our adapters, regardless of path style (relative node_modules
// path or an absolute install path). Used to detect an already-installed hook (idempotent merge) and
// to remove exactly our hooks on uninstall — without touching a user's own hooks.
export const OUR_HOOK_RE = /skill-graph[/\\]adapters[/\\](?:claude-code|codex)\.mjs/

export const isOurCommand = (command) => typeof command === "string" && OUR_HOOK_RE.test(command)

/**
 * The `command` string for a hook entry.
 *   scope "project" → a relative node_modules path, so a committed settings.json works for teammates.
 *   scope "global"  → an absolute path into this install, since there's no project-local node_modules.
 * Codex passes the event name as an argument; Claude Code does not.
 */
export function hookCommand({ harness, event, scope, packageDir = PACKAGE_DIR }) {
  const file = ADAPTER_FILE[harness]
  if (!file) throw new Error(`unknown harness: ${harness}`)
  const path = scope === "global" ? join(packageDir, "adapters", file) : `node_modules/skill-graph/adapters/${file}`
  const base = `node ${path}`
  return harness === "codex" ? `${base} ${event}` : base
}

/** A settings.json hook-group for one event. PreToolUse matches every tool ("*"); SessionStart has no matcher. */
export function hookGroup(event, command) {
  const hooks = [{ type: "command", command }]
  return event === "PreToolUse" ? { matcher: "*", hooks } : { hooks }
}

/**
 * Merge our hook for `event` into a settings object. Pure: returns { settings, action }.
 *   - if a skill-graph hook already exists for this event, its command is updated in place → "updated"
 *   - otherwise our group is appended → "added"
 * A deep clone is returned; the input is untouched.
 */
export function mergeHook(settings, event, command) {
  const next = structuredClone(settings ?? {})
  next.hooks ??= {}
  const groups = (next.hooks[event] ??= [])
  let updated = false
  for (const g of groups) {
    for (const h of g.hooks ?? []) {
      if (isOurCommand(h.command)) {
        h.command = command
        updated = true
      }
    }
  }
  if (!updated) groups.push(hookGroup(event, command))
  return { settings: next, action: updated ? "updated" : "added" }
}

/**
 * Remove every skill-graph hook from a settings object, dropping groups and event arrays that become
 * empty (and the `hooks` key if it empties out). Pure: returns { settings, removed }.
 */
export function removeHooks(settings) {
  const next = structuredClone(settings ?? {})
  let removed = 0
  const hooks = next.hooks
  if (!hooks) return { settings: next, removed }
  for (const event of Object.keys(hooks)) {
    const groups = hooks[event]
    if (!Array.isArray(groups)) continue
    for (const g of groups) {
      const before = (g.hooks ?? []).length
      if (g.hooks) g.hooks = g.hooks.filter((h) => !isOurCommand(h.command))
      removed += before - (g.hooks?.length ?? 0)
    }
    hooks[event] = groups.filter((g) => (g.hooks?.length ?? 0) > 0)
    if (hooks[event].length === 0) delete hooks[event]
  }
  if (Object.keys(hooks).length === 0) delete next.hooks
  return { settings: next, removed }
}

/** Add `.skill-graph/.state/` to a .gitignore body if absent. Pure string op; returns the new body (or null if unchanged). */
export function ensureGitignore(body) {
  const line = ".skill-graph/.state/"
  const lines = (body ?? "").split("\n")
  if (lines.some((l) => l.trim() === line || l.trim() === ".skill-graph/.state")) return null
  const trimmed = (body ?? "").replace(/\n+$/, "")
  return (trimmed ? trimmed + "\n" : "") + line + "\n"
}

/** Where the settings file lives for a harness + scope. An explicit override wins. */
export function settingsPath({ harness, scope, cwd = process.cwd(), home = homedir(), override = null }) {
  if (override) return resolve(cwd, override)
  const dir = harness === "codex" ? ".codex" : ".claude"
  return scope === "global" ? join(home, dir, "settings.json") : join(cwd, dir, "settings.json")
}

/** A minimal, correct starter workflow (factory form → no import needed, loads anywhere). */
export function starterWorkflow() {
  return `// A starter skill-graph workflow. Edit freely.
// Docs: https://github.com/vy-labs/skill-graph  (see README.md and docs/dsl.md)
//
// Factory form: (sg) => workflow. It needs no "skill-graph" import, so it loads even when the file
// lives outside node_modules. The governor discovers any *.workflow.{mjs,js} under .skill-graph/.
export default (sg) => {
  const wf = sg.workflow("my-flow")

  const explore = wf.skill("explore", { allowedTools: ["Read", "Grep", "Glob"], doneWhen: sg.fileExists("NOTES.md") })
  const build = wf.skill("build", { allowedTools: ["Edit", "Write", "Read", "Bash"] })
  const verify = wf.skill("verify", { allowedTools: ["Bash", "Read"], loop: { max: 3 } })
  const done = wf.skill("done", { allowedTools: ["Read"] })

  explore.then(build) // explore is gated: it can't complete until NOTES.md exists
  build.then(verify)
  verify.loopTo(build) // a failing check loops back to build (bounded by loop.max)
  verify.edge(done, { when: sg.shell("npm test") }) // passing tests unlock done — edit this command

  wf.root(explore)
  return wf
}
`
}

function readJson(file) {
  try {
    return JSON.parse(readFileSync(file, "utf8"))
  } catch {
    return null // absent or unparseable → treat as empty (caller decides)
  }
}

function writeJson(file, obj) {
  mkdirSync(dirname(file), { recursive: true })
  writeFileSync(file, JSON.stringify(obj, null, 2) + "\n")
}

/**
 * Wire the hook(s) into settings, optionally scaffold a workflow and gitignore the state dir.
 * `opts`: { harness, scope, cwd, home, settingsOverride, sessionStart, scaffold, dryRun }.
 * Returns { actions: string[], warnings: string[], settingsFile }. Writes nothing when dryRun.
 */
export function runInit(opts) {
  const { harness, scope, cwd = process.cwd(), home = homedir(), settingsOverride = null, sessionStart = false, scaffold = true, dryRun = false } = opts
  const actions = []
  const warnings = []
  const file = settingsPath({ harness, scope, cwd, home, override: settingsOverride })

  // Warn if a global-scope absolute path points into an ephemeral (npx) install that won't persist.
  if (scope === "global" && /[/\\](?:_npx|\.npm[/\\]_npx)[/\\]/.test(PACKAGE_DIR))
    warnings.push("global scope writes an absolute path into this install, but it looks like an ephemeral npx cache. Install the package persistently (npm i -g github:vy-labs/skill-graph) before wiring a global hook.")

  const existing = readJson(file)
  if (existing && typeof existing !== "object") warnings.push(`${file} is not a JSON object; leaving it untouched.`)

  let settings = existing && typeof existing === "object" ? existing : {}
  const events = ["PreToolUse", ...(sessionStart ? ["SessionStart"] : [])]
  for (const event of events) {
    const command = hookCommand({ harness, event, scope })
    const { settings: merged, action } = mergeHook(settings, event, command)
    settings = merged
    actions.push(`${action === "added" ? "add" : "update"} ${event} hook → ${command}`)
  }

  const backup = existing != null ? file + ".bak" : null
  if (!dryRun) {
    if (backup) copyFileSync(file, backup)
    writeJson(file, settings)
  }
  actions.push(`${dryRun ? "would write" : "wrote"} ${file}${backup ? ` (backup: ${backup})` : ""}`)

  // Scaffold a starter workflow only if the project has none, so we never clutter an existing setup.
  if (scaffold) {
    const hasWorkflow = discoverWorkflowFiles(cwd).length > 0
    if (hasWorkflow) {
      actions.push("skipped scaffold: a workflow already exists under .skill-graph/")
    } else {
      const wfFile = join(cwd, ".skill-graph", "your.workflow.mjs")
      if (!dryRun) {
        mkdirSync(dirname(wfFile), { recursive: true })
        writeFileSync(wfFile, starterWorkflow())
      }
      actions.push(`${dryRun ? "would write" : "wrote"} ${wfFile}`)
    }
  }

  // Gitignore the per-project run-state dir (state lives in the project regardless of hook scope).
  const giFile = join(cwd, ".gitignore")
  const giNext = ensureGitignore(existsSync(giFile) ? readFileSync(giFile, "utf8") : "")
  if (giNext != null) {
    if (!dryRun) writeFileSync(giFile, giNext)
    actions.push(`${dryRun ? "would add" : "added"} .skill-graph/.state/ to .gitignore`)
  }

  return { actions, warnings, settingsFile: file }
}

/** Remove our hooks from a settings file. Returns { actions, settingsFile }. */
export function runUninstall(opts) {
  const { harness, scope, cwd = process.cwd(), home = homedir(), settingsOverride = null, dryRun = false } = opts
  const actions = []
  const file = settingsPath({ harness, scope, cwd, home, override: settingsOverride })
  const existing = readJson(file)
  if (!existing || typeof existing !== "object") {
    actions.push(`no settings to change at ${file}`)
    return { actions, settingsFile: file }
  }
  const { settings, removed } = removeHooks(existing)
  if (removed === 0) {
    actions.push(`no skill-graph hooks found in ${file}`)
    return { actions, settingsFile: file }
  }
  if (!dryRun) {
    copyFileSync(file, file + ".bak")
    writeJson(file, settings)
  }
  actions.push(`${dryRun ? "would remove" : "removed"} ${removed} skill-graph hook(s) from ${file}${dryRun ? "" : ` (backup: ${file}.bak)`}`)
  return { actions, settingsFile: file }
}
