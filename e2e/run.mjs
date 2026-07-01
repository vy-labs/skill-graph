#!/usr/bin/env node
// Live e2e runner. For each scenario: build a fresh sandbox with the hook wired the real way, drive a
// REAL headless `claude` process through it, then judge the run from the governor's decision log.
//
//   node e2e/run.mjs                 # all scenarios
//   node e2e/run.mjs loop-cap        # only scenarios whose file/name matches an arg
//   E2E_MODEL=sonnet node e2e/run.mjs
//   SG_KEEP=1 node e2e/run.mjs       # keep sandboxes for inspection (prints their paths)
//
// Exit code: 0 only if every selected scenario PASSed. FAIL (governor misbehaved) and INCONCLUSIVE
// (agent never exercised the check) both exit non-zero, so a green run is unambiguous.

import { readdirSync, rmSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"
import { makeSandbox } from "./lib/sandbox.mjs"
import { runScenario } from "./lib/runClaude.mjs"
import { PASS, FAIL, INCONCLUSIVE } from "./lib/assert.mjs"

const HERE = dirname(fileURLToPath(import.meta.url))
const SCEN_DIR = join(HERE, "scenarios")

const filters = process.argv.slice(2)
const keep = !!process.env.SG_KEEP

const files = readdirSync(SCEN_DIR)
  .filter((f) => f.endsWith(".mjs"))
  .filter((f) => filters.length === 0 || filters.some((q) => f.includes(q)))
  .sort()

if (files.length === 0) {
  console.error(`no scenarios matched ${JSON.stringify(filters)} under ${SCEN_DIR}`)
  process.exit(2)
}

const glyph = { [PASS]: "✓", [FAIL]: "✗", [INCONCLUSIVE]: "•" }
const results = []

console.log(`\nskill-graph live e2e, model=${process.env.E2E_MODEL || "haiku"}, ${files.length} scenario(s)\n`)

for (const file of files) {
  const scenario = (await import(pathToFileURL(join(SCEN_DIR, file)).href)).default
  process.stdout.write(`▶ ${scenario.name}\n  intent: ${scenario.intent}\n  running claude … `)

  const { dir, logPath } = makeSandbox()
  const { entries, status, stderr } = runScenario({ dir, logPath, prompt: scenario.prompt })

  let result
  if (entries.length === 0 && status !== 0) {
    result = { verdict: INCONCLUSIVE, detail: `claude exited ${status} and the hook never logged. stderr: ${(stderr || "").slice(0, 300)}` }
  } else {
    result = scenario.check(entries)
  }

  console.log(`${glyph[result.verdict]} ${result.verdict}`)
  console.log(`  ${result.detail}`)
  console.log(`  governor decisions: ${entries.length}${keep ? `  (sandbox: ${dir})` : ""}\n`)
  results.push({ name: scenario.name, ...result, decisions: entries.length })

  if (!keep) rmSync(dir, { recursive: true, force: true })
}

// Scorecard
const pad = Math.max(...results.map((r) => r.name.length))
console.log("── scorecard ─────────────────────────────────────────────")
for (const r of results) console.log(`  ${glyph[r.verdict]} ${r.verdict.padEnd(12)} ${r.name.padEnd(pad)}  (${r.decisions} decisions)`)
const passed = results.filter((r) => r.verdict === PASS).length
console.log(`──────────────────────────────────────────────────────────`)
console.log(`  ${passed}/${results.length} PASS\n`)

process.exit(results.every((r) => r.verdict === PASS) ? 0 : 1)
