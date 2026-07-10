// Skill-graph DSL. Builds a serializable workflow graph that the pure reducer (reducer.mjs) consumes
// and the Mermaid renderer (mermaid.mjs) draws. No IO, no model — just data construction.

// ---- predicate descriptors --------------------------------------------------------------------
// Opaque to the reducer for EVALUATION: the hook adapter runs them and passes booleans in via
// `probe`, so the graph stays pure and serializable. `describe` below only RENDERS a descriptor to a
// human label (no IO, no evaluation), which both the reducer's deny hints and Mermaid reuse.
export const fileExists = (glob) => ({ kind: "fileExists", glob })
export const shell = (cmd, { fails = false } = {}) => ({ kind: "shell", cmd, fails })
export const marker = (name) => ({ kind: "marker", name })
export const not = (p) => ({ kind: "not", p })
export const all = (...ps) => ({ kind: "all", ps })
export const any = (...ps) => ({ kind: "any", ps })

/** Render a predicate descriptor to a short human label. Pure; unknown kinds → "". */
export function describe(p) {
  switch (p?.kind) {
    case "fileExists":
      return `exists ${p.glob}`
    case "shell":
      return `${p.cmd}${p.fails ? " fails" : ""}`
    case "marker":
      return `marker ${p.name}`
    case "not":
      return `not ${describe(p.p)}`
    case "all":
      return p.ps.map(describe).join(" & ")
    case "any":
      return p.ps.map(describe).join(" | ")
    default:
      return ""
  }
}

const nameOf = (h) => (typeof h === "string" ? h : h.name)

export function workflow(name) {
  return new Workflow(name)
}

class Workflow {
  constructor(name) {
    this.name = name
    this._root = null
    this.nodes = new Map() // name -> { name, allowedTools, doneWhen, join, loop, model, effort, agent }
    this.edges = [] // { from, to, when, max, fork }
    this._allowAlways = [] // [{ tool, paths? }] — tools allowed at EVERY node (see allowAlways)
  }

  // Tools permitted at every node, regardless of a node's allowedTools. Each rule is
  // { tool, paths?, commands? }:
  //   no `paths`/`commands`     → the tool is allowed everywhere.
  //   `paths: [glob, ...]`      → allowed only when the call's target file path matches a glob.
  //   `commands: [glob, ...]`   → allowed only when the call's command string matches a glob (for Bash:
  //                               permit e.g. a status command at every node, even where Bash is denied).
  // When both `paths` and `commands` are present the call must match at least one glob in at least one
  // present dimension (OR). A scoped rule that doesn't match falls through to the node's normal gating,
  // so it only ever grants. The globs are the HOST's choice — the engine ships none. Calling this more
  // than once appends.
  allowAlways(rules) {
    for (const r of rules) {
      const rule = { tool: r.tool }
      if (r.paths) rule.paths = [...r.paths]
      if (r.commands) rule.commands = [...r.commands]
      this._allowAlways.push(rule)
    }
    return this
  }

  // allowedTools: null = unrestricted; [] = skills only (no direct tools); [..] = only those.
  // loop: { max, noProgress } — when set, this node's back-edges draw on the real loop guard
  //   (max-iter + same-signature no-progress) instead of a simple per-edge counter.
  //
  // Execution profile (all optional, all default null → no change in behavior for graphs that omit
  // them). The reducer/governor NEVER acts on these — a PreToolUse hook can only allow/deny, it can't
  // switch a model or spawn. They are carried on the serialized graph so a HOST driver that runs a
  // node as a subagent can read them: `model` (a harness model alias/id or "inherit"), `effort` (a
  // reasoning-budget level), and `agent` (a companion subagent type to dispatch instead of running the
  // skill in-context). A host with no named-agent registry to resolve `agent` against (e.g. Codex)
  // ignores all three and runs the node in-context.
  skill(name, opts = {}) {
    if (this.nodes.has(name)) throw new Error(`duplicate skill node: ${name}`)
    this.nodes.set(name, {
      name,
      allowedTools: opts.allowedTools ?? null,
      doneWhen: opts.doneWhen ?? null,
      join: opts.join ?? "all",
      loop: opts.loop ?? null,
      model: opts.model ?? null,
      effort: opts.effort ?? null,
      agent: opts.agent ?? null,
    })
    return new Handle(this, name)
  }

  root(handle) {
    this._root = nameOf(handle)
    return this
  }

  _edge(from, to, opts = {}) {
    // A back-edge (a loop) is flagged with `back`, or implied by a per-edge `max` cap.
    this.edges.push({ from, to, when: opts.when ?? null, max: opts.max ?? null, fork: !!opts.fork, back: !!opts.back || opts.max != null })
  }

  toJSON() {
    return {
      name: this.name,
      root: this._root,
      nodes: Object.fromEntries(this.nodes),
      edges: this.edges,
      allowAlways: this._allowAlways,
    }
  }
}

class Handle {
  constructor(wf, name) {
    this.wf = wf
    this.name = name
  }
  // unguarded sequential edge(s) to children
  then(...children) {
    for (const c of children) this.wf._edge(this.name, nameOf(c))
    return this
  }
  // edges to children PLUS a parallel-dispatch hint (the join downstream enforces the order)
  fork(...children) {
    for (const c of children) this.wf._edge(this.name, nameOf(c), { fork: true })
    return this
  }
  // declare this node a join over the given parents (sugar for parent->this edges)
  after(...parents) {
    for (const p of parents) this.wf._edge(nameOf(p), this.name)
    return this
  }
  // explicit edge with an optional guard (`when`) and/or loop cap (`max`, marks a back-edge)
  edge(target, opts = {}) {
    this.wf._edge(this.name, nameOf(target), opts)
    return this
  }
  // a back-edge (loop) to an earlier node; the source node's `loop` policy governs the budget
  loopTo(target, opts = {}) {
    this.wf._edge(this.name, nameOf(target), { ...opts, back: true })
    return this
  }
}
