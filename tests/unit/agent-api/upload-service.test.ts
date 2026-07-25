import sharp from 'sharp'
import { describe, expect, it } from 'vitest'

import { sha256Prefixed } from '@/lib/agent-api/canonical-json'
import {
  deterministicUploadStorageKey,
  normalizeUploadImage,
  uploadReceiptIdentity,
} from '@/lib/agent-api/services/upload-service'

async function png(): Promise<Buffer> {
  return sharp({
    create: {
      width: 4,
      height: 3,
      channels: 3,
      background: '#ff0000',
    },
  }).png().toBuffer()
}

describe('upload image preparation', () => {
  it('normalizes allowed raw image bytes to deterministic JPEG metadata', async () => {
    const raw = await png()
    const normalized = await normalizeUploadImage({
      raw,
      declaredMimeType: 'image/png',
      contentSha256: sha256Prefixed(raw),
      maxBytes: raw.length,
      maxPixels: 100,
    })

    expect(normalized.mimeType).toBe('image/jpeg')
    expect(normalized.width).toBe(4)
    expect(normalized.height).toBe(3)
    expect(normalized.sizeBytes).toBe(normalized.bytes.length)
    expect(normalized.sha256).toBe(sha256Prefixed(normalized.bytes))
    expect(normalized.sha256).not.toBe(sha256Prefixed(raw))
  })

  it('rejects forged MIME, corrupt bytes, a raw hash mismatch, and oversize input', async () => {
    const raw = await png()
    await expect(normalizeUploadImage({
      raw,
      declaredMimeType: 'image/jpeg',
      contentSha256: sha256Prefixed(raw),
      maxBytes: raw.length,
      maxPixels: 100,
    })).rejects.toMatchObject({ code: 'UPLOAD_TYPE_UNSUPPORTED' })
    await expect(normalizeUploadImage({
      raw: Buffer.from('not-an-image'),
      declaredMimeType: 'image/png',
      contentSha256: sha256Prefixed(Buffer.from('not-an-image')),
      maxBytes: 100,
      maxPixels: 100,
    })).rejects.toMatchObject({ code: 'UPLOAD_TYPE_UNSUPPORTED' })
    await expect(normalizeUploadImage({
      raw,
      declaredMimeType: 'image/png',
      contentSha256: `sha256:${'0'.repeat(64)}`,
      maxBytes: raw.length,
      maxPixels: 100,
    })).rejects.toMatchObject({ code: 'ARTIFACT_HASH_MISMATCH' })
    await expect(normalizeUploadImage({
      raw,
      declaredMimeType: 'image/png',
      contentSha256: sha256Prefixed(raw),
      maxBytes: raw.length - 1,
      maxPixels: 100,
    })).rejects.toMatchObject({ code: 'UPLOAD_TOO_LARGE' })
  })

  it('rejects compressed images whose decoded dimensions exceed the pixel limit', async () => {
    const raw = await png()
    await expect(normalizeUploadImage({
      raw,
      declaredMimeType: 'image/png',
      contentSha256: sha256Prefixed(raw),
      maxBytes: raw.length,
      maxPixels: 11,
    })).rejects.toMatchObject({
      code: 'UPLOAD_TOO_LARGE',
      field: 'file',
    })
  })

  it('builds a safe deterministic key and a strict four-part receipt identity', () => {
    const hash = `sha256:${'a'.repeat(64)}`
    expect(deterministicUploadStorageKey({
      runId: 'run-1',
      targetType: 'panel-frame',
      targetKey: 'frame-001',
      variantIndex: 0,
      contentSha256: hash,
    })).toBe(`agent-runs/run-1/panel-frame/frame-001/0/${'a'.repeat(64)}.jpg`)
    expect(uploadReceiptIdentity({
      targetType: 'panel-frame',
      targetKey: 'frame-001',
      variantIndex: 0,
      contentSha256: hash,
    })).not.toBe(uploadReceiptIdentity({
      targetType: 'panel-frame',
      targetKey: 'frame-001',
      variantIndex: 1,
      contentSha256: hash,
    }))
  })
})
