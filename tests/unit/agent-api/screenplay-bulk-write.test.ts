import type { Prisma } from '@prisma/client'
import { describe, expect, it, vi } from 'vitest'

import {
  createScreenplayClipsInBulk,
  updateScreenplayClipsInBulk,
  type ScreenplayClipCreate,
} from '@/lib/agent-api/screenplay-bulk-write'

function clip(index: number): ScreenplayClipCreate {
  return {
    id: `clip-${index}`,
    episodeId: 'episode-1',
    summary: `summary-${index}`,
    location: index % 2 === 0 ? '场景' : null,
    content: `content-${index}`,
    characters: JSON.stringify(['林晓']),
    props: JSON.stringify(['发夹']),
    startText: `start-${index}`,
    endText: `end-${index}`,
    screenplay: JSON.stringify({ scenes: [], marker: index }),
    createdAt: new Date(1_700_000_000_000 + index),
  }
}

function transaction() {
  return {
    novelPromotionClip: {
      createMany: vi.fn(),
      create: vi.fn(),
      update: vi.fn(),
    },
    $executeRaw: vi.fn(),
  }
}

describe('screenplay bulk persistence', () => {
  it('creates 1000 stable Clip rows with exactly one createMany call', async () => {
    const tx = transaction()
    const rows = Array.from({ length: 1_000 }, (_, index) => clip(index))
    tx.novelPromotionClip.createMany.mockResolvedValue({ count: rows.length })

    await createScreenplayClipsInBulk(
      tx as unknown as Prisma.TransactionClient,
      rows,
    )

    expect(tx.novelPromotionClip.createMany).toHaveBeenCalledTimes(1)
    expect(tx.novelPromotionClip.createMany).toHaveBeenCalledWith({
      data: rows,
    })
    expect(tx.novelPromotionClip.create).not.toHaveBeenCalled()
  })

  it('updates heterogeneous rows in parameterized chunks without touching id or createdAt', async () => {
    const tx = transaction()
    const rows = Array.from({ length: 205 }, (_, index) => ({
      ...clip(index),
      content: index === 0 ? `unsafe ' ${'${raw}'}` : `updated-${index}`,
    }))
    tx.$executeRaw
      .mockResolvedValueOnce(100)
      .mockResolvedValueOnce(100)
      .mockResolvedValueOnce(5)

    await updateScreenplayClipsInBulk(
      tx as unknown as Prisma.TransactionClient,
      rows,
    )

    expect(tx.$executeRaw).toHaveBeenCalledTimes(3)
    expect(tx.novelPromotionClip.update).not.toHaveBeenCalled()
    const firstStatement = tx.$executeRaw.mock.calls[0][0] as {
      sql: string
      values: unknown[]
    }
    expect(firstStatement.sql).not.toContain(`unsafe '`)
    expect(firstStatement.values).toContain(`unsafe ' ${'${raw}'}`)
    expect(firstStatement.sql).not.toMatch(/\bcreatedAt\s*=/)
    expect(firstStatement.sql).not.toMatch(/\bid\s*=/)
    expect(firstStatement.sql).toMatch(/\bupdatedAt\s*=/)
  })

  it('rejects partial create or update counts so the transaction can roll back', async () => {
    const createTx = transaction()
    createTx.novelPromotionClip.createMany.mockResolvedValue({ count: 1 })
    await expect(createScreenplayClipsInBulk(
      createTx as unknown as Prisma.TransactionClient,
      [clip(0), clip(1)],
    )).rejects.toMatchObject({
      code: 'AGENT_INTERNAL_ERROR',
    })

    const updateTx = transaction()
    updateTx.$executeRaw.mockResolvedValue(1)
    await expect(updateScreenplayClipsInBulk(
      updateTx as unknown as Prisma.TransactionClient,
      [clip(0), clip(1)],
    )).rejects.toMatchObject({
      code: 'AGENT_INTERNAL_ERROR',
    })
  })
})
