import { readFile, readdir, mkdtemp, rm } from 'node:fs/promises'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { tmpdir } from 'node:os'
import path from 'node:path'

const execFileAsync = promisify(execFile)

// electron-builder unpacks each Windows arch to its own directory: x64 ->
// dist-release/win-unpacked, arm64 -> dist-release/win-arm64-unpacked. Verify
// that, for each requested arch, both the app exe and the bundled whisper-cli
// helper really are that architecture — this is what catches a mislabelled or
// cross-contaminated combined installer before it ships.
const unpackedDir = {
  x64: 'win-unpacked',
  arm64: 'win-arm64-unpacked',
}

const machineNames = {
  0x8664: 'x64',
  0xaa64: 'arm64',
  0x01c4: 'arm',
}

async function peMachine(file) {
  const data = await readFile(file)
  if (data.length < 0x40 || data.readUInt16LE(0) !== 0x5a4d) {
    throw new Error(`${file} is not a Windows PE executable`)
  }
  const peOffset = data.readUInt32LE(0x3c)
  if (peOffset + 6 > data.length || data.readUInt32LE(peOffset) !== 0x00004550) {
    throw new Error(`${file} has an invalid PE header`)
  }
  return machineNames[data.readUInt16LE(peOffset + 4)] ?? 'unknown'
}

// Parse `7z l -slt` output: an archive-level summary block, then a
// "----------" separator, then one blank-line-separated block per entry.
function splitSlt(output) {
  const normalized = output.replace(/\r\n/g, '\n')
  const sepIndex = normalized.indexOf('\n----------\n')
  if (sepIndex === -1) {
    return { summary: normalized, entries: [] }
  }
  const summary = normalized.slice(0, sepIndex)
  const rest = normalized.slice(sepIndex + '\n----------\n'.length)
  const entries = rest
    .split(/\n\n+/)
    .map(block => block.trim())
    .filter(Boolean)
  return { summary, entries }
}

function fieldFromBlock(block, field) {
  const m = block.match(new RegExp(`^${field} = (.*)$`, 'm'))
  return m ? m[1].trim() : null
}

// Match by basename, not a full "$PLUGINSDIR/..." path: 7-Zip renders the
// NSIS plugin-dir separator as "/" on macOS/Linux but "\" on Windows.
function findEntryByBasename(entries, basename) {
  return (
    entries.find(block => {
      const p = fieldFromBlock(block, 'Path')
      if (!p) return false
      const parts = p.split(/[\\/]/)
      return parts[parts.length - 1] === basename
    }) ?? null
  )
}

async function get7za() {
  const { getPath7za } = await import('app-builder-lib/out/toolsets/7zip.js')
  return getPath7za()
}

async function findInstaller() {
  const dir = path.resolve('dist-release')
  const entries = await readdir(dir)
  const match = entries.find(f => /-win\.exe$/.test(f))
  if (!match) {
    throw new Error(`No *-win.exe installer found in ${dir}`)
  }
  return path.join(dir, match)
}

const archToBlob = { x64: 'app-64.7z', arm64: 'app-arm64.7z' }

// This is the check that actually matters: electron-builder's pinned 7-Zip
// compressor (new enough to know about the "ARM64" filter added in 7-Zip
// 23.01) can silently produce an app-arm64.7z that its own bundled NSIS
// decompression plugin — vendored from 2019, years before that filter
// existed — cannot decode. The installer then "completes" (registry entries
// and shortcuts get written) but silently fails to extract the big PE/DLL
// files, leaving a missing "Lucid Type.exe". The pre-merge per-arch
// directories checked above can't catch this: the failure only happens in
// the merge/compression step that runs after those directories are staged.
// So unpack the *actual shipped installer* and check both that its payloads
// are genuinely embedded and that they weren't compressed with a filter the
// installer's own extractor can't handle.
async function verifyInstaller(arches) {
  const installer = await findInstaller()
  const sevenZa = await get7za()
  const { stdout: outerListing } = await execFileAsync(sevenZa, ['l', '-slt', installer])
  const { entries: outerEntries } = splitSlt(outerListing)
  console.log(`[debug] 7za binary: ${sevenZa}`)
  console.log(`[debug] parsed ${outerEntries.length} outer entries: ${outerEntries.map(b => fieldFromBlock(b, 'Path')).join(' | ')}`)
  if (outerEntries.length === 0) {
    console.log(`[debug] raw -slt output follows:\n${outerListing}`)
  }

  const tmpRoot = await mkdtemp(path.join(tmpdir(), 'lucid-installer-verify-'))
  try {
    for (const arch of arches) {
      const blobName = archToBlob[arch]
      const outerBlock = findEntryByBasename(outerEntries, blobName)
      if (!outerBlock) {
        throw new Error(`${installer} does not embed ${blobName} for arch ${arch}`)
      }
      const size = Number(fieldFromBlock(outerBlock, 'Packed Size'))
      if (!size || size < 50_000_000) {
        throw new Error(`${installer}'s ${blobName} is suspiciously small (${size} bytes) — looks truncated`)
      }
      console.log(`${installer}: embeds ${blobName} (${size} bytes)`)

      await execFileAsync(sevenZa, ['e', `-o${tmpRoot}`, installer, blobName, '-r', '-y'])
      const blobPath = path.join(tmpRoot, blobName)

      const { stdout: innerListing } = await execFileAsync(sevenZa, ['l', '-slt', blobPath])
      const { summary } = splitSlt(innerListing)
      const method = fieldFromBlock(summary, 'Method')
      if (!method) {
        throw new Error(`Could not determine compression method for ${blobPath}`)
      }
      if (method.includes('ARM64')) {
        throw new Error(
          `${blobPath} was compressed with the "ARM64" 7-Zip filter (Method: ${method}). ` +
            `electron-builder's bundled NSIS decompression plugin predates that filter and will ` +
            `fail to extract this archive on a real install with "Unsupported Method" errors — set ` +
            `ELECTRON_BUILDER_7Z_FILTER=BCJ (or another value from its allow-list) when packaging.`
        )
      }
      console.log(`${blobPath}: compression method OK (${method})`)

      const extractDir = path.join(tmpRoot, arch)
      await execFileAsync(sevenZa, ['x', `-o${extractDir}`, blobPath, '-y'])
      const files = [
        path.join(extractDir, 'Lucid Type.exe'),
        path.join(extractDir, 'resources', 'bin', 'whisper-cli.exe'),
      ]
      for (const file of files) {
        const actual = await peMachine(file)
        if (actual !== arch) {
          throw new Error(`Architecture mismatch inside shipped installer: ${file} is ${actual}, expected ${arch}`)
        }
        console.log(`${file} (from shipped installer): ${actual}`)
      }
    }
  } finally {
    await rm(tmpRoot, { recursive: true, force: true })
  }
}

const requested = process.argv.slice(2)
const arches = requested.length ? requested : ['x64', 'arm64']

for (const arch of arches) {
  const dir = unpackedDir[arch]
  if (!dir) {
    throw new Error(`Unknown arch "${arch}" (expected x64 or arm64)`)
  }
  const unpacked = path.resolve('dist-release', dir)
  const files = [
    path.join(unpacked, 'Lucid Type.exe'),
    path.join(unpacked, 'resources', 'bin', 'whisper-cli.exe'),
  ]
  for (const file of files) {
    const actual = await peMachine(file)
    if (actual !== arch) {
      throw new Error(`Architecture mismatch: ${file} is ${actual}, expected ${arch}`)
    }
    console.log(`${file}: ${actual}`)
  }
}

await verifyInstaller(arches.filter(arch => arch in archToBlob))

console.log(`OK: verified ${arches.join(', ')} artifact(s), including the shipped installer.`)
