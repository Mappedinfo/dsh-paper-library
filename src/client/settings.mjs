import { createElement as h, useEffect, useState } from 'react'

export const SETTINGS_NAMESPACE = 'paper-library'
const LOCALE = 'paperLibrarySettings'
export const SETTINGS_DEFAULTS = Object.freeze({
  auto_analysis: true,
  analysis_fill: true,
  'auto-paper-conversation': false,
  'reading-panel-side': 'left',
  ui_palette: 'jade',
  resource_profile: 'balanced',
})
const fields = Object.keys(SETTINGS_DEFAULTS)
const own = (value, key) => Object.prototype.hasOwnProperty.call(value ?? {}, key)
const valid = (key, value) => key === 'resource_profile' ? ['eco', 'balanced', 'performance', 'custom'].includes(value) : key === 'ui_palette' ? ['jade', 'navy', 'neutral', 'rose', 'apricot', 'system'].includes(value) : key === 'reading-panel-side'
  ? value === 'left' || value === 'right' : fields.includes(key) && typeof value === 'boolean'
const writable = snapshot => snapshot.status === 'ready' && snapshot.mode === 'host'
  && snapshot.writable && Number.isSafeInteger(snapshot.revision)

const locales = {
  zh: {
    title: 'Paper Library', description: '与资料库内的设置共用主机文件，修改后同步到已打开的阅读页。',
    auto_analysis: '新增或选中文献后自动整理', 'auto_analysis.hint': '新导入或选中且尚无整理记录的 PDF 会按全文分批排队。使用论文对应的 DSH 模型，会消耗模型额度。',
    analysis_fill: '后台整理后补齐空缺资料', 'analysis_fill.hint': '按有原文依据的 AI 建议补缺，保留已有值；新增资料仍需核对。',
    'auto-paper-conversation': '实时伴学：保存批注后自动回复', 'auto-paper-conversation.hint': '有文字评论的新批注和修改会在主机排队，回复跟随原批注，使用本篇 DSH 模型额度。历史批注不批量重发。',
    'reading-panel-side': '阅读侧栏位置', 'reading-panel-side.hint': '文献库与批注共用的侧栏。', left: '左侧', right: '右侧',
    ui_palette: '界面配色', 'ui_palette.hint': '功能色对应阅读、知识、写作和演示；明暗随 DSH。', jade: '墨绿铜金', navy: '深海蓝灰', neutral: '石墨中性', rose: '樱粉柔光', apricot: '杏橙暖光', system: '跟随 DSH',
    resource_profile: '资源档位', 'resource_profile.hint': '处理目标预算，并非整个 DSH 的内存硬限制。详细数值可在 Paper Library → 设置 → 资源与性能调整。', eco: '节能 · 256 MiB', balanced: '均衡 · 512 MiB', performance: '高性能 · 1024 MiB', custom: '自定义',
    loading: '正在读取主机设置…', unavailable: '当前连接不提供持久化插件设置。可在 Paper Library 内打开设置，使用主机保存。',
    readonly: '主机设置当前只读。', saving: '正在保存到主机…', saved: '已同步到主机',
    conflict: '设置未保存，已显示主机的当前值。请核对后重试。', failed: '无法确认设置已保存。请检查连接后重试。',
    reset: '恢复默认设置', 'reset.hint': '清除这些用户覆盖，恢复 DSH 配置中的默认值。',
    model: '模型、凭据、明暗模式与字号继续由 DSH 管理。',
    language: '语言模型与提示词', 'language.model': '模型', 'language.hint': '翻译优先使用已配置的轻量模型，润色跟随 DSH；也可指定语言模型与补充提示词。',
    'language.default': '自动：轻量翻译／DSH 润色', 'language.missing': '当前不可用', 'language.translate': '翻译补充提示词', 'language.polish': '润色补充提示词',
    'language.target': '默认翻译目标', 'language.target.auto': '自动：中文译为英文，其他译为中文', 'language.target.zh-CN': '中文', 'language.target.en': '英文',
    'language.save': '保存语言设置', 'language.reload': '重新读取（放弃本窗口未保存修改）', 'language.saved': '语言设置已保存。', 'language.conflict': '设置已在其他窗口更改，本窗口的输入仍保留。复制所需内容后可重新读取。',
    'language.failed': '语言设置读取或保存失败，请检查连接后重试。', 'language.loading': '正在读取语言设置…', 'language.saving': '正在保存语言设置…',
  },
  en: {
    ui_palette: 'Workspace palette', 'ui_palette.hint': 'Functional colors for reading, knowledge, writing and slides. Light/dark follows DSH.', jade: 'Jade & brass', navy: 'Navy & slate', neutral: 'Graphite neutral', rose: 'Soft rose', apricot: 'Warm apricot', system: 'Follow DSH',
    title: 'Paper Library', description: 'Shared with the library settings on the host. Open readers update when these choices change.',
    auto_analysis: 'Organize imported or selected papers', 'auto_analysis.hint': 'Newly imported or selected PDFs without a prior analysis enter a serial full-text queue. Uses the paper’s DSH model and model quota.',
    analysis_fill: 'Fill missing metadata after analysis', 'analysis_fill.hint': 'Uses source-backed AI suggestions and preserves existing values. Added metadata still needs review.',
    'auto-paper-conversation': 'Live companion: reply after saving a comment', 'auto-paper-conversation.hint': 'New or edited comments queue on the host and use this paper’s DSH model. Replies attach to their source annotations. Existing notes are not resent in bulk.',
    'reading-panel-side': 'Reading sidebar position', 'reading-panel-side.hint': 'The shared library and annotations sidebar.', left: 'Left', right: 'Right',
    resource_profile: 'Resource profile', 'resource_profile.hint': 'Processing target, not a hard memory cap for DSH. Adjust detailed limits in Paper Library settings.', eco: 'Eco · 256 MiB', balanced: 'Balanced · 512 MiB', performance: 'Performance · 1024 MiB', custom: 'Custom',
    loading: 'Loading host settings…', unavailable: 'This connection does not expose durable plugin settings. Open settings inside Paper Library to save on the host.',
    readonly: 'Host settings are read-only.', saving: 'Saving to the host…', saved: 'Synced to the host',
    conflict: 'Settings were not saved. Current host values are shown; review them and retry.', failed: 'Could not confirm the save. Check the connection and retry.',
    reset: 'Restore defaults', 'reset.hint': 'Clears these user overrides and restores the DSH configuration defaults.',
    model: 'Models, credentials, light/dark mode and font size remain managed by DSH.',
    language: 'Language model and prompts', 'language.model': 'Model', 'language.hint': 'Translation prefers a configured lightweight model; polishing follows DSH. An explicit language model overrides both.',
    'language.default': 'Auto: fast translation / DSH polishing', 'language.missing': 'Unavailable', 'language.translate': 'Additional translation instructions', 'language.polish': 'Additional polishing instructions',
    'language.target': 'Default translation target', 'language.target.auto': 'Automatic: Chinese to English, otherwise Chinese', 'language.target.zh-CN': 'Chinese', 'language.target.en': 'English',
    'language.save': 'Save language settings', 'language.reload': 'Reload (discard unsaved changes here)', 'language.saved': 'Language settings saved.', 'language.conflict': 'Settings changed in another window. Your input remains here; copy it before reloading.',
    'language.failed': 'Could not load or save language settings. Check the connection and retry.', 'language.loading': 'Loading language settings…', 'language.saving': 'Saving language settings…',
  },
}

/** The native scope may resolve after a rejected write; acknowledge only its accepted readback. */
export function createSettingsCardModel(scope) {
  let state = 'idle'
  let pending
  let disposed = false
  let unsubscribe
  const listeners = new Set()
  const notify = () => { if (!disposed) for (const listener of listeners) listener() }
  const getSnapshot = () => ({ scope: scope.getSnapshot(), state, pending })
  const mutate = async ops => {
    const before = scope.getSnapshot()
    if (disposed || state === 'saving' || !writable(before)) return false
    pending = Object.fromEntries(ops.map(op => [op.path[0], op.op === 'set' ? op.value : before.base?.[op.path[0]] ?? SETTINGS_DEFAULTS[op.path[0]]]))
    state = 'saving'; notify()
    try {
      await scope.mutate(ops, before.revision)
      if (disposed) return false
      const after = scope.getSnapshot()
      const accepted = writable(after) && ops.every(op => op.op === 'set'
        ? own(after.user, op.path[0]) && after.user[op.path[0]] === op.value && after.value?.[op.path[0]] === op.value
        : !own(after.user, op.path[0]) && after.value?.[op.path[0]] === (after.base?.[op.path[0]] ?? SETTINGS_DEFAULTS[op.path[0]]))
      pending = undefined; state = accepted ? 'saved' : 'conflict'; notify()
      return accepted
    } catch {
      if (!disposed) { pending = undefined; state = 'failed'; notify() }
      return false
    }
  }
  return {
    getSnapshot,
    subscribe(listener) {
      if (disposed) return () => {}
      listeners.add(listener)
      if (!unsubscribe) unsubscribe = scope.subscribe(notify)
      return () => { listeners.delete(listener); if (!listeners.size) { unsubscribe?.(); unsubscribe = undefined } }
    },
    set(key, value) {
      if (!fields.includes(key) || !valid(key, value)) return Promise.resolve(false)
      return mutate([{ op: 'set', path: [key], value }])
    },
    reset: () => mutate(fields.map(key => ({ op: 'unset', path: [key] }))),
    dispose() { disposed = true; unsubscribe?.(); unsubscribe = undefined; listeners.clear() },
  }
}

const muted = { color: 'var(--dsw-alias-label-secondary, #606771)', fontSize: '12px', lineHeight: 1.5 }
const control = { font: 'inherit', color: 'inherit', border: '1px solid var(--dsw-alias-border-l1, #d9dde2)', borderRadius: '7px', background: 'var(--dsw-alias-bg-base, transparent)', padding: '5px 8px', boxSizing: 'border-box', minWidth: 0, maxWidth: '100%' }

/** Language settings have their own revision; failed or concurrent saves retain the draft. */
export function createLanguageSettingsModel(request) {
  let snapshot = { status: 'idle', value: null, revision: null, models: [], defaultModel: null, dirty: false }
  let disposed = false, editVersion = 0
  const listeners = new Set()
  const update = patch => { if (!disposed) { snapshot = { ...snapshot, ...patch }; for (const listener of listeners) listener() } }
  return {
    getSnapshot: () => snapshot,
    subscribe(listener) { listeners.add(listener); return () => listeners.delete(listener) },
    async load() {
      if (disposed || ['loading', 'saving'].includes(snapshot.status)) return false
      update({ status: 'loading' })
      try {
        const result = await request('language_settings_get', {})
        if (disposed) return false
        editVersion++
        update({ status: 'ready', value: result.value, revision: result.revision, models: result.models || [], defaultModel: result.default_model, dirty: false })
        return true
      } catch { update({ status: 'failed' }); return false }
    },
    set(key, value) {
      if (disposed || !snapshot.value || !['model', 'translate_prompt', 'polish_prompt', 'target_language'].includes(key)) return
      editVersion++
      update({ value: { ...snapshot.value, [key]: value }, dirty: true, status: ['saving', 'conflict'].includes(snapshot.status) ? snapshot.status : 'ready' })
    },
    async save() {
      if (disposed || !snapshot.value || snapshot.revision == null || ['loading', 'saving', 'conflict'].includes(snapshot.status)) return false
      const value = snapshot.value, revision = snapshot.revision, version = editVersion
      update({ status: 'saving' })
      try {
        const result = await request('language_settings_update', { value, expected_revision: revision })
        if (disposed) return false
        const changed = editVersion !== version
        update({ revision: result.revision, value: changed ? snapshot.value : result.value, dirty: changed, status: changed ? 'ready' : 'saved' })
        return true
      } catch (error) { update({ status: error?.code === 'STATE_CONFLICT' ? 'conflict' : 'failed' }); return false }
    },
    dispose() { disposed = true; listeners.clear() },
  }
}

/** Adapt the existing HTTP settings API to the card's revision-aware scope. */
export function createHttpSettingsScope(request) {
  let snapshot = { status: 'loading', mode: 'host', writable: false, revision: 0 }
  let remoteRevision, disposed = false, busy = false
  const listeners = new Set()
  const publish = next => { if (!disposed) { snapshot = next; for (const listener of listeners) listener() } }
  const accept = result => {
    remoteRevision = result.revision
    publish({ status: 'ready', mode: result.backend === 'dsh' && result.available ? 'host' : 'unavailable', writable: !!result.writable,
      revision: snapshot.revision + 1, value: result.value || {}, user: result.user || {}, base: result.base || {} })
  }
  return {
    getSnapshot: () => snapshot,
    subscribe(listener) { listeners.add(listener); return () => listeners.delete(listener) },
    async refresh() {
      if (busy || disposed) return
      busy = true
      try { accept(await request('settings_get', {})) } catch { publish({ ...snapshot, status: 'unavailable', writable: false }) } finally { busy = false }
    },
    async mutate(ops, revision) {
      if (busy || disposed || revision !== snapshot.revision || ops.some(op => op.op !== 'set')) throw new Error('Settings changed')
      busy = true
      try {
        const patch = Object.fromEntries(ops.map(op => [op.path[0], op.value]))
        accept(await request('settings_update', { patch, expected_revision: remoteRevision }))
      } catch (error) {
        try { accept(await request('settings_get', {})) } catch { publish({ ...snapshot, status: 'unavailable', writable: false }) }
        throw error
      } finally { busy = false }
    },
    dispose() { disposed = true; listeners.clear() },
  }
}

async function languageRequest(action, args) {
  const response = await fetch('/api/paper-library/api', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action, ...args }) })
  const body = await response.json()
  if (!response.ok || !body.ok) throw Object.assign(new Error(body.error || 'Language settings request failed'), { code: body.code })
  return body.result
}

export function PaperLibraryLanguageSettings({ model, t }) {
  const [snapshot, setSnapshot] = useState(model.getSnapshot())
  useEffect(() => {
    const refresh = () => setSnapshot(model.getSnapshot())
    const unsubscribe = model.subscribe(refresh)
    refresh()
    if (!model.getSnapshot().dirty) void model.load()
    return unsubscribe
  }, [model])
  const { value, models, status } = snapshot
  const busy = status === 'loading' || status === 'saving'
  const selected = value?.model ? JSON.stringify([value.model.provider, value.model.model]) : ''
  const choices = models.map(item => ({ key: JSON.stringify([item.provider, item.id]), name: item.name || item.id, model: { provider: item.provider, model: item.id } }))
  const groups = new Map()
  for (const item of choices) {
    const group = groups.get(item.model.provider) || []
    group.push(item); groups.set(item.model.provider, group)
  }
  const missing = selected && !choices.some(item => item.key === selected)
  const statusKey = ['loading', 'saving', 'saved', 'failed', 'conflict'].includes(status) ? `language.${status}` : null
  return h('section', { 'aria-label': t('language'), style: { marginTop: '20px', display: 'grid', gridTemplateColumns: 'minmax(0, 1fr)', gap: '10px', minWidth: 0 } },
    h('h3', { style: { margin: 0, fontSize: '15px' } }, t('language')),
    h('p', { style: { ...muted, margin: 0 } }, t('language.hint')),
    value ? h('label', { style: { display: 'grid', gap: '5px' } }, t('language.model'),
      h('select', { value: selected, disabled: busy, style: control, onChange: event => model.set('model', choices.find(item => item.key === event.currentTarget.value)?.model || null) },
        h('option', { value: '' }, t('language.default')),
        missing ? h('option', { value: selected }, `${value.model.provider} / ${value.model.model} (${t('language.missing')})`) : null,
        ...[...groups].map(([provider, items]) => h('optgroup', { key: provider, label: provider },
          ...items.map(item => h('option', { key: item.key, value: item.key }, item.name)))))) : null,
    value ? h('label', { style: { display: 'grid', gap: '5px' } }, t('language.target'),
      h('select', { value: value.target_language || 'auto', disabled: busy, style: control, onChange: event => model.set('target_language', event.currentTarget.value) },
        ...['auto', 'zh-CN', 'en'].map(target => h('option', { key: target, value: target }, t(`language.target.${target}`))))) : null,
    ...['translate', 'polish'].map(kind => value ? h('label', { key: kind, style: { display: 'grid', gap: '5px' } }, t(`language.${kind}`),
      h('textarea', { value: value[`${kind}_prompt`] || '', maxLength: 2000, rows: 3, disabled: busy, style: { ...control, resize: 'vertical' }, onChange: event => model.set(`${kind}_prompt`, event.currentTarget.value) })) : null),
    h('div', { style: { display: 'flex', gap: '10px', flexWrap: 'wrap' } },
      h('button', { type: 'button', style: control, disabled: !value || busy || !!missing || status === 'conflict', onClick: () => void model.save() }, t('language.save')),
      h('button', { type: 'button', style: control, disabled: busy, onClick: () => void model.load() }, t('language.reload'))),
    statusKey ? h('p', { role: ['failed', 'conflict'].includes(status) ? 'alert' : 'status', style: { ...muted, margin: 0 } }, t(statusKey)) : null)
}

/** A keyed native settings card owns its chrome; no value imports from another plugin. */
export function PaperLibrarySettingsCard({ model, t, onMount, canReset = true }) {
  const [snapshot, setSnapshot] = useState(model.getSnapshot())
  useEffect(() => {
    const refresh = () => setSnapshot(model.getSnapshot())
    const dispose = model.subscribe(refresh)
    refresh()
    onMount?.()
    return dispose
  }, [model, onMount])
  const { scope, state, pending } = snapshot
  const disabled = !writable(scope) || state === 'saving'
  const status = scope.status === 'loading' ? 'loading' : scope.status !== 'ready' || scope.mode !== 'host'
    ? 'unavailable' : !scope.writable ? 'readonly' : state === 'idle' ? null : state
  return h('section', { 'data-paper-library-settings': true, 'aria-label': t('title'), style: {
    padding: '16px', border: '1px solid var(--dsw-alias-border-l1, #d9dde2)', borderRadius: '12px',
    background: 'var(--dsw-alias-bg-base, transparent)', color: 'var(--dsw-alias-label-primary, inherit)',
    font: 'inherit', fontSize: '13px', minWidth: 0, overflowWrap: 'anywhere',
  } },
  h('h3', { style: { fontSize: '15px', lineHeight: 1.4, margin: '0 0 6px', fontWeight: 600 } }, t('title')),
  h('p', { style: { ...muted, margin: '0 0 14px' } }, t('description')),
  ...fields.map(key => {
    const id = `paper-library-setting-${key}`
    const value = own(pending, key) ? pending[key] : valid(key, scope.value?.[key]) ? scope.value[key] : SETTINGS_DEFAULTS[key]
    const input = key === 'resource_profile'
      ? h('select', { id, value, disabled, 'aria-describedby': `${id}-hint`, style: control, onChange: event => { void model.set(key, event.currentTarget.value) } }, ...['eco', 'balanced', 'performance', 'custom'].map(value => h('option', { key: value, value }, t(value))))
      : key === 'ui_palette'
      ? h('select', { id, value, disabled, 'aria-describedby': `${id}-hint`, style: control, onChange: event => { void model.set(key, event.currentTarget.value) } }, ...['jade', 'navy', 'neutral', 'rose', 'apricot', 'system'].map(value => h('option', { key: value, value }, t(value))))
      : key === 'reading-panel-side'
      ? h('select', { id, value, disabled, 'aria-describedby': `${id}-hint`, style: control, onChange: event => { void model.set(key, event.currentTarget.value) } },
        h('option', { value: 'left' }, t('left')), h('option', { value: 'right' }, t('right')))
      : h('input', { id, type: 'checkbox', checked: value, disabled, 'aria-describedby': `${id}-hint`, style: { margin: 0, flex: 'none', accentColor: 'var(--dsw-alias-brand-primary, #171a1f)' }, onChange: event => { void model.set(key, event.currentTarget.checked) } })
    return h('div', { key, style: { display: 'grid', gridTemplateColumns: 'minmax(0, 1fr) auto', alignItems: 'center', columnGap: '16px', padding: '10px 0', borderTop: '1px solid var(--dsw-alias-border-l1, #d9dde2)' } },
      h('div', null, h('label', { htmlFor: id, style: { display: 'block', fontWeight: 500, lineHeight: 1.5, cursor: disabled ? 'default' : 'pointer' } }, t(key)),
        h('p', { id: `${id}-hint`, style: { ...muted, margin: '3px 0 0' } }, t(`${key}.hint`))), input)
  }),
  h('div', { style: { display: 'flex', flexWrap: 'wrap', gap: '10px', alignItems: 'center', marginTop: '12px' } },
    canReset ? h('button', { type: 'button', disabled, title: t('reset.hint'), style: { ...control, cursor: disabled ? 'default' : 'pointer' }, onClick: () => { void model.reset() } }, t('reset')) : null,
    status ? h('span', { role: ['conflict', 'failed'].includes(status) ? 'alert' : 'status', style: { ...muted, color: ['conflict', 'failed'].includes(status) ? 'var(--dsw-alias-state-error-primary, #b33939)' : muted.color } }, t(status)) : null),
  h('p', { style: { ...muted, margin: '12px 0 0' } }, t('model')))
}

/** Only namespace invalidations cross to a same-origin reader; values and credentials stay on the host. */
export function bindSettingsInvalidation({ window, target, scope }) {
  const origin = window.location.origin
  let previous
  let active = true
  const publish = (force = false) => {
    if (!active) return
    const snapshot = scope.getSnapshot()
    if (snapshot.status !== 'ready' || snapshot.mode !== 'host' || !Number.isSafeInteger(snapshot.revision)) return
    if (!force && snapshot.revision === previous) return
    previous = snapshot.revision
    target.postMessage({ type: 'paper-library:settings-changed', version: 1, namespace: SETTINGS_NAMESPACE, revision: snapshot.revision }, origin)
  }
  const request = event => {
    if (event.origin !== origin || event.source !== target || event.data?.version !== 1
      || !['paper-library:settings-ready', 'paper-library:ready'].includes(event.data?.type)) return
    publish(true)
  }
  window.addEventListener('message', request)
  const unsubscribe = scope.subscribe(() => publish())
  publish()
  return () => { active = false; unsubscribe(); window.removeEventListener('message', request) }
}

/** The optional service and keyed slot do not gate the library tab on older/minimal deployments. */
export function registerPaperLibrarySettings(ctx, window) {
  const httpScope = createHttpSettingsScope(languageRequest)
  const httpModel = createSettingsCardModel(httpScope)
  const language = createLanguageSettingsModel(languageRequest)
  let scope = httpScope
  const frames = new Set()
  const bind = target => {
    const binding = { target, dispose: scope ? bindSettingsInvalidation({ window, target, scope }) : undefined }
    frames.add(binding)
    return () => { binding.dispose?.(); frames.delete(binding) }
  }
  const setScope = next => {
    scope = next
    for (const binding of frames) {
      binding.dispose?.()
      binding.dispose = bindSettingsInvalidation({ window, target: binding.target, scope })
    }
  }
  if (ctx.effect && ctx.locale && ctx.slots) {
    ctx.effect(() => ctx.locale.register(LOCALE, locales), 'paper-library: settings locale')
    const t = ctx.locale.bind(LOCALE)
    const refresh = () => { void httpScope.refresh() }
    ctx.effect(() => ctx.slots.inject('settings.section', () => ctx.slots.register({
      name: 'settings.section', id: SETTINGS_NAMESPACE, order: 35, label: () => t('title'), locale: LOCALE,
      inject: () => ({ model: httpModel, language }),
    }, props => h('div', { style: { maxWidth: '760px', padding: '16px', font: 'inherit' } },
      h(PaperLibrarySettingsCard, { model: props.model, t, onMount: refresh, canReset: false }), h(PaperLibraryLanguageSettings, { model: props.language, t })))), 'paper-library: settings section')
    ctx.effect(() => () => {
      for (const binding of frames) { binding.dispose?.(); binding.dispose = undefined }
      httpModel.dispose(); httpScope.dispose(); language.dispose()
    }, 'paper-library: settings section cleanup')
  }
  ctx.inject?.(['settingsScope'], settingsCtx => {
    const nativeScope = settingsCtx.settingsScope.bind({ namespace: SETTINGS_NAMESPACE })
    const model = createSettingsCardModel(nativeScope)
    const t = settingsCtx.locale.bind(LOCALE)
    settingsCtx.effect(() => settingsCtx.slots.inject('settings.plugin.item', () => settingsCtx.slots.register({
      name: 'settings.plugin.item', key: SETTINGS_NAMESPACE, locale: LOCALE,
      inject: () => ({ model }),
    }, props => h(PaperLibrarySettingsCard, { ...props, t }))), 'paper-library: settings card')
    settingsCtx.effect(() => {
      setScope(nativeScope)
      return () => {
        model.dispose(); setScope(httpScope)
      }
    }, 'paper-library: settings bridge')
  })
  return { bind }
}
