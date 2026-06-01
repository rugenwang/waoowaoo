'use client'

import { useMemo } from 'react'
import { NovelPromotionPanel } from '@/types/project'
import { StoryboardPanel } from './hooks/useStoryboardState'
import { PanelEditData } from '../PanelEditForm'
import { ASPECT_RATIO_CONFIGS } from '@/lib/constants'
import PanelCard from './PanelCard'
import type { PreviousPanelImageOption } from './PanelCard'
import type { PanelSaveState } from './hooks/usePanelCrudActions'
import { useTaskQueue } from '@/lib/task-queue'

interface StoryboardPanelListProps {
  projectId: string
  storyboardId: string
  textPanels: StoryboardPanel[]
  storyboardStartIndex: number
  videoRatio: string
  isSubmittingStoryboardTextTask: boolean
  savingPanels: Set<string>
  deletingPanelIds: Set<string>
  saveStateByPanel: Record<string, PanelSaveState>
  hasUnsavedByPanel: Set<string>
  modifyingPanels: Set<string>
  panelTaskErrorMap: Map<string, { taskId: string; message: string }>
  isPanelTaskRunning: (panel: StoryboardPanel) => boolean
  getPanelEditData: (panel: StoryboardPanel) => PanelEditData
  getPanelCandidates: (panel: NovelPromotionPanel) => { candidates: string[]; selectedIndex: number } | null
  onPanelUpdate: (panelId: string, panel: StoryboardPanel, updates: Partial<PanelEditData>) => void
  onPanelDelete: (panelId: string) => void
  onOpenCharacterPicker: (panelId: string) => void
  onOpenLocationPicker: (panelId: string) => void
  onOpenPropPicker: (panelId: string) => void
  onRemoveCharacter: (panel: StoryboardPanel, index: number) => void
  onRemoveLocation: (panel: StoryboardPanel) => void
  onRemoveProp: (panel: StoryboardPanel, index: number) => void
  onRetryPanelSave: (panelId: string) => void
  onRegeneratePanelImage: (panelId: string, count?: number, force?: boolean) => void
  onUploadImage?: (panelId: string, file: File) => void | Promise<void>
  onUploadImageFromSource?: (panelId: string, sourceImageUrl: string) => void | Promise<void>
  onUploadFrameImage?: (frameId: string, file: File) => void | Promise<void>
  onUploadFrameImageFromSource?: (frameId: string, sourceImageUrl: string) => void | Promise<void>
  onRegenerateFrameImage?: (panelId: string, frameId: string) => void | Promise<void>
  onUpdateFrameTime?: (frameId: string, frameTimeSec: number) => void | Promise<void>
  onUpdateFramePrompt?: (frameId: string, imagePrompt: string) => void | Promise<void>
  onInsertFrame?: (payload: { panelId?: string; frameId?: string; placement?: 'before' | 'after' }) => void | Promise<void>
  onDeleteFrame?: (panelId: string, frameId: string) => void | Promise<void>
  onSplitFrame?: (frameId: string, placement: 'before' | 'after') => void | Promise<void>
  onToggleUsePreviousPanelTailReference: (payload: {
    panelId: string
    storyboardId: string
    panelIndex: number
    usePreviousPanelTailAsReference: boolean
  }) => Promise<void>
  onOpenEditModal: (panelIndex: number) => void
  onOpenAIDataModal: (panelIndex: number) => void
  onSelectPanelCandidateIndex: (panelId: string, index: number) => void
  onConfirmPanelCandidate: (panelId: string, imageUrl: string) => Promise<void>
  onCancelPanelCandidate: (panelId: string) => void
  onClearPanelTaskError: (panelId: string) => void
  onPreviewImage: (url: string) => void
  onInsertAfter: (panelIndex: number) => void
  onDuplicatePanel: (panelId: string) => Promise<void>
  onMergePanelWithNext: (panelId: string) => Promise<void>
  onVariant: (panelIndex: number) => void
  isInsertDisabled: (panelId: string) => boolean
  previousPanelImageOptionsByPanelId?: Record<string, PreviousPanelImageOption[]>
}

export default function StoryboardPanelList({
  projectId,
  storyboardId,
  textPanels,
  storyboardStartIndex,
  videoRatio,
  isSubmittingStoryboardTextTask,
  savingPanels,
  deletingPanelIds,
  saveStateByPanel,
  hasUnsavedByPanel,
  modifyingPanels,
  panelTaskErrorMap,
  isPanelTaskRunning,
  getPanelEditData,
  getPanelCandidates,
  onPanelUpdate,
  onPanelDelete,
  onOpenCharacterPicker,
  onOpenLocationPicker,
  onOpenPropPicker,
  onRemoveCharacter,
  onRemoveLocation,
  onRemoveProp,
  onRetryPanelSave,
  onRegeneratePanelImage,
  onUploadImage,
  onUploadImageFromSource,
  onUploadFrameImage,
  onUploadFrameImageFromSource,
  onRegenerateFrameImage,
  onUpdateFrameTime,
  onUpdateFramePrompt,
  onInsertFrame,
  onDeleteFrame,
  onSplitFrame,
  onToggleUsePreviousPanelTailReference,
  onOpenEditModal,
  onOpenAIDataModal,
  onSelectPanelCandidateIndex,
  onConfirmPanelCandidate,
  onCancelPanelCandidate,
  onClearPanelTaskError,
  onPreviewImage,
  onInsertAfter,
  onDuplicatePanel,
  onMergePanelWithNext,
  onVariant,
  isInsertDisabled,
  previousPanelImageOptionsByPanelId,
}: StoryboardPanelListProps) {
  const taskQueue = useTaskQueue()
  const queuedPanelIds = useMemo(() => {
    if (!taskQueue.enabled) return new Set<string>()
    const next = new Set<string>()
    for (const item of taskQueue.queue) {
      if (item.status !== 'pending') continue
      if (item.group !== 'storyboard') continue
      if (item.target.targetType !== 'NovelPromotionPanel') continue
      next.add(item.target.targetId)
    }
    return next
  }, [taskQueue.enabled, taskQueue.queue])

  const displayImages = useMemo(() => textPanels.map((panel) => panel.imageUrl || null), [textPanels])
  const isVertical = ASPECT_RATIO_CONFIGS[videoRatio]?.isVertical ?? false

  return (
    <div className={`grid gap-4 ${isVertical ? 'grid-cols-5' : 'grid-cols-3'} ${isSubmittingStoryboardTextTask ? 'opacity-50 pointer-events-none' : ''}`}>
      {textPanels.map((panel, index) => {
        const imageUrl = displayImages[index]
        const globalPanelNumber = storyboardStartIndex + index + 1
        const isPanelModifying =
          modifyingPanels.has(panel.id) ||
          Boolean(
            (panel as StoryboardPanel & { imageTaskRunning?: boolean; imageTaskIntent?: string }).imageTaskRunning &&
            (panel as StoryboardPanel & { imageTaskIntent?: string }).imageTaskIntent === 'modify',
          )
        const isPanelDeleting = deletingPanelIds.has(panel.id)
        const panelSaveState = saveStateByPanel[panel.id]
        const isPanelSaving = savingPanels.has(panel.id) || panelSaveState?.status === 'saving'
        const hasUnsavedChanges = hasUnsavedByPanel.has(panel.id) || panelSaveState?.status === 'error'
        const panelSaveError = panelSaveState?.errorMessage || null
        const panelTaskRunning = isPanelTaskRunning(panel)
        const taskError = panelTaskErrorMap.get(panel.id)
        const panelFailedError = taskError?.message || null
        const panelData = getPanelEditData(panel)
        const panelCandidateData = getPanelCandidates(panel as unknown as NovelPromotionPanel)
        const previousPanelImageOptions = previousPanelImageOptionsByPanelId?.[panel.id] || []
        const hasPreviousPanel = globalPanelNumber > 1 || previousPanelImageOptions.length > 0

        return (
          <div
            key={panel.id || index}
            className="relative group/panel h-full"
            style={{ zIndex: textPanels.length - index }}
          >
            <PanelCard
              projectId={projectId}
              panel={panel}
              panelData={panelData}
              imageUrl={imageUrl}
              globalPanelNumber={globalPanelNumber}
              storyboardId={storyboardId}
              videoRatio={videoRatio}
              isSaving={isPanelSaving}
              hasUnsavedChanges={hasUnsavedChanges}
              saveErrorMessage={panelSaveError}
              isDeleting={isPanelDeleting}
              isModifying={isPanelModifying}
              isSubmittingPanelImageTask={panelTaskRunning}
              isQueued={queuedPanelIds.has(panel.id)}
              failedError={panelFailedError}
              candidateData={panelCandidateData}
              onUpdate={(updates) => onPanelUpdate(panel.id, panel, updates)}
              onDelete={() => onPanelDelete(panel.id)}
              onOpenCharacterPicker={() => onOpenCharacterPicker(panel.id)}
              onOpenLocationPicker={() => onOpenLocationPicker(panel.id)}
              onOpenPropPicker={() => onOpenPropPicker(panel.id)}
              onRetrySave={() => onRetryPanelSave(panel.id)}
              onRemoveCharacter={(characterIndex) => onRemoveCharacter(panel, characterIndex)}
              onRemoveLocation={() => onRemoveLocation(panel)}
              onRemoveProp={(propIndex) => onRemoveProp(panel, propIndex)}
              onRegeneratePanelImage={onRegeneratePanelImage}
              onUploadImage={onUploadImage}
              onUploadImageFromSource={onUploadImageFromSource}
              onUploadFrameImage={onUploadFrameImage}
              onUploadFrameImageFromSource={onUploadFrameImageFromSource}
              onRegenerateFrameImage={onRegenerateFrameImage}
              onUpdateFrameTime={onUpdateFrameTime}
              onUpdateFramePrompt={onUpdateFramePrompt}
              onInsertFrame={onInsertFrame}
              onDeleteFrame={onDeleteFrame}
              onSplitFrame={onSplitFrame}
              onToggleUsePreviousPanelTail={(enabled) =>
                onToggleUsePreviousPanelTailReference({
                  panelId: panel.id,
                  storyboardId,
                  panelIndex: panel.panelIndex,
                  usePreviousPanelTailAsReference: enabled,
                })
              }
              onOpenEditModal={() => onOpenEditModal(index)}
              onOpenAIDataModal={() => onOpenAIDataModal(index)}
              onSelectCandidateIndex={onSelectPanelCandidateIndex}
              onConfirmCandidate={onConfirmPanelCandidate}
              onCancelCandidate={onCancelPanelCandidate}
              onClearError={() => onClearPanelTaskError(panel.id)}
              onPreviewImage={onPreviewImage}
              onInsertAfter={() => onInsertAfter(index)}
              onDuplicatePanel={() => onDuplicatePanel(panel.id)}
              onMergePanelWithNext={index < textPanels.length - 1 ? () => onMergePanelWithNext(panel.id) : undefined}
              onVariant={() => onVariant(index)}
              isInsertDisabled={isInsertDisabled(panel.id)}
              hasPreviousPanel={hasPreviousPanel}
              previousPanelImageOptions={previousPanelImageOptions}
            />
          </div>
        )
      })}
    </div>
  )
}
