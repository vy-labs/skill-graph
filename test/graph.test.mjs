import { test } from "node:test"
import assert from "node:assert/strict"
import { workflow, fileExists, shell, marker, not, all, any, describe as describePredicate } from "../src/graph.mjs"

// Exhaustive coverage of the DSL surface documented in docs/dsl.md: every skill option,
// every edge method, every predicate constructor, and the serialized toJSON shape.

test("predicate constructors produce the documented descriptors", () => {
  assert.deepEqual(fileExists("docs/*.md"), { kind: "fileExists", glob: "docs/*.md" })
  assert.deepEqual(shell("npm test"), { kind: "shell", cmd: "npm test", fails: false })
  assert.deepEqual(shell("git diff", { fails: true }), { kind: "shell", cmd: "git diff", fails: true })
  assert.deepEqual(marker("done"), { kind: "marker", name: "done" })
  const p = fileExists("a")
  assert.deepEqual(not(p), { kind: "not", p })
  assert.deepEqual(all(p, p), { kind: "all", ps: [p, p] })
  assert.deepEqual(any(p), { kind: "any", ps: [p] })
})

test("describe renders each predicate kind to a label; unknown/empty → ''", () => {
  assert.equal(describePredicate(fileExists("docs/*.md")), "exists docs/*.md")
  assert.equal(describePredicate(shell("npm test")), "npm test")
  assert.equal(describePredicate(shell("git diff", { fails: true })), "git diff fails")
  assert.equal(describePredicate(marker("ready")), "marker ready")
  assert.equal(describePredicate(not(marker("blocked"))), "not marker blocked")
  assert.equal(describePredicate(all(fileExists("a"), marker("b"))), "exists a & marker b")
  assert.equal(describePredicate(any(fileExists("a"), marker("b"))), "exists a | marker b")
  assert.equal(describePredicate({ kind: "mystery" }), "")
  assert.equal(describePredicate(null), "")
})

test("skill: allowedTools defaults to null (unrestricted) and accepts [] or a list", () => {
  const wf = workflow("w")
  const open = wf.skill("open")
  const skillsOnly = wf.skill("skillsOnly", { allowedTools: [] })
  const restricted = wf.skill("restricted", { allowedTools: ["Read", "Bash"] })
  const j = wf.toJSON()
  assert.equal(j.nodes.open.allowedTools, null)
  assert.deepEqual(j.nodes.skillsOnly.allowedTools, [])
  assert.deepEqual(j.nodes.restricted.allowedTools, ["Read", "Bash"])
  // handles are returned so edges can be chained off them
  assert.equal(open.name, "open")
})

test("skill: doneWhen, join (all default / any), and loop options are recorded", () => {
  const wf = workflow("w")
  wf.skill("a")
  wf.skill("b", { doneWhen: marker("b-done") })
  wf.skill("c", { join: "any" })
  wf.skill("d", { loop: { max: 3, noProgress: true } })
  const n = wf.toJSON().nodes
  assert.equal(n.a.doneWhen, null)
  assert.equal(n.a.join, "all") // default
  assert.equal(n.a.loop, null) // default
  assert.deepEqual(n.b.doneWhen, { kind: "marker", name: "b-done" })
  assert.equal(n.c.join, "any")
  assert.deepEqual(n.d.loop, { max: 3, noProgress: true })
})

test("duplicate skill node throws", () => {
  const wf = workflow("w")
  wf.skill("a")
  assert.throws(() => wf.skill("a"), /duplicate skill node: a/)
})

test("root accepts either a handle or a bare string name", () => {
  const h = workflow("w")
  const a = h.skill("a")
  assert.equal(h.root(a).toJSON().root, "a") // handle; root() returns the workflow (chainable)

  const w2 = workflow("w2")
  w2.skill("z")
  assert.equal(w2.root("z").toJSON().root, "z") // string
})

test("then: unguarded forward edge(s) to one or more children", () => {
  const wf = workflow("w")
  const a = wf.skill("a"), b = wf.skill("b"), c = wf.skill("c")
  assert.equal(a.then(b, c), a) // chainable
  assert.deepEqual(wf.toJSON().edges, [
    { from: "a", to: "b", when: null, max: null, fork: false, back: false },
    { from: "a", to: "c", when: null, max: null, fork: false, back: false },
  ])
})

test("fork: forward edges flagged with the parallel-dispatch hint", () => {
  const wf = workflow("w")
  const a = wf.skill("a"), b = wf.skill("b"), c = wf.skill("c")
  a.fork(b, c)
  assert.ok(wf.toJSON().edges.every((e) => e.fork === true))
})

test("after: declares a join (parent->this edges), accepting handles or strings", () => {
  const wf = workflow("w")
  const p = wf.skill("p"), q = wf.skill("q"), d = wf.skill("d")
  d.after(p, "q")
  assert.deepEqual(wf.toJSON().edges, [
    { from: "p", to: "d", when: null, max: null, fork: false, back: false },
    { from: "q", to: "d", when: null, max: null, fork: false, back: false },
  ])
})

test("edge: explicit guard (when) and per-edge cap (max marks a back-edge)", () => {
  const wf = workflow("w")
  const a = wf.skill("a"), b = wf.skill("b"), c = wf.skill("c")
  a.edge(b, { when: shell("npm test") }) // guarded forward edge, not a back-edge
  a.edge(c, { max: 2 }) // a per-edge cap implies a back-edge
  const [e1, e2] = wf.toJSON().edges
  assert.deepEqual(e1, { from: "a", to: "b", when: { kind: "shell", cmd: "npm test", fails: false }, max: null, fork: false, back: false })
  assert.equal(e2.max, 2)
  assert.equal(e2.back, true)
})

test("loopTo: back-edge to an earlier node, with optional guard", () => {
  const wf = workflow("w")
  const v = wf.skill("v"), impl = wf.skill("impl")
  v.loopTo(impl, { when: shell("npm test", { fails: true }) })
  const [e] = wf.toJSON().edges
  assert.equal(e.back, true)
  assert.equal(e.from, "v")
  assert.equal(e.to, "impl")
  assert.deepEqual(e.when, { kind: "shell", cmd: "npm test", fails: true })
})

test("toJSON: full serializable shape (name, root, nodes map, edges array)", () => {
  const wf = workflow("flow")
  const a = wf.skill("a"), b = wf.skill("b")
  a.then(b)
  wf.root(a)
  const j = wf.toJSON()
  assert.equal(j.name, "flow")
  assert.equal(j.root, "a")
  assert.deepEqual(Object.keys(j.nodes), ["a", "b"])
  assert.equal(j.edges.length, 1)
})
