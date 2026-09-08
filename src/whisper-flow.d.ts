import type { Settings } from './settings'

/**
 * How the AI polish pass resolved for a take. Mirrors `PolishOutcome` in
 * `electron/ipc.ts` (the two sides of the IPC boundary don't share a module).
 * - `off`      — polish is disabled in settings.
 * - `polished` — Ollama returned a usable rewrite and it was used.
 * - `fallback` — polish was on but Ollama failed, so the regex cleaner was used.
 */
export type PolishOutcome = 'off' | 'polished' | 'fallback'

export interface TranscribeResult {
  /** The final transcript, already copied to the clipboard (or pasted). */
  text: string
  /** How the AI polish pass resolved for this take. */
  polish: PolishOutcome
}

export interface WhisperFlowApi {
  /** The host OS, read in the preload where `process` is available. */
  platform: NodeJS.Platform
  /**
   * Send a 16 kHz mono WAV (as bytes) to whisper.cpp; resolves to the transcript
   * plus how the AI polish pass resolved for this take.
   */
  transcribe(wav: Uint8Array): Promise<TranscribeResult>
  /** Close the pill window. */
  close(): void
  /** Minimise the pill window. */
  minimize(): void
  /** Quit whisper-flow entirely (same as the tray's Quit item). */
  quit(): void
  /** Show the overlay window while the pill is on screen, hide it otherwise. */
  setPillVisible(visible: boolean): void
  /** Subscribe to the global toggle hotkey; returns an unsubscribe fn. */
  onToggle(fn: () => void): () => void
  /** Push-to-talk: the held hotkey went down — start capturing. Returns an unsubscribe fn. */
  onRecordStart(fn: () => void): () => void
  /** Push-to-talk: the held hotkey came up — stop and transcribe. Returns an unsubscribe fn. */
  onRecordStop(fn: () => void): () => void
  /** Read the persisted user settings. */
  getSettings(): Promise<Settings>
  /** Merge a patch into the persisted settings; resolves to the full new set. */
  updateSettings(patch: Partial<Settings>): Promise<Settings>
  /** Subscribe to settings changes from any source; returns an unsubscribe fn. */
  onSettingsChanged(fn: (settings: Settings) => void): () => void
  /** Open the standalone Settings window. */
  openSettings(): void
  /** Close the standalone Settings window. */
  closeSettings(): void
}

declare global {
  interface Window {
    whisperFlow: WhisperFlowApi
  }
}
