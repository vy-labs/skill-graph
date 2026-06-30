// Shared stdin→stdout runner for hook adapters. Reads the harness payload on fd 0, runs the
// adapter's (parse → govern → format) pipeline, emits the formatted envelope (if any), and FAILS
// OPEN on any error — a governor must never break a session.
import { readFileSync } from "node:fs"

export async function run(parse, govern, format) {
  let payload
  try {
    payload = JSON.parse(readFileSync(0, "utf8"))
  } catch {
    process.exit(0) // unreadable input → allow
  }
  try {
    const decision = await govern(parse(payload))
    const out = format(decision)
    if (out) process.stdout.write(JSON.stringify(out))
  } catch {
    /* fail open: emit nothing */
  }
  process.exit(0)
}
