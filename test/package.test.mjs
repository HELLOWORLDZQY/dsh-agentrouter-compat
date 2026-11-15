import assert from 'node:assert/strict'
import { test } from 'node:test'
import { readFile, stat } from 'node:fs/promises'
import { load } from 'js-yaml'

const root = new URL('../', import.meta.url)
const text = path => readFile(new URL(path, root), 'utf8')

test('bundle only inserts its own entry, with no provider or profile overrides', async () => {
  const manifest = JSON.parse(await text('package.json'))
  assert.equal(manifest.name, 'dsh-agentrouter-compat')
  assert.equal(manifest.dsh.bundle.patch, './cordis.patch.yml')
  assert.equal(manifest.dsh.client, undefined)
  const patch = load(await text('cordis.patch.yml'))
  assert.deepEqual(patch, [{ insert: [{ id: 'agentrouter-responses-compat', name: 'dsh-agentrouter-compat', config: {} }] }])
  for (const script of ['preinstall', 'install', 'postinstall', 'prepare', 'prepack']) {
    assert.equal(manifest.scripts[script], undefined)
  }
  assert.deepEqual(Object.keys(manifest.dependencies), ['@deepseek-ai/schemastery'])
})

test('exported locales and icon exist without a broken custom detail resource', async () => {
  const manifest = JSON.parse(await text('package.json'))
  assert.equal(manifest.exports['./locale/*.json'], './locale/*.json')
  assert.equal(manifest.exports['./icon'], './icon.svg')
  for (const language of ['en', 'zh']) {
    const locale = JSON.parse(await text(`locale/${language}.json`))
    assert.ok(locale.meta.title.length > 5)
    assert.ok(locale.meta.description.length > 100)
    assert.equal(locale.meta.detail, undefined, 'README fallback is deliberate')
  }
  const icon = await text('icon.svg')
  assert.match(icon, /<svg[^>]+viewBox="0 0 36 36"/)
  assert.match(icon, /<\/svg>\s*$/)
  assert.doesNotMatch(icon, /<(script|style|image|foreignObject|text)\b|\bon\w+=|href=/i)
  assert.ok((await stat(new URL('icon.svg', root))).size < 256 * 1024)
})
