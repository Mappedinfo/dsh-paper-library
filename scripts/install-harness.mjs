import { spawnSync } from 'node:child_process'
import { access, lstat, mkdir, readFile, realpath, symlink } from 'node:fs/promises'
import { constants } from 'node:fs'
import { dirname, isAbsolute, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { profileSnapshot, verifyProfileInstall } from '../src/harness/profile-audit.mjs'

const project = dirname(dirname(fileURLToPath(import.meta.url)))
const parsed = {}
for (let i = 2; i < process.argv.length; i += 2) {
  const option = process.argv[i]
  const value = process.argv[i + 1]
  if (!['--harness', '--home', '--profile'].includes(option) || !value) throw new Error('Usage: node scripts/install-harness.mjs [--harness ABSOLUTE_CHECKOUT] [--home ISOLATED_DSH_HOME] [--profile NAME]')
  parsed[option.slice(2)] = value
}
const harness = resolve(parsed.harness ?? process.env.DSH_CHECKOUT ?? join(project, '../../deepseek-ai/deepseek-harness'))
const home = resolve(parsed.home ?? join(project, '.local/harness'))
const profile = parsed.profile ?? 'paper-library'
if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]*$/.test(profile)) throw new Error('Invalid profile name')
if (!isAbsolute(home) || !isAbsolute(harness)) throw new Error('Use absolute installation paths')
const cli = join(harness, 'apps/cli/lib/bin.js')
await access(cli, constants.R_OK)

// A link: package resolves ESM imports beside its source. Link only declared
// runtime peers to the exact checkout, without installing stale registry peers.
for (const [name, relative] of [
  ['@deepseek-ai/dsh-tools', 'packages/core/tools'],
  ['@deepseek-ai/dsh-llm', 'packages/llm/llm'],
  ['@deepseek-ai/dsh-home-paths', 'packages/util/home-paths'],
  ['@deepseek-ai/dsh-atomic-write', 'packages/util/atomic-write'],
]) {
  const target = join(harness, relative)
  const link = join(project, 'node_modules', name)
  await access(join(target, 'lib/index.js'), constants.R_OK)
  await mkdir(dirname(link), { recursive: true })
  try {
    const existing = await lstat(link)
    if (!existing.isSymbolicLink() || await realpath(link) !== await realpath(target)) throw new Error(`Existing peer ${name} differs; preserve it and choose a clean plugin checkout`)
  } catch (error) {
    if (error.code !== 'ENOENT') throw error
    await symlink(target, link, 'dir')
  }
}

const environment = { ...process.env, DSH_HOME: home }
const run = (args, quiet = false) => {
  const result = spawnSync(process.execPath, [cli, ...args], { cwd: project, env: environment, stdio: quiet ? 'pipe' : 'inherit', encoding: 'utf8' })
  if (result.error) throw result.error
  if (result.status !== 0) throw new Error(`Harness command failed with status ${result.status}${quiet ? `: ${result.stderr}` : ''}`)
}
try { await access(join(home, 'profiles', profile, 'package.json')) }
catch (error) {
  if (error.code !== 'ENOENT') throw error
  run(['--profile', profile, '--from-default-profile', 'web', '--dump-config'], true)
}
const before = await profileSnapshot(join(home, 'profiles', profile))
run(['plugin', '--profile', profile, 'add', `link:${project}`, '--ignore-scripts', '--config.autoInstallPeers=false'])
const manifest = JSON.parse(await readFile(join(home, 'profiles', profile, 'package.json'), 'utf8'))
if (!manifest.dsh?.profile?.bundles?.includes('@mappedinfo/dsh-paper-library')) throw new Error('Profile did not register the Paper Library bundle')
console.log(JSON.stringify(verifyProfileInstall(before, await profileSnapshot(join(home, 'profiles', profile)))))
const quote = value => `'${value.replaceAll("'", "'\\''")}'`
console.log(`Installed Paper Library in ${home}, profile ${profile}.`)
console.log(`Launch: DSH_HOME=${quote(home)} ${quote(process.execPath)} ${quote(cli)} --profile ${quote(profile)} --port 3091 --no-open`)
