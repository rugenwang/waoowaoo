'use client'

import { useRouter } from '@/i18n/navigation'
import { usePathname } from 'next/navigation'
import { signOut, useSession } from 'next-auth/react'
import ApiConfigTab from '@/app/[locale]/profile/components/ApiConfigTab'
import MobileShell from './MobileShell'

export default function MobileApiSettings() {
  const router = useRouter()
  const pathname = usePathname()
  const { data: session, status } = useSession()
  if (status === 'loading') return <MobileShell title="模型与 API 设置"><div className="py-20 text-center text-sm text-slate-500">加载中...</div></MobileShell>
  if (!session) {
    router.replace({ pathname: '/auth/signin', query: { next: pathname || '/zh/mobile/settings' } })
    return <MobileShell title="模型与 API 设置"><div className="py-20 text-center text-sm text-slate-500">正在跳转登录...</div></MobileShell>
  }
  return (
    <MobileShell
      title="模型与 API 设置"
      subtitle="供应商、模型映射、默认模型与任务并发"
      action={(
        <button type="button" onClick={() => router.back()} className="rounded-full border border-slate-200 bg-white px-3 py-2 text-xs font-semibold text-slate-700">
          返回
        </button>
      )}
    >
      <section className="mb-3 rounded-[24px] bg-slate-950 p-4 text-white shadow-sm">
        <div className="flex items-center justify-between gap-3">
          <div className="min-w-0">
            <div className="truncate text-sm font-semibold">{session?.user?.name || session?.user?.email || '个人账户'}</div>
            <div className="mt-1 truncate text-xs text-white/55">开源版本不启用计费</div>
          </div>
          <button type="button" onClick={() => signOut({ callbackUrl: '/' })} className="shrink-0 rounded-full bg-white/10 px-3 py-2 text-xs font-semibold text-white">
            退出登录
          </button>
        </div>
      </section>
      <section className="min-w-0 overflow-hidden rounded-[24px] bg-white shadow-sm ring-1 ring-slate-200/80 [&>div]:min-h-[70vh] [&_.p-6]:p-4 [&_.p-8]:p-4">
        <ApiConfigTab />
      </section>
    </MobileShell>
  )
}
