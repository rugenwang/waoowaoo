'use client'
import { useTranslations } from 'next-intl'
import TaskStatusInline from '@/components/task/TaskStatusInline'
import { resolveTaskPresentationState } from '@/lib/task/presentation'
import { AppIcon } from '@/components/ui/icons'

interface VideoToolbarProps {
  totalPanels: number
  runningCount: number
  videosWithUrl: number
  failedCount: number
  isAnyTaskRunning: boolean
  queueModeEnabled?: boolean
  firstLastFrameLinkableCount?: number
  firstLastFrameUnlinkedCount?: number
  firstLastFrameLinkedCount?: number
  isBatchUpdatingFirstLastFrames?: boolean
  isDownloading: boolean
  onGenerateAll: () => void
  onLinkAllFirstLastFrames?: () => void
  onUnlinkAllFirstLastFrames?: () => void
  onDownloadAll: () => void
  onBack: () => void
  onEnterEditor?: () => void  // 进入剪辑器
  videosReady?: boolean  // 是否有视频可以剪辑
}

export default function VideoToolbar({
  totalPanels,
  runningCount,
  videosWithUrl,
  failedCount,
  isAnyTaskRunning,
  queueModeEnabled = false,
  firstLastFrameLinkableCount = 0,
  firstLastFrameUnlinkedCount = 0,
  firstLastFrameLinkedCount = 0,
  isBatchUpdatingFirstLastFrames = false,
  isDownloading,
  onGenerateAll,
  onLinkAllFirstLastFrames,
  onUnlinkAllFirstLastFrames,
  onDownloadAll,
  onBack,
  onEnterEditor,
  videosReady = false
}: VideoToolbarProps) {
  const t = useTranslations('video')
  const videoTaskRunningState = isAnyTaskRunning
    ? resolveTaskPresentationState({
      phase: 'processing',
      intent: 'generate',
      resource: 'video',
      hasOutput: videosWithUrl > 0,
    })
    : null
  const videoDownloadState = isDownloading
    ? resolveTaskPresentationState({
      phase: 'processing',
      intent: 'generate',
      resource: 'video',
      hasOutput: videosWithUrl > 0,
    })
    : null
  const linkAllDisabled = !onLinkAllFirstLastFrames
    || firstLastFrameUnlinkedCount <= 0
    || isBatchUpdatingFirstLastFrames
  const unlinkAllDisabled = !onUnlinkAllFirstLastFrames
    || firstLastFrameLinkedCount <= 0
    || isBatchUpdatingFirstLastFrames
  const shouldLinkFirstLastFrames = firstLastFrameUnlinkedCount > 0
  const firstLastFrameBatchAction = shouldLinkFirstLastFrames
    ? onLinkAllFirstLastFrames
    : onUnlinkAllFirstLastFrames
  const firstLastFrameBatchDisabled = shouldLinkFirstLastFrames ? linkAllDisabled : unlinkAllDisabled
  const firstLastFrameBatchTitle = firstLastFrameLinkableCount === 0
    ? t('firstLastFrame.batchLinkNoPairs')
    : shouldLinkFirstLastFrames
      ? t('firstLastFrame.batchLinkTitle', { count: firstLastFrameUnlinkedCount })
      : firstLastFrameLinkedCount === 0
        ? t('firstLastFrame.batchUnlinkNone')
        : t('firstLastFrame.batchUnlinkTitle', { count: firstLastFrameLinkedCount })
  const firstLastFrameBatchLabel = isBatchUpdatingFirstLastFrames
    ? t('firstLastFrame.batchUpdating')
    : shouldLinkFirstLastFrames
      ? t('firstLastFrame.batchLink', { count: firstLastFrameUnlinkedCount })
      : t('firstLastFrame.batchUnlink', { count: firstLastFrameLinkedCount })
  return (
    <div className="glass-surface p-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-4">
          <span className="text-sm font-semibold text-[var(--glass-text-secondary)]">
             {t('toolbar.title')}
          </span>
          <span className="text-sm text-[var(--glass-text-tertiary)]">
            {t('toolbar.totalShots', { count: totalPanels })}
            {runningCount > 0 && (
              <span className="text-[var(--glass-tone-info-fg)] ml-2 animate-pulse">({t('toolbar.generatingShots', { count: runningCount })})</span>
            )}
            {videosWithUrl > 0 && (
              <span className="text-[var(--glass-tone-success-fg)] ml-2">({t('toolbar.completedShots', { count: videosWithUrl })})</span>
            )}
            {failedCount > 0 && (
              <span className="text-[var(--glass-tone-danger-fg)] ml-2">({t('toolbar.failedShots', { count: failedCount })})</span>
            )}
          </span>
        </div>
        <div className="flex flex-wrap items-center justify-end gap-2">
          <button
            onClick={onGenerateAll}
            disabled={isAnyTaskRunning && !queueModeEnabled}
            className="glass-btn-base glass-btn-primary flex items-center gap-2 px-4 py-2 text-sm font-medium disabled:opacity-50 disabled:cursor-not-allowed"
          >
            {isAnyTaskRunning ? (
              <TaskStatusInline state={videoTaskRunningState} className="text-white [&>span]:text-white [&_svg]:text-white" />
            ) : (
              <>
                <AppIcon name="plus" className="w-4 h-4" />
                <span>{queueModeEnabled ? '加入队列生成' : t('toolbar.generateAll')}</span>
              </>
            )}
          </button>
          {(onLinkAllFirstLastFrames || onUnlinkAllFirstLastFrames) && (
            <button
              onClick={firstLastFrameBatchAction}
              disabled={firstLastFrameBatchDisabled}
              className="glass-btn-base glass-btn-secondary flex items-center gap-2 px-4 py-2 text-sm font-medium border border-[var(--glass-stroke-base)] disabled:opacity-50 disabled:cursor-not-allowed"
              title={firstLastFrameBatchTitle}
            >
              <AppIcon name="link" className="w-4 h-4" />
              <span>{firstLastFrameBatchLabel}</span>
            </button>
          )}
          <button
            onClick={onDownloadAll}
            disabled={videosWithUrl === 0 || isDownloading}
            className="glass-btn-base glass-btn-tone-info flex items-center gap-2 px-4 py-2 text-sm font-medium disabled:opacity-50 disabled:cursor-not-allowed"
            title={videosWithUrl === 0 ? t('toolbar.noVideos') : t('toolbar.downloadCount', { count: videosWithUrl })}
          >
            {isDownloading ? (
              <TaskStatusInline state={videoDownloadState} className="text-white [&>span]:text-white [&_svg]:text-white" />
            ) : (
              <>
                <AppIcon name="image" className="w-4 h-4" />
                <span>{t('toolbar.downloadAll')}</span>
              </>
            )}
          </button>
          {onEnterEditor && (
            <button
              onClick={onEnterEditor}
              disabled={!videosReady}
              className="glass-btn-base glass-btn-secondary flex items-center gap-2 px-4 py-2 text-sm font-medium border border-[var(--glass-stroke-base)] disabled:opacity-50 disabled:cursor-not-allowed"
              title={videosReady ? t('toolbar.enterEditor') : t('panelCard.needVideo')}
            >
              <AppIcon name="wandOff" className="w-4 h-4" />
              <span>{t('toolbar.enterEdit')}</span>
            </button>
          )}
          <button
            onClick={onBack}
            className="glass-btn-base glass-btn-secondary flex items-center gap-2 px-4 py-2 text-sm font-medium border border-[var(--glass-stroke-base)] hover:text-[var(--glass-tone-info-fg)]"
          >
            <AppIcon name="chevronLeft" className="w-4 h-4" />
            <span>{t('toolbar.back')}</span>
          </button>
        </div>
      </div>
    </div>
  )
}
