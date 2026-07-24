import Ajv from 'ajv'
import { describe, expect, it } from 'vitest'

import {
  CommitEnvelopeSchema,
  ExternalKeySchema,
  InputKindHintSchema,
  InputKindSchema,
  LocaleSchema,
  RunStatusSchema,
  Sha256Schema,
} from '@/lib/agent-api/contracts/common'
import {
  ResolveProjectRequestSchema,
} from '@/lib/agent-api/contracts/project'
import { CreateRunRequestSchema } from '@/lib/agent-api/contracts/run'
import { StoryCommitRequestSchema } from '@/lib/agent-api/contracts/story'
import { AssetsCommitRequestSchema } from '@/lib/agent-api/contracts/assets'
import { ScreenplayCommitRequestSchema } from '@/lib/agent-api/contracts/screenplay'
import { StoryboardsCommitRequestSchema } from '@/lib/agent-api/contracts/storyboards'
import {
  UploadFieldsSchema,
  UploadFileLikeSchema,
} from '@/lib/agent-api/contracts/upload'
import { FinalizeRequestSchema } from '@/lib/agent-api/contracts/finalize'
import {
  AGENT_CONTRACT_IDS,
  agentContractRegistry,
} from '@/lib/agent-api/contracts/registry'

const HASH_A = `sha256:${'a'.repeat(64)}`
const HASH_B = `sha256:${'b'.repeat(64)}`
const HASH_C = `sha256:${'c'.repeat(64)}`

const commit = <T>(data: T) => ({
  schemaVersion: 1 as const,
  ruleSetVersion: '2026.07.24',
  ruleSetHash: HASH_A,
  artifactHash: HASH_B,
  dryRun: false,
  data,
})

const projectFixture = {
  name: 'Demo project',
  description: 'A concise project introduction',
}

const runFixture = {
  schemaVersion: 1 as const,
  sourceHash: HASH_A,
  runFingerprint: HASH_B,
  inputKindHint: 'auto' as const,
  locale: 'zh' as const,
  effectiveOptions: {
    artStyle: 'realistic',
    videoRatio: '9:16',
    episodeSplitHint: 'auto',
  },
  ruleSetVersion: '2026.07.24',
  ruleSetHash: HASH_C,
  definitionHash: HASH_A,
  episodes: [
    {
      episodeKey: 'episode-001',
      ordinal: 1,
      sourceHash: HASH_A,
      name: 'Episode one',
      description: 'The opening episode',
    },
  ],
}

const storyFixture = commit({
  episodeKey: 'episode-001',
  sourceHash: HASH_A,
  inputKind: 'story' as const,
  name: 'Episode one',
  description: 'The opening episode',
  novelText: 'The original story text.',
})

const assetsFixture = commit({
  characters: [
    {
      characterKey: 'character-lin',
      name: 'Lin',
      aliases: ['Xiao Lin'],
      introduction: 'The protagonist',
      gender: 'female' as const,
      ageRange: '20-25',
      roleLevel: 'S' as const,
      archetype: 'hero',
      personalityTags: ['calm'],
      eraPeriod: 'modern',
      socialClass: 'middle',
      occupation: 'designer',
      costumeTier: 3,
      suggestedColors: ['blue'],
      primaryIdentifier: 'silver necklace',
      visualKeywords: ['short hair'],
      appearances: [
        {
          appearanceKey: 'appearance-lin-001',
          appearanceOrdinal: 1,
          changeReason: 'default',
          visualDescription: 'Short black hair and a blue coat',
        },
      ],
    },
  ],
  locations: [
    {
      locationKey: 'location-studio',
      name: 'Studio',
      summary: 'A bright design studio',
      availableSlots: ['window'],
      descriptions: ['Wide view of the studio'],
    },
  ],
  props: [
    {
      propKey: 'prop-necklace',
      name: 'Necklace',
      summary: 'A keepsake',
      visualDescription: 'A small silver necklace',
    },
  ],
})

const screenplayFixture = commit({
  episodeKey: 'episode-001',
  clips: [
    {
      clipKey: 'clip-001',
      ordinal: 1,
      startText: 'The original',
      endText: 'story text.',
      summary: 'Lin enters the studio',
      locationKey: 'location-studio',
      characterKeys: ['character-lin'],
      propKeys: ['prop-necklace'],
      content: 'Lin enters.\nLin: I am here.',
      screenplay: {
        originalText: 'Lin enters.\nLin: I am here.',
        scenes: [
          {
            sceneNumber: 1,
            heading: {
              intExt: 'INT' as const,
              locationKey: 'location-studio',
              time: 'DAY',
            },
            description: 'Lin enters the room',
            characterKeys: ['character-lin'],
            content: [
              { type: 'action' as const, text: 'Lin enters.' },
              {
                type: 'dialogue' as const,
                characterKey: 'character-lin',
                parenthetical: 'quietly',
                lines: 'I am here.',
              },
              {
                type: 'voiceover' as const,
                speakerLabel: 'Narrator',
                text: 'The day begins.',
              },
            ],
          },
        ],
      },
    },
  ],
})

const frame = (
  frameKey: string,
  frameIndex: number,
  frameTimeSec: number,
  frameRole: 'hero' | 'transition' = 'hero',
) => ({
  frameKey,
  frameIndex,
  frameTimeSec,
  frameRole,
  dependencyFrameKeys: [] as string[],
  imagePrompt: `Image prompt ${frameKey}`,
  videoPrompt: `Video prompt ${frameKey}`,
  referencePolicy: {
    orderedReferences: [] as Array<{
      kind: 'frame' | 'previous-panel-tail' | 'location' | 'character-appearance' | 'prop'
      targetKey: string
    }>,
  },
})

const panel = (
  panelKey: string,
  panelNumber: number,
  frames: ReturnType<typeof frame>[],
  panelMode: 'single' | 'group',
) => ({
  panelKey,
  panelNumber,
  description: `Panel ${panelNumber}`,
  characters: [
    {
      characterKey: 'character-lin',
      appearanceKey: 'appearance-lin-001',
      slot: 'center',
    },
  ],
  propKeys: ['prop-necklace'],
  locationKey: 'location-studio',
  sceneType: 'interior',
  sourceText: 'Lin enters.',
  shotType: 'medium',
  cameraMove: 'static',
  videoPrompt: `Panel video prompt ${panelNumber}`,
  durationSec: 5,
  panelMode,
  groupVideoPrompt: panelMode === 'group' ? 'Group motion prompt' : null,
  usePreviousPanelTailAsReference: false,
  frames,
})

const firstPanel = panel('panel-001', 1, [frame('frame-001', 0, 0)], 'single')
const secondPanel = panel(
  'panel-002',
  2,
  [
    frame('frame-002', 0, 0),
    {
      ...frame('frame-003', 1, 2, 'transition'),
      dependencyFrameKeys: ['frame-002'],
      referencePolicy: {
        orderedReferences: [
          { kind: 'frame' as const, targetKey: 'frame-002' },
          { kind: 'previous-panel-tail' as const, targetKey: 'frame-001' },
        ],
      },
    },
  ],
  'group',
)
secondPanel.usePreviousPanelTailAsReference = true

const storyboardsFixture = commit({
  episodeKey: 'episode-001',
  storyboards: [
    {
      storyboardKey: 'storyboard-001',
      clipKey: 'clip-001',
      photographyPlan: {
        visualStrategy: 'Naturalistic continuity',
        continuityRules: ['Keep screen direction'],
        rules: [1, 2].map((panelNumber) => ({
          panelNumber,
          composition: 'balanced',
          lighting: 'soft',
          colorPalette: 'cool',
          atmosphere: 'quiet',
          technicalNotes: '35mm',
          depthOfField: 'medium',
          colorTone: 'blue',
          characters: [
            {
              characterKey: 'character-lin',
              blocking: 'center',
            },
          ],
        })),
      },
      actingDirections: [1, 2].map((panelNumber) => ({
        panelNumber,
        characters: [
          {
            characterKey: 'character-lin',
            acting: 'restrained',
          },
        ],
      })),
      panels: [firstPanel, secondPanel],
    },
  ],
})

const fileLike = {
  name: 'frame.webp',
  type: 'image/webp',
  size: 1024,
  arrayBuffer: async () => new ArrayBuffer(0),
}

const uploadFixture = {
  targetType: 'panel-frame' as const,
  targetKey: 'frame-001',
  variantIndex: 0,
  contentSha256: HASH_A,
  file: fileLike,
}

const finalizeFixture = {
  schemaVersion: 1 as const,
  ruleSetHash: HASH_A,
  expected: {
    assets: HASH_A,
    stories: { 'episode-001': HASH_B },
    screenplays: { 'episode-001': HASH_C },
    storyboards: { 'episode-001': HASH_A },
  },
}

const requestFixtures = {
  'waoo-agent-resolve-project.v1': projectFixture,
  'waoo-agent-create-run.v1': runFixture,
  'waoo-agent-story.v1': storyFixture,
  'waoo-agent-assets.v1': assetsFixture,
  'waoo-agent-screenplay.v1': screenplayFixture,
  'waoo-agent-storyboards.v1': storyboardsFixture,
  'waoo-agent-upload.v1': uploadFixture,
  'waoo-agent-finalize.v1': finalizeFixture,
} as const

function clone<T>(value: T): T {
  return structuredClone(value)
}

function issuePaths(result: { success: boolean; error?: { issues: Array<{ path: PropertyKey[] }> } }) {
  if (result.success) return []
  return result.error?.issues.map((issue) => issue.path.join('.')) ?? []
}

describe('common Agent API contract scalars', () => {
  it('validates ExternalKey, Sha256, locale, input kind, hint, and run status', () => {
    expect(ExternalKeySchema.safeParse('episode-001').success).toBe(true)
    expect(ExternalKeySchema.safeParse('Episode 001').success).toBe(false)
    expect(ExternalKeySchema.safeParse(`a${'b'.repeat(64)}`).success).toBe(false)

    expect(Sha256Schema.safeParse(HASH_A).success).toBe(true)
    expect(Sha256Schema.safeParse(`sha256:${'A'.repeat(64)}`).success).toBe(false)

    expect(LocaleSchema.options).toEqual(['zh', 'en'])
    expect(InputKindSchema.options).toEqual(['outline', 'story', 'screenplay'])
    expect(InputKindHintSchema.options).toEqual(['auto', 'outline', 'story', 'screenplay'])
    expect(RunStatusSchema.options).toEqual([
      'created',
      'story_committed',
      'assets_committed',
      'screenplay_committed',
      'storyboards_committed',
      'images_in_progress',
      'incomplete',
      'completed',
      'failed',
    ])
  })

  it('requires CommitEnvelope schemaVersion to equal 1', () => {
    expect(CommitEnvelopeSchema.safeParse(storyFixture).success).toBe(true)
    expect(CommitEnvelopeSchema.safeParse({ ...storyFixture, schemaVersion: 2 }).success).toBe(false)
  })
})

describe('strict objects and documented size limits', () => {
  it.each(Object.entries(requestFixtures))('%s rejects unknown top-level fields', (id, fixture) => {
    const schema = agentContractRegistry[id as keyof typeof agentContractRegistry].zodSchema
    expect(schema.safeParse({ ...fixture, unknownField: true }).success).toBe(false)
  })

  it('rejects unknown nested fields', () => {
    const invalid = clone(storyFixture)
    Object.assign(invalid.data, { episodeNumber: 1 })
    expect(StoryCommitRequestSchema.safeParse(invalid).success).toBe(false)
  })

  it('enforces name, introduction, description, prompt, story, and clip content limits', () => {
    expect(ResolveProjectRequestSchema.safeParse({ name: 'x'.repeat(101) }).success).toBe(false)
    expect(ResolveProjectRequestSchema.safeParse({ name: '   ' }).success).toBe(false)
    expect(ResolveProjectRequestSchema.safeParse({
      name: 'ok',
      description: 'x'.repeat(2001),
    }).success).toBe(false)

    const assets = clone(assetsFixture)
    assets.data.characters[0].introduction = 'x'.repeat(2001)
    expect(AssetsCommitRequestSchema.safeParse(assets).success).toBe(false)
    assets.data.characters[0].introduction = 'valid'
    assets.data.characters[0].appearances[0].visualDescription = 'x'.repeat(20001)
    expect(AssetsCommitRequestSchema.safeParse(assets).success).toBe(false)

    const story = clone(storyFixture)
    story.data.novelText = 'x'.repeat(500001)
    expect(StoryCommitRequestSchema.safeParse(story).success).toBe(false)

    const screenplay = clone(screenplayFixture)
    screenplay.data.clips[0].content = 'x'.repeat(500001)
    screenplay.data.clips[0].screenplay.originalText = screenplay.data.clips[0].content
    expect(ScreenplayCommitRequestSchema.safeParse(screenplay).success).toBe(false)

    const storyboards = clone(storyboardsFixture)
    storyboards.data.storyboards[0].panels[0].frames[0].imagePrompt = 'x'.repeat(20001)
    expect(StoryboardsCommitRequestSchema.safeParse(storyboards).success).toBe(false)
  })

  it('enforces documented array limits', () => {
    const run = clone(runFixture)
    run.episodes = Array.from({ length: 201 }, (_, index) => ({
      ...runFixture.episodes[0],
      episodeKey: `episode-${String(index + 1).padStart(3, '0')}`,
      ordinal: index + 1,
    }))
    expect(CreateRunRequestSchema.safeParse(run).success).toBe(false)

    const assets = clone(assetsFixture)
    assets.data.props = Array.from({ length: 499 }, (_, index) => ({
      ...assetsFixture.data.props[0],
      propKey: `prop-${String(index + 1).padStart(3, '0')}`,
    }))
    expect(AssetsCommitRequestSchema.safeParse(assets).success).toBe(false)

    const screenplay = clone(screenplayFixture)
    screenplay.data.clips = Array.from({ length: 1001 }, (_, index) => ({
      ...screenplayFixture.data.clips[0],
      clipKey: `clip-${String(index + 1).padStart(4, '0')}`,
      ordinal: index + 1,
    }))
    expect(ScreenplayCommitRequestSchema.safeParse(screenplay).success).toBe(false)

    const storyboards = clone(storyboardsFixture)
    const base = storyboards.data.storyboards[0]
    base.panels = Array.from({ length: 201 }, (_, index) => ({
      ...clone(firstPanel),
      panelKey: `panel-${String(index + 1).padStart(3, '0')}`,
      panelNumber: index + 1,
      frames: [{
        ...clone(firstPanel.frames[0]),
        frameKey: `frame-${String(index + 1).padStart(3, '0')}`,
      }],
    }))
    base.photographyPlan.rules = base.panels.map((_, index) => ({
      ...clone(storyboardsFixture.data.storyboards[0].photographyPlan.rules[0]),
      panelNumber: index + 1,
    }))
    base.actingDirections = base.panels.map((_, index) => ({
      ...clone(storyboardsFixture.data.storyboards[0].actingDirections[0]),
      panelNumber: index + 1,
    }))
    expect(StoryboardsCommitRequestSchema.safeParse(storyboards).success).toBe(false)

    const tooManyFrames = clone(storyboardsFixture)
    tooManyFrames.data.storyboards[0].panels[1].frames = Array.from(
      { length: 21 },
      (_, index) => ({
        ...frame(`frame-many-${index}`, index, index, index === 0 ? 'hero' : 'transition'),
      }),
    )
    expect(StoryboardsCommitRequestSchema.safeParse(tooManyFrames).success).toBe(false)
  })
})

describe('ordered and cross-field invariants', () => {
  it('requires episode, appearance, scene, clip, panel, and frame ordinals to be continuous', () => {
    const run = clone(runFixture)
    run.episodes[0].ordinal = 2
    expect(issuePaths(CreateRunRequestSchema.safeParse(run))).toContain('episodes.0.ordinal')

    const assets = clone(assetsFixture)
    assets.data.characters[0].appearances.push({
      ...assets.data.characters[0].appearances[0],
      appearanceKey: 'appearance-lin-003',
      appearanceOrdinal: 3,
    })
    expect(issuePaths(AssetsCommitRequestSchema.safeParse(assets))).toContain(
      'data.characters.0.appearances.1.appearanceOrdinal',
    )

    const screenplay = clone(screenplayFixture)
    screenplay.data.clips[0].ordinal = 2
    expect(issuePaths(ScreenplayCommitRequestSchema.safeParse(screenplay))).toContain(
      'data.clips.0.ordinal',
    )
    screenplay.data.clips[0].ordinal = 1
    screenplay.data.clips[0].screenplay.scenes[0].sceneNumber = 2
    expect(issuePaths(ScreenplayCommitRequestSchema.safeParse(screenplay))).toContain(
      'data.clips.0.screenplay.scenes.0.sceneNumber',
    )

    const storyboards = clone(storyboardsFixture)
    storyboards.data.storyboards[0].panels[1].panelNumber = 3
    expect(issuePaths(StoryboardsCommitRequestSchema.safeParse(storyboards))).toContain(
      'data.storyboards.0.panels.1.panelNumber',
    )
    storyboards.data.storyboards[0].panels[1].panelNumber = 2
    storyboards.data.storyboards[0].panels[1].frames[1].frameIndex = 2
    expect(issuePaths(StoryboardsCommitRequestSchema.safeParse(storyboards))).toContain(
      'data.storyboards.0.panels.1.frames.1.frameIndex',
    )
  })

  it('enforces single and group frame modes', () => {
    const single = clone(storyboardsFixture)
    single.data.storyboards[0].panels[0].frames[0].frameRole = 'transition'
    expect(issuePaths(StoryboardsCommitRequestSchema.safeParse(single))).toContain(
      'data.storyboards.0.panels.0.frames',
    )

    const singlePrompt = clone(storyboardsFixture)
    singlePrompt.data.storyboards[0].panels[0].groupVideoPrompt = 'not allowed'
    expect(issuePaths(StoryboardsCommitRequestSchema.safeParse(singlePrompt))).toContain(
      'data.storyboards.0.panels.0.groupVideoPrompt',
    )

    const group = clone(storyboardsFixture)
    group.data.storyboards[0].panels[1].frames = [group.data.storyboards[0].panels[1].frames[0]]
    expect(issuePaths(StoryboardsCommitRequestSchema.safeParse(group))).toContain(
      'data.storyboards.0.panels.1.frames',
    )

    const groupPrompt = clone(storyboardsFixture)
    groupPrompt.data.storyboards[0].panels[1].groupVideoPrompt = null
    expect(issuePaths(StoryboardsCommitRequestSchema.safeParse(groupPrompt))).toContain(
      'data.storyboards.0.panels.1.groupVideoPrompt',
    )
  })

  it('enforces frame times and backward-only dependencies', () => {
    const firstTime = clone(storyboardsFixture)
    firstTime.data.storyboards[0].panels[1].frames[0].frameTimeSec = 1
    expect(issuePaths(StoryboardsCommitRequestSchema.safeParse(firstTime))).toContain(
      'data.storyboards.0.panels.1.frames.0.frameTimeSec',
    )

    const beyondDuration = clone(storyboardsFixture)
    beyondDuration.data.storyboards[0].panels[1].frames[1].frameTimeSec = 6
    expect(issuePaths(StoryboardsCommitRequestSchema.safeParse(beyondDuration))).toContain(
      'data.storyboards.0.panels.1.frames.1.frameTimeSec',
    )

    const dependency = clone(storyboardsFixture)
    dependency.data.storyboards[0].panels[1].frames[0].dependencyFrameKeys = ['frame-003']
    expect(issuePaths(StoryboardsCommitRequestSchema.safeParse(dependency))).toContain(
      'data.storyboards.0.panels.1.frames.0.dependencyFrameKeys.0',
    )
  })

  it('allows previous-panel-tail only for the immediately previous panel last frame', () => {
    expect(StoryboardsCommitRequestSchema.safeParse(storyboardsFixture).success).toBe(true)

    const invalid = clone(storyboardsFixture)
    invalid.data.storyboards[0].panels[1].frames[1].referencePolicy.orderedReferences[1]
      .targetKey = 'frame-unknown'
    expect(issuePaths(StoryboardsCommitRequestSchema.safeParse(invalid))).toContain(
      'data.storyboards.0.panels.1.frames.1.referencePolicy.orderedReferences.1.targetKey',
    )
  })

  it('allows normative storyboard shapes that do not add undocumented constraints', () => {
    const sameTime = clone(storyboardsFixture)
    sameTime.data.storyboards[0].panels[1].frames[1].frameTimeSec = 0
    expect(StoryboardsCommitRequestSchema.safeParse(sameTime).success).toBe(true)

    const singleWithSupportingFrame = clone(storyboardsFixture)
    singleWithSupportingFrame.data.storyboards[0].panels[0].frames.push({
      ...frame('frame-001-detail', 1, 1, 'transition'),
    })
    singleWithSupportingFrame.data.storyboards[0].panels[1].frames[1]
      .referencePolicy.orderedReferences[1].targetKey = 'frame-001-detail'
    expect(StoryboardsCommitRequestSchema.safeParse(singleWithSupportingFrame).success).toBe(true)

    const optionalPlans = clone(storyboardsFixture)
    optionalPlans.data.storyboards[0].photographyPlan.rules = []
    optionalPlans.data.storyboards[0].actingDirections = []
    expect(StoryboardsCommitRequestSchema.safeParse(optionalPlans).success).toBe(true)
  })

  it('enforces screenplay original-text equality, voiceover speaker, and asset key shapes', () => {
    const original = clone(screenplayFixture)
    original.data.clips[0].screenplay.originalText = 'different'
    expect(issuePaths(ScreenplayCommitRequestSchema.safeParse(original))).toContain(
      'data.clips.0.screenplay.originalText',
    )

    const voiceover = clone(screenplayFixture)
    const item = voiceover.data.clips[0].screenplay.scenes[0].content[2]
    if (item.type === 'voiceover') {
      Reflect.deleteProperty(item, 'speakerLabel')
    }
    expect(issuePaths(ScreenplayCommitRequestSchema.safeParse(voiceover))).toContain(
      'data.clips.0.screenplay.scenes.0.content.2.speakerLabel',
    )

    const reference = clone(screenplayFixture)
    reference.data.clips[0].characterKeys = ['Invalid Character Key']
    expect(issuePaths(ScreenplayCommitRequestSchema.safeParse(reference))).toContain(
      'data.clips.0.characterKeys.0',
    )
  })
})

describe('upload runtime and JSON Schema representations', () => {
  it('validates target, MIME, file-like shape, variantIndex, and panel-frame index', () => {
    expect(UploadFieldsSchema.safeParse(uploadFixture).success).toBe(true)
    expect(UploadFileLikeSchema.safeParse(fileLike).success).toBe(true)
    expect(UploadFieldsSchema.safeParse({
      ...uploadFixture,
      targetType: 'unknown',
    }).success).toBe(false)
    expect(UploadFieldsSchema.safeParse({
      ...uploadFixture,
      file: { ...fileLike, type: 'image/gif' },
    }).success).toBe(false)
    expect(UploadFieldsSchema.safeParse({
      ...uploadFixture,
      file: { ...fileLike, size: -1 },
    }).success).toBe(false)
    expect(UploadFieldsSchema.safeParse({
      ...uploadFixture,
      file: { name: 'frame.webp', type: 'image/webp', size: 1 },
    }).success).toBe(false)
    expect(UploadFieldsSchema.safeParse({
      ...uploadFixture,
      variantIndex: -1,
    }).success).toBe(false)
    expect(UploadFieldsSchema.safeParse({
      ...uploadFixture,
      variantIndex: 1,
    }).success).toBe(false)
  })

  it('exports upload file as a required described binary string', () => {
    const entry = agentContractRegistry['waoo-agent-upload.v1']
    const jsonSchema = entry.jsonSchema as {
      definitions?: Record<string, unknown>
    }
    const definition = jsonSchema.definitions?.['waoo-agent-upload.v1'] as {
      required?: string[]
      properties?: Record<string, {
        type?: string
        format?: string
        description?: string
      }>
    }
    const fileSchema = definition.properties?.file

    expect(definition.required).toContain('file')
    expect(fileSchema).toMatchObject({ type: 'string', format: 'binary' })
    expect(fileSchema?.description).toMatch(/image\/png.*image\/jpeg.*image\/webp/i)
    expect(fileSchema?.description).toMatch(/size/i)
  })
})

describe('single-source JSON Schema registry', () => {
  it('contains the eight fixed contract IDs', () => {
    expect(AGENT_CONTRACT_IDS).toEqual([
      'waoo-agent-resolve-project.v1',
      'waoo-agent-create-run.v1',
      'waoo-agent-story.v1',
      'waoo-agent-assets.v1',
      'waoo-agent-screenplay.v1',
      'waoo-agent-storyboards.v1',
      'waoo-agent-upload.v1',
      'waoo-agent-finalize.v1',
    ])
    expect(Object.keys(agentContractRegistry)).toEqual(AGENT_CONTRACT_IDS)
  })

  it('compiles every generated Draft-07 schema in strict AJV', () => {
    const ajv = new Ajv({ strict: true, allErrors: true })
    ajv.addFormat('binary', true)

    for (const { jsonSchema } of Object.values(agentContractRegistry)) {
      expect(jsonSchema.$schema).toBe('http://json-schema.org/draft-07/schema#')
      expect(() => ajv.compile(jsonSchema)).not.toThrow()
    }
  })

  it.each(AGENT_CONTRACT_IDS.filter((id) => id !== 'waoo-agent-upload.v1'))(
    '%s has matching Zod and AJV results for shared fixtures',
    (id) => {
      const entry = agentContractRegistry[id]
      const ajv = new Ajv({ strict: true, allErrors: true })
      ajv.addFormat('binary', true)
      const validate = ajv.compile(entry.jsonSchema)
      const fixture = requestFixtures[id]

      expect(entry.zodSchema.safeParse(fixture).success).toBe(validate(fixture))
      const invalid = { ...fixture, unexpected: true }
      expect(entry.zodSchema.safeParse(invalid).success).toBe(validate(invalid))
    },
  )

  it('keeps nonblank user-visible text consistent between Zod and AJV', () => {
    const entry = agentContractRegistry['waoo-agent-resolve-project.v1']
    const ajv = new Ajv({ strict: true, allErrors: true })
    const validate = ajv.compile(entry.jsonSchema)
    const whitespaceName = { name: '   ' }

    expect(entry.zodSchema.safeParse(whitespaceName).success).toBe(false)
    expect(validate(whitespaceName)).toBe(false)
  })

  it('keeps multipart Zod and AJV adapter fixtures consistent', () => {
    const entry = agentContractRegistry['waoo-agent-upload.v1']
    const ajv = new Ajv({ strict: true, allErrors: true })
    ajv.addFormat('binary', true)
    const validate = ajv.compile(entry.jsonSchema)
    const pairs = [
      {
        runtime: uploadFixture,
        json: { ...uploadFixture, file: fileLike.name },
      },
      {
        runtime: { ...uploadFixture, unexpected: true },
        json: { ...uploadFixture, file: fileLike.name, unexpected: true },
      },
    ]

    for (const pair of pairs) {
      expect(entry.zodSchema.safeParse(pair.runtime).success).toBe(validate(pair.json))
    }
  })
})

describe('all primary request fixtures', () => {
  it('accepts valid project, run, artifacts, upload, and finalize requests', () => {
    expect(ResolveProjectRequestSchema.safeParse(projectFixture).success).toBe(true)
    expect(CreateRunRequestSchema.safeParse(runFixture).success).toBe(true)
    expect(StoryCommitRequestSchema.safeParse(storyFixture).success).toBe(true)
    expect(AssetsCommitRequestSchema.safeParse(assetsFixture).success).toBe(true)
    expect(ScreenplayCommitRequestSchema.safeParse(screenplayFixture).success).toBe(true)
    expect(StoryboardsCommitRequestSchema.safeParse(storyboardsFixture).success).toBe(true)
    expect(UploadFieldsSchema.safeParse(uploadFixture).success).toBe(true)
    expect(FinalizeRequestSchema.safeParse(finalizeFixture).success).toBe(true)
  })
})
