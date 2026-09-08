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
}

export const DEFAULT_SETTINGS: Settings = {
  hotkey: 'Alt+Space',
  dictationMode: 'toggle',
  autoPaste: true,
  stripFillerWords: true,
  useLlmPolish: false,
  accentColor: '#3b82f6',
  soundEffects: true,
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
