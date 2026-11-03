'use strict'

// The Claude Code hooks in .claude/hooks are the part of the workflow that admits
// no exception, so what they block and what they let through is pinned here.

const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { spawnSync } = require('node:child_process')

const hooks = path.join(__dirname, '..', '..', '.claude', 'hooks')

// The owner's exception, if exported where the tests run, must not change them.
const { ORENETA_ALLOW_PROTECTED: _exception, ...cleanEnv } = process.env

function run(hook, input, options = {}) {
  return spawnSync('bash', [path.join(hooks, hook)], {
    input: JSON.stringify(input),
    encoding: 'utf8',
    env: cleanEnv,
    ...options,
  })
}

function git(cwd, ...args) {
  const result = spawnSync('git', ['-c', 'user.name=test', '-c', 'user.email=test@example.invalid', '-c', 'commit.gpgsign=false', ...args], {
    cwd,
    encoding: 'utf8',
  })
  assert.equal(result.status, 0, result.stderr)
}

function repoOn(branch) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'workflow-hooks-'))
  git(dir, 'init', '-q', '-b', branch)
  fs.writeFileSync(path.join(dir, 'file.txt'), 'one\n')
  git(dir, 'add', '.')
  git(dir, 'commit', '-q', '-m', 'first')
  return dir
}

const featureRepo = repoOn('issue-1-feature')
const mainRepo = repoOn('main')
test.after(() => {
  fs.rmSync(featureRepo, { recursive: true, force: true })
  fs.rmSync(mainRepo, { recursive: true, force: true })
})

for (const command of [
  'git push origin main',
  'git push -u origin main',
  'git push origin HEAD:main',
  'git push origin HEAD:refs/heads/main',
  'git push upstream master',
  'git -C /some/dir push origin main',
  'git push --force origin issue-1-feature',
  'git push --force-with-lease',
  'git push -f',
  'git push -uf origin issue-1-feature',
  'git push origin +issue-1-feature',
  'git commit --no-verify -m text',
  'git branch -D main',
  'git branch --delete main',
  'git reset --hard origin/main',
  'git fetch origin && git push origin main',
  'git push --force-with-lease=issue-1:abc origin issue-1',
  'git push -fu origin issue-1',
  'git push --mirror',
  'git push --all origin',
  'git push origin "main"',
  "git push origin 'HEAD:main'",
  'git push origin "+issue-1"',
  "git push origin 'refs/heads/*:refs/heads/*'",
  '(git push origin main)',
  'git --no-pager push origin main',
  'git commit -n -m text',
  'git commit -nm text',
  'git commit -m "text" --no-verify',
  'git merge --no-verify origin/main',
  'git branch -df main',
  'git branch -d issue-1 main',
  'git reset origin/main --hard',
  'git diff --output=.claude/hooks/protect-main.sh',
  'git log --output .claude/hooks/protect-main.sh',
  'git fetch origin\ngit push origin main',
]) {
  test(`protect-main blocks: ${command}`, () => {
    const result = run('protect-main.sh', { tool_input: { command } }, { cwd: featureRepo })
    assert.equal(result.status, 2, result.stderr)
  })
}

for (const command of [
  'git push',
  'git push -u origin issue-1-feature',
  'git push origin issue-1-main-menu',
  'git push --follow-tags origin issue-1-feature',
  'git merge origin/main',
  'git branch -D issue-1-feature',
  'git reset --hard HEAD~1',
  'go test ./...',
  'git push -n -u origin issue-1-feature',
  'git push origin HEAD 2>&1',
  'git push origin main:issue-1-feature',
  'git push -u origin issue-1\ngit log --oneline main',
  'git push -u origin issue-1\nrm -rf /tmp/scratch-dir',
  'git commit -m "see git push origin main"',
  'git commit -m "fix the -n flag"',
  'git reset --hard origin/main-menu',
  'git diff origin/main...HEAD',
]) {
  test(`protect-main allows: ${command}`, () => {
    const result = run('protect-main.sh', { tool_input: { command } }, { cwd: featureRepo })
    assert.equal(result.status, 0, result.stderr)
  })
}

for (const command of [
  'git push',
  'git push origin',
  'git push -u origin HEAD',
  'git push origin HEAD 2>&1',
  'git push origin HEAD -u',
  'git push origin @',
  'git push -o ci.skip origin',
]) {
  test(`protect-main blocks on main: ${command}`, () => {
    const result = run('protect-main.sh', { tool_input: { command } }, { cwd: mainRepo })
    assert.equal(result.status, 2, result.stderr)
  })
}

test('protect-main reads the checkout a command points at', () => {
  for (const command of [`git -C ${mainRepo} push`, `cd ${mainRepo} && git push`]) {
    const result = run('protect-main.sh', { tool_input: { command } }, { cwd: featureRepo })
    assert.equal(result.status, 2, command)
  }
})

for (const file of [
  '/repo/.env',
  '/repo/.env.local',
  '/repo/build/signing.pem',
  '/repo/AuthKey.p8',
  '/repo/mobile/android/release.keystore',
  '/repo/mobile/android/google-services.json',
  '/repo/frontend/src/generated/locales.ts',
  '/repo/mobile/android/src/main/res/values-ca/strings.xml',
  '/repo/mobile/ui/src/commonMain/kotlin/jp/nonbili/meron/ui/GeneratedStrings.kt',
]) {
  test(`protect-paths blocks: ${file}`, () => {
    const result = run('protect-paths.sh', { tool_input: { file_path: file } })
    assert.equal(result.status, 2, result.stderr)
  })
}

for (const file of ['/repo/locales/ca.json', '/repo/frontend/src/App.tsx', '/repo/.env.example', '/repo/main.go']) {
  test(`protect-paths allows: ${file}`, () => {
    const result = run('protect-paths.sh', { tool_input: { file_path: file } })
    assert.equal(result.status, 0, result.stderr)
  })
}

test('protect-paths honours the owner exception', () => {
  const result = run(
    'protect-paths.sh',
    { tool_input: { file_path: '/repo/.env' } },
    { env: { ...cleanEnv, ORENETA_ALLOW_PROTECTED: '1' } },
  )
  assert.equal(result.status, 0, result.stderr)
})

test('check-on-stop checks each state once and blocks only on a failure', () => {
  const dir = repoOn('issue-2-stop')
  try {
    fs.mkdirSync(path.join(dir, 'scripts'))
    const script = path.join(dir, 'scripts', 'comprobar.sh')
    const counter = path.join(dir, '.git', 'runs')
    const stop = () =>
      run('check-on-stop.sh', {}, { cwd: dir, env: { ...cleanEnv, CLAUDE_PROJECT_DIR: dir } })
    const runs = () => fs.readFileSync(counter, 'utf8').length
    const scriptExiting = (code) => `printf x >> "${counter}"; echo the-output; exit ${code}\n`

    fs.writeFileSync(script, scriptExiting(1))
    const failure = stop()
    assert.equal(failure.status, 2)
    assert.match(failure.stderr, /the-output/)
    assert.equal(runs(), 1)

    assert.equal(stop().status, 0, 'a second stop on the same state ends the turn')
    assert.equal(runs(), 1)

    fs.writeFileSync(path.join(dir, 'file.txt'), 'two\n')
    assert.equal(stop().status, 2, 'a changed tree is checked again')
    assert.equal(runs(), 2)

    fs.writeFileSync(path.join(dir, 'file.txt'), 'three\n')
    fs.writeFileSync(script, scriptExiting(3))
    assert.equal(stop().status, 0, 'checks that could not run do not block')
    assert.equal(runs(), 3)
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})
