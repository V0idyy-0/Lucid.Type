/**
 * The whisper.cpp models Lucid Type can decode with. All English-only (`.en`)
 * for now — language selection is intentionally out of scope.
 *
 * `ggml-base.en` is the one bundled into packaged builds (see
 * `scripts/fetch-model.mjs`); the others are fetched on demand from the same
 * Hugging Face repo and land in `bin/models/` next to it.
 */
import { MODEL_IDS, type ModelId } from './settings-schema.js'

export interface ModelSpec {
  id: ModelId
  /** File name under `bin/models/`. */
  file: string
  /** Download source. */
  url: string
  /** Approximate on-disk size, for the UI and a post-download sanity check. */
  sizeMB: number
  /** Short human label for the picker. */
  label: string
}

const HF_BASE = 'https://huggingface.co/ggerganov/whisper.cpp/resolve/main'

export const MODELS: Record<ModelId, ModelSpec> = {
  'tiny.en': {
    id: 'tiny.en',
    file: 'ggml-tiny.en.bin',
    url: `${HF_BASE}/ggml-tiny.en.bin`,
    sizeMB: 75,
    label: 'Lite — fastest, least accurate',
  },
  'base.en': {
    id: 'base.en',
    file: 'ggml-base.en.bin',
    url: `${HF_BASE}/ggml-base.en.bin`,
    sizeMB: 142,
    label: 'Standard — default',
  },
  'small.en': {
    id: 'small.en',
    file: 'ggml-small.en.bin',
    url: `${HF_BASE}/ggml-small.en.bin`,
    sizeMB: 466,
    label: 'Pro — deep accuracy, max precision',
  },
}

export const MODEL_LIST: ModelSpec[] = MODEL_IDS.map((id) => MODELS[id])
