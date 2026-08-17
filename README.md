# Spatial Task Notes

A SPECS Lens for capturing quick voice reminders and anchoring them in physical
space. Pinch and hold to record a note, the transcript appears beside a glowing
orb, you set an optional reminder time by voice or by picker, and the orb stays
where you left it — shifting from cool blue toward orange as its reminder
approaches.

## Feasibility findings

Three assumptions in the original brief were checked against this exact build
(Lens Studio 5.23.1, core 372, Lens API in `Support/StudioLib.d.ts`). Two did
not hold.

### Spatial Anchors are not available — placement uses persisted world positions

There is **no `AnchorModule` or `WorldAnchor`** anywhere in the Lens API for this
build (zero occurrences in `StudioLib.d.ts`), and no Spatial Anchors package in
the Asset Library. The `Anchor` class that does exist (`StudioLib.d.ts:14151`) is
Custom-Location AR — a position relative to a pre-scanned `LocationAsset`, not
ad-hoc placement. The mapping API that would produce such a location
(`MappingSession`, `createMappingSession`) is explicitly marked `@deprecated` at
`StudioLib.d.ts:18963`.

**What this project does instead:** each note's world-space transform is written
to `PersistentStorageSystem` and restored on launch (`Core/NoteStore.ts`).

**The caveat, and it is a real one:** these positions are relative to the world
tracking origin. Within a session that origin is stable and notes hold their
place exactly. *Across* sessions the origin is re-established by the platform,
and whether notes return to their true physical location depends on how Snap OS
re-localizes. **This has not been verified on hardware** — the knowledge base
was unavailable during development (see below), so it could not be confirmed
from documentation either. Treat cross-session placement accuracy as an open
question until tested on a real device in a real room.

If it turns out positions do not survive relaunch usefully, `NoteStore` already
keeps all note metadata independently of position, so degrading to "restore the
notes, let the user re-place them" is a contained change.

### Speech uses AsrModule, not VoiceML

`VoiceMLModule` exists and works, but `AsrModule` (`StudioLib.d.ts:6808`) is the
Spectacles-native path — every member is tagged `@snapOS` — and it exposes
exactly what the flow needs: `startTranscribing()` with
`TranscriptionUpdateEvent.text` / `.isFinal` for live partial-then-final
transcription. The brief specified VoiceML; this deviates deliberately.

### Time parsing runs on-device, no LLM required

The `RemoteServiceGateway` package *is* available in the Asset Library, so LLM
parsing is possible — but it needs a token generated through the "Remote Service
Gateway Token Generator" plugin, and it adds a network round-trip plus a failure
path in the middle of the capture flow.

Instead, `Core/TimeParser.ts` resolves a bounded phrase set on-device:
deterministic, offline, instant, and covered by tests. Anything it cannot
resolve confidently falls through to the manual picker rather than guessing — a
wrong reminder time is worse than one extra tap.

If you later want LLM parsing, `parseReminderTime()` is a pure function with a
narrow signature; wire an RSG call behind the same interface and keep the
on-device parser as the offline fallback.

## Setup note

`QueryLensStudioKnowledgeBase` currently fails with *"Please log into your
Snapchat account in Lens Studio."* Log in via **My Lenses > Login** to enable it.
Everything here was derived from the local type definitions instead.

## Architecture

```
Assets/Scripts/
├── Core/                    pure logic, no engine dependencies
│   ├── NoteModel.ts         note shape, validation, id generation
│   ├── NoteStore.ts         PersistentStorageSystem read/write
│   ├── TimeParser.ts        natural language -> timestamp
│   └── Urgency.ts           urgency math, colour interpolation, damping
├── Services/
│   ├── SpeechService.ts     AsrModule wrapper
│   ├── MicAmplitude.ts      mic RMS -> smoothed envelope
│   └── PinchHold.ts         hold-past-threshold gesture, both hands
└── Components/
    ├── NoteManager.ts       orchestrator; owns all state transitions
    ├── NoteOrb.ts           per-note visual state machine
    ├── ReminderPrompt.ts    voice capture + picker fallback
    ├── ReminderOptionButton.ts
    ├── HudController.ts     onboarding, alert queue
    ├── DirectionalIndicator.ts
    └── OrbDebugPanel.ts     live orb tuning row (dev only)
```

`NoteManager` is the only component that drives state transitions; the others
are driven from it, so the whole flow can be read in one file.

The `Core/` modules are deliberately engine-free so they can be reasoned about
and tested outside Lens Studio.

## Tests

`Tests/TimeParser.test.ts` covers 38 parsing cases against a fixed reference
time. It runs on plain Node (26+, via type-stripping) and is excluded from the
Lens build because it lives outside `Assets/`.

```bash
cd Tests && node TimeParser.test.ts
```

Six real bugs were found and fixed this way: a clock extractor that grabbed the
day number out of "december 25 at 8am" and silently fell back to a default hour,
a missing day-of-month rule that made "on the 20th at 3pm" resolve to *today*,
and "next friday" landing a week late.

Later additions: **bare durations without a preposition** — asked "when should I
remind you?", "ten minutes" is a complete answer, but requiring "in" sent it
straight to the fallback picker. `parseBareDuration` runs late in the strategy
list so it never intercepts phrases a more specific rule owns, and requires an
explicit unit word so a bare number can still read as a clock time.

Note on semantics: "next friday" and "on friday" both resolve to the **next
occurrence** of that weekday. English is genuinely ambiguous here — for some
speakers "next friday" skips the upcoming one — and this choice keeps a reminder
early rather than a week late.

## Scene layout

```
Camera Object
└── HUD                      head-locked  [HudController]
    ├── Onboarding           dismissed on first recording or tap
    ├── Alert                queued reminder alerts
    └── Indicator            [DirectionalIndicator] -> Arrow
Spatial Notes
├── Note Manager             [NoteManager]
├── Orb Debug Panel          [OrbDebugPanel] live orb tuning row, off by default
├── Orb Container            spawned orbs are parented here; never moves
├── Orb Template             disabled; cloned per note
│   ├── Visual               scaled by the orb animation
│   │   ├── Core             Rim Highlight shader
│   │   └── Glow             Outer Glow shader, 3 instanced shells
│   └── Transcript Panel     stays steady while the orb pulses
└── Reminder Prompt          [ReminderPrompt] -> Picker -> 7 options
```

The transcript panel is a sibling of `Visual`, not a child, so the
audio-reactive pulse scales the orb without jittering the text.

## Orb shaders

Built from `SpectaclesShaderLibrary` (installed as part of this work). Materials
are cloned per orb at runtime, so each note owns its own parameters.

| Brief parameter | Implementation |
|---|---|
| glow/emission intensity | `rimIntensity`, `glowIntensityScale`, per-state emission |
| fresnel/rim power | `rimExponent` |
| noise scale and speed | `meshNoiseScale` / `meshAmplitude` / `noiseSpeed` |
| audio-reactivity multiplier | `audioSensitivity`, `audioEmissionResponse` |

### The glow is deliberately held back

At full strength the screen-blended halo washes over the core and inner shell
and becomes the only thing visible — flattening the orb back into a bright disc,
which is exactly what the displaced geometry was added to fix. It now defaults
to `glowIntensityScale` 0.35 with a high `glowFalloff` (7) for a smooth fade
rather than banding across its three instanced shells, and `glowEnabled` turns
it off entirely. The core and inner shell are meant to carry the read; the halo
only sits behind them.

### Colour bands

The ramp has four stops driven by **remaining time against fixed thresholds**:

| Remaining | Colour |
|---|---|
| more than a week | **Colour Week**, flat |
| week → day | **Week → Day** |
| day → hour | **Day → Hour** |
| hour → due | **Hour → Due** |
| past due | stays at **Colour Due** |

Thresholds are Inspector inputs on `NoteManager` — `weekThresholdMinutes`
(10080), `dayThresholdMinutes` (1440), `hourThresholdMinutes` (60) — so the
bands can be retimed without touching code. `recordingColor` and `staticColor`
are unchanged.

There is no separate overdue colour. `resolveBand()` clamps negative remaining
time to zero, so a past-due note lands at the end of the final band, which *is*
Colour Due. That removed a whole branch and with it a real defect: an earlier
version flipped to a distinct overdue colour at exactly the instant the ramp
reached its last stop, so the final colour was reached and replaced in the same
frame and never actually appeared. `overdueAfterMinutes` survives, but now only
decides when the HUD captions a note "past due" — it no longer affects colour.

Emission interpolates alongside the colour, one value per stop
(`intensityWeek`..`intensityDue`), so a deep blue Week and a hot red Due can be
balanced independently.

**Blending happens in hue space, not RGB.** `lerpHue()` converts both stops to
HSV, walks the short way around the hue circle, and converts back. A straight
RGB lerp between two saturated hues passes through a desaturated middle — blue
to orange goes via grey-pink — so the halfway state reads as washed out rather
than as partway between the two. This was a real defect earlier in the project,
worked around then with an extra mid stop; interpolating in hue removes the
cause rather than patching it.

Band selection is a pure function, `resolveBand()`, returning stop indices plus
a blend factor rather than a colour — which keeps the maths engine-free and
testable. `Tests/Urgency.test.ts` covers all four bands and both edges of each
boundary (17 cases).

Note on boundaries: a value exactly on a threshold resolves to the *end* of the
lower band (`Week→Day` at `t=1`) rather than the start of the next. Both express
the same colour, so the ramp is continuous either way.

### Emission is per state, not global

One global intensity cannot serve both a deep blue "far" orb and a hot orange
"due" orb — set it for one and the other reads wrong. `NoteManager` exposes
`recordingIntensity`, `settledIntensity`, `staticIntensity`, `farIntensity`,
`midIntensity`, `dueIntensity` and `overdueIntensity` separately. Raise
`staticIntensity` / `farIntensity` if the calm states read too dark.

All colours are `ColorWidget` pickers, including a distinct `overdueColor` for
notes whose reminder has passed.

All are Inspector inputs on `NoteOrb`, not hardcoded.

### Why the noise is in the geometry, not a texture

The orb originally read as a flat disc, and no amount of shader tuning fixed it.
The reason is structural: **a smooth sphere has a circular silhouette from every
angle**, so rotation is literally invisible and the fresnel rim has no form to
catch. Detail had to enter the shape itself.

`Core/OrbGeometry.ts` generates a noise-displaced icosphere: an icosahedron
subdivided N times, projected to a unit sphere, then displaced along each vertex
normal by 3D fbm value noise. An icosphere is used rather than a UV sphere
because its triangles are near-uniform, so displacement is even instead of
bunching at the poles. Normals are recomputed area-weighted from the displaced
positions.

The orb is then three shells:

| Shell | Mesh | Behaviour |
|---|---|---|
| Core | displaced, seed 1 | slow spin on a tilted axis |
| Inner | displaced, seed 7, finer + deeper | counter-spins, tighter rim |
| Glow | shares the core mesh | halo hugging the real silhouette |

Two details that turned out to matter:

- **The glow shares the core's mesh.** A smooth glow sphere wrapped the
  displaced core in a perfect circle and hid the exact silhouette that makes it
  read as 3D — undoing the whole effect.
- **The shells use different seeds and counter-rotate**, so their silhouettes
  never align. That mismatch is what produces parallax and reads as volume.

Meshes are cached by parameter set and shared across every orb, so a scene of
notes generates each distinct shape once.

This route was taken because the shader library's texture and UV-animation paths
sit behind compile-time `#define`s, and package materials cannot be duplicated
(`duplicateAsset` fails on them) to flip those defines. Displacing geometry needs
no shader variant at all. `ProceduralTextureProvider` is available if a true
noise *map* is wanted later.

Set `useDisplacedMesh` off to fall back to smooth spheres.

Urgency also drives a **pulse rate**, so time pressure stays legible without
relying on colour alone.

## Notes are clickable

A committed note hides its transcript, so a room of notes is a field of orbs
rather than a wall of floating paragraphs. Clicking an orb reveals its text and
hides every other one; clicking it again, or pressing empty space, hides it.

Pressing empty space is also what starts a recording, so the two must never
collide. Getting this right needed a **press filter** rather than SIK's
Interactable targeting:

SIK freezes interactor targeting for the duration of a trigger
(`shouldPreventTargetUpdate`). A press that has not hovered first therefore
reports `currentInteractable === null` for its whole duration — so an orb press,
and even a picker button press, read as empty space and started a new recording.
That is exactly the reported bug, and it also silently cancelled the reminder
prompt mid-answer.

`PinchHold.setPressFilter()` is consulted before any gesture begins:

1. **While the reminder prompt is open, every press is claimed.** The user is
   answering a question; no press should abandon it. SIK then resolves the
   button press on its own terms.
2. **Orbs are hit-tested explicitly** — perpendicular distance from the press
   ray to each orb centre, nearest hit wins, within `orbClickRadius` (7cm).
   Owned geometry, no dependency on collider cloning or raycast layers.

The in-progress recording orb is included in that test, so pressing it cannot
stack a second recording on top of the one being made. A superseded recording
orb is also destroyed rather than orphaned.

Worth recording: **`copyWholeHierarchy` does not clone physics colliders.** The
authored collider on the Orb Template is absent from every spawned clone, which
is why `NoteOrb.ensureCollider()` creates one at runtime via
`Shape.createSphereShape()`.

## Hover feedback

Both the orbs and the picker options respond to being pointed at, so it is
visible that they can be clicked at all.

Picker options use SIK's `onInteractorHoverEnter/Exit` and ease their plate
toward `hoverColor` at `hoverScale`. Orbs use the **same ray test as selection**
rather than SIK hover events — that way the highlight and the click can never
disagree about which orb is targeted — growing by `hoverScaleBoost` (0.25) and
brightening by `hoverEmissionBoost` (1.1).

**What actually blocked orb hover** (three separate faults, all mine):

1. `collider.intangible = true`. Intangible colliders are skipped by raycasts,
   which removed the orbs from SIK's targeting entirely — no hover, no
   Interactable click. This was also the original reason orb clicks had to be
   done with a separate ray test.
2. The pointer ray required `endPoint`, which `MouseTargetProvider` only
   populates when the interactor's raycast **hits** something. Over empty space
   there was no ray at all — precisely when hover detection needs to run.
   `buildPointerRay()` now prefers the interactor's own `direction` and uses the
   start/end delta only as a fallback.

3. **The wrong interactor supplied the ray.** `getInteractors()` returns hands,
   mouse and mobile; taking the first *enabled* one meant an untracked hand won
   every frame. `enabled` and even `isActive()` stay true for a hand with
   nothing in front of the camera, and it reports the ray from wherever the
   hand was last seen — a fixed vector pointing off into the room
   (`bestOffset=Infinity`, i.e. every orb behind the ray). The pointer is now
   chosen by priority — a triggering interactor first, then Mouse, then a hand
   that `isTracked()`. Mouse-first is correct on both targets, since
   MouseInteractor deregisters itself outside the editor.

Mouse-move without a press *is* delivered (that is how the picker buttons
hover); an earlier note here claiming otherwise was wrong.

Diagnosed by logging the ray itself — origin, direction, source input type and
closest orb offset — rather than by inspection. `logHover` on `NoteManager` and
`NoteOrb` turns that back on.

## Selecting a note

Clicking an orb opens its panel: the trimmed transcript, a live countdown
(`9 min left`, `2h 15m left`, `5 min overdue`), and a **Done** button. Done and
delete are one action — either way the user no longer wants the orb — so there is
a single control rather than two that behave identically.

The transcript is shown **in full**. It sits above the orb with its text
anchored at the bottom, so a long note grows upward — away from the reminder
prompt below — which removes the collision without truncating anything.

The countdown ticks per second: `MM:SS left` under an hour, `H:MM:SS` under a
day, `Nd Hh` beyond that. It and the Done button sit side by side.

**Done is driven by the same ray test as selection, not by its Interactable.**
SIK's Interactable does not reliably deliver events on cloned orbs — the same
fault that forced selection onto a ray test — and that is why "Done" only worked
after a Lens reset. `NoteManager` now ray-tests the selected orb's Done button
*before* the orb itself (an orb-first test would always swallow the press, since
the button sits inside the orb's panel), and drives its hover highlight from the
same test so it responds like the picker options do.

`doneClickRadius` is sized to the plate so the button is as easy to hit as it
looks.

**Panels billboard toward the user, yaw only.** An orb is placed once and never
rotates, so its panels would otherwise face whichever way the user happened to
be standing when the note was made.

Two details matter here. The rotation is applied to the **orb root**, not to
each panel: panels keep their fixed local offsets and so the transcript, the orb
and the info row stay on one vertical centre line. Billboarding each panel
separately let them pivot about their own centres and visibly splay apart from
the orb when viewed off-axis. And the rotation is **yaw only** — a full look-at
tips the whole stack when looking from above or below, which is exactly when the
misalignment showed.

## Orb callbacks are registered in one place

`onClicked`, `onDone` and `setBillboardCamera` are wired inside
`instantiateOrb()`, the single function both creation paths use.

They were previously registered at each call site, and `beginRecording()` was
missing two of them — so a freshly recorded note had no Done handler and no
billboard camera, and only started behaving once a Lens reset re-created it
through `restoreNotes()`. That is a whole class of bug that disappears when
there is one place to wire rather than two to keep in sync.

The click target is a sphere of `clickRadius` (3.6 cm) on the orb itself and
`orbClickRadius` (4 cm) for the ray test, both close to the orb's own radius so
the hit area matches what is drawn.

## Due reminders persist until seen

An alert used to clear on a timer, which meant it could come and go while the
user was facing the other way — exactly the case the directional indicator
exists for. An alert and its arrow now stay up until the note has been
continuously in view for `dismissAfterSeenSeconds` (default 1s), verified with
`DirectionalIndicator.isTargetInView()`.

`alertMaxSeconds` (default 120) is a safety valve so a note that can never be
reached cannot pin the HUD forever.

## Empty recordings are discarded

If a recording captures no speech, the orb is destroyed and the flow stops
there — no reminder prompt. Asking "when should I remind you?" about an empty
note wastes the user's time and leaves a blank orb behind whichever way they
answer. A transient HUD message says what happened.

## Reminder prompt

Voice is the primary path and the picker is a genuine fallback: after recording,
the prompt says **"Listening... say a time out loud"** with no buttons visible.
The picker only appears when voice actually fails — nothing recognizable heard,
speech unavailable, an error, or the voice timeout — and it always explains why
it appeared ("Didn't catch that", or the phrase it did hear). Showing seven
buttons up front buried the instruction to speak and made voice entry look like
an afterthought.

## Reminders

Checked only while the Lens is running — the platform offers no background
wake-up. Anything that came due while the Lens was closed is surfaced on the
next launch, most overdue first (`NoteStore.dueNotes()`). Alerts queue rather
than overwrite, so a batch of overdue notes is shown one at a time instead of
collapsing into whichever fired last.

## Testing in the desktop preview

**Click and hold with the mouse.** It is the same gesture as a pinch: SIK's
`MouseInteractor` sets the identical trigger the hand pinch does, so the whole
flow — hold to record, release to settle, pick a reminder — works in the preview
with no device.

This works because `PinchHold` polls SIK's **Interactor** layer (`isTriggering`)
rather than `TrackedHand.onPinchDown`. The hand-tracking events only ever fire
for real hand tracking, which would have made the Lens untestable on desktop.
Anything reading gestures should go through Interactors for the same reason.

A trigger that *starts* on an Interactable (a picker button) is latched out of
the gesture for its whole duration, so pressing a button never also spawns a
note behind it, even if the pointer drifts off the button mid-press.

Two extra aids on `NoteManager`, both off by default:

- **Debug Simulate Capture** — runs a scripted capture on start with a synthetic
  mic envelope. Useful when you want the orb states without driving the mouse.
- **Debug Clear Notes On Start** — wipes stored notes. Turn on once to reset,
  then off again.

`AsrModule` does start a real transcription session in the preview, but with no
preview microphone it cancels — the `AsrTranscriberLancelot` / `CANCELLED` lines
in the log are expected there and are not a wiring fault.

## Recording model

Recording starts **the instant the press begins** — there is no hold delay and no
progress affordance. The threshold is applied at release instead: a press
shorter than `minRecordSeconds` (default 0.6s) is discarded and its orb
destroyed, so a stray click leaves nothing behind.

**The recording ends only when the press is released.** The recognizer emits a
final result after its own silence timeout, which was ending recordings
mid-thought and opening the reminder prompt while the user was still holding.
`SpeechService.start(..., endOnFinal)` controls this: note capture passes
`false`, so a final result banks that segment and immediately restarts
transcription. Pausing for breath mid-sentence now costs nothing, and the banked
segments are concatenated on release. The reminder prompt passes `true`, where a
silence timeout genuinely should end the answer.

This is strictly better than a hold-to-start delay, beyond removing the wait: a
delay clips the first word of whatever the user is already saying, whereas
capturing from frame one and discarding later never loses the front of an
utterance.

## Interaction debug

Enable **HUD > Interaction Debug > Enable Debug Hud**. It prints three rows,
layered from rawest to most processed, so a failure localizes to exactly one
place instead of needing guesswork:

```
Touch:   down=3 move=12 up=3        <- TouchStartEvent bound directly, no SIK
Inputs:  Mouse: on TRIGGER          <- every SIK Interactor and its trigger state
Gesture: pressed 0.45               <- the hold state machine
Hold:    [#########...........] 45%
```

Read it top-down:

- **Touch stays `NONE RECEIVED` while you click** — input is not reaching the
  Lens at all. Nothing in this project can be at fault. Check the Preview
  panel's input mode; Interactive mode also uses mouse drag to navigate the
  simulated environment.
- **Touch increments but no Interactor shows `TRIGGER`** — SIK configuration.
- **An Interactor shows `TRIGGER` but Gesture stays `idle`** — this project's
  code.
- **Gesture says "too short, will discard"** — the press did not last
  `minRecordSeconds`.

It also prints `Notes: placed=N recording=yes|no prompt=open|closed`, which is
how the click-versus-record behaviour was verified: clicking an orb must leave
`placed` unchanged and `recording=no`.

### The microphone row is why the orb was not reacting

`MicRaw` prints the raw provider state — `frames`, `samples`, `rms`, `peak` and
the `gap` since the last delivery. It found the actual fault, which no amount of
tuning would have:

```
MicRaw:  frames=5 samples=196 rms=0.0140    <- audio IS arriving
Mic:     [....................] 0%          <- but the envelope reads zero
```

`AsrModule` holds the microphone while transcribing, and the raw provider is
left starved — measured at roughly **1% of real-time audio** (4 buffers of 828
samples across 6 seconds). Every frame without a new buffer was being treated as
silence, so the envelope collapsed to zero between the sparse bursts.

Two fixes: `micHoldSeconds` holds the last measurement across the gap rather
than reading it as silence, and a second signal — **interim transcript growth**
— drives the orb whenever ASR reports new words, which works regardless of how
little raw audio arrives (`speechPulseSeconds`). Measured after the fix:
`Mic: 53%` during a live recording.

The readout also shows a live **Mic** meter. That row is what separates "the orb
barely reacts" from "the microphone is producing nothing at all" — two very
different problems that look identical from the outside.

## Tuning the orb look

Enable **Orb Debug Panel > Enable Debug Panel** in the scene. A row of six orbs
appears, each locked to one state you would otherwise have to record a real note
to see:

```
Recording  Settled  No reminder  2 weeks(Week)  3 days  1 day(Day)
12 hours  1 hour(Hour)  20 min  Due  Past due
```

Each band boundary and one mid-band sample are present, so the whole palette can
be judged at once instead of waiting for real notes to age into each band. The
row suppresses its countdowns and Done buttons (`setInfoPanelEnabled(false)`) —
eleven of each would be noise, and none refer to a real note.

It re-copies the tuning values off the Orb Template's `NoteOrb` every frame, so
dragging a slider in the Inspector updates all six orbs live, with no restart.
Tune against every state at once, in motion, rather than guessing from one
static orb. The urgency samples re-anchor their synthetic reminder each frame,
so "Halfway" stays halfway instead of drifting toward due while you work.

Row placement is adjustable via `distance`, `spacing`, and `heightOffset`.

This panel immediately earned itself: it exposed that a direct blue→orange lerp
passes through a desaturated grey-pink at the midpoint, so the halfway state
read as *washed out* rather than *getting urgent*. The ramp is now a three-stop
gradient (`farColor` → `midColor` → `dueColor`) which holds saturation across
its whole length.

## Optimization pass

**Packages removed** (~35 MB), none referenced by the scene:

| Package | Size | Why it was there |
|---|---|---|
| `SpectaclesInteractionKitExamples` | 28 MB | shipped alongside SIK; nothing used it |
| `SurfacePlacement` | 5.6 MB | pulled in during exploration |
| `SpectaclesUIKit` | 1.2 MB | present from the template; the UI here is hand-built |
| `SnapDecorators 2`, `Utilities 2` | ~50 KB | duplicate imports of packages already present |

Kept: `SpectaclesInteractionKit` (interactors, Interactable, hand data),
`SpectaclesShaderLibrary` (the orb's rim and glow materials), `SnapDecorators`
and `Utilities` (decorator/runtime infrastructure), `AiPreviewAgentInspect`
(editor tooling, 36 KB).

**Assets removed:**

- `Echopark.hdr` (1.5 MB) — an environment map from the base template. Verified
  unreferenced first: both `diffuseEnvmapTexture` and `specularEnvmapTexture` on
  the Ambient Light and Light are `null`.
- `Hold Progress Bar.mat` — left over from the hold-progress bar deleted when
  recording moved to press-immediately.

`unlit.graphShader` and `Device Camera Texture` were checked and **kept** — the
former backs the `UI Button` and `HUD Arrow` materials.

Verification after removal: clean recompile, clean runtime with no
`Cannot find asset` warnings, notes restored, and hover/selection re-tested in
the preview. Everything removed was backed up first, so the pass is reversible.

**Per-frame allocations removed.** The update loop walked the orb collection
three times a frame (hover, press-test, tick), calling `Object.keys()` each
time — three throwaway arrays per frame, growing with the number of notes.
`getOrbList()` now caches a flat array and rebuilds it only when the collection
actually changes (`orbListDirty`, set on add/commit/delete/clear). The remaining
`Object.keys()` calls are on click and debug paths, not per frame.

**Debug row disabled.** `OrbDebugPanel` was still spawning eleven orbs at launch
and ticking them every frame. The component is kept — it costs nothing while
disabled, since it early-returns in `onAwake` — but `enableDebugPanel` is now
off. Turn it back on to tune the palette.

Not touched: `Cache/` (270 MB) still holds TypeScript sources for the removed
packages. `AGENTS.md` forbids editing it and Lens Studio regenerates it, so it
is safe to delete manually if you want the disk space back; none of it ships in
the Lens.

## Known gaps

- **Cross-session placement accuracy is unverified on hardware.** See above.
  This is the one thing that most needs a real-device check.
- Picker buttons use sphere colliders. `shape.type` is read-only through the
  scene API, so box shapes would need to be set in the Inspector. Radii are sized
  so adjacent buttons do not overlap.
- Prompt panel spacing is tuned for a note placed roughly 60 cm away. Since the
  panel is placed at the pinch, a much closer or further note will read larger or
  smaller; `promptDropDistance` on `NoteManager` and the prompt's own scale are
  the tuning knobs.
- There is no delete affordance in the UI yet. `NoteManager.deleteNote(id)` and
  `clearAllNotes()` exist and work; they just are not bound to anything.
# orb-notes
