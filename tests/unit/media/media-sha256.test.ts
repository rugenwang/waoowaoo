import { beforeEach, describe, expect, it, vi } from 'vitest'

const mediaModel = vi.hoisted(() => ({
  findUnique: vi.fn(),
  upsert: vi.fn(),
}))

vi.mock('@/lib/prisma', () => ({
  prisma: { mediaObject: mediaModel },
}))

import { ensureMediaObjectFromStorageKey } from '@/lib/media/service'

function row(overrides: Record<string, unknown> = {}) {
  return {
    id: 'media-1',
    publicId: 'public-1',
    storageKey: 'images/test.jpg',
    sha256: null,
    mimeType: null,
    sizeBytes: null,
    width: null,
    height: null,
    durationMs: null,
    updatedAt: new Date(0),
    ...overrides,
  }
}

describe('ensureMediaObjectFromStorageKey sha256 metadata', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('backfills complete metadata on an existing storage key', async () => {
    mediaModel.findUnique.mockResolvedValueOnce(row())
    mediaModel.upsert.mockResolvedValueOnce(row({
      sha256: `sha256:${'a'.repeat(64)}`,
      mimeType: 'image/jpeg',
      sizeBytes: BigInt(123),
      width: 10,
      height: 20,
    }))

    const result = await ensureMediaObjectFromStorageKey('images/test.jpg', {
      sha256: `sha256:${'a'.repeat(64)}`,
      mimeType: 'image/jpeg',
      sizeBytes: 123,
      width: 10,
      height: 20,
    })

    expect(result.sha256).toBe(`sha256:${'a'.repeat(64)}`)
    expect(mediaModel.upsert).toHaveBeenCalledWith(expect.objectContaining({
      update: expect.objectContaining({
        sha256: `sha256:${'a'.repeat(64)}`,
        mimeType: 'image/jpeg',
        sizeBytes: BigInt(123),
        width: 10,
        height: 20,
      }),
    }))
  })

  it('does not clear existing sha256 when callers omit it', async () => {
    mediaModel.findUnique.mockResolvedValueOnce(row({
      sha256: `sha256:${'b'.repeat(64)}`,
    }))

    const result = await ensureMediaObjectFromStorageKey('images/test.jpg')

    expect(result.sha256).toBe(`sha256:${'b'.repeat(64)}`)
    expect(mediaModel.upsert).not.toHaveBeenCalled()
  })
})
