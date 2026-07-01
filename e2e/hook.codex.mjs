#!/usr/bin/env node
// Faithful eval wrapper around the REAL Codex hook pipeline (the Codex counterpart of e2e/hook.mjs).
//
// It runs the identical parse -> govern -> format that adapters/codex.mjs runs as a live Codex hook
// (`parseCodex` -> `codexGovern` -> `formatCodex`), and tees every decision to a JSONL log so the e2e
// can assert on what the governor actually decided. Codex passes the event name as argv[2] and the
// payload on stdin; `parseCodex` already reads argv[2], so wiring is identical to the shipped adapter.
//
// FAIL-OPEN like the real adapter: any error -> emit nothing, exit 0, never break the session.

import { readFileSync, appendFileSync, mkdirSync } from "node:fs"
import { join, dirname } from "node:path"
import { parseCodex, formatCodex, codexGovern } from "../adapters/codex.mjs"
import { branchKey } from "../adapters/core.mjs"

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
  process.exit(0)
}

try {
  const ev = parseCodex(payload) // event comes from process.argv[2], as Codex invokes it
  const decision = await codexGovern(ev)
  const out = formatCodex(decision)

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
      target: ti.skill ?? ti.name ?? null,
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
    /* logging is best-effort */
  }

  if (out) process.stdout.write(JSON.stringify(out))
} catch {
  /* fail open */
}
process.exit(0)
