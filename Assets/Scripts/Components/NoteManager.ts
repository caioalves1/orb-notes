/**
 * Orchestrates the whole Spatial Task Notes flow.
 *
 *   pinch & hold -> spawn orb + record -> release -> settle + transcribe
 *   -> reminder prompt -> persist -> colour by urgency -> alert when due
 *
 * This is the only component that owns state transitions; NoteOrb, HudController
 * and ReminderPrompt are all driven from here so there is a single place where
 * the flow can be read end to end.
 *
 * Reminders are only checked while the Lens is running — the platform offers no
 * background wake-up — so anything that came due while the Lens was closed is
 * surfaced on the next launch, most overdue first.
 */

import { createNote, NoteData } from "../Core/NoteModel"
import { OrbAppearance } from "../Core/OrbAppearance"
import { NoteStore } from "../Core/NoteStore"
import { describeReminder } from "../Core/TimeParser"
import { MicAmplitude } from "../Services/MicAmplitude"
import { PinchHold, PressRay } from "../Services/PinchHold"
import { SpeechService } from "../Services/SpeechService"
import { HudController } from "./HudController"
import { NoteOrb } from "./NoteOrb"
import { ReminderPrompt } from "./ReminderPrompt"

@component
export class NoteManager extends BaseScriptComponent {
  @ui.label("Scene references")
  @input
  @hint("Disabled template cloned for every note orb.")
  orbTemplate!: SceneObject

  @input
  @hint("Parent for spawned orbs. Must not move, so world positions stay valid.")
  orbContainer!: SceneObject

  @input
  @hint("HUD controller for onboarding, alerts and the directional indicator.")
  hud!: HudController

  @input
  @hint("Reminder time prompt.")
  reminderPrompt!: ReminderPrompt

  @input
  @hint("Camera used for placement and facing. Defaults to the main camera.")
  @allowUndefined
  camera!: Camera

  @ui.separator
  @ui.label("Speech and audio")
  @input
  @hint("AsrModule asset. Leave empty to resolve it at runtime.")
  @allowUndefined
  asrModule!: Asset

  @input
  @hint("Microphone audio track, for driving the orb from mic amplitude.")
  @allowUndefined
  microphoneTrack!: AudioTrackAsset

  @input
  @widget(new SliderWidget(0, 10, 0.1))
  @hint("Multiplier applied to mic amplitude before it reaches the orb. Compounds with the orb's own sensitivity — keep the product near 1 so the signal has headroom to vary.")
  audioSensitivity: number = 1

  @input
  @widget(new SliderWidget(0.05, 1, 0.05))
  @hint("How long a mic reading is held when no new audio frame arrives. The provider delivers sparse bursts, so this keeps the orb alive between them.")
  micHoldSeconds: number = 1

  @input
  @widget(new SliderWidget(1000, 30000, 500))
  @hint("Recognizer silence window while recording a note. The recording itself only ends on release; this just splits it into segments.")
  recordingSilenceMs: number = 10000

  @input
  @widget(new SliderWidget(0, 3, 0.05))
  @hint("Seconds a burst of recognised speech keeps the orb energised. Covers the microphone being starved while ASR holds it.")
  speechPulseSeconds: number = 0.8

  @ui.separator
  @ui.label("Interaction")
  @input
  @widget(new SliderWidget(0.1, 3, 0.05))
  @hint("Recording starts on press. A press shorter than this is discarded as a miss click.")
  minRecordSeconds: number = 0.6

  @input
  @widget(new SliderWidget(0, 60, 1))
  @hint("Distance in front of the pinch to place the orb, in centimetres.")
  placementForwardOffset: number = 0

  @input
  @widget(new SliderWidget(5, 60, 1))
  @hint("How far below the orb the reminder prompt appears, in centimetres.")
  promptDropDistance: number = 22

  @input
  @widget(new SliderWidget(20, 200, 5))
  @hint("Placement distance along the pointer ray when there is no tracked hand (mouse, mobile).")
  rayPlacementDistance: number = 60

  @input
  @widget(new SliderWidget(1, 30, 0.5))
  @hint("How close the pointer ray must pass to an orb to select it, in centimetres. Keep it close to the orb's own radius.")
  orbClickRadius: number = 4

  @ui.separator
  @ui.label("Colours")
  @input
  @widget(new ColorWidget())
  @hint("Colour while recording and settling.")
  recordingColor: vec4 = new vec4(0.35, 0.95, 0.75, 1)

  @input
  @widget(new ColorWidget())
  @hint("Colour for notes with no reminder. Static, never animates.")
  staticColor: vec4 = new vec4(0.3, 0.9, 0.5, 1)

  @input
  @widget(new ColorWidget())
  @hint("More than a week away. Flat above the week threshold.")
  colorWeek: vec4 = new vec4(0.25, 0.55, 1, 1)

  @input
  @widget(new ColorWidget())
  @hint("One day away. Week blends to Day between the week and day thresholds.")
  colorDay: vec4 = new vec4(0.2, 0.9, 0.85, 1)

  @input
  @widget(new ColorWidget())
  @hint("One hour away. Day blends to Hour between the day and hour thresholds.")
  colorHour: vec4 = new vec4(1, 0.82, 0.2, 1)

  @input
  @widget(new ColorWidget())
  @hint("Due. Hour blends to Due over the final hour, and past-due notes stay here.")
  colorDue: vec4 = new vec4(1, 0.25, 0.2, 1)

  @ui.separator
  @ui.label("Urgency thresholds")
  @ui.label("Blending runs A -> B -> C -> D as the remaining time crosses each threshold.")
  @input
  @widget(new SliderWidget(60, 43200, 60))
  @hint("Minutes remaining above which a note stays flat at Colour A. Default 10080 = one week.")
  weekThresholdMinutes: number = 10080

  @input
  @widget(new SliderWidget(10, 10080, 10))
  @hint("Minutes remaining at which a note reaches Colour B. Default 1440 = one day.")
  dayThresholdMinutes: number = 1440

  @input
  @widget(new SliderWidget(1, 1440, 1))
  @hint("Minutes remaining at which a note reaches Colour C. Default 60 = one hour.")
  hourThresholdMinutes: number = 60

  @ui.separator
  @ui.label("Emission per state")
  @ui.label("Tune each state independently; one global value cannot serve both a deep blue and a hot orange.")
  @input
  @widget(new SliderWidget(0, 4, 0.05))
  recordingIntensity: number = 1.8

  @input
  @widget(new SliderWidget(0, 4, 0.05))
  settledIntensity: number = 1.6

  @input
  @widget(new SliderWidget(0, 4, 0.05))
  @hint("Notes with no reminder. Raise this if they read too dark.")
  staticIntensity: number = 1.5

  @input
  @widget(new SliderWidget(0, 4, 0.05))
  @hint("Emission at Colour Week. Raise this if distant notes read too dark.")
  intensityWeek: number = 1.6

  @input
  @widget(new SliderWidget(0, 4, 0.05))
  @hint("Emission at Colour Day.")
  intensityDay: number = 1.4

  @input
  @widget(new SliderWidget(0, 4, 0.05))
  @hint("Emission at Colour Hour.")
  intensityHour: number = 1.2

  @input
  @widget(new SliderWidget(0, 4, 0.05))
  @hint("Emission at Colour Due.")
  intensityDue: number = 1

  @ui.label("Colour ramps across the reminder's own lifetime: blue when set, orange when due.")

  @ui.separator
  @ui.label("Reminders")
  @input
  @widget(new SliderWidget(0.2, 10, 0.1))
  @hint("How often due reminders are checked, in seconds.")
  reminderCheckSeconds: number = 1

  @input
  @hint("Alert copy. {note} is replaced with the transcript.")
  alertCopy: string = "Reminder: {note}"

  @input
  @hint("Shown briefly when a recording captured no speech and was discarded.")
  noSpeechCopy: string = "Didn't catch that — nothing saved"

  @input
  @widget(new SliderWidget(0, 240, 1))
  @hint("Minutes past the reminder before a note is captioned 'past due' on the HUD. Colour is unaffected; the ramp already ends at Colour Due.")
  overdueAfterMinutes: number = 15

  @ui.separator
  @ui.label("Development")
  @input
  @hint("Runs a scripted capture on start, with a synthetic mic level. Normal use: just click and hold in the preview.")
  debugSimulateCapture: boolean = false

  @input
  @widget(new SliderWidget(0.5, 10, 0.5))
  @hint("Seconds the simulated capture spends recording.")
  debugRecordSeconds: number = 3

  @input
  @hint("Wipes all stored notes on start. Use once to reset, then turn back off.")
  debugClearNotesOnStart: boolean = false

  @input
  @hint("Logs pointer-ray and orb hover activity. Development aid only.")
  logHover: boolean = false

  private store: NoteStore = new NoteStore()
  private speech: SpeechService | null = null
  private mic: MicAmplitude | null = null
  private pinch: PinchHold = new PinchHold()

  /** Live orbs, keyed by note id. Recording orb is tracked separately. */
  private orbs: { [noteId: string]: NoteOrb } = {}
  /**
   * Flat view of `orbs`, rebuilt only when the collection changes.
   *
   * The update loop walks every orb three times a frame (hover, press-test,
   * tick). Calling Object.keys() in each of those allocated three arrays per
   * frame for the whole life of the Lens — pure garbage, and it grows with the
   * number of notes.
   */
  private orbList: NoteOrb[] = []
  private orbListDirty: boolean = true
  private recordingOrb: NoteOrb | null = null
  private selectedOrb: NoteOrb | null = null
  private recordingPosition: vec3 = vec3.zero()
  private pendingTranscript: string = ""
  private awaitingReminder: boolean = false

  private lastMicLevel: number = 0
  private hoverLogTimer: number = 0
  /**
   * Secondary speech-activity signal, driven by the transcript growing.
   *
   * While AsrModule holds the microphone the raw provider is starved — measured
   * at roughly 1% of real-time audio in the preview — so amplitude alone cannot
   * be relied on to animate the orb. Interim transcript growth is a direct
   * indication that the user is speaking right now, and is available regardless
   * of how little raw audio reaches us.
   */
  private speechActivity: number = 0
  private lastPartialLength: number = 0
  private reminderTimer: number = 0
  private lastUpdateTime: number = 0

  onAwake(): void {
    this.createEvent("OnStartEvent").bind(() => {
      this.onStart()
    })
    this.createEvent("UpdateEvent").bind(() => {
      this.onUpdate()
    })
  }

  private onStart(): void {
    this.lastUpdateTime = getTime()

    this.speech = new SpeechService(this.asrModule)
    this.mic = new MicAmplitude(26, 6, this.audioSensitivity, this.micHoldSeconds)

    if (this.reminderPrompt !== null && this.reminderPrompt !== undefined) {
      this.reminderPrompt.setSpeechService(this.speech)
    }

    if (this.orbTemplate !== null && this.orbTemplate !== undefined) {
      this.orbTemplate.enabled = false
    }

    this.pinch.setCamera(this.resolveCamera())
    this.pinch.setRayPlacementDistance(this.rayPlacementDistance)
    this.pinch.setPressFilter((ray: PressRay) => {
      return this.tryClaimPressForOrb(ray)
    })
    this.pinch.bind(
      {
        onPressStart: (position: vec3) => {
          // Only empty-space presses reach here; orb clicks are claimed by the
          // press filter. Pressing empty space also dismisses any open note.
          this.clearSelection()
          this.beginRecording(position)
        },
        onPressEnd: (position: vec3, heldSeconds: number, longEnough: boolean) => {
          if (longEnough) {
            this.endRecording()
          } else {
            this.discardRecording()
          }
        }
      },
      this.minRecordSeconds
    )

    if (this.debugClearNotesOnStart) {
      this.store.clear()
      print("[NoteManager] Cleared all stored notes (debugClearNotesOnStart).")
    }

    this.restoreNotes()

    if (this.hud !== null && this.hud !== undefined) {
      this.hud.showOnboarding()
    }

    this.surfaceOverdueNotes()

    if (this.debugSimulateCapture) {
      this.startSimulatedCapture()
    }
  }

  // ------------------------------------------------------------- development

  private simulating: boolean = false
  private simulationTime: number = 0

  /**
   * Drives a capture without a hand pinch, so the orb states and the reminder
   * prompt can be exercised in the desktop preview. Mic amplitude is synthesized
   * because the preview has no live microphone.
   */
  private startSimulatedCapture(): void {
    const camera = this.resolveCamera()
    let position = new vec3(0, 0, -60)

    if (camera !== null) {
      const transform = camera.getSceneObject().getTransform()
      position = transform
        .getWorldPosition()
        .add(transform.forward.uniformScale(-60))
    }

    this.simulating = true
    this.simulationTime = 0
    this.beginRecording(position)
  }

  private advanceSimulation(dt: number): number {
    if (!this.simulating) {
      return 0
    }

    this.simulationTime += dt

    if (this.simulationTime >= this.debugRecordSeconds) {
      this.simulating = false
      this.pendingTranscript = "Pick up dry cleaning"
      this.endRecording()
      return 0
    }

    // Synthetic speech envelope: layered sines with a gap, so the orb's
    // audio reactivity is visible rather than a flat hum.
    const t = this.simulationTime
    const envelope = Math.abs(Math.sin(t * 3.1)) * 0.6 + Math.abs(Math.sin(t * 7.3)) * 0.4
    return Math.max(0, Math.min(1, envelope))
  }

  /** Rebuilds orbs for every stored note. */
  private restoreNotes(): void {
    const notes = this.store.getAll()

    for (let i = 0; i < notes.length; i++) {
      this.spawnOrbForNote(notes[i])
    }

    if (notes.length > 0) {
      print("[NoteManager] Restored " + notes.length + " note(s).")
    }
  }

  private spawnOrbForNote(note: NoteData): NoteOrb | null {
    const orb = this.instantiateOrb()

    if (orb === null) {
      return null
    }

    orb.bind(note)
    orb.placeAt(
      new vec3(note.position[0], note.position[1], note.position[2]),
      new quat(note.rotation[3], note.rotation[0], note.rotation[1], note.rotation[2])
    )

    this.orbs[note.id] = orb
    this.orbListDirty = true
    return orb
  }

  /** Clones the orb template. Returns null when the template is misconfigured. */
  private instantiateOrb(): NoteOrb | null {
    if (this.orbTemplate === null || this.orbTemplate === undefined) {
      print("[NoteManager] Orb template is not assigned.")
      return null
    }

    if (this.orbContainer === null || this.orbContainer === undefined) {
      print("[NoteManager] Orb container is not assigned.")
      return null
    }

    // copyWholeHierarchy parents the copy to the receiver, so cloning through
    // the container places the orb correctly in one step.
    const copy = this.orbContainer.copyWholeHierarchy(this.orbTemplate)

    if (copy === null || copy === undefined) {
      print("[NoteManager] Failed to clone the orb template.")
      return null
    }

    copy.enabled = true

    const orb = copy.getComponent(NoteOrb.getTypeName()) as NoteOrb

    if (orb === null || orb === undefined) {
      print("[NoteManager] Cloned template has no NoteOrb component.")
      copy.destroy()
      return null
    }

    // Wired here rather than at each call site. Registering per call site meant
    // an orb created by beginRecording missed its Done handler and its billboard
    // camera, so a note behaved correctly only after a Lens reset had re-created
    // it through restoreNotes. One place to wire is one place to get wrong.
    orb.onClicked((clicked: NoteOrb) => {
      this.handleOrbClicked(clicked)
    })
    orb.onDone((finished: NoteOrb) => {
      this.handleOrbDone(finished)
    })
    orb.setBillboardCamera(this.resolveCamera())

    return orb
  }

  // ---------------------------------------------------------------- recording

  private beginRecording(position: vec3): void {
    // A new recording always supersedes an open prompt, so the user is never
    // stuck answering a question about a note they have moved on from.
    if (this.reminderPrompt !== null && this.reminderPrompt !== undefined) {
      if (this.reminderPrompt.isActive()) {
        this.reminderPrompt.cancel()
      }
    }
    this.awaitingReminder = false

    // Any previous in-progress orb is discarded rather than orphaned; without
    // this a superseded recording would linger in the scene forever, uncommitted
    // and unremovable.
    if (this.recordingOrb !== null) {
      this.discardRecording()
    }

    const orb = this.instantiateOrb()
    if (orb === null) {
      return
    }

    this.recordingPosition = this.resolvePlacement(position)
    this.recordingOrb = orb
    this.pendingTranscript = ""
    this.speechActivity = 0
    this.lastPartialLength = 0

    orb.placeAt(this.recordingPosition, this.facingRotation(this.recordingPosition))
    orb.beginRecording()

    if (this.mic !== null) {
      this.mic.setSensitivity(this.audioSensitivity)
      this.mic.start(this.microphoneTrack)
    }

    if (this.speech !== null && this.speech.isAvailable()) {
      this.speech.start(
        {
          onPartial: (text: string) => {
            this.pendingTranscript = text

            // Any growth in the interim transcript means speech is happening.
            if (text.length !== this.lastPartialLength) {
              this.speechActivity = 1
              this.lastPartialLength = text.length
            }

            if (this.recordingOrb !== null) {
              this.recordingOrb.setTranscript(text)
            }
          },
          onFinal: (text: string) => {
            this.handleFinalTranscript(text)
          },
          onError: (message: string) => {
            print("[NoteManager] Speech error while recording: " + message)
            this.handleFinalTranscript(this.pendingTranscript)
          }
        },
        this.recordingSilenceMs,
        // The recording is bounded by the pinch, not by silence.
        false
      )
    }

    if (this.hud !== null && this.hud !== undefined) {
      this.hud.dismissOnboarding()
    }
  }

  private endRecording(): void {
    if (this.recordingOrb === null) {
      return
    }

    this.recordingOrb.beginSettle()

    if (this.mic !== null) {
      this.mic.stop()
    }

    if (this.speech !== null && this.speech.isListening()) {
      // Releasing the pinch is the end-of-utterance signal, so the session is
      // closed immediately rather than waiting on a silence timeout.
      this.speech.stop()
    } else {
      this.handleFinalTranscript(this.pendingTranscript)
    }
  }

  private handleFinalTranscript(text: string): void {
    if (this.recordingOrb === null || this.awaitingReminder) {
      return
    }

    const transcript = text.trim()

    // Nothing was said, so there is no note to make. Asking "when should I
    // remind you?" about an empty note wastes the user's time and leaves a
    // blank orb behind whichever way they answer.
    if (transcript.length === 0) {
      print("[NoteManager] No speech detected; discarding the note.")
      this.discardRecording()

      if (this.hud !== null && this.hud !== undefined) {
        this.hud.showTransientMessage(this.noSpeechCopy)
      }
      return
    }

    this.pendingTranscript = transcript
    this.recordingOrb.setTranscript(transcript)
    this.awaitingReminder = true

    this.askForReminder()
  }

  private askForReminder(): void {
    if (this.reminderPrompt === null || this.reminderPrompt === undefined) {
      this.commitNote(null)
      return
    }

    // Sits below the orb and its transcript so nothing overlaps.
    const panelPosition = this.recordingPosition.add(
      new vec3(0, -this.promptDropDistance, 0)
    )

    this.reminderPrompt.show(
      panelPosition,
      this.facingRotation(panelPosition),
      (reminderAt: number | null) => {
        this.commitNote(reminderAt)
      }
    )
  }

  /** Persists the pending note and hands its orb over to the live collection. */
  private commitNote(reminderAt: number | null): void {
    this.awaitingReminder = false

    const orb = this.recordingOrb
    this.recordingOrb = null

    if (orb === null) {
      return
    }

    const rotation = this.facingRotation(this.recordingPosition)

    const note = createNote(
      this.pendingTranscript,
      [this.recordingPosition.x, this.recordingPosition.y, this.recordingPosition.z],
      [rotation.x, rotation.y, rotation.z, rotation.w],
      Date.now(),
      reminderAt
    )

    this.store.add(note)
    orb.bind(note)
    // The transcript has served its purpose; hide it until the orb is clicked.
    orb.setTranscriptVisible(false)
    this.orbs[note.id] = orb
    this.orbListDirty = true

    if (reminderAt === null) {
      print("[NoteManager] Saved note with no reminder: " + note.transcript)
    } else {
      print(
        "[NoteManager] Saved note, reminder " +
          describeReminder(reminderAt, new Date()) +
          ": " +
          note.transcript
      )
    }
  }

  /**
   * Throws away a capture that was too short to be intentional.
   *
   * The orb is destroyed rather than committed, so a stray click leaves nothing
   * behind. Recording having already started is what makes this cheap: no hold
   * delay was needed, and nothing was lost from the front of the utterance if
   * the press turns out to be real.
   */
  private discardRecording(): void {
    const orb = this.recordingOrb

    this.recordingOrb = null
    this.awaitingReminder = false
    this.pendingTranscript = ""

    if (this.mic !== null) {
      this.mic.stop()
    }
    if (this.speech !== null && this.speech.isListening()) {
      this.speech.cancel()
    }

    if (orb !== null) {
      orb.getSceneObject().destroy()
    }
  }

  // ------------------------------------------------------------------ selection

  /**
   * Toggles a note's transcript. Committed notes hide their text so a room of
   * notes is a field of orbs rather than a wall of floating paragraphs; clicking
   * an orb brings its own text back and hides everyone else's.
   */
  private handleOrbClicked(orb: NoteOrb): void {
    if (orb === this.recordingOrb) {
      return
    }

    const wasVisible = orb.isTranscriptVisible()
    this.clearSelection()

    if (!wasVisible) {
      orb.setTranscriptVisible(true)
      this.selectedOrb = orb
    }
  }

  /**
   * Highlights whichever orb the pointer is currently over.
   *
   * Uses the same ray test as selection rather than SIK hover events, so the
   * highlight and the click can never disagree about which orb is targeted.
   */
  private updateHover(): void {
    const ray = this.pinch.getPointerRay()
    const orbs = this.getOrbList()
    let hovered: NoteOrb | null = null
    let bestOffset = Number.POSITIVE_INFINITY

    if (ray !== null) {
      let bestDistance = Number.POSITIVE_INFINITY

      for (let i = 0; i < orbs.length; i++) {
        const orb = orbs[i]
        const along = this.rayDistanceToPoint(ray, orb.getWorldPosition())

        if (along === null) {
          continue
        }
        if (along.offset < bestOffset) {
          bestOffset = along.offset
        }
        if (along.offset > this.orbClickRadius) {
          continue
        }
        if (along.distance < bestDistance) {
          bestDistance = along.distance
          hovered = orb
        }
      }
    }

    // The Done button of the selected orb gets its own hover test, so it
    // highlights like the picker options do.
    let doneHovered = false

    if (ray !== null && this.selectedOrb !== null) {
      const donePosition = this.selectedOrb.getDoneWorldPosition()

      if (donePosition !== null) {
        const hit = this.rayDistanceToPoint(ray, donePosition)
        doneHovered =
          hit !== null && hit.offset <= this.selectedOrb.getDoneClickRadius()
      }
    }

    for (let i = 0; i < orbs.length; i++) {
      const orb = orbs[i]
      // An orb whose Done button is under the pointer should not also read as
      // hovered itself, or both highlight at once.
      const isDoneTarget = doneHovered && orb === this.selectedOrb
      orb.setHovered(orb === hovered && !isDoneTarget)
      orb.setDoneHovered(isDoneTarget)
    }

    this.logHoverState(ray, bestOffset, hovered !== null)
  }

  /** Periodic hover diagnostics. Off unless logHover is enabled. */
  private logHoverState(ray: PressRay | null, bestOffset: number, hit: boolean): void {
    if (!this.logHover) {
      return
    }

    this.hoverLogTimer += 1

    if (this.hoverLogTimer % 45 !== 0) {
      return
    }

    if (ray === null) {
      print("[NoteManager] hover: NO RAY")
      return
    }

    print(
      "[NoteManager] hover src=" +
        this.pinch.getPointerSource() +
        " bestOffset=" +
        bestOffset.toFixed(1) +
        " limit=" +
        this.orbClickRadius +
        " hit=" +
        (hit ? "YES" : "no")
    )
  }

  /** Flat list of live orbs, rebuilt only after the collection changes. */
  private getOrbList(): NoteOrb[] {
    if (!this.orbListDirty) {
      return this.orbList
    }

    const ids = Object.keys(this.orbs)
    this.orbList = []

    for (let i = 0; i < ids.length; i++) {
      const orb = this.orbs[ids[i]]
      if (orb !== null && orb !== undefined) {
        this.orbList.push(orb)
      }
    }

    this.orbListDirty = false
    return this.orbList
  }

  /**
   * Ray-tests the press against every placed orb and, on a hit, toggles that
   * note's transcript instead of starting a recording.
   *
   * This is an explicit sphere test rather than SIK Interactable targeting.
   * Targeting was not resolving for spawned orbs — pressing one fell through to
   * empty space and recorded a new note — and an owned ray test removes the
   * dependency on how colliders survive cloning and which layers the interactor
   * raycasts. The nearest hit along the ray wins so overlapping orbs behave.
   *
   * @returns true when an orb claimed the press.
   */
  private tryClaimPressForOrb(ray: PressRay): boolean {
    // While the reminder prompt is open the user is answering a question, and
    // every press belongs to that prompt. SIK freezes interactor targeting for
    // the duration of a trigger, so a press that never hovered first reports no
    // Interactable at all — which previously made a picker button read as empty
    // space, cancelling the prompt and starting a fresh recording instead of
    // choosing a time. Claiming all presses here lets SIK resolve the button
    // press on its own terms.
    if (
      this.reminderPrompt !== null &&
      this.reminderPrompt !== undefined &&
      this.reminderPrompt.isActive()
    ) {
      return true
    }

    // The Done button is tested first and with its own radius: it sits inside
    // the selected orb's panel, so an orb-first test would always swallow the
    // press. Driving it from the same ray as selection also sidesteps SIK's
    // Interactable, which does not reliably deliver events on cloned orbs —
    // that unreliability is why "Done" only worked after a Lens reset.
    const selected = this.selectedOrb

    if (selected !== null) {
      const donePosition = selected.getDoneWorldPosition()

      if (donePosition !== null) {
        const hit = this.rayDistanceToPoint(ray, donePosition)

        if (hit !== null && hit.offset <= selected.getDoneClickRadius()) {
          selected.triggerDone()
          return true
        }
      }
    }

    const placed = this.getOrbList()
    const candidates: NoteOrb[] = []

    for (let i = 0; i < placed.length; i++) {
      candidates.push(placed[i])
    }

    // The in-progress orb is included so that pressing it never stacks a second
    // recording on top of the one being made.
    if (this.recordingOrb !== null) {
      candidates.push(this.recordingOrb)
    }

    let bestOrb: NoteOrb | null = null
    let bestDistance = Number.POSITIVE_INFINITY

    for (let i = 0; i < candidates.length; i++) {
      const orb = candidates[i]
      const along = this.rayDistanceToPoint(ray, orb.getWorldPosition())

      if (along === null) {
        continue
      }
      if (along.offset > this.orbClickRadius) {
        continue
      }
      if (along.distance < bestDistance) {
        bestDistance = along.distance
        bestOrb = orb
      }
    }

    if (bestOrb === null) {
      return false
    }

    this.handleOrbClicked(bestOrb)
    return true
  }

  /** Counts for the interaction debug readout. */
  getNoteDebugInfo(): string {
    const placed = Object.keys(this.orbs).length
    const recording = this.recordingOrb !== null ? "yes" : "no"
    const prompt =
      this.reminderPrompt !== null &&
      this.reminderPrompt !== undefined &&
      this.reminderPrompt.isActive()
        ? "open"
        : "closed"

    return "placed=" + placed + " recording=" + recording + " prompt=" + prompt
  }

  /**
   * Perpendicular offset from a ray to a point, plus how far along the ray the
   * closest approach happens. Returns null when the point is behind the ray.
   */
  private rayDistanceToPoint(
    ray: PressRay,
    point: vec3
  ): { offset: number; distance: number } | null {
    const toPoint = point.sub(ray.origin)
    const along = toPoint.dot(ray.direction)

    if (along < 0) {
      return null
    }

    const closest = ray.origin.add(ray.direction.uniformScale(along))
    return { offset: point.distance(closest), distance: along }
  }

  /**
   * Completes a note: marks it done and removes it.
   *
   * "Done" and "delete" are the same operation from the user's side — either
   * way they no longer want to see the orb — so there is one action rather than
   * two that behave identically.
   */
  private handleOrbDone(orb: NoteOrb): void {
    const ids = Object.keys(this.orbs)

    for (let i = 0; i < ids.length; i++) {
      if (this.orbs[ids[i]] === orb) {
        this.deleteNote(ids[i])
        return
      }
    }
  }

  /** Hides every committed note's transcript. */
  private clearSelection(): void {
    const orbs = this.getOrbList()

    for (let i = 0; i < orbs.length; i++) {
      orbs[i].setTranscriptVisible(false)
    }

    this.selectedOrb = null
  }

  /** Colours and per-state emission, rebuilt each frame so edits apply live. */
  private buildAppearance(): OrbAppearance {
    return {
      thresholds: {
        weekMs: this.weekThresholdMinutes * 60 * 1000,
        dayMs: this.dayThresholdMinutes * 60 * 1000,
        hourMs: this.hourThresholdMinutes * 60 * 1000
      },
      overdueAfterMs: this.overdueAfterMinutes * 60 * 1000,
      recordingColor: this.recordingColor,
      staticColor: this.staticColor,
      colorWeek: this.colorWeek,
      colorDay: this.colorDay,
      colorHour: this.colorHour,
      colorDue: this.colorDue,
      recordingIntensity: this.recordingIntensity,
      settledIntensity: this.settledIntensity,
      staticIntensity: this.staticIntensity,
      intensityWeek: this.intensityWeek,
      intensityDay: this.intensityDay,
      intensityHour: this.intensityHour,
      intensityDue: this.intensityDue
    }
  }

  // ------------------------------------------------------------------ placement

  /** Resolves where the orb should sit, given the pinch position. */
  private resolvePlacement(pinchPosition: vec3): vec3 {
    if (this.placementForwardOffset === 0) {
      return pinchPosition
    }

    const camera = this.resolveCamera()
    if (camera === null) {
      return pinchPosition
    }

    const cameraTransform = camera.getSceneObject().getTransform()
    const forward = cameraTransform.forward.uniformScale(-this.placementForwardOffset)

    return pinchPosition.add(forward)
  }

  /** Rotation that faces the orb's panel back toward the user. */
  private facingRotation(position: vec3): quat {
    const camera = this.resolveCamera()

    if (camera === null) {
      return quat.quatIdentity()
    }

    const cameraPosition = camera.getSceneObject().getTransform().getWorldPosition()
    let toCamera = cameraPosition.sub(position)

    if (toCamera.length < 0.0001) {
      return quat.quatIdentity()
    }

    toCamera = toCamera.normalize()

    return quat.lookAt(toCamera, vec3.up())
  }

  private resolveCamera(): Camera | null {
    if (this.camera !== null && this.camera !== undefined) {
      return this.camera
    }
    return null
  }

  // --------------------------------------------------------------------- loop

  private onUpdate(): void {
    const now = getTime()
    let dt = now - this.lastUpdateTime
    this.lastUpdateTime = now

    // Clamp to survive frame hitches without the envelope or timers jumping.
    if (dt < 0 || dt > 0.25) {
      dt = 0.016
    }

    this.pinch.update(dt)
    this.updateHover()

    const simulatedLevel = this.advanceSimulation(dt)
    const micLevel = this.mic !== null ? this.mic.update(dt) : 0

    // Decay the speech-activity pulse, then take whichever signal is stronger.
    if (this.speechPulseSeconds > 0) {
      this.speechActivity = Math.max(0, this.speechActivity - dt / this.speechPulseSeconds)
    } else {
      this.speechActivity = 0
    }

    const level = this.simulating
      ? simulatedLevel
      : Math.max(micLevel, this.speechActivity)
    const epochNow = Date.now()
    this.lastMicLevel = level

    this.tickOrbs(dt, level, epochNow, this.buildAppearance())

    if (this.reminderPrompt !== null && this.reminderPrompt !== undefined) {
      this.reminderPrompt.tick(dt)
    }

    if (this.hud !== null && this.hud !== undefined) {
      this.hud.tick(dt)
    }

    this.reminderTimer += dt
    if (this.reminderTimer >= this.reminderCheckSeconds) {
      this.reminderTimer = 0
      this.checkReminders(epochNow)
      this.publishDueState(epochNow)
    }
  }

  private tickOrbs(
    dt: number,
    level: number,
    epochNow: number,
    appearance: OrbAppearance
  ): void {
    if (this.recordingOrb !== null) {
      this.recordingOrb.tick(dt, level, epochNow, appearance)
    }

    const orbs = this.getOrbList()
    for (let i = 0; i < orbs.length; i++) {
      orbs[i].tick(dt, 0, epochNow, appearance)
    }
  }

  /** Smoothed mic level from the last frame, for the interaction debug readout. */
  getMicLevel(): number {
    return this.lastMicLevel
  }

  /** Microphone pipeline state, for the interaction debug readout. */
  getMicDiagnostics(): string {
    return this.mic === null ? "no mic service" : this.mic.getDiagnostics()
  }

  // ---------------------------------------------------------------- reminders

  /** Queues alerts for anything that came due while the Lens was closed. */
  private surfaceOverdueNotes(): void {
    const due = this.store.dueNotes(Date.now())

    for (let i = 0; i < due.length; i++) {
      this.fireReminder(due[i])
    }
  }

  private checkReminders(epochNow: number): void {
    const due = this.store.dueNotes(epochNow)

    for (let i = 0; i < due.length; i++) {
      this.fireReminder(due[i])
    }
  }

  /**
   * Publishes how many notes have reached their reminder time, so the HUD can
   * caption the direction arrow. Counts due notes whether or not their alert has
   * already been shown — the orb is still waiting on the user either way.
   */
  private publishDueState(epochNow: number): void {
    if (this.hud === null || this.hud === undefined) {
      return
    }

    const notes = this.store.getAll()
    let dueCount = 0
    let anyOverdue = false

    for (let i = 0; i < notes.length; i++) {
      const note = notes[i]
      if (note.reminderAt === null || epochNow < note.reminderAt) {
        continue
      }

      dueCount += 1

      if (epochNow - note.reminderAt >= this.overdueAfterMinutes * 60 * 1000) {
        anyOverdue = true
      }
    }

    this.hud.setDueState(dueCount, anyOverdue)
  }

  private fireReminder(note: NoteData): void {
    if (this.hud === null || this.hud === undefined) {
      return
    }

    const orb = this.orbs[note.id]
    const position =
      orb !== null && orb !== undefined
        ? orb.getWorldPosition()
        : new vec3(note.position[0], note.position[1], note.position[2])

    this.hud.queueAlert(this.alertCopy.replace("{note}", note.transcript), position, note.id)

    // Mark fired immediately so a slow queue cannot replay the same reminder.
    this.store.update(note.id, (target: NoteData) => {
      target.fired = true
    })
  }

  // ------------------------------------------------------------------ utility

  /** Gesture detector, exposed for the interaction debug readout. */
  getPinchHold(): PinchHold {
    return this.pinch
  }

  /** Removes a note and its orb. Exposed for a delete affordance. */
  deleteNote(noteId: string): void {
    const orb = this.orbs[noteId]

    if (orb !== null && orb !== undefined) {
      orb.getSceneObject().destroy()
      delete this.orbs[noteId]
      this.orbListDirty = true
    }

    this.store.remove(noteId)
  }

  /** Clears every note. Useful during development. */
  clearAllNotes(): void {
    const ids = Object.keys(this.orbs)

    for (let i = 0; i < ids.length; i++) {
      const orb = this.orbs[ids[i]]
      if (orb !== null && orb !== undefined) {
        orb.getSceneObject().destroy()
      }
    }

    this.orbs = {}
    this.orbListDirty = true
    this.store.clear()
  }
}
