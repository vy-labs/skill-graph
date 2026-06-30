// Harness-agnostic governor core. A thin per-harness adapter (claude-code.mjs, codex.mjs, …) parses
// its harness's hook payload into a NORMALIZED event and calls runGovernor(); the core discovers
// workflows, evaluates predicates, runs the pure reducer, persists branch-keyed state, and returns a
// harness-neutral decision the adapter formats into that harness's envelope.
//
// Normalized event:  { event, toolName, toolInput, cwd, sessionId }
// Returned decision: { action: "allow" | "deny" | "context", reason?, context? }
//
// FAIL-OPEN is the adapter's job (wrap the call); the core simply returns "allow" when nothing is
// governed. All workflow files live in the PROJECT at .skill-graph/*.workflow.js.

import { readFileSync, writeFileSync, mkdirSync, existsSync, readdirSync } from "node:fs"
import { join, dirname, delimiter } from "node:path"
import { execSync } from "node:child_process"
import { pathToFileURL } from "node:url"
import * as SG from "../src/index.mjs"

const { decide, initialState } = SG

export const WORKFLOW_DIR = ".skill-graph"

// ---- pure cores (exported for tests) ----------------------------------------------------------

/** Pick the graph this event concerns: the run's workflow if one is active, else the graph whose root
 *  skill the event is entering. null = nothing governed here. Pure. */
export function selectWorkflow(graphs, state, ev) {
  if (state) return graphs.find((g) => g.name === state.workflow) ?? null
  const target = ev.toolName === "Skill" ? (ev.toolInput?.skill ?? ev.toolInput?.name) : null
  return target ? graphs.find((g) => g.root === target) ?? null : null
}

/** Build the reducer's probe. `evalP(predicate)` is injected so tests can fake predicate results. Pure. */
export function buildProbe(graph, state, ev, { sessionId, evalP, signature }) {
  const doneWhen = {}
  for (const name of Object.keys(graph.nodes)) {
    const dw = graph.nodes[name].doneWhen
    if (dw) doneWhen[name] = evalP(dw)
  }
  const guards = {}
  for (const e of graph.edges) {
    if (e.when) guards[`${e.from}->${e.to}`] = evalP(e.when)
  }
  return { sessionId, doneWhen, guards, signature }
}

/** Evaluate a predicate descriptor against the working tree. `allowShell` gates the expensive shell
 *  predicates so they only run on transition (Skill) events, not on every tool call. */
export function evalPredicate(p, cwd, allowShell) {
  if (!p) return true
  switch (p.kind) {
    case "fileExists":
      return globExists(cwd, p.glob)
    case "marker":
      return existsSync(join(cwd, WORKFLOW_DIR, p.name))
    case "shell":
      if (!allowShell) return false // too expensive to run on every tool call
      try {
        execSync(p.cmd, { cwd, stdio: "ignore" })
        return !p.fails
      } catch {
        return !!p.fails
      }
    case "not":
      return !evalPredicate(p.p, cwd, allowShell)
    case "all":
      return p.ps.every((x) => evalPredicate(x, cwd, allowShell))
    case "any":
      return p.ps.some((x) => evalPredicate(x, cwd, allowShell))
    default:
      return false
  }
}

function globExists(cwd, glob) {
  const abs = join(cwd, glob)
  if (!glob.includes("*")) return existsSync(abs)
  const dir = dirname(abs)
  const pat = new RegExp("^" + abs.slice(dir.length + 1).replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*") + "$")
  try {
    return readdirSync(dir).some((f) => pat.test(f))
  } catch {
    return false
  }
}

// ---- IO ---------------------------------------------------------------------------------------

/** Directories scanned for workflow files: the project's .skill-graph/, plus any in the
 *  SKILL_GRAPH_DIRS env var (path-delimited). A host sets this to the directory of the workflows it
 *  ships, substituting its own install path. Harness neutral: the host decides what that path is. */
export function workflowDirs(cwd, env = process.env) {
  const extra = (env.SKILL_GRAPH_DIRS ?? "").split(delimiter).map((s) => s.trim()).filter(Boolean)
  return [...new Set([join(cwd, WORKFLOW_DIR), ...extra])]
}

/** Discover *.workflow.{js,mjs} across the workflow dirs. A file's default export is either a workflow
 *  builder (has .toJSON()) or a FACTORY (sg) => workflow. The factory form lets a file that cannot
 *  resolve "skill-graph" (for example one shipped inside a plugin, away from the project's node_modules)
 *  still build a graph: the governor injects the DSL. Imports otherwise resolve via normal Node resolution. */
export async function loadGraphs(cwd, env = process.env) {
  const graphs = []
  for (const dir of workflowDirs(cwd, env)) {
    let files = []
    try {
      files = readdirSync(dir).filter((f) => f.endsWith(".workflow.js") || f.endsWith(".workflow.mjs"))
    } catch {
      continue // dir absent or unreadable
    }
    for (const f of files) {
      try {
        const mod = await import(pathToFileURL(join(dir, f)).href)
        let wf = mod.default
        if (typeof wf === "function") wf = wf(SG) // factory: inject the DSL
        if (wf && typeof wf.toJSON === "function") graphs.push(wf.toJSON())
      } catch {
        /* skip an unloadable workflow file */
      }
    }
  }
  return graphs
}

export function branchKey(cwd) {
  try {
    // A repo with commits yields a branch name, or "HEAD" when detached; a commit-less repo (or no
    // git) throws and falls through to "no-git". So the trimmed result is always non-empty here.
    return execSync("git rev-parse --abbrev-ref HEAD", { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim().replace(/[^\w.-]/g, "_")
  } catch {
    return "no-git"
  }
}

function readState(file) {
  try {
    return JSON.parse(readFileSync(file, "utf8"))
  } catch {
    return null
  }
}

function writeState(file, state) {
  try {
    mkdirSync(dirname(file), { recursive: true })
    writeFileSync(file, JSON.stringify(state, null, 2))
  } catch {
    /* best-effort */
  }
}

/** Run the governor for one normalized event. Returns a harness-neutral decision. */
export async function runGovernor({ event, toolName, toolInput, cwd, sessionId }) {
  const graphs = await loadGraphs(cwd)
  if (graphs.length === 0) return { action: "allow" } // no workflow → nothing to govern

  const ev = { toolName, toolInput: toolInput ?? {} }
  const stateFile = join(cwd, WORKFLOW_DIR, ".state", `${branchKey(cwd)}.json`)
  const state = readState(stateFile)
  const graph = selectWorkflow(graphs, state, ev)
  if (!graph) return { action: "allow" }

  // SessionStart carries no tool call, so selectWorkflow can only have returned a graph via an
  // already-persisted run (the root-skill path requires toolName === "Skill"). state is therefore
  // non-null here — surface the active run as resume context.
  if (event === "SessionStart")
    return { action: "context", context: `# skill-graph workflow: ${graph.name}\nActive: ${state.active.join(", ")}. Completed: ${state.completed.join(", ") || "(none)"}.` }

  const isSkill = toolName === "Skill"
  const sigFile = join(cwd, WORKFLOW_DIR, ".signature")
  const signature = existsSync(sigFile) ? readFileSync(sigFile, "utf8").trim() : null
  const probe = buildProbe(graph, state ?? initialState(graph, sessionId ?? "lead"), ev, {
    sessionId: sessionId ?? "lead",
    signature,
    evalP: (p) => evalPredicate(p, cwd, isSkill),
  })

  const decision = decide(graph, state, ev, probe)
  if (decision.next) writeState(stateFile, decision.next)
  return decision.action === "deny" ? { action: "deny", reason: decision.reason } : { action: "allow" }
}
