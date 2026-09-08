import { useCallback, useEffect, useRef, useState, type RefObject } from 'react'
import { DEFAULT_SETTINGS, type Settings } from './settings'
import './App.css'

type Status = 'idle' | 'recording' | 'transcribing' | 'error'

const TARGET_SAMPLE_RATE = 16_000

/**
 * Loudest per-frame RMS (0..1) the mic has to reach during a take for us to
 * bother transcribing it. Conversational speech sits well above this; room tone
 * and breath — especially with noise suppression on — stay below it. Anything
 * quieter is almost certainly silence that whisper would only hallucinate over.
 */
const MIN_SPEECH_RMS = 0.01

/** How long the transient "No speech detected" pill stays on screen. */
const NOTICE_MS = 1_500

/**
 * A soft start/stop chime, synthesised on the fly so there's no audio asset to
 * bundle. Best-effort — a device with no output just stays silent.
 */
function chime(kind: 'start' | 'stop') {
  try {
    const ctx = new AudioContext()
    const osc = ctx.createOscillator()
    const gain = ctx.createGain()
    osc.type = 'sine'
    osc.frequency.value = kind === 'start' ? 620 : 440
    osc.connect(gain)
    gain.connect(ctx.destination)

    const t = ctx.currentTime
    gain.gain.setValueAtTime(0.0001, t)
    gain.gain.exponentialRampToValueAtTime(0.06, t + 0.012)
    gain.gain.exponentialRampToValueAtTime(0.0001, t + 0.16)
    osc.start(t)
    osc.stop(t + 0.18)
    osc.onended = () => void ctx.close()
  } catch {
    // A missing chime isn't worth surfacing.
  }
}

/** Encode mono Float32 PCM samples as a 16-bit WAV file. */
function encodeWav(samples: Float32Array, sampleRate: number): Uint8Array {
  const buffer = new ArrayBuffer(44 + samples.length * 2)
  const view = new DataView(buffer)

  const writeString = (offset: number, str: string) => {
    for (let i = 0; i < str.length; i++) view.setUint8(offset + i, str.charCodeAt(i))
  }

  writeString(0, 'RIFF')
  view.setUint32(4, 36 + samples.length * 2, true)
  writeString(8, 'WAVE')
  writeString(12, 'fmt ')
  view.setUint32(16, 16, true) // PCM chunk size
  view.setUint16(20, 1, true) // audio format = PCM
  view.setUint16(22, 1, true) // channels = mono
  view.setUint32(24, sampleRate, true)
  view.setUint32(28, sampleRate * 2, true) // byte rate
  view.setUint16(32, 2, true) // block align
  view.setUint16(34, 16, true) // bits per sample
  writeString(36, 'data')
  view.setUint32(40, samples.length * 2, true)

  let offset = 44
  for (let i = 0; i < samples.length; i++) {
    const s = Math.max(-1, Math.min(1, samples[i]))
    view.setInt16(offset, s < 0 ? s * 0x8000 : s * 0x7fff, true)
    offset += 2
  }

  return new Uint8Array(buffer)
}

const BAR_COUNT = 4

/**
 * Live 4-bar sound-wave indicator. Reads the mic's frequency spectrum from an
 * AnalyserNode every animation frame and drives each bar's `scaleY` directly on
 * the DOM node — no per-frame React render. Works the same in Chromium on macOS
 * and Windows. Honours `prefers-reduced-motion` by holding a static waveform.
 */
function WaveBars({ analyserRef }: { analyserRef: RefObject<AnalyserNode | null> }) {
  const barsRef = useRef<Array<HTMLSpanElement | null>>([])

  useEffect(() => {
    const analyser = analyserRef.current
    if (!analyser) return

    const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches
    if (reduceMotion) return

    const bins = new Uint8Array(analyser.frequencyBinCount)
    const levels = new Float32Array(BAR_COUNT)
    // Spread the four bars across the speech band only (~0–3 kHz at a 16 kHz
    // context), so every bar carries real energy instead of the top two sitting
    // dead. Each bin here is `8000 / frequencyBinCount` Hz wide.
    const usableBins = Math.min(bins.length, Math.round(bins.length * 0.38))
    const perBar = Math.max(1, Math.floor(usableBins / BAR_COUNT))
    let raf = 0

    const tick = () => {
      // The graph may be torn down a frame before this component unmounts.
      if (analyser.context.state === 'closed') return
      analyser.getByteFrequencyData(bins)

      for (let b = 0; b < BAR_COUNT; b++) {
        let sum = 0
        for (let i = 0; i < perBar; i++) sum += bins[b * perBar + i]
        // 0..1, tuned so conversational speech nearly fills the bar.
        const target = Math.min(1, sum / perBar / 190)
        // Rise fast, fall gently — reads as a lively wave rather than a flicker.
        const ease = target > levels[b] ? 0.6 : 0.18
        levels[b] += (target - levels[b]) * ease

        const bar = barsRef.current[b]
        if (bar) bar.style.transform = `scaleY(${(0.14 + levels[b] * 0.86).toFixed(3)})`
      }

      raf = requestAnimationFrame(tick)
    }

    raf = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(raf)
  }, [analyserRef])

  // Static fallback heights (also what shows under prefers-reduced-motion).
  const restScale = [0.4, 0.85, 0.6, 0.95]

  return (
    <span
      className="flex h-4 items-center gap-[3px]"
      style={{ color: 'var(--accent, #3b82f6)' }}
      aria-hidden
    >
      {Array.from({ length: BAR_COUNT }, (_, i) => (
        <span
          key={i}
          ref={(el) => {
            barsRef.current[i] = el
          }}
          className="h-full w-[3px] origin-center rounded-full bg-current"
          style={{ transform: `scaleY(${restScale[i]})` }}
        />
      ))}
    </span>
  )
}

function App() {
  const [status, setStatus] = useState<Status>('idle')
  const [notice, setNotice] = useState<string | null>(null)

  const audioCtxRef = useRef<AudioContext | null>(null)
  const streamRef = useRef<MediaStream | null>(null)
  const processorRef = useRef<ScriptProcessorNode | null>(null)
  const analyserRef = useRef<AnalyserNode | null>(null)
  const chunksRef = useRef<Float32Array[]>([])
  // Loudest RMS seen across the take's audio frames, used to gate near-silent
  // recordings before they ever reach whisper.
  const peakRmsRef = useRef(0)
  const noticeTimerRef = useRef<number | null>(null)
  // Push-to-talk: true while the hotkey is held. Lets a release that lands
  // mid-startup still stop the take once the mic is live.
  const pttHeldRef = useRef(false)

  const flashNotice = useCallback((message: string) => {
    if (noticeTimerRef.current !== null) window.clearTimeout(noticeTimerRef.current)
    setNotice(message)
    noticeTimerRef.current = window.setTimeout(() => {
      setNotice(null)
      noticeTimerRef.current = null
    }, NOTICE_MS)
  }, [])

  useEffect(
    () => () => {
      if (noticeTimerRef.current !== null) window.clearTimeout(noticeTimerRef.current)
    },
    [],
  )

  // Latest settings, mirrored into a ref so the recording callbacks can read
  // them without being torn down and rebuilt on every change.
  const settingsRef = useRef<Settings>(DEFAULT_SETTINGS)
  useEffect(() => {
    const apply = (s: Settings) => {
      settingsRef.current = s
      document.documentElement.style.setProperty('--accent', s.accentColor)
    }
    void window.whisperFlow?.getSettings().then(apply)
    return window.whisperFlow?.onSettingsChanged(apply)
  }, [])

  const stopGraph = useCallback(() => {
    processorRef.current?.disconnect()
    analyserRef.current?.disconnect()
    streamRef.current?.getTracks().forEach((t) => t.stop())
    void audioCtxRef.current?.close()
    processorRef.current = null
    analyserRef.current = null
    streamRef.current = null
    audioCtxRef.current = null
  }, [])

  useEffect(() => stopGraph, [stopGraph])

  const startRecording = useCallback(async () => {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true },
      })
      const ctx = new AudioContext({ sampleRate: TARGET_SAMPLE_RATE })
      const source = ctx.createMediaStreamSource(stream)

      // Tap the same source for the live wave visualiser. The analyser only
      // observes the signal, so it doesn't need to reach a destination.
      const analyser = ctx.createAnalyser()
      analyser.fftSize = 128
      analyser.smoothingTimeConstant = 0.7
      source.connect(analyser)

      const processor = ctx.createScriptProcessor(4096, 1, 1)
      chunksRef.current = []
      peakRmsRef.current = 0
      processor.onaudioprocess = (e) => {
        const frame = new Float32Array(e.inputBuffer.getChannelData(0))
        chunksRef.current.push(frame)

        // Track the loudest frame so a short utterance in a long take still
        // registers as speech.
        let sumSquares = 0
        for (let i = 0; i < frame.length; i++) sumSquares += frame[i] * frame[i]
        const rms = Math.sqrt(sumSquares / frame.length)
        if (rms > peakRmsRef.current) peakRmsRef.current = rms
      }
      source.connect(processor)
      processor.connect(ctx.destination)

      audioCtxRef.current = ctx
      streamRef.current = stream
      processorRef.current = processor
      analyserRef.current = analyser

      if (settingsRef.current.soundEffects) chime('start')
      setStatus('recording')
    } catch (err) {
      console.error(err instanceof Error ? err.message : 'Could not access the microphone')
      setStatus('error')
      stopGraph()
    }
  }, [stopGraph])

  const stopAndTranscribe = useCallback(async () => {
    const ctx = audioCtxRef.current
    const sampleRate = ctx?.sampleRate ?? TARGET_SAMPLE_RATE
    stopGraph()

    if (settingsRef.current.soundEffects) chime('stop')

    const total = chunksRef.current.reduce((n, c) => n + c.length, 0)
    const peakRms = peakRmsRef.current
    peakRmsRef.current = 0
    if (total === 0) {
      setStatus('idle')
      return
    }

    // Nothing loud enough to be speech — don't send silence to whisper, which
    // would only hallucinate a phrase over it.
    if (peakRms < MIN_SPEECH_RMS) {
      chunksRef.current = []
      setStatus('idle')
      flashNotice('No speech detected')
      return
    }

    const merged = new Float32Array(total)
    let at = 0
    for (const chunk of chunksRef.current) {
      merged.set(chunk, at)
      at += chunk.length
    }
    chunksRef.current = []

    setStatus('transcribing')
    try {
      const wav = encodeWav(merged, sampleRate)
      if (!window.whisperFlow) {
        throw new Error('Run inside the Electron app to transcribe')
      }
      const { text, polish } = await window.whisperFlow.transcribe(wav)
      setStatus('idle')
      if (!text) flashNotice('No speech detected')
      else if (polish === 'polished') flashNotice('Polished with AI')
      else if (polish === 'fallback') flashNotice('Ollama unavailable — basic cleanup')
    } catch (err) {
      console.error(err instanceof Error ? err.message : 'Transcription failed')
      setStatus('error')
    }
  }, [stopGraph, flashNotice])

  const toggle = useCallback(() => {
    if (status === 'recording') void stopAndTranscribe()
    else if (status !== 'transcribing') void startRecording()
  }, [status, startRecording, stopAndTranscribe])

  // The Alt+Space global hotkey drives the same start/stop flow as a tap.
  useEffect(() => window.whisperFlow?.onToggle(toggle), [toggle])

  // Push-to-talk: the main process sends explicit start/stop events bracketing
  // the held hotkey, rather than a single toggle.
  useEffect(() => {
    const api = window.whisperFlow
    if (!api?.onRecordStart) return
    const offStart = api.onRecordStart(() => {
      pttHeldRef.current = true
      if (status !== 'recording' && status !== 'transcribing') {
        void startRecording().then(() => {
          // Released before the mic came up — stop right away.
          if (!pttHeldRef.current) void stopAndTranscribe()
        })
      }
    })
    const offStop = api.onRecordStop(() => {
      pttHeldRef.current = false
      if (status === 'recording') void stopAndTranscribe()
    })
    return () => {
      offStart()
      offStop()
    }
  }, [status, startRecording, stopAndTranscribe])

  // The pill only exists while dictation is active. Keep the overlay window's
  // visibility in lockstep so an empty transparent window never lingers.
  const pillVisible = status === 'recording' || notice !== null
  useEffect(() => {
    window.whisperFlow?.setPillVisible(pillVisible)
  }, [pillVisible])

  // Nothing shows when we're idle and there's no transient notice.
  if (!pillVisible) return null

  return (
    <div className="pill-stage">
      <button
        type="button"
        onClick={toggle}
        className="pill"
        aria-label={notice ?? 'Listening — tap to stop'}
      >
        {notice ? (
          <span className="pill__text">{notice}</span>
        ) : (
          <>
            <WaveBars analyserRef={analyserRef} />
            <span className="pill__text">Listening…</span>
          </>
        )}
      </button>
    </div>
  )
}

export default App
