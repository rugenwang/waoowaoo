'use client'

import type { TaskTargetStateQuery } from '@/lib/query/hooks/useTaskTargetStateMap'

export type QueueItemStatus = 'pending' | 'running' | 'succeeded' | 'failed'

export type QueueItem = {
  id: string
  projectId: string
  target: TaskTargetStateQuery
  /**
   * 分组来源：用于在弹窗里把任务按来源（资产库/分镜/视频）分组展示。
   */
  group?: 'assets' | 'storyboard' | 'video'
  label: string
  /**
   * 去重 key：用于避免用户重复点击同一项导致队列里出现重复任务。
   * - 不传：默认使用 projectId + targetType + targetId + uiKey 生成
   * - 传入：业务方可自定义更细粒度或更粗粒度的去重策略
   */
  dedupeKey?: string
  /**
   * 业务侧可选的 UI key，用于在列表中仅标记“当前正在处理的那一项”为 running。
   * 例如资产库会用 `character-<id>-<appearanceIndex>-group` / `location-<id>-group`。
   */
  uiKey?: string
  submit: () => Promise<{ taskId: string }>
  onDone?: (taskId: string) => void | Promise<void>
  onFail?: (taskId: string, error?: unknown) => void | Promise<void>
}

export type QueueItemState = QueueItem & {
  status: QueueItemStatus
  taskId: string | null
  error: string | null
}
