import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createFetchLifecycle } from '../lib/lifecycle.js'

const url = 'https://relay.agentrouter.internal/v1/responses'
const init = { method: 'POST', body: JSON.stringify({ input: [{ type: 'message', id: 'msg_other_pool', role: 'assistant', content: 'hello' }] }) }
const clean = body => !Object.hasOwn(JSON.parse(body).input[0], 'id')

function fixture() {
  const seen = []
  const native = function (_input, options) {
    seen.push({ target: this, body: options.body })
    return Promise.resolve(new Response('ok'))
  }
  const target = { fetch: native }
  return { target, native, seen }
}

test('ensuring an existing outer layer is idempotent and preserves transport this', async () => {
  const { target, native, seen } = fixture()
  const lifecycle = createFetchLifecycle(target, {})
  try {
    lifecycle.ensureOuter()
    const first = target.fetch
    for (let i = 0; i < 100; i++) lifecycle.ensureOuter()
    assert.equal(target.fetch, first)
    await target.fetch(url, init)
    assert.equal(seen.length, 1)
    assert.equal(seen[0].target, target)
    assert.equal(clean(seen[0].body), true)
  } finally { lifecycle.dispose() }
  assert.equal(target.fetch, native)
})

test('compat outside an existing direct relay rewrites before its bypass', async () => {
  const direct = []
  const target = { fetch: (_url, options) => {
    direct.push(options.body)
    return Promise.resolve(new Response('direct'))
  } }
  const original = target.fetch
  const lifecycle = createFetchLifecycle(target, {})
  try {
    lifecycle.ensureOuter()
    assert.equal(await (await target.fetch(url, init)).text(), 'direct')
    assert.equal(clean(direct[0]), true)
  } finally { lifecycle.dispose() }
  assert.equal(target.fetch, original)
})

test('a later direct relay is covered on the first request after ensureOuter', async () => {
  const { target, seen } = fixture()
  const lifecycle = createFetchLifecycle(target, {})
  const direct = []
  try {
    lifecycle.ensureOuter()
    const cached = target.fetch
    target.fetch = (_url, options) => {
      direct.push(options.body)
      return Promise.resolve(new Response('direct'))
    }
    lifecycle.ensureOuter()
    const outer = target.fetch
    for (let i = 0; i < 100; i++) lifecycle.ensureOuter()
    assert.equal(target.fetch, outer)
    await target.fetch(url, init)
    assert.equal(clean(direct[0]), true)
    assert.equal(seen.length, 0)
    // Clients retaining an earlier reference remain covered until disposal.
    await cached(url, init)
    assert.equal(clean(seen[0].body), true)
    lifecycle.dispose()
    await cached(url, init)
    assert.equal(seen[1].body, init.body)
  } finally { lifecycle.dispose() }
})

test('disposal disables cached wrappers and cannot be reversed by a stale hook', async () => {
  const { target, native, seen } = fixture()
  const lifecycle = createFetchLifecycle(target, {})
  lifecycle.ensureOuter()
  const cached = target.fetch
  lifecycle.dispose()
  lifecycle.dispose()
  lifecycle.ensureOuter()
  assert.equal(target.fetch, native)
  await cached(url, init)
  assert.equal(seen[0].body, init.body)
})

test('non-top disposal leaves another plugin installed but stops rewriting', async () => {
  const { target, seen } = fixture()
  const lifecycle = createFetchLifecycle(target, {})
  lifecycle.ensureOuter()
  const captured = target.fetch
  const later = (input, options) => captured(input, options)
  target.fetch = later
  lifecycle.dispose()
  assert.equal(target.fetch, later)
  await target.fetch(url, init)
  assert.equal(seen[0].body, init.body)
  const reenabled = createFetchLifecycle(target, {})
  try {
    reenabled.ensureOuter()
    await target.fetch(url, init)
    assert.equal(clean(seen[1].body), true)
  } finally { reenabled.dispose() }
  assert.equal(target.fetch, later)
})

test('duplicate active instances fail instead of growing the chain', () => {
  const { target, native } = fixture()
  const first = createFetchLifecycle(target, {})
  const second = createFetchLifecycle(target, {})
  try {
    first.ensureOuter()
    const before = target.fetch
    assert.throws(() => second.ensureOuter(), /Only one active instance/)
    assert.equal(target.fetch, before)
    first.dispose()
    second.ensureOuter()
    assert.notEqual(target.fetch, native)
  } finally { first.dispose(); second.dispose() }
  assert.equal(target.fetch, native)
})

test('missing transport and invalid config fail without claiming a target', () => {
  const missing = createFetchLifecycle({}, {})
  assert.throws(() => missing.ensureOuter(), /requires global fetch/)
  const { target, native } = fixture()
  const invalid = createFetchLifecycle(target, { hosts: ['https://not-a-host.example/path'] })
  assert.throws(() => invalid.ensureOuter(), /host/)
  assert.equal(target.fetch, native)
  const good = createFetchLifecycle(target, {})
  try { good.ensureOuter() } finally { good.dispose() }
  assert.equal(target.fetch, native)
})
