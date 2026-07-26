import test from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { cp, lstat, mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { validateManifest } from '../scripts/validate-manifest.mjs'

const here = path.dirname(fileURLToPath(import.meta.url))
const projectRoot = path.resolve(here, '../../../..')
const validRun = path.join(here, 'fixtures/valid-run')

function canonicalJson(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value)
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`
  return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(',')}}`
}

function hash(value) {
  return `sha256:${createHash('sha256').update(Buffer.isBuffer(value) || typeof value === 'string' ? value : canonicalJson(value)).digest('hex')}`
}

function ruleSetHash(rules) {
  const pinned = { ...rules }
  delete pinned.contentHash
  delete pinned.contractsData
  return hash(pinned)
}

async function json(file) {
  return JSON.parse(await readFile(file, 'utf8'))
}

async function writeJson(file, value) {
  await writeFile(file, `${JSON.stringify(value, null, 2)}\n`)
}

async function tempRun(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'waoo-manifest-'))
  const runDir = path.join(root, 'run')
  await cp(validRun, runDir, { recursive: true })
  t.after(() => rm(root, { recursive: true, force: true }))
  return runDir
}

async function mutateJson(runDir, name, mutate) {
  const file = path.join(runDir, name)
  const value = await json(file)
  await mutate(value)
  await writeJson(file, value)
}

test('validates the static story-stage fixture', async () => {
  const before = await Promise.all((await readdir(validRun)).sort().map(async (name) => [name, await readFile(path.join(validRun, name))]))
  const result = await validateManifest({ projectRoot, runDir: validRun, stage: 'story' })
  assert.equal(result.message, 'manifest valid')
  const after = await Promise.all((await readdir(validRun)).sort().map(async (name) => [name, await readFile(path.join(validRun, name))]))
  assert.deepEqual(after, before, 'validator must be strictly read-only')
})

test('reports missing AJV with the project-local repair command', async (t) => {
  const emptyProject = await mkdtemp(path.join(os.tmpdir(), 'waoo-no-ajv-'))
  t.after(() => rm(emptyProject, { recursive: true, force: true }))
  await assert.rejects(validateManifest({ projectRoot: emptyProject, runDir: validRun, stage: 'story' }), /AJV is required.*npm install/i)
})

test('validates pins and downloaded schemas with JSON pointer errors', async (t) => {
  const runDir = await tempRun(t)
  await mutateJson(runDir, 'story.json', (stories) => { delete stories['episode-001'].novelText })
  await assert.rejects(validateManifest({ projectRoot, runDir, stage: 'story' }), /\/story\.json\/episode-001.*novelText.*targetKey=episode-001/i)
  await cp(path.join(validRun, 'story.json'), path.join(runDir, 'story.json'))
  await mutateJson(runDir, 'manifest.json', (manifest) => { manifest.projectId = 'wrong-project' })
  await assert.rejects(validateManifest({ projectRoot, runDir, stage: 'story' }), /\/manifest\.json\/projectId/)
})

test('requires only files reached by the selected stage', async (t) => {
  const runDir = await tempRun(t)
  await validateManifest({ projectRoot, runDir, stage: 'preflight' })
  await assert.rejects(validateManifest({ projectRoot, runDir, stage: 'assets' }), /\/assets\.json/)
  await assert.rejects(validateManifest({ projectRoot, runDir, stage: 'screenplay' }), /\/assets\.json/)
  await assert.rejects(validateManifest({ projectRoot, runDir, stage: 'storyboards' }), /\/assets\.json/)
})

async function makeFinalizeRun(t) {
  const runDir = await tempRun(t)
  const assets = {
    characters: [{
      characterKey: 'hero', name: '主角', aliases: [], introduction: '主角介绍', gender: 'unknown', roleLevel: 'S',
      personalityTags: [], suggestedColors: [], visualKeywords: [],
      appearances: [{ appearanceKey: 'hero.base', appearanceOrdinal: 1, changeReason: '初始造型', visualDescription: '黑发，蓝衣' }],
    }],
    locations: [{ locationKey: 'city', name: '城市', summary: '未来城市', availableSlots: [], descriptions: ['霓虹城市'] }],
    props: [{ propKey: 'sword', name: '长剑', summary: '主角武器', visualDescription: '银色长剑' }],
  }
  const screenplay = {
    'episode-001': {
      episodeKey: 'episode-001',
      clips: [{
        clipKey: 'clip-001', ordinal: 1, startText: '开始', endText: '结束', summary: '相遇', locationKey: 'city',
        characterKeys: ['hero'], propKeys: ['sword'], content: '主角进入城市。',
        screenplay: { originalText: '主角进入城市。', scenes: [{ sceneNumber: 1, heading: { intExt: 'EXT', locationKey: 'city', time: '夜' }, description: '街道', characterKeys: ['hero'], content: [{ type: 'dialogue', characterKey: 'hero', lines: '出发。' }] }] },
      }],
    },
  }
  const storyboards = {
    'episode-001': {
      episodeKey: 'episode-001',
      storyboards: [{
        storyboardKey: 'board-001', clipKey: 'clip-001',
        photographyPlan: { visualStrategy: '电影感', continuityRules: [], rules: [] }, actingDirections: [],
        panels: [{
          panelKey: 'panel-001', panelNumber: 1, description: '主角拔剑',
          characters: [{ characterKey: 'hero', appearanceKey: 'hero.base', slot: '中景' }], propKeys: ['sword'], locationKey: 'city',
          sceneType: '动作', sourceText: '主角进入城市。', shotType: '中景', cameraMove: '推进', videoPrompt: '主角拔剑',
          durationSec: 5, panelMode: 'group', groupVideoPrompt: '连续动作', usePreviousPanelTailAsReference: false,
          frames: [
            { frameKey: 'frame-001', frameIndex: 0, frameTimeSec: 0, frameRole: 'hero', dependencyFrameKeys: [], imagePrompt: '站立', videoPrompt: '站立', referencePolicy: { orderedReferences: [{ kind: 'location', targetKey: 'city' }, { kind: 'character-appearance', targetKey: 'hero.base' }, { kind: 'prop', targetKey: 'sword' }] } },
            { frameKey: 'frame-002', frameIndex: 1, frameTimeSec: 3, frameRole: 'action', dependencyFrameKeys: ['frame-001'], imagePrompt: '拔剑', videoPrompt: '拔剑', referencePolicy: { orderedReferences: [{ kind: 'frame', targetKey: 'frame-001' }] } },
          ],
        }],
      }],
    },
  }
  await writeJson(path.join(runDir, 'assets.json'), assets)
  await writeJson(path.join(runDir, 'screenplay.json'), screenplay)
  await writeJson(path.join(runDir, 'storyboards.json'), storyboards)
  const stories = await json(path.join(runDir, 'story.json'))
  const imageBytes = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 1])
  const imageHash = hash(imageBytes)
  const imageTargets = [
    ['character-appearance', 'hero.base'], ['location-image', 'city'], ['prop-image', 'sword'], ['panel-frame', 'frame-001'],
  ]
  const images = {}
  const uploads = {}
  const snapshotUploads = []
  for (const [targetType, targetKey] of imageTargets) {
    const localPath = `images/${targetType}-${targetKey}.png`
    await mkdir(path.dirname(path.join(runDir, localPath)), { recursive: true })
    await writeFile(path.join(runDir, localPath), imageBytes)
    const identity = { targetType, targetKey, variantIndex: 0, contentSha256: imageHash }
    images[`${targetType}:${targetKey}:0`] = { ...identity, localPath }
    uploads[canonicalJson(identity)] = { ...identity, data: { runId: 'run-001', ...identity, mediaId: `media-${targetKey}`, storageKey: localPath, url: `/${localPath}`, reused: false }, requestId: `upload-${targetKey}`, uploadedAt: '2026-07-26T00:00:00.000Z' }
    snapshotUploads.push({ ...identity, mediaId: `media-${targetKey}`, url: `/${localPath}` })
  }
  const artifactHashes = {
    assets: hash(assets),
    stories: { 'episode-001': hash(stories['episode-001']) },
    screenplays: { 'episode-001': hash(screenplay['episode-001']) },
    storyboards: { 'episode-001': hash(storyboards['episode-001']) },
  }
  const manifest = await json(path.join(runDir, 'manifest.json'))
  Object.assign(manifest, { status: 'completed', currentStage: 'completed', images, clientState: { serverStateRequestSeq: 7, serverStateAppliedSeq: 7 } })
  await writeJson(path.join(runDir, 'manifest.json'), manifest)
  await writeJson(path.join(runDir, 'receipts.json'), {
    receiptVersion: 1, runId: 'run-001', projectId: 'project-001',
    artifacts: {
      assets: { artifactHash: artifactHashes.assets },
      stories: { 'episode-001': { artifactHash: artifactHashes.stories['episode-001'] } },
      screenplays: { 'episode-001': { artifactHash: artifactHashes.screenplays['episode-001'] } },
      storyboards: { 'episode-001': { artifactHash: artifactHashes.storyboards['episode-001'] } },
    },
    uploads,
    snapshot: { data: { runId: 'run-001', status: 'completed', committedArtifactHashes: artifactHashes, uploads: snapshotUploads, missing: [] }, requestId: 'snapshot', receivedAt: '2026-07-26T00:00:00.000Z', serverStateRequestSeq: 6 },
    finalize: { expected: artifactHashes, data: { runId: 'run-001', status: 'completed' }, requestId: 'finalize', finalizedAt: '2026-07-26T00:00:01.000Z', serverStateRequestSeq: 7 },
  })
  return { runDir, assets, screenplay, storyboards }
}

test('validates all artifact graphs, four image target types, receipts and finalize snapshot', async (t) => {
  const { runDir } = await makeFinalizeRun(t)
  const before = await lstat(path.join(runDir, 'manifest.json'))
  assert.equal((await validateManifest({ projectRoot, runDir, stage: 'finalize' })).message, 'manifest valid')
  const after = await lstat(path.join(runDir, 'manifest.json'))
  assert.equal(after.mtimeMs, before.mtimeMs)
})

test('rejects unresolved screenplay and storyboard references, duplicate keys and frame DAG errors', async (t) => {
  const cases = [
    ['screenplay.json', (value) => { value['episode-001'].clips[0].characterKeys = ['missing-character'] }, /targetKey=missing-character/],
    ['assets.json', (value) => { value.props[0].propKey = 'hero' }, /targetKey=hero/],
    ['storyboards.json', (value) => { value['episode-001'].storyboards[0].panels[0].characters[0].appearanceKey = 'missing-look' }, /targetKey=missing-look/],
    ['storyboards.json', (value) => { value['episode-001'].storyboards[0].panels[0].frames[0].dependencyFrameKeys = ['frame-002'] }, /frame-002/],
    ['storyboards.json', (value) => { value['episode-001'].storyboards[0].panels[0].frames[1].referencePolicy.orderedReferences[0].targetKey = 'missing-frame' }, /targetKey=missing-frame/],
  ]
  for (const [name, mutate, expected] of cases) {
    await t.test(name, async (t) => {
      const { runDir } = await makeFinalizeRun(t)
      await mutateJson(runDir, name, mutate)
      await assert.rejects(validateManifest({ projectRoot, runDir, stage: 'storyboards' }), expected)
    })
  }
})

test('rejects forbidden generation configuration at any depth', async (t) => {
  const runDir = await tempRun(t)
  await mutateJson(runDir, 'manifest.json', (manifest) => { manifest.stages.story = { provider: 'secret-provider' } })
  await assert.rejects(validateManifest({ projectRoot, runDir, stage: 'story' }), /\/manifest\.json\/stages\/story\/provider/)
})

test('rejects a tampered definition and forbidden configuration inside an Artifact', async (t) => {
  await t.test('definition', async (t) => {
    const runDir = await tempRun(t)
    await mutateJson(runDir, 'definition.json', (definitions) => { definitions[0].sourceText = '篡改后的分集原文' })
    await assert.rejects(validateManifest({ projectRoot, runDir, stage: 'story' }), /definition\.json.*sourceHash/i)
  })
  await t.test('artifact field', async (t) => {
    const { runDir } = await makeFinalizeRun(t)
    await mutateJson(runDir, 'assets.json', (assets) => { assets.characters[0].provider = 'secret-provider' })
    await assert.rejects(validateManifest({ projectRoot, runDir, stage: 'assets' }), /\/assets\.json\/characters\/0\/provider/)
  })
})

test('rejects image escapes, symlinks, byte hash mismatches and missing upload receipts', async (t) => {
  await t.test('escape', async (t) => {
    const { runDir } = await makeFinalizeRun(t)
    await mutateJson(runDir, 'manifest.json', (manifest) => { manifest.images['panel-frame:frame-001:0'].localPath = '../escape.png' })
    await assert.rejects(validateManifest({ projectRoot, runDir, stage: 'images' }), /outside.*run|escape/i)
  })
  await t.test('symlink', async (t) => {
    const { runDir } = await makeFinalizeRun(t)
    const target = path.join(runDir, 'images/panel-frame-frame-001.png')
    const real = path.join(runDir, 'images/real.png')
    await writeFile(real, await readFile(target))
    await rm(target)
    await symlink(real, target)
    await assert.rejects(validateManifest({ projectRoot, runDir, stage: 'images' }), /symlink/i)
  })
  await t.test('symlinked images directory', async (t) => {
    const { runDir } = await makeFinalizeRun(t)
    const imageDir = path.join(runDir, 'images')
    const externalDir = path.join(path.dirname(runDir), 'outside-images')
    await cp(imageDir, externalDir, { recursive: true })
    await rm(imageDir, { recursive: true })
    await symlink(externalDir, imageDir)
    await assert.rejects(validateManifest({ projectRoot, runDir, stage: 'images' }), /symlink/i)
  })
  await t.test('hash', async (t) => {
    const { runDir } = await makeFinalizeRun(t)
    await writeFile(path.join(runDir, 'images/panel-frame-frame-001.png'), Buffer.from('changed'))
    await assert.rejects(validateManifest({ projectRoot, runDir, stage: 'images' }), /contentSha256.*targetKey=frame-001/i)
  })
  await t.test('receipt', async (t) => {
    const { runDir } = await makeFinalizeRun(t)
    await mutateJson(runDir, 'receipts.json', (receipts) => {
      const key = Object.keys(receipts.uploads).find((entry) => entry.includes('frame-001'))
      delete receipts.uploads[key]
    })
    await assert.rejects(validateManifest({ projectRoot, runDir, stage: 'images' }), /upload receipt.*targetKey=frame-001/i)
  })
})

test('rejects committed hash drift and a manifest status not proven by the latest sequence receipt', async (t) => {
  await t.test('snapshot hash', async (t) => {
    const { runDir } = await makeFinalizeRun(t)
    await mutateJson(runDir, 'receipts.json', (receipts) => { receipts.snapshot.data.committedArtifactHashes.assets = `sha256:${'0'.repeat(64)}` })
    await assert.rejects(validateManifest({ projectRoot, runDir, stage: 'finalize' }), /snapshot.*assets/)
  })
  await t.test('status sequence', async (t) => {
    const { runDir } = await makeFinalizeRun(t)
    await mutateJson(runDir, 'receipts.json', (receipts) => { receipts.finalize.serverStateRequestSeq = 5 })
    await assert.rejects(validateManifest({ projectRoot, runDir, stage: 'finalize' }), /serverStateAppliedSeq.*latest.*receipt/i)
  })
  await t.test('current stage', async (t) => {
    const { runDir } = await makeFinalizeRun(t)
    await mutateJson(runDir, 'receipts.json', (receipts) => { receipts.finalize.data.currentStage = 'assets' })
    await assert.rejects(validateManifest({ projectRoot, runDir, stage: 'finalize' }), /currentStage.*latest.*receipt/i)
  })
  await t.test('status fallback current stage', async (t) => {
    const { runDir } = await makeFinalizeRun(t)
    await mutateJson(runDir, 'manifest.json', (manifest) => { manifest.currentStage = 'assets' })
    await assert.rejects(validateManifest({ projectRoot, runDir, stage: 'finalize' }), /currentStage.*latest.*receipt/i)
  })
})

test('rejects conflicting receipts at the same latest server-state sequence', async (t) => {
  await t.test('status', async (t) => {
    const { runDir } = await makeFinalizeRun(t)
    await mutateJson(runDir, 'receipts.json', (receipts) => {
      receipts.serverRun = { data: { runId: 'run-001', status: 'assets', currentStage: 'assets' }, serverStateRequestSeq: 7 }
    })
    await assert.rejects(validateManifest({ projectRoot, runDir, stage: 'finalize' }), /\/receipts\.json\/serverRun.*targetKey=run\/receipt/i)
  })
  await t.test('effective stage', async (t) => {
    const { runDir } = await makeFinalizeRun(t)
    await mutateJson(runDir, 'receipts.json', (receipts) => {
      receipts.serverRun = { data: { runId: 'run-001', status: 'completed', currentStage: 'assets' }, serverStateRequestSeq: 7 }
    })
    await assert.rejects(validateManifest({ projectRoot, runDir, stage: 'finalize' }), /\/receipts\.json\/serverRun.*targetKey=run\/receipt/i)
  })
  await t.test('matching status and effective stage', async (t) => {
    const { runDir } = await makeFinalizeRun(t)
    await mutateJson(runDir, 'receipts.json', (receipts) => {
      receipts.serverRun = { data: { runId: 'run-001', status: 'completed' }, serverStateRequestSeq: 7 }
    })
    assert.equal((await validateManifest({ projectRoot, runDir, stage: 'finalize' })).message, 'manifest valid')
  })
})

test('rejects a recomputed rules hash when contracts or rule content are incomplete', async (t) => {
  await t.test('empty contracts', async (t) => {
    const runDir = await tempRun(t)
    await mutateJson(runDir, 'rules.json', (rules) => {
      rules.contracts = []
      rules.contentHash = ruleSetHash(rules)
    })
    await assert.rejects(validateManifest({ projectRoot, runDir, stage: 'preflight' }), /contracts.*non-empty/i)
  })
  await t.test('empty rule content', async (t) => {
    const runDir = await tempRun(t)
    await mutateJson(runDir, 'rules.json', (rules) => {
      rules.rules[0].content = ''
      rules.rules[0].hash = hash('')
      rules.contentHash = ruleSetHash(rules)
    })
    await assert.rejects(validateManifest({ projectRoot, runDir, stage: 'preflight' }), /rules\/0\/content.*non-empty/i)
  })
})

test('rejects forbidden fields in every pinned non-artifact document', async (t) => {
  for (const name of ['run-request.json', 'create-run-response.json', 'definition.json', 'receipts.json']) {
    await t.test(name, async (t) => {
      const runDir = await tempRun(t)
      await mutateJson(runDir, name, (value) => {
        const target = Array.isArray(value) ? value[0] : value
        target.nested = { provider: 'forbidden' }
      })
      const index = Array.isArray(await json(path.join(runDir, name))) ? '/0' : ''
      await assert.rejects(validateManifest({ projectRoot, runDir, stage: 'preflight' }), new RegExp(`/${name.replace('.', '\\.')}${index}/nested/provider`))
    })
  }
})
