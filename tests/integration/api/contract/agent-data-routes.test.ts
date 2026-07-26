import { beforeEach, describe, expect, it, vi } from 'vitest'

import { sha256Prefixed } from '@/lib/agent-api/canonical-json'
import { AssetsCommitResponseSchema } from '@/lib/agent-api/contracts/assets'
import { FinalizeResponseSchema } from '@/lib/agent-api/contracts/finalize'
import {
  ContractResponseSchema,
  CreatorRulesResponseSchema,
  ResolveProjectResponseSchema,
} from '@/lib/agent-api/contracts/project'
import {
  CreateRunResponseSchema,
  RunResponseSchema,
  SnapshotResponseSchema,
} from '@/lib/agent-api/contracts/run'
import { ScreenplayCommitResponseSchema } from '@/lib/agent-api/contracts/screenplay'
import { StoryCommitResponseSchema } from '@/lib/agent-api/contracts/story'
import { StoryboardsCommitResponseSchema } from '@/lib/agent-api/contracts/storyboards'
import { UploadResponseSchema } from '@/lib/agent-api/contracts/upload'
import { AgentApiError } from '@/lib/agent-api/errors'
import {
  finalizeIdempotencyKey,
  resolveProjectIdempotencyKey,
  uploadIdempotencyKey,
} from '@/lib/agent-api/idempotency'

const authMock = vi.hoisted(() => ({
  requireAgentAuth: vi.fn(),
  requireAgentProject: vi.fn(),
  requireAgentRun: vi.fn(),
}))
const services = vi.hoisted(() => ({
  resolveCreatorProject: vi.fn(),
  loadCreatorRuleBundle: vi.fn(),
  getAgentContract: vi.fn(),
  createOrResumeRun: vi.fn(),
  getCreatorRun: vi.fn(),
  commitAssetsArtifact: vi.fn(),
  commitStoryArtifact: vi.fn(),
  commitScreenplayArtifact: vi.fn(),
  commitStoryboardArtifact: vi.fn(),
  commitGeneratedImageUpload: vi.fn(),
  getRunSnapshot: vi.fn(),
  finalizeCreationRun: vi.fn(),
  configuredUploadMaxBytes: vi.fn(() => 10 * 1024 * 1024),
}))

vi.mock('@/lib/agent-api/auth', () => authMock)
vi.mock('@/lib/agent-api/services/project-resolver', () => ({
  resolveCreatorProject: services.resolveCreatorProject,
}))
vi.mock('@/lib/agent-api/rules/load-rule-bundle', () => ({
  loadCreatorRuleBundle: services.loadCreatorRuleBundle,
}))
vi.mock('@/lib/agent-api/contracts/registry', () => ({
  getAgentContract: services.getAgentContract,
}))
vi.mock('@/lib/agent-api/services/run-service', () => ({
  createOrResumeRun: services.createOrResumeRun,
  getCreatorRun: services.getCreatorRun,
}))
vi.mock('@/lib/agent-api/services/asset-service', () => ({
  commitAssetsArtifact: services.commitAssetsArtifact,
}))
vi.mock('@/lib/agent-api/services/story-service', () => ({
  commitStoryArtifact: services.commitStoryArtifact,
}))
vi.mock('@/lib/agent-api/services/screenplay-service', () => ({
  commitScreenplayArtifact: services.commitScreenplayArtifact,
}))
vi.mock('@/lib/agent-api/services/storyboard-service', () => ({
  commitStoryboardArtifact: services.commitStoryboardArtifact,
}))
vi.mock('@/lib/agent-api/services/upload-service', () => ({
  commitGeneratedImageUpload: services.commitGeneratedImageUpload,
  configuredUploadMaxBytes: services.configuredUploadMaxBytes,
}))
vi.mock('@/lib/agent-api/services/snapshot-service', async (importOriginal) => ({
  ...await importOriginal<typeof import('@/lib/agent-api/services/snapshot-service')>(),
  getRunSnapshot: services.getRunSnapshot,
}))
vi.mock('@/lib/agent-api/services/finalize-service', () => ({
  finalizeCreationRun: services.finalizeCreationRun,
}))

const SHA_A = `sha256:${'a'.repeat(64)}`
const SHA_B = `sha256:${'b'.repeat(64)}`
const SHA_C = `sha256:${'c'.repeat(64)}`
const SHA_D = `sha256:${'d'.repeat(64)}`
const SHA_E = `sha256:${'e'.repeat(64)}`

const resolveBody = { name: '契约项目', description: '项目简介' }
const runBody = {
  schemaVersion: 1,
  sourceHash: SHA_A,
  runFingerprint: SHA_B,
  inputKindHint: 'story',
  locale: 'zh',
  effectiveOptions: {
    artStyle: 'realistic',
    videoRatio: '9:16',
    episodeSplitHint: '按集拆分',
  },
  ruleSetVersion: 'rules-v1',
  ruleSetHash: SHA_C,
  definitionHash: SHA_D,
  episodes: [{
    episodeKey: 'ep-1',
    ordinal: 1,
    sourceHash: SHA_A,
    name: '第一集',
  }],
}
const assetsBody = {
  schemaVersion: 1,
  ruleSetVersion: 'rules-v1',
  ruleSetHash: SHA_C,
  artifactHash: SHA_A,
  dryRun: false,
  data: { characters: [], locations: [], props: [] },
}
const storyBody = {
  schemaVersion: 1,
  ruleSetVersion: 'rules-v1',
  ruleSetHash: SHA_C,
  artifactHash: SHA_B,
  dryRun: false,
  data: {
    episodeKey: 'ep-1',
    sourceHash: SHA_A,
    inputKind: 'story',
    name: '第一集',
    novelText: '故事正文',
  },
}
const screenplayBody = {
  schemaVersion: 1,
  ruleSetVersion: 'rules-v1',
  ruleSetHash: SHA_C,
  artifactHash: SHA_D,
  dryRun: false,
  data: { episodeKey: 'ep-1', clips: [] },
}
const storyboardsBody = {
  schemaVersion: 1,
  ruleSetVersion: 'rules-v1',
  ruleSetHash: SHA_C,
  artifactHash: SHA_E,
  dryRun: false,
  data: { episodeKey: 'ep-1', storyboards: [] },
}
const finalizeBody = {
  schemaVersion: 1,
  ruleSetHash: SHA_C,
  expected: {
    assets: SHA_A,
    stories: { 'ep-1': SHA_B },
    screenplays: { 'ep-1': SHA_D },
    storyboards: { 'ep-1': SHA_E },
  },
}

const RULE_BUNDLE = {
  schemaVersion: 1,
  ruleSetVersion: 'rules-v1',
  contentHash: SHA_C,
  locale: 'zh',
  projectSettings: {
    artStyle: 'realistic',
    artStylePrompt: null,
    videoRatio: '9:16',
    imageResolution: '2K',
    forcedStoryboardDurationSec: null,
  },
  rules: [],
  contracts: [],
}

const serviceResults = {
  resolve: { projectId: 'project-1', name: '契约项目', created: true },
  runCreate: {
    runId: 'run-1',
    resumed: false,
    status: 'created',
    projectId: 'project-1',
    sourceHash: SHA_A,
    runFingerprint: SHA_B,
    episodes: [{ episodeKey: 'ep-1', episodeId: 'episode-1', episodeNumber: 1, name: '第一集' }],
  },
  runGet: {
    runId: 'run-1',
    projectId: 'project-1',
    status: 'created',
    currentStage: 'created',
    sourceHash: SHA_A,
    runFingerprint: SHA_B,
    ruleSetVersion: 'rules-v1',
    ruleSetHash: SHA_C,
    episodes: [{ episodeKey: 'ep-1', episodeId: 'episode-1', episodeNumber: 1, status: 'created' }],
  },
  assets: {
    dryRun: false,
    artifactHash: SHA_A,
    characters: [],
    locations: [],
    props: [],
    warnings: [],
  },
  story: {
    dryRun: false,
    episodeKey: 'ep-1',
    episodeId: 'episode-1',
    episodeNumber: 1,
    artifactHash: SHA_B,
  },
  screenplay: {
    dryRun: false,
    episodeKey: 'ep-1',
    artifactHash: SHA_D,
    clips: [],
  },
  storyboards: {
    dryRun: false,
    episodeKey: 'ep-1',
    artifactHash: SHA_E,
    storyboards: [],
  },
  upload: {
    runId: 'run-1',
    targetType: 'panel-frame',
    targetKey: 'frame-1',
    variantIndex: 0,
    contentSha256: SHA_A,
    mediaId: 'media-1',
    storageKey: 'agent/run-1/frame-1.png',
    url: 'https://example.test/frame-1.png',
    reused: false,
    panelImageUpdated: true,
  },
  snapshot: {
    runId: 'run-1',
    status: 'storyboards_committed',
    committedArtifactHashes: {
      assets: SHA_A,
      stories: { 'ep-1': SHA_B },
      screenplays: { 'ep-1': SHA_D },
      storyboards: { 'ep-1': SHA_E },
    },
    uploads: [],
    missing: [],
  },
  finalize: {
    runId: 'run-1',
    status: 'completed',
    completedAt: '2026-07-26T00:00:00.000Z',
    counts: {
      episodes: 1,
      characters: 0,
      locations: 0,
      props: 0,
      clips: 0,
      storyboards: 0,
      panels: 0,
      frames: 0,
      uploadedImages: 0,
    },
  },
}

type Handler = (
  request: Request,
  context: never,
) => Promise<Response>

type JsonWriteCase = {
  name: string
  path: string
  params: Record<string, string>
  body: Record<string, unknown>
  key: string
  load: () => Promise<Handler>
  service: ReturnType<typeof vi.fn>
  responseSchema: { parse: (value: unknown) => unknown }
}

function jsonRequest(
  path: string,
  method: 'POST' | 'PUT',
  body: unknown,
  idempotencyKey?: string,
  authenticated = true,
) {
  const headers = new Headers({
    'content-type': 'application/json',
    'x-request-id': `req-${path.replace(/\W/g, '-').slice(-40)}`,
  })
  if (authenticated) {
    headers.set('authorization', 'Bearer agent-token')
    headers.set('x-waoo-user-id', 'user-1')
  }
  if (idempotencyKey) headers.set('idempotency-key', idempotencyKey)
  return new Request(`http://localhost${path}`, {
    method,
    headers,
    body: JSON.stringify(body),
  })
}

function getRequest(path: string, authenticated = true) {
  const headers = new Headers({ 'x-request-id': 'req-get' })
  if (authenticated) {
    headers.set('authorization', 'Bearer agent-token')
    headers.set('x-waoo-user-id', 'user-1')
  }
  return new Request(`http://localhost${path}`, { headers })
}

function uploadForm(options: { unknown?: boolean; duplicate?: boolean } = {}) {
  const form = new FormData()
  form.append('targetType', 'panel-frame')
  form.append('targetKey', 'frame-1')
  form.append('variantIndex', '0')
  form.append('contentSha256', SHA_A)
  form.append('file', new File([Buffer.from('png')], 'frame.png', { type: 'image/png' }))
  if (options.unknown) form.append('unexpected', 'blocked')
  if (options.duplicate) form.append('targetKey', 'frame-duplicate')
  return form
}

function uploadRequest(
  form: FormData,
  idempotencyKey?: string,
  authenticated = true,
) {
  const headers = new Headers({ 'x-request-id': 'req-upload' })
  if (authenticated) {
    headers.set('authorization', 'Bearer agent-token')
    headers.set('x-waoo-user-id', 'user-1')
  }
  if (idempotencyKey) headers.set('idempotency-key', idempotencyKey)
  return new Request('http://localhost/api/agent/v1/runs/run-1/uploads', {
    method: 'POST',
    headers,
    body: form,
  })
}

const jsonWriteCases: JsonWriteCase[] = [
  {
    name: 'resolve POST',
    path: '/api/agent/v1/projects/resolve',
    params: {},
    body: resolveBody,
    key: resolveProjectIdempotencyKey(resolveBody.name),
    load: async () => (await import('@/app/api/agent/v1/projects/resolve/route')).POST,
    service: services.resolveCreatorProject,
    responseSchema: ResolveProjectResponseSchema,
  },
  {
    name: 'runs POST',
    path: '/api/agent/v1/projects/project-1/runs',
    params: { projectId: 'project-1' },
    body: runBody,
    key: runBody.runFingerprint,
    load: async () => (await import('@/app/api/agent/v1/projects/[projectId]/runs/route')).POST,
    service: services.createOrResumeRun,
    responseSchema: CreateRunResponseSchema,
  },
  {
    name: 'assets PUT',
    path: '/api/agent/v1/runs/run-1/assets',
    params: { runId: 'run-1' },
    body: assetsBody,
    key: assetsBody.artifactHash,
    load: async () => (await import('@/app/api/agent/v1/runs/[runId]/assets/route')).PUT,
    service: services.commitAssetsArtifact,
    responseSchema: AssetsCommitResponseSchema,
  },
  {
    name: 'story PUT',
    path: '/api/agent/v1/runs/run-1/episodes/ep-1/story',
    params: { runId: 'run-1', episodeKey: 'ep-1' },
    body: storyBody,
    key: storyBody.artifactHash,
    load: async () => (await import('@/app/api/agent/v1/runs/[runId]/episodes/[episodeKey]/story/route')).PUT,
    service: services.commitStoryArtifact,
    responseSchema: StoryCommitResponseSchema,
  },
  {
    name: 'screenplay PUT',
    path: '/api/agent/v1/runs/run-1/episodes/ep-1/screenplay',
    params: { runId: 'run-1', episodeKey: 'ep-1' },
    body: screenplayBody,
    key: screenplayBody.artifactHash,
    load: async () => (await import('@/app/api/agent/v1/runs/[runId]/episodes/[episodeKey]/screenplay/route')).PUT,
    service: services.commitScreenplayArtifact,
    responseSchema: ScreenplayCommitResponseSchema,
  },
  {
    name: 'storyboards PUT',
    path: '/api/agent/v1/runs/run-1/episodes/ep-1/storyboards',
    params: { runId: 'run-1', episodeKey: 'ep-1' },
    body: storyboardsBody,
    key: storyboardsBody.artifactHash,
    load: async () => (await import('@/app/api/agent/v1/runs/[runId]/episodes/[episodeKey]/storyboards/route')).PUT,
    service: services.commitStoryboardArtifact,
    responseSchema: StoryboardsCommitResponseSchema,
  },
  {
    name: 'finalize POST',
    path: '/api/agent/v1/runs/run-1/finalize',
    params: { runId: 'run-1' },
    body: finalizeBody,
    key: finalizeIdempotencyKey(finalizeBody),
    load: async () => (await import('@/app/api/agent/v1/runs/[runId]/finalize/route')).POST,
    service: services.finalizeCreationRun,
    responseSchema: FinalizeResponseSchema,
  },
]

describe('Agent data route contract', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    const authenticate = async (request: Request) => {
      if (!request.headers.get('authorization')) {
        throw new AgentApiError('AGENT_UNAUTHORIZED')
      }
      return { userId: 'user-1' }
    }
    authMock.requireAgentAuth.mockImplementation(authenticate)
    authMock.requireAgentProject.mockImplementation(async (request: Request, projectId: string) => ({
      ...await authenticate(request),
      projectId,
    }))
    authMock.requireAgentRun.mockImplementation(async (request: Request, runId: string) => ({
      ...await authenticate(request),
      projectId: 'project-1',
      runId,
    }))

    services.resolveCreatorProject.mockResolvedValue(serviceResults.resolve)
    services.loadCreatorRuleBundle.mockResolvedValue(RULE_BUNDLE)
    services.getAgentContract.mockReturnValue({ id: 'waoo-agent-story.v1', hash: SHA_A, jsonSchema: { type: 'object' } })
    services.createOrResumeRun.mockResolvedValue(serviceResults.runCreate)
    services.getCreatorRun.mockResolvedValue(serviceResults.runGet)
    services.commitAssetsArtifact.mockResolvedValue(serviceResults.assets)
    services.commitStoryArtifact.mockResolvedValue(serviceResults.story)
    services.commitScreenplayArtifact.mockResolvedValue(serviceResults.screenplay)
    services.commitStoryboardArtifact.mockResolvedValue(serviceResults.storyboards)
    services.commitGeneratedImageUpload.mockResolvedValue(serviceResults.upload)
    services.getRunSnapshot.mockResolvedValue(serviceResults.snapshot)
    services.finalizeCreationRun.mockResolvedValue(serviceResults.finalize)
  })

  it.each(jsonWriteCases)('$name reaches its service and returns its declared schema', async (testCase) => {
    const handler = await testCase.load()
    const method = testCase.name.includes('PUT') ? 'PUT' : 'POST'
    const response = await handler(
      jsonRequest(testCase.path, method, testCase.body, testCase.key),
      { params: Promise.resolve(testCase.params) } as never,
    )
    const payload = await response.json()

    expect(response.status).toBe(200)
    expect(() => testCase.responseSchema.parse(payload)).not.toThrow()
    expect(testCase.service).toHaveBeenCalledTimes(1)
  })

  it.each(jsonWriteCases)('$name rejects missing and incorrect Idempotency-Key', async (testCase) => {
    const handler = await testCase.load()
    const method = testCase.name.includes('PUT') ? 'PUT' : 'POST'
    for (const key of [undefined, sha256Prefixed('wrong-json-write')]) {
      testCase.service.mockClear()
      const response = await handler(
        jsonRequest(testCase.path, method, testCase.body, key),
        { params: Promise.resolve(testCase.params) } as never,
      )
      expect(response.status).toBe(400)
      expect(await response.json()).toMatchObject({
        success: false,
        error: { code: 'CONTRACT_INVALID', field: 'Idempotency-Key' },
      })
      expect(testCase.service).not.toHaveBeenCalled()
    }
  })

  it.each(jsonWriteCases)('$name rejects unknown JSON fields', async (testCase) => {
    const handler = await testCase.load()
    const method = testCase.name.includes('PUT') ? 'PUT' : 'POST'
    const response = await handler(
      jsonRequest(testCase.path, method, { ...testCase.body, unexpected: true }, testCase.key),
      { params: Promise.resolve(testCase.params) } as never,
    )

    expect(response.status).toBe(400)
    expect(await response.json()).toMatchObject({
      success: false,
      error: { code: 'CONTRACT_INVALID', field: 'unexpected' },
    })
    expect(testCase.service).not.toHaveBeenCalled()
  })

  it('GET creator-rules, contract, run and snapshot need no body and reach their read services', async () => {
    const { GET: creatorRules } = await import('@/app/api/agent/v1/projects/[projectId]/creator-rules/route')
    const { GET: contract } = await import('@/app/api/agent/v1/contracts/[contractId]/route')
    const { GET: run } = await import('@/app/api/agent/v1/runs/[runId]/route')
    const { GET: snapshot } = await import('@/app/api/agent/v1/runs/[runId]/snapshot/route')

    const responses = await Promise.all([
      creatorRules(getRequest('/api/agent/v1/projects/project-1/creator-rules'), {
        params: Promise.resolve({ projectId: 'project-1' }),
      }),
      contract(getRequest('/api/agent/v1/contracts/waoo-agent-story.v1'), {
        params: Promise.resolve({ contractId: 'waoo-agent-story.v1' }),
      }),
      run(getRequest('/api/agent/v1/runs/run-1'), {
        params: Promise.resolve({ runId: 'run-1' }),
      }),
      snapshot(getRequest('/api/agent/v1/runs/run-1/snapshot'), {
        params: Promise.resolve({ runId: 'run-1' }),
      }),
    ])
    const payloads = await Promise.all(responses.map(async (response) => response.json()))

    expect(responses.map((response) => response.status)).toEqual([200, 200, 200, 200])
    expect(() => CreatorRulesResponseSchema.parse(payloads[0])).not.toThrow()
    expect(() => ContractResponseSchema.parse(payloads[1])).not.toThrow()
    expect(() => RunResponseSchema.parse(payloads[2])).not.toThrow()
    expect(() => SnapshotResponseSchema.parse(payloads[3])).not.toThrow()
    expect(services.loadCreatorRuleBundle).toHaveBeenCalledTimes(1)
    expect(services.getAgentContract).toHaveBeenCalledTimes(1)
    expect(services.getCreatorRun).toHaveBeenCalledTimes(1)
    expect(services.getRunSnapshot).toHaveBeenCalledTimes(1)
  })

  it('uploads reaches its service and rejects missing/wrong Idempotency-Key', async () => {
    const { POST } = await import('@/app/api/agent/v1/runs/[runId]/uploads/route')
    const expectedKey = uploadIdempotencyKey({
      runId: 'run-1',
      targetType: 'panel-frame',
      targetKey: 'frame-1',
      variantIndex: 0,
      contentSha256: SHA_A,
    })
    const valid = await POST(uploadRequest(uploadForm(), expectedKey), {
      params: Promise.resolve({ runId: 'run-1' }),
    })
    const validPayload = await valid.json()
    expect(valid.status).toBe(200)
    expect(() => UploadResponseSchema.parse(validPayload)).not.toThrow()
    expect(services.commitGeneratedImageUpload).toHaveBeenCalledTimes(1)

    for (const key of [undefined, sha256Prefixed('wrong-upload')]) {
      services.commitGeneratedImageUpload.mockClear()
      const response = await POST(uploadRequest(uploadForm(), key), {
        params: Promise.resolve({ runId: 'run-1' }),
      })
      expect(response.status).toBe(400)
      expect(await response.json()).toMatchObject({
        success: false,
        error: { code: 'CONTRACT_INVALID', field: 'Idempotency-Key' },
      })
      expect(services.commitGeneratedImageUpload).not.toHaveBeenCalled()
    }
  })

  it.each([
    ['unknown', { unknown: true }],
    ['duplicate', { duplicate: true }],
  ])('uploads rejects %s multipart fields', async (_name, options) => {
    const { POST } = await import('@/app/api/agent/v1/runs/[runId]/uploads/route')
    const response = await POST(
      uploadRequest(uploadForm(options), sha256Prefixed('unused')),
      { params: Promise.resolve({ runId: 'run-1' }) },
    )
    expect(response.status).toBe(400)
    expect(await response.json()).toMatchObject({
      success: false,
      error: { code: 'CONTRACT_INVALID' },
    })
    expect(services.commitGeneratedImageUpload).not.toHaveBeenCalled()
  })

  it('all twelve route methods reject requests without Agent credentials', async () => {
    const cases: Array<{
      load: () => Promise<Handler>
      request: () => Request
      params: Record<string, string>
    }> = [
      ...jsonWriteCases.map((testCase) => ({
        load: testCase.load,
        request: () => jsonRequest(
          testCase.path,
          testCase.name.includes('PUT') ? 'PUT' : 'POST',
          testCase.body,
          testCase.key,
          false,
        ),
        params: testCase.params,
      })),
      {
        load: async () => (await import('@/app/api/agent/v1/projects/[projectId]/creator-rules/route')).GET,
        request: () => getRequest('/api/agent/v1/projects/project-1/creator-rules', false),
        params: { projectId: 'project-1' },
      },
      {
        load: async () => (await import('@/app/api/agent/v1/contracts/[contractId]/route')).GET,
        request: () => getRequest('/api/agent/v1/contracts/waoo-agent-story.v1', false),
        params: { contractId: 'waoo-agent-story.v1' },
      },
      {
        load: async () => (await import('@/app/api/agent/v1/runs/[runId]/route')).GET,
        request: () => getRequest('/api/agent/v1/runs/run-1', false),
        params: { runId: 'run-1' },
      },
      {
        load: async () => (await import('@/app/api/agent/v1/runs/[runId]/snapshot/route')).GET,
        request: () => getRequest('/api/agent/v1/runs/run-1/snapshot', false),
        params: { runId: 'run-1' },
      },
      {
        load: async () => (await import('@/app/api/agent/v1/runs/[runId]/uploads/route')).POST,
        request: () => uploadRequest(uploadForm(), sha256Prefixed('unused'), false),
        params: { runId: 'run-1' },
      },
    ]

    for (const testCase of cases) {
      const handler = await testCase.load()
      const response = await handler(testCase.request(), {
        params: Promise.resolve(testCase.params),
      } as never)
      expect(response.status).toBeGreaterThanOrEqual(400)
      expect(response.status).toBeLessThan(600)
      expect(response.status).not.toBe(500)
    }
  })
})
