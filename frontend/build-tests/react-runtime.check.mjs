import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { build } from 'vite'

const root = fileURLToPath(new URL('..', import.meta.url))

for (const config of ['vite.config.js', 'baseline/vite.config.ts']) {
  test(`${config}: a linked dependency uses the application's React runtime`, async t => {
    const linked = await mkdtemp(path.join(tmpdir(), 'oreneta-linked-react-'))
    t.after(() => rm(linked, { recursive: true, force: true }))
    for (const name of ['react', 'react-dom']) {
      const dir = path.join(linked, 'node_modules', name)
      await mkdir(dir, { recursive: true })
      await writeFile(path.join(dir, 'package.json'), JSON.stringify({
        name, version: '0.0.0-test', main: 'index.js',
        exports: { '.': './index.js', './client': './index.js', './jsx-runtime': './index.js' },
      }))
      await writeFile(path.join(dir, 'index.js'), 'export const duplicateRuntime = true\n')
    }
    const entry = path.join(linked, 'entry.js')
    await writeFile(entry, `
      import * as react from 'react';
      import * as jsx from 'react/jsx-runtime';
      import * as dom from 'react-dom';
      import * as client from 'react-dom/client';
      console.log(react, jsx, dom, client);
    `)
    const result = await build({
      root,
      configFile: path.join(root, config),
      logLevel: 'error',
      build: { write: false, minify: false, rollupOptions: { input: entry } },
    })
    const outputs = Array.isArray(result) ? result : [result]
    const modules = outputs.flatMap(output => output.output.flatMap(chunk =>
      chunk.type === 'chunk' ? Object.keys(chunk.modules).map(id => id.replaceAll('\\', '/')) : [],
    ))
    assert.ok(modules.some(id => id.endsWith('/react/cjs/react.production.js')))
    assert.ok(modules.some(id => id.endsWith('/react-dom/cjs/react-dom-client.production.js')))
    assert.ok(!modules.some(id => id.startsWith(linked.replaceAll('\\', '/') + '/node_modules/')),
      'the production bundle must not include a linked dependency\'s private React runtime')
  })
}
