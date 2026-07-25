import { describe, expect, it } from 'vitest'

import {
  isCompletedUploadReceipt,
  isPendingUploadReceipt,
  parseUploadReceipts,
  serializeUploadReceipts,
} from '@/lib/agent-api/run-state'

const HASH = `sha256:${'a'.repeat(64)}`

describe('upload receipt persistence records', () => {
  it('keeps legacy completed receipts compatible and recognizes pending reservations', () => {
    const completed = {
      targetType: 'panel-frame' as const,
      targetKey: 'frame-001',
      variantIndex: 0,
      contentSha256: HASH,
      mediaId: 'media-1',
      storageKey: 'agent-runs/run-1/panel-frame/frame-001/0/a.jpg',
      url: '/m/media-1',
    }
    const pending = {
      targetType: 'location-image' as const,
      targetKey: 'location-001',
      variantIndex: 0,
      contentSha256: HASH,
      status: 'pending' as const,
      storageKey: 'agent-runs/run-1/location-image/location-001/0/a.jpg',
    }

    const parsed = parseUploadReceipts(serializeUploadReceipts([
      completed,
      pending,
    ]))
    expect(isCompletedUploadReceipt(parsed[0])).toBe(true)
    expect(isPendingUploadReceipt(parsed[0])).toBe(false)
    expect(isPendingUploadReceipt(parsed[1])).toBe(true)
    expect(isCompletedUploadReceipt(parsed[1])).toBe(false)
  })

  it('rejects duplicate pending/completed identities as corrupt persisted state', () => {
    const identity = {
      targetType: 'panel-frame' as const,
      targetKey: 'frame-001',
      variantIndex: 0,
      contentSha256: HASH,
    }
    expect(() => serializeUploadReceipts([
      {
        ...identity,
        status: 'pending' as const,
        storageKey: 'agent-runs/run-1/panel-frame/frame-001/0/a.jpg',
      },
      {
        ...identity,
        mediaId: 'media-1',
        storageKey: 'agent-runs/run-1/panel-frame/frame-001/0/a.jpg',
        url: '/m/media-1',
      },
    ])).toThrow()
  })
})
