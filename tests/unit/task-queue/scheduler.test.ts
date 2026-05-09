import { describe, expect, it } from 'vitest'
import {
  promoteRunnableQueueItems,
  resolveQueueLaneFromTaskType,
} from '@/lib/task-queue/scheduler'
import type { QueueItemState } from '@/lib/task-queue/types'

function item(id: string, group: QueueItemState['group']): QueueItemState {
  return {
    id,
    group,
    projectId: 'project-1',
    target: { targetType: 'NovelPromotionPanel', targetId: id },
    label: id,
    submit: async () => ({ taskId: id }),
    status: 'pending',
    taskId: null,
    error: null,
  }
}

describe('task queue scheduler', () => {
  it('keeps the queue global when storyboard and video cannot run in parallel', () => {
    const promoted = promoteRunnableQueueItems([
      item('storyboard-1', 'storyboard'),
      item('video-1', 'video'),
    ], {
      allowParallelStoryboardVideo: false,
    })

    expect(promoted.map((entry) => entry.status)).toEqual(['running', 'pending'])
  })

  it('runs one storyboard task and one video task together when lanes are independent', () => {
    const promoted = promoteRunnableQueueItems([
      item('storyboard-1', 'storyboard'),
      item('storyboard-2', 'storyboard'),
      item('video-1', 'video'),
      item('video-2', 'video'),
    ], {
      allowParallelStoryboardVideo: true,
    })

    expect(promoted.map((entry) => entry.status)).toEqual(['running', 'pending', 'running', 'pending'])
  })

  it('lets an external storyboard task block only storyboard lane', () => {
    const promoted = promoteRunnableQueueItems([
      item('storyboard-1', 'storyboard'),
      item('video-1', 'video'),
    ], {
      allowParallelStoryboardVideo: true,
      externalBusyLanes: ['storyboard'],
    })

    expect(promoted.map((entry) => entry.status)).toEqual(['pending', 'running'])
  })

  it('keeps global tasks exclusive even when storyboard and video lanes are independent', () => {
    const promoted = promoteRunnableQueueItems([
      item('asset-1', 'assets'),
      item('storyboard-1', 'storyboard'),
      item('video-1', 'video'),
    ], {
      allowParallelStoryboardVideo: true,
    })

    expect(promoted.map((entry) => entry.status)).toEqual(['running', 'pending', 'pending'])
  })

  it('maps active backend tasks to queue lanes', () => {
    expect(resolveQueueLaneFromTaskType('image_panel', true)).toBe('storyboard')
    expect(resolveQueueLaneFromTaskType('video_panel', true)).toBe('video')
    expect(resolveQueueLaneFromTaskType('voice_line', true)).toBe('global')
    expect(resolveQueueLaneFromTaskType('video_panel', false)).toBe('global')
  })
})
