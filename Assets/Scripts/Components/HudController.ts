/**
 * Head-locked HUD: onboarding, reminder alerts, and the directional indicator.
 *
 * Onboarding dismisses on the first successful recording or on a tap, whichever
 * comes first, and never returns for the rest of the session.
 *
 * Alerts queue rather than overwrite. If several reminders come due at once —
 * common when the Lens is reopened after being closed for a while — they are
 * shown one at a time, most overdue first, so none are missed.
 */


import { DirectionalIndicator } from "./DirectionalIndicator"

interface QueuedAlert {
  message: string
  target: vec3
  noteId: string
}

@component
export class HudController extends BaseScriptComponent {
  @input
  @hint("Onboarding panel, shown at launch.")
  @allowUndefined
  onboardingRoot!: SceneObject

  @input
  @hint("Onboarding copy.")
  @allowUndefined
  onboardingLabel!: Text

  @input
  @hint("Alert panel, shown when a reminder fires.")
  @allowUndefined
  alertRoot!: SceneObject

  @input
  @hint("Alert copy.")
  @allowUndefined
  alertLabel!: Text

  @input
  @hint("Arrow that points toward the alerting note.")
  @allowUndefined
  indicator!: DirectionalIndicator

  @input
  @hint("Label beside the direction arrow, naming how many notes are due.")
  @allowUndefined
  dueLabel!: Text

  @ui.separator
  @input
  @hint("Instructional copy shown at launch.")
  onboardingCopy: string = "Pinch and hold to record a task"

  @input
  @widget(new SliderWidget(0.2, 5, 0.1))
  @hint("Seconds the alerting note must be in view before the alert clears.")
  dismissAfterSeenSeconds: number = 1

  @input
  @widget(new SliderWidget(5, 300, 5))
  @hint("Absolute cap, in seconds, so a note that can never be found does not pin the HUD forever.")
  alertMaxSeconds: number = 120

  @input
  @widget(new SliderWidget(1, 10, 0.5))
  @hint("Seconds a transient message stays on screen.")
  transientDurationSeconds: number = 2.5

  @input
  @hint("Copy beside the arrow for a single due note. {n} is the count.")
  dueSingularCopy: string = "1 note is due"

  @input
  @hint("Copy beside the arrow for several due notes. {n} is the count.")
  duePluralCopy: string = "{n} notes are due"

  @input
  @hint("Copy beside the arrow when a due note is also overdue.")
  overdueCopy: string = "past due"

  private alertQueue: QueuedAlert[] = []
  private currentAlert: QueuedAlert | null = null
  private alertElapsed: number = 0

  private onboardingVisible: boolean = false
  private onboardingDismissed: boolean = false
  private dueCount: number = 0
  private anyOverdue: boolean = false
  /** How long the current alert's note has been continuously in view. */
  private seenTime: number = 0
  private transientElapsed: number = 0
  private transientActive: boolean = false

  onAwake(): void {
    this.setAlertVisible(false)
    this.setDueLabel("")
  }

  /** Shows the launch instructions. */
  showOnboarding(): void {
    if (this.onboardingDismissed) {
      return
    }

    this.onboardingVisible = true

    if (this.onboardingLabel !== null && this.onboardingLabel !== undefined) {
      this.onboardingLabel.text = this.onboardingCopy
    }
    if (this.onboardingRoot !== null && this.onboardingRoot !== undefined) {
      this.onboardingRoot.enabled = true
    }
  }

  /**
   * Dismisses onboarding permanently for this session. Called on the first
   * successful recording and on tap.
   */
  dismissOnboarding(): void {
    if (!this.onboardingVisible && this.onboardingDismissed) {
      return
    }

    this.onboardingVisible = false
    this.onboardingDismissed = true

    if (this.onboardingRoot !== null && this.onboardingRoot !== undefined) {
      this.onboardingRoot.enabled = false
    }
  }

  isOnboardingVisible(): boolean {
    return this.onboardingVisible
  }

  /**
   * Queues a reminder alert.
   * @param target World position of the note, for the directional indicator.
   */
  queueAlert(message: string, target: vec3, noteId: string): void {
    // Guard against the same note queueing twice before it is shown.
    for (let i = 0; i < this.alertQueue.length; i++) {
      if (this.alertQueue[i].noteId === noteId) {
        return
      }
    }
    if (this.currentAlert !== null && this.currentAlert.noteId === noteId) {
      return
    }

    this.alertQueue.push({ message: message, target: target, noteId: noteId })
  }

  /** Dismisses the alert on screen and moves to the next queued one. */
  dismissCurrentAlert(): void {
    this.currentAlert = null
    this.alertElapsed = 0
    this.seenTime = 0
    this.setAlertVisible(false)

    if (this.indicator !== null && this.indicator !== undefined) {
      this.indicator.clearTarget()
    }
  }

  hasActiveAlert(): boolean {
    return this.currentAlert !== null
  }

  /**
   * Reports how many notes are currently due, so the arrow can be captioned.
   *
   * An arrow alone says "something is over there" but not why it matters; the
   * caption is what makes an off-screen note actionable at a glance.
   */
  setDueState(dueCount: number, anyOverdue: boolean): void {
    this.dueCount = dueCount
    this.anyOverdue = anyOverdue
  }

  tick(dt: number): void {
    this.advanceAlerts(dt)
    this.advanceTransient(dt)
    this.updateDueLabel()

    if (this.indicator !== null && this.indicator !== undefined) {
      this.indicator.tick(dt)
    }
  }

  /** Caption beside the arrow. Only shown while the arrow itself is showing. */
  private updateDueLabel(): void {
    if (this.dueLabel === null || this.dueLabel === undefined) {
      return
    }

    const arrowShowing =
      this.indicator !== null && this.indicator !== undefined && this.indicator.hasTarget()

    if (!arrowShowing || this.dueCount <= 0) {
      this.setDueLabel("")
      return
    }

    const template = this.dueCount === 1 ? this.dueSingularCopy : this.duePluralCopy
    let text = template.replace("{n}", "" + this.dueCount)

    if (this.anyOverdue) {
      text += " \u00B7 " + this.overdueCopy
    }

    this.setDueLabel(text)
  }

  private setDueLabel(text: string): void {
    if (this.dueLabel !== null && this.dueLabel !== undefined) {
      if (this.dueLabel.text !== text) {
        this.dueLabel.text = text
      }
    }
  }

  private advanceAlerts(dt: number): void {
    if (this.currentAlert === null) {
      if (this.alertQueue.length === 0) {
        return
      }

      this.currentAlert = this.alertQueue.shift() as QueuedAlert
      this.alertElapsed = 0
      this.seenTime = 0

      if (this.alertLabel !== null && this.alertLabel !== undefined) {
        this.alertLabel.text = this.currentAlert.message
      }
      this.setAlertVisible(true)

      if (this.indicator !== null && this.indicator !== undefined) {
        this.indicator.setTarget(this.currentAlert.target)
      }
      return
    }

    this.alertElapsed += dt

    // A reminder is not "delivered" until the user has actually looked at the
    // note it refers to. Dismissing on a timer meant an alert could come and go
    // while the user was facing the other way, which is precisely the case the
    // directional indicator exists to handle.
    const inView =
      this.indicator !== null &&
      this.indicator !== undefined &&
      this.indicator.isTargetInView()

    if (inView) {
      this.seenTime += dt
    } else {
      this.seenTime = 0
    }

    if (this.seenTime >= this.dismissAfterSeenSeconds) {
      this.dismissCurrentAlert()
      return
    }

    // Safety valve: a note that can never be reached must not pin the HUD.
    if (this.alertElapsed >= this.alertMaxSeconds) {
      this.dismissCurrentAlert()
    }
  }

  /**
   * Shows a short-lived message in the alert slot, for things that need saying
   * but need no acknowledgement — a discarded empty recording, for instance.
   */
  showTransientMessage(message: string): void {
    if (this.currentAlert !== null) {
      return
    }
    if (this.alertLabel !== null && this.alertLabel !== undefined) {
      this.alertLabel.text = message
    }
    this.setAlertVisible(true)
    this.transientActive = true
    this.transientElapsed = 0
  }

  private advanceTransient(dt: number): void {
    if (!this.transientActive) {
      return
    }

    this.transientElapsed += dt

    if (this.transientElapsed >= this.transientDurationSeconds) {
      this.transientActive = false
      if (this.currentAlert === null) {
        this.setAlertVisible(false)
      }
    }
  }

  private setAlertVisible(visible: boolean): void {
    if (this.alertRoot !== null && this.alertRoot !== undefined) {
      this.alertRoot.enabled = visible
    }
  }

}
