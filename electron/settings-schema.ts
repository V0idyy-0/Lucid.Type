/**
 * Shared shape + defaults for the user-customisable settings that the main
 * process persists with electron-store. The renderer keeps a matching copy of
 * this contract in `src/settings.ts` — keep the two in step.
 */
/**
 * How the global hotkey drives dictation:
 * - `toggle` — tap once to start, tap again to stop (uses `globalShortcut`).
 * - `ptt`    — hold to record, release to transcribe (uses a raw keyboard hook).
 */
export type DictationMode = 'toggle' | 'ptt'

/** A literal find/replace applied to every finished transcript. */
export type Replacement = { from: string; to: string }

/** Whisper model ids Lucid Type can run. All English-only for now. */
export const MODEL_IDS = ['tiny.en', 'base.en', 'small.en'] as const
export type ModelId = (typeof MODEL_IDS)[number]

export type Settings = {
  /** Global accelerator that reveals the pill and toggles dictation. */
  hotkey: string
  /** Whether the hotkey toggles dictation or is held down for push-to-talk. */
  dictationMode: DictationMode
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
  hotkey: 'Alt+Space',
  dictationMode: 'toggle',
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

/**
 * Keep only recognised keys with well-typed values from an untrusted patch —
 * IPC payloads and tray clicks both flow through here before they touch disk.
 */
export function sanitizeSettings(patch: Partial<Settings> | null | undefined): Partial<Settings> {
  const out: Partial<Settings> = {}
  if (!patch || typeof patch !== 'object') return out

  // An Electron accelerator is a short "+"-joined list of ASCII key tokens.
  // Reject anything outside that shape so junk never reaches globalShortcut or
  // the persisted store; the renderer already runs a fuller validateShortcut().
  if (
    typeof patch.hotkey === 'string' &&
    patch.hotkey.trim() &&
    patch.hotkey.trim().length <= 80 &&
    /^[A-Za-z0-9 +]+$/.test(patch.hotkey.trim())
  ) {
    out.hotkey = patch.hotkey.trim()
  }
  if (patch.dictationMode === 'toggle' || patch.dictationMode === 'ptt') {
    out.dictationMode = patch.dictationMode
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
