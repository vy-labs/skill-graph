# skill-graph × Claude Code — example

A 3-minute setup: install, wire one hook, drop a workflow, watch it govern.

## 1. Install

```bash
npm install github:vy-labs/skill-graph
```

## 2. Wire the hook

Merge [`settings.snippet.json`](./settings.snippet.json) into your `.claude/settings.json`
(project-level) — it points `SessionStart` and `PreToolUse` at the Claude Code adapter:

```json
{ "hooks": {
  "PreToolUse":  [{ "matcher": "*", "hooks": [{ "type": "command", "command": "node node_modules/skill-graph/adapters/claude-code.mjs" }] }],
  "SessionStart":[{ "hooks": [{ "type": "command", "command": "node node_modules/skill-graph/adapters/claude-code.mjs" }] }]
}}
```

## 3. Add a workflow

Copy [`.skill-graph/review.workflow.js`](./.skill-graph/review.workflow.js) into your project's
`.skill-graph/` directory. It defines `scoping → explore → fix → verify ⇄ fix → done`.

## 4. Use it

Start Claude Code in the project. When the agent enters the root skill (`scoping`), the run begins.
From then on the governor:

- **denies** tools the current node doesn't allow (e.g. `Edit` during `explore`) with a reason,
- **holds** `explore` until `NOTES.md` exists (`doneWhen`),
- **loops** `verify → fix` until `npm test` passes (max 3, stops early on no-progress),
- **injects** "you are here / allowed next" at session start.

Run state lives in `.skill-graph/.state/<branch>.json` (gitignored). To leave the graph deliberately,
the agent can invoke `Skill(workflow:override, { to: "<node>" })` — always allowed, and logged.

See the repo [README](../../README.md) and [docs/guide.md](../../docs/guide.md) for the full model.
