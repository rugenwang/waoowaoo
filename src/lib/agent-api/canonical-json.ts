import { createHash } from 'node:crypto'

export type RunFingerprintInput = {
  projectId: string
  sourceHash: string
  inputKindHint: 'auto' | 'outline' | 'story' | 'screenplay'
  locale: 'zh' | 'en'
  effectiveOptions: {
    artStyle: string
    videoRatio: string
    episodeSplitHint: string
  }
  ruleSetHash: string
}

function compareUnicodeCodePoints(left: string, right: string): number {
  const leftPoints = Array.from(left, (character) => character.codePointAt(0)!)
  const rightPoints = Array.from(right, (character) => character.codePointAt(0)!)
  const sharedLength = Math.min(leftPoints.length, rightPoints.length)

  for (let index = 0; index < sharedLength; index += 1) {
    if (leftPoints[index] !== rightPoints[index]) {
      return leftPoints[index] - rightPoints[index]
    }
  }

  return leftPoints.length - rightPoints.length
}

function serializeCanonical(value: unknown, ancestors: Set<object>): string {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') {
    return JSON.stringify(value)
  }

  if (typeof value === 'number') {
    if (!Number.isFinite(value)) {
      throw new TypeError('canonical JSON requires finite numbers')
    }
    return JSON.stringify(value)
  }

  if (value === undefined) {
    throw new TypeError('canonical JSON does not support undefined')
  }

  if (typeof value !== 'object') {
    throw new TypeError(`canonical JSON received an unsupported ${typeof value} value`)
  }

  if (ancestors.has(value)) {
    throw new TypeError('canonical JSON does not support cyclic values')
  }
  ancestors.add(value)

  try {
    if (Array.isArray(value)) {
      const items: string[] = []
      for (let index = 0; index < value.length; index += 1) {
        items.push(serializeCanonical(value[index], ancestors))
      }
      return `[${items.join(',')}]`
    }

    const prototype = Object.getPrototypeOf(value)
    if (prototype !== Object.prototype && prototype !== null) {
      throw new TypeError('canonical JSON received an unsupported object value')
    }

    if (Object.getOwnPropertySymbols(value).length > 0) {
      throw new TypeError('canonical JSON does not support symbol keys')
    }

    const entries = Object.keys(value)
      .sort(compareUnicodeCodePoints)
      .map((key) => {
        const item = (value as Record<string, unknown>)[key]
        return `${JSON.stringify(key)}:${serializeCanonical(item, ancestors)}`
      })

    return `{${entries.join(',')}}`
  } finally {
    ancestors.delete(value)
  }
}

export function canonicalJson(value: unknown): string {
  return serializeCanonical(value, new Set())
}

export function sha256Prefixed(value: string | Buffer): string {
  return `sha256:${createHash('sha256').update(value).digest('hex')}`
}

export function normalizeSourceText(sourceText: string): string {
  return sourceText.replace(/\r\n?/g, '\n').trim()
}

export function hashSourceText(sourceText: string): string {
  return sha256Prefixed(normalizeSourceText(sourceText))
}

export function hashArtifact(value: unknown): string {
  return sha256Prefixed(canonicalJson(value))
}

export function buildRunFingerprint(input: RunFingerprintInput): string {
  return hashArtifact({
    projectId: input.projectId,
    sourceHash: input.sourceHash,
    inputKindHint: input.inputKindHint,
    locale: input.locale,
    effectiveOptions: {
      artStyle: input.effectiveOptions.artStyle,
      videoRatio: input.effectiveOptions.videoRatio,
      episodeSplitHint: input.effectiveOptions.episodeSplitHint,
    },
    ruleSetHash: input.ruleSetHash,
  })
}
