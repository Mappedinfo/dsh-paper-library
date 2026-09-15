import { defineTool } from '@deepseek-ai/dsh-tools'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { core, dispatch } from '../bridge.mjs'
import { createFetchHandler } from '../http.mjs'
import { resolveConfig } from './config.mjs'
import { createHarnessAI, discoverModels } from './ai.mjs'
import { createNodeHandler } from './http.mjs'
import { registerLibraryTools } from './tools.mjs'
import { registerBundledSkills } from './skills.mjs'
import { createPaperChat } from './paper-chat.mjs'
import { createLocalStateStore } from '../local-state.mjs'
import { createLanguageLearning } from './language-learning.mjs'
import { createLibraryKnowledge } from './library-knowledge.mjs'
import { createPaperAnalysis } from './paper-analysis.mjs'
import { createPaperAnalysisAgent } from './paper-analysis-agent.mjs'

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
    localState: createLocalStateStore({ library: config.library, home: config.localStateHome }),
  }
  ctx.effect(() => registerLibraryTools(ctx, defineTool, dispatch, options, config), 'paper-library: tools')
  ctx.inject(['skills'], scoped => {
    scoped.effect(() => registerBundledSkills(scoped), 'paper-library: bundled paper-fetch skill')
  })
  ctx.inject(['connection', 'webServer', 'sessionController', 'workspaceRegistry', 'sessionPersistence', 'sessionProjections', 'sessions', 'agents', 'agentDefaultModel'], web => {
    const paperChat = createPaperChat(web, { library: config.library, python: config.python, dispatch, core, maxAnnotationCharacters: config.maxAnnotationCharacters })
    paperChat.install()
    const languageAI = createHarnessAI(ctx.llm, createUserMessage, { ...config, maxOutputTokens: config.maxLanguageOutputTokens })
    const languageLearning = createLanguageLearning({ store: options.localState, ai: languageAI, paperChat, dispatch, library: config.library, python: config.python })
    const libraryKnowledge = createLibraryKnowledge({ store: options.localState, ai: languageAI, paperChat, dispatch, library: config.library, python: config.python,
      getModel: async (entity, { signal } = {}) => {
        if (entity.kind === 'release') {
          const release = await dispatch({action:'dataset_release_get',release_id:entity.id},{library:config.library,python:config.python,signal})
          return (await paperChat({action:'chat_ensure',id:release.dataset_id},{signal})).model
        }
        return (await paperChat({action:'chat_ensure',id:entity.id},{signal})).model
      },
    })
    const paperAnalysis = createPaperAnalysis({store:options.localState,dispatch,paperChat,library:config.library,python:config.python,
      agent:createPaperAnalysisAgent(web,{cwd:config.library,maxOutputTokens:config.maxLanguageOutputTokens})})
    web.effect(()=>()=>paperAnalysis.dispose(),'paper-library: background analysis lifecycle')
    const fetchHandler = createFetchHandler({ ...options, paperChat, languageLearning, libraryKnowledge, paperAnalysis, basePath: '/api/paper-library' })
    web.effect(() => web.webServer.register({
      kind: 'prefix',
      path: '/api/paper-library',
      handler: createNodeHandler(web.connection, fetchHandler),
    }), 'paper-library: authenticated reading surface')
  })
}
