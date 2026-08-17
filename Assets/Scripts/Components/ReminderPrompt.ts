/**
 * Asks the user when they want to be reminded.
 *
 * Voice is the primary path: the mic reopens, the response is transcribed, and
 * the phrase is resolved on-device. Anything the parser cannot resolve
 * confidently falls through to the manual picker rather than guessing — a
 * wrong reminder time is worse than one extra tap.
 *
 * The "Don't remind me" option is present in both paths at all times.
 */

import { describeReminder, ParseKind, parseReminderTime } from "../Core/TimeParser"
import { SpeechService } from "../Services/SpeechService"
import { ReminderOptionButton } from "./ReminderOptionButton"

export type ReminderResolution = (reminderAt: number | null) => void

@component
export class ReminderPrompt extends BaseScriptComponent {
  @input
  @hint("Root object for the whole prompt. Hidden when idle.")
  root!: SceneObject

  @input
  @hint("Main question copy.")
  @allowUndefined
  promptLabel!: Text

  @input
  @hint("Echoes what was heard, and any parse failure.")
  @allowUndefined
  statusLabel!: Text

  @input
  @hint("Container for the manual picker options.")
  @allowUndefined
  pickerRoot!: SceneObject

  @input
  @hint("Optional explicit option list. Leave empty to discover them under Picker.")
  @allowUndefined
  optionButtons!: ReminderOptionButton[]

  @ui.separator
  @input
  @hint("Question shown while listening.")
  promptCopy: string = "When should I remind you?"

  @input
  @hint("Shown under the question while the mic is open, to prompt speaking again.")
  listeningCopy: string = "Listening... say a time out loud"

  @input
  @hint("Shown when the spoken phrase could not be resolved and the picker appears.")
  fallbackCopy: string = "Didn't catch that — pick a time below"

  @input
  @hint("Shown when speech is unavailable and the picker is the only option.")
  noSpeechCopy: string = "Pick a time below"

  @input
  @widget(new SliderWidget(500, 5000, 100))
  @hint("Silence, in ms, that ends the spoken response on its own.")
  silenceTerminationMs: number = 1500

  @input
  @widget(new SliderWidget(2, 30, 1))
  @hint("Seconds before the prompt gives up on voice and waits on the picker.")
  voiceTimeoutSeconds: number = 12

  private speech: SpeechService | null = null
  private resolution: ReminderResolution | null = null
  private listening: boolean = false
  private elapsed: number = 0
  private active: boolean = false

  onAwake(): void {
    this.hide()

    // Options are bound on start, not awake: the buttons' own onAwake must have
    // run before their handlers can be registered.
    this.createEvent("OnStartEvent").bind(() => {
      this.bindOptions()
    })
  }

  private bindOptions(): void {
    const buttons = this.collectOptions()

    for (let i = 0; i < buttons.length; i++) {
      buttons[i].onSelected((selected: ReminderOptionButton) => {
        this.handleOptionSelected(selected)
      })
    }

    if (buttons.length === 0) {
      print("[ReminderPrompt] No option buttons found; only voice input will work.")
    }
  }

  /**
   * Resolves the option list, preferring an explicit Inspector assignment and
   * otherwise walking the picker hierarchy. Discovery means a button added in
   * the Inspector is picked up without any re-wiring.
   */
  private collectOptions(): ReminderOptionButton[] {
    const explicit: ReminderOptionButton[] = []

    // The Inspector can hand back an array padded with empty slots, so unset
    // entries are filtered rather than trusted.
    if (this.optionButtons !== null && this.optionButtons !== undefined) {
      for (let i = 0; i < this.optionButtons.length; i++) {
        const entry = this.optionButtons[i]
        if (entry !== null && entry !== undefined) {
          explicit.push(entry)
        }
      }
    }

    if (explicit.length > 0) {
      return explicit
    }

    const found: ReminderOptionButton[] = []

    if (this.pickerRoot !== null && this.pickerRoot !== undefined) {
      this.gatherOptions(this.pickerRoot, found)
    }

    return found
  }

  private gatherOptions(root: SceneObject, output: ReminderOptionButton[]): void {
    // Every custom script shares the ScriptComponent type, so the class cannot
    // be selected by type name — these objects also carry an Interactable, and
    // getComponent would return whichever was added first. Duck-typing on the
    // registration method is what actually identifies an option button.
    const scripts = root.getComponents("ScriptComponent")

    for (let i = 0; i < scripts.length; i++) {
      const candidate = scripts[i] as any
      if (candidate !== null && typeof candidate.onSelected === "function") {
        output.push(candidate as ReminderOptionButton)
      }
    }

    const count = root.getChildrenCount()
    for (let i = 0; i < count; i++) {
      this.gatherOptions(root.getChild(i), output)
    }
  }

  /** Injected by NoteManager so both flows share one ASR session owner. */
  setSpeechService(speech: SpeechService): void {
    this.speech = speech
  }

  isActive(): boolean {
    return this.active
  }

  /**
   * Opens the prompt.
   *
   * @param worldPosition Where to place the panel, usually below the new orb.
   * @param worldRotation Rotation that faces the panel back at the user.
   * @param resolve Called exactly once with the chosen time, or null for none.
   */
  show(worldPosition: vec3, worldRotation: quat, resolve: ReminderResolution): void {
    this.resolution = resolve
    this.active = true
    this.elapsed = 0

    if (this.root !== null && this.root !== undefined) {
      this.root.enabled = true
      const transform = this.root.getTransform()
      transform.setWorldPosition(worldPosition)
      transform.setWorldRotation(worldRotation)
    }

    this.setPrompt(this.promptCopy)
    this.setStatus(this.listeningCopy)

    // The picker is a fallback, not the primary path. Showing seven buttons
    // straight away buries the instruction to speak and makes voice entry look
    // like an afterthought, so it stays hidden until voice actually fails.
    this.setPickerVisible(false)

    this.startListening()
  }

  private startListening(): void {
    if (this.speech === null || !this.speech.isAvailable()) {
      // No speech available: the picker alone carries the flow.
      this.revealPicker(this.noSpeechCopy)
      return
    }

    this.listening = true

    const started = this.speech.start(
      {
        onPartial: (text: string) => {
          if (text.length > 0) {
            this.setStatus('"' + text + '"')
          }
        },
        onFinal: (text: string) => {
          this.listening = false
          this.handleSpokenResponse(text)
        },
        onError: (message: string) => {
          this.listening = false
          this.revealPicker(message + " — pick a time below")
        }
      },
      this.silenceTerminationMs
    )

    if (!started) {
      this.listening = false
      this.revealPicker(this.fallbackCopy)
    }
  }

  private handleSpokenResponse(text: string): void {
    if (!this.active) {
      return
    }

    if (text.length === 0) {
      this.revealPicker(this.fallbackCopy)
      return
    }

    const now = new Date()
    const parsed = parseReminderTime(text, now)

    if (parsed.kind === ParseKind.NoReminder) {
      this.setStatus("No reminder set")
      this.finish(null)
      return
    }

    if (parsed.kind === ParseKind.Time) {
      this.setStatus("Reminder " + describeReminder(parsed.timestamp, now))
      this.finish(parsed.timestamp)
      return
    }

    // Unparsed: show what was heard so the user understands why the picker
    // appeared, rather than silently ignoring them.
    this.revealPicker('Heard "' + text + '" — pick a time below')
  }

  private handleOptionSelected(button: ReminderOptionButton): void {
    if (!this.active) {
      return
    }

    this.stopListening()

    if (button.isNoReminder()) {
      this.finish(null)
      return
    }

    const now = new Date()
    const resolved = button.resolve(now)

    if (resolved !== null) {
      this.setStatus("Reminder " + describeReminder(resolved, now))
    }

    this.finish(resolved)
  }

  /** Advances the voice timeout. Call once per frame while active. */
  tick(dt: number): void {
    if (!this.active || !this.listening) {
      return
    }

    this.elapsed += dt

    if (this.elapsed >= this.voiceTimeoutSeconds) {
      this.stopListening()
      this.revealPicker(this.fallbackCopy)
    }
  }

  private stopListening(): void {
    if (this.listening && this.speech !== null) {
      this.speech.cancel()
    }
    this.listening = false
  }

  /** Delivers the result and closes. Safe against double resolution. */
  private finish(reminderAt: number | null): void {
    const resolve = this.resolution

    this.resolution = null
    this.active = false
    this.stopListening()
    this.hide()

    if (resolve !== null) {
      resolve(reminderAt)
    }
  }

  /** Closes the prompt without resolving, e.g. when a new recording starts. */
  cancel(): void {
    this.resolution = null
    this.active = false
    this.stopListening()
    this.hide()
  }

  private hide(): void {
    if (this.root !== null && this.root !== undefined) {
      this.root.enabled = false
    }
  }

  /** Brings up the manual picker and explains why it appeared. */
  private revealPicker(reason: string): void {
    this.setStatus(reason)
    this.setPickerVisible(true)
  }

  private setPickerVisible(visible: boolean): void {
    if (this.pickerRoot !== null && this.pickerRoot !== undefined) {
      this.pickerRoot.enabled = visible
    }
  }

  private setPrompt(text: string): void {
    if (this.promptLabel !== null && this.promptLabel !== undefined) {
      this.promptLabel.text = text
    }
  }

  private setStatus(text: string): void {
    if (this.statusLabel !== null && this.statusLabel !== undefined) {
      this.statusLabel.text = text
    }
  }
}
