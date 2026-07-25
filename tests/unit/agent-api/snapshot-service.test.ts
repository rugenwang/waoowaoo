import { beforeEach, describe, expect, it, vi } from 'vitest'

const prismaMock = vi.hoisted(() => ({
  agentCreationRun: { findUnique: vi.fn() },
  novelPromotionEpisode: { findMany: vi.fn() },
  novelPromotionCharacter: { findMany: vi.fn() },
  characterAppearance: { findMany: vi.fn() },
  novelPromotionLocation: { findMany: vi.fn() },
  locationImage: { findMany: vi.fn() },
  novelPromotionClip: { findMany: vi.fn() },
  novelPromotionStoryboard: { findMany: vi.fn() },
  novelPromotionPanel: { findMany: vi.fn() },
  novelPromotionPanelFrame: { findMany: vi.fn() },
  mediaObject: { findMany: vi.fn() },
  task: { findMany: vi.fn() },
  graphRun: { findMany: vi.fn() },
  usageCost: { findMany: vi.fn() },
}))

vi.mock('@/lib/prisma', () => ({ prisma: prismaMock }))

import {
  buildAppearanceCandidateOwnerId,
  buildProjectedEntityId,
} from '@/lib/agent-api/entity-id'
import {
  serializeArtifactHashes,
  serializeAssetMap,
  serializeClipMap,
  serializeEpisodeMap,
  serializeStoryboardMap,
  serializeUploadReceipts,
} from '@/lib/agent-api/run-state'
import { getRunSnapshot } from '@/lib/agent-api/services/snapshot-service'

const HASH = (letter: string) => `sha256:${letter.repeat(64)}`
const ids = {
  run: 'run-1',
  project: 'project-1',
  novelProject: 'novel-project-1',
  episode: 'episode-1',
  character: 'character-1',
  appearance: 'appearance-1',
  location: 'location-1',
  locationImage: buildProjectedEntityId(
    'run-1',
    'LocationImage',
    'home:0',
  ),
  prop: 'prop-1',
  propImage: buildProjectedEntityId(
    'run-1',
    'LocationImage',
    'sword:0',
  ),
  clip: buildProjectedEntityId('run-1', 'Clip', 'clip-1'),
  storyboard: buildProjectedEntityId(
    'run-1',
    'Storyboard',
    'storyboard-1',
  ),
  panel: buildProjectedEntityId('run-1', 'Panel', 'panel-1'),
  frame: buildProjectedEntityId('run-1', 'Frame', 'frame-1'),
  mediaCharacter: 'media-character',
  mediaLocation: 'media-location',
  mediaProp: 'media-prop',
  mediaFrame: 'media-frame',
}

const storage = {
  character: `agent-runs/${ids.run}/character-appearance/hero-main/0/${'a'.repeat(64)}.jpg`,
  location: `agent-runs/${ids.run}/location-image/home/0/${'b'.repeat(64)}.jpg`,
  prop: `agent-runs/${ids.run}/prop-image/sword/0/${'c'.repeat(64)}.jpg`,
  frame: `agent-runs/${ids.run}/panel-frame/frame-1/0/${'d'.repeat(64)}.jpg`,
}

function baseRun(overrides: Record<string, unknown> = {}) {
  const characterSlot = buildAppearanceCandidateOwnerId(
    ids.run,
    'hero-main',
    0,
    0,
  )
  return {
    id: ids.run,
    userId: 'user-1',
    projectId: ids.project,
    status: 'images_in_progress',
    currentStage: 'images_in_progress',
    ruleSetHash: HASH('9'),
    completedAt: null,
    episodeMapJson: serializeEpisodeMap({
      ep1: {
        episodeKey: 'ep1',
        episodeId: ids.episode,
        episodeNumber: 1,
        ordinal: 1,
        sourceHash: HASH('1'),
        name: '第一集',
        status: 'storyboards_committed',
      },
    }),
    assetMapJson: serializeAssetMap({
      characters: {
        hero: {
          characterKey: 'hero',
          characterId: ids.character,
          reused: true,
          appearances: {
            'hero-main': {
              appearanceKey: 'hero-main',
              appearanceId: ids.appearance,
              appearanceIndex: 0,
              reused: true,
              variantSlots: {
                '0': { entityId: characterSlot, index: 0 },
              },
            },
          },
        },
      },
      locations: {
        home: {
          assetKey: 'home',
          entityId: ids.location,
          reused: true,
          imageSlots: {
            '0': { entityId: ids.locationImage, index: 0 },
          },
        },
      },
      props: {
        sword: {
          assetKey: 'sword',
          entityId: ids.prop,
          reused: true,
          imageSlots: {
            '0': { entityId: ids.propImage, index: 0 },
          },
        },
      },
    }),
    clipMapJson: serializeClipMap({
      'clip-1': {
        clipKey: 'clip-1',
        clipId: ids.clip,
        episodeKey: 'ep1',
        ordinal: 1,
      },
    }),
    storyboardMapJson: serializeStoryboardMap({
      storyboards: {
        'storyboard-1': {
          storyboardKey: 'storyboard-1',
          storyboardId: ids.storyboard,
          episodeKey: 'ep1',
          clipKey: 'clip-1',
        },
      },
      panels: {
        'panel-1': {
          panelKey: 'panel-1',
          panelId: ids.panel,
          storyboardKey: 'storyboard-1',
          panelIndex: 0,
        },
      },
      frames: {
        'frame-1': {
          frameKey: 'frame-1',
          frameId: ids.frame,
          panelKey: 'panel-1',
          frameIndex: 0,
        },
      },
    }),
    artifactHashesJson: serializeArtifactHashes({
      assets: HASH('2'),
      stories: { ep1: HASH('3') },
      screenplays: { ep1: HASH('4') },
      storyboards: { ep1: HASH('5') },
    }),
    receiptJson: serializeUploadReceipts([
      {
        targetType: 'character-appearance',
        targetKey: 'hero-main',
        variantIndex: 0,
        contentSha256: HASH('a'),
        mediaId: ids.mediaCharacter,
        storageKey: storage.character,
        url: '/m/character',
      },
      {
        targetType: 'location-image',
        targetKey: 'home',
        variantIndex: 0,
        contentSha256: HASH('b'),
        mediaId: ids.mediaLocation,
        storageKey: storage.location,
        url: '/m/location',
      },
      {
        targetType: 'prop-image',
        targetKey: 'sword',
        variantIndex: 0,
        contentSha256: HASH('c'),
        mediaId: ids.mediaProp,
        storageKey: storage.prop,
        url: '/m/prop',
      },
      {
        targetType: 'panel-frame',
        targetKey: 'frame-1',
        variantIndex: 0,
        contentSha256: HASH('d'),
        mediaId: ids.mediaFrame,
        storageKey: storage.frame,
        url: '/m/frame',
      },
    ]),
    project: { userId: 'user-1' },
    ...overrides,
  }
}

function primeCompleteState() {
  prismaMock.agentCreationRun.findUnique.mockResolvedValue(baseRun())
  prismaMock.novelPromotionEpisode.findMany.mockResolvedValue([{
    id: ids.episode,
    episodeNumber: 1,
    novelText: '正文',
    novelPromotionProjectId: ids.novelProject,
    novelPromotionProject: { projectId: ids.project },
  }])
  prismaMock.novelPromotionCharacter.findMany.mockResolvedValue([{
    id: ids.character,
    novelPromotionProjectId: ids.novelProject,
    novelPromotionProject: { projectId: ids.project },
  }])
  prismaMock.characterAppearance.findMany.mockResolvedValue([{
    id: ids.appearance,
    characterId: ids.character,
    appearanceIndex: 0,
    imageUrls: JSON.stringify([storage.character]),
    imageUrl: 'historical-selected.jpg',
    imageMediaId: ids.mediaCharacter,
  }])
  prismaMock.novelPromotionLocation.findMany.mockResolvedValue([
    {
      id: ids.location,
      novelPromotionProjectId: ids.novelProject,
      assetKind: 'location',
      selectedImageId: 'historical-location-image',
      novelPromotionProject: { projectId: ids.project },
    },
    {
      id: ids.prop,
      novelPromotionProjectId: ids.novelProject,
      assetKind: 'prop',
      selectedImageId: 'historical-prop-image',
      novelPromotionProject: { projectId: ids.project },
    },
  ])
  prismaMock.locationImage.findMany.mockResolvedValue([
    {
      id: ids.locationImage,
      locationId: ids.location,
      imageIndex: 0,
      imageUrl: storage.location,
      imageMediaId: ids.mediaLocation,
    },
    {
      id: ids.propImage,
      locationId: ids.prop,
      imageIndex: 0,
      imageUrl: storage.prop,
      imageMediaId: ids.mediaProp,
    },
  ])
  prismaMock.novelPromotionClip.findMany.mockResolvedValue([{
    id: ids.clip,
    episodeId: ids.episode,
  }])
  prismaMock.novelPromotionStoryboard.findMany.mockResolvedValue([{
    id: ids.storyboard,
    clipId: ids.clip,
    episodeId: ids.episode,
  }])
  prismaMock.novelPromotionPanel.findMany.mockResolvedValue([{
    id: ids.panel,
    storyboardId: ids.storyboard,
    panelIndex: 0,
    imageUrl: storage.frame,
    imageMediaId: ids.mediaFrame,
  }])
  prismaMock.novelPromotionPanelFrame.findMany.mockResolvedValue([{
    id: ids.frame,
    panelId: ids.panel,
    frameIndex: 0,
    imageUrl: storage.frame,
    imageMediaId: ids.mediaFrame,
    generationStatus: 'completed',
  }])
  prismaMock.mediaObject.findMany.mockResolvedValue([
    {
      id: ids.mediaCharacter,
      publicId: 'character',
      storageKey: storage.character,
    },
    {
      id: ids.mediaLocation,
      publicId: 'location',
      storageKey: storage.location,
    },
    {
      id: ids.mediaProp,
      publicId: 'prop',
      storageKey: storage.prop,
    },
    {
      id: ids.mediaFrame,
      publicId: 'frame',
      storageKey: storage.frame,
    },
  ])
  prismaMock.task.findMany.mockResolvedValue([])
  prismaMock.graphRun.findMany.mockResolvedValue([])
  prismaMock.usageCost.findMany.mockResolvedValue([])
}

describe('snapshot service integrity', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    primeCompleteState()
  })

  it('returns stable artifact hashes and only completed valid receipts', async () => {
    const snapshot = await getRunSnapshot({
      userId: 'user-1',
      runId: ids.run,
    })

    expect(snapshot.missing).toEqual([])
    expect(snapshot.uploads).toHaveLength(4)
    expect(snapshot.uploads.map((entry) => entry.targetType)).toEqual([
      'character-appearance',
      'location-image',
      'panel-frame',
      'prop-image',
    ])
    expect(snapshot.committedArtifactHashes).toEqual({
      assets: HASH('2'),
      stories: { ep1: HASH('3') },
      screenplays: { ep1: HASH('4') },
      storyboards: { ep1: HASH('5') },
    })
  })

  it('reports pending and historical images as stable recoverable missing items', async () => {
    const run = baseRun()
    const receipts = JSON.parse(run.receiptJson)
    receipts[0] = {
      targetType: 'character-appearance',
      targetKey: 'hero-main',
      variantIndex: 0,
      contentSha256: HASH('a'),
      status: 'pending',
      storageKey: storage.character,
    }
    prismaMock.agentCreationRun.findUnique.mockResolvedValue({
      ...run,
      receiptJson: JSON.stringify(receipts),
    })
    prismaMock.characterAppearance.findMany.mockResolvedValue([{
      id: ids.appearance,
      characterId: ids.character,
      appearanceIndex: 0,
      imageUrls: JSON.stringify(['historical-image.jpg']),
      imageUrl: 'historical-selected.jpg',
      imageMediaId: null,
    }])

    const snapshot = await getRunSnapshot({
      userId: 'user-1',
      runId: ids.run,
    })

    expect(snapshot.uploads).toHaveLength(3)
    expect(snapshot.missing).toEqual(expect.arrayContaining([
      expect.objectContaining({
        code: 'ASSET_IMAGE_MISSING',
        targetType: 'character-appearance',
        targetKey: 'hero-main',
      }),
      expect.objectContaining({
        code: 'UPLOAD_PENDING',
        targetType: 'character-appearance',
        targetKey: 'hero-main',
      }),
    ]))
  })

  it('requires persisted media links for location, prop, and frame while allowing candidate-only character links', async () => {
    prismaMock.characterAppearance.findMany.mockResolvedValue([{
      id: ids.appearance,
      characterId: ids.character,
      appearanceIndex: 0,
      imageUrls: JSON.stringify([storage.character]),
      imageUrl: 'historical-selected.jpg',
      imageMediaId: null,
    }])
    prismaMock.locationImage.findMany.mockResolvedValue([
      {
        id: ids.locationImage,
        locationId: ids.location,
        imageIndex: 0,
        imageUrl: storage.location,
        imageMediaId: null,
      },
      {
        id: ids.propImage,
        locationId: ids.prop,
        imageIndex: 0,
        imageUrl: storage.prop,
        imageMediaId: null,
      },
    ])
    prismaMock.novelPromotionPanel.findMany.mockResolvedValue([{
      id: ids.panel,
      storyboardId: ids.storyboard,
      panelIndex: 0,
      imageUrl: storage.frame,
      imageMediaId: null,
    }])
    prismaMock.novelPromotionPanelFrame.findMany.mockResolvedValue([{
      id: ids.frame,
      panelId: ids.panel,
      frameIndex: 0,
      imageUrl: storage.frame,
      imageMediaId: null,
      generationStatus: 'completed',
    }])

    const snapshot = await getRunSnapshot({
      userId: 'user-1',
      runId: ids.run,
    })

    expect(snapshot.missing).not.toEqual(expect.arrayContaining([
      expect.objectContaining({
        code: 'ASSET_IMAGE_MISSING',
        targetType: 'character-appearance',
      }),
    ]))
    expect(snapshot.missing).toEqual(expect.arrayContaining([
      expect.objectContaining({
        code: 'ASSET_IMAGE_MISSING',
        targetType: 'location-image',
        targetKey: 'home',
      }),
      expect.objectContaining({
        code: 'ASSET_IMAGE_MISSING',
        targetType: 'prop-image',
        targetKey: 'sword',
      }),
      expect.objectContaining({
        code: 'FRAME_IMAGE_MISSING',
        targetType: 'panel-frame',
        targetKey: 'frame-1',
      }),
    ]))
  })

  it('reports absent artifacts, panel frames, and frame images in a fixed order', async () => {
    prismaMock.agentCreationRun.findUnique.mockResolvedValue(baseRun({
      artifactHashesJson: serializeArtifactHashes({
        stories: {},
        screenplays: {},
        storyboards: {},
      }),
    }))
    prismaMock.novelPromotionPanelFrame.findMany.mockResolvedValue([])

    const first = await getRunSnapshot({
      userId: 'user-1',
      runId: ids.run,
    })
    const second = await getRunSnapshot({
      userId: 'user-1',
      runId: ids.run,
    })

    expect(second.missing).toEqual(first.missing)
    expect(first.missing.map((entry) => entry.code)).toEqual(
      [...first.missing.map((entry) => entry.code)].sort(),
    )
    expect(first.missing).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: 'ASSETS_MISSING' }),
      expect.objectContaining({ code: 'STORY_MISSING', targetKey: 'ep1' }),
      expect.objectContaining({ code: 'SCREENPLAY_MISSING', targetKey: 'ep1' }),
      expect.objectContaining({ code: 'STORYBOARD_MISSING', targetKey: 'ep1' }),
      expect.objectContaining({ code: 'FRAME_IMAGE_MISSING', targetKey: 'frame-1' }),
    ]))
  })

  it('degrades corrupt mappings into MAPPING_INVALID and flags only explicit run tasks', async () => {
    prismaMock.agentCreationRun.findUnique.mockResolvedValue(baseRun({
      assetMapJson: '{broken',
    }))
    prismaMock.task.findMany.mockResolvedValue([
      { id: 'task-old', payload: { meta: { agentCreationRunId: 'other' } } },
      { id: 'task-run', payload: { meta: { agentCreationRunId: ids.run } } },
    ])
    prismaMock.graphRun.findMany.mockResolvedValue([
      { id: 'graph-run', input: { meta: { agentCreationRunId: ids.run } } },
    ])

    const snapshot = await getRunSnapshot({
      userId: 'user-1',
      runId: ids.run,
    })

    expect(snapshot.missing).toEqual(expect.arrayContaining([
      expect.objectContaining({
        code: 'MAPPING_INVALID',
        targetType: 'run',
        targetKey: ids.run,
      }),
      expect.objectContaining({
        code: 'FORBIDDEN_TASK',
        targetType: 'task',
        targetKey: 'task-run',
      }),
      expect.objectContaining({
        code: 'FORBIDDEN_GRAPH_RUN',
        targetType: 'graph-run',
        targetKey: 'graph-run',
      }),
    ]))
    expect(snapshot.missing).not.toEqual(expect.arrayContaining([
      expect.objectContaining({ targetKey: 'task-old' }),
    ]))
  })
})
