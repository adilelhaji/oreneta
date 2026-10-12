#!/usr/bin/env node
// Fails when a binary carries any of the inherited (Meron) OAuth values that
// only internal development builds may compile in (oauth_inherited.go). Run on
// a `-tags distributable` build: see docs/oauth-registrations.md.
'use strict'
const fs = require('node:fs')
const path = require('node:path')

function inheritedValues(source) {
  const values = []
  for (const match of source.matchAll(/^\s*(\w+Obf)\s*=\s*"([^"]+)"/gm)) values.push({ name: match[1], value: match[2] })
  return values
}

function leakedValues(binary, values) {
  return values.filter(({ value }) => binary.includes(Buffer.from(value)))
}

function main(argv) {
  const target = argv[2]
  if (!target) throw new Error('usage: inherited-oauth.cjs <binary>')
  const source = fs.readFileSync(path.resolve(__dirname, '../../oauth_inherited.go'), 'utf8')
  const values = inheritedValues(source)
  if (values.length === 0) throw new Error('no inherited OAuth values found in oauth_inherited.go')
  const leaked = leakedValues(fs.readFileSync(target), values)
  if (leaked.length > 0) {
    // Names only: the values themselves stay out of the log.
    throw new Error(`binary carries inherited OAuth values: ${leaked.map(({ name }) => name).join(', ')}`)
  }
  console.log(`no inherited OAuth value in ${path.basename(target)} (${values.length} checked)`)
}

if (require.main === module) {
  try {
    main(process.argv)
  } catch (error) {
    console.error(error.message)
    process.exit(1)
  }
}

module.exports = { inheritedValues, leakedValues }
