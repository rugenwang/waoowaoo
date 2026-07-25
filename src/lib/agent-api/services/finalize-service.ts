import { Prisma } from '@prisma/client'

import { canonicalJson } from '@/lib/agent-api/canonical-json'
import {
  FinalizeRequestSchema,
  type FinalizeRequest,
} from '@/lib/agent-api/contracts/finalize'
import { AgentApiError } from '@/lib/agent-api/errors'
import { prisma } from '@/lib/prisma'
import { buildBoundedMissingState } from './integrity-scan'
import {
  inspectRunIntegrity,
  loadIntegrityRun,
  lockRunIntegrityEntities,
  parseIntegrityRunState,
  type IntegrityCounts,
  type IntegrityMissing,
} from './integrity-service'

const FINALIZE_TRANSACTION_OPTIONS = {
  maxWait: 10_000,
  timeout: 120_000,
} as const

export type FinalizeCreationRunResult = {
  runId: string
  status: 'completed'
  completedAt: string
  counts: IntegrityCounts
}

type TransactionResult =
  | { kind: 'completed'; data: FinalizeCreationRunResult }
  | {
      kind: 'incomplete'
      details: ReturnType<typeof buildBoundedMissingState>['details']
    }

function exactExpectedMatch(
  expected: FinalizeRequest['expected'],
  actual: {
    assets?: string
    stories: Record<string, string>
    screenplays: Record<string, string>
    storyboards: Record<string, string>
  },
): boolean {
  if (!actual.assets) return false
  return canonicalJson(expected) === canonicalJson({
    assets: actual.assets,
    stories: actual.stories,
    screenplays: actual.screenplays,
    storyboards: actual.storyboards,
  })
}

function recoveryStage(
  missing: IntegrityMissing[],
  currentStage: string,
): string {
  if (missing.some((item) => item.code === 'MAPPING_INVALID')) {
    return 'new_run_required'
  }
  const codes = new Set(missing.map((item) => item.code))
  if (codes.has('STORY_MISSING')) return 'story_committed'
  if (codes.has('ASSETS_MISSING')) return 'assets_committed'
  if (codes.has('SCREENPLAY_MISSING')) return 'screenplay_committed'
  if (
    codes.has('STORYBOARD_MISSING')
    || codes.has('CLIP_STORYBOARD_MISSING')
    || codes.has('PANEL_FRAME_MISSING')
  ) {
    return 'storyboards_committed'
  }
  if (
    codes.has('ASSET_IMAGE_MISSING')
    || codes.has('FRAME_IMAGE_MISSING')
    || codes.has('UPLOAD_PENDING')
    || codes.has('RECEIPT_INVALID')
  ) {
    return 'images_in_progress'
  }
  return currentStage
}

export async function finalizeCreationRun(input: {
  userId: string
  runId: string
  request: FinalizeRequest
}): Promise<FinalizeCreationRunResult> {
  const parsed = FinalizeRequestSchema.safeParse(input.request)
  if (!parsed.success) {
    throw new AgentApiError('CONTRACT_INVALID', {
      field: parsed.error.issues[0]?.path.join('.'),
    })
  }

  const result = await prisma.$transaction(async (tx): Promise<TransactionResult> => {
    await tx.$queryRaw(Prisma.sql`
      SELECT id FROM agent_creation_runs
      WHERE id = ${input.runId}
      FOR UPDATE
    `)
    const run = await loadIntegrityRun(tx, {
      userId: input.userId,
      runId: input.runId,
    })
    if (run.ruleSetHash !== parsed.data.ruleSetHash) {
      throw new AgentApiError('RULESET_MISMATCH', {
        field: 'ruleSetHash',
      })
    }

    const parseMissing: IntegrityMissing[] = []
    const state = parseIntegrityRunState(run, parseMissing)
    if (
      !state.hashes
      || !exactExpectedMatch(parsed.data.expected, state.hashes)
    ) {
      throw new AgentApiError('RUN_DEFINITION_CONFLICT', {
        field: 'expected',
      })
    }
    await lockRunIntegrityEntities(tx, run, state)
    const report = await inspectRunIntegrity(tx, run)

    if (report.missing.length > 0) {
      const currentStage = recoveryStage(
        report.missing,
        run.currentStage,
      )
      const bounded = buildBoundedMissingState(run.id, report.missing)
      await tx.agentCreationRun.update({
        where: { id: run.id },
        data: {
          status: 'incomplete',
          currentStage,
          lastErrorJson: JSON.stringify(bounded.persisted),
        },
      })
      return {
        kind: 'incomplete',
        details: bounded.details,
      }
    }

    if (run.status === 'completed') {
      if (!run.completedAt) {
        throw new AgentApiError('AGENT_INTERNAL_ERROR', {
          details: { field: 'completedAt' },
        })
      }
      return {
        kind: 'completed',
        data: {
          runId: run.id,
          status: 'completed',
          completedAt: run.completedAt.toISOString(),
          counts: report.counts,
        },
      }
    }

    const completedAt = run.completedAt ?? new Date()
    await tx.agentCreationRun.update({
      where: { id: run.id },
      data: {
        status: 'completed',
        currentStage: 'completed',
        completedAt,
        lastErrorJson: null,
      },
    })
    return {
      kind: 'completed',
      data: {
        runId: run.id,
        status: 'completed',
        completedAt: completedAt.toISOString(),
        counts: report.counts,
      },
    }
  }, FINALIZE_TRANSACTION_OPTIONS)

  if (result.kind === 'incomplete') {
    throw new AgentApiError('RUN_INCOMPLETE', {
      details: result.details,
    })
  }
  return result.data
}
