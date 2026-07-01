#!/usr/bin/env node
// Deterministic Codex e2e. Replays a codex-shaped journey per scenario through the REAL Codex hook
// binary and judges it with the SAME check() the live Claude suite uses (see lib/replayCodex.mjs for
// why this is a replay rather than a live `codex exec` run).
//
//   node e2e/codex-run.mjs            # all scenarios
//   node e2e/codex-run.mjs loop       # only matching scenarios
//
// Exit 0 only if every scenario PASSes.

import { rmSync } from "node:fs"
import { makeSandbox } from "./lib/sandbox.mjs"
import { replayCodex, enter, shellCmd, file } from "./lib/replayCodex.mjs"
import { PASS, FAIL, INCONCLUSIVE } from "./lib/assert.mjs"
import happyPath from "./scenarios/happy-path.mjs"
import forbiddenTool from "./scenarios/forbidden-tool.mjs"
import offGraphJump from "./scenarios/off-graph-jump.mjs"
import loopCap from "./scenarios/loop-cap.mjs"

// Each scenario reuses its check() from the shared scenario module; only the journey (the codex-shaped
// tool events an agent would emit) is defined here. File steps make a node's doneWhen / marker hold.
const CASES = [
  { scenario: happyPath, journey: [enter("research"), file("NOTES.md"), enter("build"), file("GREETING.txt"), enter("verify"), file(".skill-graph/verified"), enter("done")] },
  { scenario: forbiddenTool, journey: [enter("research"), shellCmd("ls -la")] },
  { scenario: offGraphJump, journey: [enter("research"), enter("done")] },
  { scenario: loopCap, journey: [enter("research"), file("NOTES.md"), enter("build"), enter("verify"), enter("build"), enter("verify"), enter("build")] },
]

const filters = process.argv.slice(2)
const keep = !!process.env.SG_KEEP
const cases = CASES.filter((c) => filters.length === 0 || filters.some((q) => c.scenario.name.includes(q)))

const glyph = { [PASS]: "✓", [FAIL]: "✗", [INCONCLUSIVE]: "•" }
const results = []

console.log(`\nskill-graph Codex e2e (deterministic replay) — ${cases.length} scenario(s)\n`)

for (const { scenario, journey } of cases) {
  process.stdout.write(`▶ ${scenario.name}\n  intent: ${scenario.intent}\n  replaying codex journey … `)
  const { dir, logPath } = makeSandbox()
  const entries = replayCodex({ dir, logPath, journey })
  const result = scenario.check(entries)
  console.log(`${glyph[result.verdict]} ${result.verdict}`)
  console.log(`  ${result.detail}`)
  console.log(`  governor decisions: ${entries.length}${keep ? `  (sandbox: ${dir})` : ""}\n`)
  results.push({ name: scenario.name, ...result, decisions: entries.length })
  if (!keep) rmSync(dir, { recursive: true, force: true })
}

const pad = Math.max(...results.map((r) => r.name.length))
console.log("── scorecard ─────────────────────────────────────────────")
for (const r of results) console.log(`  ${glyph[r.verdict]} ${r.verdict.padEnd(12)} ${r.name.padEnd(pad)}  (${r.decisions} decisions)`)
console.log(`──────────────────────────────────────────────────────────`)
console.log(`  ${results.filter((r) => r.verdict === PASS).length}/${results.length} PASS\n`)

process.exit(results.every((r) => r.verdict === PASS) ? 0 : 1)
