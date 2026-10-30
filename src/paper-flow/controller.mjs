/** One CAS writer per board. A failed read or write never replaces the local draft. */
export function createFlowController({ api, validate, onChange = (_state) => {}, delay = 700 }) {
  let id = null, title = '', workspace = null, revision = null, version = 0, epoch = 0, dirty = false
  let saving = null, blocked = false, invalid = false, error = '', loading = false, disposed = false, timer = null
  const clone = value => value == null ? null : structuredClone(value)
  const state = () => ({ id, title, workspace: clone(workspace), revision, version, epoch, dirty, saving: !!saving, blocked, invalid, error, loading })
  const token = () => ({ id, version, epoch })
  const current = (owner, matchVersion = false) => !disposed && !loading && !!owner && owner.id === id && owner.epoch === epoch && (!matchVersion || owner.version === version)
  const emit = () => { if (!disposed) onChange(state()) }
  const clearTimer = () => { if (timer !== null) { clearTimeout(timer); timer = null } }
  const schedule = () => { clearTimer(); if (!disposed && dirty && !blocked && !invalid) timer = setTimeout(() => { timer = null; void flush() }, delay) }
  const decode = (record, expectedId) => {
    if (!record || record.id !== expectedId || !Object.hasOwn(record, 'workspace') || record.revision === undefined || record.revision === null) throw Error('流程工作区响应无效，当前草稿已保留。')
    return { workspace: record.workspace == null ? null : validate(record.workspace), revision: record.revision }
  }
  async function open(next) {
    if (disposed || loading || !next || typeof next.id !== 'string' || !next.id) return false
    if (id === next.id && (dirty || blocked || invalid || saving)) return true
    loading = true; emit()
    try {
      if (id && (invalid || blocked || !await flush())) return false
      const beforeRead = version
      const record = decode(await api('board_flow_get', { id: next.id }), next.id)
      if (disposed) return false
      if (beforeRead !== version) { error = '读取期间草稿发生变化，请保存后重试。'; return false }
      let value = record.workspace, seeded = false
      if (!value && next.seed != null) { value = validate(next.seed); seeded = true }
      clearTimer(); id = next.id; title = String(next.title || '画板'); revision = record.revision
      workspace = clone(value); dirty = seeded; version = seeded ? 1 : 0; ++epoch; blocked = false; invalid = false; error = ''
      if (seeded) schedule()
      return true
    } catch (e) { error = e?.message || String(e); return false }
    finally { loading = false; emit() }
  }
  function edit(value, owner) {
    if (disposed || !id) return false
    if (owner && !current(owner)) return false
    workspace = clone(value); ++version; dirty = true
    try { workspace = clone(validate(workspace)); invalid = false; if (!blocked) error = '' }
    catch (e) { invalid = true; error = e?.message || String(e) }
    schedule(); emit(); return !invalid
  }
  async function flush({ retry = false } = {}) {
    clearTimer()
    if (disposed || !id || !dirty) return !dirty
    if (invalid) return false
    if (saving) { await saving; return dirty && !blocked ? flush() : !dirty }
    if (blocked && !retry) return false
    if (retry) { blocked = false; error = '' }
    const currentId = id
    saving = (async () => {
      while (!disposed && id === currentId && dirty && !blocked && !invalid) {
        const captured = version, payload = clone(workspace)
        try {
          const result = decode(await api('board_flow_save', { id: currentId, workspace: payload, expected_revision: revision }), currentId)
          if (result.workspace === null) throw Error('保存响应未确认流程内容，草稿已保留。')
          const stable = value => JSON.stringify(value, (_key, item) => item && typeof item === 'object' && !Array.isArray(item) ? Object.fromEntries(Object.entries(item).sort(([a], [b]) => a.localeCompare(b))) : item)
          if (stable(result.workspace) !== stable(validate(payload))) throw Error('保存响应与草稿不一致，草稿已保留。')
          if (disposed || id !== currentId) return
          revision = result.revision
          if (captured === version) { workspace = clone(result.workspace); dirty = false }
          error = ''
        } catch (e) {
          if (disposed || id !== currentId) return
          blocked = true; error = e?.message || String(e)
        }
        emit()
      }
    })()
    emit()
    try { await saving } finally { saving = null; emit() }
    return !dirty && !blocked && !invalid
  }
  async function prepareLeave() {
    if (disposed || loading) return false
    if (invalid || blocked) return false
    return await flush()
  }
  async function reload() {
    if (disposed || loading || !id) return false
    const currentId = id, beforeRead = version; loading = true; emit()
    try {
      if (saving) await saving
      const record = decode(await api('board_flow_get', { id: currentId }), currentId)
      if (disposed || currentId !== id) return false
      if (beforeRead !== version) { error = '读取期间草稿发生变化，已保留。'; return false }
      clearTimer(); workspace = clone(record.workspace); revision = record.revision; dirty = false; blocked = false; invalid = false; error = ''; ++version; ++epoch
      return true
    } catch (e) { error = e?.message || String(e); return false }
    finally { loading = false; emit() }
  }
  function applyExternal(value, owner) { return current(owner, true) && edit(value, owner) }
  function invalidatePending() { ++epoch; emit() }
  function dispose() { disposed = true; clearTimer() }
  return { state, token, current, open, edit, applyExternal, invalidatePending, flush, prepareLeave, reload, dispose }
}
