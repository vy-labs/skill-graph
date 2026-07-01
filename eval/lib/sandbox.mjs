// Builds a throwaway sandbox project that wires the skill-graph hook the REAL way a Claude Code user
// would: a project .claude/settings.json whose PreToolUse + SessionStart hooks point at the eval hook,
// the sample skills under .claude/skills/, and the sample workflow under .skill-graph/. Each scenario
// gets its own fresh sandbox so runs never share governor state.

import { mkdtempSync, mkdirSync, writeFileSync, copyFileSync, cpSync, readdirSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, dirname } from "node:path"
import { fileURLToPath } from "node:url"

const HERE = dirname(fileURLToPath(import.meta.url))
const EVAL_ROOT = dirname(HERE) // .../eval
const FIXTURES = join(EVAL_ROOT, "fixtures")
const HOOK = join(EVAL_ROOT, "hook.mjs")

/** Create a sandbox project. Returns { dir, logPath }. */
export function makeSandbox() {
  const dir = mkdtempSync(join(tmpdir(), "sg-eval-"))

  // Sample workflow.
  mkdirSync(join(dir, ".skill-graph"), { recursive: true })
  copyFileSync(join(FIXTURES, "ship.workflow.mjs"), join(dir, ".skill-graph", "ship.workflow.mjs"))

  // Sample skills → .claude/skills/<name>/SKILL.md
  const skillsSrc = join(FIXTURES, "skills")
  for (const name of readdirSync(skillsSrc)) {
    cpSync(join(skillsSrc, name), join(dir, ".claude", "skills", name), { recursive: true })
  }

  // A file for the agent to research.
  copyFileSync(join(FIXTURES, "README.md"), join(dir, "README.md"))

  // Hook wiring — the real contract from the top-level README, pointed at eval/hook.mjs (absolute).
  const hookCmd = `node ${JSON.stringify(HOOK).slice(1, -1)}`
  const settings = {
    hooks: {
      PreToolUse: [{ matcher: "*", hooks: [{ type: "command", command: hookCmd }] }],
      SessionStart: [{ hooks: [{ type: "command", command: hookCmd }] }],
    },
  }
  mkdirSync(join(dir, ".claude"), { recursive: true })
  writeFileSync(join(dir, ".claude", "settings.json"), JSON.stringify(settings, null, 2))

  return { dir, logPath: join(dir, ".skill-graph", "eval-log.jsonl") }
}
