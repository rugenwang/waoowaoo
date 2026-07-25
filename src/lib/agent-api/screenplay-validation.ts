import type {
  ClipArtifactSchema,
  ScreenplayArtifact,
} from '@/lib/agent-api/contracts/screenplay'
import { AgentApiError } from '@/lib/agent-api/errors'
import type { AssetMap } from '@/lib/agent-api/run-state'
import type { z } from 'zod'

type ClipArtifact = z.infer<typeof ClipArtifactSchema>

export type ScreenplayAnchor = {
  clipKey: string
  startIndex: number
  endIndex: number
}

function invalidReference(field: string, targetKey?: string): never {
  throw new AgentApiError('REFERENCE_INVALID', {
    field,
    ...(targetKey ? { details: { targetKey } } : {}),
  })
}

export function validateScreenplayAnchors(
  novelText: string,
  clips: ClipArtifact[],
): ScreenplayAnchor[] {
  let cursor = 0
  return clips.map((clip, clipIndex) => {
    const startField = `data.clips[${clipIndex}].startText`
    const endField = `data.clips[${clipIndex}].endText`
    if (!clip.startText.trim()) invalidReference(startField)
    if (!clip.endText.trim()) invalidReference(endField)

    const startIndex = novelText.indexOf(clip.startText, cursor)
    if (startIndex < 0) invalidReference(startField)
    const endIndex = novelText.indexOf(
      clip.endText,
      startIndex + clip.startText.length,
    )
    if (endIndex < 0) invalidReference(endField)

    cursor = endIndex + clip.endText.length
    return {
      clipKey: clip.clipKey,
      startIndex,
      endIndex,
    }
  })
}

export function validateScreenplayReferences(
  artifact: ScreenplayArtifact,
  assets: AssetMap,
): void {
  const requireCharacter = (key: string, field: string) => {
    if (!key || !assets.characters[key]) invalidReference(field, key)
  }
  const requireLocation = (key: string, field: string) => {
    if (!key || !assets.locations[key]) invalidReference(field, key)
  }
  const requireProp = (key: string, field: string) => {
    if (!key || !assets.props[key]) invalidReference(field, key)
  }

  artifact.clips.forEach((clip, clipIndex) => {
    if (clip.locationKey !== null) {
      requireLocation(
        clip.locationKey,
        `data.clips[${clipIndex}].locationKey`,
      )
    }
    clip.characterKeys.forEach((key, index) => {
      requireCharacter(
        key,
        `data.clips[${clipIndex}].characterKeys[${index}]`,
      )
    })
    clip.propKeys.forEach((key, index) => {
      requireProp(
        key,
        `data.clips[${clipIndex}].propKeys[${index}]`,
      )
    })
    clip.screenplay.scenes.forEach((scene, sceneIndex) => {
      const scenePath = `data.clips[${clipIndex}].screenplay.scenes[${sceneIndex}]`
      requireLocation(
        scene.heading.locationKey,
        `${scenePath}.heading.locationKey`,
      )
      scene.characterKeys.forEach((key, index) => {
        requireCharacter(key, `${scenePath}.characterKeys[${index}]`)
      })
      scene.content.forEach((content, contentIndex) => {
        const contentPath = `${scenePath}.content[${contentIndex}]`
        if (content.type === 'dialogue') {
          requireCharacter(
            content.characterKey,
            `${contentPath}.characterKey`,
          )
        }
        if (content.type === 'voiceover') {
          if (content.characterKey !== undefined) {
            requireCharacter(
              content.characterKey,
              `${contentPath}.characterKey`,
            )
          } else if (!content.speakerLabel?.trim()) {
            invalidReference(`${contentPath}.speakerLabel`)
          }
        }
      })
    })
  })
}
