/**
 * Data model for a single spatial task note.
 *
 * Notes are stored as plain JSON so the whole collection can round-trip through
 * PersistentStorageSystem's string store. Vectors are kept as number tuples
 * rather than vec3/quat because those engine types are not JSON-serializable.
 */

export interface NoteData {
  /** Stable unique id, generated once at capture time. */
  id: string
  /** Final transcript from the ASR session. */
  transcript: string
  /** World-space position in cm, relative to the world tracking origin. */
  position: [number, number, number]
  /** World-space rotation as a quaternion (x, y, z, w). */
  rotation: [number, number, number, number]
  /** Epoch milliseconds at which the note was captured. */
  createdAt: number
  /** Epoch milliseconds the reminder is due, or null when not time-sensitive. */
  reminderAt: number | null
  /** Whether the reminder alert has already been surfaced to the user. */
  fired: boolean
}

/** Current schema version, bumped whenever NoteData changes shape. */
export const NOTE_SCHEMA_VERSION = 1

export interface NoteCollection {
  version: number
  notes: NoteData[]
}

let idCounter = 0

/**
 * Generates a unique note id. Combines capture time with a monotonic counter so
 * two notes captured within the same millisecond still differ.
 */
export function createNoteId(now: number): string {
  idCounter += 1
  return "note_" + now.toString(36) + "_" + idCounter.toString(36)
}

export function createNote(
  transcript: string,
  position: [number, number, number],
  rotation: [number, number, number, number],
  now: number,
  reminderAt: number | null
): NoteData {
  return {
    id: createNoteId(now),
    transcript: transcript,
    position: position,
    rotation: rotation,
    createdAt: now,
    reminderAt: reminderAt,
    fired: false
  }
}

/** True when the note has a reminder that has come due and not yet been shown. */
export function isDue(note: NoteData, now: number): boolean {
  return note.reminderAt !== null && !note.fired && now >= note.reminderAt
}

/** True when the note carries a reminder at all. */
export function isTimeSensitive(note: NoteData): boolean {
  return note.reminderAt !== null
}

/**
 * How overdue a note is, in milliseconds. Notes that are not yet due return a
 * negative value; notes without a reminder sort last via -Infinity.
 */
export function overdueBy(note: NoteData, now: number): number {
  if (note.reminderAt === null) {
    return Number.NEGATIVE_INFINITY
  }
  return now - note.reminderAt
}

/**
 * Validates and normalizes a value parsed from storage. Returns null when the
 * record is unusable, so a single corrupt entry cannot take down the whole load.
 */
export function sanitizeNote(raw: unknown): NoteData | null {
  if (raw === null || typeof raw !== "object") {
    return null
  }
  const candidate = raw as Partial<NoteData>

  if (typeof candidate.id !== "string" || candidate.id.length === 0) {
    return null
  }
  if (typeof candidate.transcript !== "string") {
    return null
  }
  if (!isNumberTuple(candidate.position, 3)) {
    return null
  }
  if (!isNumberTuple(candidate.rotation, 4)) {
    return null
  }
  if (typeof candidate.createdAt !== "number" || !isFinite(candidate.createdAt)) {
    return null
  }

  const reminderAt =
    typeof candidate.reminderAt === "number" && isFinite(candidate.reminderAt)
      ? candidate.reminderAt
      : null

  return {
    id: candidate.id,
    transcript: candidate.transcript,
    position: [candidate.position[0], candidate.position[1], candidate.position[2]],
    rotation: [
      candidate.rotation[0],
      candidate.rotation[1],
      candidate.rotation[2],
      candidate.rotation[3]
    ],
    createdAt: candidate.createdAt,
    reminderAt: reminderAt,
    fired: candidate.fired === true
  }
}

function isNumberTuple(value: unknown, length: number): value is number[] {
  if (!Array.isArray(value) || value.length !== length) {
    return false
  }
  for (let i = 0; i < length; i++) {
    const entry = value[i]
    if (typeof entry !== "number" || !isFinite(entry)) {
      return false
    }
  }
  return true
}
