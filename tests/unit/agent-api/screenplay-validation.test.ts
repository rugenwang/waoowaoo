import { describe, expect, it } from 'vitest'

import type { ScreenplayArtifact } from '@/lib/agent-api/contracts/screenplay'
import { AgentApiError } from '@/lib/agent-api/errors'
import type { AssetMap } from '@/lib/agent-api/run-state'
import {
  validateScreenplayAnchors,
  validateScreenplayReferences,
} from '@/lib/agent-api/screenplay-validation'

function artifact(): ScreenplayArtifact {
  return {
    episodeKey: 'episode-001',
    clips: [{
      clipKey: 'clip-001',
      ordinal: 1,
      startText: '清晨',
      endText: '出门。',
      summary: '林晓出门',
      locationKey: 'location.home',
      characterKeys: ['character.lin'],
      propKeys: ['prop.bag'],
      content: '清晨，林晓拿起背包出门。',
      screenplay: {
        originalText: '清晨，林晓拿起背包出门。',
        scenes: [{
          sceneNumber: 1,
          heading: {
            intExt: 'INT',
            locationKey: 'location.home',
            time: '清晨',
          },
          description: '林晓准备出门。',
          characterKeys: ['character.lin'],
          content: [{
            type: 'dialogue',
            characterKey: 'character.lin',
            lines: '今天一定能找到线索。',
          }, {
            type: 'voiceover',
            speakerLabel: '旁白',
            text: '新的一天开始了。',
          }],
        }],
      },
    }],
  }
}

function assetMap(): AssetMap {
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
              0: { entityId: 'appearance-id', index: 0 },
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

function expectAgentError(
  action: () => unknown,
  code: AgentApiError['code'],
  field: string,
) {
  expect(action).toThrowError(expect.objectContaining({
    code,
    field,
  }))
}

describe('validateScreenplayAnchors', () => {
  it('advances a cursor so repeated anchors resolve to later occurrences', () => {
    const data = artifact()
    data.clips = [
      {
        ...data.clips[0],
        clipKey: 'clip-001',
        ordinal: 1,
        startText: '清晨',
        endText: '出门。',
      },
      {
        ...data.clips[0],
        clipKey: 'clip-002',
        ordinal: 2,
        startText: '清晨',
        endText: '出门。',
      },
    ]

    expect(validateScreenplayAnchors(
      '清晨，林晓拿起背包出门。过了一天，清晨，她再次出门。',
      data.clips,
    )).toEqual([
      { clipKey: 'clip-001', startIndex: 0, endIndex: 9 },
      { clipKey: 'clip-002', startIndex: 17, endIndex: 23 },
    ])
  })

  it('rejects empty, missing, and reverse-ordered anchors with precise fields', () => {
    const clip = artifact().clips[0]
    expectAgentError(
      () => validateScreenplayAnchors('清晨出门。', [{
        ...clip,
        startText: '',
      }]),
      'REFERENCE_INVALID',
      'data.clips[0].startText',
    )
    expectAgentError(
      () => validateScreenplayAnchors('清晨出门。', [{
        ...clip,
        startText: '深夜',
      }]),
      'REFERENCE_INVALID',
      'data.clips[0].startText',
    )
    expectAgentError(
      () => validateScreenplayAnchors('出门。然后清晨', [clip]),
      'REFERENCE_INVALID',
      'data.clips[0].endText',
    )
  })

  it('rejects a later clip that can only reuse an earlier consumed anchor', () => {
    const clip = artifact().clips[0]
    expectAgentError(
      () => validateScreenplayAnchors('清晨出门。', [
        clip,
        { ...clip, clipKey: 'clip-002', ordinal: 2 },
      ]),
      'REFERENCE_INVALID',
      'data.clips[1].startText',
    )
  })
})

describe('validateScreenplayReferences', () => {
  it('accepts clip, scene, dialogue, and labelled voiceover references', () => {
    expect(() => validateScreenplayReferences(
      artifact(),
      assetMap(),
    )).not.toThrow()
  })

  it.each([
    ['clip character', (data: ScreenplayArtifact) => {
      data.clips[0].characterKeys = ['character.missing']
    }, 'data.clips[0].characterKeys[0]'],
    ['clip location', (data: ScreenplayArtifact) => {
      data.clips[0].locationKey = 'location.missing'
    }, 'data.clips[0].locationKey'],
    ['clip prop', (data: ScreenplayArtifact) => {
      data.clips[0].propKeys = ['prop.missing']
    }, 'data.clips[0].propKeys[0]'],
    ['scene location', (data: ScreenplayArtifact) => {
      data.clips[0].screenplay.scenes[0].heading.locationKey = 'location.missing'
    }, 'data.clips[0].screenplay.scenes[0].heading.locationKey'],
    ['scene character', (data: ScreenplayArtifact) => {
      data.clips[0].screenplay.scenes[0].characterKeys = ['character.missing']
    }, 'data.clips[0].screenplay.scenes[0].characterKeys[0]'],
    ['dialogue character', (data: ScreenplayArtifact) => {
      data.clips[0].screenplay.scenes[0].content[0] = {
        type: 'dialogue',
        characterKey: 'character.missing',
        lines: '台词',
      }
    }, 'data.clips[0].screenplay.scenes[0].content[0].characterKey'],
    ['voiceover character', (data: ScreenplayArtifact) => {
      data.clips[0].screenplay.scenes[0].content[1] = {
        type: 'voiceover',
        characterKey: 'character.missing',
        text: '旁白',
      }
    }, 'data.clips[0].screenplay.scenes[0].content[1].characterKey'],
  ])('rejects an unresolved %s reference', (_name, mutate, field) => {
    const data = artifact()
    mutate(data)
    expectAgentError(
      () => validateScreenplayReferences(data, assetMap()),
      'REFERENCE_INVALID',
      field,
    )
  })

  it('rejects missing dialogue identities and unlabelled voiceovers defensively', () => {
    const dialogue = artifact()
    dialogue.clips[0].screenplay.scenes[0].content[0] = {
      type: 'dialogue',
      characterKey: '',
      lines: '台词',
    }
    expectAgentError(
      () => validateScreenplayReferences(dialogue, assetMap()),
      'REFERENCE_INVALID',
      'data.clips[0].screenplay.scenes[0].content[0].characterKey',
    )

    const voiceover = artifact()
    voiceover.clips[0].screenplay.scenes[0].content[1] = {
      type: 'voiceover',
      text: '旁白',
    }
    expectAgentError(
      () => validateScreenplayReferences(voiceover, assetMap()),
      'REFERENCE_INVALID',
      'data.clips[0].screenplay.scenes[0].content[1].speakerLabel',
    )
  })
})
