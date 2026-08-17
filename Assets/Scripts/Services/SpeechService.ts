/**
 * Thin wrapper around AsrModule for the two transcription moments in the flow:
 * capturing the note itself, and capturing the spoken reminder time.
 *
 * AsrModule is chosen over VoiceMLModule because it is the Spectacles-native
 * path (every member is tagged @snapOS) and it surfaces interim results, which
 * the transcript panel needs in order to update while the user is still talking.
 *
 * Session lifecycle is the delicate part. `stopTranscribing()` is asynchronous,
 * and calling `startTranscribing()` while a stop is still in flight gets the new
 * session torn down along with the old one — which showed up as "the first note
 * records, every note after it is silent until the Lens is reset". Every start
 * therefore waits for any pending stop to settle, and a generation counter
 * ensures callbacks from a superseded session are discarded rather than
 * delivered to the new one.
 */

export interface SpeechCallbacks {
  /** Fires repeatedly with the best-so-far transcript while the user speaks. */
  onPartial?: (text: string) => void
  /** Fires once with the settled transcript when the session ends. */
  onFinal: (text: string) => void
  /** Fires when the session fails. The flow should degrade, not stall. */
  onError?: (message: string) => void
}

export class SpeechService {
  private asr: any = null
  private callbacks: SpeechCallbacks | null = null
  private latestText: string = ""
  private active: boolean = false
  private available: boolean = false

  /** Incremented on every start/stop so stale callbacks can be ignored. */
  private generation: number = 0
  /**
   * When false, a final result from the recognizer does not end the session.
   *
   * Note capture is bounded by the user releasing the pinch, not by silence.
   * The recognizer emits `isFinal` after its own silence timeout, which was
   * cutting recordings short mid-thought and opening the reminder prompt while
   * the user was still holding. In that mode the finalized text is banked and
   * transcription restarts, so a pause in the middle of a sentence costs
   * nothing.
   */
  private endOnFinal: boolean = true
  /** Text banked from earlier segments of the same recording. */
  private bankedText: string = ""
  /** Retained so a segment can be restarted with the same settings. */
  private silenceMs: number = 4000
  /** Resolves when the in-flight stopTranscribing settles, if there is one. */
  private pendingStop: Promise<void> | null = null

  constructor(injected: any) {
    this.asr = injected

    if (this.asr === null || this.asr === undefined) {
      try {
        this.asr = require("LensStudio:AsrModule")
      } catch (e) {
        this.asr = null
      }
    }

    this.available =
      this.asr !== null &&
      this.asr !== undefined &&
      typeof this.asr.startTranscribing === "function"

    if (!this.available) {
      print(
        "[SpeechService] AsrModule unavailable. Voice capture will be disabled; " +
          "assign an AsrModule asset to the NoteManager to enable it."
      )
    }
  }

  isAvailable(): boolean {
    return this.available
  }

  isListening(): boolean {
    return this.active
  }

  /**
   * Begins a transcription session, after any previous one has fully stopped.
   *
   * @param silenceTerminationMs Pause length that ends the session on its own.
   * @returns false when speech is unavailable, so the caller can fall back.
   */
  start(
    callbacks: SpeechCallbacks,
    silenceTerminationMs: number,
    endOnFinal: boolean = true
  ): boolean {
    if (!this.available) {
      return false
    }

    // Supersede whatever came before. Bumping the generation first means any
    // late callback from the old session is dropped on arrival.
    this.generation += 1
    const generation = this.generation

    if (this.active) {
      this.requestStop()
    }

    this.callbacks = callbacks
    this.latestText = ""
    this.bankedText = ""
    this.endOnFinal = endOnFinal
    this.silenceMs = silenceTerminationMs
    this.active = true

    const begin = () => {
      // A newer start has already superseded this one.
      if (generation !== this.generation) {
        return
      }
      this.beginSession(silenceTerminationMs, generation)
    }

    if (this.pendingStop !== null) {
      // Chained on both paths: a failed stop must not block the next session.
      this.pendingStop.then(begin, begin)
    } else {
      begin()
    }

    return true
  }

  private beginSession(silenceTerminationMs: number, generation: number): void {
    let options: any

    try {
      options = AsrModule.AsrTranscriptionOptions.create()
    } catch (e) {
      print("[SpeechService] Could not create transcription options: " + e)
      this.active = false
      return
    }

    options.mode = AsrModule.AsrMode.Balanced
    options.silenceUntilTerminationMs = silenceTerminationMs

    options.onTranscriptionUpdateEvent.add(
      (event: AsrModule.TranscriptionUpdateEvent) => {
        if (generation !== this.generation) {
          return
        }
        this.handleUpdate(event)
      }
    )

    options.onTranscriptionErrorEvent.add((code: AsrModule.AsrStatusCode) => {
      if (generation !== this.generation) {
        return
      }
      this.handleError(code)
    })

    try {
      this.asr.startTranscribing(options)
    } catch (e) {
      print("[SpeechService] Failed to start transcription: " + e)
      this.active = false
      this.callbacks = null
    }
  }

  /** Banked segments plus the segment in progress. */
  private combined(): string {
    if (this.bankedText.length === 0) {
      return this.latestText
    }
    if (this.latestText.length === 0) {
      return this.bankedText
    }
    return this.bankedText + " " + this.latestText
  }

  /**
   * Starts a fresh recognizer segment within the same logical recording, after
   * the previous one self-terminated on silence.
   */
  private restartSegment(): void {
    if (!this.active) {
      return
    }

    this.generation += 1
    const generation = this.generation

    this.requestStop()

    const begin = () => {
      if (generation !== this.generation || !this.active) {
        return
      }
      this.beginSession(this.silenceMs, generation)
    }

    if (this.pendingStop !== null) {
      this.pendingStop.then(begin, begin)
    } else {
      begin()
    }
  }

  /** Issues a stop and records the promise so the next start can wait on it. */
  private requestStop(): void {
    if (this.asr === null || typeof this.asr.stopTranscribing !== "function") {
      return
    }

    try {
      const result = this.asr.stopTranscribing()

      if (result !== null && result !== undefined && typeof result.then === "function") {
        this.pendingStop = result.then(
          () => {
            this.pendingStop = null
          },
          (e: any) => {
            print("[SpeechService] stopTranscribing rejected: " + e)
            this.pendingStop = null
          }
        )
      } else {
        this.pendingStop = null
      }
    } catch (e) {
      print("[SpeechService] Failed to stop transcription: " + e)
      this.pendingStop = null
    }
  }

  private handleUpdate(event: AsrModule.TranscriptionUpdateEvent): void {
    if (!this.active || this.callbacks === null) {
      return
    }

    const text = event.text === null || event.text === undefined ? "" : event.text

    // Interim results can arrive shorter than what came before as the recognizer
    // revises itself. Keeping the longest non-empty result avoids the panel
    // visibly losing words mid-sentence.
    if (text.length > 0) {
      this.latestText = text
    }

    if (event.isFinal) {
      if (this.endOnFinal) {
        this.finish(this.combined())
        return
      }

      // Bank this segment and keep listening: the recording ends when the user
      // releases, not when they pause for breath.
      this.bankedText = this.combined()
      this.latestText = ""

      if (this.callbacks.onPartial !== undefined) {
        this.callbacks.onPartial(this.bankedText)
      }

      this.restartSegment()
      return
    }

    if (this.callbacks.onPartial !== undefined) {
      this.callbacks.onPartial(this.combined())
    }
  }

  private handleError(code: AsrModule.AsrStatusCode): void {
    const message = this.describeStatus(code)
    print("[SpeechService] Transcription error: " + message)

    const callbacks = this.callbacks
    this.active = false
    this.callbacks = null

    if (callbacks !== null && callbacks.onError !== undefined) {
      callbacks.onError(message)
    }
  }

  /**
   * Ends the session and delivers whatever has been transcribed so far.
   * Used when the user releases the pinch — the release is the end-of-utterance
   * signal, so waiting on a silence timeout would add dead air.
   */
  stop(): void {
    if (!this.active) {
      return
    }

    const text = this.combined()

    this.generation += 1
    this.requestStop()
    this.finish(text)
  }

  /** Ends the session and discards the result. */
  cancel(): void {
    if (!this.active) {
      return
    }

    this.generation += 1
    this.active = false
    this.callbacks = null
    this.latestText = ""
    this.bankedText = ""

    this.requestStop()
  }

  private finish(text: string): void {
    const callbacks = this.callbacks

    this.active = false
    this.callbacks = null
    this.latestText = ""
    this.bankedText = ""

    if (callbacks !== null) {
      callbacks.onFinal(text)
    }
  }

  private describeStatus(code: AsrModule.AsrStatusCode): string {
    if (code === AsrModule.AsrStatusCode.NoInternet) {
      return "No internet connection"
    }
    if (code === AsrModule.AsrStatusCode.Unauthenticated) {
      return "Not signed in"
    }
    if (code === AsrModule.AsrStatusCode.InternalError) {
      return "Speech service error"
    }
    return "Unknown speech error"
  }
}
