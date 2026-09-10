import electron = require('electron')
import type { ModelId, Settings } from './settings-schema.js'
import type {
  HistoryEntry,
  MicrophoneAccessStatus,
  ModelDownloadProgress,
  ModelStatus,
  PermissionStatus,
  TranscribeResult,
  UpdateCheckResult,
} from './ipc.js'

const { contextBridge, ipcRenderer } = electron

/**
 * The surface exposed to the renderer as `window.whisperFlow`.
 * Keep this minimal — the renderer records audio and asks the main process
 * to run whisper.cpp over the encoded WAV.
 *
 * This file is `.cts` (CommonJS) on purpose: a sandboxed renderer in a
 * `"type": "module"` package can only load a CJS preload, so it uses
 * `import = require(...)` rather than ESM `import` syntax.
 */
const api = {
  /**
   * Send a 16 kHz mono WAV (as bytes) to whisper.cpp; resolves to the transcript
   * plus how the AI polish pass resolved for this take.
   */
  transcribe: (wav: Uint8Array): Promise<TranscribeResult> =>
    ipcRenderer.invoke('transcribe-audio', wav),

  /** The host OS, read in the preload where `process` is available. */
  platform: process.platform,

  /** Window chrome controls for the frameless pill. */
  close: (): void => ipcRenderer.send('app:close'),
  minimize: (): void => ipcRenderer.send('app:minimize'),

  /** Quit whisper-flow entirely (tray app — same as the tray's Quit item). */
  quit: (): void => ipcRenderer.send('app:quit'),

  /**
   * Tell the main process whether the pill is currently on screen. The overlay
   * window is shown while this is `true` and hidden otherwise, so the empty
   * transparent window never sits on top of the user's desktop.
   */
  setPillVisible: (visible: boolean): void =>
    ipcRenderer.send('whisper:pill-visible', visible),

  /**
   * Fires when the global toggle hotkey is pressed. Returns an unsubscribe fn.
   * The renderer uses this to start/stop recording from the keyboard.
   */
  onToggle: (fn: () => void): (() => void) => {
    const listener = () => fn()
    ipcRenderer.on('whisper:toggle', listener)
    return () => ipcRenderer.removeListener('whisper:toggle', listener)
  },

  /**
   * Push-to-talk: the main process fires this when the hotkey goes down (start
   * capturing) and {@link onRecordStop} when it comes back up. Returns an
   * unsubscribe fn.
   */
  onRecordStart: (fn: () => void): (() => void) => {
    const listener = () => fn()
    ipcRenderer.on('whisper:record-start', listener)
    return () => ipcRenderer.removeListener('whisper:record-start', listener)
  },

  /** Push-to-talk: fires when the held hotkey is released. Returns an unsubscribe fn. */
  onRecordStop: (fn: () => void): (() => void) => {
    const listener = () => fn()
    ipcRenderer.on('whisper:record-stop', listener)
    return () => ipcRenderer.removeListener('whisper:record-stop', listener)
  },

  /** Fires when the user presses Esc to abandon the current take. Returns an unsubscribe fn. */
  onCancel: (fn: () => void): (() => void) => {
    const listener = () => fn()
    ipcRenderer.on('whisper:cancel', listener)
    return () => ipcRenderer.removeListener('whisper:cancel', listener)
  },

  /** Tell the main process whether audio is being recorded right now, so it can
   *  arm/disarm the temporary Esc-to-cancel shortcut. */
  setRecording: (recording: boolean): void =>
    ipcRenderer.send('whisper:recording', recording),

  /** Read the persisted user settings. */
  getSettings: (): Promise<Settings> => ipcRenderer.invoke('get-settings'),

  /** Merge a patch into the persisted settings; resolves to the full new set. */
  updateSettings: (patch: Partial<Settings>): Promise<Settings> =>
    ipcRenderer.invoke('update-settings', patch),

  /**
   * Fires whenever settings change anywhere (this window, another window, or the
   * tray menu). Returns an unsubscribe fn.
   */
  onSettingsChanged: (fn: (settings: Settings) => void): (() => void) => {
    const listener = (_event: Electron.IpcRendererEvent, settings: Settings) => fn(settings)
    ipcRenderer.on('settings:changed', listener)
    return () => ipcRenderer.removeListener('settings:changed', listener)
  },

  /** Open the standalone Settings window (from the pill or a menu). */
  openSettings: (): void => ipcRenderer.send('settings:open'),

  /** Close the Settings window (the modal's "Done" button). */
  closeSettings: (): void => ipcRenderer.send('settings:close'),

  // ── First-run onboarding ──────────────────────────────────────────────

  /** Current OS permission snapshot for the onboarding flow. */
  getPermissionStatus: (): Promise<PermissionStatus> => ipcRenderer.invoke('permissions:status'),

  /**
   * Trigger the native microphone permission prompt where the main process can
   * (macOS); elsewhere just re-reads the status — the renderer's own
   * `getUserMedia` call is what actually surfaces the OS prompt there.
   */
  requestMicrophoneAccess: (): Promise<MicrophoneAccessStatus> =>
    ipcRenderer.invoke('permissions:request-microphone'),

  /** Trigger the native Accessibility trust prompt (macOS only). */
  requestAccessibilityAccess: (): Promise<boolean> =>
    ipcRenderer.invoke('permissions:request-accessibility'),

  /** Deep-link to the System Settings pane for a permission the user needs to
   *  toggle by hand. */
  openPermissionSettings: (kind: 'microphone' | 'accessibility'): void =>
    ipcRenderer.send('permissions:open-settings', kind),

  /** Whether the first-run onboarding flow has already been completed. */
  getOnboardingCompleted: (): Promise<boolean> => ipcRenderer.invoke('onboarding:get-completed'),

  /** Mark onboarding complete and close its window. */
  completeOnboarding: (): void => ipcRenderer.send('onboarding:complete'),

  // ── Dictation history ─────────────────────────────────────────────────

  /** All stored history entries, newest first. */
  listHistory: (): Promise<HistoryEntry[]> => ipcRenderer.invoke('history:list'),
  /** Delete one entry by id; resolves to the remaining entries. */
  deleteHistoryEntry: (id: string): Promise<HistoryEntry[]> =>
    ipcRenderer.invoke('history:delete', id),
  /** Wipe the whole history; resolves to `[]`. */
  clearHistory: (): Promise<HistoryEntry[]> => ipcRenderer.invoke('history:clear'),
  /** Open the standalone Dictation History window. */
  openHistory: (): void => ipcRenderer.send('history:open'),
  /** Fires when history changes from anywhere. Returns an unsubscribe fn. */
  onHistoryChanged: (fn: () => void): (() => void) => {
    const listener = () => fn()
    ipcRenderer.on('history:changed', listener)
    return () => ipcRenderer.removeListener('history:changed', listener)
  },
  /** Put text on the system clipboard (used by the history window's Copy). */
  writeClipboard: (text: string): void => ipcRenderer.send('clipboard:write', text),

  // ── Whisper models ────────────────────────────────────────────────────

  /** The available models plus whether each one's file is on disk. */
  listModels: (): Promise<ModelStatus[]> => ipcRenderer.invoke('models:list'),
  /** Download a model; resolves to the refreshed model list when it lands. */
  downloadModel: (id: ModelId): Promise<ModelStatus[]> =>
    ipcRenderer.invoke('models:download', id),
  /** Progress of an in-flight model download. Returns an unsubscribe fn. */
  onModelDownloadProgress: (fn: (progress: ModelDownloadProgress) => void): (() => void) => {
    const listener = (_event: Electron.IpcRendererEvent, progress: ModelDownloadProgress) =>
      fn(progress)
    ipcRenderer.on('model:download-progress', listener)
    return () => ipcRenderer.removeListener('model:download-progress', listener)
  },

  // ── About + updates ───────────────────────────────────────────────────

  /** The running app version (e.g. "1.0.0"). */
  getVersion: (): Promise<string> => ipcRenderer.invoke('app:get-version'),
  /** Open the standalone About window. */
  openAbout: (): void => ipcRenderer.send('about:open'),
  /** Run a GitHub-releases update check now; resolves to the result. */
  checkForUpdates: (): Promise<UpdateCheckResult> => ipcRenderer.invoke('updates:check'),
  /** The most recent update-check result (or a "never checked" placeholder). */
  getUpdateStatus: (): Promise<UpdateCheckResult> => ipcRenderer.invoke('updates:get-status'),
  /** Open the latest release's download page in the browser. */
  openDownloadPage: (): void => ipcRenderer.send('updates:open-download'),
  /** Fires whenever an update check completes. Returns an unsubscribe fn. */
  onUpdateStatus: (fn: (status: UpdateCheckResult) => void): (() => void) => {
    const listener = (_event: Electron.IpcRendererEvent, status: UpdateCheckResult) => fn(status)
    ipcRenderer.on('updates:status', listener)
    return () => ipcRenderer.removeListener('updates:status', listener)
  },
  /** Open an https://github.com/… link in the browser (other URLs are ignored). */
  openExternalLink: (url: string): void => ipcRenderer.send('app:open-external', url),
}

contextBridge.exposeInMainWorld('whisperFlow', api)

export type WhisperFlowApi = typeof api
