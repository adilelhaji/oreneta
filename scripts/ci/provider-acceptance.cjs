// Evidence from the isolated maddy suite only. Never connect to a mail account.
const fs = require('node:fs')
const path = require('node:path')
const matrix = require('../../docs/provider-acceptance-matrix.json')
const suite = 'TestIntegrationMailFlow'

function buildReport(input, sha, run, attempt) {
  if (!/^[0-9a-f]{40}$/.test(sha)) throw new Error('Expected full source SHA')
  if (!/^https:\/\/github\.com\/adilelhaji\/oreneta\/actions\/runs\/[1-9][0-9]*$/.test(run)) throw new Error('Expected repository workflow run URL')
  if (!Number.isSafeInteger(attempt) || attempt < 1) throw new Error('Expected positive run attempt')
  const records = new Map()
  let invalid = false
  let anyFailure = false
  for (const line of input.split(/\r?\n/).filter(x => x.trim())) {
    let event
    try { event = JSON.parse(line) } catch { invalid = true; continue }
    if (!event || typeof event !== 'object' || Array.isArray(event) || typeof event.Action !== 'string') {
      invalid = true
      continue
    }
    if (event.Action === 'fail' || event.Action === 'build-fail') anyFailure = true
    if (event.Package !== 'meron') continue
    const key = event.Test === undefined ? '<package>' : event.Test
    if (typeof key !== 'string') { invalid = true; continue }
    const record = records.get(key) || { started: false, terminal: null, invalid: false }
    if (event.Action === 'run' || (key === '<package>' && event.Action === 'start')) {
      if (record.started || record.terminal) record.invalid = true
      record.started = true
    } else if (['pass', 'fail', 'skip'].includes(event.Action)) {
      if (!record.started || record.terminal) record.invalid = true
      record.terminal = event.Action
    }
    records.set(key, record)
  }
  function status(key) {
    const r = records.get(key)
    if (!r || !r.started) return 'missing'
    if (r.invalid) return 'invalid'
    return ({ pass: 'passed', fail: 'failed', skip: 'skipped' })[r.terminal] || 'incomplete'
  }
  const rows = matrix.rows.map(row => ({
    id: row.id, outcome: row.outcome,
    tests: row.tests.map(name => ({ name: `${suite}/${name}`, status: status(`${suite}/${name}`) })),
  }))
  for (const row of rows) row.status = row.tests.every(x => x.status === 'passed') ? 'passed' : 'not-passed'
  const passed = !invalid && !anyFailure && [...records.values()].every(r => !r.invalid)
    && status('<package>') === 'passed' && status(suite) === 'passed'
    && rows.every(row => row.status === 'passed')
  return {
    schemaVersion: 1, sourceSha: sha, run, runAttempt: attempt,
    environment: 'isolated-maddy-imap-smtp',
    providerAcceptance: 'not-tested', nativeAcceptance: 'not-tested',
    status: passed ? 'passed' : 'not-passed',
    malformedInput: invalid, testFailure: anyFailure,
    packageStatus: status('<package>'), suiteStatus: status(suite), rows,
    pending: matrix.liveProviders,
  }
}

if (require.main === module) {
  const [input, output, sha, run, attempt] = process.argv.slice(2)
  if (!input || !output) throw new Error('Usage: provider-acceptance.cjs input.jsonl output.json sha run-url attempt')
  // A missing stream after a failed build produces explicit missing evidence.
  const report = buildReport(fs.existsSync(input) ? fs.readFileSync(input, 'utf8') : '', sha, run, Number(attempt))
  fs.mkdirSync(path.dirname(output), { recursive: true })
  fs.writeFileSync(output, JSON.stringify(report, null, 2) + '\n')
  console.log(`Isolated mail acceptance: ${report.status}; ${report.rows.filter(x => x.status === 'passed').length}/${report.rows.length} outcomes. Live providers and native app: not tested.`)
  if (report.status !== 'passed') process.exitCode = 1
}
module.exports = { buildReport }
