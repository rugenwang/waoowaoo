'use client'

import { useRouter } from '@/i18n/navigation'
import { usePathname } from 'next/navigation'
import { useSession } from 'next-auth/react'
import { AssetHubPageContent } from '@/app/[locale]/workspace/asset-hub/AssetHubPageContent'
import MobileShell, { MobileLoadingState } from './MobileShell'

export default function MobileGlobalAssets() {
  const router = useRouter()
  const pathname = usePathname()
  const { data: session, status } = useSession()
  if (status === 'loading') return <MobileShell title="全局资产"><MobileLoadingState /></MobileShell>
  if (!session) {
    router.replace({ pathname: '/auth/signin', query: { next: pathname || '/zh/mobile/assets' } })
    return <MobileShell title="全局资产"><MobileLoadingState label="正在跳转登录..." /></MobileShell>
  }
  return <AssetHubPageContent mobile onBack={() => router.back()} />
}
