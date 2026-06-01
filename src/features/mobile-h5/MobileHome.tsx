'use client'

import { useState } from 'react'
import { useSession } from 'next-auth/react'
import { useQuery } from '@tanstack/react-query'
import { usePathname } from 'next/navigation'
import { AppIcon } from '@/components/ui/icons'
import { Link, useRouter } from '@/i18n/navigation'
import { apiFetch } from '@/lib/api-fetch'
import MobileShell, { MobileEmptyState, MobileLoadingState } from './MobileShell'
import { formatDateTime } from './mobile-utils'
import type { MobileProjectSummary } from './types'

interface ProjectsResponse {
  projects: MobileProjectSummary[]
}

function useMobileProjects(search: string) {
  return useQuery({
    queryKey: ['mobile-h5-projects', search],
    queryFn: async () => {
      const params = new URLSearchParams({
        page: '1',
        pageSize: '50',
      })
      if (search.trim()) params.set('search', search.trim())
      const response = await apiFetch(`/api/projects?${params.toString()}`)
      if (!response.ok) throw new Error('获取项目失败')
      return await response.json() as ProjectsResponse
    },
    staleTime: 5000,
  })
}

export default function MobileHome() {
  const { data: session, status } = useSession()
  const router = useRouter()
  const pathname = usePathname()
  const [searchInput, setSearchInput] = useState('')
  const [search, setSearch] = useState('')
  const projectsQuery = useMobileProjects(search)

  if (status === 'loading') {
    return <MobileShell title="Waoo 移动端"><MobileLoadingState /></MobileShell>
  }

  if (!session) {
    router.replace({
      pathname: '/auth/signin',
      query: { next: pathname || '/zh/mobile' },
    })
    return <MobileShell title="Waoo 移动端"><MobileLoadingState label="正在跳转登录..." /></MobileShell>
  }

  const projects = projectsQuery.data?.projects || []
  return (
    <MobileShell
      title="Waoo 移动端"
      subtitle={`${projects.length} 个项目`}
      action={(
        <button
          type="button"
          className="inline-flex h-9 items-center gap-1.5 rounded-full border border-slate-200 bg-white px-3 text-xs font-semibold text-slate-700 shadow-sm active:scale-95"
          onClick={() => void projectsQuery.refetch()}
        >
          <AppIcon name="refresh" className="h-3.5 w-3.5" />
          <span>刷新</span>
        </button>
      )}
    >
      <section className="mb-4 overflow-hidden rounded-[28px] bg-slate-950 p-4 text-white shadow-sm">
        <div className="flex items-start justify-between gap-3">
          <div>
            <div className="text-xs font-medium text-slate-300">移动工作台</div>
            <div className="mt-1 text-xl font-semibold">随时查看生成进度</div>
          </div>
          <span className="rounded-2xl bg-white/10 px-2.5 py-1 text-xs font-medium text-white">{projects.length} 个</span>
        </div>
        <div className="mt-4 flex items-center gap-2 rounded-2xl bg-white p-1.5">
          <input
            value={searchInput}
            onChange={(event) => setSearchInput(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter') setSearch(searchInput)
            }}
            placeholder="搜索项目"
            className="min-w-0 flex-1 rounded-xl border-0 bg-transparent px-3 py-2 text-sm text-slate-950 outline-none placeholder:text-slate-400"
          />
          <button
            type="button"
            onClick={() => setSearch(searchInput)}
            className="rounded-xl bg-blue-600 px-4 py-2 text-sm font-semibold text-white shadow-sm active:scale-95"
          >
            搜索
          </button>
        </div>
      </section>

      {projectsQuery.isLoading ? (
        <MobileLoadingState label="正在加载项目..." />
      ) : projectsQuery.isError ? (
        <MobileEmptyState title="项目加载失败" description={projectsQuery.error.message} />
      ) : projects.length === 0 ? (
        <MobileEmptyState title="暂无项目" description="移动端会直接复用 PC 端项目数据。" />
      ) : (
        <div className="space-y-3">
          {projects.map((project) => (
            <Link
              key={project.id}
              href={`/mobile/workspace/${project.id}` as never}
              className="block overflow-hidden rounded-[24px] bg-white shadow-sm ring-1 ring-slate-200/80 transition active:scale-[0.99]"
            >
              <div className="p-4">
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <h2 className="truncate text-base font-semibold">{project.name}</h2>
                    <p className="mt-1 line-clamp-2 text-sm leading-6 text-slate-500">
                      {project.description || project.stats?.firstEpisodePreview || '暂无描述'}
                    </p>
                  </div>
                  <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-2xl bg-blue-50 text-blue-600">
                    <AppIcon name="chevronRightMd" className="h-5 w-5" />
                  </span>
                </div>
                <div className="mt-4 grid grid-cols-4 gap-2 text-center">
                  <div className="rounded-2xl bg-slate-50 px-2 py-2.5">
                    <div className="text-sm font-semibold">{project.stats?.episodes ?? 0}</div>
                    <div className="text-[10px] text-slate-500">剧集</div>
                  </div>
                  <div className="rounded-2xl bg-blue-50 px-2 py-2.5">
                    <div className="text-sm font-semibold text-blue-700">{project.stats?.panels ?? 0}</div>
                    <div className="text-[10px] text-blue-600/70">分镜</div>
                  </div>
                  <div className="rounded-2xl bg-emerald-50 px-2 py-2.5">
                    <div className="text-sm font-semibold text-emerald-700">{project.stats?.images ?? 0}</div>
                    <div className="text-[10px] text-emerald-600/70">图片</div>
                  </div>
                  <div className="rounded-2xl bg-amber-50 px-2 py-2.5">
                    <div className="text-sm font-semibold text-amber-700">{project.stats?.videos ?? 0}</div>
                    <div className="text-[10px] text-amber-600/70">视频</div>
                  </div>
                </div>
              </div>
              <div className="border-t border-slate-100 bg-slate-50/80 px-4 py-2.5 text-xs text-slate-400">
                更新于 {formatDateTime(project.updatedAt)}
              </div>
            </Link>
          ))}
        </div>
      )}
    </MobileShell>
  )
}
