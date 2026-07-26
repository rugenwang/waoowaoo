#!/usr/bin/env node

import fs from 'node:fs'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

const AGENT_ROOTS = [
  'src/app/api/agent',
  'src/lib/agent-api',
]

const CODE_TOKENS = [
  'maybeSubmitLLMTask',
  'executeAiTextStep',
  'createTask',
  'submitTaskWithBilling',
  'submitTask',
  'llmApiKey',
  'falApiKey',
  'googleAiKey',
  'arkApiKey',
  'qwenApiKey',
]

const IMPORT_PREFIXES = [
  '@/lib/model-gateway',
  '@/lib/llm',
  '@/lib/providers',
  '@/lib/workers',
  '@/lib/run-runtime',
  '@/lib/config-service',
  '@/lib/task',
  '@/lib/task-queue',
  '@/lib/ai-runtime',
  '@/lib/llm-observe',
]

const PROTECTED_PRISMA_MODELS = [
  'task',
  'taskEvent',
  'graphRun',
  'usageCost',
]

const PRISMA_WRITE_METHODS = [
  'create',
  'createMany',
  'createManyAndReturn',
  'update',
  'updateMany',
  'updateManyAndReturn',
  'upsert',
  'delete',
  'deleteMany',
]

const LEGACY_ROUTE_PATTERNS = [
  {
    token: '/api/novel-promotion/*/generate-image',
    pattern: /\/api\/novel-promotion\/[^/'"`\s]+\/(?:generate-image|generate-character-image|regenerate-(?:panel-frame-image|panel-image|single-image)|modify-(?:asset-image|storyboard-image))/,
  },
  {
    token: '/api/novel-promotion/*/generate-video',
    pattern: /\/api\/novel-promotion\/[^/'"`\s]+\/(?:generate-video|lip-sync|regenerate-video-prompt)/,
  },
  {
    token: '/api/novel-promotion/*/ai-*',
    pattern: /\/api\/novel-promotion\/[^/'"`\s]+\/(?:ai-[^/'"`\s]+|analyze(?:-[^/'"`\s]+)?|story-to-script-stream|script-to-storyboard-stream|screenplay-conversion)/,
  },
  {
    token: '/api/asset-hub/generate-image',
    pattern: /\/api\/asset-hub\/(?:generate-image|modify-image|ai-[^/'"`\s]+|reference-to-character)/,
  },
  {
    token: '/api/user/ai-*',
    pattern: /\/api\/user\/ai-[^/'"`\s]+/,
  },
]

function normalizeRepoPath(file) {
  return file.split(path.sep).join('/').replace(/^\.\//, '')
}

function isAgentSource(file) {
  const normalized = normalizeRepoPath(file)
  return AGENT_ROOTS.some((root) => normalized === root || normalized.startsWith(`${root}/`))
}

function lineForOffset(content, offset) {
  return content.slice(0, offset).split('\n').length
}

function tokenPattern(token) {
  return new RegExp(`\\b${token.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`)
}

function moduleSpecifiers(content, codeOnly) {
  const matches = []
  const patterns = [
    /\b(?:import|export)\s+(?:type\s+)?(?:[^'";]*?\s+from\s*)?(['"])([^'"\r\n]+)\1/g,
    /\b(?:import|require)\s*\(\s*(['"])([^'"\r\n]+)\1\s*\)/g,
  ]

  for (const pattern of patterns) {
    for (const match of content.matchAll(pattern)) {
      // The specifier string remains visible in content, but the import keyword
      // must itself remain visible in codeOnly so ordinary strings are ignored.
      if (!/[A-Za-z_$]/.test(codeOnly[match.index] ?? '')) continue
      matches.push({ index: match.index, specifier: match[2] })
    }
  }
  return matches
}

function forbiddenImportToken(file, specifier) {
  let resolved
  if (specifier.startsWith('@/')) {
    resolved = `src/${specifier.slice(2)}`
  } else if (specifier.startsWith('.')) {
    resolved = path.posix.normalize(path.posix.join(path.posix.dirname(file), specifier))
  } else {
    return null
  }

  for (const prefix of IMPORT_PREFIXES) {
    const protectedRoot = prefix.replace(/^@\//, 'src/')
    if (
      resolved === protectedRoot
      || resolved.startsWith(`${protectedRoot}/`)
      || resolved.startsWith(`${protectedRoot}.`)
    ) return prefix
  }
  return null
}

function maskIgnoredSyntax(content, maskStrings) {
  const chars = content.split('')
  let state = 'code'
  let escaped = false

  const mask = (index) => {
    if (chars[index] !== '\n' && chars[index] !== '\r') chars[index] = ' '
  }

  for (let index = 0; index < chars.length; index += 1) {
    const current = chars[index]
    const next = chars[index + 1]

    if (state === 'line-comment') {
      if (current === '\n' || current === '\r') state = 'code'
      else mask(index)
      continue
    }
    if (state === 'block-comment') {
      if (current === '*' && next === '/') {
        mask(index)
        mask(index + 1)
        index += 1
        state = 'code'
      } else {
        mask(index)
      }
      continue
    }
    if (state !== 'code') {
      const closing = state === 'single-string'
        ? "'"
        : state === 'double-string'
          ? '"'
          : '`'
      if (maskStrings) mask(index)
      if (escaped) {
        escaped = false
      } else if (current === '\\') {
        escaped = true
      } else if (current === closing) {
        state = 'code'
      }
      continue
    }

    if (current === '/' && next === '/') {
      mask(index)
      mask(index + 1)
      index += 1
      state = 'line-comment'
    } else if (current === '/' && next === '*') {
      mask(index)
      mask(index + 1)
      index += 1
      state = 'block-comment'
    } else if (current === "'" || current === '"' || current === '`') {
      state = current === "'"
        ? 'single-string'
        : current === '"'
          ? 'double-string'
          : 'template-string'
      if (maskStrings) mask(index)
    }
  }

  return chars.join('')
}

function protectedPrismaWritePattern() {
  const models = PROTECTED_PRISMA_MODELS.join('|')
  const methods = PRISMA_WRITE_METHODS.join('|')
  return new RegExp(
    `\\b([A-Za-z_$][\\w$]*)\\s*\\.\\s*(${models})\\s*\\.\\s*(${methods})\\s*\\(`,
    'g',
  )
}

function protectedDelegateAssignmentPattern() {
  const models = PROTECTED_PRISMA_MODELS.join('|')
  return new RegExp(
    `\\b[A-Za-z_$][\\w$]*\\s*=\\s*([A-Za-z_$][\\w$]*)\\s*\\.\\s*(${models})\\b`,
    'g',
  )
}

function protectedDelegateDestructurePattern() {
  return /(?:\b(?:const|let|var)\s*|\(\s*)\{([^{}]*)\}\s*=\s*([A-Za-z_$][\w$]*)\b/g
}

function protectedBracketDelegatePattern() {
  const models = PROTECTED_PRISMA_MODELS.join('|')
  return new RegExp(
    `\\b([A-Za-z_$][\\w$]*)\\s*\\[\\s*(['\"])(${models})\\2\\s*\\]`,
    'g',
  )
}

function skipWhitespace(content, start) {
  let cursor = start
  while (/\s/.test(content[cursor] ?? '')) cursor += 1
  return cursor
}

function readQuotedBody(content, start) {
  const quote = content[start]
  if (quote !== "'" && quote !== '"' && quote !== '`') return null

  let escaped = false
  for (let cursor = start + 1; cursor < content.length; cursor += 1) {
    const current = content[cursor]
    if (escaped) {
      escaped = false
    } else if (current === '\\') {
      escaped = true
    } else if (current === quote) {
      return content.slice(start + 1, cursor)
    }
  }
  return null
}

function isSingleStaticSelect(sql) {
  const normalized = sql.trimStart()
  return /^SELECT\b/i.test(normalized) && !normalized.includes(';')
}

function isSafeRawSelect(content, methodIndex, method) {
  let cursor = skipWhitespace(content, methodIndex + method.length)
  if (content[cursor] !== '(') return false
  cursor = skipWhitespace(content, cursor + 1)

  if (method === '$queryRaw') {
    if (!content.startsWith('Prisma.sql', cursor)) return false
    cursor = skipWhitespace(content, cursor + 'Prisma.sql'.length)
    if (content[cursor] !== '`') return false
  } else if (method === '$queryRawUnsafe') {
    if (!['"', "'", '`'].includes(content[cursor])) return false
  } else {
    return false
  }

  const sql = readQuotedBody(content, cursor)
  return sql !== null && isSingleStaticSelect(sql)
}

export function inspectAgentGenerationBypass(file, content) {
  const normalizedFile = normalizeRepoPath(file)
  if (!isAgentSource(normalizedFile)) return []

  const codeOnly = maskIgnoredSyntax(content, true)
  const withoutComments = maskIgnoredSyntax(content, false)
  const violations = []
  for (const token of CODE_TOKENS) {
    const match = tokenPattern(token).exec(codeOnly)
    if (!match) continue
    violations.push({
      file: normalizedFile,
      line: lineForOffset(content, match.index),
      token,
    })
  }
  for (const match of moduleSpecifiers(withoutComments, codeOnly)) {
    const token = forbiddenImportToken(normalizedFile, match.specifier)
    if (!token) continue
    violations.push({
      file: normalizedFile,
      line: lineForOffset(content, match.index),
      token,
    })
  }
  for (const match of codeOnly.matchAll(protectedPrismaWritePattern())) {
    violations.push({
      file: normalizedFile,
      line: lineForOffset(content, match.index),
      token: `${match[1]}.${match[2]}.${match[3]}`,
    })
  }
  for (const match of codeOnly.matchAll(protectedDelegateAssignmentPattern())) {
    violations.push({
      file: normalizedFile,
      line: lineForOffset(content, match.index),
      token: `${match[1]}.${match[2]}`,
    })
  }
  for (const match of codeOnly.matchAll(protectedDelegateDestructurePattern())) {
    for (const model of PROTECTED_PRISMA_MODELS) {
      if (!new RegExp(`(?:^|,)\\s*${model}\\b`).test(match[1])) continue
      violations.push({
        file: normalizedFile,
        line: lineForOffset(content, match.index),
        token: `${match[2]}.${model}`,
      })
    }
  }
  for (const match of withoutComments.matchAll(protectedBracketDelegatePattern())) {
    violations.push({
      file: normalizedFile,
      line: lineForOffset(content, match.index),
      token: `${match[1]}['${match[3]}']`,
    })
  }
  const rawExecutionPattern = /\$(?:executeRaw(?:Unsafe)?|queryRaw(?:Unsafe)?)\b/g
  for (const match of codeOnly.matchAll(rawExecutionPattern)) {
    if (isSafeRawSelect(withoutComments, match.index, match[0])) continue
    violations.push({
      file: normalizedFile,
      line: lineForOffset(content, match.index),
      token: match[0],
    })
  }
  for (const legacyRoute of LEGACY_ROUTE_PATTERNS) {
    const match = legacyRoute.pattern.exec(withoutComments)
    if (!match) continue
    violations.push({
      file: normalizedFile,
      line: lineForOffset(content, match.index),
      token: legacyRoute.token,
    })
  }

  return violations.sort((left, right) => left.line - right.line || left.token.localeCompare(right.token))
}

function walkSourceFiles(root, relativeRoot, output = []) {
  const absoluteRoot = path.join(root, relativeRoot)
  if (!fs.existsSync(absoluteRoot)) return output

  for (const entry of fs.readdirSync(absoluteRoot, { withFileTypes: true })) {
    const relativeFile = path.posix.join(relativeRoot, entry.name)
    if (entry.isDirectory()) {
      walkSourceFiles(root, relativeFile, output)
    } else if (entry.isFile() && /\.[cm]?[jt]sx?$/.test(entry.name)) {
      output.push(relativeFile)
    }
  }
  return output
}

export function scanAgentGenerationBypass(root = process.cwd()) {
  const files = AGENT_ROOTS.flatMap((agentRoot) => walkSourceFiles(root, agentRoot))
  return files.flatMap((file) => inspectAgentGenerationBypass(
    file,
    fs.readFileSync(path.join(root, file), 'utf8'),
  ))
}

function run() {
  const violations = scanAgentGenerationBypass()
  if (violations.length > 0) {
    console.error('\n[no-agent-api-generation-bypass] Agent data-only boundary violations:')
    for (const violation of violations) {
      console.error(`  - ${violation.file}:${violation.line} forbidden token: ${violation.token}`)
    }
    process.exitCode = 1
    return
  }

  console.log('[no-agent-api-generation-bypass] OK: Agent API remains data-only')
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  run()
}
