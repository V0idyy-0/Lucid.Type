import type { ModelId, Settings } from './settings'

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
  /** Auto-paste was requested but macOS Accessibility isn't trusted, so the
   *  transcript was left on the clipboard instead of being pasted. */
  autoPasteBlocked: boolean
}

/** One entry in the local dictation history (final text only — no audio). */
export interface HistoryEntry {
  id: string
  text: string
  chars: number
  app?: string
  at: number
}

/** A whisper model plus whether its file is present under `bin/models/`. */
export interface ModelStatus {
  id: string
  label: string
  file: string
  sizeMB: number
  downloaded: boolean
}

/** Progress of an in-flight model download. */
export interface ModelDownloadProgress {
  id: string
  received: number
  total: number
  done?: boolean
  error?: string
}

/** Outcome of a GitHub-releases update check. */
export interface UpdateCheckResult {
  current: string
  latest?: string
  url?: string
  notes?: string
  updateAvailable: boolean
  checkedAt: number
  error?: string
}

/**
 * Coarse OS-reported microphone permission state, as surfaced by
 * `systemPreferences.getMediaAccessStatus('microphone')` on macOS/Windows.
 * `unsupported` covers Linux and any platform where the API isn't
 * implemented — the onboarding UI falls back to a plain `getUserMedia` probe.
 */
export type MicrophoneAccessStatus =
  | 'granted'
  | 'denied'
  | 'restricted'
  | 'not-determined'
  | 'unsupported'

/** Snapshot of the permissions the first-run onboarding flow cares about. */
export interface PermissionStatus {
  platform: NodeJS.Platform
  microphone: MicrophoneAccessStatus
  /** macOS Accessibility trust (needed for auto-paste + push-to-talk). Always
   *  `true` ("not applicable") on platforms without the concept. */
  accessibility: boolean
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
  /** The user pressed Esc to abandon the current take. Returns an unsubscribe fn. */
  onCancel(fn: () => void): () => void
  /** Report whether audio is recording right now (arms the Esc-to-cancel shortcut). */
  setRecording(recording: boolean): void
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

  // ── First-run onboarding ──────────────────────────────────────────────

  /** Current OS permission snapshot for the onboarding flow. */
  getPermissionStatus(): Promise<PermissionStatus>
  /** Trigger the native microphone permission prompt where supported. */
  requestMicrophoneAccess(): Promise<MicrophoneAccessStatus>
  /** Trigger the native macOS Accessibility trust prompt. */
  requestAccessibilityAccess(): Promise<boolean>
  /** Deep-link to the System Settings pane for a permission. */
  openPermissionSettings(kind: 'microphone' | 'accessibility'): void
  /** Whether the first-run onboarding flow has already been completed. */
  getOnboardingCompleted(): Promise<boolean>
  /** Mark onboarding complete and close its window. */
  completeOnboarding(): void

  // ── Dictation history ─────────────────────────────────────────────────

  /** All stored history entries, newest first. */
  listHistory(): Promise<HistoryEntry[]>
  /** Delete one entry by id; resolves to the remaining entries. */
  deleteHistoryEntry(id: string): Promise<HistoryEntry[]>
  /** Wipe the whole history; resolves to `[]`. */
  clearHistory(): Promise<HistoryEntry[]>
  /** Open the standalone Dictation History window. */
  openHistory(): void
  /** Fires when history changes from anywhere. Returns an unsubscribe fn. */
  onHistoryChanged(fn: () => void): () => void
  /** Put text on the system clipboard. */
  writeClipboard(text: string): void

  // ── Whisper models ────────────────────────────────────────────────────

  /** The available models plus whether each one's file is on disk. */
  listModels(): Promise<ModelStatus[]>
  /** Download a model; resolves to the refreshed model list when it lands. */
  downloadModel(id: ModelId): Promise<ModelStatus[]>
  /** Progress of an in-flight model download. Returns an unsubscribe fn. */
  onModelDownloadProgress(fn: (progress: ModelDownloadProgress) => void): () => void

  // ── About + updates ───────────────────────────────────────────────────

  /** The running app version (e.g. "1.0.0"). */
  getVersion(): Promise<string>
  /** Open the standalone About window. */
  openAbout(): void
  /** Run a GitHub-releases update check now; resolves to the result. */
  checkForUpdates(): Promise<UpdateCheckResult>
  /** The most recent update-check result (or a "never checked" placeholder). */
  getUpdateStatus(): Promise<UpdateCheckResult>
  /** Open the latest release's download page in the browser. */
  openDownloadPage(): void
  /** Fires whenever an update check completes. Returns an unsubscribe fn. */
  onUpdateStatus(fn: (status: UpdateCheckResult) => void): () => void
  /** Open an https://github.com/… link in the browser (other URLs are ignored). */
  openExternalLink(url: string): void
}

declare global {
  interface Window {
    whisperFlow: WhisperFlowApi
  }
}
