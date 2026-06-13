'use client'

import {
  CharacterEditModal as SharedCharacterEditModal,
  type CharacterEditModalProps as SharedCharacterEditModalProps,
} from '@/components/shared/assets/CharacterEditModal'

interface CharacterEditModalProps {
  characterId: string
  characterName: string
  appearanceId: number
  description: string
  introduction?: string | null
  voicePrompt?: string | null
  descriptionIndex?: number
  projectId: string
  onClose: () => void
  onSave: (characterId: string, appearanceId: number) => void
  onUpdate: (newDescription: string) => void
  onIntroductionUpdate?: (newIntroduction: string) => void
  onVoicePromptUpdate?: (newVoicePrompt: string) => void
  onNameUpdate?: (newName: string) => void
  isTaskRunning?: boolean
}

export default function CharacterEditModal({
  characterId,
  characterName,
  appearanceId,
  description,
  introduction,
  voicePrompt,
  descriptionIndex,
  projectId,
  onClose,
  onSave,
  onUpdate,
  onIntroductionUpdate,
  onVoicePromptUpdate,
  onNameUpdate,
  isTaskRunning = false,
}: CharacterEditModalProps) {
  const handleSave: SharedCharacterEditModalProps['onSave'] = (
    nextCharacterId,
    nextAppearanceId,
  ) => {
    onSave(nextCharacterId, Number(nextAppearanceId))
  }

  return (
    <SharedCharacterEditModal
      mode="project"
      characterId={characterId}
      characterName={characterName}
      appearanceId={String(appearanceId)}
      description={description}
      introduction={introduction}
      voicePrompt={voicePrompt}
      descriptionIndex={descriptionIndex}
      projectId={projectId}
      onClose={onClose}
      onSave={handleSave}
      onUpdate={onUpdate}
      onIntroductionUpdate={onIntroductionUpdate}
      onVoicePromptUpdate={onVoicePromptUpdate}
      onNameUpdate={onNameUpdate}
      isTaskRunning={isTaskRunning}
    />
  )
}
