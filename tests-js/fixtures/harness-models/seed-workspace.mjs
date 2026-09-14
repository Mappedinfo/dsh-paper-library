import { mkdir, realpath } from 'node:fs/promises'
import { resolve, join } from 'node:path'

export const name = 'paper-library-harness-workspace-fixture'
export const inject = ['workspaceRegistry', 'sessionController']
export const fixtureHome = '/private/tmp/dsh-paper-library-model-follow'

/** Prepare only this fixture's temporary workspace through the public Host services. */
export async function seedWorkspace(ctx, home = process.env.DSH_HOME) {
  if (!home || resolve(home) !== fixtureHome) throw new Error(`Selection fixture requires DSH_HOME=${fixtureHome}`)
  await mkdir(fixtureHome, { recursive: true })
  if (await realpath(fixtureHome) !== fixtureHome) throw new Error('Selection fixture home must not be a symlink')
  const workspacePath = join(fixtureHome, 'workspace')
  await mkdir(workspacePath, { recursive: true })
  if (await realpath(workspacePath) !== workspacePath) throw new Error('Selection fixture workspace must not be a symlink')
  const workspace = await ctx.workspaceRegistry.create(workspacePath, 'Paper Library Model QA')
  const session = await ctx.sessionController.create({ workspaceId: workspace.id, sessionId: 'paper-library-model-follow-qa' })
  return { workspaceId: workspace.id, sessionId: session.sessionId }
}

export async function apply(ctx) {
  await seedWorkspace(ctx)
}
