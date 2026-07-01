#!/usr/bin/env node
// Faithful e2e wrapper around the REAL Claude Code hook pipeline.
//
// It runs the IDENTICAL parse → govern → format that adapters/claude-code.mjs runs as a live hook
// (same functions, imported directly — no governor logic is duplicated here), and additionally TEES
// every decision to a JSONL log. The e2e test then asserts on what the governor actually decided during a
// real agent run, which is deterministic given the tool calls the agent made — independent of whatever
// prose the model emits. The tee is the ONLY thing this file adds; remove it and it is the shipped hook.
//
// WHY a wrapper instead of the shipped adapter directly: the shipped adapter intentionally emits
// nothing on "allow" (a hook must stay quiet), so a passing run leaves no trace to assert on. The log
// gives the e2e test an observation surface without changing the adapter's behavior toward the agent.
//
// FAIL-OPEN like the real adapter: any error → emit nothing, exit 0, never break the agent session.

import { readFileSync, appendFileSync, mkdirSync } from "node:fs"
import { join, dirname } from "node:path"
import { parseClaude, formatClaude } from "../adapters/claude-code.mjs"
import { runGovernor, branchKey } from "../adapters/core.mjs"

const raw = (() => {
  try {
    return readFileSync(0, "utf8")
  } catch {
    process.exit(0)
  }
})()

let payload
try {
  payload = JSON.parse(raw)
} catch {
  process.exit(0) // unreadable input → allow
}

try {
  const ev = parseClaude(payload)
  const decision = await runGovernor(ev)
  const out = formatClaude(decision)

  // Tee: append one JSON line describing this decision plus the resulting persisted frontier.
  try {
    let state = null
    try {
      state = JSON.parse(readFileSync(join(ev.cwd, ".skill-graph", ".state", `${branchKey(ev.cwd)}.json`), "utf8"))
    } catch {
      /* no run active yet */
    }
    const ti = ev.toolInput || {}
    const record = {
      event: ev.event,
      tool: ev.toolName ?? null,
      target: ti.skill ?? ti.name ?? null, // the skill a Skill call is entering, if any
      path: ti.file_path ?? ti.path ?? ti.filePath ?? null,
      action: decision.action,
      reason: decision.reason ?? null,
      active: state?.active ?? null,
      completed: state?.completed ?? null,
    }
    const logPath = process.env.SKILL_GRAPH_E2E_LOG || join(ev.cwd, ".skill-graph", "decisions.jsonl")
    mkdirSync(dirname(logPath), { recursive: true })
    appendFileSync(logPath, JSON.stringify(record) + "\n")
  } catch {
    /* logging is best-effort; never let it affect the decision or the session */
  }

  if (out) process.stdout.write(JSON.stringify(out))
} catch {
  /* fail open */
}
process.exit(0)
