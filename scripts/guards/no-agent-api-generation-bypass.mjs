#!/usr/bin/env node

import fs from 'node:fs'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

const AGENT_ROOTS = [
  'src/app/api/agent',
  'src/lib/agent-api',
]

const EXACT_TOKENS = [
  'maybeSubmitLLMTask',
  'executeAiTextStep',
  'createTask',
  'submitTaskWithBilling',
  'submitTask',
  '@/lib/model-gateway',
  '@/lib/llm',
  '@/lib/providers',
  '@/lib/workers',
  '@/lib/run-runtime',
  '@/lib/config-service',
  'llmApiKey',
  'falApiKey',
  'googleAiKey',
  'arkApiKey',
  'qwenApiKey',
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
  if (token.startsWith('@/')) {
    return new RegExp(`${token.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?:/|['\"])`)
  }
  return new RegExp(`\\b${token.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`)
}

export function inspectAgentGenerationBypass(file, content) {
  const normalizedFile = normalizeRepoPath(file)
  if (!isAgentSource(normalizedFile)) return []

  const violations = []
  for (const token of EXACT_TOKENS) {
    const match = tokenPattern(token).exec(content)
    if (!match) continue
    violations.push({
      file: normalizedFile,
      line: lineForOffset(content, match.index),
      token,
    })
  }
  for (const legacyRoute of LEGACY_ROUTE_PATTERNS) {
    const match = legacyRoute.pattern.exec(content)
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
