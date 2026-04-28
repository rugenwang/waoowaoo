'use client'

import TaskStatusInline from '@/components/task/TaskStatusInline'
import { resolveTaskPresentationState } from '@/lib/task/presentation'
import { useTaskQueue } from '@/lib/task-queue'
import { useTaskTargetStateMap } from '@/lib/query/hooks/useTaskTargetStateMap'
import type { QueueItemState } from '@/lib/task-queue/types'

function resolveGroupLabel(group: QueueItemState['group']) {
  if (group === 'assets') return '资产库'
  if (group === 'storyboard') return '分镜'
  if (group === 'video') return '视频'
  return '其他'
}

export default function QueueProgressPopup() {
  const {
    enabled,
    projectId,
    queue,
    activeItem,
    activeTarget,
    showPopup,
    setShowPopup,
    clearPending,
    cancelCurrent,
    notice,
  } = useTaskQueue()

  // 注意：Hooks 不能在条件分支里调用。
  // 这里先无条件调用 useTaskTargetStateMap，再根据 enabled/queue.length 决定是否渲染。

  const total = queue.length
  const doneCount = queue.filter((i) => i.status === 'succeeded' || i.status === 'failed').length
  const runningIndex = activeItem ? doneCount + 1 : doneCount
  const currentLabel = activeItem?.label || ''

  // 仅订阅 overlay（不开启服务端轮询），进度由 SSE 写入 overlay
  const { getState } = useTaskTargetStateMap(
    projectId,
    activeTarget ? [activeTarget] : [],
    { enabled: false },
  )
  const state = activeTarget ? getState(activeTarget.targetType, activeTarget.targetId) : null
  const progress = typeof state?.progress === 'number' ? state.progress : null
  const stageLabel = typeof state?.stageLabel === 'string' ? state.stageLabel : null

  if (!enabled) return null
  if (queue.length === 0) return null

  const grouped = {
    assets: queue.filter((i) => i.group === 'assets'),
    storyboard: queue.filter((i) => i.group === 'storyboard'),
    video: queue.filter((i) => i.group === 'video'),
    other: queue.filter((i) => !i.group),
  }

  const hasRunningOrPending = queue.some((i) => i.status === 'running' || i.status === 'pending')

  const runningState = resolveTaskPresentationState({
    phase: 'processing',
    intent: 'generate',
    resource: 'image',
    hasOutput: true,
  })

  const idleDoneState = resolveTaskPresentationState({
    phase: 'completed',
    intent: 'generate',
    resource: 'image',
    hasOutput: true,
  })

  const body = (
    <div className="glass-surface-modal min-w-[320px] max-w-[90vw] p-4">
      <div className="flex items-start gap-3">
        <div className="mt-0.5 shrink-0">
          <TaskStatusInline state={runningState} className="[&>span]:sr-only" />
        </div>
        <div className="flex-1">
          <div className="flex items-start justify-between gap-2">
            <div className="font-semibold text-(--glass-text-primary)">
              任务队列进度（{runningIndex}/{total}）
            </div>
            <button
              type="button"
              className="glass-btn-base glass-btn-secondary rounded-md px-2 py-1 text-xs"
              onClick={() => setShowPopup(false)}
            >
              关闭
            </button>
          </div>
          {currentLabel && (
            <div className="mt-1 text-sm text-(--glass-text-secondary)">
              正在处理（{resolveGroupLabel(activeItem?.group)}）：{currentLabel}
            </div>
          )}
          {stageLabel && (
            <div className="mt-1 text-xs text-(--glass-text-tertiary)">
              {stageLabel}{progress !== null ? `（${progress}%）` : ''}
            </div>
          )}

          <div className="mt-3 flex flex-wrap gap-2">
            <button
              type="button"
              className="glass-btn-base glass-btn-secondary rounded-md px-3 py-1 text-xs"
              onClick={() => void cancelCurrent()}
              disabled={!activeItem?.taskId}
            >
              取消当前
            </button>
            <button
              type="button"
              className="glass-btn-base glass-btn-secondary rounded-md px-3 py-1 text-xs"
              onClick={() => clearPending()}
            >
              清空未开始
            </button>
          </div>
        </div>
      </div>

      <div className="mt-3 h-1.5 w-full overflow-hidden rounded-full bg-(--glass-bg-muted)">
        <div
          className="h-1.5 rounded-full bg-(--glass-accent-from)"
          style={{
            width: `${Math.min(100, Math.max(0, Math.round(((doneCount + (progress ? progress / 100 : 0)) / total) * 100)))}%`,
          }}
        />
      </div>

      <div className="mt-3 grid grid-cols-1 gap-1 text-xs text-(--glass-text-tertiary)">
        {(['assets', 'storyboard', 'video', 'other'] as const).map((groupKey) => {
          const items = grouped[groupKey]
          if (!items || items.length === 0) return null
          return (
            <div key={groupKey} className="mt-1">
              <div className="mb-1 font-medium text-(--glass-text-secondary)">
                {resolveGroupLabel(groupKey === 'other' ? undefined : groupKey)}
              </div>
              <div className="grid grid-cols-1 gap-1">
                {items.slice(-4).map((item) => (
                  <div key={item.id} className="flex items-center justify-between gap-2">
                    <div className="truncate">{item.label}</div>
                    <div className="shrink-0">
                      {item.status === 'pending' && '待处理'}
                      {item.status === 'running' && '进行中'}
                      {item.status === 'succeeded' && '完成'}
                      {item.status === 'failed' && '失败'}
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )
        })}
      </div>
    </div>
  )

  const toast = notice ? (
    <div className="mb-2 w-fit max-w-[90vw] rounded-md bg-(--glass-bg) px-3 py-2 text-sm text-(--glass-text-primary) shadow-lg">
      {notice}
    </div>
  ) : null

  if (showPopup) {
    return (
      <div className="fixed bottom-8 right-8 z-[9999] animate-slide-up">
        {toast}
        {body}
      </div>
    )
  }

  if (!hasRunningOrPending) {
    // 没有正在执行/待执行：展示一个“完成”角标（醒目）
    return (
      <div className="fixed bottom-8 right-8 z-[9999] animate-slide-up">
        {toast}
        <div className="glass-surface-modal px-3 py-2 text-sm text-(--glass-tone-success-fg) flex items-center gap-2">
          <span className="inline-flex h-5 w-5 items-center justify-center rounded-full bg-(--glass-tone-success-bg)">
            <span className="text-(--glass-tone-success-fg) text-sm leading-none">✓</span>
          </span>
          <span>队列空闲（{doneCount}/{total}）</span>
          <button
            type="button"
            className="ml-2 text-xs text-(--glass-text-tertiary) hover:text-(--glass-tone-info-fg)"
            onClick={() => clearPending()}
            title="清空未开始任务"
          >
            清空
          </button>
        </div>
      </div>
    )
  }
  return (
    <div className="fixed bottom-8 right-8 z-[9999] animate-slide-up">
      {toast}
      <button
        type="button"
        className="glass-surface-modal px-3 py-2 text-sm text-(--glass-text-primary)"
        onClick={() => setShowPopup(true)}
      >
        队列进度 {runningIndex}/{total}
      </button>
    </div>
  )
}
