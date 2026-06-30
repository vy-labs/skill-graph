# skill-graph × Codex — example

Same model as the [Claude Code example](../claude-code/README.md); only the wiring differs.

## 1. Install

```bash
npm install github:vy-labs/skill-graph
```

## 2. Wire the hook

Codex implements Claude Code's hook contract, with two differences the `codex` adapter handles:
- Codex passes the **event name as an argument** (`… codex.mjs PreToolUse`), and
- Codex's **tool ids differ** (`shell`, `read_file`, …) — `adapters/codex.mjs` maps them to the
  canonical names (`Bash`, `Read`, …) your workflow uses, via its `TOOL_MAP`.

Add [`hooks.snippet.json`](./hooks.snippet.json) to your Codex hook configuration (place it where your
Codex version reads hooks — see the Codex docs for the exact location):

```json
{ "hooks": {
  "PreToolUse":  [{ "matcher": "*", "hooks": [{ "type": "command", "command": "node node_modules/skill-graph/adapters/codex.mjs PreToolUse" }] }],
  "SessionStart":[{ "hooks": [{ "type": "command", "command": "node node_modules/skill-graph/adapters/codex.mjs SessionStart" }] }]
}}
```

## 3. Add a workflow

Same workflow file as the Claude example — [`.skill-graph/review.workflow.js`](./.skill-graph/review.workflow.js).
Workflows are harness-neutral: the adapter's `TOOL_MAP` keeps a single workflow working across Claude
Code and Codex.

> Note: verify the exact Codex hook-config path and tool ids against your Codex version, and adjust
> `TOOL_MAP` in `adapters/codex.mjs` if your build names tools differently.
