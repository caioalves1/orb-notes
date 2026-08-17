/**
 * Resolves what an orb should look like for a given note and moment.
 *
 * Colour and emission are resolved together and kept pure, so the visual state
 * can never drift out of sync with the data, and so every state's brightness can
 * be tuned independently. That last part matters: a single global intensity made
 * the low-urgency states ("no reminder", "far") read as muddy while the bright
 * states looked right, because the same multiplier cannot serve a deep blue and
 * a hot orange at once.
 */

import { NoteData } from "./NoteModel"
import { lerpHue, resolveBand, UrgencyThresholds } from "./Urgency"

/** Which visual state an orb is presenting. */
export const OrbLookState = {
  Recording: "recording",
  Settling: "settling",
  Placed: "placed"
} as const

export type OrbLookState = (typeof OrbLookState)[keyof typeof OrbLookState]

export interface OrbAppearance {
  /** Band boundaries: one week, one day, one hour of remaining time. */
  thresholds: UrgencyThresholds

  /**
   * Grace period after the reminder before a note counts as overdue.
   *
   * Without this the overdue state begins at the exact instant the ramp reaches
   * its final stop, so colour D is never actually displayed — it is reached and
   * replaced in the same frame.
   */
  overdueAfterMs: number

  recordingColor: vec4
  staticColor: vec4

  /**
   * The four ramp stops, in order of increasing urgency:
   *   Week  more than a week out  (flat)
   *   Day   one day out
   *   Hour  one hour out
   *   Due   due, and everything past due
   *
   * The ramp ends at Due rather than handing over to a separate overdue colour,
   * so an overdue note simply stays at the end of the ramp.
   */
  colorWeek: vec4
  colorDay: vec4
  colorHour: vec4
  colorDue: vec4

  /** Emission multiplier per state. Tuned independently, see note above. */
  recordingIntensity: number
  settledIntensity: number
  staticIntensity: number
  intensityWeek: number
  intensityDay: number
  intensityHour: number
  intensityDue: number
}

export interface OrbLook {
  color: vec4
  /** Emission multiplier applied to rim and glow. */
  intensity: number
  /** True once the reminder time has passed. */
  overdue: boolean
}

/**
 * Resolves colour and emission for an orb.
 *
 * @param note Bound note, or null while recording before a note exists.
 * @param now Epoch milliseconds.
 * @param state Current visual state.
 */
export function resolveOrbLook(
  note: NoteData | null,
  now: number,
  state: OrbLookState,
  appearance: OrbAppearance
): OrbLook {
  // While capturing, the orb reads as "live" rather than as an urgency state —
  // it has no reminder yet, so urgency colouring would be meaningless.
  if (state === OrbLookState.Recording || state === OrbLookState.Settling) {
    return {
      color: appearance.recordingColor,
      intensity:
        state === OrbLookState.Recording
          ? appearance.recordingIntensity
          : appearance.settledIntensity,
      overdue: false
    }
  }

  // Recorded but not yet committed: the orb is resting while the user answers
  // the reminder prompt. This is the state people actually mean by "settled" —
  // previously settledIntensity only applied during the half-second transition
  // and this resting look fell through to staticIntensity, so the input looked
  // like it did nothing.
  if (note === null) {
    return {
      color: appearance.recordingColor,
      intensity: appearance.settledIntensity,
      overdue: false
    }
  }

  if (note.reminderAt === null) {
    return {
      color: appearance.staticColor,
      intensity: appearance.staticIntensity,
      overdue: false
    }
  }

  // Which pair of stops the note sits between, and how far along. resolveBand
  // clamps negative remaining time to zero, so a past-due note lands at the end
  // of the final band — i.e. exactly Colour Due — with no separate branch.
  const band = resolveBand(note.reminderAt - now, appearance.thresholds)

  const colors = [
    appearance.colorWeek,
    appearance.colorDay,
    appearance.colorHour,
    appearance.colorDue
  ]
  const intensities = [
    appearance.intensityWeek,
    appearance.intensityDay,
    appearance.intensityHour,
    appearance.intensityDue
  ]

  return {
    color: lerpHue(colors[band.from], colors[band.to], band.t),
    intensity:
      intensities[band.from] +
      (intensities[band.to] - intensities[band.from]) * band.t,
    // Reported for the HUD's "past due" caption only; it no longer changes the
    // colour, which is why overdueAfterMs is a labelling threshold now.
    overdue: now >= note.reminderAt + appearance.overdueAfterMs
  }
}

/** Convenience re-export so components need only one import for colour work. */
export { lerpHue }
