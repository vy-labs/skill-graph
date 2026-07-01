// Minimal sample workflow for the LIVE e2e (see e2e/README.md). Factory form so it loads with no
// "skill-graph" import — the adapter injects the DSL. Four skill nodes with a bounded loop, chosen to
// exercise every governor guarantee a real agent can hit in one short run:
//
//   research (root) — Read/Grep/Glob/Write; Bash is NOT allowed here.   doneWhen: NOTES.md exists
//        │  then
//   build           — Edit/Write/Read/Bash.
//        │  then
//   verify          — Bash/Read; loop:{ max: 2 }.
//        │ ├─ loopTo build            (a failing check sends work back — a bounded back-edge)
//        └─┤ edge → done when marker "verified"   (a passing check unlocks the exit)
//   done            — Read only.
//
// What each flow demonstrates:
//   PASS   research → NOTES.md → build → verify → (marker verified) → done      every step allowed
//   LOOP   build ⇄ verify: the 1st loop-back is ALLOWED (iteration recorded), the one that would
//          exceed max:2 is DENIED "loop stopped … max-iter" — the cap the model cannot talk past
//   FAIL   Bash while at research               → deny "not permitted at [research]"
//   FAIL   enter verify while still at research  → deny "cannot enter verify … legal next: build"
export default (sg) => {
  const wf = sg.workflow("ship")
  const research = wf.skill("research", { allowedTools: ["Read", "Grep", "Glob", "Write"], doneWhen: sg.fileExists("NOTES.md") })
  const build = wf.skill("build", { allowedTools: ["Edit", "Write", "Read", "Bash"] })
  const verify = wf.skill("verify", { allowedTools: ["Bash", "Read"], loop: { max: 2 } })
  const done = wf.skill("done", { allowedTools: ["Read"] })

  research.then(build)
  build.then(verify)
  verify.loopTo(build) // failing verification loops back to build; the loop guard caps it at max:2
  verify.edge(done, { when: sg.marker("verified") }) // a passing check (marker) unlocks the exit
  wf.root(research)
  return wf
}
