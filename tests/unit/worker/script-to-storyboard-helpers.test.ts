import { describe, expect, it } from 'vitest'
import { buildPanelFramePersistence } from '@/lib/workers/handlers/script-to-storyboard-helpers'

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
      imagePrompt: '年轻女子坐在书桌前打开电脑',
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
  })
})
