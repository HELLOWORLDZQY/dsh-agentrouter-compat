import { relayResponsesCompatPatch } from './compat.js'

export const DEFAULT_HOSTS = Object.freeze([
  'relay.agentrouter.internal',
  'agentrouter.org',
  'ps.air-outer.com',
])
export const DEFAULT_PATHS = Object.freeze(['/v1/responses'])

/** Exact host matching, with optional port; never a suffix or wildcard match. */
export function normalizeHost(value) {
  if (typeof value !== 'string' || value.trim() === '' || /[\s/@?#*\\]/u.test(value.trim())) {
    throw new TypeError('AgentRouter compatibility hosts must be bare hostnames with optional ports')
  }
  const host = value.trim().toLowerCase()
  let parsed
  try {
    parsed = new URL(`https://${host}`)
  } catch {
    throw new TypeError('AgentRouter compatibility hosts must be valid hostnames with optional ports')
  }
  if (parsed.hostname === '' || parsed.pathname !== '/' || parsed.username || parsed.password) {
    throw new TypeError('AgentRouter compatibility hosts must not contain URLs or credentials')
  }
  return parsed.host
}

function urlOf(input) {
  try {
    if (typeof input === 'string' || input instanceof URL) return new URL(input)
    if (input instanceof Request) return new URL(input.url)
  } catch {
    // Let the original transport report malformed URLs.
  }
  return undefined
}

/** Preserve Request defaults when flattening a string-body override for a relay. */
function requestDefaults(input) {
  return {
    method: input.method,
    headers: input.headers,
    signal: input.signal,
    cache: input.cache,
    credentials: input.credentials,
    integrity: input.integrity,
    keepalive: input.keepalive,
    mode: input.mode,
    redirect: input.redirect,
    referrer: input.referrer,
    referrerPolicy: input.referrerPolicy,
    duplex: input.duplex,
  }
}

/**
 * Wrap the existing transport, never replace its routing, headers or proxy policy.
 * Only string init.body is inspected (the shape used by the DSH provider SDK).
 * Request/ReadableStream/Blob bodies are not consumed or buffered.
 */
export function createCompatFetch(previous, config = {}, isActive = () => true) {
  if (typeof previous !== 'function') throw new TypeError('A fetch transport is required')
  const hosts = new Set((config.hosts ?? DEFAULT_HOSTS).map(normalizeHost))
  const paths = new Set(config.paths ?? DEFAULT_PATHS)
  for (const path of paths) {
    if (typeof path !== 'string' || !path.startsWith('/') || /[?#]/u.test(path)) {
      throw new TypeError('AgentRouter compatibility paths must be exact URL pathnames')
    }
  }

  return function agentRouterCompatFetch(input, init) {
    const forward = () => previous(input, init)
    if (!isActive() || typeof init?.body !== 'string') return forward()
    const url = urlOf(input)
    const allowedProtocol = url?.protocol === 'https:' || (config.allowHttp === true && url?.protocol === 'http:')
    if (!url || !allowedProtocol || url.username || url.password || !hosts.has(url.host) || !paths.has(url.pathname)) {
      return forward()
    }
    const isRequest = input instanceof Request
    const method = init.method === undefined ? (isRequest ? input.method : 'GET') : init.method
    if (typeof method !== 'string' || method.toUpperCase() !== 'POST') return forward()

    let headers
    try {
      headers = new Headers(init.headers === undefined ? (isRequest ? input.headers : undefined) : init.headers)
    } catch {
      return forward()
    }
    const encoding = headers.get('content-encoding')
    if (encoding && encoding.trim().toLowerCase() !== 'identity') return forward()
    const mediaType = headers.get('content-type')?.split(';', 1)[0].trim().toLowerCase()
    if (mediaType && mediaType !== 'application/json' && !mediaType.endsWith('+json')) return forward()

    const body = relayResponsesCompatPatch(init.body)
    if (body === undefined) return forward()
    // The transport will calculate the length of the new UTF-8 body.
    headers.delete('content-length')
    const defaults = isRequest ? requestDefaults(input) : {}
    const overrides = { ...init }
    // Fetch dictionary members with value undefined do not override Request
    // defaults. Read these members explicitly to retain inherited members too.
    for (const key of Object.keys(defaults)) {
      if (init[key] === undefined) delete overrides[key]
      else overrides[key] = init[key]
    }
    const patched = { ...defaults, ...overrides, method, headers, body }
    // Keep the serialized body in init for the original relay's schema patch.
    // Flattening also avoids that relay's Request+init override-order pitfall.
    return previous(isRequest ? input.url : input, patched)
  }
}
