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
  const [projectDialog, setProjectDialog] = useState<{
    mode: 'create' | 'edit'
    project?: MobileProjectSummary
  } | null>(null)
  const [nameDraft, setNameDraft] = useState('')
  const [descriptionDraft, setDescriptionDraft] = useState('')
  const [savingProject, setSavingProject] = useState(false)
  const projectsQuery = useMobileProjects(search)

  const openCreateProject = () => {
    setNameDraft('')
    setDescriptionDraft('')
    setProjectDialog({ mode: 'create' })
  }

  const openEditProject = (project: MobileProjectSummary) => {
    setNameDraft(project.name)
    setDescriptionDraft(project.description || '')
    setProjectDialog({ mode: 'edit', project })
  }

  const saveProject = async () => {
    const name = nameDraft.trim()
    if (!name) {
      alert('请填写项目名称')
      return
    }
    if (!projectDialog) return
    setSavingProject(true)
    try {
      const endpoint = projectDialog.mode === 'create'
        ? '/api/projects'
        : `/api/projects/${projectDialog.project?.id}`
      const response = await apiFetch(endpoint, {
        method: projectDialog.mode === 'create' ? 'POST' : 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name, description: descriptionDraft.trim() }),
      })
      if (!response.ok) {
        const payload = await response.json().catch(() => null) as { message?: string; error?: { message?: string } | string } | null
        throw new Error(payload?.message || (typeof payload?.error === 'string' ? payload.error : payload?.error?.message) || '保存项目失败')
      }
      setProjectDialog(null)
      await projectsQuery.refetch()
    } catch (error) {
      alert(error instanceof Error ? error.message : '保存项目失败')
    } finally {
      setSavingProject(false)
    }
  }

  const deleteProject = async (project: MobileProjectSummary) => {
    if (!window.confirm(`确认删除项目“${project.name}”？项目内剧集和素材也会删除。`)) return
    try {
      const response = await apiFetch(`/api/projects/${project.id}`, { method: 'DELETE' })
      if (!response.ok) throw new Error('删除项目失败')
      await projectsQuery.refetch()
    } catch (error) {
      alert(error instanceof Error ? error.message : '删除项目失败')
    }
  }

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
        <div className="flex items-center gap-2">
          <button
            type="button"
            className="inline-flex h-9 items-center gap-1.5 rounded-full bg-blue-600 px-3 text-xs font-semibold text-white shadow-sm active:scale-95"
            onClick={openCreateProject}
          >
            <AppIcon name="plus" className="h-3.5 w-3.5" />
            <span>新建</span>
          </button>
          <button
            type="button"
            aria-label="刷新项目"
            className="inline-flex h-9 w-9 items-center justify-center rounded-full border border-slate-200 bg-white text-slate-700 shadow-sm active:scale-95"
            onClick={() => void projectsQuery.refetch()}
          >
            <AppIcon name="refresh" className="h-3.5 w-3.5" />
          </button>
        </div>
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
            <article key={project.id} className="overflow-hidden rounded-[24px] bg-white shadow-sm ring-1 ring-slate-200/80">
              <Link href={`/mobile/workspace/${project.id}` as never} className="block p-4 transition active:bg-slate-50">
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
              </Link>
              <div className="flex items-center justify-between border-t border-slate-100 bg-slate-50/80 px-4 py-2.5">
                <span className="text-xs text-slate-400">更新于 {formatDateTime(project.updatedAt)}</span>
                <div className="flex items-center gap-1">
                  <button type="button" onClick={() => openEditProject(project)} className="rounded-full p-2 text-slate-500 active:bg-slate-200" aria-label={`编辑${project.name}`}>
                    <AppIcon name="edit" className="h-4 w-4" />
                  </button>
                  <button type="button" onClick={() => void deleteProject(project)} className="rounded-full p-2 text-red-500 active:bg-red-100" aria-label={`删除${project.name}`}>
                    <AppIcon name="trash" className="h-4 w-4" />
                  </button>
                </div>
              </div>
            </article>
          ))}
        </div>
      )}

      {projectDialog ? (
        <div className="fixed inset-0 z-50 flex items-end bg-black/45" onClick={() => setProjectDialog(null)}>
          <div className="w-full rounded-t-[28px] bg-white p-4 pb-[calc(1rem+env(safe-area-inset-bottom))]" onClick={(event) => event.stopPropagation()}>
            <div className="mx-auto mb-3 h-1.5 w-10 rounded-full bg-slate-200" />
            <h2 className="text-base font-semibold text-slate-950">{projectDialog.mode === 'create' ? '新建项目' : '编辑项目'}</h2>
            <div className="mt-4 space-y-3">
              <input value={nameDraft} onChange={(event) => setNameDraft(event.target.value)} placeholder="项目名称" className="w-full rounded-2xl border border-slate-200 px-4 py-3 text-sm outline-none focus:border-blue-400" />
              <textarea value={descriptionDraft} onChange={(event) => setDescriptionDraft(event.target.value)} placeholder="项目描述（选填）" className="h-28 w-full resize-none rounded-2xl border border-slate-200 px-4 py-3 text-sm outline-none focus:border-blue-400" />
            </div>
            <div className="mt-4 grid grid-cols-2 gap-2">
              <button type="button" onClick={() => setProjectDialog(null)} className="rounded-2xl bg-slate-100 px-4 py-3 text-sm font-semibold text-slate-600">取消</button>
              <button type="button" disabled={savingProject} onClick={() => void saveProject()} className="rounded-2xl bg-blue-600 px-4 py-3 text-sm font-semibold text-white disabled:opacity-60">{savingProject ? '保存中' : '保存'}</button>
            </div>
          </div>
        </div>
      ) : null}
    </MobileShell>
  )
}
