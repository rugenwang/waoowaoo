import assert from 'node:assert/strict'
import { mkdtemp, mkdir, readFile, readdir, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

import {
  atomicWriteJson,
  canonicalJson,
  normalizeSourceText,
  readJson,
  requestJson,
  resolveConfig,
  resolveProjectRoot,
  runCli,
  sha256Prefixed,
} from '../scripts/waoo-client.mjs'
import { startMockWaooServer } from './mock-waoo-server.mjs'

const REPO_ROOT = path.resolve(import.meta.dirname, '../../..')
const HASH_VECTORS = JSON.parse(await readFile(
  path.join(REPO_ROOT, 'tests/fixtures/agent-api/hash-vectors.json'),
  'utf8',
))

async function tempProject(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'waoo-client-'))
  await writeFile(path.join(root, 'package.json'), '{"name":"waoowaoo"}\n')
  t.after(() => import('node:fs/promises').then(({ rm }) => rm(root, { recursive: true, force: true })))
  return root
}

const envFor = (baseUrl) => ({
  WAOO_BASE_URL: baseUrl,
  WAOO_AGENT_TOKEN: 'top-secret-token',
  WAOO_AGENT_USER_ID: 'user-1',
})

async function pathExistsForTest(target) {
  try {
    await readFile(target)
    return true
  } catch (error) {
    if (error.code === 'EISDIR') return true
    if (error.code === 'ENOENT') return false
    throw error
  }
}

test('canonical JSON, source normalization, and hashes match shared backend vectors', () => {
  for (const vector of HASH_VECTORS.canonical) {
    assert.equal(canonicalJson(vector.input), vector.canonical)
    if (vector.hash) assert.equal(sha256Prefixed(vector.input), vector.hash)
  }
  assert.equal(normalizeSourceText(HASH_VECTORS.source.input), HASH_VECTORS.source.normalized)
  assert.equal(sha256Prefixed(normalizeSourceText(HASH_VECTORS.source.input)), HASH_VECTORS.source.hash)
  assert.equal(sha256Prefixed(HASH_VECTORS.definition.episodes), HASH_VECTORS.definition.hash)
  assert.equal(sha256Prefixed(HASH_VECTORS.runFingerprint.input), HASH_VECTORS.runFingerprint.hash)
})

test('configuration defaults to loopback and rejects missing credentials or unsafe remote URLs', () => {
  assert.equal(resolveConfig({ WAOO_AGENT_TOKEN: 'x', WAOO_AGENT_USER_ID: 'u' }).baseUrl, 'http://127.0.0.1:3000')
  for (const host of ['http://localhost:3000', 'http://127.0.0.1:3000', 'http://[::1]:3000']) {
    assert.equal(resolveConfig({ ...envFor(host) }).baseUrl, host)
  }
  assert.throws(() => resolveConfig({}), /WAOO_AGENT_TOKEN/)
  assert.throws(() => resolveConfig({ WAOO_AGENT_TOKEN: 'x' }), /WAOO_AGENT_USER_ID/)
  assert.throws(() => resolveConfig(envFor('http://example.com')), /remote/i)
  assert.throws(() => resolveConfig({ ...envFor('https://example.com'), WAOO_ALLOW_REMOTE_AGENT_API: 'false' }), /remote/i)
  assert.equal(resolveConfig({ ...envFor('https://example.com'), WAOO_ALLOW_REMOTE_AGENT_API: 'true' }).baseUrl, 'https://example.com')
  assert.throws(() => resolveConfig({ ...envFor('http://example.com'), WAOO_ALLOW_REMOTE_AGENT_API: 'true' }), /HTTPS/i)
})

test('request auth, envelopes, retry, stable idempotency, and redacted failures', async (t) => {
  const mock = await startMockWaooServer((request, attempt) => {
    if (request.url === '/retry' && attempt < 3) return { status: 503, body: { success: false, requestId: 'req-retry', error: { code: 'BUSY', message: 'try again', retryable: true } } }
    if (request.url === '/bad') return { status: 422, body: { success: false, requestId: 'req-bad', error: { code: 'CONTRACT_INVALID', message: 'bad token top-secret-token', field: '/data/name', retryable: false } } }
    return { body: { success: true, requestId: 'req-ok', data: { ok: true } } }
  })
  t.after(mock.close)
  const config = resolveConfig(envFor(mock.baseUrl), { retries: 2, retryDelayMs: 1 })
  const data = await requestJson(config, '/retry', { method: 'POST', body: { a: 1 }, idempotencyKey: 'sha256:' + 'a'.repeat(64) })
  assert.deepEqual(data, { ok: true })
  assert.equal(mock.requests.length, 3)
  assert.equal(new Set(mock.requests.map((entry) => entry.headers['idempotency-key'])).size, 1)
  assert.ok(mock.requests.every((entry) => entry.headers.authorization === 'Bearer top-secret-token'))
  assert.ok(mock.requests.every((entry) => entry.headers['x-waoo-user-id'] === 'user-1'))
  await assert.rejects(
    requestJson(config, '/bad'),
    (error) => error.code === 'CONTRACT_INVALID'
      && error.field === '/data/name'
      && error.requestId === 'req-bad'
      && !error.message.includes('top-secret-token'),
  )
  assert.equal(mock.requests.filter((entry) => entry.url === '/bad').length, 1)
})

test('atomic JSON IO never leaves temporary files and preserves values', async (t) => {
  const root = await tempProject(t)
  const target = path.join(root, 'nested', 'value.json')
  await atomicWriteJson(target, { z: 1, a: [2] })
  assert.deepEqual(await readJson(target), { z: 1, a: [2] })
  assert.deepEqual(await readdir(path.dirname(target)), ['value.json'])
})

test('project root resolution honors explicit/env/cwd/nested order and rejects zero or ambiguous candidates', async (t) => {
  const outer = await mkdtemp(path.join(os.tmpdir(), 'waoo-roots-'))
  t.after(() => import('node:fs/promises').then(({ rm }) => rm(outer, { recursive: true, force: true })))
  const explicit = path.join(outer, 'explicit')
  const envRoot = path.join(outer, 'env')
  const cwd = path.join(outer, 'cwd')
  for (const root of [explicit, envRoot, cwd]) {
    await mkdir(root)
    await writeFile(path.join(root, 'package.json'), '{"name":"waoowaoo"}')
  }
  assert.equal(await resolveProjectRoot({ explicitRoot: explicit, env: { WAOO_PROJECT_ROOT: envRoot }, cwd }), explicit)
  assert.equal(await resolveProjectRoot({ env: { WAOO_PROJECT_ROOT: envRoot }, cwd }), envRoot)
  assert.equal(await resolveProjectRoot({ env: {}, cwd }), cwd)
  const parent = path.join(outer, 'parent')
  await mkdir(path.join(parent, 'waoowaoo'), { recursive: true })
  await writeFile(path.join(parent, 'waoowaoo/package.json'), '{"name":"waoowaoo"}')
  assert.equal(await resolveProjectRoot({ env: {}, cwd: parent }), path.join(parent, 'waoowaoo'))
  await assert.rejects(resolveProjectRoot({ env: {}, cwd: path.join(outer, 'missing') }), /locate/i)
  await assert.rejects(resolveProjectRoot({ explicitRoot: explicit, env: { WAOO_PROJECT_ROOT: envRoot }, cwd, strictUnique: true }), /multiple/i)
})

test('CLI covers doctor, project/rules/run, dry-run commits, upload, snapshot and finalize', async (t) => {
  const root = await tempProject(t)
  const sourceFile = path.join(root, 'source-input.md')
  const definitionFile = path.join(root, 'definition-input.json')
  const artifactFile = path.join(root, 'story.json')
  const assetsFile = path.join(root, 'assets.json')
  const screenplayFile = path.join(root, 'screenplay.json')
  const storyboardsFile = path.join(root, 'storyboards.json')
  const imageFile = path.join(root, 'image.png')
  await writeFile(sourceFile, ' 第一集\r\n正文 ')
  await writeFile(definitionFile, JSON.stringify([{ episodeKey: 'episode-001', ordinal: 1, sourceText: '正文', name: '第一集' }]))
  await writeFile(artifactFile, JSON.stringify({ 'episode-001': { episodeKey: 'episode-001', sourceHash: sha256Prefixed('正文'), inputKind: 'story', name: '第一集', novelText: '完整故事' } }))
  await writeFile(assetsFile, JSON.stringify({ characters: [], locations: [], props: [] }))
  await writeFile(screenplayFile, JSON.stringify({ 'episode-001': { episodeKey: 'episode-001', clips: [] } }))
  await writeFile(storyboardsFile, JSON.stringify({ 'episode-001': { episodeKey: 'episode-001', storyboards: [] } }))
  await writeFile(imageFile, Buffer.from([137, 80, 78, 71]))

  const schema = { type: 'object' }
  const contractHash = sha256Prefixed(schema)
  const rulesWithoutHash = {
    schemaVersion: 1,
    ruleSetVersion: '2026-01',
    locale: 'zh',
    projectSettings: { artStyle: 'realistic', artStylePrompt: null, videoRatio: '9:16', imageResolution: '1024x1792', forcedStoryboardDurationSec: null },
    rules: [{ id: 'hard-rule', kind: 'hard', content: 'rule', hash: sha256Prefixed('rule') }],
    contracts: [{ id: 'waoo-agent-resolve-project.v1', url: '/api/agent/v1/contracts/waoo-agent-resolve-project.v1', hash: contractHash }],
  }
  const rules = { ...rulesWithoutHash, contentHash: sha256Prefixed(rulesWithoutHash) }
  let runRequest
  const mock = await startMockWaooServer((request) => {
    const success = (data) => ({ body: { success: true, requestId: 'req-1', data } })
    if (request.url.includes('/contracts/')) return success({ id: 'waoo-agent-resolve-project.v1', hash: contractHash, jsonSchema: schema })
    if (request.url === '/api/agent/v1/projects/resolve') return success({ projectId: 'project-1', name: request.json.name, created: true })
    if (request.url === '/api/agent/v1/projects/project-1/creator-rules?locale=zh') return success(rules)
    if (request.url === '/api/agent/v1/projects/project-1/runs') {
      runRequest = request.json
      return success({ runId: 'run-1', resumed: false, status: 'created', projectId: 'project-1', sourceHash: runRequest.sourceHash, runFingerprint: runRequest.runFingerprint, episodes: [{ episodeKey: 'episode-001', episodeId: 'ep-db-1', episodeNumber: 1, name: '第一集' }] })
    }
    if (request.url === '/api/agent/v1/runs/run-1' && request.method === 'GET') return success({ runId: 'run-1', projectId: 'project-1', status: 'created', currentStage: 'created', sourceHash: runRequest.sourceHash, runFingerprint: runRequest.runFingerprint, ruleSetVersion: rules.ruleSetVersion, ruleSetHash: rules.contentHash, episodes: [{ episodeKey: 'episode-001', episodeId: 'ep-db-1', episodeNumber: 1, status: 'created' }] })
    if (request.url.endsWith('/story')) return success({ dryRun: request.json.dryRun, episodeKey: 'episode-001', episodeId: 'ep-db-1', episodeNumber: 1, artifactHash: request.json.artifactHash })
    if (request.url.endsWith('/assets')) return success({ dryRun: request.json.dryRun, artifactHash: request.json.artifactHash })
    if (request.url.endsWith('/screenplay')) return success({ dryRun: request.json.dryRun, episodeKey: 'episode-001', artifactHash: request.json.artifactHash })
    if (request.url.endsWith('/storyboards')) return success({ dryRun: request.json.dryRun, episodeKey: 'episode-001', artifactHash: request.json.artifactHash })
    if (request.url.endsWith('/snapshot')) return success({ runId: 'run-1', status: 'story_committed', committedArtifactHashes: { stories: {}, screenplays: {}, storyboards: {} }, uploads: [], missing: [] })
    if (request.url.endsWith('/uploads')) return success({ runId: 'run-1', targetType: 'character-appearance', targetKey: 'hero.base', variantIndex: 0, contentSha256: request.headers['idempotency-key'] ? sha256Prefixed(Buffer.from([137, 80, 78, 71])) : '', mediaId: 'media-1', storageKey: 'x', url: '/x.png', reused: false })
    if (request.url.endsWith('/finalize')) return success({ runId: 'run-1', status: 'completed', completedAt: new Date().toISOString(), counts: { episodes: 1, characters: 0, locations: 0, props: 0, clips: 0, storyboards: 0, panels: 0, frames: 0, uploadedImages: 1 } })
    return success({})
  })
  t.after(mock.close)
  const env = envFor(mock.baseUrl)
  const common = ['--project-root', root]
  await runCli(['doctor', ...common], { env })
  await runCli(['resolve-project', ...common, '--name', '测试项目'], { env })
  const fetched = await runCli(['fetch-rules', ...common, '--project-id', 'project-1', '--source-hash', sha256Prefixed('正文'), '--locale', 'zh'], { env })
  const rulesFile = fetched.rulesPath
  const created = await runCli(['create-run', ...common, '--project-id', 'project-1', '--source-file', sourceFile, '--definition-file', definitionFile, '--rules-file', rulesFile], { env })
  assert.equal(created.runId, 'run-1')
  assert.equal(runRequest.episodes[0].sourceText, undefined)
  const runDir = path.join(root, '.waoo-agent/runs/run-1')
  const manifest = await readJson(path.join(runDir, 'manifest.json'))
  assert.equal(manifest.runId, 'run-1')
  assert.deepEqual(manifest.episodeMap, { 'episode-001': { episodeId: 'ep-db-1', episodeNumber: 1 } })
  assert.equal(await readFile(path.join(runDir, 'source.md'), 'utf8'), normalizeSourceText(await readFile(sourceFile, 'utf8')))
  assert.ok((await readJson(path.join(runDir, 'rules.json'))).contractsData)
  await runCli(['get-run', ...common, '--run-id', 'run-1', '--run-dir', runDir], { env })
  assert.equal(mock.requests.find((request) => request.url === '/api/agent/v1/runs/run-1').method, 'GET')
  await runCli(['commit-story', ...common, '--run-id', 'run-1', '--run-dir', runDir, '--artifact-file', artifactFile, '--episode-key', 'episode-001'], { env })
  assert.equal(mock.requests.filter((request) => request.url.endsWith('/story')).length, 1)
  const receiptsBeforeCommit = await readJson(path.join(runDir, 'receipts.json'))
  assert.equal(receiptsBeforeCommit?.artifacts?.stories, undefined)
  await runCli(['commit-story', ...common, '--run-id', 'run-1', '--run-dir', runDir, '--artifact-file', artifactFile, '--episode-key', 'episode-001', '--commit'], { env })
  for (const [command, file, endpointSuffix, needsEpisode] of [
    ['commit-assets', assetsFile, '/assets', false],
    ['commit-screenplay', screenplayFile, '/screenplay', true],
    ['commit-storyboards', storyboardsFile, '/storyboards', true],
  ]) {
    const args = [command, ...common, '--run-id', 'run-1', '--run-dir', runDir, '--artifact-file', file]
    if (needsEpisode) args.push('--episode-key', 'episode-001')
    const dry = await runCli(args, { env })
    assert.equal(dry.dryRun, true)
    await runCli([...args, '--commit'], { env })
    const writes = mock.requests.filter((request) => request.url.endsWith(endpointSuffix))
    assert.deepEqual(writes.map((request) => request.method), ['PUT', 'PUT'])
    assert.deepEqual(writes.map((request) => request.json.dryRun), [true, false])
    assert.ok(writes.every((request) => request.headers['idempotency-key'] === request.json.artifactHash))
  }
  await runCli(['upload', ...common, '--run-id', 'run-1', '--run-dir', runDir, '--file', imageFile, '--target-type', 'character-appearance', '--target-key', 'hero.base', '--variant-index', '0'], { env })
  await runCli(['snapshot', ...common, '--run-id', 'run-1', '--run-dir', runDir], { env })
  const receipts = await readJson(path.join(runDir, 'receipts.json'))
  await runCli(['finalize', ...common, '--run-id', 'run-1', '--run-dir', runDir], { env })
  const finalizeRequest = mock.requests.find((request) => request.url.endsWith('/finalize')).json
  assert.equal('video' in finalizeRequest, false)
  assert.equal(finalizeRequest.expected.stories['episode-001'], receipts.artifacts.stories['episode-001'].artifactHash)
})

test('create-run crash recovery replays pinned request and never overwrites completed work', async (t) => {
  const root = await tempProject(t)
  const sourceFile = path.join(root, 'source.md')
  const definitionFile = path.join(root, 'definition.json')
  const rulesFile = path.join(root, 'rules.json')
  await writeFile(sourceFile, '正文')
  await writeFile(definitionFile, JSON.stringify([{ episodeKey: 'episode-001', ordinal: 1, sourceText: '正文', name: '第一集' }]))
  const rulesCore = { schemaVersion: 1, ruleSetVersion: 'v1', locale: 'zh', projectSettings: { artStyle: 'ink', artStylePrompt: null, videoRatio: '16:9', imageResolution: '1k', forcedStoryboardDurationSec: null }, rules: [], contracts: [], contractsData: {} }
  await atomicWriteJson(rulesFile, { ...rulesCore, contentHash: sha256Prefixed(Object.fromEntries(Object.entries(rulesCore).filter(([key]) => key !== 'contractsData'))) })
  let calls = 0
  const mock = await startMockWaooServer((request) => {
    calls += 1
    if (calls === 1) return { destroy: true }
    return { body: { success: true, requestId: 'req', data: { runId: 'run-recovered', resumed: true, status: 'created', projectId: 'project-1', sourceHash: request.json.sourceHash, runFingerprint: request.json.runFingerprint, episodes: [{ episodeKey: 'episode-001', episodeId: 'ep-1', episodeNumber: 1, name: '第一集' }] } } }
  })
  t.after(mock.close)
  const env = { ...envFor(mock.baseUrl), WAOO_HTTP_RETRIES: '0' }
  const args = ['create-run', '--project-root', root, '--project-id', 'project-1', '--source-file', sourceFile, '--definition-file', definitionFile, '--rules-file', rulesFile]
  await assert.rejects(runCli(args, { env }), /network|fetch/i)
  const pending = await runCli(['find-local-run', '--project-root', root, '--project-id', 'project-1', '--source-file', sourceFile], { env })
  assert.equal(pending.status, 'pending-create')
  const result = await runCli(args, { env })
  assert.equal(result.runId, 'run-recovered')
  assert.deepEqual(mock.requests[0].json, mock.requests[1].json)
  const runDir = path.join(root, '.waoo-agent/runs/run-recovered')
  await writeFile(path.join(runDir, 'story.json'), '{"kept":true}')
  await runCli(args, { env })
  assert.equal(await readFile(path.join(runDir, 'story.json'), 'utf8'), '{"kept":true}')

  const currentRulesElsewhere = path.join(root, 'current-rules.json')
  await atomicWriteJson(currentRulesElsewhere, { contentHash: 'sha256:' + 'f'.repeat(64) })
  const resumed = await runCli(['find-local-run', '--project-root', root, '--project-id', 'project-1', '--source-file', sourceFile], { env })
  assert.equal(resumed.status, 'resume')
  assert.equal(resumed.runId, 'run-recovered')
})

test('create-run rejects tampered pinned rule content before making a request', async (t) => {
  const root = await tempProject(t)
  const sourceFile = path.join(root, 'source.md')
  const definitionFile = path.join(root, 'definition.json')
  const rulesFile = path.join(root, 'rules.json')
  await writeFile(sourceFile, '正文')
  await writeFile(definitionFile, JSON.stringify([{ episodeKey: 'episode-001', ordinal: 1, sourceText: '正文', name: '第一集' }]))
  const rule = { id: 'hard-rule', kind: 'hard', content: 'original', hash: sha256Prefixed('original') }
  const core = { schemaVersion: 1, ruleSetVersion: 'v1', locale: 'zh', projectSettings: { artStyle: 'ink', artStylePrompt: null, videoRatio: '16:9', imageResolution: '1k', forcedStoryboardDurationSec: null }, rules: [rule], contracts: [] }
  await atomicWriteJson(rulesFile, { ...core, contentHash: sha256Prefixed(core) })
  const tampered = await readJson(rulesFile)
  tampered.rules[0].content = 'tampered'
  await atomicWriteJson(rulesFile, tampered)
  await assert.rejects(
    runCli(['create-run', '--project-root', root, '--project-id', 'project-1', '--source-file', sourceFile, '--definition-file', definitionFile, '--rules-file', rulesFile], { env: envFor('http://127.0.0.1:9') }),
    /rule content hash mismatch/,
  )
})

test('rule mismatch retains the old pinned intake and new rules create a new fingerprint', async (t) => {
  const root = await tempProject(t)
  const sourceFile = path.join(root, 'source.md')
  const definitionFile = path.join(root, 'definition.json')
  await writeFile(sourceFile, '正文')
  await writeFile(definitionFile, JSON.stringify([{ episodeKey: 'episode-001', ordinal: 1, sourceText: '正文', name: '第一集' }]))
  const makeRules = async (version, content) => {
    const file = path.join(root, `rules-${version}.json`)
    const rule = { id: 'hard-rule', kind: 'hard', content, hash: sha256Prefixed(content) }
    const core = { schemaVersion: 1, ruleSetVersion: version, locale: 'zh', projectSettings: { artStyle: 'ink', artStylePrompt: null, videoRatio: '16:9', imageResolution: '1k', forcedStoryboardDurationSec: null }, rules: [rule], contracts: [] }
    await atomicWriteJson(file, { ...core, contentHash: sha256Prefixed(core), contractsData: {} })
    return file
  }
  const v1 = await makeRules('v1', 'old')
  const v2 = await makeRules('v2', 'new')
  const mock = await startMockWaooServer((request) => {
    if (request.json.ruleSetVersion === 'v1') return { status: 409, body: { success: false, requestId: 'rule-mismatch', error: { code: 'AGENT_RULE_MISMATCH', message: 'rules changed', retryable: false } } }
    return { body: { success: true, requestId: 'created', data: { runId: 'run-v2', resumed: false, status: 'created', projectId: 'project-1', sourceHash: request.json.sourceHash, runFingerprint: request.json.runFingerprint, episodes: [{ episodeKey: 'episode-001', episodeId: 'ep-1', episodeNumber: 1, name: '第一集' }] } } }
  })
  t.after(mock.close)
  const common = ['--project-root', root, '--project-id', 'project-1', '--source-file', sourceFile, '--definition-file', definitionFile]
  const env = envFor(mock.baseUrl)
  await assert.rejects(runCli(['create-run', ...common, '--rules-file', v1], { env }), (error) => error.code === 'AGENT_RULE_MISMATCH')
  const oldFingerprint = mock.requests[0].json.runFingerprint
  const oldIntake = path.join(root, '.waoo-agent/intake', oldFingerprint)
  assert.equal((await readJson(path.join(oldIntake, 'rules.json'))).ruleSetVersion, 'v1')
  assert.equal('runId' in await readJson(path.join(oldIntake, 'intake.json')), false)
  const created = await runCli(['create-run', ...common, '--rules-file', v2], { env })
  assert.equal(created.runId, 'run-v2')
  assert.notEqual(created.runFingerprint, oldFingerprint)
  assert.equal(await pathExistsForTest(oldIntake), true)
})

test('incomplete create response never promotes pending intake to a formal run', async (t) => {
  const root = await tempProject(t)
  const sourceFile = path.join(root, 'source.md')
  const definitionFile = path.join(root, 'definition.json')
  const rulesFile = path.join(root, 'rules.json')
  await writeFile(sourceFile, '正文')
  await writeFile(definitionFile, JSON.stringify([{ episodeKey: 'episode-001', ordinal: 1, sourceText: '正文', name: '第一集' }]))
  const core = { schemaVersion: 1, ruleSetVersion: 'v1', locale: 'zh', projectSettings: { artStyle: 'ink', artStylePrompt: null, videoRatio: '16:9', imageResolution: '1k', forcedStoryboardDurationSec: null }, rules: [], contracts: [] }
  await atomicWriteJson(rulesFile, { ...core, contentHash: sha256Prefixed(core), contractsData: {} })
  const mock = await startMockWaooServer((request) => ({ body: { success: true, requestId: 'bad-map', data: { runId: 'run-bad', resumed: false, status: 'created', projectId: 'project-1', sourceHash: request.json.sourceHash, runFingerprint: request.json.runFingerprint, episodes: [] } } }))
  t.after(mock.close)
  await assert.rejects(runCli(['create-run', '--project-root', root, '--project-id', 'project-1', '--source-file', sourceFile, '--definition-file', definitionFile, '--rules-file', rulesFile], { env: envFor(mock.baseUrl) }), /episode map is incomplete/)
  assert.equal(await pathExistsForTest(path.join(root, '.waoo-agent/runs/run-bad')), false)
  assert.equal(await pathExistsForTest(path.join(root, '.waoo-agent/intake', mock.requests[0].json.runFingerprint, 'run-request.json')), true)
})

test('upload network retry keeps one idempotency key and writes one receipt', async (t) => {
  const root = await tempProject(t)
  const runDir = path.join(root, '.waoo-agent/runs/run-1')
  const imageFile = path.join(runDir, 'images/assets/hero/variant-0.png')
  await mkdir(path.dirname(imageFile), { recursive: true })
  await writeFile(imageFile, Buffer.from([137, 80, 78, 71, 1]))
  let uploadAttempt = 0
  const mock = await startMockWaooServer(() => {
    uploadAttempt += 1
    if (uploadAttempt === 1) return { destroy: true }
    return {
      body: {
        success: true,
        requestId: 'upload-ok',
        data: {
          runId: 'run-1',
          targetType: 'character-appearance',
          targetKey: 'hero.base',
          variantIndex: 0,
          contentSha256: sha256Prefixed(Buffer.from([137, 80, 78, 71, 1])),
          mediaId: 'media-1',
          storageKey: 'media/x.png',
          url: '/media/x.png',
          reused: false,
        },
      },
    }
  })
  t.after(mock.close)
  const result = await runCli([
    'upload', '--project-root', root, '--run-id', 'run-1', '--run-dir', runDir,
    '--file', imageFile, '--target-type', 'character-appearance', '--target-key', 'hero.base', '--variant-index', '0',
  ], { env: { ...envFor(mock.baseUrl), WAOO_HTTP_RETRIES: '1', WAOO_HTTP_RETRY_DELAY_MS: '1' } })
  assert.equal(mock.requests.length, 2)
  assert.equal(mock.requests[0].headers['idempotency-key'], mock.requests[1].headers['idempotency-key'])
  assert.equal(result.idempotencyKey, mock.requests[0].headers['idempotency-key'])
  assert.equal(Object.keys((await readJson(path.join(runDir, 'receipts.json'))).uploads).length, 1)
})

test('retry policy covers network, 5xx and retryable failures but not ordinary 4xx', async (t) => {
  const counts = new Map()
  const mock = await startMockWaooServer((request) => {
    const count = (counts.get(request.url) ?? 0) + 1
    counts.set(request.url, count)
    if (request.url === '/network' && count === 1) return { destroy: true }
    if (request.url === '/five' && count === 1) return { status: 500, body: { success: false, requestId: 'r', error: { code: 'SERVER', message: 'server', retryable: false } } }
    if (request.url === '/retryable' && count === 1) return { status: 409, body: { success: false, requestId: 'r', error: { code: 'LOCKED', message: 'locked', retryable: true } } }
    if (request.url === '/ordinary') return { status: 409, body: { success: false, requestId: 'r', error: { code: 'CONFLICT', message: 'conflict', retryable: false } } }
    return { body: { success: true, requestId: 'ok', data: { ok: true } } }
  })
  t.after(mock.close)
  const config = resolveConfig(envFor(mock.baseUrl), { retries: 1, retryDelayMs: 1 })
  for (const target of ['/network', '/five', '/retryable']) assert.deepEqual(await requestJson(config, target), { ok: true })
  await assert.rejects(requestJson(config, '/ordinary'), (error) => error.code === 'CONFLICT')
  assert.equal(counts.get('/network'), 2)
  assert.equal(counts.get('/five'), 2)
  assert.equal(counts.get('/retryable'), 2)
  assert.equal(counts.get('/ordinary'), 1)
})
