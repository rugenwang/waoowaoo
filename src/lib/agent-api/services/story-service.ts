import { Prisma } from '@prisma/client'

import { hashArtifact } from '@/lib/agent-api/canonical-json'
import {
  RunStatusSchema,
  type RunStatus,
} from '@/lib/agent-api/contracts/common'
import type { StoryCommitRequest } from '@/lib/agent-api/contracts/story'
import { AgentApiError } from '@/lib/agent-api/errors'
import {
  assertRunAcceptsArtifact,
  parseArtifactHashes,
  parseEpisodeMap,
  serializeArtifactHashes,
  serializeEpisodeMap,
  transitionRunStatus,
} from '@/lib/agent-api/run-state'
import { prisma } from '@/lib/prisma'

const STORY_RUN_SELECT = {
  id: true,
  userId: true,
  projectId: true,
  ruleSetVersion: true,
  ruleSetHash: true,
  definitionHash: true,
  status: true,
  currentStage: true,
  episodeMapJson: true,
  artifactHashesJson: true,
  project: {
    select: { userId: true },
  },
} satisfies Prisma.AgentCreationRunSelect

export type CommitStoryArtifactInput = {
  userId: string
  runId: string
  episodeKey: string
  request: StoryCommitRequest
}

export type CommitStoryArtifactResult = {
  dryRun: boolean
  episodeKey: string
  episodeId: string
  episodeNumber: number
  artifactHash: string
}

function parseRunStatus(value: string): RunStatus {
  const parsed = RunStatusSchema.safeParse(value)
  if (!parsed.success) {
    throw new AgentApiError('AGENT_INTERNAL_ERROR', {
      details: { field: 'status' },
    })
  }
  return parsed.data
}

export async function commitStoryArtifact(
  input: CommitStoryArtifactInput,
): Promise<CommitStoryArtifactResult> {
  return prisma.$transaction(async (tx) => {
    await tx.$queryRaw(Prisma.sql`
      SELECT id FROM agent_creation_runs
      WHERE id = ${input.runId}
      FOR UPDATE
    `)

    const run = await tx.agentCreationRun.findUnique({
      where: { id: input.runId },
      select: STORY_RUN_SELECT,
    })
    if (!run) throw new AgentApiError('AGENT_RESOURCE_NOT_FOUND')
    if (
      run.userId !== input.userId
      || run.project.userId !== input.userId
    ) {
      throw new AgentApiError('AGENT_FORBIDDEN')
    }
    const runStatus = parseRunStatus(run.status)
    assertRunAcceptsArtifact(runStatus)

    if (
      run.ruleSetVersion !== input.request.ruleSetVersion
      || run.ruleSetHash !== input.request.ruleSetHash
    ) {
      throw new AgentApiError('RULESET_MISMATCH')
    }
    if (hashArtifact(input.request.data) !== input.request.artifactHash) {
      throw new AgentApiError('ARTIFACT_HASH_MISMATCH', {
        field: 'artifactHash',
      })
    }

    const episodes = parseEpisodeMap(run.episodeMapJson)
    const definitions = Object.values(episodes)
      .sort((left, right) => left.ordinal - right.ordinal)
      .map((entry) => ({
        episodeKey: entry.episodeKey,
        ordinal: entry.ordinal,
        sourceHash: entry.sourceHash,
        name: entry.name,
        ...(entry.description !== undefined
          ? { description: entry.description }
          : {}),
      }))
    if (hashArtifact(definitions) !== run.definitionHash) {
      throw new AgentApiError('AGENT_INTERNAL_ERROR', {
        details: { field: 'definitionHash' },
      })
    }
    const episode = episodes[input.episodeKey]
    if (
      !episode
      || input.request.data.episodeKey !== input.episodeKey
      || input.request.data.sourceHash !== episode.sourceHash
      || input.request.data.name !== episode.name
    ) {
      throw new AgentApiError('REFERENCE_INVALID')
    }

    const episodeRow = await tx.novelPromotionEpisode.findUnique({
      where: { id: episode.episodeId },
      select: {
        id: true,
        episodeNumber: true,
        name: true,
        novelPromotionProject: {
          select: { projectId: true },
        },
      },
    })
    if (
      !episodeRow
      || episodeRow.episodeNumber !== episode.episodeNumber
      || episodeRow.name !== episode.name
      || episodeRow.novelPromotionProject.projectId !== run.projectId
    ) {
      throw new AgentApiError('REFERENCE_INVALID')
    }

    const artifactHashes = parseArtifactHashes(run.artifactHashesJson ?? '')
    const existingHash = artifactHashes.stories[input.episodeKey]
    if (
      existingHash !== undefined
      && existingHash !== input.request.artifactHash
    ) {
      throw new AgentApiError('RUN_DEFINITION_CONFLICT', {
        field: 'artifactHash',
      })
    }

    const receipt = {
      dryRun: input.request.dryRun,
      episodeKey: input.episodeKey,
      episodeId: episode.episodeId,
      episodeNumber: episode.episodeNumber,
      artifactHash: input.request.artifactHash,
    }
    if (input.request.dryRun || existingHash !== undefined) return receipt

    await tx.novelPromotionEpisode.update({
      where: { id: episode.episodeId },
      data: {
        description: input.request.data.description ?? null,
        novelText: input.request.data.novelText,
      },
    })

    episodes[input.episodeKey] = {
      ...episode,
      status: 'story_committed',
    }
    artifactHashes.stories[input.episodeKey] = input.request.artifactHash
    const committedCount = Object.values(episodes).filter(
      (entry) => entry.status === 'story_committed',
    ).length
    const allCommitted = committedCount === Object.keys(episodes).length
    const status = allCommitted
      ? transitionRunStatus(runStatus, run.currentStage, 'story_committed')
      : runStatus

    await tx.agentCreationRun.update({
      where: { id: run.id },
      data: {
        episodeMapJson: serializeEpisodeMap(episodes),
        artifactHashesJson: serializeArtifactHashes(artifactHashes),
        status,
        currentStage: allCommitted
          ? 'story_committed'
          : `story_committing:${committedCount}/${Object.keys(episodes).length}`,
      },
    })

    return receipt
  })
}
