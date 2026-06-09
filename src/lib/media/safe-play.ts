function readErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error || '')
}

export function isMediaPlayInterruptedError(error: unknown): boolean {
  if (error instanceof DOMException && error.name === 'AbortError') return true
  const message = readErrorMessage(error).toLowerCase()
  return (
    message.includes('the play() request was interrupted') ||
    message.includes('interrupted by a call to pause') ||
    message.includes('interrupted by a new load request')
  )
}

export async function safePlayMedia(media: HTMLMediaElement): Promise<boolean> {
  try {
    await media.play()
    return true
  } catch (error) {
    if (isMediaPlayInterruptedError(error)) return false
    throw error
  }
}
