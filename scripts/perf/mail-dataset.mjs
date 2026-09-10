import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { performance } from 'node:perf_hooks'
import { writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

export const DATASET_VERSION = 1
export const DEFAULT_SIZES = [1_000, 10_000, 100_000]

function messageAt(index) {
  const senderIndex = index % 251
  return {
    id: `message-${index + 1}`,
    threadId: `thread-${Math.floor(index / 3) + 1}`,
    accountId: `account-${index % 4 + 1}`,
    date: 1_800_000_000 - index * 60,
    sender: `sender-${senderIndex}@example.test`,
    subject: `Synthetic message ${index + 1}`,
    preview: `Deterministic preview ${index % 17}`,
    unread: index % 5 === 0,
    hasAttachments: index % 11 === 0,
  }
}

export function buildDataset(size) {
  if (!Number.isInteger(size) || size <= 0) throw new RangeError('dataset size must be a positive integer')
  return Array.from({ length: size }, (_, index) => messageAt(index))
}

export function checksum(value) {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex')
}

function timed(work) {
  const started = performance.now()
  const value = work()
  return { value, milliseconds: Number((performance.now() - started).toFixed(3)) }
}

export function measureDataset(size) {
  const generated = timed(() => buildDataset(size))
  const sorted = timed(() => [...generated.value].sort((left, right) => right.date - left.date || left.id.localeCompare(right.id)))
  const filtered = timed(() => sorted.value.filter((message) => message.sender === 'sender-17@example.test'))
  return {
    size,
    checksum: checksum(generated.value),
    generationMilliseconds: generated.milliseconds,
    stableSortMilliseconds: sorted.milliseconds,
    senderFilterMilliseconds: filtered.milliseconds,
    senderFilterMatches: filtered.value.length,
  }
}

function gitCommit() {
  try {
    return execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim()
  } catch {
    return process.env.GIT_COMMIT ?? null
  }
}

export function createReport(sizes = DEFAULT_SIZES, cacheState = 'unknown') {
  const normalized = [...new Set(sizes)].sort((left, right) => left - right)
  if (normalized.length === 0) throw new RangeError('at least one dataset size is required')
  return {
    schemaVersion: DATASET_VERSION,
    capturedAt: new Date().toISOString(),
    commit: gitCommit(),
    runtime: { node: process.version, platform: process.platform, arch: process.arch },
    cacheState,
    transport: 'synthetic-only',
    datasets: normalized.map(measureDataset),
  }
}

function parseArgs(argv) {
  const sizesArg = argv.find((value) => value.startsWith('--sizes='))?.slice('--sizes='.length)
  const output = argv.find((value) => value.startsWith('--output='))?.slice('--output='.length)
  const cacheState = argv.find((value) => value.startsWith('--cache-state='))?.slice('--cache-state='.length) ?? 'unknown'
  const sizes = sizesArg ? sizesArg.split(',').map((value) => Number(value.trim())) : DEFAULT_SIZES
  if (sizes.some((size) => !Number.isInteger(size) || size <= 0)) throw new RangeError('sizes must be positive integers')
  return { sizes, output, cacheState }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  const { sizes, output, cacheState } = parseArgs(process.argv.slice(2))
  const serialized = `${JSON.stringify(createReport(sizes, cacheState), null, 2)}\n`
  if (output) writeFileSync(output, serialized, 'utf8')
  else process.stdout.write(serialized)
}
