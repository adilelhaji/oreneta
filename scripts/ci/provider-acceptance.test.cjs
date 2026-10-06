const { test } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const os = require('node:os')
const { spawnSync } = require('node:child_process')
const { buildReport } = require('./provider-acceptance.cjs')
const matrix = require('../../docs/provider-acceptance-matrix.json')
const sha = 'a'.repeat(40)
const run = 'https://github.com/adilelhaji/oreneta/actions/runs/123'
const suite = 'TestIntegrationMailFlow'
const names = matrix.rows.flatMap(row => row.tests.map(x => `${suite}/${x}`))
const event = (Action, Test) => ({ Action, Package: 'meron', ...(Test ? { Test } : {}) })
function good() {
  return [event('start'), event('run', suite), ...names.flatMap(n => [event('run', n), event('pass', n)]), event('pass', suite), event('pass')]
}
const report = events => buildReport(events.map(x => JSON.stringify(x)).join('\n'), sha, run, 1)

test('every current isolated mail subtest belongs to exactly one outcome', () => {
  const source = fs.readFileSync(path.resolve(__dirname, '../../integration_test.go'), 'utf8').split('func TestIntegrationMailFlow')[1].split('// imapClient')[0]
  const actual = [...source.matchAll(/t\.Run\("([^"\n]+)"/g)].map(x => `${suite}/${x[1].replaceAll(' ', '_')}`)
  assert.equal(new Set(names).size, names.length)
  assert.deepEqual([...names].sort(), actual.sort())
  assert.equal(new Set(matrix.rows.map(x => x.id)).size, matrix.rows.length)
})
test('complete pass records exact provenance without claiming live or native acceptance', () => {
  const result = report(good())
  assert.equal(result.status, 'passed')
  assert.equal(result.sourceSha, sha)
  assert.equal(result.run, run)
  assert.equal(result.runAttempt, 1)
  assert.equal(result.providerAcceptance, 'not-tested')
  assert.equal(result.nativeAcceptance, 'not-tested')
  assert.ok(result.pending.every(x => x.status === 'not-tested'))
})
test('skip, failure, missing and incomplete mandatory tests never pass', () => {
  for (const action of ['skip', 'fail']) {
    const events = good()
    events.find(x => x.Test === names[0] && x.Action === 'pass').Action = action
    assert.equal(report(events).status, 'not-passed')
  }
  for (const events of [[], good().filter(x => x.Test !== names[0]), good().filter(x => !(x.Test === names[0] && x.Action === 'pass')), [event('start'), event('run', suite), event('skip', suite), event('pass')]]) {
    assert.equal(report(events).status, 'not-passed')
  }
})
test('package/suite interruption, failure and an unrelated failing test block the report', () => {
  for (const key of [undefined, suite]) {
    assert.equal(report(good().filter(x => !(x.Test === key && x.Action === 'pass'))).status, 'not-passed')
    const events = good()
    events.find(x => x.Test === key && x.Action === 'pass').Action = 'fail'
    assert.equal(report(events).status, 'not-passed')
  }
  assert.equal(report([...good(), { Action: 'build-fail', Package: 'other' }]).status, 'not-passed')
  assert.equal(report([...good(), event('run', 'Other'), event('fail', 'Other')]).status, 'not-passed')
})
test('duplicate/replayed events and terminal without start cannot manufacture a pass', () => {
  for (const extra of [event('pass', names[0]), event('run', names[0]), ...good()]) {
    assert.equal(report([...good(), extra]).status, 'not-passed')
  }
  assert.equal(report(good().filter(x => x.Action !== 'run')).status, 'not-passed')
  assert.equal(report(good().map(x => ({ ...x, Package: 'foreign' }))).status, 'not-passed')
})
test('malformed/truncated input fails closed and untrusted output is never copied', () => {
  const raw = good().map(x => JSON.stringify(x)).join('\n')
  for (const suffix of ['\n{', '\nnull', '\n[]', '\n{}']) assert.equal(buildReport(raw + suffix, sha, run, 1).status, 'not-passed')
  const result = report([...good(), { Action: 'output', Package: 'meron', Output: 'Authorization: secret; personal@example.com', Test: 'private-subject' }])
  assert.equal(result.status, 'passed')
  assert.doesNotMatch(JSON.stringify(result), /secret|personal@example|private-subject/)
})
test('provenance is mandatory and cannot redirect evidence to another repository', () => {
  for (const bad of ['', 'a'.repeat(39), 'Z'.repeat(40)]) assert.throws(() => buildReport('', bad, run), /SHA/)
  for (const bad of ['', 'http://github.com/adilelhaji/oreneta/actions/runs/123', run + '?token=private', run.replace('oreneta', 'other')]) assert.throws(() => buildReport('', sha, bad), /URL/)
  for (const bad of [undefined, NaN, 0, -1, 1.5, '1']) assert.throws(() => buildReport('', sha, run, bad), /attempt/)
  assert.equal(buildReport('', sha, run, 2).runAttempt, 2)
})
test('CLI writes failure evidence for missing input and succeeds only for a complete run', t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'oreneta-evidence-'))
  const input = path.join(directory, 'events.jsonl')
  const output = path.join(directory, 'report.json')
  t.after(() => {
    for (const file of [input, output]) fs.rmSync(file, { force: true })
    fs.rmdirSync(directory)
  })
  const execute = () => spawnSync(process.execPath, [path.join(__dirname, 'provider-acceptance.cjs'), input, output, sha, run, '1'], { encoding: 'utf8' })
  assert.equal(execute().status, 1)
  assert.equal(JSON.parse(fs.readFileSync(output, 'utf8')).suiteStatus, 'missing')
  fs.writeFileSync(input, good().map(x => JSON.stringify(x)).join('\n'))
  assert.equal(execute().status, 0)
  assert.equal(JSON.parse(fs.readFileSync(output, 'utf8')).status, 'passed')
  fs.appendFileSync(input, '\ntruncated event')
  assert.equal(execute().status, 1)
  assert.equal(JSON.parse(fs.readFileSync(output, 'utf8')).malformedInput, true)
})
test('CI reports fresh results even on failure and uploads only the sanitized report', () => {
  const ci = fs.readFileSync(path.resolve(__dirname, '../../.github/workflows/test.yml'), 'utf8').split('  integration:')[1]
  assert.match(ci, /go test .* -json -count=1 .*integration-results\/events\.jsonl/)
  assert.match(ci, /name: Summarize isolated mail acceptance\s+if: always\(\)/)
  assert.match(ci, /provider-acceptance\.cjs integration-results\/events\.jsonl integration-results\/report\.json/)
  assert.match(ci, /name: Upload isolated mail acceptance\s+if: always\(\)/)
  assert.match(ci, /path: integration-results\/report\.json/)
  assert.match(ci, /EVIDENCE_ATTEMPT: \$\{\{ github.run_attempt \}\}/)
  assert.match(ci, /"\$EVIDENCE_RUN" "\$EVIDENCE_ATTEMPT"/)
  assert.match(ci, /name: isolated-mail-acceptance-\$\{\{ github.sha \}\}-attempt-\$\{\{ github.run_attempt \}\}/)
  assert.doesNotMatch(ci, /continue-on-error|secrets\./)
})
