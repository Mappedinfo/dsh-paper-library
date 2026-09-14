import { defineTool } from '@deepseek-ai/dsh-tools'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { dispatch } from '../bridge.mjs'
import { createFetchHandler } from '../http.mjs'
import { resolveConfig } from './config.mjs'
import { createHarnessAI, discoverModels } from './ai.mjs'
import { createNodeHandler } from './http.mjs'
import { registerLibraryTools } from './tools.mjs'
import { registerBundledSkills } from './skills.mjs'

export const name = 'paper-library'
export const inject = ['tools', 'llm']

/** Mount tools in every profile and the library surface when a Web carrier exists. */
export function apply(ctx, rawConfig = {}) {
  const config = resolveConfig(rawConfig)
  const options = {
    library: config.library,
    python: config.python,
    provider: config.provider,
    model: config.model,
    ai: createHarnessAI(ctx.llm, createUserMessage, config),
    models: signal => discoverModels(ctx.llm, signal),
  }
  ctx.effect(() => registerLibraryTools(ctx, defineTool, dispatch, options, config), 'paper-library: tools')
  ctx.inject(['skills'], scoped => {
    scoped.effect(() => registerBundledSkills(scoped), 'paper-library: bundled paper-fetch skill')
  })
  ctx.inject(['connection', 'webServer'], web => {
    const fetchHandler = createFetchHandler({ ...options, basePath: '/api/paper-library' })
    web.effect(() => web.webServer.register({
      kind: 'prefix',
      path: '/api/paper-library',
      handler: createNodeHandler(web.connection, fetchHandler),
    }), 'paper-library: authenticated reading surface')
  })
}
