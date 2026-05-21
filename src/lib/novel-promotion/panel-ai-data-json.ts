type PanelAiDataCharacter = {
  name?: string | null
  appearance?: string | null
  slot?: string | null
  referenceDescription?: string | null
}

type PanelAiDataJsonParams = {
  aspectRatio: string | null | undefined
  shotType: string | null | undefined
  cameraMove: string | null | undefined
  description: string | null | undefined
  location: string | null | undefined
  locationReference?: {
    description?: string | null
    availableSlots?: string[] | null
  } | null
  characters: PanelAiDataCharacter[]
  props?: Array<string | { name?: string | null; description?: string | null }> | null
  imagePrompt?: string | null
  videoPrompt?: string | null
  sourceText?: string | null
  photographyRules?: unknown
  actingNotes?: unknown
}

function cleanString(value: string | null | undefined): string {
  return String(value || '').trim()
}

function cleanCharacters(characters: PanelAiDataCharacter[]): PanelAiDataCharacter[] {
  const result: PanelAiDataCharacter[] = []
  for (const character of characters) {
    const name = cleanString(character.name)
    if (!name) continue
    const appearance = cleanString(character.appearance)
    const slot = cleanString(character.slot)
    result.push({
      name,
      appearance,
      ...(slot ? { slot } : {}),
      ...(cleanString(character.referenceDescription) ? { reference_description: cleanString(character.referenceDescription) } : {}),
    })
  }
  return result
}

function cleanProps(props: PanelAiDataJsonParams['props']): Array<{ name: string; description?: string }> {
  if (!Array.isArray(props)) return []
  const seen = new Set<string>()
  const result: Array<{ name: string; description?: string }> = []
  for (const prop of props) {
    const name = typeof prop === 'string' ? cleanString(prop) : cleanString(prop?.name)
    if (!name || seen.has(name)) continue
    seen.add(name)
    const description = typeof prop === 'string' ? '' : cleanString(prop?.description)
    result.push({
      name,
      ...(description ? { description } : {}),
    })
  }
  return result
}

export function buildPanelAiDataJson(params: PanelAiDataJsonParams) {
  const description = cleanString(params.description)
  const videoPrompt = cleanString(params.videoPrompt)
  const imagePrompt = cleanString(params.imagePrompt)
  const sourceText = cleanString(params.sourceText)
  const props = cleanProps(params.props)

  return {
    aspect_ratio: cleanString(params.aspectRatio),
    shot: {
      shot_type: cleanString(params.shotType),
      camera_move: cleanString(params.cameraMove),
      description,
      location: cleanString(params.location),
      ...(params.locationReference
        ? {
          location_reference: {
            ...(cleanString(params.locationReference.description) ? { description: cleanString(params.locationReference.description) } : {}),
            ...(Array.isArray(params.locationReference.availableSlots) && params.locationReference.availableSlots.length > 0
              ? { available_slots: params.locationReference.availableSlots.map(cleanString).filter(Boolean) }
              : {}),
          },
        }
        : {}),
      characters: cleanCharacters(params.characters),
      props,
      reference_priority: '严格按输入参考图生成：角色参考图锁定人物身份、发型、妆容、服装款式、服装颜色和服饰层次；场景参考图锁定空间结构、光线和可站位置；道具参考图锁定道具外观。不得自行更换衣服、发型或新增未要求的穿戴物。',
      ...(imagePrompt ? { image_prompt: imagePrompt } : {}),
      ...(videoPrompt ? { video_prompt: videoPrompt } : {}),
      prompt_text: [
        imagePrompt,
        description,
        videoPrompt,
      ].filter(Boolean).join('。'),
    },
    ...(sourceText ? { source_text: sourceText } : {}),
    ...(params.photographyRules ? { photography_rules: params.photographyRules } : {}),
    ...(params.actingNotes ? { acting_notes: params.actingNotes } : {}),
  }
}
