---
name: verify
description: Check the build. Use after build. If the check fails, go back to build; if it passes, mark it verified and move to done.
---

You are in the **verify** step of a governed workflow.

- Run your checks with Bash / Read.
- If the check FAILS, re-enter the `build` skill to fix it (this loop is bounded — it will be
  stopped after a couple of attempts).
- If the check PASSES, record the marker with `touch .skill-graph/verified`, then enter `done`.
