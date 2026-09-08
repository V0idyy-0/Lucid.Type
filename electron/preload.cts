import electron = require('electron')
import type { Settings } from './settings-schema.js'
import type { TranscribeResult } from './ipc.js'

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
}

contextBridge.exposeInMainWorld('whisperFlow', api)

export type WhisperFlowApi = typeof api
