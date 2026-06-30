import { test } from "node:test"
import assert from "node:assert/strict"
import { spawnSync } from "node:child_process"
import { mkdtempSync, mkdirSync, writeFileSync, existsSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

// End-to-end coverage of the stdin→stdout runner (core-io.mjs) and the adapter entry guard, by
// spawning the REAL adapter binary the way a harness hook would: payload on stdin, envelope on stdout.

const CLAUDE_ADAPTER = new URL("../adapters/claude-code.mjs", import.meta.url).pathname
const CODEX_ADAPTER = new URL("../adapters/codex.mjs", import.meta.url).pathname
const CORE_IO = new URL("../adapters/core-io.mjs", import.meta.url).pathname
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
