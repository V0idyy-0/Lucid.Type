import { readFile, mkdtemp, rm, stat, writeFile, readdir as readdirFs } from 'node:fs/promises'
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

async function get7za() {
  const { getPath7za } = await import('app-builder-lib/out/toolsets/7zip.js')
  return getPath7za()
}

async function findInstaller() {
  const dir = path.resolve('dist-release')
  const entries = await readdirFs(dir)
  const match = entries.find(f => /-win\.exe$/.test(f))
  if (!match) {
    throw new Error(`No *-win.exe installer found in ${dir}`)
  }
  return path.join(dir, match)
}

const SEVEN_Z_SIGNATURE = Buffer.from([0x37, 0x7a, 0xbc, 0xaf, 0x27, 0x1c])

// Find every standalone 7z archive embedded verbatim in the installer.
// electron-builder's NSIS template embeds each arch's app package as a raw,
// uncompressed $PLUGINSDIR file (Method: Copy — confirmed by listing the
// installer on a platform whose 7za does understand the NSIS wrapper), so
// each occurrence of the 7z file signature marks the start of one complete,
// self-contained .7z archive. We can't rely on 7za to read the NSIS wrapper
// itself: the win-arm64 build of 7za electron-builder downloads (confirmed
// via `-tNsis` erroring out on it) has no NSIS format support at all, even
// though it reads plain "7z" archives fine — so we find archive boundaries
// ourselves and let 7za only ever handle standalone .7z files.
async function findEmbedded7zArchives(installerPath) {
  const buffer = await readFile(installerPath)
  const found = []
  let searchFrom = 0
  while (true) {
    const idx = buffer.indexOf(SEVEN_Z_SIGNATURE, searchFrom)
    if (idx === -1) break
    // 7z start header: 6-byte signature + 2-byte version + 4-byte header CRC,
    // then 20 bytes of {NextHeaderOffset, NextHeaderSize, NextHeaderCRC}
    // (8+8+4), all relative to the end of this 32-byte start header.
    if (idx + 32 <= buffer.length) {
      const nextHeaderOffset = buffer.readBigUInt64LE(idx + 12)
      const nextHeaderSize = buffer.readBigUInt64LE(idx + 20)
      const archiveSize = 32n + nextHeaderOffset + nextHeaderSize
      if (archiveSize > 32n && idx + Number(archiveSize) <= buffer.length) {
        found.push({ offset: idx, size: Number(archiveSize) })
        searchFrom = idx + Number(archiveSize)
        continue
      }
    }
    searchFrom = idx + 1
  }
  return { buffer, archives: found }
}

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
  const installerSize = (await stat(installer)).size
  console.log(`${installer}: ${installerSize} bytes on disk`)
  const sevenZa = await get7za()

  const { buffer, archives } = await findEmbedded7zArchives(installer)
  console.log(`${installer}: found ${archives.length} embedded 7z archive(s)`)
  if (archives.length !== arches.length) {
    throw new Error(
      `${installer} embeds ${archives.length} 7z archive(s), expected exactly ${arches.length} (one per requested arch: ${arches.join(', ')})`
    )
  }

  const tmpRoot = await mkdtemp(path.join(tmpdir(), 'lucid-installer-verify-'))
  const seenArches = new Set()
  try {
    for (const [i, archive] of archives.entries()) {
      if (archive.size < 50_000_000) {
        throw new Error(`${installer}'s embedded archive #${i} is suspiciously small (${archive.size} bytes) — looks truncated`)
      }
      const blobPath = path.join(tmpRoot, `embedded-${i}.7z`)
      await writeFile(blobPath, buffer.subarray(archive.offset, archive.offset + archive.size))
      console.log(`${installer}: embedded archive #${i} carved out (${archive.size} bytes)`)

      const { stdout: innerListing } = await execFileAsync(sevenZa, ['l', '-slt', '-t7z', blobPath])
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

      const extractDir = path.join(tmpRoot, `extracted-${i}`)
      await execFileAsync(sevenZa, ['x', `-o${extractDir}`, '-t7z', blobPath, '-y'])
      const exe = path.join(extractDir, 'Lucid Type.exe')
      const helper = path.join(extractDir, 'resources', 'bin', 'whisper-cli.exe')
      const arch = await peMachine(exe)
      const helperArch = await peMachine(helper)
      if (helperArch !== arch) {
        throw new Error(`Architecture mismatch inside shipped installer: ${exe} is ${arch} but ${helper} is ${helperArch}`)
      }
      if (!arches.includes(arch)) {
        throw new Error(`${installer} embeds an unexpected "${arch}" payload (expected one of: ${arches.join(', ')})`)
      }
      if (seenArches.has(arch)) {
        throw new Error(`${installer} embeds more than one "${arch}" payload`)
      }
      seenArches.add(arch)
      console.log(`${exe} (from shipped installer): ${arch}`)
    }
    for (const arch of arches) {
      if (!seenArches.has(arch)) {
        throw new Error(`${installer} does not embed a "${arch}" payload`)
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

await verifyInstaller(arches.filter(arch => arch in unpackedDir))

console.log(`OK: verified ${arches.join(', ')} artifact(s), including the shipped installer.`)
