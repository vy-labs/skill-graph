import { test } from "node:test"
import assert from "node:assert/strict"
import { parseClaude, formatClaude, isEntry as isEntryClaude } from "../adapters/claude-code.mjs"
import { parseCodex, formatCodex, isEntry as isEntryCodex } from "../adapters/codex.mjs"

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
  assert.deepEqual(formatCodex({ action: "context", context: "ctx" }), {
    hookSpecificOutput: { hookEventName: "SessionStart", additionalContext: "ctx" },
  })
  assert.equal(formatCodex({ action: "allow" }), null)
})

test("claude adapter: parse accepts camelCase aliases and fills defaults", () => {
  const n = parseClaude({ hookEventName: "SessionStart", toolName: "Read", toolInput: { p: 1 } })
  assert.equal(n.event, "SessionStart")
  assert.equal(n.toolName, "Read")
  assert.deepEqual(n.toolInput, { p: 1 })
  assert.equal(n.sessionId, "lead") // default when absent
  assert.equal(typeof n.cwd, "string") // falls back to process.cwd()
})

test("claude adapter: a payload with no tool_input defaults to {}", () => {
  const n = parseClaude({ hook_event_name: "PreToolUse", tool_name: "Bash" })
  assert.deepEqual(n.toolInput, {})
})

test("codex adapter: event falls back to payload when argv has none; unmapped tool passes through", () => {
  const n = parseCodex({ hook_event_name: "SessionStart", tool_name: "custom_tool" }, ["node", "codex.mjs"])
  assert.equal(n.event, "SessionStart") // no argv[2] → payload event
  assert.equal(n.toolName, "custom_tool") // not in TOOL_MAP → unchanged
  assert.deepEqual(n.toolInput, {}) // default
  assert.equal(n.sessionId, "lead")
})

test("codex adapter: falls all the way back to camelCase event + camelCase tool name", () => {
  const n = parseCodex({ hookEventName: "PreToolUse", toolName: "shell" }, ["node", "codex.mjs"])
  assert.equal(n.event, "PreToolUse") // argv[2] and hook_event_name absent → hookEventName
  assert.equal(n.toolName, "Bash") // rawTool resolved from toolName, then mapped
})

test("isEntry: false when imported (argv[1] is the test runner, not this module)", () => {
  assert.equal(isEntryClaude(), false)
  assert.equal(isEntryCodex(), false)
})

test("isEntry: false (no throw) when argv[1] is a path realpathSync cannot resolve", () => {
  const saved = process.argv[1]
  try {
    process.argv[1] = "/definitely/not/a/real/path/xyz-" + "qqq"
    assert.equal(isEntryClaude(), false) // realpathSync throws → caught → false
    assert.equal(isEntryCodex(), false)
    process.argv[1] = "" // falsy short-circuit, realpathSync never called
    assert.equal(isEntryClaude(), false)
    assert.equal(isEntryCodex(), false)
  } finally {
    process.argv[1] = saved
  }
})
