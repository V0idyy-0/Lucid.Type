/**
 * Validation for the global dictation hotkey.
 *
 * {@link validateShortcut} takes whatever the capture UI produced — an Electron
 * accelerator string (`"CommandOrControl+Shift+D"`) or an explicit token list
 * (`["ControlLeft", "Shift", "D"]`) — normalises it, and runs four rules in
 * order, returning the first failure:
 *
 *  1. **Max keys** — 3 keys or fewer. Left/Right modifier variants (e.g.
 *     `ControlLeft` vs `ControlRight`) are counted as separate keys.
 *  2. **Modifier / mouse** — the combo must contain at least one modifier
 *     (Ctrl, Cmd, Alt/Opt, Shift, Fn, or Win — either side) OR a usable mouse
 *     button (middle click, or a standalone Mouse 4–10).
 *  3. **macOS blocklist** — combos the system reserves, when `platform` is
 *     `"darwin"`.
 *  4. **Windows blocklist** — likewise, when `platform` is `"win32"`.
 *
 * Tokens are accepted in many spellings — DOM `KeyboardEvent.code`
 * (`"KeyC"`, `"Digit3"`, `"ArrowUp"`), accelerator tokens (`"C"`, `","`,
 * `"Up"`), and friendly names (`"Cmd"`, `"Option"`, `"Middle Click"`,
 * `"Mouse 4"`) — so the same validator works against the raw keydown and
 * against a stored accelerator.
 */

/** Host platform. Mirrors the strings `process.platform` can return; the two
 *  the blocklists care about are `"darwin"` and `"win32"`. */
export type ShortcutPlatform = 'darwin' | 'win32' | 'linux' | (string & {})

export interface ShortcutValidation {
  /** True when every rule passed. */
  ok: boolean
  /** The user-facing reason the combo was rejected, or null when `ok`. */
  error: string | null
}

/** The fixed error strings for the two count/shape rules. */
export const SHORTCUT_ERRORS = {
  TOO_MANY_KEYS: 'Shortcut must contain 3 or fewer keys.',
  NEEDS_MODIFIER_OR_MOUSE: 'Shortcut must include a modifier key or a valid mouse button.',
} as const

// ── Normalisation ────────────────────────────────────────────────────────────

type ModName = 'Cmd' | 'Ctrl' | 'Alt' | 'Shift' | 'Fn' | 'Win'
type Side = 'left' | 'right' | 'any'
/** `middle` — middle click (usable on its own or in a combo).
 *  `ext`    — Mouse 4–10 (only usable standalone).
 *  `primary`— left/right click (never a valid shortcut button). */
type MouseClass = 'middle' | 'ext' | 'primary'

type Token =
  | { kind: 'mod'; name: ModName; side: Side }
  | { kind: 'mouse'; name: string; mouseClass: MouseClass }
  | { kind: 'key'; name: string }

/** Canonical modifier order for the blocklist lookup key. */
const MOD_ORDER: readonly ModName[] = ['Cmd', 'Ctrl', 'Alt', 'Shift', 'Fn', 'Win']

/** Non-alphanumeric key spellings → the canonical name used in the blocklists.
 *  Looked up against both the lower-cased token and its whitespace-stripped
 *  form, so `"print screen"` and `"PrintScreen"` both land on `"PrintScreen"`. */
const KEY_ALIASES: Readonly<Record<string, string>> = {
  ' ': 'Space', space: 'Space', spacebar: 'Space', spc: 'Space',
  tab: 'Tab',
  enter: 'Enter', return: 'Enter', ret: 'Enter',
  esc: 'Esc', escape: 'Esc',
  del: 'Delete', delete: 'Delete', forwarddelete: 'Delete',
  backspace: 'Backspace', bksp: 'Backspace', bs: 'Backspace',
  up: 'Up', arrowup: 'Up',
  down: 'Down', arrowdown: 'Down',
  left: 'Left', arrowleft: 'Left',
  right: 'Right', arrowright: 'Right',
  home: 'Home', end: 'End',
  pageup: 'PageUp', pgup: 'PageUp', pagedown: 'PageDown', pgdn: 'PageDown',
  ',': 'Comma', comma: 'Comma',
  '.': 'Period', period: 'Period', dot: 'Period',
  '-': '-', minus: '-', dash: '-', hyphen: '-', subtract: '-',
  '=': '=', equal: '=', equals: '=', plus: '=', add: '=',
  printscreen: 'PrintScreen', 'print screen': 'PrintScreen', prtsc: 'PrintScreen',
  prtscn: 'PrintScreen', prntscrn: 'PrintScreen', sysrq: 'PrintScreen',
}

/** Resolve a bare modifier word (side already stripped) to its canonical name. */
function resolveModName(base: string, platform?: ShortcutPlatform): ModName | null {
  switch (base) {
    case 'ctrl':
    case 'control':
    case 'ctl':
      return 'Ctrl'
    case 'cmd':
    case 'command':
    case 'apple':
      return 'Cmd'
    case 'meta':
    case 'super':
    case 'os':
      // A bare "Meta"/"Super" is ⌘ on macOS and the Windows key elsewhere.
      return platform === 'darwin' ? 'Cmd' : 'Win'
    case 'win':
    case 'windows':
      return 'Win'
    case 'alt':
    case 'option':
    case 'opt':
    case 'altgr':
      return 'Alt'
    case 'shift':
      return 'Shift'
    case 'fn':
    case 'function':
      return 'Fn'
    case 'commandorcontrol':
    case 'cmdorctrl':
      return platform === 'darwin' ? 'Cmd' : 'Ctrl'
    default:
      return null
  }
}

/** Parse a token as a modifier, pulling out an explicit Left/Right side. */
function parseModifier(
  lower: string,
  platform?: ShortcutPlatform,
): { name: ModName; side: Side } | null {
  let base = lower.replace(/[\s._-]/g, '')
  let side: Side = 'any'
  for (const s of ['left', 'right'] as const) {
    if (base.length > s.length && base.startsWith(s)) {
      side = s
      base = base.slice(s.length)
      break
    }
    if (base.length > s.length && base.endsWith(s)) {
      side = s
      base = base.slice(0, -s.length)
      break
    }
  }
  const name = resolveModName(base, platform)
  return name ? { name, side } : null
}

/** Parse a token as a mouse button, classifying how it may be used. */
function parseMouse(lower: string): { name: string; mouseClass: MouseClass } | null {
  const compact = lower.replace(/[\s._-]/g, '')
  if (
    compact === 'middleclick' ||
    compact === 'middlemouse' ||
    compact === 'middlemousebutton' ||
    compact === 'mmb' ||
    compact === 'wheelclick'
  ) {
    return { name: 'MiddleClick', mouseClass: 'middle' }
  }
  if (compact === 'leftclick' || compact === 'lmb') return { name: 'Mouse1', mouseClass: 'primary' }
  if (compact === 'rightclick' || compact === 'rmb') return { name: 'Mouse2', mouseClass: 'primary' }

  const m = /^(?:mouse|button|mb)(\d{1,2})$/.exec(compact)
  if (!m) return null
  const n = Number(m[1])
  if (n === 1 || n === 2) return { name: `Mouse${n}`, mouseClass: 'primary' }
  if (n === 3) return { name: 'MiddleClick', mouseClass: 'middle' }
  if (n >= 4 && n <= 10) return { name: `Mouse${n}`, mouseClass: 'ext' }
  return null
}

/** Normalise a single raw token to a {@link Token}, or null if it's noise. */
function normalizeToken(raw: string, platform?: ShortcutPlatform): Token | null {
  const trimmed = raw.trim()
  if (!trimmed) return null
  const lower = trimmed.toLowerCase()

  const mod = parseModifier(lower, platform)
  if (mod) return { kind: 'mod', name: mod.name, side: mod.side }

  const mouse = parseMouse(lower)
  if (mouse) return { kind: 'mouse', name: mouse.name, mouseClass: mouse.mouseClass }

  return { kind: 'key', name: normalizeKeyName(trimmed) }
}

/** Canonical name for a non-modifier, non-mouse key. */
function normalizeKeyName(raw: string): string {
  const lower = raw.toLowerCase()
  const compact = lower.replace(/\s+/g, '')
  if (Object.hasOwn(KEY_ALIASES, lower)) return KEY_ALIASES[lower]
  if (Object.hasOwn(KEY_ALIASES, compact)) return KEY_ALIASES[compact]

  let m: RegExpExecArray | null
  if ((m = /^key([a-z])$/.exec(compact))) return m[1].toUpperCase()
  if ((m = /^digit([0-9])$/.exec(compact))) return m[1]
  if ((m = /^numpad([0-9])$/.exec(compact))) return `Numpad${m[1]}`
  if ((m = /^f([1-9]|1[0-9]|2[0-4])$/.exec(compact))) return `F${m[1]}`
  if (/^[a-z]$/.test(compact)) return compact.toUpperCase()
  if (/^[0-9]$/.test(compact)) return compact
  return raw.trim()
}

/** Stable identity for de-duping — Left/Right modifier variants stay distinct. */
function tokenId(t: Token): string {
  if (t.kind === 'mod') return `mod:${t.name}:${t.side}`
  if (t.kind === 'mouse') return `mouse:${t.name}`
  return `key:${t.name}`
}

/** Split an accelerator/friendly string and normalise each part to a token. */
function toTokens(input: string | readonly string[], platform?: ShortcutPlatform): Token[] {
  const raw =
    typeof input === 'string'
      ? input.split('+').map((s) => s.trim()).filter(Boolean)
      : Array.from(input, (s) => String(s))

  const seen = new Set<string>()
  const tokens: Token[] = []
  for (const part of raw) {
    const token = normalizeToken(part, platform)
    if (!token) continue
    const id = tokenId(token)
    if (seen.has(id)) continue
    seen.add(id)
    tokens.push(token)
  }
  return tokens
}

/** Build the blocklist lookup key: ordered modifiers (Left/Right collapsed),
 *  then the remaining keys sorted for determinism, joined with "+". */
function canonical(tokens: readonly Token[]): string {
  const mods = new Set<ModName>()
  const keys: string[] = []
  for (const t of tokens) {
    if (t.kind === 'mod') mods.add(t.name)
    else keys.push(t.name)
  }
  const orderedMods = MOD_ORDER.filter((m) => mods.has(m))
  keys.sort()
  return [...orderedMods, ...keys].join('+')
}

/**
 * Canonical `"Mod+Mod+Key"` form for a shortcut — modifiers in a fixed order
 * with Left/Right variants collapsed. Exposed for callers that want to compare
 * or display combos the same way the blocklist does.
 */
export function toCanonicalShortcut(
  input: string | readonly string[],
  platform?: ShortcutPlatform,
): string {
  return canonical(toTokens(input, platform))
}

// ── OS blocklists (canonical form — see `canonical()`) ───────────────────────

/** `Cmd+Up`, `Cmd+Down`, `Cmd+Left`, `Cmd+Right` for a given prefix. */
const arrows = (prefix: string): string[] =>
  ['Up', 'Down', 'Left', 'Right'].map((a) => `${prefix}${a}`)

const MACOS_RESERVED: ReadonlySet<string> = new Set<string>([
  'Cmd+C', 'Cmd+V', 'Cmd+X', 'Cmd+Z', 'Cmd+Shift+Z',
  'Cmd+A', 'Cmd+Q', 'Cmd+W', 'Cmd+R', 'Cmd+T', 'Cmd+P', 'Cmd+N', 'Cmd+O', 'Cmd+S',
  'Cmd+M', 'Cmd+H', 'Cmd+F', 'Cmd+G', 'Cmd+Shift+G',
  'Cmd+Comma', 'Cmd+Tab', 'Cmd+Shift+R',
  ...arrows('Cmd+'),
  ...arrows('Cmd+Shift+'),
  'Cmd+Ctrl+F', 'Cmd+Space', 'Cmd+Alt+Space',
  'Cmd+Shift+3', 'Cmd+Shift+4', 'Cmd+Shift+5',
  'Cmd+Alt+Esc', 'Cmd+Alt+D', 'Cmd+Alt+P',
  'Cmd+Delete', 'Cmd+Shift+Delete', 'Cmd+Shift+Q',
  'Cmd+Alt+Left', 'Cmd+Alt+Right',
  'Cmd+B', 'Cmd+I', 'Cmd+U', 'Cmd+Shift+T',
  'Cmd+=', 'Cmd+-',
  'Cmd+Alt+F', 'Cmd+Shift+F',
  ...arrows('Ctrl+'),
  'Ctrl+A', 'Ctrl+E', 'Ctrl+K',
  'Fn+F11', 'Fn+F12',
  'Alt+Backspace', 'Alt+Delete',
])

const WINDOWS_RESERVED: ReadonlySet<string> = new Set<string>([
  'Ctrl+C', 'Ctrl+V', 'Ctrl+X', 'Ctrl+Z', 'Ctrl+Y', 'Ctrl+R', 'Ctrl+A', 'Ctrl+B',
  'Ctrl+I', 'Ctrl+U', 'Ctrl+F', 'Ctrl+G', 'Ctrl+O', 'Ctrl+S', 'Ctrl+P', 'Ctrl+N',
  'Ctrl+T', 'Ctrl+W', 'Ctrl+K',
  'Ctrl+Home', 'Ctrl+End',
  'Ctrl+Alt+Delete', 'Ctrl+Shift+Esc',
  'Ctrl+Backspace', 'Ctrl+Delete',
  'Ctrl+Shift+T', 'Ctrl+=', 'Ctrl+-',
  'Ctrl+Shift+Home', 'Ctrl+Shift+End', 'Ctrl+Shift+R',
  'Alt+Tab', 'Alt+F4', 'Alt+Left', 'Alt+Right', 'Alt+PrintScreen',
  'F5', 'F11', 'Ctrl+F5', 'Home', 'End', 'PrintScreen',
  'Shift+F3', 'Shift+Home', 'Shift+End',
])

/** The reserved-combo sets, keyed by `process.platform`. */
export const RESERVED_SHORTCUTS: Readonly<Record<'darwin' | 'win32', ReadonlySet<string>>> = {
  darwin: MACOS_RESERVED,
  win32: WINDOWS_RESERVED,
}

// ── Public API ───────────────────────────────────────────────────────────────

function detectPlatform(): ShortcutPlatform | undefined {
  const proc = (globalThis as { process?: { platform?: string } }).process
  return (proc?.platform as ShortcutPlatform | undefined) ?? undefined
}

/** Turn a canonical combo back into something readable for an error message. */
function displayCombo(combo: string): string {
  return combo
    .split('+')
    .map((p) => (p === 'Comma' ? ',' : p === 'Period' ? '.' : p))
    .join(' + ')
}

/**
 * Validate a shortcut against all four rules. `input` is an Electron
 * accelerator string or an explicit token list; `options.platform` defaults to
 * `process.platform` when it can be read (the OS blocklists are skipped when it
 * can't be determined or isn't macOS/Windows).
 */
export function validateShortcut(
  input: string | readonly string[],
  options: { platform?: ShortcutPlatform } = {},
): ShortcutValidation {
  const platform = options.platform ?? detectPlatform()
  const tokens = toTokens(input, platform)

  // Rule 1 — max keys. Left/Right variants were kept distinct by `toTokens`.
  if (tokens.length > 3) {
    return { ok: false, error: SHORTCUT_ERRORS.TOO_MANY_KEYS }
  }

  // Rule 2 — needs a modifier, or a usable mouse button.
  const hasModifier = tokens.some((t) => t.kind === 'mod')
  const hasMiddleClick = tokens.some((t) => t.kind === 'mouse' && t.mouseClass === 'middle')
  const standaloneExtraButton =
    tokens.length === 1 && tokens[0].kind === 'mouse' && tokens[0].mouseClass === 'ext'
  if (!hasModifier && !hasMiddleClick && !standaloneExtraButton) {
    return { ok: false, error: SHORTCUT_ERRORS.NEEDS_MODIFIER_OR_MOUSE }
  }

  // Rules 3 & 4 — per-OS blocklists.
  const blocklist =
    platform === 'darwin'
      ? MACOS_RESERVED
      : platform === 'win32'
        ? WINDOWS_RESERVED
        : null
  if (blocklist) {
    const combo = canonical(tokens)
    if (blocklist.has(combo)) {
      const os = platform === 'darwin' ? 'macOS' : 'Windows'
      return {
        ok: false,
        error: `${displayCombo(combo)} is reserved by ${os} and can't be used as a shortcut.`,
      }
    }
  }

  return { ok: true, error: null }
}

/** Convenience boolean wrapper around {@link validateShortcut}. */
export function isValidShortcut(
  input: string | readonly string[],
  options: { platform?: ShortcutPlatform } = {},
): boolean {
  return validateShortcut(input, options).ok
}

/**
 * True when every token in the shortcut is a modifier — e.g. `"Control+Alt"`,
 * held with no third key (push-to-talk's alternative to a modifier+key
 * combo). Such a combo can't be registered with `electron.globalShortcut`
 * (there's no regular key for it to claim), so it can't be swallowed from
 * whatever app is focused the way a normal hotkey can — callers use this to
 * surface that tradeoff in the UI rather than to change validation.
 */
export function isModifierOnlyShortcut(
  input: string | readonly string[],
  platform?: ShortcutPlatform,
): boolean {
  const tokens = toTokens(input, platform ?? detectPlatform())
  return tokens.length > 0 && tokens.every((t) => t.kind === 'mod')
}
