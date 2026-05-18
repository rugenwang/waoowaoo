'use client'
import { useTranslations } from 'next-intl'
import { useState } from 'react'
import './ImageSection.css'
import { GlassButton } from '@/components/ui/primitives'
import { MediaImageWithLoading } from '@/components/media/MediaImageWithLoading'
import TaskStatusOverlay from '@/components/task/TaskStatusOverlay'
import { resolveTaskPresentationState } from '@/lib/task/presentation'
import ImageSectionCandidateMode from './ImageSectionCandidateMode'
import ImageSectionActionButtons from './ImageSectionActionButtons'
import { AppIcon } from '@/components/ui/icons'
import { useTaskTargetStateMap } from '@/lib/query/hooks/useTaskTargetStateMap'
import { useCancelTask } from '@/lib/query/mutations'

interface PanelCandidateData {
  candidates: string[]
  selectedIndex: number
}

interface ImageSectionProps {
  projectId: string
  panelId: string
  imageUrl: string | null
  globalPanelNumber: number
  durationSec?: number | null
  shotType: string
  videoRatio: string
  isDeleting: boolean
  isModifying: boolean
  isSubmittingPanelImageTask: boolean
  isQueued?: boolean
  failedError: string | null
  candidateData: PanelCandidateData | null
  previousImageUrl?: string | null
  onRegeneratePanelImage: (panelId: string, count?: number, force?: boolean) => void
  onOpenEditModal: () => void
  onOpenAIDataModal: () => void
  onUploadImage?: (panelId: string, file: File) => void | Promise<void>
  onSelectCandidateIndex: (panelId: string, index: number) => void
  onConfirmCandidate: (panelId: string, imageUrl: string) => Promise<void>
  onCancelCandidate: (panelId: string) => void
  onClearError: () => void
  onUndo?: (panelId: string) => void
  onPreviewImage?: (url: string) => void
}

export default function ImageSection({
  projectId,
  panelId,
  imageUrl,
  globalPanelNumber,
  durationSec,
  shotType,
  videoRatio,
  isDeleting,
  isModifying,
  isSubmittingPanelImageTask,
  isQueued = false,
  failedError,
  candidateData,
  previousImageUrl,
  onRegeneratePanelImage,
  onOpenEditModal,
  onOpenAIDataModal,
  onUploadImage,
  onSelectCandidateIndex,
  onConfirmCandidate,
  onCancelCandidate,
  onClearError,
  onUndo,
  onPreviewImage,
}: ImageSectionProps) {
  const t = useTranslations('storyboard')
  const [isTaskPulseAnimating, setIsTaskPulseAnimating] = useState(false)
  const cssAspectRatio = videoRatio.replace(':', '/')
  const hasValidCandidates = !!candidateData && candidateData.candidates.some((url) => !url.startsWith('PENDING:'))
  const normalizedDuration = typeof durationSec === 'number' && Number.isFinite(durationSec) && durationSec > 0
    ? Math.round(durationSec * 100) / 100
    : null

  const cancelTask = useCancelTask(projectId)
  const taskStateMap = useTaskTargetStateMap(projectId, [
    { targetType: 'NovelPromotionPanel', targetId: panelId, types: ['image_panel'] },
  ])
  const taskState = taskStateMap.getState('NovelPromotionPanel', panelId)
  const runningTaskId = taskState?.runningTaskId || null
  const canCancel =
    !!runningTaskId &&
    !runningTaskId.startsWith('optimistic:') &&
    (taskState?.phase === 'queued' || taskState?.phase === 'processing')

  const triggerPulse = () => {
    setIsTaskPulseAnimating(true)
    setTimeout(() => setIsTaskPulseAnimating(false), 600)
  }

  const renderLoadingState = (
    intent: 'generate' | 'regenerate' | 'modify' | 'process',
    backdropImageUrl: string | null = null,
  ) => {
    const state = resolveTaskPresentationState({
      phase: 'processing',
      intent,
      resource: 'image',
      hasOutput: !!backdropImageUrl,
    })

    return (
      <div className="relative flex h-full w-full items-center justify-center overflow-hidden bg-[var(--glass-bg-surface-modal)] backdrop-blur-md group/loading">
        {backdropImageUrl && (
          <MediaImageWithLoading
            src={backdropImageUrl}
            alt={t('image.clickToPreview')}
            containerClassName="absolute inset-0 h-full w-full"
            className="absolute inset-0 h-full w-full object-cover"
            sizes="(max-width: 768px) 100vw, 33vw"
          />
        )}
        <div className={`absolute inset-0 ${backdropImageUrl ? 'bg-black/45 backdrop-blur-[1px]' : 'bg-[var(--glass-bg-surface-modal)] backdrop-blur-md'}`} />
        <TaskStatusOverlay
          state={state}
          className={backdropImageUrl ? 'bg-black/45 backdrop-blur-[1px]' : undefined}
        />
      </div>
    )
  }

  const renderFailedState = () => (
    <div className="flex h-full w-full flex-col items-center justify-center gap-1 bg-[var(--glass-danger-ring)] text-[var(--glass-tone-danger-fg)] p-2">
      <AppIcon name="alert" className="w-6 h-6 mb-1" />
      <span className="text-xs text-center font-medium">{t('image.failed')}</span>
      <span className="text-[10px] text-center mt-1 line-clamp-2 px-1">{failedError}</span>
      <button
        onClick={onClearError}
        className="glass-btn-base glass-btn-tone-danger mt-1 px-2 py-1 text-[10px] rounded-md"
      >
        {t('variant.close')}
      </button>
    </div>
  )

  const renderEmptyState = () => (
    <div className="flex h-full w-full flex-col items-center justify-center gap-2 bg-[var(--glass-bg-surface-strong)] text-[var(--glass-text-tertiary)]">
      <AppIcon name="imagePreview" className="w-8 h-8" />
      <span className="text-xs">{t('video.toolbar.showPending')}</span>
      <GlassButton
        variant="primary"
        size="sm"
        onClick={() => {
          triggerPulse()
          onRegeneratePanelImage(panelId, 1, false)
        }}
      >
        {t('panel.generateImage')}
      </GlassButton>
    </div>
  )

  return (
    <div
      className={`relative overflow-hidden group rounded-t-2xl transition-all bg-[var(--glass-bg-muted)] ${isTaskPulseAnimating ? 'animate-brightness-boost' : ''}`}
      style={{ aspectRatio: cssAspectRatio }}
    >
      {isDeleting ? (
        renderLoadingState('process', imageUrl)
      ) : isModifying ? (
        renderLoadingState('modify', imageUrl)
      ) : isSubmittingPanelImageTask ? (
        renderLoadingState('regenerate', imageUrl)
      ) : isQueued ? (
        <TaskStatusOverlay
          state={resolveTaskPresentationState({
            phase: 'queued',
            intent: 'generate',
            resource: 'image',
            hasOutput: !!imageUrl,
          })}
        />
      ) : candidateData ? (
        hasValidCandidates ? (
          <ImageSectionCandidateMode
            panelId={panelId}
            imageUrl={imageUrl}
            candidateData={candidateData}
            onSelectCandidateIndex={onSelectCandidateIndex}
            onConfirmCandidate={onConfirmCandidate}
            onCancelCandidate={onCancelCandidate}
            onPreviewImage={onPreviewImage}
          />
        ) : (
          renderLoadingState(imageUrl ? 'regenerate' : 'generate', imageUrl)
        )
      ) : failedError ? (
        renderFailedState()
      ) : imageUrl ? (
        <MediaImageWithLoading
          src={imageUrl}
          alt={t('variant.shotNum', { number: globalPanelNumber })}
          containerClassName="h-full w-full"
          className={`w-full h-full object-cover ${onPreviewImage ? 'cursor-zoom-in' : ''}`}
          onClick={onPreviewImage ? () => onPreviewImage(imageUrl) : undefined}
          title={onPreviewImage ? t('image.clickToPreview') : undefined}
          sizes="(max-width: 768px) 100vw, 33vw"
        />
      ) : (
        renderEmptyState()
      )}

      <div className="absolute top-2 left-2 flex items-center gap-1.5">
        <span className="glass-chip glass-chip-neutral px-2 py-0.5 text-xs font-medium">{globalPanelNumber}</span>
        {normalizedDuration !== null ? (
          <span className="inline-flex items-center gap-1 rounded-full border border-white/55 bg-black/70 px-2.5 py-1 text-xs font-bold text-white shadow-[0_4px_14px_rgba(0,0,0,0.35)] backdrop-blur">
            <AppIcon name="clock" className="h-3 w-3" />
            {normalizedDuration}s
          </span>
        ) : null}
      </div>

      <div className="absolute top-2 right-2">
        <div className="flex items-center gap-1">
          <span className="glass-chip glass-chip-info px-2 py-0.5 text-xs">{shotType}</span>
          {canCancel && (
            <button
              type="button"
              onClick={(e) => { e.stopPropagation(); cancelTask.mutate(runningTaskId!) }}
              disabled={cancelTask.isPending}
              className="glass-btn-base glass-btn-tone-danger h-6 w-6 rounded-md"
              title="取消任务"
            >
              <AppIcon name="close" className="w-4 h-4" />
            </button>
          )}
        </div>
      </div>

      {!candidateData && (
        <ImageSectionActionButtons
          panelId={panelId}
          imageUrl={imageUrl}
          previousImageUrl={previousImageUrl}
          isSubmittingPanelImageTask={isSubmittingPanelImageTask}
          isModifying={isModifying}
          onRegeneratePanelImage={onRegeneratePanelImage}
          onOpenEditModal={onOpenEditModal}
          onOpenAIDataModal={onOpenAIDataModal}
          onUploadImage={onUploadImage}
          onUndo={onUndo}
          triggerPulse={triggerPulse}
        />
      )}
    </div>
  )
}
