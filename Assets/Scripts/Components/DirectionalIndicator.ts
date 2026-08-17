/**
 * HUD arrow that points toward a note's anchor, including when the note is
 * behind the user.
 *
 * The arrow lives on a ring around the centre of view. Its angular position and
 * its rotation both track the target, so it reads as "turn this way" rather
 * than as a static icon. When the target comes into view the indicator fades
 * out, since the orb itself is then the better signpost.
 */

import { clamp01, damp } from "../Core/Urgency"

@component
export class DirectionalIndicator extends BaseScriptComponent {
  @input
  @hint("Camera used to resolve view direction. Defaults to the main camera.")
  @allowUndefined
  camera!: Camera

  @input
  @hint("Object that is rotated and positioned around the view centre.")
  arrow!: SceneObject

  @input
  @hint("Visual whose material alpha is faded. Optional.")
  @allowUndefined
  arrowVisual!: MaterialMeshVisual

  @input
  @widget(new SliderWidget(1, 40, 0.5))
  @hint("Radius of the arrow ring from view centre, in local units.")
  ringRadius: number = 12

  @input
  @widget(new SliderWidget(0, 1, 0.01))
  @hint("Fraction of the screen considered 'in view'. Below this the arrow hides.")
  onScreenMargin: number = 0.15

  @input
  @widget(new SliderWidget(1, 30, 0.5))
  @hint("How quickly the arrow follows the target direction.")
  followRate: number = 10

  private target: vec3 | null = null
  private currentAngle: number = 0
  private opacity: number = 0
  private material: Material | null = null

  onAwake(): void {
    if (this.arrowVisual !== null && this.arrowVisual !== undefined) {
      if (this.arrowVisual.mainMaterial !== null) {
        this.material = this.arrowVisual.mainMaterial.clone()
        this.arrowVisual.mainMaterial = this.material
      }
    }
    this.setVisible(false)
  }

  /** Points the indicator at a world position. */
  setTarget(position: vec3): void {
    this.target = position
  }

  clearTarget(): void {
    this.target = null
  }

  hasTarget(): boolean {
    return this.target !== null
  }

  private resolveCamera(): Camera | null {
    if (this.camera !== null && this.camera !== undefined) {
      return this.camera
    }
    return null
  }

  /** Advances the indicator. Call once per frame from the HUD controller. */
  tick(dt: number): void {
    const camera = this.resolveCamera()

    if (this.target === null || camera === null) {
      this.opacity = damp(this.opacity, 0, 8, dt)
      this.applyOpacity()
      return
    }

    const cameraTransform = camera.getSceneObject().getTransform()
    const local = cameraTransform.getInvertedWorldTransform().multiplyPoint(this.target)

    // -Z is forward, so a negative z means the note is ahead of the user.
    const inFront = local.z < 0
    const visible = inFront && this.isWithinView(camera)

    let targetAngle: number
    if (inFront) {
      targetAngle = Math.atan2(local.y, local.x)
    } else {
      // Behind the user: mirror through the view centre so the arrow indicates
      // the shorter way to turn rather than pointing at a mirrored ghost.
      targetAngle = Math.atan2(-local.y, -local.x)
    }

    this.currentAngle = this.dampAngle(this.currentAngle, targetAngle, this.followRate, dt)
    this.opacity = damp(this.opacity, visible ? 0 : 1, 8, dt)

    this.applyTransform()
    this.applyOpacity()
  }

  /**
   * True when the current target is inside the viewport. The HUD uses this to
   * decide when a due reminder has actually been looked at.
   */
  isTargetInView(): boolean {
    const camera = this.resolveCamera()
    if (camera === null || this.target === null) {
      return false
    }

    const cameraTransform = camera.getSceneObject().getTransform()
    const local = cameraTransform.getInvertedWorldTransform().multiplyPoint(this.target)

    // -Z is forward, so a negative z means the note is ahead of the user.
    if (local.z >= 0) {
      return false
    }

    return this.isWithinView(camera)
  }

  private isWithinView(camera: Camera): boolean {
    if (this.target === null) {
      return false
    }

    const screen = camera.worldSpaceToScreenSpace(this.target)
    const margin = this.onScreenMargin

    return (
      screen.x >= margin &&
      screen.x <= 1 - margin &&
      screen.y >= margin &&
      screen.y <= 1 - margin
    )
  }

  /** Interpolates angles the short way around the circle. */
  private dampAngle(current: number, target: number, rate: number, dt: number): number {
    let delta = target - current
    const twoPi = Math.PI * 2

    while (delta > Math.PI) {
      delta -= twoPi
    }
    while (delta < -Math.PI) {
      delta += twoPi
    }

    return current + delta * clamp01(1 - Math.exp(-rate * dt))
  }

  private applyTransform(): void {
    if (this.arrow === null || this.arrow === undefined) {
      return
    }

    const transform = this.arrow.getTransform()

    transform.setLocalPosition(
      new vec3(
        Math.cos(this.currentAngle) * this.ringRadius,
        Math.sin(this.currentAngle) * this.ringRadius,
        0
      )
    )

    // Arrow art points +Y by convention, so subtract a quarter turn to align it
    // with the ring angle.
    transform.setLocalRotation(
      quat.angleAxis(this.currentAngle - Math.PI / 2, vec3.forward())
    )
  }

  private applyOpacity(): void {
    const visible = this.opacity > 0.01
    this.setVisible(visible)

    if (!visible || this.material === null) {
      return
    }

    const pass = this.material.mainPass
    const base = pass.baseColor

    if (base !== null && base !== undefined) {
      pass.baseColor = new vec4(base.x, base.y, base.z, this.opacity)
    }
  }

  private setVisible(visible: boolean): void {
    if (this.arrow !== null && this.arrow !== undefined) {
      if (this.arrow.enabled !== visible) {
        this.arrow.enabled = visible
      }
    }
  }
}
