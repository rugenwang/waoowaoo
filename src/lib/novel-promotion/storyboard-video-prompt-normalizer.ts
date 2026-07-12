import type { CharacterAsset, StoryboardPanel } from '@/lib/storyboard-phases'

type CharacterNameSource = Pick<CharacterAsset, 'name'> | { name?: string | null } | string

const OFF_CAMERA_CHARACTER_PREFIX = '镜头外角色'
const NARRATION_MARKER = '【旁白】'
export const NARRATION_VISUAL_GUARD = '画面内所有可见人物嘴唇全程保持自然静止，不做发声动作，不出现说话口型；声音来自画面外，不与任何画面人物绑定。'
const DIALOGUE_MARKER_PATTERN = /【(?:对白|对话)】/g
const SECTION_MARKER_PATTERN = /【[^】]+】/g

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

function readCharacterName(value: unknown): string | null {
  if (typeof value === 'string' && value.trim()) return value.trim()
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const name = (value as { name?: unknown }).name
  return typeof name === 'string' && name.trim() ? name.trim() : null
}

function uniqueCharacterNames(characters: CharacterNameSource[]): string[] {
  const seen = new Set<string>()
  const result: string[] = []
  for (const character of characters) {
    const name = readCharacterName(character)
    if (!name || seen.has(name)) continue
    seen.add(name)
    result.push(name)
  }
  return result.sort((left, right) => right.length - left.length)
}

function getPanelCharacterNames(panel: StoryboardPanel): string[] {
  const characters = Array.isArray(panel.characters) ? panel.characters : []
  return uniqueCharacterNames(characters as CharacterNameSource[])
}

function isCharacterReferenced(name: string, referencedNames: Set<string>): boolean {
  for (const referencedName of referencedNames) {
    if (referencedName === name || referencedName.includes(name) || name.includes(referencedName)) {
      return true
    }
  }
  return false
}

function buildCharacterNameRegex(name: string): RegExp {
  const escapedName = escapeRegExp(name)
  const isAsciiName = /^[A-Za-z0-9_\-\s]+$/.test(name)
  const body = isAsciiName
    ? `(?<![\\p{L}\\p{N}_])${escapedName}(?![\\p{L}\\p{N}_])`
    : escapedName
  return new RegExp(`(?<!${OFF_CAMERA_CHARACTER_PREFIX})${body}`, 'gu')
}

function markOffCameraCharactersInText(text: string, referencedNames: Set<string>, knownCharacterNames: string[]): string {
  let normalized = text
  for (const name of knownCharacterNames) {
    if (isCharacterReferenced(name, referencedNames)) continue
    normalized = normalized.replace(buildCharacterNameRegex(name), `${OFF_CAMERA_CHARACTER_PREFIX}${name}`)
  }
  return normalized
}

function cleanOffCameraPrefixInDialogue(text: string, knownCharacterNames: string[]): string {
  let normalized = text
  for (const name of knownCharacterNames) {
    normalized = normalized.replace(
      new RegExp(`${OFF_CAMERA_CHARACTER_PREFIX}${escapeRegExp(name)}`, 'gu'),
      name,
    )
  }
  return normalized
}

function findNextSectionMarkerIndex(prompt: string, fromIndex: number): number {
  SECTION_MARKER_PATTERN.lastIndex = fromIndex
  const nextSection = SECTION_MARKER_PATTERN.exec(prompt)
  return nextSection ? nextSection.index : prompt.length
}

function markOffCameraCharacters(prompt: string, panel: StoryboardPanel, knownCharacterNames: string[]): string {
  const referencedNames = new Set(getPanelCharacterNames(panel))
  let normalized = ''
  let cursor = 0
  DIALOGUE_MARKER_PATTERN.lastIndex = 0

  for (let match = DIALOGUE_MARKER_PATTERN.exec(prompt); match; match = DIALOGUE_MARKER_PATTERN.exec(prompt)) {
    const markerStart = match.index
    normalized += markOffCameraCharactersInText(
      prompt.slice(cursor, markerStart),
      referencedNames,
      knownCharacterNames,
    )
    const dialogueEnd = findNextSectionMarkerIndex(prompt, markerStart + match[0].length)
    normalized += cleanOffCameraPrefixInDialogue(
      prompt.slice(markerStart, dialogueEnd),
      knownCharacterNames,
    )
    cursor = dialogueEnd
    DIALOGUE_MARKER_PATTERN.lastIndex = dialogueEnd
  }

  normalized += markOffCameraCharactersInText(
    prompt.slice(cursor),
    referencedNames,
    knownCharacterNames,
  )
  return normalized
}

function addNoMouthMovementBeforeNarration(prompt: string): string {
  return prompt.replace(
    new RegExp(`(?<!${escapeRegExp(NARRATION_VISUAL_GUARD)})${escapeRegExp(NARRATION_MARKER)}`, 'gu'),
    `${NARRATION_VISUAL_GUARD}${NARRATION_MARKER}`,
  )
}

function normalizeVideoPromptText(prompt: unknown, panel: StoryboardPanel, knownCharacterNames: string[]): string | null {
  if (typeof prompt !== 'string') return null
  const trimmed = prompt.trim()
  if (!trimmed) return null
  return addNoMouthMovementBeforeNarration(markOffCameraCharacters(trimmed, panel, knownCharacterNames))
}

function normalizePromptField<T extends Record<string, unknown>>(
  target: T,
  key: keyof T,
  panel: StoryboardPanel,
  knownCharacterNames: string[],
): T {
  const normalized = normalizeVideoPromptText(target[key], panel, knownCharacterNames)
  if (normalized === null) return target
  return {
    ...target,
    [key]: normalized,
  }
}

function normalizeFramePrompts(frame: unknown, panel: StoryboardPanel, knownCharacterNames: string[]): unknown {
  if (!frame || typeof frame !== 'object' || Array.isArray(frame)) return frame
  let nextFrame = frame as Record<string, unknown>
  nextFrame = normalizePromptField(nextFrame, 'video_prompt', panel, knownCharacterNames)
  nextFrame = normalizePromptField(nextFrame, 'videoPrompt', panel, knownCharacterNames)
  nextFrame = normalizePromptField(nextFrame, 'motion_prompt', panel, knownCharacterNames)
  nextFrame = normalizePromptField(nextFrame, 'motionPrompt', panel, knownCharacterNames)
  return nextFrame
}

export function normalizeStoryboardVideoPrompts(
  panels: StoryboardPanel[],
  characters: CharacterNameSource[],
): StoryboardPanel[] {
  const knownCharacterNames = uniqueCharacterNames(characters)
  return panels.map((panel) => {
    let nextPanel = normalizePromptField(panel, 'video_prompt', panel, knownCharacterNames)
    nextPanel = normalizePromptField(nextPanel, 'videoPrompt', panel, knownCharacterNames)
    nextPanel = normalizePromptField(nextPanel, 'group_video_prompt', panel, knownCharacterNames)
    nextPanel = normalizePromptField(nextPanel, 'groupVideoPrompt', panel, knownCharacterNames)
    if (Array.isArray(nextPanel.frames)) {
      nextPanel = {
        ...nextPanel,
        frames: nextPanel.frames.map((frame) => normalizeFramePrompts(frame, panel, knownCharacterNames)),
      }
    }
    return nextPanel
  })
}
