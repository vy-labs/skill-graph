// Pure session-governor reducer: (graph, state, toolEvent, probe) -> { action, reason?, next }.
//
// All IO — predicate evaluation, current session id, the clock — is performed by the hook adapter and
// passed in via `probe`, so this function touches nothing and is fully unit-testable. Every guarantee
// (a join waits, a loop is capped, an off-graph call is denied) is an explicit branch that returns a
// `deny`; there is no "should" the model can talk past.
//
// See docs/specs/2026-06-29-skill-graph-workflow-framework.md.

import { evaluateGuard, applyRecord } from "./loop.mjs"

export const OVERRIDE_SKILL = "workflow:override"
export const edgeKey = (from, to) => `${from}->${to}`

const uniq = (a) => [...new Set(a)]
// Structural parents only: back-edges are loops, not dependencies, so they must not participate in
// join/readiness — otherwise a loop target could never be entered.
const parentsOf = (graph, name) => graph.edges.filter((e) => e.to === name && !e.back).map((e) => e.from)

// Forward-reachable nodes from `start` (over non-back edges), inclusive. A back-edge to `start` resets
// this whole set in `completed` so the loop body is genuinely redone.
function downstream(graph, start) {
  const seen = new Set([start])
  const q = [start]
  while (q.length) {
    const n = q.shift()
    for (const e of graph.edges) if (e.from === n && !e.back && !seen.has(e.to)) (seen.add(e.to), q.push(e.to))
  }
  return seen
}

export function joinSatisfied(join, parents, completed) {
  if (parents.length === 0) return true
  return join === "any" ? parents.some((p) => completed.includes(p)) : parents.every((p) => completed.includes(p))
}

const deny = (state, reason) => ({ action: "deny", reason, next: state })

export function initialState(graph, leadSessionId) {
  return { workflow: graph.name, leadSessionId, active: [graph.root], completed: [], loops: {}, overrides: [] }
}

// Fold in any done_when-satisfied completions, then recompute the frontier: a non-completed node joins
// `active` once its (forward) parents satisfy its join via an UNGUARDED, non-loop edge. Guarded targets
// are reached by explicit transition instead, so they don't auto-activate here.
function refresh(graph, state, probe) {
  const completed = [...state.completed]
  for (const name of Object.keys(graph.nodes)) {
    const n = graph.nodes[name]
    if (n.doneWhen && probe.doneWhen?.[name] === true && !completed.includes(name)) completed.push(name)
  }
  const ready = []
  for (const name of Object.keys(graph.nodes)) {
    if (completed.includes(name)) continue
    const parents = parentsOf(graph, name)
    if (parents.length === 0) continue // root: seeded into active, never auto-readied
    if (!joinSatisfied(graph.nodes[name].join, parents, completed)) continue
    const enabled = graph.edges.some((e) => e.to === name && !e.back && e.when == null && completed.includes(e.from))
    if (enabled) ready.push(name)
  }
  const active = uniq([...state.active.filter((n) => !completed.includes(n)), ...ready])
  return { ...state, completed, active }
}

function skillTarget(ev) {
  if (ev.toolName !== "Skill") return null
  const ti = ev.toolInput || {}
  return ti.skill ?? ti.name ?? null
}

function legalNext(graph, state, probe) {
  const set = new Set(state.active)
  for (const e of graph.edges) {
    if (!state.active.includes(e.from)) continue
    const key = edgeKey(e.from, e.to)
    if (e.when && probe.guards?.[key] !== true) continue
    if (!e.back && !joinSatisfied(graph.nodes[e.to].join, parentsOf(graph, e.to), state.completed)) continue
    set.add(e.to)
  }
  return [...set]
}

function override(graph, state, ev) {
  const to = ev.toolInput?.to ?? null
  const overrides = [...state.overrides, { at: state.active.join(","), to, reason: ev.toolInput?.reason ?? "", ts: probe_now(ev) }]
  let { completed, active } = state
  if (to && graph.nodes[to]) {
    // Unblock: treat the target's parents as completed so the join clears, and put the target on the frontier.
    completed = uniq([...completed, ...parentsOf(graph, to)])
    active = uniq([...active, to])
  }
  return { action: "allow", next: { ...state, overrides, completed, active } }
}
const probe_now = (ev) => ev._now ?? "" // overrides carry a timestamp only if the adapter supplied one

export function decide(graph, state, ev, probe) {
  // 1. Only the lead session is governed; subagents (a different session) pass through untouched.
  //    This is how `allowed_tools` ends up governing the lead's journey and not delegated work.
  if (state && probe.sessionId !== state.leadSessionId) return { action: "allow", next: state }

  const target = skillTarget(ev)

  // 2. No active run: a run starts only when the lead enters THIS graph's root skill.
  if (!state) {
    if (target === graph.root) return { action: "allow", next: initialState(graph, probe.sessionId) }
    return { action: "allow", next: null } // not our workflow — no opinion
  }

  state = refresh(graph, state, probe) // fold completions before deciding

  // 3. Escape hatch: always allowed, logged, optionally unblocks a target.
  if (target === OVERRIDE_SKILL) return override(graph, state, ev)

  // 4. A transition attempt (entering a skill node).
  if (target && graph.nodes[target]) return decideTransition(graph, state, target, probe)
  if (target) return { action: "allow", next: state } // a skill outside this graph — no opinion

  // 5. A plain (non-skill) tool: gated by the active node(s)' allowed_tools.
  return decideTool(graph, state, ev.toolName)
}

function decideTransition(graph, state, target, probe) {
  // Already on the frontier (a fork sibling, or a ready node) → allow without needing an edge.
  if (state.active.includes(target)) return { action: "allow", next: state }

  const edge = graph.edges.find((e) => state.active.includes(e.from) && e.to === target)
  if (!edge)
    return deny(state, `cannot enter "${target}" from [${state.active.join(", ")}]. legal next: ${legalNext(graph, state, probe).join(", ") || "(none)"}`)

  const key = edgeKey(edge.from, target)
  const isBack = !!edge.back
  if (edge.when && probe.guards?.[key] !== true) return deny(state, `"${target}" not enterable yet (guard not satisfied).`)

  let { completed, active, loops } = state
  if (isBack) {
    const src = graph.nodes[edge.from]
    if (src.loop) {
      // Real loop guard (feature-dev's implement⇄verify model): each back-edge is a failing iteration.
      // Record it and let the deterministic guard decide proceed/stop (max-iter OR same-signature
      // no-progress) — the model can't talk past a stop. `probe.signature` is the iteration's failure
      // fingerprint, supplied by the adapter (e.g. the set of failing checks).
      //
      // The cap is re-derived LIVE from the current graph node every call, never trusted from stored
      // state. This is what lets a host raise loop.max (per run, via the adapter override) and resume:
      // history persists in state, but a freshly-raised cap immediately governs the next iteration,
      // so a run stopped at the old cap proceeds once the cap is lifted.
      const prior = state.loops[edge.from] ?? { history: [] }
      const recorded = applyRecord({ history: prior.history ?? [], maxIter: src.loop.max ?? 5 }, { status: "fail", signature: probe.signature ?? null })
      const v = evaluateGuard(recorded)
      if (v.verdict === "stop")
        return deny(state, `loop stopped at "${edge.from}": ${v.reason} (iteration ${v.iteration}/${v.maxIter}). use ${OVERRIDE_SKILL} or stop.`)
      loops = { ...loops, [edge.from]: recorded }
    } else {
      // Simple per-edge cap (no node loop policy): a plain bounded counter.
      if (edge.max != null && (loops[key] ?? 0) >= edge.max)
        return deny(state, `loop budget exhausted at "${edge.from}" (${edge.max}/${edge.max}). use ${OVERRIDE_SKILL} or stop.`)
      loops = { ...loops, [key]: (loops[key] ?? 0) + 1 }
    }
    // Reset the whole loop body (everything forward-reachable from the target) so it is genuinely redone.
    const body = downstream(graph, target)
    completed = completed.filter((n) => !body.has(n))
    active = uniq([...active.filter((n) => n !== edge.from), target])
  } else {
    // Forward: this transition completes the source — but only if it CAN complete (no done_when, or its
    // done_when is already satisfied). Check the target's join against that post-exit set, so a node's
    // own exit can satisfy its successor's join, while an unfinished done_when source fails the join.
    const src = graph.nodes[edge.from]
    const sourceCompletes = src.doneWhen == null || completed.includes(edge.from)
    const effective = sourceCompletes ? uniq([...completed, edge.from]) : completed
    const parents = parentsOf(graph, target)
    if (!joinSatisfied(graph.nodes[target].join, parents, effective))
      return deny(state, `"${target}" waits on: ${parents.filter((p) => !effective.includes(p)).join(", ")}`)
    completed = effective
    active = uniq([...active.filter((n) => n !== edge.from), target])
  }
  return { action: "allow", next: refresh(graph, { ...state, completed, active, loops }, probe) }
}

function decideTool(graph, state, toolName) {
  const restricted = state.active.map((n) => graph.nodes[n]).filter((n) => n && n.allowedTools !== null)
  if (restricted.length === 0) return { action: "allow", next: state } // no active node restricts → open
  if (restricted.every((n) => n.allowedTools.includes(toolName))) return { action: "allow", next: state }
  const allowed = uniq(restricted.flatMap((n) => n.allowedTools))
  return deny(state, `"${toolName}" not permitted at [${state.active.join(", ")}]. allowed: ${allowed.join(", ") || "(skills only)"}`)
}
