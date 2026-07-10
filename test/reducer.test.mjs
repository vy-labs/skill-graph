import { test } from "node:test"
import assert from "node:assert/strict"
import { workflow, fileExists, shell, marker } from "../src/graph.mjs"
import { decide, initialState, edgeKey, joinSatisfied, matchGlob, matchTool, matchCommand, OVERRIDE_SKILL } from "../src/reducer.mjs"

const LEAD = "sess-lead"
const probe = (over = {}) => ({ sessionId: LEAD, doneWhen: {}, guards: {}, ...over })
const skillEv = (name, input = {}) => ({ toolName: "Skill", toolInput: { skill: name, ...input } })
const toolEv = (toolName) => ({ toolName, toolInput: {} })
const toolEvP = (toolName, toolInput) => ({ toolName, toolInput }) // tool event with a typed input (path, etc.)

// fork/join graph (fluent API): a → (b ∥ c) → d(join all) → e ⇄ f(simple cap) → g
function G() {
  const wf = workflow("t")
  const a = wf.skill("a", { allowedTools: ["AskUserQuestion"] })
  const b = wf.skill("b", { doneWhen: marker("b-done") })
  const c = wf.skill("c", { allowedTools: ["Task", "Read"], doneWhen: fileExists("c.md") })
  const d = wf.skill("d", { join: "all" })
  const e = wf.skill("e", { allowedTools: ["Edit", "Bash"] })
  const f = wf.skill("f")
  const g = wf.skill("g")
  a.fork(b, c)
  d.after(b, c)
  d.then(e)
  e.then(f)
  f.edge(e, { when: shell("t", { fails: true }), max: 2 })
  f.edge(g, { when: shell("t") })
  wf.root(a)
  return wf.toJSON()
}
const g = G()

// linear-with-real-loop graph (the feature-dev shape, generic names):
// scope → ctx → plan → impl → verify ; verify ⇄ impl (bug) ; verify ⇄ plan (wrong) ; verify → ship (pass)
function L() {
  const wf = workflow("L")
  const scope = wf.skill("scope", { allowedTools: ["AskUserQuestion"] })
  const ctx = wf.skill("ctx", { allowedTools: ["Task", "Read"], doneWhen: fileExists("ctx.md") })
  const plan = wf.skill("plan", { doneWhen: fileExists("plan.md") })
  const impl = wf.skill("impl", { allowedTools: ["Edit", "Bash"] })
  const verify = wf.skill("verify", { allowedTools: ["Bash"], loop: { max: 5, noProgress: true } })
  const ship = wf.skill("ship")
  scope.then(ctx); ctx.then(plan); plan.then(impl); impl.then(verify)
  verify.loopTo(impl); verify.loopTo(plan)
  verify.edge(ship, { when: shell("npm test") })
  wf.root(scope)
  return wf.toJSON()
}
const l = L()

test("activation: a run starts only on the root skill", () => {
  assert.deepEqual(decide(g, null, skillEv("a"), probe()).next.active, ["a"])
  assert.equal(decide(g, null, skillEv("b"), probe()).next, null)
})

test("subagent (non-lead session) passes through", () => {
  const st = initialState(g, LEAD)
  assert.equal(decide(g, st, toolEv("Bash"), probe({ sessionId: "worker" })).action, "allow")
})

test("tool gating: deny tool absent from active node's allowedTools, allow listed", () => {
  const st = initialState(g, LEAD) // active [a], allows only AskUserQuestion
  assert.equal(decide(g, st, toolEv("Bash"), probe()).action, "deny")
  assert.equal(decide(g, st, toolEv("AskUserQuestion"), probe()).action, "allow")
})

test("phase-1-gate fidelity: at a delegate node, Bash denied but Task allowed", () => {
  const st = { ...initialState(g, LEAD), active: ["c"] } // c allows Task, Read
  assert.equal(decide(g, st, toolEv("Bash"), probe()).action, "deny")
  assert.equal(decide(g, st, toolEv("Task"), probe()).action, "allow")
})

test("fork: entering one branch puts both on the frontier", () => {
  const r = decide(g, initialState(g, LEAD), skillEv("b"), probe())
  assert.equal(r.action, "allow")
  assert.deepEqual(r.next.active.sort(), ["b", "c"])
})

test("join barrier: denied until both parents complete, then allowed", () => {
  const st = { workflow: "t", leadSessionId: LEAD, active: ["b", "c"], completed: ["a"], loops: {}, overrides: [] }
  const one = decide(g, st, skillEv("d"), probe({ doneWhen: { b: true } }))
  assert.equal(one.action, "deny")
  assert.match(one.reason, /waits on: c/)
  const both = decide(g, st, skillEv("d"), probe({ doneWhen: { b: true, c: true } }))
  assert.equal(both.action, "allow")
})

test("guarded edges + simple loop cap", () => {
  const atF = { workflow: "t", leadSessionId: LEAD, active: ["f"], completed: ["a", "b", "c", "d", "e"], loops: {}, overrides: [] }
  assert.equal(decide(g, atF, skillEv("g"), probe({ guards: { [edgeKey("f", "g")]: true } })).action, "allow")
  assert.equal(decide(g, atF, skillEv("g"), probe({ guards: {} })).action, "deny") // guard false
  const back = decide(g, atF, skillEv("e"), probe({ guards: { [edgeKey("f", "e")]: true } }))
  assert.equal(back.action, "allow")
  assert.equal(back.next.loops[edgeKey("f", "e")], 1)
  const capped = decide(g, { ...atF, loops: { [edgeKey("f", "e")]: 2 } }, skillEv("e"), probe({ guards: { [edgeKey("f", "e")]: true } }))
  assert.equal(capped.action, "deny")
  assert.match(capped.reason, /loop budget exhausted/)
  assert.deepEqual(capped.loop, { reason: "edge-cap", iteration: 2, maxIter: 2 }) // structured loop info
})

// ---- structured deny guidance ----

test("guard deny names the unmet condition, points to override, and carries the raw descriptor", () => {
  const atF = { workflow: "t", leadSessionId: LEAD, active: ["f"], completed: ["a", "b", "c", "d", "e"], loops: {}, overrides: [] }
  const r = decide(g, atF, skillEv("g"), probe({ guards: {} })) // f→g guarded by shell("t"), guard false
  assert.equal(r.action, "deny")
  assert.match(r.reason, /needs: t\b/) // the rendered guard condition
  assert.match(r.reason, /workflow:override/) // escape hatch named
  assert.deepEqual(r.guard, { kind: "shell", cmd: "t", fails: false }) // machine-readable descriptor
})

test("pending lists a guard-closed edge but omits the same edge once its guard is satisfied", () => {
  // Active [f]; an illegal jump to a real-but-unreachable node ("a") triggers the deny+guidance.
  // f→g is guarded by shell("t"): closed → it's pending; open → it drops out (it's legal-now, not pending).
  const atF = { workflow: "t", leadSessionId: LEAD, active: ["f"], completed: ["a", "b", "c", "d", "e"], loops: {}, overrides: [] }
  const closed = decide(g, atF, skillEv("a"), probe({ guards: {} }))
  assert.deepEqual(closed.pending, [{ to: "g", needs: "t" }])
  const open = decide(g, atF, skillEv("a"), probe({ guards: { [edgeKey("f", "g")]: true } }))
  assert.deepEqual(open.pending, []) // guard satisfied → no longer pending
})

test("guard deny falls back to a generic phrase when the predicate has no renderable label", () => {
  const wf = workflow("gx")
  const a = wf.skill("a"), b = wf.skill("b")
  a.edge(b, { when: { kind: "custom" } }) // describe() → "" for an unknown descriptor
  wf.root(a)
  const sg = wf.toJSON()
  const r = decide(sg, initialState(sg, LEAD), skillEv("b"), probe({ guards: {} }))
  assert.equal(r.action, "deny")
  assert.match(r.reason, /needs: an unmet condition/)
})

test("join deny carries waitingOn; tool deny carries allowedTools", () => {
  const joinSt = { workflow: "t", leadSessionId: LEAD, active: ["b", "c"], completed: ["a"], loops: {}, overrides: [] }
  const j = decide(g, joinSt, skillEv("d"), probe({ doneWhen: { b: true } })) // c still pending
  assert.equal(j.action, "deny")
  assert.deepEqual(j.waitingOn, ["c"])

  const t = decide(g, initialState(g, LEAD), toolEv("Bash"), probe()) // active [a] allows AskUserQuestion
  assert.equal(t.action, "deny")
  assert.deepEqual(t.allowedTools, ["AskUserQuestion"])
})

test("real-loop stop carries structured loop info (reason/iteration/maxIter)", () => {
  const st = { ...atVerify(), loops: { verify: { history: [{ n: 1, status: "fail", signature: "same" }] } } }
  const r = decide(l, st, skillEv("impl"), probe({ signature: "same" })) // same signature twice → no-progress
  assert.equal(r.action, "deny")
  assert.equal(r.loop.reason, "no-progress")
  assert.equal(r.loop.maxIter, 5) // live cap from the graph node
})

test("off-graph skill denied with guidance; override always allowed", () => {
  const deny = decide(g, initialState(g, LEAD), skillEv("d"), probe())
  assert.equal(deny.action, "deny")
  assert.match(deny.reason, /cannot enter "d" from \[a\]/)
  const ov = decide(g, initialState(g, LEAD), skillEv(OVERRIDE_SKILL, { to: "d", reason: "manual" }), probe())
  assert.equal(ov.action, "allow")
  assert.equal(ov.next.overrides[0].to, "d")
  assert.ok(ov.next.active.includes("d"))
})

// ---- the real loop (node loop policy) ----
const atVerify = () => ({ workflow: "L", leadSessionId: LEAD, active: ["verify"], completed: ["scope", "ctx", "plan", "impl"], loops: {}, overrides: [] })

test("happy path scope→…→ship", () => {
  const done = { ctx: true, plan: true }
  let st = decide(l, null, skillEv("scope"), probe()).next
  st = decide(l, st, skillEv("ctx"), probe()).next
  st = decide(l, st, skillEv("plan"), probe({ doneWhen: done })).next
  st = decide(l, st, skillEv("impl"), probe({ doneWhen: done })).next
  st = decide(l, st, skillEv("verify"), probe({ doneWhen: done })).next
  const r = decide(l, st, skillEv("ship"), probe({ doneWhen: done, guards: { [edgeKey("verify", "ship")]: true } }))
  assert.equal(r.action, "allow")
})

test("real loop: bug → back to impl, body reset, iteration recorded", () => {
  const r = decide(l, atVerify(), skillEv("impl"), probe({ signature: "A" }))
  assert.equal(r.action, "allow")
  assert.deepEqual(r.next.active, ["impl"])
  assert.ok(!r.next.completed.includes("impl"))
  assert.equal(r.next.loops.verify.history.length, 1)
})

test("real loop: wrong-approach → back to plan, resets plan onward", () => {
  const r = decide(l, atVerify(), skillEv("plan"), probe({ signature: "A" }))
  assert.equal(r.action, "allow")
  assert.deepEqual(r.next.active, ["plan"])
  assert.deepEqual(r.next.completed.sort(), ["ctx", "scope"])
})

test("real loop: max-iter stops", () => {
  const st = { ...atVerify(), loops: { verify: { maxIter: 2, history: [{ n: 1, status: "fail", signature: "x" }] } } }
  const r = decide(l, st, skillEv("impl"), probe({ signature: "y" }))
  assert.equal(r.action, "deny")
  assert.match(r.reason, /loop stopped.*max-iter/)
})

test("real loop: same-signature twice stops as no-progress", () => {
  const st = { ...atVerify(), loops: { verify: { maxIter: 5, history: [{ n: 1, status: "fail", signature: "same" }] } } }
  const r = decide(l, st, skillEv("impl"), probe({ signature: "same" }))
  assert.equal(r.action, "deny")
  assert.match(r.reason, /no-progress/)
})

// ---- remaining decision branches ----

test("subagent passthrough also leaves a null state null (no opinion)", () => {
  // state === null AND non-lead is the `state && ...` short-circuit; the lead-with-null path:
  assert.equal(decide(g, null, toolEv("Bash"), probe()).next, null) // no run, non-skill tool → no opinion
})

test("a Skill entered via toolInput.name (not .skill) still resolves the target", () => {
  const r = decide(g, null, { toolName: "Skill", toolInput: { name: "a" } }, probe())
  assert.deepEqual(r.next.active, ["a"]) // started the run via the `name` alias
})

test("a skill outside this graph, mid-run, gets no opinion (allow, state unchanged)", () => {
  const st = initialState(g, LEAD)
  const r = decide(g, st, skillEv("some-other-skill"), probe())
  assert.equal(r.action, "allow")
  assert.deepEqual(r.next, st) // refresh rebuilds the object; structurally unchanged
})

test("re-entering a node already on the frontier is allowed without an edge", () => {
  const st = { ...initialState(g, LEAD), active: ["b", "c"], completed: ["a"] }
  assert.equal(decide(g, st, skillEv("c"), probe()).action, "allow")
})

test("tool gating: an active node with allowedTools=null leaves all tools open", () => {
  const st = { ...initialState(g, LEAD), active: ["d"] } // d has no allowedTools → unrestricted
  assert.equal(decide(g, st, toolEv("Bash"), probe()).action, "allow")
})

test("tool gating: allowedTools=[] denies every tool with a 'skills only' message", () => {
  const wf = workflow("so")
  const a = wf.skill("a", { allowedTools: [] })
  wf.root(a)
  const sg = wf.toJSON()
  const r = decide(sg, initialState(sg, LEAD), toolEv("Bash"), probe())
  assert.equal(r.action, "deny")
  assert.match(r.reason, /allowed: \(skills only\)/)
})

test("deny guidance: legalNext lists open targets; the guard-closed ship edge is reported as pending", () => {
  // From active [verify], an illegal jump to a real-but-unreachable node ("scope") triggers the
  // deny+guidance path. Loop targets (back-edges bypass the join check) are legal-now; the guarded
  // verify→ship edge isn't open yet, so it surfaces under `pending` with its unlock condition rather
  // than being hidden. (An UNKNOWN skill is instead waved through as "no opinion".)
  const r = decide(l, atVerify(), skillEv("scope"), probe())
  assert.equal(r.action, "deny")
  assert.match(r.reason, /legal next:/)
  assert.deepEqual(r.legalNext.sort(), ["impl", "plan", "verify"]) // active + back-edge targets, ship excluded
  assert.ok(!r.legalNext.includes("ship"))
  assert.deepEqual(r.pending, [{ to: "ship", needs: "npm test" }]) // reachable once the guard passes
  assert.match(r.reason, /pending: ship \(needs npm test\)/)
})

test("forward transition is blocked when the source's done_when is not yet satisfied", () => {
  // At [plan] with plan.md absent, plan cannot complete, so impl's join over [plan] stays unmet.
  const st = { workflow: "L", leadSessionId: LEAD, active: ["plan"], completed: ["scope", "ctx"], loops: {}, overrides: [] }
  const r = decide(l, st, skillEv("impl"), probe({ doneWhen: { plan: false } }))
  assert.equal(r.action, "deny")
  assert.match(r.reason, /"impl" waits on: plan/)
})

test("override with no target just logs (no frontier change) and records a timestamp", () => {
  const st = initialState(g, LEAD)
  const r = decide(g, { ...st, _now: undefined }, { ...skillEv(OVERRIDE_SKILL), _now: "2026-06-30T00:00:00Z" }, probe())
  assert.equal(r.action, "allow")
  assert.equal(r.next.overrides[0].to, null)
  assert.equal(r.next.overrides[0].ts, "2026-06-30T00:00:00Z")
  assert.deepEqual(r.next.active, ["a"]) // unchanged
})

test("override to an unknown node logs but does not move the frontier", () => {
  const r = decide(g, initialState(g, LEAD), skillEv(OVERRIDE_SKILL, { to: "ghost" }), probe())
  assert.equal(r.action, "allow")
  assert.equal(r.next.overrides[0].to, "ghost")
  assert.ok(!r.next.active.includes("ghost"))
})

// ---- boundary branches ----

test("joinSatisfied: any vs all semantics, and a parentless node is vacuously satisfied", () => {
  assert.equal(joinSatisfied("all", ["p", "q"], ["p"]), false)
  assert.equal(joinSatisfied("all", ["p", "q"], ["p", "q"]), true)
  assert.equal(joinSatisfied("any", ["p", "q"], ["p"]), true) // any: one parent suffices
  assert.equal(joinSatisfied("any", ["p", "q"], []), false)
  assert.equal(joinSatisfied("all", [], []), true) // no parents → satisfied
  assert.equal(joinSatisfied("any", [], []), true)
})

test("an 'any' join unlocks as soon as ONE parent completes", () => {
  const wf = workflow("any-join")
  const p = wf.skill("p"), q = wf.skill("q"), d = wf.skill("d", { join: "any" })
  d.after(p, q)
  wf.root(p)
  const sg = wf.toJSON()
  // Active at [p, q] with neither done; entering d completes p, which satisfies the ANY join.
  const st = { workflow: "any-join", leadSessionId: LEAD, active: ["p", "q"], completed: [], loops: {}, overrides: [] }
  assert.equal(decide(sg, st, skillEv("d"), probe()).action, "allow")
})

test("a Skill call with no toolInput at all is handled (skillTarget defaults the input to {})", () => {
  // No state + a Skill event missing toolInput → skillTarget reads `ev.toolInput || {}`, finds no
  // target, and decide gives no opinion (next stays null).
  const r = decide(g, null, { toolName: "Skill" }, probe())
  assert.equal(r.action, "allow")
  assert.equal(r.next, null)
})

test("a Skill call with neither skill nor name resolves to no target", () => {
  // skillTarget falls through to null; with active [a] (allows only AskUserQuestion) the bare
  // 'Skill' tool name itself is then gated and denied — proving target resolution returned null.
  const r = decide(g, initialState(g, LEAD), { toolName: "Skill", toolInput: {} }, probe())
  assert.equal(r.action, "deny")
})

test("deny guidance reads '(none)' when there is no active node to move from", () => {
  const st = { ...initialState(g, LEAD), active: [] }
  const r = decide(g, st, skillEv("b"), probe())
  assert.equal(r.action, "deny")
  assert.match(r.reason, /legal next: \(none\)/)
})

test("real loop: a loop policy without an explicit max defaults the cap to 5", () => {
  const wf = workflow("LD")
  const impl = wf.skill("impl")
  const verify = wf.skill("verify", { loop: { noProgress: true } }) // no max
  impl.then(verify)
  verify.loopTo(impl)
  wf.root(impl)
  const sg = wf.toJSON()
  const st = { workflow: "LD", leadSessionId: LEAD, active: ["verify"], completed: ["impl"], loops: {}, overrides: [] }
  const r = decide(sg, st, skillEv("impl"), probe({ signature: "z" }))
  assert.equal(r.action, "allow")
  assert.equal(r.next.loops.verify.maxIter, 5) // defaulted
})

test("real loop: a back-edge with no probe signature records a null fingerprint", () => {
  const r = decide(l, atVerify(), skillEv("impl"), probe()) // probe() supplies no signature
  assert.equal(r.action, "allow")
  assert.equal(r.next.loops.verify.history[0].signature, null)
})

// ---- workflow-level allowAlways ----

// A one-node graph whose only node forbids everything but AskUserQuestion, plus the given allowAlways.
function AA(rules) {
  const wf = workflow("aa")
  wf.skill("a", { allowedTools: ["AskUserQuestion"] })
  wf.root("a")
  wf.allowAlways(rules)
  return wf.toJSON()
}

test("matchGlob: ** crosses dirs, * stays within a segment, relative glob matches absolute paths", () => {
  assert.equal(matchGlob(".synaptic/**", ".synaptic/a/b.json"), true)
  assert.equal(matchGlob(".synaptic/**", "/Users/x/project/.synaptic/a.json"), true) // segment-boundary suffix
  assert.equal(matchGlob("docs/*.md", "docs/a.md"), true)
  assert.equal(matchGlob("docs/*.md", "docs/a/b.md"), false) // * does not cross /
  assert.equal(matchGlob("a/**/b", "a/x/y/b"), true) // ** across dirs
  assert.equal(matchGlob(".synaptic/**", "src/app.js"), false)
  assert.equal(matchGlob(".synaptic/**", "x.synaptic/a"), false) // boundary, not a partial segment
  assert.equal(matchGlob(".x/**", null), false) // no path → no match
})

test("allowAlways (no paths): the tool is allowed at every node; unrelated tools stay gated", () => {
  const g = AA([{ tool: "Read" }])
  const st = initialState(g, LEAD) // active [a], node allows only AskUserQuestion
  assert.equal(decide(g, st, toolEvP("Read", {}), probe()).action, "allow")
  assert.equal(decide(g, st, toolEvP("Bash", {}), probe()).action, "deny")
})

test("allowAlways (paths): Write to a declared glob is allowed where the node forbids Write; elsewhere denied", () => {
  const g = AA([{ tool: "Write", paths: [".synaptic/**", ".skill-graph/**"] }])
  const st = initialState(g, LEAD)
  assert.equal(decide(g, st, toolEvP("Write", { file_path: ".synaptic/feature-dev-state.json" }), probe()).action, "allow")
  assert.equal(decide(g, st, toolEvP("Write", { file_path: ".skill-graph/.signature" }), probe()).action, "allow")
  assert.equal(decide(g, st, toolEvP("Write", { file_path: "src/app.js" }), probe()).action, "deny") // strong gate holds
})

test("allowAlways (paths): the absolute form of a relative glob matches", () => {
  const g = AA([{ tool: "Write", paths: [".synaptic/**"] }])
  const st = initialState(g, LEAD)
  assert.equal(decide(g, st, toolEvP("Write", { file_path: "/Users/x/project/.synaptic/state.json" }), probe()).action, "allow")
})

test("allowAlways (paths): a path-scoped rule does not grant a tool that carries no path (Bash stays gated)", () => {
  const g = AA([{ tool: "Write", paths: [".synaptic/**"] }])
  const st = initialState(g, LEAD)
  assert.equal(decide(g, st, toolEvP("Bash", {}), probe()).action, "deny")
})

test("allowAlways: the path is read from file_path, path, or filePath", () => {
  const g = AA([{ tool: "Write", paths: [".synaptic/**"] }])
  const st = initialState(g, LEAD)
  assert.equal(decide(g, st, toolEvP("Write", { path: ".synaptic/a" }), probe()).action, "allow")
  assert.equal(decide(g, st, toolEvP("Write", { filePath: ".synaptic/a" }), probe()).action, "allow")
})

test("reducer tolerates a graph with no allowAlways field (older serialization)", () => {
  const g = AA([])
  delete g.allowAlways // simulate a graph serialized before the feature existed
  const st = initialState(g, LEAD)
  assert.equal(decide(g, st, toolEvP("Bash", {}), probe()).action, "deny") // node gating still applies
})

// ---- tool-name glob matching ----

test("matchTool: literal is exact; * globs a family; * alone matches anything", () => {
  // family glob
  assert.equal(matchTool("mcp__*", "mcp__foo__bar"), true)
  assert.equal(matchTool("mcp__*", "mcp__a_b__c-d"), true)
  assert.equal(matchTool("mcp__*", "Bash"), false)
  assert.equal(matchTool("mcp__*", "MyMcpTool"), false) // must start with mcp__
  // literal — exact only, no accidental substring/prefix
  assert.equal(matchTool("Bash", "Bash"), true)
  assert.equal(matchTool("Bash", "Bashful"), false)
  assert.equal(matchTool("Bash", "xBash"), false)
  // bare star
  assert.equal(matchTool("*", "anything_at_all"), true)
})

test("node allowedTools: a tool-name glob permits a family; non-matches still denied", () => {
  const wf = workflow("tg")
  wf.skill("a", { allowedTools: ["Read", "mcp__*"] })
  wf.root("a")
  const g = wf.toJSON()
  const st = initialState(g, LEAD)
  assert.equal(decide(g, st, toolEvP("Read", {}), probe()).action, "allow")
  assert.equal(decide(g, st, toolEvP("mcp__github__create_issue", {}), probe()).action, "allow")
  assert.equal(decide(g, st, toolEvP("Bash", {}), probe()).action, "deny")
})

test("allowAlways: an unscoped tool-name glob grants a family at a node that doesn't list it", () => {
  const wf = workflow("tg2")
  wf.skill("a", { allowedTools: ["Read"] }) // does NOT list any mcp tool
  wf.root("a")
  wf.allowAlways([{ tool: "mcp__*" }])
  const g = wf.toJSON()
  const st = initialState(g, LEAD)
  assert.equal(decide(g, st, toolEvP("mcp__foo__bar", {}), probe()).action, "allow")
})

test("allowAlways: without an mcp rule, a node limited to [Read] still denies an mcp tool", () => {
  const wf = workflow("tg3")
  wf.skill("a", { allowedTools: ["Read"] })
  wf.root("a")
  const g = wf.toJSON()
  const st = initialState(g, LEAD)
  assert.equal(decide(g, st, toolEvP("mcp__foo__bar", {}), probe()).action, "deny")
})

test("allowAlways: a tool-name glob composes with the path glob (both must match)", () => {
  const wf = workflow("tg4")
  wf.skill("a", { allowedTools: ["AskUserQuestion"] })
  wf.root("a")
  wf.allowAlways([{ tool: "mcp__fs__*", paths: [".myhost/**"] }])
  const g = wf.toJSON()
  const st = initialState(g, LEAD)
  assert.equal(decide(g, st, toolEvP("mcp__fs__write", { file_path: ".myhost/x" }), probe()).action, "allow") // tool glob + path glob
  assert.equal(decide(g, st, toolEvP("mcp__fs__write", { file_path: "src/x" }), probe()).action, "deny") // path glob fails
  assert.equal(decide(g, st, toolEvP("mcp__net__get", { file_path: ".myhost/x" }), probe()).action, "deny") // tool glob fails
})

// ---- command-scoped allowAlways (Bash status commands at a Bash-denied node) ----

test("matchCommand: * spans any chars incl / and spaces; no-* is exact whole-command match", () => {
  assert.equal(matchCommand("ao report*", "ao report working"), true)
  assert.equal(matchCommand("ao report*", "ao report --path src/a/b"), true) // * crosses /
  assert.equal(matchCommand("ao report*", "rm -rf app/"), false)
  assert.equal(matchCommand("ao report", "ao report"), true) // exact
  assert.equal(matchCommand("ao report", "ao report working"), false) // no accidental prefix match
  assert.equal(matchCommand("*", "anything at all /x"), true)
  assert.equal(matchCommand("ao report*", null), false) // no command → no match
  // `*` spans newlines too (dotAll): commands are routinely multiline (heredocs, multiline -m).
  assert.equal(matchCommand("git commit*", "git commit -m fix\nsecond line"), true)
  assert.equal(matchCommand("*", "a\nb"), true)
})

test("allowAlways (commands): a multiline command matched by a glob is granted (dotAll)", () => {
  const wf = workflow("cmd-ml")
  wf.skill("a", { allowedTools: ["AskUserQuestion"] })
  wf.root("a")
  wf.allowAlways([{ tool: "Bash", commands: ["git commit*"] }])
  const g = wf.toJSON()
  const st = initialState(g, LEAD)
  assert.equal(decide(g, st, toolEvP("Bash", { command: "git commit -m one\ntwo" }), probe()).action, "allow")
})

test("allowAlways: a path-scoped rule never grants a call whose path is the empty string", () => {
  // Regression: an empty file_path must not be granted even by a catch-all `**` (a truthy, not != null,
  // guard) — otherwise a path-less/empty-path call would slip a strong Write gate.
  const g = AA([{ tool: "Write", paths: ["**"] }])
  const st = initialState(g, LEAD)
  assert.equal(decide(g, st, toolEvP("Write", { file_path: "" }), probe()).action, "deny")
})

// A single node that denies Bash outright (allows only AskUserQuestion), plus a command-scoped rule.
function CMD() {
  const wf = workflow("cmd")
  wf.skill("a", { allowedTools: ["AskUserQuestion"] })
  wf.root("a")
  wf.allowAlways([{ tool: "Bash", commands: ["ao report*"] }])
  return wf.toJSON()
}

test("allowAlways (commands): a matching Bash command is allowed at a node whose allowedTools excludes Bash", () => {
  const g = CMD()
  const st = initialState(g, LEAD) // active [a], node allows only AskUserQuestion (Bash denied)
  assert.equal(decide(g, st, toolEvP("Bash", { command: "ao report working" }), probe()).action, "allow")
})

test("allowAlways (commands): a non-matching Bash command is still denied at the same node (gate holds)", () => {
  const g = CMD()
  const st = initialState(g, LEAD)
  assert.equal(decide(g, st, toolEvP("Bash", { command: "rm -rf app/" }), probe()).action, "deny")
  assert.equal(decide(g, st, toolEvP("Bash", {}), probe()).action, "deny") // no command field → not granted
})

test("allowAlways (commands): the command reads from a Codex-style cmd array too", () => {
  const g = CMD()
  const st = initialState(g, LEAD)
  assert.equal(decide(g, st, toolEvP("Bash", { cmd: ["ao", "report", "working"] }), probe()).action, "allow")
})

test("allowAlways: a rule with NO commands/paths behaves exactly as before (no broadening)", () => {
  // Unscoped Read is allowed everywhere; unrelated Bash stays gated — identical to pre-feature behavior.
  const g = AA([{ tool: "Read" }])
  const st = initialState(g, LEAD)
  assert.equal(decide(g, st, toolEvP("Read", {}), probe()).action, "allow")
  assert.equal(decide(g, st, toolEvP("Bash", { command: "ao report x" }), probe()).action, "deny") // Read rule can't grant Bash
})

test("allowAlways: paths and commands on one rule are OR'd (either dimension may match)", () => {
  const wf = workflow("cmd-path")
  wf.skill("a", { allowedTools: ["AskUserQuestion"] })
  wf.root("a")
  wf.allowAlways([{ tool: "Bash", paths: [".myhost/**"], commands: ["ao report*"] }])
  const g = wf.toJSON()
  const st = initialState(g, LEAD)
  assert.equal(decide(g, st, toolEvP("Bash", { command: "ao report working" }), probe()).action, "allow") // command dim matches
  assert.equal(decide(g, st, toolEvP("Bash", { file_path: ".myhost/x" }), probe()).action, "allow") // path dim matches
  assert.equal(decide(g, st, toolEvP("Bash", { command: "rm -rf app/" }), probe()).action, "deny") // neither matches
})

test("allowAlways: the builder carries a commands field through toJSON (and keeps paths-only unchanged)", () => {
  const wf = workflow("ser")
  wf.skill("a")
  wf.root("a")
  wf.allowAlways([{ tool: "Bash", commands: ["ao report*"] }, { tool: "Write", paths: [".x/**"] }, { tool: "Read" }])
  const g = wf.toJSON()
  assert.deepEqual(g.allowAlways, [
    { tool: "Bash", commands: ["ao report*"] },
    { tool: "Write", paths: [".x/**"] }, // paths-only rule serializes exactly as before
    { tool: "Read" }, // unscoped rule unchanged
  ])
})
