export type MobileVideoCardState = 'idle' | 'queued' | 'generating' | 'generated'

export function resolveMobileVideoCardState({
  queueStatus,
  activeTask,
  hasVideo,
}: {
  queueStatus: 'pending' | 'running' | null
  activeTask: boolean
  hasVideo: boolean
}): MobileVideoCardState {
  if (queueStatus === 'pending') return 'queued'
  if (queueStatus === 'running' || activeTask) return 'generating'
  return hasVideo ? 'generated' : 'idle'
}

export function isMobileVideoCardBusy(state: MobileVideoCardState): boolean {
  return state === 'queued' || state === 'generating'
}

export function getMobileVideoCardStateLabel(state: MobileVideoCardState): string {
  if (state === 'queued') return '队列等待'
  if (state === 'generating') return '生成中'
  if (state === 'generated') return '已生成'
  return '待生成'
}
