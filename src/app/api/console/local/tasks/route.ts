import { NextRequest, NextResponse } from 'next/server'
import { apiHandler, ApiError } from '@/lib/api-errors'
import { isErrorResponse, requireUserAuth } from '@/lib/api-auth'
import { getProviderConfig } from '@/lib/api-config'

function normalizeBaseUrl(baseUrl: string): string {
  return baseUrl.replace(/\/+$/, '')
}

export const GET = apiHandler(async (request: NextRequest) => {
  const authResult = await requireUserAuth()
  if (isErrorResponse(authResult)) return authResult
  const { session } = authResult

  const { baseUrl, apiKey } = await getProviderConfig(session.user.id, 'local')
  if (!baseUrl) throw new ApiError('INVALID_PARAMS', { message: 'local.baseUrl is required' })
  if (!apiKey) throw new ApiError('INVALID_PARAMS', { message: 'local.apiKey is required' })

  const limit = request.nextUrl.searchParams.get('limit') || '50'
  const projectId = request.nextUrl.searchParams.get('project_id')
  const taskType = request.nextUrl.searchParams.get('task_type')

  const url = new URL(`${normalizeBaseUrl(baseUrl)}/api/integrations/waoowaoo/v1/tasks`)
  url.searchParams.set('limit', limit)
  if (projectId) url.searchParams.set('project_id', projectId)
  if (taskType) url.searchParams.set('task_type', taskType)

  const res = await fetch(url, {
    method: 'GET',
    headers: { Authorization: `Bearer ${apiKey}` },
    cache: 'no-store',
  })
  const text = await res.text().catch(() => '')
  if (!res.ok) {
    throw new ApiError('INTERNAL_ERROR', { message: `local tasks request failed: ${res.status} ${text.slice(0, 200)}` })
  }

  const json = JSON.parse(text) as unknown
  return NextResponse.json(json)
})
