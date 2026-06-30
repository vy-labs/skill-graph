#!/usr/bin/env node
// Claude Code hook adapter for skill-graph. Wire it in .claude/settings.json:
//   PreToolUse  (matcher "*")  → node node_modules/skill-graph/adapters/claude-code.mjs
//   SessionStart               → node node_modules/skill-graph/adapters/claude-code.mjs
//
// It does ONLY two harness-specific things: parse Claude Code's hook payload into the normalized event,
// and format the neutral decision into Claude Code's envelope. All logic lives in core.mjs.
// FAIL-OPEN: any error → emit nothing, exit 0 (never break a session).

import { realpathSync } from "node:fs"
import { fileURLToPath } from "node:url"
import { run } from "./core-io.mjs"
import { runGovernor } from "./core.mjs"

// True when this file was run directly (a hook), not imported (a test). realpathSync resolves symlinks
// so it still matches import.meta.url under symlinked paths (e.g. macOS /var → /private/var).
function isEntry() {
  try {
    return !!process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)
  } catch {
    return false
  }
}

/** Claude Code payload → normalized event. CC sends snake_case fields on stdin. */
export function parseClaude(payload) {
  return {
    event: payload.hook_event_name ?? payload.hookEventName,
    toolName: payload.tool_name ?? payload.toolName,
    toolInput: payload.tool_input ?? payload.toolInput ?? {},
    cwd: payload.cwd ?? process.cwd(),
    sessionId: payload.session_id ?? payload.sessionId ?? "lead",
  }
}

/** Neutral decision → Claude Code envelope (nested hookSpecificOutput). null = emit nothing (allow). */
export function formatClaude(decision) {
  if (decision.action === "deny")
    return { hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason: decision.reason } }
  if (decision.action === "context")
    return { hookSpecificOutput: { hookEventName: "SessionStart", additionalContext: decision.context } }
  return null
}

if (isEntry()) run(parseClaude, runGovernor, formatClaude)
