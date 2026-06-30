# Guide

A hands-on walkthrough. If n8n lets you wire up automation visually, `skill-graph` lets you wire up
your *coding agent's* workflow in code — and have it enforced while the agent runs.

## The idea

You describe the work as a graph of **skills** (phases): what order they go in, which tools the agent
may use in each, when each is "done", and where it loops. A hook runs that graph as a **governor** — on
every tool call it checks "is this allowed from where we are?" and denies what isn't, with a reason the
agent reads and corrects against. The decision is deterministic: a pure function, not the model's
goodwill.

## Install

```bash
npm install github:vy-labs/skill-graph
```

## 1. Write a workflow

Create `.skill-graph/review.workflow.js` in your project:

```js
import { workflow, fileExists, shell } from "skill-graph"

const wf = workflow("review")
const scope   = wf.skill("scoping", { allowedTools: ["AskUserQuestion"] })
const explore = wf.skill("explore", { allowedTools: ["Read", "Grep", "Glob"], doneWhen: fileExists("NOTES.md") })
const fix     = wf.skill("fix",     { allowedTools: ["Edit", "Write", "Bash", "Read"] })
const verify  = wf.skill("verify",  { allowedTools: ["Bash"], loop: { max: 3, noProgress: true } })
const done    = wf.skill("done")

scope.then(explore); explore.then(fix); fix.then(verify)
verify.loopTo(fix)
verify.edge(done, { when: shell("npm test") })
wf.root(scope)
export default wf
```

Read it top to bottom: scope first; in `explore` the agent may only read/search and isn't done until
it has written `NOTES.md`; `fix` may edit/run; `verify` runs the suite and loops back to `fix` until
`npm test` passes (at most 3 tries, stopping early if it keeps failing the same way); then `done`.

## 2. Wire the hook

**Claude Code** — merge into `.claude/settings.json` (full snippet in
[`examples/claude-code/`](../examples/claude-code/)):

```json
{ "hooks": {
  "PreToolUse":  [{ "matcher": "*", "hooks": [{ "type": "command", "command": "node node_modules/skill-graph/adapters/claude-code.mjs" }] }],
  "SessionStart":[{ "hooks": [{ "type": "command", "command": "node node_modules/skill-graph/adapters/claude-code.mjs" }] }]
}}
```

**Codex** — same shape with `adapters/codex.mjs` and the event name as an argument; see
[`examples/codex/`](../examples/codex/).

## 3. Run

Start your agent in the project. The run begins when the agent enters the root skill (`scoping`). From
there:

- Use a tool the current node forbids → **denied**, with the allowed tools listed.
- Try to skip ahead off-graph → **denied**, with the legal next steps.
- `explore` won't hand off until `NOTES.md` exists; `verify` loops to `fix` until tests pass.
- At session start the governor injects a one-liner: where you are, what's done.

## When the graph is wrong for the moment

Reality diverges sometimes. The agent can always invoke `Skill("workflow:override", { to: "<node>" })`
— it's never denied, and every override is logged to the run state. A recurring override is a signal
you're missing an edge; add it to the workflow.

## Loops in depth

`verify.loopTo(fix)` is a back-edge. Each time it's taken, the governor records a failing iteration and
the loop guard decides whether to continue:

- after `max` iterations it stops (a spend ceiling), and
- if two iterations in a row report the **same failure signature**, it stops early as "no-progress".

This is the same guard logic used in production orchestrators — termination is never left to the model
to eyeball.

## Visualize

```js
import { toMermaid } from "skill-graph"
console.log(toMermaid((await import("./.skill-graph/review.workflow.js")).default.toJSON()))
```

Paste the output into any Mermaid renderer to see the flow. Pass the run state as a second argument to
overlay live progress.

## Troubleshooting

- **Nothing is gated.** The run only starts after the agent enters the root skill, and only the *lead*
  session is governed (subagents run free by design). Check the hook is wired and `.skill-graph/` has a
  `*.workflow.js`.
- **A workflow file won't load.** It must `export default` a `workflow()` and be valid ESM resolvable
  from the project (so `import "skill-graph"` resolves — i.e. installed in `node_modules`).
- **An expensive `shell` predicate seems to run a lot.** It doesn't — shell predicates evaluate only on
  skill-transition events, not every tool call.

See [docs/dsl.md](./dsl.md) for the full reference.
