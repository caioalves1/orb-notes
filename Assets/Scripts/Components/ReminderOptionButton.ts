/**
 * One selectable option in the reminder-time picker.
 *
 * Each button describes itself — its label and what time it resolves to — so
 * the picker can be rearranged, extended or trimmed entirely in the Inspector
 * without touching code.
 */

import { Interactable } from "SpectaclesInteractionKit.lspkg/Components/Interaction/Interactable/Interactable"

export const ReminderOptionKind = {
  /** Adds `offsetMinutes` to the current time. */
  Relative: "relative",
  /** The next occurrence of `absoluteHour` on the clock. */
  AbsoluteHour: "absoluteHour",
  /** Explicitly no reminder. */
  None: "none"
} as const

export type ReminderOptionKind =
  (typeof ReminderOptionKind)[keyof typeof ReminderOptionKind]

@component
export class ReminderOptionButton extends BaseScriptComponent {
  @input
  @hint("Text shown on the button.")
  @allowUndefined
  label!: Text

  @input
  @hint("Label copy, e.g. '30 min' or \"Don't remind me\".")
  labelText: string = "30 min"

  @input
  @widget(
    new ComboBoxWidget()
      .addItem("Relative offset", "relative")
      .addItem("Next time on the clock", "absoluteHour")
      .addItem("No reminder", "none")
  )
  @hint("How this option resolves to a timestamp.")
  kind: string = "relative"

  @input
  @hint("Minutes from now. Used when kind is 'relative'.")
  offsetMinutes: number = 30

  @input
  @widget(new SliderWidget(0, 23, 1))
  @hint("Hour of day, 24h. Used when kind is 'absoluteHour'.")
  absoluteHour: number = 9

  @input
  @hint("Days to add before applying the hour. Used when kind is 'absoluteHour'.")
  dayOffset: number = 1

  @input
  @hint("Interactable that receives the pinch. Defaults to one on this object.")
  @allowUndefined
  interactable!: Interactable

  @input
  @hint("Plate whose colour and scale respond to hover.")
  @allowUndefined
  plate!: MaterialMeshVisual

  @input
  @widget(new ColorWidget())
  @hint("Plate colour when idle.")
  idleColor: vec4 = new vec4(0.12, 0.16, 0.24, 0.85)

  @input
  @widget(new ColorWidget())
  @hint("Plate colour while hovered, so the option reads as selectable.")
  hoverColor: vec4 = new vec4(0.3, 0.55, 0.95, 0.95)

  @input
  @widget(new SliderWidget(1, 1.4, 0.01))
  @hint("Plate scale multiplier while hovered.")
  hoverScale: number = 1.08

  private handler: ((button: ReminderOptionButton) => void) | null = null
  private plateMaterial: Material | null = null
  private plateBaseScale: vec3 = new vec3(1, 1, 1)
  private hovered: boolean = false
  private hoverAmount: number = 0

  onAwake(): void {
    if (this.label !== null && this.label !== undefined) {
      this.label.text = this.labelText
    }

    const target = this.resolveInteractable()

    if (target === null) {
      print(
        "[ReminderOptionButton] No Interactable found for '" +
          this.labelText +
          "'; this option cannot be selected."
      )
      return
    }

    target.onTriggerEnd.add(() => {
      if (this.handler !== null) {
        this.handler(this)
      }
    })

    target.onInteractorHoverEnter.add(() => {
      this.hovered = true
    })
    target.onInteractorHoverExit.add(() => {
      this.hovered = false
    })

    this.setupPlate()

    this.createEvent("UpdateEvent").bind(() => {
      this.advanceHover(getDeltaTime())
    })
  }

  /** Clones the plate material so each button highlights independently. */
  private setupPlate(): void {
    if (this.plate === null || this.plate === undefined) {
      return
    }

    if (this.plate.mainMaterial !== null) {
      this.plateMaterial = this.plate.mainMaterial.clone()
      this.plate.mainMaterial = this.plateMaterial
    }

    this.plateBaseScale = this.plate.getSceneObject().getTransform().getLocalScale()
  }

  /**
   * Eases the plate toward its hovered look. Without this the picker gives no
   * indication that the options are selectable at all.
   */
  private advanceHover(dt: number): void {
    const target = this.hovered ? 1 : 0
    const rate = 14
    this.hoverAmount = this.hoverAmount + (target - this.hoverAmount) * Math.min(1, rate * dt)

    if (this.plateMaterial !== null) {
      const from = this.idleColor
      const to = this.hoverColor
      const t = this.hoverAmount
      this.plateMaterial.mainPass.baseColor = new vec4(
        from.x + (to.x - from.x) * t,
        from.y + (to.y - from.y) * t,
        from.z + (to.z - from.z) * t,
        from.w + (to.w - from.w) * t
      )
    }

    if (this.plate !== null && this.plate !== undefined) {
      const scale = 1 + (this.hoverScale - 1) * this.hoverAmount
      this.plate
        .getSceneObject()
        .getTransform()
        .setLocalScale(
          new vec3(
            this.plateBaseScale.x * scale,
            this.plateBaseScale.y,
            this.plateBaseScale.z * scale
          )
        )
    }
  }

  private resolveInteractable(): Interactable | null {
    if (this.interactable !== null && this.interactable !== undefined) {
      return this.interactable
    }

    // Custom scripts all report the ScriptComponent type, so the Interactable is
    // identified by the event it exposes rather than by type name.
    const scripts = this.getSceneObject().getComponents("ScriptComponent")

    for (let i = 0; i < scripts.length; i++) {
      const candidate = scripts[i] as any
      if (candidate !== null && candidate.onTriggerEnd !== undefined) {
        return candidate as Interactable
      }
    }

    return null
  }

  /** Registers the picker's selection handler. */
  onSelected(handler: (button: ReminderOptionButton) => void): void {
    this.handler = handler
  }

  /**
   * Resolves this option against a reference time.
   * @returns Epoch milliseconds, or null when the option means "no reminder".
   */
  resolve(now: Date): number | null {
    if (this.kind === ReminderOptionKind.None) {
      return null
    }

    if (this.kind === ReminderOptionKind.AbsoluteHour) {
      const base = new Date(now.getTime() + this.dayOffset * 24 * 60 * 60 * 1000)
      const result = new Date(
        base.getFullYear(),
        base.getMonth(),
        base.getDate(),
        this.absoluteHour,
        0,
        0,
        0
      )

      // Never resolve into the past; roll forward a day if the hour has gone.
      if (result.getTime() <= now.getTime()) {
        return result.getTime() + 24 * 60 * 60 * 1000
      }
      return result.getTime()
    }

    return now.getTime() + this.offsetMinutes * 60 * 1000
  }

  isNoReminder(): boolean {
    return this.kind === ReminderOptionKind.None
  }
}
