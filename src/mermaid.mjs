// Render a workflow graph (and, optionally, a live run's state) to a Mermaid flowchart. Pure.

import { describe } from "./graph.mjs"

function edgeLabel(e) {
  const parts = []
  if (e.when) parts.push(describe(e.when))
  if (e.max != null) parts.push(`≤${e.max}`) // ≤N
  return parts.join(", ")
}

export function toMermaid(graph, state) {
  const lines = ["flowchart TD"]
  for (const e of graph.edges) {
    const lbl = edgeLabel(e)
    lines.push(`  ${e.from} -->${lbl ? `|${lbl}|` : ""} ${e.to}`)
  }
  if (state) {
    // Overlay live progress: completed = green, active (not yet done) = bold outline.
    for (const n of state.completed) lines.push(`  class ${n} done`)
    for (const n of state.active) if (!state.completed.includes(n)) lines.push(`  class ${n} active`)
    lines.push("  classDef done fill:#bbf7d0,stroke:#16a34a")
    lines.push("  classDef active stroke-width:3px,stroke:#2563eb")
  }
  return lines.join("\n")
}
