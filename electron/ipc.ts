/**
 * Types shared across the IPC boundary between {@link ./main.ts} and the
 * {@link ./preload.cts} bridge. Kept in its own module so both compilation
 * entry points agree on the shape without importing each other.
 */

/**
 * What happened to the transcript on its way back to the renderer:
 * - `off`      — the AI polish pass is disabled in settings.
 * - `polished` — Ollama returned a usable rewrite and we used it.
 * - `fallback` — polish was on but Ollama was unreachable/slow/unusable, so the
 *   regex cleaner's output was used instead.
 */
export type PolishOutcome = 'off' | 'polished' | 'fallback'

/** Result of a single {@link transcribe} call. */
export interface TranscribeResult {
  /** The final transcript, already copied to the clipboard (or pasted). */
  text: string
  /** How the AI polish pass resolved for this take. */
  polish: PolishOutcome
  /**
   * Auto-paste was requested but macOS Accessibility isn't trusted, so the
   * transcript was left on the clipboard instead of being pasted.
   */
  autoPasteBlocked: boolean
}

/** One entry in the local dictation history (final text only — no audio). */
export interface HistoryEntry {
  id: string
  /** The finished transcript as it reached the clipboard / target app. */
  text: string
  /** Character count, precomputed for the list UI. */
  chars: number
  /** Best-effort name of the app it was dictated into. */
  app?: string
  /** Unix ms when the take finished. */
  at: number
}

/** A whisper model plus whether its file is present under `bin/models/`. */
export interface ModelStatus {
  id: string
  label: string
  file: string
  sizeMB: number
  /** The model file exists locally and is ready to use. */
  downloaded: boolean
}

/** Outcome of a GitHub-releases update check (see `electron/updates.ts`). */
export interface UpdateCheckResult {
  /** The running app version. */
  current: string
  /** Latest published release version, when the check succeeded. */
  latest?: string
  /** URL of the latest release page (where the installer lives). */
  url?: string
  /** Release notes body, truncated. */
  notes?: string
  /** `latest` is strictly newer than `current`. */
  updateAvailable: boolean
  /** Unix ms of the check; 0 means "never checked this session". */
  checkedAt: number
  /** Set when the check couldn't complete (offline, rate limited, …). */
  error?: string
}

/** Progress of an in-flight model download, pushed over `model:download-progress`. */
export interface ModelDownloadProgress {
  id: string
  received: number
  /** Total bytes if the server sent Content-Length, else 0. */
  total: number
  /** Set once the download finishes or fails. */
  done?: boolean
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
