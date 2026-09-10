import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import { buildDataset, checksum, createReport, measureDataset } from './mail-dataset.mjs'

describe('deterministic performance datasets', () => {
  test('rejects empty or non-integer datasets', () => {
    assert.throws(() => buildDataset(0), /positive integer/)
    assert.throws(() => buildDataset(1.5), /positive integer/)
    assert.throws(() => createReport([]), /at least one dataset size/)
  })

  test('builds the same ordered metadata for every run', () => {
    const first = buildDataset(1_000)
    const second = buildDataset(1_000)
    assert.deepEqual(first, second)
    assert.equal(checksum(first), '61d6f12a765767e0b840b6ad794d72d189d64cc1642b4e2830204d36bc0e999d')
  })

  test('reports separate deterministic workload fields', () => {
    const result = measureDataset(10_000)
    assert.equal(result.size, 10_000)
    assert.match(result.checksum, /^[0-9a-f]{64}$/)
    assert.equal(result.senderFilterMatches, 40)
    assert.ok(result.generationMilliseconds >= 0)
    assert.ok(result.stableSortMilliseconds >= 0)
    assert.ok(result.senderFilterMilliseconds >= 0)
  })

  test('normalizes report sizes and identifies synthetic transport', () => {
    const report = createReport([10_000, 1_000, 10_000], 'warm')
    assert.equal(report.cacheState, 'warm')
    assert.equal(report.transport, 'synthetic-only')
    assert.deepEqual(report.datasets.map((dataset) => dataset.size), [1_000, 10_000])
  })
})
