import { defineTool } from '@deepseek-ai/dsh-tools'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { core, dispatch } from '../bridge.mjs'
import { createFetchHandler } from '../http.mjs'
import { resolveConfig } from './config.mjs'
import { createExternalSources } from './external-sources.mjs'
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
import { createQueuedPaperAnalysis } from './paper-analysis-queue.mjs'
import { createChallengeMining } from './challenge-mining.mjs'
import { createBoardStore } from './board-store.mjs'
import { createCompanionQueue } from './companion-queue.mjs'
import Schema from '@deepseek-ai/schemastery'
import { createPaperLibrarySettings, createPaperLibrarySettingsSchema } from './settings.mjs'

export const name = 'paper-library'
export const inject = ['tools', 'llm']

/** Mount tools in every profile and the library surface when a Web carrier exists. */
export function apply(ctx, rawConfig = {}) {
  const config = resolveConfig(rawConfig)
  const store = createLocalStateStore({ library: config.library, home: config.localStateHome })
  const localSettings = createPaperLibrarySettings({ store })
  const settingsListeners=new Set()
  const notifySettings=()=>{for(const fn of settingsListeners)fn()}
  localSettings.subscribe(notifySettings)
  let sharedSettings = localSettings
  let automaticAnalysis
  ctx.effect(() => () => localSettings.dispose(), 'paper-library: local preferences')
  ctx.inject(['settings'], settingsCtx => {
    const nativeSettings = createPaperLibrarySettings({ store, settings: settingsCtx.settings, schema: createPaperLibrarySettingsSchema(Schema) })
    sharedSettings = nativeSettings
    nativeSettings.subscribe(notifySettings)
    settingsCtx.effect(() => () => { sharedSettings = localSettings; return nativeSettings.dispose() }, 'paper-library: native settings')
  })
  // Delegation stays live when the optional settings provider mounts/unmounts.
  const settings = { get: () => sharedSettings.get(), update: (...args) => sharedSettings.update(...args), reset: (...args) => sharedSettings.reset(...args),subscribe:fn=>{settingsListeners.add(fn);return()=>settingsListeners.delete(fn)} }
  // Synced corpora stay optional: with no configured roots the list is empty and
  // every other path behaves exactly as before.
  const sources = createExternalSources({ config })
  const localState = Object.fromEntries(['get','put','list'].map(method => [method, (...args) => sharedSettings.localState[method](...args)]))
  // Boards reuse the private state store, so no second persistence path exists.
  const boards = createBoardStore({ localState })
  const options = {
    library: config.library,
    python: config.python,
    boards,
    provider: config.provider,
    model: config.model,
    ...(config.translationServer ? { translationServer: config.translationServer } : {}),
    ai: createHarnessAI(ctx.llm, createUserMessage, config),
    models: signal => discoverModels(ctx.llm, signal),
    localState,
    settings,
    sources,
    onImported:items=>automaticAnalysis?.imported(items),
  }
  ctx.effect(() => registerLibraryTools(ctx, defineTool, dispatch, options, config), 'paper-library: tools')
  ctx.inject(['skills'], scoped => {
    scoped.effect(() => registerBundledSkills(scoped), 'paper-library: bundled paper-fetch skill')
  })
  ctx.inject(['connection', 'webServer', 'sessionController', 'workspaceRegistry', 'sessionPersistence', 'sessionProjections', 'sessions', 'agents', 'agentDefaultModel'], web => {
    const paperChat = createPaperChat(web, { library: config.library, python: config.python, dispatch, core, store:options.localState, boards, maxAnnotationCharacters: config.maxAnnotationCharacters })
    paperChat.install()
    const companion = createCompanionQueue({store:options.localState,settings,paperChat,dispatch,library:config.library,python:config.python})
    paperChat.onFeedback(companion.feedback)
    paperChat.onTurnFailure(companion.turnFailed)
    web.effect(()=>()=>{companion.dispose();paperChat.onFeedback(undefined);paperChat.onTurnFailure(undefined)},'paper-library: companion lifecycle')
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
    const paperAnalysis = createQueuedPaperAnalysis({store:options.localState,settings,analysis:createPaperAnalysis({store:options.localState,dispatch,paperChat,library:config.library,python:config.python,maxConcurrency:config.analysisConcurrency,reviewProfile:config.reviewProfile,
      agent:createPaperAnalysisAgent(web,{cwd:config.library,maxOutputTokens:config.maxLanguageOutputTokens})})})
    automaticAnalysis=paperAnalysis
    web.effect(()=>()=>{automaticAnalysis=undefined;paperAnalysis.dispose()},'paper-library: background analysis lifecycle')
    const challengeMining = createChallengeMining({store:options.localState,dispatch,paperChat,library:config.library,python:config.python,
      agent:createPaperAnalysisAgent(web,{cwd:config.library,maxOutputTokens:config.maxLanguageOutputTokens})})
    const fetchHandler = createFetchHandler({ ...options, paperChat, companion, languageLearning, libraryKnowledge, paperAnalysis, challengeMining, basePath: '/api/paper-library' })
    web.effect(() => web.webServer.register({
      kind: 'prefix',
      path: '/api/paper-library',
      handler: createNodeHandler(web.connection, fetchHandler),
    }), 'paper-library: authenticated reading surface')
  })
}
