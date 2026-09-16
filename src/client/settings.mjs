import { createElement as h, useEffect, useState } from 'react'

export const SETTINGS_NAMESPACE = 'paper-library'
const LOCALE = 'paperLibrarySettings'
export const SETTINGS_DEFAULTS = Object.freeze({
  auto_analysis: true,
  analysis_fill: true,
  'auto-paper-conversation': false,
  'reading-panel-side': 'left',
})
const fields = Object.keys(SETTINGS_DEFAULTS)
const own = (value, key) => Object.prototype.hasOwnProperty.call(value ?? {}, key)
const valid = (key, value) => key === 'reading-panel-side'
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
    loading: '正在读取主机设置…', unavailable: '当前连接不提供持久化插件设置。可在 Paper Library 内打开设置，使用主机保存。',
    readonly: '主机设置当前只读。', saving: '正在保存到主机…', saved: '已同步到主机',
    conflict: '设置未保存，已显示主机的当前值。请核对后重试。', failed: '无法确认设置已保存。请检查连接后重试。',
    reset: '恢复默认设置', 'reset.hint': '清除这四项用户覆盖，恢复 DSH 配置中的默认值。',
    model: '模型、凭据、主题与字号继续由 DSH 管理。',
  },
  en: {
    title: 'Paper Library', description: 'Shared with the library settings on the host. Open readers update when these choices change.',
    auto_analysis: 'Organize imported or selected papers', 'auto_analysis.hint': 'Newly imported or selected PDFs without a prior analysis enter a serial full-text queue. Uses the paper’s DSH model and model quota.',
    analysis_fill: 'Fill missing metadata after analysis', 'analysis_fill.hint': 'Uses source-backed AI suggestions and preserves existing values. Added metadata still needs review.',
    'auto-paper-conversation': 'Live companion: reply after saving a comment', 'auto-paper-conversation.hint': 'New or edited comments queue on the host and use this paper’s DSH model. Replies attach to their source annotations. Existing notes are not resent in bulk.',
    'reading-panel-side': 'Reading sidebar position', 'reading-panel-side.hint': 'The shared library and annotations sidebar.', left: 'Left', right: 'Right',
    loading: 'Loading host settings…', unavailable: 'This connection does not expose durable plugin settings. Open settings inside Paper Library to save on the host.',
    readonly: 'Host settings are read-only.', saving: 'Saving to the host…', saved: 'Synced to the host',
    conflict: 'Settings were not saved. Current host values are shown; review them and retry.', failed: 'Could not confirm the save. Check the connection and retry.',
    reset: 'Restore defaults', 'reset.hint': 'Clears these four user overrides and restores the DSH configuration defaults.',
    model: 'Models, credentials, theme and font size remain managed by DSH.',
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
const control = { font: 'inherit', color: 'inherit', border: '1px solid var(--dsw-alias-border-l1, #d9dde2)', borderRadius: '7px', background: 'var(--dsw-alias-bg-base, transparent)', padding: '5px 8px' }

/** A keyed native settings card owns its chrome; no value imports from another plugin. */
export function PaperLibrarySettingsCard({ model, t }) {
  const [snapshot, setSnapshot] = useState(model.getSnapshot())
  useEffect(() => {
    const refresh = () => setSnapshot(model.getSnapshot())
    const dispose = model.subscribe(refresh)
    refresh()
    return dispose
  }, [model])
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
    const input = key === 'reading-panel-side'
      ? h('select', { id, value, disabled, 'aria-describedby': `${id}-hint`, style: control, onChange: event => { void model.set(key, event.currentTarget.value) } },
        h('option', { value: 'left' }, t('left')), h('option', { value: 'right' }, t('right')))
      : h('input', { id, type: 'checkbox', checked: value, disabled, 'aria-describedby': `${id}-hint`, style: { margin: 0, flex: 'none', accentColor: 'var(--dsw-alias-brand-primary, #171a1f)' }, onChange: event => { void model.set(key, event.currentTarget.checked) } })
    return h('div', { key, style: { display: 'grid', gridTemplateColumns: 'minmax(0, 1fr) auto', alignItems: 'center', columnGap: '16px', padding: '10px 0', borderTop: '1px solid var(--dsw-alias-border-l1, #d9dde2)' } },
      h('div', null, h('label', { htmlFor: id, style: { display: 'block', fontWeight: 500, lineHeight: 1.5, cursor: disabled ? 'default' : 'pointer' } }, t(key)),
        h('p', { id: `${id}-hint`, style: { ...muted, margin: '3px 0 0' } }, t(`${key}.hint`))), input)
  }),
  h('div', { style: { display: 'flex', flexWrap: 'wrap', gap: '10px', alignItems: 'center', marginTop: '12px' } },
    h('button', { type: 'button', disabled, title: t('reset.hint'), style: { ...control, cursor: disabled ? 'default' : 'pointer' }, onClick: () => { void model.reset() } }, t('reset')),
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
  let scope
  const frames = new Set()
  const bind = target => {
    const binding = { target, dispose: scope ? bindSettingsInvalidation({ window, target, scope }) : undefined }
    frames.add(binding)
    return () => { binding.dispose?.(); frames.delete(binding) }
  }
  ctx.inject?.(['settingsScope'], settingsCtx => {
    scope = settingsCtx.settingsScope.bind({ namespace: SETTINGS_NAMESPACE })
    const model = createSettingsCardModel(scope)
    settingsCtx.effect(() => settingsCtx.locale.register(LOCALE, locales), 'paper-library: settings locale')
    const t = settingsCtx.locale.bind(LOCALE)
    settingsCtx.effect(() => settingsCtx.slots.inject('settings.plugin.item', () => settingsCtx.slots.register({
      name: 'settings.plugin.item', key: SETTINGS_NAMESPACE, locale: LOCALE,
      inject: () => ({ model }),
    }, props => h(PaperLibrarySettingsCard, { ...props, t }))), 'paper-library: settings card')
    settingsCtx.effect(() => {
      for (const binding of frames) binding.dispose = bindSettingsInvalidation({ window, target: binding.target, scope })
      return () => {
        for (const binding of frames) { binding.dispose?.(); binding.dispose = undefined }
        model.dispose(); scope = undefined
      }
    }, 'paper-library: settings bridge')
  })
  return { bind }
}
