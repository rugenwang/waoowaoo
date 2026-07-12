import { describe, expect, it } from 'vitest'
import { TASK_TYPE } from '@/lib/task/types'
import { getTaskFlowMeta } from '@/lib/llm-observe/stage-pipeline'
import {
  isActiveTaskStatus,
  normalizeTaskPayload,
  shouldAttachNewTaskToReusableRun,
  shouldDedupeReusableRunTask,
} from '@/lib/task/submitter'

describe('task submitter helpers', () => {
  it('fills default flow metadata when payload misses flow fields', () => {
    const type = TASK_TYPE.AI_CREATE_CHARACTER
    const flow = getTaskFlowMeta(type)
    const normalized = normalizeTaskPayload(type, {})

    expect(normalized.flowId).toBe(flow.flowId)
    expect(normalized.flowStageIndex).toBe(flow.flowStageIndex)
    expect(normalized.flowStageTotal).toBe(flow.flowStageTotal)
    expect(normalized.flowStageTitle).toBe(flow.flowStageTitle)
    expect(normalized.meta).toMatchObject({
      flowId: flow.flowId,
      flowStageIndex: flow.flowStageIndex,
      flowStageTotal: flow.flowStageTotal,
      flowStageTitle: flow.flowStageTitle,
    })
  })

  it('normalizes negative stage values', () => {
    const normalized = normalizeTaskPayload(TASK_TYPE.ANALYZE_NOVEL, {
      flowId: 'flow-a',
      flowStageIndex: -9,
      flowStageTotal: -1,
      flowStageTitle: ' title ',
      meta: {},
    })

    expect(normalized.flowId).toBe('flow-a')
    expect(normalized.flowStageIndex).toBeGreaterThanOrEqual(1)
    expect(normalized.flowStageTotal).toBeGreaterThanOrEqual(normalized.flowStageIndex)
    expect(normalized.flowStageTitle).toBe('title')
  })

  it('prefers payload meta flow values when valid', () => {
    const normalized = normalizeTaskPayload(TASK_TYPE.ANALYZE_NOVEL, {
      flowId: 'outer-flow',
      flowStageIndex: 1,
      flowStageTotal: 2,
      flowStageTitle: 'Outer',
      meta: {
        flowId: 'meta-flow',
        flowStageIndex: 3,
        flowStageTotal: 7,
        flowStageTitle: 'Meta',
      },
    })

    const meta = normalized.meta as Record<string, unknown>
    expect(meta.flowId).toBe('meta-flow')
    expect(meta.flowStageIndex).toBe(3)
    expect(meta.flowStageTotal).toBe(7)
    expect(meta.flowStageTitle).toBe('Meta')
  })

  it('reuses linked runs only while the existing task is still active', () => {
    expect(isActiveTaskStatus('queued')).toBe(true)
    expect(isActiveTaskStatus('processing')).toBe(true)
    expect(isActiveTaskStatus('completed')).toBe(false)
    expect(shouldAttachNewTaskToReusableRun('queued')).toBe(false)
    expect(shouldAttachNewTaskToReusableRun('processing')).toBe(false)
    expect(shouldAttachNewTaskToReusableRun('failed')).toBe(true)
    expect(shouldAttachNewTaskToReusableRun(null)).toBe(true)
  })

  it('does not dedupe explicit failed-step retries against a stale active task', () => {
    expect(shouldDedupeReusableRunTask('processing', {
      episodeId: 'episode-1',
    })).toBe(true)
    expect(shouldDedupeReusableRunTask('processing', {
      runId: 'run-1',
      retryStepKey: 'clip_clip-1_phase3_detail',
      retryStepAttempt: 2,
    })).toBe(false)
  })
})
