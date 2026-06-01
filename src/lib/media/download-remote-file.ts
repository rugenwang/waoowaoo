function extensionFromContentType(contentType: string | null): string {
  const normalized = (contentType || '').split(';')[0]?.trim().toLowerCase()
  if (normalized === 'image/jpeg') return 'jpg'
  if (normalized === 'image/png') return 'png'
  if (normalized === 'image/webp') return 'webp'
  if (normalized === 'image/gif') return 'gif'
  return ''
}

function extensionFromUrl(url: string): string {
  try {
    const pathname = new URL(url, window.location.href).pathname
    const match = pathname.match(/\.([a-z0-9]{2,5})$/i)
    return match?.[1]?.toLowerCase() || ''
  } catch {
    const match = url.split('?')[0]?.match(/\.([a-z0-9]{2,5})$/i)
    return match?.[1]?.toLowerCase() || ''
  }
}

function sanitizeFileName(name: string): string {
  return name
    .trim()
    .replace(/[\\/:*?"<>|]+/g, '-')
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '') || 'image'
}

function withExtension(fileName: string, url: string, contentType: string | null): string {
  const safeName = sanitizeFileName(fileName)
  if (/\.[a-z0-9]{2,5}$/i.test(safeName)) return safeName
  const extension = extensionFromContentType(contentType) || extensionFromUrl(url) || 'png'
  return `${safeName}.${extension}`
}

function triggerDownload(url: string, fileName: string) {
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = fileName
  anchor.rel = 'noopener'
  document.body.appendChild(anchor)
  anchor.click()
  document.body.removeChild(anchor)
}

export async function downloadRemoteFile(url: string, fileName: string): Promise<void> {
  const response = await fetch(url, { cache: 'no-store' })
  if (!response.ok) {
    throw new Error(`HTTP ${response.status}`)
  }

  const blob = await response.blob()
  const resolvedFileName = withExtension(fileName, url, blob.type || response.headers.get('content-type'))
  const objectUrl = window.URL.createObjectURL(blob)
  try {
    triggerDownload(objectUrl, resolvedFileName)
  } finally {
    window.setTimeout(() => window.URL.revokeObjectURL(objectUrl), 1000)
  }
}
