#!/usr/bin/env node
// skill-graph — set up (or remove) the governor hook in your harness.
//
//   skill-graph init [options]        wire the PreToolUse hook, optionally scaffold a workflow
//   skill-graph uninstall [options]   remove skill-graph hooks the installer added
//
// Interactive when run in a TTY with choices left unspecified; otherwise fully flag-driven, so it
// works in scripts and agents. Nothing is written with --dry-run or --print.

import { createInterface } from "node:readline/promises"
import { readFileSync } from "node:fs"
import { hookCommand, hookGroup, runInit, runUninstall, settingsPath, PACKAGE_DIR } from "../adapters/install.mjs"

const HELP = `skill-graph — wire the governor hook into your harness

Usage:
  skill-graph init [options]
  skill-graph uninstall [options]

Options:
      --harness <claude|codex>   Which harness to wire (default: claude, or ask in a TTY).
      --scope <project|global>   settings.json to edit (default: global). project = ./.claude,
                                 global = ~/.claude.
      --settings <file>          Write to this settings file instead of the scope's default.
      --session-start            Also add the optional SessionStart resume-context hook.
      --no-scaffold              Don't create a starter .skill-graph/your.workflow.mjs.
      --print                    Print the settings snippet and manual steps; write nothing.
      --dry-run                  Show what would change; write nothing.
  -y, --yes                      Accept defaults; never prompt (implied when not a TTY).
  -h, --help                     Show this help.

Examples:
  npx skill-graph init                                 # global hook + starter workflow (asks in a TTY)
  npx skill-graph init --scope project --session-start # project .claude/settings.json, both hooks
  npx skill-graph init --harness codex --print         # print the Codex snippet, change nothing
  npx skill-graph uninstall --scope global             # remove the global hook

Related: skill-graph-mermaid renders a workflow to a diagram.
`

const ALIAS = { "-h": "--help", "-y": "--yes" }

function parseArgs(argv) {
  const o = { cmd: null, harness: null, scope: null, settings: null, sessionStart: false, scaffold: true, print: false, dryRun: false, yes: false, help: false }
  for (let i = 0; i < argv.length; i++) {
    const a = ALIAS[argv[i]] ?? argv[i]
    if (a === "--help") o.help = true
    else if (a === "--harness") o.harness = argv[++i]
    else if (a === "--scope") o.scope = argv[++i]
    else if (a === "--settings") o.settings = argv[++i]
    else if (a === "--session-start") o.sessionStart = true
    else if (a === "--no-scaffold") o.scaffold = false
    else if (a === "--print") o.print = true
    else if (a === "--dry-run") o.dryRun = true
    else if (a === "--yes") o.yes = true
    else if (a.startsWith("-")) fail(`unknown option: ${a}`)
    else if (o.cmd == null) o.cmd = a
    else fail(`unexpected argument: ${a}`)
  }
  return o
}

function fail(msg) {
  process.stderr.write(`skill-graph: ${msg}\n`)
  process.exit(1)
}

const interactive = () => process.stdin.isTTY && process.stdout.isTTY

async function prompt(o) {
  // Only ask for what wasn't passed and has no forced default. --yes / non-TTY skip all prompts.
  if (o.yes || o.print || !interactive()) return o
  const rl = createInterface({ input: process.stdin, output: process.stdout })
  try {
    if (!o.harness) {
      const h = (await rl.question("Harness? [claude]/codex: ")).trim().toLowerCase()
      o.harness = h === "codex" ? "codex" : "claude"
    }
    if (!o.scope) {
      const s = (await rl.question("Scope? project/[global]: ")).trim().toLowerCase()
      o.scope = s === "project" ? "project" : "global"
    }
    if (!o.sessionStart) {
      const ss = (await rl.question("Add optional SessionStart resume hook? y/[n]: ")).trim().toLowerCase()
      o.sessionStart = ss === "y" || ss === "yes"
    }
    if (o.scaffold) {
      const sc = (await rl.question("Scaffold a starter workflow if none exists? [y]/n: ")).trim().toLowerCase()
      o.scaffold = !(sc === "n" || sc === "no")
    }
  } finally {
    rl.close()
  }
  return o
}

// Print the settings snippet + steps for a harness/scope, writing nothing.
function printSnippet(o) {
  const harness = o.harness ?? "claude"
  const scope = o.scope ?? "global"
  const events = ["PreToolUse", ...(o.sessionStart ? ["SessionStart"] : [])]
  const hooks = {}
  for (const event of events) hooks[event] = [hookGroup(event, hookCommand({ harness, event, scope }))]
  const file = settingsPath({ harness, scope, override: o.settings })
  process.stdout.write(`# Merge into ${file}\n\n${JSON.stringify({ hooks }, null, 2)}\n`)
  if (harness === "codex")
    process.stdout.write(`\n# Codex reads hooks from a version-specific location — see the Codex docs, or pass --settings <file> to merge automatically.\n`)
  process.stdout.write(`\n# Then add a workflow under .skill-graph/*.workflow.mjs and start your agent.\n`)
}

function report(title, { actions, warnings = [], settingsFile }) {
  process.stdout.write(`${title}\n`)
  for (const w of warnings) process.stdout.write(`  ! ${w}\n`)
  for (const a of actions) process.stdout.write(`  - ${a}\n`)
}

async function main() {
  const o = parseArgs(process.argv.slice(2))
  if (o.help || !o.cmd) {
    process.stdout.write(HELP)
    return
  }
  if (o.cmd !== "init" && o.cmd !== "uninstall") fail(`unknown command: ${o.cmd}`)
  if (o.harness && o.harness !== "claude" && o.harness !== "codex") fail(`--harness must be claude or codex`)
  if (o.scope && o.scope !== "project" && o.scope !== "global") fail(`--scope must be project or global`)

  if (o.print) {
    printSnippet(o)
    return
  }

  await prompt(o)
  const harness = o.harness ?? "claude"
  const scope = o.scope ?? "global"
  const common = { harness, scope, settingsOverride: o.settings, dryRun: o.dryRun }

  // Codex's hook-config path is version-specific; only auto-merge when the user names the file.
  if (harness === "codex" && !o.settings) {
    process.stdout.write("Codex's hook location varies by version, so I won't guess a file to edit.\n")
    printSnippet({ ...o, harness, scope })
    process.stdout.write("\nRe-run with --settings <file> to merge into a specific Codex settings file.\n")
    return
  }

  if (o.cmd === "init") report(o.dryRun ? "init (dry run):" : "init:", runInit({ ...common, sessionStart: o.sessionStart, scaffold: o.scaffold }))
  else report(o.dryRun ? "uninstall (dry run):" : "uninstall:", runUninstall(common))
}

main()
