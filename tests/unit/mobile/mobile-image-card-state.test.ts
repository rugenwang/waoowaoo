import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import {
  getMobileImageCardStateLabel,
  resolveMobileImageCardState,
} from '@/features/mobile-h5/mobile-image-card-state'

describe('mobile image card state', () => {
  it('keeps queued and current generation states isolated', () => {
    expect(resolveMobileImageCardState({ queueStatus: 'pending', mutationPending: false, activeTask: false, hasImage: false })).toBe('queued')
    expect(resolveMobileImageCardState({ queueStatus: 'running', mutationPending: false, activeTask: true, hasImage: false })).toBe('generating')
    expect(resolveMobileImageCardState({ queueStatus: null, mutationPending: false, activeTask: false, hasImage: false })).toBe('idle')
  })

  it('shows an image while the task is settling instead of calling it generating', () => {
    expect(resolveMobileImageCardState({ queueStatus: 'running', mutationPending: false, activeTask: true, hasImage: true })).toBe('settling')
    expect(resolveMobileImageCardState({ queueStatus: null, mutationPending: false, activeTask: false, hasImage: true })).toBe('generated')
  })

  it('uses mutation variables only while the mutation is pending', () => {
    expect(resolveMobileImageCardState({ queueStatus: null, mutationPending: true, activeTask: false, hasImage: false })).toBe('submitting')

    const source = readFileSync(resolve(process.cwd(), 'src/features/mobile-h5/MobileProject.tsx'), 'utf8')
    expect(source).toContain('regenerateImage.isPending ? regenerateImage.variables')
    expect(source).toContain('regenerateFrameImage.isPending ? regenerateFrameImage.variables?.frameId')
  })

  it('does not trust the persisted frame processing flag for mobile runtime state', () => {
    const source = readFileSync(resolve(process.cwd(), 'src/features/mobile-h5/MobileProject.tsx'), 'utf8')
    expect(source).not.toContain("frame.generationStatus === 'processing'")
    expect(getMobileImageCardStateLabel('settling')).toBe('任务收尾中')
  })
})
