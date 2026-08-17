/**
 * A single note's orb: an abstract glowing sphere built from two shells.
 *
 *   Core  - Rim Highlight shader. Carries the note's colour and the fresnel rim.
 *   Glow  - Outer Glow shader (3 instanced shells, screen blend). The halo.
 *
 * Both materials are cloned per orb on awake so that colour, glow and scale can
 * be driven independently for every note without one note's state leaking into
 * another's.
 *
 * The orb has three visual states:
 *   Recording - audio-reactive; scale, rim and glow track mic amplitude live
 *   Settling  - a short, deliberate transition so the end of recording is
 *               unmistakable: a bright flash that contracts into the resting form
 *   Placed    - resting; colour interpolates with urgency, glow breathes slowly
 */

import { NoteData } from "../Core/NoteModel"
import { describeRemaining } from "../Core/TimeParser"
import { getOrbMesh } from "../Core/OrbGeometry"
import { OrbAppearance, OrbLookState, resolveOrbLook } from "../Core/OrbAppearance"
import { clamp01, damp, pulseRateFor } from "../Core/Urgency"
import { Interactable } from "SpectaclesInteractionKit.lspkg/Components/Interaction/Interactable/Interactable"

export const OrbState = {
  Recording: "recording",
  Settling: "settling",
  Placed: "placed"
} as const

export type OrbState = (typeof OrbState)[keyof typeof OrbState]

/** Tilted spin axes, so neither shell turns about a screen-aligned axis. */
const CORE_AXIS = new vec3(0.24, 1, 0.12).normalize()
const INNER_AXIS = new vec3(-0.4, 0.7, 0.58).normalize()

@component
export class NoteOrb extends BaseScriptComponent {
  @input
  @hint("Child holding the Core and Glow shells. Scaled by the orb animation.")
  visualRoot!: SceneObject

  @input
  @hint("Inner sphere carrying the note colour and fresnel rim.")
  core!: RenderMeshVisual

  @input
  @hint("Outer sphere carrying the glow halo.")
  glow!: RenderMeshVisual

  @input
  @hint("Text panel showing the transcript. Optional.")
  @allowUndefined
  transcriptText!: Text

  @input
  @hint("Object holding the transcript panel. Shown while recording, then only when the orb is clicked.")
  @allowUndefined
  transcriptPanel!: SceneObject

  @input
  @hint("Panel with the countdown and the Done button. Shown only while the orb is selected.")
  @allowUndefined
  infoPanel!: SceneObject

  @input
  @hint("Label showing how long is left before the reminder.")
  @allowUndefined
  timeLabel!: Text

  @input
  @hint("Interactable that deletes / completes this note.")
  @allowUndefined
  doneButton!: Interactable

  @input
  @hint("Object holding the Done button, used as its hit target and hover visual.")
  @allowUndefined
  doneButtonRoot!: SceneObject

  @input
  @hint("Plate behind the Done label, tinted and scaled on hover.")
  @allowUndefined
  donePlate!: MaterialMeshVisual

  @input
  @widget(new ColorWidget())
  @hint("Done button colour when idle.")
  doneIdleColor: vec4 = new vec4(0.12, 0.16, 0.24, 0.85)

  @input
  @widget(new ColorWidget())
  @hint("Done button colour while hovered.")
  doneHoverColor: vec4 = new vec4(0.3, 0.55, 0.95, 0.95)

  @input
  @widget(new SliderWidget(1, 1.5, 0.01))
  @hint("Done button scale multiplier while hovered.")
  doneHoverScale: number = 1.12

  @input
  @widget(new SliderWidget(1, 12, 0.5))
  @hint("Radius of the Done button's hit target, in centimetres. Match it to the plate width so the button is as easy to hit as it looks.")
  doneClickRadius: number = 4.5

  @ui.separator
  @input
  @hint("Keep the transcript and info panels turned toward the user.")
  billboardPanels: boolean = true

  @input
  @hint("Interactable that makes the orb clickable. Defaults to one on this object.")
  @allowUndefined
  interactable!: Interactable

  @input
  @widget(new SliderWidget(1, 20, 0.5))
  @hint("Radius of the click target, in centimetres. Should roughly match the orb's own size.")
  clickRadius: number = 3.6

  @ui.separator
  @ui.label("Hover feedback")
  @input
  @widget(new SliderWidget(0, 2, 0.05))
  @hint("Extra emission while the pointer is over the orb, so it reads as clickable.")
  hoverEmissionBoost: number = 1.1

  @input
  @widget(new SliderWidget(0, 0.5, 0.01))
  @hint("Extra size while hovered, as a fraction of the orb radius.")
  hoverScaleBoost: number = 0.25

  @input
  @hint("Print hover enter/exit to the log. Development aid only.")
  logHover: boolean = false

  @ui.separator
  @ui.label("Orb form")
  @input
  @widget(new SliderWidget(0.5, 20, 0.5))
  @hint("Resting radius of the orb, in centimetres.")
  baseRadius: number = 3

  @input
  @widget(new SliderWidget(0, 2, 0.05))
  @hint("Extra radius at full mic amplitude while recording.")
  recordingScaleBoost: number = 0.85

  @ui.separator
  @ui.label("Glow and rim")
  @input
  @widget(new SliderWidget(0, 10, 0.1))
  @hint("Emission strength of the rim highlight.")
  rimIntensity: number = 2

  @input
  @widget(new SliderWidget(0, 10, 0.1))
  @hint("Fresnel falloff power. Higher values give a tighter rim.")
  rimExponent: number = 2.2

  @input
  @widget(new SliderWidget(0, 10, 0.05))
  @hint("How far the outer glow reaches past the core. Keep low so the halo stays behind the core.")
  glowDistance: number = 0.28

  @input
  @widget(new SliderWidget(0, 10, 0.1))
  @hint("Outer glow falloff. Higher is a softer, smoother fade.")
  glowFalloff: number = 7

  @input
  @widget(new SliderWidget(0, 2, 0.01))
  @hint("Overall glow strength relative to the core. Below 1 keeps the core and inner shell dominant.")
  glowIntensityScale: number = 0.35

  @input
  @hint("Turn the outer glow off entirely. The orb reads well without it.")
  glowEnabled: boolean = true

  @ui.separator
  @ui.label("Noise")
  @input
  @widget(new SliderWidget(0, 8, 0.1))
  @hint("Amplitude of the organic wobble applied to shape and glow.")
  noiseScale: number = 1.6

  @input
  @widget(new SliderWidget(0, 5, 0.05))
  @hint("Rate of the noise animation.")
  noiseSpeed: number = 0.7

  @ui.separator
  @ui.label("Displaced geometry")
  @input
  @hint("Replace the smooth spheres with noise-displaced meshes. This is what makes the orb read as 3D.")
  useDisplacedMesh: boolean = true

  @input
  @widget(new SliderWidget(0, 4, 1))
  @hint("Icosphere subdivisions. 2 is 162 verts, 3 is 642. Higher is smoother and costlier.")
  meshSubdivisions: number = 3

  @input
  @widget(new SliderWidget(0.2, 8, 0.1))
  @hint("Spatial frequency of the displacement noise. Higher gives finer detail.")
  meshNoiseScale: number = 1.9

  @input
  @widget(new SliderWidget(1, 6, 1))
  @hint("Fbm octaves in the displacement.")
  meshOctaves: number = 4

  @input
  @widget(new SliderWidget(0, 0.6, 0.01))
  @hint("Displacement depth as a fraction of radius. 0 is a smooth sphere.")
  meshAmplitude: number = 0.22

  @ui.separator
  @ui.label("Inner shell")
  @input
  @hint("Second displaced shell that counter-rotates inside the core, for parallax depth.")
  @allowUndefined
  innerVisual!: RenderMeshVisual

  @input
  @widget(new SliderWidget(0.2, 1, 0.01))
  @hint("Inner shell radius, as a fraction of the core.")
  innerScale: number = 0.74

  @ui.separator
  @ui.label("Rotation")
  @input
  @widget(new SliderWidget(0, 90, 1))
  @hint("Core rotation speed in degrees/second. Rotation is only visible once the mesh is displaced.")
  coreSpinSpeed: number = 9

  @input
  @widget(new SliderWidget(-90, 90, 1))
  @hint("Inner shell rotation speed in degrees/second. Opposite sign reads as depth.")
  innerSpinSpeed: number = -14

  @input
  @widget(new SliderWidget(0, 4, 0.1))
  @hint("Extra spin multiplier at full mic amplitude while recording.")
  recordingSpinBoost: number = 2.5

  @ui.separator
  @ui.label("Audio reactivity")
  @input
  @widget(new SliderWidget(0, 8, 0.1))
  @hint("Multiplier applied to mic amplitude while recording. Combined with NoteManager's own multiplier; too high pins the level at maximum and the orb stops varying.")
  audioSensitivity: number = 1.3

  @input
  @widget(new SliderWidget(0, 6, 0.1))
  @hint("How much mic amplitude drives emission while recording.")
  audioEmissionResponse: number = 2.6

  @input
  @widget(new SliderWidget(1, 40, 1))
  @hint("How quickly the orb follows the mic. Higher is snappier.")
  audioFollowRate: number = 22

  @input
  @widget(new SliderWidget(0, 1, 0.01))
  @hint("Minimum audio level while recording, so a silent orb still reads as live. Keep low or there is no headroom left for speech to show.")
  audioIdleLevel: number = 0.12

  @ui.separator
  @ui.label("Pulse")
  @input
  @widget(new SliderWidget(0, 4, 0.05))
  @hint("Glow pulse rate, in Hz, for a note that is not yet urgent.")
  basePulseHz: number = 0.25

  @input
  @widget(new SliderWidget(0, 4, 0.05))
  @hint("Glow pulse rate, in Hz, for a note that is due now.")
  urgentPulseHz: number = 1.4

  private coreMaterial: Material | null = null
  private glowMaterial: Material | null = null
  private innerMaterial: Material | null = null

  private state: OrbState = OrbState.Placed
  private note: NoteData | null = null

  /** Smoothed mic level, so shape changes stay fluid between frames. */
  private level: number = 0
  /** Seconds elapsed in the current state, drives the settle transition. */
  private stateTime: number = 0
  /** Free-running clock for noise and pulse phase. */
  private phase: number = 0
  /** Current displayed colour, damped toward the urgency target. */
  private displayColor: vec4 = new vec4(0.35, 0.6, 1, 1)

  private settleDuration: number = 0.55

  /** Accumulated spin, in degrees, for core and inner shells. */
  private coreSpin: number = 0
  private innerSpin: number = 0

  private transcript: string = ""
  private transcriptVisible: boolean = false
  private clickHandler: ((orb: NoteOrb) => void) | null = null
  private doneHandler: ((orb: NoteOrb) => void) | null = null
  /** Hover reported by SIK's Interactable, independent of the ray fallback. */
  private sikHovered: boolean = false
  private doneHovered: boolean = false
  private doneHoverAmount: number = 0
  private doneMaterial: Material | null = null
  private donePlateBaseScale: vec3 = new vec3(1, 1, 1)
  private billboardCamera: Camera | null = null
  private infoPanelEnabled: boolean = true
  /** Emission multiplier resolved from the appearance config each frame. */
  private stateIntensity: number = 1
  private overdue: boolean = false
  private hovered: boolean = false
  /** Damped hover amount, so the response eases rather than snaps. */
  private hoverAmount: number = 0

  onAwake(): void {
    this.cloneMaterials()
    this.applyDisplacedMeshes()
    this.ensureCollider()

    this.createEvent("OnStartEvent").bind(() => {
      this.bindInteractable()
    })
  }

  /**
   * Guarantees a collider exists on this orb.
   *
   * copyWholeHierarchy does NOT clone physics components, so every orb spawned
   * from the template arrived with its Interactable but no collider — and an
   * Interactable with nothing to hit can never be targeted. The press then fell
   * through to empty space and started a new recording instead of selecting the
   * orb. Creating the collider at runtime is what makes cloned orbs clickable.
   */
  private ensureCollider(): void {
    const object = this.getSceneObject()
    const existing = object.getComponent("Physics.ColliderComponent") as ColliderComponent

    if (existing !== null && existing !== undefined) {
      this.configureCollider(existing)
      return
    }

    try {
      const collider = object.createComponent(
        "Physics.ColliderComponent"
      ) as ColliderComponent
      this.configureCollider(collider)
      print("[NoteOrb] Collider created for orb click/hover.")
    } catch (e) {
      print("[NoteOrb] Could not create a collider; the orb will not be clickable: " + e)
    }
  }

  private configureCollider(collider: ColliderComponent): void {
    try {
      // fitVisual would size the collider to this object's own visual, and the
      // meshes live on children, so the radius is set explicitly instead.
      collider.fitVisual = false

      const shape = Shape.createSphereShape()
      shape.radius = this.clickRadius
      collider.shape = shape

      // NOT intangible. An intangible collider is skipped by raycasts, which
      // silently removed the orb from SIK's targeting entirely — no hover, no
      // Interactable click. It reads as "the orb is not clickable at all", and
      // was the reason selection had to be done with a separate ray test.
      collider.intangible = false
    } catch (e) {
      print("[NoteOrb] Could not configure the orb collider: " + e)
    }
  }

  /** True once this orb's reminder time has passed. */
  isOverdue(): boolean {
    return this.overdue
  }

  /** Marks the orb as pointed at, for hover feedback. */
  setHovered(hovered: boolean): void {
    this.hovered = hovered
  }

  isHovered(): boolean {
    return this.hovered
  }

  /**
   * Swaps the smooth sphere meshes for noise-displaced ones.
   *
   * The two shells use different seeds so their silhouettes never line up,
   * which is what produces visible parallax as they counter-rotate.
   */
  private applyDisplacedMeshes(): void {
    if (!this.useDisplacedMesh) {
      return
    }

    const coreMesh = getOrbMesh({
      subdivisions: this.meshSubdivisions,
      noiseScale: this.meshNoiseScale,
      octaves: this.meshOctaves,
      amplitude: this.meshAmplitude,
      seed: 1
    })

    if (coreMesh !== null && this.core !== null && this.core !== undefined) {
      this.core.mesh = coreMesh
    }

    // The halo shares the core's mesh. A smooth glow sphere would wrap the
    // displaced core in a perfect circle and hide the very silhouette that
    // makes the orb read as three-dimensional.
    if (coreMesh !== null && this.glow !== null && this.glow !== undefined) {
      this.glow.mesh = coreMesh
    }

    if (this.innerVisual !== null && this.innerVisual !== undefined) {
      const innerMesh = getOrbMesh({
        subdivisions: this.meshSubdivisions,
        noiseScale: this.meshNoiseScale * 1.6,
        octaves: this.meshOctaves,
        amplitude: this.meshAmplitude * 1.4,
        seed: 7
      })

      if (innerMesh !== null) {
        this.innerVisual.mesh = innerMesh
      }
    }
  }

  /**
   * Materials are cloned so each orb owns its parameters. Without this, every
   * orb would share the package material and all notes would show the colour of
   * whichever one updated last.
   */
  private cloneMaterials(): void {
    if (this.core !== null && this.core !== undefined && this.core.mainMaterial !== null) {
      this.coreMaterial = this.core.mainMaterial.clone()
      this.core.mainMaterial = this.coreMaterial
    } else {
      print("[NoteOrb] Core visual or its material is missing.")
    }

    if (this.glow !== null && this.glow !== undefined && this.glow.mainMaterial !== null) {
      this.glowMaterial = this.glow.mainMaterial.clone()
      this.glow.mainMaterial = this.glowMaterial
    } else {
      print("[NoteOrb] Glow visual or its material is missing.")
    }

    if (
      this.innerVisual !== null &&
      this.innerVisual !== undefined &&
      this.innerVisual.mainMaterial !== null
    ) {
      this.innerMaterial = this.innerVisual.mainMaterial.clone()
      this.innerVisual.mainMaterial = this.innerMaterial
    }

    // Cloned so one orb's Done highlight does not tint every other orb's.
    if (
      this.donePlate !== null &&
      this.donePlate !== undefined &&
      this.donePlate.mainMaterial !== null
    ) {
      this.doneMaterial = this.donePlate.mainMaterial.clone()
      this.donePlate.mainMaterial = this.doneMaterial
      this.donePlateBaseScale = this.donePlate.getSceneObject().getTransform().getLocalScale()
    }
  }

  /** Binds this orb to a note and jumps straight to the resting state. */
  bind(note: NoteData): void {
    this.note = note
    this.setState(OrbState.Placed)
    this.setTranscript(note.transcript)
    this.setTranscriptVisible(false)
  }

  getNote(): NoteData | null {
    return this.note
  }

  getState(): OrbState {
    return this.state
  }

  setState(next: OrbState): void {
    this.state = next
    this.stateTime = 0
  }

  /** Begins the audio-reactive recording presentation. */
  beginRecording(): void {
    this.note = null
    this.level = 0
    this.setState(OrbState.Recording)
    this.setTranscript("")
    // Live transcript is always visible while capturing.
    this.setTranscriptVisible(true)
  }

  /**
   * Ends recording and plays the settle transition. The flash-and-contract is
   * what makes "recording has stopped" readable without any text.
   */
  beginSettle(): void {
    this.setState(OrbState.Settling)
  }

  /** Sets the transcript copy without changing whether it is shown. */
  setTranscript(text: string): void {
    this.transcript = text

    if (this.transcriptText !== null && this.transcriptText !== undefined) {
      // Shown in full. The panel sits above the orb with its text anchored at
      // the bottom, so a long note grows upward, away from the reminder prompt
      // below — no trimming needed to keep the two from colliding.
      this.transcriptText.text = text
    }

    this.applyTranscriptVisibility()
  }

  /**
   * Shows or hides the transcript panel.
   *
   * Once a note is committed its transcript is hidden, so a room full of notes
   * is a field of orbs rather than a wall of floating text. Clicking an orb
   * brings its text back.
   */
  setTranscriptVisible(visible: boolean): void {
    this.transcriptVisible = visible
    this.applyTranscriptVisibility()
  }

  isTranscriptVisible(): boolean {
    return this.transcriptVisible
  }

  private applyTranscriptVisibility(): void {
    const shouldShow = this.transcriptVisible && this.transcript.length > 0

    if (this.transcriptPanel !== null && this.transcriptPanel !== undefined) {
      if (this.transcriptPanel.enabled !== shouldShow) {
        this.transcriptPanel.enabled = shouldShow
      }
    }

    // Countdown and Done only make sense for a committed note the user has
    // deliberately opened, so they follow selection rather than the transcript.
    const showInfo = this.infoPanelEnabled && this.transcriptVisible && this.note !== null

    if (this.infoPanel !== null && this.infoPanel !== undefined) {
      if (this.infoPanel.enabled !== showInfo) {
        this.infoPanel.enabled = showInfo
      }
    }
  }

  /** Registers the click handler used to toggle this orb's transcript. */
  onClicked(handler: (orb: NoteOrb) => void): void {
    this.clickHandler = handler
  }

  private bindInteractable(): void {
    let target: Interactable | null = this.interactable

    if (target === null || target === undefined) {
      // Custom scripts all report the ScriptComponent type, so the Interactable
      // is identified by the event it exposes rather than by type name.
      const scripts = this.getSceneObject().getComponents("ScriptComponent")
      for (let i = 0; i < scripts.length; i++) {
        const candidate = scripts[i] as any
        if (candidate !== null && candidate.onTriggerEnd !== undefined) {
          target = candidate as Interactable
          break
        }
      }
    }

    if (target === null || target === undefined) {
      return
    }

    target.onTriggerEnd.add(() => {
      if (this.clickHandler !== null) {
        this.clickHandler(this)
      }
    })

    // SIK delivers hover for the orbs exactly as it does for the picker
    // buttons, provided the collider exists. This is the primary hover path;
    // NoteManager's ray test is a fallback for interactors that report no
    // Interactable.
    target.onInteractorHoverEnter.add(() => {
      this.sikHovered = true
      if (this.logHover) {
        print("[NoteOrb] hover ENTER on '" + this.transcript + "'")
      }
    })
    target.onInteractorHoverExit.add(() => {
      this.sikHovered = false
      if (this.logHover) {
        print("[NoteOrb] hover EXIT on '" + this.transcript + "'")
      }
    })

    this.bindDoneButton()
  }

  private bindDoneButton(): void {
    if (this.doneButton === null || this.doneButton === undefined) {
      return
    }

    this.doneButton.onTriggerEnd.add(() => {
      if (this.doneHandler !== null) {
        this.doneHandler(this)
      }
    })
  }

  /** Registers the handler for the Done / delete action. */
  onDone(handler: (orb: NoteOrb) => void): void {
    this.doneHandler = handler
  }

  /** Invoked by NoteManager's ray test when the Done button is pressed. */
  triggerDone(): void {
    if (this.doneHandler !== null) {
      this.doneHandler(this)
    }
  }

  setDoneHovered(hovered: boolean): void {
    this.doneHovered = hovered
  }

  /** World centre of the Done button, or null when it is not shown. */
  getDoneWorldPosition(): vec3 | null {
    if (!this.transcriptVisible || this.note === null) {
      return null
    }
    if (this.doneButtonRoot === null || this.doneButtonRoot === undefined) {
      return null
    }
    return this.doneButtonRoot.getTransform().getWorldPosition()
  }

  getDoneClickRadius(): number {
    return this.doneClickRadius
  }

  /**
   * Suppresses the countdown and Done button entirely.
   *
   * The tuning row shows every colour band at once; eleven live countdowns and
   * eleven Close buttons there are noise, and none of them refer to a real note.
   */
  setInfoPanelEnabled(enabled: boolean): void {
    this.infoPanelEnabled = enabled
    this.applyTranscriptVisibility()
  }

  /** Camera the panels turn to face. */
  setBillboardCamera(camera: Camera | null): void {
    this.billboardCamera = camera
  }

  /**
   * Advances the orb one frame.
   *
   * @param dt Seconds since the last frame.
   * @param audioLevel Mic amplitude in [0, 1]. Ignored outside Recording.
   * @param now Current epoch milliseconds, for urgency colouring.
   * @param appearance Colours and per-state emission, resolved by NoteManager.
   */
  tick(dt: number, audioLevel: number, now: number, appearance: OrbAppearance): void {
    this.stateTime += dt
    this.phase += dt * this.noiseSpeed

    // A recording orb with no sound yet still needs to look alive. Without a
    // floor it sits at its dimmest the whole time the user is drawing breath,
    // which reads as "nothing is happening".
    const targetLevel =
      this.state === OrbState.Recording
        ? clamp01(
            Math.max(this.audioIdleLevel, audioLevel * this.audioSensitivity)
          )
        : 0
    this.level = damp(this.level, targetLevel, this.audioFollowRate, dt)
    const anyHover = this.hovered || this.sikHovered
    this.hoverAmount = damp(this.hoverAmount, anyHover ? 1 : 0, 12, dt)
    this.doneHoverAmount = damp(this.doneHoverAmount, this.doneHovered ? 1 : 0, 14, dt)
    this.applyDoneHover()
    this.applyBillboard()

    // Rewritten every frame; describeRemaining resolves to seconds under an
    // hour, so the label ticks rather than sitting on a stale minute count.
    if (this.timeLabel !== null && this.timeLabel !== undefined && this.note !== null) {
      const countdown = describeRemaining(this.note.reminderAt, now)
      if (this.timeLabel.text !== countdown) {
        this.timeLabel.text = countdown
      }
    }

    const look = resolveOrbLook(this.note, now, this.state as OrbLookState, appearance)

    this.stateIntensity = look.intensity
    this.overdue = look.overdue

    this.displayColor = new vec4(
      damp(this.displayColor.x, look.color.x, 4, dt),
      damp(this.displayColor.y, look.color.y, 4, dt),
      damp(this.displayColor.z, look.color.z, 4, dt),
      damp(this.displayColor.w, look.color.w, 4, dt)
    )

    if (this.state === OrbState.Settling && this.stateTime >= this.settleDuration) {
      this.setState(OrbState.Placed)
    }

    this.applyShape(now, appearance, dt)
    this.applyMaterials()
  }

  /**
   * Matches the picker buttons' hover treatment so the Done button reads as the
   * same kind of control rather than as inert text on a plate.
   */
  private applyDoneHover(): void {
    if (this.doneMaterial !== null) {
      const from = this.doneIdleColor
      const to = this.doneHoverColor
      const t = this.doneHoverAmount

      this.doneMaterial.mainPass.baseColor = new vec4(
        from.x + (to.x - from.x) * t,
        from.y + (to.y - from.y) * t,
        from.z + (to.z - from.z) * t,
        from.w + (to.w - from.w) * t
      )
    }

    if (this.donePlate !== null && this.donePlate !== undefined) {
      const scale = 1 + (this.doneHoverScale - 1) * this.doneHoverAmount
      this.donePlate
        .getSceneObject()
        .getTransform()
        .setLocalScale(
          new vec3(
            this.donePlateBaseScale.x * scale,
            this.donePlateBaseScale.y,
            this.donePlateBaseScale.z * scale
          )
        )
    }
  }

  /**
   * Turns the whole orb toward the user, about the vertical axis only.
   *
   * Two decisions here, both about staying legible from any angle:
   *
   * Rotating the orb root rather than each panel keeps the panels on their
   * fixed local offsets, so the transcript, the orb and the info row stay on one
   * vertical centre line. Billboarding each panel independently let them pivot
   * about their own centres, and from an off-axis view they visibly splayed
   * apart from the orb they belong to.
   *
   * Yaw only, with no pitch, keeps the text upright and the panels co-planar.
   * A full look-at tips the whole stack when the user looks from above or
   * below, which is exactly when the misalignment showed.
   */
  private applyBillboard(): void {
    if (!this.billboardPanels || this.billboardCamera === null) {
      return
    }

    const transform = this.getTransform()
    const cameraPosition = this.billboardCamera
      .getSceneObject()
      .getTransform()
      .getWorldPosition()

    const toCamera = cameraPosition.sub(transform.getWorldPosition())
    const flat = new vec3(toCamera.x, 0, toCamera.z)

    // Directly above or below the orb there is no meaningful yaw; keep the last.
    if (flat.length < 0.0001) {
      return
    }

    transform.setWorldRotation(quat.lookAt(flat.normalize(), vec3.up()))
  }

  /** Layered sines standing in for noise: cheap, smooth, and non-repeating enough. */
  private noise(offset: number): number {
    const t = this.phase + offset
    return (
      Math.sin(t * 1.0) * 0.5 + Math.sin(t * 1.7 + 1.3) * 0.3 + Math.sin(t * 2.9 + 2.7) * 0.2
    )
  }

  private applyShape(now: number, appearance: OrbAppearance, dt: number): void {
    this.advanceSpin(dt)

    const wobbleAmount = this.noiseScale * 0.02
    let radius = this.baseRadius

    if (this.state === OrbState.Recording) {
      radius += this.baseRadius * this.recordingScaleBoost * this.level
    } else if (this.state === OrbState.Settling) {
      radius *= this.settleScale()
    } else {
      radius *= 1 + this.pulseValue(now, appearance) * 0.04
    }

    radius *= 1 + this.hoverAmount * this.hoverScaleBoost

    // Slight per-axis variation keeps the orb from reading as a hard CG sphere.
    const sx = radius * (1 + this.noise(0) * wobbleAmount)
    const sy = radius * (1 + this.noise(2.1) * wobbleAmount)
    const sz = radius * (1 + this.noise(4.3) * wobbleAmount)

    // Only the visual shells scale. Scaling the component's own object would
    // drag the transcript panel along with every audio-driven pulse.
    if (this.visualRoot !== null && this.visualRoot !== undefined) {
      this.visualRoot.getTransform().setLocalScale(new vec3(sx, sy, sz))
    }

    if (this.innerVisual !== null && this.innerVisual !== undefined) {
      this.innerVisual
        .getSceneObject()
        .getTransform()
        .setLocalScale(new vec3(this.innerScale, this.innerScale, this.innerScale))
    }
  }

  /**
   * Turns both shells. Rotation only became meaningful once the meshes were
   * displaced — on a smooth sphere it is literally invisible.
   */
  private advanceSpin(dt: number): void {
    const boost = 1 + this.level * this.recordingSpinBoost

    this.coreSpin += this.coreSpinSpeed * boost * dt
    this.innerSpin += this.innerSpinSpeed * boost * dt

    if (this.core !== null && this.core !== undefined) {
      this.core
        .getSceneObject()
        .getTransform()
        .setLocalRotation(quat.angleAxis(this.coreSpin * Math.PI / 180, CORE_AXIS))
    }

    if (this.innerVisual !== null && this.innerVisual !== undefined) {
      this.innerVisual
        .getSceneObject()
        .getTransform()
        .setLocalRotation(quat.angleAxis(this.innerSpin * Math.PI / 180, INNER_AXIS))
    }
  }

  /**
   * Settle curve: a fast overshoot outward, then an ease back in past the
   * resting size and up to it. Reads as a "snap into place".
   */
  private settleScale(): number {
    const t = clamp01(this.stateTime / this.settleDuration)
    const overshoot = Math.sin(t * Math.PI) * 0.35
    const contraction = 1 - 0.18 * (1 - t)
    return contraction + overshoot * (1 - t)
  }

  private pulseValue(now: number, appearance: OrbAppearance): number {
    if (this.note === null) {
      return Math.sin(this.phase * Math.PI * 2 * this.basePulseHz)
    }
    const hz = pulseRateFor(
      this.note,
      now,
      appearance.thresholds,
      this.basePulseHz,
      this.urgentPulseHz
    )
    return Math.sin(this.phase * Math.PI * 2 * hz)
  }

  private applyMaterials(): void {
    const color = this.displayColor
    const noiseWobble = 1 + this.noise(1.1) * this.noiseScale * 0.08

    // Per-state emission from the appearance config, so a deep blue "far" orb
    // and a hot "due" orb can be balanced independently.
    let intensityScale = this.stateIntensity * (1 + this.hoverAmount * this.hoverEmissionBoost)

    if (this.state === OrbState.Recording) {
      intensityScale *= 1 + this.level * this.audioEmissionResponse
    } else if (this.state === OrbState.Settling) {
      const t = clamp01(this.stateTime / this.settleDuration)
      intensityScale *= 1 + (1 - t) * 2.2
    }

    if (this.coreMaterial !== null) {
      const pass = this.coreMaterial.mainPass
      pass.baseColor = color
      pass.rimColor = color
      pass.rimIntensity = this.rimIntensity * intensityScale * noiseWobble
      pass.rimExponent = this.rimExponent
    }

    if (this.innerMaterial !== null) {
      const pass = this.innerMaterial.mainPass
      pass.baseColor = color
      pass.rimColor = color
      // The inner shell runs a tighter, brighter rim so it reads as a distinct
      // body suspended inside the core rather than as a second outline.
      pass.rimIntensity = this.rimIntensity * intensityScale * 1.35
      pass.rimExponent = this.rimExponent * 1.6
    }

    this.applyGlow(color, intensityScale, noiseWobble)
  }

  /**
   * The halo is deliberately held back. At full strength the screen-blended
   * glow washes over the core and inner shell and becomes the only thing you
   * see, which flattens the orb back into a bright disc — the exact problem the
   * displaced geometry was added to solve. glowIntensityScale below 1 keeps the
   * core dominant, and a high falloff keeps the fade smooth rather than banded
   * across the three instanced shells.
   */
  private applyGlow(color: vec4, intensityScale: number, noiseWobble: number): void {
    if (this.glow !== null && this.glow !== undefined) {
      const shouldRender = this.glowEnabled && this.glowIntensityScale > 0.001
      if (this.glow.enabled !== shouldRender) {
        this.glow.enabled = shouldRender
      }
      if (!shouldRender) {
        return
      }
    }

    if (this.glowMaterial === null) {
      return
    }

    const pass = this.glowMaterial.mainPass
    const strength = this.glowIntensityScale

    // Scaling the colour rather than only the distance keeps the halo subtle
    // without shrinking it into a hard ring against the core.
    pass.baseColor = new vec4(
      color.x * strength,
      color.y * strength,
      color.z * strength,
      color.w
    )
    pass.glowDistance = this.glowDistance * intensityScale * strength * noiseWobble
    pass.glowFalloff = this.glowFalloff
  }

  /**
   * Copies every look-tuning value from another orb.
   *
   * Used by the debug panel so that editing the Orb Template's sliders in the
   * Inspector updates the live preview orbs on the next frame, with no restart.
   */
  copyTuningFrom(source: NoteOrb): void {
    this.baseRadius = source.baseRadius
    this.recordingScaleBoost = source.recordingScaleBoost
    this.rimIntensity = source.rimIntensity
    this.rimExponent = source.rimExponent
    this.glowDistance = source.glowDistance
    this.glowFalloff = source.glowFalloff
    this.noiseScale = source.noiseScale
    this.noiseSpeed = source.noiseSpeed
    this.audioSensitivity = source.audioSensitivity
    this.basePulseHz = source.basePulseHz
    this.urgentPulseHz = source.urgentPulseHz
    this.innerScale = source.innerScale
    this.coreSpinSpeed = source.coreSpinSpeed
    this.innerSpinSpeed = source.innerSpinSpeed
    this.recordingSpinBoost = source.recordingSpinBoost
    this.glowIntensityScale = source.glowIntensityScale
    this.glowEnabled = source.glowEnabled
    this.audioEmissionResponse = source.audioEmissionResponse
    this.audioFollowRate = source.audioFollowRate
    this.audioIdleLevel = source.audioIdleLevel
    this.clickRadius = source.clickRadius
    this.hoverEmissionBoost = source.hoverEmissionBoost
    this.hoverScaleBoost = source.hoverScaleBoost
    this.doneHoverScale = source.doneHoverScale
    this.doneClickRadius = source.doneClickRadius
    this.billboardPanels = source.billboardPanels
    this.meshAmplitude = source.meshAmplitude
    this.meshNoiseScale = source.meshNoiseScale
  }

  /** Snaps the displayed colour to the target, skipping the damping ramp. */
  snapColor(color: vec4): void {
    this.displayColor = color
  }

  /** Places the orb at a world position and faces it toward the camera. */
  placeAt(position: vec3, rotation: quat): void {
    const transform = this.getTransform()
    transform.setWorldPosition(position)
    transform.setWorldRotation(rotation)
  }

  getWorldPosition(): vec3 {
    return this.getTransform().getWorldPosition()
  }
}
