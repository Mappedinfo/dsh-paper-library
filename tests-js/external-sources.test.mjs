/**
 * Synced corpora stay optional and deployment-configured: the library indexes them
 * by symlink, never by copying, and a sync service is read, never required.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { resolveConfig } from '../src/harness/config.mjs'
import { createExternalSources, normalizeConfiguredSources, SOURCE_TOOL_SPECS } from '../src/harness/external-sources.mjs'
import { createSyncSourceReader, sourcesFromSyncConfig } from '../src/harness/sync-config.mjs'
import { requestFromTool, TOOL_SPECS } from '../src/harness/tools.mjs'

const serviceConfig = {
  version: 1,
  sources: [
    { id: 'paper-library', kind: 'paper-library', root: '/Users/example/.local/share/dsh-paper-library' },
    { id: 'zotero-attachments', kind: 'directory', root: '/Users/example/Documents/academic/zotero-attanger' },
    { id: 'cloudsync-academic', kind: 'directory', root: '/Users/example/ShiqiLocalStorage/CloudSync/Academic' },
    { id: 'relative', kind: 'directory', root: 'relative/path' },
    { id: 'remote-only', kind: 'rclone', root: '/Users/example/remote' },
  ],
}

function fakeFileSystem(files) {
  return {
    readFile: async path => {
      if (!(path in files)) throw Object.assign(new Error('no such file'), { code: 'ENOENT' })
      return files[path].body
    },
    statFile: async path => {
      if (!(path in files)) throw Object.assign(new Error('no such file'), { code: 'ENOENT' })
      return { isFile: () => true, size: files[path].body.length, mtimeMs: files[path].mtime }
    },
  }
}

test('a sync service config contributes its directory sources and nothing else', () => {
  const { sources, warnings } = sourcesFromSyncConfig(serviceConfig)
  assert.deepEqual(sources.map(entry => entry.id), ['sync-zotero-attachments', 'sync-cloudsync-academic'])
  assert.deepEqual(sources.map(entry => entry.root), ['/Users/example/Documents/academic/zotero-attanger', '/Users/example/ShiqiLocalStorage/CloudSync/Academic'])
  assert.deepEqual(warnings, [])
  assert.deepEqual(sourcesFromSyncConfig({}).warnings, ['sync config has no sources array'])
  assert.deepEqual(sourcesFromSyncConfig({ sources: 'nope' }).sources, [])
})

test('the sync config is read bounded, memoized by mtime, and never fatal', async () => {
  const files = { '/sync/config.json': { body: JSON.stringify(serviceConfig), mtime: 1 } }
  const reader = createSyncSourceReader(fakeFileSystem(files))
  const first = await reader('/sync/config.json')
  assert.equal(first.sources.length, 2)
  files['/sync/config.json'].mtime = 2
  files['/sync/config.json'].body = JSON.stringify({ sources: [{ id: 'zotero-attachments', kind: 'directory', root: '/Users/example/Documents/academic/zotero-attanger' }] })
  const second = await reader('/sync/config.json')
  assert.equal(second.sources.length, 1)
  files['/sync/config.json'].body = '{ not json'
  files['/sync/config.json'].mtime = 3
  const broken = await reader('/sync/config.json')
  assert.deepEqual(broken.sources, [])
  assert.match(broken.warnings[0], /could not be parsed/)
  const missing = await reader('/sync/missing.json')
  assert.equal(missing.sources.length, 0)
  assert.match(missing.warnings[0], /unavailable/)
  assert.deepEqual(await reader(undefined), { sources: [], warnings: [] })
})

test('external source configuration is validated before the plugin loads', () => {
  assert.deepEqual(normalizeConfiguredSources(undefined), [])
  assert.deepEqual(normalizeConfiguredSources([{ id: 'local', root: '/papers', label: '本地' }]), [{ id: 'local', root: '/papers', label: '本地', from: 'config' }])
  assert.equal(normalizeConfiguredSources('[{"id":"local","root":"/papers"}]')[0].id, 'local')
  assert.throws(() => normalizeConfiguredSources('nope'), /array or JSON array/)
  assert.throws(() => normalizeConfiguredSources([{ id: 'Bad Id', root: '/papers' }]), /lowercase/)
  assert.throws(() => normalizeConfiguredSources([{ id: 'local', root: 'papers' }]), /absolute root/)
  assert.deepEqual(normalizeConfiguredSources([{ id: 'sync-zotero-attachments' }]), [{ id: 'sync-zotero-attachments', from: 'config' }])
  assert.deepEqual(normalizeConfiguredSources([{ select: 'all' }]), [{ select: 'all', from: 'config' }])
  assert.throws(() => normalizeConfiguredSources([{ select: 'some' }]), /select must be "all"/)
  assert.throws(() => normalizeConfiguredSources([{ id: 'a', root: '/a' }, { id: 'a', root: '/b' }]), /duplicate/)
  assert.throws(() => normalizeConfiguredSources(Array.from({ length: 9 }, (_, index) => ({ id: `s${index}`, root: `/p${index}` }))), /at most 8/)
  const config = resolveConfig({ library: '/tmp/library', syncConfig: '/Users/example/.dsh/vault-sync/config.json', externalSources: [{ id: 'local', root: '/papers' }] })
  assert.equal(config.externalSources.length, 1)
  assert.equal(config.syncConfig, '/Users/example/.dsh/vault-sync/config.json')
  assert.equal(resolveConfig({ library: '/tmp/library' }).syncConfig, undefined)
  assert.throws(() => resolveConfig({ library: '/tmp/library', syncConfig: 'relative.json' }), /absolute/)
})

test('a sync service only offers directories until one is selected', async () => {
  const files = { '/sync/config.json': { body: JSON.stringify(serviceConfig), mtime: 1 } }
  const sources = createExternalSources({ config: resolveConfig({ library: '/tmp/library', syncConfig: '/sync/config.json' }), ...fakeFileSystem(files) })
  const offered = await sources.list()
  assert.deepEqual(offered.sources, [])
  assert.deepEqual(offered.offered.map(entry => entry.id), ['sync-zotero-attachments', 'sync-cloudsync-academic'])

  const byId = await sources.list({ external_sources: '[{"id":"sync-zotero-attachments"}]' })
  assert.deepEqual(byId.sources.map(entry => entry.root), ['/Users/example/Documents/academic/zotero-attanger'])
  assert.equal(byId.sources[0].from, 'selection')
  // `list` reports every candidate; the tool result narrows that to the unselected ones.
  assert.deepEqual(byId.offered.map(entry => entry.id), ['sync-zotero-attachments', 'sync-cloudsync-academic'])

  const all = await sources.list({ external_sources: '[{"select":"all"}]' })
  assert.deepEqual(all.sources.map(entry => entry.id), ['sync-zotero-attachments', 'sync-cloudsync-academic'])

  const unknown = await sources.list({ external_sources: '[{"id":"nope"}]' })
  assert.deepEqual(unknown.sources, [])
  assert.match(unknown.warnings.join(' '), /no sync service directory matches/)
})

test('state directories inside the DSH home are never offered as paper sources', async () => {
  const files = { '/sync/config.json': { body: JSON.stringify({ sources: [
    { id: 'paper-library-state', kind: 'directory', root: '/home/example/.dsh/paper-library' },
    { id: 'sessions', kind: 'directory', root: '/home/example/.dsh/sessions' },
    { id: 'zotero-attachments', kind: 'directory', root: '/Users/example/Documents/academic/zotero-attanger' },
  ] }), mtime: 1 } }
  const config = resolveConfig({ library: '/tmp/library', localStateHome: '/home/example/.dsh', syncConfig: '/sync/config.json' })
  const sources = createExternalSources({ config, ...fakeFileSystem(files) })
  const listed = await sources.list({ external_sources: '[{"select":"all"}]' })
  assert.deepEqual(listed.offered.map(entry => entry.id), ['sync-zotero-attachments'])
  assert.deepEqual(listed.sources.map(entry => entry.root), ['/Users/example/Documents/academic/zotero-attanger'])
  assert.match(listed.warnings.join(' '), /DSH home hold state/)
})

test('live settings may name the sync service and select from it', async () => {
  const files = { '/sync/config.json': { body: JSON.stringify(serviceConfig), mtime: 1 } }
  const sources = createExternalSources({ config: resolveConfig({ library: '/tmp/library' }), ...fakeFileSystem(files) })
  const fromSettings = await sources.list({ sync_config: '/sync/config.json', external_sources: '[{"id":"sync-cloudsync-academic"},{"id":"extra","root":"/Volumes/archive/papers"}]' })
  assert.deepEqual(fromSettings.sources.map(entry => entry.id), ['sync-cloudsync-academic', 'extra'])
  assert.equal(fromSettings.sources[0].from, 'selection')
  assert.equal(fromSettings.sources[1].from, 'settings')
  assert.equal(fromSettings.syncConfig, '/sync/config.json')
  assert.equal(fromSettings.rejectedSettings, false)

  const badText = await sources.list({ external_sources: 'not json' })
  assert.deepEqual(badText.sources, [])
  assert.equal(badText.rejectedSettings, true)

  const deploymentWins = createExternalSources({ config: resolveConfig({ library: '/tmp/library', syncConfig: '/sync/config.json' }), ...fakeFileSystem(files) })
  const overridden = await deploymentWins.list({ sync_config: '/sync/other.json', external_sources: '[{"id":"sync-zotero-attachments"}]' })
  assert.equal(overridden.syncConfig, '/sync/other.json')
  assert.equal(overridden.sources.length, 0)
})

test('source tools carry deployment roots and ignore any root in their arguments', async () => {
  const files = { '/sync/config.json': { body: JSON.stringify(serviceConfig), mtime: 1 } }
  const sources = createExternalSources({ config: resolveConfig({ library: '/tmp/library', syncConfig: '/sync/config.json' }), ...fakeFileSystem(files) })
  const preferences = { external_sources: '[{"select":"all"}]' }
  const statusSpec = TOOL_SPECS.find(spec => spec.name === 'library_sources')
  const scanSpec = TOOL_SPECS.find(spec => spec.name === 'library_sources_scan')
  assert.ok(statusSpec && scanSpec && SOURCE_TOOL_SPECS.every(spec => TOOL_SPECS.includes(spec)))
  assert.deepEqual(requestFromTool(statusSpec, { sources: [{ id: 'evil', root: '/etc' }], library: '/wrong' }, { agent: { session: { header: { cwd: '/tmp' } } } }), { action: 'external_status' })
  assert.deepEqual(requestFromTool(scanSpec, { operation: 'scan', limit: 5, source: 'sync-zotero-attachments', root: '/etc' }, { agent: { session: { header: { cwd: '/tmp' } } } }), { action: 'external_scan', operation: 'scan', limit: 5, source: 'sync-zotero-attachments' })

  const seen = []
  const dispatch = async (request, options) => {
    seen.push({ request, options })
    return { sources: [], warnings: ['from the service'] }
  }
  const { handleSourceRequest } = await import('../src/harness/external-sources.mjs')
  const scan = await handleSourceRequest(sources, scanSpec, { action: 'external_scan', operation: 'scan', limit: 3 }, dispatch, { library: '/tmp/library' }, undefined, preferences)
  assert.equal(seen[0].request.action, 'external_scan')
  assert.equal(seen[0].request.limit, 3)
  assert.deepEqual(seen[0].request.sources.map(entry => entry.root), ['/Users/example/Documents/academic/zotero-attanger', '/Users/example/ShiqiLocalStorage/CloudSync/Academic'])
  assert.equal(seen[0].options.library, '/tmp/library')
  assert.deepEqual(scan.warnings, ['from the service'])
  assert.equal(scan.configured, 2)

  const listed = await handleSourceRequest(sources, statusSpec, { action: 'external_status' }, dispatch, {}, undefined, { external_sources: '[{"id":"sync-zotero-attachments"}]' })
  assert.deepEqual(listed.offered.map(entry => entry.id), ['sync-cloudsync-academic'])
  assert.match(listed.offered_hint, /额外外部文献源/)

  const prune = await handleSourceRequest(sources, scanSpec, { action: 'external_scan', operation: 'prune', source: 'sync-cloudsync-academic' }, dispatch, {}, undefined, preferences)
  assert.equal(seen[2].request.action, 'external_prune')
  assert.equal(seen[2].request.source, 'sync-cloudsync-academic')
  assert.equal(prune.configured, 2)
})

test('the plugin loads with no sync service at all', async () => {
  const config = resolveConfig({ library: '/tmp/library' })
  assert.deepEqual(config.externalSources, [])
  const sources = createExternalSources({ config })
  const { sources: empty } = await sources.list()
  assert.deepEqual(empty, [])
})
