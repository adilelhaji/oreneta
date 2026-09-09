const { test } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const root = path.resolve(__dirname, '../..')
const ledger = JSON.parse(fs.readFileSync(path.join(root, 'docs/emclient-parity-acceptance.json'), 'utf8'))
const backlog = JSON.parse(fs.readFileSync(path.join(root, 'docs/emclient-parity-backlog.json'), 'utf8'))
const issues = new Set([backlog.program.number, ...backlog.existing.map(x => x.number), ...backlog.issues.map(x => x.number)])
const states = new Set(['unassessed', 'absent', 'partial', 'implemented-unverified', 'verified', 'blocked'])
function validateResult(result) {
  assert.ok(typeof result === 'string' && result.trim(), 'result reference')
  if (result.startsWith('https://')) {
    const url = new URL(result)
    assert.ok(url.hostname && url.pathname !== '/', 'specific result URL')
    return
  }
  const file = path.resolve(root, result)
  assert.ok(file.startsWith(root + path.sep) && fs.existsSync(file) && fs.statSync(file).isFile(), 'existing repository result file')
}
function validate(row) {
  assert.ok(states.has(row.status), 'known status')
  assert.ok(issues.has(row.issue), 'tracked issue')
  for (const key of ['id', 'section', 'outcome', 'present', 'acceptance', 'platform', 'provider', 'referenceSource', 'code']) assert.ok(typeof row[key] === 'string' && row[key].trim(), key)
  assert.equal(new URL(row.referenceSource).hostname, 'www.emclient.com')
  const localPath = path.resolve(root, row.code)
  assert.ok(localPath.startsWith(root + path.sep), 'code stays within repository')
  assert.ok(fs.existsSync(localPath), 'existing code boundary')
  assert.equal(typeof row.requiresNative, 'boolean')
  assert.equal(typeof row.requiresProvider, 'boolean')
  for (const kind of ['automated', 'native', 'provider']) {
    assert.ok(Array.isArray(row.evidence[kind]))
    for (const item of row.evidence[kind]) {
      assert.match(item.sha, /^[0-9a-f]{40}$/)
      validateResult(item.result)
    }
  }
  if (row.status === 'verified') {
    assert.ok(row.evidence.automated.length, 'verified requires automated evidence')
    if (row.requiresNative) assert.ok(row.evidence.native.length, 'native evidence missing')
    if (row.requiresProvider) assert.ok(row.evidence.provider.length, 'provider evidence missing')
  }
}
test('ledger freezes version, provenance and unique acceptance identities', () => {
  assert.equal(ledger.schemaVersion, 1)
  assert.equal(ledger.reference.version, '10.4.5674.0')
  assert.match(ledger.baselineSha, /^[0-9a-f]{40}$/)
  assert.equal(new Set(ledger.rows.map(x => x.id)).size, ledger.rows.length)
  assert.ok(ledger.rows.some(x => x.issue === 83))
  assert.ok(ledger.rows.some(x => x.issue === 84))
  assert.ok(ledger.rows.some(x => x.issue === 85))
  ledger.rows.forEach(validate)
})
test('a planned acceptance procedure cannot count as verified evidence', () => {
  assert.throws(() => validate({ ...structuredClone(ledger.rows[0]), status: 'verified' }), /automated evidence/)
})
test('unknown state, owner and unsafe or nonexistent code paths are rejected', () => {
  for (const patch of [{ status: 'done' }, { issue: -1 }, { code: '../outside' }, { code: 'missing-parity-file' }]) assert.throws(() => validate({ ...structuredClone(ledger.rows[0]), ...patch }))
})
test('automated evidence cannot replace native or required provider evidence', () => {
  const row = { ...structuredClone(ledger.rows[0]), status: 'verified' }
  row.evidence.automated.push({ sha: ledger.baselineSha, result: 'docs/baseline.md' })
  assert.throws(() => validate(row), /native evidence/)
  row.evidence.native.push({ sha: ledger.baselineSha, result: 'docs/desktop-startup.md' })
  row.requiresProvider = true
  assert.throws(() => validate(row), /provider evidence/)
  row.evidence.provider.push({ sha: ledger.baselineSha, result: 'docs/baseline.md' })
  validate(row)
})
test('evidence references must be specific HTTPS URLs or existing repository files', () => {
  for (const result of ['invented-result', '../outside', 'docs/missing-result.md', 'docs', 'https://github.com/', 'http://example.test/result']) assert.throws(() => validateResult(result))
  validateResult('docs/baseline.md')
  validateResult('https://github.com/adilelhaji/oreneta/actions/runs/34322789096')
})
