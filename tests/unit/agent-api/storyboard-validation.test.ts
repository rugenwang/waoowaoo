import { describe, expect, it } from 'vitest'

import type { StoryboardsArtifact } from '@/lib/agent-api/contracts/storyboards'
import { AgentApiError } from '@/lib/agent-api/errors'
import type { AssetMap, ClipMap } from '@/lib/agent-api/run-state'
import { validateStoryboardArtifact } from '@/lib/agent-api/storyboard-validation'

function assets(): AssetMap {
  return {
    characters: {
      'character.lin': {
        characterKey: 'character.lin',
        characterId: 'character-id',
        reused: false,
        appearances: {
          'appearance.lin.default': {
            appearanceKey: 'appearance.lin.default',
            appearanceId: 'appearance-id',
            appearanceIndex: 0,
            reused: false,
            variantSlots: {
              0: { entityId: 'candidate-id', index: 0 },
            },
          },
        },
      },
      'character.zhou': {
        characterKey: 'character.zhou',
        characterId: 'character-zhou-id',
        reused: false,
        appearances: {
          'appearance.zhou.default': {
            appearanceKey: 'appearance.zhou.default',
            appearanceId: 'appearance-zhou-id',
            appearanceIndex: 0,
            reused: false,
            variantSlots: {
              0: { entityId: 'candidate-zhou-id', index: 0 },
            },
          },
        },
      },
    },
    locations: {
      'location.home': {
        assetKey: 'location.home',
        entityId: 'location-id',
        reused: false,
        imageSlots: {
          0: { entityId: 'location-image-id', index: 0 },
        },
      },
    },
    props: {
      'prop.bag': {
        assetKey: 'prop.bag',
        entityId: 'prop-id',
        reused: false,
        imageSlots: {
          0: { entityId: 'prop-image-id', index: 0 },
        },
      },
    },
  }
}

function clips(): ClipMap {
  return {
    'clip-001': {
      clipKey: 'clip-001',
      clipId: 'clip-id-1',
      episodeKey: 'episode-001',
      ordinal: 1,
    },
    'clip-002': {
      clipKey: 'clip-002',
      clipId: 'clip-id-2',
      episodeKey: 'episode-001',
      ordinal: 2,
    },
    'clip-other': {
      clipKey: 'clip-other',
      clipId: 'clip-id-other',
      episodeKey: 'episode-002',
      ordinal: 1,
    },
  }
}

function artifact(): StoryboardsArtifact {
  return {
    episodeKey: 'episode-001',
    storyboards: [{
      storyboardKey: 'storyboard-001',
      clipKey: 'clip-001',
      photographyPlan: {
        visualStrategy: '低照度写实摄影',
        continuityRules: ['保持人物轴线一致'],
        rules: [{
          panelNumber: 1,
          composition: '三分构图',
          lighting: '窗边侧光',
          colorPalette: '冷蓝色',
          atmosphere: '紧张',
          technicalNotes: '35mm',
          characters: [{
            characterKey: 'character.lin',
            blocking: '画面左侧',
          }],
        }],
      },
      actingDirections: [{
        panelNumber: 1,
        characters: [{
          characterKey: 'character.lin',
          acting: '克制地环顾四周',
        }],
      }],
      panels: [{
        panelKey: 'panel-001',
        panelNumber: 1,
        description: '林晓走入房间',
        characters: [{
          characterKey: 'character.lin',
          appearanceKey: 'appearance.lin.default',
          slot: 'left',
        }],
        propKeys: ['prop.bag'],
        locationKey: 'location.home',
        sceneType: '室内',
        sourceText: '林晓走入房间。',
        shotType: '中景',
        cameraMove: '固定',
        videoPrompt: '林晓缓慢走入房间',
        durationSec: 5,
        panelMode: 'single',
        groupVideoPrompt: null,
        usePreviousPanelTailAsReference: false,
        frames: [{
          frameKey: 'frame-001',
          frameIndex: 0,
          frameTimeSec: 0,
          frameRole: 'hero',
          dependencyFrameKeys: [],
          imagePrompt: '中景，林晓站在门口',
          videoPrompt: '林晓走进房间',
          referencePolicy: {
            orderedReferences: [
              { kind: 'location', targetKey: 'location.home' },
              {
                kind: 'character-appearance',
                targetKey: 'appearance.lin.default',
              },
              { kind: 'prop', targetKey: 'prop.bag' },
            ],
          },
        }, {
          frameKey: 'frame-002',
          frameIndex: 1,
          frameTimeSec: 3,
          frameRole: 'reaction',
          dependencyFrameKeys: ['frame-001'],
          imagePrompt: '林晓回头',
          videoPrompt: '林晓突然回头',
          referencePolicy: {
            orderedReferences: [
              { kind: 'frame', targetKey: 'frame-001' },
            ],
          },
        }],
      }, {
        panelKey: 'panel-002',
        panelNumber: 2,
        description: '林晓发现线索',
        characters: [{
          characterKey: 'character.lin',
          appearanceKey: 'appearance.lin.default',
          slot: 'center',
        }],
        propKeys: ['prop.bag'],
        locationKey: 'location.home',
        sceneType: '室内',
        sourceText: '她发现了线索。',
        shotType: '特写',
        cameraMove: '推进',
        videoPrompt: '镜头推进到林晓的手',
        durationSec: 5,
        panelMode: 'group',
        groupVideoPrompt: '连续展示发现线索的动作',
        usePreviousPanelTailAsReference: true,
        frames: [{
          frameKey: 'frame-003',
          frameIndex: 0,
          frameTimeSec: 0,
          frameRole: 'hero',
          dependencyFrameKeys: [],
          imagePrompt: '手部特写',
          videoPrompt: '镜头推进',
          referencePolicy: {
            orderedReferences: [{
              kind: 'previous-panel-tail',
              targetKey: 'frame-002',
            }],
          },
        }, {
          frameKey: 'frame-004',
          frameIndex: 1,
          frameTimeSec: 4,
          frameRole: 'detail',
          dependencyFrameKeys: ['frame-003'],
          imagePrompt: '线索特写',
          videoPrompt: '手拿起线索',
          referencePolicy: {
            orderedReferences: [{
              kind: 'frame',
              targetKey: 'frame-003',
            }],
          },
        }],
      }],
    }, {
      storyboardKey: 'storyboard-002',
      clipKey: 'clip-002',
      photographyPlan: {
        visualStrategy: '静态观察',
        continuityRules: [],
        rules: [],
      },
      actingDirections: [],
      panels: [],
    }],
  }
}

function expectReferenceError(
  value: StoryboardsArtifact,
  field: string,
): void {
  expect(() => validateStoryboardArtifact(
    value,
    assets(),
    clips(),
    'episode-001',
  )).toThrowError(expect.objectContaining<Partial<AgentApiError>>({
    code: 'REFERENCE_INVALID',
    field,
  }))
}

describe('validateStoryboardArtifact', () => {
  it('accepts exact clip coverage and normative single supporting frames', () => {
    expect(() => validateStoryboardArtifact(
      artifact(),
      assets(),
      clips(),
      'episode-001',
    )).not.toThrow()
  })

  it('requires exactly one storyboard for every current episode clip', () => {
    const value = artifact()
    value.storyboards.pop()
    expectReferenceError(value, 'data.storyboards')

    const foreign = artifact()
    foreign.storyboards[1].clipKey = 'clip-other'
    expectReferenceError(foreign, 'data.storyboards[1].clipKey')
  })

  it('rejects decreasing frame times and frame references that bypass dependencies', () => {
    const decreasing = artifact()
    decreasing.storyboards[0].panels[0].frames[1].frameTimeSec = 0
    decreasing.storyboards[0].panels[0].frames[0].frameTimeSec = 1
    expectReferenceError(
      decreasing,
      'data.storyboards[0].panels[0].frames[0].frameTimeSec',
    )

    const bypass = artifact()
    bypass.storyboards[0].panels[0].frames[1].dependencyFrameKeys = []
    expectReferenceError(
      bypass,
      'data.storyboards[0].panels[0].frames[1].referencePolicy.orderedReferences[0].targetKey',
    )
  })

  it('resolves characters, appearances, locations, props, and their relationships', () => {
    const appearance = artifact()
    appearance.storyboards[0].panels[0].characters[0].appearanceKey =
      'appearance.zhou.default'
    expectReferenceError(
      appearance,
      'data.storyboards[0].panels[0].characters[0].appearanceKey',
    )

    const location = artifact()
    location.storyboards[0].panels[0].locationKey = 'location.missing'
    expectReferenceError(
      location,
      'data.storyboards[0].panels[0].locationKey',
    )

    const prop = artifact()
    prop.storyboards[0].panels[0].propKeys = ['prop.missing']
    expectReferenceError(
      prop,
      'data.storyboards[0].panels[0].propKeys[0]',
    )

    const orderedAppearance = artifact()
    orderedAppearance.storyboards[0].panels[0].frames[0]
      .referencePolicy.orderedReferences[1].targetKey =
        'appearance.missing'
    expectReferenceError(
      orderedAppearance,
      'data.storyboards[0].panels[0].frames[0].referencePolicy.orderedReferences[1].targetKey',
    )
  })

  it('validates photography and acting panel-character scope', () => {
    const photography = artifact()
    photography.storyboards[0].photographyPlan.rules[0]
      .characters[0].characterKey = 'character.zhou'
    expectReferenceError(
      photography,
      'data.storyboards[0].photographyPlan.rules[0].characters[0].characterKey',
    )

    const duplicateRule = artifact()
    duplicateRule.storyboards[0].photographyPlan.rules.push(
      structuredClone(duplicateRule.storyboards[0].photographyPlan.rules[0]),
    )
    expectReferenceError(
      duplicateRule,
      'data.storyboards[0].photographyPlan.rules[1].panelNumber',
    )

    const acting = artifact()
    acting.storyboards[0].actingDirections[0]
      .characters[0].characterKey = 'character.zhou'
    expectReferenceError(
      acting,
      'data.storyboards[0].actingDirections[0].characters[0].characterKey',
    )
  })

  it('requires previous-panel-tail to be on the first frame and target the prior tail', () => {
    const firstPanel = artifact()
    firstPanel.storyboards[0].panels[0].frames[0]
      .referencePolicy.orderedReferences.push({
        kind: 'previous-panel-tail',
        targetKey: 'frame-002',
      })
    expectReferenceError(
      firstPanel,
      'data.storyboards[0].panels[0].frames[0].referencePolicy.orderedReferences[3].targetKey',
    )

    const laterFrame = artifact()
    const panel = laterFrame.storyboards[0].panels[1]
    panel.frames[0].referencePolicy.orderedReferences = []
    panel.frames[1].referencePolicy.orderedReferences.push({
      kind: 'previous-panel-tail',
      targetKey: 'frame-002',
    })
    expectReferenceError(
      laterFrame,
      'data.storyboards[0].panels[1].frames[1].referencePolicy.orderedReferences[1].targetKey',
    )
  })
})
