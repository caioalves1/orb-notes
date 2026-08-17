/**
 * Live interaction readout, for answering one question: is input reaching the
 * Lens at all, and if so, where does it stop?
 *
 * The three rows are deliberately layered from rawest to most processed:
 *
 *   Touch   - TouchStartEvent / TouchEndEvent bound directly on this script.
 *             Nothing to do with SIK. If these never increment, the click is
 *             being consumed before it reaches the Lens — check the Preview
 *             panel's input mode, since Interactive mode uses mouse drag to
 *             navigate the simulated environment.
 *   Inputs  - every SIK Interactor and whether it reports a trigger. If Touch
 *             increments but no Interactor shows TRIGGER, the problem is SIK
 *             configuration, not the preview.
 *   Gesture - the hold state machine. If an Interactor shows TRIGGER but the
 *             gesture stays idle, the problem is in this project's code.
 *
 * That layering is the whole point: it localizes a failure to one of three
 * places without guesswork.
 */

import { NoteManager } from "./NoteManager"

@component
export class InteractionDebugHud extends BaseScriptComponent {
  @input
  @hint("Turn on to show the interaction readout.")
  enableDebugHud: boolean = false

  @input
  @hint("Text component the readout is written into.")
  readout!: Text

  @input
  @hint("Object holding the readout, hidden when disabled.")
  @allowUndefined
  root!: SceneObject

  @input
  @hint("Manager whose gesture state is reported.")
  @allowUndefined
  noteManager!: NoteManager

  @input
  @widget(new SliderWidget(0.05, 1, 0.05))
  @hint("Seconds between readout refreshes.")
  refreshInterval: number = 0.1

  private touchDownCount: number = 0
  private touchUpCount: number = 0
  private touchMoveCount: number = 0
  private lastTouchAt: number = -1
  private elapsed: number = 0

  onAwake(): void {
    if (!this.enableDebugHud) {
      if (this.root !== null && this.root !== undefined) {
        this.root.enabled = false
      }
      return
    }

    if (this.root !== null && this.root !== undefined) {
      this.root.enabled = true
    }

    // Bound directly, with no SIK involvement, so this row stays truthful even
    // if the interaction kit is misconfigured entirely.
    this.createEvent("TouchStartEvent").bind(() => {
      this.touchDownCount += 1
      this.lastTouchAt = getTime()
    })

    this.createEvent("TouchMoveEvent").bind(() => {
      this.touchMoveCount += 1
      this.lastTouchAt = getTime()
    })

    this.createEvent("TouchEndEvent").bind(() => {
      this.touchUpCount += 1
      this.lastTouchAt = getTime()
    })

    this.createEvent("UpdateEvent").bind(() => {
      this.tick(getDeltaTime())
    })

    print("[InteractionDebugHud] Active. Click and hold in the preview to test.")
  }

  private tick(dt: number): void {
    this.elapsed += dt

    if (this.elapsed < this.refreshInterval) {
      return
    }
    this.elapsed = 0

    if (this.readout === null || this.readout === undefined) {
      return
    }

    this.readout.text = this.buildReadout()
  }

  private buildReadout(): string {
    const lines: string[] = []

    lines.push("-- INTERACTION DEBUG --")
    lines.push(this.touchLine())
    lines.push("")

    const pinch = this.resolvePinch()

    if (pinch === null) {
      lines.push("Inputs: NoteManager not assigned")
      lines.push("Gesture: unknown")
      return lines.join("\n")
    }

    const report = pinch.getInteractorReport()
    lines.push("Inputs (" + report.length + "):")
    for (let i = 0; i < report.length; i++) {
      lines.push("  " + report[i])
    }

    lines.push("")
    lines.push("Gesture: " + pinch.getDebugState())
    lines.push("Driver:  " + pinch.getActiveInputName())
    lines.push("Mic:     " + this.progressBar(this.micLevel()))
    lines.push("MicRaw:  " + this.micDiagnostics())
    lines.push("Notes:   " + this.noteInfo())
    lines.push("Discard under " + this.minRecordText() + "s")

    return lines.join("\n")
  }

  private touchLine(): string {
    const seen = this.touchDownCount + this.touchUpCount + this.touchMoveCount

    if (seen === 0) {
      return "Touch: NONE RECEIVED  <-- input not reaching Lens"
    }

    const age =
      this.lastTouchAt < 0 ? "" : "  (" + (getTime() - this.lastTouchAt).toFixed(1) + "s ago)"

    return (
      "Touch: down=" +
      this.touchDownCount +
      " move=" +
      this.touchMoveCount +
      " up=" +
      this.touchUpCount +
      age
    )
  }

  /** Twenty-cell ASCII bar; readable at a glance without any extra geometry. */
  private progressBar(progress: number): string {
    const cells = 20
    const filled = Math.round(Math.max(0, Math.min(1, progress)) * cells)
    let bar = "["

    for (let i = 0; i < cells; i++) {
      bar += i < filled ? "#" : "."
    }

    return bar + "] " + Math.round(progress * 100) + "%"
  }

  private minRecordText(): string {
    if (this.noteManager === null || this.noteManager === undefined) {
      return "?"
    }
    return this.noteManager.minRecordSeconds.toFixed(2)
  }

  /**
   * Live mic level. Surfacing this is the only way to tell "the orb barely
   * reacts" apart from "the microphone is producing nothing at all".
   */
  private micDiagnostics(): string {
    if (this.noteManager === null || this.noteManager === undefined) {
      return "-"
    }
    if (typeof this.noteManager.getMicDiagnostics !== "function") {
      return "-"
    }
    return this.noteManager.getMicDiagnostics()
  }

  private noteInfo(): string {
    if (this.noteManager === null || this.noteManager === undefined) {
      return "-"
    }
    if (typeof this.noteManager.getNoteDebugInfo !== "function") {
      return "-"
    }
    return this.noteManager.getNoteDebugInfo()
  }

  private micLevel(): number {
    if (this.noteManager === null || this.noteManager === undefined) {
      return 0
    }
    if (typeof this.noteManager.getMicLevel !== "function") {
      return 0
    }
    return this.noteManager.getMicLevel()
  }

  private resolvePinch(): ReturnType<NoteManager["getPinchHold"]> | null {
    if (this.noteManager === null || this.noteManager === undefined) {
      return null
    }
    if (typeof this.noteManager.getPinchHold !== "function") {
      return null
    }
    return this.noteManager.getPinchHold()
  }
}
