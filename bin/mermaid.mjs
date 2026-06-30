#!/usr/bin/env node
// skill-graph-mermaid — render a workflow to a Mermaid flowchart.
//
//   skill-graph-mermaid [workflow.mjs] [options]
//
// With no path, discovers .skill-graph/*.workflow.{mjs,js} in the cwd (and SKILL_GRAPH_DIRS). Prints
// Mermaid text to stdout by default; -o writes a file, and an .svg/.png output (or --svg) renders an
// image via the mermaid-cli (mmdc), which is NOT a dependency — it's invoked from PATH or via npx.

import { readFileSync, writeFileSync, mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, basename, resolve } from "node:path"
import { spawnSync } from "node:child_process"
import { toMermaid } from "../src/index.mjs"
import { loadWorkflowFile, discoverWorkflowFiles } from "../adapters/core.mjs"

const HELP = `skill-graph-mermaid — render a workflow to a Mermaid flowchart

Usage:
  skill-graph-mermaid [workflow.mjs] [options]

Arguments:
  workflow.mjs           Path to a .workflow.{mjs,js} file. If omitted, every workflow under
                         ./.skill-graph (and SKILL_GRAPH_DIRS) is discovered.

Options:
  -s, --state <file>     Overlay a run's state JSON (completed = green, active = bold).
  -o, --out <file>       Write to <file>. The extension picks the format:
                           .svg / .png  → image (rendered with the mermaid-cli)
                           .md          → Markdown with a fenced \`\`\`mermaid block
                           anything else → raw Mermaid text
      --svg              Shorthand for SVG output; writes <workflow>.svg when -o is absent.
      --mmdc <cmd>       mermaid-cli binary to use (default: try \`mmdc\`, then \`npx … mermaid-cli\`).
  -h, --help             Show this help.

Examples:
  skill-graph-mermaid                                  # all workflows → stdout
  skill-graph-mermaid .skill-graph/review.workflow.mjs # one workflow → stdout
  skill-graph-mermaid review.workflow.mjs -o flow.svg  # render an SVG
  skill-graph-mermaid wf.mjs -s .skill-graph/.state/main.json  # with live overlay
`

const ALIAS = { "-h": "--help", "-s": "--state", "-o": "--out" }

function parseArgs(argv) {
  const opts = { path: null, state: null, out: null, svg: false, mmdc: null, help: false }
  for (let i = 0; i < argv.length; i++) {
    const a = ALIAS[argv[i]] ?? argv[i] // normalize short flags so each option is one check
    if (a === "--help") opts.help = true
    else if (a === "--state") opts.state = argv[++i]
    else if (a === "--out") opts.out = argv[++i]
    else if (a === "--svg") opts.svg = true
    else if (a === "--mmdc") opts.mmdc = argv[++i]
    else if (a.startsWith("-")) fail(`unknown option: ${a}`)
    else if (opts.path == null) opts.path = a
    else fail(`unexpected argument: ${a}`)
  }
  return opts
}

function fail(msg) {
  process.stderr.write(`skill-graph-mermaid: ${msg}\n`)
  process.exit(1)
}

const isImage = (p) => /\.(svg|png)$/i.test(p)

// Render Mermaid text to an image via the mermaid-cli. Tries an explicit --mmdc, then `mmdc` on PATH,
// then `npx -y @mermaid-js/mermaid-cli`. Returns true on success. Never throws.
function renderImage(mermaid, outPath, mmdcOverride) {
  const tmp = join(mkdtempSync(join(tmpdir(), "sg-mmd-")), "wf.mmd")
  writeFileSync(tmp, mermaid)
  const attempts = mmdcOverride
    ? [[mmdcOverride, ["-i", tmp, "-o", outPath]]]
    : [
        ["mmdc", ["-i", tmp, "-o", outPath]],
        ["npx", ["-y", "@mermaid-js/mermaid-cli", "-i", tmp, "-o", outPath]],
      ]
  for (const [cmd, args] of attempts) {
    const r = spawnSync(cmd, args, { stdio: "inherit" })
    if (r.status === 0) return true
    if (r.error && r.error.code === "ENOENT") continue // binary not found → try the next strategy
    return false // it ran but failed (e.g. missing browser); don't mask the real error by retrying
  }
  return false
}

async function main() {
  const opts = parseArgs(process.argv.slice(2))
  if (opts.help) {
    process.stdout.write(HELP)
    return
  }

  const files = opts.path ? [resolve(opts.path)] : discoverWorkflowFiles(process.cwd())
  if (files.length === 0) fail("no workflow given and none found under ./.skill-graph")

  const wantsFile = !!opts.out || opts.svg
  if (wantsFile && files.length > 1)
    fail(`found ${files.length} workflows; pass one explicitly for file output:\n  ${files.join("\n  ")}`)

  const state = opts.state ? JSON.parse(readFileSync(opts.state, "utf8")) : undefined

  // stdout (possibly several workflows)
  if (!wantsFile) {
    const blocks = []
    for (const f of files) {
      const graph = await loadWorkflowFile(f).catch(() => null)
      if (!graph) fail(`not a workflow file: ${f}`)
      blocks.push(files.length > 1 ? `%% ${basename(f)} (${graph.name})\n${toMermaid(graph, state)}` : toMermaid(graph, state))
    }
    process.stdout.write(blocks.join("\n\n") + "\n")
    return
  }

  // file output (exactly one workflow)
  const graph = await loadWorkflowFile(files[0]).catch(() => null)
  if (!graph) fail(`not a workflow file: ${files[0]}`)
  const mermaid = toMermaid(graph, state)
  const out = opts.out || `${graph.name}.svg`

  if (opts.svg || isImage(out)) {
    if (renderImage(mermaid, out, opts.mmdc)) {
      process.stderr.write(`wrote ${out}\n`)
      return
    }
    // Fall back to the .mmd source so nothing is lost, and tell the user how to get the image.
    const mmd = out.replace(/\.(svg|png)$/i, ".mmd")
    writeFileSync(mmd, mermaid + "\n")
    fail(`could not render ${out} (mermaid-cli unavailable). wrote ${mmd} instead.\n  install it: npm i -g @mermaid-js/mermaid-cli   (or pass --mmdc <path>)`)
  }

  const body = /\.md$/i.test(out) ? `\`\`\`mermaid\n${mermaid}\n\`\`\`\n` : mermaid + "\n"
  writeFileSync(out, body)
  process.stderr.write(`wrote ${out}\n`)
}

main()
