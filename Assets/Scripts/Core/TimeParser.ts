/**
 * On-device natural-language reminder-time parser.
 *
 * Resolves a bounded set of spoken phrases into an absolute epoch timestamp,
 * using a caller-supplied "now" as the reference point. Everything here is pure
 * and engine-free so it can be reasoned about and tested in isolation.
 *
 * Anything outside the supported phrase set returns Unparsed, which the caller
 * is expected to handle by falling back to the manual date/time picker. Failing
 * to a picker is always preferable to guessing a wrong reminder time.
 */

export const ParseKind = {
  /** A concrete reminder time was resolved. */
  Time: "time",
  /** The user explicitly declined a reminder. */
  NoReminder: "none",
  /** Nothing recognizable; caller should fall back to the picker. */
  Unparsed: "unparsed"
} as const

export type ParseKind = (typeof ParseKind)[keyof typeof ParseKind]

export interface ParseResult {
  kind: ParseKind
  /** Epoch milliseconds. Only meaningful when kind === Time. */
  timestamp: number
  /** The fragment that produced the match, for UI confirmation copy. */
  matched: string
}

const MINUTE = 60 * 1000
const HOUR = 60 * MINUTE
const DAY = 24 * HOUR

const NUMBER_WORDS: { [key: string]: number } = {
  a: 1,
  an: 1,
  one: 1,
  two: 2,
  three: 3,
  four: 4,
  five: 5,
  six: 6,
  seven: 7,
  eight: 8,
  nine: 9,
  ten: 10,
  eleven: 11,
  twelve: 12,
  thirteen: 13,
  fourteen: 14,
  fifteen: 15,
  twenty: 20,
  thirty: 30,
  forty: 40,
  fortyfive: 45,
  fifty: 50,
  sixty: 60,
  ninety: 90
}

const MONTHS: { [key: string]: number } = {
  january: 0,
  jan: 0,
  february: 1,
  feb: 1,
  march: 2,
  mar: 2,
  april: 3,
  apr: 3,
  may: 4,
  june: 5,
  jun: 5,
  july: 6,
  jul: 6,
  august: 7,
  aug: 7,
  september: 8,
  sep: 8,
  sept: 8,
  october: 9,
  oct: 9,
  november: 10,
  nov: 10,
  december: 11,
  dec: 11
}

const WEEKDAYS: { [key: string]: number } = {
  sunday: 0,
  sun: 0,
  monday: 1,
  mon: 1,
  tuesday: 2,
  tue: 2,
  tues: 2,
  wednesday: 3,
  wed: 3,
  thursday: 4,
  thu: 4,
  thurs: 4,
  friday: 5,
  fri: 5,
  saturday: 6,
  sat: 6
}

/** Phrases that mean "do not set a reminder". */
const DECLINE_PATTERNS = [
  /\bdon'?t remind me\b/,
  /\bdo not remind me\b/,
  /\bno reminder\b/,
  /\bnot time sensitive\b/,
  /\bno time\b/,
  /\bwhenever\b/,
  /\bskip\b/,
  /\bno thanks\b/,
  /\bnope\b/,
  /^\s*no\s*$/
]

/** Named times of day, as hour-of-day in 24h form. */
const DAY_PARTS: { [key: string]: number } = {
  morning: 9,
  noon: 12,
  midday: 12,
  afternoon: 14,
  evening: 18,
  tonight: 20,
  night: 20,
  midnight: 0
}

/**
 * Parses a spoken reminder phrase into an absolute timestamp.
 *
 * @param input Raw transcript from the ASR session.
 * @param now Reference point. Pass the real current time; injectable for tests.
 */
export function parseReminderTime(input: string, now: Date): ParseResult {
  const text = normalize(input)

  if (text.length === 0) {
    return unparsed()
  }

  for (let i = 0; i < DECLINE_PATTERNS.length; i++) {
    if (DECLINE_PATTERNS[i].test(text)) {
      return { kind: ParseKind.NoReminder, timestamp: 0, matched: text }
    }
  }

  // Order matters: more specific patterns are tried before looser ones so that
  // "tomorrow at 9am" is not swallowed by the bare "tomorrow" rule.
  const strategies = [
    parseRelativeDuration,
    parseExplicitDate,
    parseDayOfMonth,
    parseWeekday,
    parseTomorrowOrToday,
    parseNextUnit,
    parseDayPart,
    parseBareDuration,
    parseClockTime
  ]

  for (let i = 0; i < strategies.length; i++) {
    const result = strategies[i](text, now)
    if (result !== null) {
      return result
    }
  }

  return unparsed()
}

/** Lowercases, strips punctuation, and collapses whitespace. */
function normalize(input: string): string {
  return input
    .toLowerCase()
    .replace(/[.,!?;]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
}

function unparsed(): ParseResult {
  return { kind: ParseKind.Unparsed, timestamp: 0, matched: "" }
}

function time(timestamp: number, matched: string): ParseResult {
  return { kind: ParseKind.Time, timestamp: timestamp, matched: matched }
}

/** Resolves "5" or "thirty" or "half" into a number. */
function wordToNumber(token: string): number | null {
  if (token === "half") {
    return 0.5
  }
  if (/^\d+$/.test(token)) {
    return parseInt(token, 10)
  }
  const word = NUMBER_WORDS[token]
  return word === undefined ? null : word
}

/**
 * "in 30 minutes", "in two hours", "in half an hour", "in a day", "30 min from now"
 */
function parseRelativeDuration(text: string, now: Date): ParseResult | null {
  const pattern =
    /\b(?:in|after)\s+([a-z0-9]+)\s*(?:an?\s+)?(second|seconds|sec|secs|minute|minutes|min|mins|hour|hours|hr|hrs|day|days|week|weeks|month|months)\b/
  let match = text.match(pattern)

  if (match === null) {
    const fromNow =
      /\b([a-z0-9]+)\s*(?:an?\s+)?(second|seconds|sec|secs|minute|minutes|min|mins|hour|hours|hr|hrs|day|days|week|weeks|month|months)\s+from\s+now\b/
    match = text.match(fromNow)
  }

  if (match === null) {
    return null
  }

  const amount = wordToNumber(match[1])
  if (amount === null || amount <= 0) {
    return null
  }

  const unitMs = durationUnitToMs(match[2])
  if (unitMs === null) {
    return null
  }

  return time(now.getTime() + amount * unitMs, match[0])
}

function durationUnitToMs(unit: string): number | null {
  if (unit.indexOf("sec") === 0) {
    return 1000
  }
  if (unit.indexOf("min") === 0) {
    return MINUTE
  }
  if (unit.indexOf("hour") === 0 || unit.indexOf("hr") === 0) {
    return HOUR
  }
  if (unit.indexOf("day") === 0) {
    return DAY
  }
  if (unit.indexOf("week") === 0) {
    return 7 * DAY
  }
  if (unit.indexOf("month") === 0) {
    return 30 * DAY
  }
  return null
}

/**
 * "on 16 august", "august 16", "on the 16th at 9am", "16 aug 9am"
 */
function parseExplicitDate(text: string, now: Date): ParseResult | null {
  // "<day> <month>" e.g. "16 august", "16th aug"
  let match = text.match(
    /\b(?:on\s+)?(?:the\s+)?(\d{1,2})(?:st|nd|rd|th)?\s+(?:of\s+)?([a-z]+)\b/
  )
  let day: number
  let monthName: string

  if (match !== null && MONTHS[match[2]] !== undefined) {
    day = parseInt(match[1], 10)
    monthName = match[2]
  } else {
    // "<month> <day>" e.g. "august 16", "aug 16th"
    match = text.match(/\b(?:on\s+)?([a-z]+)\s+(?:the\s+)?(\d{1,2})(?:st|nd|rd|th)?\b/)
    if (match === null || MONTHS[match[1]] === undefined) {
      return null
    }
    monthName = match[1]
    day = parseInt(match[2], 10)
  }

  const month = MONTHS[monthName]
  if (day < 1 || day > 31) {
    return null
  }

  const clock = extractClockTime(text)
  const hour = clock === null ? 9 : clock.hour
  const minute = clock === null ? 0 : clock.minute

  let year = now.getFullYear()
  let candidate = new Date(year, month, day, hour, minute, 0, 0)

  // A date that already passed this year is assumed to mean next year.
  if (candidate.getTime() <= now.getTime()) {
    candidate = new Date(year + 1, month, day, hour, minute, 0, 0)
  }

  // Guard against rollover from an invalid day for the month (e.g. 31 February).
  if (candidate.getDate() !== day) {
    return null
  }

  return time(candidate.getTime(), match[0])
}

/**
 * "on the 20th", "the 3rd at 5pm" — a day of the month with no month named.
 * Resolves within the current month, rolling forward when the day has passed.
 *
 * The ordinal suffix is required: without it, bare numbers from durations and
 * clock times would be misread as calendar days.
 */
function parseDayOfMonth(text: string, now: Date): ParseResult | null {
  const match = text.match(/\b(?:on\s+)?the\s+(\d{1,2})(?:st|nd|rd|th)\b/)
  if (match === null) {
    return null
  }

  const day = parseInt(match[1], 10)
  if (day < 1 || day > 31) {
    return null
  }

  const clock = extractClockTime(text)
  const hour = clock === null ? 9 : clock.hour
  const minute = clock === null ? 0 : clock.minute

  let candidate = new Date(now.getFullYear(), now.getMonth(), day, hour, minute, 0, 0)

  if (candidate.getDate() !== day) {
    // Day does not exist in this month (e.g. "the 31st" in February).
    candidate = new Date(now.getFullYear(), now.getMonth() + 1, day, hour, minute, 0, 0)
    if (candidate.getDate() !== day) {
      return null
    }
  } else if (candidate.getTime() <= now.getTime()) {
    candidate = new Date(now.getFullYear(), now.getMonth() + 1, day, hour, minute, 0, 0)
    if (candidate.getDate() !== day) {
      return null
    }
  }

  return time(candidate.getTime(), match[0])
}

/**
 * "on monday", "next friday", "this thursday at 3pm"
 */
function parseWeekday(text: string, now: Date): ParseResult | null {
  const match = text.match(/\b(?:(next|this)\s+)?([a-z]+day|mon|tue|tues|wed|thu|thurs|fri|sat|sun)\b/)
  if (match === null) {
    return null
  }

  const target = WEEKDAYS[match[2]]
  if (target === undefined) {
    return null
  }

  const clock = extractClockTime(text)
  const hour = clock === null ? 9 : clock.hour
  const minute = clock === null ? 0 : clock.minute

  const current = now.getDay()
  let delta = target - current

  if (delta < 0) {
    delta += 7
  }

  if (delta === 0) {
    // Same weekday: "this monday" on a Monday means today if the time is still
    // ahead, otherwise a week out. "next monday" always means a week out.
    const todayAt = atTime(now, hour, minute)
    if (match[1] === "next" || todayAt.getTime() <= now.getTime()) {
      delta = 7
    }
  }

  // "next friday" and "on friday" both resolve to the next occurrence of that
  // weekday. English is genuinely ambiguous here — for some speakers "next
  // friday" skips the upcoming one — but resolving to the nearest occurrence
  // keeps the reminder early rather than a week late, and stays consistent with
  // the bare "on friday" reading.

  const base = new Date(now.getTime() + delta * DAY)
  return time(atTime(base, hour, minute).getTime(), match[0])
}

/**
 * "tomorrow", "tomorrow at 9am", "today at 5", "later today"
 */
function parseTomorrowOrToday(text: string, now: Date): ParseResult | null {
  const isTomorrow = /\btomorrow\b/.test(text)
  const isToday = /\btoday\b/.test(text) || /\blater\b/.test(text)

  if (!isTomorrow && !isToday) {
    return null
  }

  const clock = extractClockTime(text)
  const dayPart = extractDayPart(text)

  let hour: number
  let minute: number

  if (clock !== null) {
    hour = clock.hour
    minute = clock.minute
  } else if (dayPart !== null) {
    hour = dayPart
    minute = 0
  } else if (isTomorrow) {
    hour = 9
    minute = 0
  } else {
    // Bare "later today" with no time: nudge an hour out rather than inventing
    // a clock time the user never said.
    return time(now.getTime() + HOUR, "later today")
  }

  const base = isTomorrow ? new Date(now.getTime() + DAY) : now
  let result = atTime(base, hour, minute)

  // "today at 8" said at 9pm should not resolve into the past.
  if (!isTomorrow && result.getTime() <= now.getTime()) {
    result = atTime(new Date(now.getTime() + DAY), hour, minute)
  }

  return time(result.getTime(), isTomorrow ? "tomorrow" : "today")
}

/**
 * "next week", "next month", "next hour"
 */
function parseNextUnit(text: string, now: Date): ParseResult | null {
  const match = text.match(/\bnext\s+(hour|day|week|month|year)\b/)
  if (match === null) {
    return null
  }

  const unit = match[1]
  if (unit === "hour") {
    return time(now.getTime() + HOUR, match[0])
  }
  if (unit === "day") {
    return time(atTime(new Date(now.getTime() + DAY), 9, 0).getTime(), match[0])
  }
  if (unit === "week") {
    return time(atTime(new Date(now.getTime() + 7 * DAY), 9, 0).getTime(), match[0])
  }
  if (unit === "month") {
    const next = new Date(now.getTime())
    next.setMonth(next.getMonth() + 1)
    return time(atTime(next, 9, 0).getTime(), match[0])
  }
  const nextYear = new Date(now.getTime())
  nextYear.setFullYear(nextYear.getFullYear() + 1)
  return time(atTime(nextYear, 9, 0).getTime(), match[0])
}

/**
 * "tonight", "this evening", "in the morning"
 */
function parseDayPart(text: string, now: Date): ParseResult | null {
  const hour = extractDayPart(text)
  if (hour === null) {
    return null
  }

  let result = atTime(now, hour, 0)
  if (result.getTime() <= now.getTime()) {
    result = atTime(new Date(now.getTime() + DAY), hour, 0)
  }

  return time(result.getTime(), "that time of day")
}

function extractDayPart(text: string): number | null {
  const keys = Object.keys(DAY_PARTS)
  for (let i = 0; i < keys.length; i++) {
    const key = keys[i]
    if (new RegExp("\\b" + key + "\\b").test(text)) {
      return DAY_PARTS[key]
    }
  }
  return null
}

/**
 * A duration with no preposition: "10 seconds", "five minutes", "2 hours".
 *
 * People drop the "in" constantly when answering a direct question — asked
 * "when should I remind you?", "ten minutes" is a complete answer. Requiring the
 * preposition sent these straight to the fallback picker.
 *
 * Runs late so that phrases owned by a more specific rule ("on the 20th",
 * "tomorrow at 9") are never intercepted, and requires an explicit unit word so
 * a bare number can still be read as a clock time.
 */
function parseBareDuration(text: string, now: Date): ParseResult | null {
  const match = text.match(
    /\b([a-z0-9]+)\s*(seconds?|secs?|minutes?|mins?|hours?|hrs?|days?|weeks?|months?)\b/
  )

  if (match === null) {
    return null
  }

  const amount = wordToNumber(match[1])
  if (amount === null || amount <= 0) {
    return null
  }

  const unitMs = durationUnitToMs(match[2])
  if (unitMs === null) {
    return null
  }

  return time(now.getTime() + amount * unitMs, match[0])
}

/**
 * "at 9am", "at 9:30 pm", "at 17:00". Resolves to the next occurrence.
 */
function parseClockTime(text: string, now: Date): ParseResult | null {
  const clock = extractClockTime(text)
  if (clock === null) {
    return null
  }

  let result = atTime(now, clock.hour, clock.minute)
  if (result.getTime() <= now.getTime()) {
    result = atTime(new Date(now.getTime() + DAY), clock.hour, clock.minute)
  }

  return time(result.getTime(), clock.matched)
}

interface ClockTime {
  hour: number
  minute: number
  matched: string
}

/**
 * Pulls a clock time out of a phrase. Handles "9am", "9:30pm", "at 17:00",
 * and bare "at 5" (interpreted as the daytime reading, 5pm).
 *
 * Candidates are tried most-specific first rather than taking the first number
 * in the string. In "december 25 at 8am" the leading "25" is a date, not an
 * hour, so a naive left-to-right scan would find an invalid hour and give up.
 */
function extractClockTime(text: string): ClockTime | null {
  // 1. Explicit meridiem is unambiguous: "8am", "9:30 pm".
  const withMeridiem = text.match(/\b(\d{1,2})(?::(\d{2}))?\s*(am|pm|a m|p m)\b/)
  if (withMeridiem !== null) {
    let hour = parseInt(withMeridiem[1], 10)
    const minute = withMeridiem[2] === undefined ? 0 : parseInt(withMeridiem[2], 10)
    if (hour > 12 || minute > 59) {
      return null
    }
    const meridiem = withMeridiem[3].replace(/\s/g, "")
    if (meridiem === "pm" && hour < 12) {
      hour += 12
    } else if (meridiem === "am" && hour === 12) {
      hour = 0
    }
    return { hour: hour, minute: minute, matched: withMeridiem[0] }
  }

  // 2. Colon form is also unambiguous: "17:00", "at 9:05".
  const withColon = text.match(/\b(\d{1,2}):(\d{2})\b/)
  if (withColon !== null) {
    const hour = parseInt(withColon[1], 10)
    const minute = parseInt(withColon[2], 10)
    if (hour > 23 || minute > 59) {
      return null
    }
    return { hour: hour, minute: minute, matched: withColon[0] }
  }

  // 3. Bare "at <n>". Requires the "at" preposition, otherwise a stray number
  //    from a date or duration would be misread as an hour.
  const bare = text.match(/\bat\s+(\d{1,2})\b/)
  if (bare !== null) {
    let hour = parseInt(bare[1], 10)
    if (hour > 23) {
      return null
    }
    if (hour >= 1 && hour <= 7) {
      // "at 5" almost always means the afternoon in a reminder context.
      hour += 12
    }
    return { hour: hour, minute: 0, matched: bare[0] }
  }

  return null
}

/** Returns a new Date on the same calendar day as `base`, at the given time. */
function atTime(base: Date, hour: number, minute: number): Date {
  return new Date(
    base.getFullYear(),
    base.getMonth(),
    base.getDate(),
    hour,
    minute,
    0,
    0
  )
}

/**
 * Human-readable summary of a resolved reminder, for confirmation UI.
 * e.g. "in 30 min", "tomorrow 09:00", "Wed 16 Aug 14:30"
 */
export function describeReminder(timestamp: number, now: Date): string {
  const delta = timestamp - now.getTime()

  if (delta < 0) {
    return "overdue"
  }
  if (delta < HOUR) {
    return "in " + Math.max(1, Math.round(delta / MINUTE)) + " min"
  }

  const target = new Date(timestamp)
  const clock = pad(target.getHours()) + ":" + pad(target.getMinutes())

  if (isSameDay(target, now)) {
    return "today " + clock
  }

  const tomorrow = new Date(now.getTime() + DAY)
  if (isSameDay(target, tomorrow)) {
    return "tomorrow " + clock
  }

  const dayNames = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"]
  const monthNames = [
    "Jan", "Feb", "Mar", "Apr", "May", "Jun",
    "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"
  ]

  return (
    dayNames[target.getDay()] +
    " " +
    target.getDate() +
    " " +
    monthNames[target.getMonth()] +
    " " +
    clock
  )
}

/**
 * Countdown copy for a selected note: "9 min left", "2h 15m left",
 * "5 min overdue". Deliberately terse — it sits under an orb, not in a list.
 */
export function describeRemaining(reminderAt: number | null, now: number): string {
  if (reminderAt === null) {
    return "No reminder"
  }

  const delta = reminderAt - now
  const overdue = delta < 0
  let seconds = Math.floor(Math.abs(delta) / 1000)

  const days = Math.floor(seconds / 86400)
  seconds -= days * 86400
  const hours = Math.floor(seconds / 3600)
  seconds -= hours * 3600
  const minutes = Math.floor(seconds / 60)
  seconds -= minutes * 60

  let body: string

  if (days > 0) {
    body = days + "d " + hours + "h"
  } else if (hours > 0) {
    // Seconds are kept below a day so the display visibly ticks.
    body = hours + ":" + pad(minutes) + ":" + pad(seconds)
  } else {
    body = pad(minutes) + ":" + pad(seconds)
  }

  return overdue ? body + " overdue" : body + " left"
}

function isSameDay(a: Date, b: Date): boolean {
  return (
    a.getFullYear() === b.getFullYear() &&
    a.getMonth() === b.getMonth() &&
    a.getDate() === b.getDate()
  )
}

function pad(value: number): string {
  return value < 10 ? "0" + value : "" + value
}
