import type { QueueItem, QueueItemState, QueueItemStatus } from '@/lib/task-queue'
import type { MobilePanel } from './types'

type QueuePanel = Pick<MobilePanel, 'id' | 'storyboardId' | 'panelIndex' | 'panelNumber'>
type SubmitResult = { taskId?: unknown } | null | undefined

interface BuildQueueItemsOptions<T extends QueuePanel> {
  projectId: string
  batchId: string
  panels: T[]
  submit: (panel: T) => Promise<SubmitResult>
  onSettled?: () => void | Promise<void>
}

function taskIdFromResult(result: SubmitResult, label: string): string {
  const taskId = String(result?.taskId || '').trim()
  if (!taskId) {
    throw new Error(`${label}任务提交成功但未返回任务 ID`)
  }
  return taskId
}

export function getMobileQueueUiStatus(
  queue: QueueItemState[],
  uiKey: string,
): Extract<QueueItemStatus, 'pending' | 'running'> | null {
  const item = queue.find((candidate) =>
    candidate.uiKey === uiKey && (candidate.status === 'pending' || candidate.status === 'running'),
  )
  return item?.status === 'pending' || item?.status === 'running' ? item.status : null
}

export function buildMobileStoryboardQueueItems<T extends QueuePanel>({
  projectId,
  batchId,
  panels,
  submit,
  onSettled,
}: BuildQueueItemsOptions<T>): QueueItem[] {
  return panels.map((panel, index) => ({
    id: `mobile-storyboard:${batchId}:${index}:${panel.id}`,
    group: 'storyboard',
    projectId,
    target: {
      targetType: 'NovelPromotionPanel',
      targetId: panel.id,
      types: ['image_panel', 'panel_variant', 'modify_asset_image'],
    },
    uiKey: `panel-${panel.id}`,
    label: `分镜：镜头 ${panel.panelNumber || panel.panelIndex + 1}`,
    submit: async () => ({ taskId: taskIdFromResult(await submit(panel), '分镜图片') }),
    onDone: onSettled,
    onFail: onSettled,
  }))
}

export function buildMobileVideoQueueItems<T extends QueuePanel>({
  projectId,
  batchId,
  panels,
  submit,
  onSettled,
}: BuildQueueItemsOptions<T>): QueueItem[] {
  return panels.map((panel, index) => ({
    id: `mobile-video:${batchId}:${index}:${panel.id}`,
    group: 'video',
    projectId,
    target: {
      targetType: 'NovelPromotionPanel',
      targetId: panel.id,
      types: ['video_panel'],
    },
    uiKey: `video-panel-${panel.id}`,
    label: `视频：镜头 ${panel.panelNumber || panel.panelIndex + 1}`,
    submit: async () => ({ taskId: taskIdFromResult(await submit(panel), '视频') }),
    onDone: onSettled,
    onFail: onSettled,
  }))
}

export interface MobileBatchResult {
  succeeded: number
  failed: number
  errors: string[]
}

export async function runMobileGenerationBatch<T>(
  items: T[],
  submit: (item: T) => Promise<unknown>,
  concurrency = 10,
): Promise<MobileBatchResult> {
  const limit = Math.max(1, Math.floor(concurrency))
  const results: PromiseSettledResult<unknown>[] = []

  for (let index = 0; index < items.length; index += limit) {
    const batch = items.slice(index, index + limit)
    results.push(...await Promise.allSettled(batch.map((item) => submit(item))))
  }

  const errors = results
    .filter((result): result is PromiseRejectedResult => result.status === 'rejected')
    .map((result) => result.reason instanceof Error ? result.reason.message : String(result.reason || '生成失败'))

  return {
    succeeded: results.length - errors.length,
    failed: errors.length,
    errors,
  }
}
