import type {
  PanelArtifactSchema,
  StoryboardArtifactSchema,
  StoryboardsArtifact,
} from '@/lib/agent-api/contracts/storyboards'
import { AgentApiError } from '@/lib/agent-api/errors'
import type { AssetMap, ClipMap } from '@/lib/agent-api/run-state'
import type { z } from 'zod'

type StoryboardArtifact = z.infer<typeof StoryboardArtifactSchema>
type PanelArtifact = z.infer<typeof PanelArtifactSchema>

function invalid(field: string, targetKey?: string): never {
  throw new AgentApiError('REFERENCE_INVALID', {
    field,
    ...(targetKey ? { details: { targetKey } } : {}),
  })
}

function assertPanelPlans(
  storyboard: StoryboardArtifact,
  storyboardIndex: number,
): void {
  const panelsByNumber = new Map(
    storyboard.panels.map((panel) => [panel.panelNumber, panel]),
  )
  const photographyNumbers = new Set<number>()
  storyboard.photographyPlan.rules.forEach((rule, ruleIndex) => {
    const field =
      `data.storyboards[${storyboardIndex}].photographyPlan.rules[${ruleIndex}]`
    const panel = panelsByNumber.get(rule.panelNumber)
    if (!panel || photographyNumbers.has(rule.panelNumber)) {
      invalid(`${field}.panelNumber`)
    }
    photographyNumbers.add(rule.panelNumber)
    const characters = new Set(
      panel.characters.map((entry) => entry.characterKey),
    )
    rule.characters.forEach((character, characterIndex) => {
      if (!characters.has(character.characterKey)) {
        invalid(
          `${field}.characters[${characterIndex}].characterKey`,
          character.characterKey,
        )
      }
    })
  })

  const actingNumbers = new Set<number>()
  storyboard.actingDirections.forEach((direction, directionIndex) => {
    const field =
      `data.storyboards[${storyboardIndex}].actingDirections[${directionIndex}]`
    const panel = panelsByNumber.get(direction.panelNumber)
    if (!panel || actingNumbers.has(direction.panelNumber)) {
      invalid(`${field}.panelNumber`)
    }
    actingNumbers.add(direction.panelNumber)
    const characters = new Set(
      panel.characters.map((entry) => entry.characterKey),
    )
    direction.characters.forEach((character, characterIndex) => {
      if (!characters.has(character.characterKey)) {
        invalid(
          `${field}.characters[${characterIndex}].characterKey`,
          character.characterKey,
        )
      }
    })
  })
}

function assertPanelAssets(
  panel: PanelArtifact,
  field: string,
  assets: AssetMap,
): void {
  const panelAppearanceKeys = new Set<string>()
  panel.characters.forEach((entry, index) => {
    const character = assets.characters[entry.characterKey]
    if (!character) {
      invalid(`${field}.characters[${index}].characterKey`, entry.characterKey)
    }
    if (!character.appearances[entry.appearanceKey]) {
      invalid(
        `${field}.characters[${index}].appearanceKey`,
        entry.appearanceKey,
      )
    }
    panelAppearanceKeys.add(entry.appearanceKey)
  })
  if (panel.locationKey !== null && !assets.locations[panel.locationKey]) {
    invalid(`${field}.locationKey`, panel.locationKey)
  }
  panel.propKeys.forEach((propKey, index) => {
    if (!assets.props[propKey]) {
      invalid(`${field}.propKeys[${index}]`, propKey)
    }
  })

  let previousTime = -1
  const framesByKey = new Map(
    panel.frames.map((frame) => [frame.frameKey, frame]),
  )
  panel.frames.forEach((frame, frameIndex) => {
    const frameField = `${field}.frames[${frameIndex}]`
    if (
      frame.frameTimeSec < previousTime
      || frame.frameTimeSec > panel.durationSec
      || (frameIndex === 0 && frame.frameTimeSec !== 0)
    ) {
      invalid(`${frameField}.frameTimeSec`)
    }
    previousTime = frame.frameTimeSec
    const dependencies = new Set(frame.dependencyFrameKeys)
    frame.referencePolicy.orderedReferences.forEach(
      (reference, referenceIndex) => {
        const referenceField =
          `${frameField}.referencePolicy.orderedReferences[${referenceIndex}].targetKey`
        if (reference.kind === 'frame') {
          const target = framesByKey.get(reference.targetKey)
          if (
            !target
            || target.frameIndex >= frame.frameIndex
            || !dependencies.has(reference.targetKey)
          ) {
            invalid(referenceField, reference.targetKey)
          }
        } else if (reference.kind === 'location') {
          if (!assets.locations[reference.targetKey]) {
            invalid(referenceField, reference.targetKey)
          }
        } else if (reference.kind === 'prop') {
          if (!assets.props[reference.targetKey]) {
            invalid(referenceField, reference.targetKey)
          }
        } else if (reference.kind === 'character-appearance') {
          if (!panelAppearanceKeys.has(reference.targetKey)) {
            invalid(referenceField, reference.targetKey)
          }
        }
      },
    )
  })
}

function assertPreviousPanelTail(
  storyboard: StoryboardArtifact,
  storyboardIndex: number,
): void {
  storyboard.panels.forEach((panel, panelIndex) => {
    const priorTail = panelIndex === 0
      ? undefined
      : storyboard.panels[panelIndex - 1].frames.at(-1)?.frameKey
    let referenceCount = 0
    panel.frames.forEach((frame, frameIndex) => {
      frame.referencePolicy.orderedReferences.forEach(
        (reference, referenceIndex) => {
          if (reference.kind !== 'previous-panel-tail') return
          referenceCount += 1
          if (
            frameIndex !== 0
            || priorTail === undefined
            || reference.targetKey !== priorTail
          ) {
            invalid(
              `data.storyboards[${storyboardIndex}].panels[${panelIndex}].frames[${frameIndex}].referencePolicy.orderedReferences[${referenceIndex}].targetKey`,
              reference.targetKey,
            )
          }
        },
      )
    })
    if (
      (panel.usePreviousPanelTailAsReference && referenceCount !== 1)
      || (!panel.usePreviousPanelTailAsReference && referenceCount !== 0)
    ) {
      invalid(
        `data.storyboards[${storyboardIndex}].panels[${panelIndex}].usePreviousPanelTailAsReference`,
      )
    }
  })
}

export function validateStoryboardArtifact(
  artifact: StoryboardsArtifact,
  assets: AssetMap,
  clipMap: ClipMap,
  episodeKey: string,
): void {
  if (artifact.episodeKey !== episodeKey) {
    invalid('data.episodeKey', artifact.episodeKey)
  }
  const expectedClips = Object.values(clipMap)
    .filter((entry) => entry.episodeKey === episodeKey)
    .sort((left, right) => left.ordinal - right.ordinal)
  if (artifact.storyboards.length !== expectedClips.length) {
    invalid('data.storyboards')
  }
  artifact.storyboards.forEach((storyboard, storyboardIndex) => {
    const expected = expectedClips[storyboardIndex]
    if (
      !expected
      || storyboard.clipKey !== expected.clipKey
      || clipMap[storyboard.clipKey]?.episodeKey !== episodeKey
    ) {
      invalid(
        `data.storyboards[${storyboardIndex}].clipKey`,
        storyboard.clipKey,
      )
    }
    storyboard.panels.forEach((panel, panelIndex) => {
      assertPanelAssets(
        panel,
        `data.storyboards[${storyboardIndex}].panels[${panelIndex}]`,
        assets,
      )
    })
    assertPanelPlans(storyboard, storyboardIndex)
    assertPreviousPanelTail(storyboard, storyboardIndex)
  })
}
