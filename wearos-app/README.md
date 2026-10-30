# household-wear

Minimal Wear OS (Kotlin + Compose for Wear) companion app scaffold for
household-app. Targets Wear OS 3+ (Galaxy Watch4 and newer) — this does not
support older Tizen-based Galaxy Watches.

## What's here

- **Ask Household** (voice) — the watch's built-in speech-to-text prompt
  captures a spoken question, sends it to the same `POST /api/assistant/chat`
  endpoint the web UI uses, and speaks the final reply back via
  `TextToSpeech`. Only the terminal `done` SSE event is read; the intermediate
  `delta`/`tool_start`/`tool_end` events are parsed out but discarded — there's
  no good place to render incremental streaming text on a watch face.
- **Today's calendar** — a plain `GET /api/calendar?from=...&to=...` call
  (see [`routes/calendar.ts`](../routes/calendar.ts)), listed as chips.

See [`ApiClient.kt`](app/src/main/java/com/householdapp/wear/ApiClient.kt) and
[`MainActivity.kt`](app/src/main/java/com/householdapp/wear/MainActivity.kt).

## Pairing a watch

The app authenticates with a **device token** (`routes/devices.ts`,
`auth.ts`'s `deviceTokenAuth`) instead of a username and password — a
long-lived, individually revocable credential meant for exactly this kind of
client, sent as `Authorization: Bearer <token>` on every request.

1. On a phone or computer, sign in to household-app in a browser, open the
   account menu → **Devices**, name the device (e.g. "Alex's watch"), and
   generate a token. It's shown once — copy it.
2. On the watch, open Household. On the pairing screen, tap **Set server
   address** and enter the Tailscale URL (`https://your-host.your-tailnet.ts.net`)
   or LAN address, using the watch's own voice/keyboard text-entry prompt.
3. Tap **Enter device token** and enter the token from step 1 the same way.
4. The watch is now paired. Revoking the device later (same Devices screen)
   signs it out immediately — there's no password to change.

A device token reaches everything a normal login can **except** budget and
other financial routes, which stay hard-blocked for a device token
regardless of the household's PIN. See `auth.ts`'s `requireUnlocked` for
where that's enforced.

## What's deliberately NOT here yet

- **No budget/financial quick action.** The app never presents a
  budget-specific button, and financial routes are hard-blocked for any
  device token regardless (see "Pairing a watch" above). Beyond that, a
  spoken question that merely sounds financial (asked through "Ask
  Household") is refused server-side before it reaches a model — see
  `POST /api/assistant/chat` and `assistant/providers/index.ts`'s
  `blocksVoiceFinance` — controlled by the admin-configurable **"Block
  spoken questions about money"** setting (on by default) in AdminSettings'
  Security tab. This still doesn't cover raw audio leaving the *phone's* mic
  during on-device recognition itself (Android's speech recognizer may use a
  cloud model depending on the device/language) — see PLAN.md's Stage 8b for
  the fuller on-device-vs-cloud speech backend design. Its local half shipped
  2026-10-18 for the *browser* (a mic button whose audio is transcribed by
  Whisper on the PC, so spoken money/health questions are allowed there); the
  watch is unchanged and still refused for those, because its audio goes
  through Android's recognizer instead.
- **No Samsung Health / Health Connect integration.** That's a separate,
  larger piece of work — calorie data would flow app → Health Connect on the
  device itself, not through household-app's server, since Samsung Health has
  no public API for third-party servers to write to remotely.
- **No app icons, no Tile/complication.** Launcher-icon-only scaffold; add a
  Tile once the core screens are validated on a real watch.

## Building

Requires Android Studio (or the command-line SDK) with the Wear OS system
image for testing. From this directory:

```
./gradlew assembleDebug
```

Then either run it in a Wear OS emulator, or side-load onto a real Galaxy
Watch with ADB over Wi-Fi (`adb connect <watch-ip>:5555`, then
`adb install app/build/outputs/apk/debug/app-debug.apk`).

See "Pairing a watch" above for how to connect it to a real server once it's
running.
