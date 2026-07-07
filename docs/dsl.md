# DSL and semantics reference

`import { workflow, fileExists, shell, marker, not, all, any } from "skill-graph"`

## Building a graph

```js
const wf = workflow("my-flow")          // a named workflow
const a  = wf.skill("a", opts)          // add a node; returns a handle
wf.root(a)                              // the skill that starts a run
export default wf                       // the governor loads the default export
```

### Two export forms

A `.workflow.{js,mjs}` file's default export is either the workflow itself, or a **factory** that
receives the DSL and returns a workflow:

```js
// direct: the common case, when the file can import the package
import { workflow } from "skill-graph"
export default workflow("my-flow") /* … */

// factory: when the file cannot resolve "skill-graph" (for example a workflow shipped inside a plugin,
// away from the project's node_modules). The governor injects the DSL.
export default (sg) => {
  const wf = sg.workflow("my-flow")
  // sg also has fileExists, shell, marker, not, all, any
  return wf
}
```

### Where workflows are discovered

By default the governor scans the project's `.skill-graph/` directory. Set the `SKILL_GRAPH_DIRS`
environment variable (path delimited) to add more directories, which lets a host point at the workflows
it ships:

```bash
SKILL_GRAPH_DIRS="/path/to/shipped/.skill-graph" node node_modules/skill-graph/adapters/claude-code.mjs
```

The host substitutes its own install path. Each harness's wiring, including how it provides that path,
lives in the [examples](../examples).

### `wf.skill(name, opts)`

`name` is the skill id the agent invokes (`Skill(name)`). The governor matches the live call to it.

| opt | meaning |
|---|---|
| `allowedTools` | `null` (default) means unrestricted. `[]` means skills only, no direct tools. `[…]` means only these tools are allowed for the lead's direct calls at this node. An entry may use `*` as a tool-name glob — `"mcp__*"` permits every MCP tool without listing them; an entry with no `*` is an exact match. |
| `doneWhen` | a predicate that must hold for the node to count as complete (it gates the joins of its successors). Omit it and the node completes when the agent legally moves on. |
| `join` | `"all"` (default) or `"any"`. For a node with several parents, complete all of them, or at least one, before it unlocks. |
| `loop` | `{ max, noProgress }`. When set, this node's back edges (`loopTo`) draw on the loop guard (see Loops). |
| `model` | optional (default `null`). A harness model alias/id, or `"inherit"`. Carried on the serialized graph for a host driver to read — the governor never acts on it (a PreToolUse hook can't switch a model). |
| `effort` | optional (default `null`). A reasoning-budget level for a host driver. Carried, never enforced by the governor. |
| `agent` | optional (default `null`). A companion subagent type a host driver may dispatch to run this node instead of running the skill in-context. A host with no named-agent registry to resolve it against (e.g. Codex) ignores it and runs in-context. |

`model`/`effort`/`agent` are the **execution profile**: they let a graph declare *how* a node should
run (which model tier, how much reasoning, in-context vs. delegated to a subagent) as data on the
node. The governor stays a pure allow/deny state machine and ignores them; enforcement is the host's
job — a driver reads them off `toJSON()` and spawns accordingly. Omit them and nothing changes.

### Edges (handle methods)

| method | edge |
|---|---|
| `a.then(b, c, …)` | forward edge(s) `a` to `b`, `a` to `c`, with no guard. |
| `a.fork(b, c)` | forward edges plus a parallel hint. The downstream join enforces the order. |
| `b.after(p, q)` | declares `b` a join over parents `p` and `q` (sugar for `p` to `b`, `q` to `b`). |
| `a.edge(t, { when, max })` | an explicit edge with an optional guard predicate and an optional per edge loop cap. |
| `a.loopTo(t, { when })` | a back edge (a loop) to an earlier node, bounded by `a`'s `loop` policy. |

### `wf.allowAlways(rules)` — tools permitted at every node

Some tools should be allowed everywhere without repeating them in each node's `allowedTools`, and a host
often needs to write its own bookkeeping files at any node *without* opening `Write` wholesale. `rules`
is an array of `{ tool, paths? }`:

- **no `paths`** — the tool is allowed at every node, regardless of the node's `allowedTools`.
- **`paths: [glob, …]`** — the tool is allowed only when the call's target file path matches one of the
  globs; otherwise the call falls through to the node's normal gating. This keeps a delegation gate
  intact (e.g. "at the context node you must delegate, not write the artifact yourself") while still
  letting the host persist its own state.

Calling `allowAlways` more than once appends. It serialises as `graph.allowAlways` (default `[]`, so
existing workflows are unchanged). **The globs are the host's choice — the engine ships none.**

`tool` is itself a name pattern: a `*` globs a family (`"mcp__*"` grants every MCP tool), and a name
with no `*` is an exact match. A tool-name glob composes with the path globs — both must match.

```js
wf.allowAlways([
  { tool: "Read" },                                            // reading is always fine
  { tool: "Task" }, { tool: "Agent" },                         // delegating to subagents is always fine
  { tool: "Write", paths: [".myhost/**", ".skill-graph/**"] }, // host bookkeeping only — not Write at large
  { tool: "Edit",  paths: [".myhost/**", ".skill-graph/**"] },
])
```

The checked path comes from the tool call's `file_path`, `path`, or `filePath`. Globs match a path
string purely (no filesystem): `*` stays within a segment, `**` crosses segments, and a relative glob
like `.myhost/**` matches whether the harness reports a relative `.myhost/x` or an absolute
`/abs/project/.myhost/x` (it matches at any `/` boundary). A tool that carries no path field is never
granted by a path-scoped rule — it stays gated by the node.
## Predicates

Descriptors the adapter evaluates against the project working tree (cwd):

| predicate | true when |
|---|---|
| `fileExists("glob")` | a path matches (supports a single `*`, for example `docs/*.md`). |
| `shell("cmd", { fails })` | `cmd` exits 0, or exits non zero with `{ fails: true }`. Evaluated only on transition events, for cost. |
| `marker("name")` | `.skill-graph/name` exists (a file the agent writes to signal completion). |
| `not(p)`, `all(p, …)`, `any(p, …)` | boolean combinators. |

## How the governor decides (the reducer)

On each tool call, in order:

1. Not the lead session, so allow. Subagents run free. `allowedTools` governs only the lead.
2. No run yet, and the event enters a graph's root skill, so start the run.
3. The `workflow:override` skill, so always allow, record it, and optionally move the frontier (`{ to }`).
4. Entering a skill node. Allowed when it sits on the frontier, or an edge from an active node permits it
   (the guard is true, the join is satisfied, the loop budget remains). Otherwise blocked, with the legal
   next steps named.
5. Any other tool. Allowed when it is in the active node's `allowedTools`. Otherwise blocked.

Every guarantee (a join waits, a loop caps, a step that leaves the graph is blocked) is an explicit
branch. The outcome is deterministic, not a model judgment.

### What a denial tells you

A deny is navigational, not just a refusal. The `reason` string is mirrored by machine-readable fields
so a consumer can recover structurally instead of parsing prose:

| denial | `reason` names | structured fields |
|---|---|---|
| wrong node (no edge from the frontier) | the legal next steps, and any guard-blocked nodes | `legalNext: [...]`, `pending: [{ to, needs }]` |
| join not satisfied | the parents still outstanding | `waitingOn: [...]` |
| guard not satisfied | the unmet condition, and `workflow:override` | `guard: <predicate descriptor>` |
| tool not permitted here | the allowed tools | `allowedTools: [...]` |
| loop cap / no-progress | the reason and iteration `n/max`, and `workflow:override` | `loop: { reason, iteration, maxIter }` |

`pending` is the key navigational aid: a node reachable from the frontier but not open yet because its
guard is unmet appears here (with the condition to satisfy), rather than being invisible — `legalNext`
lists only what is traversable right now.

## Loops

A `loopTo` back edge from a node with a `loop` policy records a failing iteration and consults the guard:

- **Maximum count.** Stop after `max` iterations, a runaway spend valve.
- **No progress.** Stop early when two iterations in a row carry the same failure signature. The adapter
  supplies that signature through `.skill-graph/.signature`.

Taking a back edge resets the loop body (everything reachable forward from the target) so it is genuinely
redone. A node without a `loop` policy can still use a per edge cap with `edge(t, { max })`.

## State

Branch keyed JSON at `.skill-graph/.state/<branch>.json`:

```jsonc
{ "workflow": "my-flow", "leadSessionId": "…",
  "active": ["…"], "completed": ["…"],
  "loops": { "node or edge": … }, "overrides": [ … ] }
```

## Visualizing

Programmatically:

```js
import { toMermaid } from "skill-graph"
toMermaid(wf.toJSON())            // structure
toMermaid(wf.toJSON(), state)     // with a live overlay (completed in green, active in bold)
```

Or from the command line with the bundled `skill-graph-mermaid` bin:

```bash
# print Mermaid text (discovers .skill-graph/*.workflow.{mjs,js} when no path is given)
skill-graph-mermaid
skill-graph-mermaid .skill-graph/review.workflow.mjs

# write a file — the extension picks the format
skill-graph-mermaid review.workflow.mjs -o flow.md     # Markdown, fenced ```mermaid block
skill-graph-mermaid review.workflow.mjs -o flow.svg     # SVG (or .png) via the mermaid-cli
skill-graph-mermaid review.workflow.mjs --svg           # → review.svg

# overlay a live run (completed green, active bold)
skill-graph-mermaid review.workflow.mjs -s .skill-graph/.state/main.json
```

SVG/PNG output shells out to the [mermaid-cli](https://github.com/mermaid-js/mermaid-cli) (`mmdc`),
which is **not** a dependency: the bin uses `mmdc` from your `PATH`, falls back to `npx`, or takes an
explicit `--mmdc <path>`. If none is available it writes the `.mmd` source and tells you how to install
it. Run `skill-graph-mermaid --help` for all options.
