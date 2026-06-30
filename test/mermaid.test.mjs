import { test } from "node:test"
import assert from "node:assert/strict"
import { workflow, shell } from "../src/graph.mjs"
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
