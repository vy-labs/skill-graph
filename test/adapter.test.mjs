import { test } from "node:test"
import assert from "node:assert/strict"
import { parseClaude, formatClaude } from "../adapters/claude-code.mjs"
import { parseCodex, formatCodex } from "../adapters/codex.mjs"

test("claude adapter: parse snake_case payload → normalized event", () => {
  const n = parseClaude({ hook_event_name: "PreToolUse", tool_name: "Bash", tool_input: { command: "ls" }, cwd: "/p", session_id: "s1" })
  assert.deepEqual(n, { event: "PreToolUse", toolName: "Bash", toolInput: { command: "ls" }, cwd: "/p", sessionId: "s1" })
})

test("claude adapter: format deny / context / allow", () => {
  assert.deepEqual(formatClaude({ action: "deny", reason: "no" }), {
    hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason: "no" },
  })
  assert.deepEqual(formatClaude({ action: "context", context: "hi" }), {
    hookSpecificOutput: { hookEventName: "SessionStart", additionalContext: "hi" },
  })
  assert.equal(formatClaude({ action: "allow" }), null)
})

test("codex adapter: event from argv, tool name mapped to canonical", () => {
  const n = parseCodex({ tool_name: "shell", tool_input: { cmd: "ls" }, cwd: "/p", session_id: "s" }, ["node", "codex.mjs", "PreToolUse"])
  assert.equal(n.event, "PreToolUse")
  assert.equal(n.toolName, "Bash") // shell → Bash via TOOL_MAP
})

test("codex adapter: format matches the hookSpecificOutput contract", () => {
  assert.deepEqual(formatCodex({ action: "deny", reason: "x" }), {
    hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason: "x" },
  })
})
