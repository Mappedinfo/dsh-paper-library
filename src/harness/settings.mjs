/** Shared preferences: the native DSH namespace is authoritative when mounted.
 * Reader drafts and legacy-only fields retain their existing per-library store.
 * No second process opens or writes the DSH settings document here.
 */
import { createHash } from 'node:crypto';
import { LocalStateConflictError, LocalStateError } from '../local-state.mjs';

export const PAPER_LIBRARY_SETTINGS_NAMESPACE = 'paper-library';
export const PAPER_LIBRARY_SETTINGS_DEFAULTS = Object.freeze({
  auto_analysis: true,
  analysis_fill: true,
  auto_review: true,
  'auto-paper-conversation': false,
  'reading-panel-side': 'left',
});
const fields = Object.keys(PAPER_LIBRARY_SETTINGS_DEFAULTS);
const markerKey = 'settings.migration:paper-library';
const backupKey = 'settings.backup:paper-library';
const own = (value, key) => Object.hasOwn(value, key);
const clone = value => structuredClone(value);
const plain = value => value !== null && typeof value === 'object' && !Array.isArray(value)
  && [Object.prototype, null].includes(Object.getPrototypeOf(value));
const stable = value => JSON.stringify(value, (_key, item) => plain(item)
  ? Object.fromEntries(Object.keys(item).sort().map(key => [key, item[key]])) : item);
const equal = (left, right) => stable(left) === stable(right);
const hash = value => createHash('sha256').update(stable(value)).digest('hex');
const conflict = record => new LocalStateConflictError(record);
const invalid = message => new LocalStateError(message, 'SETTINGS_INVALID', 400);
const unavailable = () => new LocalStateError('此库的设置由 DSH 管理。请在 DSH 文献库或设置 → 插件中修改。', 'SETTINGS_UNAVAILABLE', 503);

/** The caller supplies DSH's schemastery constructor; standalone has no dependency. */
export function createPaperLibrarySettingsSchema(Schema) {
  return Schema.object({
    auto_analysis: Schema.boolean().default(true),
    analysis_fill: Schema.boolean().default(true),
    auto_review: Schema.boolean().default(true),
    'auto-paper-conversation': Schema.boolean().default(false),
    'reading-panel-side': Schema.union([Schema.const('left'), Schema.const('right')]).default('left'),
  });
}

function validatePatch(patch) {
  if (!plain(patch)) throw invalid('设置必须是字段对象。');
  for (const [key, value] of Object.entries(patch)) {
    if (!fields.includes(key)) throw invalid(`此字段不属于可编辑设置：${key}`);
    if (key === 'reading-panel-side' ? !['left', 'right'].includes(value) : typeof value !== 'boolean') {
      throw invalid(`设置值无效：${key}`);
    }
  }
  return clone(patch);
}
function managed(value, { legacy = false } = {}) {
  const result = {};
  for (const key of fields) {
    if (!own(value, key)) continue;
    let candidate = value[key];
    if (legacy && key !== 'reading-panel-side' && ['true', 'false'].includes(candidate)) candidate = candidate === 'true';
    try { Object.assign(result, validatePatch({ [key]: candidate })); } catch { /* Invalid legacy values remain in their recovery record. */ }
  }
  return result;
}
function extras(value) { return Object.fromEntries(Object.entries(value).filter(([key]) => !fields.includes(key))); }
function preferencesOf(record) {
  if (record.value === null) return {};
  if (!plain(record.value)) throw new LocalStateError('现有偏好格式无效，原记录已保留。', 'STATE_CORRUPT', 409);
  return record.value;
}

/**
 * @param {object} options
 * @param {object} options.store - Existing LocalState store; only preferences and two migration keys are read.
 * @param {object} [options.settings] - Native ctx.settings, owned by the caller's injectable fiber.
 * @param {object} [options.schema] - createPaperLibrarySettingsSchema(Schema), required with settings.
 * @param {object} [options.base] - Optional composition defaults for the four live preferences only.
 */
export function createPaperLibrarySettings({ store, settings, schema, base = {} }) {
  if (!store?.get || !store?.put || !store?.list) throw new TypeError('settings require the local state store');
  const defaults = { ...PAPER_LIBRARY_SETTINGS_DEFAULTS, ...validatePatch(base) };
  if (settings && !schema) throw new TypeError('native settings require a schemastery schema');
  const scope = settings?.register(PAPER_LIBRARY_SETTINGS_NAMESPACE, schema, { base: defaults, applies: 'live' });
  let disposed = false, tail = Promise.resolve();
  const listeners = new Set();
  function notify() { if (!disposed) for (const listener of listeners) { try { listener(); } catch { /* A view cannot reject a committed preference. */ } } }
  const unwatch = scope?.watch(notify);
  function native() {
    const descriptor = settings?.describe({ redactSecrets: true }).find(item => item.ns === PAPER_LIBRARY_SETTINGS_NAMESPACE);
    if (settings && !descriptor) throw unavailable();
    return descriptor;
  }
  async function putOnce(key, value) {
    const current = await store.get(key);
    if (current.revision !== 0) return current;
    try { return await store.put(key, value, 0); }
    catch (error) { if (error.code !== 'STATE_CONFLICT') throw error; return store.get(key); }
  }
  const ready = (async () => {
    if (!settings) return;
    const marker = await store.get(markerKey);
    if (marker.revision !== 0) {
      if (marker.value?.version !== 1 || marker.value?.namespace !== PAPER_LIBRARY_SETTINGS_NAMESPACE) {
        throw new LocalStateError('设置迁移记录无效，已保留原文件。', 'STATE_CORRUPT', 409);
      }
      return;
    }
    const legacy = await store.get('preferences'), value = preferencesOf(legacy);
    if (legacy.revision !== 0) await putOnce(backupKey, clone(value));
    const candidates = managed(value, { legacy: true });
    let imported = [];
    for (let attempt = 0; attempt < 3; attempt++) {
      const current = native();
      const patch = Object.fromEntries(Object.entries(candidates).filter(([key]) => !own(current.user ?? {}, key)));
      if (!Object.keys(patch).length) break;
      try { await settings.update(PAPER_LIBRARY_SETTINGS_NAMESPACE, patch, current.revision); imported = Object.keys(patch); break; }
      catch (error) { if (error.code !== 'SETTINGS_CONFLICT' || attempt === 2) throw error; }
    }
    await putOnce(markerKey, {
      version: 1, namespace: PAPER_LIBRARY_SETTINGS_NAMESPACE, source_revision: legacy.revision,
      imported_fields: imported, ignored_fields: fields.filter(key => own(value, key) && !own(candidates, key)),
    });
  })();
  // Expose the rejection on ready and every operation, without an unhandled boot promise.
  void ready.catch(() => {});

  async function snapshot() {
    await ready;
    if (disposed) throw unavailable();
    const legacy = await store.get('preferences'), value = preferencesOf(legacy), current = native();
    const marker = current ? null : await store.get(markerKey);
    const managedElsewhere = !current && marker.revision !== 0;
    const backend = current || managedElsewhere ? 'dsh' : 'local';
    const resolved = current ? { ...defaults, ...managed(current.value ?? {}) }
      : managedElsewhere ? null : { ...defaults, ...managed(value, { legacy: true }) };
    const revision = hash({ legacy: legacy.revision, backend, namespace: current
      ? { revision: current.revision, value: current.value, user: current.user ?? null, base: current.base ?? null }
      : marker.revision });
    const descriptor = {
      namespace: PAPER_LIBRARY_SETTINGS_NAMESPACE, backend, available: !managedElsewhere,
      writable: current ? settings.writable === true : !managedElsewhere, revision,
      value: resolved, base: current?.base ?? defaults, user: current?.user ?? (managedElsewhere ? null : managed(value, { legacy: true })),
      native_revision: current?.revision ?? null,
    };
    return { legacy, current, descriptor, record: backend === 'local' ? clone(legacy) : {
      key: 'preferences', value: { ...extras(value), ...(resolved ?? {}) }, revision, updated_at: legacy.updated_at,
    } };
  }
  function enqueue(operation) {
    const task = tail.then(operation); tail = task.catch(() => {}); return task;
  }
  function assertRevision(expected, current, legacyAPI = false) {
    if (!(legacyAPI && current.descriptor.backend === 'local' && expected === 0)
      && (typeof expected !== 'string' || !/^[a-f0-9]{64}$/.test(expected))) throw invalid('保存设置需要当前版本号。');
    if (expected !== (legacyAPI ? current.record.revision : current.descriptor.revision)) throw conflict(current.record);
    if (!current.descriptor.writable) throw unavailable();
  }
  async function nativeWrite(current, patch, resetFields) {
    try {
      if (resetFields) await settings.mutate(PAPER_LIBRARY_SETTINGS_NAMESPACE, resetFields.map(key => ({ op: 'unset', path: [key] })), current.current.revision);
      else await settings.update(PAPER_LIBRARY_SETTINGS_NAMESPACE, patch, current.current.revision);
    } catch (error) {
      if (error.code === 'SETTINGS_CONFLICT') throw conflict((await snapshot()).record);
      throw error;
    }
  }
  async function write(patch, expected, resetFields) {
    const current = await snapshot(); assertRevision(expected, current);
    if (current.current) await nativeWrite(current, patch, resetFields);
    else {
      const value = { ...preferencesOf(current.legacy), ...patch };
      for (const key of resetFields ?? []) delete value[key];
      await store.put('preferences', value, current.legacy.revision);
    }
    notify(); return (await snapshot()).descriptor;
  }
  const localState = {
    async get(key) { return key === 'preferences' ? (await snapshot()).record : store.get(key); },
    put(key, value, expected) {
      if (key !== 'preferences') return store.put(key, value, expected);
      return enqueue(async () => {
        if (!plain(value)) throw invalid('偏好必须是字段对象。');
        const current = await snapshot(); assertRevision(expected, current, true);
        if (current.descriptor.backend === 'local') {
          // Preserve the public LocalState contract, including absent records,
          // legacy field types and full replacement, until DSH takes ownership.
          const saved = await store.put('preferences', clone(value), current.legacy.revision);
          notify(); return saved;
        }
        // Existing browser writes are full-record snapshots, not patches: do not
        // allow a stale/older client to delete preferences it did not understand.
        const currentValue = current.record.value;
        for (const field of Object.keys(currentValue)) if (!own(value, field)) throw invalid('请保留未编辑的偏好字段。');
        const patch = validatePatch(Object.fromEntries(fields.filter(field => own(value, field) && !equal(value[field], currentValue[field])).map(field => [field, value[field]])));
        const nextExtras = extras(value), oldExtras = extras(currentValue), extrasChanged = !equal(nextExtras, oldExtras);
        if (current.current) {
          if (extrasChanged && Object.keys(patch).length) throw invalid('请分别保存 DSH 设置与旧版偏好，避免跨存储部分写入。');
          if (Object.keys(patch).length) await nativeWrite(current, patch);
          if (extrasChanged) await store.put('preferences', { ...preferencesOf(current.legacy), ...nextExtras }, current.legacy.revision);
        } else await store.put('preferences', clone(value), current.legacy.revision);
        notify(); return (await snapshot()).record;
      });
    },
    async list(options = {}) {
      if (options.prefix !== 'preferences') return store.list(options);
      const offset = options.offset ?? 0, limit = options.limit ?? 20;
      if (!Number.isSafeInteger(offset) || offset < 0 || offset > 10000 || !Number.isSafeInteger(limit) || limit < 1 || limit > 50) throw invalid('状态分页要求 offset 0–10000、limit 1–50。');
      const record = await this.get('preferences');
      const total = record.revision === 0 ? 0 : 1;
      return { records: offset === 0 && total ? [record] : [], total, offset, limit, next_offset: null, hasMore: false, truncated: false };
    },
  };
  return {
    ready, localState,
    async get() { return clone((await snapshot()).descriptor); },
    update(patch, expectedRevision) { const valid = validatePatch(patch); return enqueue(() => write(valid, expectedRevision)); },
    reset(expectedRevision, resetFields = fields) {
      if (!Array.isArray(resetFields) || !resetFields.length || new Set(resetFields).size !== resetFields.length || resetFields.some(key => !fields.includes(key))) throw invalid('请选择有效且不重复的设置字段。');
      return enqueue(() => write({}, expectedRevision, [...resetFields]));
    },
    subscribe(listener) { listeners.add(listener); return () => listeners.delete(listener); },
    async dispose() { disposed = true; unwatch?.(); listeners.clear(); await Promise.allSettled([ready, tail]); },
  };
}
