import { readFile } from 'node:fs/promises'
import path from 'node:path'

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

console.log(`OK: verified ${arches.join(', ')} artifact(s) match their target architecture.`)
