#!/usr/bin/env node
/**
 * Ensure the whisper.cpp model `ggml-base.en.bin` exists under `bin/models/`.
 *
 * The model is ~142 MB, so it is NOT committed to git (see `.gitignore`).
 * This script is run from `postinstall` and again from `predist`, and is a
 * no-op when the file is already present — so a fresh clone, CI, and a
 * packaging build all end up with the model in place without anyone having to
 * fetch it by hand.
 *
 * Fetch a different model with WHISPER_MODEL (e.g. `ggml-small.en.bin`);
 * override the source with WHISPER_MODEL_URL; skip entirely with
 * SKIP_MODEL_DOWNLOAD=1 (useful for offline installs that bring their own copy).
 *
 * Note: the app also downloads models on demand at runtime (into userData/),
 * so this script only needs to cover the one bundled into packaged builds.
 */
import { createWriteStream } from 'node:fs'
import { mkdir, rename, stat, unlink } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const MODEL_DIR = join(ROOT, 'bin', 'models')
const MODEL_NAME = process.env.WHISPER_MODEL || 'ggml-base.en.bin'
const MODEL_PATH = join(MODEL_DIR, MODEL_NAME)
const MODEL_URL =
  process.env.WHISPER_MODEL_URL ||
  `https://huggingface.co/ggerganov/whisper.cpp/resolve/main/${MODEL_NAME}`

/** Smallest plausible model file (ggml-tiny is ~75 MB) — anything under this is
 *  a truncated download or an HTML error page. */
const MIN_BYTES = 60 * 1024 * 1024

async function fileSize(path) {
  try {
    return (await stat(path)).size
  } catch {
    return 0
  }
}

async function main() {
  if (process.env.SKIP_MODEL_DOWNLOAD === '1') {
    console.log('[fetch-model] SKIP_MODEL_DOWNLOAD=1 — skipping.')
    return
  }

  const existing = await fileSize(MODEL_PATH)
  if (existing >= MIN_BYTES) {
    console.log(`[fetch-model] ${MODEL_NAME} already present (${(existing / 1e6).toFixed(0)} MB).`)
    return
  }

  console.log(`[fetch-model] downloading ${MODEL_NAME} from ${MODEL_URL}`)
  await mkdir(MODEL_DIR, { recursive: true })

  const res = await fetch(MODEL_URL, { redirect: 'follow' })
  if (!res.ok || !res.body) {
    throw new Error(`download failed: HTTP ${res.status} ${res.statusText}`)
  }

  const tmp = `${MODEL_PATH}.download`
  await pipeline(Readable.fromWeb(res.body), createWriteStream(tmp))

  const got = await fileSize(tmp)
  if (got < MIN_BYTES) {
    await unlink(tmp).catch(() => {})
    throw new Error(`download too small (${got} bytes) — aborting`)
  }

  await rename(tmp, MODEL_PATH)
  console.log(`[fetch-model] saved ${MODEL_NAME} (${(got / 1e6).toFixed(0)} MB).`)
}

main().catch((err) => {
  console.error(`[fetch-model] ${err.message}`)
  process.exit(1)
})
