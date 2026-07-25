import { Prisma } from '@prisma/client'

import { AgentApiError } from '@/lib/agent-api/errors'

const STORYBOARD_CHUNK_SIZE = 100
const PANEL_CHUNK_SIZE = 250
const FRAME_CHUNK_SIZE = 500

export type StoryboardWrite = {
  id: string
  panelCount: number
  storyboardTextJson: string
  photographyPlan: string
}

export type StoryboardCreate = StoryboardWrite & {
  episodeId: string
  clipId: string
  createdAt: Date
}

export type PanelWrite = {
  id: string
  panelIndex: number
  panelNumber: number
  shotType: string
  cameraMove: string
  description: string
  location: string | null
  characters: string
  props: string
  srtSegment: string
  duration: number
  panelMode: string
  groupDurationSec: number | null
  groupVideoPrompt: string | null
  groupPlanJson: string | null
  imagePrompt: string
  videoPrompt: string
  sceneType: string
  photographyRules: string | null
  actingNotes: string | null
  usePreviousPanelTailAsReference: boolean
}

export type PanelCreate = PanelWrite & {
  storyboardId: string
  createdAt: Date
}

export type FrameWrite = {
  id: string
  frameIndex: number
  frameTimeSec: number
  frameRole: string
  dependencyFrameIds: string | null
  imagePrompt: string
  videoPrompt: string
  promptJson: string
  referencePolicy: string
}

export type FrameCreate = FrameWrite & {
  panelId: string
  createdAt: Date
}

export type ClipShotCountWrite = {
  id: string
  shotCount: number
}

function mismatch(operation: string): never {
  throw new AgentApiError('AGENT_INTERNAL_ERROR', {
    details: { field: 'storyboardMapJson', operation },
  })
}

async function createChunks<T>(
  rows: T[],
  chunkSize: number,
  create: (chunk: T[]) => Promise<{ count: number }>,
  operation: string,
): Promise<void> {
  let count = 0
  for (let offset = 0; offset < rows.length; offset += chunkSize) {
    const chunk = rows.slice(offset, offset + chunkSize)
    count += (await create(chunk)).count
  }
  if (count !== rows.length) mismatch(operation)
}

function caseExpression<T>(
  rows: T[],
  id: (row: T) => string,
  value: (row: T) => string | number | boolean | null,
  column: string,
): Prisma.Sql {
  return Prisma.sql`
    CASE id
      ${Prisma.join(
        rows.map((row) => Prisma.sql`WHEN ${id(row)} THEN ${value(row)}`),
        ' ',
      )}
      ELSE ${Prisma.raw(`\`${column}\``)}
    END
  `
}

function updatedAtExpression(): Prisma.Sql {
  return Prisma.sql`CASE
    WHEN updatedAt >= CURRENT_TIMESTAMP(3)
      THEN DATE_ADD(updatedAt, INTERVAL 1000 MICROSECOND)
    ELSE CURRENT_TIMESTAMP(3)
  END`
}

async function executeChunks<T>(
  tx: Prisma.TransactionClient,
  rows: T[],
  chunkSize: number,
  statement: (chunk: T[]) => Prisma.Sql,
  operation: string,
): Promise<void> {
  let count = 0
  for (let offset = 0; offset < rows.length; offset += chunkSize) {
    count += await tx.$executeRaw(statement(rows.slice(
      offset,
      offset + chunkSize,
    )))
  }
  if (count !== rows.length) mismatch(operation)
}

export async function createStoryboardRows(
  tx: Prisma.TransactionClient,
  rows: StoryboardCreate[],
): Promise<void> {
  await createChunks(
    rows,
    STORYBOARD_CHUNK_SIZE,
    (data) => tx.novelPromotionStoryboard.createMany({ data }),
    'storyboard_bulk_create',
  )
}

export async function createPanelRows(
  tx: Prisma.TransactionClient,
  rows: PanelCreate[],
): Promise<void> {
  await createChunks(
    rows,
    PANEL_CHUNK_SIZE,
    (data) => tx.novelPromotionPanel.createMany({ data }),
    'panel_bulk_create',
  )
}

export async function createFrameRows(
  tx: Prisma.TransactionClient,
  rows: FrameCreate[],
): Promise<void> {
  await createChunks(
    rows,
    FRAME_CHUNK_SIZE,
    (data) => tx.novelPromotionPanelFrame.createMany({ data }),
    'frame_bulk_create',
  )
}

export async function updateStoryboardRows(
  tx: Prisma.TransactionClient,
  rows: StoryboardWrite[],
): Promise<void> {
  await executeChunks(
    tx,
    rows,
    STORYBOARD_CHUNK_SIZE,
    (chunk) => Prisma.sql`
      UPDATE novel_promotion_storyboards
      SET
        panelCount = ${caseExpression(chunk, (row) => row.id, (row) => row.panelCount, 'panelCount')},
        storyboardTextJson = ${caseExpression(chunk, (row) => row.id, (row) => row.storyboardTextJson, 'storyboardTextJson')},
        photographyPlan = ${caseExpression(chunk, (row) => row.id, (row) => row.photographyPlan, 'photographyPlan')},
        updatedAt = ${updatedAtExpression()}
      WHERE id IN (${Prisma.join(chunk.map((row) => row.id))})
    `,
    'storyboard_bulk_update',
  )
}

export async function updatePanelRows(
  tx: Prisma.TransactionClient,
  rows: PanelWrite[],
): Promise<void> {
  await executeChunks(
    tx,
    rows,
    PANEL_CHUNK_SIZE,
    (chunk) => Prisma.sql`
      UPDATE novel_promotion_panels
      SET
        panelIndex = ${caseExpression(chunk, (row) => row.id, (row) => row.panelIndex, 'panelIndex')},
        panelNumber = ${caseExpression(chunk, (row) => row.id, (row) => row.panelNumber, 'panelNumber')},
        shotType = ${caseExpression(chunk, (row) => row.id, (row) => row.shotType, 'shotType')},
        cameraMove = ${caseExpression(chunk, (row) => row.id, (row) => row.cameraMove, 'cameraMove')},
        description = ${caseExpression(chunk, (row) => row.id, (row) => row.description, 'description')},
        location = ${caseExpression(chunk, (row) => row.id, (row) => row.location, 'location')},
        characters = ${caseExpression(chunk, (row) => row.id, (row) => row.characters, 'characters')},
        props = ${caseExpression(chunk, (row) => row.id, (row) => row.props, 'props')},
        srtSegment = ${caseExpression(chunk, (row) => row.id, (row) => row.srtSegment, 'srtSegment')},
        duration = ${caseExpression(chunk, (row) => row.id, (row) => row.duration, 'duration')},
        panelMode = ${caseExpression(chunk, (row) => row.id, (row) => row.panelMode, 'panelMode')},
        groupDurationSec = ${caseExpression(chunk, (row) => row.id, (row) => row.groupDurationSec, 'groupDurationSec')},
        groupVideoPrompt = ${caseExpression(chunk, (row) => row.id, (row) => row.groupVideoPrompt, 'groupVideoPrompt')},
        groupPlanJson = ${caseExpression(chunk, (row) => row.id, (row) => row.groupPlanJson, 'groupPlanJson')},
        imagePrompt = ${caseExpression(chunk, (row) => row.id, (row) => row.imagePrompt, 'imagePrompt')},
        videoPrompt = ${caseExpression(chunk, (row) => row.id, (row) => row.videoPrompt, 'videoPrompt')},
        sceneType = ${caseExpression(chunk, (row) => row.id, (row) => row.sceneType, 'sceneType')},
        photographyRules = ${caseExpression(chunk, (row) => row.id, (row) => row.photographyRules, 'photographyRules')},
        actingNotes = ${caseExpression(chunk, (row) => row.id, (row) => row.actingNotes, 'actingNotes')},
        usePreviousPanelTailAsReference = ${caseExpression(chunk, (row) => row.id, (row) => row.usePreviousPanelTailAsReference, 'usePreviousPanelTailAsReference')},
        updatedAt = ${updatedAtExpression()}
      WHERE id IN (${Prisma.join(chunk.map((row) => row.id))})
    `,
    'panel_bulk_update',
  )
}

export async function updateFrameRows(
  tx: Prisma.TransactionClient,
  rows: FrameWrite[],
): Promise<void> {
  await executeChunks(
    tx,
    rows,
    FRAME_CHUNK_SIZE,
    (chunk) => Prisma.sql`
      UPDATE novel_promotion_panel_frames
      SET
        frameIndex = ${caseExpression(chunk, (row) => row.id, (row) => row.frameIndex, 'frameIndex')},
        frameTimeSec = ${caseExpression(chunk, (row) => row.id, (row) => row.frameTimeSec, 'frameTimeSec')},
        frameRole = ${caseExpression(chunk, (row) => row.id, (row) => row.frameRole, 'frameRole')},
        dependencyFrameIds = ${caseExpression(chunk, (row) => row.id, (row) => row.dependencyFrameIds, 'dependencyFrameIds')},
        imagePrompt = ${caseExpression(chunk, (row) => row.id, (row) => row.imagePrompt, 'imagePrompt')},
        videoPrompt = ${caseExpression(chunk, (row) => row.id, (row) => row.videoPrompt, 'videoPrompt')},
        promptJson = ${caseExpression(chunk, (row) => row.id, (row) => row.promptJson, 'promptJson')},
        referencePolicy = ${caseExpression(chunk, (row) => row.id, (row) => row.referencePolicy, 'referencePolicy')},
        updatedAt = ${updatedAtExpression()}
      WHERE id IN (${Prisma.join(chunk.map((row) => row.id))})
    `,
    'frame_bulk_update',
  )
}

export async function updateClipShotCounts(
  tx: Prisma.TransactionClient,
  rows: ClipShotCountWrite[],
): Promise<void> {
  await executeChunks(
    tx,
    rows,
    PANEL_CHUNK_SIZE,
    (chunk) => Prisma.sql`
      UPDATE novel_promotion_clips
      SET
        shotCount = ${caseExpression(chunk, (row) => row.id, (row) => row.shotCount, 'shotCount')},
        updatedAt = ${updatedAtExpression()}
      WHERE id IN (${Prisma.join(chunk.map((row) => row.id))})
    `,
    'clip_shot_count_bulk_update',
  )
}
