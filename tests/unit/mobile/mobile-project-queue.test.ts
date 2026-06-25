import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { getMobileTaskQueueConfig } from '@/features/mobile-h5/mobile-task-queue'

describe('mobile project task queue runtime', () => {
  it('uses the project queue setting and desktop local-model lane rule', () => {
    expect(getMobileTaskQueueConfig({
      progressPopupEnabled: true,
      storyboardModel: 'local::image2',
      videoModel: 'local::ltx-video',
    })).toEqual({
      enabled: true,
      allowParallelStoryboardVideo: false,
    })

    expect(getMobileTaskQueueConfig({
      progressPopupEnabled: true,
      storyboardModel: 'openai::gpt-image-2',
      videoModel: 'local::ltx-video',
    }).allowParallelStoryboardVideo).toBe(true)
  })

  it('exposes the provider queue context to mobile workspace actions', () => {
    const boundarySource = readFileSync(resolve(process.cwd(), 'src/features/mobile-h5/MobileProjectTaskQueueBoundary.tsx'), 'utf8')
    const projectSource = readFileSync(resolve(process.cwd(), 'src/features/mobile-h5/MobileProject.tsx'), 'utf8')

    expect(boundarySource).toContain('useTaskQueue()')
    expect(boundarySource).toContain('children(taskQueue)')
    expect(projectSource).toContain('{(taskQueue) => (')
  })

  it('shows mobile queue controls on storyboard and video pages', () => {
    const barSource = readFileSync(resolve(process.cwd(), 'src/features/mobile-h5/MobileGenerationQueueBar.tsx'), 'utf8')
    const projectSource = readFileSync(resolve(process.cwd(), 'src/features/mobile-h5/MobileProject.tsx'), 'utf8')

    expect(barSource).toContain('当前任务')
    expect(barSource).toContain('等待')
    expect(barSource).toContain('取消当前')
    expect(barSource).toContain('清空未开始')
    expect(projectSource.match(/<MobileGenerationQueueBar/g)?.length).toBeGreaterThanOrEqual(2)
  })

  it('shows mobile queue feedback on the project assets page', () => {
    const providerSource = readFileSync(resolve(process.cwd(), 'src/lib/task-queue/TaskQueueProvider.tsx'), 'utf8')
    const assetsSource = readFileSync(resolve(process.cwd(), 'src/features/mobile-h5/MobileProjectAssets.tsx'), 'utf8')

    expect(providerSource).toContain('flashNotice(`已加入队列：${item.label}`)')
    expect(assetsSource).toContain("import MobileGenerationQueueBar from './MobileGenerationQueueBar'")
    expect(assetsSource).toContain('<MobileGenerationQueueBar />')
  })

  it('shows the latest failed queue submission on mobile', () => {
    const source = readFileSync(resolve(process.cwd(), 'src/features/mobile-h5/MobileGenerationQueueBar.tsx'), 'utf8')

    expect(source).toContain("item.status === 'failed'")
    expect(source).toContain('提交失败')
    expect(source).toContain('latestFailure.error')
  })

  it('refreshes mobile episode data for terminal task events', () => {
    const boundarySource = readFileSync(resolve(process.cwd(), 'src/features/mobile-h5/MobileProjectTaskQueueBoundary.tsx'), 'utf8')
    const projectSource = readFileSync(resolve(process.cwd(), 'src/features/mobile-h5/MobileProject.tsx'), 'utf8')

    expect(boundarySource).toContain('onTaskTerminal')
    expect(boundarySource).toContain('TASK_EVENT_TYPE.COMPLETED')
    expect(boundarySource).toContain('TASK_EVENT_TYPE.FAILED')
    expect(projectSource).toContain('onTaskTerminal={refreshMobileData}')
  })
})
