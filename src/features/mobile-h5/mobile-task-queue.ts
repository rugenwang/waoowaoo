import { parseModelKeyStrict } from '@/lib/model-config-contract'

interface MobileTaskQueueProjectConfig {
  progressPopupEnabled?: boolean | null
  storyboardModel?: string | null
  videoModel?: string | null
}

export function getMobileTaskQueueConfig(project: MobileTaskQueueProjectConfig | null | undefined) {
  const storyboardProvider = parseModelKeyStrict(project?.storyboardModel)?.provider || null
  const videoProvider = parseModelKeyStrict(project?.videoModel)?.provider || null

  return {
    enabled: project?.progressPopupEnabled === true,
    allowParallelStoryboardVideo: !(storyboardProvider === 'local' && videoProvider === 'local'),
  }
}
