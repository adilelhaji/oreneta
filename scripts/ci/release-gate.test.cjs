'use strict'

const { test } = require('node:test')
const assert = require('node:assert/strict')
const { verifyRelease, REQUIRED_JOBS } = require('./release-gate.cjs')
const SHA = 'a'.repeat(40)
const OTHER = 'b'.repeat(40)

function fixture() {
  const state = {
    runs: [{ id: 42, head_sha: SHA, head_branch: 'main', event: 'push',
      path: '.github/workflows/test.yml', status: 'completed', conclusion: 'success',
      run_number: 10, run_attempt: 1, html_url: 'https://github.com/example/app/actions/runs/42' }],
    jobs: REQUIRED_JOBS.map(name => ({ name, status: 'completed', conclusion: 'success' })),
    ref: { type: 'commit', sha: SHA },
    tagObject: { type: 'commit', sha: SHA },
  }
  const listJobsForWorkflowRun = () => {}
  const github = {
    rest: {
      actions: {
        listWorkflowRuns: async args => {
          assert.equal(args.head_sha, SHA)
          assert.equal(args.branch, 'main')
          assert.equal(args.event, 'push')
          assert.equal(args.workflow_id, 'test.yml')
          return { data: { workflow_runs: state.runs } }
        },
        listJobsForWorkflowRun,
      },
      git: {
        getRef: async () => {
          if (state.refError) throw Object.assign(new Error('GitHub error'), { status: state.refError })
          return { data: { object: state.ref } }
        },
        getTag: async () => ({ data: { object: state.tagObject } }),
      },
    },
    paginate: async (method, args) => {
      assert.equal(method, listJobsForWorkflowRun)
      assert.equal(args.run_id, 42)
      assert.equal(args.filter, 'latest')
      return state.jobs
    },
  }
  return { state, github, check: options => verifyRelease({ github, owner: 'example', repo: 'app',
    sha: SHA, tag: 'v1.0.0', ...options }) }
}

test('accepts a completed main run with all suites on the release SHA', async () => {
  const { check } = fixture()
  assert.equal((await check()).sha, SHA)
})

for (const patch of [
  { head_sha: OTHER }, { head_branch: 'feature' }, { event: 'pull_request' },
  { path: '.github/workflows/other.yml' }, { status: 'in_progress' },
  { conclusion: 'failure' }, { conclusion: 'cancelled' },
]) {
  test(`rejects unverified run: ${JSON.stringify(patch)}`, async () => {
    const { state, check } = fixture()
    Object.assign(state.runs[0], patch)
    await assert.rejects(check(), /Release blocked/)
  })
}

test('rejects missing CI and does not use an older green run', async () => {
  const { state, check } = fixture()
  state.runs.push({ ...state.runs[0], id: 43, run_number: 11, conclusion: 'failure' })
  await assert.rejects(check(), /latest main CI/)
  state.runs = []
  await assert.rejects(check(), /latest main CI/)
})

for (const name of REQUIRED_JOBS) {
  for (const conclusion of ['failure', 'skipped', 'cancelled', null]) {
    test(`rejects ${name} when ${conclusion}`, async () => {
      const { state, check } = fixture()
      state.jobs.find(job => job.name === name).conclusion = conclusion
      await assert.rejects(check(), new RegExp(`required job ${name}`))
    })
  }
}

test('rejects missing, duplicate, or pending required jobs', async () => {
  const { state, check } = fixture()
  const removed = state.jobs.pop()
  await assert.rejects(check(), /required job/)
  state.jobs.push(removed, removed)
  await assert.rejects(check(), /required job/)
  state.jobs.pop()
  removed.status = 'in_progress'
  await assert.rejects(check(), /required job/)
})

test('peels annotated tags and rejects mismatched targets', async () => {
  const { state, check } = fixture()
  state.ref = { type: 'tag', sha: OTHER }
  await check()
  state.tagObject.sha = OTHER
  await assert.rejects(check(), /does not point/)
})

test('only a manual desktop release may create a missing tag', async () => {
  const { state, check } = fixture()
  state.refError = 404
  await assert.rejects(check())
  await check({ allowMissingTag: true })
  state.refError = 403
  await assert.rejects(check({ allowMissingTag: true }))
})

test('rejects a short or invalid SHA', async () => {
  const { check } = fixture()
  await assert.rejects(check({ sha: 'abc123' }), /full release commit/)
})

// Execute the actual workflow script with the same injected dependencies as
// github-script. This also tests event/tag routing, not only the API policy.
const fs = require('node:fs')
const path = require('node:path')
const workflowDir = path.resolve(__dirname, '../../.github/workflows')
const workflow = fs.readFileSync(path.join(workflowDir, 'verify-release.yml'), 'utf8')
const script = workflow.split(/script: \|\r?\n/)[1].replace(/^            /gm, '')
const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor
const executeWorkflow = new AsyncFunction('github', 'context', 'core', 'require', 'process', script)

async function runWorkflow({ product = 'desktop', ref = 'refs/heads/main',
  eventName = 'workflow_dispatch', statePatch = {} } = {}) {
  const { github, state } = fixture()
  Object.assign(state, statePatch)
  const notices = []
  const summary = {
    addHeading() { return this }, addRaw() { return this }, async write() {},
  }
  await executeWorkflow(github, { sha: SHA, ref, eventName,
    repo: { owner: 'example', repo: 'app' } },
  { notice: value => notices.push(value), summary },
  name => name === 'node:fs'
    ? { readFileSync: () => JSON.stringify({ info: { productVersion: '1.0.0' } }) }
    : require('./release-gate.cjs'), { env: { RELEASE_PRODUCT: product } })
  assert.match(notices[0], new RegExp(SHA))
}

test('workflow permits validated manual desktop and Android builds', async () => {
  await runWorkflow({ statePatch: { refError: 404 } })
  await runWorkflow({ product: 'android', statePatch: { refError: 404 } })
})

test('workflow validates pushed tags and never allows missing pushed tags', async () => {
  await runWorkflow({ ref: 'refs/tags/v1.0.0', eventName: 'push' })
  await runWorkflow({ product: 'android', ref: 'refs/tags/android/v1.0.0', eventName: 'push' })
  await assert.rejects(runWorkflow({ ref: 'refs/tags/v1.0.0', eventName: 'push',
    statePatch: { refError: 404 } }))
})

test('workflow blocks version mismatch, mismatched manual tags and unknown products', async () => {
  await assert.rejects(runWorkflow({ ref: 'refs/tags/v9.0.0' }), /productVersion/)
  await assert.rejects(runWorkflow({ ref: 'refs/tags/v1.0.0',
    statePatch: { ref: { type: 'commit', sha: OTHER } } }), /does not point/)
  await assert.rejects(runWorkflow({ product: 'other' }), /Unknown release product/)
})

test('both release builders depend on the reusable gate without bypass conditions', () => {
  for (const [filename, product] of [['release.yml', 'desktop'], ['android-release.yml', 'android']]) {
    const source = fs.readFileSync(path.join(workflowDir, filename), 'utf8')
    assert.match(source, new RegExp(`  verify:\\r?\\n    uses: \\./\\.github/workflows/verify-release\\.yml\\r?\\n    with:\\r?\\n      product: ${product}`))
    const build = source.split(/^  build:/m)[1].split(/^  [a-z]+:/m)[0]
    assert.match(build, /^    needs: verify\r?$/m)
    assert.doesNotMatch(build, /^    (if|continue-on-error):/m)
  }
  const desktop = fs.readFileSync(path.join(workflowDir, 'release.yml'), 'utf8')
  assert.match(desktop, /target_commitish: \$\{\{ github.sha \}\}/)
  const ci = fs.readFileSync(path.join(workflowDir, 'test.yml'), 'utf8')
  for (const job of REQUIRED_JOBS) assert.match(ci, new RegExp(`^  ${job}:`, 'm'))
})
