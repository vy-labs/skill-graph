// Assertion helpers over the governor decision log (JSONL lines the e2e hook tees). Every scenario
// verdict is derived from what the governor DECIDED during the real run — deterministic given the tool
// calls the agent made — so a wandering model can't make the verdict flaky.
//
// Three verdicts:
//   PASS         — the governor did the right thing (allowed a legal step / denied an illegal one).
//   FAIL         — the governor did the WRONG thing (allowed something it must block, or vice versa).
//   INCONCLUSIVE — the agent never attempted the governed action, so there's nothing to judge. Not a
//                  bug in skill-graph; a hint to tighten the prompt or re-run.

export const PASS = "PASS"
export const FAIL = "FAIL"
export const INCONCLUSIVE = "INCONCLUSIVE"

export const verdict = (v, detail) => ({ verdict: v, detail })

/** Skill-transition attempts for a given node, in log order. */
export const skillEntries = (entries, name) => entries.filter((e) => e.tool === "Skill" && e.target === name)

/** Did the run start? i.e. was the root skill entered and allowed. */
export const enteredAllow = (entries, name) => skillEntries(entries, name).some((e) => e.action === "allow")

/** All deny records (optionally filtered). */
export const denies = (entries, pred = () => true) => entries.filter((e) => e.action === "deny" && pred(e))

/**
 * Classify every attempt to enter `loopNode` as forward (the first, reached normally) vs loop-back
 * (any attempt after we've since passed through `viaNode`). Returns { allowedBacks, deniedBacks }.
 * A back-edge is what the loop guard counts; the cap should allow the first and deny the one that
 * would exceed max.
 */
export function classifyLoopBacks(entries, loopNode, viaNode) {
  let seenViaSinceLoop = false
  let firstLoopNodeSeen = false
  const backs = []
  for (const e of entries) {
    if (e.tool !== "Skill") continue
    if (e.target === viaNode && e.action === "allow") seenViaSinceLoop = true
    if (e.target === loopNode) {
      if (!firstLoopNodeSeen) {
        firstLoopNodeSeen = true // the forward entry — not a back-edge
      } else if (seenViaSinceLoop) {
        backs.push(e) // re-entering the loop node after passing through the via node → a back-edge
        seenViaSinceLoop = false
      }
    }
  }
  return {
    allowedBacks: backs.filter((e) => e.action === "allow"),
    deniedBacks: backs.filter((e) => e.action === "deny"),
  }
}
