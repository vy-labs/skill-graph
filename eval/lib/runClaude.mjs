// Spawns a REAL headless `claude` process against a sandbox and returns the governor's decision log.
//
// The agent runs as its own top-level (lead) session — which matters: the governor only governs the
// lead session (subagents pass through), so a live eval MUST drive a genuine claude process, not a
// subagent. We pre-allow the tools the agent needs via --allowedTools so Claude Code's own permission
// layer never interferes; that leaves the skill-graph hook as the sole governor of the run.

import { spawnSync } from "node:child_process"
import { readFileSync } from "node:fs"

const MODEL = process.env.EVAL_MODEL || "haiku" // fast + cheap; override with EVAL_MODEL=sonnet etc.

// Tools the eval agent may use. The skill-graph hook — not this list — decides what is allowed WHERE.
const ALLOWED = ["Skill", "Read", "Grep", "Glob", "Write", "Edit", "Bash"]

/** Run one scenario. Returns { entries, raw, status, stderr }. `entries` are the parsed JSONL log lines. */
export function runScenario({ dir, logPath, prompt }) {
  const args = [
    "-p",
    prompt,
    "--model",
    MODEL,
    "--output-format",
    "stream-json",
    "--verbose",
    "--allowedTools",
    ...ALLOWED,
    "--settings",
    join_settings(dir),
  ]
  const res = spawnSync("claude", args, {
    cwd: dir,
    encoding: "utf8",
    env: { ...process.env, SKILL_GRAPH_EVAL_LOG: logPath },
    maxBuffer: 32 * 1024 * 1024,
    timeout: 180_000,
  })

  let entries = []
  try {
    entries = readFileSync(logPath, "utf8")
      .split("\n")
      .filter(Boolean)
      .map((l) => JSON.parse(l))
  } catch {
    /* no log → run never triggered the hook */
  }
  return { entries, raw: res.stdout ?? "", status: res.status, stderr: res.stderr ?? "" }
}

// The sandbox already writes .claude/settings.json; passing it explicitly via --settings makes the
// wiring independent of Claude Code's project-trust prompt in headless mode.
function join_settings(dir) {
  return `${dir}/.claude/settings.json`
}
