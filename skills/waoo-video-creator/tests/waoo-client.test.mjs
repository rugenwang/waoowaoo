import assert from 'node:assert/strict'
import { mkdtemp, mkdir, readFile, readdir, realpath, rm, symlink, utimes, writeFile } from 'node:fs/promises'
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
import { parseMultipartRequest, startMockWaooServer } from './mock-waoo-server.mjs'

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

function deferred() {
  let resolve
  const promise = new Promise((done) => { resolve = done })
  return { promise, resolve }
}

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

async function writeRulesSnapshot(root, version, content = version) {
  const file = path.join(root, `rules-${version}.json`)
  const rule = { id: 'hard-rule', kind: 'hard', content, hash: sha256Prefixed(content) }
  const core = { schemaVersion: 1, ruleSetVersion: version, locale: 'zh', projectSettings: { artStyle: 'ink', artStylePrompt: null, videoRatio: '16:9', imageResolution: '1k', forcedStoryboardDurationSec: null }, rules: [rule], contracts: [] }
  await atomicWriteJson(file, { ...core, contentHash: sha256Prefixed(core), contractsData: {} })
  return file
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

test('configuration strictly validates all numeric limits', () => {
  const cases = [
    ['WAOO_HTTP_RETRIES', ['-1', '11', '1.5', 'NaN', 'Infinity']],
    ['WAOO_HTTP_RETRY_DELAY_MS', ['-1', '60001', '1.5', 'NaN', 'Infinity']],
    ['WAOO_HTTP_TIMEOUT_MS', ['99', '300001', '1.5', 'NaN', 'Infinity']],
    ['WAOO_AGENT_UPLOAD_MAX_BYTES', ['0', '1073741825', '1.5', 'NaN', 'Infinity']],
  ]
  for (const [key, values] of cases) {
    for (const value of values) assert.throws(() => resolveConfig({ ...envFor('http://127.0.0.1:3000'), [key]: value }), new RegExp(key))
  }
  const config = resolveConfig(envFor('http://127.0.0.1:3000'))
  assert.deepEqual({ retries: config.retries, retryDelayMs: config.retryDelayMs, timeoutMs: config.timeoutMs, uploadMaxBytes: config.uploadMaxBytes }, { retries: 2, retryDelayMs: 150, timeoutMs: 30000, uploadMaxBytes: 10485760 })
})

test('request auth, envelopes, retry, stable idempotency, and redacted failures', async (t) => {
  const mock = await startMockWaooServer((request, attempt) => {
    if (request.url === '/api/agent/v1/test/retry' && attempt < 3) return { status: 503, body: { success: false, requestId: 'req-retry', error: { code: 'BUSY', message: 'try again', retryable: true } } }
    if (request.url === '/api/agent/v1/test/bad') return { status: 422, body: { success: false, requestId: 'req-bad', error: { code: 'CONTRACT_INVALID', message: 'bad token top-secret-token', field: '/data/name', retryable: false } } }
    return { body: { success: true, requestId: 'req-ok', data: { ok: true } } }
  })
  t.after(mock.close)
  const config = resolveConfig(envFor(mock.baseUrl), { retries: 2, retryDelayMs: 1 })
  const data = await requestJson(config, '/api/agent/v1/test/retry', { method: 'POST', body: { a: 1 }, idempotencyKey: 'sha256:' + 'a'.repeat(64) })
  assert.deepEqual(data, { ok: true })
  assert.equal(mock.requests.length, 3)
  assert.equal(new Set(mock.requests.map((entry) => entry.headers['idempotency-key'])).size, 1)
  assert.ok(mock.requests.every((entry) => entry.headers.authorization === 'Bearer top-secret-token'))
  assert.ok(mock.requests.every((entry) => entry.headers['x-waoo-user-id'] === 'user-1'))
  await assert.rejects(
    requestJson(config, '/api/agent/v1/test/bad'),
    (error) => error.code === 'CONTRACT_INVALID'
      && error.field === '/data/name'
      && error.requestId === 'req-bad'
      && !error.message.includes('top-secret-token'),
  )
  assert.equal(mock.requests.filter((entry) => entry.url === '/api/agent/v1/test/bad').length, 1)
})

test('requestJson rejects same-request credential exfiltration through absolute or escaped URLs', async (t) => {
  const mock = await startMockWaooServer(() => ({ body: { success: true, requestId: 'ok', data: {} } }))
  t.after(mock.close)
  const config = resolveConfig(envFor(mock.baseUrl))
  await assert.rejects(requestJson(config, 'https://example.com/api/agent/v1/contracts/x'), /same-origin|origin|unsafe/i)
  await assert.rejects(requestJson(config, '//example.com/api/agent/v1/contracts/x'), /same-origin|origin|unsafe/i)
  await assert.rejects(requestJson(config, '/api/agent/v1/../../escape'), /Agent API path|unsafe/i)
  assert.equal(mock.requests.length, 0)
})

test('requestJson never follows redirects, including to an external or non-agent target', async (t) => {
  const target = await startMockWaooServer(() => ({ body: { success: true, requestId: 'stolen', data: {} } }))
  t.after(target.close)
  const source = await startMockWaooServer((request) => ({ status: 302, headers: { location: request.url.endsWith('/external') ? `${target.baseUrl}/api/agent/v1/stolen` : '/not-agent' }, body: { success: false, requestId: 'redirect', error: { code: 'REDIRECT', message: 'redirect', retryable: false } } }))
  t.after(source.close)
  const config = resolveConfig(envFor(source.baseUrl), { retries: 2, retryDelayMs: 1 })
  await assert.rejects(requestJson(config, '/api/agent/v1/test/external'), (error) => error.status === 302)
  await assert.rejects(requestJson(config, '/api/agent/v1/test/non-agent'), (error) => error.status === 302)
  assert.equal(source.requests.length, 2)
  assert.equal(target.requests.length, 0)
  assert.ok(source.requests.every((request) => request.headers.authorization === 'Bearer top-secret-token'))
})

test('failure metadata and CLI-safe errors redact token and user id from every field', async (t) => {
  const mock = await startMockWaooServer(() => ({ status: 422, body: { success: false, requestId: 'user-1', error: { code: 'top-secret-token', message: 'top-secret-token user-1', field: '/top-secret-token/user-1', retryable: false } } }))
  t.after(mock.close)
  const config = resolveConfig(envFor(mock.baseUrl), { retries: 0 })
  await assert.rejects(requestJson(config, '/api/agent/v1/contracts/x'), (error) => {
    const serialized = JSON.stringify({ message: error.message, code: error.code, field: error.field, requestId: error.requestId })
    return !serialized.includes('top-secret-token') && !serialized.includes('user-1')
  })
})

test('successful response data is returned byte-for-byte semantically unchanged even when it contains credential text', async (t) => {
  const original = {
    literalToken: 'top-secret-token',
    literalUserId: 'user-1',
    nested: ['prefix-top-secret-token-suffix', { value: 'user-1' }],
  }
  const mock = await startMockWaooServer(() => ({ body: { success: true, requestId: 'success-request', data: original } }))
  t.after(mock.close)
  assert.deepEqual(await requestJson(resolveConfig(envFor(mock.baseUrl)), '/api/agent/v1/contracts/x'), original)
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
  assert.equal(await resolveProjectRoot({ explicitRoot: explicit, env: { WAOO_PROJECT_ROOT: envRoot }, cwd }), await realpath(explicit))
  assert.equal(await resolveProjectRoot({ env: { WAOO_PROJECT_ROOT: envRoot }, cwd }), await realpath(envRoot))
  assert.equal(await resolveProjectRoot({ env: {}, cwd }), await realpath(cwd))
  const parent = path.join(outer, 'parent')
  await mkdir(path.join(parent, 'waoowaoo'), { recursive: true })
  await writeFile(path.join(parent, 'waoowaoo/package.json'), '{"name":"waoowaoo"}')
  assert.equal(await resolveProjectRoot({ env: {}, cwd: parent }), await realpath(path.join(parent, 'waoowaoo')))
  await assert.rejects(resolveProjectRoot({ env: {}, cwd: path.join(outer, 'missing') }), /locate/i)
  await assert.rejects(resolveProjectRoot({ explicitRoot: explicit, env: { WAOO_PROJECT_ROOT: envRoot }, cwd, strictUnique: true }), /multiple/i)
})

test('project paths reject symlink traversal for reads and write roots before HTTP', async (t) => {
  const root = await tempProject(t)
  const outside = await mkdtemp(path.join(os.tmpdir(), 'waoo-outside-'))
  t.after(() => import('node:fs/promises').then(({ rm: remove }) => remove(outside, { recursive: true, force: true })))
  const outsideSource = path.join(outside, 'source.md')
  const outsideArtifact = path.join(outside, 'story.json')
  const outsideImage = path.join(outside, 'image.png')
  await writeFile(outsideSource, 'secret source')
  await writeFile(outsideArtifact, '{}')
  await writeFile(outsideImage, Buffer.from([137, 80, 78, 71]))
  const linkedSource = path.join(root, 'linked-source.md')
  const linkedArtifact = path.join(root, 'linked-story.json')
  const linkedImage = path.join(root, 'linked-image.png')
  await symlink(outsideSource, linkedSource)
  await symlink(outsideArtifact, linkedArtifact)
  await symlink(outsideImage, linkedImage)
  await assert.rejects(runCli(['find-local-run', '--project-root', root, '--project-id', 'project-1', '--source-file', linkedSource]), /symlink|outside project root/i)

  const runDir = path.join(root, '.waoo-agent/runs/run-1')
  await mkdir(runDir, { recursive: true })
  await atomicWriteJson(path.join(runDir, 'manifest.json'), { manifestVersion: 1, runId: 'run-1', projectId: 'project-1', ruleSetVersion: 'v1', ruleSetHash: 'sha256:' + 'a'.repeat(64) })
  await atomicWriteJson(path.join(runDir, 'receipts.json'), { receiptVersion: 1, runId: 'run-1', projectId: 'project-1', artifacts: {}, uploads: {} })
  const mock = await startMockWaooServer(() => ({ body: { success: true, requestId: 'unexpected', data: {} } }))
  t.after(mock.close)
  await assert.rejects(runCli(['commit-assets', '--project-root', root, '--run-id', 'run-1', '--run-dir', runDir, '--artifact-file', linkedArtifact], { env: envFor(mock.baseUrl) }), /symlink|outside project root/i)
  await assert.rejects(runCli(['upload', '--project-root', root, '--run-id', 'run-1', '--run-dir', runDir, '--file', linkedImage, '--target-type', 'character-appearance', '--target-key', 'hero.base'], { env: envFor(mock.baseUrl) }), /symlink|outside project root/i)
  await mkdir(path.join(root, '.waoo-agent'), { recursive: true })
  await symlink(outside, path.join(root, '.waoo-agent/preflight'))
  await assert.rejects(runCli(['fetch-rules', '--project-root', root, '--project-id', 'project-1', '--source-hash', 'sha256:' + 'b'.repeat(64)], { env: envFor(mock.baseUrl) }), /symlink|outside project root/i)
  assert.equal(mock.requests.length, 0)
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
  const storyArtifact = { episodeKey: 'episode-001', sourceHash: sha256Prefixed('正文'), inputKind: 'story', name: '第一集', novelText: '完整故事' }
  const assetsArtifact = { characters: [], locations: [], props: [] }
  const screenplayArtifact = { episodeKey: 'episode-001', clips: [] }
  const storyboardsArtifact = { episodeKey: 'episode-001', storyboards: [] }
  await writeFile(sourceFile, ' 第一集\r\n正文 ')
  await writeFile(definitionFile, JSON.stringify([{ episodeKey: 'episode-001', ordinal: 1, sourceText: '正文', name: '第一集' }]))
  await writeFile(artifactFile, JSON.stringify({ 'episode-001': storyArtifact }))
  await writeFile(assetsFile, JSON.stringify(assetsArtifact))
  await writeFile(screenplayFile, JSON.stringify({ 'episode-001': screenplayArtifact }))
  await writeFile(storyboardsFile, JSON.stringify({ 'episode-001': storyboardsArtifact }))
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
  let snapshotCalls = 0
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
    if (request.url.endsWith('/snapshot')) {
      snapshotCalls += 1
      return success({
        runId: 'run-1',
        status: snapshotCalls === 1 ? 'story_committed' : 'incomplete',
        committedArtifactHashes: { stories: {}, screenplays: {}, storyboards: {} },
        uploads: [],
        missing: snapshotCalls === 1 ? [] : [{ code: 'FRAME_IMAGE_MISSING', targetType: 'panel-frame', targetKey: 'frame-1', message: 'missing' }],
      })
    }
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
  assert.deepEqual(await readJson(path.join(runDir, 'receipts.json')), { receiptVersion: 1, runId: 'run-1', projectId: 'project-1', artifacts: {}, uploads: {} })
  assert.equal(manifest.runId, 'run-1')
  assert.deepEqual(manifest.episodeMap, { 'episode-001': { episodeId: 'ep-db-1', episodeNumber: 1 } })
  assert.equal(await readFile(path.join(runDir, 'source.md'), 'utf8'), normalizeSourceText(await readFile(sourceFile, 'utf8')))
  assert.ok((await readJson(path.join(runDir, 'rules.json'))).contractsData)
  await runCli(['get-run', ...common, '--run-id', 'run-1', '--run-dir', runDir], { env })
  assert.equal(mock.requests.find((request) => request.url === '/api/agent/v1/runs/run-1').method, 'GET')
  const refreshedManifest = await readJson(path.join(runDir, 'manifest.json'))
  assert.deepEqual({ status: refreshedManifest.status, currentStage: refreshedManifest.currentStage }, { status: 'created', currentStage: 'created' })
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
  const completedManifest = await readJson(path.join(runDir, 'manifest.json'))
  assert.equal(completedManifest.status, 'completed')
  assert.equal(completedManifest.currentStage, 'completed')
  assert.equal(typeof completedManifest.completedAt, 'string')

  const [doctorRequest, resolveRequest, rulesRequest, contractRequest, createRequest] = mock.requests
  assert.equal(mock.requests.length, 17)
  for (const request of mock.requests) {
    assert.equal(request.headers.authorization, 'Bearer top-secret-token')
    assert.equal(request.headers['x-waoo-user-id'], 'user-1')
  }
  assert.deepEqual([doctorRequest.method, doctorRequest.url, doctorRequest.headers['idempotency-key']], ['GET', '/api/agent/v1/contracts/waoo-agent-resolve-project.v1', undefined])
  assert.equal(doctorRequest.body.length, 0)
  assert.deepEqual([resolveRequest.method, resolveRequest.url, resolveRequest.json], ['POST', '/api/agent/v1/projects/resolve', { name: '测试项目' }])
  assert.equal(resolveRequest.headers['idempotency-key'], sha256Prefixed('resolve-project:测试项目'))
  assert.deepEqual([rulesRequest.method, rulesRequest.url, rulesRequest.headers['idempotency-key']], ['GET', '/api/agent/v1/projects/project-1/creator-rules?locale=zh', undefined])
  assert.equal(rulesRequest.body.length, 0)
  assert.deepEqual([contractRequest.method, contractRequest.url], ['GET', '/api/agent/v1/contracts/waoo-agent-resolve-project.v1'])
  assert.equal(contractRequest.headers['idempotency-key'], undefined)
  assert.equal(contractRequest.body.length, 0)
  const expectedEpisodes = [{ episodeKey: 'episode-001', ordinal: 1, sourceHash: sha256Prefixed('正文'), name: '第一集' }]
  const expectedSourceHash = sha256Prefixed('第一集\n正文')
  const expectedOptions = { artStyle: 'realistic', videoRatio: '9:16', episodeSplitHint: 'auto' }
  const expectedFingerprint = sha256Prefixed({ projectId: 'project-1', sourceHash: expectedSourceHash, inputKindHint: 'auto', locale: 'zh', effectiveOptions: expectedOptions, ruleSetHash: rules.contentHash })
  const expectedCreateBody = { schemaVersion: 1, sourceHash: expectedSourceHash, runFingerprint: expectedFingerprint, inputKindHint: 'auto', locale: 'zh', effectiveOptions: expectedOptions, ruleSetVersion: rules.ruleSetVersion, ruleSetHash: rules.contentHash, definitionHash: sha256Prefixed(expectedEpisodes), episodes: expectedEpisodes }
  assert.deepEqual([createRequest.method, createRequest.url, createRequest.json], ['POST', '/api/agent/v1/projects/project-1/runs', expectedCreateBody])
  assert.equal(createRequest.headers['idempotency-key'], createRequest.json.runFingerprint)
  const getRequest = mock.requests[5]
  assert.deepEqual([getRequest.method, getRequest.url, getRequest.headers['idempotency-key'], getRequest.body.length], ['GET', '/api/agent/v1/runs/run-1', undefined, 0])

  const commitCases = [
    { indexes: [6, 7], path: '/api/agent/v1/runs/run-1/episodes/episode-001/story', data: storyArtifact },
    { indexes: [8, 9], path: '/api/agent/v1/runs/run-1/assets', data: assetsArtifact },
    { indexes: [10, 11], path: '/api/agent/v1/runs/run-1/episodes/episode-001/screenplay', data: screenplayArtifact },
    { indexes: [12, 13], path: '/api/agent/v1/runs/run-1/episodes/episode-001/storyboards', data: storyboardsArtifact },
  ]
  for (const { indexes, path: requestPath, data } of commitCases) {
    const artifactHash = sha256Prefixed(data)
    for (const [offset, index] of indexes.entries()) {
      const request = mock.requests[index]
      assert.deepEqual([request.method, request.url, request.headers['idempotency-key']], ['PUT', requestPath, artifactHash])
      assert.deepEqual(request.json, { schemaVersion: 1, ruleSetVersion: rules.ruleSetVersion, ruleSetHash: rules.contentHash, artifactHash, dryRun: offset === 0, data })
    }
  }
  const uploadRequest = mock.requests[14]
  assert.deepEqual([uploadRequest.method, uploadRequest.url], ['POST', '/api/agent/v1/runs/run-1/uploads'])
  const multipart = parseMultipartRequest(uploadRequest)
  assert.deepEqual(multipart.fields, { targetType: 'character-appearance', targetKey: 'hero.base', variantIndex: '0', contentSha256: sha256Prefixed(Buffer.from([137, 80, 78, 71])) })
  assert.deepEqual(multipart.file.bytes, Buffer.from([137, 80, 78, 71]))
  assert.equal(uploadRequest.headers['idempotency-key'], sha256Prefixed({ runId: 'run-1', targetType: 'character-appearance', targetKey: 'hero.base', variantIndex: 0, contentSha256: multipart.fields.contentSha256 }))
  const snapshotRequest = mock.requests[15]
  assert.deepEqual([snapshotRequest.method, snapshotRequest.url, snapshotRequest.headers['idempotency-key'], snapshotRequest.body.length], ['GET', '/api/agent/v1/runs/run-1/snapshot', undefined, 0])
  const finalCall = mock.requests[16]
  assert.deepEqual([finalCall.method, finalCall.url, finalCall.headers['idempotency-key']], ['POST', '/api/agent/v1/runs/run-1/finalize', sha256Prefixed(finalCall.json)])
  assert.deepEqual(finalCall.json, { schemaVersion: 1, ruleSetHash: rules.contentHash, expected: { assets: sha256Prefixed(assetsArtifact), stories: { 'episode-001': sha256Prefixed(storyArtifact) }, screenplays: { 'episode-001': sha256Prefixed(screenplayArtifact) }, storyboards: { 'episode-001': sha256Prefixed(storyboardsArtifact) } } })

  const finalReceipts = await readJson(path.join(runDir, 'receipts.json'))
  assert.deepEqual(finalReceipts.serverRun.data, { runId: 'run-1', projectId: 'project-1', status: 'created', currentStage: 'created', sourceHash: expectedSourceHash, runFingerprint: expectedFingerprint, ruleSetVersion: rules.ruleSetVersion, ruleSetHash: rules.contentHash, episodes: [{ episodeKey: 'episode-001', episodeId: 'ep-db-1', episodeNumber: 1, status: 'created' }] })
  assert.equal(finalReceipts.artifacts.stories['episode-001'].artifactHash, sha256Prefixed(storyArtifact))
  assert.equal(finalReceipts.artifacts.assets.artifactHash, sha256Prefixed(assetsArtifact))
  assert.equal(finalReceipts.artifacts.screenplays['episode-001'].artifactHash, sha256Prefixed(screenplayArtifact))
  assert.equal(finalReceipts.artifacts.storyboards['episode-001'].artifactHash, sha256Prefixed(storyboardsArtifact))
  assert.equal(Object.keys(finalReceipts.uploads).length, 1)
  assert.equal(finalReceipts.snapshot.data.runId, 'run-1')
  assert.deepEqual(finalReceipts.finalize.expected, finalCall.json.expected)
  assert.equal(finalReceipts.finalize.data.status, 'completed')
  assert.ok(!(await readdir(runDir, { recursive: true })).some((name) => String(name).includes('.tmp')))

  const beforeFindRequestCount = mock.requests.length
  const afterFinalize = await runCli(['find-local-run', ...common, '--project-id', 'project-1', '--source-file', sourceFile], { env })
  assert.equal(afterFinalize.status, 'not-found')
  assert.equal(mock.requests.length, beforeFindRequestCount)

  await runCli(['snapshot', ...common, '--run-id', 'run-1', '--run-dir', runDir], { env })
  const incompleteManifest = await readJson(path.join(runDir, 'manifest.json'))
  assert.equal(incompleteManifest.status, 'incomplete')
  assert.ok(incompleteManifest.clientState.serverStateAppliedSeq > finalReceipts.finalize.serverStateRequestSeq)
  const afterIncomplete = await runCli(['find-local-run', ...common, '--project-id', 'project-1', '--source-file', sourceFile], { env })
  assert.deepEqual(
    { status: afterIncomplete.status, runId: afterIncomplete.runId },
    { status: 'resume', runId: 'run-1' },
  )

  const legacyManifest = await readJson(path.join(runDir, 'manifest.json'))
  delete legacyManifest.clientState
  legacyManifest.status = 'completed'
  await atomicWriteJson(path.join(runDir, 'manifest.json'), legacyManifest)
  const legacyReceipts = await readJson(path.join(runDir, 'receipts.json'))
  for (const receipt of [legacyReceipts.serverRun, legacyReceipts.snapshot, legacyReceipts.finalize]) delete receipt.serverStateRequestSeq
  legacyReceipts.serverRun.receivedAt = '2026-07-26T09:00:00.000Z'
  legacyReceipts.finalize.finalizedAt = '2026-07-26T10:00:00.000Z'
  legacyReceipts.snapshot.receivedAt = '2026-07-26T11:00:00.000Z'
  await atomicWriteJson(path.join(runDir, 'receipts.json'), legacyReceipts)
  const legacyAfterIncomplete = await runCli(['find-local-run', ...common, '--project-id', 'project-1', '--source-file', sourceFile], { env })
  assert.equal(legacyAfterIncomplete.status, 'resume')
})

test('unsafe path identifiers and malicious contract URLs are rejected before credentialed requests', async (t) => {
  const root = await tempProject(t)
  const sourceHash = 'sha256:' + 'a'.repeat(64)
  const schema = { type: 'object' }
  const ruleCore = {
    schemaVersion: 1,
    ruleSetVersion: 'v1',
    locale: 'zh',
    projectSettings: { artStyle: 'ink', artStylePrompt: null, videoRatio: '16:9', imageResolution: '1k', forcedStoryboardDurationSec: null },
    rules: [],
    contracts: [{ id: 'contract.v1', url: 'https://example.com/steal', hash: sha256Prefixed(schema) }],
  }
  const mock = await startMockWaooServer(() => ({ body: { success: true, requestId: 'rules', data: { ...ruleCore, contentHash: sha256Prefixed(ruleCore) } } }))
  t.after(mock.close)
  await assert.rejects(runCli(['fetch-rules', '--project-root', root, '--project-id', '../escape', '--source-hash', sourceHash], { env: envFor(mock.baseUrl) }), /safe identifier/i)
  assert.equal(mock.requests.length, 0)
  await assert.rejects(runCli(['fetch-rules', '--project-root', root, '--project-id', 'project-1', '--source-hash', sourceHash], { env: envFor(mock.baseUrl) }), /contract URL|contract path|same-origin/i)
  assert.equal(mock.requests.length, 1)
})

test('upload, snapshot, and finalize reject a run-dir manifest mismatch before HTTP', async (t) => {
  const root = await tempProject(t)
  const runDir = path.join(root, '.waoo-agent/runs/run-other')
  const imageFile = path.join(runDir, 'image.png')
  await mkdir(runDir, { recursive: true })
  await writeFile(imageFile, Buffer.from([137, 80, 78, 71]))
  await atomicWriteJson(path.join(runDir, 'manifest.json'), { manifestVersion: 1, runId: 'run-other', projectId: 'project-1', ruleSetHash: 'sha256:' + 'a'.repeat(64) })
  await atomicWriteJson(path.join(runDir, 'receipts.json'), { receiptVersion: 1, runId: 'run-other', projectId: 'project-1', artifacts: {}, uploads: {} })
  const mock = await startMockWaooServer(() => ({ body: { success: true, requestId: 'unexpected', data: {} } }))
  t.after(mock.close)
  const common = ['--project-root', root, '--run-id', 'run-wanted', '--run-dir', runDir]
  await assert.rejects(runCli(['upload', ...common, '--file', imageFile, '--target-type', 'character-appearance', '--target-key', 'hero.base'], { env: envFor(mock.baseUrl) }), /run-id does not match/)
  await assert.rejects(runCli(['snapshot', ...common], { env: envFor(mock.baseUrl) }), /run-id does not match/)
  await assert.rejects(runCli(['finalize', ...common], { env: envFor(mock.baseUrl) }), /run-id does not match/)
  assert.equal(mock.requests.length, 0)
})

test('create-run rejects unsafe or cross-project response identifiers before filesystem promotion', async (t) => {
  const root = await tempProject(t)
  const sourceFile = path.join(root, 'source.md')
  const definitionFile = path.join(root, 'definition.json')
  const rulesFile = await writeRulesSnapshot(root, 'v1')
  await writeFile(sourceFile, '正文')
  await writeFile(definitionFile, JSON.stringify([{ episodeKey: 'episode-001', ordinal: 1, sourceText: '正文', name: '第一集' }]))
  let attempt = 0
  const mock = await startMockWaooServer((request) => {
    attempt += 1
    const common = { resumed: false, status: 'created', sourceHash: request.json.sourceHash, runFingerprint: request.json.runFingerprint, episodes: [{ episodeKey: 'episode-001', episodeId: 'ep-1', episodeNumber: 1, name: '第一集' }] }
    return { body: { success: true, requestId: 'bad', data: attempt === 1 ? { ...common, runId: 'run-safe', projectId: 'project-other' } : { ...common, runId: '../escape', projectId: 'project-1' } } }
  })
  t.after(mock.close)
  const args = ['create-run', '--project-root', root, '--project-id', 'project-1', '--source-file', sourceFile, '--definition-file', definitionFile, '--rules-file', rulesFile]
  await assert.rejects(runCli(args, { env: envFor(mock.baseUrl) }), /projectId mismatch/)
  await assert.rejects(runCli(args, { env: envFor(mock.baseUrl) }), /safe identifier/)
  assert.equal(await pathExistsForTest(path.join(root, '.waoo-agent/runs/run-safe')), false)
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

  const currentCore = { schemaVersion: 1, ruleSetVersion: 'v2', locale: 'zh', projectSettings: { artStyle: 'new-style', artStylePrompt: null, videoRatio: '9:16', imageResolution: '2k', forcedStoryboardDurationSec: null }, rules: [], contracts: [] }
  await atomicWriteJson(rulesFile, { ...currentCore, contentHash: sha256Prefixed(currentCore), contractsData: {} })
  const resumed = await runCli(['find-local-run', '--project-root', root, '--project-id', 'project-1', '--source-file', sourceFile], { env })
  assert.equal(resumed.status, 'resume')
  assert.equal(resumed.runId, 'run-recovered')
})

test('resumed create-run repairs only missing create response and episode map', async (t) => {
  const root = await tempProject(t)
  const sourceFile = path.join(root, 'source.md')
  const definitionFile = path.join(root, 'definition.json')
  const rulesFile = path.join(root, 'rules.json')
  await writeFile(sourceFile, '正文')
  await writeFile(definitionFile, JSON.stringify([{ episodeKey: 'episode-001', ordinal: 1, sourceText: '正文', name: '第一集' }]))
  const core = { schemaVersion: 1, ruleSetVersion: 'v1', locale: 'zh', projectSettings: { artStyle: 'ink', artStylePrompt: null, videoRatio: '16:9', imageResolution: '1k', forcedStoryboardDurationSec: null }, rules: [], contracts: [] }
  await atomicWriteJson(rulesFile, { ...core, contentHash: sha256Prefixed(core), contractsData: {} })
  let createCount = 0
  const mock = await startMockWaooServer((request) => {
    createCount += 1
    return { body: { success: true, requestId: `created-${createCount}`, data: { runId: 'run-repair', resumed: createCount > 1, status: 'created', projectId: 'project-1', sourceHash: request.json.sourceHash, runFingerprint: request.json.runFingerprint, episodes: [{ episodeKey: 'episode-001', episodeId: 'ep-1', episodeNumber: 1, name: '第一集' }] } } }
  })
  t.after(mock.close)
  const args = ['create-run', '--project-root', root, '--project-id', 'project-1', '--source-file', sourceFile, '--definition-file', definitionFile, '--rules-file', rulesFile]
  const created = await runCli(args, { env: envFor(mock.baseUrl) })
  const runDir = created.runDir
  const manifest = await readJson(path.join(runDir, 'manifest.json'))
  delete manifest.episodeMap
  manifest.stages = { story: { completed: true } }
  manifest.images = { kept: { contentSha256: 'sha256:' + 'd'.repeat(64) } }
  await atomicWriteJson(path.join(runDir, 'manifest.json'), manifest)
  const preservedReceipts = { receiptVersion: 1, runId: 'run-repair', projectId: 'project-1', artifacts: { stories: { 'episode-001': { artifactHash: 'sha256:' + 'e'.repeat(64), marker: 'keep-receipt' } } }, uploads: { kept: { marker: 'keep-upload' } } }
  await atomicWriteJson(path.join(runDir, 'receipts.json'), preservedReceipts)
  const preservedArtifacts = {
    'story.json': '{"story":"keep"}\n',
    'assets.json': '{"assets":"keep"}\n',
    'screenplay.json': '{"screenplay":"keep"}\n',
    'storyboards.json': '{"storyboards":"keep"}\n',
  }
  for (const [name, content] of Object.entries(preservedArtifacts)) await writeFile(path.join(runDir, name), content)
  const preservedImage = path.join(runDir, 'images/assets/hero/variant-0.png')
  await mkdir(path.dirname(preservedImage), { recursive: true })
  await writeFile(preservedImage, Buffer.from([1, 2, 3, 4]))
  await rm(path.join(runDir, 'create-run-response.json'))
  const resumed = await runCli(args, { env: envFor(mock.baseUrl) })
  assert.equal(resumed.resumed, true)
  const repaired = await readJson(path.join(runDir, 'manifest.json'))
  assert.deepEqual(repaired.episodeMap, { 'episode-001': { episodeId: 'ep-1', episodeNumber: 1 } })
  assert.deepEqual(repaired.stages, manifest.stages)
  assert.deepEqual(repaired.images, manifest.images)
  assert.deepEqual(await readJson(path.join(runDir, 'receipts.json')), preservedReceipts)
  for (const [name, content] of Object.entries(preservedArtifacts)) assert.equal(await readFile(path.join(runDir, name), 'utf8'), content)
  assert.deepEqual(await readFile(preservedImage), Buffer.from([1, 2, 3, 4]))
  assert.equal(await pathExistsForTest(path.join(runDir, 'create-run-response.json')), true)
})

test('find-local-run reports ambiguous formal and pending candidates instead of guessing', async (t) => {
  const formalRoot = await tempProject(t)
  const formalSource = path.join(formalRoot, 'source.md')
  const formalDefinition = path.join(formalRoot, 'definition.json')
  await writeFile(formalSource, '正文')
  await writeFile(formalDefinition, JSON.stringify([{ episodeKey: 'episode-001', ordinal: 1, sourceText: '正文', name: '第一集' }]))
  const formalRules1 = await writeRulesSnapshot(formalRoot, 'v1')
  const formalRules2 = await writeRulesSnapshot(formalRoot, 'v2')
  const formalMock = await startMockWaooServer((request) => ({ body: { success: true, requestId: 'created', data: { runId: `run-${request.json.ruleSetVersion}`, resumed: false, status: 'created', projectId: 'project-1', sourceHash: request.json.sourceHash, runFingerprint: request.json.runFingerprint, episodes: [{ episodeKey: 'episode-001', episodeId: `ep-${request.json.ruleSetVersion}`, episodeNumber: request.json.ruleSetVersion === 'v1' ? 1 : 2, name: '第一集' }] } } }))
  t.after(formalMock.close)
  const formalCommon = ['create-run', '--project-root', formalRoot, '--project-id', 'project-1', '--source-file', formalSource, '--definition-file', formalDefinition]
  await runCli([...formalCommon, '--rules-file', formalRules1], { env: envFor(formalMock.baseUrl) })
  await runCli([...formalCommon, '--rules-file', formalRules2], { env: envFor(formalMock.baseUrl) })
  const formalResult = await runCli(['find-local-run', '--project-root', formalRoot, '--project-id', 'project-1', '--source-file', formalSource], { env: envFor(formalMock.baseUrl) })
  assert.equal(formalResult.status, 'ambiguous')
  assert.deepEqual(formalResult.candidates.map((candidate) => candidate.runId).sort(), ['run-v1', 'run-v2'])

  const pendingRoot = await tempProject(t)
  const pendingSource = path.join(pendingRoot, 'source.md')
  const pendingDefinition = path.join(pendingRoot, 'definition.json')
  await writeFile(pendingSource, '正文')
  await writeFile(pendingDefinition, JSON.stringify([{ episodeKey: 'episode-001', ordinal: 1, sourceText: '正文', name: '第一集' }]))
  const pendingRules1 = await writeRulesSnapshot(pendingRoot, 'v1')
  const pendingRules2 = await writeRulesSnapshot(pendingRoot, 'v2')
  const pendingMock = await startMockWaooServer(() => ({ status: 409, body: { success: false, requestId: 'mismatch', error: { code: 'AGENT_RULE_MISMATCH', message: 'changed', retryable: false } } }))
  t.after(pendingMock.close)
  const pendingCommon = ['create-run', '--project-root', pendingRoot, '--project-id', 'project-1', '--source-file', pendingSource, '--definition-file', pendingDefinition]
  await assert.rejects(runCli([...pendingCommon, '--rules-file', pendingRules1], { env: envFor(pendingMock.baseUrl) }))
  await assert.rejects(runCli([...pendingCommon, '--rules-file', pendingRules2], { env: envFor(pendingMock.baseUrl) }))
  const pendingResult = await runCli(['find-local-run', '--project-root', pendingRoot, '--project-id', 'project-1', '--source-file', pendingSource], { env: envFor(pendingMock.baseUrl) })
  assert.equal(pendingResult.status, 'ambiguous')
  assert.equal(pendingResult.candidates.length, 2)
  assert.ok(pendingResult.candidates.every((candidate) => candidate.status === 'pending-create'))

  const mixedRoot = await tempProject(t)
  const mixedSource = path.join(mixedRoot, 'source.md')
  const mixedDefinition = path.join(mixedRoot, 'definition.json')
  await writeFile(mixedSource, '正文')
  await writeFile(mixedDefinition, JSON.stringify([{ episodeKey: 'episode-001', ordinal: 1, sourceText: '正文', name: '第一集' }]))
  const mixedRules1 = await writeRulesSnapshot(mixedRoot, 'v1')
  const mixedRules2 = await writeRulesSnapshot(mixedRoot, 'v2')
  const mixedMock = await startMockWaooServer((request) => request.json.ruleSetVersion === 'v1'
    ? { body: { success: true, requestId: 'created', data: { runId: 'run-formal', resumed: false, status: 'created', projectId: 'project-1', sourceHash: request.json.sourceHash, runFingerprint: request.json.runFingerprint, episodes: [{ episodeKey: 'episode-001', episodeId: 'ep-1', episodeNumber: 1, name: '第一集' }] } } }
    : { status: 409, body: { success: false, requestId: 'pending', error: { code: 'AGENT_RULE_MISMATCH', message: 'pending', retryable: false } } })
  t.after(mixedMock.close)
  const mixedCommon = ['create-run', '--project-root', mixedRoot, '--project-id', 'project-1', '--source-file', mixedSource, '--definition-file', mixedDefinition]
  await runCli([...mixedCommon, '--rules-file', mixedRules1], { env: envFor(mixedMock.baseUrl) })
  await assert.rejects(runCli([...mixedCommon, '--rules-file', mixedRules2], { env: envFor(mixedMock.baseUrl) }))
  const mixedResult = await runCli(['find-local-run', '--project-root', mixedRoot, '--project-id', 'project-1', '--source-file', mixedSource], { env: envFor(mixedMock.baseUrl) })
  assert.equal(mixedResult.status, 'ambiguous')
  assert.deepEqual(mixedResult.candidates.map((candidate) => candidate.status).sort(), ['pending-create', 'resume'])
})

test('find-local-run detects pinned formal rules and pending fingerprint tampering', async (t) => {
  const formalRoot = await tempProject(t)
  const sourceFile = path.join(formalRoot, 'source.md')
  const definitionFile = path.join(formalRoot, 'definition.json')
  const rulesFile = await writeRulesSnapshot(formalRoot, 'v1')
  await writeFile(sourceFile, '正文')
  await writeFile(definitionFile, JSON.stringify([{ episodeKey: 'episode-001', ordinal: 1, sourceText: '正文', name: '第一集' }]))
  const mock = await startMockWaooServer((request) => ({ body: { success: true, requestId: 'created', data: { runId: 'run-1', resumed: false, status: 'created', projectId: 'project-1', sourceHash: request.json.sourceHash, runFingerprint: request.json.runFingerprint, episodes: [{ episodeKey: 'episode-001', episodeId: 'ep-1', episodeNumber: 1, name: '第一集' }] } } }))
  t.after(mock.close)
  const created = await runCli(['create-run', '--project-root', formalRoot, '--project-id', 'project-1', '--source-file', sourceFile, '--definition-file', definitionFile, '--rules-file', rulesFile], { env: envFor(mock.baseUrl) })
  const formalDefinitionPath = path.join(created.runDir, 'definition.json')
  const originalDefinitions = await readJson(formalDefinitionPath)
  await atomicWriteJson(formalDefinitionPath, [{ ...originalDefinitions[0], sourceText: '篡改正文' }])
  await assert.rejects(runCli(['find-local-run', '--project-root', formalRoot, '--project-id', 'project-1', '--source-file', sourceFile]), /episode sourceHash|source hash mismatch/i)
  await atomicWriteJson(formalDefinitionPath, originalDefinitions)
  const originalManifest = await readJson(path.join(created.runDir, 'manifest.json'))
  await atomicWriteJson(path.join(created.runDir, 'manifest.json'), { ...originalManifest, runFingerprint: 'sha256:' + 'e'.repeat(64) })
  await assert.rejects(runCli(['find-local-run', '--project-root', formalRoot, '--project-id', 'project-1', '--source-file', sourceFile]), /fingerprint mismatch/)
  await atomicWriteJson(path.join(created.runDir, 'manifest.json'), originalManifest)
  const pinnedRules = await readJson(path.join(created.runDir, 'rules.json'))
  pinnedRules.rules[0].content = 'tampered'
  await atomicWriteJson(path.join(created.runDir, 'rules.json'), pinnedRules)
  await assert.rejects(runCli(['find-local-run', '--project-root', formalRoot, '--project-id', 'project-1', '--source-file', sourceFile]), /rule content hash mismatch/)

  const pendingRoot = await tempProject(t)
  const pendingSource = path.join(pendingRoot, 'source.md')
  const pendingDefinition = path.join(pendingRoot, 'definition.json')
  const pendingRules = await writeRulesSnapshot(pendingRoot, 'v1')
  await writeFile(pendingSource, '正文')
  await writeFile(pendingDefinition, JSON.stringify([{ episodeKey: 'episode-001', ordinal: 1, sourceText: '正文', name: '第一集' }]))
  const pendingMock = await startMockWaooServer(() => ({ status: 409, body: { success: false, requestId: 'mismatch', error: { code: 'AGENT_RULE_MISMATCH', message: 'changed', retryable: false } } }))
  t.after(pendingMock.close)
  await assert.rejects(runCli(['create-run', '--project-root', pendingRoot, '--project-id', 'project-1', '--source-file', pendingSource, '--definition-file', pendingDefinition, '--rules-file', pendingRules], { env: envFor(pendingMock.baseUrl) }))
  const [fingerprint] = await readdir(path.join(pendingRoot, '.waoo-agent/intake'))
  const pendingDefinitionPath = path.join(pendingRoot, '.waoo-agent/intake', fingerprint, 'definition.json')
  const originalPendingDefinitions = await readJson(pendingDefinitionPath)
  await atomicWriteJson(pendingDefinitionPath, [{ ...originalPendingDefinitions[0], sourceText: '篡改正文' }])
  await assert.rejects(runCli(['find-local-run', '--project-root', pendingRoot, '--project-id', 'project-1', '--source-file', pendingSource]), /episode sourceHash|source hash mismatch/i)
  await atomicWriteJson(pendingDefinitionPath, originalPendingDefinitions)
  const requestPath = path.join(pendingRoot, '.waoo-agent/intake', fingerprint, 'run-request.json')
  const request = await readJson(requestPath)
  request.runFingerprint = 'sha256:' + 'f'.repeat(64)
  await atomicWriteJson(requestPath, request)
  await assert.rejects(runCli(['find-local-run', '--project-root', pendingRoot, '--project-id', 'project-1', '--source-file', pendingSource]), /fingerprint mismatch/)
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
  await atomicWriteJson(path.join(runDir, 'manifest.json'), { manifestVersion: 1, runId: 'run-1', projectId: 'project-1' })
  await atomicWriteJson(path.join(runDir, 'receipts.json'), { receiptVersion: 1, runId: 'run-1', projectId: 'project-1', artifacts: {}, uploads: {} })
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

test('upload rejects non-regular and oversized files before HTTP', async (t) => {
  const root = await tempProject(t)
  const runDir = path.join(root, '.waoo-agent/runs/run-1')
  await mkdir(runDir, { recursive: true })
  await atomicWriteJson(path.join(runDir, 'manifest.json'), { manifestVersion: 1, runId: 'run-1', projectId: 'project-1' })
  await atomicWriteJson(path.join(runDir, 'receipts.json'), { receiptVersion: 1, runId: 'run-1', projectId: 'project-1', artifacts: {}, uploads: {} })
  const oversized = path.join(runDir, 'oversized.png')
  await writeFile(oversized, Buffer.alloc(5, 1))
  const mock = await startMockWaooServer(() => ({ body: { success: true, requestId: 'unexpected', data: {} } }))
  t.after(mock.close)
  const common = ['upload', '--project-root', root, '--run-id', 'run-1', '--run-dir', runDir, '--target-type', 'character-appearance', '--target-key', 'hero.base']
  await assert.rejects(runCli([...common, '--file', oversized], { env: { ...envFor(mock.baseUrl), WAOO_AGENT_UPLOAD_MAX_BYTES: '4' } }), /maximum|too large|bytes/i)
  await assert.rejects(runCli([...common, '--file', runDir], { env: envFor(mock.baseUrl) }), /regular file/i)
  assert.equal(mock.requests.length, 0)
})

test('concurrent receipt updates keep every key and file locks recover stale locks but time out live locks', async (t) => {
  const root = await tempProject(t)
  const runDir = path.join(root, '.waoo-agent/runs/run-1')
  await mkdir(runDir, { recursive: true })
  const ruleSetHash = 'sha256:' + 'a'.repeat(64)
  await atomicWriteJson(path.join(runDir, 'manifest.json'), { manifestVersion: 1, runId: 'run-1', projectId: 'project-1', ruleSetVersion: 'v1', ruleSetHash, status: 'created', currentStage: 'created' })
  await atomicWriteJson(path.join(runDir, 'receipts.json'), { receiptVersion: 1, runId: 'run-1', projectId: 'project-1', artifacts: {}, uploads: {} })
  const storyFile = path.join(runDir, 'story.json')
  const assetsFile = path.join(runDir, 'assets.json')
  const imageFile = path.join(runDir, 'image.png')
  const story = { episodeKey: 'episode-001', value: 'story' }
  const assets = { characters: [], locations: [], props: [] }
  await atomicWriteJson(storyFile, { 'episode-001': story })
  await atomicWriteJson(assetsFile, assets)
  await writeFile(imageFile, Buffer.from([137, 80, 78, 71, 9]))
  const mock = await startMockWaooServer(async (request) => {
    await new Promise((resolve) => setTimeout(resolve, 10))
    const success = (data) => ({ body: { success: true, requestId: `req-${request.url}`, data } })
    if (request.url.endsWith('/story')) return success({ dryRun: false, episodeKey: 'episode-001', episodeId: 'ep-1', episodeNumber: 1, artifactHash: request.json.artifactHash })
    if (request.url.endsWith('/assets')) return success({ dryRun: false, artifactHash: request.json.artifactHash })
    if (request.url.endsWith('/uploads')) {
      const multipart = parseMultipartRequest(request)
      return success({ runId: 'run-1', targetType: multipart.fields.targetType, targetKey: multipart.fields.targetKey, variantIndex: Number(multipart.fields.variantIndex), contentSha256: multipart.fields.contentSha256, mediaId: `media-${multipart.fields.targetKey}`, storageKey: `x/${multipart.fields.targetKey}`, url: `/x/${multipart.fields.targetKey}.png`, reused: false })
    }
    if (request.url.endsWith('/snapshot')) return success({ runId: 'run-1', status: 'images_in_progress', committedArtifactHashes: { stories: {}, screenplays: {}, storyboards: {} }, uploads: [], missing: [] })
    return success({})
  })
  t.after(mock.close)
  const env = envFor(mock.baseUrl)
  const common = ['--project-root', root, '--run-id', 'run-1', '--run-dir', runDir]
  await Promise.all([
    runCli(['commit-story', ...common, '--artifact-file', storyFile, '--episode-key', 'episode-001', '--commit'], { env }),
    runCli(['commit-assets', ...common, '--artifact-file', assetsFile, '--commit'], { env }),
    runCli(['upload', ...common, '--file', imageFile, '--target-type', 'character-appearance', '--target-key', 'hero.base'], { env }),
    runCli(['upload', ...common, '--file', imageFile, '--target-type', 'character-appearance', '--target-key', 'villain.base'], { env }),
    runCli(['snapshot', ...common], { env }),
  ])
  const concurrentReceipts = await readJson(path.join(runDir, 'receipts.json'))
  assert.equal(concurrentReceipts.artifacts.stories['episode-001'].artifactHash, sha256Prefixed(story))
  assert.equal(concurrentReceipts.artifacts.assets.artifactHash, sha256Prefixed(assets))
  assert.equal(Object.keys(concurrentReceipts.uploads).length, 2)
  assert.equal(concurrentReceipts.snapshot.data.status, 'images_in_progress')

  const lockPath = path.join(runDir, 'receipts.json.lock')
  await writeFile(lockPath, '{"token":"stale"}')
  const staleTime = new Date(Date.now() - 120_000)
  await utimes(lockPath, staleTime, staleTime)
  await runCli(['snapshot', ...common], { env })
  assert.equal(await pathExistsForTest(lockPath), false)

  await writeFile(lockPath, '{"token":"live"}')
  await assert.rejects(runCli(['snapshot', ...common], { env }), /lock.*timeout/i)
  await rm(lockPath, { force: true })
})

test('late run reads cannot roll a completed or higher-stage manifest backward', async (t) => {
  const root = await tempProject(t)
  const sourceHash = 'sha256:' + 'b'.repeat(64)
  const runFingerprint = 'sha256:' + 'c'.repeat(64)
  const ruleSetHash = 'sha256:' + 'd'.repeat(64)
  const assetHash = 'sha256:' + 'e'.repeat(64)
  const createdRun = (runId) => ({
    runId,
    projectId: 'project-1',
    status: 'created',
    currentStage: 'created',
    sourceHash,
    runFingerprint,
    ruleSetVersion: 'v1',
    ruleSetHash,
    episodes: [],
  })
  const writeRun = async (runId) => {
    const runDir = path.join(root, `.waoo-agent/runs/${runId}`)
    await mkdir(runDir, { recursive: true })
    await atomicWriteJson(path.join(runDir, 'manifest.json'), {
      manifestVersion: 1,
      ...createdRun(runId),
    })
    await atomicWriteJson(path.join(runDir, 'receipts.json'), {
      receiptVersion: 1,
      runId,
      projectId: 'project-1',
      artifacts: { assets: { artifactHash: assetHash }, stories: {}, screenplays: {}, storyboards: {} },
      uploads: {},
    })
    return runDir
  }

  const runOneReadStarted = deferred()
  const releaseRunOneRead = deferred()
  const runTwoReadStarted = deferred()
  const releaseRunTwoRead = deferred()
  let runTwoReads = 0
  const completedAt = '2026-07-26T10:00:00.000Z'
  const mock = await startMockWaooServer(async (request) => {
    const success = (data, requestId) => ({ body: { success: true, requestId, data } })
    if (request.url === '/api/agent/v1/runs/run-1' && request.method === 'GET') {
      runOneReadStarted.resolve()
      await releaseRunOneRead.promise
      return success(createdRun('run-1'), 'stale-created')
    }
    if (request.url === '/api/agent/v1/runs/run-1/finalize') {
      return success({ runId: 'run-1', status: 'completed', completedAt, counts: {} }, 'finalized')
    }
    if (request.url === '/api/agent/v1/runs/run-1/snapshot') {
      return success({ runId: 'run-1', status: 'incomplete', committedArtifactHashes: { stories: {}, screenplays: {}, storyboards: {} }, uploads: [], missing: [{ code: 'FRAME_IMAGE_MISSING', targetType: 'panel-frame', targetKey: 'frame-1', message: 'missing' }] }, 'later-incomplete')
    }
    if (request.url === '/api/agent/v1/runs/run-2' && request.method === 'GET') {
      runTwoReads += 1
      if (runTwoReads === 1) {
        runTwoReadStarted.resolve()
        await releaseRunTwoRead.promise
        return success(createdRun('run-2'), 'older-created')
      }
      return success({ ...createdRun('run-2'), status: 'storyboards_committed', currentStage: 'storyboards_committed' }, 'newer-storyboards')
    }
    throw new Error(`unexpected request: ${request.method} ${request.url}`)
  })
  t.after(mock.close)
  const env = envFor(mock.baseUrl)

  const runOneDir = await writeRun('run-1')
  const runOneCommon = ['--project-root', root, '--run-id', 'run-1', '--run-dir', runOneDir]
  const staleRunOneRead = runCli(['get-run', ...runOneCommon], { env })
  await runOneReadStarted.promise
  await runCli(['finalize', ...runOneCommon], { env })
  releaseRunOneRead.resolve()
  await staleRunOneRead
  const completedManifest = await readJson(path.join(runOneDir, 'manifest.json'))
  assert.deepEqual(
    { status: completedManifest.status, currentStage: completedManifest.currentStage, completedAt: completedManifest.completedAt },
    { status: 'completed', currentStage: 'completed', completedAt },
  )
  const completedReceipts = await readJson(path.join(runOneDir, 'receipts.json'))
  assert.equal(completedReceipts.finalize.data.status, 'completed')
  assert.equal(completedReceipts.serverRun.data.status, 'created')
  assert.equal(completedReceipts.artifacts.assets.artifactHash, assetHash)

  await runCli(['snapshot', ...runOneCommon], { env })
  const laterIncompleteManifest = await readJson(path.join(runOneDir, 'manifest.json'))
  assert.deepEqual(
    {
      status: laterIncompleteManifest.status,
      currentStage: laterIncompleteManifest.currentStage,
      completedAt: laterIncompleteManifest.completedAt,
      requestSeq: laterIncompleteManifest.clientState.serverStateRequestSeq,
      appliedSeq: laterIncompleteManifest.clientState.serverStateAppliedSeq,
    },
    { status: 'incomplete', currentStage: 'completed', completedAt, requestSeq: 3, appliedSeq: 3 },
  )

  const runTwoDir = await writeRun('run-2')
  const runTwoCommon = ['--project-root', root, '--run-id', 'run-2', '--run-dir', runTwoDir]
  const staleRunTwoRead = runCli(['get-run', ...runTwoCommon], { env })
  await runTwoReadStarted.promise
  await runCli(['get-run', ...runTwoCommon], { env })
  releaseRunTwoRead.resolve()
  await staleRunTwoRead
  const higherManifest = await readJson(path.join(runTwoDir, 'manifest.json'))
  assert.deepEqual(
    { status: higherManifest.status, currentStage: higherManifest.currentStage },
    { status: 'storyboards_committed', currentStage: 'storyboards_committed' },
  )
})

test('retry policy covers network, 5xx and retryable failures but not ordinary 4xx', async (t) => {
  const counts = new Map()
  const mock = await startMockWaooServer((request) => {
    const count = (counts.get(request.url) ?? 0) + 1
    counts.set(request.url, count)
    if (request.url === '/api/agent/v1/network' && count === 1) return { destroy: true }
    if (request.url === '/api/agent/v1/five' && count === 1) return { status: 500, body: { success: false, requestId: 'r', error: { code: 'SERVER', message: 'server', retryable: false } } }
    if (request.url === '/api/agent/v1/retryable' && count === 1) return { status: 409, body: { success: false, requestId: 'r', error: { code: 'LOCKED', message: 'locked', retryable: true } } }
    if (request.url === '/api/agent/v1/ordinary') return { status: 409, body: { success: false, requestId: 'r', error: { code: 'CONFLICT', message: 'conflict', retryable: false } } }
    return { body: { success: true, requestId: 'ok', data: { ok: true } } }
  })
  t.after(mock.close)
  const config = resolveConfig(envFor(mock.baseUrl), { retries: 1, retryDelayMs: 1 })
  for (const target of ['/api/agent/v1/network', '/api/agent/v1/five', '/api/agent/v1/retryable']) assert.deepEqual(await requestJson(config, target), { ok: true })
  await assert.rejects(requestJson(config, '/api/agent/v1/ordinary'), (error) => error.code === 'CONFLICT')
  assert.equal(counts.get('/api/agent/v1/network'), 2)
  assert.equal(counts.get('/api/agent/v1/five'), 2)
  assert.equal(counts.get('/api/agent/v1/retryable'), 2)
  assert.equal(counts.get('/api/agent/v1/ordinary'), 1)
})
