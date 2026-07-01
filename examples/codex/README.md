# skill-graph for Codex

Same model as the [Claude Code example](../claude-code/README.md). The wiring and one concept differ.

## 1. Install

```bash
npm install github:vy-labs/skill-graph
```

## 2. Wire the hook

Codex loads hooks from `~/.codex/config.toml` (`[hooks]`) or `~/.codex/hooks.json`, and from the
repo-level `.codex/` equivalents for trusted projects. Wire `PreToolUse` (required) and, so the
node-entry convention below is injected automatically, `SessionStart`. See
[`hooks.snippet.json`](./hooks.snippet.json):

```json
{ "hooks": {
  "PreToolUse":  [{ "matcher": ".*", "hooks": [{ "type": "command", "command": "node node_modules/skill-graph/adapters/codex.mjs PreToolUse" }] }],
  "SessionStart":[{ "matcher": ".*", "hooks": [{ "type": "command", "command": "node node_modules/skill-graph/adapters/codex.mjs SessionStart" }] }]
}}
```

Each section bakes its event name into the command; the adapter also falls back to the payload's
`hook_event_name`. Codex's tool ids (`shell`, `apply_patch`, …) are mapped to the canonical names
(`Bash`, `Edit`, …) your workflow uses, via `TOOL_MAP`.

## 3. Node entry (Codex-specific)

Unlike Claude Code, a Codex skill is injected context, **not a tool call**, so it fires no hook — the
governor has no skill event to start or advance a run on. Codex hooks *do* fire for shell (Bash), so
skill-graph adopts a sentinel-command convention: signal a transition by running a no-op shell command
the governor intercepts (run it *before* doing that node's work):

```
: skill-graph enter <node>       # enter/adopt a workflow node
: skill-graph override <node>    # escape hatch: force a move (always allowed, recorded)
```

The adapter rewrites these into the `Skill` event the shared reducer already understands (this
translation lives only in `adapters/codex.mjs`; the reducer and the Claude adapter are untouched). The
`SessionStart` hook injects this convention into the session automatically, so the agent knows to emit
it; adding a one-line reminder to each skill's `SKILL.md` improves compliance.

Trade-off: governance on Codex is only as reliable as the agent emitting these signals (skill-graph is
fail-open, so a skipped signal just means that step isn't governed) — whereas on Claude Code a skill
*is* the tool call, so it's automatic.

## 4. Add a workflow

Same workflow file as the Claude example: [`.skill-graph/review.workflow.mjs`](./.skill-graph/review.workflow.mjs).
Workflows are harness neutral.

> Codex hook-config location and tool ids vary by version. The deterministic Codex e2e
> (`node e2e/codex-run.mjs`) validates skill-graph's Codex handling — the sentinel translation,
> per-node tool gating, joins, and the loop cap — through the real Codex adapter, independent of a live
> model. Confirm the hook-config path and `TOOL_MAP` against your Codex build.
