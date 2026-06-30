// Generic loop guard for a node's back-edges. This is the SAME proven verdict logic as
// skills/feature-dev/scripts/loop-guard.mjs (feature-dev's real implement⇄verify guard), lifted into
// the framework so any looping node can use it. evaluateGuard/applyRecord are pure and unit-tested.
//
// State shape per looping node: { maxIter, history: [{ n, status: "pass"|"fail", signature }] }.
// Termination is NOT a model judgment: this decides proceed/stop deterministically.

/** Deterministic verdict from a loop state. No I/O. (Mirrors loop-guard.mjs:evaluateGuard.) */
export function evaluateGuard(state) {
  const maxIter = state.maxIter ?? 5
  const history = state.history ?? []
  const last = history[history.length - 1]

  // A passing iteration ends the loop successfully — the caller proceeds (e.g. to ship).
  if (last && last.status === "pass") return { verdict: "proceed", reason: "passed", iteration: history.length, maxIter }
  // Hard cap: never exceed maxIter attempts (the --max-iter runaway-spend valve).
  if (history.length >= maxIter) return { verdict: "stop", reason: "max-iter", iteration: history.length, maxIter }
  // No-progress: two consecutive failures with the SAME signature → reflection found nothing new.
  const prev = history[history.length - 2]
  if (last && prev && last.status === "fail" && prev.status === "fail" && last.signature && last.signature === prev.signature)
    return { verdict: "stop", reason: "no-progress", iteration: history.length, maxIter }
  return { verdict: "proceed", reason: "continue", iteration: history.length, maxIter }
}

/** Append an iteration to a loop state (pure; returns the new state). (Mirrors loop-guard.mjs:applyRecord.) */
export function applyRecord(state, { status, signature }) {
  if (status !== "pass" && status !== "fail") throw new Error(`status must be pass|fail, got ${status}`)
  const history = [...(state.history ?? [])]
  history.push({ n: history.length + 1, status, signature: signature ?? null })
  return { ...state, history }
}
