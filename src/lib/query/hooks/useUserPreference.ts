'use client'

import { useQuery } from '@tanstack/react-query'
import { apiFetch } from '@/lib/api-fetch'
import { queryKeys } from '@/lib/query/keys'

export interface UserPreferenceDto {
  progressPopupEnabled?: boolean
}

export function useUserPreference() {
  return useQuery<UserPreferenceDto>({
    queryKey: queryKeys.userPreference.all(),
    queryFn: async () => {
      const res = await apiFetch('/api/user-preference', { method: 'GET' })
      if (!res.ok) return {}
      const data = await res.json().catch(() => ({}))
      return (data?.preference ?? data ?? {}) as UserPreferenceDto
    },
    staleTime: 30_000,
  })
}

