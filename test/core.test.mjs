import { test } from "node:test"
import assert from "node:assert/strict"
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { workflow, fileExists, shell, marker } from "../src/graph.mjs"
import { edgeKey } from "../src/reducer.mjs"
import { selectWorkflow, buildProbe, evalPredicate, loadGraphs, workflowDirs, WORKFLOW_DIR } from "../adapters/core.mjs"

function G() {
  const wf = workflow("t")
  const a = wf.skill("a")
  const c = wf.skill("c", { doneWhen: fileExists("c.md") })
  const f = wf.skill("f")
  const x = wf.skill("x")
  a.then(c); c.then(f)
  f.edge(x, { when: shell("t") })
  wf.root(a)
  return wf.toJSON()
}
const g = G()
const skillEv = (name) => ({ toolName: "Skill", toolInput: { skill: name } })

test("selectWorkflow: active run, root skill, else null, dormant", () => {
  assert.equal(selectWorkflow([g], { workflow: "t" }, skillEv("z")).name, "t")
  assert.equal(selectWorkflow([g], null, skillEv("a")).name, "t")
  assert.equal(selectWorkflow([g], null, skillEv("zzz")), null)
  assert.equal(selectWorkflow([], null, skillEv("a")), null)
})

test("buildProbe maps done_when + guards via the injected evaluator", () => {
  const p = buildProbe(g, null, skillEv("a"), { sessionId: "s", evalP: () => true })
  assert.equal(p.doneWhen.c, true)
  assert.equal(p.guards[edgeKey("f", "x")], true)
})

test("evalPredicate: fileExists glob, marker, shell gated by allowShell", () => {
  const dir = mkdtempSync(join(tmpdir(), "sg-"))
  mkdirSync(join(dir, "docs"), { recursive: true })
  writeFileSync(join(dir, "docs", "r.md"), "x")
  mkdirSync(join(dir, WORKFLOW_DIR), { recursive: true })
  writeFileSync(join(dir, WORKFLOW_DIR, "m"), "x")
  assert.equal(evalPredicate(fileExists("docs/*.md"), dir, false), true)
  assert.equal(evalPredicate(fileExists("docs/*.json"), dir, false), false)
  assert.equal(evalPredicate(marker("m"), dir, false), true)
  assert.equal(evalPredicate(shell("true"), dir, false), false) // skipped unless allowShell
  assert.equal(evalPredicate(shell("true"), dir, true), true)
  assert.equal(evalPredicate(shell("false"), dir, true), false)
})

test("loadGraphs discovers .skill-graph/*.workflow.js in the project", async () => {
  const dir = mkdtempSync(join(tmpdir(), "sg-"))
  mkdirSync(join(dir, WORKFLOW_DIR), { recursive: true })
  // a workflow file authored as a normal module importing the engine by relative path (test-local)
  const enginePath = new URL("../src/index.mjs", import.meta.url).pathname
  writeFileSync(
    join(dir, WORKFLOW_DIR, "demo.workflow.js"),
    `import { workflow } from ${JSON.stringify(enginePath)}\nconst wf = workflow("demo"); const a = wf.skill("a"); const b = wf.skill("b"); a.then(b); wf.root(a); export default wf\n`,
  )
  const graphs = await loadGraphs(dir)
  assert.equal(graphs.length, 1)
  assert.equal(graphs[0].name, "demo")
  assert.equal(graphs[0].root, "a")
})

test("loadGraphs supports a factory workflow (default export is a function, no import needed)", async () => {
  const dir = mkdtempSync(join(tmpdir(), "sg-"))
  mkdirSync(join(dir, WORKFLOW_DIR), { recursive: true })
  // factory form: never imports "skill-graph"; the governor injects the DSL
  writeFileSync(
    join(dir, WORKFLOW_DIR, "f.workflow.mjs"),
    `export default (sg) => { const wf = sg.workflow("fac"); const a = wf.skill("a"); const b = wf.skill("b"); a.then(b); wf.root(a); return wf }\n`,
  )
  const graphs = await loadGraphs(dir)
  assert.equal(graphs.length, 1)
  assert.equal(graphs[0].name, "fac")
  assert.equal(graphs[0].root, "a")
})

test("SKILL_GRAPH_DIRS adds extra discovery dirs (a plugin shipping its own workflow)", async () => {
  const proj = mkdtempSync(join(tmpdir(), "sg-proj-"))
  const ship = mkdtempSync(join(tmpdir(), "sg-ship-"))
  mkdirSync(join(ship, WORKFLOW_DIR), { recursive: true })
  writeFileSync(
    join(ship, WORKFLOW_DIR, "p.workflow.mjs"),
    `export default (sg) => { const wf = sg.workflow("shipped"); wf.skill("x"); wf.root("x"); return wf }\n`,
  )
  const env = { SKILL_GRAPH_DIRS: join(ship, WORKFLOW_DIR) }
  assert.ok(workflowDirs(proj, env).includes(join(ship, WORKFLOW_DIR)))
  const graphs = await loadGraphs(proj, env)
  assert.equal(graphs.find((g) => g.name === "shipped")?.root, "x")
})
