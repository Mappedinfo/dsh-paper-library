import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'

/** Capture only plugin identifiers and a patch digest, never settings or credentials. */
export async function profileSnapshot(directory) {
  const manifest = JSON.parse(await readFile(join(directory, 'package.json'), 'utf8'))
  let patchSha = null
  try { patchSha = createHash('sha256').update(await readFile(join(directory, 'cordis.patch.yml'))).digest('hex') }
  catch (error) { if (error.code !== 'ENOENT') throw error }
  return { dependencies: manifest.dependencies ?? {}, bundles: manifest.dsh?.profile?.bundles ?? [], patchSha }
}

/** Verify one additive installation leaves pre-existing dependencies and user patch intact. */
export function verifyProfileInstall(before, after) {
  const id = '@mappedinfo/dsh-paper-library'
  if (!Object.hasOwn(after.dependencies, id) || after.bundles.filter(value => value === id).length !== 1) throw new Error('Paper Library dependency/bundle is not registered exactly once')
  if (before) {
    for (const [name, value] of Object.entries(before.dependencies)) {
      if (name !== id && after.dependencies[name] !== value) throw new Error(`Pre-existing dependency changed: ${name}`)
    }
    const retained = after.bundles.filter(value => value !== id)
    if (JSON.stringify(retained) !== JSON.stringify(before.bundles.filter(value => value !== id))) throw new Error('Pre-existing bundle order changed')
    if (before.patchSha !== after.patchSha) throw new Error('User profile patch changed during installation')
  }
  return { ok: true, plugin: id, plugins: Object.keys(after.dependencies), preservedUserPatch: before ? true : null }
}
