/**
 * Shared shape + defaults for the user-customisable settings that the main
 * process persists with electron-store. The renderer keeps a matching copy of
 * this contract in `src/settings.ts` — keep the two in step.
 */
/** A literal find/replace applied to every finished transcript. */
export type Replacement = { from: string; to: string }

/** Whisper model ids Lucid Type can run. All English-only for now. */
export const MODEL_IDS = ['tiny.en', 'base.en', 'small.en'] as const
export type ModelId = (typeof MODEL_IDS)[number]

export type Settings = {
  /** Global accelerator that reveals the pill and toggles dictation with a
   *  tap. Empty falls back to the default (there's always a toggle key). */
  toggleHotkey: string
  /** Accelerator held down to record push-to-talk style, release to
   *  transcribe. Empty means push-to-talk is disabled — unlike the toggle
   *  hotkey, there's no default to fall back to. Independent of
   *  `toggleHotkey`; both can be bound and used at the same time. */
  pttHotkey: string
  /** Fire a synthetic paste after transcription so the text lands in the app. */
  autoPaste: boolean
  /** Drop "um", "uh", "like", "you know" from the transcript. */
  stripFillerWords: boolean
  /**
   * Route the raw transcript through a locally-running Ollama (llama3.2:1b) to
   * strip filler words before pasting. Best-effort: falls back to the regex
   * cleaner if Ollama isn't running.
   */
  useLlmPolish: boolean
  /** Accent colour for the pill's wave bars and glow (hex, e.g. "#3b82f6"). */
  accentColor: string
  /** Play a short start/stop chime when recording toggles. */
  soundEffects: boolean
  /** Whisper model to decode with. Larger = more accurate, slower. */
  model: ModelId
  /** Keep a local log of finished transcripts (off by default — privacy-first). */
  saveHistory: boolean
  /** How many history entries to keep before the oldest are dropped. */
  historyLimit: number
  /** Proper nouns / jargon / acronyms fed to whisper as a recognition hint. */
  vocabulary: string[]
  /** Literal find/replace rules applied to every finished transcript. */
  replacements: Replacement[]
  /** Start Lucid Type automatically when the user logs into their computer. */
  launchAtLogin: boolean
  /** Check GitHub for a newer release on startup and once a day. */
  autoCheckUpdates: boolean
}

export const DEFAULT_SETTINGS: Settings = {
  toggleHotkey: 'Alt+Space',
  pttHotkey: '',
  autoPaste: true,
  stripFillerWords: true,
  useLlmPolish: false,
  accentColor: '#3b82f6',
  soundEffects: true,
  model: 'base.en',
  saveHistory: false,
  historyLimit: 100,
  vocabulary: [],
  replacements: [],
  launchAtLogin: true,
  autoCheckUpdates: true,
}

/** Shape of a pre-split persisted settings file, before the toggle and
 *  push-to-talk hotkeys became independent fields. */
interface LegacyHotkeySettings {
  hotkey?: string
  dictationMode?: 'toggle' | 'ptt'
}

/**
 * One-time upgrade of a raw electron-store record from the old shared
 * `hotkey` + `dictationMode` shape to independent `toggleHotkey`/`pttHotkey`
 * fields. Returns `null` when there's nothing to migrate (a fresh install, or
 * a store already on the new shape). electron-store never renames or drops
 * keys it doesn't recognise on its own, so without this the old fields would
 * sit inert on disk while the new ones silently default, discarding whatever
 * hotkey the user had configured.
 */
export function migrateLegacyHotkeySettings(
  raw: Record<string, unknown>,
): Partial<Settings> | null {
  const legacy = raw as LegacyHotkeySettings
  if (typeof legacy.hotkey !== 'string') return null

  const hotkey = legacy.hotkey.trim()
  if (legacy.dictationMode === 'ptt') {
    // The user's one hotkey *was* their push-to-talk key — carry it over and
    // give toggle the (new) default rather than leaving it unbound.
    return { pttHotkey: hotkey, toggleHotkey: DEFAULT_SETTINGS.toggleHotkey }
  }
  return { toggleHotkey: hotkey || DEFAULT_SETTINGS.toggleHotkey, pttHotkey: '' }
}

/** Per-entry / per-list caps so an untrusted patch can't bloat the store or the
 *  whisper command line. */
const MAX_VOCAB_TERMS = 200
const MAX_TERM_CHARS = 80
const MAX_REPLACEMENTS = 200
const MAX_REPLACEMENT_CHARS = 200

function cleanStringList(value: unknown, max: number, maxChars: number): string[] | undefined {
  if (!Array.isArray(value)) return undefined
  const out: string[] = []
  for (const item of value) {
    if (typeof item !== 'string') continue
    const trimmed = item.trim().slice(0, maxChars)
    if (trimmed) out.push(trimmed)
    if (out.length >= max) break
  }
  return out
}

function cleanReplacements(value: unknown): Replacement[] | undefined {
  if (!Array.isArray(value)) return undefined
  const out: Replacement[] = []
  for (const item of value) {
    if (!item || typeof item !== 'object') continue
    const from = (item as Replacement).from
    const to = (item as Replacement).to
    if (typeof from !== 'string' || typeof to !== 'string') continue
    const f = from.trim().slice(0, MAX_REPLACEMENT_CHARS)
    if (!f) continue
    out.push({ from: f, to: to.slice(0, MAX_REPLACEMENT_CHARS) })
    if (out.length >= MAX_REPLACEMENTS) break
  }
  return out
}

/** An Electron accelerator is a short "+"-joined list of ASCII key tokens. */
const ACCELERATOR_RE = /^[A-Za-z0-9 +]+$/

/**
 * Keep only recognised keys with well-typed values from an untrusted patch —
 * IPC payloads and tray clicks both flow through here before they touch disk.
 * `current` is the settings already on disk, needed to reject a patch that
 * would make `toggleHotkey` and `pttHotkey` collide (the field being changed
 * loses, the other field's existing value wins).
 */
export function sanitizeSettings(
  patch: Partial<Settings> | null | undefined,
  current: Settings = DEFAULT_SETTINGS,
): Partial<Settings> {
  const out: Partial<Settings> = {}
  if (!patch || typeof patch !== 'object') return out

  // Reject anything outside the accelerator shape so junk never reaches
  // globalShortcut or the persisted store; the renderer already runs a
  // fuller validateShortcut(). Unlike toggleHotkey, an empty pttHotkey is a
  // valid, meaningful value (push-to-talk disabled).
  if (typeof patch.toggleHotkey === 'string') {
    const trimmed = patch.toggleHotkey.trim()
    if (trimmed && trimmed.length <= 80 && ACCELERATOR_RE.test(trimmed)) {
      out.toggleHotkey = trimmed
    }
  }
  if (typeof patch.pttHotkey === 'string') {
    const trimmed = patch.pttHotkey.trim()
    if (trimmed === '' || (trimmed.length <= 80 && ACCELERATOR_RE.test(trimmed))) {
      out.pttHotkey = trimmed
    }
  }
  // Two non-empty hotkeys bound to the same combo would be ambiguous — let
  // whichever field isn't being changed by this patch win, and drop the one
  // that is.
  const nextToggle = out.toggleHotkey ?? current.toggleHotkey
  const nextPtt = out.pttHotkey ?? current.pttHotkey
  if (nextToggle && nextToggle === nextPtt) {
    if ('toggleHotkey' in out) delete out.toggleHotkey
    else delete out.pttHotkey
    console.warn(`Ignored hotkey change: "${nextToggle}" is already used by the other trigger.`)
  }
  if (typeof patch.autoPaste === 'boolean') out.autoPaste = patch.autoPaste
  if (typeof patch.stripFillerWords === 'boolean') out.stripFillerWords = patch.stripFillerWords
  if (typeof patch.useLlmPolish === 'boolean') out.useLlmPolish = patch.useLlmPolish
  if (typeof patch.accentColor === 'string' && /^#[0-9a-f]{6}$/i.test(patch.accentColor)) {
    out.accentColor = patch.accentColor.toLowerCase()
  }
  if (typeof patch.soundEffects === 'boolean') out.soundEffects = patch.soundEffects

  if ((MODEL_IDS as readonly string[]).includes(patch.model as string)) {
    out.model = patch.model as ModelId
  }
  if (typeof patch.saveHistory === 'boolean') out.saveHistory = patch.saveHistory
  if (typeof patch.launchAtLogin === 'boolean') out.launchAtLogin = patch.launchAtLogin
  if (typeof patch.autoCheckUpdates === 'boolean') out.autoCheckUpdates = patch.autoCheckUpdates
  if (typeof patch.historyLimit === 'number' && Number.isFinite(patch.historyLimit)) {
    out.historyLimit = Math.min(1000, Math.max(1, Math.round(patch.historyLimit)))
  }

  const vocab = cleanStringList(patch.vocabulary, MAX_VOCAB_TERMS, MAX_TERM_CHARS)
  if (vocab) out.vocabulary = vocab
  const replacements = cleanReplacements(patch.replacements)
  if (replacements) out.replacements = replacements

  return out
}
