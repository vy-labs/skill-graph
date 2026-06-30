// Example skill-graph workflow: a small explore → fix → verify loop.
//
// A node's name is the skill id your agent invokes (Skill(<name>)). allowedTools limits the LEAD's
// direct tools at each phase. The verify node loops back to fix until `npm test` passes (max 3 tries).
//
// Drop this in your project's .skill-graph/ and wire the hook (see ../README.md).

import { workflow, fileExists, shell } from "skill-graph"

const wf = workflow("review")

const scope = wf.skill("scoping", { allowedTools: ["AskUserQuestion"] })
const explore = wf.skill("explore", { allowedTools: ["Read", "Grep", "Glob"], doneWhen: fileExists("NOTES.md") })
const fix = wf.skill("fix", { allowedTools: ["Edit", "Write", "Bash", "Read"] })
const verify = wf.skill("verify", { allowedTools: ["Bash", "Read"], loop: { max: 3, noProgress: true } })
const done = wf.skill("done")

scope.then(explore)
explore.then(fix)
fix.then(verify)
verify.loopTo(fix) // tests failed → go fix again (bounded by the loop policy)
verify.edge(done, { when: shell("npm test") }) // tests pass → done

wf.root(scope)

export default wf
