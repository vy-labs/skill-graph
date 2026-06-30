import { test } from "node:test"
import assert from "node:assert/strict"
import { workflow, shell, fileExists, marker, not, all, any } from "../src/graph.mjs"
import { toMermaid } from "../src/mermaid.mjs"

function G() {
  const wf = workflow("t")
  const a = wf.skill("a")
  const b = wf.skill("b")
  const c = wf.skill("c")
  a.then(b)
  b.edge(a, { when: shell("x", { fails: true }), max: 2 })
  b.edge(c, { when: shell("x") })
  wf.root(a)
  return wf.toJSON()
}

test("renders edges with guard + cap labels", () => {
  const m = toMermaid(G())
  assert.match(m, /flowchart TD/)
  assert.match(m, /a --> b/)
  assert.match(m, /b -->\|x fails, ≤2\| a/)
  assert.match(m, /b -->\|x\| c/)
})

test("overlays live state classes", () => {
  const m = toMermaid(G(), { completed: ["a"], active: ["b"] })
  assert.match(m, /class a done/)
  assert.match(m, /class b active/)
})

test("describes every predicate kind in edge guard labels", () => {
  // One edge per predicate kind so describe() renders each branch (incl. nested not/all/any).
  const wf = workflow("w")
  const s = wf.skill("s")
  const fe = wf.skill("fe"), mk = wf.skill("mk"), nt = wf.skill("nt"), al = wf.skill("al"), an = wf.skill("an")
  s.edge(fe, { when: fileExists("docs/*.md") })
  s.edge(mk, { when: marker("ready") })
  s.edge(nt, { when: not(marker("blocked")) })
  s.edge(al, { when: all(fileExists("a"), marker("b")) })
  s.edge(an, { when: any(fileExists("a"), marker("b")) })
  const m = toMermaid(wf.toJSON())
  assert.match(m, /\|exists docs\/\*\.md\| fe/)
  assert.match(m, /\|marker ready\| mk/)
  assert.match(m, /\|not marker blocked\| nt/)
  assert.match(m, /\|exists a & marker b\| al/)
  assert.match(m, /\|exists a \| marker b\| an/)
})

test("an unknown predicate kind renders an empty label (no crash)", () => {
  // Exercises describe()'s default fall-through for a descriptor the renderer doesn't know.
  const wf = workflow("w")
  const a = wf.skill("a"), b = wf.skill("b")
  a.edge(b, { when: { kind: "mystery" } })
  const m = toMermaid(wf.toJSON())
  assert.match(m, /a --> b/) // no |label| because describe() returned ""
})

test("overlay marks a node active only when it is not also completed", () => {
  // The active loop skips nodes already in completed (the `if (!completed.includes(n))` branch).
  const m = toMermaid(G(), { completed: ["a", "b"], active: ["b"] })
  assert.match(m, /class b done/)
  assert.doesNotMatch(m, /class b active/)
})
