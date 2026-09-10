import { useCallback, useEffect, useState, type CSSProperties } from 'react'
import logo from '../assets/logo.svg'
import type { UpdateCheckResult } from '../whisper-flow'

const isMac = typeof navigator !== 'undefined' && navigator.userAgent.includes('Mac')

const DRAG: CSSProperties = { WebkitAppRegion: 'drag' } as CSSProperties
const NO_DRAG: CSSProperties = { WebkitAppRegion: 'no-drag' } as CSSProperties

const SHELL = isMac ? '#1c1c1e' : '#0e0f17'

const REPO = 'https://github.com/V0idyy-0/Lucid.Type'
const LINKS = [
  { label: 'GitHub', url: REPO },
  { label: 'Releases', url: `${REPO}/releases` },
  { label: 'Report an issue', url: `${REPO}/issues` },
]

type CheckState = 'idle' | 'checking'

/** One line describing where the app stands relative to the latest release. */
function statusLine(state: CheckState, status: UpdateCheckResult | null): string {
  if (state === 'checking') return 'Checking for updates…'
  if (!status || status.checkedAt === 0) return ''
  if (status.error) return status.error
  if (status.updateAvailable) return `Version ${status.latest} is available.`
  return "You're on the latest version."
}

export default function About() {
  const [version, setVersion] = useState('')
  const [status, setStatus] = useState<UpdateCheckResult | null>(null)
  const [checkState, setCheckState] = useState<CheckState>('idle')
  const [autoCheck, setAutoCheck] = useState(true)

  useEffect(() => {
    const api = window.whisperFlow
    if (!api) return
    void api.getVersion().then(setVersion)
    void api.getUpdateStatus().then(setStatus)
    void api.getSettings().then((s) => {
      setAutoCheck(s.autoCheckUpdates)
      document.documentElement.style.setProperty('--accent', s.accentColor)
    })
    const offStatus = api.onUpdateStatus((next) => {
      setStatus(next)
      setCheckState('idle')
    })
    const offSettings = api.onSettingsChanged((s) => {
      setAutoCheck(s.autoCheckUpdates)
      document.documentElement.style.setProperty('--accent', s.accentColor)
    })
    return () => {
      offStatus()
      offSettings()
    }
  }, [])

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') window.close()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  const check = useCallback(() => {
    setCheckState('checking')
    void window.whisperFlow?.checkForUpdates().then((next) => {
      setStatus(next)
      setCheckState('idle')
    })
  }, [])

  const line = statusLine(checkState, status)
  const updateAvailable = !!status?.updateAvailable

  return (
    <div
      className={`flex h-screen w-screen flex-col items-center text-zinc-100 ${
        isMac ? 'platform-mac' : 'platform-win'
      }`}
      style={{ ...DRAG, backgroundColor: SHELL }}
    >
      <div className="flex flex-1 flex-col items-center px-8 pb-7 pt-12 text-center">
        <img
          src={logo}
          alt=""
          width={56}
          height={53}
          className="drop-shadow-[0_4px_20px_rgba(0,0,0,0.45)]"
        />
        <h1 className="mt-4 text-[18px] font-semibold text-white">Lucid Type</h1>
        <p className="mt-0.5 text-[12px] text-zinc-500">
          {version ? `Version ${version}` : ' '}
        </p>

        <div
          className="mt-6 flex w-full flex-col items-center gap-2 rounded-[12px] border border-white/[0.08] bg-white/[0.03] px-4 py-4"
          style={NO_DRAG}
        >
          {updateAvailable ? (
            <button
              type="button"
              onClick={() => window.whisperFlow?.openDownloadPage()}
              className="rounded-lg px-3.5 py-1.5 text-[13px] font-semibold text-white transition-opacity hover:opacity-90"
              style={{ backgroundColor: 'var(--accent, #3b82f6)' }}
            >
              Download {status?.latest}
            </button>
          ) : (
            <button
              type="button"
              onClick={check}
              disabled={checkState === 'checking'}
              className="rounded-lg border border-white/10 bg-white/5 px-3.5 py-1.5 text-[13px] text-zinc-200 transition-colors hover:bg-white/10 disabled:opacity-50"
            >
              Check for updates
            </button>
          )}
          {line && <p className="text-[12px] leading-snug text-zinc-400">{line}</p>}
          <label className="mt-1 flex items-center gap-2 text-[12px] text-zinc-400">
            <input
              type="checkbox"
              checked={autoCheck}
              onChange={(e) => {
                setAutoCheck(e.target.checked)
                void window.whisperFlow?.updateSettings({ autoCheckUpdates: e.target.checked })
              }}
            />
            Automatically check for updates
          </label>
        </div>

        <p className="mt-5 max-w-[280px] text-[11px] leading-relaxed text-zinc-600">
          On-device transcription by whisper.cpp. Optional text polish via a local Ollama model.
          Nothing leaves your machine.
        </p>
      </div>

      <div
        className="flex w-full items-center justify-center gap-4 border-t border-white/10 py-3 text-[12px]"
        style={NO_DRAG}
      >
        {LINKS.map((l) => (
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
    </div>
  )
}
