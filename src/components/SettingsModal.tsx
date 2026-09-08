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
  type DictationMode,
  type Settings,
} from '../settings'
import { validateShortcut } from '../utils/shortcutValidator'

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
  appearance: (
    <>
      <circle cx="13.5" cy="6.5" r=".5" fill="currentColor" />
      <circle cx="17.5" cy="10.5" r=".5" fill="currentColor" />
      <circle cx="8.5" cy="7.5" r=".5" fill="currentColor" />
      <circle cx="6.5" cy="12.5" r=".5" fill="currentColor" />
      <path d="M12 2C6.5 2 2 6.5 2 12s4.5 10 10 10c.926 0 1.648-.746 1.648-1.688 0-.437-.18-.835-.437-1.125-.29-.289-.438-.652-.438-1.125a1.64 1.64 0 0 1 1.668-1.668h1.996c3.051 0 5.555-2.503 5.555-5.554C21.965 6.012 17.461 2 12 2Z" />
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
  { id: 'models', label: 'AI & Models' },
  { id: 'appearance', label: 'Appearance' },
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

export default function SettingsModal() {
  // Outside Electron (e.g. plain Vite) there's nothing to load — fall straight
  // back to the defaults so the window still renders.
  const [settings, setSettings] = useState<Settings | null>(() =>
    window.whisperFlow ? null : DEFAULT_SETTINGS,
  )
  const [tab, setTab] = useState<TabId>('general')
  const [capturing, setCapturing] = useState(false)
  const [shortcutError, setShortcutError] = useState<string | null>(null)
  const captureBtnRef = useRef<HTMLButtonElement>(null)

  useEffect(() => {
    const api = window.whisperFlow
    if (!api) return
    void api.getSettings().then(setSettings)
    return api.onSettingsChanged(setSettings)
  }, [])

  // Every interaction persists straight to electron-store; there's no Save step.
  const commit = useCallback((patch: Partial<Settings>) => {
    setSettings((prev) => (prev ? { ...prev, ...patch } : prev))
    void window.whisperFlow?.updateSettings(patch)
  }, [])

  const close = useCallback(() => {
    if (window.whisperFlow) window.whisperFlow.closeSettings()
    else window.close()
  }, [])

  // Esc closes the window — unless we're mid hotkey-capture, where it cancels.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !capturing) close()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [capturing, close])

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

  const onCaptureKeyDown = (e: ReactKeyboardEvent<HTMLButtonElement>) => {
    e.preventDefault()
    e.stopPropagation()
    if (e.key === 'Escape') {
      setCapturing(false)
      setShortcutError(null)
      return
    }
    const { accelerator, complete } = toAccelerator(e)
    if (!complete) return

    // Reject reserved / malformed combos before they reach the store — the
    // capture stays open so the user can try another key.
    const platform = window.whisperFlow?.platform ?? (isMac ? 'darwin' : 'win32')
    const { ok, error } = validateShortcut(accelerator, { platform })
    if (!ok) {
      setShortcutError(error)
      return
    }

    setShortcutError(null)
    setCapturing(false)
    captureBtnRef.current?.blur()
    commit({ hotkey: accelerator })
  }

  const activeLabel = TABS.find((t) => t.id === tab)?.label ?? ''

  const selectClass =
    'cursor-pointer rounded-md border border-white/10 bg-[#323234] px-2 py-1 text-[12px] text-[#e1e1e1] outline-none transition-colors hover:bg-[#3d3d40]'

  return (
    <div
      className={`flex h-screen w-screen overflow-hidden text-zinc-100 antialiased ${platformClass}`}
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
            <button
              type="button"
              style={NO_DRAG}
              onClick={() => window.whisperFlow?.quit()}
              className="rounded-md border border-white/10 bg-[#323234] px-2.5 py-1 text-[12px] text-zinc-300 transition-colors hover:bg-[#3d3d40]"
            >
              Quit app
            </button>
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
            </>
          )}

          {tab === 'shortcuts' && (
            <>
              <CategoryLabel>Dictation</CategoryLabel>
              <Card>
                <CardRow
                  title="Trigger mode"
                  hint="How the shortcut controls recording"
                  align="start"
                >
                  <select
                    style={NO_DRAG}
                    value={settings.dictationMode}
                    onChange={(e) => commit({ dictationMode: e.target.value as DictationMode })}
                    aria-label="Dictation trigger mode"
                    className={selectClass}
                  >
                    <option value="toggle">Toggle (Press to Start/Stop)</option>
                    <option value="ptt">Push to Talk (Hold to Record)</option>
                  </select>
                </CardRow>
                <CardRow
                  title={settings.dictationMode === 'ptt' ? 'Hold to dictate' : 'Toggle dictation'}
                  hint={
                    settings.dictationMode === 'ptt'
                      ? 'Hold this combo to record; release to transcribe'
                      : 'Works anywhere, even when Lucid Type is in the background'
                  }
                >
                  <button
                    ref={captureBtnRef}
                    type="button"
                    style={NO_DRAG}
                    onClick={() => {
                      setCapturing((c) => !c)
                      setShortcutError(null)
                    }}
                    onKeyDown={capturing ? onCaptureKeyDown : undefined}
                    onBlur={() => {
                      setCapturing(false)
                      setShortcutError(null)
                    }}
                    aria-label={`Change shortcut, currently ${prettyKey(settings.hotkey)}`}
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
                    ) : (
                      keyParts(settings.hotkey).map((k, i) => <KeyBadge key={i}>{k}</KeyBadge>)
                    )}
                  </button>
                </CardRow>
              </Card>
              {capturing && (
                <p className="pt-3 text-xs text-zinc-500">
                  Hold a modifier ({isMac ? '⌘ / ⌥ / ⌃' : 'Ctrl / Alt'}) and a key, or use a
                  function key. Esc to cancel.
                </p>
              )}
              {shortcutError && (
                <p className="pt-2 text-xs text-red-400" role="alert">
                  {shortcutError}
                </p>
              )}
            </>
          )}

          {tab === 'models' && (
            <>
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
        </div>
      </main>
    </div>
  )
}
