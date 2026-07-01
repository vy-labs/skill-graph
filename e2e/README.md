# skill-graph live e2e

> Two harnesses. **Claude Code** runs *live* (`npm run test:e2e`): a real `claude` process driven
> through the workflow. **Codex** runs *deterministic* (`npm run test:e2e:codex`): a replay of
> codex-shaped hook events through the real Codex adapter — because Codex skills are injected context,
> not tool calls, so a live `codex exec` can't drive skill transitions (see [Codex](#codex)). Both
> judge the same governor decision log with the same scenario checks.

A live, end-to-end test. It drives a real headless `claude` process through a governed sample workflow
and checks that the hook enforces the graph. It covers the pass flow (legal steps are allowed) and the
fail flows (illegal steps are blocked with the right reason), including the bounded loop guard.

`npm test` runs unit and integration tests over the engine and adapters. This runs the whole stack the
way a user runs it: a real agent, a real `.claude/settings.json` hook, a real CLI.

```bash
npm run test:e2e                # all scenarios
node e2e/run.mjs loop-cap       # just the ones whose filename matches an arg
E2E_MODEL=sonnet npm run test:e2e
SG_KEEP=1 npm run test:e2e      # keep each sandbox dir for inspection
```

Requires the `claude` CLI on PATH and working auth. It is not part of `npm test` or CI, because it
costs model calls and depends on live model behavior. Runs default to the `haiku` alias for speed and
cost.

## How it works

For each scenario the runner:

1. Builds a fresh sandbox (`lib/sandbox.mjs`): a temp project wired like a real install, with
   `.claude/settings.json` (`PreToolUse` and `SessionStart` hooks pointing at the e2e hook), the
   sample skills under `.claude/skills/`, and the sample workflow under `.skill-graph/`.
2. Drives a real `claude -p` process (`lib/runClaude.mjs`) with a scripted prompt. The agent runs as
   its own top-level (lead) session. This matters: the governor only governs the lead session, and a
   subagent would pass through ungoverned. So a live e2e test must spawn a real `claude` process rather
   than delegate to a subagent.
3. Judges the run from the governor's decision log, not from model output. The e2e hook (`hook.mjs`)
   is the shipped Claude adapter pipeline (`parseClaude`, `runGovernor`, `formatClaude`) plus one
   addition: it tees every decision to a JSONL log. Asserting on what the governor decided is
   deterministic given the agent's tool calls, so an off-script model does not make the verdict flaky.

### Three verdicts

- PASS: the governor allowed a legal step or denied an illegal one.
- FAIL: the governor allowed something it must block, or blocked something it must allow. A real bug
  in skill-graph.
- INCONCLUSIVE: the agent never attempted the governed action (for example, never entered the root
  skill), so there was nothing to judge. Not a skill-graph bug. Re-run or tighten the prompt.

Exit code is `0` only if every scenario passes.

## The sample workflow (`fixtures/ship.workflow.mjs`)

```
research (root)  ->then->  build  ->then->  verify  ->edge (marker "verified")->  done
  Read/Grep/                Edit/Write/      Bash/Read                            Read
  Glob/Write                Read/Bash        loop { max: 2 }
  doneWhen NOTES.md                          loopTo build (bounded back-edge)
```

## Scenarios (`scenarios/`)

| Scenario | Flow | What it proves |
|---|---|---|
| `happy-path` | pass | research, build, verify, done are all allowed; the guarded marker edge into `done` clears |
| `forbidden-tool` | fail | Bash at `research` is denied ("not permitted"): per-node tool gating |
| `off-graph-jump` | fail | entering `done` from the start (skipping build, verify, marker) is denied ("cannot enter"): structural edges |
| `loop-cap` | loop | the first build/verify back-edge is allowed; the one exceeding `max:2` is denied ("loop stopped") |

## Adding a scenario

Drop a `scenarios/<name>.mjs` default-exporting `{ name, intent, prompt, check(entries) }`. `entries`
are the parsed decision-log lines (`{ event, tool, target, path, action, reason, active, completed }`).
Helpers live in `lib/assert.mjs`. Return `verdict(PASS|FAIL|INCONCLUSIVE, detail)`.

## Codex

Run with `npm run test:e2e:codex` (or `node e2e/codex-run.mjs`). It reuses the same four scenarios and
their `check()`s, but the driver differs, for a real reason:

- **Why deterministic, not live.** A Codex skill is *injected context, not a tool call*, so it fires no
  hook — the governor has no skill event to start or advance a run on (Claude Code's skills *are* tool
  calls, which is why its suite runs live). Codex hooks *do* fire for shell, so skill-graph signals node
  entry with a sentinel command (`: skill-graph enter <node>`, see [`examples/codex`](../examples/codex))
  that `parseCodex` rewrites into the canonical `Skill` event.
- **What it exercises.** `e2e/codex-run.mjs` replays a codex-shaped journey (sentinel enters + real
  `shell`/`apply_patch` events + file side effects) through the **real** Codex hook binary
  (`e2e/hook.codex.mjs` → `parseCodex` → `codexGovern` → `formatCodex` → tee). So it proves the sentinel
  translation, per-node tool gating (`shell`→`Bash`), joins, the marker-gated edge, and the loop cap —
  the whole Codex path — without a live model.
- **Live `codex exec`.** Not wired: it's slow, and (in probing) repo-level hook config didn't load in a
  throwaway sandbox without project trust. Once the hook is wired where Codex loads it (global config or
  a trusted project), a live run is possible; the deterministic suite is the reliable coverage today.

The translation is confined to `adapters/codex.mjs`; the reducer and the Claude adapter are untouched,
so the live Claude suite is unaffected.
