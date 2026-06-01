import { NextRequest, NextResponse } from 'next/server'
import { requireProjectAuth, isErrorResponse } from '@/lib/api-auth'
import { apiHandler, ApiError } from '@/lib/api-errors'
import { prisma } from '@/lib/prisma'
import { getProjectModelConfig } from '@/lib/config-service'
import { executeAiTextStep } from '@/lib/ai-runtime/client'

type PromptField = 'videoPrompt' | 'groupVideoPrompt' | 'firstLastFramePrompt'

function parsePromptField(value: unknown): PromptField {
  if (value === 'videoPrompt' || value === 'groupVideoPrompt' || value === 'firstLastFramePrompt') return value
  return 'videoPrompt'
}

function cleanVideoPromptText(value: string): string {
  const replacements: Array<[RegExp, string]> = [
    [/(瞪大双眼|瞪眼|怒目圆睁)/g, '目光锐利'],
    [/(死鱼眼|无神大眼|眼睛超大)/g, '眼神专注'],
    [/(嘴角夸张上扬|歪嘴|邪笑)/g, '神情克制'],
    [/(咬牙切齿|咬紧牙关|嘴唇紧闭用力)/g, '下颌微收'],
    [/(五官扭曲|面部紧绷|面部狰狞)/g, '神情紧张克制'],
    [/(瞳孔放大|眼球突出|眼白过多)/g, '目光一怔'],
    [/(挑眉过度|挑眉凶狠)/g, '眉头微蹙'],
    [/(脸部僵硬|面无表情呆滞)/g, '神情克制'],
  ]
  const faceCleaned = replacements.reduce((text, [pattern, replacement]) => text.replace(pattern, replacement), value)

  return faceCleaned
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

function buildVideoPromptInstruction(params: {
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
  return `你是专业短剧/影视 AI 生视频提示词导演。请根据分镜上下文，重新生成一条高质量中文${targetName}。

【必须沿用的视频提示词格式】
1. 第一段必须是「正面提示词 + 背景音乐风格」：
   - 必须以「高清4K」「高清 4K」或「4K」开头。
   - 包含电影级质感、画面稳定清晰、场景光影、人物描述、动作流畅、表情生动、无画面闪烁、无脸部崩坏、无肢体畸形。
   - 多人物同镜时必须明确区分年龄段、性别、服饰、发型、身形、气质、站位和朝向，镜头中不要出现形象、相貌一样的人。
   - 必须包含「背景音乐为...，贯穿整段视频」。
2. 后续必须是按时间轴的一段式自然镜头描述：
   - 格式类似：00:00-00:04：平视中景固定镜......；随后镜头缓慢推近......；表情特写......；【对话】某人声音...语气...地说：「...」；背景音......
   - 时间轴必须从 00:00 开始，递增覆盖当前分镜时长。
   - 每段必须包含自然运镜、人物站位、方向关系、动作、表情、背景音。
   - 涉及动作、对话、对视、触碰、追逐、阻拦、递物等多人互动时，必须写清画面左/右、前/后、近/远、面对/背对、从哪一侧走向哪一侧。例如：「画面左侧年轻女子转头对右侧年轻女子说」「后方年轻女子上前半步，轻拍前方年轻女子右肩」。
   - 运镜必须使用「视角/景别 + 运镜 + 画面内容」的自然电影语言。推荐：「平视中景固定镜」「越肩推镜，从人物肩后推进到对方正面」「轻微斜角近景，强化压迫感」。禁止：「镜头平视固定」「镜头越肩推进」「镜头斜角拍」。
   - 同一句内不能运镜矛盾：固定镜不能同时推进/拉远/跟拍；如果需要先固定再推进，拆成两个连续小句。
	   - 避免重复病句，例如不要写「面无表情表情冷峻」，应写「面无表情，神色冷峻，眼神冰冷」。
	   - 有真实角色台词才写【对话】，并写清情绪、声音质感、语气和表情；没有台词时直接省略对话部分，禁止写「无台词」「暂无台词」等占位。
	   - 如果原文是旁白、内心独白、画外音或叙述性文字，禁止标为【对话】，必须使用「【旁白】」标注，并写清旁白声音质感、语气和情绪。
3. 运镜可从这些类型中选择并自然扩写：推镜、拉镜、摇镜、移镜、跟镜、固定镜、俯拍、仰拍、平视、斜角拍、环绕镜、俯冲、升降镜、甩镜、变焦镜、旋转镜、穿梭镜、平稳手持、颠簸手持。
4. 背景音乐必须从这些类型中选择一种：紧张悬疑大片配乐、史诗恢弘交响乐、热血激昂战斗史诗、暗黑压抑氛围感配乐、悲壮苍凉电影原声、燃向高燃英雄主题曲、治愈温柔轻音乐、伤感催泪抒情纯音乐、宁静空灵古风禅意、神秘诡异悬疑氛围、低沉压抑阴暗曲风、轻快舒缓治愈小调、古风江湖侠义配乐、古风悲情婉转二胡、仙侠空灵仙乐、古装宫廷典雅乐、武侠对决紧张古风、烟雨江南温婉古风、硬核格斗打击乐、快节奏江湖对决 BGM、霸气出场气场音乐、急促鼓点战斗配乐、街头硬汉摇滚风、高级感氛围感纯音、低沉卡点节奏感音乐、温柔叙事旁白配乐、氛围感沉浸式背景音乐、极简冷淡风纯音乐、未来科技空灵电子乐、悬疑探案低沉音效、末日废土苍凉配乐、赛博朋克暗黑电音。

【禁止】
- 禁止使用旧版五行格式「运镜：人物：动作：表情：台词：」。
- 禁止出现圆圈数字编号符号，例如 ①②③。
- 禁止写「主运镜」「辅助运镜」。
- 禁止生硬拼接运镜词，例如「镜头平视固定」「镜头越肩推进」「镜头斜角拍」。
- 禁止同一句内固定镜和运动镜头互相矛盾。
- 禁止没有台词时写「【对话】无台词」或类似占位。
- 禁止把旁白、内心独白、画外音写成【对话】。
	- 禁止同一镜头内出现两个或多个形象、相貌几乎一样的人。
	- 禁止多人动作/对话缺少方向关系，例如只写「她对她说」「拍了一下她」。
	- 禁止出现这些容易毁脸的表情词：瞪眼、瞪大双眼、怒目圆睁、死鱼眼、无神大眼、眼睛超大、歪嘴、邪笑、嘴角夸张上扬、咬牙切齿、咬紧牙关、嘴唇紧闭用力、五官扭曲、面部紧绷、面部狰狞、瞳孔放大、眼球突出、眼白过多、挑眉过度、挑眉凶狠、脸部僵硬、面无表情呆滞。改用「目光锐利」「眉头微蹙」「神情克制」「眼神专注」「下颌微收」等自然表情。
	- 禁止输出解释、JSON、Markdown，只输出最终视频提示词正文。

【当前视频提示词】
${params.currentPrompt || '暂无'}

【分镜上下文 JSON】
${params.contextJson}

【用户补充要求】
${params.additionalRequirement || '无'}

请直接输出最终视频提示词。`
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
      ? {
          id: panelId,
          storyboard: { episode: { novelPromotionProject: { projectId } } },
        }
      : {
          storyboardId,
          panelIndex,
          storyboard: { episode: { novelPromotionProject: { projectId } } },
    },
    include: {
      frames: { orderBy: { frameIndex: 'asc' } },
    },
  })

  if (!panel) {
    throw new ApiError('NOT_FOUND')
  }

  const modelConfig = await getProjectModelConfig(projectId, session.user.id)
  if (!modelConfig.analysisModel) {
    throw new Error('请先在项目设置中配置分析模型')
  }

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
  const currentPrompt = readCurrentPrompt(panel, field)
  const prompt = buildVideoPromptInstruction({
    field,
    additionalRequirement,
    currentPrompt,
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
  if (!videoPrompt) {
    throw new ApiError('NO_RESULT', { message: '大模型没有返回有效视频提示词' })
  }

  return NextResponse.json({
    success: true,
    prompt: videoPrompt,
    field,
    panelId: panel.id,
    storyboardId: panel.storyboardId,
    panelIndex: panel.panelIndex,
  })
})
