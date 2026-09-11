import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type CSSProperties,
  type KeyboardEvent as ReactKeyboardEvent,
  type ReactNode,
} from 'react'
import {
  ACCENT_SWATCHES,
  DEFAULT_SETTINGS,
  type ModelId,
  type Replacement,
  type Settings,
} from '../settings'
import type { ModelDownloadProgress, ModelStatus, UpdateCheckResult } from '../whisper-flow'
import { isModifierOnlyShortcut, validateShortcut } from '../utils/shortcutValidator'
import logo from '../assets/logo.svg'

const isMac = typeof navigator !== 'undefined' && navigator.userAgent.includes('Mac')

// Keep the frameless window draggable by its chrome while leaving controls clickable.
const DRAG: CSSProperties = { WebkitAppRegion: 'drag' } as CSSProperties
const NO_DRAG: CSSProperties = { WebkitAppRegion: 'no-drag' } as CSSProperties

// ── Native surface colours ───────────────────────────────────────────────────
// macOS System Settings palette (matched to the reference screenshot); Windows
// keeps the app's darker slate so both platforms stay legible.
const COLOR = isMac
  ? {
      shell: '#1c1c1e',
      sidebar: '#252528',
      card: '#28282b',
      toggleOff: '#3b3b3d',
    }
  : {
      shell: '#0e0f17',
      sidebar: '#18181b',
      card: '#1a1a1f',
      toggleOff: '#3f3f46',
    }
/** Apple system blue — active nav pill and "on" toggles. */
const APPLE_BLUE = '#0063e5'

// ── About / links ─────────────────────────────────────────────────────────
const REPO = 'https://github.com/V0idyy-0/Lucid.Type'
const ABOUT_LINKS = [
  { label: 'Releases', url: `${REPO}/releases` },
  { label: 'Report an issue', url: `${REPO}/issues` },
]

/** One line describing where the app stands relative to the latest release. */
function updateSummary(checking: boolean, status: UpdateCheckResult | null): string {
  if (checking) return 'Checking for updates…'
  if (!status || status.checkedAt === 0) return 'Check GitHub for a newer release'
  if (status.error) return status.error
  if (status.updateAvailable) return `Version ${status.latest} is available`
  return "You're on the latest version"
}

/** GitHub mark, inlined so there's no icon dependency to ship. */
function GithubGlyph() {
  return (
    <svg width="22" height="22" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
      <path d="M12 .5C5.37.5 0 5.87 0 12.5c0 5.3 3.44 9.8 8.21 11.39.6.11.82-.26.82-.58 0-.29-.01-1.04-.02-2.05-3.34.73-4.04-1.61-4.04-1.61-.55-1.39-1.34-1.76-1.34-1.76-1.09-.75.08-.73.08-.73 1.2.08 1.84 1.24 1.84 1.24 1.07 1.84 2.81 1.31 3.5 1 .11-.78.42-1.31.76-1.61-2.67-.3-5.47-1.34-5.47-5.96 0-1.32.47-2.39 1.24-3.23-.12-.3-.54-1.53.12-3.18 0 0 1.01-.32 3.3 1.23a11.5 11.5 0 0 1 6 0c2.29-1.55 3.3-1.23 3.3-1.23.66 1.65.24 2.88.12 3.18.77.84 1.24 1.91 1.24 3.23 0 4.63-2.81 5.65-5.49 5.95.43.37.81 1.1.81 2.22 0 1.61-.01 2.9-.01 3.29 0 .32.22.7.83.58A12.01 12.01 0 0 0 24 12.5C24 5.87 18.63.5 12 .5Z" />
    </svg>
  )
}

const MODIFIER_CODES = new Set([
  'ShiftLeft',
  'ShiftRight',
  'ControlLeft',
  'ControlRight',
  'AltLeft',
  'AltRight',
  'MetaLeft',
  'MetaRight',
])

/** Map a keydown to an Electron accelerator key name, or null for a bare modifier. */
function keyName(e: ReactKeyboardEvent): string | null {
  const { code, key } = e
  if (MODIFIER_CODES.has(code)) return null
  if (/^Key[A-Z]$/.test(code)) return code.slice(3)
  if (/^Digit\d$/.test(code)) return code.slice(5)
  if (/^Numpad\d$/.test(code)) return `num${code.slice(6)}`
  if (/^F\d{1,2}$/.test(code)) return code

  const named: Record<string, string> = {
    Space: 'Space',
    Enter: 'Return',
    Tab: 'Tab',
    Backspace: 'Backspace',
    Delete: 'Delete',
    ArrowUp: 'Up',
    ArrowDown: 'Down',
    ArrowLeft: 'Left',
    ArrowRight: 'Right',
    Minus: '-',
    Equal: '=',
    BracketLeft: '[',
    BracketRight: ']',
    Semicolon: ';',
    Quote: "'",
    Comma: ',',
    Period: '.',
    Slash: '/',
    Backquote: '`',
    Backslash: '\\',
  }
  if (code in named) return named[code]
  return key.length === 1 ? key.toUpperCase() : null
}

/**
 * Build an Electron accelerator from a keydown. `complete` is false while only
 * modifiers are held, or when a bare key without a modifier isn't allowed as a
 * global shortcut (function keys are the exception).
 */
function toAccelerator(e: ReactKeyboardEvent): { accelerator: string; complete: boolean } {
  const mods: string[] = []
  if (e.ctrlKey || e.metaKey) mods.push('CommandOrControl')
  if (e.altKey) mods.push('Alt')
  if (e.shiftKey) mods.push('Shift')

  const k = keyName(e)
  if (!k) return { accelerator: mods.join('+'), complete: false }

  const isFunctionKey = /^F\d{1,2}$/.test(k)
  return { accelerator: [...mods, k].join('+'), complete: mods.length > 0 || isFunctionKey }
}

const KEY_GLYPHS: Record<string, string> = {
  CommandOrControl: isMac ? '⌘' : 'Ctrl',
  CmdOrCtrl: isMac ? '⌘' : 'Ctrl',
  Command: '⌘',
  Cmd: '⌘',
  Control: 'Ctrl',
  Ctrl: 'Ctrl',
  Alt: isMac ? '⌥' : 'Alt',
  Option: '⌥',
  Shift: isMac ? '⇧' : 'Shift',
  Super: isMac ? '⌘' : 'Win',
  Meta: isMac ? '⌘' : 'Win',
}

/** Split an accelerator into per-key labels with platform-native glyphs. */
function keyParts(accelerator: string): string[] {
  return accelerator.split('+').map((p) => KEY_GLYPHS[p] ?? p)
}

/** Flat accelerator string for aria labels. */
function prettyKey(accelerator: string): string {
  return keyParts(accelerator).join(isMac ? ' ' : ' + ')
}

/** A held modifier, tracked by its own flag rather than merged into the
 *  "CommandOrControl" pseudo-token {@link toAccelerator} uses — needed so a
 *  modifier-only capture (see {@link HotkeyRecorder}) can tell physical
 *  Control and Command apart, since e.g. "Control+Alt" and "Command+Alt" are
 *  different combos there, unlike a regular modifier+key shortcut. */
type ModifierToken = 'Control' | 'Command' | 'Alt' | 'Shift'
const MODIFIER_TOKEN_ORDER: readonly ModifierToken[] = ['Control', 'Command', 'Alt', 'Shift']

/** Which modifiers a keyboard event currently has held, as literal tokens. */
function heldModifierTokens(e: ReactKeyboardEvent): Set<ModifierToken> {
  const held = new Set<ModifierToken>()
  if (e.ctrlKey) held.add('Control')
  if (e.metaKey) held.add('Command')
  if (e.altKey) held.add('Alt')
  if (e.shiftKey) held.add('Shift')
  return held
}

/**
 * A capture-on-click hotkey button: shows the current accelerator as
 * {@link KeyBadge}s, and on click starts listening for the next keydown to
 * rebind it. Self-contained (owns its own capture/error state) so the toggle
 * and push-to-talk rows in the Shortcuts tab can each have one independently.
 * `otherValue` is the sibling row's current accelerator, rejected as a
 * duplicate so the two triggers can never collide. `allowClear` shows a
 * control to reset the value to `''` (only meaningful for push-to-talk, where
 * empty is a valid "disabled" state). `allowModifierOnly` additionally lets
 * the user finish a capture by holding two or more modifiers together and
 * releasing them, with no regular key — push-to-talk's alternative to a
 * modifier+key combo (e.g. Wispr Flow's "hold Control+Option" fallback).
 * Toggle mode doesn't offer this: `electron.globalShortcut` can't register a
 * modifier-only accelerator, so it wouldn't actually work as a toggle key.
 */
function HotkeyRecorder({
  value,
  otherValue,
  accent,
  allowClear,
  allowModifierOnly,
  onCapturingChange,
  onChange,
}: {
  value: string
  otherValue: string
  accent: string
  allowClear?: boolean
  allowModifierOnly?: boolean
  onCapturingChange?: (capturing: boolean) => void
  onChange: (accelerator: string) => void
}) {
  const [capturing, setCapturing] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const btnRef = useRef<HTMLButtonElement>(null)
  // Modifiers seen at any point during the in-progress capture attempt, for
  // the modifier-only completion path below. Cleared whenever a capture
  // attempt starts or ends.
  const heldMods = useRef<Set<ModifierToken>>(new Set())

  const setCapturingState = (next: boolean) => {
    setCapturing(next)
    onCapturingChange?.(next)
  }

  const finish = (accelerator: string) => {
    const platform = window.whisperFlow?.platform ?? (isMac ? 'darwin' : 'win32')
    const { ok, error: validationError } = validateShortcut(accelerator, { platform })
    if (!ok) {
      setError(validationError)
      return
    }
    if (otherValue && accelerator === otherValue) {
      setError('Already used by the other shortcut')
      return
    }

    setError(null)
    setCapturingState(false)
    btnRef.current?.blur()
    onChange(accelerator)
  }

  const onKeyDown = (e: ReactKeyboardEvent<HTMLButtonElement>) => {
    e.preventDefault()
    e.stopPropagation()
    if (e.key === 'Escape') {
      setCapturingState(false)
      setError(null)
      heldMods.current.clear()
      return
    }
    if (allowModifierOnly) {
      for (const mod of heldModifierTokens(e)) heldMods.current.add(mod)
    }
    const { accelerator, complete } = toAccelerator(e)
    if (!complete) return
    finish(accelerator)
  }

  // Only relevant when `allowModifierOnly`: releasing the last held modifier
  // with no regular key pressed yet finishes the capture as that modifier
  // combo, e.g. holding Control+Alt then letting go both.
  const onKeyUp = (e: ReactKeyboardEvent<HTMLButtonElement>) => {
    if (!allowModifierOnly) return
    e.preventDefault()
    e.stopPropagation()
    if (e.ctrlKey || e.metaKey || e.altKey || e.shiftKey) return // still holding something
    const mods = heldMods.current
    heldMods.current = new Set()
    // Require at least two modifiers — a bare single one (just Shift, say)
    // is far too easy to trigger by accident to accept as a whole combo.
    if (mods.size < 2) return
    finish(MODIFIER_TOKEN_ORDER.filter((m) => mods.has(m)).join('+'))
  }

  const showsModifierOnlyHint = !capturing && !error && value && isModifierOnlyShortcut(value)

  return (
    <span className="flex flex-col items-end gap-1">
      <span className="flex items-center gap-1.5">
        <button
          ref={btnRef}
          type="button"
          style={NO_DRAG}
          onClick={() => {
            setCapturingState(!capturing)
            setError(null)
            heldMods.current.clear()
          }}
          onKeyDown={capturing ? onKeyDown : undefined}
          onKeyUp={capturing ? onKeyUp : undefined}
          onBlur={() => {
            setCapturingState(false)
            setError(null)
            heldMods.current.clear()
          }}
          aria-label={`Change shortcut, currently ${value ? prettyKey(value) : 'not set'}`}
          className="flex shrink-0 items-center gap-1"
        >
          {capturing ? (
            <span
              className="rounded border px-2 py-0.5 font-mono text-xs"
              style={{
                borderColor: accent,
                color: accent,
                backgroundColor: 'color-mix(in srgb, currentColor 12%, transparent)',
              }}
            >
              Press keys…
            </span>
          ) : value ? (
            keyParts(value).map((k, i) => <KeyBadge key={i}>{k}</KeyBadge>)
          ) : (
            <span className="rounded border border-dashed border-white/15 px-2 py-0.5 text-[11px] text-zinc-500">
              Not set
            </span>
          )}
        </button>
        {allowClear && value && !capturing && (
          <button
            type="button"
            style={NO_DRAG}
            onClick={() => onChange('')}
            aria-label="Clear shortcut"
            className="px-0.5 text-sm leading-none text-zinc-500 hover:text-zinc-300"
          >
            ×
          </button>
        )}
      </span>
      {capturing && (
        <span className="text-[11px] text-zinc-500">
          Hold a modifier ({isMac ? '⌘ / ⌥ / ⌃' : 'Ctrl / Alt'}) and a key, use a function key
          {allowModifierOnly ? ', or hold two modifiers alone and release them' : ''}. Esc to cancel.
        </span>
      )}
      {error && (
        <span className="text-[11px] text-red-400" role="alert">
          {error}
        </span>
      )}
      {showsModifierOnlyHint && (
        <span className="max-w-[220px] text-right text-[11px] text-amber-400/80">
          Won't be blocked from other apps while held, and may conflict with AltGr on some
          keyboard layouts.
        </span>
      )}
    </span>
  )
}

// ── Sidebar icons (16px Lucide glyphs, inlined so there's no dep to ship) ─────
const TAB_ICON_PATHS: Record<TabId, ReactNode> = {
  general: (
    <>
      <line x1="21" x2="14" y1="4" y2="4" />
      <line x1="10" x2="3" y1="4" y2="4" />
      <line x1="21" x2="12" y1="12" y2="12" />
      <line x1="8" x2="3" y1="12" y2="12" />
      <line x1="21" x2="16" y1="20" y2="20" />
      <line x1="12" x2="3" y1="20" y2="20" />
      <line x1="14" x2="14" y1="2" y2="6" />
      <line x1="8" x2="8" y1="10" y2="14" />
      <line x1="16" x2="16" y1="18" y2="22" />
    </>
  ),
  shortcuts: (
    <>
      <path d="M10 8h.01" />
      <path d="M12 12h.01" />
      <path d="M14 8h.01" />
      <path d="M16 12h.01" />
      <path d="M18 8h.01" />
      <path d="M6 8h.01" />
      <path d="M7 16h10" />
      <path d="M8 12h.01" />
      <rect width="20" height="16" x="2" y="4" rx="2" />
    </>
  ),
  models: (
    <>
      <path d="M9.937 15.5A2 2 0 0 0 8.5 14.063l-6.135-1.582a.5.5 0 0 1 0-.962L8.5 9.936A2 2 0 0 0 9.937 8.5l1.582-6.135a.5.5 0 0 1 .962 0L14.063 8.5A2 2 0 0 0 15.5 9.937l6.135 1.581a.5.5 0 0 1 0 .964L15.5 14.063a2 2 0 0 0-1.437 1.437l-1.582 6.135a.5.5 0 0 1-.962 0z" />
      <path d="M20 3v4" />
      <path d="M22 5h-4" />
      <path d="M4 17v2" />
      <path d="M5 18H3" />
    </>
  ),
  vocabulary: (
    <>
      <path d="M12 7v14" />
      <path d="M3 18a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1h5a4 4 0 0 1 4 4 4 4 0 0 1 4-4h5a1 1 0 0 1 1 1v13a1 1 0 0 1-1 1h-6a3 3 0 0 0-3 3 3 3 0 0 0-3-3z" />
    </>
  ),
  appearance: (
    <>
      <circle cx="13.5" cy="6.5" r=".5" fill="currentColor" />
      <circle cx="17.5" cy="10.5" r=".5" fill="currentColor" />
      <circle cx="8.5" cy="7.5" r=".5" fill="currentColor" />
      <circle cx="6.5" cy="12.5" r=".5" fill="currentColor" />
      <path d="M12 2C6.5 2 2 6.5 2 12s4.5 10 10 10c.926 0 1.648-.746 1.648-1.688 0-.437-.18-.835-.437-1.125-.29-.289-.438-.652-.438-1.125a1.64 1.64 0 0 1 1.668-1.668h1.996c3.051 0 5.555-2.503 5.555-5.554C21.965 6.012 17.461 2 12 2Z" />
    </>
  ),
  about: (
    <>
      <circle cx="12" cy="12" r="10" />
      <path d="M12 16v-4" />
      <path d="M12 8h.01" />
    </>
  ),
}

function TabIcon({ id }: { id: TabId }) {
  return (
    <svg
      aria-hidden="true"
      width="16"
      height="16"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      className="shrink-0"
    >
      {TAB_ICON_PATHS[id]}
    </svg>
  )
}

const TABS = [
  { id: 'general', label: 'General' },
  { id: 'shortcuts', label: 'Shortcuts' },
  { id: 'vocabulary', label: 'Vocabulary' },
  { id: 'models', label: 'AI & Models' },
  { id: 'appearance', label: 'Appearance' },
  { id: 'about', label: 'About' },
] as const
type TabId = (typeof TABS)[number]['id']

/** Small bold category header sitting directly above a card. */
function CategoryLabel({ children }: { children: ReactNode }) {
  return (
    <h2 className="mb-1.5 mt-5 text-[12px] font-semibold text-zinc-300 first:mt-0">{children}</h2>
  )
}

/** Inset dark card that groups related setting rows (hairline-divided). */
function Card({ children }: { children: ReactNode }) {
  return (
    <div
      className="divide-y divide-white/[0.06] overflow-hidden rounded-[10px] border border-white/[0.08]"
      style={{ backgroundColor: COLOR.card }}
    >
      {children}
    </div>
  )
}

/** A single row inside a {@link Card}. */
function CardRow({
  title,
  hint,
  children,
  align = 'center',
}: {
  title: string
  hint?: string
  children: ReactNode
  align?: 'center' | 'start'
}) {
  return (
    <div
      className={`flex justify-between gap-4 px-3.5 py-2.5 ${
        align === 'center' ? 'items-center' : 'items-start'
      }`}
    >
      <span className="flex min-w-0 flex-col gap-0.5">
        <span className="text-[13px] text-[#e1e1e1]">{title}</span>
        {hint && <span className="text-[11px] leading-snug text-zinc-500">{hint}</span>}
      </span>
      <span className="shrink-0">{children}</span>
    </div>
  )
}

/** A single native key badge, e.g. ⌘ or Space. */
function KeyBadge({ children }: { children: ReactNode }) {
  return (
    <kbd className="rounded border border-white/10 bg-[#38383a] px-1.5 py-0.5 font-mono text-[11px] text-zinc-200">
      {children}
    </kbd>
  )
}

/** macOS-style toggle: blue track when on, dark-grey when off, white thumb. */
function Toggle({
  checked,
  accent,
  onChange,
  label,
}: {
  checked: boolean
  accent: string
  onChange: (value: boolean) => void
  label: string
}) {
  // Windows keeps the user's accent for "on"; macOS uses system blue.
  const onColor = isMac ? APPLE_BLUE : accent
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      onClick={() => onChange(!checked)}
      style={{ ...NO_DRAG, backgroundColor: checked ? onColor : COLOR.toggleOff }}
      className="relative h-[22px] w-[38px] shrink-0 rounded-full transition-colors duration-200"
    >
      <span
        className="absolute left-0.5 top-0.5 h-[18px] w-[18px] rounded-full bg-white shadow-sm transition-transform duration-200 ease-out"
        style={{ transform: checked ? 'translateX(16px)' : 'translateX(0)' }}
      />
    </button>
  )
}

function PillPreview({ accent }: { accent: string }) {
  return (
    <div
      className="flex w-fit items-center gap-2.5 rounded-full border border-white/10 bg-black/40 px-3.5 py-2"
      style={{ boxShadow: `0 0 0 1px color-mix(in srgb, ${accent} 35%, transparent)` }}
    >
      <span className="flex h-4 items-end gap-[3px]" style={{ color: accent }}>
        {[0.5, 0.95, 0.65, 1].map((h, i) => (
          <span
            key={i}
            className="w-[3px] rounded-full bg-current"
            style={{ height: `${h * 100}%` }}
          />
        ))}
      </span>
      <span className="text-xs text-zinc-400">Listening…</span>
    </div>
  )
}

/**
 * Vocabulary + find/replace editor. Keeps its edits in local state and only
 * pushes them to the store on blur, so a controlled `<textarea>` doesn't fight
 * the user's cursor on every keystroke.
 */
function VocabularyPanel({
  vocabulary,
  replacements,
  commit,
}: {
  vocabulary: string[]
  replacements: Replacement[]
  commit: (patch: Partial<Settings>) => void
}) {
  const [text, setText] = useState(vocabulary.join('\n'))
  const [rows, setRows] = useState<Replacement[]>(replacements)

  // Re-sync when the stored value changes from elsewhere (another window, a
  // reset) — the render-phase "adjust state when a prop changes" pattern, so a
  // blur-commit round-trip doesn't stomp what the user is mid-edit.
  const [syncedVocab, setSyncedVocab] = useState(vocabulary)
  if (vocabulary !== syncedVocab) {
    setSyncedVocab(vocabulary)
    setText(vocabulary.join('\n'))
  }
  const [syncedRules, setSyncedRules] = useState(replacements)
  if (replacements !== syncedRules) {
    setSyncedRules(replacements)
    setRows(replacements)
  }

  const commitVocab = () => {
    const terms = text
      .split('\n')
      .map((t) => t.trim())
      .filter(Boolean)
    commit({ vocabulary: terms })
  }

  const commitRows = (next: Replacement[]) => {
    setRows(next)
    commit({ replacements: next.filter((r) => r.from.trim()) })
  }

  const inputClass =
    'min-w-0 flex-1 rounded-md border border-white/10 bg-[#323234] px-2 py-1 text-[12px] text-[#e1e1e1] outline-none placeholder:text-zinc-600 focus:border-white/25'

  return (
    <>
      <CategoryLabel>Spelling hints</CategoryLabel>
      <p className="pb-2 text-[11px] leading-relaxed text-zinc-500">
        Names, jargon, and acronyms you want recognised. One per line — Lucid Type feeds them to
        whisper as a hint.
      </p>
      <textarea
        value={text}
        onChange={(e) => setText(e.target.value)}
        onBlur={commitVocab}
        spellCheck={false}
        rows={6}
        placeholder={'Kubernetes\nGraphQL\nNaledi'}
        className="w-full resize-y rounded-[10px] border border-white/[0.08] bg-[#28282b] p-3 font-mono text-[12px] leading-relaxed text-zinc-100 outline-none focus:border-white/25"
      />

      <CategoryLabel>Replacements</CategoryLabel>
      <p className="pb-2 text-[11px] leading-relaxed text-zinc-500">
        Rewrite finished text — expand shorthand, fix a spelling whisper always gets wrong. Matching
        is case-insensitive.
      </p>
      <div className="flex flex-col gap-2">
        {rows.map((row, i) => (
          <div key={i} className="flex items-center gap-2" style={NO_DRAG}>
            <input
              value={row.from}
              onChange={(e) =>
                setRows(rows.map((r, j) => (j === i ? { ...r, from: e.target.value } : r)))
              }
              onBlur={() => commitRows(rows)}
              placeholder="heard this"
              className={inputClass}
            />
            <span aria-hidden className="text-zinc-600">
              →
            </span>
            <input
              value={row.to}
              onChange={(e) =>
                setRows(rows.map((r, j) => (j === i ? { ...r, to: e.target.value } : r)))
              }
              onBlur={() => commitRows(rows)}
              placeholder="write this"
              className={inputClass}
            />
            <button
              type="button"
              aria-label="Remove replacement"
              onClick={() => commitRows(rows.filter((_, j) => j !== i))}
              className="shrink-0 rounded-md px-1.5 py-1 text-zinc-500 transition-colors hover:bg-white/10 hover:text-red-400"
            >
              ✕
            </button>
          </div>
        ))}
        <button
          type="button"
          style={NO_DRAG}
          onClick={() => setRows([...rows, { from: '', to: '' }])}
          className="self-start rounded-md border border-white/10 bg-[#323234] px-2.5 py-1 text-[12px] text-zinc-300 transition-colors hover:bg-[#3d3d40]"
        >
          Add replacement
        </button>
      </div>
    </>
  )
}

export default function SettingsModal() {
  // Outside Electron (e.g. plain Vite) there's nothing to load — fall straight
  // back to the defaults so the window still renders.
  const [settings, setSettings] = useState<Settings | null>(() =>
    window.whisperFlow ? null : DEFAULT_SETTINGS,
  )
  const [tab, setTab] = useState<TabId>('general')
  // Whether either Shortcuts-tab hotkey recorder is mid-capture — gates the
  // window-level Escape handler below so Esc cancels the capture instead of
  // closing Settings.
  const [capturingHotkey, setCapturingHotkey] = useState(false)

  const [models, setModels] = useState<ModelStatus[]>([])
  const [download, setDownload] = useState<ModelDownloadProgress | null>(null)
  const [version, setVersion] = useState('')
  const [updateStatus, setUpdateStatus] = useState<UpdateCheckResult | null>(null)
  const [updateDialog, setUpdateDialog] = useState(false)
  const [checking, setChecking] = useState(false)

  useEffect(() => {
    const api = window.whisperFlow
    if (!api) return
    void api.getSettings().then(setSettings)
    void api.listModels().then(setModels)
    void api.getVersion().then(setVersion)
    void api.getUpdateStatus().then(setUpdateStatus)
    const offSettings = api.onSettingsChanged(setSettings)
    const offProgress = api.onModelDownloadProgress((p) => {
      setDownload(p.done && !p.error ? null : p)
      if (p.done) void api.listModels().then(setModels)
    })
    const offUpdate = api.onUpdateStatus((next) => {
      setUpdateStatus(next)
      setChecking(false)
    })
    return () => {
      offSettings()
      offProgress()
      offUpdate()
    }
  }, [])

  // Every interaction persists straight to electron-store; there's no Save step.
  const commit = useCallback((patch: Partial<Settings>) => {
    setSettings((prev) => (prev ? { ...prev, ...patch } : prev))
    void window.whisperFlow?.updateSettings(patch)
  }, [])

  const chooseModel = useCallback(
    (id: ModelId) => {
      const status = models.find((m) => m.id === id)
      if (status && !status.downloaded) {
        // Download first; only switch to it once the file is actually on disk
        // (until then transcription would fall back to base.en anyway).
        setDownload({ id, received: 0, total: 0 })
        void window.whisperFlow
          ?.downloadModel(id)
          .then((list) => {
            setModels(list)
            setDownload(null)
            commit({ model: id })
          })
          .catch((err: unknown) => {
            setDownload({
              id,
              received: 0,
              total: 0,
              done: true,
              error: err instanceof Error ? err.message : 'Download failed',
            })
          })
        return
      }
      commit({ model: id })
    },
    [models, commit],
  )

  const close = useCallback(() => {
    if (window.whisperFlow) window.whisperFlow.closeSettings()
    else window.close()
  }, [])

  // Manual update check — pops the result dialog, mirroring the tray item.
  const runUpdateCheck = useCallback(() => {
    setUpdateDialog(true)
    setChecking(true)
    void window.whisperFlow?.checkForUpdates().then((next) => {
      setUpdateStatus(next)
      setChecking(false)
    })
  }, [])

  // Esc closes the update dialog if it's open, else the window — unless we're
  // mid hotkey-capture, where it cancels the capture instead.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape' || capturingHotkey) return
      if (updateDialog) setUpdateDialog(false)
      else close()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [capturingHotkey, close, updateDialog])

  const platformClass = isMac ? 'platform-mac' : 'platform-win'

  if (!settings) {
    return (
      <div
        className={`grid h-screen w-screen place-items-center text-sm text-zinc-500 ${platformClass}`}
        style={{ backgroundColor: COLOR.shell }}
      >
        Loading…
      </div>
    )
  }

  const accent = settings.accentColor

  const activeLabel = TABS.find((t) => t.id === tab)?.label ?? ''

  const selectClass =
    'cursor-pointer rounded-md border border-white/10 bg-[#323234] px-2 py-1 text-[12px] text-[#e1e1e1] outline-none transition-colors hover:bg-[#3d3d40]'

  return (
    <div
      className={`relative flex h-screen w-screen overflow-hidden text-zinc-100 antialiased ${platformClass}`}
      style={{ backgroundColor: COLOR.shell }}
    >
      {/* Left sidebar — draggable chrome. 210px on macOS to clear the traffic lights. */}
      <nav
        style={{ ...DRAG, backgroundColor: COLOR.sidebar }}
        className={`flex shrink-0 flex-col gap-0.5 border-r border-white/10 p-2 ${
          isMac ? 'w-[210px] pt-9' : 'w-[200px] pt-4'
        }`}
      >
        {TABS.map((t) => {
          const active = t.id === tab
          return (
            <button
              key={t.id}
              type="button"
              style={NO_DRAG}
              onClick={() => setTab(t.id)}
              className={`flex items-center gap-2 rounded-md px-3 py-1.5 text-left text-[13px] transition-colors ${
                active
                  ? 'bg-[#0063e5] font-medium text-white'
                  : 'text-[#dedede] hover:bg-white/5'
              }`}
            >
              <TabIcon id={t.id} />
              {t.label}
            </button>
          )
        })}
      </nav>

      {/* Right content pane */}
      <main className="flex flex-1 flex-col overflow-hidden" style={{ backgroundColor: COLOR.shell }}>
        <div style={DRAG} className="shrink-0 px-5 pt-3">
          <div className="mb-4 flex items-center justify-between border-b border-white/10 pb-3">
            <h1 className="text-[17px] font-bold text-white">{activeLabel}</h1>
            {tab === 'about' ? (
              <button
                type="button"
                style={NO_DRAG}
                onClick={runUpdateCheck}
                className="rounded-md border border-white/10 bg-[#323234] px-2.5 py-1 text-[12px] text-zinc-300 transition-colors hover:bg-[#3d3d40]"
              >
                Check for Updates…
              </button>
            ) : (
              <button
                type="button"
                style={NO_DRAG}
                onClick={() => window.whisperFlow?.quit()}
                className="rounded-md border border-white/10 bg-[#323234] px-2.5 py-1 text-[12px] text-zinc-300 transition-colors hover:bg-[#3d3d40]"
              >
                Quit app
              </button>
            )}
          </div>
        </div>

        <div className="flex-1 overflow-y-auto px-5 pb-6" style={NO_DRAG}>
          {tab === 'general' && (
            <>
              <CategoryLabel>Transcription</CategoryLabel>
              <Card>
                <CardRow
                  title="Auto-paste transcript"
                  hint="Paste into the focused app as soon as dictation ends"
                >
                  <Toggle
                    label="Auto-paste transcript"
                    checked={settings.autoPaste}
                    accent={accent}
                    onChange={(v) => commit({ autoPaste: v })}
                  />
                </CardRow>
                <CardRow title="Strip filler words" hint={'Remove "um", "uh", "like", "you know"'}>
                  <Toggle
                    label="Strip filler words"
                    checked={settings.stripFillerWords}
                    accent={accent}
                    onChange={(v) => commit({ stripFillerWords: v })}
                  />
                </CardRow>
              </Card>

              <CategoryLabel>Feedback</CategoryLabel>
              <Card>
                <CardRow title="Sound effects" hint="Play a soft chime on start and stop">
                  <Toggle
                    label="Sound effects"
                    checked={settings.soundEffects}
                    accent={accent}
                    onChange={(v) => commit({ soundEffects: v })}
                  />
                </CardRow>
              </Card>

              <CategoryLabel>History</CategoryLabel>
              <Card>
                <CardRow
                  title="Save dictation history"
                  hint="Keep a local log of finished transcripts. Nothing leaves your machine."
                >
                  <Toggle
                    label="Save dictation history"
                    checked={settings.saveHistory}
                    accent={accent}
                    onChange={(v) => commit({ saveHistory: v })}
                  />
                </CardRow>
                <CardRow title="Keep the last" hint="Older entries are dropped automatically">
                  <select
                    style={NO_DRAG}
                    value={settings.historyLimit}
                    onChange={(e) => commit({ historyLimit: Number(e.target.value) })}
                    aria-label="History entries to keep"
                    className={selectClass}
                    disabled={!settings.saveHistory}
                  >
                    {[25, 50, 100, 250, 500].map((n) => (
                      <option key={n} value={n}>
                        {n} entries
                      </option>
                    ))}
                  </select>
                </CardRow>
                <CardRow title="Dictation history" hint="Open the log, or wipe it">
                  <span className="flex gap-2" style={NO_DRAG}>
                    <button
                      type="button"
                      onClick={() => window.whisperFlow?.openHistory()}
                      className={selectClass}
                    >
                      Open
                    </button>
                    <button
                      type="button"
                      onClick={() => void window.whisperFlow?.clearHistory()}
                      className="cursor-pointer rounded-md border border-white/10 bg-[#323234] px-2 py-1 text-[12px] text-zinc-300 transition-colors hover:bg-[#3d3d40] hover:text-red-400"
                    >
                      Clear
                    </button>
                  </span>
                </CardRow>
              </Card>

              <CategoryLabel>Startup</CategoryLabel>
              <Card>
                <CardRow
                  title="Launch at login"
                  hint="Start Lucid Type in the menu bar when you log in — no window, no relaunch"
                >
                  <Toggle
                    label="Launch at login"
                    checked={settings.launchAtLogin}
                    accent={accent}
                    onChange={(v) => commit({ launchAtLogin: v })}
                  />
                </CardRow>
              </Card>
            </>
          )}

          {tab === 'shortcuts' && (
            <>
              <CategoryLabel>Dictation</CategoryLabel>
              <Card>
                <CardRow
                  title="Toggle shortcut"
                  hint="Tap once to start, tap again to stop — works anywhere, even in the background"
                  align="start"
                >
                  <HotkeyRecorder
                    value={settings.toggleHotkey}
                    otherValue={settings.pttHotkey}
                    accent={accent}
                    onCapturingChange={setCapturingHotkey}
                    onChange={(accelerator) => commit({ toggleHotkey: accelerator })}
                  />
                </CardRow>
                <CardRow
                  title="Push-to-talk shortcut"
                  hint="Hold to record, release to transcribe — optional, leave unset to disable"
                  align="start"
                >
                  <HotkeyRecorder
                    value={settings.pttHotkey}
                    otherValue={settings.toggleHotkey}
                    accent={accent}
                    allowClear
                    allowModifierOnly
                    onCapturingChange={setCapturingHotkey}
                    onChange={(accelerator) => commit({ pttHotkey: accelerator })}
                  />
                </CardRow>
              </Card>
            </>
          )}

          {tab === 'vocabulary' && (
            <VocabularyPanel
              vocabulary={settings.vocabulary}
              replacements={settings.replacements}
              commit={commit}
            />
          )}

          {tab === 'models' && (
            <>
              <CategoryLabel>Speech model</CategoryLabel>
              <Card>
                <CardRow
                  title="Models"
                  hint="Larger models are more accurate but slower to transcribe"
                  align="start"
                >
                  <select
                    style={NO_DRAG}
                    value={settings.model}
                    onChange={(e) => chooseModel(e.target.value as ModelId)}
                    aria-label="Whisper model"
                    className={selectClass}
                    disabled={!!download && !download.error}
                  >
                    {(models.length
                      ? models
                      : [{ id: settings.model, label: settings.model, downloaded: true, sizeMB: 0 }]
                    ).map((m) => (
                      <option key={m.id} value={m.id}>
                        {m.label}
                        {m.sizeMB ? ` — ${m.sizeMB} MB` : ''}
                        {m.downloaded ? '' : ' (download)'}
                      </option>
                    ))}
                  </select>
                </CardRow>
              </Card>
              {settings.model === 'small.en' &&
                models.find((m) => m.id === 'small.en')?.downloaded && (
                  <p className="pt-2 text-[11px] leading-relaxed text-zinc-500">
                    Pro can be a bit slower.
                  </p>
                )}
              {download && !download.error && (
                <div className="pt-3">
                  <div className="mb-1 flex justify-between text-[11px] text-zinc-500">
                    <span>Downloading {download.id}…</span>
                    {download.total > 0 && (
                      <span>{Math.round((download.received / download.total) * 100)}%</span>
                    )}
                  </div>
                  <div className="h-1.5 overflow-hidden rounded-full bg-white/10">
                    <div
                      className="h-full rounded-full transition-[width] duration-200"
                      style={{
                        backgroundColor: accent,
                        width: download.total
                          ? `${(download.received / download.total) * 100}%`
                          : '35%',
                      }}
                    />
                  </div>
                </div>
              )}
              {download?.error && (
                <p className="pt-2 text-xs text-red-400" role="alert">
                  {download.error}
                </p>
              )}

              <CategoryLabel>AI Text Polish</CategoryLabel>
              <Card>
                <CardRow
                  title="Polish with a local model"
                  hint="Clean up wording with a local Ollama model before pasting"
                  align="start"
                >
                  <Toggle
                    label="AI Text Polish"
                    checked={settings.useLlmPolish}
                    accent={accent}
                    onChange={(v) => commit({ useLlmPolish: v })}
                  />
                </CardRow>
              </Card>
              <p className="pt-3 text-xs leading-relaxed text-zinc-500">
                Requires Ollama running locally with{' '}
                <span className="font-mono text-zinc-400">llama3.2:1b</span> on{' '}
                <span className="font-mono text-zinc-400">localhost:11434</span>. If it isn't
                reachable, Lucid Type falls back to the built-in cleaner.
              </p>
            </>
          )}

          {tab === 'appearance' && (
            <>
              <CategoryLabel>Pill</CategoryLabel>
              <Card>
                <CardRow
                  title="Accent colour"
                  hint="Colour of the wave bars and glow"
                  align="start"
                >
                  <div className="flex max-w-[220px] flex-wrap items-center justify-end gap-2.5">
                    {ACCENT_SWATCHES.map((hex) => (
                      <button
                        key={hex}
                        type="button"
                        aria-label={hex}
                        aria-pressed={settings.accentColor === hex}
                        onClick={() => commit({ accentColor: hex })}
                        className="size-6 rounded-full transition"
                        style={{
                          backgroundColor: hex,
                          outline: `2px solid ${
                            settings.accentColor === hex ? hex : 'transparent'
                          }`,
                          outlineOffset: 2,
                        }}
                      />
                    ))}
                    <label
                      className="grid size-6 cursor-pointer place-items-center rounded-full border border-white/15 text-zinc-400 transition hover:text-zinc-100"
                      title="Custom colour"
                    >
                      <span className="text-sm leading-none">+</span>
                      <input
                        type="color"
                        value={settings.accentColor}
                        onChange={(e) => commit({ accentColor: e.target.value })}
                        className="sr-only"
                      />
                    </label>
                  </div>
                </CardRow>
              </Card>
              <div className="pt-4">
                <PillPreview accent={accent} />
              </div>
            </>
          )}

          {tab === 'about' && (
            <>
              <div className="flex flex-col items-center pb-1 pt-1 text-center">
                <img
                  src={logo}
                  alt=""
                  width={52}
                  height={49}
                  className="drop-shadow-[0_4px_20px_rgba(0,0,0,0.45)]"
                />
                <h2 className="mt-3 text-[16px] font-semibold text-white">Lucid Type</h2>
                <p className="mt-0.5 text-[12px] text-zinc-500">
                  {version ? `Version ${version}` : ' '}
                </p>
              </div>

              <CategoryLabel>Version info</CategoryLabel>
              <Card>
                <CardRow title="Application" hint="On-device dictation for macOS &amp; Windows">
                  <span className="text-[13px] text-zinc-300">Lucid Type</span>
                </CardRow>
                <CardRow title="Version">
                  <span className="text-[13px] text-zinc-300">{version || '—'}</span>
                </CardRow>
              </Card>

              <CategoryLabel>Software updates</CategoryLabel>
              <Card>
                <CardRow
                  title="Automatically check for updates"
                  hint="Check GitHub for a newer release on launch and once a day"
                >
                  <Toggle
                    label="Automatically check for updates"
                    checked={settings.autoCheckUpdates}
                    accent={accent}
                    onChange={(v) => commit({ autoCheckUpdates: v })}
                  />
                </CardRow>
                <CardRow title="Check now" hint={updateSummary(checking, updateStatus)}>
                  {updateStatus?.updateAvailable ? (
                    <button
                      type="button"
                      onClick={() => window.whisperFlow?.openDownloadPage()}
                      className="rounded-md px-2.5 py-1 text-[12px] font-semibold text-white transition-opacity hover:opacity-90"
                      style={{ backgroundColor: isMac ? APPLE_BLUE : accent }}
                    >
                      Download {updateStatus.latest}
                    </button>
                  ) : (
                    <button
                      type="button"
                      onClick={runUpdateCheck}
                      disabled={checking}
                      className={`${selectClass} disabled:opacity-50`}
                    >
                      {checking ? 'Checking…' : 'Check for updates'}
                    </button>
                  )}
                </CardRow>
              </Card>

              <CategoryLabel>Links</CategoryLabel>
              <button
                type="button"
                onClick={() => window.whisperFlow?.openExternalLink(REPO)}
                className="flex w-full flex-col items-center gap-1.5 rounded-[10px] border border-white/[0.08] py-5 text-zinc-200 transition-colors hover:bg-white/[0.04]"
                style={{ backgroundColor: COLOR.card }}
              >
                <GithubGlyph />
                <span className="text-[13px] font-medium">GitHub</span>
              </button>
              <div className="mt-3 flex justify-center gap-4 text-[12px]">
                {ABOUT_LINKS.map((l) => (
                  <button
                    key={l.url}
                    type="button"
                    onClick={() => window.whisperFlow?.openExternalLink(l.url)}
                    className="text-zinc-400 transition-colors hover:text-zinc-100"
                  >
                    {l.label}
                  </button>
                ))}
              </div>

              <p className="mt-6 text-center text-[11px] leading-relaxed text-zinc-600">
                On-device transcription by whisper.cpp. Nothing leaves your machine.
              </p>
            </>
          )}
        </div>
      </main>

      {updateDialog && (
        <div
          className="absolute inset-0 z-50 flex items-center justify-center bg-black/50 backdrop-blur-[2px]"
          style={NO_DRAG}
          onClick={() => setUpdateDialog(false)}
        >
          <div
            role="dialog"
            aria-modal="true"
            onClick={(e) => e.stopPropagation()}
            className="mx-6 flex w-[300px] flex-col items-center rounded-[16px] border border-white/10 px-6 py-6 text-center shadow-2xl"
            style={{ backgroundColor: COLOR.card }}
          >
            <img
              src={logo}
              alt=""
              width={54}
              height={51}
              className="drop-shadow-[0_4px_20px_rgba(0,0,0,0.5)]"
            />
            {checking ? (
              <>
                <p className="mt-4 text-[15px] font-semibold text-white">
                  {'Checking for updates…'}
                </p>
                <p className="mt-1 text-[12.5px] leading-snug text-zinc-400">
                  Looking for the latest Lucid Type release.
                </p>
              </>
            ) : updateStatus?.error ? (
              <>
                <p className="mt-4 text-[15px] font-semibold text-white">
                  {"Couldn't check for updates"}
                </p>
                <p className="mt-1 text-[12.5px] leading-snug text-zinc-400">
                  {updateStatus.error}
                </p>
              </>
            ) : updateStatus?.updateAvailable ? (
              <>
                <p className="mt-4 text-[15px] font-semibold text-white">Update available</p>
                <p className="mt-1 text-[12.5px] leading-snug text-zinc-400">
                  Lucid Type {updateStatus.latest} is available. You have {updateStatus.current}.
                </p>
              </>
            ) : (
              <>
                <p className="mt-4 text-[15px] font-semibold text-white">
                  {"You're up to date!"}
                </p>
                <p className="mt-1 text-[12.5px] leading-snug text-zinc-400">
                  Lucid Type {updateStatus?.current || version} is currently the newest version
                  available.
                </p>
              </>
            )}

            <div className="mt-5 flex w-full gap-2">
              {!checking && updateStatus?.updateAvailable && (
                <button
                  type="button"
                  onClick={() => {
                    window.whisperFlow?.openDownloadPage()
                    setUpdateDialog(false)
                  }}
                  className="flex-1 rounded-[10px] py-2 text-[13px] font-semibold text-white transition-opacity hover:opacity-90"
                  style={{ backgroundColor: isMac ? APPLE_BLUE : accent }}
                >
                  Download
                </button>
              )}
              <button
                type="button"
                onClick={() => setUpdateDialog(false)}
                disabled={checking}
                className={
                  !checking && updateStatus?.updateAvailable
                    ? 'flex-1 rounded-[10px] border border-white/10 bg-white/5 py-2 text-[13px] text-zinc-200 transition-colors hover:bg-white/10'
                    : 'flex-1 rounded-[10px] py-2 text-[13px] font-semibold text-white transition-opacity hover:opacity-90 disabled:opacity-60'
                }
                style={
                  !checking && updateStatus?.updateAvailable
                    ? undefined
                    : { backgroundColor: isMac ? APPLE_BLUE : accent }
                }
              >
                {checking ? 'Please wait…' : updateStatus?.updateAvailable ? 'Later' : 'OK'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
