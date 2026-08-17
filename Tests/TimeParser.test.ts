import { parseReminderTime, describeReminder, ParseKind } from "../Assets/Scripts/Core/TimeParser.ts"

// Reference: Friday 15 August 2026, 14:30 local.
const NOW = new Date(2026, 7, 15, 14, 30, 0, 0)

let pass = 0
let fail = 0

function fmt(ts: number): string {
  const d = new Date(ts)
  const p = (n: number) => (n < 10 ? "0" + n : "" + n)
  const days = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"]
  return `${days[d.getDay()]} ${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`
}

function check(input: string, expected: string) {
  const r = parseReminderTime(input, NOW)
  const actual = r.kind === ParseKind.Time ? fmt(r.timestamp) : r.kind
  const ok = actual === expected
  if (ok) { pass++ } else { fail++ }
  console.log(`${ok ? "PASS" : "FAIL"}  "${input}"\n        got: ${actual}${ok ? "" : `\n        exp: ${expected}`}`)
}

console.log("NOW =", fmt(NOW.getTime()), "\n")

console.log("--- relative durations ---")
check("in 30 minutes", "Sat 2026-08-15 15:00")
check("in 5 min", "Sat 2026-08-15 14:35")
check("in two hours", "Sat 2026-08-15 16:30")
check("in an hour", "Sat 2026-08-15 15:30")
check("in half an hour", "Sat 2026-08-15 15:00")
check("in 3 days", "Tue 2026-08-18 14:30")
check("in a week", "Sat 2026-08-22 14:30")
check("45 minutes from now", "Sat 2026-08-15 15:15")

console.log("\n--- tomorrow / today ---")
check("tomorrow", "Sun 2026-08-16 09:00")
check("tomorrow at 9am", "Sun 2026-08-16 09:00")
check("tomorrow at 6pm", "Sun 2026-08-16 18:00")
check("tomorrow morning", "Sun 2026-08-16 09:00")
check("tomorrow evening", "Sun 2026-08-16 18:00")
check("today at 5pm", "Sat 2026-08-15 17:00")
check("today at 9am", "Sun 2026-08-16 09:00") // already passed -> next day

console.log("\n--- next unit ---")
check("next week", "Sat 2026-08-22 09:00")
check("next month", "Tue 2026-09-15 09:00")
check("next hour", "Sat 2026-08-15 15:30")

console.log("\n--- explicit dates ---")
check("on 16 august 9am", "Sun 2026-08-16 09:00")
check("on august 16", "Sun 2026-08-16 09:00")
check("on the 20th at 3pm", "Thu 2026-08-20 15:00")
check("on the 3rd", "Thu 2026-09-03 09:00") // 3rd already passed -> next month
check("on 1 september", "Tue 2026-09-01 09:00")
check("december 25 at 8am", "Fri 2026-12-25 08:00")
check("on 1 january", "Fri 2027-01-01 09:00") // rolls to next year

console.log("\n--- weekdays ---")
check("on monday", "Mon 2026-08-17 09:00")
check("next friday", "Fri 2026-08-21 09:00")
check("on wednesday at 3pm", "Wed 2026-08-19 15:00")

console.log("\n--- day parts / clock ---")
check("tonight", "Sat 2026-08-15 20:00")
check("at 9am", "Sun 2026-08-16 09:00")
check("at 17:00", "Sat 2026-08-15 17:00")
check("at 9:30pm", "Sat 2026-08-15 21:30")

console.log("\n--- bare durations (no preposition) ---")
check("10 seconds", "Sat 2026-08-15 14:30")
check("ten minutes", "Sat 2026-08-15 14:40")
check("30 minutes", "Sat 2026-08-15 15:00")
check("2 hours", "Sat 2026-08-15 16:30")
check("3 days", "Tue 2026-08-18 14:30")
check("a week", "Sat 2026-08-22 14:30")

console.log("\n--- declines ---")
check("don't remind me", "none")
check("no reminder", "none")
check("nope", "none")

console.log("\n--- unparseable -> picker ---")
check("sometime after the thing on the weekend maybe", "unparsed")
check("", "unparsed")
check("uhh I don't know", "unparsed")

console.log("\n--- describeReminder ---")
for (const p of ["in 30 minutes", "tomorrow at 9am", "on 16 august 9am", "next week"]) {
  const r = parseReminderTime(p, NOW)
  if (r.kind === ParseKind.Time) console.log(`  "${p}" -> "${describeReminder(r.timestamp, NOW)}"`)
}

console.log(`\n=== ${pass} passed, ${fail} failed ===`)
