export type MobileImageCardState =
  | 'idle'
  | 'queued'
  | 'submitting'
  | 'generating'
  | 'settling'
  | 'generated'

export interface MobileImageCardStateInput {
  queueStatus: 'pending' | 'running' | null
  mutationPending: boolean
  activeTask: boolean
  hasImage: boolean
}

export function resolveMobileImageCardState({
  queueStatus,
  mutationPending,
  activeTask,
  hasImage,
}: MobileImageCardStateInput): MobileImageCardState {
  if (mutationPending) return 'submitting'
  if (queueStatus === 'pending') return 'queued'
  if (queueStatus === 'running' || activeTask) return hasImage ? 'settling' : 'generating'
  return hasImage ? 'generated' : 'idle'
}

export function isMobileImageCardBusy(state: MobileImageCardState): boolean {
  return state === 'queued' || state === 'submitting' || state === 'generating' || state === 'settling'
}

export function getMobileImageCardStateLabel(state: MobileImageCardState): string {
  if (state === 'queued') return '队列等待'
  if (state === 'submitting') return '提交中'
  if (state === 'generating') return '生成中'
  if (state === 'settling') return '任务收尾中'
  if (state === 'generated') return '已生成'
  return '待生成'
}
