/**
 * Urgency math for note colouring.
 *
 * A note's colour is a pure function of (reminderAt, now, horizon), so the
 * visual state can never drift out of sync with the data. Kept engine-free
 * apart from vec4, which is only used as a colour container.
 */

// Type-only: erased at compile time, which also keeps this module runnable
// under plain Node for the band tests in Tests/.
import type { NoteData } from "./NoteModel"

/** Time thresholds that divide the colour ramp into bands. */
export interface UrgencyThresholds {
  weekMs: number
  dayMs: number
  hourMs: number
}

/**
 * Which pair of colour stops a note falls between, and how far along.
 *
 * Stops are indexed 0..3 (A, B, C, D):
 *   remaining >= week          -> A flat
 *   week   > remaining >= day  -> A to B
 *   day    > remaining >= hour -> B to C
 *   hour   > remaining         -> C to D
 *
 * Returned as indices plus a blend factor rather than as a colour so the band
 * maths stays engine-free and testable; the caller supplies the palette.
 */
export interface UrgencyBand {
  from: number
  to: number
  t: number
}

export function resolveBand(
  remainingMs: number,
  thresholds: UrgencyThresholds
): UrgencyBand {
  const week = thresholds.weekMs
  const day = thresholds.dayMs
  const hour = thresholds.hourMs

  // Past due sits at the far end of the ramp; the overdue state is resolved
  // separately, by OrbAppearance.
  const remaining = remainingMs < 0 ? 0 : remainingMs

  if (remaining >= week) {
    return { from: 0, to: 0, t: 0 }
  }

  if (remaining >= day) {
    const span = week - day
    return { from: 0, to: 1, t: span <= 0 ? 1 : (week - remaining) / span }
  }

  if (remaining >= hour) {
    const span = day - hour
    return { from: 1, to: 2, t: span <= 0 ? 1 : (day - remaining) / span }
  }

  return { from: 2, to: 3, t: hour <= 0 ? 1 : (hour - remaining) / hour }
}

/**
 * Normalized urgency in [0, 1] across the whole ramp, for the pulse rate.
 * Each band occupies an equal third so the pulse rises steadily rather than
 * jumping at the boundaries.
 */
export function urgencyOf(
  note: NoteData,
  now: number,
  thresholds: UrgencyThresholds
): number {
  if (note.reminderAt === null) {
    return 0
  }

  const band = resolveBand(note.reminderAt - now, thresholds)

  if (band.from === 0 && band.to === 0) {
    return 0
  }

  return clamp01((band.from + band.t) / 3)
}

/**
 * Interpolates two colours through hue space.
 *
 * A straight RGB lerp between two saturated hues passes through a desaturated
 * middle — blue to orange goes via grey-pink — so the halfway state reads as
 * washed out rather than as partway between the two. Travelling along the hue
 * circle (the short way) keeps saturation up across the whole ramp.
 */
export function lerpHue(from: vec4, to: vec4, t: number): vec4 {
  const clamped = clamp01(t)
  const a = rgbToHsv(from)
  const b = rgbToHsv(to)

  let hueDelta = b.h - a.h

  // Take the shorter way around the circle: 350deg to 10deg is 20deg, not 340.
  if (hueDelta > 0.5) {
    hueDelta -= 1
  } else if (hueDelta < -0.5) {
    hueDelta += 1
  }

  let hue = a.h + hueDelta * clamped
  if (hue < 0) {
    hue += 1
  } else if (hue > 1) {
    hue -= 1
  }

  const rgb = hsvToRgb(
    hue,
    a.s + (b.s - a.s) * clamped,
    a.v + (b.v - a.v) * clamped
  )

  return new vec4(rgb.r, rgb.g, rgb.b, from.w + (to.w - from.w) * clamped)
}

function rgbToHsv(color: vec4): { h: number; s: number; v: number } {
  const r = color.x
  const g = color.y
  const b = color.z

  const max = Math.max(r, Math.max(g, b))
  const min = Math.min(r, Math.min(g, b))
  const delta = max - min

  let h = 0

  if (delta > 0.00001) {
    if (max === r) {
      h = ((g - b) / delta) % 6
    } else if (max === g) {
      h = (b - r) / delta + 2
    } else {
      h = (r - g) / delta + 4
    }
    h /= 6
    if (h < 0) {
      h += 1
    }
  }

  return { h: h, s: max <= 0.00001 ? 0 : delta / max, v: max }
}

function hsvToRgb(h: number, s: number, v: number): { r: number; g: number; b: number } {
  const i = Math.floor(h * 6)
  const f = h * 6 - i
  const p = v * (1 - s)
  const q = v * (1 - f * s)
  const t = v * (1 - (1 - f) * s)

  switch (i % 6) {
    case 0:
      return { r: v, g: t, b: p }
    case 1:
      return { r: q, g: v, b: p }
    case 2:
      return { r: p, g: v, b: t }
    case 3:
      return { r: p, g: q, b: v }
    case 4:
      return { r: t, g: p, b: v }
    default:
      return { r: v, g: p, b: q }
  }
}

/** Linear interpolation between two colours, in RGB. */
export function lerpColor(from: vec4, to: vec4, t: number): vec4 {
  const clamped = clamp01(t)
  return new vec4(
    from.x + (to.x - from.x) * clamped,
    from.y + (to.y - from.y) * clamped,
    from.z + (to.z - from.z) * clamped,
    from.w + (to.w - from.w) * clamped
  )
}

/**
 * Resolves the colour an orb should display.
 *
 * Notes without a reminder use a single static colour and never animate, which
 * is what visually distinguishes them from time-sensitive notes at a glance.
 */
export function pulseRateFor(
  note: NoteData,
  now: number,
  thresholds: UrgencyThresholds,
  basePulseHz: number,
  urgentPulseHz: number
): number {
  if (note.reminderAt === null) {
    return basePulseHz
  }
  const t = urgencyOf(note, now, thresholds)
  return basePulseHz + (urgentPulseHz - basePulseHz) * t
}

export function clamp01(value: number): number {
  if (value < 0) {
    return 0
  }
  if (value > 1) {
    return 1
  }
  return value
}

export function clamp(value: number, min: number, max: number): number {
  if (value < min) {
    return min
  }
  if (value > max) {
    return max
  }
  return value
}

/** Frame-rate independent smoothing factor for exponential damping. */
export function damp(current: number, target: number, rate: number, dt: number): number {
  const t = 1 - Math.exp(-rate * dt)
  return current + (target - current) * t
}
