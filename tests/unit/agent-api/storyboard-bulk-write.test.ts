import type { Prisma } from '@prisma/client'
import { describe, expect, it, vi } from 'vitest'

import { AgentApiError } from '@/lib/agent-api/errors'
import {
  createFrameRows,
  updateClipShotCounts,
  type FrameCreate,
} from '@/lib/agent-api/storyboard-bulk-write'

function frame(index: number): FrameCreate {
  return {
    id: `frame-${index}`,
    panelId: 'panel-1',
    frameIndex: index,
    frameTimeSec: index,
    frameRole: index === 0 ? 'hero' : 'detail',
    dependencyFrameIds: index === 0 ? null : `[${index - 1}]`,
    imagePrompt: `image-${index}`,
    videoPrompt: `video-${index}`,
    promptJson: `{"frameIndex":${index}}`,
    referencePolicy: '{"orderedReferences":[]}',
    createdAt: new Date(index),
  }
}

describe('storyboard bulk writes', () => {
  it('chunks frame inserts and verifies the aggregate affected count', async () => {
    const createMany = vi.fn(async ({ data }: { data: FrameCreate[] }) => ({
      count: data.length,
    }))
    const tx = {
      novelPromotionPanelFrame: { createMany },
    } as unknown as Prisma.TransactionClient

    await createFrameRows(
      tx,
      Array.from({ length: 501 }, (_, index) => frame(index)),
    )
    expect(createMany).toHaveBeenCalledTimes(2)
    expect(createMany.mock.calls.map(([argument]) => argument.data.length))
      .toEqual([500, 1])
  })

  it('fails atomically when a bulk insert reports a short count', async () => {
    const tx = {
      novelPromotionPanelFrame: {
        createMany: vi.fn(async () => ({ count: 0 })),
      },
    } as unknown as Prisma.TransactionClient

    await expect(createFrameRows(tx, [frame(0)])).rejects.toEqual(
      expect.objectContaining<Partial<AgentApiError>>({
        code: 'AGENT_INTERNAL_ERROR',
        details: expect.objectContaining({
          operation: 'frame_bulk_create',
        }),
      }),
    )
  })

  it('uses bounded CASE batches for clip shot-count updates', async () => {
    const executeRaw = vi.fn(async () => 250)
      .mockResolvedValueOnce(250)
      .mockResolvedValueOnce(1)
    const tx = {
      $executeRaw: executeRaw,
    } as unknown as Prisma.TransactionClient

    await updateClipShotCounts(
      tx,
      Array.from({ length: 251 }, (_, index) => ({
        id: `clip-${index}`,
        shotCount: index,
      })),
    )
    expect(executeRaw).toHaveBeenCalledTimes(2)
  })
})
