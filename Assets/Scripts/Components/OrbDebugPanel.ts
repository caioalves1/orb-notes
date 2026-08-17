/**
 * Live tuning rig for the orb look.
 *
 * Enable it and a row of orbs appears in front of the camera, each locked to one
 * state you would otherwise have to record a real note to see:
 *
 *   Recording  ->  Settled  ->  No reminder  ->  Far  ->  Halfway  ->  Due
 *
 * Every frame it re-copies the tuning values off the Orb Template's NoteOrb, so
 * dragging a slider in the Inspector updates all six orbs immediately without
 * restarting the Lens. That is the whole point: tune against every state at
 * once, in motion, instead of guessing from a single static orb.
 *
 * Urgency samples hold their position on the gradient by having their synthetic
 * reminder time recomputed each frame, so "halfway" stays halfway instead of
 * drifting toward due while you work.
 */

import { NoteData } from "../Core/NoteModel"
import { OrbAppearance } from "../Core/OrbAppearance"
import { NoteManager } from "./NoteManager"
import { NoteOrb, OrbState } from "./NoteOrb"

/** One sample in the row. */
interface DebugSample {
  label: string
  /** Remaining time to the reminder. null renders the no-reminder colour. */
  remainingMs: number | null
  recording: boolean
  orb: NoteOrb | null
  note: NoteData | null
  /** Forces the reminder into the past so the overdue look can be inspected. */
  overdue?: boolean
}

const MINUTE_MS = 60 * 1000
const HOUR_MS = 60 * MINUTE_MS
const DAY_MS = 24 * HOUR_MS

@component
export class OrbDebugPanel extends BaseScriptComponent {
  @input
  @hint("Turn on to show the tuning row. Leave off for normal use.")
  enableDebugPanel: boolean = false

  @input
  @hint("Orb Template to clone and to read tuning values from.")
  orbTemplate!: SceneObject

  @input
  @hint("Parent for the preview orbs.")
  container!: SceneObject

  @input
  @hint("Supplies the urgency colours and horizon, so the preview matches the real thing.")
  noteManager!: NoteManager

  @input
  @hint("Camera the row is placed in front of.")
  @allowUndefined
  camera!: Camera

  @ui.separator
  @input
  @widget(new SliderWidget(30, 200, 5))
  @hint("Distance in front of the camera, in centimetres.")
  distance: number = 80

  @input
  @widget(new SliderWidget(5, 40, 1))
  @hint("Horizontal gap between preview orbs, in centimetres.")
  spacing: number = 14

  @input
  @widget(new SliderWidget(-40, 40, 1))
  @hint("Vertical offset of the row, in centimetres.")
  heightOffset: number = 0

  @input
  @hint("Show a caption under each orb naming its state.")
  showLabels: boolean = true

  @input
  @widget(new SliderWidget(0, 1, 0.05))
  @hint("Synthetic mic level floor for the recording sample.")
  simulatedAudioFloor: number = 0.15

  private samples: DebugSample[] = []
  private ready: boolean = false
  private elapsed: number = 0

  onAwake(): void {
    if (!this.enableDebugPanel) {
      return
    }

    this.createEvent("OnStartEvent").bind(() => {
      this.build()
    })

    this.createEvent("UpdateEvent").bind(() => {
      this.tick(getDeltaTime())
    })
  }

  private build(): void {
    if (this.orbTemplate === null || this.orbTemplate === undefined) {
      print("[OrbDebugPanel] Orb Template is not assigned.")
      return
    }
    if (this.container === null || this.container === undefined) {
      print("[OrbDebugPanel] Container is not assigned.")
      return
    }

    // One sample per band boundary plus one mid-band, so every stop and every
    // blend between them can be judged side by side.
    this.samples = [
      { label: "Recording", remainingMs: null, recording: true, orb: null, note: null },
      { label: "Settled", remainingMs: null, recording: false, orb: null, note: null },
      { label: "No reminder", remainingMs: null, recording: false, orb: null, note: null },
      { label: "2 weeks (Week)", remainingMs: 14 * DAY_MS, recording: false, orb: null, note: null },
      { label: "3 days", remainingMs: 3 * DAY_MS, recording: false, orb: null, note: null },
      { label: "1 day (Day)", remainingMs: DAY_MS, recording: false, orb: null, note: null },
      { label: "12 hours", remainingMs: 12 * HOUR_MS, recording: false, orb: null, note: null },
      { label: "1 hour (Hour)", remainingMs: HOUR_MS, recording: false, orb: null, note: null },
      { label: "20 min", remainingMs: 20 * MINUTE_MS, recording: false, orb: null, note: null },
      { label: "Due", remainingMs: 0, recording: false, orb: null, note: null },
      { label: "Past due", remainingMs: 0, recording: false, orb: null, note: null, overdue: true }
    ]

    for (let i = 0; i < this.samples.length; i++) {
      this.buildSample(this.samples[i], i)
    }

    this.ready = true
    print("[OrbDebugPanel] Tuning row active. Edit the Orb Template's NoteOrb to update live.")
  }

  private buildSample(sample: DebugSample, index: number): void {
    const copy = this.container.copyWholeHierarchy(this.orbTemplate)

    if (copy === null || copy === undefined) {
      return
    }

    copy.enabled = true
    copy.name = "Debug Orb - " + sample.label

    const orb = copy.getComponent(NoteOrb.getTypeName()) as NoteOrb

    if (orb === null || orb === undefined) {
      print("[OrbDebugPanel] Clone has no NoteOrb component.")
      copy.destroy()
      return
    }

    sample.orb = orb

    if (sample.recording) {
      orb.beginRecording()
    } else {
      sample.note = this.makeNote(sample, Date.now())
      orb.bind(sample.note)
    }

    orb.setTranscript(this.showLabels ? sample.label : "")
    orb.setInfoPanelEnabled(false)
    // Committed notes hide their transcript until clicked; the tuning row needs
    // its captions shown unconditionally.
    orb.setTranscriptVisible(this.showLabels)
  }

  /**
   * Builds a synthetic note whose reminder sits at the sample's urgency.
   *
   * urgency = 1 - remaining / horizon, so remaining = horizon * (1 - urgency).
   */
  private makeNote(sample: DebugSample, now: number): NoteData {
    return {
      id: "debug_" + sample.label,
      transcript: sample.label,
      position: [0, 0, 0],
      rotation: [0, 0, 0, 1],
      createdAt: now,
      reminderAt: this.reminderFor(sample, now),
      fired: false
    }
  }

  /** Absolute reminder time that puts the sample at its intended remaining. */
  private reminderFor(sample: DebugSample, now: number): number | null {
    if (sample.remainingMs === null) {
      return null
    }
    if (sample.overdue === true) {
      return now - this.numberOf("overdueAfterMinutes", 15) * 60 * 1000 - 60 * 1000
    }
    return now + sample.remainingMs
  }

  private tick(dt: number): void {
    if (!this.ready) {
      return
    }

    this.elapsed += dt

    const templateOrb = this.orbTemplate.getComponent(NoteOrb.getTypeName()) as NoteOrb
    const now = Date.now()

    const appearance = this.buildAppearance()

    this.layout()

    // A rolling envelope so the recording sample visibly breathes while tuning.
    const audio =
      this.simulatedAudioFloor +
      (1 - this.simulatedAudioFloor) * Math.abs(Math.sin(this.elapsed * 2.7))

    for (let i = 0; i < this.samples.length; i++) {
      const sample = this.samples[i]

      if (sample.orb === null) {
        continue
      }

      // Live-copy tuning so Inspector edits take effect without a restart.
      if (templateOrb !== null && templateOrb !== undefined) {
        sample.orb.copyTuningFrom(templateOrb)
      }

      if (sample.note !== null) {
        // Re-anchored each frame so the sample holds its exact remaining time
        // instead of counting down toward due while you tune.
        sample.note.createdAt = now
        sample.note.reminderAt = this.reminderFor(sample, now)
      }

      // "Settled" is held in its transition state so the flash can be inspected;
      // it would otherwise resolve to Placed within half a second.
      if (sample.label === "Settled" && sample.orb.getState() === OrbState.Placed) {
        sample.orb.setState(OrbState.Settling)
      }

      sample.orb.tick(dt, sample.recording ? audio : 0, now, appearance)
    }
  }

  /**
   * Mirrors NoteManager's appearance so the tuning row matches the real thing.
   * Read fresh every frame, so Inspector colour and intensity edits apply live.
   */
  private buildAppearance(): OrbAppearance {
    return {
      thresholds: {
        weekMs: this.numberOf("weekThresholdMinutes", 10080) * 60 * 1000,
        dayMs: this.numberOf("dayThresholdMinutes", 1440) * 60 * 1000,
        hourMs: this.numberOf("hourThresholdMinutes", 60) * 60 * 1000
      },
      overdueAfterMs: this.numberOf("overdueAfterMinutes", 15) * 60 * 1000,
      recordingColor: this.colorOf("recordingColor", new vec4(0.35, 0.95, 0.75, 1)),
      staticColor: this.colorOf("staticColor", new vec4(0.3, 0.9, 0.5, 1)),
      colorWeek: this.colorOf("colorWeek", new vec4(0.25, 0.55, 1, 1)),
      colorDay: this.colorOf("colorDay", new vec4(0.2, 0.9, 0.85, 1)),
      colorHour: this.colorOf("colorHour", new vec4(1, 0.82, 0.2, 1)),
      colorDue: this.colorOf("colorDue", new vec4(1, 0.25, 0.2, 1)),
      recordingIntensity: this.numberOf("recordingIntensity", 1.8),
      settledIntensity: this.numberOf("settledIntensity", 1.6),
      staticIntensity: this.numberOf("staticIntensity", 1.5),
      intensityWeek: this.numberOf("intensityWeek", 1.6),
      intensityDay: this.numberOf("intensityDay", 1.4),
      intensityHour: this.numberOf("intensityHour", 1.2),
      intensityDue: this.numberOf("intensityDue", 1)
    }
  }

  private numberOf(field: string, fallback: number): number {
    if (this.noteManager === null || this.noteManager === undefined) {
      return fallback
    }
    const value = (this.noteManager as any)[field]
    return typeof value === "number" ? value : fallback
  }

  private colorOf(field: string, fallback: vec4): vec4 {
    if (this.noteManager === null || this.noteManager === undefined) {
      return fallback
    }
    const value = (this.noteManager as any)[field]
    if (value === null || value === undefined) {
      return fallback
    }
    return value as vec4
  }

  /** Keeps the row centred in front of the camera as it moves. */
  private layout(): void {
    if (this.camera === null || this.camera === undefined) {
      return
    }

    const transform = this.camera.getSceneObject().getTransform()
    const origin = transform.getWorldPosition()
    const forward = transform.forward.uniformScale(-this.distance)
    const right = transform.right
    const up = transform.up

    const count = this.samples.length
    const start = -((count - 1) * this.spacing) / 2

    for (let i = 0; i < count; i++) {
      const orb = this.samples[i].orb
      if (orb === null) {
        continue
      }

      const offset = right
        .uniformScale(start + i * this.spacing)
        .add(up.uniformScale(this.heightOffset))

      orb.placeAt(origin.add(forward).add(offset), transform.getWorldRotation())
    }
  }
}
