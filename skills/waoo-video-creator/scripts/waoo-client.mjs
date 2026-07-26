#!/usr/bin/env node

import { createHash, randomUUID } from 'node:crypto'
import { constants as fsConstants } from 'node:fs'
import {
  access,
  mkdir,
  lstat,
  open,
  readFile,
  readdir,
  realpath,
  rename,
  rm,
  stat,
} from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const API_ROOT = '/api/agent/v1'
const DEFAULT_BASE_URL = 'http://127.0.0.1:3000'
const SHA256_PATTERN = /^sha256:[a-f0-9]{64}$/
const COMPLETE_STATUS = 'completed'

function compareUnicodeCodePoints(left, right) {
  const leftPoints = Array.from(left, (character) => character.codePointAt(0))
  const rightPoints = Array.from(right, (character) => character.codePointAt(0))
  for (let index = 0; index < Math.min(leftPoints.length, rightPoints.length); index += 1) {
    if (leftPoints[index] !== rightPoints[index]) return leftPoints[index] - rightPoints[index]
  }
  return leftPoints.length - rightPoints.length
}

function serializeCanonical(value, ancestors) {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return JSON.stringify(value)
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new TypeError('canonical JSON requires finite numbers')
    return JSON.stringify(value)
  }
  if (value === undefined) throw new TypeError('canonical JSON does not support undefined')
  if (typeof value !== 'object') throw new TypeError(`canonical JSON received an unsupported ${typeof value} value`)
  if (ancestors.has(value)) throw new TypeError('canonical JSON does not support cyclic values')
  if (Buffer.isBuffer(value)) throw new TypeError('canonical JSON does not support Buffer values')
  ancestors.add(value)
  try {
    if (Array.isArray(value)) return `[${value.map((item) => serializeCanonical(item, ancestors)).join(',')}]`
    const prototype = Object.getPrototypeOf(value)
    if (prototype !== Object.prototype && prototype !== null) throw new TypeError('canonical JSON received an unsupported object value')
    if (Object.getOwnPropertySymbols(value).length) throw new TypeError('canonical JSON does not support symbol keys')
    return `{${Object.keys(value).sort(compareUnicodeCodePoints).map((key) => `${JSON.stringify(key)}:${serializeCanonical(value[key], ancestors)}`).join(',')}}`
  } finally {
    ancestors.delete(value)
  }
}

export function canonicalJson(value) {
  return serializeCanonical(value, new Set())
}

export function sha256Prefixed(value) {
  const bytes = typeof value === 'string' || Buffer.isBuffer(value)
    ? value
    : canonicalJson(value)
  return `sha256:${createHash('sha256').update(bytes).digest('hex')}`
}

export function normalizeSourceText(value) {
  return String(value).replace(/\r\n?/g, '\n').trim()
}

function sanitizeMessage(message, ...secrets) {
  let result = String(message || 'Agent API request failed')
  for (const secret of secrets.filter(Boolean)) result = result.split(String(secret)).join('[REDACTED]')
  result = result.replace(/Bearer\s+[^\s,;]+/gi, 'Bearer [REDACTED]')
  return result
}

function agentError(message, details = {}) {
  const error = new Error(message)
  Object.assign(error, details)
  return error
}

function isLoopback(hostname) {
  const normalized = hostname.replace(/^\[|\]$/g, '').toLowerCase()
  return normalized === 'localhost' || normalized === '127.0.0.1' || normalized === '::1'
}

function assertSafeIdentifier(label, value) {
  if (typeof value !== 'string' || value.length === 0 || value.length > 200 || value !== value.trim()) {
    throw new Error(`${label} must be a nonempty safe identifier`)
  }
  if (value === '.' || value === '..' || !/^[A-Za-z0-9][A-Za-z0-9._:-]*$/.test(value)) {
    throw new Error(`${label} must be a safe identifier without path escapes`)
  }
  return value
}

function safeChildPath(root, label, ...segments) {
  for (const segment of segments) assertSafeIdentifier(label, segment)
  const resolvedRoot = path.resolve(root)
  const resolved = path.resolve(resolvedRoot, ...segments)
  const relative = path.relative(resolvedRoot, resolved)
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) throw new Error(`${label} resolves outside its allowed root`)
  return resolved
}

function assertLexicallyContained(root, target, label) {
  const resolvedRoot = path.resolve(root)
  const resolvedTarget = path.resolve(target)
  const relative = path.relative(resolvedRoot, resolvedTarget)
  if (relative.startsWith('..') || path.isAbsolute(relative)) throw new Error(`${label} is outside project root`)
  return { resolvedRoot, resolvedTarget, relative }
}

async function assertNoSymlinkPath(projectRoot, target, { mustExist }) {
  const rootReal = await realpath(projectRoot)
  const resolvedTarget = path.resolve(target)
  let aliasRoot
  let cursor = resolvedTarget
  while (true) {
    try {
      if (await realpath(cursor) === rootReal) {
        aliasRoot = cursor
        break
      }
    } catch (error) {
      if (error.code !== 'ENOENT' && error.code !== 'ENOTDIR') throw error
    }
    const parent = path.dirname(cursor)
    if (parent === cursor) break
    cursor = parent
  }
  if (!aliasRoot) throw new Error(`path is outside project root: ${resolvedTarget}`)
  const relative = path.relative(aliasRoot, resolvedTarget)
  let current = aliasRoot
  let nearestExisting = aliasRoot
  for (const segment of relative.split(path.sep).filter(Boolean)) {
    current = path.join(current, segment)
    try {
      const info = await lstat(current)
      if (info.isSymbolicLink()) throw new Error(`symlink paths are forbidden: ${current}`)
      nearestExisting = current
    } catch (error) {
      if (error.code === 'ENOENT') break
      throw error
    }
  }
  if (mustExist && !await pathExists(resolvedTarget)) throw new Error(`required path does not exist: ${resolvedTarget}`)
  const ancestorReal = await realpath(nearestExisting)
  assertLexicallyContained(rootReal, ancestorReal, 'resolved path ancestor')
  if (mustExist) {
    const targetReal = await realpath(resolvedTarget)
    assertLexicallyContained(rootReal, targetReal, 'resolved path')
  }
  return resolvedTarget
}

async function secureReadPath(projectRoot, target, options = {}) {
  const resolved = await assertNoSymlinkPath(projectRoot, target, { mustExist: true })
  if (options.regularFile !== false && !(await lstat(resolved)).isFile()) throw new Error(`path must be a regular file: ${resolved}`)
  return resolved
}

async function secureWriteTarget(projectRoot, target) {
  return assertNoSymlinkPath(projectRoot, target, { mustExist: false })
}

async function atomicWriteProjectJson(projectRoot, target, value) {
  await secureWriteTarget(projectRoot, target)
  await atomicWriteJson(target, value)
}

function numericConfig(name, value, fallback, minimum, maximum) {
  const resolved = value ?? fallback
  const number = typeof resolved === 'number' ? resolved : Number(resolved)
  if (!Number.isFinite(number) || !Number.isInteger(number) || number < minimum || number > maximum) {
    throw new Error(`${name} must be a finite integer from ${minimum} to ${maximum}`)
  }
  return number
}

export function resolveConfig(env = process.env, overrides = {}) {
  const token = overrides.token ?? env.WAOO_AGENT_TOKEN
  const userId = overrides.userId ?? env.WAOO_AGENT_USER_ID
  if (!token) throw new Error('WAOO_AGENT_TOKEN is required')
  if (!userId) throw new Error('WAOO_AGENT_USER_ID is required')
  const baseUrl = (overrides.baseUrl ?? env.WAOO_BASE_URL ?? DEFAULT_BASE_URL).replace(/\/$/, '')
  let parsed
  try {
    parsed = new URL(baseUrl)
  } catch {
    throw new Error('WAOO_BASE_URL must be a valid absolute URL')
  }
  if (parsed.username || parsed.password) throw new Error('WAOO_BASE_URL must not contain URL credentials')
  if (!isLoopback(parsed.hostname)) {
    if (String(env.WAOO_ALLOW_REMOTE_AGENT_API).toLowerCase() !== 'true') {
      throw new Error('remote Agent API is disabled; set WAOO_ALLOW_REMOTE_AGENT_API=true explicitly')
    }
    if (parsed.protocol !== 'https:') throw new Error('remote Agent API requires HTTPS')
  } else if (!['http:', 'https:'].includes(parsed.protocol)) {
    throw new Error('loopback Agent API must use HTTP or HTTPS')
  }
  return {
    baseUrl,
    token,
    userId,
    retries: numericConfig('WAOO_HTTP_RETRIES', overrides.retries ?? env.WAOO_HTTP_RETRIES, 2, 0, 10),
    retryDelayMs: numericConfig('WAOO_HTTP_RETRY_DELAY_MS', overrides.retryDelayMs ?? env.WAOO_HTTP_RETRY_DELAY_MS, 150, 0, 60_000),
    timeoutMs: numericConfig('WAOO_HTTP_TIMEOUT_MS', overrides.timeoutMs ?? env.WAOO_HTTP_TIMEOUT_MS, 30_000, 100, 300_000),
    uploadMaxBytes: numericConfig('WAOO_AGENT_UPLOAD_MAX_BYTES', overrides.uploadMaxBytes ?? env.WAOO_AGENT_UPLOAD_MAX_BYTES, 10_485_760, 1, 1_073_741_824),
  }
}

function shouldRetry(error, status) {
  if (error?.retryable === true) return true
  if (status >= 500) return true
  return error?.network === true
}

const delay = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds))

export async function requestJson(config, requestPath, options = {}) {
  const base = new URL(`${config.baseUrl}/`)
  let requestUrl
  try {
    requestUrl = new URL(requestPath, base)
  } catch {
    throw new Error('unsafe Agent API URL')
  }
  if (requestUrl.origin !== base.origin || requestUrl.username || requestUrl.password) throw new Error('Agent API requests must stay same-origin with WAOO_BASE_URL')
  if (!requestUrl.pathname.startsWith(`${API_ROOT}/`) || /[\\\0%]/.test(String(requestPath))) {
    throw new Error('unsafe Agent API path outside /api/agent/v1')
  }
  const method = options.method ?? 'GET'
  const headers = new Headers(options.headers)
  headers.set('Authorization', `Bearer ${config.token}`)
  headers.set('X-Waoo-User-Id', config.userId)
  headers.set('Accept', 'application/json')
  if (options.idempotencyKey) headers.set('Idempotency-Key', options.idempotencyKey)
  let body = options.body
  if (body !== undefined && !(body instanceof FormData) && !Buffer.isBuffer(body) && typeof body !== 'string') {
    headers.set('Content-Type', 'application/json')
    body = canonicalJson(body)
  }
  const retries = Math.max(0, options.retries ?? config.retries ?? 0)
  let lastError
  for (let attempt = 0; attempt <= retries; attempt += 1) {
    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), options.timeoutMs ?? config.timeoutMs)
    try {
      const response = await fetch(requestUrl, {
        method,
        headers,
        body,
        signal: controller.signal,
        redirect: 'manual',
      })
      let envelope
      try {
        envelope = await response.json()
      } catch {
        throw agentError(`Agent API returned invalid JSON (${response.status})`, { status: response.status })
      }
      if (envelope?.success === true && response.ok) {
        return options.returnEnvelope ? envelope : envelope.data
      }
      const failure = envelope?.error ?? {}
      const error = agentError(sanitizeMessage(failure.message ?? `Agent API request failed (${response.status})`, config.token, config.userId), {
        code: sanitizeMessage(failure.code ?? 'AGENT_HTTP_ERROR', config.token, config.userId),
        field: failure.field ? sanitizeMessage(failure.field, config.token, config.userId) : undefined,
        requestId: envelope?.requestId ? sanitizeMessage(envelope.requestId, config.token, config.userId) : undefined,
        retryable: failure.retryable === true,
        status: response.status,
      })
      if (attempt < retries && shouldRetry(error, response.status)) {
        lastError = error
        await delay(config.retryDelayMs * (attempt + 1))
        continue
      }
      throw error
    } catch (caught) {
      const error = caught?.code || caught?.status
        ? caught
        : agentError(sanitizeMessage(`Agent API network error: ${caught?.message ?? caught}`, config.token, config.userId), { network: true, code: 'NETWORK_ERROR', retryable: true })
      if (attempt < retries && shouldRetry(error, error.status ?? 0)) {
        lastError = error
        await delay(config.retryDelayMs * (attempt + 1))
        continue
      }
      throw error
    } finally {
      clearTimeout(timeout)
    }
  }
  throw lastError
}

export async function atomicWriteJson(targetPath, value) {
  await mkdir(path.dirname(targetPath), { recursive: true })
  const temporaryPath = path.join(path.dirname(targetPath), `.${path.basename(targetPath)}.${process.pid}.${randomUUID()}.tmp`)
  try {
    const handle = await open(temporaryPath, 'wx', 0o600)
    try {
      await handle.writeFile(`${JSON.stringify(value, null, 2)}\n`, 'utf8')
      await handle.sync()
    } finally {
      await handle.close()
    }
    await rename(temporaryPath, targetPath)
  } catch (error) {
    await rm(temporaryPath, { force: true })
    throw error
  }
}

export async function readJson(targetPath) {
  return JSON.parse(await readFile(targetPath, 'utf8'))
}

async function isProjectRoot(candidate) {
  try {
    const packageJson = await readJson(path.join(candidate, 'package.json'))
    return packageJson?.name === 'waoowaoo'
  } catch {
    return false
  }
}

export async function resolveProjectRoot({ explicitRoot, env = process.env, cwd = process.cwd(), strictUnique = false } = {}) {
  const declared = [explicitRoot, env.WAOO_PROJECT_ROOT].filter(Boolean).map((candidate) => path.resolve(candidate))
  if (strictUnique && declared.length > 1 && new Set(declared).size > 1) {
    throw new Error(`multiple project roots were provided: ${declared.join(', ')}`)
  }
  if (explicitRoot) {
    const candidate = path.resolve(explicitRoot)
    if (!await isProjectRoot(candidate)) throw new Error(`explicit --project-root is not the waoowaoo root: ${candidate}`)
    return realpath(candidate)
  }
  if (env.WAOO_PROJECT_ROOT) {
    const candidate = path.resolve(env.WAOO_PROJECT_ROOT)
    if (!await isProjectRoot(candidate)) throw new Error(`WAOO_PROJECT_ROOT is not the waoowaoo root: ${candidate}`)
    return realpath(candidate)
  }
  const candidates = [path.resolve(cwd), path.resolve(cwd, 'waoowaoo')]
  const matches = []
  for (const candidate of candidates) if (await isProjectRoot(candidate)) matches.push(candidate)
  if (matches.length === 0) throw new Error('unable to locate waoowaoo project root; pass --project-root or WAOO_PROJECT_ROOT')
  if (matches.length > 1) throw new Error(`multiple project-root candidates found: ${matches.join(', ')}`)
  return realpath(matches[0])
}

function parseArgs(argv) {
  const [command, ...tokens] = argv
  const options = {}
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index]
    if (!token.startsWith('--')) throw new Error(`unexpected argument: ${token}`)
    const key = token.slice(2)
    const next = tokens[index + 1]
    if (!next || next.startsWith('--')) options[key] = true
    else {
      options[key] = next
      index += 1
    }
  }
  return { command, options }
}

function required(options, key) {
  const value = options[key]
  if (value === undefined || value === true || String(value).trim() === '') throw new Error(`--${key} is required`)
  return String(value)
}

function insideProject(projectRoot, value, fallback) {
  return path.resolve(projectRoot, value ?? fallback)
}

function without(object, keys) {
  return Object.fromEntries(Object.entries(object).filter(([key]) => !keys.includes(key)))
}

function stripEpisodeSourceText(episode) {
  return without(episode, ['sourceText'])
}

function validateDefinitionSourceHashes(definitions, label) {
  for (const definition of definitions) {
    const computed = sha256Prefixed(normalizeSourceText(definition.sourceText))
    if (computed !== definition.sourceHash) throw new Error(`${label} episode sourceHash mismatch: ${definition.episodeKey}`)
  }
}

function validateRuleSnapshot(rules) {
  if (!rules || rules.schemaVersion !== 1 || !SHA256_PATTERN.test(rules.contentHash ?? '')) throw new Error('rules.json is incomplete')
  for (const rule of rules.rules ?? []) {
    if (sha256Prefixed(rule.content) !== rule.hash) throw new Error(`rule content hash mismatch: ${rule.id}`)
  }
  const content = without(rules, ['contentHash', 'contractsData'])
  if (sha256Prefixed(content) !== rules.contentHash) throw new Error('ruleSet contentHash mismatch')
  const contractData = rules.contractsData ?? {}
  for (const contract of rules.contracts ?? []) {
    const downloaded = contractData[contract.id]
    if (!downloaded) throw new Error(`contract snapshot is missing: ${contract.id}`)
    if (downloaded.id !== contract.id || downloaded.hash !== contract.hash || sha256Prefixed(downloaded.jsonSchema) !== contract.hash) {
      throw new Error(`contract hash mismatch: ${contract.id}`)
    }
  }
  return rules
}

async function writeTextExclusiveOrReplace(target, content) {
  await mkdir(path.dirname(target), { recursive: true })
  const temp = `${target}.${process.pid}.${randomUUID()}.tmp`
  const handle = await open(temp, 'wx', 0o600)
  try {
    await handle.writeFile(content, 'utf8')
    await handle.sync()
  } finally {
    await handle.close()
  }
  await rename(temp, target)
}

async function writeProjectText(projectRoot, target, content) {
  await secureWriteTarget(projectRoot, target)
  await writeTextExclusiveOrReplace(target, content)
}

async function pathExists(target) {
  try {
    await access(target, fsConstants.F_OK)
    return true
  } catch {
    return false
  }
}

const FILE_LOCK_TIMEOUT_MS = 750
const FILE_LOCK_RETRY_MS = 20
const FILE_LOCK_STALE_MS = 60_000

async function removeStaleLock(lockPath) {
  let before
  try {
    before = await lstat(lockPath)
  } catch (error) {
    if (error.code === 'ENOENT') return true
    throw error
  }
  if (before.isSymbolicLink() || !before.isFile()) throw new Error(`unsafe lock file: ${lockPath}`)
  if (Date.now() - before.mtimeMs <= FILE_LOCK_STALE_MS) return false
  const after = await lstat(lockPath).catch((error) => error.code === 'ENOENT' ? null : Promise.reject(error))
  if (!after) return true
  if (after.ino !== before.ino || after.mtimeMs !== before.mtimeMs || after.size !== before.size) return false
  await rm(lockPath, { force: true })
  return true
}

async function withFileLock(projectRoot, targetPath, operation) {
  const lockPath = `${targetPath}.lock`
  await secureWriteTarget(projectRoot, lockPath)
  const deadline = Date.now() + FILE_LOCK_TIMEOUT_MS
  const token = `${process.pid}-${randomUUID()}`
  let acquired = false
  while (!acquired) {
    try {
      const handle = await open(lockPath, 'wx', 0o600)
      try {
        await handle.writeFile(JSON.stringify({ token, pid: process.pid, createdAt: new Date().toISOString() }), 'utf8')
        await handle.sync()
      } finally {
        await handle.close()
      }
      acquired = true
    } catch (error) {
      if (error.code !== 'EEXIST') throw error
      if (await removeStaleLock(lockPath)) continue
      if (Date.now() >= deadline) throw new Error(`file lock timeout: ${path.basename(targetPath)}`)
      await delay(FILE_LOCK_RETRY_MS)
    }
  }
  try {
    return await operation()
  } finally {
    try {
      const lock = JSON.parse(await readFile(lockPath, 'utf8'))
      if (lock.token === token) await rm(lockPath, { force: true })
    } catch (error) {
      if (error.code !== 'ENOENT' && !(error instanceof SyntaxError)) throw error
    }
  }
}

function sameCanonical(left, right) {
  return canonicalJson(left) === canonicalJson(right)
}

function assertEqual(label, left, right) {
  if (!sameCanonical(left, right)) throw new Error(`${label} mismatch; refusing to overwrite pinned run data`)
}

function validateManifestRunId(manifest, runId) {
  assertSafeIdentifier('manifest runId', manifest?.runId)
  assertSafeIdentifier('manifest projectId', manifest?.projectId)
  if (manifest.runId !== runId) throw new Error('run-id does not match run manifest')
  return manifest
}

async function loadReceipts(runDir, manifest) {
  const receiptPath = path.join(runDir, 'receipts.json')
  const receipts = await pathExists(receiptPath)
    ? await readJson(receiptPath)
    : { receiptVersion: 1, runId: manifest.runId, projectId: manifest.projectId, artifacts: {}, uploads: {} }
  if (receipts.runId !== manifest.runId || receipts.projectId !== manifest.projectId) throw new Error(`receipts are not bound to this manifest run/project (${receipts.runId ?? 'missing'}/${receipts.projectId ?? 'missing'} != ${manifest.runId}/${manifest.projectId})`)
  receipts.artifacts ??= {}
  receipts.uploads ??= {}
  return receipts
}

async function saveReceipt(projectRoot, runDir, manifest, updater) {
  const receiptPath = path.join(runDir, 'receipts.json')
  return withFileLock(projectRoot, receiptPath, async () => {
    await secureWriteTarget(projectRoot, receiptPath)
    const receipts = await loadReceipts(runDir, manifest)
    await updater(receipts)
    await atomicWriteProjectJson(projectRoot, receiptPath, receipts)
    return receipts
  })
}

function endpoint(...segments) {
  return [API_ROOT, ...segments.map((segment) => encodeURIComponent(assertSafeIdentifier('API path identifier', segment)))].join('/')
}

async function commandDoctor(config) {
  const contractId = 'waoo-agent-resolve-project.v1'
  const contract = await requestJson(config, endpoint('contracts', contractId))
  if (contract.id !== contractId || !SHA256_PATTERN.test(contract.hash ?? '')) throw new Error('doctor received an incompatible resolve-project contract')
  return { ok: true, contractId, hash: contract.hash }
}

async function commandResolveProject(config, options) {
  const name = required(options, 'name').trim()
  const body = { name }
  if (options.description) body.description = String(options.description).trim()
  const data = await requestJson(config, endpoint('projects', 'resolve'), {
    method: 'POST',
    body,
    idempotencyKey: sha256Prefixed(`resolve-project:${name}`),
  })
  assertSafeIdentifier('resolved projectId', data.projectId)
  return data
}

async function commandFetchRules(config, projectRoot, options) {
  const projectId = required(options, 'project-id')
  assertSafeIdentifier('projectId', projectId)
  const sourceHash = required(options, 'source-hash')
  if (!SHA256_PATTERN.test(sourceHash)) throw new Error('--source-hash must be a sha256: value')
  const root = insideProject(projectRoot, options['preflight-root'], '.waoo-agent/preflight')
  await secureWriteTarget(projectRoot, root)
  const locale = options.locale ?? 'zh'
  const rules = await requestJson(config, `${endpoint('projects', projectId, 'creator-rules')}?locale=${encodeURIComponent(locale)}`)
  for (const rule of rules.rules ?? []) {
    if (sha256Prefixed(rule.content) !== rule.hash) throw new Error(`rule content hash mismatch: ${rule.id}`)
  }
  if (sha256Prefixed(without(rules, ['contentHash'])) !== rules.contentHash) throw new Error('creator-rules contentHash mismatch')
  const contractsData = {}
  for (const contractRef of rules.contracts ?? []) {
    const contractId = assertSafeIdentifier('contract id', contractRef.id)
    const expectedPath = endpoint('contracts', contractId)
    const declaredUrl = new URL(contractRef.url, `${config.baseUrl}/`)
    const baseUrl = new URL(`${config.baseUrl}/`)
    if (declaredUrl.origin !== baseUrl.origin || declaredUrl.pathname !== expectedPath || declaredUrl.search || declaredUrl.hash || declaredUrl.username || declaredUrl.password) {
      throw new Error(`contract URL must be the same-origin canonical contract path: ${contractId}`)
    }
    const contract = await requestJson(config, expectedPath)
    if (contract.id !== contractRef.id || contract.hash !== contractRef.hash || sha256Prefixed(contract.jsonSchema) !== contractRef.hash) {
      throw new Error(`contract hash mismatch: ${contractRef.id}`)
    }
    contractsData[contract.id] = contract
  }
  const snapshot = { ...rules, contractsData }
  validateRuleSnapshot(snapshot)
  const projectCache = safeChildPath(root, 'rules cache projectId', projectId)
  const sourceCache = safeChildPath(projectCache, 'rules cache sourceHash', sourceHash)
  const ruleCache = safeChildPath(sourceCache, 'rules cache ruleSetHash', rules.contentHash)
  const rulesPath = path.join(ruleCache, 'rules.json')
  if (await pathExists(rulesPath)) {
    await secureReadPath(projectRoot, rulesPath)
    assertEqual('existing rules snapshot', await readJson(rulesPath), snapshot)
  } else await atomicWriteProjectJson(projectRoot, rulesPath, snapshot)
  return { rulesPath, ruleSetVersion: rules.ruleSetVersion, ruleSetHash: rules.contentHash, contractCount: Object.keys(contractsData).length }
}

function optionFilterMatches(manifest, options) {
  const effective = manifest.effectiveOptions ?? {}
  return manifest.inputKindHint === (options['input-kind-hint'] ?? 'auto')
    && manifest.locale === (options.locale ?? 'zh')
    && effective.episodeSplitHint === (options['episode-split-hint'] ?? 'auto')
    && (!options['art-style-override'] || effective.artStyle === options['art-style-override'])
    && (!options['video-ratio-override'] || effective.videoRatio === options['video-ratio-override'])
}

async function validateFormalRunDirectory(projectRoot, runDir, manifest, options = {}) {
  const requireCreateResponse = options.requireCreateResponse !== false
  const requireEpisodeMap = options.requireEpisodeMap !== false
  assertSafeIdentifier('formal manifest runId', manifest?.runId)
  assertSafeIdentifier('formal manifest projectId', manifest?.projectId)
  if (!manifest.runId || path.basename(runDir) !== manifest.runId) throw new Error(`formal run directory/runId mismatch: ${runDir}`)
  await secureReadPath(projectRoot, runDir, { regularFile: false })
  for (const name of ['source.md', 'definition.json', 'rules.json', 'run-request.json']) await secureReadPath(projectRoot, path.join(runDir, name))
  const source = normalizeSourceText(await readFile(path.join(runDir, 'source.md'), 'utf8'))
  if (sha256Prefixed(source) !== manifest.sourceHash) throw new Error(`formal run source hash mismatch: ${manifest.runId}`)
  const definitions = await readJson(path.join(runDir, 'definition.json'))
  for (const definition of definitions) assertSafeIdentifier('formal definition episodeKey', definition.episodeKey)
  validateDefinitionSourceHashes(definitions, 'formal definition')
  const episodes = definitions.map(stripEpisodeSourceText)
  if (sha256Prefixed(episodes) !== manifest.definitionHash || !sameCanonical(episodes, manifest.episodeDefinitions)) {
    throw new Error(`formal run definition hash mismatch: ${manifest.runId}`)
  }
  const rules = validateRuleSnapshot(await readJson(path.join(runDir, 'rules.json')))
  if (rules.contentHash !== manifest.ruleSetHash || rules.ruleSetVersion !== manifest.ruleSetVersion) throw new Error(`formal run rule pin mismatch: ${manifest.runId}`)
  const request = await readJson(path.join(runDir, 'run-request.json'))
  for (const episode of request.episodes ?? []) assertSafeIdentifier('formal request episodeKey', episode.episodeKey)
  const expectedFingerprint = sha256Prefixed({
    projectId: manifest.projectId,
    sourceHash: manifest.sourceHash,
    inputKindHint: manifest.inputKindHint,
    locale: manifest.locale,
    effectiveOptions: manifest.effectiveOptions,
    ruleSetHash: manifest.ruleSetHash,
  })
  if (expectedFingerprint !== manifest.runFingerprint || request.runFingerprint !== expectedFingerprint) throw new Error(`formal run fingerprint mismatch: ${manifest.runId}`)
  for (const key of ['sourceHash', 'inputKindHint', 'locale', 'effectiveOptions', 'ruleSetVersion', 'ruleSetHash', 'definitionHash', 'episodes']) {
    assertEqual(`formal run request ${key}`, request[key], key === 'episodes' ? episodes : manifest[key])
  }
  const responsePath = path.join(runDir, 'create-run-response.json')
  let response
  let createdManifest
  if (await pathExists(responsePath)) {
    await secureReadPath(projectRoot, responsePath)
    response = await readJson(responsePath)
    createdManifest = buildManifest(response, request, definitions, manifest.projectId)
    if (manifest.episodeMap !== undefined) assertEqual('formal run episode map', manifest.episodeMap, createdManifest.episodeMap)
    else if (requireEpisodeMap) throw new Error(`formal run episode map is missing: ${manifest.runId}`)
  } else if (requireCreateResponse) {
    throw new Error(`formal run create response is missing: ${manifest.runId}`)
  }
  if (manifest.episodeMap === undefined && requireEpisodeMap) throw new Error(`formal run episode map is missing: ${manifest.runId}`)
  if (manifest.episodeMap !== undefined) {
    for (const [episodeKey, mapping] of Object.entries(manifest.episodeMap)) {
      assertSafeIdentifier('manifest episodeKey', episodeKey)
      assertSafeIdentifier('manifest episodeId', mapping?.episodeId)
    }
  }
  return { definitions, rules, request, response, createdManifest }
}

async function commandFindLocalRun(projectRoot, options) {
  const projectId = required(options, 'project-id')
  assertSafeIdentifier('projectId', projectId)
  const sourcePath = insideProject(projectRoot, required(options, 'source-file'))
  await secureReadPath(projectRoot, sourcePath)
  const source = normalizeSourceText(await readFile(sourcePath, 'utf8'))
  const sourceHash = sha256Prefixed(source)
  const runsRoot = insideProject(projectRoot, options['runs-root'], '.waoo-agent/runs')
  const intakeRoot = insideProject(projectRoot, options['intake-root'], '.waoo-agent/intake')
  await secureWriteTarget(projectRoot, runsRoot)
  await secureWriteTarget(projectRoot, intakeRoot)
  const formal = []
  if (await pathExists(runsRoot)) {
    for (const name of await readdir(runsRoot)) {
      assertSafeIdentifier('run directory id', name)
      const runDir = safeChildPath(runsRoot, 'run directory id', name)
      if (!await stat(runDir).then((value) => value.isDirectory()).catch(() => false)) continue
      const manifestPath = path.join(runDir, 'manifest.json')
      if (!await pathExists(manifestPath)) continue
      await secureReadPath(projectRoot, manifestPath)
      const manifest = await readJson(manifestPath)
      if (manifest.projectId === projectId && manifest.sourceHash === sourceHash && optionFilterMatches(manifest, options)) {
        await validateFormalRunDirectory(projectRoot, runDir, manifest)
        if (await pathExists(path.join(runDir, 'receipts.json'))) await secureReadPath(projectRoot, path.join(runDir, 'receipts.json'))
        const receipts = await loadReceipts(runDir, manifest)
        const latestStatus = receipts.finalize?.data?.status ?? receipts.serverRun?.data?.status ?? receipts.snapshot?.data?.status ?? manifest.status
        if (latestStatus === COMPLETE_STATUS) continue
        formal.push({ status: 'resume', runId: manifest.runId, runFingerprint: manifest.runFingerprint, runDir })
      }
    }
  }
  const pending = []
  if (await pathExists(intakeRoot)) {
    for (const name of await readdir(intakeRoot)) {
      assertSafeIdentifier('intake fingerprint', name)
      const intakeDir = safeChildPath(intakeRoot, 'intake fingerprint', name)
      const requestPath = path.join(intakeDir, 'run-request.json')
      if (!await pathExists(requestPath)) continue
      for (const fileName of ['run-request.json', 'intake.json', 'source.md', 'definition.json', 'rules.json']) await secureReadPath(projectRoot, path.join(intakeDir, fileName))
      const request = await readJson(requestPath)
      for (const episode of request.episodes ?? []) assertSafeIdentifier('pending request episodeKey', episode.episodeKey)
      if (request.projectId !== undefined) throw new Error(`pending request contains forbidden projectId field: ${name}`)
      const intake = await readJson(path.join(intakeDir, 'intake.json'))
      if (intake.projectId !== projectId || request.sourceHash !== sourceHash || !optionFilterMatches({ ...request, status: 'created' }, options)) continue
      if (name !== request.runFingerprint || intake.runFingerprint !== request.runFingerprint) throw new Error(`pending intake fingerprint mismatch: ${name}`)
      const pinnedSource = normalizeSourceText(await readFile(path.join(intakeDir, 'source.md'), 'utf8'))
      if (sha256Prefixed(pinnedSource) !== request.sourceHash) throw new Error(`pending intake source hash mismatch: ${name}`)
      const definitions = await readJson(path.join(intakeDir, 'definition.json'))
      validateDefinitionSourceHashes(definitions, 'pending definition')
      const requestEpisodes = definitions.map(stripEpisodeSourceText)
      if (sha256Prefixed(requestEpisodes) !== request.definitionHash || !sameCanonical(requestEpisodes, request.episodes)) throw new Error(`pending intake definition hash mismatch: ${name}`)
      const rules = validateRuleSnapshot(await readJson(path.join(intakeDir, 'rules.json')))
      if (rules.contentHash !== request.ruleSetHash || rules.ruleSetVersion !== request.ruleSetVersion) throw new Error(`pending intake rule pin mismatch: ${name}`)
      const expectedFingerprint = sha256Prefixed({
        projectId,
        sourceHash: request.sourceHash,
        inputKindHint: request.inputKindHint,
        locale: request.locale,
        effectiveOptions: request.effectiveOptions,
        ruleSetHash: request.ruleSetHash,
      })
      if (expectedFingerprint !== request.runFingerprint) throw new Error(`pending intake fingerprint content mismatch: ${name}`)
      pending.push({ status: 'pending-create', runFingerprint: request.runFingerprint, intakeDir, requestPath })
    }
  }
  const candidates = [...formal, ...pending]
  if (candidates.length === 0) return { status: 'not-found', projectId, sourceHash }
  if (candidates.length > 1) return { status: 'ambiguous', projectId, sourceHash, candidates }
  return candidates[0]
}

function normalizeDefinitions(raw) {
  const values = Array.isArray(raw) ? raw : raw.episodes
  if (!Array.isArray(values) || values.length === 0) throw new Error('definition file must contain at least one episode')
  return values.map((episode, index) => {
    assertSafeIdentifier('episodeKey', episode.episodeKey)
    if (episode.ordinal !== index + 1) throw new Error('episode ordinals must be continuous from 1')
    const sourceText = normalizeSourceText(episode.sourceText)
    if (!sourceText) throw new Error(`definition episode ${episode.episodeKey} has empty sourceText`)
    const normalized = {
      episodeKey: episode.episodeKey,
      ordinal: episode.ordinal,
      sourceHash: sha256Prefixed(sourceText),
      sourceText,
      name: String(episode.name).trim(),
    }
    if (episode.description !== undefined) normalized.description = String(episode.description).trim()
    return normalized
  })
}

function buildManifest(response, request, definitions, expectedProjectId) {
  if (!response.runId || response.projectId === undefined || !response.status || !Array.isArray(response.episodes)) throw new Error('create-run response lacks runId/status/episode map')
  assertSafeIdentifier('create response runId', response.runId)
  assertSafeIdentifier('create response projectId', response.projectId)
  if (response.projectId !== expectedProjectId) throw new Error('create-run response projectId mismatch')
  if (response.sourceHash !== request.sourceHash || response.runFingerprint !== request.runFingerprint) throw new Error('create-run response source/fingerprint mismatch')
  const responseByKey = new Map(response.episodes.map((episode) => [episode.episodeKey, episode]))
  if (responseByKey.size !== definitions.length) throw new Error('create-run response episode map is incomplete')
  const episodeMap = {}
  for (const definition of definitions) {
    const episode = responseByKey.get(definition.episodeKey)
    if (episode) {
      assertSafeIdentifier('create response episodeKey', episode.episodeKey)
      assertSafeIdentifier('create response episodeId', episode.episodeId)
    }
    if (!episode || !episode.episodeId || !Number.isInteger(episode.episodeNumber)) throw new Error(`create-run response missing episode map: ${definition.episodeKey}`)
    if (episode.name !== definition.name) throw new Error(`create-run response episode name mismatch: ${definition.episodeKey}`)
    episodeMap[definition.episodeKey] = { episodeId: episode.episodeId, episodeNumber: episode.episodeNumber }
  }
  return {
    manifestVersion: 1,
    schemaVersion: 1,
    runId: response.runId,
    projectId: response.projectId,
    status: response.status,
    currentStage: response.status,
    sourceHash: request.sourceHash,
    runFingerprint: request.runFingerprint,
    ruleSetVersion: request.ruleSetVersion,
    ruleSetHash: request.ruleSetHash,
    inputKindHint: request.inputKindHint,
    locale: request.locale,
    effectiveOptions: request.effectiveOptions,
    definitionHash: request.definitionHash,
    episodeDefinitions: definitions.map(stripEpisodeSourceText),
    episodeMap,
    visualBible: {},
    stages: {},
    images: {},
  }
}

async function prepareIntake({ projectRoot, intakeDir, source, definitions, rules, request, projectId }) {
  await secureWriteTarget(projectRoot, intakeDir)
  if (await pathExists(intakeDir)) {
    for (const fileName of ['run-request.json', 'definition.json', 'rules.json', 'source.md']) await secureReadPath(projectRoot, path.join(intakeDir, fileName))
    assertEqual('pending run request', await readJson(path.join(intakeDir, 'run-request.json')), request)
    assertEqual('pending definitions', await readJson(path.join(intakeDir, 'definition.json')), definitions)
    assertEqual('pending rules', await readJson(path.join(intakeDir, 'rules.json')), rules)
    const storedSource = await readFile(path.join(intakeDir, 'source.md'), 'utf8')
    if (storedSource !== source) throw new Error('pending source mismatch; refusing to reuse intake')
    return false
  }
  await mkdir(path.dirname(intakeDir), { recursive: true })
  const temporaryDir = path.join(path.dirname(intakeDir), `.${path.basename(intakeDir)}.${process.pid}.${randomUUID()}.tmp`)
  await secureWriteTarget(projectRoot, temporaryDir)
  await mkdir(temporaryDir, { recursive: false })
  try {
    await writeProjectText(projectRoot, path.join(temporaryDir, 'source.md'), source)
    await atomicWriteProjectJson(projectRoot, path.join(temporaryDir, 'definition.json'), definitions)
    await atomicWriteProjectJson(projectRoot, path.join(temporaryDir, 'rules.json'), rules)
    await atomicWriteProjectJson(projectRoot, path.join(temporaryDir, 'run-request.json'), request)
    await atomicWriteProjectJson(projectRoot, path.join(temporaryDir, 'intake.json'), {
      intakeVersion: 1,
      projectId,
      sourceHash: request.sourceHash,
      definitionHash: request.definitionHash,
      ruleSetHash: request.ruleSetHash,
      runFingerprint: request.runFingerprint,
      effectiveOptions: request.effectiveOptions,
      createdAt: new Date().toISOString(),
    })
    await rename(temporaryDir, intakeDir)
    return true
  } catch (error) {
    await rm(temporaryDir, { recursive: true, force: true })
    throw error
  }
}

async function commandCreateRun(config, projectRoot, options) {
  const projectId = required(options, 'project-id')
  assertSafeIdentifier('projectId', projectId)
  const sourcePath = insideProject(projectRoot, required(options, 'source-file'))
  const definitionPath = insideProject(projectRoot, required(options, 'definition-file'))
  const rulesPath = insideProject(projectRoot, required(options, 'rules-file'))
  await secureReadPath(projectRoot, sourcePath)
  await secureReadPath(projectRoot, definitionPath)
  await secureReadPath(projectRoot, rulesPath)
  const source = normalizeSourceText(await readFile(sourcePath, 'utf8'))
  const definitions = normalizeDefinitions(await readJson(definitionPath))
  const rules = validateRuleSnapshot(await readJson(rulesPath))
  const inputKindHint = options['input-kind-hint'] ?? 'auto'
  const locale = options.locale ?? 'zh'
  const effectiveOptions = {
    artStyle: options['art-style-override'] ?? rules.projectSettings.artStyle,
    videoRatio: options['video-ratio-override'] ?? rules.projectSettings.videoRatio,
    episodeSplitHint: options['episode-split-hint'] ?? 'auto',
  }
  const episodes = definitions.map(stripEpisodeSourceText)
  const sourceHash = sha256Prefixed(source)
  const definitionHash = sha256Prefixed(episodes)
  const runFingerprint = sha256Prefixed({ projectId, sourceHash, inputKindHint, locale, effectiveOptions, ruleSetHash: rules.contentHash })
  const request = { schemaVersion: 1, sourceHash, runFingerprint, inputKindHint, locale, effectiveOptions, ruleSetVersion: rules.ruleSetVersion, ruleSetHash: rules.contentHash, definitionHash, episodes }
  const intakeRoot = insideProject(projectRoot, options['intake-root'], '.waoo-agent/intake')
  const runsRoot = insideProject(projectRoot, options['runs-root'], '.waoo-agent/runs')
  await secureWriteTarget(projectRoot, intakeRoot)
  await secureWriteTarget(projectRoot, runsRoot)
  const intakeDir = safeChildPath(intakeRoot, 'runFingerprint', runFingerprint)
  const createdIntake = await prepareIntake({ projectRoot, intakeDir, source, definitions, rules, request, projectId })
  let response
  try {
    response = await requestJson(config, endpoint('projects', projectId, 'runs'), { method: 'POST', body: await readJson(path.join(intakeDir, 'run-request.json')), idempotencyKey: runFingerprint })
  } catch (error) {
    if (!createdIntake && error.code === 'AGENT_RULE_MISMATCH') {
      error.message = `${error.message}; pinned intake retained—create a new stage-0 fingerprint instead of mixing rules`
    }
    throw error
  }
  await atomicWriteProjectJson(projectRoot, path.join(intakeDir, 'create-run-response.json'), response)
  const manifest = buildManifest(response, request, definitions, projectId)
  await atomicWriteProjectJson(projectRoot, path.join(intakeDir, 'manifest.json'), manifest)
  const roundTripManifest = await readJson(path.join(intakeDir, 'manifest.json'))
  assertEqual('preflight manifest', roundTripManifest, manifest)
  const runDir = safeChildPath(runsRoot, 'runId', response.runId)
  await secureWriteTarget(projectRoot, runDir)
  await mkdir(runsRoot, { recursive: true })
  if (!await pathExists(runDir)) {
    await rename(intakeDir, runDir)
  } else {
    const existing = await readJson(path.join(runDir, 'manifest.json'))
    await validateFormalRunDirectory(projectRoot, runDir, existing, { requireCreateResponse: false, requireEpisodeMap: false })
    for (const key of ['runId', 'projectId', 'sourceHash', 'runFingerprint', 'ruleSetVersion', 'ruleSetHash', 'definitionHash']) {
      if (existing[key] !== manifest[key]) throw new Error(`existing run manifest ${key} mismatch; refusing to overwrite`)
    }
    if (existing.episodeMap !== undefined) assertEqual('existing run episode map', existing.episodeMap, manifest.episodeMap)
    assertEqual('existing run definitions', existing.episodeDefinitions, manifest.episodeDefinitions)
    assertEqual('existing run rules', await readJson(path.join(runDir, 'rules.json')), rules)
    const responsePath = path.join(runDir, 'create-run-response.json')
    if (!await pathExists(responsePath)) await atomicWriteProjectJson(projectRoot, responsePath, response)
    if (existing.episodeMap === undefined) await atomicWriteProjectJson(projectRoot, path.join(runDir, 'manifest.json'), { ...existing, episodeMap: manifest.episodeMap })
    await validateFormalRunDirectory(projectRoot, runDir, await readJson(path.join(runDir, 'manifest.json')))
    if (createdIntake) await rm(intakeDir, { recursive: true, force: true })
  }
  if (!await pathExists(path.join(runDir, 'receipts.json'))) await atomicWriteProjectJson(projectRoot, path.join(runDir, 'receipts.json'), { receiptVersion: 1, runId: response.runId, projectId: response.projectId, artifacts: {}, uploads: {} })
  return { runId: response.runId, resumed: response.resumed, runFingerprint, runDir, episodeMap: manifest.episodeMap }
}

function validateRunPins(manifest, server) {
  assertSafeIdentifier('server runId', server?.runId)
  assertSafeIdentifier('server projectId', server?.projectId)
  for (const episode of server?.episodes ?? []) {
    assertSafeIdentifier('server episodeKey', episode.episodeKey)
    assertSafeIdentifier('server episodeId', episode.episodeId)
  }
  for (const key of ['runId', 'projectId', 'sourceHash', 'runFingerprint', 'ruleSetVersion', 'ruleSetHash']) {
    if (manifest[key] !== server[key]) throw new Error(`server run ${key} does not match pinned manifest`)
  }
}

async function loadBoundManifest(projectRoot, runDir, runId) {
  if (path.basename(runDir) !== runId) throw new Error('run-id does not match run-dir basename')
  await secureReadPath(projectRoot, runDir, { regularFile: false })
  await secureReadPath(projectRoot, path.join(runDir, 'manifest.json'))
  return validateManifestRunId(await readJson(path.join(runDir, 'manifest.json')), runId)
}

function serverStateSequence(value) {
  return Number.isSafeInteger(value) && value >= 0 ? value : 0
}

async function reserveServerStateRequest(projectRoot, runDir, current) {
  const manifestPath = path.join(runDir, 'manifest.json')
  return withFileLock(projectRoot, manifestPath, async () => {
    await secureWriteTarget(projectRoot, manifestPath)
    const latest = await readJson(manifestPath)
    if (latest.runId !== current.runId || latest.projectId !== current.projectId) throw new Error('manifest identity changed while waiting for lock')
    const clientState = { ...(latest.clientState ?? {}) }
    const requestSeq = serverStateSequence(clientState.serverStateRequestSeq) + 1
    clientState.serverStateRequestSeq = requestSeq
    clientState.serverStateAppliedSeq = serverStateSequence(clientState.serverStateAppliedSeq)
    const updated = { ...latest, clientState }
    await atomicWriteProjectJson(projectRoot, manifestPath, updated)
    return requestSeq
  })
}

async function updateManifest(projectRoot, runDir, current, patch, requestSeq) {
  const manifestPath = path.join(runDir, 'manifest.json')
  return withFileLock(projectRoot, manifestPath, async () => {
    await secureWriteTarget(projectRoot, manifestPath)
    const latest = await readJson(manifestPath)
    if (latest.runId !== current.runId || latest.projectId !== current.projectId) throw new Error('manifest identity changed while waiting for lock')
    const clientState = { ...(latest.clientState ?? {}) }
    const appliedSeq = serverStateSequence(clientState.serverStateAppliedSeq)
    if (requestSeq < appliedSeq) return latest
    clientState.serverStateRequestSeq = Math.max(serverStateSequence(clientState.serverStateRequestSeq), requestSeq)
    clientState.serverStateAppliedSeq = requestSeq
    const updated = { ...latest, ...patch, clientState }
    await atomicWriteProjectJson(projectRoot, manifestPath, updated)
    return updated
  })
}

async function commandGetRun(config, projectRoot, options) {
  const runId = required(options, 'run-id')
  assertSafeIdentifier('runId', runId)
  const runDir = insideProject(projectRoot, required(options, 'run-dir'))
  const manifest = await loadBoundManifest(projectRoot, runDir, runId)
  const requestSeq = await reserveServerStateRequest(projectRoot, runDir, manifest)
  const server = await requestJson(config, endpoint('runs', runId))
  validateRunPins(manifest, server)
  await saveReceipt(projectRoot, runDir, manifest, (receipts) => {
    if (requestSeq >= serverStateSequence(receipts.serverRun?.serverStateRequestSeq)) {
      receipts.serverRun = { data: server, receivedAt: new Date().toISOString(), serverStateRequestSeq: requestSeq }
    }
  })
  await updateManifest(projectRoot, runDir, manifest, { status: server.status, currentStage: server.currentStage }, requestSeq)
  return server
}

function artifactFor(command, aggregate, episodeKey) {
  if (command === 'commit-assets') return aggregate
  if (!episodeKey) throw new Error('--episode-key is required')
  const artifact = aggregate[episodeKey]
  if (!artifact) throw new Error(`artifact not found for episode-key ${episodeKey}`)
  return artifact
}

const COMMIT_PATH = {
  'commit-story': (runId, key) => endpoint('runs', runId, 'episodes', key, 'story'),
  'commit-assets': (runId) => endpoint('runs', runId, 'assets'),
  'commit-screenplay': (runId, key) => endpoint('runs', runId, 'episodes', key, 'screenplay'),
  'commit-storyboards': (runId, key) => endpoint('runs', runId, 'episodes', key, 'storyboards'),
}

const RECEIPT_COLLECTION = {
  'commit-story': 'stories',
  'commit-assets': 'assets',
  'commit-screenplay': 'screenplays',
  'commit-storyboards': 'storyboards',
}

async function commandCommit(config, projectRoot, command, options) {
  const runId = required(options, 'run-id')
  assertSafeIdentifier('runId', runId)
  const runDir = insideProject(projectRoot, required(options, 'run-dir'))
  const manifest = await loadBoundManifest(projectRoot, runDir, runId)
  const artifactPath = insideProject(projectRoot, required(options, 'artifact-file'))
  await secureReadPath(projectRoot, artifactPath)
  if (options['episode-key']) assertSafeIdentifier('episodeKey', options['episode-key'])
  const artifact = artifactFor(command, await readJson(artifactPath), options['episode-key'])
  const artifactHash = sha256Prefixed(artifact)
  const dryRun = options.commit !== true
  const body = { schemaVersion: 1, ruleSetVersion: manifest.ruleSetVersion, ruleSetHash: manifest.ruleSetHash, artifactHash, dryRun, data: artifact }
  const envelope = await requestJson(config, COMMIT_PATH[command](runId, options['episode-key']), { method: 'PUT', body, idempotencyKey: artifactHash, returnEnvelope: true })
  if (envelope.data?.artifactHash !== artifactHash || envelope.data?.dryRun !== dryRun) throw new Error(`${command} response hash/dryRun mismatch`)
  if (!dryRun) {
    await saveReceipt(projectRoot, runDir, manifest, (receipts) => {
      const collection = RECEIPT_COLLECTION[command]
      const value = { artifactHash, data: envelope.data, requestId: envelope.requestId, committedAt: new Date().toISOString() }
      if (command === 'commit-assets') receipts.artifacts.assets = value
      else {
        receipts.artifacts[collection] ??= {}
        const existing = receipts.artifacts[collection][options['episode-key']]
        if (existing && existing.artifactHash !== artifactHash) throw new Error('existing committed receipt hash mismatch')
        receipts.artifacts[collection][options['episode-key']] = existing ?? value
      }
    })
  }
  return { dryRun, artifactHash, data: envelope.data }
}

function mimeForFile(filePath) {
  const extension = path.extname(filePath).toLowerCase()
  if (extension === '.jpg' || extension === '.jpeg') return 'image/jpeg'
  if (extension === '.webp') return 'image/webp'
  if (extension === '.png') return 'image/png'
  throw new Error('upload file must be PNG, JPEG, or WEBP')
}

async function commandUpload(config, projectRoot, options) {
  const runId = required(options, 'run-id')
  assertSafeIdentifier('runId', runId)
  const runDir = insideProject(projectRoot, required(options, 'run-dir'))
  const manifest = await loadBoundManifest(projectRoot, runDir, runId)
  const filePath = insideProject(projectRoot, required(options, 'file'))
  await secureReadPath(projectRoot, filePath)
  const targetType = required(options, 'target-type')
  if (!['character-appearance', 'location-image', 'prop-image', 'panel-frame'].includes(targetType)) throw new Error('--target-type is invalid')
  const targetKey = required(options, 'target-key')
  assertSafeIdentifier('targetKey', targetKey)
  const variantIndex = Number(options['variant-index'] ?? 0)
  if (!Number.isInteger(variantIndex) || variantIndex < 0) throw new Error('--variant-index must be a nonnegative integer')
  const fileInfo = await stat(filePath)
  if (!fileInfo.isFile()) throw new Error('upload path must be a regular file')
  if (fileInfo.size > config.uploadMaxBytes) throw new Error(`upload exceeds maximum ${config.uploadMaxBytes} bytes`)
  const bytes = await readFile(filePath)
  if (bytes.length > config.uploadMaxBytes) throw new Error(`upload exceeds maximum ${config.uploadMaxBytes} bytes after read`)
  const contentSha256 = sha256Prefixed(bytes)
  const idempotencyKey = sha256Prefixed({ runId, targetType, targetKey, variantIndex, contentSha256 })
  const form = new FormData()
  form.set('targetType', targetType)
  form.set('targetKey', targetKey)
  form.set('variantIndex', String(variantIndex))
  form.set('contentSha256', contentSha256)
  form.set('file', new Blob([bytes], { type: mimeForFile(filePath) }), path.basename(filePath))
  const envelope = await requestJson(config, endpoint('runs', runId, 'uploads'), { method: 'POST', body: form, idempotencyKey, returnEnvelope: true })
  for (const [key, expected] of Object.entries({ runId, targetType, targetKey, variantIndex, contentSha256 })) {
    if (envelope.data?.[key] !== expected) throw new Error(`upload response ${key} mismatch`)
  }
  const receiptKey = canonicalJson({ targetType, targetKey, variantIndex, contentSha256 })
  await saveReceipt(projectRoot, runDir, manifest, (receipts) => {
    const existing = receipts.uploads[receiptKey]
    const value = { contentSha256, targetType, targetKey, variantIndex, data: envelope.data, requestId: envelope.requestId, uploadedAt: new Date().toISOString() }
    if (existing && !sameCanonical(existing.data, value.data)) throw new Error('upload receipt conflict')
    receipts.uploads[receiptKey] = existing ?? value
  })
  return { contentSha256, idempotencyKey, data: envelope.data }
}

async function commandSnapshot(config, projectRoot, options) {
  const runId = required(options, 'run-id')
  assertSafeIdentifier('runId', runId)
  const runDir = insideProject(projectRoot, required(options, 'run-dir'))
  const manifest = await loadBoundManifest(projectRoot, runDir, runId)
  const requestSeq = await reserveServerStateRequest(projectRoot, runDir, manifest)
  const envelope = await requestJson(config, endpoint('runs', runId, 'snapshot'), { returnEnvelope: true })
  if (envelope.data?.runId !== runId) throw new Error('snapshot response runId mismatch')
  await saveReceipt(projectRoot, runDir, manifest, (receipts) => {
    if (requestSeq >= serverStateSequence(receipts.snapshot?.serverStateRequestSeq)) {
      receipts.snapshot = { data: envelope.data, requestId: envelope.requestId, receivedAt: new Date().toISOString(), serverStateRequestSeq: requestSeq }
    }
  })
  await updateManifest(projectRoot, runDir, manifest, { status: envelope.data.status }, requestSeq)
  return envelope.data
}

function receiptHashMap(collection = {}) {
  return Object.fromEntries(Object.entries(collection).map(([key, receipt]) => {
    assertSafeIdentifier('receipt episodeKey', key)
    if (!SHA256_PATTERN.test(receipt?.artifactHash ?? '')) throw new Error(`committed receipt is missing artifactHash: ${key}`)
    return [key, receipt.artifactHash]
  }))
}

async function commandFinalize(config, projectRoot, options) {
  const runId = required(options, 'run-id')
  assertSafeIdentifier('runId', runId)
  const runDir = insideProject(projectRoot, required(options, 'run-dir'))
  const manifest = await loadBoundManifest(projectRoot, runDir, runId)
  const receipts = await loadReceipts(runDir, manifest)
  const assets = receipts.artifacts?.assets?.artifactHash
  if (!SHA256_PATTERN.test(assets ?? '')) throw new Error('assets committed receipt is required before finalize')
  const body = {
    schemaVersion: 1,
    ruleSetHash: manifest.ruleSetHash,
    expected: {
      assets,
      stories: receiptHashMap(receipts.artifacts?.stories),
      screenplays: receiptHashMap(receipts.artifacts?.screenplays),
      storyboards: receiptHashMap(receipts.artifacts?.storyboards),
    },
  }
  const requestSeq = await reserveServerStateRequest(projectRoot, runDir, manifest)
  const idempotencyKey = sha256Prefixed(body)
  const envelope = await requestJson(config, endpoint('runs', runId, 'finalize'), { method: 'POST', body, idempotencyKey, returnEnvelope: true })
  if (envelope.data?.runId !== runId || envelope.data?.status !== COMPLETE_STATUS) throw new Error('finalize response runId/status mismatch')
  await saveReceipt(projectRoot, runDir, manifest, (current) => { current.finalize = { expected: body.expected, data: envelope.data, requestId: envelope.requestId, finalizedAt: new Date().toISOString(), serverStateRequestSeq: requestSeq } })
  await updateManifest(projectRoot, runDir, manifest, { status: COMPLETE_STATUS, currentStage: COMPLETE_STATUS, completedAt: envelope.data.completedAt }, requestSeq)
  return envelope.data
}

async function runCliUnsafe(argv = process.argv.slice(2), context = {}) {
  const { command, options } = parseArgs(argv)
  if (!command) throw new Error('a command is required')
  const projectRoot = await resolveProjectRoot({ explicitRoot: options['project-root'], env: context.env ?? process.env, cwd: context.cwd ?? process.cwd() })
  if (command === 'resolve-project' || command === 'doctor' || command === 'fetch-rules' || command === 'create-run' || command === 'get-run' || command.startsWith('commit-') || command === 'upload' || command === 'snapshot' || command === 'finalize') {
    var config = resolveConfig(context.env ?? process.env, context.configOverrides)
  }
  let result
  switch (command) {
    case 'doctor': result = await commandDoctor(config); break
    case 'resolve-project': result = await commandResolveProject(config, options); break
    case 'fetch-rules': result = await commandFetchRules(config, projectRoot, options); break
    case 'find-local-run': result = await commandFindLocalRun(projectRoot, options); break
    case 'create-run': result = await commandCreateRun(config, projectRoot, options); break
    case 'get-run': result = await commandGetRun(config, projectRoot, options); break
    case 'commit-story':
    case 'commit-assets':
    case 'commit-screenplay':
    case 'commit-storyboards': result = await commandCommit(config, projectRoot, command, options); break
    case 'upload': result = await commandUpload(config, projectRoot, options); break
    case 'snapshot': result = await commandSnapshot(config, projectRoot, options); break
    case 'finalize': result = await commandFinalize(config, projectRoot, options); break
    default: throw new Error(`unknown command: ${command}`)
  }
  if (context.print === true) process.stdout.write(`${JSON.stringify(result, null, 2)}\n`)
  return result
}

export async function runCli(argv = process.argv.slice(2), context = {}) {
  try {
    return await runCliUnsafe(argv, context)
  } catch (error) {
    const env = context.env ?? process.env
    error.message = sanitizeMessage(error.message, env.WAOO_AGENT_TOKEN, env.WAOO_AGENT_USER_ID)
    if (error.code) error.code = sanitizeMessage(error.code, env.WAOO_AGENT_TOKEN, env.WAOO_AGENT_USER_ID)
    if (error.field) error.field = sanitizeMessage(error.field, env.WAOO_AGENT_TOKEN, env.WAOO_AGENT_USER_ID)
    if (error.requestId) error.requestId = sanitizeMessage(error.requestId, env.WAOO_AGENT_TOKEN, env.WAOO_AGENT_USER_ID)
    throw error
  }
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
if (isMain) {
  runCli(process.argv.slice(2), { print: true }).catch((error) => {
    const safe = {
      success: false,
      error: {
        code: sanitizeMessage(error.code ?? 'CLIENT_ERROR', process.env.WAOO_AGENT_TOKEN, process.env.WAOO_AGENT_USER_ID),
        message: sanitizeMessage(error.message, process.env.WAOO_AGENT_TOKEN, process.env.WAOO_AGENT_USER_ID),
        ...(error.field ? { field: sanitizeMessage(error.field, process.env.WAOO_AGENT_TOKEN, process.env.WAOO_AGENT_USER_ID) } : {}),
        ...(error.requestId ? { requestId: sanitizeMessage(error.requestId, process.env.WAOO_AGENT_TOKEN, process.env.WAOO_AGENT_USER_ID) } : {}),
      },
    }
    process.stderr.write(`${JSON.stringify(safe)}\n`)
    process.exitCode = 1
  })
}
