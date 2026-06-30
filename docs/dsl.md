# DSL & semantics reference

`import { workflow, fileExists, shell, marker, not, all, any } from "skill-graph"`

## Building a graph

```js
const wf = workflow("my-flow")          // a named workflow
const a  = wf.skill("a", opts)          // add a node; returns a handle
wf.root(a)                              // the skill that starts a run
export default wf                       // the governor loads the default export
```

### `wf.skill(name, opts)`

`name` is the **skill id the agent invokes** (`Skill(name)`); the governor matches the live call to it.

| opt | meaning |
|---|---|
| `allowedTools` | `null` (default) = unrestricted; `[]` = skills only, no direct tools; `[…]` = only these tools allowed for the **lead's direct** calls at this node. |
| `doneWhen` | a predicate that must hold for the node to count as complete (gates successors' joins). Omit → the node completes when the agent legally moves on. |
| `join` | `"all"` (default) or `"any"` — for a node with multiple parents, complete all / at least one before it unlocks. |
| `loop` | `{ max, noProgress }` — when set, this node's back-edges (`loopTo`) draw on the loop guard (see Loops). |

### Edges (handle methods)

| method | edge |
|---|---|
| `a.then(b, c, …)` | unguarded forward edge(s) `a → b`, `a → c`. |
| `a.fork(b, c)` | forward edges + a parallel hint (the downstream join enforces order). |
| `b.after(p, q)` | declares `b` a join over parents `p, q` (sugar for `p → b`, `q → b`). |
| `a.edge(t, { when, max })` | explicit edge with an optional guard predicate and/or a per-edge loop cap. |
| `a.loopTo(t, { when })` | a **back-edge** (loop) to an earlier node; bounded by `a`'s `loop` policy. |

## Predicates

Descriptors evaluated by the adapter against the project working tree (cwd):

| predicate | true when |
|---|---|
| `fileExists("glob")` | a path matches (supports a single `*`, e.g. `docs/*.md`). |
| `shell("cmd", { fails })` | `cmd` exits 0 (or non-zero with `{ fails: true }`). Evaluated only on transition events (cost). |
| `marker("name")` | `.skill-graph/name` exists (a file the agent writes to signal completion). |
| `not(p)`, `all(p, …)`, `any(p, …)` | boolean combinators. |

## How the governor decides (the reducer)

On each tool call, in order:

1. **Not the lead session** → allow (subagents run free; `allowedTools` governs only the lead).
2. **No run yet** + the event enters a graph's **root skill** → start the run.
3. **`workflow:override`** skill → always allowed, logged; optionally moves the frontier (`{ to }`).
4. **Entering a skill node** → allowed iff it's on the frontier, or an edge from an active node permits
   it (guard true, join satisfied, loop budget left); otherwise **denied** with the legal next steps.
5. **Any other tool** → allowed iff it's in the active node(s)' `allowedTools`; else **denied**.

Every guarantee (join waits, loop caps, off-graph denies) is an explicit branch — deterministic, not a
model judgment.

## Loops

A `loopTo` back-edge from a node with a `loop` policy records a failing iteration and consults the
guard:

- **max-iter** — stop after `max` iterations (a runaway-spend valve).
- **no-progress** — stop early if two consecutive iterations carry the **same failure signature**
  (the adapter supplies the signature via `.skill-graph/.signature`).

Taking a back-edge **resets the loop body** (everything forward-reachable from the target) so it is
genuinely redone. A node without a `loop` policy can still use a per-edge `max` cap on `edge(t, { max })`.

## State

Branch-keyed JSON at `.skill-graph/.state/<branch>.json`:

```jsonc
{ "workflow": "my-flow", "leadSessionId": "…",
  "active": ["…"], "completed": ["…"],
  "loops": { "node-or-edge": … }, "overrides": [ … ] }
```

## Visualizing

```js
import { toMermaid } from "skill-graph"
toMermaid(wf.toJSON())            // structure
toMermaid(wf.toJSON(), state)     // + live overlay (completed = green, active = bold)
```
