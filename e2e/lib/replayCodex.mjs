// Deterministic Codex e2e driver. Codex `exec` is slow and its skills aren't tool calls, so instead of
// driving a live agent we replay a codex-shaped journey — the exact hook payloads a Codex agent would
// produce — through the REAL Codex hook binary (e2e/hook.codex.mjs), and assert on the governor's
// decision log with the SAME scenario checks the live Claude suite uses.
//
// This proves the Codex path end-to-end: the sentinel node-entry translation (parseCodex), codexGovern,
// the shared reducer, the deny envelope, and the tee — invoked the way Codex invokes a PreToolUse hook
// (event via the payload's hook_event_name, payload on stdin).

import { spawnSync } from "node:child_process"
import { readFileSync, writeFileSync, mkdirSync } from "node:fs"
import { join, dirname } from "node:path"
import { fileURLToPath } from "node:url"

const HOOK = join(dirname(fileURLToPath(import.meta.url)), "..", "hook.codex.mjs")

// Journey step builders.
// A Codex node transition rides a no-op shell command carrying the sentinel; parseCodex rewrites it.
export const enter = (node) => ({ send: { tool_name: "shell", tool_input: { command: `: skill-graph enter ${node}` } } })
export const override = (node) => ({ send: { tool_name: "shell", tool_input: { command: `: skill-graph override ${node}` } } })
export const shellCmd = (command) => ({ send: { tool_name: "shell", tool_input: { command } } })
export const applyPatch = (path) => ({ send: { tool_name: "apply_patch", tool_input: { file_path: path } } })
// A real file side effect (so a node's doneWhen / a marker actually holds at the next transition).
export const file = (rel, content = "x") => ({ file: [rel, content] })

/** Replay a journey through the real Codex hook binary; return the parsed decision-log entries. */
export function replayCodex({ dir, logPath, journey }) {
  for (const step of journey) {
    if (step.file) {
      const [rel, content] = step.file
      const p = join(dir, rel)
      mkdirSync(dirname(p), { recursive: true })
      writeFileSync(p, content)
      continue
    }
    // Codex delivers the event in the payload (hook_event_name), not argv — mirror that here.
    const payload = { hook_event_name: "PreToolUse", session_id: "lead", cwd: dir, ...step.send }
    spawnSync(process.execPath, [HOOK], {
      input: JSON.stringify(payload),
      cwd: dir,
      encoding: "utf8",
      env: { ...process.env, SKILL_GRAPH_E2E_LOG: logPath },
    })
  }
  try {
    return readFileSync(logPath, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l))
  } catch {
    return []
  }
}
