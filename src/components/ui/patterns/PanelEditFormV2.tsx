'use client'

import { useTranslations } from 'next-intl'
import { useState } from 'react'
import { createPortal } from 'react-dom'
import type { PanelEditData } from '@/app/[locale]/workspace/[projectId]/modes/novel-promotion/components/PanelEditForm'
import {
  GlassChip,
  GlassField,
  GlassInput,
  GlassTextarea
} from '@/components/ui/primitives'
import type { UiPatternMode } from './types'
import { AppIcon } from '@/components/ui/icons'

export interface PanelEditFormV2Props {
  panelData: PanelEditData
  isSaving?: boolean
  saveStatus?: 'idle' | 'saving' | 'error'
  saveErrorMessage?: string | null
  onRetrySave?: () => void
  onUpdate: (updates: Partial<PanelEditData>) => void
  onOpenCharacterPicker: () => void
  onOpenLocationPicker: () => void
  onOpenPropPicker: () => void
  onRemoveCharacter: (index: number) => void
  onRemoveLocation: () => void
  onRemoveProp: (index: number) => void
  videoPromptField?: 'videoPrompt' | 'groupVideoPrompt'
  onRefineStoryboardPrompt?: () => void
  isRefiningStoryboardPrompt?: boolean
  refinedStoryboardPrompt?: string | null
  onClearRefinedStoryboardPrompt?: () => void
  onRegenerateVideoPrompt?: () => void
  isRegeneratingVideoPrompt?: boolean
  uiMode?: UiPatternMode
}

type LargeTextEditorState = {
  field: 'description' | 'videoPrompt'
  title: string
  subtitle?: string
  value: string
  placeholder: string
} | null

export default function PanelEditFormV2({
  panelData,
  isSaving = false,
  saveStatus = 'idle',
  saveErrorMessage = null,
  onRetrySave,
  onUpdate,
  onOpenCharacterPicker,
  onOpenLocationPicker,
  onOpenPropPicker,
  onRemoveCharacter,
  onRemoveLocation,
  onRemoveProp,
  videoPromptField = 'videoPrompt',
  onRefineStoryboardPrompt,
  isRefiningStoryboardPrompt = false,
  refinedStoryboardPrompt = null,
  onClearRefinedStoryboardPrompt,
  onRegenerateVideoPrompt,
  isRegeneratingVideoPrompt = false,
  uiMode = 'flow'
}: PanelEditFormV2Props) {
  const t = useTranslations('storyboard')
  const [largeTextEditor, setLargeTextEditor] = useState<LargeTextEditorState>(null)
  const handleCopyRefinedPrompt = async () => {
    const value = (refinedStoryboardPrompt || '').trim()
    if (!value) return
    try {
      await navigator.clipboard.writeText(value)
    } catch {
      // Clipboard can be unavailable in insecure contexts; selection fallback is intentionally omitted.
    }
  }

  const currentVideoPromptValue = videoPromptField === 'groupVideoPrompt'
    ? panelData.groupVideoPrompt || panelData.videoPrompt || ''
    : panelData.videoPrompt || ''

  const updateVideoPromptValue = (value: string) => {
    onUpdate(videoPromptField === 'groupVideoPrompt' ? { groupVideoPrompt: value } : { videoPrompt: value })
  }

  const openLargeTextEditor = (field: 'description' | 'videoPrompt') => {
    setLargeTextEditor({
      field,
      title: field === 'description' ? t('panel.sceneDescription') : t('panel.videoPrompt'),
      subtitle: field === 'description' ? t('panel.sceneDescriptionPlaceholder') : t('panel.videoPromptHint'),
      value: field === 'description' ? panelData.description || '' : currentVideoPromptValue,
      placeholder: field === 'description' ? t('panel.sceneDescriptionPlaceholder') : t('panel.videoPromptPlaceholder'),
    })
  }

  const closeLargeTextEditor = () => setLargeTextEditor(null)

  const saveLargeTextEditor = () => {
    if (!largeTextEditor) return
    if (largeTextEditor.field === 'description') {
      onUpdate({ description: largeTextEditor.value })
    } else {
      updateVideoPromptValue(largeTextEditor.value)
    }
    setLargeTextEditor(null)
  }

  return (
    <div className={`ui-pattern-form ui-pattern-form-${uiMode} space-y-2`}>
      {saveStatus === 'saving' || isSaving ? (
        <GlassChip tone="info" icon={<span className="h-2 w-2 animate-pulse rounded-full bg-current" />}>
          {t('common.saving')}
        </GlassChip>
      ) : null}
      {saveStatus === 'error' ? (
        <div className="flex flex-wrap items-center gap-2">
          <GlassChip tone="danger">
            {saveErrorMessage || t('common.saveFailed')}
          </GlassChip>
          {onRetrySave ? (
            <button
              type="button"
              onClick={onRetrySave}
              className="glass-btn-base glass-btn-soft px-2 py-1 text-xs"
            >
              {t('common.retrySave')}
            </button>
          ) : null}
        </div>
      ) : null}

      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <GlassField label={t('panel.shotTypeLabel')}>
          <GlassInput
            density="compact"
            value={panelData.shotType || ''}
            onChange={(event) => onUpdate({ shotType: event.target.value || null })}
            placeholder={t('panel.shotTypePlaceholder')}
          />
        </GlassField>

        <GlassField label={t('panel.cameraMove')}>
          <GlassInput
            density="compact"
            value={panelData.cameraMove || ''}
            onChange={(event) => onUpdate({ cameraMove: event.target.value || null })}
            placeholder={t('panel.cameraMovePlaceholder')}
          />
        </GlassField>
      </div>

      {panelData.sourceText ? (
        <GlassField label={t('panel.sourceText')}>
          <div className="rounded-[var(--glass-radius-md)] bg-[var(--glass-bg-surface-strong)] px-3 py-2.5">
            <p className="text-sm leading-6 text-[var(--glass-text-secondary)]">&ldquo;{panelData.sourceText}&rdquo;</p>
          </div>
        </GlassField>
      ) : null}

      <GlassField
        label={t('panel.sceneDescription')}
        actions={(
          <div className="flex items-center gap-1">
            <button
              type="button"
              onClick={() => openLargeTextEditor('description')}
              className="inline-flex h-8 w-8 items-center justify-center text-[var(--glass-text-secondary)] transition-colors hover:text-[var(--glass-tone-info-fg)]"
              aria-label="放大编辑画面描述"
              title="放大编辑画面描述"
            >
              <AppIcon name="maximize" className="h-4 w-4" />
            </button>
            {onRefineStoryboardPrompt ? (
              <button
                type="button"
                onClick={onRefineStoryboardPrompt}
                disabled={isRefiningStoryboardPrompt}
                className="inline-flex h-8 w-8 items-center justify-center text-[var(--glass-text-secondary)] hover:text-[var(--glass-tone-info-fg)] disabled:cursor-not-allowed disabled:opacity-50 transition-colors"
                aria-label={t('panel.refineStoryboardPrompt')}
                title={t('panel.refineStoryboardPrompt')}
              >
                {isRefiningStoryboardPrompt ? (
                  <AppIcon name="refresh" className="h-4 w-4 animate-spin" />
                ) : (
                  <AppIcon name="sparklesAlt" className="h-4 w-4" />
                )}
              </button>
            ) : null}
          </div>
        )}
      >
        <GlassTextarea
          density="compact"
          rows={2}
          value={panelData.description || ''}
          onChange={(event) => onUpdate({ description: event.target.value })}
          placeholder={t('panel.sceneDescriptionPlaceholder')}
        />
        {refinedStoryboardPrompt ? (
          <div className="mt-2 rounded-[var(--glass-radius-md)] border border-[var(--glass-stroke-base)] bg-[var(--glass-bg-surface-strong)] p-2.5">
            <div className="mb-1.5 flex items-center justify-between gap-2">
              <span className="text-xs font-medium text-[var(--glass-text-secondary)]">
                {t('panel.refinedStoryboardPromptResult')}
              </span>
              <div className="flex items-center gap-1">
                <button
                  type="button"
                  onClick={handleCopyRefinedPrompt}
                  className="inline-flex h-7 w-7 items-center justify-center text-[var(--glass-text-secondary)] hover:text-[var(--glass-tone-info-fg)] transition-colors"
                  aria-label={t('panel.copyRefinedPrompt')}
                  title={t('panel.copyRefinedPrompt')}
                >
                  <AppIcon name="copy" className="h-3.5 w-3.5" />
                </button>
                {onClearRefinedStoryboardPrompt ? (
                  <button
                    type="button"
                    onClick={onClearRefinedStoryboardPrompt}
                    className="inline-flex h-7 w-7 items-center justify-center text-[var(--glass-text-tertiary)] hover:text-[var(--glass-tone-danger-fg)] transition-colors"
                    aria-label={t('common.cancel')}
                    title={t('common.cancel')}
                  >
                    <AppIcon name="closeSm" className="h-3.5 w-3.5" />
                  </button>
                ) : null}
              </div>
            </div>
            <p className="whitespace-pre-wrap text-xs leading-5 text-[var(--glass-text-primary)]">
              {refinedStoryboardPrompt}
            </p>
          </div>
        ) : null}
      </GlassField>

      <GlassField
        label={t('panel.videoPrompt')}
        hint={t('panel.videoPromptHint')}
        actions={(
          <div className="flex items-center gap-1">
            <button
              type="button"
              onClick={() => openLargeTextEditor('videoPrompt')}
              className="inline-flex h-8 w-8 items-center justify-center text-[var(--glass-text-secondary)] transition-colors hover:text-[var(--glass-tone-info-fg)]"
              aria-label="放大编辑视频提示词"
              title="放大编辑视频提示词"
            >
              <AppIcon name="maximize" className="h-4 w-4" />
            </button>
            {onRegenerateVideoPrompt ? (
              <button
                type="button"
                onClick={onRegenerateVideoPrompt}
                disabled={isRegeneratingVideoPrompt}
                className="inline-flex h-8 w-8 items-center justify-center text-[var(--glass-text-secondary)] transition-colors hover:text-[var(--glass-tone-info-fg)] disabled:cursor-not-allowed disabled:opacity-50"
                aria-label="重新生成视频提示词"
                title="重新生成视频提示词"
              >
                {isRegeneratingVideoPrompt ? (
                  <AppIcon name="refresh" className="h-4 w-4 animate-spin" />
                ) : (
                  <AppIcon name="sparklesAlt" className="h-4 w-4" />
                )}
              </button>
            ) : null}
          </div>
        )}
      >
        <button
          type="button"
          onClick={() => openLargeTextEditor('videoPrompt')}
          className="block max-h-28 min-h-[4.75rem] w-full overflow-y-auto whitespace-pre-wrap break-words rounded-[var(--glass-radius-md)] border border-[var(--glass-stroke-base)] bg-[var(--glass-bg-muted)] px-3 py-2.5 text-left text-xs leading-5 text-[var(--glass-text-secondary)] transition hover:border-[var(--glass-tone-info-fg)] hover:bg-[var(--glass-bg-surface)]"
        >
          {currentVideoPromptValue || (
            <span className="text-[var(--glass-text-tertiary)] italic">
              {t('panel.videoPromptPlaceholder')}
            </span>
          )}
        </button>
      </GlassField>

      <div className="grid grid-cols-1 gap-2 xl:grid-cols-3">
        <GlassField
          label={t('panel.locationLabel')}
          actions={
            <button
              type="button"
              onClick={onOpenLocationPicker}
              className="inline-flex h-8 w-8 items-center justify-center text-[var(--glass-text-secondary)] hover:text-[var(--glass-tone-info-fg)] transition-colors"
              aria-label={t('panel.editLocation')}
              title={t('panel.editLocation')}
            >
              <AppIcon name="edit" className="h-4 w-4" />
            </button>
          }
        >
          {panelData.location ? (
            <div className="flex flex-wrap gap-1.5">
              <GlassChip tone="success" onRemove={onRemoveLocation}>{panelData.location}</GlassChip>
            </div>
          ) : (
            <p className="text-xs text-[var(--glass-text-tertiary)]">{t('panel.locationNotEdited')}</p>
          )}
        </GlassField>

        <GlassField
          label={t('panel.characterLabelWithCount', { count: panelData.characters.length })}
          actions={
            <button
              type="button"
              onClick={onOpenCharacterPicker}
              className="inline-flex h-8 w-8 items-center justify-center text-[var(--glass-text-secondary)] hover:text-[var(--glass-tone-info-fg)] transition-colors"
              aria-label={t('panel.editCharacter')}
              title={t('panel.editCharacter')}
            >
              <AppIcon name="edit" className="h-4 w-4" />
            </button>
          }
        >
          {panelData.characters.length > 0 ? (
            <div className="flex flex-wrap gap-1.5">
              {panelData.characters.map((character, index) => (
                <GlassChip key={`${character.name}-${index}`} tone="info" onRemove={() => onRemoveCharacter(index)}>
                  {character.name}({character.appearance})
                </GlassChip>
              ))}
            </div>
          ) : (
            <p className="text-xs text-[var(--glass-text-tertiary)]">{t('panel.charactersNotEdited')}</p>
          )}
        </GlassField>

        <GlassField
          label={t('panel.propLabelWithCount', { count: panelData.props.length })}
          actions={
            <button
              type="button"
              onClick={onOpenPropPicker}
              className="inline-flex h-8 w-8 items-center justify-center text-[var(--glass-text-secondary)] hover:text-[var(--glass-tone-info-fg)] transition-colors"
              aria-label={t('panel.editProp')}
              title={t('panel.editProp')}
            >
              <AppIcon name="edit" className="h-4 w-4" />
            </button>
          }
        >
          {panelData.props.length > 0 ? (
            <div className="flex flex-wrap gap-1.5">
              {panelData.props.map((propName, index) => (
                <GlassChip key={`${propName}-${index}`} tone="neutral" onRemove={() => onRemoveProp(index)}>
                  {propName}
                </GlassChip>
              ))}
            </div>
          ) : (
            <p className="text-xs text-[var(--glass-text-tertiary)]">{t('panel.propsNotEdited')}</p>
          )}
        </GlassField>
      </div>
      {largeTextEditor && typeof document !== 'undefined' ? createPortal(
        <div
          className="fixed inset-0 z-[10000] flex items-center justify-center bg-black/70 p-4 backdrop-blur-sm"
          onClick={closeLargeTextEditor}
        >
          <div
            className="flex max-h-[90vh] w-full max-w-5xl flex-col overflow-hidden rounded-xl border border-[var(--glass-stroke-base)] bg-[var(--glass-bg-surface)] shadow-2xl"
            onClick={(event) => event.stopPropagation()}
          >
            <div className="flex items-center justify-between border-b border-[var(--glass-stroke-subtle)] px-5 py-4">
              <div>
                <div className="text-sm font-semibold text-[var(--glass-text-primary)]">{largeTextEditor.title}</div>
                {largeTextEditor.subtitle ? (
                  <div className="mt-1 text-xs text-[var(--glass-text-tertiary)]">{largeTextEditor.subtitle}</div>
                ) : null}
              </div>
              <button
                type="button"
                onClick={closeLargeTextEditor}
                className="rounded-full p-2 text-[var(--glass-text-tertiary)] transition hover:bg-[var(--glass-bg-muted)] hover:text-[var(--glass-text-primary)]"
                aria-label={t('common.cancel')}
              >
                <AppIcon name="close" className="h-5 w-5" />
              </button>
            </div>
            <div className="flex-1 overflow-y-auto p-5">
              <textarea
                value={largeTextEditor.value}
                onChange={(event) => setLargeTextEditor((previous) => previous ? { ...previous, value: event.target.value } : previous)}
                autoFocus
                className="min-h-[48vh] w-full resize-y rounded-lg border border-[var(--glass-stroke-focus)] bg-[var(--glass-bg-surface)] px-4 py-3 text-sm leading-6 text-[var(--glass-text-secondary)] outline-none focus:ring-2 focus:ring-[var(--glass-tone-info-fg)]"
                placeholder={largeTextEditor.placeholder}
              />
              <p className="mt-2 text-xs text-[var(--glass-text-tertiary)]">
                点击保存后会回写到当前分镜字段，外层仍按原有自动保存逻辑保存。
              </p>
            </div>
            <div className="flex justify-end gap-3 border-t border-[var(--glass-stroke-subtle)] px-5 py-4">
              <button
                type="button"
                onClick={closeLargeTextEditor}
                className="rounded-lg border border-[var(--glass-stroke-base)] bg-[var(--glass-bg-muted)] px-4 py-2 text-sm text-[var(--glass-text-secondary)] transition hover:bg-[var(--glass-bg-surface)]"
              >
                {t('common.cancel')}
              </button>
              <button
                type="button"
                onClick={saveLargeTextEditor}
                className="rounded-lg bg-[var(--glass-accent-from)] px-4 py-2 text-sm font-medium text-white transition hover:bg-[var(--glass-accent-to)]"
              >
                {t('common.save')}
              </button>
            </div>
          </div>
        </div>,
        document.body,
      ) : null}
    </div>
  )
}
