import { buildAuthenticatedHomeTarget } from '@/lib/home/default-route'

const LOCALE_PATH_PREFIX = /^\/(zh|en)(?=\/|$)/

function normalizeMobileTarget(next: string | null | undefined): string | null {
  const trimmed = typeof next === 'string' ? next.trim() : ''
  if (!trimmed || !trimmed.startsWith('/') || trimmed.startsWith('//')) return null

  const localeFree = trimmed.replace(LOCALE_PATH_PREFIX, '') || '/'
  const pathname = localeFree.split(/[?#]/, 1)[0]
  if (pathname !== '/mobile' && !pathname.startsWith('/mobile/')) return null
  return localeFree
}

export function isMobileAuthTarget(next: string | null | undefined): boolean {
  return normalizeMobileTarget(next) !== null
}

export function resolveSafePostLoginTarget(next: string | null | undefined) {
  return normalizeMobileTarget(next) ?? buildAuthenticatedHomeTarget()
}
