import React, { useMemo, useState } from 'react'
import { createPortal } from 'react-dom'
import RegenerateVideoPromptModal from '../../RegenerateVideoPromptModal'
import PanelDubbingDialog from './PanelDubbingDialog'
import TaskStatusInline from '@/components/task/TaskStatusInline'
import { resolveTaskPresentationState } from '@/lib/task/presentation'
import { ModelCapabilityDropdown } from '@/components/ui/config-modals/ModelCapabilityDropdown'
import { AppIcon } from '@/components/ui/icons'
import type { VideoPanelRuntime } from './hooks/useVideoPanelActions'
import { useUpdateProjectPanelDuration } from '@/lib/query/mutations/useVideoMutations'
import { useRegenerateProjectVideoPrompt } from '@/lib/query/hooks'
import { shouldShowError } from '@/lib/error-utils'
import { extractErrorMessage } from '@/lib/errors/extract'

interface VideoPanelCardBodyProps {
  runtime: VideoPanelRuntime
}

export default function VideoPanelCardBody({ runtime }: VideoPanelCardBodyProps) {
  const {
    t,
    tCommon,
    panel,
    panelIndex,
    panelKey,
    layout,
    actions,
    taskStatus,
    videoModel,
    promptEditor,
    voiceManager,
    lipSync,
    computed,
  } = runtime

  const updateDurationMutation = useUpdateProjectPanelDuration(runtime.layout.projectId)
  const regenerateVideoPrompt = useRegenerateProjectVideoPrompt(runtime.layout.projectId)
  const currentDuration = panel.textPanel?.duration
  const [isEditingDuration, setIsEditingDuration] = useState(false)
  const [editingDuration, setEditingDuration] = useState<string>('')
  const [promptModalOpen, setPromptModalOpen] = useState(false)
  const [dubbingMode, setDubbingMode] = useState<'video-vocal' | 'character-voice' | null>(null)
  const [promptRequirement, setPromptRequirement] = useState('')
  const [promptCandidate, setPromptCandidate] = useState<string | null>(null)
  const durationSuffix = useMemo(() => t('promptModal.duration'), [t])
  const inheritedFirstLastGenerationOptions = useMemo(
    () => {
      const next = { ...layout.flGenerationOptions }
      const fieldDefaults = new Map(
        layout.flCapabilityFields.map((field) => [field.field, field.options[0]]),
      )
      for (const [field, value] of Object.entries(videoModel.generationOptions)) {
        if (field === 'duration') continue
        const flValue = layout.flGenerationOptions[field]
        const defaultValue = fieldDefaults.get(field)
        const isFlOnlyDefault =
          flValue === undefined
          || (
            defaultValue !== undefined
            && String(flValue) === String(defaultValue)
            && String(value) !== String(defaultValue)
          )
        if (isFlOnlyDefault) {
          next[field] = value
        }
      }
      return next
    },
    [layout.flCapabilityFields, layout.flGenerationOptions, videoModel.generationOptions],
  )

  const beginEditDuration = () => {
    setEditingDuration(currentDuration ? String(currentDuration) : '')
    setIsEditingDuration(true)
  }

  const saveDuration = async () => {
    const raw = editingDuration.trim()
    const next = raw === '' ? null : Number(raw)
    if (next !== null && (!Number.isFinite(next) || next <= 0 || !Number.isInteger(next))) return
    await updateDurationMutation.mutateAsync({
      storyboardId: panel.storyboardId,
      panelIndex: panel.panelIndex,
      duration: next,
    })
    setIsEditingDuration(false)
  }
  const safeTranslate = (key: string | undefined, fallback = ''): string => {
    if (!key) return fallback
    try {
      return t(key as never)
    } catch {
      return fallback
    }
  }

  const renderCapabilityLabel = (field: {
    field: string
    label: string
    labelKey?: string
    unitKey?: string
  }): string => {
    const labelText = safeTranslate(field.labelKey, safeTranslate(`capability.${field.field}`, field.label))
    const unitText = safeTranslate(field.unitKey)
    return unitText ? `${labelText} (${unitText})` : labelText
  }

  const isFirstLastFrameGenerated = panel.videoGenerationMode === 'firstlastframe' && !!panel.videoUrl
  const hasDialogueForDubbing = voiceManager.localVoiceLines.length > 0
  const panelDubbingAudioSrc = panel.panelId
    ? `/api/novel-promotion/${encodeURIComponent(layout.projectId)}/panel-dubbing/audio?panelId=${encodeURIComponent(panel.panelId)}&v=${encodeURIComponent(panel.dubbingAudioUrl || '')}`
    : panel.dubbingAudioUrl || ''
  const showsIncomingLinkBadge = layout.isLastFrame && !!layout.prevPanel
  const showsOutgoingLinkBadge = layout.isLinked && !!layout.nextPanel
  const showsPromptEditor = !layout.isLastFrame || layout.isLinked
  const showsFirstLastFrameActions = layout.isLinked && !!layout.nextPanel
  const handleGenerateVideoPromptCandidate = async () => {
    try {
      const result = await regenerateVideoPrompt.mutateAsync({
        panelId: panel.panelId,
        storyboardId: panel.storyboardId,
        panelIndex: panel.panelIndex,
        field: layout.promptField,
        additionalRequirement: promptRequirement,
      })
      const nextPrompt = result.prompt.trim()
      if (!nextPrompt) throw new Error('视频提示词为空')
      setPromptCandidate(nextPrompt)
    } catch (error: unknown) {
      if (shouldShowError(error)) {
        alert(extractErrorMessage(error, '重新生成视频提示词失败'))
      }
    }
  }

  const handleUseVideoPromptCandidate = async () => {
    const nextPrompt = (promptCandidate || '').trim()
    if (!nextPrompt) return
    try {
      await promptEditor.savePromptValue(nextPrompt)
      if (layout.promptField === 'firstLastFramePrompt') {
        actions.onFlCustomPromptChange(panelKey, nextPrompt)
      }
      setPromptRequirement('')
      setPromptCandidate(null)
      setPromptModalOpen(false)
    } catch (error: unknown) {
      if (shouldShowError(error)) {
        alert(extractErrorMessage(error, '保存视频提示词失败'))
      }
    }
  }

  return (
    <div className="p-4 space-y-2">
      <div className="flex items-center justify-between text-xs">
        <span className="px-2 py-0.5 bg-[var(--glass-tone-info-bg)] text-[var(--glass-tone-info-fg)] rounded font-medium">{panel.textPanel?.shot_type || t('panelCard.unknownShotType')}</span>
        {isEditingDuration ? (
          <span className="flex items-center gap-1 text-[var(--glass-text-tertiary)]">
            <input
              className="w-14 rounded border border-[var(--glass-stroke-base)] bg-[var(--glass-bg-surface)] px-1 py-0.5 text-xs text-[var(--glass-text-secondary)] focus:outline-none focus:ring-1 focus:ring-[var(--glass-tone-info-fg)]"
              value={editingDuration}
              onChange={(e) => setEditingDuration(e.target.value)}
              placeholder="4"
            />
            <span>{durationSuffix}</span>
            <button
              onClick={saveDuration}
              disabled={updateDurationMutation.isPending}
              className="ml-1 text-[var(--glass-tone-info-fg)] hover:underline disabled:opacity-50"
            >
              {updateDurationMutation.isPending ? '...' : t('panelCard.save')}
            </button>
            <button
              onClick={() => setIsEditingDuration(false)}
              disabled={updateDurationMutation.isPending}
              className="text-[var(--glass-text-tertiary)] hover:text-[var(--glass-tone-info-fg)] disabled:opacity-50"
            >
              {t('panelCard.cancel')}
            </button>
          </span>
        ) : (
          <span
            className="text-[var(--glass-text-tertiary)] cursor-pointer hover:text-[var(--glass-tone-info-fg)]"
            title="点击编辑镜头时长"
            onClick={beginEditDuration}
          >
            {(panel.textPanel?.duration ? `${panel.textPanel.duration}${durationSuffix}` : `—${durationSuffix}`)}
          </span>
        )}
      </div>

      <p className="text-sm text-[var(--glass-text-secondary)] line-clamp-2">{panel.textPanel?.description}</p>

      <div className="mt-3 pt-3 border-t border-[var(--glass-stroke-base)]">
        {(showsIncomingLinkBadge || showsOutgoingLinkBadge) && (
          <div className="mb-2 flex flex-wrap gap-1.5">
            {showsIncomingLinkBadge && (
              <span
                className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[11px] font-medium ${showsOutgoingLinkBadge
                    ? 'bg-[var(--glass-tone-info-bg)] text-[var(--glass-tone-info-fg)]'
                    : 'bg-[var(--glass-bg-muted)] text-[var(--glass-text-tertiary)] border border-[var(--glass-stroke-base)]'
                  }`}
              >
                <AppIcon name={showsOutgoingLinkBadge ? 'link' : 'unplug'} className="w-3 h-3" />
                {t('firstLastFrame.asLastFrameFor', { number: panelIndex })}
              </span>
            )}
            {showsOutgoingLinkBadge && (
              <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[11px] font-medium bg-[var(--glass-tone-info-bg)] text-[var(--glass-tone-info-fg)]">
                <AppIcon name="link" className="w-3 h-3" />
                {t('firstLastFrame.asFirstFrameFor', { number: panelIndex + 2 })}
              </span>
            )}
          </div>
        )}

        {showsPromptEditor && (
          <>
            <div className="flex items-center justify-between mb-1">
              <span className="text-xs font-medium text-[var(--glass-text-tertiary)]">{t('promptModal.promptLabel')}</span>
              <div className="flex items-center gap-2">
                <button
                  type="button"
                  onClick={() => setPromptModalOpen(true)}
                  disabled={regenerateVideoPrompt.isPending || promptEditor.isSavingPrompt}
                  className="inline-flex items-center gap-1 p-0.5 text-[11px] text-[var(--glass-text-tertiary)] transition-colors hover:text-[var(--glass-tone-info-fg)] disabled:cursor-not-allowed disabled:opacity-50"
                >
                  <AppIcon name={regenerateVideoPrompt.isPending ? 'refresh' : 'sparklesAlt'} className={`h-3.5 w-3.5 ${regenerateVideoPrompt.isPending ? 'animate-spin' : ''}`} />
                  重生成
                </button>
                <button onClick={promptEditor.handleStartEdit} className="inline-flex items-center gap-1 text-[11px] text-[var(--glass-text-tertiary)] hover:text-[var(--glass-tone-info-fg)] transition-colors p-0.5">
                  <AppIcon name="edit" className="w-3.5 h-3.5" />
                  {t('panelCard.edit')}
                </button>
              </div>
            </div>

            <button
              type="button"
              onClick={promptEditor.handleStartEdit}
              className="mb-3 block max-h-28 w-full overflow-y-auto whitespace-pre-wrap break-words rounded-lg border border-[var(--glass-stroke-base)] bg-[var(--glass-bg-muted)] p-2 text-left text-xs leading-5 text-[var(--glass-text-secondary)] transition hover:border-[var(--glass-tone-info-fg)] hover:bg-[var(--glass-bg-surface)]"
            >
              {promptEditor.localPrompt || <span className="text-[var(--glass-text-tertiary)] italic">{t('panelCard.clickToEditPrompt')}</span>}
            </button>

            {promptEditor.isEditing && typeof document !== 'undefined' ? createPortal(
              <div
                className="fixed inset-0 z-[10000] flex items-center justify-center bg-black/70 p-4 backdrop-blur-sm"
                onClick={promptEditor.isSavingPrompt ? undefined : promptEditor.handleCancelEdit}
              >
                <div
                  className="flex max-h-[90vh] w-full max-w-5xl flex-col overflow-hidden rounded-xl border border-[var(--glass-stroke-base)] bg-[var(--glass-bg-surface)] shadow-2xl"
                  onClick={(event) => event.stopPropagation()}
                >
                  <div className="flex items-center justify-between border-b border-[var(--glass-stroke-subtle)] px-5 py-4">
                    <div>
                      <div className="text-sm font-semibold text-[var(--glass-text-primary)]">
                        {t('promptModal.title', { number: panelIndex + 1 })}
                      </div>
                      <div className="mt-1 text-xs text-[var(--glass-text-tertiary)]">
                        {panel.textPanel?.shot_type || '-'}{panel.textPanel?.duration ? ` · ${panel.textPanel.duration}${t('promptModal.duration')}` : ''}
                      </div>
                    </div>
                    <button
                      type="button"
                      disabled={promptEditor.isSavingPrompt}
                      onClick={promptEditor.handleCancelEdit}
                      className="rounded-full p-2 text-[var(--glass-text-tertiary)] transition hover:bg-[var(--glass-bg-muted)] hover:text-[var(--glass-text-primary)] disabled:cursor-not-allowed disabled:opacity-50"
                    >
                      <AppIcon name="close" className="h-5 w-5" />
                    </button>
                  </div>
                  <div className="flex-1 overflow-y-auto p-5">
                    <textarea
                      value={promptEditor.editingPrompt}
                      onChange={(event) => promptEditor.setEditingPrompt(event.target.value)}
                      autoFocus
                      className="min-h-[48vh] w-full resize-y rounded-lg border border-[var(--glass-stroke-focus)] bg-[var(--glass-bg-surface)] px-4 py-3 text-sm leading-6 text-[var(--glass-text-secondary)] outline-none focus:ring-2 focus:ring-[var(--glass-tone-info-fg)]"
                      placeholder={t('promptModal.placeholder')}
                    />
                    <p className="mt-2 text-xs text-[var(--glass-text-tertiary)]">
                      {t('promptModal.tip')}
                    </p>
                  </div>
                  <div className="flex justify-end gap-3 border-t border-[var(--glass-stroke-subtle)] px-5 py-4">
                    <button
                      type="button"
                      onClick={promptEditor.handleCancelEdit}
                      disabled={promptEditor.isSavingPrompt}
                      className="rounded-lg border border-[var(--glass-stroke-base)] bg-[var(--glass-bg-muted)] px-4 py-2 text-sm text-[var(--glass-text-secondary)] transition hover:bg-[var(--glass-bg-surface)] disabled:cursor-not-allowed disabled:opacity-50"
                    >
                      {t('panelCard.cancel')}
                    </button>
                    <button
                      type="button"
                      onClick={promptEditor.handleSave}
                      disabled={promptEditor.isSavingPrompt}
                      className="rounded-lg bg-[var(--glass-accent-from)] px-4 py-2 text-sm font-medium text-white transition hover:bg-[var(--glass-accent-to)] disabled:cursor-not-allowed disabled:opacity-60"
                    >
                      {promptEditor.isSavingPrompt ? '...' : t('panelCard.save')}
                    </button>
                  </div>
                </div>
              </div>,
              document.body,
            ) : null}

            {showsFirstLastFrameActions ? (() => {
              const linkedNextPanel = layout.nextPanel!
              const linkedNextStartImage = Array.isArray(linkedNextPanel.frames)
                ? [...linkedNextPanel.frames]
                  .filter((frame) => typeof frame.imageUrl === 'string' && frame.imageUrl.trim())
                  .sort((left, right) => left.frameTimeSec - right.frameTimeSec || left.frameIndex - right.frameIndex)
                  .at(0)?.imageUrl || linkedNextPanel.imageUrl
                : linkedNextPanel.imageUrl
              return (
                <div className="mt-2 flex items-center gap-2">
                  <button
                    onClick={() => actions.onGenerateFirstLastFrame(
                      panel.storyboardId,
                      panel.panelIndex,
                      linkedNextPanel.storyboardId,
                      linkedNextPanel.panelIndex,
                      panelKey,
                      inheritedFirstLastGenerationOptions,
                      panel.panelId,
                    )}
                    disabled={
                      taskStatus.isVideoTaskRunning
                      || !panel.imageUrl
                      || !linkedNextStartImage
                      || !layout.flModel
                      || layout.flMissingCapabilityFields.length > 0
                    }
                    className="flex-shrink-0 min-w-[120px] py-2 px-3 text-sm font-medium rounded-lg shadow-sm transition-all disabled:opacity-50 bg-[var(--glass-accent-from)] text-white"
                  >
                    {isFirstLastFrameGenerated ? t('firstLastFrame.generated') : taskStatus.isVideoTaskRunning ? taskStatus.taskRunningVideoLabel : t('firstLastFrame.generate')}
                  </button>
                  <div className="flex-1 min-w-0">
                    <ModelCapabilityDropdown
                      compact
                      models={layout.flModelOptions}
                      value={layout.flModel || undefined}
                      onModelChange={actions.onFlModelChange}
                      capabilityFields={layout.flCapabilityFields.map((field) => ({
                        field: field.field,
                        label: field.label,
                        options: field.options,
                        disabledOptions: field.disabledOptions,
                      }))}
                      capabilityOverrides={inheritedFirstLastGenerationOptions}
                      onCapabilityChange={(field, rawValue) => {
                        if (field === 'duration') {
                          const duration = rawValue === '' ? null : Number(rawValue)
                          actions.onUpdatePanelDuration(
                            panel.storyboardId,
                            panel.panelIndex,
                            Number.isFinite(duration as number) ? (duration as number) : null,
                          )
                          return
                        }
                        actions.onFlCapabilityChange(field, rawValue)
                      }}
                      placeholder={t('panelCard.selectModel')}
                    />
                  </div>
                </div>
              )
            })() : (
              <>
                <div className="flex items-center gap-2">
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
                      || !panel.imageUrl
                      || !videoModel.selectedModel
                      || videoModel.missingCapabilityFields.length > 0
                    }
                    className="flex-shrink-0 min-w-[90px] py-2 px-3 text-sm font-medium rounded-lg shadow-sm transition-all disabled:opacity-50 bg-[var(--glass-accent-from)] text-white"
                  >
                    {panel.videoUrl ? t('stage.hasSynced') : taskStatus.isVideoTaskRunning ? taskStatus.taskRunningVideoLabel : t('panelCard.generateVideo')}
                  </button>
                  <div className="flex-1 min-w-0">
                    <ModelCapabilityDropdown
                      compact
                      models={videoModel.videoModelOptions}
                      value={videoModel.selectedModel || undefined}
                      onModelChange={(modelKey) => {
                        videoModel.setSelectedModel(modelKey)
                        actions.onUpdatePanelVideoModel(panel.storyboardId, panel.panelIndex, modelKey)
                      }}
                      capabilityFields={videoModel.capabilityFields.map((field) => ({
                        field: field.field,
                        label: renderCapabilityLabel(field),
                        options: field.options,
                        disabledOptions: field.disabledOptions,
                      }))}
                      capabilityOverrides={videoModel.generationOptions}
                      onCapabilityChange={(field, rawValue, sample) => {
                        videoModel.setCapabilityValue(field, rawValue)
                        if (field === 'duration') {
                          const duration = rawValue === '' ? null : Number(rawValue)
                          actions.onUpdatePanelDuration(panel.storyboardId, panel.panelIndex, Number.isFinite(duration as number) ? (duration as number) : null)
                          return
                        }
                        actions.onUpdateVideoCapabilityOverride(videoModel.selectedModel, field, rawValue, sample)
                      }}
                      placeholder={t('panelCard.selectModel')}
                    />
                  </div>
                </div>

                {computed.showLipSyncSection && (
                  <div className="mt-2">
                    <div className="flex gap-2">
                      <button
                        onClick={computed.canLipSync ? lipSync.handleStartLipSync : undefined}
                        disabled={!computed.canLipSync || taskStatus.isLipSyncTaskRunning || lipSync.executingLipSync}
                        className="flex-1 py-1.5 text-xs rounded-lg transition-all flex items-center justify-center gap-1 bg-[var(--glass-accent-from)] text-white disabled:opacity-50"
                      >
                        {taskStatus.isLipSyncTaskRunning || lipSync.executingLipSync ? (
                          <TaskStatusInline state={taskStatus.lipSyncInlineState} className="text-white [&>span]:text-white [&_svg]:text-white" />
                        ) : (
                          <>{t('panelCard.lipSync')}</>
                        )}
                      </button>

                      {(taskStatus.isLipSyncTaskRunning || panel.lipSyncVideoUrl) && voiceManager.hasMatchedAudio && (
                        <button onClick={lipSync.handleStartLipSync} disabled={lipSync.executingLipSync} className="flex-shrink-0 px-3 py-1.5 text-xs rounded-lg bg-[var(--glass-tone-warning-fg)] text-white">
                          {t('panelCard.redo')}
                        </button>
                      )}
                    </div>

                    {voiceManager.audioGenerateError && (
                      <div className="mt-1 p-1.5 bg-[var(--glass-tone-danger-bg)] border border-[var(--glass-stroke-danger)] rounded text-[10px] text-[var(--glass-tone-danger-fg)]">
                        {voiceManager.audioGenerateError}
                      </div>
                    )}

                    {hasDialogueForDubbing && (
                      <div className="mt-2 rounded-lg border border-[var(--glass-stroke-base)] bg-[var(--glass-bg-muted)] p-2">
                        <div className="mb-2 flex flex-wrap items-center gap-2">
                          {panel.videoUrl && (
                            <button
                              type="button"
                              onClick={() => setDubbingMode('video-vocal')}
                              className="inline-flex items-center gap-1 rounded-lg bg-[var(--glass-accent-from)] px-3 py-1.5 text-xs font-medium text-white transition hover:bg-[var(--glass-accent-to)]"
                            >
                              <AppIcon name="audioWave" className="h-3.5 w-3.5" />
                              视频配音
                            </button>
                          )}
                          <button
                            type="button"
                            onClick={() => setDubbingMode('character-voice')}
                            className="inline-flex items-center gap-1 rounded-lg border border-[var(--glass-stroke-base)] bg-[var(--glass-bg-surface)] px-3 py-1.5 text-xs font-medium text-[var(--glass-text-secondary)] transition hover:border-[var(--glass-tone-info-fg)] hover:text-[var(--glass-tone-info-fg)]"
                          >
                            <AppIcon name="mic" className="h-3.5 w-3.5" />
                            角色视频配音
                          </button>
                        </div>
                        {panel.dubbingAudioUrl && (
                          <div className="space-y-1">
                            <div className="text-[10px] text-[var(--glass-text-tertiary)]">
                              当前配音音频{panel.dubbingSourceType === 'video-vocal' ? ' · 视频人声' : panel.dubbingSourceType === 'character-voice' ? ' · 角色音色' : ''}
                            </div>
                            <audio controls preload="metadata" src={panelDubbingAudioSrc} className="h-10 w-full" />
                          </div>
                        )}
                      </div>
                    )}

                    {voiceManager.localVoiceLines.length > 0 && (
                      <div className="mt-2 space-y-1">
                        {voiceManager.localVoiceLines.map((voiceLine) => {
                          const isVoiceTaskRunning = voiceManager.isVoiceLineTaskRunning(voiceLine.id)
                          const voiceAudioRunningState = isVoiceTaskRunning
                            ? resolveTaskPresentationState({ phase: 'processing', intent: 'generate', resource: 'audio', hasOutput: !!voiceLine.audioUrl })
                            : null

                          return (
                            <div key={voiceLine.id} className="flex items-start gap-1.5 p-1.5 bg-[var(--glass-bg-muted)] rounded text-[10px]">
                              {voiceLine.audioUrl ? (
                                <button
                                  onClick={(event) => {
                                    event.stopPropagation()
                                    voiceManager.handlePlayVoiceLine(voiceLine)
                                  }}
                                  className="flex-shrink-0 w-5 h-5 rounded-full flex items-center justify-center transition-colors bg-[var(--glass-bg-muted)]"
                                  title={voiceManager.playingVoiceLineId === voiceLine.id ? t('panelCard.stopVoice') : t('panelCard.play')}
                                >
                                  <AppIcon name="play" className="w-3 h-3" />
                                </button>
                              ) : (
                                <button
                                  onClick={(event) => {
                                    event.stopPropagation()
                                    void voiceManager.handleGenerateAudio(voiceLine)
                                  }}
                                  disabled={isVoiceTaskRunning}
                                  className="flex-shrink-0 px-1.5 py-0.5 bg-[var(--glass-accent-from)] text-white rounded disabled:opacity-50"
                                  title={t('panelCard.generateAudio')}
                                >
                                  {isVoiceTaskRunning ? (
                                    <TaskStatusInline state={voiceAudioRunningState} className="text-white [&>span]:text-white [&_svg]:text-white" />
                                  ) : (
                                    tCommon('generate')
                                  )}
                                </button>
                              )}
                              <div className="flex-1 min-w-0">
                                <span className="text-[var(--glass-text-tertiary)]">{voiceLine.speaker}: </span>
                                <span className="text-[var(--glass-text-secondary)]">&ldquo;{voiceLine.content}&rdquo;</span>
                              </div>
                            </div>
                          )
                        })}
                      </div>
                    )}
                  </div>
                )}
              </>
            )}
          </>
        )}
      </div>
      <RegenerateVideoPromptModal
        open={promptModalOpen}
        title="重新生成视频提示词"
              description="会沿用当前成片视频提示词格式要求，可补充本次想叠加的音乐、运镜、台词或动作要求。"
              value={promptRequirement}
              currentPrompt={promptEditor.localPrompt}
              candidatePrompt={promptCandidate}
              isSubmitting={regenerateVideoPrompt.isPending}
              isSaving={promptEditor.isSavingPrompt}
              onChange={setPromptRequirement}
              onClose={() => {
                if (regenerateVideoPrompt.isPending || promptEditor.isSavingPrompt) return
                setPromptModalOpen(false)
              }}
              onGenerate={() => void handleGenerateVideoPromptCandidate()}
              onUseCandidate={() => void handleUseVideoPromptCandidate()}
            />
      {dubbingMode && (
        <PanelDubbingDialog
          open={!!dubbingMode}
          mode={dubbingMode}
          projectId={layout.projectId}
          panel={panel}
          voiceLines={voiceManager.localVoiceLines}
          onClose={() => setDubbingMode(null)}
        />
      )}
    </div>
  )
}
