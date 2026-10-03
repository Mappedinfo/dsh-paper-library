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
import { createInkQueue } from '../ink-queue.mjs'
import { createLanguageLearning } from './language-learning.mjs'
import { createHandwriting } from './handwriting.mjs'
import { createLibraryKnowledge } from './library-knowledge.mjs'
import { createPaperAnalysis } from './paper-analysis.mjs'
import { createPaperAnalysisAgent } from './paper-analysis-agent.mjs'
import { createQueuedPaperAnalysis } from './paper-analysis-queue.mjs'
import { createChallengeMining } from './challenge-mining.mjs'
import { createLatexAI } from './latex-ai.mjs'
import { createLatexWorkspace } from './latex-workspace.mjs'
import { createBoardStore } from './board-store.mjs'
import { createCompanionQueue } from './companion-queue.mjs'
import Schema from '@deepseek-ai/schemastery'
import { createPaperLibrarySettings, createPaperLibrarySettingsSchema } from './settings.mjs'

export const name = 'paper-library'
export const inject = ['tools', 'llm']

/** Preferences projected into 设置 → 插件: volatile fields resolve live from the
 * profile config, hot-reload in place and back the auto-generated settings form.
 * Keep constraints out of here (the loader validates on boot); range checks belong
 * to the settings adapter in ./settings.mjs. Unknown config keys pass through. */
export const Config = Schema.object({
  auto_analysis: Schema.boolean().default(true).description('新增或选中文献后自动整理（按全文分批排队，使用本篇模型额度）。').volatile(),
  analysis_fill: Schema.boolean().default(true).description('整理完成后补齐空缺资料（有原文依据才补缺，保留已有资料）。').volatile(),
  auto_review: Schema.boolean().default(true).description('整理完成后生成证据图谱评审草稿（待审）。').volatile(),
  'auto-paper-conversation': Schema.boolean().default(false).description('实时伴学：保存批注后自动回复。').volatile(),
  'reading-panel-side': Schema.union([Schema.const('left'), Schema.const('right')]).default('left').description('阅读侧栏位置（left 左侧 / right 右侧）。').volatile(),
  sync_config: Schema.string().default('').description('数据同步服务配置文件（绝对路径，留空不启用）。').volatile(),
  external_sources: Schema.string().default('').description('额外外部文献源（JSON 数组文本，留空不启用）。').volatile(),
  latex_starter: Schema.boolean().default(true).description('新建 LaTeX 文件夹时生成 starter 文件。').volatile(),
  latex_auto_compile: Schema.boolean().default(true).description('LaTeX 保存后自动编译。').volatile(),
  latex_split: Schema.number().default(50).description('LaTeX 源码窗格宽度百分比（25–75）。').volatile(),
  latex_sync_folder: Schema.boolean().default(true).description('LaTeX 工作区同步到同步服务文件夹。').volatile(),
})

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
    // The settings document is keyed by the profile entry id, which can differ
    // from the package name when the plugin is installed under an alias.
    const namespace = ctx.fiber?.entry?.options?.id ?? name
    const nativeSettings = createPaperLibrarySettings({
      store, settings: settingsCtx.settings, namespace,
      schema: createPaperLibrarySettingsSchema(Schema),
      // Config volatile commits hot-reload in place; relay them to open readers.
      watch: listener => ctx.on('loader/volatile-update', listener),
    })
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
  const inkQueue = createInkQueue({store:localState,dispatch,library:config.library,python:config.python})
  ctx.effect(() => () => inkQueue.dispose(), 'paper-library: durable ink queue')
  const options = {
    library: config.library,
    python: config.python,
    boards,
    inkQueue,
    provider: config.provider,
    model: config.model,
    ...(config.translationServer ? { translationServer: config.translationServer } : {}),
    ai: createHarnessAI(ctx.llm, createUserMessage, config),
    models: signal => discoverModels(ctx.llm, signal),
    localState,
    settings,
    sources,
    latexRoot: config.latexRoot,
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
    const handwritingAI = createHarnessAI(ctx.llm, createUserMessage, { ...config, maxOutputTokens: config.maxLanguageOutputTokens }, { attachments: () => ctx.get('attachments') })
    const handwriting = createHandwriting({ store: options.localState, ai: handwritingAI, paperChat, dispatch, library: config.library, python: config.python })
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
    // LaTeX questions and co-writing reuse the language route and the local state
    // store; proposals hold replacements, never a second copy of the manuscript.
    const latexAI = createLatexAI({ store: options.localState, ai: languageAI, config, dispatch, library: config.library, python: config.python })
    // The workspace owns the manuscript folder under the DSH home and keeps it in the
    // sync service's own config; both are host-side jobs, so neither enters the worker.
    const latexWorkspace = createLatexWorkspace({ config, dispatch, settings, library: config.library, python: config.python })
    const fetchHandler = createFetchHandler({ ...options, paperChat, companion, languageLearning, handwriting, libraryKnowledge, paperAnalysis, challengeMining, latexAI, latexWorkspace, basePath: '/api/paper-library' })
    web.effect(() => web.webServer.register({
      kind: 'prefix',
      path: '/api/paper-library',
      handler: createNodeHandler(web.connection, fetchHandler),
    }), 'paper-library: authenticated reading surface')
  })
}
