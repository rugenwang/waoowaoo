import { describe, expect, it, vi } from 'vitest'

import {
  buildBoundedMissingState,
  buildRelationCountIndex,
  loadInStableIdChunks,
  stableIdChunks,
  visitStableIdChunks,
} from '@/lib/agent-api/services/integrity-scan'

describe('integrity scan scaling helpers', () => {
  it('deduplicates and stably chunks more than 65,535 ids for reads and locks', async () => {
    const unique = Array.from(
      { length: 70_000 },
      (_, index) => `id-${String(index).padStart(6, '0')}`,
    )
    const input = [...unique].reverse().flatMap((id) => [id, id])
    const chunks = stableIdChunks(input)

    expect(chunks.length).toBe(140)
    expect(chunks.every((chunk) => chunk.length <= 500)).toBe(true)
    expect(chunks.flat()).toEqual(unique)
    expect(new Set(chunks.flat()).size).toBe(70_000)

    const lock = vi.fn(async (chunk: string[]) => {
      void chunk
    })
    await visitStableIdChunks(input, lock)
    expect(lock).toHaveBeenCalledTimes(140)
    expect(lock.mock.calls.every(([chunk]) => chunk.length <= 500)).toBe(true)

    const load = vi.fn(async (chunk: string[]) => chunk.map((id) => ({ id })))
    const loaded = await loadInStableIdChunks(input, load)
    expect(load).toHaveBeenCalledTimes(140)
    expect(load.mock.calls.every(([chunk]) => chunk.length <= 500)).toBe(true)
    expect(loaded.map((row) => row.id)).toEqual(unique)
  })

  it('builds relationship counts in one pass for large clip and panel collections', () => {
    const entries = Array.from({ length: 100_000 }, (_, index) => ({
      parent: `parent-${index % 10_000}`,
    }))
    let operations = 0
    const counts = buildRelationCountIndex(entries, (entry) => {
      operations += 1
      return entry.parent
    })

    expect(operations).toBe(entries.length)
    expect(counts.size).toBe(10_000)
    expect(counts.get('parent-42')).toBe(10)
  })

  it('bounds persisted and response error summaries without losing the total', () => {
    const missing = Array.from({ length: 20_000 }, (_, index) => ({
      code: 'FRAME_IMAGE_MISSING',
      targetType: 'panel-frame',
      targetKey: `frame-${index}`,
      message: `Frame ${index} is missing`,
    }))
    const bounded = buildBoundedMissingState('run-1', missing)
    const serialized = JSON.stringify(bounded.persisted)

    expect(bounded.persisted.missingCount).toBe(20_000)
    expect(bounded.persisted.summary).toHaveLength(50)
    expect(bounded.persisted.truncated).toBe(true)
    expect(serialized.length).toBeLessThan(64 * 1024)
    expect(bounded.details).toEqual({
      missingCount: 20_000,
      snapshotEndpoint: '/api/agent/v1/runs/run-1/snapshot',
      summaryCount: 50,
      truncated: true,
    })
    expect(JSON.stringify(bounded.details).length).toBeLessThan(1_024)
  })
})
