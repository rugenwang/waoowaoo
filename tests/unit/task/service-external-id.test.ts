import { beforeEach, describe, expect, it, vi } from 'vitest'

const updateManyMock = vi.hoisted(() => vi.fn())

vi.mock('@/lib/prisma', () => ({
  prisma: {
    task: {
      updateMany: updateManyMock,
      findUnique: vi.fn(),
    },
  },
}))

vi.mock('@/i18n/routing', () => ({
  locales: ['zh', 'en'],
}))

vi.mock('@/lib/billing', () => ({
  rollbackTaskBilling: vi.fn(),
}))

import { tryMarkTaskProcessing } from '@/lib/task/service'

describe('task service externalId preservation', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    updateManyMock.mockResolvedValue({ count: 1 })
  })

  it('preserves an existing externalId when marking a retry as processing', async () => {
    await expect(tryMarkTaskProcessing('task-1')).resolves.toBe(true)

    const data = updateManyMock.mock.calls[0][0].data
    expect(data).not.toHaveProperty('externalId')
    expect(data.status).toBe('processing')
    expect(data.attempt).toEqual({ increment: 1 })
  })

  it('only updates externalId when the caller explicitly passes it', async () => {
    await expect(tryMarkTaskProcessing('task-1', 'LOCAL:VIDEO:bG9jYWw:vid_1')).resolves.toBe(true)
    expect(updateManyMock.mock.calls[0][0].data.externalId).toBe('LOCAL:VIDEO:bG9jYWw:vid_1')

    await expect(tryMarkTaskProcessing('task-1', null)).resolves.toBe(true)
    expect(updateManyMock.mock.calls[1][0].data.externalId).toBeNull()
  })
})
