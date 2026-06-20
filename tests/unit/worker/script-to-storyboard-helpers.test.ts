import { describe, expect, it } from 'vitest'
import {
  buildPanelFramePersistence,
  cleanPanelDescriptionText,
} from '@/lib/workers/handlers/script-to-storyboard-helpers'

describe('buildPanelFramePersistence', () => {
  it('为旧格式分镜补一个单关键帧', () => {
    const result = buildPanelFramePersistence({
      panel_number: 1,
      description: '年轻女子坐在书桌前打开电脑',
      source_text: '她打开电脑。',
      video_prompt: '【正面提示词】4K画质。\n【时间轴提示词】At0s：年轻女子打开电脑。',
      duration: 4,
    })

    expect(result.panelMode).toBe('single')
    expect(result.groupDurationSec).toBeNull()
    expect(result.duration).toBe(4)
    expect(result.frames).toHaveLength(1)
    expect(result.frames[0]).toMatchObject({
      frameIndex: 0,
      frameTimeSec: 0,
      frameRole: 'hero',
      imagePrompt: '无额外输入参考图；当前画面：年轻女子坐在书桌前打开电脑',
      generationStatus: 'pending',
    })
  })

  it('标准化复杂分镜组关键帧和组级提示词', () => {
    const result = buildPanelFramePersistence({
      panel_number: 2,
      panel_mode: 'group',
      complexity: 'action_transition',
      description: '少年从门口冲入房间并停在窗边',
      duration_sec: 24,
      group_video_prompt: '【正面提示词】4K画质，室内夜景。\n【时间轴提示词】At0s：少年冲入。At12s：少年停下。',
      frames: [
        {
          frame_index: 10,
          frame_time_sec: 12.4,
          frame_role: 'end',
          dependency_frame_ids: [0],
          image_prompt: '少年站在窗边回头',
          video_prompt: '少年从门口跑到窗边',
          reference_policy: { character_consistency: '保持少年服饰一致' },
        },
        {
          frame_index: 3,
          frame_time_sec: 0,
          frame_role: 'start',
          dependency_frame_ids: [],
          image_prompt: '少年推门冲入房间',
          video_prompt: '镜头跟随少年进门',
        },
      ],
    })

    expect(result.panelMode).toBe('group')
    expect(result.duration).toBe(20)
    expect(result.groupDurationSec).toBe(20)
    expect(result.groupVideoPrompt).toContain('室内夜景')
    expect(result.groupPlanJson).toContain('action_transition')
    expect(result.frames).toHaveLength(2)
    expect(result.frames.map((frame) => frame.frameIndex)).toEqual([0, 1])
    expect(result.frames.map((frame) => frame.frameTimeSec)).toEqual([0, 12.4])
    expect(result.frames[1]?.dependencyFrameIds).toBe('[0]')
    expect(result.frames[1]?.referencePolicy).toContain('保持少年服饰一致')
    expect(result.frames[1]?.imagePrompt).toContain('参考图F1为分镜组已生成关键帧 F1')
  })

  it('AI 初始规划里的 FP 不落库，上一尾帧只允许用户显式链接后写入', () => {
    const result = buildPanelFramePersistence({
      panel_number: 3,
      panel_mode: 'single',
      description: '林晚站在办公室门口准备回应',
      location: '办公室',
      characters: [{ name: '林晚', appearance: '初始形象' }],
      frames: [
        {
          frame_index: 0,
          frame_time_sec: 0,
          frame_role: 'hero',
          dependency_frame_ids: ['FP'],
          image_prompt: '林晚站在门口准备回应',
          reference_policy: {
            ordered_references: ['上一分镜尾帧 FP', '当前分镜场景图：办公室', '角色图：林晚 · 初始形象'],
          },
        },
      ],
    })

    expect(result.frames[0]?.dependencyFrameIds).toBeNull()
    expect(result.frames[0]?.imagePrompt).toBe('参考图F1为当前分镜场景图：办公室，参考图F2为角色图：林晚 · 初始形象；当前画面：林晚站在门口准备回应')
    expect(result.frames[0]?.referencePolicy).not.toContain('上一分镜尾帧')
  })

  it('AI 初始规划里已经写进 image_prompt 的 FP 参考说明也会被重建', () => {
    const result = buildPanelFramePersistence({
      panel_number: 4,
      panel_mode: 'single',
      description: '林晚走到办公桌旁',
      location: '办公室',
      characters: [{ name: '林晚', appearance: '初始形象' }],
      frames: [
        {
          frame_index: 0,
          frame_time_sec: 0,
          dependency_frame_ids: ['FP'],
          image_prompt: '参考图F1为上一个连续分镜的尾帧 FP，作为当前分镜的参考图，F2为当前分镜场景图：办公室，F3为角色图：林晚 · 初始形象；当前画面：年轻女子林晚走到办公桌旁。',
        },
      ],
    })

    expect(result.frames[0]?.dependencyFrameIds).toBeNull()
    expect(result.frames[0]?.imagePrompt).toBe('参考图F1为当前分镜场景图：办公室，参考图F2为角色图：林晚 · 初始形象；当前画面：年轻女子林晚走到办公桌旁。')
  })
})

describe('cleanPanelDescriptionText', () => {
  it('分镜描述被视频提示词污染时，优先回退到关键帧生图描述', () => {
    const result = cleanPanelDescriptionText({
      description: '高清4K，电影级质感，现代办公室场景，背景音乐为紧张悬疑大片配乐。\n\n00:00-00:04：平视中景固定镜，年轻女子开口说话。',
      source_text: '张曼开口分配任务。',
      frames: [
        {
          frame_index: 0,
          image_prompt: '参考图F1为当前分镜场景图：办公室，F2为角色图：张曼；当前画面：办公室近景，张曼站在画面右侧分配任务，林晚站在画面左侧听着。',
        },
      ],
    })

    expect(result).toBe('办公室近景，张曼站在画面右侧分配任务，林晚站在画面左侧听着。')
  })

  it('正常分镜描述不做改写', () => {
    expect(cleanPanelDescriptionText({
      description: '林晚站在办公桌旁紧张回应张曼',
      source_text: '林晚说她马上去。',
    })).toBe('林晚站在办公桌旁紧张回应张曼')
  })
})
