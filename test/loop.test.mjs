import { test } from "node:test"
import assert from "node:assert/strict"
import { evaluateGuard, applyRecord } from "../src/loop.mjs"

test("applyRecord appends an iteration", () => {
  const s = applyRecord({ maxIter: 5, history: [] }, { status: "fail", signature: "x" })
  assert.equal(s.history.length, 1)
  assert.deepEqual(s.history[0], { n: 1, status: "fail", signature: "x" })
})

test("applyRecord rejects a bad status", () => {
  assert.throws(() => applyRecord({}, { status: "nope" }), /status must be/)
})

test("evaluateGuard: pass → proceed", () => {
  assert.equal(evaluateGuard({ maxIter: 5, history: [{ status: "pass" }] }).verdict, "proceed")
})

test("evaluateGuard: max-iter → stop", () => {
  const v = evaluateGuard({ maxIter: 2, history: [{ status: "fail", signature: "a" }, { status: "fail", signature: "b" }] })
  assert.equal(v.verdict, "stop")
  assert.equal(v.reason, "max-iter")
})

test("evaluateGuard: same signature twice → stop (no-progress)", () => {
  const v = evaluateGuard({ maxIter: 9, history: [{ status: "fail", signature: "s" }, { status: "fail", signature: "s" }] })
  assert.equal(v.verdict, "stop")
  assert.equal(v.reason, "no-progress")
})

test("evaluateGuard: differing signatures below cap → proceed", () => {
  const v = evaluateGuard({ maxIter: 9, history: [{ status: "fail", signature: "s1" }, { status: "fail", signature: "s2" }] })
  assert.equal(v.verdict, "proceed")
})

test("evaluateGuard: empty/absent history → proceed (continue), iteration 0", () => {
  const v = evaluateGuard({})
  assert.deepEqual(v, { verdict: "proceed", reason: "continue", iteration: 0, maxIter: 5 }) // maxIter defaults to 5
})

test("evaluateGuard: two fails with NULL signatures do not count as no-progress", () => {
  // signature falsy on both sides → the same-signature short-circuit must not fire.
  const v = evaluateGuard({ maxIter: 9, history: [{ status: "fail", signature: null }, { status: "fail", signature: null }] })
  assert.equal(v.verdict, "proceed")
  assert.equal(v.reason, "continue")
})

test("applyRecord: defaults a missing history and a missing signature to null", () => {
  const s = applyRecord({ maxIter: 3 }, { status: "pass" }) // no history field, no signature
  assert.deepEqual(s.history, [{ n: 1, status: "pass", signature: null }])
  assert.equal(s.maxIter, 3) // other fields preserved
})
