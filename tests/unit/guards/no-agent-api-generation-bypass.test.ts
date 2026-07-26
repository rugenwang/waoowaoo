import { describe, expect, it } from 'vitest'

import {
  inspectAgentGenerationBypass,
} from '../../../scripts/guards/no-agent-api-generation-bypass.mjs'

describe('no Agent API generation bypass guard', () => {
  it.each([
    ['legacy LLM helper import', "import { maybeSubmitLLMTask } from '@/lib/task/submit'", 'maybeSubmitLLMTask'],
    ['AI text execution call', 'await executeAiTextStep(input)', 'executeAiTextStep'],
    ['task creation call', 'await createTask({ type: "IMAGE" })', 'createTask'],
    ['task submit call', 'await submitTask(input)', 'submitTask'],
    ['billing task submit call', 'await submitTaskWithBilling(input)', 'submitTaskWithBilling'],
    ['model gateway import', "import { generate } from '@/lib/model-gateway'", '@/lib/model-gateway'],
    ['LLM import', "import { chat } from '@/lib/llm/chat'", '@/lib/llm'],
    ['provider import', "import { provider } from '@/lib/providers/fal'", '@/lib/providers'],
    ['worker import', "import { worker } from '@/lib/workers/image.worker'", '@/lib/workers'],
    ['run runtime import', "import { runtime } from '@/lib/run-runtime'", '@/lib/run-runtime'],
    ['config service import', "import { config } from '@/lib/config-service'", '@/lib/config-service'],
    ['LLM key access', 'const key = config.llmApiKey', 'llmApiKey'],
    ['Fal key access', 'const key = config.falApiKey', 'falApiKey'],
    ['Google AI key access', 'const key = config.googleAiKey', 'googleAiKey'],
    ['Ark key access', 'const key = config.arkApiKey', 'arkApiKey'],
    ['Qwen key access', 'const key = config.qwenApiKey', 'qwenApiKey'],
    ['legacy image route', "fetch('/api/novel-promotion/p1/generate-image')", '/api/novel-promotion/*/generate-image'],
    ['legacy video route', "fetch('/api/novel-promotion/p1/generate-video')", '/api/novel-promotion/*/generate-video'],
    ['legacy AI route', "fetch('/api/novel-promotion/p1/ai-create-character')", '/api/novel-promotion/*/ai-*'],
    ['legacy asset image route', "fetch('/api/asset-hub/generate-image')", '/api/asset-hub/generate-image'],
  ])('flags %s with file, line and token', (_name, content, token) => {
    expect(inspectAgentGenerationBypass(
      'src/lib/agent-api/services/bad-service.ts',
      `const safe = true\n${content}\n`,
    )).toEqual([
      expect.objectContaining({
        file: 'src/lib/agent-api/services/bad-service.ts',
        line: 2,
        token,
      }),
    ])
  })

  it('allows Prisma reads, storage, Sharp and prompt-only rule loading', () => {
    const content = `
      import sharp from 'sharp'
      import { prisma } from '@/lib/prisma'
      import { uploadObject } from '@/lib/storage'
      import { loadCreatorRuleBundle } from '@/lib/agent-api/rules/load-rule-bundle'

      const [tasks, graphRuns, costs] = await Promise.all([
        prisma.task.findUnique({ where: { id: taskId } }),
        prisma.taskEvent.findFirst({ where: { projectId } }),
        prisma.task.findMany({ where: { projectId } }),
        prisma.graphRun.findMany({ where: { projectId } }),
        prisma.usageCost.findMany({ where: { projectId } }),
        prisma.task.count({ where: { projectId } }),
        prisma.taskEvent.aggregate({ _max: { id: true } }),
        prisma.usageCost.groupBy({ by: ['projectId'] }),
      ])
    `

    expect(inspectAgentGenerationBypass(
      'src/lib/agent-api/services/integrity-service.ts',
      content,
    )).toEqual([])
  })

  it.each([
    'create',
    'createMany',
    'createManyAndReturn',
    'update',
    'updateMany',
    'updateManyAndReturn',
    'upsert',
    'delete',
    'deleteMany',
  ])('blocks protected generation-table %s writes for every delegate', (writeMethod) => {
    for (const model of ['task', 'taskEvent', 'graphRun', 'usageCost']) {
      const token = `prisma.${model}.${writeMethod}`
      expect(inspectAgentGenerationBypass(
        'src/lib/agent-api/services/bad-write.ts',
        `const before = 1\nawait ${token}({ where: {} })\n`,
      )).toEqual([
        expect.objectContaining({
          file: 'src/lib/agent-api/services/bad-write.ts',
          line: 2,
          token,
        }),
      ])
    }
  })

  it('blocks raw Prisma write execution as an obvious data-only bypass', () => {
    expect(inspectAgentGenerationBypass(
      'src/lib/agent-api/services/raw-write.ts',
      'await tx.$executeRaw`DELETE FROM tasks`',
    )).toEqual([
      expect.objectContaining({ token: '$executeRaw' }),
    ])
  })

  it('ignores protected write syntax that appears only in comments or strings', () => {
    const content = `
      // await prisma.task.create({ data: {} })
      const example = 'prisma.graphRun.update({ where: {} })'
      /* prisma.usageCost.deleteMany({}) */
      const template = \`prisma.taskEvent.upsert({ where: {} })\`
      const packageExample = '@/lib/llm/chat'
      const helperExample = 'submitTask(input)'
    `
    expect(inspectAgentGenerationBypass(
      'src/lib/agent-api/services/documented-example.ts',
      content,
    )).toEqual([])
  })

  it('does not scan tests, documentation or files outside the two Agent roots', () => {
    const bypass = 'await submitTask({})'
    expect(inspectAgentGenerationBypass('tests/unit/agent-api/example.test.ts', bypass)).toEqual([])
    expect(inspectAgentGenerationBypass('docs/agent-api.md', bypass)).toEqual([])
    expect(inspectAgentGenerationBypass('src/lib/other/example.ts', bypass)).toEqual([])
  })
})
