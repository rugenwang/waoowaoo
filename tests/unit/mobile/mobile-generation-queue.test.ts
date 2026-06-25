import { describe, expect, it, vi } from 'vitest'
import {
  buildMobileStoryboardQueueItems,
  buildMobileVideoQueueItems,
  getMobileQueueUiStatus,
  runMobileGenerationBatch,
} from '@/features/mobile-h5/mobile-generation-queue'

const panels = [
  { id: 'panel-1', storyboardId: 'storyboard-1', panelIndex: 0, panelNumber: 1 },
  { id: 'panel-2', storyboardId: 'storyboard-1', panelIndex: 1, panelNumber: 2 },
]

describe('mobile generation queue', () => {
  it('builds ordered storyboard queue items', async () => {
    const submit = vi.fn(async (panel: { id: string }) => ({ taskId: `task-${panel.id}` }))
    const items = buildMobileStoryboardQueueItems({
      projectId: 'project-1',
      batchId: 'batch-1',
      panels,
      submit,
    })

    expect(items.map((item) => item.group)).toEqual(['storyboard', 'storyboard'])
    expect(items.map((item) => item.target.targetId)).toEqual(['panel-1', 'panel-2'])
    expect(items.map((item) => item.uiKey)).toEqual(['panel-panel-1', 'panel-panel-2'])
    await expect(items[1].submit()).resolves.toEqual({ taskId: 'task-panel-2' })
  })

  it('builds ordered video queue items', async () => {
    const submit = vi.fn(async (panel: { id: string }) => ({ taskId: `video-${panel.id}` }))
    const items = buildMobileVideoQueueItems({
      projectId: 'project-1',
      batchId: 'batch-2',
      panels,
      submit,
    })

    expect(items.map((item) => item.group)).toEqual(['video', 'video'])
    expect(items.map((item) => item.target.types)).toEqual([['video_panel'], ['video_panel']])
    expect(items.map((item) => item.target.targetId)).toEqual(['panel-1', 'panel-2'])
    await expect(items[0].submit()).resolves.toEqual({ taskId: 'video-panel-1' })
  })

  it('does not silently finish an async video item without a task id', async () => {
    const items = buildMobileVideoQueueItems({
      projectId: 'project-1',
      batchId: 'batch-missing-task-id',
      panels: [panels[0]],
      submit: async () => ({}),
    })

    await expect(items[0].submit()).rejects.toThrow('视频任务提交成功但未返回任务 ID')
  })

  it('continues a non-queue batch after one item fails', async () => {
    const called: string[] = []
    const result = await runMobileGenerationBatch(
      ['one', 'two', 'three'],
      async (item) => {
        called.push(item)
        if (item === 'two') throw new Error('failed two')
      },
      2,
    )

    expect(called).toEqual(['one', 'two', 'three'])
    expect(result.succeeded).toBe(2)
    expect(result.failed).toBe(1)
    expect(result.errors).toEqual(['failed two'])
  })

  it('marks only the exact mobile card that was queued', () => {
    const queue = [
      {
        ...buildMobileStoryboardQueueItems({
          projectId: 'project-1',
          batchId: 'batch-3',
          panels: [panels[0]],
          submit: async () => ({ taskId: 'task-1' }),
        })[0],
        status: 'pending' as const,
        taskId: null,
        error: null,
      },
    ]

    expect(getMobileQueueUiStatus(queue, 'panel-panel-1')).toBe('pending')
    expect(getMobileQueueUiStatus(queue, 'panel-panel-2')).toBeNull()
    expect(getMobileQueueUiStatus(queue, 'panel-frame-frame-1')).toBeNull()
  })
})
