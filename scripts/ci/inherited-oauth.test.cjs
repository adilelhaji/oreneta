'use strict'
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const test = require('node:test')
const { inheritedValues, leakedValues } = require('./inherited-oauth.cjs')

const root = path.resolve(__dirname, '../..')

test('reads every inherited value from the development-only file', () => {
  const source = fs.readFileSync(path.join(root, 'oauth_inherited.go'), 'utf8')
  assert.match(source, /^\/\/go:build !distributable$/m)
  const names = inheritedValues(source).map(({ name }) => name)
  assert.deepEqual(names.sort(), ['googleClientIDObf', 'googleClientSecretObf', 'outlookClientIDObf'])
})

test('the distributable file compiles in no value of its own', () => {
  const source = fs.readFileSync(path.join(root, 'oauth_distributable.go'), 'utf8')
  assert.match(source, /^\/\/go:build distributable$/m)
  assert.deepEqual(inheritedValues(source), [])
})

test('flags a binary that carries an inherited value, by name only', () => {
  const values = [
    { name: 'googleClientIDObf', value: 'AAAA' },
    { name: 'outlookClientIDObf', value: 'BBBB' },
  ]
  assert.deepEqual(leakedValues(Buffer.from('header BBBB trailer'), values), [values[1]])
  assert.deepEqual(leakedValues(Buffer.from('nothing here'), values), [])
})

test('CI builds the distributable binary and checks it', () => {
  const ci = fs.readFileSync(path.join(root, '.github/workflows/test.yml'), 'utf8').split('  go-windows:')[0]
  assert.match(ci, /go test -tags "webkit2_41 distributable"/)
  assert.match(ci, /go build -tags "webkit2_41 distributable" -o "\$RUNNER_TEMP\/oreneta-distributable"/)
  assert.match(ci, /node scripts\/ci\/inherited-oauth\.cjs "\$RUNNER_TEMP\/oreneta-distributable"/)
})
