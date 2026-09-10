import { useCallback, useEffect, useState, type CSSProperties, type ReactNode } from 'react'
import logo from '../assets/logo.svg'
import { DEFAULT_SETTINGS, type Settings } from '../settings'
import type { MicrophoneAccessStatus, PermissionStatus } from '../whisper-flow'

const isMac = typeof navigator !== 'undefined' && navigator.userAgent.includes('Mac')

// Keep the frameless window draggable by its chrome while leaving controls clickable.
const DRAG: CSSProperties = { WebkitAppRegion: 'drag' } as CSSProperties
const NO_DRAG: CSSProperties = { WebkitAppRegion: 'no-drag' } as CSSProperties

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

/** Render an Electron accelerator with platform-native glyphs, e.g. "⌥ Space". */
function formatHotkey(accelerator: string): string {
  return accelerator
    .split('+')
    .map((part) => KEY_GLYPHS[part] ?? part)
    .join(isMac ? ' ' : ' + ')
}

type Step = 'welcome' | 'permissions' | 'done'

/** A permission row's resolved UI state, independent of the raw OS status. */
type RowState = 'idle' | 'requesting' | 'granted' | 'denied'

function micRowState(status: MicrophoneAccessStatus | undefined): RowState {
  if (status === 'granted') return 'granted'
  if (status === 'denied' || status === 'restricted') return 'denied'
  return 'idle'
}

// ── Icons (16-20px Lucide-style glyphs, inlined so there's no dep to ship) ───

function MicIcon() {
  return (
    <svg
      aria-hidden="true"
      width="20"
      height="20"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d="M12 2a3 3 0 0 0-3 3v6a3 3 0 0 0 6 0V5a3 3 0 0 0-3-3Z" />
      <path d="M19 10v1a7 7 0 0 1-14 0v-1" />
      <line x1="12" x2="12" y1="18" y2="22" />
      <line x1="8" x2="16" y1="22" y2="22" />
    </svg>
  )
}

function AccessibilityIcon() {
  return (
    <svg
      aria-hidden="true"
      width="20"
      height="20"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <rect width="18" height="11" x="3" y="11" rx="2" ry="2" />
      <path d="M7 11V7a5 5 0 0 1 10 0v4" />
    </svg>
  )
}

function CheckIcon({ size = 14 }: { size?: number }) {
  return (
    <svg
      aria-hidden="true"
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="3"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d="M20 6 9 17l-5-5" />
    </svg>
  )
}

/** Full-width pill button in the app's accent colour — the primary action on
 *  every onboarding step. */
function PrimaryButton({
  children,
  onClick,
  disabled,
}: {
  children: ReactNode
  onClick: () => void
  disabled?: boolean
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      style={{ ...NO_DRAG, backgroundColor: 'var(--accent, #3b82f6)' }}
      className="w-full rounded-xl py-2.5 text-[14px] font-semibold text-white transition-opacity disabled:opacity-50"
    >
      {children}
    </button>
  )
}

/** Small top-right link that skips the rest of onboarding without granting
 *  anything — first-run flows shouldn't be able to trap someone. */
function SkipLink({ onSkip }: { onSkip: () => void }) {
  return (
    <button
      type="button"
      style={NO_DRAG}
      onClick={onSkip}
      className="absolute right-4 top-4 text-[12px] text-zinc-500 transition-colors hover:text-zinc-300"
    >
      Skip
    </button>
  )
}

// ── Step 1: Welcome ──────────────────────────────────────────────────────────

function WelcomeStep({ onNext, onSkip }: { onNext: () => void; onSkip: () => void }) {
  return (
    <div className="relative z-10 flex h-full flex-col items-center justify-between px-8 pb-8 pt-12 text-center">
      <SkipLink onSkip={onSkip} />

      <div className="flex flex-1 flex-col items-center justify-center gap-5">
        <img
          src={logo}
          alt=""
          width={64}
          height={61}
          className="drop-shadow-[0_4px_24px_rgba(0,0,0,0.45)]"
        />
        <div className="flex flex-col items-center gap-2">
          <h1 className="text-[22px] font-semibold text-white">Welcome to Lucid Type</h1>
          <p className="max-w-[300px] text-[13px] leading-relaxed text-zinc-400">
            Press a hotkey, speak, and your words show up wherever you're typing — fast, local
            dictation that never leaves your computer.
          </p>
        </div>
      </div>

      <div className="w-full" style={NO_DRAG}>
        <PrimaryButton onClick={onNext}>Get Started</PrimaryButton>
      </div>
    </div>
  )
}

// ── Step 2: Permissions ──────────────────────────────────────────────────────

function PermissionRow({
  icon,
  title,
  description,
  state,
  onRequest,
  onOpenSettings,
}: {
  icon: ReactNode
  title: string
  description: string
  state: RowState
  onRequest: () => void
  onOpenSettings: () => void
}) {
  return (
    <div className="flex items-start gap-3 rounded-[14px] border border-white/10 bg-white/[0.03] p-3.5">
      <div className="mt-0.5 flex size-9 shrink-0 items-center justify-center rounded-[10px] bg-white/5 text-zinc-300">
        {icon}
      </div>
      <div className="flex min-w-0 flex-1 flex-col gap-0.5">
        <span className="text-[13px] font-medium text-white">{title}</span>
        <span className="text-[12px] leading-snug text-zinc-500">{description}</span>
      </div>
      <div className="shrink-0 pt-0.5">
        {state === 'granted' ? (
          <span className="flex items-center gap-1 text-[12px] font-medium text-emerald-400">
            <CheckIcon /> Granted
          </span>
        ) : state === 'denied' ? (
          <button
            type="button"
            style={NO_DRAG}
            onClick={onOpenSettings}
            className="rounded-md border border-white/10 bg-white/5 px-2.5 py-1 text-[12px] text-zinc-300 transition-colors hover:bg-white/10"
          >
            Open Settings
          </button>
        ) : (
          <button
            type="button"
            style={{ ...NO_DRAG, backgroundColor: 'var(--accent, #3b82f6)' }}
            onClick={onRequest}
            disabled={state === 'requesting'}
            className="rounded-md px-2.5 py-1 text-[12px] font-medium text-white transition-opacity disabled:opacity-60"
          >
            {state === 'requesting' ? 'Requesting…' : 'Allow'}
          </button>
        )}
      </div>
    </div>
  )
}

function PermissionsStep({
  showAccessibility,
  micState,
  axState,
  onRequestMic,
  onRequestAx,
  onOpenSettings,
  onNext,
  onSkip,
}: {
  showAccessibility: boolean
  micState: RowState
  axState: RowState
  onRequestMic: () => void
  onRequestAx: () => void
  onOpenSettings: (kind: 'microphone' | 'accessibility') => void
  onNext: () => void
  onSkip: () => void
}) {
  return (
    <div className="relative z-10 flex h-full flex-col px-7 pb-7 pt-10">
      <SkipLink onSkip={onSkip} />

      <div className="mb-6 flex flex-col gap-1.5">
        <h1 className="text-[19px] font-semibold text-white">Enable permissions</h1>
        <p className="text-[13px] leading-relaxed text-zinc-400">
          Lucid Type needs a couple of permissions from your system to dictate and paste for you.
        </p>
      </div>

      <div className="flex flex-1 flex-col gap-3" style={NO_DRAG}>
        <PermissionRow
          icon={<MicIcon />}
          title="Microphone"
          description="Needed to hear you while you dictate."
          state={micState}
          onRequest={onRequestMic}
          onOpenSettings={() => onOpenSettings('microphone')}
        />
        {showAccessibility && (
          <PermissionRow
            icon={<AccessibilityIcon />}
            title="Accessibility"
            description="Lets Lucid Type paste your transcript into whatever app you're using."
            state={axState}
            onRequest={onRequestAx}
            onOpenSettings={() => onOpenSettings('accessibility')}
          />
        )}
        <p className="text-[11px] leading-relaxed text-zinc-600">
          You can grant these later from Settings — dictation just won't work until you do.
        </p>
      </div>

      <div style={NO_DRAG}>
        <PrimaryButton onClick={onNext}>Continue</PrimaryButton>
      </div>
    </div>
  )
}

// ── Step 3: Done ─────────────────────────────────────────────────────────────

function DoneStep({
  hotkey,
  launchAtLogin,
  onLaunchAtLoginChange,
  onFinish,
}: {
  hotkey: string
  launchAtLogin: boolean
  onLaunchAtLoginChange: (value: boolean) => void
  onFinish: () => void
}) {
  return (
    <div className="relative z-10 flex h-full flex-col items-center justify-between px-8 pb-8 pt-12 text-center">
      <div className="flex flex-1 flex-col items-center justify-center gap-5">
        <div
          className="flex size-16 items-center justify-center rounded-full"
          style={{ backgroundColor: 'color-mix(in srgb, var(--accent, #3b82f6) 22%, transparent)' }}
        >
          <span
            className="flex size-11 items-center justify-center rounded-full text-white"
            style={{ backgroundColor: 'var(--accent, #3b82f6)' }}
          >
            <CheckIcon size={22} />
          </span>
        </div>
        <div className="flex flex-col items-center gap-2">
          <h1 className="text-[22px] font-semibold text-white">You're all set!</h1>
          <p className="max-w-[300px] text-[13px] leading-relaxed text-zinc-400">
            Press{' '}
            <kbd className="rounded border border-white/10 bg-white/5 px-1.5 py-0.5 font-mono text-[12px] text-zinc-200">
              {formatHotkey(hotkey)}
            </kbd>{' '}
            anywhere to start dictating. Lucid Type lives in your{' '}
            {isMac ? 'menu bar' : 'system tray'} from here on.
          </p>
        </div>

        <label
          style={NO_DRAG}
          className="flex cursor-pointer items-center gap-2 text-[12px] text-zinc-400"
        >
          <input
            type="checkbox"
            checked={launchAtLogin}
            onChange={(e) => onLaunchAtLoginChange(e.target.checked)}
          />
          Launch Lucid Type at login
        </label>
      </div>

      <div className="w-full" style={NO_DRAG}>
        <PrimaryButton onClick={onFinish}>Start Using Lucid Type</PrimaryButton>
      </div>
    </div>
  )
}

// ── Root ─────────────────────────────────────────────────────────────────────

export default function Onboarding() {
  const [step, setStep] = useState<Step>('welcome')
  const [settings, setSettings] = useState<Settings>(DEFAULT_SETTINGS)
  const [permissions, setPermissions] = useState<PermissionStatus | null>(null)
  const [micState, setMicState] = useState<RowState>('idle')
  const [axState, setAxState] = useState<RowState>('idle')

  const refreshPermissions = useCallback(() => {
    void window.whisperFlow?.getPermissionStatus().then((status) => {
      setPermissions(status)
      setMicState((prev) => (prev === 'requesting' ? prev : micRowState(status.microphone)))
      setAxState((prev) =>
        prev === 'requesting' ? prev : status.accessibility ? 'granted' : 'idle',
      )
    })
  }, [])

  useEffect(() => {
    void window.whisperFlow?.getSettings().then(setSettings)
    refreshPermissions()
  }, [refreshPermissions])

  // Re-check permission status whenever the window regains focus — Accessibility
  // in particular is only ever granted by the user flipping a toggle in System
  // Settings, a completely separate app from this one.
  useEffect(() => {
    const onFocus = () => refreshPermissions()
    window.addEventListener('focus', onFocus)
    return () => window.removeEventListener('focus', onFocus)
  }, [refreshPermissions])

  const requestMicrophone = useCallback(async () => {
    setMicState('requesting')
    try {
      // Actually opening the mic is what triggers the OS-level prompt on every
      // platform (the main process's request only covers macOS); doing it here
      // also confirms a real input device is reachable, not just permitted.
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true })
      stream.getTracks().forEach((track) => track.stop())
      setMicState('granted')
    } catch {
      setMicState('denied')
    } finally {
      void window.whisperFlow?.requestMicrophoneAccess()
      refreshPermissions()
    }
  }, [refreshPermissions])

  const requestAccessibility = useCallback(async () => {
    setAxState('requesting')
    const trusted = await window.whisperFlow?.requestAccessibilityAccess()
    setAxState(trusted ? 'granted' : 'idle')
  }, [])

  const setLaunchAtLogin = useCallback((value: boolean) => {
    setSettings((prev) => ({ ...prev, launchAtLogin: value }))
    void window.whisperFlow?.updateSettings({ launchAtLogin: value })
  }, [])

  const finish = useCallback(() => {
    window.whisperFlow?.completeOnboarding()
  }, [])

  const showAccessibility = permissions ? permissions.platform === 'darwin' : isMac

  return (
    <div
      className="relative flex h-screen w-screen items-center justify-center overflow-hidden"
      style={DRAG}
    >
      <div
        className="relative flex h-full w-full flex-col overflow-hidden rounded-[20px] border border-white/10 text-zinc-100"
        style={{ backgroundColor: '#0b0c12' }}
      >
        {/* Soft accent glow behind the top of the card — the app's own accent
            colour, not a copy of any reference material's palette. */}
        <div
          aria-hidden
          className="pointer-events-none absolute left-1/2 top-0 h-64 w-64 -translate-x-1/2 -translate-y-1/3 rounded-full opacity-30 blur-3xl"
          style={{ backgroundColor: 'var(--accent, #3b82f6)' }}
        />

        {step === 'welcome' && <WelcomeStep onNext={() => setStep('permissions')} onSkip={finish} />}
        {step === 'permissions' && (
          <PermissionsStep
            showAccessibility={showAccessibility}
            micState={micState}
            axState={axState}
            onRequestMic={requestMicrophone}
            onRequestAx={requestAccessibility}
            onOpenSettings={(kind) => window.whisperFlow?.openPermissionSettings(kind)}
            onNext={() => setStep('done')}
            onSkip={finish}
          />
        )}
        {step === 'done' && (
          <DoneStep
            hotkey={settings.hotkey}
            launchAtLogin={settings.launchAtLogin}
            onLaunchAtLoginChange={setLaunchAtLogin}
            onFinish={finish}
          />
        )}
      </div>
    </div>
  )
}
