# Lucid Type

A local‑first dictation app for macOS and Windows. Hold a hotkey, talk, and your
words land in whatever app you were using — transcribed on‑device with
[whisper.cpp](https://github.com/ggerganov/whisper.cpp), with an optional local
LLM polish pass. No account, no cloud, no audio ever leaves your machine.

Lucid Type lives in the menu bar / system tray. While you dictate it shows a
small floating pill with a live waveform; the rest of the time it stays out of
the way.

## Features

- **On‑device transcription** — whisper.cpp with the bundled `ggml-base.en`
  model. Works offline.
- **Two trigger modes** — *toggle* (tap to start, tap to stop) or *push‑to‑talk*
  (hold the key, release to transcribe).
- **Auto‑paste** — the transcript is typed into the focused app the moment you
  finish, then your previous clipboard contents are restored.
- **Optional AI polish** — routes the raw transcript through a locally‑running
  [Ollama](https://ollama.com) model (`llama3.2:1b`) to resolve mid‑sentence
  self‑corrections, add punctuation, and match the tone of the target app
  (chat vs. email vs. code). Falls back to the built‑in cleaner if Ollama isn't
  running.
- **Transcript cleanup** — strips filler words (“um”, “uh”, “like”, “you know”),
  removes non‑verbal artefacts (“\[coughing]”), and drops the phrases whisper
  tends to hallucinate over silence (“thanks for watching”).
- **Silence gate** — near‑silent takes are discarded instead of transcribed.
- **Customisable** — global hotkey, trigger mode, accent colour, start/stop
  chime.

## How it works

```
hotkey ─▶ record (16 kHz mono, Web Audio)
       ─▶ silence gate
       ─▶ whisper.cpp  ──▶ regex cleanup ──┬─▶ (optional) Ollama polish
                                           │
       auto‑paste into the focused app ◀───┴─  clipboard fallback
```

## Install

Grab the latest build from the
[Releases page](https://github.com/V0idyy-0/Lucid.Type/releases):

| Platform | File |
| --- | --- |
| macOS (Apple Silicon) | `Lucid-Type-<version>-mac-arm64.dmg` |
| Windows (x64) | `Lucid-Type-<version>-win-x64.exe` |
| Windows (ARM64) | `Lucid-Type-<version>-win-arm64.exe` |

> **Note:** builds are **ad‑hoc signed, not notarized**.
>
> - **macOS:** the first launch is blocked by Gatekeeper. Right‑click the app →
>   *Open* → *Open*, or allow it under *System Settings → Privacy & Security*.
>   If macOS still calls it *"damaged"*, clear the download quarantine:
>   `xattr -dr com.apple.quarantine "/Applications/Lucid Type.app"`
> - **Windows:** SmartScreen shows a warning — *More info → Run anyway*.

### Prerequisites

- **whisper.cpp CLI** on your `PATH` (or set `WHISPER_CLI` to its full path).
  Lucid Type looks for `whisper-cli` / `whisper-cpp`, including the common
  Homebrew locations.
  - macOS: `brew install whisper-cpp`
  - Windows / Linux: build from
    [whisper.cpp](https://github.com/ggerganov/whisper.cpp) and put `whisper-cli`
    on your `PATH`.
- **Ollama** — only if you turn on *AI Text Polish*. Run
  `ollama pull llama3.2:1b` and keep `ollama serve` running on
  `localhost:11434`.

### Permissions

- **Microphone** — required.
- **Accessibility / Input Monitoring** (macOS) — required for push‑to‑talk and
  for auto‑paste. Grant it in *System Settings → Privacy & Security* when
  prompted.

## Usage

- Press the hotkey (**`Alt`+`Space`** by default) to start/stop dictation, or
  hold it in push‑to‑talk mode.
- Open **Settings** from the tray menu (or `⌘,` / `Ctrl+,`).
- Quit from the tray menu (or `⌘Q` / `Ctrl+Q`). Closing the windows leaves it
  running in the tray.

### Settings

| Setting | Default | What it does |
| --- | --- | --- |
| Trigger mode | Toggle | Toggle (press to start/stop) or Push‑to‑Talk (hold to record) |
| Hotkey | `Alt+Space` | Global shortcut; must include a modifier or be a function key |
| Auto‑paste transcript | On | Paste into the focused app as soon as dictation ends |
| Strip filler words | On | Remove “um”, “uh”, “like”, “you know” |
| AI Text Polish | Off | Clean up wording with a local Ollama model before pasting |
| Accent colour | `#3b82f6` | Colour of the pill's wave bars and glow |
| Sound effects | On | Soft chime on start and stop |

## Development

Requires **Node 20+**.

```bash
npm install          # also fetches the whisper model (~142 MB) on first run
npm run electron:dev # Vite dev server + Electron with hot reload
```

Other scripts:

| Script | Purpose |
| --- | --- |
| `npm run dev` | Vite dev server only (renderer in a browser, no Electron APIs) |
| `npm run build` | Type‑check + build the renderer |
| `npm run build:electron` | Compile the Electron main/preload TypeScript |
| `npm run electron:start` | Production build, then run in Electron |
| `npm run dist` | Package installers into `dist-release/` via electron‑builder |
| `npm run fetch:model` | Download `ggml-base.en.bin` if missing |
| `npm run lint` | oxlint |

### Project layout

```
electron/
  main.ts              main process — windows, tray, hotkeys, whisper + Ollama
  preload.cts          contextBridge API exposed to the renderer
  settings-schema.ts   settings shape + defaults (persisted with electron-store)
src/
  App.tsx              the floating pill: recording, waveform, transcription
  components/
    SettingsModal.tsx  the Settings window
  utils/
    shortcutValidator.ts  hotkey validation + per‑OS blocklists
scripts/
  fetch-model.mjs      idempotent whisper model download (postinstall / predist)
```

### Packaging

`npm run dist` builds for the host platform. CI (`.github/workflows/build.yml`)
builds macOS on `macos-latest`, Windows x64 on `windows-latest`, and Windows
ARM64 natively on `windows-11-arm`; pushing a `v*` tag publishes a GitHub
Release with all the installers attached.

The `ggml-base.en.bin` model is not committed to git — it is fetched by
`scripts/fetch-model.mjs` (via `postinstall`) and bundled into packaged builds.

## Tech

Electron · React 19 · Vite · TypeScript · Tailwind CSS v4 ·
[`electron-store`](https://github.com/sindresorhus/electron-store) ·
[`uiohook-napi`](https://github.com/SnosMe/uiohook-napi) (push‑to‑talk key hook) ·
[`active-win`](https://github.com/sindresorhus/active-win) (frontmost‑app
detection for polish formatting).

## Privacy

Audio is recorded to a temporary 16 kHz WAV, transcribed by a local whisper.cpp
process, and deleted immediately after. If AI polish is enabled the transcript
text is sent to your own local Ollama instance. Nothing is sent to any remote
server.
