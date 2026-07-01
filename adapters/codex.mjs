#!/usr/bin/env node
// Codex hook adapter for skill-graph. Wire it in your Codex hooks config:
//   PreToolUse / SessionStart → node node_modules/skill-graph/adapters/codex.mjs <EventName>
// (Codex passes the event name as an argument and the payload on stdin.)
//
// Codex implements Claude Code's hook contract, so the OUTPUT envelope matches. The harness-specific
// bits are: the event name may arrive as argv, and Codex's tool vocabulary differs — TOOL_MAP
// translates it to the canonical names workflows use (so one workflow file works across harnesses).
// FAIL-OPEN. Validate exact field names against your Codex version; adjust TOOL_MAP to its tool ids.
//
// Node entry on Codex: unlike Claude Code, a Codex skill is injected context, not a tool call, so it
// fires no hook — the governor would have nothing to observe a transition on. Codex hooks DO fire for
// Bash, so this adapter adopts a sentinel-command convention: the agent runs a no-op shell command
//   : skill-graph enter <node>       (or)   : skill-graph override <node>
// and `parseCodex` rewrites it into the exact `Skill` event the shared reducer already understands.
// This translation lives ONLY here; the reducer and the Claude adapter are untouched.

import { realpathSync } from "node:fs"
import { fileURLToPath } from "node:url"
import { run } from "./core-io.mjs"
import { runGovernor, loadGraphs } from "./core.mjs"

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

// The node-entry sentinel embedded in a shell command: "skill-graph enter <node>" or
// "skill-graph override <node>". Matched anywhere in the command string so the harmless `:` no-op
// prefix (or a bash -lc wrapper) doesn't matter.
export const SENTINEL_RE = /\bskill-graph\s+(enter|override)\s+(\S+)/

// Extract a command string from Codex's shell tool_input across the shapes it may take.
function commandString(toolInput) {
  const c = toolInput?.command ?? toolInput?.cmd
  if (typeof c === "string") return c
  if (Array.isArray(c)) return c.join(" ")
  return ""
}

/** Codex payload (+ argv event) → normalized event. */
export function parseCodex(payload, argv = process.argv) {
  const rawTool = payload.tool_name ?? payload.toolName
  const toolName = TOOL_MAP[rawTool] ?? rawTool
  const toolInput = payload.tool_input ?? payload.toolInput ?? {}
  const base = {
    event: argv[2] ?? payload.hook_event_name ?? payload.hookEventName,
    cwd: payload.cwd ?? process.cwd(),
    sessionId: payload.session_id ?? payload.sessionId ?? "lead",
  }
  // Sentinel node-entry rides the Bash tool (the one Codex reliably hooks). Rewrite it to the canonical
  // Skill event; everything else passes through with the mapped tool name.
  if (toolName === "Bash") {
    const m = SENTINEL_RE.exec(commandString(toolInput))
    if (m) {
      const [, verb, node] = m
      const skillInput = verb === "override" ? { skill: "workflow:override", to: node } : { skill: node }
      return { ...base, toolName: "Skill", toolInput: skillInput }
    }
  }
  return { ...base, toolName, toolInput }
}

/** Neutral decision → Codex envelope (same hookSpecificOutput contract as Claude Code). */
export function formatCodex(decision) {
  if (decision.action === "deny")
    return { hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason: decision.reason } }
  if (decision.action === "context")
    return { hookSpecificOutput: { hookEventName: "SessionStart", additionalContext: decision.context } }
  return null
}

// Injected at SessionStart so the Codex agent knows how to signal node transitions (it can't invoke a
// skill as a tool call the way Claude Code does). Kept out of the shared core so Claude is unaffected.
export const CONVENTION = [
  "This session is governed by skill-graph.",
  "Codex skills are context, not tool calls, so signal workflow transitions with a no-op shell command",
  "the governor intercepts (run it BEFORE doing that node's work):",
  "  : skill-graph enter <node>       enter/adopt a workflow node",
  "  : skill-graph override <node>    escape hatch: force a move (always allowed, recorded)",
  "Begin by entering your workflow's root node.",
].join("\n")

/** Codex governor: same as runGovernor, but SessionStart also injects the node-entry convention. */
export async function codexGovern(ev) {
  if (ev.event === "SessionStart") {
    const graphs = await loadGraphs(ev.cwd).catch(() => [])
    if (graphs.length === 0) return { action: "allow" } // nothing governed here → stay quiet
    const base = await runGovernor(ev) // resume note if a run is already active
    const resume = base.action === "context" ? base.context + "\n\n" : ""
    return { action: "context", context: resume + CONVENTION }
  }
  return runGovernor(ev)
}

if (isEntry()) run(parseCodex, codexGovern, formatCodex)
