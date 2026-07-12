import { parseModelKeyStrict } from '@/lib/model-config-contract'

const NON_BLOCKING_LOCAL_IMAGE_MODELS = new Set([
  'image2api-curl',
  'local/image2api-curl',
])

export function isLocalQueueBlockingModel(
  modelKey: string | null | undefined,
  modelType: 'image' | 'video',
): boolean {
  const parsed = parseModelKeyStrict(modelKey)
  if (parsed?.provider !== 'local') return false

  if (modelType === 'image' && NON_BLOCKING_LOCAL_IMAGE_MODELS.has(parsed.modelId.trim())) {
    return false
  }

  return true
}

export function shouldAllowParallelStoryboardVideo(input: {
  storyboardModel?: string | null
  videoModel?: string | null
}): boolean {
  const storyboardBlocksLocalQueue = isLocalQueueBlockingModel(input.storyboardModel, 'image')
  const videoBlocksLocalQueue = isLocalQueueBlockingModel(input.videoModel, 'video')
  return !(storyboardBlocksLocalQueue && videoBlocksLocalQueue)
}
