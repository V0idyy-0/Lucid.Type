import { readFile } from 'node:fs/promises'
import path from 'node:path'

const expected = process.argv[2]
if (expected !== 'x64' && expected !== 'arm64') {
  throw new Error('Usage: node scripts/verify-windows-artifact.mjs <x64|arm64>')
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

const unpacked = path.resolve('dist-release', 'win-unpacked')
const files = [
  path.join(unpacked, 'Lucid Type.exe'),
  path.join(unpacked, 'resources', 'bin', 'whisper-cli.exe'),
]

for (const file of files) {
  const actual = await peMachine(file)
  if (actual !== expected) {
    throw new Error(`Architecture mismatch: ${file} is ${actual}, expected ${expected}`)
  }
  console.log(`${file}: ${actual}`)
}
