import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { profileSnapshot, verifyProfileInstall } from '../src/harness/profile-audit.mjs'

const [home, profile, beforePath] = process.argv.slice(2)
if (!home || !profile) throw new Error('Usage: node scripts/verify-harness-install.mjs DSH_HOME PROFILE [BEFORE_JSON]')
const before = beforePath ? JSON.parse(await readFile(beforePath, 'utf8')) : undefined
console.log(JSON.stringify(verifyProfileInstall(before, await profileSnapshot(join(home, 'profiles', profile)))))
