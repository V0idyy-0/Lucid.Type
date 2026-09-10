import { exec, execFile } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { createWriteStream, existsSync } from 'node:fs'
import { mkdir, mkdtemp, readFile, rename, rm, stat, unlink, writeFile } from 'node:fs/promises'
import { availableParallelism, tmpdir } from 'node:os'
import path from 'node:path'
import { Readable, Transform } from 'node:stream'
import type { ReadableStream as WebReadableStream } from 'node:stream/web'
import { pipeline } from 'node:stream/promises'
import { promisify } from 'node:util'
import { fileURLToPath } from 'node:url'
import {
  app,
  BrowserWindow,
  clipboard,
  globalShortcut,
  ipcMain,
  Menu,
  nativeImage,
  Notification,
  session,
  shell,
  systemPreferences,
  Tray,
} from 'electron'
import activeWin from 'active-win'
import Store from 'electron-store'
import { uIOhook, UiohookKey, type UiohookKeyboardEvent } from 'uiohook-napi'
import {
  DEFAULT_SETTINGS,
  sanitizeSettings,
  type ModelId,
  type Replacement,
  type Settings,
} from './settings-schema.js'
import { MODELS, MODEL_LIST } from './models.js'
import { checkForUpdate } from './updates.js'
import type {
  HistoryEntry,
  MicrophoneAccessStatus,
  ModelDownloadProgress,
  ModelStatus,
  PermissionStatus,
  PolishOutcome,
  TranscribeResult,
  UpdateCheckResult,
} from './ipc.js'

const execFileAsync = promisify(execFile)

/**
 * Tidy a raw whisper transcript: optionally drop common filler words and
 * phrases ("um", "uh", "like", "you know", plus runs like "ummm"), then heal the
 * spacing and punctuation that removal leaves behind and trim the ends.
 */
function cleanTranscript(raw: string, stripFillerWords: boolean): string {
  const deFilled = stripFillerWords
    ? raw.replace(/\b(?:um+|uh+|like|you know)\b/gi, '')
    : raw
  return deFilled
    .replace(/\s+([,.!?;:])/g, '$1') // no space before punctuation
    .replace(/([,;:])(?:\s*[,;:])+/g, '$1') // "…, , …" -> "…,"
    .replace(/([.!?])[,;:]+/g, '$1') // ".," -> "."
    .replace(/[,;:]+([.!?])/g, '$1') // ",." -> "."
    .replace(/\s{2,}/g, ' ') // collapse runs of whitespace
    .replace(/^[\s,;:.!?]+/, '') // no leading punctuation/space
    .trim()
}

/** Escape a string for use as a literal inside a RegExp. */
function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/**
 * Apply the user's literal find/replace rules to a finished transcript. Matches
 * are case-insensitive and — for single-word `from` terms — bounded to whole
 * words so "cat" doesn't rewrite "category". When the matched text was
 * capitalised (e.g. sentence-initial) the replacement's first letter is
 * capitalised to match.
 */
function applyReplacements(text: string, rules: Replacement[]): string {
  let out = text
  for (const { from, to } of rules) {
    if (!from) continue
    const boundary = /^\w[\w'-]*$/.test(from) ? '\\b' : ''
    const re = new RegExp(`${boundary}${escapeRegExp(from)}${boundary}`, 'gi')
    out = out.replace(re, (match) => {
      if (!to) return ''
      const wasCapitalised = /^[A-Z]/.test(match) && /^[a-z]/.test(to)
      return wasCapitalised ? to[0].toUpperCase() + to.slice(1) : to
    })
  }
  return out
}

/**
 * Strip non-verbal speech artefacts from a raw whisper transcript: bracketed,
 * parenthesised, or asterisked stage directions ("[coughing]", "(clears
 * throat)", "*cough*") plus the bare non-speech words whisper emits for coughs,
 * sniffs, sighs, and laughter. Heals the whitespace the removal leaves behind
 * and trims. A take that was *only* throat-clearing or noise comes back as "".
 */
function sanitizeTranscript(text: string): string {
  return text
    .replace(/[([*][^)\]*]*[)\]*]/g, '')
    .replace(
      /\b(clears? throat|throat clearing|coughing|coughs?|sniffing|sighs?|laughter|gasping)\b/gi,
      '',
    )
    .replace(/\s{2,}/g, ' ')
    .trim()
}

/** Hard ceiling on transcript length before it reaches the clipboard or a
 *  synthetic paste. No real dictation take comes close; this just bounds a
 *  pathological whisper-cli or Ollama response. */
const MAX_TRANSCRIPT_CHARS = 100_000

/** ESC + "[" … CSI escape sequence, built without a literal control byte in
 *  the source so the regex stays lint-clean. */
const CSI_SEQUENCE = new RegExp(`${String.fromCharCode(27)}\\[[0-9;:?]*[ -/]*[@-~]`, 'g')

/**
 * Strip everything from a transcript that has no business surviving a trip to
 * the clipboard or a synthetic paste into the user's editor or terminal:
 *
 *  - ANSI / VT (CSI) escape sequences,
 *  - NUL and every other C0/C1 control byte (tab and newline are kept; CR and
 *    CRLF are normalised to "\n"),
 *  - zero-width, BOM, and Unicode bidirectional-control characters,
 *  - the Unicode line/paragraph separators (U+2028 / U+2029 → newline).
 *
 * The result is clamped to {@link MAX_TRANSCRIPT_CHARS}. whisper-cli and a
 * local Ollama both *should* only ever emit plain prose — this is the guard
 * that doesn't rely on it.
 */
function scrubText(text: string): string {
  const normalized = text.normalize('NFC').replace(/\r\n?/g, '\n').replace(CSI_SEQUENCE, '')

  let out = ''
  for (const ch of normalized) {
    if (out.length >= MAX_TRANSCRIPT_CHARS) break
    const c = ch.codePointAt(0) as number

    if (c === 0x09 || c === 0x0a) {
      out += ch // keep tab and newline
    } else if (c < 0x20 || (c >= 0x7f && c <= 0x9f)) {
      // drop C0 / C1 control characters
    } else if (c === 0x2028 || c === 0x2029) {
      out += '\n' // Unicode line / paragraph separator
    } else if (
      c === 0xfeff ||
      (c >= 0x200b && c <= 0x200f) || // zero-width + LTR/RTL marks
      (c >= 0x202a && c <= 0x202e) || // bidi embeddings / overrides
      (c >= 0x2060 && c <= 0x2064) || // word joiner + invisible operators
      (c >= 0x2066 && c <= 0x206f) // bidi isolates + deprecated format chars
    ) {
      // drop zero-width / BOM / bidirectional-control characters
    } else {
      out += ch
    }
  }
  return out
}

/** Local Ollama endpoint used for the optional "AI Text Polish" pass. */
const OLLAMA_URL = 'http://localhost:11434/api/generate'
const OLLAMA_MODEL = 'llama3.2:1b'
/** How long to wait on Ollama before giving up and using the regex cleaner. */
const OLLAMA_TIMEOUT_MS = 1500

/**
 * The editing contract handed to Ollama on every polish pass. Kept terse — a 1B
 * model follows a short bulleted rule set far more reliably than prose.
 */
const POLISH_SYSTEM_PROMPT = [
  'You are a dictation editor. You receive a raw speech-to-text transcript and',
  'return a cleaned-up version of exactly that text. Follow these rules:',
  '- Smart self-correction: when the speaker corrects themselves mid-sentence,',
  '  keep only the corrected version and drop the retraction. Example:',
  '  "let\'s meet Monday, actually Tuesday at 3" -> "Let\'s meet on Tuesday at 3".',
  '- Remove filler words and false starts such as "um", "uh", "like", "you know".',
  '- Automatic punctuation: add natural capitalization, commas, question marks,',
  '  and a terminating period so the result reads as well-formed sentences.',
  '- Never add, drop, or reinterpret meaning beyond the speaker\'s own corrections.',
  '- Strict output: reply with ONLY the final polished text. No preamble, no',
  '  commentary, no explanation, no surrounding quotation marks.',
].join('\n')

/**
 * Per-destination formatting guidance appended to the polish prompt. `appName` is
 * the best-effort frontmost-application name (see {@link detectFrontmostApp});
 * an unknown or missing app falls back to plain prose.
 */
function formattingGuidance(appName?: string): string {
  const app = (appName ?? '').toLowerCase()
  const matches = (...needles: string[]) => needles.some((n) => app.includes(n))

  if (matches('slack', 'discord')) {
    return 'The text is a chat message: keep it to concise sentences or short bullet points.'
  }
  if (matches('mail', 'outlook')) {
    return 'The text is an email: use professional grammar and structure it into clear paragraphs.'
  }
  if (matches('code', 'cursor', 'terminal', 'iterm')) {
    return (
      'The text is going into a code editor or terminal: preserve code syntax, ' +
      'backtick spans, file paths, and technical acronyms exactly as spoken.'
    )
  }
  return 'Write standard, natural prose.'
}

/**
 * Ask a locally-running Ollama (llama3.2:1b) to polish the raw whisper
 * transcript: resolve mid-sentence self-corrections, strip filler words, and add
 * natural punctuation. `activeAppName` — the app the transcript is about to land
 * in — tunes the output formatting. Entirely best-effort: if Ollama isn't
 * running, is slow, or returns something unusable we abort after 1.5s and return
 * null so the caller falls back to {@link cleanTranscript}.
 */
async function polishTranscript(raw: string, activeAppName?: string): Promise<string | null> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), OLLAMA_TIMEOUT_MS)
  try {
    const res = await fetch(OLLAMA_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: OLLAMA_MODEL,
        stream: false,
        system: POLISH_SYSTEM_PROMPT,
        prompt: `${formattingGuidance(activeAppName)}\n\nTranscript:\n${raw}`,
      }),
      signal: controller.signal,
    })
    if (!res.ok) return null
    const data = (await res.json()) as { response?: unknown }
    // Don't trust the local model's output shape: scrub control/format
    // characters and clamp the length before it re-enters the pipeline.
    const polished = typeof data.response === 'string' ? scrubText(data.response).trim() : ''
    return polished || null
  } catch {
    // Ollama not running, aborted by the timeout, or a malformed response.
    return null
  } finally {
    clearTimeout(timer)
  }
}

/** Give up on the active-window lookup after this long — it must never delay
 *  the transcript reaching the clipboard. */
const ACTIVE_WIN_TIMEOUT_MS = 200

/**
 * Best-effort name of the app the transcript is about to land in, used only to
 * tune the AI polish formatting (see {@link formattingGuidance}). Queries
 * `active-win` for the frontmost window's owner — e.g. "Slack", "Visual Studio
 * Code", "Mail" — and resolves to undefined whenever the lookup fails, is
 * unsupported, lacks permission, or takes longer than
 * {@link ACTIVE_WIN_TIMEOUT_MS}, in which case the polish pass uses plain prose.
 */
async function detectActiveApp(): Promise<string | undefined> {
  const timeout = new Promise<undefined>((resolve) =>
    setTimeout(() => resolve(undefined), ACTIVE_WIN_TIMEOUT_MS),
  )
  // Swallow a rejection that arrives after the timeout has already won the race,
  // so it never surfaces as an unhandled rejection.
  const lookup = activeWin().catch((err: unknown) => {
    console.warn(`active-win lookup failed: ${(err as Error).message}`)
    return undefined
  })
  const win = await Promise.race([lookup, timeout])
  if (win) {
    console.log(`Active window: "${win.title}" — ${win.owner.name}`)
    return win.owner.name || undefined
  }
  return undefined
}

/** Phrases whisper.cpp routinely invents for near-silent or music-only audio —
 *  YouTube-style sign-offs baked into its training data. A transcript that is
 *  nothing but one of these is treated as empty. */
const HALLUCINATION_LINES = new Set([
  'thank you',
  'thank you.',
  'thank you very much',
  'thank you very much.',
  'thanks for watching',
  'thanks for watching.',
  'thanks for watching!',
  'thank you for watching',
  'thank you for watching.',
  'please subscribe',
  'like and subscribe',
  'you',
  'you.',
  'bye',
  'bye.',
])

/** Whole-transcript prefixes that mark a hallucinated credit line. */
const HALLUCINATION_PREFIXES = ['subtitles by', 'transcription by', 'transcript by']

/**
 * Drop a transcript that is only a known whisper hallucination, returning the
 * empty string in its place; pass anything real straight through.
 */
function dropHallucinations(text: string): string {
  const normalized = text.trim().toLowerCase()
  if (!normalized) return ''
  if (
    HALLUCINATION_LINES.has(normalized) ||
    HALLUCINATION_PREFIXES.some((prefix) => normalized.startsWith(prefix))
  ) {
    return ''
  }
  return text
}

/**
 * Simulate the platform's paste shortcut so the freshly-transcribed text drops
 * straight into whatever app the user was in. Branches per OS — AppleScript on
 * macOS (Cmd+V), PowerShell SendKeys on Windows (Ctrl+V). A failure here is
 * non-fatal; other platforms just fall back to the clipboard copy.
 *
 * The user's existing clipboard contents are stashed first, the transcript is
 * placed only long enough for the synthetic paste to consume it, and then the
 * original contents are restored — dictation never silently clobbers whatever
 * the user had copied.
 */
async function triggerSystemPaste(text: string): Promise<void> {
  const previousText = await clipboard.readText()
  await clipboard.writeText(text)

  const restoreClipboard = () => {
    setTimeout(() => void clipboard.writeText(previousText), 150)
  }

  const onError = (err: Error | null) => {
    if (err) console.warn(`Auto-paste failed: ${err.message}`)
    restoreClipboard()
  }

  if (process.platform === 'darwin') {
    exec(
      `osascript -e 'tell application "System Events" to keystroke "v" using command down'`,
      onError,
    )
  } else if (process.platform === 'win32') {
    exec(
      'powershell -NoProfile -Command "Add-Type -AssemblyName System.Windows.Forms; ' +
        "[System.Windows.Forms.SendKeys]::SendWait('^v')\"",
      onError,
    )
  } else {
    // Nothing was pasted, so leave the transcript on the clipboard rather than
    // restoring the previous contents.
    console.warn(`Auto-paste is not supported on ${process.platform}; transcript left on the clipboard.`)
  }
}

const __dirname = path.dirname(fileURLToPath(import.meta.url))

/** App icon for the BrowserWindows. Present in dev and when running from an
 *  unpacked build; in a packaged app the window icon comes from the .app
 *  bundle / .exe resources electron-builder stamps from `build.*.icon`, and a
 *  missing path here is simply ignored. */
const APP_ICON = path.join(__dirname, '../build/icon.png')

const DEV_SERVER_URL = process.env.VITE_DEV_SERVER_URL

/** Project root — the directory that holds `bin/`, `package.json`, `dist/`. */
const APP_ROOT = app.getAppPath()

/** Platform-specific name of the whisper.cpp CLI executable. */
const WHISPER_BIN = process.platform === 'win32' ? 'whisper-cli.exe' : 'whisper-cli'

/** Roots that may hold a bundled `bin/` — the project root in dev, and the
 *  packaged resources dir (incl. the unpacked-from-asar copy) in production. */
const BIN_ROOTS = [
  APP_ROOT,
  process.resourcesPath,
  process.resourcesPath && path.join(process.resourcesPath, 'app.asar.unpacked'),
].filter((r): r is string => Boolean(r))

/** Locate a file named `name` under any `<root>/<...segments>` we know about,
 *  falling back to the bare name (resolved via PATH at spawn time). */
function resolveBundled(name: string, ...segments: string[]): string {
  const candidates = BIN_ROOTS.map((root) => path.join(root, ...segments, name))
  return candidates.find((c) => existsSync(c)) ?? name
}

/** Where on-demand model downloads are written — a writable dir that survives
 *  app updates, unlike the packaged resources folder. */
const USER_MODELS_DIR = path.join(app.getPath('userData'), 'models')

/** Absolute path to a model's file: a user-downloaded copy wins over a bundled
 *  one; falls back to the bare bundled name when neither exists. */
function modelFilePath(id: ModelId): string {
  const userCopy = path.join(USER_MODELS_DIR, MODELS[id].file)
  if (existsSync(userCopy)) return userCopy
  return resolveBundled(MODELS[id].file, 'bin', 'models')
}

/** Whether a model's file is present locally (bundled or downloaded). */
function isModelDownloaded(id: ModelId): boolean {
  if (existsSync(path.join(USER_MODELS_DIR, MODELS[id].file))) return true
  return BIN_ROOTS.some((root) => existsSync(path.join(root, 'bin', 'models', MODELS[id].file)))
}

/** Resolve the whisper.cpp CLI. Honour an explicit override, then a binary
 *  bundled under `bin/`, then the usual per-OS install locations, then a bare
 *  name found on PATH. */
function resolveWhisperCli(): string {
  const installLocations =
    process.platform === 'darwin'
      ? ['/opt/homebrew/bin/whisper-cli', '/usr/local/bin/whisper-cli', '/opt/homebrew/bin/whisper-cpp']
      : process.platform === 'linux'
        ? ['/usr/local/bin/whisper-cli', '/usr/bin/whisper-cli']
        : []

  const candidates = [
    process.env.WHISPER_CLI,
    ...BIN_ROOTS.map((root) => path.join(root, 'bin', WHISPER_BIN)),
    ...installLocations,
  ].filter((c): c is string => Boolean(c))

  for (const candidate of candidates) {
    if (existsSync(candidate)) return candidate
  }
  return WHISPER_BIN
}

const WHISPER_CLI = resolveWhisperCli()

/** Frameless floating overlay dimensions. */
const OVERLAY_WIDTH = 360
const OVERLAY_HEIGHT = 70

let win: BrowserWindow | null = null
let settingsWin: BrowserWindow | null = null
let onboardingWin: BrowserWindow | null = null
let historyWin: BrowserWindow | null = null
let aboutWin: BrowserWindow | null = null
let tray: Tray | null = null
let store: Store<Settings>
/** First-run onboarding completion flag, kept in its own tiny store so it
 *  never gets tangled up with the user-facing {@link Settings}. */
let onboardingStore: Store<{ completed: boolean }>
/** Local dictation-history log, gated behind the `saveHistory` setting. */
let historyStore: Store<{ entries: HistoryEntry[] }>

/** Last-seen "auto-paste was blocked by missing Accessibility" state, so the
 *  tray only rebuilds its fix-it item when the situation actually changes. */
let lastAutoPasteBlocked = false

/** True while a temporary global Esc shortcut is registered for cancelling the
 *  in-progress take. */
let cancelShortcutOn = false

/** Last update check result, surfaced to the About window and the tray. */
let lastUpdateResult: UpdateCheckResult | null = null
/** The version we've already shown a "new release" notification for this
 *  session, so a background re-check doesn't nag again. */
let notifiedVersion: string | null = null

/** The accelerator we actually managed to register (may differ from the
 *  requested one if it was invalid or already claimed by another app). */
let activeHotkey: string | null = null

/** Push-to-talk state: the parsed hotkey we're watching for via the raw
 *  keyboard hook, the modifier keycodes that also end a take, whether the key
 *  is currently held (also used to swallow OS auto-repeat), and whether the
 *  uiohook listener thread is running. */
let pttMatcher: HotkeyMatcher | null = null
let pttModifierKeycodes = new Set<number>()
let pttKeyHeld = false
let uiohookRunning = false

/** Live settings, or the defaults if the store hasn't been created yet. */
function settings(): Settings {
  return store ? store.store : DEFAULT_SETTINGS
}

function createWindow() {
  win = new BrowserWindow({
    width: OVERLAY_WIDTH,
    height: OVERLAY_HEIGHT,
    title: 'Lucid Type',
    icon: APP_ICON,
    show: false,
    frame: false,
    transparent: true,
    hasShadow: false,
    resizable: false,
    maximizable: false,
    fullscreenable: false,
    skipTaskbar: true,
    alwaysOnTop: true,
    // Never let the pill become the active app. A non-focusable macOS panel
    // keeps whatever the user was typing in frontmost, so the synthetic paste
    // fired after transcription lands in that app — not in the pill.
    focusable: false,
    type: 'panel',
    webPreferences: {
      // Compiled from `preload.cts` → CommonJS. A sandboxed renderer cannot
      // load an ESM preload, and this package is `"type": "module"`, so the
      // `.cjs` extension is what keeps `window.whisperFlow` defined.
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      // The pill lives in a window that is hidden whenever dictation is idle.
      // Keep the renderer running full-speed while hidden so audio capture
      // isn't throttled mid-recording.
      backgroundThrottling: false,
    },
  })

  win.setAlwaysOnTop(true, 'screen-saver')
  win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true })

  if (DEV_SERVER_URL) {
    void win.loadURL(DEV_SERVER_URL)
  } else {
    void win.loadFile(path.join(APP_ROOT, 'dist', 'index.html'))
  }

  // The window starts hidden and is only revealed once the renderer reports
  // that the pill is on screen (i.e. recording has started) — see the
  // `whisper:pill-visible` handler below.

  // Open external links in the user's browser, never inside the pill.
  win.webContents.setWindowOpenHandler(({ url }) => {
    void shell.openExternal(url)
    return { action: 'deny' }
  })
}

/**
 * Alt+Space handler. Just tells the renderer to flip its recording state so
 * the same key starts and stops dictation. Window visibility is driven by the
 * renderer via `whisper:pill-visible` — the pill is on screen exactly while
 * recording, never otherwise.
 */
function toggleOverlay() {
  if (!win) {
    createWindow()
    return
  }

  win.webContents.send('whisper:toggle')
}

// ── Settings · global hotkey · tray ──────────────────────────────────────────

// ── Push-to-talk: matching a stored accelerator against raw keyboard events ───

/** A parsed accelerator: the physical key plus the modifier state it requires. */
interface HotkeyMatcher {
  keycode: number
  ctrl: boolean
  alt: boolean
  shift: boolean
  meta: boolean
}

const UIOHOOK_KEYS = UiohookKey as Record<string, number>

/** Named (non-alphanumeric) accelerator tokens → uiohook keycodes. The token
 *  spellings match what the Settings capture UI produces (`keyName`). */
const NAMED_KEYCODES: Record<string, number> = {
  Space: UiohookKey.Space,
  Return: UiohookKey.Enter,
  Enter: UiohookKey.Enter,
  Tab: UiohookKey.Tab,
  Backspace: UiohookKey.Backspace,
  Delete: UiohookKey.Delete,
  Escape: UiohookKey.Escape,
  Up: UiohookKey.ArrowUp,
  Down: UiohookKey.ArrowDown,
  Left: UiohookKey.ArrowLeft,
  Right: UiohookKey.ArrowRight,
  Home: UiohookKey.Home,
  End: UiohookKey.End,
  PageUp: UiohookKey.PageUp,
  PageDown: UiohookKey.PageDown,
  '-': UiohookKey.Minus,
  '=': UiohookKey.Equal,
  '[': UiohookKey.BracketLeft,
  ']': UiohookKey.BracketRight,
  ';': UiohookKey.Semicolon,
  "'": UiohookKey.Quote,
  ',': UiohookKey.Comma,
  '.': UiohookKey.Period,
  '/': UiohookKey.Slash,
  '`': UiohookKey.Backquote,
  '\\': UiohookKey.Backslash,
}

/** Resolve a single accelerator key token to a uiohook keycode, or null. */
function tokenKeycode(token: string): number | null {
  if (token in NAMED_KEYCODES) return NAMED_KEYCODES[token]
  if (/^[A-Za-z]$/.test(token)) return UIOHOOK_KEYS[token.toUpperCase()] ?? null
  if (/^[0-9]$/.test(token)) return UIOHOOK_KEYS[token] ?? null
  if (/^F([1-9]|1\d|2[0-4])$/.test(token)) return UIOHOOK_KEYS[token] ?? null
  if (/^num[0-9]$/.test(token)) return UIOHOOK_KEYS[`Numpad${token.slice(3)}`] ?? null
  return null
}

/**
 * Parse an Electron accelerator ("Alt+Space", "CommandOrControl+Shift+D") into a
 * {@link HotkeyMatcher}, resolving "CommandOrControl" to ⌘ on macOS and Ctrl
 * elsewhere. Returns null when the final key token isn't one we can match.
 */
function parseAccelerator(accelerator: string): HotkeyMatcher | null {
  const parts = accelerator
    .split('+')
    .map((p) => p.trim())
    .filter(Boolean)
  if (parts.length === 0) return null

  const keycode = tokenKeycode(parts[parts.length - 1])
  if (keycode == null) return null

  const mac = process.platform === 'darwin'
  const matcher: HotkeyMatcher = { keycode, ctrl: false, alt: false, shift: false, meta: false }

  for (const mod of parts.slice(0, -1).map((m) => m.toLowerCase())) {
    if (mod === 'commandorcontrol' || mod === 'cmdorctrl') {
      if (mac) matcher.meta = true
      else matcher.ctrl = true
    } else if (mod === 'command' || mod === 'cmd' || mod === 'super' || mod === 'meta') {
      matcher.meta = true
    } else if (mod === 'control' || mod === 'ctrl') {
      matcher.ctrl = true
    } else if (mod === 'alt' || mod === 'option' || mod === 'altgr') {
      matcher.alt = true
    } else if (mod === 'shift') {
      matcher.shift = true
    }
  }
  return matcher
}

/** uiohook keycodes for whichever modifiers a matcher needs (left + right) — a
 *  keyup on any of these also ends a push-to-talk take, so lifting the modifier
 *  before the main key still stops recording. */
function modifierKeycodes(m: HotkeyMatcher): Set<number> {
  const codes = new Set<number>()
  if (m.ctrl) codes.add(UiohookKey.Ctrl).add(UiohookKey.CtrlRight)
  if (m.alt) codes.add(UiohookKey.Alt).add(UiohookKey.AltRight)
  if (m.shift) codes.add(UiohookKey.Shift).add(UiohookKey.ShiftRight)
  if (m.meta) codes.add(UiohookKey.Meta).add(UiohookKey.MetaRight)
  return codes
}

/** True when a raw keyboard event is exactly the hotkey combo. */
function eventMatchesHotkey(m: HotkeyMatcher, e: UiohookKeyboardEvent): boolean {
  return (
    e.keycode === m.keycode &&
    e.ctrlKey === m.ctrl &&
    e.altKey === m.alt &&
    e.shiftKey === m.shift &&
    e.metaKey === m.meta
  )
}

/** Hotkey pressed: reveal the pill and tell the renderer to start capturing.
 *  The `pttKeyHeld` guard in the caller means OS key-repeat can't re-trigger. */
function beginPushToTalk(): void {
  if (!win) {
    createWindow()
    return
  }
  win.webContents.send('whisper:record-start')
}

/** Hotkey released: the renderer stops capture, then runs transcription +
 *  optional Ollama polish and auto-pastes into the still-frontmost app. */
function endPushToTalk(): void {
  win?.webContents.send('whisper:record-stop')
}

function onPushToTalkKeydown(e: UiohookKeyboardEvent): void {
  if (pttKeyHeld || !pttMatcher) return
  if (!eventMatchesHotkey(pttMatcher, e)) return
  pttKeyHeld = true
  beginPushToTalk()
}

function onPushToTalkKeyup(e: UiohookKeyboardEvent): void {
  if (!pttKeyHeld || !pttMatcher) return
  if (e.keycode !== pttMatcher.keycode && !pttModifierKeycodes.has(e.keycode)) return
  pttKeyHeld = false
  endPushToTalk()
}

/** Start (or reconfigure) the raw keyboard hook for push-to-talk. */
function enablePushToTalk(accelerator: string): void {
  const matcher = parseAccelerator(accelerator)
  if (!matcher) {
    console.warn(`Push-to-talk: can't match hotkey "${accelerator}"; dictation hotkey is disabled.`)
    disablePushToTalk()
    return
  }

  pttMatcher = matcher
  pttModifierKeycodes = modifierKeycodes(matcher)
  pttKeyHeld = false

  uIOhook.removeListener('keydown', onPushToTalkKeydown)
  uIOhook.removeListener('keyup', onPushToTalkKeyup)
  uIOhook.on('keydown', onPushToTalkKeydown)
  uIOhook.on('keyup', onPushToTalkKeyup)

  if (!uiohookRunning) {
    try {
      // First call prompts for Accessibility / Input Monitoring permission on
      // macOS; the hook stays inert until it's granted.
      uIOhook.start()
      uiohookRunning = true
    } catch (err) {
      console.warn(`Push-to-talk: couldn't start the keyboard hook: ${(err as Error).message}`)
    }
  }
  activeHotkey = accelerator
}

/** Tear down the push-to-talk keyboard hook. */
function disablePushToTalk(): void {
  pttMatcher = null
  pttKeyHeld = false
  pttModifierKeycodes = new Set()
  uIOhook.removeListener('keydown', onPushToTalkKeydown)
  uIOhook.removeListener('keyup', onPushToTalkKeyup)
  if (uiohookRunning) {
    try {
      uIOhook.stop()
    } catch {
      // Already stopped, or never really started.
    }
    uiohookRunning = false
  }
}

/**
 * (Re-)bind the global dictation hotkey to whichever trigger mode is active.
 *
 * - `toggle` — `globalShortcut` registers the accelerator (which the focused app
 *   never sees); a tap flips the renderer's recording state. Falls back to the
 *   default accelerator if the requested one is malformed or already claimed.
 * - `ptt` — a raw `uiohook` keyboard hook watches for the combo's keydown/keyup
 *   so the key can be *held*. Unlike `globalShortcut`, the combo is NOT swallowed
 *   from the focused app, so an unobtrusive hotkey works best here.
 *
 * Whatever was bound before is torn down first so a mode or hotkey edit never
 * leaves a stale binding live.
 */
function registerHotkey(): void {
  globalShortcut.unregisterAll()
  activeHotkey = null

  const wanted = settings().hotkey.trim() || DEFAULT_SETTINGS.hotkey

  if (settings().dictationMode === 'ptt') {
    enablePushToTalk(wanted)
    return
  }

  disablePushToTalk()

  const candidates =
    wanted === DEFAULT_SETTINGS.hotkey ? [wanted] : [wanted, DEFAULT_SETTINGS.hotkey]

  for (const accelerator of candidates) {
    try {
      if (globalShortcut.register(accelerator, toggleOverlay)) {
        activeHotkey = accelerator
        if (accelerator !== wanted) {
          console.warn(`Hotkey "${wanted}" was unavailable; fell back to "${accelerator}".`)
        }
        return
      }
    } catch (err) {
      console.warn(`Invalid accelerator "${accelerator}": ${(err as Error).message}`)
    }
  }
  console.warn(`Could not register a global hotkey (wanted "${wanted}").`)
}

/** Parse "#rrggbb" into an [r, g, b] triple; defaults to the stock blue. */
function hexToRgb(hex: string): [number, number, number] {
  const m = /^#?([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(hex.trim())
  if (!m) return [59, 130, 246]
  return [parseInt(m[1], 16), parseInt(m[2], 16), parseInt(m[3], 16)]
}

/** A crisp filled dot rendered in memory, so there's no icon file to ship. */
function dotImage(rgb: [number, number, number]): Electron.NativeImage {
  const size = 16
  const centre = (size - 1) / 2
  const radius = size / 2 - 2
  const buf = Buffer.alloc(size * size * 4)

  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const d = Math.hypot(x - centre, y - centre)
      const coverage = d <= radius ? 1 : d <= radius + 1 ? radius + 1 - d : 0
      const a = Math.round(coverage * 255)
      const i = (y * size + x) * 4
      // Electron expects premultiplied BGRA.
      buf[i] = Math.round((rgb[2] * a) / 255)
      buf[i + 1] = Math.round((rgb[1] * a) / 255)
      buf[i + 2] = Math.round((rgb[0] * a) / 255)
      buf[i + 3] = a
    }
  }
  return nativeImage.createFromBitmap(buf, { width: size, height: size })
}

/**
 * Tray artwork. macOS wants a monochrome *template* image that the OS tints for
 * light/dark menu bars; Windows and Linux get a solid dot in the user's accent
 * colour so it stays legible on any taskbar theme.
 */
function trayImage(): Electron.NativeImage {
  if (process.platform === 'darwin') {
    const img = dotImage([0, 0, 0])
    img.setTemplateImage(true)
    return img
  }
  return dotImage(hexToRgb(settings().accentColor))
}

/** Prettify an Electron accelerator for a menu label (⌘⌥⇧ on macOS). */
function prettyAccelerator(accelerator: string): string {
  const mac = process.platform === 'darwin'
  return accelerator
    .replace(/CommandOrControl|CmdOrCtrl/gi, mac ? '⌘' : 'Ctrl')
    .replace(/Command|Cmd|Super|Meta/gi, mac ? '⌘' : 'Win')
    .replace(/Control|Ctrl/gi, 'Ctrl')
    .replace(/Option|Alt/gi, mac ? '⌥' : 'Alt')
    .replace(/Shift/gi, mac ? '⇧' : 'Shift')
    .replace(/\+/g, mac ? '' : '+')
}

function createTray(): void {
  tray = new Tray(trayImage())
  tray.setToolTip('Lucid Type — press the hotkey to dictate')

  // Windows/Linux convention: a plain left-click opens the app. macOS shows the
  // menu on any click, which `setContextMenu` handles for us.
  if (process.platform !== 'darwin') {
    tray.on('click', () => openSettings())
  }
  refreshTray()
}

/** Rebuild the tray icon + context menu from the current settings. */
function refreshTray(): void {
  if (!tray) return
  if (process.platform !== 'darwin') tray.setImage(trayImage())

  const s = settings()
  const hotkeyHint = activeHotkey ? `  ${prettyAccelerator(activeHotkey)}` : ''

  const template: Electron.MenuItemConstructorOptions[] = [
    { label: `Start / stop dictation${hotkeyHint}`, click: () => toggleOverlay() },
    { type: 'separator' },
    {
      label: 'Auto-paste transcript',
      type: 'checkbox',
      checked: s.autoPaste,
      click: (item) => void applySettings({ autoPaste: item.checked }),
    },
    {
      label: 'Strip filler words',
      type: 'checkbox',
      checked: s.stripFillerWords,
      click: (item) => void applySettings({ stripFillerWords: item.checked }),
    },
    {
      label: 'Launch at login',
      type: 'checkbox',
      checked: s.launchAtLogin,
      click: (item) => void applySettings({ launchAtLogin: item.checked }),
    },
  ]

  if (lastAutoPasteBlocked) {
    template.push(
      { type: 'separator' },
      { label: 'Enable auto-paste…', click: () => openPermissionSettings('accessibility') },
    )
  }

  if (lastUpdateResult?.updateAvailable && lastUpdateResult.url) {
    const url = lastUpdateResult.url
    template.push(
      { type: 'separator' },
      { label: `Download Lucid Type ${lastUpdateResult.latest}…`, click: () => void shell.openExternal(url) },
    )
  }

  template.push(
    { type: 'separator' },
    { label: 'Dictation History…', click: () => openHistory() },
    { label: 'Settings…', accelerator: 'CmdOrCtrl+,', click: () => openSettings() },
    { label: 'Check for Updates…', click: () => void runUpdateCheck().then(() => openAbout()) },
    { label: 'About Lucid Type', click: () => openAbout() },
    { label: 'Quit Lucid Type', role: 'quit' },
  )

  tray.setContextMenu(Menu.buildFromTemplate(template))
}

/**
 * Persist a settings patch, then apply its side effects: re-register the hotkey
 * if it changed, repaint the tray, and push the fresh values to every renderer.
 */
function applySettings(patch: Partial<Settings>): Settings {
  const clean = sanitizeSettings(patch)
  if (Object.keys(clean).length > 0) store.set(clean)

  const next = store.store
  if ('hotkey' in clean || 'dictationMode' in clean) registerHotkey()
  if ('launchAtLogin' in clean) syncLoginItem()
  if ('historyLimit' in clean && historyStore) {
    const trimmed = historyStore.get('entries', []).slice(0, Math.max(1, next.historyLimit))
    historyStore.set('entries', trimmed)
    historyWin?.webContents.send('history:changed')
  }
  refreshTray()
  for (const w of BrowserWindow.getAllWindows()) {
    w.webContents.send('settings:changed', next)
  }
  return next
}

/** Open — or focus, if already open — the standalone Settings window. */
function openSettings(): void {
  if (settingsWin && !settingsWin.isDestroyed()) {
    settingsWin.show()
    settingsWin.focus()
    return
  }

  const mac = process.platform === 'darwin'

  settingsWin = new BrowserWindow({
    width: 720,
    height: 480,
    resizable: false,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    show: false,
    title: 'Lucid Type Settings',
    icon: APP_ICON,
    // On macOS let the sidebar vibrancy show through the transparent body; on
    // Windows keep the opaque dark backdrop.
    backgroundColor: mac ? '#00000000' : '#0e0f17',
    vibrancy: mac ? 'sidebar' : undefined,
    titleBarStyle: mac ? 'hiddenInset' : 'default',
    trafficLightPosition: mac ? { x: 12, y: 12 } : undefined,
    autoHideMenuBar: process.platform === 'win32',
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  })

  if (DEV_SERVER_URL) {
    void settingsWin.loadURL(`${DEV_SERVER_URL}#settings`)
  } else {
    void settingsWin.loadFile(path.join(APP_ROOT, 'dist', 'index.html'), { hash: 'settings' })
  }

  settingsWin.once('ready-to-show', () => settingsWin?.show())
  settingsWin.on('closed', () => {
    settingsWin = null
  })
}

/** Open — or focus, if already open — the Dictation History window. */
function openHistory(): void {
  if (historyWin && !historyWin.isDestroyed()) {
    historyWin.show()
    historyWin.focus()
    return
  }

  const mac = process.platform === 'darwin'

  historyWin = new BrowserWindow({
    width: 560,
    height: 560,
    minWidth: 380,
    minHeight: 320,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    show: false,
    title: 'Dictation History',
    icon: APP_ICON,
    backgroundColor: mac ? '#00000000' : '#0e0f17',
    vibrancy: mac ? 'sidebar' : undefined,
    titleBarStyle: mac ? 'hiddenInset' : 'default',
    trafficLightPosition: mac ? { x: 12, y: 12 } : undefined,
    autoHideMenuBar: process.platform === 'win32',
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  })

  if (DEV_SERVER_URL) {
    void historyWin.loadURL(`${DEV_SERVER_URL}#history`)
  } else {
    void historyWin.loadFile(path.join(APP_ROOT, 'dist', 'index.html'), { hash: 'history' })
  }

  historyWin.once('ready-to-show', () => historyWin?.show())
  historyWin.on('closed', () => {
    historyWin = null
  })
}

/** Open — or focus, if already open — the About window. */
function openAbout(): void {
  if (aboutWin && !aboutWin.isDestroyed()) {
    aboutWin.show()
    aboutWin.focus()
    return
  }

  const mac = process.platform === 'darwin'

  aboutWin = new BrowserWindow({
    width: 400,
    height: 470,
    resizable: false,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    show: false,
    center: true,
    title: 'About Lucid Type',
    icon: APP_ICON,
    backgroundColor: mac ? '#00000000' : '#0e0f17',
    vibrancy: mac ? 'sidebar' : undefined,
    titleBarStyle: mac ? 'hiddenInset' : 'default',
    trafficLightPosition: mac ? { x: 12, y: 12 } : undefined,
    autoHideMenuBar: process.platform === 'win32',
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  })

  if (DEV_SERVER_URL) {
    void aboutWin.loadURL(`${DEV_SERVER_URL}#about`)
  } else {
    void aboutWin.loadFile(path.join(APP_ROOT, 'dist', 'index.html'), { hash: 'about' })
  }

  aboutWin.once('ready-to-show', () => aboutWin?.show())
  aboutWin.on('closed', () => {
    aboutWin = null
  })
}

// ── Launch at login ─────────────────────────────────────────────────────────

/** Bring the OS "open at login" state in line with the stored setting. Called
 *  on startup (so a fresh install's default actually registers) and whenever
 *  the setting changes. The app has no dock icon and shows no window on launch,
 *  so it already starts quietly in the menu bar. */
function syncLoginItem(): void {
  try {
    app.setLoginItemSettings({ openAtLogin: settings().launchAtLogin })
  } catch (err) {
    console.warn(`Could not update the login item: ${(err as Error).message}`)
  }
}

// ── Update check ────────────────────────────────────────────────────────────

/**
 * Run a GitHub-releases update check, cache the result, and fan it out to the
 * About window + tray. On a newly-seen newer release, also raise a desktop
 * notification (once per version per session).
 */
async function runUpdateCheck(): Promise<UpdateCheckResult> {
  const result = await checkForUpdate(app.getVersion())
  lastUpdateResult = result

  for (const w of BrowserWindow.getAllWindows()) {
    w.webContents.send('updates:status', result)
  }
  refreshTray()

  if (
    result.updateAvailable &&
    result.latest &&
    result.latest !== notifiedVersion &&
    Notification.isSupported()
  ) {
    notifiedVersion = result.latest
    const note = new Notification({
      title: `Lucid Type ${result.latest} is available`,
      body: 'Click to open the download page.',
    })
    note.on('click', () => {
      if (result.url) void shell.openExternal(result.url)
    })
    note.show()
  }

  return result
}

// ── First-run onboarding ──────────────────────────────────────────────────

/**
 * Best-effort microphone permission snapshot. `getMediaAccessStatus` is only
 * implemented on macOS and Windows; Linux (and any future platform) reports
 * `unsupported` so the onboarding UI falls back to just trying `getUserMedia`.
 */
function getMicrophoneStatus(): MicrophoneAccessStatus {
  if (process.platform === 'darwin' || process.platform === 'win32') {
    try {
      return systemPreferences.getMediaAccessStatus('microphone') as MicrophoneAccessStatus
    } catch {
      return 'unsupported'
    }
  }
  return 'unsupported'
}

/** Current macOS Accessibility trust (needed for auto-paste + push-to-talk).
 *  Reported as `true` ("not applicable") on platforms without the concept. */
function getAccessibilityStatus(): boolean {
  if (process.platform !== 'darwin') return true
  try {
    return systemPreferences.isTrustedAccessibilityClient(false)
  } catch {
    return true
  }
}

/** Snapshot of every permission the onboarding flow cares about. */
function getPermissionStatus(): PermissionStatus {
  return {
    platform: process.platform,
    microphone: getMicrophoneStatus(),
    accessibility: getAccessibilityStatus(),
  }
}

/**
 * Ask macOS for microphone access, surfacing the native TCC prompt the first
 * time it's called. Windows/Linux have no equivalent main-process API — the
 * renderer's own `getUserMedia` call is what triggers the OS-level prompt
 * there, so this just reports the current status back.
 */
async function requestMicrophoneAccess(): Promise<MicrophoneAccessStatus> {
  if (process.platform === 'darwin') {
    try {
      const granted = await systemPreferences.askForMediaAccess('microphone')
      return granted ? 'granted' : 'denied'
    } catch {
      return getMicrophoneStatus()
    }
  }
  return getMicrophoneStatus()
}

/**
 * Ask macOS for Accessibility trust. `isTrustedAccessibilityClient(true)`
 * shows the native "would like to control this computer" prompt the first
 * time (and lists the app in Privacy & Security → Accessibility); actually
 * flipping the toggle is always a manual step for the user, so this just
 * reports whether it happens to be trusted already. Not applicable elsewhere.
 */
function requestAccessibilityAccess(): boolean {
  if (process.platform !== 'darwin') return true
  try {
    return systemPreferences.isTrustedAccessibilityClient(true)
  } catch {
    return getAccessibilityStatus()
  }
}

/** Deep-link straight to the System Settings pane for a permission, so a user
 *  who dismissed the native prompt (or is toggling it back on) doesn't have to
 *  go hunting for it. No-op on platforms without that concept. */
function openPermissionSettings(kind: 'microphone' | 'accessibility'): void {
  if (process.platform === 'darwin') {
    const pane = kind === 'microphone' ? 'Privacy_Microphone' : 'Privacy_Accessibility'
    void shell.openExternal(`x-apple.systempreferences:com.apple.preference.security?${pane}`)
  } else if (process.platform === 'win32' && kind === 'microphone') {
    void shell.openExternal('ms-settings:privacy-microphone')
  }
}

/** Open — or focus, if already open — the first-run onboarding window. Shown
 *  once (until {@link onboardingStore}'s `completed` flag is set) so a new
 *  install walks through granting the permissions the app needs before the
 *  user goes looking for the (dock-icon-less) app and finds nothing there. */
function openOnboarding(): void {
  if (onboardingWin && !onboardingWin.isDestroyed()) {
    onboardingWin.show()
    onboardingWin.focus()
    return
  }

  onboardingWin = new BrowserWindow({
    width: 460,
    height: 620,
    resizable: false,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    show: false,
    center: true,
    frame: false,
    transparent: true,
    hasShadow: true,
    title: 'Welcome to Lucid Type',
    icon: APP_ICON,
    backgroundColor: '#00000000',
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  })

  if (DEV_SERVER_URL) {
    void onboardingWin.loadURL(`${DEV_SERVER_URL}#onboarding`)
  } else {
    void onboardingWin.loadFile(path.join(APP_ROOT, 'dist', 'index.html'), { hash: 'onboarding' })
  }

  onboardingWin.once('ready-to-show', () => onboardingWin?.show())
  onboardingWin.on('closed', () => {
    onboardingWin = null
  })
}

// ── Dictation history ────────────────────────────────────────────────────────

/** Append a finished transcript to the local history, oldest-first trimmed to
 *  the `historyLimit` setting. No-op unless `saveHistory` is on (checked by the
 *  caller). */
function addHistoryEntry(text: string, appName?: string): void {
  if (!historyStore) return
  const entry: HistoryEntry = {
    id: randomUUID(),
    text,
    chars: text.length,
    app: appName,
    at: Date.now(),
  }
  const limit = Math.max(1, settings().historyLimit)
  const entries = [entry, ...historyStore.get('entries', [])].slice(0, limit)
  historyStore.set('entries', entries)
  historyWin?.webContents.send('history:changed')
}

// ── On-demand model downloads ────────────────────────────────────────────────

/** The current whisper models plus whether each one's file is on disk. */
function modelStatuses(): ModelStatus[] {
  return MODEL_LIST.map((spec) => ({
    id: spec.id,
    label: spec.label,
    file: spec.file,
    sizeMB: spec.sizeMB,
    downloaded: isModelDownloaded(spec.id),
  }))
}

/** Serialises downloads so two requests can't write the same file at once. */
let modelDownloadChain: Promise<unknown> = Promise.resolve()

function emitModelProgress(progress: ModelDownloadProgress): void {
  for (const w of BrowserWindow.getAllWindows()) {
    w.webContents.send('model:download-progress', progress)
  }
}

/**
 * Fetch a whisper model into {@link USER_MODELS_DIR}, streaming to a temp file
 * and renaming on success. Emits `model:download-progress` as it goes. Resolves
 * once the file is in place; rejects (and reports via a `done` + `error`
 * progress event) on any failure.
 */
async function downloadModel(id: ModelId): Promise<void> {
  const run = modelDownloadChain.catch(() => {}).then(async () => {
    if (isModelDownloaded(id)) return

    const spec = MODELS[id]
    await mkdir(USER_MODELS_DIR, { recursive: true })
    const dest = path.join(USER_MODELS_DIR, spec.file)
    const tmp = `${dest}.download`

    try {
      const res = await fetch(spec.url, { redirect: 'follow' })
      if (!res.ok || !res.body) {
        throw new Error(`HTTP ${res.status} ${res.statusText}`)
      }
      const total = Number(res.headers.get('content-length')) || 0
      let received = 0

      // Count bytes with a passthrough in the pipeline — attaching a 'data'
      // listener directly would fight `pipeline` for the stream.
      const counter = new Transform({
        transform(chunk: Buffer, _enc, cb) {
          received += chunk.length
          emitModelProgress({ id, received, total })
          cb(null, chunk)
        },
      })
      const body = Readable.fromWeb(res.body as unknown as WebReadableStream<Uint8Array>)
      await pipeline(body, counter, createWriteStream(tmp))

      const got = (await stat(tmp)).size
      if (got < spec.sizeMB * 1024 * 1024 * 0.8) {
        await unlink(tmp).catch(() => {})
        throw new Error('download was incomplete')
      }
      await rename(tmp, dest)
      emitModelProgress({ id, received: got, total: got, done: true })
    } catch (err) {
      await unlink(tmp).catch(() => {})
      const message = err instanceof Error ? err.message : String(err)
      emitModelProgress({ id, received: 0, total: 0, done: true, error: message })
      throw new Error(`Model download failed: ${message}`)
    }
  })
  modelDownloadChain = run
  return run as Promise<void>
}

// ── Cancel-the-current-take shortcut ─────────────────────────────────────────

/** Arm or disarm a temporary global Esc that abandons the in-progress take.
 *  Kept narrow — only live while actually recording — so it never eats an Esc
 *  the user meant for their editor. */
function setCancelShortcut(on: boolean): void {
  if (on === cancelShortcutOn) return
  if (on) {
    try {
      cancelShortcutOn = globalShortcut.register('Escape', () => {
        win?.webContents.send('whisper:cancel')
      })
    } catch {
      cancelShortcutOn = false
    }
  } else {
    try {
      globalShortcut.unregister('Escape')
    } catch {
      // never registered
    }
    cancelShortcutOn = false
  }
}

/**
 * Run whisper.cpp against a 16 kHz mono WAV, copy the transcript to the system
 * clipboard, and return it alongside how the AI polish pass resolved. The
 * renderer records via the Web Audio API and hands us the encoded WAV bytes.
 */
async function transcribe(wavBytes: Uint8Array): Promise<TranscribeResult> {
  // Resolve the chosen model, falling back to the always-bundled base.en if its
  // file isn't on disk (e.g. a download that never finished).
  let modelFile = modelFilePath(settings().model)
  if (!existsSync(modelFile)) modelFile = modelFilePath('base.en')
  if (!existsSync(modelFile)) {
    throw new Error(`Whisper model not found at ${modelFile}`)
  }

  const dir = await mkdtemp(path.join(tmpdir(), 'whisper-flow-'))
  const wavPath = path.join(dir, `${randomUUID()}.wav`)
  // whisper-cli's `-otxt` writes alongside the input, appending `.txt` to the
  // full name (so `foo.wav` -> `foo.wav.txt`).
  const txtPath = `${wavPath}.txt`

  // Detect the active app the moment dictation stops — while the user's target
  // window is still frontmost (the pill never takes focus). The lookup overlaps
  // whisper-cli and is needed for the polish pass and for the history entry.
  const wantActiveApp = settings().useLlmPolish || settings().saveHistory
  const activeAppPromise: Promise<string | undefined> = wantActiveApp
    ? detectActiveApp()
    : Promise.resolve(undefined)

  // A non-empty custom vocabulary is handed to whisper as an initial prompt,
  // biasing it toward those spellings. Clamp the length so a huge list can't
  // blow out the command line.
  const vocab = settings().vocabulary
  const promptArg = vocab.length ? ['--prompt', vocab.join(', ').slice(0, 900)] : []

  try {
    await writeFile(wavPath, wavBytes)

    const args = [
      '-m', modelFile,
      '-f', wavPath,
      '-nt', // no timestamps
      '-otxt', // write the plain transcript to <wavPath>.txt
      '-l', 'en', // force English; skip language auto-detect
      '--entropy-thold', '2.4', // fail a decode that gets too random
      '--logprob-thold', '-1.0', // fail a decode whose tokens are too unlikely
      '-t', String(Math.max(1, availableParallelism() - 1)),
      ...promptArg,
    ]

    try {
      await execFileAsync(WHISPER_CLI, args)
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err)
      throw new Error(`whisper-cli failed: ${detail}`)
    }

    const raw = await readFile(txtPath, 'utf8')
    const joined = scrubText(
      raw
        .split('\n')
        .map((line) => line.trim())
        .filter(Boolean)
        .join(' '),
    )

    const { autoPaste, stripFillerWords, useLlmPolish } = settings()

    // Drop coughs, throat-clearing, and other non-verbal artefacts from the raw
    // transcript before it reaches Ollama or the clipboard. If nothing survives,
    // the take was pure noise: return an empty transcript so the caller neither
    // pastes nor copies, and the pill closes quietly.
    const sanitized = sanitizeTranscript(joined)
    if (!sanitized) {
      return { text: '', polish: 'off', autoPasteBlocked: false }
    }

    let text = dropHallucinations(cleanTranscript(sanitized, stripFillerWords))

    // Optional local-LLM polish: hand Ollama the raw transcript to resolve
    // self-corrections, strip filler, and punctuate — with formatting tuned to
    // the frontmost app. Falls back to the regex-cleaned text above if Ollama
    // isn't reachable within the timeout. The LLM output still runs through the
    // regex cleaner — honouring stripFillerWords — so anything the model leaves
    // behind is caught the same way the non-polish path would catch it.
    let polish: PolishOutcome = 'off'
    if (text && useLlmPolish) {
      const polished = await polishTranscript(sanitized, await activeAppPromise)
      if (polished) {
        text = dropHallucinations(cleanTranscript(polished, stripFillerWords))
        polish = 'polished'
      } else {
        polish = 'fallback'
      }
    }

    // User find/replace rules, then the final guard: whatever cleaner/polish
    // path produced `text`, nothing untrusted reaches the clipboard or a
    // synthetic paste unscrubbed.
    text = applyReplacements(text, settings().replacements)
    text = scrubText(text)

    // Auto-paste needs macOS Accessibility trust; without it the synthetic
    // Cmd+V is silently swallowed. Detect that up front and leave the text on
    // the clipboard with a flag so the renderer can explain what happened.
    let autoPasteBlocked = false
    if (text) {
      if (autoPaste && process.platform === 'darwin' && !getAccessibilityStatus()) {
        await clipboard.writeText(text)
        autoPasteBlocked = true
      } else if (autoPaste) {
        await triggerSystemPaste(text)
      } else {
        await clipboard.writeText(text)
      }
    }

    if (autoPasteBlocked !== lastAutoPasteBlocked) {
      lastAutoPasteBlocked = autoPasteBlocked
      refreshTray()
    }

    if (text && settings().saveHistory) {
      addHistoryEntry(text, await activeAppPromise)
    }

    return { text, polish, autoPasteBlocked }
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}

// ── Transcription rate limiting ──────────────────────────────────────────────
//
// `transcribe` shells out to whisper-cli, which pins a core for the length of
// the decode. Nothing metered or billable runs here — this guard exists purely
// so a wedged renderer, a second window, or a runaway caller can't stampede the
// CPU with overlapping decode processes.

/** Largest WAV we'll accept from the renderer. 16 kHz mono 16-bit is ~32 KB/s,
 *  so this is roughly 45 minutes — a bigger payload is a bug, not a take. */
const MAX_WAV_BYTES = 90 * 1024 * 1024
/** How many requests may wait behind the running decode before we start
 *  rejecting. The renderer already blocks a second take while one is in flight,
 *  so a backlog past this means something is misbehaving. */
const MAX_TRANSCRIBE_QUEUE = 2
/** Idle gap forced between one decode finishing and the next starting, so a
 *  burst of requests can't keep whisper-cli pegged back-to-back. */
const TRANSCRIBE_COOLDOWN_MS = 400

const delay = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))

/** Tail of the decode chain; every request awaits this before it runs, which
 *  serialises them so only one whisper-cli process is ever alive. */
let transcribeChain: Promise<unknown> = Promise.resolve()
/** Requests accepted but not yet started — the backlog the queue cap limits. */
let transcribeQueued = 0
let lastTranscribeFinishedAt = 0

/**
 * Gate {@link transcribe}: one decode at a time, a bounded queue, a short
 * cooldown between takes, and a sanity check on the payload size. Throws a plain
 * Error (surfaced to the renderer as a failed transcription) when the queue is
 * full or the WAV is implausibly large.
 */
async function rateLimitedTranscribe(wavBytes: Uint8Array): Promise<TranscribeResult> {
  const size = (wavBytes as { byteLength?: number } | null | undefined)?.byteLength ?? 0
  if (size === 0) throw new Error('No audio received')
  if (size > MAX_WAV_BYTES) throw new Error('Recording is too long to transcribe')

  if (transcribeQueued >= MAX_TRANSCRIBE_QUEUE) {
    console.warn(`transcribe-audio: ${transcribeQueued} already queued — rejecting request`)
    throw new Error('Transcription is busy — try again in a moment')
  }

  transcribeQueued++
  const run = transcribeChain
    .catch(() => {}) // a failed decode must not break the chain for the next one
    .then(async () => {
      transcribeQueued--
      const idle = Date.now() - lastTranscribeFinishedAt
      if (idle < TRANSCRIBE_COOLDOWN_MS) await delay(TRANSCRIBE_COOLDOWN_MS - idle)
      try {
        return await transcribe(wavBytes)
      } finally {
        lastTranscribeFinishedAt = Date.now()
      }
    })

  transcribeChain = run
  return run
}

app.whenReady().then(() => {
  store = new Store<Settings>({ defaults: DEFAULT_SETTINGS })
  onboardingStore = new Store<{ completed: boolean }>({
    name: 'onboarding',
    defaults: { completed: false },
  })
  historyStore = new Store<{ entries: HistoryEntry[] }>({
    name: 'history',
    defaults: { entries: [] },
  })

  // Windows: group the app's windows and notifications under a stable identity
  // (must match electron-builder's appId) rather than the default per-exe one.
  app.setAppUserModelId('com.lucidtype.app')

  app.setAboutPanelOptions({
    applicationName: 'Lucid Type',
    applicationVersion: app.getVersion(),
    version: '',
    copyright: 'Local-first dictation. On-device transcription by whisper.cpp.',
    website: 'https://github.com/V0idyy-0/Lucid.Type',
    iconPath: APP_ICON,
  })

  // A menu-bar / system-tray resident app — no dock icon on macOS.
  if (process.platform === 'darwin') app.dock?.hide()

  // Bring the OS login item in line with the setting (registers a fresh
  // install's default, honours a returning user's choice).
  syncLoginItem()

  // Let the renderer reach the microphone.
  session.defaultSession.setPermissionRequestHandler((_wc, permission, callback) => {
    callback(permission === 'media')
  })

  ipcMain.handle('transcribe-audio', async (_event, wavBytes: Uint8Array) => {
    return rateLimitedTranscribe(wavBytes)
  })

  // Settings bridge for the renderer.
  ipcMain.handle('get-settings', () => store.store)
  ipcMain.handle('update-settings', (_event, patch: Partial<Settings>) => applySettings(patch))
  ipcMain.on('settings:open', () => openSettings())
  ipcMain.on('settings:close', () => settingsWin?.close())

  // Onboarding: first-run permission checks + completion flag.
  ipcMain.handle('permissions:status', () => getPermissionStatus())
  ipcMain.handle('permissions:request-microphone', () => requestMicrophoneAccess())
  ipcMain.handle('permissions:request-accessibility', () => requestAccessibilityAccess())
  ipcMain.on('permissions:open-settings', (_event, kind: 'microphone' | 'accessibility') =>
    openPermissionSettings(kind),
  )
  ipcMain.handle('onboarding:get-completed', () => onboardingStore.get('completed'))
  ipcMain.on('onboarding:complete', () => {
    onboardingStore.set('completed', true)
    onboardingWin?.close()
  })

  // Dictation history.
  ipcMain.handle('history:list', () => historyStore.get('entries', []))
  ipcMain.handle('history:delete', (_event, id: string) => {
    const kept = historyStore.get('entries', []).filter((e) => e.id !== id)
    historyStore.set('entries', kept)
    historyWin?.webContents.send('history:changed')
    return kept
  })
  ipcMain.handle('history:clear', () => {
    historyStore.set('entries', [])
    historyWin?.webContents.send('history:changed')
    return []
  })
  ipcMain.on('history:open', () => openHistory())
  ipcMain.on('clipboard:write', (_event, text: string) => {
    if (typeof text === 'string' && text) clipboard.writeText(text.slice(0, 100_000))
  })

  // Whisper model picker + on-demand downloads.
  ipcMain.handle('models:list', () => modelStatuses())
  ipcMain.handle('models:download', async (_event, id: ModelId) => {
    if (!(id in MODELS)) throw new Error(`Unknown model "${id}"`)
    await downloadModel(id)
    return modelStatuses()
  })

  ipcMain.on('app:close', () => win?.close())
  ipcMain.on('app:minimize', () => win?.minimize())
  ipcMain.on('app:quit', () => app.quit())

  // The renderer owns the pill's lifecycle: show the overlay while the pill is
  // mounted (recording), hide it the moment dictation ends. `showInactive`
  // keeps the user's current app frontmost so the auto-paste still lands there.
  ipcMain.on('whisper:pill-visible', (_event, visible: boolean) => {
    if (!win) return
    if (visible) win.showInactive()
    else win.hide()
  })

  // Arm the Esc-to-cancel shortcut only while a take is actually being recorded.
  ipcMain.on('whisper:recording', (_event, recording: boolean) => setCancelShortcut(!!recording))

  // About window + update check.
  ipcMain.handle('app:get-version', () => app.getVersion())
  ipcMain.on('about:open', () => openAbout())
  ipcMain.handle('updates:check', () => runUpdateCheck())
  ipcMain.handle('updates:get-status', () =>
    lastUpdateResult ?? { current: app.getVersion(), updateAvailable: false, checkedAt: 0 },
  )
  ipcMain.on('updates:open-download', () => {
    const url = lastUpdateResult?.url
    if (url) void shell.openExternal(url)
  })
  // Guarded external-link opener for the About window's links.
  ipcMain.on('app:open-external', (_event, url: string) => {
    try {
      const parsed = new URL(url)
      if (parsed.protocol === 'https:' && parsed.hostname === 'github.com') {
        void shell.openExternal(parsed.toString())
      }
    } catch {
      // not a URL — ignore
    }
  })

  registerHotkey()
  createTray()
  createWindow()

  if (!onboardingStore.get('completed')) openOnboarding()

  // Check for a newer release shortly after startup, then once a day, unless
  // the user turned it off.
  if (settings().autoCheckUpdates) {
    setTimeout(() => void runUpdateCheck(), 8000)
    setInterval(() => {
      if (settings().autoCheckUpdates) void runUpdateCheck()
    }, 24 * 60 * 60 * 1000)
  }

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('will-quit', () => {
  globalShortcut.unregisterAll()
  disablePushToTalk()
})

// This is a tray-resident app: closing its windows leaves it running in the
// menu bar / system tray. Quitting is done from the tray menu or Cmd/Ctrl+Q.
app.on('window-all-closed', () => {})
