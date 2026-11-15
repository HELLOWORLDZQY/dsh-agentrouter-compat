// Optional smoke test for the exact OpenAI SDK resolved by the running DSH.
// All network calls are replaced with an in-memory transport; no real key is used.
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { createFetchLifecycle } from '../lib/lifecycle.js'

if (!process.env.DSH_INSTALL_DIR) {
  throw new Error('Run this optional check from a DSH shell (DSH_INSTALL_DIR is required).')
}
const fromDsh = createRequire(join(process.env.DSH_INSTALL_DIR, 'package.json'))
const adapterManifest = fromDsh.resolve('@deepseek-ai/dsh-llm-pi-ai/package.json')
const fromAdapter = createRequire(adapterManifest)
const { default: OpenAI } = await import(pathToFileURL(fromAdapter.resolve('openai')).href)

const originalFetch = globalThis.fetch
const seen = []
const transport = async (url, init) => {
  assert.equal(new URL(url).pathname, '/v1/responses')
  assert.equal(typeof init.body, 'string', 'SDK must still serialize into init.body')
  const body = JSON.parse(init.body)
  seen.push(body)
  const bad = 'previous_response_id' in body || body.input.some(item => 'id' in item || item.type === 'item_reference')
  return new Response(JSON.stringify(bad
    ? { error: { message: 'The requested item was created under a different resource.', type: 'invalid_request_error' } }
    : { id: 'resp_synthetic', object: 'response', status: 'completed', output: [] }), {
    status: bad ? 400 : 200,
    headers: { 'content-type': 'application/json' },
  })
}
globalThis.fetch = transport
const lifecycle = createFetchLifecycle(globalThis, {})
const payload = {
  model: 'synthetic-model', stream: false, store: false, previous_response_id: 'resp_other_resource',
  input: [
    { type: 'reasoning', id: 'rs_other_resource', summary: [], encrypted_content: 'synthetic-ciphertext' },
    { type: 'function_call', id: 'fc_other_resource', call_id: 'call_pair', name: 'lookup', arguments: '{}' },
    { type: 'function_call_output', call_id: 'call_pair', output: 'synthetic-result' },
  ],
}
try {
  // Baseline proves the fake second resource rejects the original replay.
  const before = new OpenAI({ apiKey: 'test-only-not-a-real-key', baseURL: 'https://relay.agentrouter.internal/v1', maxRetries: 0 })
  await assert.rejects(before.responses.create(payload), error => error.status === 400)
  lifecycle.ensureOuter()
  const enabled = new OpenAI({ apiKey: 'test-only-not-a-real-key', baseURL: 'https://relay.agentrouter.internal/v1', maxRetries: 0 })
  assert.equal((await enabled.responses.create(payload)).status, 'completed')
  assert.equal(seen[1].input[0].encrypted_content, 'synthetic-ciphertext')
  assert.equal(seen[1].input[1].call_id, seen[1].input[2].call_id)
  assert.equal(seen[1].input[1].arguments, '{}')
  assert.equal(payload.input[1].id, 'fc_other_resource', 'source payload stays intact')
  lifecycle.dispose()
  // Even a client retaining the compatibility wrapper stops rewriting on unload.
  await assert.rejects(enabled.responses.create(payload), error => error.status === 400)
  assert.equal(seen.length, 3, 'the plugin must not add retries')
  console.log('Installed OpenAI SDK smoke passed: baseline 400 → compatibility 200 → disposed 400. No network used.')
} finally {
  lifecycle.dispose()
  globalThis.fetch = originalFetch
}
