#!/usr/bin/env node
/**
 * Download the official Kotlin LSP standalone runtime on demand.
 *
 * The standalone runtime ships its own JRE and unpacks to ~862 MB, so it is
 * neither committed to the repository nor published to npm. This script fetches
 * it once per machine into a cache directory and verifies it against the
 * published SHA-256 digest before unpacking.
 *
 * Usage:
 *   pnpm run fetch-kotlin              install if missing (idempotent)
 *   pnpm run fetch-kotlin -- --check   only report status, never download
 *   pnpm run fetch-kotlin -- --force   re-download even if already installed
 *
 * Environment:
 *   DSH_KOTLIN_LSP_HOME   cache root (default: ~/.dsh/kotlin-lsp)
 *   HTTPS_PROXY / HTTP_PROXY  honoured by Node >= 24 when NODE_USE_ENV_PROXY=1
 *
 * Exit codes: 0 success / already installed, 1 failure or (for --check) missing.
 */
import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import {
  chmodSync, closeSync, createReadStream, createWriteStream, existsSync, mkdirSync,
  openSync, readdirSync, readFileSync, readSync, renameSync, rmSync, statSync, statfsSync, writeFileSync,
} from 'node:fs'
import { homedir } from 'node:os'
import { basename, dirname, isAbsolute, join, normalize, resolve } from 'node:path'
import { Transform } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { fileURLToPath } from 'node:url'
import { createInflateRaw } from 'node:zlib'

const VERSION = '262.2310.0'
const PACKAGE_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const MARKER_FILE = '.dsh-kotlin-lsp.json'
// Verified 2026-11-11 from https://download.jetbrains.com/kotlin-lsp/<ver>/kotlin-lsp-<ver>-<platform>.zip.sha256
const SHA256 = {
  'linux-x64': 'c004242158f4b5e1d917ddd848e6f6a279484fa58a3e2bce8846b807d1ad16b1',
  'linux-aarch64': '1f8c814dfa9d64a9fba32b83a6fa0279cbc48e7240ef0ce922c7db2f39f0d35c',
  'mac-x64': 'a4ccf591664cfef6a12f21a690d23bad26b92de62ed34674491b915f25f95bf5',
  'mac-aarch64': '11560eb4ecd766204363848cc5ee84b51c0fd03fbfd4bbedaba0f00af74309c7',
  'win-x64': '6b2dcb875d5c45f61cec315b3d993fc8e3457c6380adde5ad69ce593ed44edda',
  'win-aarch64': '667b9d75771a4eeb4c33519c7d0e2125e3cdc76a2e84466b9b5467d2091d871e',
}
const PLATFORM_ARCH = {
  'linux-x64': ['linux', 'x64'],
  'linux-aarch64': ['linux', 'arm64'],
  'mac-x64': ['darwin', 'x64'],
  'mac-aarch64': ['darwin', 'arm64'],
  'win-x64': ['win32', 'x64'],
  'win-aarch64': ['win32', 'arm64'],
}
// peak disk use is the zip plus its expanded tree; refuse to start below this.
const REQUIRED_FREE_BYTES = 1400 * 1024 * 1024

class Fatal extends Error {}

// tracked so an interrupt can delete a half-written archive
let activePartial = null

const log = (message) => process.stderr.write(`${message}\n`)
const say = (message) => process.stdout.write(`${message}\n`)

function urlFor(platform) {
  // download.jetbrains.com issues a signed 302 to the CDN; the bare
  // download-cdn.jetbrains.com path 404s without that signature.
  return `https://download.jetbrains.com/kotlin-lsp/${VERSION}/kotlin-lsp-${VERSION}-${platform}.zip`
}

function detectPlatform() {
  for (const [name, [os, arch]] of Object.entries(PLATFORM_ARCH)) {
    if (process.platform === os && process.arch === arch) return name
  }
  throw new Fatal(
    `unsupported platform: ${process.platform}/${process.arch}\n` +
    `Kotlin LSP ${VERSION} is published for: ${Object.keys(SHA256).join(', ')}\n` +
    'Set DSH_KOTLIN_LSP_COMMAND to a Kotlin LSP launcher you installed yourself, '
    + 'or skip Kotlin support; the other languages keep working.',
  )
}

const isWindows = () => process.platform === 'win32'

function exeName() {
  return isWindows() ? 'kotlin-lsp.cmd' : 'kotlin-lsp.sh'
}

function expandHome(value) {
  if (value === '~') return homedir()
  if (value.startsWith('~/') || value.startsWith('~\\')) return join(homedir(), value.slice(2))
  return value
}

function cacheRoot() {
  const configured = process.env.DSH_KOTLIN_LSP_HOME
  return configured && configured.trim() ? resolve(expandHome(configured.trim())) : join(homedir(), '.dsh', 'kotlin-lsp')
}

const cacheDir = () => join(cacheRoot(), `kotlin-lsp-${VERSION}`)
const legacyDir = () => join(PACKAGE_ROOT, '.runtime', `kotlin-lsp-${VERSION}`)

/** Report whether a directory holds a usable extracted runtime. */
function inspect(dir) {
  const executable = join(dir, exeName())
  if (!existsSync(executable)) {
    return { installed: false, reason: existsSync(dir) ? `missing ${exeName()}` : 'directory not present' }
  }
  const markerPath = join(dir, MARKER_FILE)
  if (existsSync(markerPath)) {
    let marker
    try {
      marker = JSON.parse(readFileSync(markerPath, 'utf8'))
    } catch {
      return { installed: false, reason: `${MARKER_FILE} is not valid JSON` }
    }
    if (marker.version && marker.version !== VERSION) {
      return { installed: false, reason: `version marker is ${marker.version}, expected ${VERSION}` }
    }
    return { installed: true, executable, marker }
  }
  // Directories unpacked by hand (or by the legacy .runtime layout) have no
  // marker; the version is carried by the directory name itself.
  return { installed: true, executable, marker: null }
}

function describe(cache, legacy) {
  const lines = []
  if (cache.installed) lines.push(`  ${cacheDir()} -> installed (${cache.executable})`)
  else lines.push(`  ${cacheDir()} -> ${cache.reason}`)
  if (legacy.installed) lines.push(`  ${legacyDir()} -> installed (${legacy.executable})`)
  else lines.push(`  ${legacyDir()} -> ${legacy.reason}`)
  return lines.join('\n')
}

function freeBytes(dir) {
  try {
    const stats = statfsSync(dir)
    return stats.bavail * stats.bsize
  } catch {
    return null
  }
}

function formatBytes(bytes) {
  if (bytes >= 1024 ** 3) return `${(bytes / 1024 ** 3).toFixed(1)} GB`
  return `${(bytes / 1024 ** 2).toFixed(1)} MB`
}

async function download(url, partPath, expectedSha) {
  let response
  try {
    response = await fetch(url, { redirect: 'follow' })
  } catch (error) {
    const code = error?.cause?.code || error?.code || ''
    const hint = /^(ENOTFOUND|ECONNREFUSED|ETIMEDOUT|EAI_AGAIN|ECONNRESET|EHOSTUNREACH|ENETUNREACH)$/.test(code)
      ? '\nThe host could not be reached. If you need a proxy, export HTTPS_PROXY/HTTP_PROXY '
        + 'and NODE_USE_ENV_PROXY=1 (Node 24+), or download the zip yourself and unpack it into '
        + `${cacheDir()}.`
      : ''
    throw new Fatal(`download failed: ${code || error?.message || 'unknown network error'}${hint}`)
  }
  if (!response.ok || !response.body) {
    throw new Fatal(
      `download failed: HTTP ${response.status} ${response.statusText} for ${url}\n`
      + 'That combination of version and platform may not be published.',
    )
  }

  const total = Number(response.headers.get('content-length')) || 0
  const hash = createHash('sha256')
  let received = 0
  let lastReport = 0
  const interactive = process.stderr.isTTY
  const meter = new Transform({
    transform(chunk, _encoding, callback) {
      hash.update(chunk)
      received += chunk.length
      const now = Date.now()
      if (interactive && now - lastReport > 500) {
        lastReport = now
        const share = total ? `${((received / total) * 100).toFixed(1)}%` : ''
        process.stderr.write(`\r  downloading ${formatBytes(received)}${total ? ` / ${formatBytes(total)}` : ''} ${share}`)
      }
      callback(null, chunk)
    },
  })

  try {
    await pipeline(response.body, meter, createWriteStream(partPath, { mode: 0o644 }))
  } catch (error) {
    rmSync(partPath, { force: true })
    throw new Fatal(`download failed while streaming: ${error?.message || 'unknown error'}`)
  }
  if (interactive) process.stderr.write('\n')

  const actual = hash.digest('hex')
  if (actual !== expectedSha) {
    rmSync(partPath, { force: true })
    throw new Fatal(
      'SHA-256 mismatch, the downloaded archive was deleted.\n'
      + `  expected ${expectedSha}\n  received ${actual}\n`
      + 'Retry the command; if it keeps failing the download is being altered in transit.',
    )
  }
  return { bytes: received, actual }
}

function runUnzip(zipPath, destination) {
  return new Promise((resolvePromise, rejectPromise) => {
    const child = spawn('unzip', ['-qq', '-o', zipPath, '-d', destination], { stdio: ['ignore', 'ignore', 'pipe'] })
    let stderr = ''
    child.stderr?.on('data', (chunk) => { stderr += chunk })
    child.on('error', (error) => rejectPromise(error))
    child.on('close', (code) => {
      if (code === 0) resolvePromise()
      else rejectPromise(Object.assign(new Error(`unzip exited with ${code}: ${stderr.trim().slice(0, 400)}`), { code: 'UNZIP_FAILED' }))
    })
  })
}

const SIG_EOCD = 0x06054b50
const SIG_ZIP64_EOCD = 0x06064b50
const SIG_ZIP64_LOCATOR = 0x07064b50
const SIG_CENTRAL = 0x02014b50
const SIG_LOCAL = 0x04034b50

function readAt(fd, length, position) {
  const buffer = Buffer.alloc(length)
  let filled = 0
  while (filled < length) {
    const read = readSync(fd, buffer, filled, length - filled, position + filled)
    if (read <= 0) break
    filled += read
  }
  if (filled === 0) throw new Fatal('archive is truncated')
  return filled === length ? buffer : buffer.subarray(0, filled)
}

function findEndOfCentralDirectory(fd, fileSize) {
  const tailLength = Math.min(fileSize, 66_000)
  const tail = readAt(fd, tailLength, fileSize - tailLength)
  for (let offset = tail.length - 22; offset >= 0; offset -= 1) {
    if (tail.readUInt32LE(offset) === SIG_EOCD) return { buffer: tail, offset, base: fileSize - tailLength }
  }
  throw new Fatal('not a zip archive: end of central directory not found')
}

/** Minimal central-directory reader: stored and deflated entries, zip64 aware. */
function listEntries(fd, fileSize) {
  const { buffer, offset, base } = findEndOfCentralDirectory(fd, fileSize)
  let totalEntries = buffer.readUInt16LE(offset + 10)
  let centralOffset = buffer.readUInt32LE(offset + 16)

  if (totalEntries === 0xffff || centralOffset === 0xffffffff) {
    const locatorPosition = base + offset - 20
    if (locatorPosition >= 0) {
      const locator = readAt(fd, 20, locatorPosition)
      if (locator.readUInt32LE(0) === SIG_ZIP64_LOCATOR) {
        const zip64Offset = Number(locator.readBigUInt64LE(8))
        const zip64 = readAt(fd, 56, zip64Offset)
        if (zip64.readUInt32LE(0) === SIG_ZIP64_EOCD) {
          totalEntries = Number(zip64.readBigUInt64LE(32))
          centralOffset = Number(zip64.readBigUInt64LE(48))
        }
      }
    }
  }

  const entries = []
  let cursor = centralOffset
  for (let index = 0; index < totalEntries; index += 1) {
    const header = readAt(fd, 46, cursor)
    if (header.readUInt32LE(0) !== SIG_CENTRAL) throw new Fatal(`corrupt central directory at entry ${index}`)
    const flags = header.readUInt16LE(8)
    const method = header.readUInt16LE(10)
    let compressedSize = header.readUInt32LE(20)
    let uncompressedSize = header.readUInt32LE(24)
    const nameLength = header.readUInt16LE(28)
    const extraLength = header.readUInt16LE(30)
    const commentLength = header.readUInt16LE(32)
    const externalAttributes = header.readUInt32LE(38)
    let localOffset = header.readUInt32LE(42)
    const nameBuffer = readAt(fd, nameLength, cursor + 46)
    const extra = extraLength ? readAt(fd, extraLength, cursor + 46 + nameLength) : Buffer.alloc(0)
    const name = nameBuffer.toString(flags & 0x800 ? 'utf8' : 'utf8')

    if (compressedSize === 0xffffffff || uncompressedSize === 0xffffffff || localOffset === 0xffffffff) {
      let position = 0
      while (position + 4 <= extra.length) {
        const id = extra.readUInt16LE(position)
        const size = extra.readUInt16LE(position + 2)
        const body = extra.subarray(position + 4, position + 4 + size)
        if (id === 0x0001) {
          let inner = 0
          if (uncompressedSize === 0xffffffff && inner + 8 <= body.length) { uncompressedSize = Number(body.readBigUInt64LE(inner)); inner += 8 }
          if (compressedSize === 0xffffffff && inner + 8 <= body.length) { compressedSize = Number(body.readBigUInt64LE(inner)); inner += 8 }
          if (localOffset === 0xffffffff && inner + 8 <= body.length) { localOffset = Number(body.readBigUInt64LE(inner)) }
        }
        position += 4 + size
      }
    }

    entries.push({ name, method, compressedSize, uncompressedSize, localOffset, mode: externalAttributes >>> 16 })
    cursor += 46 + nameLength + extraLength + commentLength
  }
  return entries
}

function isSafeRelative(name) {
  const normalized = normalize(name.replace(/\\/g, '/'))
  if (!normalized || isAbsolute(normalized)) return false
  return !normalized.split('/').includes('..')
}

async function extractWithNode(zipPath, destination) {
  const fd = openSync(zipPath, 'r')
  try {
    const fileSize = statSync(zipPath).size
    const entries = listEntries(fd, fileSize)
    let files = 0
    for (const entry of entries) {
      if (!isSafeRelative(entry.name)) throw new Fatal(`archive contains an unsafe path: ${entry.name}`)
      const target = join(destination, entry.name)
      if (entry.name.endsWith('/')) {
        mkdirSync(target, { recursive: true })
        continue
      }
      mkdirSync(dirname(target), { recursive: true })
      const localHeader = readAt(fd, 30, entry.localOffset)
      if (localHeader.readUInt32LE(0) !== SIG_LOCAL) throw new Fatal(`corrupt local header for ${entry.name}`)
      const dataStart = entry.localOffset + 30 + localHeader.readUInt16LE(26) + localHeader.readUInt16LE(28)
      if (entry.method === 0) {
        await pipeline(
          createReadStream(zipPath, { start: dataStart, end: dataStart + entry.compressedSize - 1 }),
          createWriteStream(target),
        )
      } else if (entry.method === 8) {
        await pipeline(
          createReadStream(zipPath, { start: dataStart, end: dataStart + entry.compressedSize - 1 }),
          createInflateRaw(),
          createWriteStream(target),
        )
      } else {
        throw new Fatal(`unsupported compression method ${entry.method} for ${entry.name}`)
      }
      const mode = (entry.mode & 0o777) || 0o644
      chmodSync(target, entry.name.endsWith('.sh') ? mode | 0o755 : mode)
      files += 1
    }
    log(`  extracted ${files} files with the built-in zip reader (unzip not available)`)
  } finally {
    closeSync(fd)
  }
}

function removeTree(path) {
  rmSync(path, { recursive: true, force: true, maxRetries: 3 })
}

async function extract(zipPath, destination) {
  mkdirSync(dirname(destination), { recursive: true })
  removeTree(destination)
  mkdirSync(destination, { recursive: true })
  try {
    await runUnzip(zipPath, destination)
    log('  extracted with system unzip')
  } catch (error) {
    if (error?.code !== 'ENOENT') {
      log(`  system unzip failed (${error.message.split('\n')[0]}), retrying with the built-in reader`)
      removeTree(destination)
      mkdirSync(destination, { recursive: true })
    }
    try {
      await extractWithNode(zipPath, destination)
    } catch (fallbackError) {
      removeTree(destination)
      throw new Fatal(`could not unpack the archive: ${fallbackError?.message || fallbackError}`)
    }
  }
  const executable = join(destination, exeName())
  if (!existsSync(executable)) {
    removeTree(destination)
    throw new Fatal(`the archive did not contain ${exeName()} at its top level`)
  }
  if (!isWindows()) chmodSync(executable, 0o755)
}

function cleanStaleSiblings(root, target) {
  const base = basename(target)
  let names = []
  try {
    names = readdirSync(root)
  } catch {
    return
  }
  for (const name of names) {
    if (!name.startsWith(`${base}.partial-`) && !name.startsWith(`${base}.previous-`)) continue
    if (name === `${base}.partial-${process.pid}`) continue
    removeTree(join(root, name))
  }
}

async function install(platform) {
  const root = cacheRoot()
  mkdirSync(root, { recursive: true })
  const target = cacheDir()
  const free = freeBytes(root)
  if (free !== null && free < REQUIRED_FREE_BYTES) {
    throw new Fatal(
      `${formatBytes(free)} free under ${root}, but unpacking Kotlin LSP needs about 1.4 GB `
      + '(386 MB archive plus 862 MB expanded). Free some space, or point DSH_KOTLIN_LSP_HOME '
      + 'at a roomier filesystem.',
    )
  }

  const url = urlFor(platform)
  const zipPath = join(root, `kotlin-lsp-${VERSION}-${platform}.zip`)
  const partPath = `${zipPath}.part`
  activePartial = partPath
  const staging = `${target}.partial-${process.pid}`
  // Reclaim space from runs that were killed mid-unpack; these names are ours alone.
  cleanStaleSiblings(root, target)

  log(`[kotlin-lsp] installing ${VERSION} for ${platform}`)
  log(`  source: ${url}`)
  log(`  target: ${target}`)

  // The existing install stays in place until the new archive is verified and
  // unpacked, so a failed download never leaves the user without a runtime.
  const { bytes } = await download(url, partPath, SHA256[platform])
  log(`  verified SHA-256 (${formatBytes(bytes)})`)
  renameSync(partPath, zipPath)

  activePartial = null

  // Swap in the fresh tree without a window where neither copy exists: move the
  // old one aside, promote the new one, then drop the old one.
  const previous = `${target}.previous-${process.pid}`
  try {
    await extract(zipPath, staging)
    if (existsSync(target)) renameSync(target, previous)
    renameSync(staging, target)
    if (existsSync(previous)) removeTree(previous)
  } catch (error) {
    if (existsSync(previous) && !existsSync(target)) renameSync(previous, target)
    throw error
  } finally {
    rmSync(zipPath, { force: true })
    rmSync(partPath, { force: true })
    if (existsSync(staging)) removeTree(staging)
    if (existsSync(previous)) removeTree(previous)
  }

  writeFileSync(join(target, MARKER_FILE), `${JSON.stringify({
    version: VERSION,
    platform,
    sha256: SHA256[platform],
    source: url,
    installedAt: new Date().toISOString(),
  }, null, 2)}\n`)

  return target
}

function usage() {
  return [
    'Fetch the official Kotlin LSP standalone runtime for this platform.',
    '',
    'Usage: pnpm run fetch-kotlin [-- --check | --force | --help]',
    '',
    '  (no flag)   download, verify and unpack only when nothing usable is installed',
    '  --check     report platform and installation status, never download',
    '  --force     ignore the installed copy and download again',
    '  --help      show this text',
    '',
    `Cache root: $DSH_KOTLIN_LSP_HOME, default ${join(homedir(), '.dsh', 'kotlin-lsp')}`,
  ].join('\n')
}

async function main(argv) {
  const flags = new Set()
  for (const argument of argv) {
    // pnpm forwards the separator literally, so `... -- --check` arrives as ['--', '--check'].
    if (argument === '--') continue
    if (argument === '--check' || argument === '--force' || argument === '--help' || argument === '-h') flags.add(argument)
    else throw new Fatal(`unknown argument: ${argument}\n\n${usage()}`)
  }
  if (flags.has('--help') || flags.has('-h')) {
    say(usage())
    return 0
  }
  if (flags.has('--check') && flags.has('--force')) throw new Fatal('--check and --force cannot be combined')

  const platform = detectPlatform()
  const cache = inspect(cacheDir())
  const legacy = inspect(legacyDir())

  if (flags.has('--check')) {
    say(`[kotlin-lsp] Kotlin LSP ${VERSION}`)
    say(`  platform: ${platform} (${process.platform}/${process.arch})`)
    say(`  launcher: ${exeName()}`)
    say(describe(cache, legacy))
    if (cache.installed || legacy.installed) {
      say('status: installed')
      return 0
    }
    say(`status: missing — run "pnpm run fetch-kotlin" to download about 386 MB`)
    return 1
  }

  if (flags.has('--force')) {
    const target = await install(platform)
    say(target)
    return 0
  }

  if (cache.installed || legacy.installed) {
    const where = cache.installed ? cache.executable : legacy.executable
    say(`[kotlin-lsp] Kotlin LSP ${VERSION} is already installed.`)
    say(where)
    if (legacy.installed && !cache.installed) say('  (package-local .runtime copy; nothing to download)')
    return 0
  }

  const target = await install(platform)
  say(`[kotlin-lsp] Kotlin LSP ${VERSION} is ready.`)
  say(target)
  return 0
}

const cleanupHandlers = () => {
  for (const signal of ['SIGINT', 'SIGTERM']) {
    process.once(signal, () => {
      log('\ninterrupted — removing partial download')
      if (activePartial) rmSync(activePartial, { force: true })
      process.exit(130)
    })
  }
}

try {
  cleanupHandlers()
  process.exitCode = await main(process.argv.slice(2))
} catch (error) {
  if (error instanceof Fatal) {
    log(`[kotlin-lsp] error: ${error.message}`)
  } else {
    log(`[kotlin-lsp] error: ${error?.message || error}`)
    if (process.env.DSH_KOTLIN_LSP_DEBUG) log(error?.stack || '')
  }
  process.exitCode = 1
}
