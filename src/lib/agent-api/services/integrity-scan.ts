export const INTEGRITY_ID_CHUNK_SIZE = 500
export const INTEGRITY_MISSING_SUMMARY_LIMIT = 50

type MissingLike = {
  code: string
  targetType: string
  targetKey: string
  message: string
}

export function stableUniqueIds(values: readonly string[]): string[] {
  return [...new Set(values)].sort()
}

export function stableIdChunks(
  values: readonly string[],
): string[][] {
  const unique = stableUniqueIds(values)
  const chunks: string[][] = []
  for (
    let offset = 0;
    offset < unique.length;
    offset += INTEGRITY_ID_CHUNK_SIZE
  ) {
    chunks.push(unique.slice(offset, offset + INTEGRITY_ID_CHUNK_SIZE))
  }
  return chunks
}

export async function visitStableIdChunks(
  values: readonly string[],
  visit: (chunk: string[]) => Promise<void>,
): Promise<void> {
  for (const chunk of stableIdChunks(values)) await visit(chunk)
}

export async function loadInStableIdChunks<T>(
  values: readonly string[],
  load: (chunk: string[]) => Promise<T[]>,
): Promise<T[]> {
  const result: T[] = []
  for (const chunk of stableIdChunks(values)) {
    result.push(...await load(chunk))
  }
  return result
}

export function buildRelationCountIndex<T>(
  values: readonly T[],
  parentKey: (value: T) => string,
): Map<string, number> {
  const counts = new Map<string, number>()
  for (const value of values) {
    const key = parentKey(value)
    counts.set(key, (counts.get(key) ?? 0) + 1)
  }
  return counts
}

export function buildBoundedMissingState(
  runId: string,
  missing: readonly MissingLike[],
) {
  const summary = missing.slice(0, INTEGRITY_MISSING_SUMMARY_LIMIT)
  const truncated = missing.length > summary.length
  return {
    persisted: {
      code: 'RUN_INCOMPLETE',
      missingCount: missing.length,
      summaryCount: summary.length,
      truncated,
      summary,
    },
    details: {
      missingCount: missing.length,
      snapshotEndpoint: `/api/agent/v1/runs/${runId}/snapshot`,
      summaryCount: summary.length,
      truncated,
    },
  }
}
