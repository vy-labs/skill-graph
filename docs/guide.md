# Guide

A hands on walkthrough. If n8n lets you wire automation visually, skill-graph lets you wire your coding
agent's workflow in code, and have it enforced while the agent runs.

## The idea

You describe the work as a graph of skills. You say what order they run in, which tools the agent may
use in each, when each one is done, and where it loops. A hook then runs that graph as a governor. On
every tool call it checks "is this allowed from where we are?" and blocks what is not, with a reason the
agent reads and corrects against. The decision is a pure function, so it behaves the same way every run.

## Install

```bash
npm install github:vy-labs/skill-graph
```

## 1. Write a workflow

Create `.skill-graph/review.workflow.mjs` in your project. Workflow files are ES modules. The `.mjs`
name loads in any project, and a `.workflow.js` name also works when your project sets
`"type": "module"`. The governor discovers both.

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

Read it top to bottom. Scope first. In explore the agent may only read and search, and it is not done
until it has written `NOTES.md`. In fix it may edit and run. In verify it runs the suite and loops back
to fix until `npm test` passes, at most three tries, stopping early if it keeps failing the same way.
Then done.

## 2. Wire the hook

For Claude Code, merge this into `.claude/settings.json` (full snippet in
[`examples/claude-code`](../examples/claude-code)):

```json
{ "hooks": {
  "PreToolUse":  [{ "matcher": "*", "hooks": [{ "type": "command", "command": "node node_modules/skill-graph/adapters/claude-code.mjs" }] }],
  "SessionStart":[{ "hooks": [{ "type": "command", "command": "node node_modules/skill-graph/adapters/claude-code.mjs" }] }]
}}
```

The `PreToolUse` hook is the enforcer and is required. The `SessionStart` hook is optional. It injects a
short "you are here" note that helps the agent resume a run already in progress. You can leave it out and
the governor still works.

For Codex, use the same shape with `adapters/codex.mjs` and the event name as an argument. See
[`examples/codex`](../examples/codex).

## 3. Run

Start your agent in the project. The run begins when the agent enters the root skill (`scoping`). From
there the governor blocks a tool the current node forbids and tells you the allowed set, blocks an
attempt to skip ahead off the graph and lists the legal next steps, holds explore until `NOTES.md`
exists, and loops verify back to fix until the tests pass.

## When the graph is wrong for the moment

Reality diverges sometimes. The agent can always invoke `Skill("workflow:override", { to: "<node>" })`.
It is never blocked, and every override is recorded in the run state. A recurring override is a signal
that you are missing an edge, so add it to the workflow.

## Loops in depth

`verify.loopTo(fix)` is a back edge. Each time it is taken, the governor records a failing iteration and
the loop guard decides whether to continue. It stops after the maximum count, a spend ceiling. It also
stops early when two iterations in a row report the same failure, which it treats as no progress. This is
the same guard logic used in production orchestrators. Termination is never left to the model to eyeball.

## Visualize

```js
import { toMermaid } from "skill-graph"
console.log(toMermaid((await import("./.skill-graph/review.workflow.mjs")).default.toJSON()))
```

Paste the output into any Mermaid renderer to see the flow. Pass the run state as a second argument to
overlay live progress.

## Troubleshooting

- **Nothing is gated.** The run starts only after the agent enters the root skill, and only the lead
  session is governed (subagents run free by design). Check that the hook is wired and that
  `.skill-graph/` holds a `*.workflow.mjs`.
- **A workflow file does not load.** It must default export a `workflow()` and be valid ESM resolvable
  from the project, so `import "skill-graph"` resolves (the package installed in `node_modules`).
- **An expensive `shell` predicate seems to run often.** It does not. Shell predicates evaluate only on
  skill transition events, not on every tool call.

See [docs/dsl.md](./dsl.md) for the full reference.
