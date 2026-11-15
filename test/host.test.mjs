import assert from 'node:assert/strict'
import { test } from 'node:test'
import { Context, Service } from '@deepseek-ai/cordis'
import * as plugin from '../index.js'

class LlmFixture extends Service {
  constructor(ctx) { super(ctx, 'llm') }
}

const url = 'https://relay.agentrouter.internal/v1/responses'
const body = JSON.stringify({ input: [{ type: 'function_call', id: 'fc_other_pool', call_id: 'call_pair', name: 'lookup', arguments: '{}' }] })

test('the real Cordis fiber mounts, guards downstream direct fetch and cleans up', async () => {
  const originalFetch = globalThis.fetch
  const seen = []
  const native = (_input, options) => {
    seen.push(options.body)
    return Promise.resolve(new Response('ok'))
  }
  globalThis.fetch = native
  const root = new Context()
  try {
    await root.plugin(LlmFixture)
    const fiber = await root.plugin(plugin, { announce: false })
    assert.notEqual(globalThis.fetch, native)
    const cached = globalThis.fetch
    const direct = (_input, options) => {
      seen.push(options.body)
      return Promise.resolve(new Response('direct'))
    }
    globalThis.fetch = direct
    const frozenOptions = Object.freeze({ provider: 'agentrouter-responses', messages: Object.freeze([]) })
    const expected = JSON.stringify(frozenOptions)
    const stream = (async function* () {
      const response = await globalThis.fetch(url, { method: 'POST', body })
      yield await response.text()
    })()
    const received = root.waterfall(root.llm, 'llm/stream', frozenOptions, () => stream)
    assert.equal(received, stream, 'next result must not be replaced')
    assert.notEqual(globalThis.fetch, direct, 'hook must restore the outer position before next')
    assert.deepEqual(await Array.fromAsync(received), ['direct'])
    assert.equal(Object.hasOwn(JSON.parse(seen[0]).input[0], 'id'), false)
    assert.equal(JSON.parse(seen[0]).input[0].call_id, 'call_pair')
    assert.equal(JSON.stringify(frozenOptions), expected)
    await fiber.dispose()
    assert.equal(globalThis.fetch, direct)
    // A stale cached wrapper is inert, and the disposed event no longer rewraps.
    await cached(url, { method: 'POST', body })
    assert.equal(seen[1], body)
    const marker = {}
    assert.equal(root.waterfall(root.llm, 'llm/stream', frozenOptions, () => marker), marker)
    assert.equal(globalThis.fetch, direct)
  } finally {
    await root.fiber.dispose()
    globalThis.fetch = originalFetch
  }
})

test('config schema supplies defaults and rejects wrongly typed controls', () => {
  const config = plugin.Config({})
  assert.deepEqual(config.hosts, ['relay.agentrouter.internal', 'agentrouter.org', 'ps.air-outer.com'])
  assert.deepEqual(config.paths, ['/v1/responses'])
  assert.equal(config.allowHttp, false)
  assert.equal(config.announce, true)
  assert.throws(() => plugin.Config({ hosts: '*' }))
  assert.throws(() => plugin.Config({ allowHttp: 'true' }))
})
