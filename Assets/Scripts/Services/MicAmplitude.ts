/**
 * Reads the microphone and exposes a smoothed, normalized loudness value that
 * shader parameters can be driven from directly.
 *
 * Raw RMS is jittery frame to frame and would make the orb strobe rather than
 * breathe, so the signal is smoothed with an asymmetric envelope follower:
 * fast attack so the orb responds the instant the user speaks, slow release so
 * it settles gracefully instead of snapping back between syllables.
 */

import { clamp01, damp } from "../Core/Urgency"

/** Frames requested per update. 1024 covers a frame at typical sample rates. */
const FRAME_SIZE = 1024

export class MicAmplitude {
  private provider: MicrophoneAudioProvider | null = null
  private buffer: Float32Array = new Float32Array(FRAME_SIZE)
  private smoothed: number = 0
  private peak: number = 0.05
  private running: boolean = false

  // Diagnostics. "The orb does not react" has several very different causes —
  // no track assigned, start() refused, zero frames delivered, or frames that
  // are genuinely silent — and they are indistinguishable without counters.
  private startedOk: boolean = false
  private startError: string = ""
  private framesSeen: number = 0
  private lastSampleCount: number = 0
  private lastRms: number = 0

  /** Most recent measured loudness, held between sparse frame deliveries. */
  private heldLoudness: number = 0
  /** Seconds since the last frame actually arrived. */
  private silenceTime: number = 0

  /**
   * @param attackRate Envelope rise speed, in units/second.
   * @param releaseRate Envelope fall speed, in units/second.
   * @param sensitivity Multiplier applied to the normalized level.
   */
  constructor(
    private attackRate: number = 26,
    private releaseRate: number = 6,
    private sensitivity: number = 1,
    /** How long a measurement is held when no new audio frame arrives. */
    private holdSeconds: number = 0.35
  ) {}

  /**
   * Binds to a microphone audio track and begins capture.
   * @param audioTrack An AudioTrackAsset whose control is a MicrophoneAudioProvider.
   */
  start(audioTrack: AudioTrackAsset | null): boolean {
    this.startedOk = false
    this.startError = ""
    this.framesSeen = 0
    this.lastSampleCount = 0
    this.lastRms = 0

    if (audioTrack === null || audioTrack === undefined) {
      this.startError = "no track assigned"
      print("[MicAmplitude] No microphone audio track assigned.")
      return false
    }

    const control = audioTrack.control as MicrophoneAudioProvider

    if (control === null || control === undefined || control.start === undefined) {
      this.startError = "control is not a MicrophoneAudioProvider"
      print("[MicAmplitude] Audio track control is not a MicrophoneAudioProvider.")
      return false
    }

    this.provider = control
    this.smoothed = 0
    this.peak = 0.05
    this.heldLoudness = 0
    this.silenceTime = 0

    try {
      this.provider.start()
    } catch (e) {
      this.startError = "start() threw: " + e
      print("[MicAmplitude] Failed to start microphone: " + e)
      this.provider = null
      return false
    }

    this.running = true
    this.startedOk = true
    return true
  }

  stop(): void {
    if (this.provider !== null && this.running) {
      try {
        this.provider.stop()
      } catch (e) {
        print("[MicAmplitude] Failed to stop microphone: " + e)
      }
    }
    this.running = false
    this.provider = null
    this.smoothed = 0
  }

  isRunning(): boolean {
    return this.running
  }

  /**
   * Pumps the audio queue and advances the envelope. Call once per frame.
   * @param dt Seconds since the previous update.
   * @returns Smoothed loudness in [0, 1].
   */
  update(dt: number): number {
    if (!this.running || this.provider === null) {
      return 0
    }

    let loudest = 0
    let sawAudio = false

    // Drain every frame queued since the last update, otherwise the buffer
    // backs up and the envelope lags behind the speaker.
    for (let guard = 0; guard < 16; guard++) {
      const shape = this.provider.getAudioFrame(this.buffer)
      const sampleCount = shape.x

      if (sampleCount <= 0) {
        break
      }

      sawAudio = true
      this.framesSeen += 1
      this.lastSampleCount = sampleCount

      const rms = this.computeRms(sampleCount)
      if (rms > loudest) {
        loudest = rms
      }
    }

    if (sawAudio) {
      // Track a decaying peak so the orb stays expressive for quiet and loud
      // speakers alike, rather than requiring a hand-tuned absolute threshold.
      //
      // The decay is deliberately quick and the floor deliberately low: with a
      // slow decay one loud syllable sets a high reference that the rest of the
      // sentence never approaches, and the orb goes flat for seconds afterwards.
      this.peak = Math.max(this.peak * 0.99, loudest, 0.008)
    }

    if (sawAudio) {
      this.lastRms = loudest
    }

    const normalized = clamp01((loudest / this.peak) * this.sensitivity)
    const rate = normalized > this.smoothed ? this.attackRate : this.releaseRate
    this.smoothed = damp(this.smoothed, normalized, rate, dt)

    return clamp01(this.smoothed)
  }

  /**
   * One-line state summary for the interaction debug readout.
   *
   * frames=0 while running means the provider is delivering nothing at all,
   * which is a routing or permission problem rather than a tuning one.
   */
  getDiagnostics(): string {
    if (!this.running) {
      return this.startError.length > 0 ? "stopped (" + this.startError + ")" : "stopped"
    }
    if (!this.startedOk) {
      return "start failed: " + this.startError
    }
    return (
      "frames=" +
      this.framesSeen +
      " samples=" +
      this.lastSampleCount +
      " rms=" +
      this.lastRms.toFixed(4) +
      " peak=" +
      this.peak.toFixed(4) +
      " gap=" +
      this.silenceTime.toFixed(2)
    )
  }

  /** Last computed level, without advancing the envelope. */
  getLevel(): number {
    return clamp01(this.smoothed)
  }

  setSensitivity(value: number): void {
    this.sensitivity = value
  }

  private computeRms(sampleCount: number): number {
    const count = Math.min(sampleCount, this.buffer.length)
    if (count <= 0) {
      return 0
    }

    let sum = 0
    for (let i = 0; i < count; i++) {
      const sample = this.buffer[i]
      sum += sample * sample
    }

    return Math.sqrt(sum / count)
  }
}
