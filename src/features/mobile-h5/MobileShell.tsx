'use client'

import type { ReactNode } from 'react'
import { AppIcon } from '@/components/ui/icons'

interface MobileShellProps {
  title: string
  subtitle?: string
  action?: ReactNode
  children: ReactNode
}

export default function MobileShell({ title, subtitle, action, children }: MobileShellProps) {
  return (
    <div className="min-h-screen bg-[#f4f6f8] text-slate-950">
      <header className="sticky top-0 z-30 border-b border-slate-200/70 bg-white/90 px-4 pb-3 pt-[calc(0.75rem+env(safe-area-inset-top))] backdrop-blur-xl">
        <div className="mx-auto flex max-w-md items-center justify-between gap-3">
          <div className="min-w-0">
            <div className="flex items-center gap-2">
              <span className="inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-2xl bg-slate-950 text-white shadow-sm">
                <AppIcon name="sparkles" className="h-4 w-4" />
              </span>
              <h1 className="truncate text-[17px] font-semibold tracking-normal">{title}</h1>
            </div>
            {subtitle ? <p className="mt-1 truncate text-xs text-slate-500">{subtitle}</p> : null}
          </div>
          {action}
        </div>
      </header>
      <main className="mx-auto max-w-md px-4 pb-[calc(6rem+env(safe-area-inset-bottom))] pt-4">
        {children}
      </main>
    </div>
  )
}

export function MobileEmptyState({ title, description }: { title: string; description?: string }) {
  return (
    <div className="rounded-[24px] border border-dashed border-slate-300 bg-white px-5 py-12 text-center shadow-sm">
      <div className="mx-auto mb-3 flex h-12 w-12 items-center justify-center rounded-2xl bg-slate-100 text-slate-500">
        <AppIcon name="imagePreview" className="h-5 w-5" />
      </div>
      <div className="font-semibold">{title}</div>
      {description ? <div className="mt-1 text-sm text-slate-500">{description}</div> : null}
    </div>
  )
}

export function MobileLoadingState({ label = '加载中...' }: { label?: string }) {
  return (
    <div className="flex min-h-[50vh] items-center justify-center rounded-[24px] bg-white text-sm text-slate-500 shadow-sm">
      <span className="mr-2 h-4 w-4 animate-spin rounded-full border-2 border-blue-500 border-t-transparent" />
      {label}
    </div>
  )
}
