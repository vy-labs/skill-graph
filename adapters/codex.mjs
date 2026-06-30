#!/usr/bin/env node
// Codex hook adapter for skill-graph. Wire it in your Codex hooks config:
//   PreToolUse / SessionStart → node node_modules/skill-graph/adapters/codex.mjs <EventName>
// (Codex passes the event name as an argument and the payload on stdin.)
//
// Codex implements Claude Code's hook contract, so the OUTPUT envelope matches. The harness-specific
// bits are: the event name may arrive as argv, and Codex's tool vocabulary differs — TOOL_MAP
// translates it to the canonical names workflows use (so one workflow file works across harnesses).
// FAIL-OPEN. Validate exact field names against your Codex version; adjust TOOL_MAP to its tool ids.

import { realpathSync } from "node:fs"
import { fileURLToPath } from "node:url"
import { run } from "./core-io.mjs"
import { runGovernor } from "./core.mjs"

// True when run directly (a hook), not imported (a test). realpathSync resolves symlinks so it matches
// import.meta.url under symlinked paths (e.g. macOS /var → /private/var).
export function isEntry() {
  try {
    return !!process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)
  } catch {
    return false
  }
}

// Codex tool id → canonical (Claude-style) tool name used in workflow `allowedTools`.
// Adjust to your Codex build's actual tool names.
const TOOL_MAP = {
  shell: "Bash",
  local_shell: "Bash",
  read_file: "Read",
  write_file: "Write",
  apply_patch: "Edit",
}

/** Codex payload (+ argv event) → normalized event. */
export function parseCodex(payload, argv = process.argv) {
  const rawTool = payload.tool_name ?? payload.toolName
  return {
    event: argv[2] ?? payload.hook_event_name ?? payload.hookEventName,
    toolName: TOOL_MAP[rawTool] ?? rawTool,
    toolInput: payload.tool_input ?? payload.toolInput ?? {},
    cwd: payload.cwd ?? process.cwd(),
    sessionId: payload.session_id ?? payload.sessionId ?? "lead",
  }
}

/** Neutral decision → Codex envelope (same hookSpecificOutput contract as Claude Code). */
export function formatCodex(decision) {
  if (decision.action === "deny")
    return { hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason: decision.reason } }
  if (decision.action === "context")
    return { hookSpecificOutput: { hookEventName: "SessionStart", additionalContext: decision.context } }
  return null
}

if (isEntry()) run(parseCodex, runGovernor, formatCodex)
