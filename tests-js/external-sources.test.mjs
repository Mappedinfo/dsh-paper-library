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
  assert.throws(() => normalizeConfiguredSources([{ id: 'a', root: '/a' }, { id: 'a', root: '/b' }]), /duplicate/)
  assert.throws(() => normalizeConfiguredSources(Array.from({ length: 9 }, (_, index) => ({ id: `s${index}`, root: `/p${index}` }))), /at most 8/)
  const config = resolveConfig({ library: '/tmp/library', syncConfig: '/Users/example/.dsh/vault-sync/config.json', externalSources: [{ id: 'local', root: '/papers' }] })
  assert.equal(config.externalSources.length, 1)
  assert.equal(config.syncConfig, '/Users/example/.dsh/vault-sync/config.json')
  assert.equal(resolveConfig({ library: '/tmp/library' }).syncConfig, undefined)
  assert.throws(() => resolveConfig({ library: '/tmp/library', syncConfig: 'relative.json' }), /absolute/)
})

test('explicit and service sources merge without duplicating a folder', async () => {
  const files = { '/sync/config.json': { body: JSON.stringify(serviceConfig), mtime: 1 } }
  const sources = createExternalSources({ config: resolveConfig({ library: '/tmp/library', syncConfig: '/sync/config.json', externalSources: [{ id: 'local', root: '/papers' }] }), ...fakeFileSystem(files) })
  const listed = await sources.list()
  assert.deepEqual(listed.sources.map(entry => entry.id), ['local', 'sync-zotero-attachments', 'sync-cloudsync-academic'])
  assert.deepEqual(listed.warnings, [])

  const duplicated = createExternalSources({
    config: resolveConfig({ library: '/tmp/library', syncConfig: '/sync/config.json', externalSources: [{ id: 'sync-zotero-attachments', root: '/Users/example/Documents/academic/zotero-attanger' }] }),
    ...fakeFileSystem(files),
  })
  const merged = await duplicated.list()
  assert.deepEqual(merged.sources.map(entry => entry.id), ['sync-zotero-attachments', 'sync-cloudsync-academic'])
  assert.equal(merged.sources.filter(entry => entry.root.includes('zotero-attanger')).length, 1)

  const none = await createExternalSources({ config: resolveConfig({ library: '/tmp/library' }) }).list()
  assert.deepEqual(none.sources, [])
  assert.deepEqual(none.warnings, [])
  assert.equal(none.syncConfig, null)
})

test('live settings may name the sync service and add folders next to the deployment list', async () => {
  const files = { '/sync/config.json': { body: JSON.stringify(serviceConfig), mtime: 1 } }
  const sources = createExternalSources({ config: resolveConfig({ library: '/tmp/library' }), ...fakeFileSystem(files) })
  const fromSettings = await sources.list({ sync_config: '/sync/config.json', external_sources: '[{"id":"extra","root":"/Volumes/archive/papers"}]' })
  assert.deepEqual(fromSettings.sources.map(entry => entry.id), ['extra', 'sync-zotero-attachments', 'sync-cloudsync-academic'])
  assert.equal(fromSettings.sources[0].from, 'settings')
  assert.equal(fromSettings.syncConfig, '/sync/config.json')
  assert.equal(fromSettings.rejectedSettings, false)

  const badText = await sources.list({ external_sources: 'not json' })
  assert.deepEqual(badText.sources, [])
  assert.equal(badText.rejectedSettings, true)

  const deploymentWins = createExternalSources({ config: resolveConfig({ library: '/tmp/library', syncConfig: '/sync/config.json' }), ...fakeFileSystem(files) })
  const overridden = await deploymentWins.list({ sync_config: '/sync/other.json' })
  assert.equal(overridden.syncConfig, '/sync/other.json')
  assert.equal(overridden.sources.length, 0)
})

test('source tools carry deployment roots and ignore any root in their arguments', async () => {
  const files = { '/sync/config.json': { body: JSON.stringify(serviceConfig), mtime: 1 } }
  const sources = createExternalSources({ config: resolveConfig({ library: '/tmp/library', syncConfig: '/sync/config.json' }), ...fakeFileSystem(files) })
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
  const scan = await (await import('../src/harness/external-sources.mjs')).handleSourceRequest(sources, scanSpec, { action: 'external_scan', operation: 'scan', limit: 3 }, dispatch, { library: '/tmp/library' }, undefined)
  assert.equal(seen[0].request.action, 'external_scan')
  assert.equal(seen[0].request.limit, 3)
  assert.deepEqual(seen[0].request.sources.map(entry => entry.root), ['/Users/example/Documents/academic/zotero-attanger', '/Users/example/ShiqiLocalStorage/CloudSync/Academic'])
  assert.equal(seen[0].options.library, '/tmp/library')
  assert.deepEqual(scan.warnings, ['from the service'])
  assert.equal(scan.configured, 2)

  const prune = await (await import('../src/harness/external-sources.mjs')).handleSourceRequest(sources, scanSpec, { action: 'external_scan', operation: 'prune', source: 'sync-cloudsync-academic' }, dispatch, {}, undefined)
  assert.equal(seen[1].request.action, 'external_prune')
  assert.equal(seen[1].request.source, 'sync-cloudsync-academic')
  assert.equal(prune.configured, 2)
})

test('the plugin loads with no sync service at all', async () => {
  const config = resolveConfig({ library: '/tmp/library' })
  assert.deepEqual(config.externalSources, [])
  const sources = createExternalSources({ config })
  const { sources: empty } = await sources.list()
  assert.deepEqual(empty, [])
})
