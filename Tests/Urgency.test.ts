import { resolveBand } from "../Assets/Scripts/Core/Urgency.ts"

const MIN = 60 * 1000
const HOUR = 60 * MIN
const DAY = 24 * HOUR
const WEEK = 7 * DAY

const T = { weekMs: WEEK, dayMs: DAY, hourMs: HOUR }

let pass = 0
let fail = 0

const STOPS = ["A", "B", "C", "D"]

function check(label: string, remaining: number, expected: string) {
  const b = resolveBand(remaining, T)
  const actual =
    b.from === b.to
      ? STOPS[b.from] + " flat"
      : STOPS[b.from] + "->" + STOPS[b.to] + " " + b.t.toFixed(2)

  const ok = actual === expected
  if (ok) { pass++ } else { fail++ }
  console.log(`${ok ? "PASS" : "FAIL"}  ${label.padEnd(18)} ${actual}${ok ? "" : `   expected ${expected}`}`)
}

console.log("--- above a week: flat A ---")
check("1 year", 365 * DAY, "A flat")
check("2 weeks", 2 * WEEK, "A flat")
check("exactly 1 week", WEEK, "A flat")

console.log("\n--- week to day: A -> B ---")
check("6 days", 6 * DAY, "A->B 0.17")
check("4 days", 4 * DAY, "A->B 0.50")
check("2 days", 2 * DAY, "A->B 0.83")
// A boundary resolves to the END of the lower band rather than the start of
// the next. Both express the same colour (A->B at t=1 IS B), so the ramp is
// continuous either way.
check("exactly 1 day", DAY, "A->B 1.00")

console.log("\n--- day to hour: B -> C ---")
check("18 hours", 18 * HOUR, "B->C 0.26")
check("12 hours", 12 * HOUR, "B->C 0.52")
check("2 hours", 2 * HOUR, "B->C 0.96")
check("exactly 1 hour", HOUR, "B->C 1.00")

console.log("\n--- final hour: C -> D ---")
check("45 min", 45 * MIN, "C->D 0.25")
check("30 min", 30 * MIN, "C->D 0.50")
check("6 min", 6 * MIN, "C->D 0.90")
check("due now", 0, "C->D 1.00")

console.log("\n--- past due clamps to D ---")
check("5 min overdue", -5 * MIN, "C->D 1.00")
check("2 days overdue", -2 * DAY, "C->D 1.00")

console.log(`\n=== ${pass} passed, ${fail} failed ===`)
