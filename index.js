import z from '@deepseek-ai/schemastery'
import { DEFAULT_HOSTS, DEFAULT_PATHS } from './lib/fetch.js'
import { createFetchLifecycle } from './lib/lifecycle.js'

export const name = 'agentrouter-responses-compat'
export const inject = ['llm']
export const Config = z.object({
  hosts: z.array(z.string()).default([...DEFAULT_HOSTS])
    .description('Exact AgentRouter hosts (optional ports). No URLs, suffix matching or wildcards.'),
  paths: z.array(z.string()).default([...DEFAULT_PATHS])
    .description('Exact Responses URL pathnames. Other endpoints are untouched.'),
  allowHttp: z.boolean().default(false)
    .description('Also match plain HTTP on the configured hosts. Leave off except for trusted local tests.'),
  announce: z.boolean().default(true)
    .description('Log activation once, without request content, headers or credentials.'),
})

export function apply(ctx, config) {
  const lifecycle = createFetchLifecycle(globalThis, config)
  ctx.effect(() => {
    lifecycle.ensureOuter()
    return () => lifecycle.dispose()
  })
  ctx.on('llm/stream', (_options, next) => {
    // Read no messages and never mutate the frozen/log-backed LLM request.
    // This also handles the AgentRouter plugin mounting after this bundle.
    lifecycle.ensureOuter()
    return next()
  })
  if (config.announce) {
    ctx.logger.info('AgentRouter Responses compatibility enabled: resource-bound replay handles are stripped; no retries added.')
  }
}
