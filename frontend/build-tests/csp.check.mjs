import { test } from 'node:test'
import assert from 'node:assert/strict'
import { productionCsp } from '../vite.config.js'

// The e2e suite runs under this policy (vite preview), so it must be read
// exactly as Go builds it.
test('the production CSP is read whole from csp_prod.go', () => {
  const policy = productionCsp()
  assert.match(policy, /^default-src 'self'; script-src 'self' 'wasm-unsafe-eval'; /)
  assert.match(policy, /frame-ancestors 'none'$/)
  assert.ok(!policy.split(/[\s;]+/).includes("'unsafe-eval'"), 'no JavaScript eval in production')
  assert.doesNotMatch(policy, /fonts\.g/, 'fonts are bundled')
})

test('a policy written across lines with a comment after it is read to its end', () => {
  const source = `package main\n\nconst contentSecurityPolicy = "default-src 'self'; " +\n\t"img-src data:"\n\n// next\nconst other = "x"\n`
  assert.equal(productionCsp(source), "default-src 'self'; img-src data:")
})
