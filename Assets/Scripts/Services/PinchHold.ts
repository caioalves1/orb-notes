/**
 * Press-and-hold detection, driven through SIK's Interactor abstraction.
 *
 * Going through Interactors rather than raw hand tracking is what makes this
 * work everywhere: `isTriggering` is set by the hand pinch on device, by the
 * mouse button in the desktop preview, and by touch on mobile. Subscribing to
 * TrackedHand.onPinchDown would only ever fire for real hand tracking, which
 * makes the Lens untestable in the preview.
 *
 * Recording begins the instant the press starts, so there is no dead time and
 * no progress affordance to explain. The threshold is applied at release
 * instead: a press shorter than `minHoldSeconds` is reported as too short and
 * the caller discards it. Capturing from the first moment also means the start
 * of the user's sentence is never clipped by a hold delay.
 *
 * Interactors are polled rather than subscribed to. Polling sidesteps
 * subscription ordering and teardown entirely, and reads uniformly across every
 * interactor type.
 */

import { SIK } from "SpectaclesInteractionKit.lspkg/SIK"
import {
  Interactor,
  InteractorInputType
} from "SpectaclesInteractionKit.lspkg/Core/Interactor/Interactor"
import { HandType } from "SpectaclesInteractionKit.lspkg/Providers/HandInputData/HandType"

/** Readable name for an InteractorInputType bitflag. */
export function describeInputType(inputType: InteractorInputType): string {
  if ((inputType & InteractorInputType.Mouse) !== 0) {
    return "Mouse"
  }
  if ((inputType & InteractorInputType.LeftHand) !== 0) {
    return "LeftHand"
  }
  if ((inputType & InteractorInputType.RightHand) !== 0) {
    return "RightHand"
  }
  if ((inputType & InteractorInputType.Mobile) !== 0) {
    return "Mobile"
  }
  if ((inputType & InteractorInputType.BtController) !== 0) {
    return "BtController"
  }
  return "Other"
}

export interface PinchHoldCallbacks {
  /** Press began. Recording starts here, immediately. */
  onPressStart: (position: vec3) => void
  /** Fires each frame while the press is held. */
  onPressUpdate?: (position: vec3, heldSeconds: number) => void
  /**
   * Press released.
   * @param longEnough true when the press lasted at least minHoldSeconds.
   *        false means the caller should discard whatever it captured.
   */
  onPressEnd: (position: vec3, heldSeconds: number, longEnough: boolean) => void
}

/** Ray a press was made along, for hit-testing before a gesture begins. */
export interface PressRay {
  origin: vec3
  direction: vec3
  /** Resolved world point of the press, as used for orb placement. */
  point: vec3
}

export class PinchHold {
  private callbacks: PinchHoldCallbacks | null = null
  /**
   * Consulted before any gesture starts. Returning true means something else
   * claimed the press (an orb was clicked), so no recording should begin.
   */
  private pressFilter: ((ray: PressRay) => boolean) | null = null
  private minHoldSeconds: number = 0.6

  /** Interactor currently driving the gesture, or null. */
  private activeInteractor: Interactor | null = null
  private holdTime: number = 0
  private thresholdReached: boolean = false
  private lastPosition: vec3 = vec3.zero()

  private camera: Camera | null = null

  /**
   * Distance in front of the interactor ray at which to place the orb when the
   * gesture has no physical hand position — mouse and mobile, mainly.
   */
  private rayPlacementDistance: number = 60

  bind(callbacks: PinchHoldCallbacks, minHoldSeconds: number): void {
    this.callbacks = callbacks
    this.minHoldSeconds = minHoldSeconds
  }

  setCamera(camera: Camera | null): void {
    this.camera = camera
  }

  /**
   * Registers a claim check run at press start.
   *
   * SIK's Interactable targeting proved unreliable for the spawned orbs, so
   * selection is resolved with an explicit ray test owned by this project
   * instead of depending on collider cloning and interactor raycast layers.
   */
  setPressFilter(filter: (ray: PressRay) => boolean): void {
    this.pressFilter = filter
  }

  setMinHoldSeconds(seconds: number): void {
    this.minHoldSeconds = seconds
  }

  setRayPlacementDistance(distance: number): void {
    this.rayPlacementDistance = distance
  }

  /** True once the active trigger has passed the hold threshold. */
  isHolding(): boolean {
    return this.thresholdReached
  }

  /** Seconds the current press has lasted, or 0 when idle. */
  getHeldSeconds(): number {
    return this.activeInteractor === null ? 0 : this.holdTime
  }

  /** Human-readable state, for the interaction debug readout. */
  getDebugState(): string {
    if (this.activeInteractor === null) {
      return "idle"
    }
    if (this.thresholdReached) {
      return "RECORDING " + this.holdTime.toFixed(1) + "s (will keep)"
    }
    return "RECORDING " + this.holdTime.toFixed(1) + "s (too short, will discard)"
  }

  /** Input type driving the current gesture, or "-" when idle. */
  getActiveInputName(): string {
    if (this.activeInteractor === null) {
      return "-"
    }
    return describeInputType(this.activeInteractor.inputType)
  }

  /** Snapshot of every interactor, for the debug readout. */
  getInteractorReport(): string[] {
    const interactors = this.getInteractors()
    const lines: string[] = []

    for (let i = 0; i < interactors.length; i++) {
      const interactor = interactors[i]
      const name = describeInputType(interactor.inputType)
      const enabled = interactor.enabled ? "on" : "OFF"
      const triggering = interactor.isTriggering ? "TRIGGER" : "-"
      const targeting =
        interactor.currentInteractable !== null && interactor.currentInteractable !== undefined
          ? " onUI"
          : ""

      lines.push(name + ": " + enabled + " " + triggering + targeting)
    }

    if (lines.length === 0) {
      lines.push("no interactors found")
    }

    return lines
  }

  /**
   * Ray for the pointer right now, whether or not anything is pressed.
   * Used for hover highlighting.
   */
  getPointerRay(): PressRay | null {
    const interactors = this.getInteractors()

    // A triggering interactor is unambiguously the one the user is using.
    for (let i = 0; i < interactors.length; i++) {
      if (this.isInteractorHolding(interactors[i])) {
        const ray = this.buildPointerRay(interactors[i])
        if (ray !== null) {
          this.lastPointerSource = describeInputType(interactors[i].inputType)
          return ray
        }
      }
    }

    // Otherwise choose by input type rather than by list order. Interactors stay
    // "enabled" and even "active" when they have nothing to report — an untracked
    // hand hands back the ray from wherever it was last seen, which is a fixed
    // vector pointing off into the room. Taking the first one in the list meant
    // that stale ray won every frame and no hover test ever hit.
    //
    // Mouse first is correct on both targets: MouseInteractor deregisters itself
    // outside the editor, so on device the hands are all that remain.
    const priority = [
      InteractorInputType.Mouse,
      InteractorInputType.RightHand,
      InteractorInputType.LeftHand,
      InteractorInputType.Mobile
    ]

    for (let p = 0; p < priority.length; p++) {
      for (let i = 0; i < interactors.length; i++) {
        const interactor = interactors[i]

        if ((interactor.inputType & priority[p]) === 0) {
          continue
        }
        if (!interactor.enabled) {
          continue
        }
        if (typeof interactor.isActive === "function" && !interactor.isActive()) {
          continue
        }

        // isActive() is true for a hand interactor even with no hand in front of
        // the camera, and it then reports the ray from wherever the hand was
        // last seen. Only a tracked hand has a meaningful pointer.
        const handType = this.handTypeOf(interactor)
        if (handType !== null && !this.isHandTracked(handType)) {
          continue
        }

        const ray = this.buildPointerRay(interactor)
        if (ray !== null) {
          this.lastPointerSource = describeInputType(interactor.inputType)
          return ray
        }
      }
    }

    this.lastPointerSource = "-"
    return null
  }

  private isHandTracked(handType: HandType): boolean {
    const hand = SIK.HandInputData.getHand(handType)
    if (hand === null || hand === undefined) {
      return false
    }
    return hand.isTracked()
  }

  /** Input type that supplied the last pointer ray, for diagnostics. */
  getPointerSource(): string {
    return this.lastPointerSource
  }

  private lastPointerSource: string = "-"

  /**
   * Ray for an interactor's pointer, without requiring it to be hitting
   * anything.
   *
   * `endPoint` is only populated when the interactor's own raycast lands on a
   * target, so building the ray from start/end alone yields nothing while the
   * pointer is over empty space — which is exactly when hover detection needs
   * to run. The interactor's `direction` is used when available and the
   * start/end delta only as a fallback.
   */
  private buildPointerRay(interactor: Interactor): PressRay | null {
    const start = interactor.startPoint

    if (start === null || start === undefined) {
      return null
    }

    const direct = (interactor as any).direction as vec3 | null | undefined

    if (direct !== null && direct !== undefined && direct.length > 0.0001) {
      return { origin: start, direction: direct.normalize(), point: start }
    }

    const end = interactor.endPoint

    if (end !== null && end !== undefined) {
      const delta = end.sub(start)
      if (delta.length > 0.0001) {
        return { origin: start, direction: delta.normalize(), point: end }
      }
    }

    return null
  }

  /** Advances the gesture. Call once per frame. */
  update(dt: number): void {
    if (this.callbacks === null) {
      return
    }

    if (this.activeInteractor === null) {
      this.tryBeginGesture()
      return
    }

    this.advanceGesture(dt)
  }

  private tryBeginGesture(): void {
    const interactor = this.findTriggeringInteractor()

    if (interactor === null) {
      return
    }

    const position = this.resolvePosition(interactor)
    if (position !== null) {
      this.lastPosition = position
    }

    // Give anything else a chance to claim this press before it becomes a
    // recording. A press that selects an orb must not also spawn a new one.
    if (this.pressFilter !== null) {
      const ray = this.buildPressRay(interactor)
      if (ray !== null && this.pressFilter(ray)) {
        // Latch the interactor out so the claim holds for the whole press.
        this.blocked.push(interactor)
        return
      }
    }

    this.activeInteractor = interactor
    this.holdTime = 0
    this.thresholdReached = false

    // Recording starts here, on the very first frame of the press.
    if (this.callbacks !== null) {
      this.callbacks.onPressStart(this.lastPosition)
    }
  }

  /** Ray for the press, derived from the interactor's start and end points. */
  private buildPressRay(interactor: Interactor): PressRay | null {
    const start = interactor.startPoint
    const end = interactor.endPoint

    if (start === null || start === undefined) {
      return null
    }

    let direction: vec3 | null = null

    if (end !== null && end !== undefined) {
      const delta = end.sub(start)
      if (delta.length > 0.0001) {
        direction = delta.normalize()
      }
    }

    if (direction === null) {
      const camera = this.camera
      if (camera === null) {
        return null
      }
      direction = camera
        .getSceneObject()
        .getTransform()
        .forward.uniformScale(-1)
        .normalize()
    }

    return { origin: start, direction: direction, point: this.lastPosition }
  }

  private advanceGesture(dt: number): void {
    const interactor = this.activeInteractor

    if (interactor === null || this.callbacks === null) {
      return
    }

    const stillHeld = this.isInteractorHolding(interactor)

    if (stillHeld) {
      const position = this.resolvePosition(interactor)
      if (position !== null) {
        this.lastPosition = position
      }

      this.holdTime += dt
      this.thresholdReached = this.holdTime >= this.minHoldSeconds

      if (this.callbacks.onPressUpdate !== undefined) {
        this.callbacks.onPressUpdate(this.lastPosition, this.holdTime)
      }
      return
    }

    // Released, or the interactor went away mid-gesture.
    const heldSeconds = this.holdTime
    const longEnough = heldSeconds >= this.minHoldSeconds
    const position = this.lastPosition

    this.activeInteractor = null
    this.holdTime = 0
    this.thresholdReached = false

    this.callbacks.onPressEnd(position, heldSeconds, longEnough)
  }

  /**
   * First enabled interactor that is currently triggering on empty space.
   *
   * Triggers that land on an Interactable are skipped: pressing a picker button
   * must drive that button, not also spawn a note behind it. Only the start of
   * the gesture is checked, so drifting off a button mid-hold does not suddenly
   * begin a recording.
   */
  private findTriggeringInteractor(): Interactor | null {
    const interactors = this.getInteractors()
    let candidate: Interactor | null = null

    for (let i = 0; i < interactors.length; i++) {
      const interactor = interactors[i]

      if (!this.isInteractorHolding(interactor)) {
        this.unblock(interactor)
        continue
      }

      if (this.isBlocked(interactor)) {
        continue
      }

      // A trigger that begins on an Interactable belongs to that Interactable
      // for its whole duration. Latching this is what stops a press that drifts
      // off a button from turning into a recording partway through the hold.
      if (interactor.currentInteractable !== null && interactor.currentInteractable !== undefined) {
        this.blocked.push(interactor)
        continue
      }

      if (candidate === null) {
        candidate = interactor
      }
    }

    return candidate
  }

  /** Interactors whose current trigger started on UI and must be ignored. */
  private blocked: Interactor[] = []

  private isBlocked(interactor: Interactor): boolean {
    for (let i = 0; i < this.blocked.length; i++) {
      if (this.blocked[i] === interactor) {
        return true
      }
    }
    return false
  }

  private unblock(interactor: Interactor): void {
    for (let i = this.blocked.length - 1; i >= 0; i--) {
      if (this.blocked[i] === interactor) {
        this.blocked.splice(i, 1)
      }
    }
  }

  private isInteractorHolding(interactor: Interactor): boolean {
    if (interactor === null || interactor === undefined) {
      return false
    }
    if (!interactor.enabled) {
      return false
    }
    return interactor.isTriggering === true
  }

  private getInteractors(): Interactor[] {
    try {
      return SIK.InteractionManager.getInteractorsByType(InteractorInputType.All)
    } catch (e) {
      print("[PinchHold] Could not read interactors: " + e)
      return []
    }
  }

  /**
   * World position for the gesture.
   *
   * A tracked hand gives a real pinch point, which is the most natural place for
   * the orb to appear. Everything else (mouse, mobile) only has a ray, so the
   * orb is placed a fixed distance along it — that keeps preview placement
   * predictable and still lets you aim by pointing.
   */
  private resolvePosition(interactor: Interactor): vec3 | null {
    const handPosition = this.resolveHandPinchPosition(interactor)
    if (handPosition !== null) {
      return handPosition
    }

    const rayPosition = this.resolveRayPosition(interactor)
    if (rayPosition !== null) {
      return rayPosition
    }

    return this.resolveCameraFallback()
  }

  private resolveHandPinchPosition(interactor: Interactor): vec3 | null {
    const handType = this.handTypeOf(interactor)

    if (handType === null) {
      return null
    }

    const hand = SIK.HandInputData.getHand(handType)

    if (hand === null || hand === undefined || !hand.isTracked()) {
      return null
    }

    const thumb = hand.thumbTip
    const index = hand.indexTip

    if (thumb === null || thumb === undefined || index === null || index === undefined) {
      return null
    }

    const a = thumb.position
    const b = index.position

    if (a === null || a === undefined || b === null || b === undefined) {
      return null
    }

    return new vec3((a.x + b.x) * 0.5, (a.y + b.y) * 0.5, (a.z + b.z) * 0.5)
  }

  private handTypeOf(interactor: Interactor): HandType | null {
    const inputType = interactor.inputType

    if ((inputType & InteractorInputType.LeftHand) !== 0) {
      return "left"
    }
    if ((inputType & InteractorInputType.RightHand) !== 0) {
      return "right"
    }
    return null
  }

  /** A point a fixed distance along the interactor's ray. */
  private resolveRayPosition(interactor: Interactor): vec3 | null {
    const start = interactor.startPoint
    const end = interactor.endPoint

    if (start === null || start === undefined) {
      return null
    }
    if (end === null || end === undefined) {
      return null
    }

    const direction = end.sub(start)

    if (direction.length < 0.0001) {
      return null
    }

    return start.add(direction.normalize().uniformScale(this.rayPlacementDistance))
  }

  private resolveCameraFallback(): vec3 | null {
    if (this.camera === null) {
      return null
    }

    const transform = this.camera.getSceneObject().getTransform()

    return transform
      .getWorldPosition()
      .add(transform.forward.uniformScale(-this.rayPlacementDistance))
  }

  /** Kept for symmetry with the previous event-based implementation. */
  destroy(): void {
    this.callbacks = null
    this.activeInteractor = null
  }
}
