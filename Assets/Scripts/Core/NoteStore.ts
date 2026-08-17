/**
 * Persistence layer for spatial notes.
 *
 * The whole collection is serialized to a single JSON string in
 * PersistentStorageSystem's key-value store. Notes are small and few, so
 * rewriting the collection on every mutation is cheaper and far simpler than
 * maintaining per-note keys with an index.
 *
 * Positions are stored in world space relative to the world tracking origin.
 * Within a session that origin is stable, so notes hold their place exactly.
 * Across sessions the origin is re-established by the platform, so restored
 * notes are only as accurate as that re-localization — see README for the
 * hardware check this still needs.
 */

import {
  NOTE_SCHEMA_VERSION,
  NoteCollection,
  NoteData,
  sanitizeNote
} from "./NoteModel"

const STORAGE_KEY = "spatialTaskNotes.v1"

export class NoteStore {
  private notes: NoteData[] = []
  private loaded: boolean = false

  /**
   * Reads the collection from persistent storage. Safe to call more than once;
   * subsequent calls are no-ops.
   *
   * A corrupt or unreadable store is treated as an empty one rather than an
   * error: losing notes is bad, but refusing to launch is worse.
   */
  load(): NoteData[] {
    if (this.loaded) {
      return this.notes
    }
    this.loaded = true

    const store = global.persistentStorageSystem.store
    let raw: string = ""

    try {
      raw = store.getString(STORAGE_KEY)
    } catch (e) {
      print("[NoteStore] Could not read storage, starting empty: " + e)
      this.notes = []
      return this.notes
    }

    if (raw === null || raw === undefined || raw.length === 0) {
      this.notes = []
      return this.notes
    }

    this.notes = this.deserialize(raw)
    return this.notes
  }

  private deserialize(raw: string): NoteData[] {
    let parsed: unknown

    try {
      parsed = JSON.parse(raw)
    } catch (e) {
      print("[NoteStore] Stored notes were not valid JSON, discarding: " + e)
      return []
    }

    if (parsed === null || typeof parsed !== "object") {
      return []
    }

    const collection = parsed as Partial<NoteCollection>

    if (!Array.isArray(collection.notes)) {
      return []
    }

    if (collection.version !== NOTE_SCHEMA_VERSION) {
      print(
        "[NoteStore] Schema version " +
          collection.version +
          " does not match " +
          NOTE_SCHEMA_VERSION +
          "; discarding stored notes."
      )
      return []
    }

    const result: NoteData[] = []
    let skipped = 0

    for (let i = 0; i < collection.notes.length; i++) {
      const note = sanitizeNote(collection.notes[i])
      if (note === null) {
        skipped += 1
      } else {
        result.push(note)
      }
    }

    if (skipped > 0) {
      print("[NoteStore] Skipped " + skipped + " unreadable note(s).")
    }

    return result
  }

  /** All notes currently held. Returns the live array; do not mutate directly. */
  getAll(): NoteData[] {
    this.load()
    return this.notes
  }

  find(id: string): NoteData | null {
    const all = this.getAll()
    for (let i = 0; i < all.length; i++) {
      if (all[i].id === id) {
        return all[i]
      }
    }
    return null
  }

  add(note: NoteData): void {
    this.load()
    this.notes.push(note)
    this.save()
  }

  remove(id: string): boolean {
    this.load()
    for (let i = 0; i < this.notes.length; i++) {
      if (this.notes[i].id === id) {
        this.notes.splice(i, 1)
        this.save()
        return true
      }
    }
    return false
  }

  /** Applies a mutation to one note and persists the result. */
  update(id: string, mutate: (note: NoteData) => void): boolean {
    const note = this.find(id)
    if (note === null) {
      return false
    }
    mutate(note)
    this.save()
    return true
  }

  clear(): void {
    this.load()
    this.notes = []
    this.save()
  }

  /** Writes the collection back to persistent storage. */
  save(): void {
    const collection: NoteCollection = {
      version: NOTE_SCHEMA_VERSION,
      notes: this.notes
    }

    try {
      global.persistentStorageSystem.store.putString(
        STORAGE_KEY,
        JSON.stringify(collection)
      )
    } catch (e) {
      print("[NoteStore] Failed to persist notes: " + e)
    }
  }

  /**
   * Notes whose reminder has come due but has not yet been shown, most overdue
   * first. This is what surfaces missed reminders when the Lens is reopened —
   * the platform has no background wake-up, so anything that came due while the
   * Lens was closed is caught here on the next launch.
   */
  dueNotes(now: number): NoteData[] {
    const due: NoteData[] = []
    const all = this.getAll()

    for (let i = 0; i < all.length; i++) {
      const note = all[i]
      if (note.reminderAt !== null && !note.fired && now >= note.reminderAt) {
        due.push(note)
      }
    }

    due.sort(function (a: NoteData, b: NoteData): number {
      // Both have a non-null reminderAt by construction above.
      return (a.reminderAt as number) - (b.reminderAt as number)
    })

    return due
  }
}
