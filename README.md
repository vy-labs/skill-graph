<div align="center">

# skill-graph

### Deterministic workflows your AI coding agent can't ignore

Wire the work as a graph of skills, then let a hook enforce it at every step while the agent runs.

</div>

---

## What it is

skill-graph lets you describe an agent workflow as a directed graph of skill nodes. It runs as a
**session governor**: on every tool call, a hook checks where the agent is in the graph and whether the
call is allowed. It blocks anything that leaves the graph and tells the agent why. It holds parallel
branches at a join, runs bounded loops, and draws the whole thing as a Mermaid diagram.

Like n8n, you design the flow as a graph once. Unlike n8n, skill-graph doesn't run the steps; your
agent does, and skill-graph enforces the graph while it works. The rules are binding and the decisions
are deterministic, decided by a pure function rather than the model's goodwill.

## A workflow

```js
import { workflow, fileExists, shell, marker } from "skill-graph"

const wf = workflow("ship-a-feature")

const intake   = wf.skill("intake",     { allowedTools: ["AskUserQuestion"] })
const research = wf.skill("research",   { allowedTools: ["Read", "Grep", "WebFetch"], doneWhen: fileExists("docs/research.md") })
const audit    = wf.skill("audit-deps", { allowedTools: ["Bash", "Read"], doneWhen: fileExists("docs/deps.md") })
const plan     = wf.skill("plan",       { join: "all", allowedTools: ["Write", "Read"], doneWhen: fileExists("PLAN.md") })
const build    = wf.skill("build",      { allowedTools: ["Edit", "Write", "Bash", "Read"] })
const tests    = wf.skill("run-tests",  { allowedTools: ["Bash"], loop: { max: 5, noProgress: true } })
const review   = wf.skill("review",     { allowedTools: ["Read", "Bash"], loop: { max: 3 } })
const release  = wf.skill("release",    { allowedTools: ["Bash"] })

intake.fork(research, audit)                        // research and the dependency audit run in parallel
plan.after(research, audit)                         // plan waits until both finish
plan.then(build)
build.then(tests)
tests.loopTo(build)                                 // a failing suite sends work back to build
tests.edge(review, { when: shell("npm test") })     // a green suite unlocks review
review.loopTo(build)                                // requested changes send work back to build
review.edge(release, { when: marker("review.approved") })

wf.root(intake)
export default wf
```

```mermaid
flowchart TD
  intake --> research
  intake --> audit-deps
  research --> plan
  audit-deps --> plan
  plan --> build
  build --> run-tests
  run-tests --> build
  run-tests -->|npm test| review
  review --> build
  review -->|marker review.approved| release
```

That diagram is exactly what `skill-graph-mermaid` emits for this workflow — see [Visualize](#visualize).

## Why

A capable agent still wanders. It explores when it should delegate, edits before it has a plan, calls
the job done while tests are red, or loops without end. skill-graph makes the shape of the work
explicit and binding.

- **Deterministic.** A pure reducer decides ordering, tool permissions, joins, and loop termination.
  A join waits. A loop is capped. A step that leaves the graph is blocked. Every time.
- **One file, visualized.** The workflow is the documentation. `toMermaid()` (or the `skill-graph-mermaid` CLI) renders it — as text, Markdown, or SVG.
- **Drop in.** It runs on the hook system your harness already has. Install, add one hook, write a workflow.
- **Portable.** A small core with thin adapters for Claude Code and Codex. Adding another harness is one short file.

## Install

```bash
npm install github:vy-labs/skill-graph
npx skill-graph init
```

`skill-graph init` wires the hook for you and scaffolds a starter workflow. It asks for the harness and
scope in a terminal, or takes them as flags: `--scope project|global` (global by default),
`--harness claude|codex`, `--session-start` to add the optional resume hook. Preview without touching
anything using `--print` (shows the settings snippet) or `--dry-run` (shows what it would write). Undo
with `skill-graph uninstall`.

## Quickstart for Claude Code

`npx skill-graph init` does steps 2 and 3 below. To wire it by hand instead:

1. Install the package.
2. Add the hook to `.claude/settings.json` (full snippet in [`examples/claude-code`](./examples/claude-code)):
   ```json
   { "hooks": {
     "PreToolUse":  [{ "matcher": "*", "hooks": [{ "type": "command", "command": "node node_modules/skill-graph/adapters/claude-code.mjs" }] }],
     "SessionStart":[{ "hooks": [{ "type": "command", "command": "node node_modules/skill-graph/adapters/claude-code.mjs" }] }]
   }}
   ```
   The `PreToolUse` hook is the enforcer and is required. The `SessionStart` hook is optional. It
   injects a short "you are here" note for resuming a run in progress, and you can leave it out.
3. Write a workflow at `.skill-graph/your.workflow.mjs` that default exports a `workflow()`.
4. Start the agent. The run begins when it enters the root skill, and the governor takes over.

Codex setup follows the same shape (`npx skill-graph init --harness codex --print`). See
[`examples/codex`](./examples/codex).

## Visualize

The package ships a `skill-graph-mermaid` CLI that renders a workflow to a [Mermaid](https://mermaid.js.org)
flowchart — as text, Markdown, or an image:

```bash
skill-graph-mermaid                                   # all workflows under ./.skill-graph → stdout
skill-graph-mermaid .skill-graph/ship.workflow.mjs    # one workflow → stdout
skill-graph-mermaid ship.workflow.mjs -o flow.md      # Markdown with a fenced ```mermaid block
skill-graph-mermaid ship.workflow.mjs -o flow.svg     # SVG (or .png), or just --svg
skill-graph-mermaid ship.workflow.mjs -s .skill-graph/.state/main.json   # overlay a live run
```

Image output uses the [mermaid-cli](https://github.com/mermaid-js/mermaid-cli) (`mmdc`) if it's on your
`PATH` or via `npx` — it isn't a dependency. Equivalent in code: `toMermaid(wf.toJSON(), state?)`.
Details in [`docs/dsl.md`](./docs/dsl.md#visualizing).

## How it works

**The loop.** The `PreToolUse` hook fires on every tool call and runs a pure reducer (`decide()`) that
returns allow or deny. It reads where the agent is (the active node or nodes) and what it is calling, then:

- allows tools the active node permits and denies the rest, with a reason and the legal next steps;
- completes a node when its `doneWhen` holds, and advances the frontier;
- holds a join until its required parents finish;
- counts loop back-edges and stops a loop at its cap.

Same input, same decision, every time. Run state is persisted per git branch under `.skill-graph/.state/`.

**The pieces** (full reference in [docs/dsl.md](./docs/dsl.md)):

- **Node**: a skill the agent invokes. `allowedTools` limits its direct tools (globs allowed, e.g.
  `"mcp__*"` for every MCP tool); subagents it delegates to run unrestricted.
- **doneWhen**: a predicate (a file exists, a command passes, a marker is written) that completes a
  node. Without one, the node completes when the agent moves on.
- **Edge / guard**: a transition between nodes, optionally gated by a `when` condition for branching.
- **Join**: a node with several parents opens once its join (`all` or `any`) is satisfied.
- **Loop**: `loopTo` adds a back-edge; the loop policy stops at a max count, and early when two
  iterations report the same failure, so a stuck loop never spins.
- **allowAlways**: `wf.allowAlways(rules)` permits tools at *every* node, either outright or only for
  file paths matching globs you supply. The globs are yours; the engine ships none.
- **Override**: `Skill("workflow:override", { to: "<node>" })` is always allowed and recorded, for when
  reality diverges from the plan.

Full reference: [docs/dsl.md](./docs/dsl.md). Hands-on guide: [docs/guide.md](./docs/guide.md).

## Harness support

| Harness | Adapter | Status |
|---|---|---|
| Claude Code | `adapters/claude-code.mjs` | supported (skills are tool calls, so transitions are automatic) |
| Codex | `adapters/codex.mjs` | supported via a sentinel node-entry command (`: skill-graph enter <node>`), since Codex skills are context, not tool calls. See [`examples/codex`](./examples/codex). |
| Gemini, Cursor, Copilot, others | add a short adapter over the shared core | open |

## License

MIT, vy-labs.
