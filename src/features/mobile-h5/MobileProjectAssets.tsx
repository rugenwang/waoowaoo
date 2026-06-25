'use client'

import dynamic from 'next/dynamic'
import { useState } from 'react'
import { AppIcon } from '@/components/ui/icons'
import { MobileLoadingState } from './MobileShell'
import { useRefreshProjectAssets } from '@/lib/query/hooks'
import MobileGenerationQueueBar from './MobileGenerationQueueBar'

const AssetsStage = dynamic(
  () => import('@/app/[locale]/workspace/[projectId]/modes/novel-promotion/components/AssetsStage'),
  { ssr: false, loading: () => <MobileLoadingState label="正在加载项目资产..." /> },
)

export default function MobileProjectAssets({ projectId, onBack }: { projectId: string; onBack: () => void }) {
  const refreshAssets = useRefreshProjectAssets(projectId)
  const [refreshing, setRefreshing] = useState(false)

  const handleRefresh = async () => {
    setRefreshing(true)
    try {
      await refreshAssets()
    } finally {
      setRefreshing(false)
    }
  }

  return (
    <div className="min-w-0 space-y-3 pb-24">
      <section className="sticky top-[66px] z-30 flex items-center gap-3 rounded-[22px] border border-slate-200 bg-white/95 p-3 shadow-sm backdrop-blur">
        <button type="button" onClick={onBack} className="rounded-full bg-slate-100 p-2 text-slate-600">
          <AppIcon name="chevronLeft" className="h-4 w-4" />
        </button>
        <div className="min-w-0 flex-1">
          <h2 className="text-base font-semibold text-slate-950">项目资产</h2>
          <p className="truncate text-xs text-slate-500">角色、场景、道具和角色音色</p>
        </div>
        <button
          type="button"
          onClick={() => void handleRefresh()}
          disabled={refreshing}
          className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-slate-100 text-slate-600 disabled:opacity-50"
          aria-label="刷新项目资产"
        >
          <AppIcon name="refresh" className={`h-4 w-4 ${refreshing ? 'animate-spin' : ''}`} />
        </button>
      </section>
      <MobileGenerationQueueBar />
      <div className="min-w-0 overflow-x-hidden [&_button]:touch-manipulation">
        <AssetsStage projectId={projectId} isAnalyzingAssets={false} mobile />
      </div>
    </div>
  )
}
