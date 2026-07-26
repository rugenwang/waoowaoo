import { createHash } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { NextRequest } from 'next/server'
import {
  afterAll,
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from 'vitest'

const legacyAuthMock = vi.hoisted(() => ({
  requireUserAuth: vi.fn(),
  requireProjectAuthLight: vi.fn(),
}))

vi.mock('@/lib/api-auth', () => ({
  requireUserAuth: legacyAuthMock.requireUserAuth,
  requireProjectAuthLight: legacyAuthMock.requireProjectAuthLight,
  isErrorResponse: (value: unknown) => value instanceof Response,
}))

import { PUT as COMMIT_ASSETS } from '@/app/api/agent/v1/runs/[runId]/assets/route'
import { PUT as COMMIT_SCREENPLAY } from '@/app/api/agent/v1/runs/[runId]/episodes/[episodeKey]/screenplay/route'
import { PUT as COMMIT_STORY } from '@/app/api/agent/v1/runs/[runId]/episodes/[episodeKey]/story/route'
import { PUT as COMMIT_STORYBOARDS } from '@/app/api/agent/v1/runs/[runId]/episodes/[episodeKey]/storyboards/route'
import { POST as CREATE_RUN } from '@/app/api/agent/v1/projects/[projectId]/runs/route'
import {
  buildRunFingerprint,
  hashArtifact,
} from '@/lib/agent-api/canonical-json'
import type { AssetsCommitRequest } from '@/lib/agent-api/contracts/assets'
import type { CreateRunRequest } from '@/lib/agent-api/contracts/run'
import type { ScreenplayCommitRequest } from '@/lib/agent-api/contracts/screenplay'
import type { StoryCommitRequest } from '@/lib/agent-api/contracts/story'
import type { StoryboardsCommitRequest } from '@/lib/agent-api/contracts/storyboards'
import { loadCreatorRuleBundle } from '@/lib/agent-api/rules/load-rule-bundle'
import { resetSystemState } from '../helpers/db-reset'
import {
  createFixtureNovelProject,
  createFixtureProject,
  createFixtureUser,
} from '../helpers/fixtures'
import { prisma } from '../helpers/prisma'

const ORIGINAL_ENV = {
  WAOO_AGENT_API_ENABLED: process.env.WAOO_AGENT_API_ENABLED,
  WAOO_AGENT_TOKEN: process.env.WAOO_AGENT_TOKEN,
  WAOO_AGENT_USER_ID: process.env.WAOO_AGENT_USER_ID,
}
const SOURCE_HASH = `sha256:${'1'.repeat(64)}`
const NOVEL_TEXT = '清晨，林晓拿起背包出门。夜里，她在新闻编辑室查看发夹。'

function unauthorized() {
  return new Response(JSON.stringify({ error: { code: 'UNAUTHORIZED' } }), {
    status: 401,
    headers: { 'content-type': 'application/json' },
  })
}

function fileSignature(files: string[]) {
  const digest = createHash('sha256')
  for (const file of files) {
    digest.update(file)
    digest.update(fs.readFileSync(path.resolve(process.cwd(), file)))
  }
  return `${files.length}:${digest.digest('hex')}`
}

function legacySurfaceSnapshot() {
  const promptRoot = path.resolve(process.cwd(), 'lib/prompts/novel-promotion')
  const promptFiles = fs.readdirSync(promptRoot)
    .filter((name) => name.endsWith('.txt'))
    .sort()
    .map((name) => `lib/prompts/novel-promotion/${name}`)
  const taskAndWorkerEntries = [
    'src/lib/task/types.ts',
    'src/lib/workers/index.ts',
    'src/lib/workers/text.worker.ts',
    'src/lib/workers/image.worker.ts',
    'src/lib/workers/video.worker.ts',
  ]
  return {
    prompts: fileSignature(promptFiles),
    taskAndWorkers: fileSignature(taskAndWorkerEntries),
  }
}

function agentHeaders(userId: string, idempotencyKey: string) {
  return {
    Authorization: 'Bearer integration-agent-token',
    'Content-Type': 'application/json',
    'Idempotency-Key': idempotencyKey,
    'X-Waoo-User-Id': userId,
    'X-Request-Id': `req-isolation-${crypto.randomUUID()}`,
  }
}

async function writeJson<TParams extends Record<string, string>>(
  handler: (
    request: Request,
    context: { params: Promise<TParams> },
  ) => Promise<Response>,
  pathName: string,
  method: 'POST' | 'PUT',
  body: Record<string, unknown>,
  params: TParams,
  userId: string,
  idempotencyKey: string,
) {
  const response = await handler(new Request(`http://localhost${pathName}`, {
    method,
    headers: agentHeaders(userId, idempotencyKey),
    body: JSON.stringify(body),
  }), { params: Promise.resolve(params) })
  const payload = await response.json()
  expect(response.status, JSON.stringify(payload)).toBe(200)
  return payload as { data: Record<string, unknown> }
}

async function generationSideEffectCounts() {
  const [tasks, taskEvents, graphRuns, usageCosts] = await Promise.all([
    prisma.task.count(),
    prisma.taskEvent.count(),
    prisma.graphRun.count(),
    prisma.usageCost.count(),
  ])
  return { tasks, taskEvents, graphRuns, usageCosts }
}

describe('Agent API legacy isolation regression', () => {
  beforeEach(async () => {
    await resetSystemState()
    legacyAuthMock.requireUserAuth.mockReset()
    legacyAuthMock.requireProjectAuthLight.mockReset()
    legacyAuthMock.requireUserAuth.mockResolvedValue(unauthorized())
    legacyAuthMock.requireProjectAuthLight.mockResolvedValue(unauthorized())
  })

  afterEach(() => {
    for (const [key, value] of Object.entries(ORIGINAL_ENV)) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
  })

  afterAll(async () => {
    await prisma.$disconnect()
  })

  it('does not let Agent credentials replace legacy Session authentication', async () => {
    const { GET: projectsGet } = await import('@/app/api/projects/route')
    const { GET: novelPromotionGet } = await import('@/app/api/novel-promotion/[projectId]/route')
    const headers = {
      Authorization: 'Bearer integration-agent-token',
      'X-Waoo-User-Id': 'agent-user',
    }

    const projectsResponse = await projectsGet(new NextRequest(
      'http://localhost/api/projects',
      { headers },
    ), { params: Promise.resolve({}) })
    const novelResponse = await novelPromotionGet(new NextRequest(
      'http://localhost/api/novel-promotion/project-1',
      { headers },
    ), { params: Promise.resolve({ projectId: 'project-1' }) })

    expect(projectsResponse.status).toBe(401)
    expect(novelResponse.status).toBe(401)
    expect(legacyAuthMock.requireUserAuth).toHaveBeenCalledTimes(1)
    expect(legacyAuthMock.requireProjectAuthLight).toHaveBeenCalledWith('project-1')
  })

  it('commits a full data-only creation fixture without touching tasks, costs, workers or legacy prompts', async () => {
    const legacyBefore = legacySurfaceSnapshot()
    const user = await createFixtureUser()
    const project = await createFixtureProject(user.id)
    await createFixtureNovelProject(project.id)
    process.env.WAOO_AGENT_API_ENABLED = 'true'
    process.env.WAOO_AGENT_TOKEN = 'integration-agent-token'
    process.env.WAOO_AGENT_USER_ID = user.id

    const beforeCounts = await generationSideEffectCounts()
    const rules = await loadCreatorRuleBundle({ projectId: project.id, locale: 'zh' })
    const episodes = [{
      episodeKey: 'episode-001',
      ordinal: 1,
      sourceHash: SOURCE_HASH,
      name: '第一集',
      description: '第一集简介',
    }]
    const runBase = {
      schemaVersion: 1 as const,
      sourceHash: SOURCE_HASH,
      inputKindHint: 'story' as const,
      locale: 'zh' as const,
      effectiveOptions: {
        artStyle: rules.projectSettings.artStyle,
        videoRatio: rules.projectSettings.videoRatio,
        episodeSplitHint: 'single episode',
      },
      ruleSetVersion: rules.ruleSetVersion,
      ruleSetHash: rules.contentHash,
      definitionHash: hashArtifact(episodes),
      episodes,
    }
    const runBody: CreateRunRequest = {
      ...runBase,
      runFingerprint: buildRunFingerprint({
        projectId: project.id,
        sourceHash: runBase.sourceHash,
        inputKindHint: runBase.inputKindHint,
        locale: runBase.locale,
        effectiveOptions: runBase.effectiveOptions,
        ruleSetHash: runBase.ruleSetHash,
      }),
    }
    const runResult = await writeJson(
      CREATE_RUN,
      `/api/agent/v1/projects/${project.id}/runs`,
      'POST',
      runBody,
      { projectId: project.id },
      user.id,
      runBody.runFingerprint,
    )
    const runId = runResult.data.runId as string

    const storyData: StoryCommitRequest['data'] = {
      episodeKey: 'episode-001',
      sourceHash: SOURCE_HASH,
      inputKind: 'story',
      name: '第一集',
      description: '第一集简介',
      novelText: NOVEL_TEXT,
    }
    const storyBody: StoryCommitRequest = {
      schemaVersion: 1,
      ruleSetVersion: rules.ruleSetVersion,
      ruleSetHash: rules.contentHash,
      artifactHash: hashArtifact(storyData),
      dryRun: false,
      data: storyData,
    }
    await writeJson(
      COMMIT_STORY,
      `/api/agent/v1/runs/${runId}/episodes/episode-001/story`,
      'PUT',
      storyBody,
      { runId, episodeKey: 'episode-001' },
      user.id,
      storyBody.artifactHash,
    )

    const assetsData: AssetsCommitRequest['data'] = {
      characters: [{
        characterKey: 'character.lin',
        name: '林晓',
        aliases: ['小林'],
        introduction: '调查记者',
        gender: 'female',
        roleLevel: 'S',
        personalityTags: ['坚毅'],
        suggestedColors: ['蓝色'],
        visualKeywords: ['短发'],
        appearances: [{
          appearanceKey: 'appearance.lin.default',
          appearanceOrdinal: 1,
          changeReason: '默认造型',
          visualDescription: '短发蓝衣',
        }],
      }],
      locations: [{
        locationKey: 'location.newsroom',
        name: '新闻编辑室',
        summary: '深夜工作的地点',
        availableSlots: ['窗边'],
        descriptions: ['深夜编辑室全景'],
      }],
      props: [{
        propKey: 'prop.hairpin',
        name: '银色发夹',
        summary: '关键线索',
        visualDescription: '磨损的银色发夹',
      }],
    }
    const assetsBody: AssetsCommitRequest = {
      schemaVersion: 1,
      ruleSetVersion: rules.ruleSetVersion,
      ruleSetHash: rules.contentHash,
      artifactHash: hashArtifact(assetsData),
      dryRun: false,
      data: assetsData,
    }
    await writeJson(
      COMMIT_ASSETS,
      `/api/agent/v1/runs/${runId}/assets`,
      'PUT',
      assetsBody,
      { runId },
      user.id,
      assetsBody.artifactHash,
    )

    const clipText = '夜里，她在新闻编辑室查看发夹。'
    const screenplayData: ScreenplayCommitRequest['data'] = {
      episodeKey: 'episode-001',
      clips: [{
        clipKey: 'clip-001',
        ordinal: 1,
        startText: '夜里',
        endText: '发夹。',
        summary: '林晓夜查线索',
        locationKey: 'location.newsroom',
        characterKeys: ['character.lin'],
        propKeys: ['prop.hairpin'],
        content: clipText,
        screenplay: {
          originalText: clipText,
          scenes: [{
            sceneNumber: 1,
            heading: { intExt: 'INT', locationKey: 'location.newsroom', time: '夜' },
            description: '林晓查看发夹。',
            characterKeys: ['character.lin'],
            content: [{ type: 'action', text: '她发现关键线索。' }],
          }],
        },
      }],
    }
    const screenplayBody: ScreenplayCommitRequest = {
      schemaVersion: 1,
      ruleSetVersion: rules.ruleSetVersion,
      ruleSetHash: rules.contentHash,
      artifactHash: hashArtifact(screenplayData),
      dryRun: false,
      data: screenplayData,
    }
    await writeJson(
      COMMIT_SCREENPLAY,
      `/api/agent/v1/runs/${runId}/episodes/episode-001/screenplay`,
      'PUT',
      screenplayBody,
      { runId, episodeKey: 'episode-001' },
      user.id,
      screenplayBody.artifactHash,
    )

    const storyboardData: StoryboardsCommitRequest['data'] = {
      episodeKey: 'episode-001',
      storyboards: [{
        storyboardKey: 'storyboard-001',
        clipKey: 'clip-001',
        photographyPlan: {
          visualStrategy: '写实悬疑',
          continuityRules: ['保持轴线'],
          rules: [{
            panelNumber: 1,
            composition: '三分构图',
            lighting: '冷色侧光',
            colorPalette: '蓝灰色',
            atmosphere: '紧张',
            technicalNotes: '35mm',
            characters: [{ characterKey: 'character.lin', blocking: '画面左侧' }],
          }],
        },
        actingDirections: [{
          panelNumber: 1,
          characters: [{ characterKey: 'character.lin', acting: '克制地观察' }],
        }],
        panels: [{
          panelKey: 'panel-001',
          panelNumber: 1,
          description: '林晓在冷光下端详发夹',
          characters: [{
            characterKey: 'character.lin',
            appearanceKey: 'appearance.lin.default',
            slot: 'left',
          }],
          propKeys: ['prop.hairpin'],
          locationKey: 'location.newsroom',
          sceneType: '室内',
          sourceText: clipText,
          shotType: '中景',
          cameraMove: '缓慢推进',
          videoPrompt: '镜头缓慢推进，人物观察发夹',
          durationSec: 6,
          panelMode: 'single',
          groupVideoPrompt: null,
          usePreviousPanelTailAsReference: false,
          frames: [{
            frameKey: 'frame-001',
            frameIndex: 0,
            frameTimeSec: 0,
            frameRole: 'hero',
            dependencyFrameKeys: [],
            imagePrompt: '冷色编辑室中，短发女记者端详银色发夹',
            videoPrompt: '固定首帧，人物轻微呼吸',
            referencePolicy: {
              orderedReferences: [
                { kind: 'location', targetKey: 'location.newsroom' },
                { kind: 'character-appearance', targetKey: 'appearance.lin.default' },
                { kind: 'prop', targetKey: 'prop.hairpin' },
              ],
            },
          }],
        }],
      }],
    }
    const storyboardBody: StoryboardsCommitRequest = {
      schemaVersion: 1,
      ruleSetVersion: rules.ruleSetVersion,
      ruleSetHash: rules.contentHash,
      artifactHash: hashArtifact(storyboardData),
      dryRun: false,
      data: storyboardData,
    }
    await writeJson(
      COMMIT_STORYBOARDS,
      `/api/agent/v1/runs/${runId}/episodes/episode-001/storyboards`,
      'PUT',
      storyboardBody,
      { runId, episodeKey: 'episode-001' },
      user.id,
      storyboardBody.artifactHash,
    )

    expect(await generationSideEffectCounts()).toEqual(beforeCounts)
    expect(legacySurfaceSnapshot()).toEqual(legacyBefore)

    const pageModel = await prisma.project.findUniqueOrThrow({
      where: { id: project.id },
      include: {
        novelPromotionData: {
          include: {
            characters: { include: { appearances: true } },
            locations: { include: { images: true } },
            episodes: {
              include: {
                clips: true,
                storyboards: {
                  include: { panels: { include: { frames: true } } },
                },
              },
            },
          },
        },
      },
    })
    const novel = pageModel.novelPromotionData!
    const panel = novel.episodes[0].storyboards[0].panels[0]
    expect(novel.characters.map((entry) => entry.name)).toContain('林晓')
    expect(novel.locations.map((entry) => [entry.assetKind, entry.name])).toEqual(expect.arrayContaining([
      ['location', '新闻编辑室'],
      ['prop', '银色发夹'],
    ]))
    expect(novel.episodes[0]).toMatchObject({ name: '第一集', novelText: NOVEL_TEXT })
    expect(novel.episodes[0].clips).toHaveLength(1)
    expect(panel.frames).toHaveLength(1)
    expect(panel).toMatchObject({
      imageUrl: null,
      videoUrl: null,
      videoMediaId: null,
      lipSyncTaskId: null,
      lipSyncVideoUrl: null,
      dubbingAudioUrl: null,
      dubbingAudioMediaId: null,
    })
  }, 120_000)
})
