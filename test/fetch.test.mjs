import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { createCompatFetch, DEFAULT_HOSTS, DEFAULT_PATHS, normalizeHost } from '../lib/fetch.js'

// Every transport below is an in-memory spy. No test calls global fetch or a network.
const ENDPOINT = 'https://agentrouter.org/v1/responses'
const CLEAN = {
  model: 'synthetic-model',
  input: [
    { type: 'message', role: 'user', content: [{ type: 'input_text', id: 'part_synthetic_keep', text: 'synthetic 正文 ☃' }] },
    { type: 'function_call', call_id: 'call_synthetic_shared', name: 'synthetic_lookup', arguments: '{"id":"argument_synthetic_keep"}' },
    { type: 'function_call_output', call_id: 'call_synthetic_shared', output: 'synthetic tool output', file_id: 'file_synthetic_keep' },
  ],
}
const RAW = JSON.stringify({
  ...CLEAN,
  previous_response_id: 'resp_synthetic_remove',
  input: [
    ...CLEAN.input.map((item, index) => ({ ...item, id: `item_synthetic_remove_${index}` })),
    { type: 'item_reference', id: 'reference_synthetic_remove' },
  ],
}, null, 2)

function post(overrides = {}) {
  return {
    method: 'POST', body: RAW,
    headers: { 'content-type': 'application/json', 'content-length': String(Buffer.byteLength(RAW)) },
    ...overrides,
  }
}

function recorder(config = {}, isActive) {
  const calls = []
  const result = { synthetic: 'transport-result' }
  const wrapped = createCompatFetch((input, init) => {
    calls.push([input, init])
    return result
  }, config, isActive)
  return { calls, result, wrapped }
}

function expectBypass(input, init, config = {}, isActive) {
  const record = recorder(config, isActive)
  assert.strictEqual(record.wrapped(input, init), record.result)
  assert.equal(record.calls.length, 1)
  assert.strictEqual(record.calls[0][0], input, 'no-op must preserve the input reference')
  assert.strictEqual(record.calls[0][1], init, 'no-op must preserve the init reference')
  return record
}

function expectRewrite(input, init, config = {}, expected = CLEAN) {
  const record = recorder(config)
  assert.strictEqual(record.wrapped(input, init), record.result)
  assert.equal(record.calls.length, 1)
  const [nextInput, nextInit] = record.calls[0]
  assert.strictEqual(nextInput, input instanceof Request ? input.url : input)
  assert.notStrictEqual(nextInit, init)
  assert.equal(typeof nextInit.body, 'string')
  assert.deepEqual(JSON.parse(nextInit.body), expected)
  assert.ok(nextInit.headers instanceof Headers)
  assert.equal(nextInit.headers.has('content-length'), false)
  return { ...record, input: nextInput, init: nextInit }
}

function makeRequest(overrides = {}) {
  return new Request(ENDPOINT, {
    method: 'POST', body: 'synthetic original Request body must not win',
    headers: { 'content-type': 'application/json', 'content-length': '999', 'x-request-only': 'synthetic-request-header' },
    ...overrides,
  })
}

describe('createCompatFetch exact endpoint allowlist', () => {
  test('exports the sentinel and both public hosts, with only the default Responses path', () => {
    for (const host of ['relay.agentrouter.internal', 'agentrouter.org', 'ps.air-outer.com']) {
      assert.ok(DEFAULT_HOSTS.includes(host), `missing default host ${host}`)
    }
    assert.deepEqual(DEFAULT_PATHS, ['/v1/responses'])
  })

  for (const host of ['relay.agentrouter.internal', 'agentrouter.org', 'ps.air-outer.com']) {
    test(`rewrites HTTPS on default host ${host}`, () => {
      expectRewrite(`https://${host}/v1/responses`, post())
    })
    test(`does not enable HTTP by default for ${host}`, () => {
      expectBypass(`http://${host}/v1/responses`, post())
    })
  }

  for (const input of [
    'https://AGENTROUTER.ORG:443/v1/responses',
    'https://agentrouter.org/v1/responses?synthetic=1#synthetic-fragment',
    new URL('https://ps.air-outer.com/v1/responses?synthetic=2'),
  ]) {
    test(`matches normalized host/path without replacing the original URL value: ${input}`, () => {
      expectRewrite(input, post())
    })
  }

  const unrelated = [
    ['unrelated host', 'https://synthetic.invalid/v1/responses'],
    ['suffix spoof', 'https://agentrouter.org.synthetic.invalid/v1/responses'],
    ['other public host suffix spoof', 'https://ps.air-outer.com.synthetic.invalid/v1/responses'],
    ['sentinel suffix spoof', 'https://relay.agentrouter.internal.synthetic.invalid/v1/responses'],
    ['prefix spoof', 'https://synthetic-agentrouter.org/v1/responses'],
    ['subdomain', 'https://sub.agentrouter.org/v1/responses'],
    ['trailing-dot host', 'https://agentrouter.org./v1/responses'],
    ['non-default TLS port', 'https://agentrouter.org:8443/v1/responses'],
    ['HTTP port on HTTPS', 'https://agentrouter.org:80/v1/responses'],
    ['FTP protocol', 'ftp://agentrouter.org/v1/responses'],
    ['WebSocket protocol', 'ws://agentrouter.org/v1/responses'],
    ['secure WebSocket protocol', 'wss://agentrouter.org/v1/responses'],
    ['file protocol', 'file://agentrouter.org/v1/responses'],
    ['data protocol', 'data:application/json,%7B%7D'],
    ['Chat Completions', 'https://agentrouter.org/v1/chat/completions'],
    ['missing version prefix', 'https://agentrouter.org/responses'],
    ['trailing slash', 'https://agentrouter.org/v1/responses/'],
    ['path suffix', 'https://agentrouter.org/v1/responses-extra'],
    ['path case', 'https://agentrouter.org/V1/responses'],
    ['encoded path segment', 'https://agentrouter.org/v1/%72esponses'],
    ['relative URL', '/v1/responses'],
    ['malformed URL', 'https://[synthetic-invalid'],
    ['URL-like text', 'not a synthetic URL'],
  ]
  for (const [name, input] of unrelated) {
    test(`passes unrelated input through without touching references: ${name}`, () => {
      expectBypass(input, post())
    })
  }

  for (const input of [
    'https://synthetic-user@agentrouter.org/v1/responses',
    'https://synthetic-user:synthetic-password@agentrouter.org/v1/responses',
    new URL('https://:synthetic-password@agentrouter.org/v1/responses'),
    'https://agentrouter.org@synthetic.invalid/v1/responses',
  ]) {
    test(`does not rewrite a URL with userinfo: ${input}`, () => {
      expectBypass(input, post())
    })
  }

  test('does not inspect a duck-typed URL or coerce an arbitrary input', () => {
    const input = {
      get url() { assert.fail('must not read a duck-typed URL') },
      toString() { assert.fail('must not coerce an arbitrary input') },
    }
    expectBypass(input, post())
    expectBypass(null, post())
  })

  test('allows HTTP only with explicit boolean opt-in and the exact configured host/port', () => {
    const config = { allowHttp: true, hosts: ['127.0.0.1:18317'] }
    expectRewrite('http://127.0.0.1:18317/v1/responses', post(), config)
    expectBypass('http://127.0.0.1:18318/v1/responses', post(), config)
    expectBypass('http://127.0.0.1:18317/v1/chat/completions', post(), config)
    expectBypass('http://synthetic-user@127.0.0.1:18317/v1/responses', post(), config)
    expectBypass('ftp://127.0.0.1:18317/v1/responses', post(), config)
    expectRewrite(ENDPOINT, post(), { allowHttp: true })
    for (const allowHttp of [undefined, false, 'true', 1]) {
      expectBypass('http://agentrouter.org/v1/responses', post(), { allowHttp })
    }
  })

  test('uses exact custom allowlists rather than extending defaults or matching prefixes', () => {
    const config = { hosts: [' Synthetic-Gateway.INVALID:8443 '], paths: ['/custom/responses'] }
    expectRewrite('https://synthetic-gateway.invalid:8443/custom/responses?synthetic=1', post(), config)
    expectBypass(ENDPOINT, post(), config)
    expectBypass('https://synthetic-gateway.invalid/custom/responses', post(), config)
    expectBypass('https://synthetic-gateway.invalid:8443/custom/responses/extra', post(), config)
    expectBypass('https://synthetic-gateway.invalid:8443/v1/responses', post(), config)
    expectBypass(ENDPOINT, post(), { hosts: [] })
    expectBypass(ENDPOINT, post(), { paths: [] })
  })

  test('validates transport, bare hosts and exact path configuration without transport calls', () => {
    for (const previous of [undefined, null, {}, 'synthetic']) {
      assert.throws(() => createCompatFetch(previous), TypeError)
    }
    assert.equal(normalizeHost(' AGENTROUTER.ORG:443 '), 'agentrouter.org')
    assert.equal(normalizeHost(' SYNTHETIC.INVALID:8443 '), 'synthetic.invalid:8443')
    for (const host of ['', null, 'bad host', '*.agentrouter.org', 'https://agentrouter.org', 'synthetic@agentrouter.org', 'agentrouter.org/path', 'agentrouter.org?synthetic=1', 'agentrouter.org#synthetic', 'agentrouter.org\\path', 'agentrouter.org:65536']) {
      assert.throws(() => normalizeHost(host), TypeError)
      assert.throws(() => createCompatFetch(() => assert.fail('must not call transport'), { hosts: [host] }), TypeError)
    }
    for (const path of ['', null, 'v1/responses', '/v1/responses?synthetic=1', '/v1/responses#synthetic']) {
      assert.throws(() => createCompatFetch(() => assert.fail('must not call transport'), { paths: [path] }), TypeError)
    }
  })
})

describe('createCompatFetch method, media type and encoding gates', () => {
  for (const method of ['POST', 'post', 'PoSt']) {
    test(`accepts case-insensitive POST and retains the provided method: ${method}`, () => {
      const result = expectRewrite(ENDPOINT, post({ method }))
      assert.equal(result.init.method, method)
    })
  }
  for (const method of [undefined, null, '', 'GET', 'HEAD', 'PUT', 'PATCH', 'DELETE', 'OPTIONS', ' POST ', 123]) {
    test(`bypasses a non-POST effective method: ${String(method)}`, () => {
      expectBypass(ENDPOINT, post({ method }))
    })
  }

  for (const type of [undefined, '', 'application/json', 'Application/JSON ; charset=UTF-8', 'application/problem+json', 'application/vnd.synthetic+json; charset=utf-8']) {
    test(`permits JSON media type: ${String(type)}`, () => {
      const headers = type === undefined ? {} : { 'content-type': type }
      expectRewrite(ENDPOINT, post({ headers }))
    })
  }
  for (const type of ['text/plain', 'text/event-stream', 'application/octet-stream', 'application/x-www-form-urlencoded', 'multipart/form-data; boundary=synthetic', 'application/jsonp', 'application/json, text/plain']) {
    test(`bypasses non-JSON media type: ${type}`, () => {
      expectBypass(ENDPOINT, post({ headers: { 'content-type': type, 'content-length': '999' } }))
    })
  }
  for (const encoding of ['gzip', 'br', 'deflate', 'compress', 'identity, gzip', 'synthetic-encoding']) {
    test(`bypasses compressed or non-identity string body: ${encoding}`, () => {
      expectBypass(ENDPOINT, post({ headers: { 'content-type': 'application/json', 'content-encoding': encoding, 'content-length': '999' } }))
    })
  }
  for (const encoding of ['', 'identity', ' IDENTITY ']) {
    test(`permits identity content encoding: ${JSON.stringify(encoding)}`, () => {
      const { init } = expectRewrite(ENDPOINT, post({ headers: { 'content-type': 'application/json', 'content-encoding': encoding } }))
      assert.equal(init.headers.get('content-encoding'), encoding.trim())
    })
  }
})

describe('createCompatFetch no-op body and reference preservation', () => {
  const unchanged = [
    ['empty', ''], ['malformed', '{"input":['], ['null', 'null'], ['primitive', '123'], ['root array', '[]'],
    ['string input', '{ "input":"synthetic", "previous_response_id":"resp_synthetic_keep" }'],
    ['no input', '{ "previous_response_id":"resp_synthetic_keep" }'],
    ['already clean with whitespace, escapes and exponent', ' {\n "input": [], "number": 1.2300e+02, "text": "\\u4e2d"\n}\r\n'],
    ['duplicate keys', '{ "input": [], "synthetic": 1, "synthetic": 2 }'],
    ['nested handles only', '{"input":[{"content":[{"id":"part_synthetic_keep","file_id":"file_synthetic_keep"}],"call_id":"call_synthetic_keep"}]}'],
  ]
  for (const [name, body] of unchanged) {
    test(`leaves original body bytes, init and headers untouched: ${name}`, () => {
      const headers = new Headers({ 'content-type': 'application/json', 'content-length': '999', 'x-synthetic': 'keep' })
      const init = post({ body, headers })
      const { calls } = expectBypass(ENDPOINT, init)
      assert.strictEqual(calls[0][1].headers, headers)
      assert.equal(calls[0][1].body, body)
      assert.equal(headers.get('content-length'), '999')
    })
  }

  test('does not add init or a body when omitted', () => {
    expectBypass(ENDPOINT, undefined)
    expectBypass(ENDPOINT, null)
    expectBypass(ENDPOINT, { method: 'POST' })
  })

  const nonStringBodies = [
    ['undefined', () => undefined], ['null', () => null], ['number', () => 123],
    ['boxed string', () => new String(RAW)],
    ['Uint8Array', () => new TextEncoder().encode(RAW)],
    ['ArrayBuffer', () => new TextEncoder().encode(RAW).buffer],
    ['Buffer', () => Buffer.from(RAW)],
    ['URLSearchParams', () => new URLSearchParams({ synthetic: RAW })],
    ['FormData', () => { const form = new FormData(); form.set('synthetic', RAW); return form }],
    ['object with coercion trap', () => ({ toString() { assert.fail('must not stringify arbitrary bodies') } })],
    ['Blob', () => {
      const blob = new Blob([RAW], { type: 'application/json' })
      for (const method of ['text', 'arrayBuffer', 'stream']) {
        blob[method] = () => assert.fail(`must not read Blob.${method}`)
      }
      return blob
    }],
    ['ReadableStream', () => new ReadableStream({ pull() { assert.fail('must not pull request stream') } }, { highWaterMark: 0 })],
  ]
  for (const [name, factory] of nonStringBodies) {
    test(`never buffers or reads non-string init.body: ${name}`, () => {
      const body = factory()
      const init = post({ body })
      const { calls } = expectBypass(ENDPOINT, init)
      assert.strictEqual(calls[0][1].body, body)
      if (body instanceof ReadableStream) assert.equal(body.locked, false)
    })
  }

  test('is idempotent, including headers and init identity after the first rewrite', () => {
    const first = expectRewrite(ENDPOINT, post())
    const second = expectBypass(first.input, first.init)
    assert.strictEqual(second.calls[0][1].headers, first.init.headers)
    assert.equal(second.calls[0][1].body, first.init.body)
  })
})

describe('createCompatFetch header preservation', () => {
  const headerFactories = [
    ['record', () => ({ 'Content-Type': 'application/json', 'Content-Length': '999', Authorization: 'Bearer synthetic-not-a-real-key', 'X-Synthetic-Route': 'route-synthetic', Accept: 'text/event-stream' })],
    ['Headers', () => new Headers({ 'Content-Type': 'application/json', 'Content-Length': '999', Authorization: 'Bearer synthetic-not-a-real-key', 'X-Synthetic-Route': 'route-synthetic', Accept: 'text/event-stream' })],
    ['tuple list', () => [['Content-Type', 'application/json'], ['Content-Length', '999'], ['content-length', '111'], ['Authorization', 'Bearer synthetic-not-a-real-key'], ['X-Synthetic-Route', 'route-synthetic'], ['Accept', 'text/event-stream']]],
  ]
  for (const [name, factory] of headerFactories) {
    test(`removes only content-length without mutating ${name} headers or init`, () => {
      const headers = factory()
      const before = [...new Headers(headers)]
      const init = Object.freeze(post({ headers }))
      const next = expectRewrite(ENDPOINT, init).init
      const expected = new Headers(headers)
      expected.delete('content-length')
      assert.deepEqual([...next.headers], [...expected])
      assert.deepEqual([...new Headers(headers)], before)
      assert.strictEqual(init.headers, headers)
      assert.equal(init.body, RAW)
      assert.notStrictEqual(next.headers, headers)
    })
  }

  test('leaves malformed HeadersInit validation and errors to the original transport', () => {
    for (const headers of [null, [['x-synthetic']], { 'bad header name': 'synthetic' }]) {
      expectBypass(ENDPOINT, post({ headers }))
    }
  })
})

describe('createCompatFetch Request plus init priority', () => {
  test('does not consume or clone a bare Request, even if its underlying text would need cleanup', (t) => {
    const request = makeRequest({ body: RAW })
    const body = request.body
    for (const method of ['text', 'json', 'arrayBuffer', 'blob', 'formData', 'clone']) {
      t.mock.method(request, method, () => assert.fail(`must not call Request.${method}`))
    }
    expectBypass(request, undefined)
    expectBypass(request, { method: 'POST' })
    expectBypass(request, { body: null })
    assert.equal(request.bodyUsed, false)
    assert.strictEqual(request.body, body)
    assert.equal(body.locked, false)
  })

  test('keeps clean string overrides as the original Request/init pair, not a flattened request', () => {
    const request = makeRequest({ body: RAW })
    for (const body of ['', '{"input":[]}', 'synthetic non-JSON override']) {
      const init = { body, headers: { 'x-synthetic-override': 'keep' } }
      expectBypass(request, init)
    }
    assert.equal(request.bodyUsed, false)
  })

  test('flattens only a changed Request override, uses init.body and inherits all Request defaults', () => {
    const controller = new AbortController()
    const request = makeRequest({
      signal: controller.signal, cache: 'no-store', credentials: 'omit',
      integrity: 'synthetic-integrity', keepalive: true, mode: 'same-origin', redirect: 'manual',
      referrer: 'https://synthetic-origin.invalid/page', referrerPolicy: 'no-referrer',
    })
    const originalBody = request.body
    const init = { body: RAW }
    const next = expectRewrite(request, init).init
    for (const key of ['method', 'signal', 'cache', 'credentials', 'integrity', 'keepalive', 'mode', 'redirect', 'referrer', 'referrerPolicy', 'duplex']) {
      assert.strictEqual(next[key], request[key], `must inherit Request.${key}`)
    }
    assert.equal(next.headers.get('x-request-only'), 'synthetic-request-header')
    assert.equal(request.headers.get('content-length'), '999')
    assert.equal(request.bodyUsed, false)
    assert.strictEqual(request.body, originalBody)
    assert.equal(originalBody.locked, false)
    assert.equal(init.body, RAW)
  })

  test('inherits Request dictionary defaults when init explicitly supplies undefined', () => {
    const controller = new AbortController()
    const request = makeRequest({ signal: controller.signal, cache: 'no-store', credentials: 'omit', redirect: 'manual' })
    const keys = ['method', 'headers', 'signal', 'cache', 'credentials', 'integrity', 'keepalive', 'mode', 'redirect', 'referrer', 'referrerPolicy', 'duplex']
    const init = { body: RAW, ...Object.fromEntries(keys.map(key => [key, undefined])) }
    const next = expectRewrite(request, init).init
    for (const key of keys.filter(key => key !== 'headers')) {
      assert.strictEqual(next[key], request[key], `undefined init.${key} must not erase Request defaults`)
    }
    assert.equal(next.headers.get('x-request-only'), 'synthetic-request-header')
    controller.abort('synthetic-abort')
    assert.equal(next.signal.aborted, true)
    assert.equal(next.signal.reason, 'synthetic-abort')
  })

  test('honors explicit init options, signal and transport-specific fields over Request defaults', () => {
    const request = makeRequest({ cache: 'no-store', credentials: 'omit', redirect: 'manual' })
    const controller = new AbortController()
    const dispatcher = { synthetic: 'dispatcher-reference' }
    const extraSymbol = Symbol('synthetic-transport-field')
    const overrides = {
      method: 'post', signal: controller.signal, cache: 'reload', credentials: 'include',
      integrity: 'synthetic-override-integrity', keepalive: false, mode: 'cors', redirect: 'error',
      referrer: 'https://synthetic-override.invalid/page', referrerPolicy: 'origin', duplex: 'half',
      dispatcher, [extraSymbol]: dispatcher,
    }
    const next = expectRewrite(request, { ...overrides, body: RAW }).init
    for (const key of Reflect.ownKeys(overrides)) assert.strictEqual(next[key], overrides[key])
    const explicitNull = expectRewrite(request, { body: RAW, signal: null }).init
    assert.strictEqual(explicitNull.signal, null)
    assert.equal(request.bodyUsed, false)
  })

  test('retains inherited RequestInit dictionary members when flattening', () => {
    const controller = new AbortController()
    const inherited = { method: 'POST', signal: controller.signal, cache: 'reload', headers: { 'x-synthetic-inherited': 'keep' } }
    const init = Object.assign(Object.create(inherited), { body: RAW })
    const next = expectRewrite(makeRequest(), init).init
    assert.equal(next.method, 'POST')
    assert.strictEqual(next.signal, controller.signal)
    assert.equal(next.cache, 'reload')
    assert.equal(next.headers.get('x-synthetic-inherited'), 'keep')
    assert.equal(next.headers.has('x-request-only'), false)
  })

  test('uses effective init.method rather than blindly using Request.method', () => {
    const getRequest = new Request(ENDPOINT)
    expectRewrite(getRequest, post())
    expectBypass(getRequest, { body: RAW })
    const postRequest = makeRequest()
    for (const method of ['GET', 'PUT', 'HEAD', null, 123]) {
      expectBypass(postRequest, { body: RAW, method })
    }
  })

  test('init.headers replaces, rather than merges with, Request headers for gating and forwarding', () => {
    const request = makeRequest({ headers: { 'content-type': 'text/plain', 'content-encoding': 'gzip', 'x-request-only': 'must-not-leak' } })
    const headers = { 'content-type': 'application/json', 'x-init-only': 'synthetic-header', 'content-length': '999' }
    const next = expectRewrite(request, { body: RAW, headers }).init
    assert.equal(next.headers.get('x-init-only'), 'synthetic-header')
    assert.equal(next.headers.has('x-request-only'), false)
    assert.equal(next.headers.has('content-encoding'), false)
    expectBypass(request, { body: RAW })
    expectBypass(makeRequest(), { body: RAW, headers: { 'content-type': 'text/plain' } })
    expectBypass(makeRequest(), { body: RAW, headers: { 'content-encoding': 'br' } })
    expectBypass(makeRequest(), { body: RAW, headers: null })
    expectRewrite(request, { body: RAW, headers: {} })
  })

  test('does not touch a Request stream when a separate string init.body takes priority', () => {
    const stream = new ReadableStream({ pull() { assert.fail('must not pull the overridden Request body') } }, { highWaterMark: 0 })
    const request = makeRequest({ body: stream, duplex: 'half' })
    expectRewrite(request, { body: RAW })
    assert.equal(request.bodyUsed, false)
    assert.equal(stream.locked, false)
    assert.strictEqual(request.body, stream)
  })
})

describe('createCompatFetch activation and transparent transport behavior', () => {
  test('inactive wrapping forwards without even looking at body or headers', () => {
    const init = {
      get body() { assert.fail('inactive wrapper must not inspect body') },
      get headers() { assert.fail('inactive wrapper must not inspect headers') },
    }
    expectBypass(ENDPOINT, init, {}, () => false)
  })

  test('evaluates activity on each call and resumes rewriting only while active', () => {
    let active = false
    const record = recorder({}, () => active)
    const init = post()
    record.wrapped(ENDPOINT, init)
    assert.strictEqual(record.calls[0][1], init)
    active = true
    record.wrapped(ENDPOINT, init)
    assert.notStrictEqual(record.calls[1][1], init)
    assert.deepEqual(JSON.parse(record.calls[1][1].body), CLEAN)
    active = false
    record.wrapped(ENDPOINT, init)
    assert.strictEqual(record.calls[2][1], init)
  })

  for (const changed of [false, true]) {
    const name = changed ? 'rewritten' : 'bypassed'
    const makeInit = () => post({ body: changed ? RAW : '{ "input": [] }' })

    test(`returns the exact synchronous transport value for a ${name} request`, () => {
      for (const value of [undefined, null, false, 0, 'synthetic-value', { synthetic: true }]) {
        let calls = 0
        const wrapped = createCompatFetch(() => { calls++; return value })
        assert.strictEqual(wrapped(ENDPOINT, makeInit()), value)
        assert.equal(calls, 1)
      }
    })

    test(`returns the original promise, without adding a wrapper, for a ${name} request`, async () => {
      const value = { synthetic: 'resolved-response' }
      const promise = Promise.resolve(value)
      const wrapped = createCompatFetch(() => promise)
      const result = wrapped(ENDPOINT, makeInit())
      assert.strictEqual(result, promise)
      assert.strictEqual(await result, value)
    })

    test(`propagates the same synchronous error exactly once for a ${name} request`, () => {
      const error = new Error('synthetic transport failure')
      let calls = 0
      const wrapped = createCompatFetch(() => { calls++; throw error })
      assert.throws(() => wrapped(ENDPOINT, makeInit()), received => received === error)
      assert.equal(calls, 1)
    })

    test(`preserves a rejected promise and its exact error for a ${name} request`, async () => {
      const error = new Error('synthetic asynchronous transport failure')
      const promise = Promise.reject(error)
      const wrapped = createCompatFetch(() => promise)
      const result = wrapped(ENDPOINT, makeInit())
      assert.strictEqual(result, promise)
      await assert.rejects(result, received => received === error)
    })

    test(`preserves signal identity, abort reason and custom routing options for a ${name} request`, () => {
      const controller = new AbortController()
      const dispatcher = { synthetic: 'dispatcher' }
      const init = { ...makeInit(), signal: controller.signal, dispatcher, duplex: 'half', redirect: 'manual' }
      const record = recorder()
      record.wrapped(ENDPOINT, init)
      const forwarded = record.calls[0][1]
      assert.strictEqual(forwarded.signal, controller.signal)
      assert.strictEqual(forwarded.dispatcher, dispatcher)
      assert.equal(forwarded.duplex, 'half')
      assert.equal(forwarded.redirect, 'manual')
      const reason = { synthetic: 'abort-reason' }
      controller.abort(reason)
      assert.equal(forwarded.signal.aborted, true)
      assert.strictEqual(forwarded.signal.reason, reason)
    })

    test(`does not consume, replace or lock a streaming Response for a ${name} request`, () => {
      const stream = new ReadableStream({ pull() { assert.fail('wrapper must not pull response stream') } }, { highWaterMark: 0 })
      const response = new Response(stream, { status: 202, headers: { 'content-type': 'text/event-stream', 'x-synthetic': 'keep' } })
      const wrapped = createCompatFetch(() => response)
      assert.strictEqual(wrapped(ENDPOINT, makeInit()), response)
      assert.strictEqual(response.body, stream)
      assert.equal(response.bodyUsed, false)
      assert.equal(stream.locked, false)
      assert.equal(response.status, 202)
      assert.equal(response.headers.get('x-synthetic'), 'keep')
    })
  }

  test('forwards an already-aborted signal without substituting a local error', () => {
    const controller = new AbortController()
    const reason = new Error('synthetic pre-abort')
    controller.abort(reason)
    const { init } = expectRewrite(ENDPOINT, post({ signal: controller.signal }))
    assert.strictEqual(init.signal, controller.signal)
    assert.strictEqual(init.signal.reason, reason)
  })
})
