'use client'

import ProgressToast from '@/components/ProgressToast'
import ConfirmDialog from '@/components/ConfirmDialog'
import { AnimatedBackground } from '@/components/ui/SharedComponents'
import { useTranslations } from 'next-intl'
import { WorkspaceProvider, useWorkspaceProvider } from './WorkspaceProvider'
import WorkspaceRunStreamConsoles from './components/WorkspaceRunStreamConsoles'
import WorkspaceStageContent from './components/WorkspaceStageContent'
import WorkspaceAssetLibraryModal from './components/WorkspaceAssetLibraryModal'
import WorkspaceHeaderShell from './components/WorkspaceHeaderShell'
import { WorkspaceStageRuntimeProvider } from './WorkspaceStageRuntimeContext'
import { useNovelPromotionWorkspaceController } from './hooks/useNovelPromotionWorkspaceController'
import type { NovelPromotionWorkspaceProps } from './types'
import { TaskQueueProvider } from '@/lib/task-queue'
import { parseModelKeyStrict } from '@/lib/model-config-contract'
import QueueProgressPopup from '@/components/task/QueueProgressPopup'
import '@/styles/animations.css'

function NovelPromotionWorkspaceContent(props: NovelPromotionWorkspaceProps) {
  const vm = useNovelPromotionWorkspaceController(props)
  const tProgress = useTranslations('progress')
  const workspace = useWorkspaceProvider()

  const {
    project,
    projectId,
    episodeId,
    episodes = [],
    onEpisodeSelect,
    onEpisodeCreate,
    onEpisodeRename,
    onEpisodeDelete,
  } = props

  const storyToScriptStream = vm.execution.storyToScriptStream
  const scriptToStoryboardStream = vm.execution.scriptToStoryboardStream
  const storyToScriptActive =
    storyToScriptStream.isRunning ||
    storyToScriptStream.isRecoveredRunning ||
    storyToScriptStream.status === 'running'
  const scriptToStoryboardActive =
    scriptToStoryboardStream.isRunning ||
    scriptToStoryboardStream.isRecoveredRunning ||
    scriptToStoryboardStream.status === 'running'

  const showStoryToScriptMinBadge =
    storyToScriptStream.isVisible &&
    storyToScriptActive &&
    vm.execution.storyToScriptConsoleMinimized

  const showScriptToStoryboardMinBadge =
    scriptToStoryboardStream.isVisible &&
    scriptToStoryboardActive &&
    vm.execution.scriptToStoryboardConsoleMinimized

  const runBadges: { id: string; label: string; onClick: () => void }[] = []

  if (showStoryToScriptMinBadge) {
    runBadges.push({
      id: 'story-to-script',
      label: tProgress('runConsole.storyToScriptRunning'),
      onClick: () => vm.execution.setStoryToScriptConsoleMinimized(false),
    })
  }

  if (showScriptToStoryboardMinBadge) {
    runBadges.push({
      id: 'script-to-storyboard',
      label: tProgress('runConsole.scriptToStoryboardRunning'),
      onClick: () => vm.execution.setScriptToStoryboardConsoleMinimized(false),
    })
  }

  if (!vm.project.projectData) {
    return <div className="text-center text-(--glass-text-secondary)">{vm.i18n.tc('loading')}</div>
  }

  const storyboardModelProvider = parseModelKeyStrict(vm.project.storyboardModel)?.provider || null
  const videoModelProvider = parseModelKeyStrict(vm.project.videoModel)?.provider || null
  const allowParallelStoryboardVideo =
    !(storyboardModelProvider === 'local' && videoModelProvider === 'local')

  return (
    <TaskQueueProvider
      projectId={projectId}
      enabled={vm.project.progressPopupEnabled === true}
      allowParallelStoryboardVideo={allowParallelStoryboardVideo}
      subscribeTaskEvents={workspace.subscribeTaskEvents}
    >
      <div>
        <AnimatedBackground />

        <WorkspaceHeaderShell
          isSettingsModalOpen={vm.ui.isSettingsModalOpen}
          isWorldContextModalOpen={vm.ui.isWorldContextModalOpen}
          onCloseSettingsModal={() => vm.ui.setIsSettingsModalOpen(false)}
          onCloseWorldContextModal={() => vm.ui.setIsWorldContextModalOpen(false)}
          availableModels={vm.ui.userModelsForSettings || undefined}
          modelsLoaded={vm.ui.userModelsLoaded}
          artStyle={vm.project.artStyle}
          analysisModel={vm.project.analysisModel}
          characterModel={vm.project.characterModel}
          locationModel={vm.project.locationModel}
          storyboardModel={vm.project.storyboardModel}
          editModel={vm.project.editModel}
          videoModel={vm.project.videoModel}
          audioModel={vm.project.audioModel}
          capabilityOverrides={vm.project.capabilityOverrides}
          videoRatio={vm.project.videoRatio}
          ttsRate={vm.project.ttsRate !== undefined && vm.project.ttsRate !== null ? String(vm.project.ttsRate) : undefined}
          localImageWidth={vm.project.localImageWidth}
          localImageHeight={vm.project.localImageHeight}
          localImageSteps={vm.project.localImageSteps}
          localT2IWidth={vm.project.localT2IWidth}
          localT2IHeight={vm.project.localT2IHeight}
          localT2ISteps={vm.project.localT2ISteps}
          localI2IWidth={vm.project.localI2IWidth}
          localI2IHeight={vm.project.localI2IHeight}
          localI2ISteps={vm.project.localI2ISteps}
          localStoryboardPromptRefineEnabled={vm.project.localStoryboardPromptRefineEnabled}
          localStoryboardPromptRefineLevel={vm.project.localStoryboardPromptRefineLevel}
          localStoryboardUsePanelDescriptionEnabled={vm.project.localStoryboardUsePanelDescriptionEnabled}
          progressPopupEnabled={vm.project.progressPopupEnabled}
          onUpdateConfig={vm.actions.handleUpdateConfig}
          globalAssetText={vm.project.globalAssetText}
          projectName={project.name}
          episodes={episodes}
          currentEpisodeId={episodeId}
          onEpisodeSelect={onEpisodeSelect}
          onEpisodeCreate={onEpisodeCreate}
          onEpisodeRename={onEpisodeRename}
          onEpisodeDelete={onEpisodeDelete}
          capsuleNavItems={vm.stageNav.capsuleNavItems}
          currentStage={vm.stageNav.currentStage}
          onStageChange={vm.stageNav.handleStageChange}
          projectId={projectId}
          episodeId={episodeId}
          onOpenAssetLibrary={() => vm.ui.openAssetLibrary()}
          onOpenSettingsModal={() => vm.ui.setIsSettingsModalOpen(true)}
          onRefresh={() => vm.ui.onRefresh({ mode: 'full' })}
          assetLibraryLabel={vm.i18n.t('buttons.assetLibrary')}
          settingsLabel={vm.i18n.t('buttons.settings')}
          refreshTitle={vm.i18n.t('buttons.refreshData')}
        />

        <QueueProgressPopup />

        <div className="pt-24">
          <WorkspaceStageRuntimeProvider value={vm.runtime.stageRuntime}>
            <WorkspaceStageContent currentStage={vm.stageNav.currentStage} />
          </WorkspaceStageRuntimeProvider>

        <WorkspaceAssetLibraryModal
          isOpen={vm.ui.isAssetLibraryOpen}
          onClose={vm.ui.closeAssetLibrary}
          assetsLoading={vm.ui.assetsLoading}
          assetsLoadingState={vm.ui.assetsLoadingState}
          hasCharacters={vm.project.projectCharacters.length > 0}
          hasLocations={vm.project.projectLocations.length > 0}
          projectId={projectId}
          isAnalyzingAssets={vm.execution.isAssetAnalysisRunning}
          focusCharacterId={vm.ui.assetLibraryFocusCharacterId}
          focusCharacterRequestId={vm.ui.assetLibraryFocusRequestId}
          triggerGlobalAnalyze={vm.ui.triggerGlobalAnalyzeOnOpen}
          onGlobalAnalyzeComplete={() => vm.ui.setTriggerGlobalAnalyzeOnOpen(false)}
        />

        {vm.execution.showCreatingToast && (
          <ProgressToast
            show
            message={vm.i18n.t('storyInput.creating')}
            step={vm.execution.transitionProgress.step || ''}
            runBadges={runBadges}
          />
        )}

        <ConfirmDialog
          show={vm.rebuild.showRebuildConfirm}
          type="warning"
          title={vm.rebuild.rebuildConfirmTitle}
          message={vm.rebuild.rebuildConfirmMessage}
          confirmText={vm.i18n.t('rebuildConfirm.confirm')}
          cancelText={vm.i18n.t('rebuildConfirm.cancel')}
          onConfirm={vm.rebuild.handleAcceptRebuildConfirm}
          onCancel={vm.rebuild.handleCancelRebuildConfirm}
        />

        <WorkspaceRunStreamConsoles
          storyToScriptStream={vm.execution.storyToScriptStream}
          scriptToStoryboardStream={vm.execution.scriptToStoryboardStream}
          storyToScriptConsoleMinimized={vm.execution.storyToScriptConsoleMinimized}
          scriptToStoryboardConsoleMinimized={vm.execution.scriptToStoryboardConsoleMinimized}
          onStoryToScriptMinimizedChange={vm.execution.setStoryToScriptConsoleMinimized}
          onScriptToStoryboardMinimizedChange={vm.execution.setScriptToStoryboardConsoleMinimized}
          hideMinimizedBadges={vm.execution.showCreatingToast}
        />
        </div>
      </div>
    </TaskQueueProvider>
  )
}

export default function NovelPromotionWorkspace(props: NovelPromotionWorkspaceProps) {
  const { projectId, episodeId } = props

  return (
    <WorkspaceProvider
      projectId={projectId}
      episodeId={episodeId}
      invalidateMode={props.project.novelPromotionData?.progressPopupEnabled ? 'minimal' : 'default'}
    >
      <NovelPromotionWorkspaceContent {...props} />
    </WorkspaceProvider>
  )
}
