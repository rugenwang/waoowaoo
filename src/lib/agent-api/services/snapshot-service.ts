import { z } from 'zod'

import { RunStatusSchema } from '@/lib/agent-api/contracts/common'
import {
  ArtifactHashesSchema,
} from '@/lib/agent-api/run-state'
import { prisma } from '@/lib/prisma'
import {
  inspectRunIntegrity,
  loadIntegrityRun,
  type IntegrityReport,
} from './integrity-service'

export const SnapshotDataSchema = z.object({
  runId: z.string().min(1),
  status: RunStatusSchema,
  committedArtifactHashes: ArtifactHashesSchema,
  uploads: z.array(z.object({
    targetType: z.enum([
      'character-appearance',
      'location-image',
      'prop-image',
      'panel-frame',
    ]),
    targetKey: z.string().min(1),
    variantIndex: z.number().int().nonnegative(),
    contentSha256: z.string().regex(/^sha256:[a-f0-9]{64}$/),
    mediaId: z.string().min(1),
    url: z.string().min(1),
  }).strict()),
  missing: z.array(z.object({
    code: z.string().min(1),
    targetType: z.string().min(1),
    targetKey: z.string().min(1),
    message: z.string().min(1),
  }).strict()),
}).strict()

export async function getRunSnapshot(input: {
  userId: string
  runId: string
}): Promise<Omit<IntegrityReport, 'counts'>> {
  const run = await loadIntegrityRun(prisma, input)
  const report = await inspectRunIntegrity(prisma, run)
  return {
    runId: report.runId,
    status: report.status,
    committedArtifactHashes: report.committedArtifactHashes,
    uploads: report.uploads,
    missing: report.missing,
  }
}
