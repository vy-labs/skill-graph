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
