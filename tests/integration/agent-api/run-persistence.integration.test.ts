import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import { resetSystemState } from '../../helpers/db-reset'
import {
  createFixtureAgentRun,
  createFixtureProject,
  createFixtureUser,
} from '../../helpers/fixtures'
import { prisma } from '../../helpers/prisma'

function runData(userId: string, projectId: string, runFingerprint: string) {
  return {
    userId,
    projectId,
    sourceHash: `sha256:${'a'.repeat(64)}`,
    runFingerprint,
    inputKindHint: 'story',
    locale: 'zh',
    effectiveOptionsJson: JSON.stringify({ episodeCount: 1 }),
    ruleSetVersion: 'agent-rules-v1',
    ruleSetHash: `sha256:${'b'.repeat(64)}`,
    definitionHash: `sha256:${'c'.repeat(64)}`,
    episodeMapJson: JSON.stringify({ episodeIds: ['episode-1'] }),
  }
}

function longJson(kind: string) {
  return JSON.stringify({ kind, payload: 'x'.repeat(70_000) })
}

describe('AgentCreationRun persistence', () => {
  beforeEach(async () => {
    await resetSystemState()
  })

  afterAll(async () => {
    await prisma.$disconnect()
  })

  it('associates multiple runs with both the user and project', async () => {
    const user = await createFixtureUser()
    const project = await createFixtureProject(user.id)

    await createFixtureAgentRun(user.id, project.id, `sha256:${'1'.repeat(64)}`)
    await createFixtureAgentRun(user.id, project.id, `sha256:${'2'.repeat(64)}`)

    const persistedUser = await prisma.user.findUnique({
      where: { id: user.id },
      include: { agentCreationRuns: true },
    })
    const persistedProject = await prisma.project.findUnique({
      where: { id: project.id },
      include: { agentCreationRuns: true },
    })

    expect(persistedUser?.agentCreationRuns).toHaveLength(2)
    expect(persistedProject?.agentCreationRuns).toHaveLength(2)
  })

  it('enforces one run fingerprint per user and project', async () => {
    const user = await createFixtureUser()
    const project = await createFixtureProject(user.id)
    const data = runData(user.id, project.id, `sha256:${'3'.repeat(64)}`)

    await createFixtureAgentRun(user.id, project.id, data.runFingerprint)

    await expect(prisma.agentCreationRun.create({ data })).rejects.toMatchObject({
      code: 'P2002',
    })
  })

  it('cascades run deletion when its project is deleted', async () => {
    const user = await createFixtureUser()
    const project = await createFixtureProject(user.id)
    const run = await createFixtureAgentRun(
      user.id,
      project.id,
      `sha256:${'4'.repeat(64)}`,
    )

    await prisma.project.delete({ where: { id: project.id } })

    await expect(
      prisma.agentCreationRun.findUnique({ where: { id: run.id } }),
    ).resolves.toBeNull()
  })

  it('cascades run deletion when its user is deleted', async () => {
    const userA = await createFixtureUser()
    const userB = await createFixtureUser()
    const projectB = await createFixtureProject(userB.id)
    const run = await prisma.agentCreationRun.create({
      data: runData(userA.id, projectB.id, `sha256:${'5'.repeat(64)}`),
    })

    await prisma.user.delete({ where: { id: userA.id } })

    await expect(
      prisma.user.findUnique({ where: { id: userB.id } }),
    ).resolves.not.toBeNull()
    await expect(
      prisma.project.findUnique({ where: { id: projectB.id } }),
    ).resolves.not.toBeNull()
    await expect(
      prisma.agentCreationRun.findUnique({ where: { id: run.id } }),
    ).resolves.toBeNull()
  })

  it('round-trips long episode, asset, clip, storyboard, artifact, and receipt mappings', async () => {
    const user = await createFixtureUser()
    const project = await createFixtureProject(user.id)
    const mappings = {
      episodeMapJson: longJson('episode'),
      assetMapJson: longJson('asset'),
      clipMapJson: longJson('clip'),
      storyboardMapJson: longJson('storyboard'),
      artifactHashesJson: longJson('artifact'),
      receiptJson: longJson('receipt'),
    }

    const run = await prisma.agentCreationRun.create({
      data: {
        ...runData(user.id, project.id, `sha256:${'6'.repeat(64)}`),
        ...mappings,
      },
    })

    expect(run).toMatchObject(mappings)
  })

  it('allows the system reset helper to remove runs before projects and users', async () => {
    const user = await createFixtureUser()
    const project = await createFixtureProject(user.id)
    await createFixtureAgentRun(user.id, project.id, `sha256:${'7'.repeat(64)}`)

    await expect(resetSystemState()).resolves.toBeUndefined()

    await expect(prisma.agentCreationRun.count()).resolves.toBe(0)
    await expect(prisma.project.count()).resolves.toBe(0)
    await expect(prisma.user.count()).resolves.toBe(0)
  })
})
