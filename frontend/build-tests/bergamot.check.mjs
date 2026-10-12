import { test } from 'node:test'
import assert from 'node:assert/strict'
import { Worker } from 'node:worker_threads'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

// Bergamot (#106) as the app ships it: its worker and WebAssembly, run here
// by Node, with the published model checked against the registry. No network:
// the model comes from ORENETA_TRANSLATION_MODELS (scripts/fetch-translation-test-model.mjs).
const root = fileURLToPath(new URL('..', import.meta.url))
const models = process.env.ORENETA_TRANSLATION_MODELS ?? path.join(root, '.translation-models')
const registry = JSON.parse(fs.readFileSync(path.join(root, '../meron-core/src/translation/registry.json'), 'utf8'))

function start() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'oreneta-bergamot-'))
  const source = path.join(root, 'node_modules/@browsermt/bergamot-translator/worker')
  for (const file of fs.readdirSync(source)) fs.copyFileSync(path.join(source, file), path.join(dir, file))
  // The package says it is an ES module; its worker is a classic script.
  fs.writeFileSync(path.join(dir, 'package.json'), '{"type":"commonjs"}')
  const worker = new Worker(path.join(dir, 'translator-worker.js'))
  let next = 0
  const pending = new Map()
  worker.on('message', ({ id, result, error }) => {
    const call = pending.get(id)
    pending.delete(id)
    error ? call.reject(Object.assign(new Error(error.message), error)) : call.resolve(result)
  })
  const call = (name, ...args) =>
    new Promise((resolve, reject) => {
      const id = ++next
      pending.set(id, { resolve, reject })
      worker.postMessage({ id, name, args })
    })
  return { call, stop: () => worker.terminate() }
}

test('the shipped Bergamot starts without a model', async () => {
  const { call, stop } = start()
  await call('initialize', { cacheSize: 0 })
  await stop()
})

const installed = Object.values(registry.esen).every((f) => fs.existsSync(path.join(models, 'esen', f.name)))
test('translates Spanish to English with the published model, keeping the HTML', { skip: !installed && 'no model fetched' }, async () => {
  const read = (file) => {
    const bytes = fs.readFileSync(path.join(models, 'esen', file.name))
    assert.equal(bytes.length, file.size)
    return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength)
  }
  const { call, stop } = start()
  await call('initialize', { cacheSize: 0 })
  await call('loadTranslationModel', { from: 'es', to: 'en' }, {
    model: read(registry.esen.model),
    shortlist: read(registry.esen.lex),
    vocabs: [read(registry.esen.vocab)],
  })
  const [plain, html] = await call('translate', {
    models: [{ from: 'es', to: 'en' }],
    texts: [
      { text: 'Hola Marta, te mando el presupuesto revisado para la cocina esta tarde.', html: false },
      { text: '<p>Gracias por tu <b>ayuda</b> con la reunión del martes.</p>', html: true },
    ],
  })
  assert.match(plain.target.text, /budget/i)
  assert.match(html.target.text, /^<p>.*<b>help<\/b>.*<\/p>$/)
  await stop()
})
