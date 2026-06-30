# DSL and semantics reference

`import { workflow, fileExists, shell, marker, not, all, any } from "skill-graph"`

## Building a graph

```js
const wf = workflow("my-flow")          // a named workflow
const a  = wf.skill("a", opts)          // add a node; returns a handle
wf.root(a)                              // the skill that starts a run
export default wf                       // the governor loads the default export
```

### `wf.skill(name, opts)`

`name` is the skill id the agent invokes (`Skill(name)`). The governor matches the live call to it.

| opt | meaning |
|---|---|
| `allowedTools` | `null` (default) means unrestricted. `[]` means skills only, no direct tools. `[…]` means only these tools are allowed for the lead's direct calls at this node. |
| `doneWhen` | a predicate that must hold for the node to count as complete (it gates the joins of its successors). Omit it and the node completes when the agent legally moves on. |
| `join` | `"all"` (default) or `"any"`. For a node with several parents, complete all of them, or at least one, before it unlocks. |
| `loop` | `{ max, noProgress }`. When set, this node's back edges (`loopTo`) draw on the loop guard (see Loops). |

### Edges (handle methods)

| method | edge |
|---|---|
| `a.then(b, c, …)` | forward edge(s) `a` to `b`, `a` to `c`, with no guard. |
| `a.fork(b, c)` | forward edges plus a parallel hint. The downstream join enforces the order. |
| `b.after(p, q)` | declares `b` a join over parents `p` and `q` (sugar for `p` to `b`, `q` to `b`). |
| `a.edge(t, { when, max })` | an explicit edge with an optional guard predicate and an optional per edge loop cap. |
| `a.loopTo(t, { when })` | a back edge (a loop) to an earlier node, bounded by `a`'s `loop` policy. |

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

```js
import { toMermaid } from "skill-graph"
toMermaid(wf.toJSON())            // structure
toMermaid(wf.toJSON(), state)     // with a live overlay (completed in green, active in bold)
```
