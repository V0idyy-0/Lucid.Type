/**
 * A lightweight update check: ask the GitHub Releases API for the latest
 * published release and compare its version to the running one. There is no
 * auto-install — silent updates on macOS need a Developer ID signature +
 * notarization this project doesn't have — so a newer release just surfaces a
 * notification and a "Download" button that opens the release page.
 */
import type { UpdateCheckResult } from './ipc.js'

/** `owner/repo` on GitHub — matches `git remote`. */
const REPO = 'V0idyy-0/Lucid.Type'
const LATEST_RELEASE_URL = `https://api.github.com/repos/${REPO}/releases/latest`
const RELEASES_PAGE = `https://github.com/${REPO}/releases`

/** Give up on the network call after this long — a stalled check must never
 *  hang the app or a menu click. */
const REQUEST_TIMEOUT_MS = 5000

/** "v1.2.3" / "1.2.3-beta" -> [1, 2, 3]. Non-numeric tails are ignored. */
function parseVersion(raw: string): number[] {
  return raw
    .trim()
    .replace(/^v/i, '')
    .split('.')
    .map((part) => parseInt(part, 10))
    .map((n) => (Number.isFinite(n) ? n : 0))
}

/** True when `remote` is a strictly higher version than `local`. */
export function isNewer(remote: string, local: string): boolean {
  const a = parseVersion(remote)
  const b = parseVersion(local)
  const len = Math.max(a.length, b.length)
  for (let i = 0; i < len; i++) {
    const diff = (a[i] ?? 0) - (b[i] ?? 0)
    if (diff !== 0) return diff > 0
  }
  return false
}

interface GitHubRelease {
  tag_name?: string
  name?: string
  html_url?: string
  body?: string
  draft?: boolean
  prerelease?: boolean
}

/** Fetch the latest non-draft release, or null on any failure (offline, rate
 *  limited, no releases yet, malformed response). Never throws. */
async function fetchLatestRelease(): Promise<GitHubRelease | null> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS)
  try {
    const res = await fetch(LATEST_RELEASE_URL, {
      headers: {
        'User-Agent': 'LucidType',
        Accept: 'application/vnd.github+json',
      },
      signal: controller.signal,
    })
    if (!res.ok) return null
    const data = (await res.json()) as GitHubRelease
    if (!data || typeof data.tag_name !== 'string' || data.draft) return null
    return data
  } catch {
    return null
  } finally {
    clearTimeout(timer)
  }
}

/**
 * Compare the running version against the latest GitHub release. Always resolves
 * — `error` is set (and `updateAvailable` is false) when the check couldn't
 * complete.
 */
export async function checkForUpdate(currentVersion: string): Promise<UpdateCheckResult> {
  const release = await fetchLatestRelease()
  const checkedAt = Date.now()

  if (!release || !release.tag_name) {
    return {
      current: currentVersion,
      updateAvailable: false,
      checkedAt,
      error: "Couldn't reach GitHub to check for updates",
    }
  }

  const latest = release.tag_name.replace(/^v/i, '')
  const updateAvailable = isNewer(latest, currentVersion)

  return {
    current: currentVersion,
    latest,
    url: release.html_url || RELEASES_PAGE,
    notes: release.body?.slice(0, 4000),
    updateAvailable,
    checkedAt,
  }
}
