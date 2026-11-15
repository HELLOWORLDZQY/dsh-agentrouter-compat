import { createCompatFetch } from './fetch.js'

const OWNER = Symbol.for('dsh-agentrouter-compat.fetch-owner.v1')

/**
 * Own the lifetime of this plugin's fetch wrappers. A later relay wrapper can
 * bypass its previous fetch via a direct transport, so ensureOuter() is also
 * called at the llm/stream boundary, before the SDK captures global fetch.
 * Cached older wrappers stay useful while enabled (the rewrite is idempotent).
 * All owned wrappers become inert on disposal, even when retained by others.
 */
export function createFetchLifecycle(target, config) {
  let disposed = false
  let current
  let previous
  const owner = {}

  return {
    ensureOuter() {
      if (disposed || (current && target.fetch === current)) return
      if (target[OWNER] && target[OWNER] !== owner) {
        throw new Error('Only one active instance of dsh-agentrouter-compat may own a fetch transport')
      }
      const next = target.fetch
      if (typeof next !== 'function') throw new TypeError('AgentRouter compatibility requires global fetch')
      const wrapped = createCompatFetch(next.bind(target), config, () => !disposed)
      Object.defineProperty(target, OWNER, { value: owner, configurable: true })
      previous = next
      current = wrapped
      target.fetch = wrapped
    },
    dispose() {
      if (disposed) return
      disposed = true
      // Do not overwrite a wrapper installed by another plugin after ours.
      if (current && target.fetch === current) target.fetch = previous
      if (target[OWNER] === owner) delete target[OWNER]
    },
  }
}
