import { beforeEach, describe, expect, it, vi } from 'vitest'

const redisCtorMock = vi.hoisted(() => vi.fn())

vi.mock('ioredis', () => {
  class MockRedis {
    on = vi.fn()

    constructor(...args: unknown[]) {
      redisCtorMock(...args)
    }
  }

  return {
    default: MockRedis,
  }
})

describe('createSubscriber', () => {
  beforeEach(() => {
    redisCtorMock.mockReset()
  })

  it('disables ready check for subscriber connections', async () => {
    const { createSubscriber } = await import('@/lib/redis')

    createSubscriber()

    expect(redisCtorMock).toHaveBeenCalledWith(
      expect.objectContaining({
        enableReadyCheck: false,
        maxRetriesPerRequest: null,
      }),
    )
  })
})
