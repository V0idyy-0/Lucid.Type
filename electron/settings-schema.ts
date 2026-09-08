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

/**
 * Keep only recognised keys with well-typed values from an untrusted patch —
 * IPC payloads and tray clicks both flow through here before they touch disk.
 */
export function sanitizeSettings(patch: Partial<Settings> | null | undefined): Partial<Settings> {
  const out: Partial<Settings> = {}
  if (!patch || typeof patch !== 'object') return out

  if (typeof patch.hotkey === 'string' && patch.hotkey.trim()) {
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

  return out
}
