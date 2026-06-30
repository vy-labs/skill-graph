import { test } from "node:test"
import assert from "node:assert/strict"
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, readFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { workflow, fileExists, shell, marker, not, all, any } from "../src/graph.mjs"
import { edgeKey } from "../src/reducer.mjs"
import { selectWorkflow, buildProbe, evalPredicate, loadGraphs, workflowDirs, branchKey, runGovernor, WORKFLOW_DIR } from "../adapters/core.mjs"

const ENGINE = new URL("../src/index.mjs", import.meta.url).pathname

// Scaffold a temp project with one .skill-graph workflow file whose body is supplied. The file
// imports the engine by absolute path so it resolves in tests (outside the project's node_modules).
function makeProject(body) {
  const dir = mkdtempSync(join(tmpdir(), "sg-proj-"))
  mkdirSync(join(dir, WORKFLOW_DIR), { recursive: true })
  writeFileSync(join(dir, WORKFLOW_DIR, "wf.workflow.mjs"), `import { workflow } from ${JSON.stringify(ENGINE)}\n${body}\n`)
  return dir
}
// Workflow: root "a" allows only AskUserQuestion, then b.
const ROOT_WF = `const wf = workflow("proj"); const a = wf.skill("a", { allowedTools: ["AskUserQuestion"] }); const b = wf.skill("b"); a.then(b); wf.root(a); export default wf`
// Workflow with a doneWhen node and a guarded edge, so buildProbe actually evaluates predicates.
const PRED_WF = `import { fileExists, shell } from ${JSON.stringify(ENGINE)}
const wf = workflow("pred"); const a = wf.skill("a", { doneWhen: fileExists("done.md") }); const b = wf.skill("b"); a.edge(b, { when: shell("true") }); wf.root(a); export default wf`

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

test("selectWorkflow: a non-Skill event with no run governs nothing; root via name alias matches", () => {
  assert.equal(selectWorkflow([g], null, { toolName: "Bash", toolInput: {} }), null) // not a Skill → no target
  assert.equal(selectWorkflow([g], null, { toolName: "Skill", toolInput: { name: "a" } }).name, "t") // name alias
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

test("evalPredicate: null is vacuously true; not/all/any combinators; unknown kind is false", () => {
  const dir = mkdtempSync(join(tmpdir(), "sg-"))
  mkdirSync(join(dir, "docs"), { recursive: true })
  writeFileSync(join(dir, "docs", "r.md"), "x")
  const present = fileExists("docs/r.md")
  const absent = fileExists("docs/none.md")
  assert.equal(evalPredicate(null, dir, false), true) // no predicate → satisfied
  assert.equal(evalPredicate(not(absent), dir, false), true)
  assert.equal(evalPredicate(all(present, absent), dir, false), false)
  assert.equal(evalPredicate(any(present, absent), dir, false), true)
  assert.equal(evalPredicate({ kind: "bogus" }, dir, false), false) // unknown descriptor
})

test("evalPredicate: a glob whose directory does not exist is false (readdir throws → caught)", () => {
  const dir = mkdtempSync(join(tmpdir(), "sg-"))
  assert.equal(evalPredicate(fileExists("no-such-dir/*.md"), dir, false), false)
})

test("branchKey: returns a sanitized branch in a git repo, 'no-git' outside one", () => {
  const repoRoot = new URL("..", import.meta.url).pathname // this project is a git repo
  assert.match(branchKey(repoRoot), /^[\w.-]+$/)
  assert.equal(branchKey(mkdtempSync(join(tmpdir(), "sg-nogit-"))), "no-git")
})

test("loadGraphs skips an unloadable workflow file (syntax error) without throwing", async () => {
  const dir = mkdtempSync(join(tmpdir(), "sg-bad-"))
  mkdirSync(join(dir, WORKFLOW_DIR), { recursive: true })
  writeFileSync(join(dir, WORKFLOW_DIR, "broken.workflow.mjs"), "this is not valid javascript (((")
  assert.deepEqual(await loadGraphs(dir), []) // swallowed, returns the (empty) rest
})

test("workflowDirs: bare project dir when SKILL_GRAPH_DIRS is unset, and dedupes the project dir", () => {
  assert.deepEqual(workflowDirs("/proj", {}), [join("/proj", WORKFLOW_DIR)])
  // An extra dir equal to the project dir collapses (Set dedup); blank entries are dropped.
  assert.deepEqual(workflowDirs("/proj", { SKILL_GRAPH_DIRS: `  ${join("/proj", WORKFLOW_DIR)} :: ` }), [join("/proj", WORKFLOW_DIR)])
})

// ---- runGovernor: the full IO orchestration ----

test("runGovernor: no workflow files → allow (nothing to govern)", async () => {
  const dir = mkdtempSync(join(tmpdir(), "sg-empty-"))
  assert.deepEqual(await runGovernor({ event: "PreToolUse", toolName: "Bash", cwd: dir }), { action: "allow" })
})

test("runGovernor: entering the root persists state and allows", async () => {
  const dir = makeProject(ROOT_WF)
  const r = await runGovernor({ event: "PreToolUse", toolName: "Skill", toolInput: { skill: "a" }, cwd: dir, sessionId: "lead" })
  assert.equal(r.action, "allow")
  const stateFile = join(dir, WORKFLOW_DIR, ".state", "no-git.json")
  assert.ok(existsSync(stateFile))
  assert.deepEqual(JSON.parse(readFileSync(stateFile, "utf8")).active, ["a"])
})

test("runGovernor: SessionStart with an active run returns resume context", async () => {
  const dir = makeProject(ROOT_WF)
  await runGovernor({ event: "PreToolUse", toolName: "Skill", toolInput: { skill: "a" }, cwd: dir, sessionId: "lead" })
  const r = await runGovernor({ event: "SessionStart", cwd: dir, sessionId: "lead" })
  assert.equal(r.action, "context")
  assert.match(r.context, /skill-graph workflow: proj/)
  assert.match(r.context, /Active: a/)
})

test("runGovernor: a tool absent from the active node's allowedTools is denied with a reason", async () => {
  const dir = makeProject(ROOT_WF)
  await runGovernor({ event: "PreToolUse", toolName: "Skill", toolInput: { skill: "a" }, cwd: dir, sessionId: "lead" })
  const r = await runGovernor({ event: "PreToolUse", toolName: "Bash", cwd: dir, sessionId: "lead" })
  assert.equal(r.action, "deny")
  assert.match(r.reason, /not permitted/)
})

test("runGovernor: an event for no matching workflow (no run, non-root skill) → allow", async () => {
  const dir = makeProject(ROOT_WF)
  const r = await runGovernor({ event: "PreToolUse", toolName: "Skill", toolInput: { skill: "unrelated" }, cwd: dir, sessionId: "lead" })
  assert.equal(r.action, "allow")
})

test("runGovernor: evaluates a node's doneWhen and an edge's guard through the real predicate path", async () => {
  const dir = makeProject(PRED_WF)
  // Entering the root on a Skill event lets shell guards run; buildProbe invokes the injected
  // evaluator for both the doneWhen and the guarded edge. The run starts regardless → allow.
  const r = await runGovernor({ event: "PreToolUse", toolName: "Skill", toolInput: { skill: "a" }, cwd: dir, sessionId: "lead" })
  assert.equal(r.action, "allow")
  assert.ok(existsSync(join(dir, WORKFLOW_DIR, ".state", "no-git.json")))
})

test("runGovernor: a missing sessionId defaults the lead id to 'lead'", async () => {
  const dir = makeProject(ROOT_WF)
  const r = await runGovernor({ event: "PreToolUse", toolName: "Skill", toolInput: { skill: "a" }, cwd: dir }) // no sessionId
  assert.equal(r.action, "allow")
  const st = JSON.parse(readFileSync(join(dir, WORKFLOW_DIR, ".state", "no-git.json"), "utf8"))
  assert.equal(st.leadSessionId, "lead")
})

test("runGovernor: reads a .signature file when present (loop fingerprint plumbing)", async () => {
  const dir = makeProject(ROOT_WF)
  writeFileSync(join(dir, WORKFLOW_DIR, ".signature"), "sig-123\n")
  // Start a run; the signature path is exercised on the transition event.
  const r = await runGovernor({ event: "PreToolUse", toolName: "Skill", toolInput: { skill: "a" }, cwd: dir, sessionId: "lead" })
  assert.equal(r.action, "allow")
})

test("runGovernor: a corrupt state file is treated as no active run (readState fails closed to null)", async () => {
  const dir = makeProject(ROOT_WF)
  mkdirSync(join(dir, WORKFLOW_DIR, ".state"), { recursive: true })
  writeFileSync(join(dir, WORKFLOW_DIR, ".state", "no-git.json"), "{ not json")
  // No usable state → a non-root skill gets no opinion (allow), proving the parse error was swallowed.
  const r = await runGovernor({ event: "PreToolUse", toolName: "Skill", toolInput: { skill: "unrelated" }, cwd: dir, sessionId: "lead" })
  assert.equal(r.action, "allow")
})

test("runGovernor: writeState failure is best-effort (a non-dir .state path does not break the decision)", async () => {
  const dir = makeProject(ROOT_WF)
  writeFileSync(join(dir, WORKFLOW_DIR, ".state"), "i am a file, not a directory") // mkdir of .state will throw
  const r = await runGovernor({ event: "PreToolUse", toolName: "Skill", toolInput: { skill: "a" }, cwd: dir, sessionId: "lead" })
  assert.equal(r.action, "allow") // decision still returned despite the persistence failure
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
