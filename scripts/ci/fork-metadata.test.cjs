// Release metadata names this fork, not the upstream Meron/Nonbili project (#249).
const { test } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')

const root = path.resolve(__dirname, '../..')
const read = (file) => fs.readFileSync(path.join(root, file), 'utf8')
const metainfo = read('metadata/flatpak/io.github.adilelhaji.oreneta.metainfo.xml')

test('Flatpak metainfo screenshots are hosted in this repository', () => {
  const images = [...metainfo.matchAll(/<image>([^<]+)<\/image>/g)].map((match) => match[1])
  assert.ok(images.length > 0)
  for (const url of images) {
    const parts = url.match(/^https:\/\/raw\.githubusercontent\.com\/adilelhaji\/oreneta\/[0-9a-f]{40}\/(screenshots\/[\w-]+\.png)$/)
    assert.ok(parts, `screenshot not pinned to this repository: ${url}`)
    assert.ok(fs.existsSync(path.join(root, parts[1])), `screenshot missing from the repository: ${parts[1]}`)
  }
})

test('Flatpak metainfo names the fork owner and nothing upstream', () => {
  assert.match(metainfo, /<developer>\s*<name>Adil El Haji<\/name>\s*<\/developer>/)
  assert.doesNotMatch(metainfo, /nonbili/i)
})

test('the repository has no funding links to the upstream maintainers', () => {
  assert.equal(fs.existsSync(path.join(root, '.github/FUNDING.yml')), false)
})

function kotlinSources(dir) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) return entry.name === 'build' ? [] : kotlinSources(full)
    return entry.name.endsWith('.kt') ? [full] : []
  })
}

test('mobile log tags are Oreneta.*, never Meron', () => {
  const sources = kotlinSources(path.join(root, 'mobile'))
  assert.ok(sources.length > 0)
  const offenders = []
  for (const file of sources) {
    const source = fs.readFileSync(file, 'utf8')
    // A Log call or a *TAG constant whose literal starts with Meron, or a
    // platform prefix written as "Meron.$tag".
    const pattern = /Log\.[diwe]\(\s*"Meron|TAG\s*=\s*"Meron|"Meron\.\$/g
    if (pattern.test(source)) offenders.push(path.relative(root, file))
  }
  assert.deepEqual(offenders, [])
})

test('Android release APKs are named after Oreneta', () => {
  const workflow = read('.github/workflows/android-release.yml')
  const renamed = [...workflow.matchAll(/^\s*mv android-[\w-]+-release\.apk "([^"]+)"/gm)].map((match) => match[1])
  assert.deepEqual(renamed, [
    'oreneta-${MERON_VERSION_NAME}.apk',
    'oreneta-${MERON_VERSION_NAME}-arm64-v8a.apk',
    'oreneta-${MERON_VERSION_NAME}-armeabi-v7a.apk',
  ])
  assert.match(workflow, /files: mobile\/android\/build\/outputs\/apk\/release\/oreneta-\*\.apk/)
  assert.doesNotMatch(workflow, /meron-[^\s"]*\.apk/)
})
