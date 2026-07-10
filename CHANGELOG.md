# Changelog

All notable changes to this project are documented here. The format is based on
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project adheres to
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [1.1.0] - 2026-07-10

### Added

- **`allowAlways` command scoping.** Rules now accept an optional `commands` field — a list of globs
  matched against the tool call's command string: `{ tool: "Bash", commands: ["ao report*"] }`. This
  lets a host permit one specific command (e.g. a status command) at *every* node, including phases
  where `Bash` is intentionally denied, without opening `Bash` at large. When a rule has both `paths`
  and `commands`, the call must match at least one glob in at least one present dimension (OR); a
  scoped rule that doesn't match falls through to node gating, so it only ever grants. The command
  string is read from the tool input's `command`, falling back to `cmd` and to a joined argv array
  (Codex shell shapes). Command globs are not path-structured: `*` matches any run of characters —
  including `/`, spaces, and newlines (dotAll), so a `*` spans a multiline command. The match is
  anchored to the whole command (a pattern with no `*` is an exact match), deliberately, so a glob
  can't accidentally match a command that merely contains it. A call carrying no command — or an empty
  command — is never granted by a command-scoped rule.
- `matchCommand(pattern, command)` exported from `src/reducer.mjs` (mirrors `matchGlob`/`matchTool`).

### Notes

- Fully backward compatible: a rule with no `paths`/`commands` behaves exactly as before, and existing
  serialized graphs are unchanged. Node-level `allowedTools` is intentionally *not* command-scoped —
  command scoping lives only in `allowAlways`.

## [1.0.0]

- Initial release.
