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
}
