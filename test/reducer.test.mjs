import { test } from "node:test"
import assert from "node:assert/strict"
import { workflow, fileExists, shell, marker } from "../src/graph.mjs"
import { decide, initialState, edgeKey, OVERRIDE_SKILL } from "../src/reducer.mjs"

const LEAD = "sess-lead"
const probe = (over = {}) => ({ sessionId: LEAD, doneWhen: {}, guards: {}, ...over })
const skillEv = (name, input = {}) => ({ toolName: "Skill", toolInput: { skill: name, ...input } })
const toolEv = (toolName) => ({ toolName, toolInput: {} })

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
