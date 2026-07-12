import { NextRequest, NextResponse } from 'next/server'
import { requireProjectAuth, isErrorResponse } from '@/lib/api-auth'
import { apiHandler, ApiError } from '@/lib/api-errors'
import { prisma } from '@/lib/prisma'
import { getProjectModelConfig } from '@/lib/config-service'
import { executeAiTextStep } from '@/lib/ai-runtime/client'
import { NARRATION_VISUAL_GUARD } from '@/lib/novel-promotion/storyboard-video-prompt-normalizer'

type PromptField = 'videoPrompt' | 'groupVideoPrompt' | 'firstLastFramePrompt'

function parsePromptField(value: unknown): PromptField {
  if (value === 'videoPrompt' || value === 'groupVideoPrompt' || value === 'firstLastFramePrompt') return value
  return 'videoPrompt'
}

function cleanVideoPromptText(value: string): string {
  const cleaned = value
    .replace(/^```(?:json|text|markdown)?\s*/i, '')
    .replace(/```\s*$/i, '')
    .replace(/^["']|["']$/g, '')
    .replace(/[①②③④⑤⑥⑦⑧⑨⑩]\s*/g, '')
    .replace(/(?:[（(]\s*)?(?:主运镜|辅助运镜)(?:\s*[）)])?/g, '')
    .replace(/【对话】\s*(?:无台词|无明确台词|暂无台词|没有台词)\s*[；;。]?/g, '')
    .replace(/台词：\s*(?:无台词|无明确台词|暂无台词|没有台词)\s*[；;。]?/g, '')
    .replace(/[ \t]+([，。；：])/g, '$1')
    .replace(/；{2,}/g, '；')
    .trim()

  return cleaned.replace(/【旁白】/g, (marker, offset) => {
    const prefix = cleaned.slice(Math.max(0, offset - NARRATION_VISUAL_GUARD.length), offset)
    return prefix === NARRATION_VISUAL_GUARD ? marker : `${NARRATION_VISUAL_GUARD}${marker}`
  })
}

function readCurrentPrompt(panel: {
  videoPrompt: string | null
  groupVideoPrompt: string | null
  firstLastFramePrompt: string | null
}, field: PromptField): string {
  if (field === 'firstLastFramePrompt') return panel.firstLastFramePrompt || panel.groupVideoPrompt || panel.videoPrompt || ''
  if (field === 'groupVideoPrompt') return panel.groupVideoPrompt || panel.videoPrompt || ''
  return panel.videoPrompt || panel.groupVideoPrompt || ''
}

export function buildVideoPromptInstruction(params: {
  field: PromptField
  additionalRequirement: string
  currentPrompt: string
  contextJson: string
}) {
  const targetName = params.field === 'firstLastFramePrompt'
    ? '首尾帧视频提示词'
    : params.field === 'groupVideoPrompt'
      ? '分镜组视频提示词'
      : '单分镜视频提示词'

  return `你是专业影视 AI 生视频提示词导演。根据上下文重新生成一条中文${targetName}，只输出最终正文。

【统一结构】
第一段以“高清4K”或“4K”开头，只写画质、当前环境、光线、视觉风格和背景音乐；不写具体人物、动作、表情、对白、旁白或运镜，不堆砌近义形容词，不写无闪烁/无崩脸/无畸形等负面词。结尾写“背景音乐为……，贯穿整段视频”。

第二部分使用连续时间轴，例如“00:00-00:04：……”。从 00:00 开始，结尾严格等于 durationSec；没有 durationSec 时按对白 2-3 个汉字约 1 秒，并加动作、停顿、运镜和环境时间，总时长不超过 20 秒。
- 每段只写一个动作阶段、一个主要运镜、最多一次转场；固定镜可以单独使用。
- 多人互动写清画面左/右、前/后、近/远、朝向和移动方向。
- 角色首次出现写“年龄段+性别+角色名”，后续可写角色名。
- 分镜未引用但必须提及的已有角色，只在对白外写“镜头外角色+角色名”；禁止把“镜头外角色”写进【对白】。
- 对白必须嵌入实际发生的时间段，紧跟说话人的动作，统一写作“【对白】角色名：「原文台词」”；禁止在连续时间轴结束后单独输出对白或再次标注对白时间。
- 时间轴格式示例：`00:00-00:03：平视中景固定镜，画面左侧年轻女子林晚转向右侧青年男性周明，低声说：【对白】林晚：「我明白了。」周明保持安静，目光落在林晚身上。`
- 真正由画面角色说出的原文台词使用【对白】；没有台词就省略，禁止占位。
- 旁白、内心独白、画外音使用【旁白】，并嵌入实际发生的时间段。每个【旁白】前必须写：“${NARRATION_VISUAL_GUARD}”
- 同一时间段不得同时出现【对白】和【旁白】；旁白段禁止开口、说话、嘴唇翕动或对口型，优先背影、侧面、反应或环境画面。

【镜头语言】
景别、角度和运镜分开选择。基础运镜使用固定、摇镜、倾斜、推进、拉远、横移、跟拍、升降、环绕、变焦、焦点转移；平稳/颠簸手持、甩镜、旋转、俯冲、穿梭仅在剧情需要时使用。同一句禁止既固定又运动。

【当前提示词】
${params.currentPrompt || '暂无'}

【分镜上下文 JSON】
${params.contextJson}

【用户补充要求】
${params.additionalRequirement || '无'}

直接输出最终视频提示词。`
}

export const POST = apiHandler(async (
  request: NextRequest,
  context: { params: Promise<{ projectId: string }> },
) => {
  const { projectId } = await context.params
  const authResult = await requireProjectAuth(projectId)
  if (isErrorResponse(authResult)) return authResult
  const { session } = authResult

  const body = await request.json().catch(() => ({}))
  const panelId = typeof body?.panelId === 'string' ? body.panelId.trim() : ''
  const storyboardId = typeof body?.storyboardId === 'string' ? body.storyboardId.trim() : ''
  const panelIndex = typeof body?.panelIndex === 'number' ? body.panelIndex : Number(body?.panelIndex)
  const field = parsePromptField(body?.field)
  const additionalRequirement = typeof body?.additionalRequirement === 'string'
    ? body.additionalRequirement.trim().slice(0, 2000)
    : ''

  if (!panelId && (!storyboardId || !Number.isFinite(panelIndex))) {
    throw new ApiError('INVALID_PARAMS', { message: 'panelId or storyboardId + panelIndex is required' })
  }

  const panel = await prisma.novelPromotionPanel.findFirst({
    where: panelId
      ? { id: panelId, storyboard: { episode: { novelPromotionProject: { projectId } } } }
      : { storyboardId, panelIndex, storyboard: { episode: { novelPromotionProject: { projectId } } } },
    include: { frames: { orderBy: { frameIndex: 'asc' } } },
  })
  if (!panel) throw new ApiError('NOT_FOUND')

  const modelConfig = await getProjectModelConfig(projectId, session.user.id)
  if (!modelConfig.analysisModel) throw new Error('请先在项目设置中配置分析模型')

  const duration = panel.duration || panel.groupDurationSec || null
  const contextPayload = {
    id: panel.id,
    panelIndex: panel.panelIndex,
    panelNumber: panel.panelNumber,
    panelMode: panel.panelMode,
    targetField: field,
    durationSec: duration,
    shotType: panel.shotType,
    cameraMove: panel.cameraMove,
    description: panel.description,
    location: panel.location,
    characters: panel.characters,
    props: panel.props,
    srtSegment: panel.srtSegment,
    imagePrompt: panel.imagePrompt,
    videoPrompt: panel.videoPrompt,
    groupVideoPrompt: panel.groupVideoPrompt,
    firstLastFramePrompt: panel.firstLastFramePrompt,
    actingNotes: panel.actingNotes,
    photographyRules: panel.photographyRules,
    frames: panel.frames.map((frame) => ({
      frameIndex: frame.frameIndex,
      frameTimeSec: frame.frameTimeSec,
      frameRole: frame.frameRole,
      imagePrompt: frame.imagePrompt,
      videoPrompt: frame.videoPrompt,
      referencePolicy: frame.referencePolicy,
    })),
  }
  const prompt = buildVideoPromptInstruction({
    field,
    additionalRequirement,
    currentPrompt: readCurrentPrompt(panel, field),
    contextJson: JSON.stringify(contextPayload, null, 2),
  })

  const res = await executeAiTextStep({
    userId: session.user.id,
    projectId,
    model: modelConfig.analysisModel,
    action: 'NP_REGENERATE_VIDEO_PROMPT',
    meta: {
      stepId: 'np_regenerate_video_prompt',
      stepTitle: 'regenerate_video_prompt',
      stepIndex: 1,
      stepTotal: 1,
      stepAttempt: 1,
    },
    reasoning: false,
    temperature: 0.25,
    messages: [{ role: 'user', content: prompt }],
  })

  const videoPrompt = cleanVideoPromptText(res.text)
  if (!videoPrompt) throw new ApiError('NO_RESULT', { message: '大模型没有返回有效视频提示词' })

  return NextResponse.json({
    success: true,
    prompt: videoPrompt,
    field,
    panelId: panel.id,
    storyboardId: panel.storyboardId,
    panelIndex: panel.panelIndex,
  })
})
