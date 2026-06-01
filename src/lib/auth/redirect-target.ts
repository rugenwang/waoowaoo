import { buildAuthenticatedHomeTarget } from '@/lib/home/default-route'

const LOCALE_PATH_PREFIX = /^\/(zh|en)(\/|$)/
const SAFE_NEXT_PREFIXES = ['/zh/mobile', '/en/mobile', '/mobile']

export function resolveSafePostLoginTarget(next: string | null | undefined) {
  const trimmed = typeof next === 'string' ? next.trim() : ''
  if (!trimmed || !trimmed.startsWith('/') || trimmed.startsWith('//')) {
    return buildAuthenticatedHomeTarget()
  }

  if (SAFE_NEXT_PREFIXES.some((prefix) => trimmed === prefix || trimmed.startsWith(`${prefix}/`) || trimmed.startsWith(`${prefix}?`))) {
    return trimmed
  }

  if (LOCALE_PATH_PREFIX.test(trimmed) && trimmed.includes('/mobile')) {
    return trimmed
  }

  return buildAuthenticatedHomeTarget()
}
