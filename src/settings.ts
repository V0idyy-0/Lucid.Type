/**
 * Renderer-side copy of the settings contract. Mirrors
 * `electron/settings-schema.ts` — keep the two in step.
 */
/**
 * How the global hotkey drives dictation:
 * - `toggle` — tap once to start, tap again to stop.
 * - `ptt`    — hold to record, release to transcribe (push-to-talk).
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

/** Preset accent colours offered in the Settings modal. */
export const ACCENT_SWATCHES = [
  '#3b82f6', // blue
  '#8b5cf6', // violet
  '#ec4899', // pink
  '#f43f5e', // rose
  '#f97316', // orange
  '#eab308', // amber
  '#10b981', // emerald
  '#14b8a6', // teal
] as const
