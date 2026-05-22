'use client'

import { NovelPromotionStoryboard, NovelPromotionClip } from '@/types/project'
import { CharacterPickerModal, LocationPickerModal, PropPickerModal } from '../PanelEditForm'
import ImageEditModal from './ImageEditModal'
import AIDataModal from './AIDataModal'
import ImagePreviewModal from '@/components/ui/ImagePreviewModal'
import StoryboardStageShell from './StoryboardStageShell'
import StoryboardToolbar from './StoryboardToolbar'
import StoryboardCanvas from './StoryboardCanvas'
import { useStoryboardStageController } from './hooks/useStoryboardStageController'
import { useStoryboardModalRuntime } from './hooks/useStoryboardModalRuntime'
import { useDeleteProjectPanelFrame, useUpdateProjectPanelFramePrompt, useUpdateProjectPanelFrameTime } from '@/lib/query/hooks'
import { toDisplayImageUrl } from '@/lib/media/image-url'

interface StoryboardStageProps {
  projectId: string
  episodeId: string
  storyboards: NovelPromotionStoryboard[]
  clips: NovelPromotionClip[]
  videoRatio: string
  onBack: () => void
  onNext: () => void
  isTransitioning?: boolean
}

export default function StoryboardStage({
  projectId,
  episodeId,
  storyboards: initialStoryboards,
  clips,
  videoRatio,
  onBack,
  onNext,
  isTransitioning = false,
}: StoryboardStageProps) {
  const controller = useStoryboardStageController({
    projectId,
    episodeId,
    initialStoryboards,
    clips,
    isTransitioning,
  })

  const {
    localStoryboards,
    setLocalStoryboards,
    sortedStoryboards,
    expandedClips,
    toggleExpandedClip,
    getClipInfo,
    getTextPanels,
    getPanelEditData,
    updatePanelEdit,
    formatClipTitle,
    totalPanels,
    storyboardStartIndex,

    savingPanels,
    deletingPanelIds,
    saveStateByPanel,
    hasUnsavedByPanel,
    submittingStoryboardTextIds,
    addingStoryboardGroup,
    movingClipId,
    insertingAfterPanelId,
    savePanelWithData,
    addPanel,
    deletePanel,
    deleteStoryboard,
    regenerateStoryboardText,
    addStoryboardGroup,
    moveStoryboardGroup,
    insertPanel,
    duplicatePanel,
    splitPanelFrame,

    submittingVariantPanelId,
    generatePanelVariant,

    submittingStoryboardIds,
    submittingPanelImageIds,
    selectingCandidateIds,

    editingPanel,
    setEditingPanel,
    modifyingPanels,
    isDownloadingImages,
    previewImage,
    setPreviewImage,
    regeneratePanelImage,
    regenerateAllPanelsIndividually,
    selectPanelCandidate,
    selectPanelCandidateIndex,
    cancelPanelCandidate,
    getPanelCandidates,
    uploadPanelImage,
    uploadPanelImageFromSource,
    uploadPanelFrameImage,
    uploadPanelFrameImageFromSource,
    regeneratePanelFrameImage,
    downloadAllImages,
    clearStoryboardError,

    assetPickerPanel,
    setAssetPickerPanel,
    aiDataPanel,
    setAIDataPanel,
    isEpisodeBatchSubmitting,

    getDefaultAssetsForClip,
    handleEditSubmit,
    handlePanelUpdate,
    handleAddCharacter,
    handleSetLocation,
    handleAddProp,
    handleRemoveCharacter,
    handleRemoveLocation,
    handleRemoveProp,
    retrySave,

    updatePhotographyPlanMutation,
    updatePanelActingNotesMutation,

    addingStoryboardGroupState,
    transitioningState,
    runningCount,
    pendingPanelCount,
    handleGenerateAllPanels,
  } = controller

  const modalRuntime = useStoryboardModalRuntime({
    projectId,
    videoRatio,
    localStoryboards,
    editingPanel,
    setEditingPanel,
    assetPickerPanel,
    setAssetPickerPanel,
    aiDataPanel,
    setAIDataPanel,
    previewImage,
    setPreviewImage,
    getTextPanels,
    getPanelEditData,
    updatePanelEdit,
    savePanelWithData,
    getDefaultAssetsForClip,
    handleEditSubmit,
    handleAddCharacter,
    handleSetLocation,
    handleAddProp,
    updatePhotographyPlanMutation,
    updatePanelActingNotesMutation,
  })

  const updatePanelFrameTimeMutation = useUpdateProjectPanelFrameTime(projectId)
  const updatePanelFramePromptMutation = useUpdateProjectPanelFramePrompt(projectId)
  const deletePanelFrameMutation = useDeleteProjectPanelFrame(projectId)
  const updatePanelFrameTime = async (frameId: string, frameTimeSec: number) => {
    const result = await updatePanelFrameTimeMutation.mutateAsync({ frameId, frameTimeSec })
    setLocalStoryboards((prev) =>
      prev.map((storyboard) => ({
        ...storyboard,
        panels: storyboard.panels?.map((panel) => ({
          ...panel,
          frames: panel.frames?.map((frame) =>
            frame.id === frameId
              ? { ...frame, frameTimeSec: result.frameTimeSec ?? frameTimeSec }
              : frame,
          ),
        })),
      })),
    )
  }
  const deletePanelFrame = async (panelId: string, frameId: string) => {
    const result = await deletePanelFrameMutation.mutateAsync({ frameId })
    const nextImageUrl = toDisplayImageUrl(result.imageUrl) || result.imageUrl
    const nextFrames = result.frames.map((frame) => ({
      ...frame,
      imageUrl: toDisplayImageUrl(frame.imageUrl) || frame.imageUrl,
    }))
    setLocalStoryboards((prev) =>
      prev.map((storyboard) => ({
        ...storyboard,
        panels: storyboard.panels?.map((panel) => {
          if (panel.id !== panelId && panel.id !== result.panelId) return panel
          return {
            ...panel,
            panelMode: result.panelMode,
            imageUrl: nextImageUrl,
            groupDurationSec: result.groupDurationSec,
            groupVideoPrompt: result.groupVideoPrompt,
            groupPlanJson: result.groupPlanJson,
            candidateImages: null,
            frames: nextFrames,
          }
        }),
      })),
    )
  }
  const updatePanelFramePrompt = async (frameId: string, imagePrompt: string) => {
    const result = await updatePanelFramePromptMutation.mutateAsync({ frameId, imagePrompt })
    setLocalStoryboards((prev) =>
      prev.map((storyboard) => ({
        ...storyboard,
        panels: storyboard.panels?.map((panel) => ({
          ...panel,
          frames: panel.frames?.map((frame) =>
            frame.id === frameId
              ? { ...frame, imagePrompt: result.imagePrompt, videoPrompt: result.videoPrompt }
              : frame,
          ),
        })),
      })),
    )
  }

  return (
      <StoryboardStageShell
        isTransitioning={isTransitioning}
        isNextDisabled={isTransitioning || localStoryboards.length === 0}
        transitioningState={transitioningState}
        onNext={onNext}
      >
        <StoryboardToolbar
          totalSegments={sortedStoryboards.length}
          totalPanels={totalPanels}
          isDownloadingImages={isDownloadingImages}
          runningCount={runningCount}
          pendingPanelCount={pendingPanelCount}
          isBatchSubmitting={isEpisodeBatchSubmitting}
          addingStoryboardGroup={addingStoryboardGroup}
          addingStoryboardGroupState={addingStoryboardGroupState}
          onDownloadAllImages={downloadAllImages}
          onGenerateAllPanels={handleGenerateAllPanels}
          onAddStoryboardGroupAtStart={() => addStoryboardGroup(0)}
          onBack={onBack}
        />

        <StoryboardCanvas
          sortedStoryboards={sortedStoryboards}
          videoRatio={videoRatio}
          expandedClips={expandedClips}
          submittingStoryboardIds={submittingStoryboardIds}
          selectingCandidateIds={selectingCandidateIds}
          submittingStoryboardTextIds={submittingStoryboardTextIds}
          savingPanels={savingPanels}
          deletingPanelIds={deletingPanelIds}
          saveStateByPanel={saveStateByPanel}
          hasUnsavedByPanel={hasUnsavedByPanel}
          modifyingPanels={modifyingPanels}
          submittingPanelImageIds={submittingPanelImageIds}

          movingClipId={movingClipId}
          insertingAfterPanelId={insertingAfterPanelId}
          submittingVariantPanelId={submittingVariantPanelId}
          projectId={projectId}
          episodeId={episodeId}
          storyboardStartIndex={storyboardStartIndex}
          getClipInfo={getClipInfo}
          getTextPanels={getTextPanels}
          getPanelEditData={getPanelEditData}
          formatClipTitle={formatClipTitle}
          onToggleExpandedClip={toggleExpandedClip}
          onMoveStoryboardGroup={moveStoryboardGroup}
          onRegenerateStoryboardText={regenerateStoryboardText}
          onAddPanel={addPanel}
          onDeleteStoryboard={deleteStoryboard}
          onGenerateAllIndividually={regenerateAllPanelsIndividually}
          onPreviewImage={setPreviewImage}
          onCloseStoryboardError={clearStoryboardError}
          onPanelUpdate={handlePanelUpdate}
          onPanelDelete={deletePanel}
          onOpenCharacterPicker={(panelId) => setAssetPickerPanel({ panelId, type: 'character' })}
          onOpenLocationPicker={(panelId) => setAssetPickerPanel({ panelId, type: 'location' })}
          onOpenPropPicker={(panelId) => setAssetPickerPanel({ panelId, type: 'prop' })}
          onRemoveCharacter={handleRemoveCharacter}
          onRemoveLocation={handleRemoveLocation}
          onRemoveProp={handleRemoveProp}
          onRetryPanelSave={retrySave}
          onRegeneratePanelImage={regeneratePanelImage}
          onUploadImage={uploadPanelImage}
          onUploadImageFromSource={uploadPanelImageFromSource}
          onUploadFrameImage={uploadPanelFrameImage}
          onUploadFrameImageFromSource={uploadPanelFrameImageFromSource}
          onRegenerateFrameImage={async (panelId, frameId) => {
            await regeneratePanelFrameImage(panelId, frameId)
          }}
          onUpdateFrameTime={updatePanelFrameTime}
          onUpdateFramePrompt={updatePanelFramePrompt}
          onDeleteFrame={deletePanelFrame}
          onSplitFrame={splitPanelFrame}
          onOpenEditModal={(storyboardId, panelIndex) => setEditingPanel({ storyboardId, panelIndex })}
          onOpenAIDataModal={(storyboardId, panelIndex) => setAIDataPanel({ storyboardId, panelIndex })}
          getPanelCandidates={getPanelCandidates}
          onSelectPanelCandidateIndex={selectPanelCandidateIndex}
          onConfirmPanelCandidate={selectPanelCandidate}
          onCancelPanelCandidate={cancelPanelCandidate}

          onInsertPanel={insertPanel}
          onDuplicatePanel={duplicatePanel}
          onPanelVariant={generatePanelVariant}
          addStoryboardGroup={addStoryboardGroup}
          addingStoryboardGroup={addingStoryboardGroup}
          setLocalStoryboards={setLocalStoryboards}
        />

        {modalRuntime.editingPanel && (
          <ImageEditModal
            projectId={modalRuntime.projectId}
            defaultAssets={modalRuntime.imageEditDefaults}
            onSubmit={modalRuntime.handleEditSubmit}
            onClose={modalRuntime.closeImageEditModal}
          />
        )}

        {modalRuntime.aiDataPanel && modalRuntime.aiDataRuntime && (
          <AIDataModal
            isOpen={true}
            onClose={modalRuntime.closeAIDataModal}
            syncKey={modalRuntime.aiDataRuntime.panel.id}
            panelNumber={modalRuntime.aiDataRuntime.panelData.panelNumber || modalRuntime.aiDataPanel.panelIndex + 1}
            shotType={modalRuntime.aiDataRuntime.panelData.shotType}
            cameraMove={modalRuntime.aiDataRuntime.panelData.cameraMove}
            description={modalRuntime.aiDataRuntime.panelData.description}
            location={modalRuntime.aiDataRuntime.panelData.location}
            characters={modalRuntime.aiDataRuntime.characters}
            props={modalRuntime.aiDataRuntime.panelData.props}
            imagePrompt={modalRuntime.aiDataRuntime.panel.image_prompt || null}
            sourceText={modalRuntime.aiDataRuntime.panelData.sourceText || null}
            videoPrompt={modalRuntime.aiDataRuntime.panelData.videoPrompt}
            photographyRules={modalRuntime.aiDataRuntime.photographyRules}
            actingNotes={modalRuntime.aiDataRuntime.actingNotes}
            videoRatio={modalRuntime.videoRatio}
            onSave={modalRuntime.handleSaveAIData}
          />
        )}

        {modalRuntime.previewImage && (
          <ImagePreviewModal imageUrl={modalRuntime.previewImage} onClose={modalRuntime.closePreviewImage} />
        )}

        {modalRuntime.hasCharacterPicker && (
          <CharacterPickerModal
            projectId={projectId}
            currentCharacters={modalRuntime.pickerPanelRuntime ? getPanelEditData(modalRuntime.pickerPanelRuntime.panel).characters : []}
            onSelect={modalRuntime.handleAddCharacter}
            onClose={modalRuntime.closeAssetPicker}
          />
        )}

        {modalRuntime.hasLocationPicker && (
          <LocationPickerModal
            projectId={projectId}
            currentLocation={modalRuntime.pickerPanelRuntime ? getPanelEditData(modalRuntime.pickerPanelRuntime.panel).location || null : null}
            onSelect={modalRuntime.handleSetLocation}
            onClose={modalRuntime.closeAssetPicker}
          />
        )}

        {modalRuntime.hasPropPicker && (
          <PropPickerModal
            projectId={projectId}
            currentProps={modalRuntime.pickerPanelRuntime ? getPanelEditData(modalRuntime.pickerPanelRuntime.panel).props : []}
            onSelect={modalRuntime.handleAddProp}
            onClose={modalRuntime.closeAssetPicker}
          />
        )}
      </StoryboardStageShell>
  )
}
