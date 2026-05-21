'use client'

import { useTranslations } from 'next-intl'
import PanelEditFormV2 from '@/components/ui/patterns/PanelEditFormV2'
import { GlassButton, GlassModalShell, GlassSurface } from '@/components/ui/primitives'
import { Character, Location, Prop } from '@/types/project'
import { useProjectAssets } from '@/lib/query/hooks/useProjectAssets'
import { AppIcon } from '@/components/ui/icons'

interface CharacterAppearance {
  id?: string
  appearanceIndex?: string | number
  changeReason?: string | null
}

export interface PanelEditData {
  id: string
  panelIndex: number
  panelNumber: number | null
  shotType: string | null
  cameraMove: string | null
  description: string | null
  location: string | null
  characters: { name: string; appearance: string; slot?: string }[]
  props: string[]
  srtStart: number | null
  srtEnd: number | null
  duration: number | null
  videoPrompt: string | null
  groupVideoPrompt?: string | null
  photographyRules?: string | null
  actingNotes?: string | null
  sourceText?: string | null
}

interface PanelEditFormProps {
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
}

export default function PanelEditForm({
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
  videoPromptField,
  onRefineStoryboardPrompt,
  isRefiningStoryboardPrompt,
  refinedStoryboardPrompt,
  onClearRefinedStoryboardPrompt,
  onRegenerateVideoPrompt,
  isRegeneratingVideoPrompt,
}: PanelEditFormProps) {
  return (
    <PanelEditFormV2
      panelData={panelData}
      isSaving={isSaving}
      saveStatus={saveStatus}
      saveErrorMessage={saveErrorMessage}
      onRetrySave={onRetrySave}
      onUpdate={onUpdate}
      onOpenCharacterPicker={onOpenCharacterPicker}
      onOpenLocationPicker={onOpenLocationPicker}
      onOpenPropPicker={onOpenPropPicker}
      onRemoveCharacter={onRemoveCharacter}
      onRemoveLocation={onRemoveLocation}
      onRemoveProp={onRemoveProp}
      videoPromptField={videoPromptField}
      onRefineStoryboardPrompt={onRefineStoryboardPrompt}
      isRefiningStoryboardPrompt={isRefiningStoryboardPrompt}
      refinedStoryboardPrompt={refinedStoryboardPrompt}
      onClearRefinedStoryboardPrompt={onClearRefinedStoryboardPrompt}
      onRegenerateVideoPrompt={onRegenerateVideoPrompt}
      isRegeneratingVideoPrompt={isRegeneratingVideoPrompt}
      uiMode="flow"
    />
  )
}

interface PropPickerModalProps {
  projectId: string
  currentProps: string[]
  onSelect: (propName: string) => void
  onClose: () => void
}

export function PropPickerModal({
  projectId,
  currentProps,
  onSelect,
  onClose,
}: PropPickerModalProps) {
  const ts = useTranslations('storyboard')
  const { data: assets } = useProjectAssets(projectId)
  const props: Prop[] = assets?.props ?? []

  return (
    <GlassModalShell open onClose={onClose} size="md" title={ts('panel.selectProp')}>
      <div className="max-h-[60vh] overflow-y-auto">
        {props.length === 0 ? (
          <p className="py-8 text-center text-[var(--glass-text-secondary)]">{ts('panel.noPropAssets')}</p>
        ) : (
          <div className="grid grid-cols-2 gap-3">
            {props.map(prop => {
              const isSelected = currentProps.some((name) => name === prop.name)
              return (
                <button
                  key={prop.id}
                  type="button"
                  disabled={isSelected}
                  onClick={() => {
                    if (!isSelected) onSelect(prop.name)
                  }}
                  className={`rounded-[var(--glass-radius-md)] border px-3 py-3 text-left transition-colors ${
                    isSelected
                      ? 'bg-[var(--glass-tone-success-bg)] text-[var(--glass-tone-success-fg)]'
                      : 'bg-[var(--glass-bg-muted)] text-[var(--glass-text-secondary)] hover:border-[var(--glass-stroke-focus)]'
                  }`}
                >
                  <div className="flex items-center gap-1.5 font-medium text-[var(--glass-text-primary)]">
                    <AppIcon name="package" className="h-3.5 w-3.5 text-[var(--glass-text-tertiary)]" />
                    <span>{prop.name}</span>
                  </div>
                  {prop.summary ? (
                    <div className="mt-1 line-clamp-2 text-xs text-[var(--glass-text-tertiary)]">{prop.summary}</div>
                  ) : null}
                  {isSelected ? (
                    <span className="mt-1 inline-flex text-xs text-[var(--glass-tone-success-fg)]">{ts('panel.selected')}</span>
                  ) : null}
                </button>
              )
            })}
          </div>
        )}
      </div>
    </GlassModalShell>
  )
}

interface CharacterPickerModalProps {
  projectId: string
  currentCharacters: { name: string; appearance: string; slot?: string }[]
  onSelect: (charName: string, appearance: string) => void
  onClose: () => void
}

export function CharacterPickerModal({
  projectId,
  currentCharacters,
  onSelect,
  onClose
}: CharacterPickerModalProps) {
  const ts = useTranslations('storyboard')
  const { data: assets } = useProjectAssets(projectId)
  const characters: Character[] = assets?.characters ?? []

  return (
    <GlassModalShell open onClose={onClose} size="md" title={ts('panel.selectCharacter')}>
      <div className="max-h-[60vh] space-y-4 overflow-y-auto">
        {characters.length === 0 ? (
          <p className="py-8 text-center text-[var(--glass-text-secondary)]">{ts('panel.noCharacterAssets')}</p>
        ) : (
          characters.map(char => {
            const appearances = char.appearances || []
            return (
              <GlassSurface key={char.id} variant="panel" className="space-y-2 p-3">
                <h5 className="text-sm font-medium text-[var(--glass-text-primary)]">{char.name}</h5>
                <div className="flex flex-wrap gap-2">
                  {appearances.map((app: CharacterAppearance) => {
                    const appearanceName = app.changeReason || ts('panel.defaultAppearance')
                    const isSelected = currentCharacters.some(
                      c => c.name === char.name && c.appearance === appearanceName
                    )
                    return (
                      <GlassButton
                        key={app.id || app.appearanceIndex}
                        size="sm"
                        variant={isSelected ? 'secondary' : 'ghost'}
                        disabled={isSelected}
                        onClick={() => {
                          if (!isSelected) onSelect(char.name, appearanceName)
                        }}
                      >
                        {appearanceName}
                        {isSelected && (
                          <AppIcon name="checkTiny" className="h-3 w-3" />
                        )}
                      </GlassButton>
                    )
                  })}
                </div>
              </GlassSurface>
            )
          })
        )}
      </div>
    </GlassModalShell>
  )
}

interface LocationPickerModalProps {
  projectId: string
  currentLocation: string | null
  onSelect: (locationName: string) => void
  onClose: () => void
}

export function LocationPickerModal({
  projectId,
  currentLocation,
  onSelect,
  onClose
}: LocationPickerModalProps) {
  const ts = useTranslations('storyboard')
  const { data: assets } = useProjectAssets(projectId)
  const locations: Location[] = assets?.locations ?? []

  return (
    <GlassModalShell open onClose={onClose} size="md" title={ts('panel.selectLocation')}>
      <div className="max-h-[60vh] overflow-y-auto">
        {locations.length === 0 ? (
          <p className="py-8 text-center text-[var(--glass-text-secondary)]">{ts('panel.noLocationAssets')}</p>
        ) : (
          <div className="grid grid-cols-2 gap-3">
            {locations.map(loc => {
              const isSelected = currentLocation === loc.name
              return (
                <button
                  key={loc.id}
                  type="button"
                  onClick={() => onSelect(loc.name)}
                  className={`rounded-[var(--glass-radius-md)] border px-3 py-3 text-left transition-colors ${
                    isSelected
                      ? 'bg-[var(--glass-tone-success-bg)] text-[var(--glass-tone-success-fg)]'
                      : 'bg-[var(--glass-bg-muted)] text-[var(--glass-text-secondary)]'
                  }`}
                >
                  <div className="font-medium text-[var(--glass-text-primary)] flex items-center gap-1.5">
                    <AppIcon name="imageAlt" className="h-3.5 w-3.5 text-[var(--glass-text-tertiary)]" />
                    <span>{loc.name}</span>
                  </div>
                  {isSelected ? (
                    <span className="text-xs text-[var(--glass-tone-success-fg)]">{ts('panel.selected')}</span>
                  ) : null}
                </button>
              )
            })}
          </div>
        )}
      </div>
    </GlassModalShell>
  )
}
