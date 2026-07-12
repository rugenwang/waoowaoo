import { hasPanelCharacterContinuity } from '@/lib/novel-promotion/panel-character-continuity'

type PanelCharacter = string | { name?: string; appearance?: string }

export function shouldBatchLinkAdjacentPanels(
  currentCharacters: PanelCharacter[] | undefined,
  nextCharacters: PanelCharacter[] | undefined,
): boolean {
  return hasPanelCharacterContinuity(currentCharacters, nextCharacters)
}
