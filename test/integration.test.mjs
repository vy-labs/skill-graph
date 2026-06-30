import { test } from "node:test"
import assert from "node:assert/strict"
import { spawnSync } from "node:child_process"
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, readFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

// End-to-end coverage of the stdin→stdout runner (core-io.mjs) and the adapter entry guard, by
// spawning the REAL adapter binary the way a harness hook would: payload on stdin, envelope on stdout.

const CLAUDE_ADAPTER = new URL("../adapters/claude-code.mjs", import.meta.url).pathname
const CODEX_ADAPTER = new URL("../adapters/codex.mjs", import.meta.url).pathname
const CORE_IO = new URL("../adapters/core-io.mjs", import.meta.url).pathname
const MERMAID_BIN = new URL("../bin/mermaid.mjs", import.meta.url).pathname
const ENGINE = new URL("../src/index.mjs", import.meta.url).pathname

function project() {
  const dir = mkdtempSync(join(tmpdir(), "sg-it-"))
  mkdirSync(join(dir, ".skill-graph"), { recursive: true })
  writeFileSync(
    join(dir, ".skill-graph", "wf.workflow.mjs"),
    `import { workflow } from ${JSON.stringify(ENGINE)}\n` +
      `const wf = workflow("it"); const a = wf.skill("a", { allowedTools: ["AskUserQuestion"] }); const b = wf.skill("b"); a.then(b); wf.root(a); export default wf\n`,
  )
  return dir
}

function runAdapter(payload, cwd) {
  const input = typeof payload === "string" ? payload : JSON.stringify(payload)
  return spawnSync(process.execPath, [CLAUDE_ADAPTER], { input, cwd, encoding: "utf8" })
}

test("adapter binary: entering the root allows (no stdout) and persists state", () => {
  const dir = project()
  const r = runAdapter({ hook_event_name: "PreToolUse", tool_name: "Skill", tool_input: { skill: "a" }, cwd: dir, session_id: "lead" }, dir)
  assert.equal(r.status, 0)
  assert.equal(r.stdout, "") // allow → format returns null → nothing written
  assert.ok(existsSync(join(dir, ".skill-graph", ".state", "no-git.json")))
})

test("adapter binary: a disallowed tool emits a deny envelope on stdout", () => {
  const dir = project()
  runAdapter({ hook_event_name: "PreToolUse", tool_name: "Skill", tool_input: { skill: "a" }, cwd: dir, session_id: "lead" }, dir) // start run
  const r = runAdapter({ hook_event_name: "PreToolUse", tool_name: "Bash", tool_input: {}, cwd: dir, session_id: "lead" }, dir)
  assert.equal(r.status, 0)
  const out = JSON.parse(r.stdout)
  assert.equal(out.hookSpecificOutput.permissionDecision, "deny")
  assert.match(out.hookSpecificOutput.permissionDecisionReason, /not permitted/)
})

test("adapter binary: unreadable stdin fails open (exit 0, no output)", () => {
  const dir = project()
  const r = runAdapter("{ this is not json", dir)
  assert.equal(r.status, 0)
  assert.equal(r.stdout, "")
})

test("codex adapter binary: entering the root via argv-supplied event allows (no stdout)", () => {
  const dir = project()
  // Codex passes the event name as argv[2]; the payload carries the tool. "Skill" isn't in TOOL_MAP
  // so it passes through unchanged and starts the run.
  const payload = JSON.stringify({ tool_name: "Skill", tool_input: { skill: "a" }, cwd: dir, session_id: "lead" })
  const r = spawnSync(process.execPath, [CODEX_ADAPTER, "PreToolUse"], { input: payload, cwd: dir, encoding: "utf8" })
  assert.equal(r.status, 0)
  assert.equal(r.stdout, "")
  assert.ok(existsSync(join(dir, ".skill-graph", ".state", "no-git.json")))
})

// ---- skill-graph-mermaid bin ----

// A factory-form workflow needs no "skill-graph" import, so the bin loads it anywhere. loopWf adds a
// guarded loop so the diagram has an edge label too.
function mermaidProject() {
  const dir = mkdtempSync(join(tmpdir(), "sg-mmd-"))
  mkdirSync(join(dir, ".skill-graph"), { recursive: true })
  writeFileSync(
    join(dir, ".skill-graph", "flow.workflow.mjs"),
    `export default (sg) => { const wf = sg.workflow("flow"); const a = wf.skill("a"); const b = wf.skill("b"); a.then(b); b.loopTo(a, { when: sg.shell("npm test", { fails: true }) }); wf.root(a); return wf }`,
  )
  return dir
}
const runMermaid = (args, cwd) => spawnSync(process.execPath, [MERMAID_BIN, ...args], { cwd, encoding: "utf8" })

test("mermaid bin: explicit path renders flowchart text to stdout", () => {
  const dir = mermaidProject()
  const r = runMermaid([join(dir, ".skill-graph", "flow.workflow.mjs")], dir)
  assert.equal(r.status, 0)
  assert.match(r.stdout, /flowchart TD/)
  assert.match(r.stdout, /a --> b/)
})

test("mermaid bin: with no path, discovers the workflow under ./.skill-graph", () => {
  const dir = mermaidProject()
  const r = runMermaid([], dir)
  assert.equal(r.status, 0)
  assert.match(r.stdout, /flowchart TD/)
})

test("mermaid bin: -o a non-.md text file writes raw Mermaid (no fence)", () => {
  const dir = mermaidProject()
  const out = join(dir, "flow.mmd")
  const r = runMermaid([join(dir, ".skill-graph", "flow.workflow.mjs"), "-o", out], dir)
  assert.equal(r.status, 0)
  const text = readFileSync(out, "utf8")
  assert.match(text, /^flowchart TD/) // raw, not wrapped in ```mermaid
  assert.doesNotMatch(text, /```/)
})

test("mermaid bin: -o a .md file wraps the diagram in a mermaid fence; --state overlays classes", () => {
  const dir = mermaidProject()
  writeFileSync(join(dir, "state.json"), JSON.stringify({ completed: ["a"], active: ["b"] }))
  const out = join(dir, "flow.md")
  const r = runMermaid([join(dir, ".skill-graph", "flow.workflow.mjs"), "-o", out, "-s", join(dir, "state.json")], dir)
  assert.equal(r.status, 0)
  const md = readFileSync(out, "utf8")
  assert.match(md, /```mermaid/)
  assert.match(md, /class a done/) // overlay applied
})

test("mermaid bin: --svg renders via the mermaid-cli command it's given", () => {
  const dir = mermaidProject()
  const stub = join(dir, "mmdc-stub.sh") // writes bytes to the -o path, mimicking mmdc
  writeFileSync(stub, `#!/bin/sh\nout=""\nwhile [ "$#" -gt 0 ]; do [ "$1" = "-o" ] && out="$2"; shift; done\nprintf '<svg></svg>' > "$out"\n`)
  spawnSync("chmod", ["+x", stub])
  const out = join(dir, "flow.svg")
  const r = runMermaid([join(dir, ".skill-graph", "flow.workflow.mjs"), "-o", out, "--mmdc", stub], dir)
  assert.equal(r.status, 0)
  assert.equal(readFileSync(out, "utf8"), "<svg></svg>")
})

test("mermaid bin: an unavailable mermaid-cli fails with guidance and writes a .mmd fallback", () => {
  const dir = mermaidProject()
  const out = join(dir, "flow.svg")
  const r = runMermaid([join(dir, ".skill-graph", "flow.workflow.mjs"), "-o", out, "--mmdc", "/no/such/mmdc"], dir)
  assert.equal(r.status, 1)
  assert.match(r.stderr, /mermaid-cli unavailable/)
  assert.match(readFileSync(join(dir, "flow.mmd"), "utf8"), /flowchart TD/) // source preserved
})

test("mermaid bin: file output with several discovered workflows errors and lists them", () => {
  const dir = mermaidProject()
  writeFileSync(join(dir, ".skill-graph", "second.workflow.mjs"), `export default (sg) => { const wf = sg.workflow("second"); wf.skill("x"); wf.root("x"); return wf }`)
  const r = runMermaid(["-o", join(dir, "out.svg")], dir)
  assert.equal(r.status, 1)
  assert.match(r.stderr, /found 2 workflows/)
})

test("mermaid bin: several workflows to stdout are emitted with %% headers", () => {
  const dir = mermaidProject()
  writeFileSync(join(dir, ".skill-graph", "second.workflow.mjs"), `export default (sg) => { const wf = sg.workflow("second"); wf.skill("x"); wf.root("x"); return wf }`)
  const r = runMermaid([], dir)
  assert.equal(r.status, 0)
  assert.match(r.stdout, /%% flow\.workflow\.mjs \(flow\)/)
  assert.match(r.stdout, /%% second\.workflow\.mjs \(second\)/)
})

test("mermaid bin: --help prints usage and exits 0", () => {
  const r = runMermaid(["--help"], mermaidProject())
  assert.equal(r.status, 0)
  assert.match(r.stdout, /Usage:/)
})

test("mermaid bin: an unknown option is rejected", () => {
  const r = runMermaid(["--nope"], mermaidProject())
  assert.equal(r.status, 1)
  assert.match(r.stderr, /unknown option: --nope/)
})

test("mermaid bin: a second positional argument is rejected", () => {
  const dir = mermaidProject()
  const wf = join(dir, ".skill-graph", "flow.workflow.mjs")
  const r = runMermaid([wf, wf], dir)
  assert.equal(r.status, 1)
  assert.match(r.stderr, /unexpected argument/)
})

test("mermaid bin: no path and no discoverable workflow fails with guidance", () => {
  const empty = mkdtempSync(join(tmpdir(), "sg-none-")) // no .skill-graph
  const r = runMermaid([], empty)
  assert.equal(r.status, 1)
  assert.match(r.stderr, /none found under \.\/\.skill-graph/)
})

test("mermaid bin: a file whose default export is not a workflow is rejected", () => {
  const dir = mermaidProject()
  const bad = join(dir, ".skill-graph", "bad.workflow.mjs")
  writeFileSync(bad, `export default { not: "a workflow" }`)
  const r = runMermaid([bad], dir)
  assert.equal(r.status, 1)
  assert.match(r.stderr, /not a workflow file/)
})

test("mermaid bin: a workflow file that throws on import is reported (not a crashing stack), to stdout and to a file", () => {
  const dir = mermaidProject()
  const boom = join(dir, ".skill-graph", "boom.workflow.mjs")
  writeFileSync(boom, `throw new Error("kaboom")`)
  const toStdout = runMermaid([boom], dir) // exercises the stdout-branch catch
  assert.equal(toStdout.status, 1)
  assert.match(toStdout.stderr, /not a workflow file/)
  const toFile = runMermaid([boom, "-o", join(dir, "x.mmd")], dir) // exercises the file-branch catch
  assert.equal(toFile.status, 1)
  assert.match(toFile.stderr, /not a workflow file/)
})

test("mermaid bin: --svg with no -o uses the default mmdc on PATH and names the file after the workflow", () => {
  const dir = mermaidProject()
  const binDir = mkdtempSync(join(tmpdir(), "sg-path-"))
  writeFileSync(join(binDir, "mmdc"), `#!/bin/sh\nout=""\nwhile [ "$#" -gt 0 ]; do [ "$1" = "-o" ] && out="$2"; shift; done\nprintf '<svg/>' > "$out"\n`)
  spawnSync("chmod", ["+x", join(binDir, "mmdc")])
  // No --mmdc → exercises the default [mmdc, npx] attempts; the stub mmdc on PATH satisfies the first.
  const r = spawnSync(process.execPath, [MERMAID_BIN, join(dir, ".skill-graph", "flow.workflow.mjs"), "--svg"], {
    cwd: dir,
    encoding: "utf8",
    env: { ...process.env, PATH: `${binDir}:${process.env.PATH}` },
  })
  assert.equal(r.status, 0)
  assert.equal(readFileSync(join(dir, "flow.svg"), "utf8"), "<svg/>") // default name = "<workflow name>.svg"
})

test("mermaid bin: a mermaid-cli that runs but fails is not retried, and the .mmd fallback is written", () => {
  const dir = mermaidProject()
  const stub = join(dir, "failing-mmdc.sh")
  writeFileSync(stub, `#!/bin/sh\nexit 3\n`) // runs, exits non-zero
  spawnSync("chmod", ["+x", stub])
  const r = runMermaid([join(dir, ".skill-graph", "flow.workflow.mjs"), "-o", join(dir, "flow.svg"), "--mmdc", stub], dir)
  assert.equal(r.status, 1)
  assert.match(r.stderr, /mermaid-cli unavailable/)
  assert.match(readFileSync(join(dir, "flow.mmd"), "utf8"), /flowchart TD/)
})

test("core-io run(): an error anywhere in parse→govern→format fails open (exit 0, no output)", () => {
  // Drive run() directly: parse and govern succeed, format throws — exercising the try/catch that
  // wraps the whole pipeline plus process.exit(0). (parse, govern and format all run.)
  const dir = mkdtempSync(join(tmpdir(), "sg-io-"))
  const driver = join(dir, "driver.mjs")
  writeFileSync(
    driver,
    `import { run } from ${JSON.stringify(CORE_IO)}\n` +
      `await run((p) => p, async () => ({ action: "allow" }), () => { throw new Error("boom") })\n`,
  )
  const r = spawnSync(process.execPath, [driver], { input: "{}", encoding: "utf8" })
  assert.equal(r.status, 0)
  assert.equal(r.stdout, "")
})
