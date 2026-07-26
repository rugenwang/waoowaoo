import assert from 'node:assert/strict'
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

import { atomicWriteJson, readJson, runCli, sha256Prefixed } from '../scripts/waoo-client.mjs'
import { parseMultipartRequest, startMockWaooServer } from './mock-waoo-server.mjs'

const TINY_PNG = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])

const envFor = (baseUrl) => ({
  WAOO_BASE_URL: baseUrl,
  WAOO_AGENT_TOKEN: 'e2e-token-not-a-real-secret',
  WAOO_AGENT_USER_ID: 'e2e-user',
})

function rules(version) {
  const schema = { $schema: 'https://json-schema.org/draft/2020-12/schema', type: 'object' }
  const contract = {
    id: 'waoo-agent-resolve-project.v1',
    url: '/api/agent/v1/contracts/waoo-agent-resolve-project.v1',
    hash: sha256Prefixed(schema),
  }
  const core = {
    schemaVersion: 1,
    ruleSetVersion: version,
    locale: 'zh',
    projectSettings: {
      artStyle: version === 'v1' ? 'ink' : 'color',
      artStylePrompt: null,
      videoRatio: '16:9',
      imageResolution: '1k',
      forcedStoryboardDurationSec: null,
    },
    rules: [{ id: 'creative-boundary', kind: 'hard', content: `rules-${version}`, hash: sha256Prefixed(`rules-${version}`) }],
    contracts: [contract],
  }
  return { ...core, contentHash: sha256Prefixed(core), schema }
}

function response(data, requestId) {
  return { body: { success: true, requestId, data } }
}

test('full creator flow is resumable, pinned, upload-only, and never reaches generation routes', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'waoo-creator-e2e-'))
  await writeFile(path.join(root, 'package.json'), '{"name":"waoowaoo"}\n')
  t.after(() => rm(root, { recursive: true, force: true }))

  const sourceFile = path.join(root, 'source.md')
  const definitionFile = path.join(root, 'definition.json')
  const artifacts = {
    story: { 'episode-001': { episodeKey: 'episode-001', title: '雨夜来客', content: '故事正文' } },
    assets: { characters: [], locations: [], props: [] },
    screenplay: { 'episode-001': { episodeKey: 'episode-001', clips: [] } },
    storyboards: { 'episode-001': { episodeKey: 'episode-001', storyboards: [] } },
  }
  await writeFile(sourceFile, '第一集\n雨夜来客\n')
  await atomicWriteJson(definitionFile, [{ episodeKey: 'episode-001', ordinal: 1, sourceText: '雨夜来客', name: '第一集' }])
  const artifactFiles = {}
  for (const [name, value] of Object.entries(artifacts)) {
    artifactFiles[name] = path.join(root, `${name}.json`)
    await atomicWriteJson(artifactFiles[name], value)
  }

  const state = {
    currentRules: rules('v1'),
    runsByFingerprint: new Map(),
    createCalls: 0,
    uploadAttempts: new Map(),
    uploadTargets: new Set(),
    committed: { stories: new Set(), assets: new Set(), screenplays: new Set(), storyboards: new Set() },
  }
  const allowedUploadTargets = new Set([
    'character-appearance:hero.base:0',
    'location-image:street.day:0',
    'prop-image:sword.main:0',
    'panel-frame:frame-001:0',
  ])
  const mock = await startMockWaooServer((request) => {
    const activeRules = state.currentRules
    if (request.url === '/api/agent/v1/contracts/waoo-agent-resolve-project.v1') {
      return response({ id: 'waoo-agent-resolve-project.v1', hash: activeRules.contracts[0].hash, jsonSchema: activeRules.schema }, 'doctor-contract')
    }
    if (request.url === '/api/agent/v1/projects/resolve') return response({ projectId: 'project-1', created: state.runsByFingerprint.size === 0 }, 'project')
    if (request.url === '/api/agent/v1/projects/project-1/creator-rules?locale=zh') {
      const { schema, ...snapshot } = activeRules
      return response(snapshot, `rules-${snapshot.ruleSetVersion}`)
    }
    if (request.url === '/api/agent/v1/projects/project-1/runs' && request.method === 'POST') {
      state.createCalls += 1
      const body = request.json
      let run = state.runsByFingerprint.get(body.runFingerprint)
      if (!run) {
        run = {
          runId: `run-${state.runsByFingerprint.size + 1}`,
          projectId: 'project-1',
          status: 'created', currentStage: 'created',
          sourceHash: body.sourceHash, runFingerprint: body.runFingerprint,
          ruleSetVersion: body.ruleSetVersion, ruleSetHash: body.ruleSetHash,
          episodes: body.episodes.map((episode) => ({ episodeKey: episode.episodeKey, episodeId: `db-${episode.episodeKey}`, episodeNumber: episode.ordinal, name: episode.name, status: 'created' })),
        }
        state.runsByFingerprint.set(body.runFingerprint, run)
      }
      // The first response is lost after the server has durably created the run.
      if (state.createCalls === 1) return { destroy: true }
      return response(run, `create-${run.runId}`)
    }
    const runMatch = /^\/api\/agent\/v1\/runs\/([^/]+)$/.exec(request.url)
    if (runMatch && request.method === 'GET') {
      const run = [...state.runsByFingerprint.values()].find((candidate) => candidate.runId === runMatch[1])
      if (!run) throw new Error('unknown run')
      return response(run, `get-${run.runId}`)
    }
    const commitMatch = /^\/api\/agent\/v1\/runs\/run-1(?:\/episodes\/episode-001\/(story|screenplay|storyboards)|\/(assets))$/.exec(request.url)
    if (commitMatch && request.method === 'PUT') {
      const collection = ({ story: 'stories', screenplay: 'screenplays', storyboards: 'storyboards' })[commitMatch[1]] ?? 'assets'
      if (!request.json.dryRun) state.committed[collection].add(request.json.artifactHash)
      return response({ dryRun: request.json.dryRun, episodeKey: commitMatch[1] ? 'episode-001' : undefined, artifactHash: request.json.artifactHash }, `commit-${collection}`)
    }
    if (request.url === '/api/agent/v1/runs/run-1/uploads' && request.method === 'POST') {
      const multipart = parseMultipartRequest(request)
      const target = `${multipart.fields.targetType}:${multipart.fields.targetKey}:${multipart.fields.variantIndex}`
      assert.ok(allowedUploadTargets.has(target), `upload must be a run-owned candidate/slot: ${target}`)
      assert.equal(multipart.file.bytes.equals(TINY_PNG), true)
      const attempts = (state.uploadAttempts.get(target) ?? 0) + 1
      state.uploadAttempts.set(target, attempts)
      // A transient failure validates retry and an identical idempotency key, without a duplicate receipt.
      if (target === 'character-appearance:hero.base:0' && attempts === 1) return { destroy: true }
      state.uploadTargets.add(target)
      return response({
        runId: 'run-1', targetType: multipart.fields.targetType, targetKey: multipart.fields.targetKey,
        variantIndex: Number(multipart.fields.variantIndex), contentSha256: multipart.fields.contentSha256,
        mediaId: `media-${multipart.fields.targetKey}`, storageKey: `run-1/${multipart.fields.targetKey}`,
        url: `/media/${multipart.fields.targetKey}.png`, reused: false,
      }, `upload-${target}`)
    }
    if (request.url === '/api/agent/v1/runs/run-1/snapshot' && request.method === 'GET') {
      const missing = [...allowedUploadTargets].filter((target) => !state.uploadTargets.has(target))
      return response({
        runId: 'run-1', status: missing.length ? 'images_in_progress' : 'ready_to_finalize',
        committedArtifactHashes: { stories: {}, screenplays: {}, storyboards: {} }, uploads: [],
        missing: missing.map((target) => ({ code: 'IMAGE_MISSING', targetType: target.split(':')[0], targetKey: target.split(':')[1], message: 'required image missing' })),
      }, 'snapshot')
    }
    if (request.url === '/api/agent/v1/runs/run-1/finalize' && request.method === 'POST') {
      if (state.uploadTargets.size !== allowedUploadTargets.size) return response({ runId: 'run-1', status: 'images_in_progress', missing: ['images'] }, 'finalize-missing')
      return response({ runId: 'run-1', status: 'completed', completedAt: '2026-07-26T00:00:00.000Z', counts: { uploadedImages: 4 } }, 'finalize-complete')
    }
    throw new Error(`unexpected endpoint: ${request.method} ${request.url}`)
  })
  t.after(mock.close)
  const env = envFor(mock.baseUrl)
  const common = ['--project-root', root]

  await runCli(['doctor', ...common], { env, configOverrides: { retries: 0 } })
  const project = await runCli(['resolve-project', ...common, '--name', 'E2E Creator Project'], { env, configOverrides: { retries: 0 } })
  assert.equal(project.projectId, 'project-1')
  const firstRules = await runCli(['fetch-rules', ...common, '--project-id', 'project-1', '--source-hash', sha256Prefixed('第一集\n雨夜来客'), '--locale', 'zh'], { env, configOverrides: { retries: 0 } })

  const createArgs = ['create-run', ...common, '--project-id', 'project-1', '--source-file', sourceFile, '--definition-file', definitionFile, '--rules-file', firstRules.rulesPath]
  await assert.rejects(runCli(createArgs, { env, configOverrides: { retries: 0 } }), /network|fetch|socket|terminated|request/i)
  const pending = await runCli(['find-local-run', ...common, '--project-id', 'project-1', '--source-file', sourceFile], { env })
  assert.equal(pending.status, 'pending-create')
  for (const name of ['source.md', 'definition.json', 'rules.json', 'run-request.json', 'intake.json']) {
    assert.ok(await readFile(path.join(pending.intakeDir, name)))
  }
  const created = await runCli(createArgs, { env, configOverrides: { retries: 0 } })
  assert.equal(created.runId, 'run-1')
  assert.equal(state.createCalls, 2)
  const createRequests = mock.requests.filter((request) => request.url === '/api/agent/v1/projects/project-1/runs')
  assert.deepEqual(createRequests[0].json, createRequests[1].json)
  assert.equal(createRequests[0].headers['idempotency-key'], createRequests[1].headers['idempotency-key'])

  const runDir = created.runDir
  const runArgs = [...common, '--run-id', 'run-1', '--run-dir', runDir]
  const visualBibleFile = path.join(runDir, 'visual-bible-input.json')
  await atomicWriteJson(visualBibleFile, {
    artStyle: 'ink wash', colorPalette: ['indigo', 'vermilion'], videoRatio: '16:9',
    eraRegion: 'rainy Chang’an', negativeConstraints: ['no watermark', 'no text'],
  })
  await runCli(['set-visual-bible', ...common, '--run-dir', runDir, '--visual-bible-file', visualBibleFile], { env })
  await runCli(['get-run', ...runArgs], { env, configOverrides: { retries: 0 } })

  const commitCases = [
    ['commit-story', artifactFiles.story, 'episode-001'],
    ['commit-assets', artifactFiles.assets],
    ['commit-screenplay', artifactFiles.screenplay, 'episode-001'],
    ['commit-storyboards', artifactFiles.storyboards, 'episode-001'],
  ]
  for (const [command, artifactFile, episodeKey] of commitCases) {
    const args = [command, ...runArgs, '--artifact-file', artifactFile, ...(episodeKey ? ['--episode-key', episodeKey] : [])]
    const dry = await runCli(args, { env, configOverrides: { retries: 0 } })
    assert.equal(dry.dryRun, true)
    const beforeCommit = await readJson(path.join(runDir, 'receipts.json'))
    assert.equal(Object.keys(beforeCommit.artifacts.stories ?? {}).length, command === 'commit-story' ? 0 : Object.keys(beforeCommit.artifacts.stories ?? {}).length)
    const committed = await runCli([...args, '--commit'], { env, configOverrides: { retries: 0 } })
    assert.equal(committed.dryRun, false)
  }

  // The process may restart here: only persisted run files and receipts are used from now on.
  const resume = await runCli(['find-local-run', ...common, '--project-id', 'project-1', '--source-file', sourceFile], { env })
  assert.deepEqual({ status: resume.status, runId: resume.runId }, { status: 'resume', runId: 'run-1' })
  assert.equal(mock.requests.filter((request) => request.method === 'PUT').length, 8, 'completed artifact stages were not submitted again after resume')

  await runCli(['snapshot', ...runArgs], { env, configOverrides: { retries: 0 } })
  await assert.rejects(runCli(['finalize', ...runArgs], { env, configOverrides: { retries: 0 } }), /status mismatch/i)
  const afterMissingFinalize = await readJson(path.join(runDir, 'receipts.json'))
  assert.equal(afterMissingFinalize.finalize, undefined)

  const uploads = [
    ['character-appearance', 'hero.base'], ['location-image', 'street.day'],
    ['prop-image', 'sword.main'], ['panel-frame', 'frame-001'],
  ]
  for (const [targetType, targetKey] of uploads) {
    const imageFile = path.join(runDir, 'images', targetType, `${targetKey}.png`)
    await mkdir(path.dirname(imageFile), { recursive: true })
    await writeFile(imageFile, TINY_PNG)
    await runCli(['upload', ...runArgs, '--file', imageFile, '--target-type', targetType, '--target-key', targetKey, '--variant-index', '0'], { env, configOverrides: { retries: 1, retryDelayMs: 1 } })
  }
  assert.equal(state.uploadTargets.size, 4)
  const retriedUploads = mock.requests.filter((request) => request.url === '/api/agent/v1/runs/run-1/uploads' && request.headers['idempotency-key'])
  assert.equal(retriedUploads[0].headers['idempotency-key'], retriedUploads[1].headers['idempotency-key'])
  const uploadedReceipts = await readJson(path.join(runDir, 'receipts.json'))
  assert.equal(Object.keys(uploadedReceipts.uploads).length, 4, 'retry did not create a duplicate upload receipt')
  await runCli(['snapshot', ...runArgs], { env, configOverrides: { retries: 0 } })
  const finalized = await runCli(['finalize', ...runArgs], { env, configOverrides: { retries: 0 } })
  assert.equal(finalized.status, 'completed')

  // The old run remains recoverable from its local rule pin after the server changes current rules.
  const originalRules = await readFile(path.join(runDir, 'rules.json'))
  state.currentRules = rules('v2')
  const oldRun = await runCli(['get-run', ...runArgs], { env, configOverrides: { retries: 0 } })
  assert.equal(oldRun.ruleSetVersion, 'v1')
  assert.equal((await readJson(path.join(runDir, 'rules.json'))).ruleSetVersion, 'v1')
  await writeFile(path.join(runDir, 'rules.json'), '{"tampered":true}')
  await assert.rejects(runCli(['find-local-run', ...common, '--project-id', 'project-1', '--source-file', sourceFile], { env }), /rules|pin|hash/i)
  await writeFile(path.join(runDir, 'rules.json'), originalRules)
  const upgradedRules = await runCli(['fetch-rules', ...common, '--project-id', 'project-1', '--source-hash', sha256Prefixed('第一集\n雨夜来客'), '--locale', 'zh'], { env, configOverrides: { retries: 0 } })
  const upgraded = await runCli(['create-run', ...createArgs.slice(1, -1), '--rules-file', upgradedRules.rulesPath], { env, configOverrides: { retries: 0 } })
  assert.equal(upgraded.runId, 'run-2', 'explicit current-rules upgrade creates a distinct run fingerprint')

  const forbidden = /(novel-promotion|analyze|generate|regenerate|video|voice|task|model)/i
  assert.ok(mock.requests.every((request) => request.url.startsWith('/api/agent/v1/') && !forbidden.test(request.url)), 'the client called only Agent Data API routes')
  for (const request of mock.requests.filter((request) => ['POST', 'PUT'].includes(request.method))) {
    assert.ok(request.headers['idempotency-key'], `${request.method} ${request.url} is idempotent`)
  }
})
