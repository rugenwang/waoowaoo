import type { Job } from 'bullmq'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { TASK_TYPE, type TaskJobData } from '@/lib/task/types'

const prismaMock = vi.hoisted(() => ({
  novelPromotionPanel: {
    findUnique: vi.fn(),
    update: vi.fn(async () => ({})),
  },
  novelPromotionPanelFrame: {
    update: vi.fn(async () => ({})),
  },
}))

const utilsMock = vi.hoisted(() => ({
  assertTaskActive: vi.fn(async () => undefined),
  getProjectModels: vi.fn(async () => ({ storyboardModel: 'storyboard-model-1', artStyle: 'realistic' })),
  resolveImageSourceFromGeneration: vi.fn(),
  toSignedUrlIfCos: vi.fn((value: string | null | undefined) => value ? `signed:${value}` : null),
  uploadImageSourceToCos: vi.fn(),
}))

const sharedMock = vi.hoisted(() => ({
  collectPanelReferenceImages: vi.fn(async () => ['https://signed.example/ref-1.png']),
  resolveNovelData: vi.fn(async () => ({
    videoRatio: '16:9',
    characters: [],
    locations: [
      {
        name: 'Old Town',
        images: [
          {
            isSelected: true,
            description: '雨夜街道',
            availableSlots: JSON.stringify([
              '街道左侧靠墙的留白位置',
            ]),
          },
        ],
      },
    ],
  })),
}))

const outboundMock = vi.hoisted(() => ({
  normalizeReferenceImagesForGeneration: vi.fn(async (..._args: unknown[]) => ['normalized-ref-1']),
}))

const promptMock = vi.hoisted(() => ({
  buildPrompt: vi.fn(() => 'panel-image-prompt'),
}))

vi.mock('@/lib/prisma', () => ({ prisma: prismaMock }))
vi.mock('@/lib/workers/utils', () => utilsMock)
vi.mock('@/lib/task/service', () => ({ clearTaskExternalId: vi.fn(async () => true) }))
vi.mock('@/lib/media/outbound-image', () => outboundMock)
vi.mock('@/lib/workers/shared', () => ({ reportTaskProgress: vi.fn(async () => undefined) }))
vi.mock('@/lib/logging/core', () => ({
  logInfo: vi.fn(),
  createScopedLogger: vi.fn(() => ({
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    event: vi.fn(),
    child: vi.fn(),
  })),
}))
vi.mock('@/lib/workers/handlers/image-task-handler-shared', async () => {
  const actual = await vi.importActual<typeof import('@/lib/workers/handlers/image-task-handler-shared')>(
    '@/lib/workers/handlers/image-task-handler-shared',
  )
  return {
    ...actual,
    collectPanelReferenceImages: sharedMock.collectPanelReferenceImages,
    resolveNovelData: sharedMock.resolveNovelData,
  }
})
vi.mock('@/lib/prompt-i18n', () => ({
  PROMPT_IDS: { NP_SINGLE_PANEL_IMAGE: 'np_single_panel_image' },
  buildPrompt: promptMock.buildPrompt,
}))

import {
  buildStoryboardHardConstraints,
  buildPanelStructuredPrompt,
  handlePanelImageTask,
} from '@/lib/workers/handlers/panel-image-task-handler'

function buildJob(payload: Record<string, unknown>, targetId = 'panel-1'): Job<TaskJobData> {
  return {
    data: {
      taskId: 'task-panel-image-1',
      type: TASK_TYPE.IMAGE_PANEL,
      locale: 'zh',
      projectId: 'project-1',
      episodeId: 'episode-1',
      targetType: 'NovelPromotionPanel',
      targetId,
      payload,
      userId: 'user-1',
    },
  } as unknown as Job<TaskJobData>
}

describe('worker panel-image-task-handler behavior', () => {
  beforeEach(() => {
    vi.clearAllMocks()

    prismaMock.novelPromotionPanel.findUnique.mockResolvedValue({
      id: 'panel-1',
      storyboardId: 'storyboard-1',
      panelIndex: 0,
      shotType: 'close-up',
      cameraMove: 'static',
      description: 'hero close-up',
      imagePrompt: 'panel anchor prompt',
      videoPrompt: 'dramatic',
      location: 'Old Town',
      characters: JSON.stringify([{ name: 'Hero', appearance: 'default', slot: '街道左侧靠墙的留白位置' }]),
      srtSegment: '台词片段',
      photographyRules: null,
      actingNotes: null,
      sketchImageUrl: null,
      imageUrl: null,
      panelMode: 'single',
      frames: [],
    })

    utilsMock.resolveImageSourceFromGeneration
      .mockResolvedValueOnce('generated-source-1')
      .mockResolvedValueOnce('generated-source-2')

    utilsMock.uploadImageSourceToCos
      .mockResolvedValueOnce('cos/panel-candidate-1.png')
      .mockResolvedValueOnce('cos/panel-candidate-2.png')
  })

  it('missing panelId -> explicit error', async () => {
    const job = buildJob({}, '')
    await expect(handlePanelImageTask(job)).rejects.toThrow('panelId missing')
  })

  it('first generation -> persists main image and candidate list', async () => {
    const job = buildJob({ candidateCount: 2 })
    const result = await handlePanelImageTask(job)

    expect(result).toEqual({
      panelId: 'panel-1',
      candidateCount: 2,
      imageUrl: 'cos/panel-candidate-1.png',
    })

    expect(utilsMock.resolveImageSourceFromGeneration).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        modelId: 'storyboard-model-1',
        prompt: expect.stringContaining('panel-image-prompt'),
        allowTaskExternalIdResume: false,
        options: expect.objectContaining({
          referenceImages: ['normalized-ref-1'],
          aspectRatio: '16:9',
        }),
      }),
    )
    expect(promptMock.buildPrompt).toHaveBeenCalledWith(expect.objectContaining({
      variables: expect.objectContaining({
        storyboard_text_json_input: expect.stringContaining('"slot": "街道左侧靠墙的留白位置"'),
      }),
    }))
    expect(promptMock.buildPrompt).toHaveBeenCalledWith(expect.objectContaining({
      variables: expect.objectContaining({
        storyboard_text_json_input: expect.stringContaining('"available_slots"'),
      }),
    }))

    expect(prismaMock.novelPromotionPanel.update).toHaveBeenCalledWith({
      where: { id: 'panel-1' },
      data: {
        imageUrl: 'cos/panel-candidate-1.png',
        candidateImages: JSON.stringify(['cos/panel-candidate-1.png', 'cos/panel-candidate-2.png']),
      },
    })
  })

  it('first generation -> appends same-face constraint to storyboard image prompt', async () => {
    const job = buildJob({ candidateCount: 1 })
    await handlePanelImageTask(job)

    expect(utilsMock.resolveImageSourceFromGeneration).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        prompt: expect.stringContaining('多人或一群人的场景'),
      }),
    )
    expect(utilsMock.resolveImageSourceFromGeneration).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        prompt: expect.stringContaining('同一张脸'),
      }),
    )
  })

  it('regeneration branch -> keeps old image in previousImageUrl and stores candidates only', async () => {
    utilsMock.resolveImageSourceFromGeneration.mockReset()
    utilsMock.uploadImageSourceToCos.mockReset()

    prismaMock.novelPromotionPanel.findUnique.mockResolvedValueOnce({
      id: 'panel-1',
      storyboardId: 'storyboard-1',
      panelIndex: 0,
      shotType: 'close-up',
      cameraMove: 'static',
      description: 'hero close-up',
      imagePrompt: null,
      videoPrompt: 'dramatic',
      location: 'Old Town',
      characters: '[]',
      srtSegment: null,
      photographyRules: null,
      actingNotes: null,
      sketchImageUrl: null,
      imageUrl: 'cos/panel-old.png',
      panelMode: 'single',
      frames: [],
    })

    utilsMock.resolveImageSourceFromGeneration.mockResolvedValueOnce('generated-source-regen')
    utilsMock.uploadImageSourceToCos.mockResolvedValueOnce('cos/panel-regenerated.png')

    const job = buildJob({ candidateCount: 1 })
    const result = await handlePanelImageTask(job)

    expect(result).toEqual({
      panelId: 'panel-1',
      candidateCount: 1,
      imageUrl: null,
    })

    expect(prismaMock.novelPromotionPanel.update).toHaveBeenCalledWith({
      where: { id: 'panel-1' },
      data: {
        previousImageUrl: 'cos/panel-old.png',
        candidateImages: JSON.stringify(['cos/panel-regenerated.png']),
      },
    })
  })

  it('group generation -> persists first frame to main panel image immediately and continues remaining frames', async () => {
    utilsMock.resolveImageSourceFromGeneration.mockReset()
    utilsMock.uploadImageSourceToCos.mockReset()
    prismaMock.novelPromotionPanel.update.mockClear()
    prismaMock.novelPromotionPanelFrame.update.mockClear()

    prismaMock.novelPromotionPanel.findUnique.mockResolvedValueOnce({
      id: 'panel-1',
      storyboardId: 'storyboard-1',
      panelIndex: 0,
      shotType: 'medium',
      cameraMove: 'push-in',
      description: 'group scene',
      imagePrompt: null,
      videoPrompt: 'group motion',
      groupVideoPrompt: 'group video prompt',
      location: 'Old Town',
      characters: '[]',
      srtSegment: null,
      photographyRules: null,
      actingNotes: null,
      sketchImageUrl: null,
      imageUrl: null,
      panelMode: 'group',
      frames: [
        {
          id: 'frame-1',
          frameIndex: 0,
          frameTimeSec: 0,
          frameRole: 'hero',
          dependencyFrameIds: null,
          imagePrompt: 'frame 1 prompt',
          videoPrompt: null,
          imageUrl: null,
        },
        {
          id: 'frame-2',
          frameIndex: 1,
          frameTimeSec: 4,
          frameRole: 'continuity',
          dependencyFrameIds: '[0]',
          imagePrompt: 'frame 2 prompt',
          videoPrompt: null,
          imageUrl: null,
        },
      ],
    })

    utilsMock.resolveImageSourceFromGeneration
      .mockResolvedValueOnce('generated-frame-source-1')
      .mockResolvedValueOnce('generated-frame-source-2')
    utilsMock.uploadImageSourceToCos
      .mockResolvedValueOnce('cos/frame-1.png')
      .mockResolvedValueOnce('cos/frame-2.png')

    const result = await handlePanelImageTask(buildJob({ candidateCount: 1 }))

    expect(result).toEqual({
      panelId: 'panel-1',
      candidateCount: 2,
      imageUrl: 'cos/frame-1.png',
      panelImageUrl: 'cos/frame-1.png',
    })
    expect(utilsMock.resolveImageSourceFromGeneration).toHaveBeenCalledTimes(2)
    expect(prismaMock.novelPromotionPanel.update).toHaveBeenNthCalledWith(1, {
      where: { id: 'panel-1' },
      data: {
        imageUrl: 'cos/frame-1.png',
        candidateImages: null,
      },
    })
    expect(prismaMock.novelPromotionPanelFrame.update).toHaveBeenCalledWith({
      where: { id: 'frame-2' },
      data: {
        generationStatus: 'completed',
        imageUrl: 'cos/frame-2.png',
        errorMessage: null,
      },
    })
  })

  it('target frame regeneration -> only regenerates selected frame and uses generated dependencies', async () => {
    utilsMock.resolveImageSourceFromGeneration.mockReset()
    utilsMock.uploadImageSourceToCos.mockReset()
    prismaMock.novelPromotionPanel.update.mockClear()
    prismaMock.novelPromotionPanelFrame.update.mockClear()

    prismaMock.novelPromotionPanel.findUnique.mockResolvedValueOnce({
      id: 'panel-1',
      storyboardId: 'storyboard-1',
      panelIndex: 0,
      shotType: 'medium',
      cameraMove: 'push-in',
      description: 'group scene',
      imagePrompt: null,
      videoPrompt: 'group motion',
      groupVideoPrompt: 'group video prompt',
      location: 'Old Town',
      characters: '[]',
      srtSegment: null,
      photographyRules: null,
      actingNotes: null,
      sketchImageUrl: null,
      imageUrl: 'cos/frame-1-old.png',
      panelMode: 'group',
      frames: [
        {
          id: 'frame-1',
          frameIndex: 0,
          frameTimeSec: 0,
          frameRole: 'base',
          dependencyFrameIds: null,
          imagePrompt: 'frame 1 prompt',
          videoPrompt: null,
          imageUrl: 'cos/frame-1-old.png',
        },
        {
          id: 'frame-2',
          frameIndex: 1,
          frameTimeSec: 4,
          frameRole: 'continuity',
          dependencyFrameIds: '[0]',
          imagePrompt: 'frame 2 prompt',
          videoPrompt: null,
          imageUrl: 'cos/frame-2-old.png',
        },
      ],
    })

    utilsMock.resolveImageSourceFromGeneration.mockResolvedValueOnce('generated-frame-source-2')
    utilsMock.uploadImageSourceToCos.mockResolvedValueOnce('cos/frame-2-new.png')

    const result = await handlePanelImageTask(buildJob({
      candidateCount: 1,
      targetFrameId: 'frame-2',
    }))

    expect(result).toEqual({
      panelId: 'panel-1',
      candidateCount: 1,
      imageUrl: 'cos/frame-2-new.png',
      panelImageUrl: 'cos/frame-1-old.png',
      frameId: 'frame-2',
      frameIndex: 1,
    })
    expect(utilsMock.resolveImageSourceFromGeneration).toHaveBeenCalledTimes(1)
    expect(utilsMock.toSignedUrlIfCos).toHaveBeenCalledWith('cos/frame-1-old.png', 3600)
    expect(prismaMock.novelPromotionPanelFrame.update).toHaveBeenCalledWith({
      where: { id: 'frame-2' },
      data: {
        generationStatus: 'completed',
        imageUrl: 'cos/frame-2-new.png',
        errorMessage: null,
      },
    })
    expect(prismaMock.novelPromotionPanel.update).toHaveBeenCalledTimes(1)
    expect(prismaMock.novelPromotionPanel.update).toHaveBeenCalledWith({
      where: { id: 'panel-1' },
      data: {
        imageUrl: 'cos/frame-1-old.png',
        candidateImages: null,
      },
    })
  })

  it('target frame regeneration -> rejects when dependency frame has not been generated', async () => {
    utilsMock.resolveImageSourceFromGeneration.mockReset()
    utilsMock.uploadImageSourceToCos.mockReset()
    prismaMock.novelPromotionPanelFrame.update.mockClear()

    prismaMock.novelPromotionPanel.findUnique.mockResolvedValueOnce({
      id: 'panel-1',
      storyboardId: 'storyboard-1',
      panelIndex: 0,
      shotType: 'medium',
      cameraMove: 'push-in',
      description: 'group scene',
      imagePrompt: null,
      videoPrompt: 'group motion',
      groupVideoPrompt: 'group video prompt',
      location: 'Old Town',
      characters: '[]',
      srtSegment: null,
      photographyRules: null,
      actingNotes: null,
      sketchImageUrl: null,
      imageUrl: null,
      panelMode: 'group',
      frames: [
        {
          id: 'frame-1',
          frameIndex: 0,
          frameTimeSec: 0,
          frameRole: 'base',
          dependencyFrameIds: null,
          imagePrompt: 'frame 1 prompt',
          videoPrompt: null,
          imageUrl: null,
        },
        {
          id: 'frame-2',
          frameIndex: 1,
          frameTimeSec: 4,
          frameRole: 'continuity',
          dependencyFrameIds: '[0]',
          imagePrompt: 'frame 2 prompt',
          videoPrompt: null,
          imageUrl: null,
        },
      ],
    })

    await expect(handlePanelImageTask(buildJob({
      candidateCount: 1,
      targetFrameId: 'frame-2',
    }))).rejects.toThrow('请先生成关联帧 F1，再重新生成 F2')
    expect(utilsMock.resolveImageSourceFromGeneration).not.toHaveBeenCalled()
  })

  it('target frame regeneration -> uses only direct linked frame references plus panel asset references', async () => {
    utilsMock.resolveImageSourceFromGeneration.mockReset()
    utilsMock.uploadImageSourceToCos.mockReset()
    utilsMock.toSignedUrlIfCos.mockClear()
    prismaMock.novelPromotionPanel.update.mockClear()
    prismaMock.novelPromotionPanelFrame.update.mockClear()
    outboundMock.normalizeReferenceImagesForGeneration.mockImplementation(async (...args: unknown[]) => {
      const refs = Array.isArray(args[0]) ? args[0] as string[] : []
      return refs.map((ref) => `normalized:${ref}`)
    })

    prismaMock.novelPromotionPanel.findUnique.mockResolvedValueOnce({
      id: 'panel-1',
      storyboardId: 'storyboard-1',
      panelIndex: 0,
      shotType: 'medium',
      cameraMove: 'push-in',
      description: 'group scene',
      imagePrompt: null,
      videoPrompt: 'group motion',
      groupVideoPrompt: 'group video prompt',
      location: 'Old Town',
      characters: '[]',
      srtSegment: null,
      photographyRules: null,
      actingNotes: null,
      sketchImageUrl: null,
      imageUrl: 'cos/frame-1-old.png',
      panelMode: 'group',
      frames: [
        {
          id: 'frame-1',
          frameIndex: 0,
          frameTimeSec: 0,
          frameRole: 'base',
          dependencyFrameIds: null,
          imagePrompt: 'frame 1 prompt',
          videoPrompt: null,
          imageUrl: 'cos/frame-1-old.png',
        },
        {
          id: 'frame-2',
          frameIndex: 1,
          frameTimeSec: 4,
          frameRole: 'continuity',
          dependencyFrameIds: '[0]',
          imagePrompt: 'frame 2 prompt',
          videoPrompt: null,
          imageUrl: 'cos/frame-2-old.png',
        },
        {
          id: 'frame-3',
          frameIndex: 2,
          frameTimeSec: 8,
          frameRole: 'continuity',
          dependencyFrameIds: '[1]',
          imagePrompt: 'frame 3 prompt',
          videoPrompt: null,
          imageUrl: 'cos/frame-3-old.png',
        },
      ],
    })

    utilsMock.resolveImageSourceFromGeneration.mockResolvedValueOnce('generated-frame-source-3')
    utilsMock.uploadImageSourceToCos.mockResolvedValueOnce('cos/frame-3-new.png')

    await handlePanelImageTask(buildJob({
      candidateCount: 1,
      targetFrameId: 'frame-3',
    }))

    expect(utilsMock.toSignedUrlIfCos).toHaveBeenCalledTimes(1)
    expect(utilsMock.toSignedUrlIfCos).toHaveBeenCalledWith('cos/frame-2-old.png', 3600)
    expect(utilsMock.resolveImageSourceFromGeneration).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        prompt: expect.stringContaining('同一张脸'),
        options: expect.objectContaining({
          referenceImages: [
            'normalized:signed:cos/frame-2-old.png',
            'normalized:https://signed.example/ref-1.png',
          ],
        }),
      }),
    )
  })

  it('hard constraints explicitly forbid same faces in multi-person shots', () => {
    const zh = buildStoryboardHardConstraints({
      locale: 'zh',
      aspectRatio: '16:9',
      styleText: '写实短剧风格',
      referenceImagesCount: 1,
    })
    const en = buildStoryboardHardConstraints({
      locale: 'en',
      aspectRatio: '16:9',
      styleText: 'realistic drama',
      referenceImagesCount: 1,
    })

    expect(zh).toContain('多人或一群人的场景')
    expect(zh).toContain('同一张脸')
    expect(en).toContain('multi-person or crowd scenes')
    expect(en).toContain('same face')
  })

  it('structured prompt for local image generation does not pass video timeline as image prompt', () => {
    const prompt = buildPanelStructuredPrompt({
      locale: 'zh',
      aspectRatio: '16:9',
      styleText: '写实短剧风格',
      context: {
        panel: {
          panel_id: 'panel-1',
          shot_type: '平视中景',
          camera_move: '缓推',
          description: '年轻女子站在窗边回头',
          image_prompt: '年轻女子站在窗边回头，手扶窗框，暖光侧逆光',
          video_prompt: '00:00-00:03\n运镜：缓推\n人物：年轻女子\n动作：走到窗边后回头\n台词：无台词',
          location: '书房',
          characters: [],
          source_text: '',
          photography_rules: null,
          acting_notes: null,
        },
        context: {
          character_appearances: [],
          location_reference: null,
        },
      },
    })

    expect(prompt).toContain('静态生图提示：年轻女子站在窗边回头，手扶窗框，暖光侧逆光')
    expect(prompt).not.toContain('00:00-00:03')
    expect(prompt).not.toContain('运镜：缓推')
    expect(prompt).not.toContain('补充提示')
  })
})
