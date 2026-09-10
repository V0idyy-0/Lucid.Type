import { useCallback, useEffect, useMemo, useState, type CSSProperties } from 'react'
import type { HistoryEntry } from '../whisper-flow'

const isMac = typeof navigator !== 'undefined' && navigator.userAgent.includes('Mac')

// Keep the frameless title area draggable while leaving controls clickable.
const DRAG: CSSProperties = { WebkitAppRegion: 'drag' } as CSSProperties
const NO_DRAG: CSSProperties = { WebkitAppRegion: 'no-drag' } as CSSProperties

const SHELL = isMac ? '#1c1c1e' : '#0e0f17'
const CARD = isMac ? '#28282b' : '#1a1a1f'

/** "just now" / "4m ago" / "3h ago" / "Aug 2" — coarse, no live ticking. */
function relativeTime(at: number): string {
  const secs = Math.max(0, (Date.now() - at) / 1000)
  if (secs < 45) return 'just now'
  if (secs < 3600) return `${Math.round(secs / 60)}m ago`
  if (secs < 86_400) return `${Math.round(secs / 3600)}h ago`
  const d = new Date(at)
  return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })
}

function CopyIcon() {
  return (
    <svg
      aria-hidden="true"
      width="15"
      height="15"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <rect width="14" height="14" x="8" y="8" rx="2" ry="2" />
      <path d="M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2" />
    </svg>
  )
}

function TrashIcon() {
  return (
    <svg
      aria-hidden="true"
      width="15"
      height="15"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d="M3 6h18" />
      <path d="M19 6v14c0 1-1 2-2 2H7c-1 0-2-1-2-2V6" />
      <path d="M8 6V4c0-1 1-2 2-2h4c1 0 2 1 2 2v2" />
    </svg>
  )
}

function Row({
  entry,
  onCopy,
  onDelete,
}: {
  entry: HistoryEntry
  onCopy: (entry: HistoryEntry) => void
  onDelete: (id: string) => void
}) {
  const [copied, setCopied] = useState(false)

  const copy = () => {
    onCopy(entry)
    setCopied(true)
    window.setTimeout(() => setCopied(false), 1200)
  }

  return (
    <li
      className="flex flex-col gap-2 rounded-[10px] border border-white/[0.08] p-3"
      style={{ backgroundColor: CARD }}
    >
      <p className="whitespace-pre-wrap text-[13px] leading-relaxed text-zinc-100">{entry.text}</p>
      <div className="flex items-center justify-between text-[11px] text-zinc-500">
        <span className="flex items-center gap-1.5">
          <span>{relativeTime(entry.at)}</span>
          {entry.app && (
            <>
              <span aria-hidden>·</span>
              <span className="truncate">{entry.app}</span>
            </>
          )}
          <span aria-hidden>·</span>
          <span>{entry.chars} chars</span>
        </span>
        <span className="flex items-center gap-1" style={NO_DRAG}>
          <button
            type="button"
            onClick={copy}
            className="flex items-center gap-1 rounded-md px-1.5 py-1 text-zinc-400 transition-colors hover:bg-white/10 hover:text-zinc-100"
          >
            <CopyIcon />
            {copied ? 'Copied' : 'Copy'}
          </button>
          <button
            type="button"
            aria-label="Delete entry"
            onClick={() => onDelete(entry.id)}
            className="rounded-md px-1.5 py-1 text-zinc-400 transition-colors hover:bg-white/10 hover:text-red-400"
          >
            <TrashIcon />
          </button>
        </span>
      </div>
    </li>
  )
}

export default function History() {
  const [entries, setEntries] = useState<HistoryEntry[] | null>(null)
  const [saveHistory, setSaveHistory] = useState(true)

  const refresh = useCallback(() => {
    void window.whisperFlow?.listHistory().then(setEntries)
  }, [])

  useEffect(() => {
    refresh()
    void window.whisperFlow?.getSettings().then((s) => {
      setSaveHistory(s.saveHistory)
      document.documentElement.style.setProperty('--accent', s.accentColor)
    })
    const offHistory = window.whisperFlow?.onHistoryChanged(refresh)
    const offSettings = window.whisperFlow?.onSettingsChanged((s) => {
      setSaveHistory(s.saveHistory)
      document.documentElement.style.setProperty('--accent', s.accentColor)
    })
    return () => {
      offHistory?.()
      offSettings?.()
    }
  }, [refresh])

  // Esc closes the window.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') window.close()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  const copy = useCallback((entry: HistoryEntry) => {
    window.whisperFlow?.writeClipboard(entry.text)
  }, [])

  const remove = useCallback((id: string) => {
    void window.whisperFlow?.deleteHistoryEntry(id).then(setEntries)
  }, [])

  const clearAll = useCallback(() => {
    void window.whisperFlow?.clearHistory().then(setEntries)
  }, [])

  const count = entries?.length ?? 0
  const body = useMemo(() => {
    if (entries === null) {
      return <p className="px-1 py-8 text-center text-[13px] text-zinc-500">Loading…</p>
    }
    if (count === 0) {
      return (
        <div className="px-1 py-10 text-center text-[13px] leading-relaxed text-zinc-500">
          {saveHistory ? (
            <>Nothing here yet. Finished transcripts will show up as you dictate.</>
          ) : (
            <>
              History is off. Turn on <span className="text-zinc-300">Save dictation history</span> in
              Settings → General to start keeping a log.
            </>
          )}
        </div>
      )
    }
    return (
      <ul className="flex flex-col gap-2">
        {entries.map((entry) => (
          <Row key={entry.id} entry={entry} onCopy={copy} onDelete={remove} />
        ))}
      </ul>
    )
  }, [entries, count, saveHistory, copy, remove])

  return (
    <div
      className={`flex h-screen w-screen flex-col text-zinc-100 ${isMac ? 'platform-mac' : 'platform-win'}`}
      style={{ backgroundColor: SHELL }}
    >
      <header
        style={DRAG}
        className={`flex shrink-0 items-center justify-between border-b border-white/10 px-5 ${
          isMac ? 'pb-3 pt-9' : 'py-3'
        }`}
      >
        <h1 className="text-[15px] font-bold text-white">
          Dictation History{count > 0 && <span className="ml-1.5 text-zinc-500">{count}</span>}
        </h1>
        {count > 0 && (
          <button
            type="button"
            style={NO_DRAG}
            onClick={clearAll}
            className="rounded-md border border-white/10 bg-white/5 px-2.5 py-1 text-[12px] text-zinc-300 transition-colors hover:bg-white/10 hover:text-white"
          >
            Clear all
          </button>
        )}
      </header>
      <div className="flex-1 overflow-y-auto px-5 py-4">{body}</div>
    </div>
  )
}
