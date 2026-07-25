import { Prisma } from '@prisma/client'
import sharp from 'sharp'

import { sha256Prefixed } from '@/lib/agent-api/canonical-json'
import {
  RunStatusSchema,
  type RunStatus,
} from '@/lib/agent-api/contracts/common'
import type {
  UploadFields,
} from '@/lib/agent-api/contracts/upload'
import {
  buildAppearanceCandidateOwnerId,
  buildProjectedEntityId,
} from '@/lib/agent-api/entity-id'
import { AgentApiError } from '@/lib/agent-api/errors'
import {
  parseAssetMap,
  parseStoryboardMap,
  parseUploadReceipts,
  isCompletedUploadReceipt,
  isPendingUploadReceipt,
  serializeUploadReceipts,
  transitionRunStatus,
  type AssetMap,
  type StoryboardMap,
  type PendingUploadReceipt,
  type UploadReceipt,
  type UploadReceiptRecord,
  type UploadReceipts,
} from '@/lib/agent-api/run-state'
import { decodeImageUrlsFromDb } from '@/lib/contracts/image-urls-contract'
import { ensureMediaObjectFromStorageKey } from '@/lib/media/service'
import type { MediaRef } from '@/lib/media/types'
import { prisma } from '@/lib/prisma'
import { uploadObject } from '@/lib/storage'

const DEFAULT_UPLOAD_MAX_BYTES = 10 * 1024 * 1024
const DEFAULT_UPLOAD_MAX_PIXELS = 40_000_000
const UPLOAD_TRANSACTION_OPTIONS = {
  maxWait: 10_000,
  timeout: 30_000,
} as const
const SAFE_PATH_SEGMENT = /^[A-Za-z0-9][A-Za-z0-9._-]{0,199}$/
const ACTUAL_MIME_BY_FORMAT: Record<string, string> = {
  png: 'image/png',
  jpeg: 'image/jpeg',
  webp: 'image/webp',
}

type UploadTargetType = UploadFields['targetType']

const UPLOAD_RUN_SELECT = {
  id: true,
  userId: true,
  projectId: true,
  status: true,
  currentStage: true,
  assetMapJson: true,
  storyboardMapJson: true,
  receiptJson: true,
  project: { select: { userId: true } },
} satisfies Prisma.AgentCreationRunSelect

type UploadRun = Prisma.AgentCreationRunGetPayload<{
  select: typeof UPLOAD_RUN_SELECT
}>

type CharacterTarget = {
  kind: 'character-appearance'
  appearanceId: string
  actualIndex: number
  reused: boolean
  imageUrls: string[]
  imageUrl: string | null
}

type ImageAssetTarget = {
  kind: 'location-image' | 'prop-image'
  assetId: string
  imageId: string
  actualIndex: number
  reused: boolean
  imageUrl: string | null
}

type PanelFrameTarget = {
  kind: 'panel-frame'
  frameId: string
  frameIndex: number
  panelId: string
  panelImageUrl: string | null
  panelImageMediaId: string | null
}

type ResolvedUploadTarget =
  | CharacterTarget
  | ImageAssetTarget
  | PanelFrameTarget

type UploadDb = Pick<
  Prisma.TransactionClient,
  | 'characterAppearance'
  | 'locationImage'
  | 'novelPromotionLocation'
  | 'novelPromotionPanelFrame'
>

export type NormalizedUploadImage = {
  bytes: Buffer
  sha256: string
  mimeType: 'image/jpeg'
  sizeBytes: number
  width: number
  height: number
}

export type CommitGeneratedImageUploadInput = {
  userId: string
  runId: string
  fields: UploadFields
}

export type CommitGeneratedImageUploadResult = {
  runId: string
  targetType: UploadTargetType
  targetKey: string
  variantIndex: number
  contentSha256: string
  mediaId: string
  storageKey: string
  url: string
  reused: boolean
  panelImageUpdated?: boolean
}

type UploadIdentity = Pick<
  UploadReceiptRecord,
  'targetType' | 'targetKey' | 'variantIndex' | 'contentSha256'
>

function referenceInvalid(field: string): never {
  throw new AgentApiError('REFERENCE_INVALID', { field })
}

function internalState(field: string): never {
  throw new AgentApiError('AGENT_INTERNAL_ERROR', {
    details: { field },
  })
}

function parseRunStatus(value: string): RunStatus {
  const parsed = RunStatusSchema.safeParse(value)
  if (!parsed.success) internalState('status')
  return parsed.data
}

function assertUploadStatus(value: string): RunStatus {
  const status = parseRunStatus(value)
  if (status !== 'storyboards_committed' && status !== 'images_in_progress') {
    throw new AgentApiError('RUN_INCOMPLETE', {
      details: { status },
    })
  }
  return status
}

function assertRunOwner(run: UploadRun | null, userId: string): UploadRun {
  if (!run) throw new AgentApiError('AGENT_RESOURCE_NOT_FOUND')
  if (run.userId !== userId || run.project.userId !== userId) {
    throw new AgentApiError('AGENT_FORBIDDEN')
  }
  return run
}

function parseRunMappings(run: UploadRun): {
  assets: AssetMap
  storyboards: StoryboardMap
  receipts: UploadReceipts
} {
  if (!run.assetMapJson) internalState('assetMapJson')
  if (!run.storyboardMapJson) internalState('storyboardMapJson')
  if (!run.receiptJson) internalState('receiptJson')
  return {
    assets: parseAssetMap(run.assetMapJson),
    storyboards: parseStoryboardMap(run.storyboardMapJson),
    receipts: parseUploadReceipts(run.receiptJson),
  }
}

function receiptMatches(
  receipt: UploadReceiptRecord,
  identity: UploadIdentity,
): boolean {
  return receipt.targetType === identity.targetType
    && receipt.targetKey === identity.targetKey
    && receipt.variantIndex === identity.variantIndex
    && receipt.contentSha256 === identity.contentSha256
}

function findReceiptRecord(
  receipts: UploadReceipts,
  identity: UploadIdentity,
): UploadReceiptRecord | undefined {
  return receipts.find((receipt) => receiptMatches(receipt, identity))
}

function resultFromReceipt(
  runId: string,
  receipt: UploadReceipt,
  target: ResolvedUploadTarget,
): CommitGeneratedImageUploadResult {
  return {
    runId,
    ...receipt,
    reused: true,
    ...(target.kind === 'panel-frame'
      ? { panelImageUpdated: target.frameIndex === 0 }
      : {}),
  }
}

export function uploadReceiptIdentity(input: UploadIdentity): string {
  return [
    input.targetType,
    input.targetKey,
    String(input.variantIndex),
    input.contentSha256,
  ].join('\u0000')
}

function sortReceipts(receipts: UploadReceipts): UploadReceipts {
  return [...receipts].sort((left, right) => {
    const leftKey = uploadReceiptIdentity(left)
    const rightKey = uploadReceiptIdentity(right)
    return leftKey < rightKey ? -1 : leftKey > rightKey ? 1 : 0
  })
}

export function configuredUploadMaxBytes(): number {
  const raw = process.env.WAOO_AGENT_UPLOAD_MAX_BYTES
  if (raw === undefined || raw.trim() === '') return DEFAULT_UPLOAD_MAX_BYTES
  if (!/^[1-9]\d*$/.test(raw)) internalState('WAOO_AGENT_UPLOAD_MAX_BYTES')
  const value = Number(raw)
  if (!Number.isSafeInteger(value)) internalState('WAOO_AGENT_UPLOAD_MAX_BYTES')
  return value
}

export function configuredUploadMaxPixels(): number {
  const raw = process.env.WAOO_AGENT_UPLOAD_MAX_PIXELS
  if (raw === undefined || raw.trim() === '') return DEFAULT_UPLOAD_MAX_PIXELS
  if (!/^[1-9]\d*$/.test(raw)) internalState('WAOO_AGENT_UPLOAD_MAX_PIXELS')
  const value = Number(raw)
  if (!Number.isSafeInteger(value)) internalState('WAOO_AGENT_UPLOAD_MAX_PIXELS')
  return value
}

export function deterministicUploadStorageKey(input: {
  runId: string
  targetType: UploadTargetType
  targetKey: string
  variantIndex: number
  contentSha256: string
}): string {
  if (
    !SAFE_PATH_SEGMENT.test(input.runId)
    || !SAFE_PATH_SEGMENT.test(input.targetKey)
    || !Number.isSafeInteger(input.variantIndex)
    || input.variantIndex < 0
    || !/^sha256:[a-f0-9]{64}$/.test(input.contentSha256)
  ) {
    throw new AgentApiError('CONTRACT_INVALID')
  }
  return [
    'agent-runs',
    input.runId,
    input.targetType,
    input.targetKey,
    String(input.variantIndex),
    `${input.contentSha256.slice('sha256:'.length)}.jpg`,
  ].join('/')
}

export async function normalizeUploadImage(input: {
  raw: Buffer
  declaredMimeType: string
  contentSha256: string
  maxBytes: number
  maxPixels: number
}): Promise<NormalizedUploadImage> {
  if (input.raw.length > input.maxBytes) {
    throw new AgentApiError('UPLOAD_TOO_LARGE', { field: 'file' })
  }
  if (sha256Prefixed(input.raw) !== input.contentSha256) {
    throw new AgentApiError('ARTIFACT_HASH_MISMATCH', {
      field: 'contentSha256',
    })
  }

  let metadata: sharp.Metadata
  try {
    metadata = await sharp(input.raw, {
      limitInputPixels: false,
    }).metadata()
  } catch {
    throw new AgentApiError('UPLOAD_TYPE_UNSUPPORTED', { field: 'file' })
  }
  const actualMimeType = metadata.format
    ? ACTUAL_MIME_BY_FORMAT[metadata.format]
    : undefined
  if (!actualMimeType || actualMimeType !== input.declaredMimeType) {
    throw new AgentApiError('UPLOAD_TYPE_UNSUPPORTED', { field: 'file' })
  }
  if (
    !metadata.width
    || !metadata.height
    || metadata.width > Math.floor(input.maxPixels / metadata.height)
  ) {
    throw new AgentApiError('UPLOAD_TOO_LARGE', { field: 'file' })
  }

  try {
    const output = await sharp(input.raw, {
      limitInputPixels: input.maxPixels,
    })
      .rotate()
      .jpeg({ quality: 90, mozjpeg: true })
      .toBuffer({ resolveWithObject: true })
    if (!output.info.width || !output.info.height || output.data.length === 0) {
      throw new Error('empty normalized image')
    }
    return {
      bytes: output.data,
      sha256: sha256Prefixed(output.data),
      mimeType: 'image/jpeg',
      sizeBytes: output.data.length,
      width: output.info.width,
      height: output.info.height,
    }
  } catch {
    throw new AgentApiError('UPLOAD_TYPE_UNSUPPORTED', { field: 'file' })
  }
}

function findAppearanceMapping(
  assets: AssetMap,
  targetKey: string,
) {
  const matches = Object.values(assets.characters).flatMap(
    (character) => Object.values(character.appearances).filter(
      (appearance) => appearance.appearanceKey === targetKey,
    ),
  )
  if (matches.length !== 1) referenceInvalid('targetKey')
  return matches[0]
}

async function resolveUploadTarget(
  db: UploadDb,
  run: UploadRun,
  fields: Pick<UploadFields, 'targetType' | 'targetKey' | 'variantIndex'>,
  assets: AssetMap,
  storyboards: StoryboardMap,
): Promise<ResolvedUploadTarget> {
  if (fields.targetType === 'character-appearance') {
    if (fields.variantIndex !== 0) referenceInvalid('variantIndex')
    const mapped = findAppearanceMapping(assets, fields.targetKey)
    const slot = mapped.variantSlots['0']
    if (
      !slot
      || slot.entityId !== buildAppearanceCandidateOwnerId(
        run.id,
        fields.targetKey,
        0,
        slot.index,
      )
    ) {
      internalState('assetMapJson')
    }
    const appearance = await db.characterAppearance.findUnique({
      where: { id: mapped.appearanceId },
      select: {
        id: true,
        appearanceIndex: true,
        imageUrls: true,
        imageUrl: true,
        character: {
          select: {
            id: true,
            novelPromotionProject: {
              select: { projectId: true },
            },
          },
        },
      },
    })
    if (
      !appearance
      || appearance.appearanceIndex !== mapped.appearanceIndex
      || (
        !mapped.reused
        && mapped.appearanceId !== buildProjectedEntityId(
          run.id,
          'Appearance',
          fields.targetKey,
        )
      )
      || appearance.character.id !== Object.values(assets.characters).find(
        (character) => character.appearances[fields.targetKey],
      )?.characterId
      || appearance.character.novelPromotionProject.projectId !== run.projectId
    ) {
      referenceInvalid('targetKey')
    }
    let imageUrls: string[]
    try {
      imageUrls = decodeImageUrlsFromDb(
        appearance.imageUrls,
        'characterAppearance.imageUrls',
      )
    } catch {
      internalState('assetMapJson')
    }
    if (
      slot.index >= imageUrls.length
      || slot.index !== imageUrls.length - 1
    ) {
      internalState('assetMapJson')
    }
    return {
      kind: 'character-appearance',
      appearanceId: appearance.id,
      actualIndex: slot.index,
      reused: mapped.reused,
      imageUrls,
      imageUrl: appearance.imageUrl,
    }
  }

  if (
    fields.targetType === 'location-image'
    || fields.targetType === 'prop-image'
  ) {
    const collection = fields.targetType === 'location-image'
      ? assets.locations
      : assets.props
    const mapped = collection[fields.targetKey]
    const slot = mapped?.imageSlots[String(fields.variantIndex)]
    if (!mapped || !slot) referenceInvalid('variantIndex')
    if (
      slot.entityId !== buildProjectedEntityId(
        run.id,
        'LocationImage',
        `${fields.targetKey}:${fields.variantIndex}`,
      )
    ) {
      internalState('assetMapJson')
    }
    const image = await db.locationImage.findUnique({
      where: { id: slot.entityId },
      select: {
        id: true,
        imageIndex: true,
        imageUrl: true,
        location: {
          select: {
            id: true,
            assetKind: true,
            novelPromotionProject: {
              select: { projectId: true },
            },
          },
        },
      },
    })
    const expectedKind = fields.targetType === 'location-image'
      ? 'location'
      : 'prop'
    if (
      !image
      || image.id !== slot.entityId
      || image.imageIndex !== slot.index
      || image.location.id !== mapped.entityId
      || image.location.assetKind !== expectedKind
      || (
        !mapped.reused
        && mapped.entityId !== buildProjectedEntityId(
          run.id,
          expectedKind === 'location' ? 'Location' : 'Prop',
          fields.targetKey,
        )
      )
      || image.location.novelPromotionProject.projectId !== run.projectId
    ) {
      referenceInvalid('targetKey')
    }
    return {
      kind: fields.targetType,
      assetId: mapped.entityId,
      imageId: image.id,
      actualIndex: image.imageIndex,
      reused: mapped.reused,
      imageUrl: image.imageUrl,
    }
  }

  if (fields.variantIndex !== 0) referenceInvalid('variantIndex')
  const mappedFrame = storyboards.frames[fields.targetKey]
  if (!mappedFrame) referenceInvalid('targetKey')
  const mappedPanel = storyboards.panels[mappedFrame.panelKey]
  const mappedStoryboard = mappedPanel
    ? storyboards.storyboards[mappedPanel.storyboardKey]
    : undefined
  if (!mappedPanel || !mappedStoryboard) internalState('storyboardMapJson')
  if (
    mappedFrame.frameId !== buildProjectedEntityId(
      run.id,
      'Frame',
      fields.targetKey,
    )
    || mappedPanel.panelId !== buildProjectedEntityId(
      run.id,
      'Panel',
      mappedPanel.panelKey,
    )
    || mappedStoryboard.storyboardId !== buildProjectedEntityId(
      run.id,
      'Storyboard',
      mappedStoryboard.storyboardKey,
    )
  ) {
    internalState('storyboardMapJson')
  }
  const frame = await db.novelPromotionPanelFrame.findUnique({
    where: { id: mappedFrame.frameId },
    select: {
      id: true,
      frameIndex: true,
      panelId: true,
      panel: {
        select: {
          id: true,
          imageUrl: true,
          imageMediaId: true,
          storyboard: {
            select: {
              id: true,
              episode: {
                select: {
                  novelPromotionProject: {
                    select: { projectId: true },
                  },
                },
              },
            },
          },
        },
      },
    },
  })
  if (
    !frame
    || frame.id !== mappedFrame.frameId
    || frame.frameIndex !== mappedFrame.frameIndex
    || frame.panelId !== mappedPanel.panelId
    || frame.panel.storyboard.id !== mappedStoryboard.storyboardId
    || frame.panel.storyboard.episode.novelPromotionProject.projectId
      !== run.projectId
  ) {
    referenceInvalid('targetKey')
  }
  return {
    kind: 'panel-frame',
    frameId: frame.id,
    frameIndex: frame.frameIndex,
    panelId: frame.panelId,
    panelImageUrl: frame.panel.imageUrl,
    panelImageMediaId: frame.panel.imageMediaId,
  }
}

async function updateUploadTarget(
  tx: Prisma.TransactionClient,
  target: ResolvedUploadTarget,
  media: MediaRef,
  storageKey: string,
): Promise<boolean | undefined> {
  if (target.kind === 'character-appearance') {
    const nextUrls = [...target.imageUrls]
    nextUrls[target.actualIndex] = storageKey
    await tx.characterAppearance.update({
      where: { id: target.appearanceId },
      data: {
        previousImageUrls: JSON.stringify(target.imageUrls),
        imageUrls: JSON.stringify(nextUrls),
        ...(!target.reused && target.actualIndex === 0
          ? {
              previousImageUrl: target.imageUrl,
              imageUrl: storageKey,
              imageMediaId: media.id,
              selectedIndex: target.actualIndex,
            }
          : {}),
      },
    })
    return undefined
  }

  if (target.kind !== 'panel-frame') {
    await tx.locationImage.update({
      where: { id: target.imageId },
      data: {
        previousImageUrl: target.imageUrl,
        imageUrl: storageKey,
        imageMediaId: media.id,
        isSelected: !target.reused && target.actualIndex === 0,
      },
    })
    if (!target.reused && target.actualIndex === 0) {
      await tx.novelPromotionLocation.update({
        where: { id: target.assetId },
        data: { selectedImageId: target.imageId },
      })
    }
    return undefined
  }

  await tx.novelPromotionPanelFrame.update({
    where: { id: target.frameId },
    data: {
      imageUrl: storageKey,
      imageMediaId: media.id,
      generationStatus: 'completed',
      errorMessage: null,
    },
  })
  if (target.frameIndex === 0) {
    await tx.novelPromotionPanel.update({
      where: { id: target.panelId },
      data: {
        previousImageUrl: target.panelImageUrl,
        previousImageMediaId: target.panelImageMediaId,
        imageUrl: storageKey,
        imageMediaId: media.id,
        candidateImages: null,
      },
    })
  }
  return target.frameIndex === 0
}

async function loadValidatedTarget(
  db: UploadDb,
  run: UploadRun,
  fields: UploadFields,
) {
  assertUploadStatus(run.status)
  const mappings = parseRunMappings(run)
  const target = await resolveUploadTarget(
    db,
    run,
    fields,
    mappings.assets,
    mappings.storyboards,
  )
  return { ...mappings, target }
}

async function lockUploadRun(
  tx: Prisma.TransactionClient,
  input: Pick<CommitGeneratedImageUploadInput, 'userId' | 'runId' | 'fields'>,
) {
  await tx.$queryRaw(Prisma.sql`
    SELECT id FROM agent_creation_runs
    WHERE id = ${input.runId}
    FOR UPDATE
  `)
  const run = assertRunOwner(
    await tx.agentCreationRun.findUnique({
      where: { id: input.runId },
      select: UPLOAD_RUN_SELECT,
    }),
    input.userId,
  )
  const locked = await loadValidatedTarget(
    tx as unknown as UploadDb,
    run,
    input.fields,
  )
  return { run, locked }
}

type UploadReservationResult = {
  target: ResolvedUploadTarget
  completed?: UploadReceipt
}

async function reserveUploadReceipt(
  input: CommitGeneratedImageUploadInput,
  identity: UploadIdentity,
  storageKey: string,
): Promise<UploadReservationResult> {
  return prisma.$transaction(async (tx) => {
    const { run, locked } = await lockUploadRun(tx, input)
    const existing = findReceiptRecord(locked.receipts, identity)
    if (existing) {
      if (isCompletedUploadReceipt(existing)) {
        return { target: locked.target, completed: existing }
      }
      if (!isPendingUploadReceipt(existing) || existing.storageKey !== storageKey) {
        internalState('receiptJson')
      }
      return { target: locked.target }
    }
    if (locked.receipts.length >= 20_000) {
      throw new AgentApiError('AGENT_INTERNAL_ERROR', {
        message: 'Upload receipt limit reached',
        details: { maxReceipts: 20_000 },
      })
    }
    const pending: PendingUploadReceipt = {
      ...identity,
      status: 'pending',
      storageKey,
    }
    await tx.agentCreationRun.update({
      where: { id: run.id },
      data: {
        receiptJson: serializeUploadReceipts(
          sortReceipts([...locked.receipts, pending]),
        ),
      },
    })
    return { target: locked.target }
  }, UPLOAD_TRANSACTION_OPTIONS)
}

export async function commitGeneratedImageUpload(
  input: CommitGeneratedImageUploadInput,
): Promise<CommitGeneratedImageUploadResult> {
  const preflightRun = assertRunOwner(
    await prisma.agentCreationRun.findUnique({
      where: { id: input.runId },
      select: UPLOAD_RUN_SELECT,
    }),
    input.userId,
  )
  await loadValidatedTarget(
    prisma as unknown as UploadDb,
    preflightRun,
    input.fields,
  )
  const identity: UploadIdentity = {
    targetType: input.fields.targetType,
    targetKey: input.fields.targetKey,
    variantIndex: input.fields.variantIndex,
    contentSha256: input.fields.contentSha256,
  }

  if (input.fields.file.size > configuredUploadMaxBytes()) {
    throw new AgentApiError('UPLOAD_TOO_LARGE', { field: 'file' })
  }
  const raw = Buffer.from(await input.fields.file.arrayBuffer())
  if (raw.length !== input.fields.file.size) {
    throw new AgentApiError('CONTRACT_INVALID', { field: 'file.size' })
  }
  const normalized = await normalizeUploadImage({
    raw,
    declaredMimeType: input.fields.file.type,
    contentSha256: input.fields.contentSha256,
    maxBytes: configuredUploadMaxBytes(),
    maxPixels: configuredUploadMaxPixels(),
  })
  const storageKey = deterministicUploadStorageKey({
    runId: input.runId,
    ...identity,
  })
  const reservation = await reserveUploadReceipt(input, identity, storageKey)
  if (reservation.completed) {
    return resultFromReceipt(
      input.runId,
      reservation.completed,
      reservation.target,
    )
  }
  await uploadObject(normalized.bytes, storageKey, 1, normalized.mimeType)
  const media = await ensureMediaObjectFromStorageKey(storageKey, {
    sha256: normalized.sha256,
    mimeType: normalized.mimeType,
    sizeBytes: normalized.sizeBytes,
    width: normalized.width,
    height: normalized.height,
  })

  return prisma.$transaction(async (tx) => {
    const { run, locked } = await lockUploadRun(tx, input)
    const reserved = findReceiptRecord(locked.receipts, identity)
    if (reserved && isCompletedUploadReceipt(reserved)) {
      return resultFromReceipt(input.runId, reserved, locked.target)
    }
    if (
      !reserved
      || !isPendingUploadReceipt(reserved)
      || reserved.storageKey !== storageKey
    ) {
      internalState('receiptJson')
    }

    const panelImageUpdated = await updateUploadTarget(
      tx,
      locked.target,
      media,
      storageKey,
    )
    const receipt: UploadReceipt = {
      ...identity,
      mediaId: media.id,
      storageKey,
      url: media.url,
    }
    const receipts = sortReceipts(locked.receipts.map((entry) => (
      receiptMatches(entry, identity) ? receipt : entry
    )))
    const status = parseRunStatus(run.status)
    const nextStatus = status === 'storyboards_committed'
      ? transitionRunStatus(status, run.currentStage, 'images_in_progress')
      : status
    await tx.agentCreationRun.update({
      where: { id: run.id },
      data: {
        receiptJson: serializeUploadReceipts(receipts),
        status: nextStatus,
        currentStage: 'images_in_progress',
      },
    })
    return {
      runId: run.id,
      ...receipt,
      reused: false,
      ...(panelImageUpdated !== undefined ? { panelImageUpdated } : {}),
    }
  }, UPLOAD_TRANSACTION_OPTIONS)
}
