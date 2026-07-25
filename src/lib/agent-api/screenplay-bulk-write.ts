import { Prisma } from '@prisma/client'

import { AgentApiError } from '@/lib/agent-api/errors'

const UPDATE_CHUNK_SIZE = 100

export type ScreenplayClipWrite = {
  id: string
  summary: string
  location: string | null
  content: string
  characters: string
  props: string
  startText: string
  endText: string
  screenplay: string
}

export type ScreenplayClipCreate = ScreenplayClipWrite & {
  episodeId: string
  createdAt: Date
}

function countMismatch(operation: string): never {
  throw new AgentApiError('AGENT_INTERNAL_ERROR', {
    details: {
      field: 'clipMapJson',
      operation,
    },
  })
}

export async function createScreenplayClipsInBulk(
  tx: Prisma.TransactionClient,
  rows: ScreenplayClipCreate[],
): Promise<void> {
  if (rows.length === 0) return
  const result = await tx.novelPromotionClip.createMany({ data: rows })
  if (result.count !== rows.length) countMismatch('clip_bulk_create')
}

function caseExpression(
  rows: ScreenplayClipWrite[],
  value: (row: ScreenplayClipWrite) => string | null,
  column: string,
): Prisma.Sql {
  return Prisma.sql`
    CASE id
      ${Prisma.join(
        rows.map((row) => Prisma.sql`WHEN ${row.id} THEN ${value(row)}`),
        ' ',
      )}
      ELSE ${Prisma.raw(`\`${column}\``)}
    END
  `
}

function updateStatement(rows: ScreenplayClipWrite[]): Prisma.Sql {
  return Prisma.sql`
    UPDATE novel_promotion_clips
    SET
      summary = ${caseExpression(rows, (row) => row.summary, 'summary')},
      location = ${caseExpression(rows, (row) => row.location, 'location')},
      content = ${caseExpression(rows, (row) => row.content, 'content')},
      characters = ${caseExpression(rows, (row) => row.characters, 'characters')},
      props = ${caseExpression(rows, (row) => row.props, 'props')},
      startText = ${caseExpression(rows, (row) => row.startText, 'startText')},
      endText = ${caseExpression(rows, (row) => row.endText, 'endText')},
      screenplay = ${caseExpression(rows, (row) => row.screenplay, 'screenplay')},
      updatedAt = CASE
        WHEN updatedAt >= CURRENT_TIMESTAMP(3)
          THEN DATE_ADD(updatedAt, INTERVAL 1000 MICROSECOND)
        ELSE CURRENT_TIMESTAMP(3)
      END
    WHERE id IN (${Prisma.join(rows.map((row) => row.id))})
  `
}

export async function updateScreenplayClipsInBulk(
  tx: Prisma.TransactionClient,
  rows: ScreenplayClipWrite[],
): Promise<void> {
  let updatedCount = 0
  for (let offset = 0; offset < rows.length; offset += UPDATE_CHUNK_SIZE) {
    const chunk = rows.slice(offset, offset + UPDATE_CHUNK_SIZE)
    updatedCount += await tx.$executeRaw(updateStatement(chunk))
  }
  if (updatedCount !== rows.length) countMismatch('clip_bulk_update')
}
