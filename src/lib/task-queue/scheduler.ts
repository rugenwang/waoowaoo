import type { QueueItemState } from './types'

export type TaskQueueLane = 'global' | 'storyboard' | 'video'

export interface TaskQueueSchedulingOptions {
  allowParallelStoryboardVideo?: boolean
  externalBusyLanes?: readonly TaskQueueLane[]
}

export function resolveQueueLane(
  group: QueueItemState['group'],
  allowParallelStoryboardVideo = false,
): TaskQueueLane {
  if (!allowParallelStoryboardVideo) return 'global'
  if (group === 'storyboard') return 'storyboard'
  if (group === 'video') return 'video'
  return 'global'
}

export function resolveQueueLaneFromTaskType(
  taskType: string | null | undefined,
  allowParallelStoryboardVideo = false,
): TaskQueueLane {
  if (!allowParallelStoryboardVideo) return 'global'
  if (taskType === 'image_panel' || taskType === 'panel_variant' || taskType === 'modify_asset_image') return 'storyboard'
  if (taskType === 'video_panel' || taskType === 'lip_sync') return 'video'
  return 'global'
}

export function queueLanesConflict(left: TaskQueueLane, right: TaskQueueLane) {
  return left === 'global' || right === 'global' || left === right
}

export function promoteRunnableQueueItems(
  queue: QueueItemState[],
  options: TaskQueueSchedulingOptions = {},
): QueueItemState[] {
  const allowParallelStoryboardVideo = options.allowParallelStoryboardVideo === true
  const occupiedLanes: TaskQueueLane[] = [
    ...(options.externalBusyLanes || []),
    ...queue
      .filter((item) => item.status === 'running')
      .map((item) => resolveQueueLane(item.group, allowParallelStoryboardVideo)),
  ]

  let changed = false
  const next = queue.map((item) => {
    if (item.status !== 'pending') return item
    const lane = resolveQueueLane(item.group, allowParallelStoryboardVideo)
    if (occupiedLanes.some((occupiedLane) => queueLanesConflict(occupiedLane, lane))) {
      return item
    }
    occupiedLanes.push(lane)
    changed = true
    return { ...item, status: 'running' as const, error: null }
  })

  return changed ? next : queue
}
