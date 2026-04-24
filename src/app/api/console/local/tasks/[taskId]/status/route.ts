import { NextRequest, NextResponse } from 'next/server'
import { apiHandler, ApiError } from '@/lib/api-errors'
import { isErrorResponse, requireUserAuth } from '@/lib/api-auth'
import { getProviderConfig } from '@/lib/api-config'

function normalizeBaseUrl(baseUrl: string): string {
  return baseUrl.replace(/\/+$/, '')
}

export const GET = apiHandler(async (
  _request: NextRequest,
  context: { params: Promise<{ taskId: string }> },
) => {
  const authResult = await requireUserAuth()
  if (isErrorResponse(authResult)) return authResult
  const { session } = authResult
  const { taskId } = await context.params

  const { baseUrl, apiKey } = await getProviderConfig(session.user.id, 'local')
  if (!baseUrl) throw new ApiError('INVALID_PARAMS', { message: 'local.baseUrl is required' })
  if (!apiKey) throw new ApiError('INVALID_PARAMS', { message: 'local.apiKey is required' })

  const url = `${normalizeBaseUrl(baseUrl)}/api/integrations/waoowaoo/v1/tasks/${encodeURIComponent(taskId)}`
  const res = await fetch(url, {
    method: 'GET',
    headers: { Authorization: `Bearer ${apiKey}` },
    cache: 'no-store',
  })
  const text = await res.text().catch(() => '')
  if (!res.ok) {
    throw new ApiError('INTERNAL_ERROR', { message: `local task status request failed: ${res.status} ${text.slice(0, 200)}` })
  }
  return NextResponse.json(JSON.parse(text) as unknown)
})
