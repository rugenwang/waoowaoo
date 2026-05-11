import { useCallback, useState, useEffect, useRef } from 'react'
import TaskStatusOverlay from '@/components/task/TaskStatusOverlay'
import { MediaImageWithLoading } from '@/components/media/MediaImageWithLoading'

import type { VideoPanelRuntime } from './hooks/useVideoPanelActions'
import { AppIcon } from '@/components/ui/icons'
import { useTaskQueue } from '@/lib/task-queue'
import { buildVideoSubmissionKey } from '@/lib/novel-promotion/stages/video-stage-runtime/immediate-video-submission'
import { resolveTaskPresentationState } from '@/lib/task/presentation'
import { useTaskTargetStateMap } from '@/lib/query/hooks/useTaskTargetStateMap'
import { useUpdateProjectPanelFrameTime } from '@/lib/query/hooks'
import { useCancelTask } from '@/lib/query/mutations'
import { shouldShowError } from '@/lib/error-utils'
import { extractErrorMessage } from '@/lib/errors/extract'
import type { NovelPromotionPanelFrame } from '@/types/project'

interface VideoPanelCardHeaderProps {
  runtime: VideoPanelRuntime
  onUploadVideo?: (panelId: string, file: File) => void
  isUploadingVideo?: boolean
}

export default function VideoPanelCardHeader({ runtime, onUploadVideo, isUploadingVideo }: VideoPanelCardHeaderProps) {
  const {
    t,
    panel,
    panelIndex,
    panelKey,
    layout,
    media,
    taskStatus,
    videoModel,
    player,
    actions,
  } = runtime

  // 追踪已被用户关闭的错误，使得同一错误关闭后不再出现，但新错误仍可正常显示
  // 用 errorCode 作为稳定 key（避免原始消息中的时间戳/请求ID等变化导致匹配失败）
  // 用 useEffect 在客户端 mount 后从 sessionStorage 恢复，避免 SSR 时 window 为 undefined
  const dismissedStorageKey = `video-panel-dismissed:${panel.panelId ?? ''}:${panel.panelIndex ?? ''}`
  const [dismissedErrorCodes, _setDismissedErrorCodes] = useState<Set<string>>(new Set())

  // 同时更新 state 和 sessionStorage 的辅助方法
  const setDismissed = useCallback((updater: (prev: Set<string>) => Set<string>) => {
    _setDismissedErrorCodes(prev => {
      const next = updater(prev)
      try {
        if (next.size > 0) {
          sessionStorage.setItem(dismissedStorageKey, JSON.stringify([...next]))
        } else {
          sessionStorage.removeItem(dismissedStorageKey)
        }
      } catch {}
      return next
    })
  }, [dismissedStorageKey])

  // 挂载后或从 sessionStorage key 变化时，从 sessionStorage 恢复（SSR 安全）
  useEffect(() => {
    try {
      const stored = sessionStorage.getItem(dismissedStorageKey)
      if (stored) {
        _setDismissedErrorCodes(new Set(JSON.parse(stored) as string[]))
      }
    } catch {}
  }, [dismissedStorageKey])

  // 当前错误码；当错误从有到无（任务成功/重新运行）时，清理 dismissed 集合
  // 用 ref 避免初始加载时（从未知到无）误清理 sessionStorage
  const currentErrorCode = taskStatus.panelErrorDisplay?.code || null
  const hasSeenErrorRef = useRef(false)
  useEffect(() => {
    if (currentErrorCode) {
      hasSeenErrorRef.current = true
    } else if (hasSeenErrorRef.current) {
      // 只有曾经看到过错误，现在错误消失了，才清理
      hasSeenErrorRef.current = false
      setDismissed(() => new Set())
    }
  }, [currentErrorCode, setDismissed])

  const [showTooltip, setShowTooltip] = useState(false)
  const taskQueue = useTaskQueue()
  const queueKey = buildVideoSubmissionKey({ panelId: panel.panelId, storyboardId: panel.storyboardId, panelIndex: panel.panelIndex })
  const isQueued =
    taskQueue.enabled &&
    taskQueue.queue.some((item) =>
      item.status === 'pending' && item.group === 'video' && item.uiKey === queueKey,
     )

  const hasVisibleBaseVideo = !!media.baseVideoUrl
  const showFirstLastFrameSwitch = layout.hasNext

  const projectId = layout.projectId || 'unknown-project'
  const targetId = panel.panelId || ''
  const cancelTask = useCancelTask(projectId)
  const updateFrameTime = useUpdateProjectPanelFrameTime(projectId)
  const taskStateMap = useTaskTargetStateMap(layout.projectId, [
     { targetType: 'NovelPromotionPanel', targetId },
   ], { enabled: !!layout.projectId && !!targetId })
  const taskState = taskStateMap.getState('NovelPromotionPanel', targetId)
  const canCancel = !!taskState?.runningTaskId && (taskState?.phase === 'queued' || taskState?.phase === 'processing')

  const fileInputRef = useRef<HTMLInputElement>(null)
  const groupFrames = Array.isArray(panel.frames)
    ? panel.frames.filter((frame) => typeof frame.imageUrl === 'string' && frame.imageUrl.trim())
    : []
  const showGroupFrames = groupFrames.length > 1
  const [frameTimeDrafts, setFrameTimeDrafts] = useState<Record<string, string>>({})

  const getFrameTimeDraft = (frame: NovelPromotionPanelFrame) => {
    return frameTimeDrafts[frame.id] ?? String(frame.frameTimeSec)
  }

  const setFrameTimeDraft = (frameId: string, value: string) => {
    setFrameTimeDrafts((prev) => ({ ...prev, [frameId]: value }))
  }

  const commitFrameTime = async (frame: NovelPromotionPanelFrame) => {
    if (frame.frameIndex === 0) return
    const raw = getFrameTimeDraft(frame).trim()
    const nextValue = Number(raw)
    if (!Number.isFinite(nextValue) || nextValue <= 0) {
      alert('F1 之后的关键帧起始时间必须大于 0 秒')
      setFrameTimeDraft(frame.id, String(frame.frameTimeSec))
      return
    }
    const normalized = Math.round(nextValue * 100) / 100
    if (normalized === frame.frameTimeSec) {
      setFrameTimeDraft(frame.id, String(frame.frameTimeSec))
      return
    }
    try {
      await updateFrameTime.mutateAsync({ frameId: frame.id, frameTimeSec: normalized })
      setFrameTimeDraft(frame.id, String(normalized))
    } catch (error: unknown) {
      setFrameTimeDraft(frame.id, String(frame.frameTimeSec))
      if (shouldShowError(error)) {
        alert(extractErrorMessage(error, '更新关键帧时间失败'))
      }
    }
  }

  return (
     <div className="group/video-frame bg-[var(--glass-bg-muted)] flex items-center justify-center relative" style={{ aspectRatio: player.cssAspectRatio }}>
       {hasVisibleBaseVideo && player.isPlaying ? (
         <video
          ref={player.videoRef}
          key={`video-${panel.storyboardId}-${panel.panelIndex}-${media.currentVideoUrl}`}
          src={media.currentVideoUrl}
          controls
          playsInline
          className="w-full h-full object-contain bg-black"
          onEnded={() => player.setIsPlaying(false)}
         />
       ) : hasVisibleBaseVideo ? (
         <div
          className="relative w-full h-full group cursor-pointer"
          onClick={() => void player.handlePlayClick()}
         >
           <MediaImageWithLoading
            src={panel.imageUrl || ''}
            alt={t('panelCard.shot', { number: panelIndex + 1 })}
            containerClassName="w-full h-full bg-black"
            className="w-full h-full object-contain bg-black"
           />
           <div className="absolute inset-0 flex items-center justify-center bg-[var(--glass-overlay)] group-hover:bg-[var(--glass-overlay)] transition-colors pointer-events-none">
             <div className="w-16 h-16 bg-[var(--glass-bg-surface-strong)] rounded-full flex items-center justify-center shadow-lg group-hover:scale-110 transition-transform">
               <AppIcon name="play" className="w-8 h-8 text-white" />
             </div>
           </div>
         </div>
       ) : panel.imageUrl ? (
         <MediaImageWithLoading
          src={panel.imageUrl}
          alt={t('panelCard.shot', { number: panelIndex + 1 })}
          containerClassName="w-full h-full bg-[var(--glass-bg-muted)]"
          className={`w-full h-full object-contain bg-[var(--glass-bg-muted)] ${media.onPreviewImage ? 'cursor-zoom-in' : ''}`}
          onClick={media.onPreviewImage ? player.handlePreviewImage : undefined}
         />
       ) : (
         <AppIcon name="playCircle" className="w-16 h-16 text-[var(--glass-text-tertiary)]" />
       )}

       {/* 镜头编号 */}
       <div className="absolute top-2 left-2 bg-[var(--glass-overlay)] text-white px-2 py-0.5 rounded text-xs font-medium">
         {panelIndex + 1}
       </div>

       {showGroupFrames && (
         <div className="pointer-events-none absolute left-2 right-2 bottom-2 z-20 flex gap-1.5 overflow-x-auto rounded-lg bg-black/45 p-1.5 backdrop-blur">
           {groupFrames.map((frame) => (
             <div
              key={frame.id}
              className="pointer-events-auto relative h-12 w-20 shrink-0 overflow-hidden rounded border border-white/35 bg-black/40"
              title={`F${frame.frameIndex + 1} · 从 ${frame.frameTimeSec}s 开始`}
             >
               <button
                type="button"
                className="absolute inset-0 h-full w-full"
                onClick={(event) => {
                  event.stopPropagation()
                  if (frame.imageUrl) media.onPreviewImage?.(frame.imageUrl)
                }}
                aria-label={`预览关键帧 F${frame.frameIndex + 1}`}
               >
               <MediaImageWithLoading
                src={frame.imageUrl || ''}
                alt={`F${frame.frameIndex + 1}`}
                containerClassName="h-full w-full bg-black"
                className="h-full w-full object-cover"
               />
               </button>
               <span className="absolute left-1 top-1 rounded bg-black/65 px-1 text-[10px] font-semibold text-white">
                 F{frame.frameIndex + 1}
               </span>
               {frame.frameIndex === 0 ? (
                 <span className="absolute bottom-1 right-1 rounded bg-black/70 px-1 text-[10px] font-medium text-white">
                   {frame.frameTimeSec}s
                 </span>
               ) : (
                 <label
                  className="absolute bottom-1 right-1 rounded bg-black/75 px-1 text-[10px] font-medium text-white"
                  onClick={(event) => event.stopPropagation()}
                  onMouseDown={(event) => event.stopPropagation()}
                 >
                   <span className="sr-only">F{frame.frameIndex + 1} 起始时间</span>
                   <input
                    type="number"
                    min="0.1"
                    step="0.1"
                    value={getFrameTimeDraft(frame)}
                    disabled={updateFrameTime.isPending}
                    className="w-9 bg-transparent text-right text-[10px] font-medium text-white outline-none disabled:opacity-60"
                    onChange={(event) => setFrameTimeDraft(frame.id, event.currentTarget.value)}
                    onBlur={() => void commitFrameTime(frame)}
                    onKeyDown={(event) => {
                      if (event.key === 'Enter') {
                        event.currentTarget.blur()
                      } else if (event.key === 'Escape') {
                        setFrameTimeDraft(frame.id, String(frame.frameTimeSec))
                        event.currentTarget.blur()
                      }
                    }}
                   />
                   <span>s</span>
                 </label>
               )}
             </div>
           ))}
         </div>
       )}

       {/* 两卡片中间唯一的链接/断开按钮 */}

       {showFirstLastFrameSwitch && (
         <div className="absolute -right-6 top-1/2 -translate-y-1/2 z-30">
           <div className="relative">
             <button
              onClick={(event) => {
                event.stopPropagation()
                actions.onToggleLink(panelKey, panel.storyboardId, panel.panelIndex)
               }}
              onMouseEnter={() => setShowTooltip(true)}
              onMouseLeave={() => setShowTooltip(false)}
              className={`h-8 w-8 rounded-full flex items-center justify-center shadow-[var(--glass-shadow-sm)] transition-all duration-200 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--glass-stroke-focus)] ${layout.isLinked
                 ? 'bg-[var(--glass-accent-from)] text-white shadow-[0_0_12px_rgba(99,102,241,0.5)]'
                 : 'bg-[var(--glass-bg-surface)] text-[var(--glass-text-secondary)] hover:bg-[var(--glass-tone-info-bg)] hover:text-[var(--glass-tone-info-fg)]'
                 }`}
             >
               <AppIcon name="unplug" size={16} />
             </button>

             {/* 自定义 Tooltip */}
             {showTooltip && (
               <div className="absolute left-1/2 -translate-x-1/2 bottom-full mb-2 z-50 pointer-events-none">
                 <div className="bg-[var(--glass-bg-surface-strong)] text-[var(--glass-text-primary)] text-xs rounded-lg px-3 py-1.5 shadow-[var(--glass-shadow-md)] whitespace-nowrap border border-[var(--glass-stroke-base)]">
                   {layout.isLinked ? t('firstLastFrame.unlinkAction') : t('firstLastFrame.linkToNext')}
                   <div className="absolute left-1/2 -translate-x-1/2 top-full w-0 h-0 border-l-4 border-r-4 border-t-4 border-l-transparent border-r-transparent border-t-[var(--glass-bg-surface-strong)]" />
                 </div>
               </div>
             )}
           </div>
         </div>
       )}

       {/* 口型同步切换 */}
       {panel.lipSyncVideoUrl && hasVisibleBaseVideo ? (
         <div
          className="absolute top-2 right-2 flex items-center bg-[var(--glass-overlay)] rounded-full p-0.5 cursor-pointer"
          onClick={(event) => {
            event.stopPropagation()
            media.onToggleLipSyncVideo(panelKey, !media.showLipSyncVideo)
            player.setIsPlaying(false)
           }}
         >
           <div className={`px-2 py-0.5 rounded-full text-[10px] font-medium transition-all ${!media.showLipSyncVideo ? 'bg-[var(--glass-tone-success-fg)] text-white' : 'text-[var(--glass-text-tertiary)] hover:text-white'}`}>
             {t('panelCard.original')}
           </div>
           <div className={`px-2 py-0.5 rounded-full text-[10px] font-medium transition-all ${media.showLipSyncVideo ? 'bg-[var(--glass-accent-from)] text-white' : 'text-[var(--glass-text-tertiary)] hover:text-white'}`}>
             {t('panelCard.synced')}
           </div>
         </div>
       ) : null}

       {/* 重新生成按钮 */}
       {!layout.isLinked && !layout.isLastFrame && (hasVisibleBaseVideo || taskStatus.isVideoTaskRunning) && (
         <button
          onClick={() =>
            actions.onGenerateVideo(
              panel.storyboardId,
              panel.panelIndex,
              videoModel.selectedModel,
              undefined,
              videoModel.generationOptions,
              panel.panelId,
             )}
          disabled={
            taskStatus.isVideoTaskRunning
             || !videoModel.selectedModel
             || videoModel.missingCapabilityFields.length > 0
           }
          className="absolute bottom-2 right-2 bg-black/75 hover:bg-black/90 text-white p-2 rounded-full transition-all z-30 shadow-lg ring-1 ring-white/20 disabled:cursor-not-allowed disabled:opacity-50"
         >
           <AppIcon name="refresh" className="w-4 h-4" />
         </button>
       )}

       {/* 取消任务按钮（尽力硬取消：queued 移除 job；processing 标记取消并尽快中断） */}
       {canCancel && (
         <button
          onClick={(e) => { e.stopPropagation(); cancelTask.mutate(taskState!.runningTaskId!) }}
          disabled={cancelTask.isPending}
          className="absolute bottom-2 right-12 bg-black/75 hover:bg-black/90 text-white p-2 rounded-full transition-all z-30 shadow-lg ring-1 ring-white/20 disabled:cursor-not-allowed disabled:opacity-50"
          title="取消任务"
         >
           <AppIcon name="close" className="w-4 h-4" />
         </button>
       )}

       {/* 任务进度遮罩 */}
       {(taskStatus.isVideoTaskRunning || taskStatus.isLipSyncTaskRunning) && (
         <TaskStatusOverlay state={taskStatus.overlayPresentation} className="z-10" />
       )}
       {/* 待执行遮罩（队列中，但未轮到执行） */}
       {isQueued && !(taskStatus.isVideoTaskRunning || taskStatus.isLipSyncTaskRunning) && (
         <TaskStatusOverlay
          state={resolveTaskPresentationState({
            phase: 'queued',
            intent: 'generate',
            resource: 'video',
            hasOutput: hasVisibleBaseVideo,
           })}
          className="z-10"
         />
       )}

      {/* 错误提示 */}
      {taskStatus.panelErrorDisplay && !taskStatus.isVideoTaskRunning && !taskStatus.isLipSyncTaskRunning && currentErrorCode && !dismissedErrorCodes.has(currentErrorCode) && (
         <div className="absolute inset-0 bg-[var(--glass-tone-danger-bg)] flex flex-col items-center justify-center z-10 p-4">
           <button
            onClick={(e) => {
              e.stopPropagation()
              setDismissed(prev => new Set(prev).add(currentErrorCode))
            }}
            className="absolute top-2 right-2 w-5 h-5 flex items-center justify-center rounded-full bg-black/30 hover:bg-black/50 text-white text-xs transition-colors"
           >
             <AppIcon name="close" className="w-3 h-3" />
           </button>
           <span className="text-white text-xs text-center break-all">{taskStatus.panelErrorDisplay.message}</span>
         </div>
      )}

       {/* 上传视频按钮 */}
       {onUploadVideo && (
         <>
           <button
            onClick={() => fileInputRef.current?.click()}
            disabled={isUploadingVideo}
            className="absolute bottom-2 left-2 bg-black/75 hover:bg-black/90 text-white p-2 rounded-full transition-all z-30 shadow-lg ring-1 ring-white/20 disabled:opacity-50"
            title="上传本地视频"
           >
             <AppIcon name="upload" className="w-4 h-4" />
           </button>
           <input
            ref={fileInputRef}
            type="file"
            accept="video/*"
            className="hidden"
            onChange={async (event) => {
              const file = event.target.files?.[0]
              if (!file) return
              if (!panel.panelId) return
              await onUploadVideo(panel.panelId, file)
              event.target.value = ''
              }}
           />
         </>
       )}
     </div>
   )
}
