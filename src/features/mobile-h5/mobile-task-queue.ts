import { shouldAllowParallelStoryboardVideo } from '@/lib/task-queue/model-policy'

interface MobileTaskQueueProjectConfig {
  progressPopupEnabled?: boolean | null
  storyboardModel?: string | null
  videoModel?: string | null
}

export function getMobileTaskQueueConfig(project: MobileTaskQueueProjectConfig | null | undefined) {
  return {
    enabled: project?.progressPopupEnabled === true,
    allowParallelStoryboardVideo: shouldAllowParallelStoryboardVideo({
      storyboardModel: project?.storyboardModel,
      videoModel: project?.videoModel,
    }),
  }
}
