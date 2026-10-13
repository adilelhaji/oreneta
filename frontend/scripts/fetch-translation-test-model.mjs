// Fetches the Spanish→English translation model the tests use (#106) into
// .translation-models/, checked against the registry the app ships. 22 MB,
// so it is not in the repository; a file already there and intact is kept.
import { createHash } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('..', import.meta.url))
const registry = JSON.parse(fs.readFileSync(path.join(root, '../meron-core/src/translation/registry.json'), 'utf8'))
// The project's own copy first, as the app does (ADR-0031); Mozilla's bucket
// it was copied from while that release is not yet published.
const SOURCES = [
  (file) => `https://github.com/adilelhaji/oreneta/releases/download/translation-models-0.3.3/${key}-${file}`,
  (file) => `https://storage.googleapis.com/bergamot-models-sandbox/0.3.3/${key}/${file}`,
]
const key = process.argv[2] ?? 'esen'
const dir = path.join(process.env.ORENETA_TRANSLATION_MODELS ?? path.join(root, '.translation-models'), key)
fs.mkdirSync(dir, { recursive: true })

const sha = (bytes) => createHash('sha256').update(bytes).digest('hex')
for (const file of Object.values(registry[key])) {
  const target = path.join(dir, file.name)
  if (fs.existsSync(target) && sha(fs.readFileSync(target)) === file.expectedSha256Hash) continue
  let response
  for (const source of SOURCES) {
    response = await fetch(source(file.name))
    if (response.ok) break
  }
  if (!response.ok) throw new Error(`${file.name}: ${response.status}`)
  const bytes = Buffer.from(await response.arrayBuffer())
  if (bytes.length !== file.size || sha(bytes) !== file.expectedSha256Hash) {
    throw new Error(`${file.name} does not match the registry`)
  }
  fs.writeFileSync(target, bytes)
  console.log(`fetched ${file.name} (${bytes.length} bytes)`)
}
console.log(dir)
