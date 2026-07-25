import { Prisma } from '@prisma/client'
import { z } from 'zod'

import {
  buildRunFingerprint,
  hashArtifact,
} from '@/lib/agent-api/canonical-json'
import {
  IdSchema,
  InputKindHintSchema,
  LocaleSchema,
  RuleSetVersionSchema,
  RunStatusSchema,
  Sha256Schema,
  trimmedTextSchema,
  type RunStatus,
} from '@/lib/agent-api/contracts/common'
import type { CreateRunRequest } from '@/lib/agent-api/contracts/run'
import { AgentApiError } from '@/lib/agent-api/errors'
import {
  loadCreatorRuleBundle,
} from '@/lib/agent-api/rules/load-rule-bundle'
import {
  parseArtifactHashes,
  parseAssetMap,
  parseClipMap,
  parseEffectiveOptions,
  parseEpisodeMap,
  parseStoryboardMap,
  parseUploadReceipts,
  serializeArtifactHashes,
  serializeAssetMap,
  serializeClipMap,
  serializeEffectiveOptions,
  serializeEpisodeMap,
  serializeStoryboardMap,
  serializeUploadReceipts,
  type EpisodeMap,
} from '@/lib/agent-api/run-state'
import { prisma } from '@/lib/prisma'

const RUN_SELECT = {
  id: true,
  userId: true,
  projectId: true,
  sourceHash: true,
  runFingerprint: true,
  inputKindHint: true,
  locale: true,
  effectiveOptionsJson: true,
  ruleSetVersion: true,
  ruleSetHash: true,
  definitionHash: true,
  status: true,
  currentStage: true,
  episodeMapJson: true,
  assetMapJson: true,
  clipMapJson: true,
  storyboardMapJson: true,
  artifactHashesJson: true,
  receiptJson: true,
  project: {
    select: { userId: true },
  },
} satisfies Prisma.AgentCreationRunSelect

type StoredRun = Prisma.AgentCreationRunGetPayload<{
  select: typeof RUN_SELECT
}>

export type CreateOrResumeRunInput = {
  userId: string
  projectId: string
  request: CreateRunRequest
}

export type CreateOrResumeRunResult = {
  runId: string
  resumed: boolean
  status: RunStatus
  projectId: string
  sourceHash: string
  runFingerprint: string
  episodes: Array<{
    episodeKey: string
    episodeId: string
    episodeNumber: number
    name: string
  }>
}

export type CreatorRunResult = {
  runId: string
  projectId: string
  status: RunStatus
  currentStage: string
  sourceHash: string
  runFingerprint: string
  ruleSetVersion: string
  ruleSetHash: string
  episodes: Array<{
    episodeKey: string
    episodeId: string
    episodeNumber: number
    status: RunStatus
  }>
}

function internalInvalid(field: string): never {
  throw new AgentApiError('AGENT_INTERNAL_ERROR', {
    details: { field },
  })
}

function parsePersisted<T>(
  schema: z.ZodType<T>,
  value: unknown,
  field: string,
): T {
  const result = schema.safeParse(value)
  if (!result.success) return internalInvalid(field)
  return result.data
}

function decodeRun(run: StoredRun) {
  const decoded = {
    id: parsePersisted(IdSchema, run.id, 'id'),
    projectId: parsePersisted(IdSchema, run.projectId, 'projectId'),
    inputKindHint: parsePersisted(
      InputKindHintSchema,
      run.inputKindHint,
      'inputKindHint',
    ),
    locale: parsePersisted(LocaleSchema, run.locale, 'locale'),
    sourceHash: parsePersisted(Sha256Schema, run.sourceHash, 'sourceHash'),
    runFingerprint: parsePersisted(
      Sha256Schema,
      run.runFingerprint,
      'runFingerprint',
    ),
    ruleSetVersion: parsePersisted(
      RuleSetVersionSchema,
      run.ruleSetVersion,
      'ruleSetVersion',
    ),
    ruleSetHash: parsePersisted(
      Sha256Schema,
      run.ruleSetHash,
      'ruleSetHash',
    ),
    definitionHash: parsePersisted(
      Sha256Schema,
      run.definitionHash,
      'definitionHash',
    ),
    status: parsePersisted(RunStatusSchema, run.status, 'status'),
    currentStage: parsePersisted(
      trimmedTextSchema(100),
      run.currentStage,
      'currentStage',
    ),
    effectiveOptions: parseEffectiveOptions(run.effectiveOptionsJson),
    episodes: parseEpisodeMap(run.episodeMapJson),
  }

  if (run.assetMapJson !== null) parseAssetMap(run.assetMapJson)
  if (run.clipMapJson !== null) parseClipMap(run.clipMapJson)
  if (run.storyboardMapJson !== null) {
    parseStoryboardMap(run.storyboardMapJson)
  }
  if (run.artifactHashesJson !== null) {
    parseArtifactHashes(run.artifactHashesJson)
  }
  if (run.receiptJson !== null) parseUploadReceipts(run.receiptJson)

  const expectedFingerprint = buildRunFingerprint({
    projectId: decoded.projectId,
    sourceHash: decoded.sourceHash,
    inputKindHint: decoded.inputKindHint,
    locale: decoded.locale,
    effectiveOptions: decoded.effectiveOptions,
    ruleSetHash: decoded.ruleSetHash,
  })
  if (expectedFingerprint !== decoded.runFingerprint) {
    return internalInvalid('runFingerprint')
  }

  const definitions = orderedEpisodes(decoded.episodes).map((episode) => ({
    episodeKey: episode.episodeKey,
    ordinal: episode.ordinal,
    sourceHash: episode.sourceHash,
    name: episode.name,
    ...(episode.description !== undefined
      ? { description: episode.description }
      : {}),
  }))
  if (hashArtifact(definitions) !== decoded.definitionHash) {
    return internalInvalid('definitionHash')
  }
  return decoded
}

function orderedEpisodes(episodeMap: EpisodeMap) {
  return Object.values(episodeMap).sort(
    (left, right) => left.ordinal - right.ordinal,
  )
}

function createResponse(
  run: StoredRun,
  resumed: boolean,
): CreateOrResumeRunResult {
  const decoded = decodeRun(run)
  return {
    runId: decoded.id,
    resumed,
    status: decoded.status,
    projectId: decoded.projectId,
    sourceHash: decoded.sourceHash,
    runFingerprint: decoded.runFingerprint,
    episodes: orderedEpisodes(decoded.episodes).map((episode) => ({
      episodeKey: episode.episodeKey,
      episodeId: episode.episodeId,
      episodeNumber: episode.episodeNumber,
      name: episode.name,
    })),
  }
}

function validateRequestHashes(
  projectId: string,
  request: CreateRunRequest,
): void {
  const definitionHash = hashArtifact(request.episodes)
  if (request.definitionHash !== definitionHash) {
    throw new AgentApiError('ARTIFACT_HASH_MISMATCH', {
      field: 'definitionHash',
    })
  }

  const runFingerprint = buildRunFingerprint({
    projectId,
    sourceHash: request.sourceHash,
    inputKindHint: request.inputKindHint,
    locale: request.locale,
    effectiveOptions: request.effectiveOptions,
    ruleSetHash: request.ruleSetHash,
  })
  if (request.runFingerprint !== runFingerprint) {
    throw new AgentApiError('ARTIFACT_HASH_MISMATCH', {
      field: 'runFingerprint',
    })
  }
}

function validateFixedRun(
  run: StoredRun,
  input: CreateOrResumeRunInput,
): CreateOrResumeRunResult {
  if (
    run.userId !== input.userId
    || run.projectId !== input.projectId
    || run.project.userId !== input.userId
  ) {
    throw new AgentApiError('AGENT_FORBIDDEN')
  }
  const storedRuleSetVersion = parsePersisted(
    RuleSetVersionSchema,
    run.ruleSetVersion,
    'ruleSetVersion',
  )
  const storedRuleSetHash = parsePersisted(
    Sha256Schema,
    run.ruleSetHash,
    'ruleSetHash',
  )
  if (
    storedRuleSetVersion !== input.request.ruleSetVersion
    || storedRuleSetHash !== input.request.ruleSetHash
  ) {
    throw new AgentApiError('RULESET_MISMATCH')
  }
  const storedDefinitionHash = parsePersisted(
    Sha256Schema,
    run.definitionHash,
    'definitionHash',
  )
  if (storedDefinitionHash !== input.request.definitionHash) {
    throw new AgentApiError('RUN_DEFINITION_CONFLICT')
  }
  const decoded = decodeRun(run)
  if (
    decoded.sourceHash !== input.request.sourceHash
    || decoded.runFingerprint !== input.request.runFingerprint
  ) {
    return internalInvalid('runFingerprint')
  }
  return createResponse(run, true)
}

async function requireServiceProject(
  userId: string,
  projectId: string,
): Promise<void> {
  const project = await prisma.project.findUnique({
    where: { id: projectId },
    select: {
      id: true,
      userId: true,
      novelPromotionData: {
        select: { id: true },
      },
    },
  })
  if (!project) throw new AgentApiError('AGENT_RESOURCE_NOT_FOUND')
  if (project.userId !== userId) throw new AgentApiError('AGENT_FORBIDDEN')
  if (!project.novelPromotionData) {
    throw new AgentApiError('AGENT_RESOURCE_NOT_FOUND')
  }
}

function uniqueRunWhere(input: CreateOrResumeRunInput) {
  return {
    userId_projectId_runFingerprint: {
      userId: input.userId,
      projectId: input.projectId,
      runFingerprint: input.request.runFingerprint,
    },
  }
}

async function findExistingRun(
  input: CreateOrResumeRunInput,
): Promise<StoredRun | null> {
  return prisma.agentCreationRun.findUnique({
    where: uniqueRunWhere(input),
    select: RUN_SELECT,
  })
}

function validateRules(
  request: CreateRunRequest,
  rules: {
    ruleSetVersion: string
    contentHash: string
  },
): void {
  if (
    rules.ruleSetVersion !== request.ruleSetVersion
    || rules.contentHash !== request.ruleSetHash
  ) {
    throw new AgentApiError('RULESET_MISMATCH')
  }
}

function isEpisodeNumberConflict(error: unknown): boolean {
  if (!error || typeof error !== 'object' || !('code' in error)) return false
  if ((error as { code?: unknown }).code !== 'P2002') return false
  const meta = (error as {
    meta?: { modelName?: unknown; target?: unknown }
  }).meta
  if (meta?.modelName !== 'NovelPromotionEpisode') return false

  const target = meta.target
  if (Array.isArray(target)) {
    return target.length === 2
      && target.includes('novelPromotionProjectId')
      && target.includes('episodeNumber')
  }
  return target
    === 'novel_promotion_episodes_novelPromotionProjectId_episodeNumber_key'
    || target
    === 'novel_promotion_episodes_novelPromotionProjectId_episodeNumb_key'
}

async function createInTransaction(
  input: CreateOrResumeRunInput,
  beforeLockRules: {
    ruleSetVersion: string
    contentHash: string
  },
): Promise<CreateOrResumeRunResult> {
  return prisma.$transaction(async (tx) => {
    await tx.$queryRaw(Prisma.sql`
      SELECT id FROM novel_promotion_projects
      WHERE projectId = ${input.projectId}
      FOR UPDATE
    `)

    const project = await tx.project.findUnique({
      where: { id: input.projectId },
      select: {
        id: true,
        userId: true,
        novelPromotionData: {
          select: { id: true },
        },
      },
    })
    if (!project || !project.novelPromotionData) {
      throw new AgentApiError('AGENT_RESOURCE_NOT_FOUND')
    }
    if (project.userId !== input.userId) {
      throw new AgentApiError('AGENT_FORBIDDEN')
    }

    const existing = await tx.agentCreationRun.findUnique({
      where: uniqueRunWhere(input),
      select: RUN_SELECT,
    })
    if (existing) return validateFixedRun(existing, input)

    const afterLockRules = await loadCreatorRuleBundle({
      projectId: input.projectId,
      locale: input.request.locale,
    })
    validateRules(input.request, beforeLockRules)
    validateRules(input.request, afterLockRules)
    if (
      afterLockRules.ruleSetVersion !== beforeLockRules.ruleSetVersion
      || afterLockRules.contentHash !== beforeLockRules.contentHash
    ) {
      throw new AgentApiError('RULESET_MISMATCH')
    }

    const maximum = await tx.novelPromotionEpisode.aggregate({
      where: {
        novelPromotionProjectId: project.novelPromotionData.id,
      },
      _max: { episodeNumber: true },
    })
    const firstEpisodeNumber = (maximum._max.episodeNumber ?? 0) + 1
    const episodeMap: EpisodeMap = {}

    for (const definition of input.request.episodes) {
      const episodeNumber = firstEpisodeNumber + definition.ordinal - 1
      const episode = await tx.novelPromotionEpisode.create({
        data: {
          novelPromotionProjectId: project.novelPromotionData.id,
          episodeNumber,
          name: definition.name,
          description: definition.description ?? null,
          novelText: null,
        },
        select: {
          id: true,
          episodeNumber: true,
          name: true,
        },
      })
      episodeMap[definition.episodeKey] = {
        episodeKey: definition.episodeKey,
        episodeId: episode.id,
        episodeNumber: episode.episodeNumber,
        ordinal: definition.ordinal,
        sourceHash: definition.sourceHash,
        name: episode.name,
        ...(definition.description !== undefined
          ? { description: definition.description }
          : {}),
        status: 'created',
      }
    }

    const run = await tx.agentCreationRun.create({
      data: {
        userId: input.userId,
        projectId: input.projectId,
        sourceHash: input.request.sourceHash,
        runFingerprint: input.request.runFingerprint,
        inputKindHint: input.request.inputKindHint,
        locale: input.request.locale,
        effectiveOptionsJson: serializeEffectiveOptions(
          input.request.effectiveOptions,
        ),
        ruleSetVersion: input.request.ruleSetVersion,
        ruleSetHash: input.request.ruleSetHash,
        definitionHash: input.request.definitionHash,
        status: 'created',
        currentStage: 'created',
        episodeMapJson: serializeEpisodeMap(episodeMap),
        assetMapJson: serializeAssetMap({
          characters: {},
          locations: {},
          props: {},
        }),
        clipMapJson: serializeClipMap({}),
        storyboardMapJson: serializeStoryboardMap({
          storyboards: {},
          panels: {},
          frames: {},
        }),
        artifactHashesJson: serializeArtifactHashes({
          stories: {},
          screenplays: {},
          storyboards: {},
        }),
        receiptJson: serializeUploadReceipts([]),
      },
      select: RUN_SELECT,
    })

    const lastEpisode = orderedEpisodes(episodeMap).at(-1)
    if (!lastEpisode) return internalInvalid('episodeMapJson')
    await tx.novelPromotionProject.update({
      where: { projectId: input.projectId },
      data: { lastEpisodeId: lastEpisode.episodeId },
    })
    return createResponse(run, false)
  })
}

export async function createOrResumeRun(
  input: CreateOrResumeRunInput,
): Promise<CreateOrResumeRunResult> {
  validateRequestHashes(input.projectId, input.request)
  await requireServiceProject(input.userId, input.projectId)

  const existing = await findExistingRun(input)
  if (existing) return validateFixedRun(existing, input)

  for (let attempt = 0; attempt < 2; attempt += 1) {
    const currentRules = await loadCreatorRuleBundle({
      projectId: input.projectId,
      locale: input.request.locale,
    })
    validateRules(input.request, currentRules)

    try {
      return await createInTransaction(input, currentRules)
    } catch (error) {
      if (!isEpisodeNumberConflict(error)) throw error
      if (attempt === 1) {
        throw new AgentApiError('EPISODE_NUMBER_CONFLICT', {
          retryable: true,
        })
      }
    }
  }
  return internalInvalid('episodeNumber')
}

export async function getCreatorRun(input: {
  userId: string
  runId: string
}): Promise<CreatorRunResult> {
  const run = await prisma.agentCreationRun.findUnique({
    where: { id: input.runId },
    select: RUN_SELECT,
  })
  if (!run) throw new AgentApiError('AGENT_RESOURCE_NOT_FOUND')
  if (
    run.userId !== input.userId
    || run.project.userId !== input.userId
  ) {
    throw new AgentApiError('AGENT_FORBIDDEN')
  }

  const decoded = decodeRun(run)
  return {
    runId: decoded.id,
    projectId: decoded.projectId,
    status: decoded.status,
    currentStage: decoded.currentStage,
    sourceHash: decoded.sourceHash,
    runFingerprint: decoded.runFingerprint,
    ruleSetVersion: decoded.ruleSetVersion,
    ruleSetHash: decoded.ruleSetHash,
    episodes: orderedEpisodes(decoded.episodes).map((episode) => ({
      episodeKey: episode.episodeKey,
      episodeId: episode.episodeId,
      episodeNumber: episode.episodeNumber,
      status: episode.status,
    })),
  }
}
