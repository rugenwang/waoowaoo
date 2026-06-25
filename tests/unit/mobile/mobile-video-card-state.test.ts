import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import {
  getMobileVideoCardStateLabel,
  resolveMobileVideoCardState,
} from '@/features/mobile-h5/mobile-video-card-state'

describe('mobile video card state', () => {
  it('shows immediate queue and running feedback for the exact video panel', () => {
    expect(resolveMobileVideoCardState({ queueStatus: 'pending', activeTask: false, hasVideo: false })).toBe('queued')
    expect(resolveMobileVideoCardState({ queueStatus: 'running', activeTask: false, hasVideo: false })).toBe('generating')
    expect(resolveMobileVideoCardState({ queueStatus: null, activeTask: true, hasVideo: false })).toBe('generating')
  })

  it('restores a usable idle or generated state after the task is terminal', () => {
    expect(resolveMobileVideoCardState({ queueStatus: null, activeTask: false, hasVideo: false })).toBe('idle')
    expect(resolveMobileVideoCardState({ queueStatus: null, activeTask: false, hasVideo: true })).toBe('generated')
  })

  it('connects the mobile video card to queue and backend task state', () => {
    const source = readFileSync(resolve(process.cwd(), 'src/features/mobile-h5/MobileProject.tsx'), 'utf8')

    expect(source).toContain('panel.videoTaskRunning || activeVideoTargetIds.has(panel.id)')
    expect(source).toContain('`video-panel-${panel.id}`')
    expect(source).toContain('videoIsBusy')
    expect(getMobileVideoCardStateLabel('queued')).toBe('队列等待')
  })

  it('keeps queued video submission state stable instead of refreshing immediately', () => {
    const source = readFileSync(resolve(process.cwd(), 'src/features/mobile-h5/MobileProject.tsx'), 'utf8')

    expect(source).toContain('taskQueue.enqueueMany(buildMobileVideoQueueItems')
    expect(source).toContain('setPanelMenu(null)\n          return')
  })
})
