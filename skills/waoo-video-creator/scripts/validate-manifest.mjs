#!/usr/bin/env node

import { createHash } from 'node:crypto'
import { createRequire } from 'node:module'
import { lstat, readFile, realpath } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const SHA256_PATTERN = /^sha256:[a-f0-9]{64}$/
const STAGES = ['preflight', 'story', 'assets', 'screenplay', 'storyboards', 'images', 'finalize']
const STAGE_FILES = [
  ['story', 'story.json', 'waoo-agent-story.v1'],
  ['assets', 'assets.json', 'waoo-agent-assets.v1'],
  ['screenplay', 'screenplay.json', 'waoo-agent-screenplay.v1'],
  ['storyboards', 'storyboards.json', 'waoo-agent-storyboards.v1'],
]

function canonicalJson(value) {
  if (value === null || typeof value === 'string' || typeof value === 'boolean' || typeof value === 'number') return JSON.stringify(value)
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`
  return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(',')}}`
}

function sha256Prefixed(value) {
  const bytes = typeof value === 'string' || Buffer.isBuffer(value) ? value : canonicalJson(value)
  return `sha256:${createHash('sha256').update(bytes).digest('hex')}`
}

function normalizeSourceText(value) {
  return String(value).replace(/\r\n?/g, '\n').trim()
}

function without(value, keys) {
  return Object.fromEntries(Object.entries(value).filter(([key]) => !keys.includes(key)))
}

function fail(pointer, message, targetKey) {
  const suffix = targetKey === undefined ? '' : ` targetKey=${targetKey}`
  throw new Error(`${pointer}: ${message}${suffix}`)
}

function stageAtLeast(stage, required) {
  return STAGES.indexOf(stage) >= STAGES.indexOf(required)
}

async function readJson(runDir, name) {
  try {
    return JSON.parse(await readFile(path.join(runDir, name), 'utf8'))
  } catch (error) {
    fail(`/${name}`, error.code === 'ENOENT' ? 'required file is missing' : `invalid JSON: ${error.message}`)
  }
}

async function maybeReadJson(runDir, name) {
  try {
    return JSON.parse(await readFile(path.join(runDir, name), 'utf8'))
  } catch (error) {
    if (error.code === 'ENOENT') return undefined
    fail(`/${name}`, `invalid JSON: ${error.message}`)
  }
}

function loadAjv(projectRoot) {
  try {
    const requireFromProject = createRequire(path.resolve(projectRoot, 'package.json'))
    return requireFromProject('ajv')
  } catch (error) {
    throw new Error(`/projectRoot: AJV is required; run npm install in ${projectRoot} (${error.message})`)
  }
}

function validateRules(rules) {
  if (rules?.schemaVersion !== 1 || !rules.ruleSetVersion || !SHA256_PATTERN.test(rules.contentHash ?? '')) fail('/rules.json', 'rules snapshot is incomplete')
  if (!Array.isArray(rules.rules) || rules.rules.length === 0) fail('/rules.json/rules', 'must be a non-empty array')
  for (const [index, rule] of (rules.rules ?? []).entries()) {
    if (typeof rule.content !== 'string' || !rule.content.trim()) fail(`/rules.json/rules/${index}/content`, 'must be non-empty', rule.id)
    if (!rule.id || sha256Prefixed(rule.content) !== rule.hash) fail(`/rules.json/rules/${index}/hash`, 'rule content hash mismatch', rule.id)
  }
  if (sha256Prefixed(without(rules, ['contentHash', 'contractsData'])) !== rules.contentHash) fail('/rules.json/contentHash', 'rule set content hash mismatch')
  if (!Array.isArray(rules.contracts) || rules.contracts.length === 0) fail('/rules.json/contracts', 'must be a non-empty array')
  const contractIds = new Set()
  for (const [index, contract] of (rules.contracts ?? []).entries()) {
    const downloaded = rules.contractsData?.[contract.id]
    if (typeof contract.id !== 'string' || !contract.id || !SHA256_PATTERN.test(contract.hash ?? '') || contractIds.has(contract.id)) fail(`/rules.json/contracts/${index}`, 'id and hash must be complete and unique', contract.id)
    contractIds.add(contract.id)
    if (!downloaded) fail(`/rules.json/contracts/${index}`, 'contract snapshot is missing', contract.id)
    if (!downloaded.jsonSchema || typeof downloaded.jsonSchema !== 'object' || downloaded.id !== contract.id || downloaded.hash !== contract.hash || sha256Prefixed(downloaded.jsonSchema) !== contract.hash) {
      fail(`/rules.json/contracts/${index}/hash`, 'contract hash mismatch', contract.id)
    }
  }
  if (!rules.contractsData || Object.keys(rules.contractsData).length !== contractIds.size || Object.keys(rules.contractsData).some((id) => !contractIds.has(id))) fail('/rules.json/contractsData', 'must exactly match complete contracts')
}

function same(left, right) {
  return canonicalJson(left) === canonicalJson(right)
}

function responseEpisodeMap(response) {
  if (!Array.isArray(response?.episodes)) fail('/create-run-response.json/episodes', 'must be an array')
  return Object.fromEntries(response.episodes.map((episode) => [episode.episodeKey, { episodeId: episode.episodeId, episodeNumber: episode.episodeNumber }]))
}

function latestStateReceipt(receipts) {
  const candidates = [
    ['finalize', receipts?.finalize, '/receipts.json/finalize'],
    ['serverRun', receipts?.serverRun, '/receipts.json/serverRun'],
    ['snapshot', receipts?.snapshot, '/receipts.json/snapshot'],
  ].map(([kind, receipt, pointer]) => ({ kind, receipt, pointer, sequence: receipt?.serverStateRequestSeq }))
    .filter(({ receipt, sequence }) => typeof receipt?.data?.status === 'string' && Number.isSafeInteger(sequence) && sequence >= 0)
  if (!candidates.length) return undefined
  const maxSequence = Math.max(...candidates.map(({ sequence }) => sequence))
  const latest = candidates.filter(({ sequence }) => sequence === maxSequence)
  const expected = latest[0]
  const expectedStage = expected.receipt.data.currentStage ?? expected.receipt.data.status
  for (const candidate of latest.slice(1)) {
    const candidateStage = candidate.receipt.data.currentStage ?? candidate.receipt.data.status
    if (candidate.receipt.data.status !== expected.receipt.data.status || candidateStage !== expectedStage) {
      fail(candidate.pointer, 'conflicts with another receipt at the latest server-state sequence', 'run/receipt')
    }
  }
  return expected
}

function validateFormalManifest(manifest, request, response, rules, sourceText, definitions, receipts) {
  if (manifest?.manifestVersion !== 1) fail('/manifest.json/manifestVersion', 'must equal 1')
  if (manifest.schemaVersion !== 1) fail('/manifest.json/schemaVersion', 'must equal 1')
  for (const key of ['runId', 'projectId', 'status', 'currentStage', 'sourceHash', 'runFingerprint', 'ruleSetVersion', 'ruleSetHash', 'effectiveOptions', 'episodeDefinitions', 'episodeMap']) {
    if (manifest[key] === undefined) fail(`/manifest.json/${key}`, 'required field is missing')
  }
  for (const key of ['runId', 'projectId', 'sourceHash', 'runFingerprint']) {
    if (manifest[key] !== response[key]) fail(`/manifest.json/${key}`, 'does not match create-run-response.json')
  }
  if (!same(manifest.episodeMap, responseEpisodeMap(response))) fail('/manifest.json/episodeMap', 'does not match create-run response')
  if (manifest.ruleSetVersion !== rules.ruleSetVersion || manifest.ruleSetHash !== rules.contentHash) fail('/manifest.json/ruleSetHash', 'does not match rules.json')
  if (manifest.sourceHash !== sha256Prefixed(normalizeSourceText(sourceText))) fail('/manifest.json/sourceHash', 'does not match source.md')
  for (const key of ['sourceHash', 'runFingerprint', 'ruleSetVersion', 'ruleSetHash', 'effectiveOptions']) {
    if (!same(manifest[key], request[key])) fail(`/manifest.json/${key}`, 'does not match run-request.json')
  }
  if (!same(manifest.episodeDefinitions, request.episodes)) fail('/manifest.json/episodeDefinitions', 'does not match run-request episodes')
  if (!Array.isArray(definitions)) fail('/definition.json', 'must be an array')
  const pinnedDefinitions = definitions.map((definition) => {
    if (!definition || typeof definition !== 'object' || typeof definition.sourceText !== 'string' || !SHA256_PATTERN.test(definition.sourceHash ?? '') || sha256Prefixed(normalizeSourceText(definition.sourceText)) !== definition.sourceHash) {
      fail('/definition.json/sourceHash', 'does not match normalized sourceText', definition?.episodeKey)
    }
    const pinned = { ...definition }
    delete pinned.sourceText
    return pinned
  })
  if (!same(manifest.episodeDefinitions, pinnedDefinitions) || manifest.definitionHash !== sha256Prefixed(pinnedDefinitions) || request.definitionHash !== manifest.definitionHash) {
    fail('/definition.json', 'does not match pinned definitionHash')
  }
  const applied = manifest.clientState?.serverStateAppliedSeq
  if (applied !== undefined) {
    if (!Number.isSafeInteger(applied) || applied < 0) fail('/manifest.json/clientState/serverStateAppliedSeq', 'must be a non-negative integer')
    const latest = latestStateReceipt(receipts)
    if (!latest || latest.sequence !== applied) fail('/manifest.json/clientState/serverStateAppliedSeq', 'is not proven by the latest receipt')
    if (manifest.status !== latest.receipt.data.status) fail('/manifest.json/status', `does not match latest ${latest.kind} receipt`)
    const expectedStage = latest.receipt.data.currentStage ?? latest.receipt.data.status
    if (manifest.currentStage !== expectedStage) fail('/manifest.json/currentStage', `does not match latest ${latest.kind} receipt`)
  } else if (manifest.status !== response.status || manifest.currentStage !== response.status) {
    fail('/manifest.json/status', 'is not backed by create-run-response.json')
  }
}

function validateForbidden(value, pointer = '') {
  if (Array.isArray(value)) return value.forEach((entry, index) => validateForbidden(entry, `${pointer}/${index}`))
  if (!value || typeof value !== 'object') return
  for (const [key, entry] of Object.entries(value)) {
    if (/^(model|provider|apiKey|task|tasks|video|audio|videoTasks?|audioTasks?)$/i.test(key)) fail(`${pointer}/${key}`, 'forbidden generation field')
    validateForbidden(entry, `${pointer}/${key}`)
  }
}

function validateArtifact(Ajv, rules, contractId, artifact, pointer) {
  const schema = rules.contractsData?.[contractId]?.jsonSchema
  if (!schema) fail(pointer, 'downloaded contract schema is missing', contractId)
  const ajv = new Ajv({ allErrors: true, strict: false })
  ajv.addFormat('binary', true)
  const envelope = { schemaVersion: 1, ruleSetVersion: rules.ruleSetVersion, ruleSetHash: rules.contentHash, artifactHash: sha256Prefixed(artifact), dryRun: false, data: artifact }
  const validate = ajv.compile(schema)
  if (!validate(envelope)) {
    const issue = validate.errors[0]
    fail(`${pointer}${issue.instancePath || issue.dataPath || ''}`, issue.message ?? 'schema validation failed', artifact.episodeKey)
  }
}

function addUnique(seen, key, pointer) {
  if (typeof key !== 'string' || !key) fail(pointer, 'external key is required')
  if (seen.has(key)) fail(pointer, 'external key must be unique', key)
  seen.add(key)
}

function assertKnown(known, key, pointer) {
  if (!known.has(key)) fail(pointer, 'reference does not resolve', key)
}

function validateArtifactGraphs({ assets, screenplay, storyboards }) {
  const externalKeys = new Set()
  const characters = new Set()
  const appearances = new Set()
  const locations = new Set()
  const props = new Set()
  for (const [index, character] of (assets.characters ?? []).entries()) {
    addUnique(externalKeys, character.characterKey, `/assets.json/characters/${index}/characterKey`)
    characters.add(character.characterKey)
    for (const [appearanceIndex, appearance] of (character.appearances ?? []).entries()) {
      addUnique(externalKeys, appearance.appearanceKey, `/assets.json/characters/${index}/appearances/${appearanceIndex}/appearanceKey`)
      appearances.add(appearance.appearanceKey)
    }
  }
  for (const [index, location] of (assets.locations ?? []).entries()) {
    addUnique(externalKeys, location.locationKey, `/assets.json/locations/${index}/locationKey`)
    locations.add(location.locationKey)
  }
  for (const [index, prop] of (assets.props ?? []).entries()) {
    addUnique(externalKeys, prop.propKey, `/assets.json/props/${index}/propKey`)
    props.add(prop.propKey)
  }
  const clips = new Set()
  for (const [episodeKey, artifact] of Object.entries(screenplay)) {
    for (const [index, clip] of (artifact.clips ?? []).entries()) {
      const pointer = `/screenplay.json/${episodeKey}/clips/${index}`
      addUnique(externalKeys, clip.clipKey, `${pointer}/clipKey`)
      clips.add(clip.clipKey)
      assertKnown(locations, clip.locationKey, `${pointer}/locationKey`)
      for (const key of clip.characterKeys ?? []) assertKnown(characters, key, `${pointer}/characterKeys`)
      for (const key of clip.propKeys ?? []) assertKnown(props, key, `${pointer}/propKeys`)
    }
  }
  const frames = new Map()
  const panels = []
  for (const [episodeKey, artifact] of Object.entries(storyboards)) {
    for (const [boardIndex, board] of (artifact.storyboards ?? []).entries()) {
      const boardPointer = `/storyboards.json/${episodeKey}/storyboards/${boardIndex}`
      addUnique(externalKeys, board.storyboardKey, `${boardPointer}/storyboardKey`)
      assertKnown(clips, board.clipKey, `${boardPointer}/clipKey`)
      for (const [panelIndex, panel] of (board.panels ?? []).entries()) {
        const pointer = `${boardPointer}/panels/${panelIndex}`
        addUnique(externalKeys, panel.panelKey, `${pointer}/panelKey`)
        panels.push({ panel, pointer })
        assertKnown(locations, panel.locationKey, `${pointer}/locationKey`)
        for (const character of panel.characters ?? []) {
          assertKnown(characters, character.characterKey, `${pointer}/characters`)
          assertKnown(appearances, character.appearanceKey, `${pointer}/characters`)
        }
        for (const key of panel.propKeys ?? []) assertKnown(props, key, `${pointer}/propKeys`)
        for (const [frameIndex, frame] of (panel.frames ?? []).entries()) {
          addUnique(externalKeys, frame.frameKey, `${pointer}/frames/${frameIndex}/frameKey`)
          frames.set(frame.frameKey, { frame, pointer: `${pointer}/frames/${frameIndex}` })
        }
      }
    }
  }
  for (const { panel } of panels) {
    for (const frame of panel.frames ?? []) {
      const frameInfo = frames.get(frame.frameKey)
      for (const dependency of frame.dependencyFrameKeys ?? []) {
        const target = frames.get(dependency)
        if (!target) fail(`${frameInfo.pointer}/dependencyFrameKeys`, 'frame dependency does not resolve', dependency)
        if ((target.frame.frameIndex ?? 0) >= (frame.frameIndex ?? 0)) fail(`${frameInfo.pointer}/dependencyFrameKeys`, 'frame dependency is not topologically earlier', dependency)
      }
      for (const reference of frame.referencePolicy?.orderedReferences ?? []) {
        const known = reference.kind === 'location' ? locations
          : reference.kind === 'character-appearance' ? appearances
            : reference.kind === 'prop' ? props
              : reference.kind === 'frame' ? new Set(frames.keys()) : undefined
        if (!known || !known.has(reference.targetKey)) fail(`${frameInfo.pointer}/referencePolicy/orderedReferences`, 'reference does not resolve', reference.targetKey)
      }
    }
  }
  return { appearances, locations, props, frames }
}

async function validateImages(runDir, manifest, receipts) {
  if (!receipts || receipts.runId !== manifest.runId || receipts.projectId !== manifest.projectId) fail('/receipts.json', 'is not bound to manifest')
  for (const [imageId, image] of Object.entries(manifest.images ?? {})) {
    const pointer = `/manifest.json/images/${imageId}`
    for (const key of ['targetType', 'targetKey', 'variantIndex', 'contentSha256', 'localPath']) if (image[key] === undefined) fail(`${pointer}/${key}`, 'required field is missing')
    if (!SHA256_PATTERN.test(image.contentSha256)) fail(`${pointer}/contentSha256`, 'must be sha256')
    const filePath = path.resolve(runDir, image.localPath)
    const relativePath = path.relative(runDir, filePath)
    if (!relativePath || relativePath.startsWith(`..${path.sep}`) || relativePath === '..' || path.isAbsolute(relativePath)) fail(`${pointer}/localPath`, 'image path escapes outside run directory', image.targetKey)
    let stat
    let currentPath = runDir
    try {
      const rootStat = await lstat(currentPath)
      if (rootStat.isSymbolicLink()) fail(`${pointer}/localPath`, 'run directory must not be a symlink', image.targetKey)
      for (const segment of relativePath.split(path.sep)) {
        currentPath = path.join(currentPath, segment)
        stat = await lstat(currentPath)
        if (stat.isSymbolicLink()) fail(`${pointer}/localPath`, 'image path must not contain a symlink', image.targetKey)
      }
    } catch (error) {
      if (error instanceof Error && error.message.startsWith(`${pointer}/localPath:`)) throw error
      fail(`${pointer}/localPath`, 'image file is missing', image.targetKey)
    }
    if (!stat.isFile()) fail(`${pointer}/localPath`, 'image path must be a regular file', image.targetKey)
    const [realRunDir, realFilePath] = await Promise.all([realpath(runDir), realpath(filePath)])
    const realRelativePath = path.relative(realRunDir, realFilePath)
    if (!realRelativePath || realRelativePath.startsWith(`..${path.sep}`) || realRelativePath === '..' || path.isAbsolute(realRelativePath)) fail(`${pointer}/localPath`, 'resolved image path escapes outside run directory', image.targetKey)
    if (sha256Prefixed(await readFile(filePath)) !== image.contentSha256) fail(`${pointer}/contentSha256`, 'does not match image bytes', image.targetKey)
    const identity = { targetType: image.targetType, targetKey: image.targetKey, variantIndex: image.variantIndex, contentSha256: image.contentSha256 }
    const receipt = receipts.uploads?.[canonicalJson(identity)]
    if (!receipt || !same(Object.fromEntries(Object.keys(identity).map((key) => [key, receipt[key]])), identity) || !same(Object.fromEntries(Object.keys(identity).map((key) => [key, receipt.data?.[key]])), identity)) {
      fail('/receipts.json/uploads', 'upload receipt is missing or mismatched', image.targetKey)
    }
  }
}

function validateReceipts(manifest, receipts, artifacts) {
  if (!receipts || receipts.runId !== manifest.runId || receipts.projectId !== manifest.projectId) fail('/receipts.json', 'is not bound to manifest')
  const hashes = {
    assets: sha256Prefixed(artifacts.assets),
    stories: Object.fromEntries(Object.entries(artifacts.stories).map(([key, value]) => [key, sha256Prefixed(value)])),
    screenplays: Object.fromEntries(Object.entries(artifacts.screenplay).map(([key, value]) => [key, sha256Prefixed(value)])),
    storyboards: Object.fromEntries(Object.entries(artifacts.storyboards).map(([key, value]) => [key, sha256Prefixed(value)])),
  }
  if (receipts.artifacts?.assets?.artifactHash !== hashes.assets) fail('/receipts.json/artifacts/assets', 'committed artifact hash differs from local artifact')
  for (const [collection, expected] of Object.entries(hashes)) {
    if (collection === 'assets') continue
    for (const [episodeKey, artifactHash] of Object.entries(expected)) {
      if (receipts.artifacts?.[collection]?.[episodeKey]?.artifactHash !== artifactHash) fail(`/receipts.json/artifacts/${collection}/${episodeKey}`, 'committed artifact hash differs from local artifact', episodeKey)
    }
  }
  const snapshot = receipts.snapshot?.data
  if (!snapshot || snapshot.runId !== manifest.runId) fail('/receipts.json/snapshot', 'is missing or bound to another run')
  for (const [collection, expected] of Object.entries(hashes)) {
    if (!same(snapshot.committedArtifactHashes?.[collection], expected)) fail(`/receipts.json/snapshot/committedArtifactHashes/${collection}`, 'differs from local artifacts')
  }
  if (receipts.finalize?.data?.status !== 'completed' || manifest.status !== 'completed') fail('/receipts.json/finalize', 'finalize status is incomplete')
}

export async function validateManifest({ projectRoot, runDir, stage }) {
  const resolvedProjectRoot = path.resolve(projectRoot)
  const resolvedRunDir = path.resolve(runDir)
  if (!STAGES.includes(stage)) fail('/stage', `must be one of ${STAGES.join(', ')}`)
  const Ajv = loadAjv(resolvedProjectRoot)
  const [manifest, rules, request, response, sourceText, definitions, receipts, ...existingArtifactValues] = await Promise.all([
    readJson(resolvedRunDir, 'manifest.json'), readJson(resolvedRunDir, 'rules.json'), readJson(resolvedRunDir, 'run-request.json'),
    readJson(resolvedRunDir, 'create-run-response.json'), readFile(path.join(resolvedRunDir, 'source.md'), 'utf8'), readJson(resolvedRunDir, 'definition.json'), readJson(resolvedRunDir, 'receipts.json'),
    ...STAGE_FILES.map(([, file]) => maybeReadJson(resolvedRunDir, file)),
  ])
  validateForbidden(manifest, '/manifest.json')
  validateForbidden(rules, '/rules.json')
  validateForbidden(request, '/run-request.json')
  validateForbidden(response, '/create-run-response.json')
  validateForbidden(definitions, '/definition.json')
  validateForbidden(receipts, '/receipts.json')
  const existingArtifacts = Object.fromEntries(STAGE_FILES.map(([, file], index) => [file, existingArtifactValues[index]]))
  for (const [file, aggregate] of Object.entries(existingArtifacts)) if (aggregate !== undefined) validateForbidden(aggregate, `/${file}`)
  validateRules(rules)
  validateFormalManifest(manifest, request, response, rules, sourceText, definitions, receipts)
  const artifacts = {}
  for (const [requiredStage, file, contractId] of STAGE_FILES) {
    if (!stageAtLeast(stage, requiredStage)) continue
    const aggregate = existingArtifacts[file] ?? await readJson(resolvedRunDir, file)
    artifacts[requiredStage === 'story' ? 'stories' : requiredStage] = aggregate
    if (requiredStage === 'assets') validateArtifact(Ajv, rules, contractId, aggregate, `/${file}`)
    else for (const [episodeKey, artifact] of Object.entries(aggregate)) {
      if (artifact.episodeKey !== episodeKey) fail(`/${file}/${episodeKey}/episodeKey`, 'does not match aggregate key', episodeKey)
      validateArtifact(Ajv, rules, contractId, artifact, `/${file}/${episodeKey}`)
    }
  }
  if (stageAtLeast(stage, 'storyboards')) validateArtifactGraphs({ assets: artifacts.assets, screenplay: artifacts.screenplay, storyboards: artifacts.storyboards })
  if (stageAtLeast(stage, 'images')) await validateImages(resolvedRunDir, manifest, receipts)
  if (stage === 'finalize') validateReceipts(manifest, receipts, artifacts)
  return { message: 'manifest valid' }
}

function parseArgs(argv) {
  const result = {}
  for (let index = 0; index < argv.length; index += 1) {
    if (!argv[index].startsWith('--')) continue
    result[argv[index].slice(2)] = argv[index + 1]
    index += 1
  }
  return result
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const options = parseArgs(process.argv.slice(2))
  validateManifest({ projectRoot: options['project-root'], runDir: options['run-dir'], stage: options.stage })
    .then((result) => console.log(result.message))
    .catch((error) => { console.error(error.message); process.exitCode = 1 })
}
