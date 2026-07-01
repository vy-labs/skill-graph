import { test } from "node:test"
import assert from "node:assert/strict"
import { spawnSync } from "node:child_process"
import { mkdtempSync, writeFileSync, readFileSync, existsSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  hookCommand,
  hookGroup,
  isOurCommand,
  mergeHook,
  removeHooks,
  ensureGitignore,
  settingsPath,
  starterWorkflow,
} from "../adapters/install.mjs"
import { loadWorkflowFile } from "../adapters/core.mjs"

// ---- pure helpers -----------------------------------------------------------------------------

test("hookCommand: project = relative node_modules path; global = absolute; codex carries the event arg", () => {
  assert.equal(hookCommand({ harness: "claude", event: "PreToolUse", scope: "project" }), "node node_modules/skill-graph/adapters/claude-code.mjs")
  const global = hookCommand({ harness: "claude", event: "PreToolUse", scope: "global", packageDir: "/opt/sg" })
  assert.equal(global, "node /opt/sg/adapters/claude-code.mjs")
  assert.equal(hookCommand({ harness: "codex", event: "PreToolUse", scope: "project" }), "node node_modules/skill-graph/adapters/codex.mjs PreToolUse")
  assert.equal(hookCommand({ harness: "codex", event: "SessionStart", scope: "project" }), "node node_modules/skill-graph/adapters/codex.mjs SessionStart")
})

test("isOurCommand matches either adapter at any path style, and nothing else", () => {
  assert.ok(isOurCommand("node node_modules/skill-graph/adapters/claude-code.mjs"))
  assert.ok(isOurCommand("node /opt/x/skill-graph/adapters/codex.mjs SessionStart"))
  assert.ok(!isOurCommand("node some/other/hook.mjs"))
  assert.ok(!isOurCommand(undefined))
})

test("hookGroup: PreToolUse gets matcher '*'; SessionStart has none", () => {
  assert.deepEqual(hookGroup("PreToolUse", "c"), { matcher: "*", hooks: [{ type: "command", command: "c" }] })
  assert.deepEqual(hookGroup("SessionStart", "c"), { hooks: [{ type: "command", command: "c" }] })
})

test("mergeHook: adds into empty settings without touching input", () => {
  const input = {}
  const { settings, action } = mergeHook(input, "PreToolUse", "CMD")
  assert.equal(action, "added")
  assert.deepEqual(settings.hooks.PreToolUse, [{ matcher: "*", hooks: [{ type: "command", command: "CMD" }] }])
  assert.deepEqual(input, {}) // pure
})

test("mergeHook: preserves a user's existing hook and appends ours", () => {
  const ours = "node node_modules/skill-graph/adapters/claude-code.mjs"
  const input = { hooks: { PreToolUse: [{ matcher: "Bash", hooks: [{ type: "command", command: "user-thing" }] }] } }
  const { settings } = mergeHook(input, "PreToolUse", ours)
  assert.equal(settings.hooks.PreToolUse.length, 2)
  assert.equal(settings.hooks.PreToolUse[0].hooks[0].command, "user-thing")
  assert.ok(isOurCommand(settings.hooks.PreToolUse[1].hooks[0].command))
})

test("mergeHook: is idempotent — a second merge updates our command in place, no duplicate", () => {
  let s = {}
  s = mergeHook(s, "PreToolUse", "OLD").settings
  const { settings, action } = mergeHook(s, "PreToolUse", "node node_modules/skill-graph/adapters/claude-code.mjs")
  // "OLD" isn't recognized as ours, so this is a fresh add; then re-running with a real command updates it.
  assert.equal(action, "added")
  const again = mergeHook(settings, "PreToolUse", "node /new/skill-graph/adapters/claude-code.mjs")
  assert.equal(again.action, "updated")
  const cmds = again.settings.hooks.PreToolUse.flatMap((g) => g.hooks.map((h) => h.command)).filter(isOurCommand)
  assert.equal(cmds.length, 1) // still exactly one of ours
  assert.equal(cmds[0], "node /new/skill-graph/adapters/claude-code.mjs")
})

test("removeHooks: strips ours, keeps the user's, drops emptied groups/events", () => {
  const input = {
    hooks: {
      PreToolUse: [
        { matcher: "Bash", hooks: [{ type: "command", command: "user-thing" }] },
        { matcher: "*", hooks: [{ type: "command", command: "node node_modules/skill-graph/adapters/claude-code.mjs" }] },
      ],
      SessionStart: [{ hooks: [{ type: "command", command: "node node_modules/skill-graph/adapters/claude-code.mjs" }] }],
    },
  }
  const { settings, removed } = removeHooks(input)
  assert.equal(removed, 2)
  assert.equal(settings.hooks.PreToolUse.length, 1)
  assert.equal(settings.hooks.PreToolUse[0].hooks[0].command, "user-thing")
  assert.ok(!("SessionStart" in settings.hooks)) // emptied event dropped
})

test("removeHooks: settings with no hooks is a no-op", () => {
  const { settings, removed } = removeHooks({ other: 1 })
  assert.equal(removed, 0)
  assert.deepEqual(settings, { other: 1 })
})

test("ensureGitignore: adds the state dir once; null when already present", () => {
  const added = ensureGitignore("node_modules\n")
  assert.match(added, /\.skill-graph\/\.state\/\n$/)
  assert.equal(ensureGitignore(added), null) // idempotent
  assert.equal(ensureGitignore(".skill-graph/.state"), null) // tolerates the no-slash variant
})

test("settingsPath: scope + harness + override", () => {
  assert.equal(settingsPath({ harness: "claude", scope: "project", cwd: "/p" }), "/p/.claude/settings.json")
  assert.equal(settingsPath({ harness: "claude", scope: "global", home: "/h" }), "/h/.claude/settings.json")
  assert.equal(settingsPath({ harness: "codex", scope: "project", cwd: "/p" }), "/p/.codex/settings.json")
  assert.equal(settingsPath({ harness: "claude", scope: "global", cwd: "/p", override: "custom.json" }), "/p/custom.json")
})

test("starterWorkflow: loads as a valid graph with the expected shape", async () => {
  const dir = mkdtempSync(join(tmpdir(), "sg-starter-"))
  const f = join(dir, "starter.workflow.mjs")
  writeFileSync(f, starterWorkflow())
  const g = await loadWorkflowFile(f)
  assert.equal(g.root, "explore")
  assert.deepEqual(Object.keys(g.nodes).sort(), ["build", "done", "explore", "verify"])
  assert.ok(g.edges.some((e) => e.from === "verify" && e.to === "build" && e.back)) // the loop
})

// ---- bin: real spawns -------------------------------------------------------------------------

const BIN = new URL("../bin/skill-graph.mjs", import.meta.url).pathname
const run = (args, cwd) => spawnSync(process.execPath, [BIN, ...args], { cwd, encoding: "utf8" })

test("bin init: project scope wires the hook, scaffolds, gitignores; re-run is idempotent", () => {
  const dir = mkdtempSync(join(tmpdir(), "sg-init-"))
  const r = run(["init", "--harness", "claude", "--scope", "project", "-y"], dir)
  assert.equal(r.status, 0)
  const settingsFile = join(dir, ".claude", "settings.json")
  const s = JSON.parse(readFileSync(settingsFile, "utf8"))
  assert.equal(s.hooks.PreToolUse.length, 1)
  assert.match(s.hooks.PreToolUse[0].hooks[0].command, /skill-graph\/adapters\/claude-code\.mjs/)
  assert.ok(!("SessionStart" in s.hooks)) // not requested
  assert.ok(existsSync(join(dir, ".skill-graph", "your.workflow.mjs")))
  assert.match(readFileSync(join(dir, ".gitignore"), "utf8"), /\.skill-graph\/\.state\//)

  // Second run must not duplicate the hook.
  assert.equal(run(["init", "--harness", "claude", "--scope", "project", "-y"], dir).status, 0)
  const s2 = JSON.parse(readFileSync(settingsFile, "utf8"))
  const ours = s2.hooks.PreToolUse.flatMap((g) => g.hooks.map((h) => h.command)).filter((c) => /skill-graph/.test(c))
  assert.equal(ours.length, 1)
})

test("bin init: --session-start adds the second hook; --no-scaffold skips the workflow", () => {
  const dir = mkdtempSync(join(tmpdir(), "sg-init2-"))
  const r = run(["init", "--harness", "claude", "--scope", "project", "--session-start", "--no-scaffold", "-y"], dir)
  assert.equal(r.status, 0)
  const s = JSON.parse(readFileSync(join(dir, ".claude", "settings.json"), "utf8"))
  assert.ok(s.hooks.SessionStart)
  assert.ok(!existsSync(join(dir, ".skill-graph", "your.workflow.mjs")))
})

test("bin init: --dry-run and --print write nothing", () => {
  const dry = mkdtempSync(join(tmpdir(), "sg-dry-"))
  assert.equal(run(["init", "--harness", "claude", "--scope", "project", "--dry-run", "-y"], dry).status, 0)
  assert.ok(!existsSync(join(dry, ".claude", "settings.json")))

  const pr = mkdtempSync(join(tmpdir(), "sg-print-"))
  const r = run(["init", "--harness", "claude", "--scope", "project", "--print"], pr)
  assert.equal(r.status, 0)
  assert.match(r.stdout, /"PreToolUse"/)
  assert.ok(!existsSync(join(pr, ".claude", "settings.json")))
})

test("bin init: codex without --settings prints the snippet and writes nothing", () => {
  const dir = mkdtempSync(join(tmpdir(), "sg-codex-"))
  const r = run(["init", "--harness", "codex", "--scope", "project", "-y"], dir)
  assert.equal(r.status, 0)
  assert.match(r.stdout, /codex\.mjs PreToolUse/)
  assert.ok(!existsSync(join(dir, ".codex", "settings.json")))
})

test("bin uninstall: removes exactly our hook", () => {
  const dir = mkdtempSync(join(tmpdir(), "sg-uninst-"))
  run(["init", "--harness", "claude", "--scope", "project", "--no-scaffold", "-y"], dir)
  const r = run(["uninstall", "--harness", "claude", "--scope", "project"], dir)
  assert.equal(r.status, 0)
  const s = JSON.parse(readFileSync(join(dir, ".claude", "settings.json"), "utf8"))
  assert.ok(!s.hooks || !s.hooks.PreToolUse) // our only hook removed → event dropped
})

test("bin: unknown command and bad option flags fail with a message", () => {
  const dir = mkdtempSync(join(tmpdir(), "sg-bad-"))
  const a = run(["frobnicate"], dir)
  assert.equal(a.status, 1)
  assert.match(a.stderr, /unknown command/)
  const b = run(["init", "--nope"], dir)
  assert.equal(b.status, 1)
  assert.match(b.stderr, /unknown option/)
})
