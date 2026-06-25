'use client'

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { ComponentProps, ReactNode } from 'react'
import { useParams, usePathname, useSearchParams } from 'next/navigation'
import { useSession } from 'next-auth/react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { AppIcon } from '@/components/ui/icons'
import { Link, useRouter } from '@/i18n/navigation'
import { apiFetch } from '@/lib/api-fetch'
import { downloadRemoteFile } from '@/lib/media/download-remote-file'
import { useScriptToStoryboardRunStream } from '@/lib/query/hooks/useScriptToStoryboardRunStream'
import { useStoryToScriptRunStream } from '@/lib/query/hooks/useStoryToScriptRunStream'
import MobileShell, { MobileEmptyState, MobileLoadingState } from './MobileShell'
import MobileProjectSettings from './MobileProjectSettings'
import MobileProjectAssets from './MobileProjectAssets'
import MobileVoice from './MobileVoice'
import MobileStoryboardPromptDetail from './MobileStoryboardPromptDetail'
import MobileGenerationQueueBar from './MobileGenerationQueueBar'
import MobileProjectTaskQueueBoundary from './MobileProjectTaskQueueBoundary'
import NovelInputStage from '@/app/[locale]/workspace/[projectId]/modes/novel-promotion/components/NovelInputStage'
import SmartImportWizard from '@/app/[locale]/workspace/[projectId]/modes/novel-promotion/components/SmartImportWizard'
import { useTaskQueue, type TaskQueueContextValue } from '@/lib/task-queue'
import {
  buildMobileStoryboardQueueItems,
  buildMobileVideoQueueItems,
  getMobileQueueUiStatus,
  runMobileGenerationBatch,
} from './mobile-generation-queue'
import {
  getMobileImageCardStateLabel,
  isMobileImageCardBusy,
  resolveMobileImageCardState,
  type MobileImageCardState,
} from './mobile-image-card-state'
import {
  getMobileVideoCardStateLabel,
  isMobileVideoCardBusy,
  resolveMobileVideoCardState,
  type MobileVideoCardState,
} from './mobile-video-card-state'
import {
  MOBILE_MORE_DESTINATIONS,
  MOBILE_PRIMARY_TABS,
  getMobilePrimaryTab,
  type MobileMoreDestination,
  type MobilePrimaryTab,
  type MobileWorkspaceTab,
} from './mobile-navigation'
import {
  copyText,
  canReferencePreviousPanel,
  displayMediaUrl,
  formatDateTime,
  formatClipSummary,
  getPanelDuration,
  getPanelImageUrl,
  getPanelVideoUrl,
  getSortedPanelGroups,
  getSortedFrames,
  getSortedPanels,
  parseNameList,
  shouldDisplayPanelFrames,
} from './mobile-utils'
import type {
  MobileClip,
  MobileEpisodeDetail,
  MobileEpisodeSummary,
  MobilePanel,
  MobilePanelFrame,
  MobileProjectDetail,
  MobileTask,
} from './types'

interface ProjectResponse {
  project: MobileProjectDetail
}

interface EpisodeResponse {
  episode: MobileEpisodeDetail
}

interface TasksResponse {
  tasks: MobileTask[]
}

type MobileUploadTarget =
  | { kind: 'panel-image'; panelId: string }
  | { kind: 'panel-frame-image'; frameId: string }
  | { kind: 'panel-video'; panelId: string }

type MobilePanelDialog =
  | { kind: 'panel-edit'; panel: MobilePanel; storyboardId: string }
  | { kind: 'insert-panel'; panel: MobilePanel; storyboardId: string }
  | { kind: 'frame-edit'; frame: MobilePanelFrame }
  | { kind: 'video-prompt'; panel: MobilePanel; storyboardId: string }
  | { kind: 'first-last-prompt'; panel: MobilePanel; storyboardId: string }
  | { kind: 'duration'; panel: MobilePanel; storyboardId: string }

type MobileScriptEditDialog = {
  clip: MobileClip
  field: 'content' | 'screenplay' | 'characters' | 'location' | 'props'
}

interface PanelMenuState {
  panel: MobilePanel
  storyboardId: string
  hasNext: boolean
  hasPrevious: boolean
}

interface FrameMenuState {
  frame: MobilePanelFrame
  panel: MobilePanel
}

function sortEpisodes(episodes: MobileEpisodeSummary[]): MobileEpisodeSummary[] {
  return [...episodes].sort((left, right) => {
    const leftNumber = typeof left.episodeNumber === 'number' ? left.episodeNumber : Number.MAX_SAFE_INTEGER
    const rightNumber = typeof right.episodeNumber === 'number' ? right.episodeNumber : Number.MAX_SAFE_INTEGER
    if (leftNumber !== rightNumber) return leftNumber - rightNumber
    return left.name.localeCompare(right.name, 'zh')
  })
}

function StatusPill({ running, label }: { running?: boolean; label: string }) {
  return (
    <span className={`inline-flex items-center gap-1 rounded-full px-2.5 py-1 text-[11px] font-semibold ${running ? 'bg-amber-100 text-amber-700' : 'bg-slate-100 text-slate-500'}`}>
      {running ? <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-amber-500" /> : null}
      {label}
    </span>
  )
}

function MobileImageStatePill({ state }: { state: MobileImageCardState }) {
  const tone = state === 'queued' || state === 'submitting'
    ? 'bg-amber-100 text-amber-700'
    : state === 'generating' || state === 'settling'
      ? 'bg-blue-100 text-blue-700'
      : state === 'generated'
        ? 'bg-emerald-100 text-emerald-700'
        : 'bg-slate-100 text-slate-500'
  return (
    <span className={`inline-flex items-center gap-1 rounded-full px-2.5 py-1 text-[11px] font-semibold ${tone}`}>
      {isMobileImageCardBusy(state) ? <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-current" /> : null}
      {getMobileImageCardStateLabel(state)}
    </span>
  )
}

function MobileVideoStatePill({ state }: { state: MobileVideoCardState }) {
  const tone = state === 'queued'
    ? 'bg-amber-100 text-amber-700'
    : state === 'generating'
      ? 'bg-blue-100 text-blue-700'
      : state === 'generated'
        ? 'bg-emerald-100 text-emerald-700'
        : 'bg-slate-100 text-slate-500'
  return (
    <span className={`inline-flex items-center gap-1 rounded-full px-2.5 py-1 text-[11px] font-semibold ${tone}`}>
      {isMobileVideoCardBusy(state) ? <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-current" /> : null}
      {getMobileVideoCardStateLabel(state)}
    </span>
  )
}

function BottomTabs({
  value,
  counts,
  onChange,
}: {
  value: MobileWorkspaceTab
  counts: Record<MobilePrimaryTab, number>
  onChange: (next: MobileWorkspaceTab) => void
}) {
  const activePrimaryTab = getMobilePrimaryTab(value)

  return (
    <nav className="fixed inset-x-0 bottom-0 z-40 border-t border-slate-200/80 bg-white/95 px-4 pb-[calc(0.5rem+env(safe-area-inset-bottom))] pt-2 backdrop-blur-xl">
      <div className="mx-auto grid max-w-md grid-cols-5 gap-1">
        {MOBILE_PRIMARY_TABS.map((item) => {
          const active = activePrimaryTab === item.key
          return (
            <button
              key={item.key}
              type="button"
              onClick={() => onChange(item.key)}
              className={`flex h-14 flex-col items-center justify-center rounded-2xl text-[11px] font-semibold transition active:scale-95 ${active ? 'bg-slate-950 text-white shadow-sm' : 'text-slate-500 hover:bg-slate-100'}`}
            >
              <span className="relative">
                <AppIcon name={item.icon} className="h-5 w-5" />
                {counts[item.key] > 0 ? (
                  <span className={`absolute -right-3 -top-2 min-w-4 rounded-full px-1 text-[9px] leading-4 ${active ? 'bg-white text-slate-950' : 'bg-blue-600 text-white'}`}>
                    {counts[item.key]}
                  </span>
                ) : null}
              </span>
              <span className="mt-1">{item.label}</span>
            </button>
          )
        })}
      </div>
    </nav>
  )
}

function PreviewModal({
  type,
  url,
  onClose,
}: {
  type: 'image' | 'video'
  url: string
  onClose: () => void
}) {
  return (
    <div className="fixed inset-0 z-[80] flex items-center justify-center bg-black/80 p-4" onClick={onClose}>
      <button
        type="button"
        className="absolute right-4 top-4 rounded-full bg-white/15 p-2 text-white backdrop-blur"
        onClick={onClose}
      >
        <AppIcon name="close" className="h-5 w-5" />
      </button>
      {type === 'image' ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img src={url} alt="预览图片" className="max-h-[86vh] max-w-full rounded-xl object-contain" onClick={(event) => event.stopPropagation()} />
      ) : (
        <video src={url} controls autoPlay className="max-h-[86vh] max-w-full rounded-xl bg-black" onClick={(event) => event.stopPropagation()} />
      )}
    </div>
  )
}

function MobileTextPreviewModal({
  title,
  content,
  onClose,
}: {
  title: string
  content: string
  onClose: () => void
}) {
  return (
    <div className="fixed inset-0 z-[80] flex flex-col bg-[#f4f6f8]">
      <div className="flex items-center gap-3 border-b border-slate-200 bg-white px-4 pb-3 pt-[calc(0.75rem+env(safe-area-inset-top))]">
        <button type="button" onClick={onClose} className="flex h-10 w-10 items-center justify-center rounded-full bg-slate-100 text-slate-600" aria-label="关闭">
          <AppIcon name="chevronLeft" className="h-5 w-5" />
        </button>
        <div className="min-w-0 flex-1 truncate text-base font-semibold text-slate-950">{title}</div>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto p-4 pb-[calc(1rem+env(safe-area-inset-bottom))]">
        <div className="min-h-full whitespace-pre-wrap rounded-[22px] border border-blue-100 bg-white p-4 text-sm leading-7 text-slate-800 shadow-sm">
          {content || '暂无视频提示词'}
        </div>
      </div>
    </div>
  )
}

function MobileActionSheet({
  title,
  subtitle,
  children,
  onClose,
}: {
  title: string
  subtitle?: string
  children: ReactNode
  onClose: () => void
}) {
  return (
    <div className="fixed inset-0 z-50 flex items-end bg-black/45" onClick={onClose}>
      <div
        className="max-h-[82vh] w-full overflow-y-auto rounded-t-[28px] bg-white p-4 pb-[calc(1rem+env(safe-area-inset-bottom))] shadow-2xl"
        onClick={(event) => event.stopPropagation()}
      >
        <div className="mx-auto mb-3 h-1.5 w-10 rounded-full bg-slate-200" />
        <div className="mb-4 flex items-start justify-between gap-3">
          <div className="min-w-0">
            <div className="truncate text-base font-semibold text-slate-950">{title}</div>
            {subtitle ? <div className="mt-1 text-xs leading-5 text-slate-500">{subtitle}</div> : null}
          </div>
          <button type="button" onClick={onClose} className="rounded-full bg-slate-100 p-2 text-slate-500">
            <AppIcon name="close" className="h-4 w-4" />
          </button>
        </div>
        <div className="grid grid-cols-2 gap-2">{children}</div>
      </div>
    </div>
  )
}

function SheetButton({
  label,
  icon,
  tone = 'default',
  disabled,
  onClick,
}: {
  label: string
  icon: ComponentProps<typeof AppIcon>['name']
  tone?: 'default' | 'primary' | 'danger'
  disabled?: boolean
  onClick: () => void
}) {
  const toneClass = tone === 'danger'
    ? 'bg-red-50 text-red-600 ring-red-100'
    : tone === 'primary'
      ? 'bg-blue-600 text-white ring-blue-600'
      : 'bg-slate-50 text-slate-700 ring-slate-200'
  return (
    <button
      type="button"
      disabled={disabled}
      onClick={onClick}
      className={`flex min-h-12 items-center justify-center gap-2 rounded-2xl px-3 py-2 text-sm font-semibold ring-1 active:scale-[0.98] disabled:opacity-40 ${toneClass}`}
    >
      <AppIcon name={icon} className="h-4 w-4" />
      <span>{label}</span>
    </button>
  )
}

export default function MobileProject() {
  const params = useParams<{ projectId?: string }>()
  const searchParams = useSearchParams()
  const pathname = usePathname()
  const router = useRouter()
  const { data: session, status } = useSession()
  const queryClient = useQueryClient()
  const projectId = params?.projectId || ''
  const [tab, setTab] = useState<MobileWorkspaceTab>('story')
  const [storyDraft, setStoryDraft] = useState('')
  const [savingStory, setSavingStory] = useState(false)
  const [copiedPanelId, setCopiedPanelId] = useState<string | null>(null)
  const [copiedFrameId, setCopiedFrameId] = useState<string | null>(null)
  const [expandedClipIds, setExpandedClipIds] = useState<Set<string>>(new Set())
  const [promptDetailPanelId, setPromptDetailPanelId] = useState<string | null>(null)
  const [preview, setPreview] = useState<{ type: 'image' | 'video'; url: string } | null>(null)
  const [textPreview, setTextPreview] = useState<{ title: string; content: string } | null>(null)
  const [panelMenu, setPanelMenu] = useState<PanelMenuState | null>(null)
  const [frameMenu, setFrameMenu] = useState<FrameMenuState | null>(null)
  const [videoMenu, setVideoMenu] = useState<MobilePanel | null>(null)
  const [scriptMenu, setScriptMenu] = useState<MobileClip | null>(null)
  const [dialog, setDialog] = useState<MobilePanelDialog | null>(null)
  const [dialogDraft, setDialogDraft] = useState('')
  const [frameTimeDraft, setFrameTimeDraft] = useState('')
  const [scriptDialog, setScriptDialog] = useState<MobileScriptEditDialog | null>(null)
  const [scriptDraft, setScriptDraft] = useState('')
  const [episodeDialog, setEpisodeDialog] = useState<{ mode: 'create' | 'rename'; episodeId?: string } | null>(null)
  const [episodeNameDraft, setEpisodeNameDraft] = useState('')
  const [savingEpisode, setSavingEpisode] = useState(false)
  const [smartSplitText, setSmartSplitText] = useState<string | null>(null)
  const [uploadTarget, setUploadTarget] = useState<MobileUploadTarget | null>(null)
  const fileInputRef = useRef<HTMLInputElement>(null)
  const hadRunningTasksRef = useRef(false)

  const projectQuery = useQuery({
    queryKey: ['mobile-h5-project', projectId],
    queryFn: async () => {
      const response = await apiFetch(`/api/projects/${projectId}/data`)
      if (!response.ok) throw new Error('获取项目失败')
      return await response.json() as ProjectResponse
    },
    enabled: !!projectId && !!session,
    staleTime: 5000,
  })

  const episodes = useMemo(
    () => sortEpisodes(projectQuery.data?.project.novelPromotionData?.episodes || []),
    [projectQuery.data?.project.novelPromotionData?.episodes],
  )
  const urlEpisodeId = searchParams?.get('episode') || null
  const selectedEpisodeId = urlEpisodeId && episodes.some((episode) => episode.id === urlEpisodeId)
    ? urlEpisodeId
    : episodes[0]?.id || null

  const episodeQuery = useQuery({
    queryKey: ['mobile-h5-episode', projectId, selectedEpisodeId],
    queryFn: async () => {
      const response = await apiFetch(`/api/novel-promotion/${projectId}/episodes/${selectedEpisodeId}`)
      if (!response.ok) throw new Error('获取剧集失败')
      return await response.json() as EpisodeResponse
    },
    enabled: !!projectId && !!selectedEpisodeId && !!session,
    staleTime: 5000,
  })

  const storyToScriptStream = useStoryToScriptRunStream({ projectId, episodeId: selectedEpisodeId })
  const scriptToStoryboardStream = useScriptToStoryboardRunStream({ projectId, episodeId: selectedEpisodeId })

  const tasksQuery = useQuery({
    queryKey: ['mobile-h5-tasks', projectId],
    queryFn: async () => {
      const params = new URLSearchParams({
        projectId,
        limit: '80',
      })
      const response = await apiFetch(`/api/tasks?${params.toString()}`)
      if (!response.ok) throw new Error('获取任务失败')
      return await response.json() as TasksResponse
    },
    enabled: !!projectId && !!session,
    refetchInterval: 5000,
  })

  const regenerateImage = useMutation({
    mutationFn: async (panelId: string) => {
      const response = await apiFetch(`/api/novel-promotion/${projectId}/regenerate-panel-image`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ panelId }),
      })
      if (!response.ok) {
        const payload = await response.json().catch(() => null) as { message?: string; error?: string | { message?: string } } | null
        const message = typeof payload?.message === 'string'
          ? payload.message
          : typeof payload?.error === 'string'
            ? payload.error
            : payload?.error?.message
        throw new Error(message || '提交生图任务失败')
      }
      return response.json()
    },
    onSettled: () => {
      void queryClient.invalidateQueries({ queryKey: ['mobile-h5-episode', projectId, selectedEpisodeId] })
      void queryClient.invalidateQueries({ queryKey: ['mobile-h5-tasks', projectId] })
    },
  })

  const regenerateFrameImage = useMutation({
    mutationFn: async ({ panelId, frameId }: { panelId: string; frameId: string }) => {
      const response = await apiFetch(`/api/novel-promotion/${projectId}/regenerate-panel-frame-image`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ panelId, frameId }),
      })
      if (!response.ok) {
        const payload = await response.json().catch(() => null) as { message?: string; error?: { message?: string } } | null
        throw new Error(payload?.message || payload?.error?.message || '提交关键帧生图任务失败')
      }
      return response.json()
    },
    onSettled: () => {
      void queryClient.invalidateQueries({ queryKey: ['mobile-h5-episode', projectId, selectedEpisodeId] })
      void queryClient.invalidateQueries({ queryKey: ['mobile-h5-tasks', projectId] })
    },
  })

  const cancelTask = useMutation({
    mutationFn: async (taskId: string) => {
      const response = await apiFetch(`/api/tasks/${encodeURIComponent(taskId)}`, { method: 'DELETE' })
      if (!response.ok) throw new Error('取消任务失败')
      return response.json()
    },
    onSettled: () => {
      void queryClient.invalidateQueries({ queryKey: ['mobile-h5-tasks', projectId] })
      void queryClient.invalidateQueries({ queryKey: ['mobile-h5-episode', projectId, selectedEpisodeId] })
    },
  })

  const dismissFailedTasks = useMutation({
    mutationFn: async (taskIds: string[]) => {
      const response = await apiFetch('/api/tasks/dismiss', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ taskIds }),
      })
      if (!response.ok) throw new Error('清理失败任务失败')
      return response.json()
    },
    onSettled: () => {
      void queryClient.invalidateQueries({ queryKey: ['mobile-h5-tasks', projectId] })
    },
  })

  const runningTaskCount = (tasksQuery.data?.tasks || [])
    .filter((task) => task.status === 'queued' || task.status === 'processing')
    .length
  const refetchEpisode = episodeQuery.refetch
  const refetchProject = projectQuery.refetch
  const refetchTasks = tasksQuery.refetch

  useEffect(() => {
    if (!projectId || !selectedEpisodeId || !session) return

    if (runningTaskCount > 0) {
      hadRunningTasksRef.current = true
      void refetchEpisode()
      const timer = window.setInterval(() => {
        void refetchEpisode()
        void refetchTasks()
      }, 3000)
      return () => window.clearInterval(timer)
    }

    if (hadRunningTasksRef.current) {
      hadRunningTasksRef.current = false
      void refetchEpisode()
      void refetchProject()
    }
  }, [projectId, refetchEpisode, refetchProject, refetchTasks, runningTaskCount, selectedEpisodeId, session])

  useEffect(() => {
    setStoryDraft(episodeQuery.data?.episode?.novelText || '')
  }, [episodeQuery.data?.episode?.novelText, selectedEpisodeId])

  const refreshMobileData = useCallback(async () => {
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: ['mobile-h5-project', projectId] }),
      queryClient.invalidateQueries({ queryKey: ['mobile-h5-episode', projectId, selectedEpisodeId] }),
      queryClient.invalidateQueries({ queryKey: ['mobile-h5-tasks', projectId] }),
    ])
    void refetchEpisode()
    void refetchProject()
    void refetchTasks()
  }, [projectId, queryClient, refetchEpisode, refetchProject, refetchTasks, selectedEpisodeId])

  const readErrorMessage = async (response: Response, fallback: string) => {
    const payload = await response.json().catch(() => null) as { message?: string; error?: string | { message?: string } } | null
    if (typeof payload?.message === 'string') return payload.message
    if (typeof payload?.error === 'string') return payload.error
    if (payload?.error && typeof payload.error.message === 'string') return payload.error.message
    return fallback
  }

  const requestJson = useCallback(async (url: string, init: RequestInit, fallback: string) => {
    const response = await apiFetch(url, init)
    if (!response.ok) throw new Error(await readErrorMessage(response, fallback))
    return response.json().catch(() => ({}))
  }, [])

  const openCreateEpisode = useCallback(() => {
    setEpisodeNameDraft(`第 ${episodes.length + 1} 集`)
    setEpisodeDialog({ mode: 'create' })
  }, [episodes.length])

  const openRenameEpisode = useCallback((episodeId: string, name: string) => {
    setEpisodeNameDraft(name)
    setEpisodeDialog({ mode: 'rename', episodeId })
  }, [])

  const saveEpisode = useCallback(async () => {
    if (!episodeDialog) return
    const name = episodeNameDraft.trim()
    if (!name) {
      alert('请填写剧集名称')
      return
    }
    setSavingEpisode(true)
    try {
      const creating = episodeDialog.mode === 'create'
      const payload = await requestJson(
        creating
          ? `/api/novel-promotion/${projectId}/episodes`
          : `/api/novel-promotion/${projectId}/episodes/${episodeDialog.episodeId}`,
        {
          method: creating ? 'POST' : 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ name }),
        },
        creating ? '创建剧集失败' : '重命名剧集失败',
      ) as { episode?: { id?: string } }
      setEpisodeDialog(null)
      await projectQuery.refetch()
      if (creating && payload.episode?.id) {
        router.replace({ pathname: `/mobile/workspace/${projectId}` as never, query: { episode: payload.episode.id } })
      } else {
        await episodeQuery.refetch()
      }
    } catch (error) {
      alert(error instanceof Error ? error.message : '保存剧集失败')
    } finally {
      setSavingEpisode(false)
    }
  }, [episodeDialog, episodeNameDraft, episodeQuery, projectId, projectQuery, requestJson, router])

  const deleteEpisode = useCallback(async (episodeId: string, name: string) => {
    if (!window.confirm(`确认删除剧集“${name}”？该剧集内的剧本、分镜和成片也会删除。`)) return
    try {
      await requestJson(`/api/novel-promotion/${projectId}/episodes/${episodeId}`, { method: 'DELETE' }, '删除剧集失败')
      const nextEpisode = episodes.find((item) => item.id !== episodeId)
      await projectQuery.refetch()
      router.replace({
        pathname: `/mobile/workspace/${projectId}` as never,
        query: nextEpisode ? { episode: nextEpisode.id } : {},
      })
    } catch (error) {
      alert(error instanceof Error ? error.message : '删除剧集失败')
    }
  }, [episodes, projectId, projectQuery, requestJson, router])

  const saveStoryDraft = useCallback(async () => {
    if (!selectedEpisodeId) return
    setSavingStory(true)
    try {
      await requestJson(`/api/novel-promotion/${projectId}/episodes/${selectedEpisodeId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ novelText: storyDraft }),
      }, '保存故事失败')
      await refreshMobileData()
    } catch (error) {
      alert(error instanceof Error ? error.message : '保存故事失败')
    } finally {
      setSavingStory(false)
    }
  }, [projectId, refreshMobileData, requestJson, selectedEpisodeId, storyDraft])

  const updateStoryProjectConfig = useCallback(async (key: 'videoRatio' | 'artStyle', value: string) => {
    try {
      await requestJson(`/api/novel-promotion/${projectId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ [key]: value }),
      }, '保存故事配置失败')
      await projectQuery.refetch()
    } catch (error) {
      alert(error instanceof Error ? error.message : '保存故事配置失败')
    }
  }, [projectId, projectQuery, requestJson])

  const runStoryToScriptMobile = useCallback(async () => {
    if (!selectedEpisodeId) return
    const content = storyDraft.trim()
    if (!content) {
      alert('请先填写故事内容。')
      return
    }
    setSavingStory(true)
    try {
      await requestJson(`/api/novel-promotion/${projectId}/episodes/${selectedEpisodeId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ novelText: storyDraft }),
      }, '保存故事失败')
      setSavingStory(false)
      const result = await storyToScriptStream.run({
        episodeId: selectedEpisodeId,
        content,
        temperature: 0.7,
        reasoning: true,
      })
      if (result.status !== 'completed') {
        throw new Error(result.errorMessage || '故事生成剧本失败')
      }
      await refreshMobileData()
      setTab('script')
    } catch (error) {
      alert(error instanceof Error ? error.message : '故事生成剧本失败')
    } finally {
      setSavingStory(false)
    }
  }, [projectId, refreshMobileData, requestJson, selectedEpisodeId, storyDraft, storyToScriptStream])

  const runScriptToStoryboardMobile = useCallback(async (clipId?: string) => {
    if (!selectedEpisodeId) return
    try {
      const result = await scriptToStoryboardStream.run({
        episodeId: selectedEpisodeId,
        clipId,
        temperature: 0.7,
        reasoning: true,
      })
      if (result.status !== 'completed') {
        throw new Error(result.errorMessage || '剧本生成分镜失败')
      }
      await refreshMobileData()
      setTab('storyboard')
    } catch (error) {
      alert(error instanceof Error ? error.message : '剧本生成分镜失败')
    }
  }, [refreshMobileData, scriptToStoryboardStream, selectedEpisodeId])

  const openScriptDialog = useCallback((clip: MobileClip, field: MobileScriptEditDialog['field']) => {
    setScriptDialog({ clip, field })
    setScriptDraft(String(clip[field] || ''))
  }, [])

  const submitScriptDialog = useCallback(async () => {
    if (!scriptDialog) return
    try {
      await requestJson(`/api/novel-promotion/${projectId}/clips/${scriptDialog.clip.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ [scriptDialog.field]: scriptDraft }),
      }, '保存剧本片段失败')
      setScriptDialog(null)
      await refreshMobileData()
    } catch (error) {
      alert(error instanceof Error ? error.message : '保存剧本片段失败')
    }
  }, [projectId, refreshMobileData, requestJson, scriptDialog, scriptDraft])

  const deleteScriptClip = useCallback(async (clip: MobileClip) => {
    if (!window.confirm('确认删除这个剧本片段？关联分镜也可能受到影响。')) return
    try {
      await requestJson(`/api/novel-promotion/${projectId}/clips/${clip.id}`, { method: 'DELETE' }, '删除剧本片段失败')
      await refreshMobileData()
    } catch (error) {
      alert(error instanceof Error ? error.message : '删除剧本片段失败')
    }
  }, [projectId, refreshMobileData, requestJson])

  const openUpload = useCallback((target: MobileUploadTarget) => {
    setUploadTarget(target)
    window.setTimeout(() => fileInputRef.current?.click(), 0)
  }, [])

  const handleUploadFile = useCallback(async (file: File) => {
    if (!uploadTarget) return
    const formData = new FormData()
    formData.append('file', file)
    const endpoint = (() => {
      if (uploadTarget.kind === 'panel-image') {
        formData.append('panelId', uploadTarget.panelId)
        return `/api/novel-promotion/${projectId}/upload-panel-image`
      }
      if (uploadTarget.kind === 'panel-frame-image') {
        formData.append('frameId', uploadTarget.frameId)
        return `/api/novel-promotion/${projectId}/upload-panel-frame-image`
      }
      formData.append('panelId', uploadTarget.panelId)
      return `/api/novel-promotion/${projectId}/upload-panel-video`
    })()
    try {
      await requestJson(endpoint, { method: 'POST', body: formData }, '上传失败')
      await refreshMobileData()
    } catch (error) {
      alert(error instanceof Error ? error.message : '上传失败')
    } finally {
      setUploadTarget(null)
    }
  }, [projectId, refreshMobileData, requestJson, uploadTarget])

  const openDialog = useCallback((next: MobilePanelDialog) => {
    setDialog(next)
    if (next.kind === 'panel-edit') {
      setDialogDraft([
        next.panel.shotType || '',
        next.panel.cameraMove || '',
        next.panel.location || '',
        String(getPanelDuration(next.panel) ?? ''),
        next.panel.description || '',
        next.panel.imagePrompt || '',
        next.panel.videoPrompt || '',
      ].join('\n---\n'))
    } else if (next.kind === 'insert-panel') {
      setDialogDraft('')
      setFrameTimeDraft('')
    } else if (next.kind === 'frame-edit') {
      setFrameTimeDraft(String(next.frame.frameTimeSec ?? 0))
      setDialogDraft(next.frame.imagePrompt || '')
    } else if (next.kind === 'video-prompt') {
      setFrameTimeDraft('')
      setDialogDraft(next.panel.panelMode === 'group'
        ? next.panel.groupVideoPrompt || next.panel.videoPrompt || ''
        : next.panel.videoPrompt || '')
    } else if (next.kind === 'first-last-prompt') {
      setFrameTimeDraft('')
      setDialogDraft(next.panel.firstLastFramePrompt || next.panel.groupVideoPrompt || next.panel.videoPrompt || '')
    } else if (next.kind === 'duration') {
      setFrameTimeDraft('')
      setDialogDraft(String(getPanelDuration(next.panel) ?? ''))
    }
  }, [])

  const submitDialog = useCallback(async () => {
    if (!dialog) return
    try {
      if (dialog.kind === 'panel-edit') {
        const [shotType = '', cameraMove = '', location = '', durationRaw = '', description = '', imagePrompt = '', videoPrompt = ''] = dialogDraft.split('\n---\n')
        const duration = durationRaw.trim() === '' ? null : Number(durationRaw.trim())
        await requestJson(`/api/novel-promotion/${projectId}/panel`, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            storyboardId: dialog.storyboardId,
            panelIndex: dialog.panel.panelIndex,
            id: dialog.panel.id,
            panelNumber: dialog.panel.panelNumber,
            shotType: shotType.trim(),
            cameraMove: cameraMove.trim(),
            location: location.trim(),
            duration: Number.isFinite(duration) ? duration : null,
            description: description.trim(),
            imagePrompt: imagePrompt.trim(),
            videoPrompt: videoPrompt.trim(),
          }),
        }, '保存分镜失败')
      } else if (dialog.kind === 'insert-panel') {
        await requestJson(`/api/novel-promotion/${projectId}/insert-panel`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            storyboardId: dialog.storyboardId,
            insertAfterPanelId: dialog.panel.id,
            userInput: dialogDraft.trim(),
          }),
        }, '插入分镜失败')
      } else if (dialog.kind === 'frame-edit') {
        const frameTimeSec = Number(frameTimeDraft.trim())
        await requestJson(`/api/novel-promotion/${projectId}/panel-frame`, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            frameId: dialog.frame.id,
            frameTimeSec: Number.isFinite(frameTimeSec) ? frameTimeSec : dialog.frame.frameTimeSec,
            imagePrompt: dialogDraft.trim(),
          }),
        }, '保存关键帧失败')
      } else if (dialog.kind === 'video-prompt') {
        await requestJson(`/api/novel-promotion/${projectId}/panel`, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            storyboardId: dialog.storyboardId,
            panelIndex: dialog.panel.panelIndex,
            [dialog.panel.panelMode === 'group' ? 'groupVideoPrompt' : 'videoPrompt']: dialogDraft,
          }),
        }, '保存视频提示词失败')
      } else if (dialog.kind === 'first-last-prompt') {
        await requestJson(`/api/novel-promotion/${projectId}/panel`, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            storyboardId: dialog.storyboardId,
            panelIndex: dialog.panel.panelIndex,
            firstLastFramePrompt: dialogDraft,
          }),
        }, '保存首尾帧提示词失败')
      } else if (dialog.kind === 'duration') {
        const duration = dialogDraft.trim() === '' ? null : Number(dialogDraft.trim())
        await requestJson(`/api/novel-promotion/${projectId}/panel`, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            storyboardId: dialog.storyboardId,
            panelIndex: dialog.panel.panelIndex,
            duration: Number.isFinite(duration) ? duration : null,
          }),
        }, '保存时长失败')
      }
      setDialog(null)
      await refreshMobileData()
    } catch (error) {
      alert(error instanceof Error ? error.message : '保存失败')
    }
  }, [dialog, dialogDraft, frameTimeDraft, projectId, refreshMobileData, requestJson])

  const runPanelCommand = useCallback(async (
    panel: MobilePanel,
    storyboardId: string,
    command: 'duplicate' | 'merge' | 'delete' | 'togglePreviousTail' | 'generateVideo',
    taskQueue?: TaskQueueContextValue,
  ) => {
    try {
      if (command === 'duplicate') {
        await requestJson(`/api/novel-promotion/${projectId}/duplicate-panel`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ panelId: panel.id }),
        }, '复制分镜失败')
      } else if (command === 'merge') {
        if (!window.confirm('确认将当前分镜和下一个分镜合并为分镜组？')) return
        await requestJson(`/api/novel-promotion/${projectId}/merge-panels`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ panelId: panel.id }),
        }, '合并分镜失败')
      } else if (command === 'delete') {
        if (!window.confirm('确认删除当前分镜？')) return
        await requestJson(`/api/novel-promotion/${projectId}/panel?panelId=${encodeURIComponent(panel.id)}`, {
          method: 'DELETE',
        }, '删除分镜失败')
      } else if (command === 'togglePreviousTail') {
        await requestJson(`/api/novel-promotion/${projectId}/panel`, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            panelId: panel.id,
            usePreviousPanelTailAsReference: !panel.usePreviousPanelTailAsReference,
          }),
        }, '更新上一尾帧引用失败')
      } else if (command === 'generateVideo') {
        const videoModel = projectQuery.data?.project.novelPromotionData?.videoModel || panel.videoModel || ''
        if (!videoModel) throw new Error('项目还没有配置默认视频模型，请先在 PC 端项目设置里配置。')
        const submit = async (): Promise<{ taskId?: unknown }> => await requestJson(`/api/novel-promotion/${projectId}/generate-video`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              storyboardId,
              panelIndex: panel.panelIndex,
              panelId: panel.id,
              videoModel,
              generationOptions: {
                ...(typeof getPanelDuration(panel) === 'number' ? { duration: getPanelDuration(panel) } : {}),
              },
            }),
          }, '提交视频生成失败') as { taskId?: unknown }
        if (taskQueue?.enabled) {
          taskQueue.enqueueMany(buildMobileVideoQueueItems({
            projectId,
            batchId: String(Date.now()),
            panels: [panel],
            submit,
            onSettled: refreshMobileData,
          }))
          setPanelMenu(null)
          return
        } else {
          await submit()
        }
      }
      setPanelMenu(null)
      await refreshMobileData()
    } catch (error) {
      alert(error instanceof Error ? error.message : '操作失败')
    }
  }, [projectId, projectQuery.data?.project.novelPromotionData?.videoModel, refreshMobileData, requestJson])

  const runFrameCommand = useCallback(async (
    frame: MobilePanelFrame,
    panel: MobilePanel,
    command: 'delete' | 'splitBefore' | 'splitAfter' | 'insertBefore' | 'insertAfter',
  ) => {
    try {
      if (command === 'delete') {
        if (!window.confirm('确认删除这个关键帧？')) return
        await requestJson(`/api/novel-promotion/${projectId}/panel-frame`, {
          method: 'DELETE',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ frameId: frame.id }),
        }, '删除关键帧失败')
      } else if (command === 'splitBefore' || command === 'splitAfter') {
        await requestJson(`/api/novel-promotion/${projectId}/split-panel-frame`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ frameId: frame.id, placement: command === 'splitBefore' ? 'before' : 'after' }),
        }, '拆出关键帧失败')
      } else if (command === 'insertBefore' || command === 'insertAfter') {
        await requestJson(`/api/novel-promotion/${projectId}/panel-frame`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ frameId: frame.id, placement: command === 'insertBefore' ? 'before' : 'after' }),
        }, '插入关键帧失败')
      }
      setFrameMenu(null)
      await refreshMobileData()
    } catch (error) {
      alert(error instanceof Error ? error.message : '操作失败')
    }
  }, [projectId, refreshMobileData, requestJson])

  const insertPanelFrame = useCallback(async (panel: MobilePanel) => {
    try {
      await requestJson(`/api/novel-promotion/${projectId}/panel-frame`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ panelId: panel.id, placement: 'after' }),
      }, '插入关键帧失败')
      setPanelMenu(null)
      await refreshMobileData()
    } catch (error) {
      alert(error instanceof Error ? error.message : '插入关键帧失败')
    }
  }, [projectId, refreshMobileData, requestJson])

  const handleDownloadAllImages = useCallback(async () => {
    if (!selectedEpisodeId) return
    try {
      const response = await apiFetch(`/api/novel-promotion/${projectId}/download-images?episodeId=${selectedEpisodeId}`)
      if (!response.ok) throw new Error(await readErrorMessage(response, '下载全部图片失败'))
      const blob = await response.blob()
      const url = URL.createObjectURL(blob)
      const anchor = document.createElement('a')
      anchor.href = url
      anchor.download = 'images.zip'
      anchor.click()
      URL.revokeObjectURL(url)
    } catch (error) {
      alert(error instanceof Error ? error.message : '下载全部图片失败')
    }
  }, [projectId, selectedEpisodeId])

  if (status === 'loading') {
    return <MobileShell title="移动工作台"><MobileLoadingState /></MobileShell>
  }

  if (!session) {
    const queryString = searchParams?.toString()
    router.replace({
      pathname: '/auth/signin',
      query: { next: `${pathname || `/zh/mobile/workspace/${projectId}`}${queryString ? `?${queryString}` : ''}` },
    })
    return <MobileShell title="移动工作台"><MobileLoadingState label="正在跳转登录..." /></MobileShell>
  }

  const project = projectQuery.data?.project
  const episode = episodeQuery.data?.episode
  const clips = Array.isArray(episode?.clips)
    ? [...episode.clips].sort((left, right) => {
      const leftStart = typeof left.start === 'number' ? left.start : Number.MAX_SAFE_INTEGER
      const rightStart = typeof right.start === 'number' ? right.start : Number.MAX_SAFE_INTEGER
      if (leftStart !== rightStart) return leftStart - rightStart
      return (left.createdAt || '').localeCompare(right.createdAt || '')
    })
    : []
  const panels = getSortedPanels(episode)
  const promptDetailPanel = panels.find((panel) => panel.id === promptDetailPanelId) || null
  const panelGroups = getSortedPanelGroups(episode)
  const videoPanels = panels.filter((panel) => getPanelVideoUrl(panel))
  const runningTasks = (tasksQuery.data?.tasks || []).filter((task) => task.status === 'queued' || task.status === 'processing')
  const activeImageTargetIds = new Set(
    runningTasks
      .filter((task) => (
        task.type === 'image_panel' || task.type === 'panel_variant' || task.type === 'modify_asset_image'
      ))
      .map((task) => task.targetId)
      .filter((targetId): targetId is string => Boolean(targetId)),
  )
  const activeVideoTargetIds = new Set(
    runningTasks
      .filter((task) => task.type === 'video_panel' || task.type === 'lip_sync')
      .map((task) => task.targetId)
      .filter((targetId): targetId is string => Boolean(targetId)),
  )

  const handleGeneratePanelImage = async (taskQueue: TaskQueueContextValue, panel: MobilePanel) => {
    if (taskQueue.enabled) {
      taskQueue.enqueueMany(buildMobileStoryboardQueueItems({
        projectId,
        batchId: String(Date.now()),
        panels: [panel],
        submit: async (candidate) => await regenerateImage.mutateAsync(candidate.id) as { taskId?: unknown },
        onSettled: refreshMobileData,
      }))
      return
    }
    regenerateImage.mutate(panel.id)
  }

  const handleGeneratePanelFrameImage = async (
    taskQueue: TaskQueueContextValue,
    panelId: string,
    frameId: string,
  ) => {
    if (taskQueue.enabled) {
      taskQueue.enqueue({
        id: `mobile-storyboard-frame:${Date.now()}:${frameId}`,
        group: 'storyboard',
        projectId,
        target: {
          targetType: 'NovelPromotionPanelFrame',
          targetId: frameId,
          types: ['image_panel', 'panel_variant', 'modify_asset_image'],
        },
        uiKey: `panel-frame-${frameId}`,
        label: `关键帧：${frameId.slice(0, 6)}`,
        submit: async () => {
          const result = await regenerateFrameImage.mutateAsync({ panelId, frameId }) as { taskId?: unknown }
          return { taskId: String(result?.taskId || '') }
        },
        onDone: refreshMobileData,
        onFail: refreshMobileData,
      })
      return
    }
    regenerateFrameImage.mutate({ panelId, frameId })
  }

  const handleGenerateMissingPanelImages = async (taskQueue: TaskQueueContextValue) => {
    const pending = panels.filter((panel) => (
      !getPanelImageUrl(panel) &&
      !activeImageTargetIds.has(panel.id) &&
      !getMobileQueueUiStatus(taskQueue.queue, `panel-${panel.id}`)
    ))
    if (pending.length === 0) {
      alert('当前没有待生成的分镜图片')
      return
    }
    if (taskQueue.enabled) {
      taskQueue.enqueueMany(buildMobileStoryboardQueueItems({
        projectId,
        batchId: String(Date.now()),
        panels: pending,
        submit: async (panel) => await regenerateImage.mutateAsync(panel.id) as { taskId?: unknown },
        onSettled: refreshMobileData,
      }))
      return
    }
    try {
      const result = await runMobileGenerationBatch(
        pending,
        async (panel) => await regenerateImage.mutateAsync(panel.id),
      )
      await refreshMobileData()
      if (result.failed > 0) {
        alert(`分镜图片提交完成：成功 ${result.succeeded} 个，失败 ${result.failed} 个\n${result.errors.slice(0, 3).join('\n')}`)
      }
    } catch (error) {
      alert(error instanceof Error ? error.message : '批量生成分镜图片失败')
    }
  }

  const handleGenerateAllVideos = async (taskQueue: TaskQueueContextValue) => {
    const videoModel = project?.novelPromotionData?.videoModel || ''
    if (!videoModel) {
      alert('项目还没有配置默认视频模型，请先在项目设置里配置。')
      return
    }
    const candidates = panels.filter((panel) => (
      !getPanelVideoUrl(panel) &&
      !activeVideoTargetIds.has(panel.id) &&
      !getMobileQueueUiStatus(taskQueue.queue, `video-panel-${panel.id}`)
    ))
    if (candidates.length === 0) {
      alert('当前没有待生成的成片')
      return
    }
    const submit = async (panel: MobilePanel): Promise<{ taskId?: unknown }> => await requestJson(`/api/novel-promotion/${projectId}/generate-video`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        storyboardId: panel.storyboardId,
        panelIndex: panel.panelIndex,
        panelId: panel.id,
        videoModel,
        generationOptions: {
          ...(typeof getPanelDuration(panel) === 'number' ? { duration: getPanelDuration(panel) } : {}),
        },
      }),
    }, '提交视频生成失败') as { taskId?: unknown }

    if (taskQueue.enabled) {
      taskQueue.enqueueMany(buildMobileVideoQueueItems({
        projectId,
        batchId: String(Date.now()),
        panels: candidates,
        submit,
        onSettled: refreshMobileData,
      }))
      return
    }

    const result = await runMobileGenerationBatch(candidates, submit)
    await refreshMobileData()
    if (result.failed > 0) {
      alert(`成片提交完成：成功 ${result.succeeded} 个，失败 ${result.failed} 个\n${result.errors.slice(0, 3).join('\n')}`)
    }
  }

  const handleGenerateFirstLastVideo = async (taskQueue: TaskQueueContextValue, panel: MobilePanel) => {
    const index = panels.findIndex((item) => item.id === panel.id)
    const nextPanel = index >= 0 ? panels[index + 1] : null
    const videoModel = project?.novelPromotionData?.videoModel || panel.videoModel || ''
    if (!nextPanel || !panel.storyboardId || !nextPanel.storyboardId) {
      alert('当前分镜后面没有可用于尾帧的分镜')
      return
    }
    if (!videoModel) {
      alert('请先在项目设置中选择视频模型')
      return
    }
    const submit = async (): Promise<{ taskId?: unknown }> => await requestJson(`/api/novel-promotion/${projectId}/generate-video`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          storyboardId: panel.storyboardId,
          panelIndex: panel.panelIndex,
          panelId: panel.id,
          videoModel,
          firstLastFrame: {
            lastFrameStoryboardId: nextPanel.storyboardId,
            lastFramePanelIndex: nextPanel.panelIndex,
            flModel: videoModel,
            customPrompt: panel.firstLastFramePrompt || undefined,
          },
        }),
      }, '首尾帧视频生成失败') as { taskId?: unknown }
    try {
      if (taskQueue.enabled) {
        taskQueue.enqueueMany(buildMobileVideoQueueItems({
          projectId,
          batchId: `first-last-${Date.now()}`,
          panels: [panel],
          submit,
          onSettled: refreshMobileData,
        }))
        return
      }
      await submit()
      await refreshMobileData()
    } catch (error) {
      alert(error instanceof Error ? error.message : '首尾帧视频生成失败')
    }
  }

  const handleEpisodeChange = (episodeId: string) => {
    router.replace({
      pathname: `/mobile/workspace/${projectId}` as never,
      query: { episode: episodeId },
    })
  }

  const handleCopyPrompt = async (panel: MobilePanel) => {
    const prompt = panel.panelMode === 'group'
      ? panel.groupVideoPrompt || panel.videoPrompt || panel.imagePrompt || ''
      : panel.videoPrompt || panel.imagePrompt || panel.description || ''
    const ok = await copyText(prompt)
    if (ok) {
      setCopiedPanelId(panel.id)
      window.setTimeout(() => setCopiedPanelId(null), 1200)
    }
  }

  const handleCopyFramePrompt = async (frame: MobilePanelFrame) => {
    const prompt = frame.imagePrompt || frame.videoPrompt || ''
    const ok = await copyText(prompt)
    if (ok) {
      setCopiedFrameId(frame.id)
      window.setTimeout(() => setCopiedFrameId(null), 1200)
    }
  }

  return (
    <MobileProjectTaskQueueBoundary
      projectId={projectId}
      episodeId={selectedEpisodeId}
      projectData={project?.novelPromotionData}
      onTaskTerminal={refreshMobileData}
    >
      {(taskQueue) => (
      <MobileShell
      title={project?.name || '移动工作台'}
      subtitle={episode?.name || 'H5 轻量工作台'}
      action={(
        <Link href="/mobile" className="inline-flex h-9 items-center rounded-full border border-slate-200 bg-white px-3 text-xs font-semibold text-slate-700 shadow-sm active:scale-95">
          返回
        </Link>
      )}
    >
      {projectQuery.isLoading ? (
        <MobileLoadingState label="正在加载项目..." />
      ) : projectQuery.isError ? (
        <MobileEmptyState title="项目加载失败" description={projectQuery.error.message} />
      ) : episodes.length === 0 ? (
        <div className="space-y-3">
          <MobileEmptyState title="暂无剧集" description="可以直接在手机创建第一集。" />
          <button type="button" onClick={openCreateEpisode} className="w-full rounded-[22px] bg-blue-600 px-4 py-3 text-sm font-semibold text-white shadow-sm">
            新建第一集
          </button>
          <div className="grid grid-cols-2 gap-2">
            <button type="button" onClick={() => setTab('assets')} className="rounded-[20px] bg-white px-4 py-3 text-sm font-semibold text-slate-700 shadow-sm ring-1 ring-slate-200">项目资产</button>
            <button type="button" onClick={() => setTab('project-settings')} className="rounded-[20px] bg-white px-4 py-3 text-sm font-semibold text-slate-700 shadow-sm ring-1 ring-slate-200">项目设置</button>
          </div>
          {tab === 'assets' ? <MobileProjectAssets projectId={projectId} onBack={() => setTab('story')} /> : null}
        </div>
      ) : (
        <>
          <section className="mb-3 overflow-x-auto pb-1">
            <div className="flex gap-2">
              {episodes.map((item) => (
                <button
                  key={item.id}
                  type="button"
                  onClick={() => handleEpisodeChange(item.id)}
                  className={`shrink-0 rounded-full px-3.5 py-2 text-sm font-semibold active:scale-95 ${item.id === selectedEpisodeId ? 'bg-slate-950 text-white shadow-sm' : 'bg-white text-slate-600 ring-1 ring-slate-200'}`}
                >
                  {item.name}
                </button>
              ))}
              <button type="button" onClick={openCreateEpisode} className="flex shrink-0 items-center gap-1 rounded-full bg-blue-50 px-3.5 py-2 text-sm font-semibold text-blue-600 ring-1 ring-blue-100">
                <AppIcon name="plus" className="h-4 w-4" />
                新建剧集
              </button>
            </div>
          </section>

          <section className="mb-4 rounded-[24px] bg-white p-4 shadow-sm ring-1 ring-slate-200/80">
            <div className="flex items-start justify-between gap-3">
              <div className="min-w-0">
                <div className="text-xs font-medium text-slate-400">当前剧集</div>
                <div className="mt-1 truncate text-lg font-semibold">{episode?.name || '加载中'}</div>
              </div>
              <div className="flex items-center gap-1">
                <button type="button" onClick={() => selectedEpisodeId && openRenameEpisode(selectedEpisodeId, episode?.name || '')} className="rounded-full bg-slate-100 p-2 text-slate-600" aria-label="重命名剧集">
                  <AppIcon name="edit" className="h-4 w-4" />
                </button>
                <button type="button" onClick={() => selectedEpisodeId && void deleteEpisode(selectedEpisodeId, episode?.name || '当前剧集')} className="rounded-full bg-red-50 p-2 text-red-500" aria-label="删除剧集">
                  <AppIcon name="trash" className="h-4 w-4" />
                </button>
                <button
                  type="button"
                  onClick={() => {
                    void episodeQuery.refetch()
                    void tasksQuery.refetch()
                  }}
                  className="rounded-full bg-slate-100 p-2 text-slate-600"
                  aria-label="刷新剧集"
                >
                  <AppIcon name="refresh" className="h-4 w-4" />
                </button>
              </div>
            </div>
            <div className="mt-4 grid grid-cols-4 gap-2 text-center">
              <div className="rounded-2xl bg-violet-50 px-2 py-2.5">
                <div className="text-base font-semibold text-violet-700">{clips.length}</div>
                <div className="text-[10px] text-violet-600/70">片段</div>
              </div>
              <div className="rounded-2xl bg-blue-50 px-2 py-2.5">
                <div className="text-base font-semibold text-blue-700">{panels.length}</div>
                <div className="text-[10px] text-blue-600/70">分镜</div>
              </div>
              <div className="rounded-2xl bg-emerald-50 px-2 py-2.5">
                <div className="text-base font-semibold text-emerald-700">{videoPanels.length}</div>
                <div className="text-[10px] text-emerald-600/70">成片</div>
              </div>
              <div className="rounded-2xl bg-amber-50 px-2 py-2.5">
                <div className="text-base font-semibold text-amber-700">{runningTasks.length}</div>
                <div className="text-[10px] text-amber-600/70">运行中</div>
              </div>
            </div>
          </section>

          {episodeQuery.isLoading ? <MobileLoadingState label="正在加载剧集..." /> : null}
          {episodeQuery.isError ? <MobileEmptyState title="剧集加载失败" description={episodeQuery.error.message} /> : null}
          {!episodeQuery.isLoading && !episodeQuery.isError && tab === 'story' ? (
            smartSplitText !== null ? (
              <div className="overflow-hidden rounded-[24px] bg-white shadow-sm ring-1 ring-slate-200/80">
                <SmartImportWizard
                  projectId={projectId}
                  initialRawContent={smartSplitText}
                  onManualCreate={() => setSmartSplitText(null)}
                  onImportComplete={() => {
                    setSmartSplitText(null)
                    void projectQuery.refetch().then((result) => {
                      const firstEpisodeId = result.data?.project.novelPromotionData?.episodes?.[0]?.id
                      if (firstEpisodeId) {
                        router.replace({ pathname: `/mobile/workspace/${projectId}` as never, query: { episode: firstEpisodeId } })
                      }
                    })
                  }}
                />
              </div>
            ) : (
              <div className="space-y-3">
                <div className="rounded-[24px] bg-white p-3 shadow-sm ring-1 ring-slate-200/80">
                  <NovelInputStage
                    mobile
                    novelText={storyDraft}
                    episodeName={episode?.name}
                    onNovelTextChange={setStoryDraft}
                    onNext={() => { void runStoryToScriptMobile() }}
                    onSmartSplit={setSmartSplitText}
                    isSubmittingTask={savingStory || storyToScriptStream.isRunning || storyToScriptStream.isRecoveredRunning}
                    isSwitchingStage={storyToScriptStream.status === 'running'}
                    videoRatio={project?.novelPromotionData?.videoRatio || undefined}
                    artStyle={project?.novelPromotionData?.artStyle || undefined}
                    onVideoRatioChange={(value) => { void updateStoryProjectConfig('videoRatio', value) }}
                    onArtStyleChange={(value) => { void updateStoryProjectConfig('artStyle', value) }}
                  />
                  <button type="button" onClick={() => void saveStoryDraft()} disabled={savingStory} className="mt-3 w-full rounded-2xl bg-slate-950 px-4 py-3 text-sm font-semibold text-white disabled:opacity-50">
                    {savingStory ? '保存中' : '仅保存故事'}
                  </button>
                </div>
                <RunProgressPanel stream={{
                  running: storyToScriptStream.isRunning || storyToScriptStream.isRecoveredRunning || storyToScriptStream.status === 'running',
                  progress: storyToScriptStream.overallProgress,
                  activeMessage: storyToScriptStream.activeMessage,
                  outputText: storyToScriptStream.outputText,
                  errorMessage: storyToScriptStream.errorMessage,
                }} />
              </div>
            )
          ) : null}
          {!episodeQuery.isLoading && !episodeQuery.isError && tab === 'script' ? (
            <ScriptTab
              clips={clips}
              panelGroups={panelGroups}
              stream={{
                running: scriptToStoryboardStream.isRunning || scriptToStoryboardStream.isRecoveredRunning || scriptToStoryboardStream.status === 'running',
                progress: scriptToStoryboardStream.overallProgress,
                activeMessage: scriptToStoryboardStream.activeMessage,
                outputText: scriptToStoryboardStream.outputText,
                errorMessage: scriptToStoryboardStream.errorMessage,
              }}
              onRunAll={() => void runScriptToStoryboardMobile()}
              onRunClip={(clipId) => void runScriptToStoryboardMobile(clipId)}
              onStop={() => scriptToStoryboardStream.stop()}
              onGoStory={() => setTab('story')}
              onOpenAssets={() => setTab('assets')}
              onOpenMenu={setScriptMenu}
            />
          ) : null}
          {!episodeQuery.isLoading && !episodeQuery.isError && tab === 'storyboard' ? (
            <StoryboardTab
              panels={panels}
              panelGroups={panelGroups}
              copiedPanelId={copiedPanelId}
              regeneratingPanelId={regenerateImage.isPending ? regenerateImage.variables || null : null}
              copiedFrameId={copiedFrameId}
              regeneratingFrameId={regenerateFrameImage.isPending ? regenerateFrameImage.variables?.frameId || null : null}
              activeImageTargetIds={activeImageTargetIds}
              expandedClipIds={expandedClipIds}
              onToggleClipSummary={(clipId) => {
                setExpandedClipIds((previous) => {
                  const next = new Set(previous)
                  if (next.has(clipId)) next.delete(clipId)
                  else next.add(clipId)
                  return next
                })
              }}
              onPreview={(url) => setPreview({ type: 'image', url })}
              onCopyPrompt={handleCopyPrompt}
              onCopyFramePrompt={handleCopyFramePrompt}
              onRegenerate={(panel) => void handleGeneratePanelImage(taskQueue, panel)}
              onRegenerateFrame={(panelId, frameId) => void handleGeneratePanelFrameImage(taskQueue, panelId, frameId)}
              onDownloadAllImages={handleDownloadAllImages}
              onGenerateAllImages={() => void handleGenerateMissingPanelImages(taskQueue)}
              onTogglePreviousTail={(panel, storyboardId) => void runPanelCommand(panel, storyboardId, 'togglePreviousTail', taskQueue)}
              onOpenPromptDetail={(panel) => setPromptDetailPanelId(panel.id)}
              onOpenPanelMenu={setPanelMenu}
              onOpenFrameMenu={setFrameMenu}
              onEditFrame={(frame) => openDialog({ kind: 'frame-edit', frame })}
            />
          ) : null}
          {!episodeQuery.isLoading && !episodeQuery.isError && tab === 'videos' ? (
            <VideosTab
              panels={panels}
              copiedPanelId={copiedPanelId}
              activeVideoTargetIds={activeVideoTargetIds}
              onGenerateAll={() => void handleGenerateAllVideos(taskQueue)}
              onGenerateVideo={(panel) => void runPanelCommand(panel, panel.storyboardId || '', 'generateVideo', taskQueue)}
              onCopyPrompt={handleCopyPrompt}
              onViewPrompt={(panel, prompt) => setTextPreview({
                title: `视频片段 ${panel.panelNumber || panel.panelIndex + 1} · 视频提示词`,
                content: prompt,
              })}
              onEditVideoPrompt={(panel) => openDialog({ kind: 'video-prompt', panel, storyboardId: panel.storyboardId || '' })}
              onPreviewImage={(url) => setPreview({ type: 'image', url })}
              onOpenMenu={setVideoMenu}
            />
          ) : null}
          {tab === 'tasks' ? (
            <TasksTab
              tasks={tasksQuery.data?.tasks || []}
              loading={tasksQuery.isLoading}
              cancellingTaskId={cancelTask.variables || null}
              onCancel={(taskId) => cancelTask.mutate(taskId)}
              onRefresh={() => void tasksQuery.refetch()}
              onDismissFailed={(taskIds) => dismissFailedTasks.mutate(taskIds)}
            />
          ) : null}
          {tab === 'more' ? (
            <MoreTab
              projectId={projectId}
              runningTaskCount={runningTasks.length}
              onSelect={setTab}
            />
          ) : null}
          {tab === 'assets' ? (
            <MobileProjectAssets projectId={projectId} onBack={() => setTab('more')} />
          ) : null}
          {tab === 'voice' && selectedEpisodeId ? (
            <MobileVoice
              projectId={projectId}
              episodeId={selectedEpisodeId}
              onBack={() => setTab('more')}
              onOpenAssets={() => setTab('assets')}
            />
          ) : null}
          <BottomTabs
            value={tab}
            counts={{
              story: storyDraft.trim() ? 1 : 0,
              script: clips.length,
              storyboard: panels.length,
              videos: videoPanels.length,
              more: runningTasks.length,
            }}
            onChange={setTab}
          />
        </>
      )}

      {preview ? <PreviewModal type={preview.type} url={preview.url} onClose={() => setPreview(null)} /> : null}
      {textPreview ? <MobileTextPreviewModal title={textPreview.title} content={textPreview.content} onClose={() => setTextPreview(null)} /> : null}
      {promptDetailPanel ? (
        <MobileStoryboardPromptDetail
          panel={promptDetailPanel}
          panelOrder={promptDetailPanel.panelNumber || panels.findIndex((panel) => panel.id === promptDetailPanel.id) + 1}
          frames={getSortedFrames(promptDetailPanel)}
          copiedFrameId={copiedFrameId}
          regeneratingFrameId={regenerateFrameImage.isPending ? regenerateFrameImage.variables?.frameId || null : null}
          onClose={() => setPromptDetailPanelId(null)}
          onPreview={(url) => setPreview({ type: 'image', url })}
          onCopyPrompt={handleCopyFramePrompt}
          onEditPrompt={(frame) => {
            setPromptDetailPanelId(null)
            openDialog({ kind: 'frame-edit', frame })
          }}
          onRegenerate={(panelId, frameId) => void handleGeneratePanelFrameImage(taskQueue, panelId, frameId)}
        />
      ) : null}
      {episodeDialog ? (
        <div className="fixed inset-0 z-50 flex items-end bg-black/45" onClick={() => setEpisodeDialog(null)}>
          <div className="w-full rounded-t-[28px] bg-white p-4 pb-[calc(1rem+env(safe-area-inset-bottom))]" onClick={(event) => event.stopPropagation()}>
            <div className="mx-auto mb-3 h-1.5 w-10 rounded-full bg-slate-200" />
            <h2 className="text-base font-semibold text-slate-950">{episodeDialog.mode === 'create' ? '新建剧集' : '重命名剧集'}</h2>
            <input autoFocus value={episodeNameDraft} onChange={(event) => setEpisodeNameDraft(event.target.value)} className="mt-4 w-full rounded-2xl border border-slate-200 px-4 py-3 text-sm outline-none focus:border-blue-400" placeholder="剧集名称" />
            <div className="mt-4 grid grid-cols-2 gap-2">
              <button type="button" onClick={() => setEpisodeDialog(null)} className="rounded-2xl bg-slate-100 px-4 py-3 text-sm font-semibold text-slate-600">取消</button>
              <button type="button" disabled={savingEpisode} onClick={() => void saveEpisode()} className="rounded-2xl bg-blue-600 px-4 py-3 text-sm font-semibold text-white disabled:opacity-60">{savingEpisode ? '保存中' : '保存'}</button>
            </div>
          </div>
        </div>
      ) : null}
      {tab === 'project-settings' ? (
        <MobileProjectSettings
          projectId={projectId}
          projectData={project?.novelPromotionData}
          onClose={() => setTab('more')}
          onUpdated={() => { void projectQuery.refetch() }}
        />
      ) : null}
      <input
        ref={fileInputRef}
        type="file"
        accept={uploadTarget?.kind === 'panel-video' ? 'video/*' : 'image/*'}
        className="hidden"
        onChange={(event) => {
          const file = event.target.files?.[0]
          event.target.value = ''
          if (file) void handleUploadFile(file)
        }}
      />
      {panelMenu ? (
        <MobileActionSheet
          title={`分镜 ${panelMenu.panel.panelNumber || panelMenu.panel.panelIndex + 1}`}
          subtitle={panelMenu.panel.description || panelMenu.panel.shotType || undefined}
          onClose={() => setPanelMenu(null)}
        >
          <SheetButton label="编辑分镜" icon="edit" onClick={() => { openDialog({ kind: 'panel-edit', panel: panelMenu.panel, storyboardId: panelMenu.storyboardId }); setPanelMenu(null) }} />
          <SheetButton label="上传图片" icon="upload" onClick={() => { openUpload({ kind: 'panel-image', panelId: panelMenu.panel.id }); setPanelMenu(null) }} />
          <SheetButton label="下载原图" icon="download" disabled={!getPanelImageUrl(panelMenu.panel)} onClick={() => { const url = getPanelImageUrl(panelMenu.panel); if (url) void downloadRemoteFile(url, `panel-${panelMenu.panel.panelNumber || panelMenu.panel.panelIndex + 1}.jpg`); setPanelMenu(null) }} />
          <SheetButton label="插入分镜" icon="plus" onClick={() => { openDialog({ kind: 'insert-panel', panel: panelMenu.panel, storyboardId: panelMenu.storyboardId }); setPanelMenu(null) }} />
          <SheetButton label="复制到下一分镜" icon="copy" onClick={() => void runPanelCommand(panelMenu.panel, panelMenu.storyboardId, 'duplicate')} />
          <SheetButton label="合并下一分镜" icon="clapperboard" disabled={!panelMenu.hasNext} onClick={() => void runPanelCommand(panelMenu.panel, panelMenu.storyboardId, 'merge')} />
          <SheetButton label={getSortedFrames(panelMenu.panel).length > 1 ? '追加关键帧' : '插入关键帧组'} icon="plus" onClick={() => void insertPanelFrame(panelMenu.panel)} />
          {panelMenu.hasPrevious ? (
            <SheetButton label={panelMenu.panel.usePreviousPanelTailAsReference ? '关闭上一尾帧' : '引用上一尾帧'} icon="link" onClick={() => void runPanelCommand(panelMenu.panel, panelMenu.storyboardId, 'togglePreviousTail')} />
          ) : null}
          <SheetButton label="生成视频" icon="video" tone="primary" onClick={() => void runPanelCommand(panelMenu.panel, panelMenu.storyboardId, 'generateVideo', taskQueue)} />
          <SheetButton label="删除分镜" icon="trash" tone="danger" onClick={() => void runPanelCommand(panelMenu.panel, panelMenu.storyboardId, 'delete')} />
        </MobileActionSheet>
      ) : null}
      {frameMenu ? (
        <MobileActionSheet
          title={`关键帧 F${frameMenu.frame.frameIndex + 1}`}
          subtitle={`${frameMenu.frame.frameTimeSec}s · ${frameMenu.frame.frameRole || '关键状态'}`}
          onClose={() => setFrameMenu(null)}
        >
          <SheetButton label="编辑提示词/秒数" icon="edit" onClick={() => { openDialog({ kind: 'frame-edit', frame: frameMenu.frame }); setFrameMenu(null) }} />
          <SheetButton label="上传替换图片" icon="upload" onClick={() => { openUpload({ kind: 'panel-frame-image', frameId: frameMenu.frame.id }); setFrameMenu(null) }} />
          <SheetButton label="前插关键帧" icon="plus" onClick={() => void runFrameCommand(frameMenu.frame, frameMenu.panel, 'insertBefore')} />
          <SheetButton label="后插关键帧" icon="plusAlt" onClick={() => void runFrameCommand(frameMenu.frame, frameMenu.panel, 'insertAfter')} />
          <SheetButton label="拆到组前" icon="arrowRight" onClick={() => void runFrameCommand(frameMenu.frame, frameMenu.panel, 'splitBefore')} />
          <SheetButton label="拆到组后" icon="arrowRight" onClick={() => void runFrameCommand(frameMenu.frame, frameMenu.panel, 'splitAfter')} />
          <SheetButton label="删除关键帧" icon="trash" tone="danger" onClick={() => void runFrameCommand(frameMenu.frame, frameMenu.panel, 'delete')} />
        </MobileActionSheet>
      ) : null}
      {videoMenu ? (
        <MobileActionSheet
          title={`视频片段 ${videoMenu.panelNumber || videoMenu.panelIndex + 1}`}
          subtitle={`${getPanelDuration(videoMenu) ?? '-'}s · ${videoMenu.shotType || videoMenu.description || '成片操作'}`}
          onClose={() => setVideoMenu(null)}
        >
          <SheetButton label="生成/重新生成" icon="video" tone="primary" onClick={() => { void runPanelCommand(videoMenu, videoMenu.storyboardId || '', 'generateVideo', taskQueue); setVideoMenu(null) }} />
          <SheetButton label="编辑视频提示词" icon="edit" onClick={() => { openDialog({ kind: 'video-prompt', panel: videoMenu, storyboardId: videoMenu.storyboardId || '' }); setVideoMenu(null) }} />
          <SheetButton label="复制视频提示词" icon="copy" onClick={() => { void handleCopyPrompt(videoMenu); setVideoMenu(null) }} />
          <SheetButton label="修改片段秒数" icon="clock" onClick={() => { openDialog({ kind: 'duration', panel: videoMenu, storyboardId: videoMenu.storyboardId || '' }); setVideoMenu(null) }} />
          <SheetButton label="上传替换视频" icon="upload" onClick={() => { openUpload({ kind: 'panel-video', panelId: videoMenu.id }); setVideoMenu(null) }} />
          <SheetButton label="下载视频" icon="download" disabled={!getPanelVideoUrl(videoMenu)} onClick={() => { const url = getPanelVideoUrl(videoMenu); if (url) void downloadRemoteFile(url, `video-${videoMenu.panelNumber || videoMenu.panelIndex + 1}.mp4`); setVideoMenu(null) }} />
          <SheetButton label="视频与角色配音" icon="mic" onClick={() => { setTab('voice'); setVideoMenu(null) }} />
          <SheetButton label="编辑首尾帧提示词" icon="link" onClick={() => { openDialog({ kind: 'first-last-prompt', panel: videoMenu, storyboardId: videoMenu.storyboardId || '' }); setVideoMenu(null) }} />
          <SheetButton label="生成首尾帧视频" icon="video" disabled={panels.findIndex((item) => item.id === videoMenu.id) >= panels.length - 1} onClick={() => { void handleGenerateFirstLastVideo(taskQueue, videoMenu); setVideoMenu(null) }} />
        </MobileActionSheet>
      ) : null}
      {scriptMenu ? (
        <MobileActionSheet
          title={`剧本片段 ${(scriptMenu.clipIndex ?? clips.findIndex((item) => item.id === scriptMenu.id)) + 1}`}
          subtitle={scriptMenu.summary || formatClipSummary(scriptMenu.screenplay, scriptMenu.content) || '片段操作'}
          onClose={() => setScriptMenu(null)}
        >
          <SheetButton label="生成/重新生成分镜" icon="imagePreview" tone="primary" onClick={() => { void runScriptToStoryboardMobile(scriptMenu.id); setScriptMenu(null) }} />
          <SheetButton label="编辑剧本" icon="edit" onClick={() => { openScriptDialog(scriptMenu, 'screenplay'); setScriptMenu(null) }} />
          <SheetButton label="编辑片段原文" icon="edit" onClick={() => { openScriptDialog(scriptMenu, 'content'); setScriptMenu(null) }} />
          <SheetButton label="编辑出场角色" icon="user" onClick={() => { openScriptDialog(scriptMenu, 'characters'); setScriptMenu(null) }} />
          <SheetButton label="编辑出场场景" icon="imageLandscape" onClick={() => { openScriptDialog(scriptMenu, 'location'); setScriptMenu(null) }} />
          <SheetButton label="编辑出场道具" icon="package" onClick={() => { openScriptDialog(scriptMenu, 'props'); setScriptMenu(null) }} />
          <SheetButton label="打开项目资产" icon="folderHeart" onClick={() => { setTab('assets'); setScriptMenu(null) }} />
          <SheetButton label="删除片段" icon="trash" tone="danger" onClick={() => { void deleteScriptClip(scriptMenu); setScriptMenu(null) }} />
        </MobileActionSheet>
      ) : null}
      {scriptDialog ? (
        <div className="fixed inset-0 z-50 flex flex-col bg-[#f4f6f8]">
          <div className="flex items-center gap-3 border-b border-slate-200 bg-white px-4 pb-3 pt-[calc(0.75rem+env(safe-area-inset-top))]">
            <button type="button" onClick={() => setScriptDialog(null)} className="flex h-10 w-10 items-center justify-center rounded-full bg-slate-100 text-slate-600">
              <AppIcon name="chevronLeft" className="h-5 w-5" />
            </button>
            <div className="min-w-0 flex-1">
              <div className="text-base font-semibold text-slate-950">编辑{scriptDialog.field === 'screenplay' ? '剧本' : scriptDialog.field === 'content' ? '片段原文' : scriptDialog.field === 'characters' ? '出场角色' : scriptDialog.field === 'location' ? '出场场景' : '出场道具'}</div>
              <div className="truncate text-xs text-slate-500">{scriptDialog.clip.summary || `片段 ${scriptDialog.clip.clipIndex ?? ''}`}</div>
            </div>
            <button type="button" onClick={() => void submitScriptDialog()} className="min-h-10 rounded-full bg-blue-600 px-4 text-sm font-semibold text-white">
              保存
            </button>
          </div>
          <div className="min-h-0 flex-1 p-4 pb-[calc(1rem+env(safe-area-inset-bottom))]">
            <textarea
              autoFocus
              value={scriptDraft}
              onChange={(event) => setScriptDraft(event.target.value)}
              className="h-full w-full resize-none rounded-[22px] border border-slate-200 bg-white p-4 text-sm leading-7 text-slate-800 shadow-sm outline-none focus:border-blue-400"
            />
          </div>
        </div>
      ) : null}
      {dialog ? (
        <div className="fixed inset-0 z-50 flex items-end bg-black/45" onClick={() => setDialog(null)}>
          <div className="w-full rounded-t-[28px] bg-white p-4 pb-[calc(1rem+env(safe-area-inset-bottom))]" onClick={(event) => event.stopPropagation()}>
            <div className="mx-auto mb-3 h-1.5 w-10 rounded-full bg-slate-200" />
            <div className="mb-3 text-base font-semibold text-slate-950">
              {dialog.kind === 'panel-edit' ? '编辑分镜' : dialog.kind === 'insert-panel' ? '插入分镜要求' : dialog.kind === 'frame-edit' ? '编辑关键帧' : dialog.kind === 'duration' ? '修改时长' : dialog.kind === 'first-last-prompt' ? '编辑首尾帧提示词' : '编辑视频提示词'}
            </div>
            {dialog.kind === 'frame-edit' ? (
              <div className="space-y-3">
                <label className="block">
                  <span className="mb-1 block text-xs font-semibold text-slate-500">关键帧秒数</span>
                  <input
                    type="number"
                    min="0"
                    step="0.1"
                    value={frameTimeDraft}
                    onChange={(event) => setFrameTimeDraft(event.target.value)}
                    className="w-full rounded-2xl border border-slate-200 bg-white px-3 py-3 text-sm font-semibold text-slate-900 outline-none focus:border-blue-400"
                  />
                </label>
                <label className="block">
                  <span className="mb-1 block text-xs font-semibold text-slate-500">生图提示词</span>
                  <textarea
                    value={dialogDraft}
                    onChange={(event) => setDialogDraft(event.target.value)}
                    className="h-56 w-full resize-none rounded-2xl border border-slate-200 bg-white p-3 text-sm leading-6 text-slate-800 outline-none focus:border-blue-400"
                  />
                </label>
              </div>
            ) : (
              <>
                <div className="mb-2 rounded-2xl bg-slate-50 px-3 py-2 text-xs leading-5 text-slate-500">
                  {dialog.kind === 'panel-edit' ? '格式：镜头类型 --- 运镜 --- 场景 --- 秒数 --- 画面描述 --- 生图提示词 --- 视频提示词' : dialog.kind === 'insert-panel' ? '填写要插入的新分镜要求，可为空。' : '直接编辑内容并保存。'}
                </div>
                <textarea
                  value={dialogDraft}
                  onChange={(event) => setDialogDraft(event.target.value)}
                  className="h-64 w-full resize-none rounded-2xl border border-slate-200 bg-white p-3 text-sm leading-6 text-slate-800 outline-none focus:border-blue-400"
                />
              </>
            )}
            <div className="mt-3 grid grid-cols-2 gap-2">
              <button type="button" onClick={() => setDialog(null)} className="rounded-2xl bg-slate-100 px-4 py-3 text-sm font-semibold text-slate-600">取消</button>
              <button type="button" onClick={() => void submitDialog()} className="rounded-2xl bg-blue-600 px-4 py-3 text-sm font-semibold text-white">保存</button>
            </div>
          </div>
        </div>
      ) : null}
      </MobileShell>
      )}
    </MobileProjectTaskQueueBoundary>
  )
}

function MoreTab({
  projectId,
  runningTaskCount,
  onSelect,
}: {
  projectId: string
  runningTaskCount: number
  onSelect: (destination: MobileMoreDestination) => void
}) {
  return (
    <div className="grid grid-cols-2 gap-3">
      {MOBILE_MORE_DESTINATIONS.map((item) => {
        const content = (
          <>
            <span className="flex h-11 w-11 items-center justify-center rounded-2xl bg-slate-100 text-slate-700">
              <AppIcon name={item.icon} className="h-5 w-5" />
            </span>
            <span className="mt-3 flex items-center gap-2 text-sm font-semibold text-slate-950">
              {item.label}
              {item.key === 'tasks' && runningTaskCount > 0 ? (
                <span className="rounded-full bg-amber-100 px-2 py-0.5 text-[10px] text-amber-700">{runningTaskCount}</span>
              ) : null}
            </span>
            <span className="mt-1 text-xs leading-5 text-slate-500">{item.description}</span>
          </>
        )

        const className = 'flex min-h-36 flex-col rounded-[24px] bg-white p-4 text-left shadow-sm ring-1 ring-slate-200/80 active:scale-[0.99]'
        if (item.externalPath) {
          const href = item.key === 'global-assets'
            ? item.externalPath
            : `${item.externalPath}?from=${encodeURIComponent(`/mobile/workspace/${projectId}`)}`
          return <Link key={item.key} href={href as never} className={className}>{content}</Link>
        }
        return (
          <button key={item.key} type="button" onClick={() => onSelect(item.key)} className={className}>
            {content}
          </button>
        )
      })}
    </div>
  )
}

interface MobileRunStatus {
  running: boolean
  progress: number
  activeMessage: string
  outputText: string
  errorMessage: string
}

function RunProgressPanel({ stream }: { stream: MobileRunStatus }) {
  if (!stream.running && !stream.outputText && !stream.errorMessage) return null
  const progress = Math.max(0, Math.min(100, Math.round(stream.progress || 0)))
  return (
    <div className="rounded-[22px] bg-slate-950 p-4 text-white shadow-sm">
      <div className="flex items-center justify-between gap-3">
        <div className="text-sm font-semibold">{stream.running ? 'AI 正在执行' : stream.errorMessage ? '执行异常' : '执行结果'}</div>
        <div className="rounded-full bg-white/12 px-2 py-1 text-xs font-semibold">{progress}%</div>
      </div>
      <div className="mt-3 h-1.5 overflow-hidden rounded-full bg-white/15">
        <div className="h-full rounded-full bg-blue-400 transition-all" style={{ width: `${progress}%` }} />
      </div>
      {stream.activeMessage ? <div className="mt-3 text-xs leading-5 text-white/75">{stream.activeMessage}</div> : null}
      {stream.errorMessage ? <div className="mt-3 rounded-2xl bg-red-500/15 p-3 text-xs leading-5 text-red-100">{stream.errorMessage}</div> : null}
      {stream.outputText ? (
        <div className="mt-3 max-h-36 overflow-y-auto whitespace-pre-wrap rounded-2xl bg-white/10 p-3 text-xs leading-5 text-white/75">
          {stream.outputText}
        </div>
      ) : null}
    </div>
  )
}

// Kept as the compact fallback while the full PC-parity stages settle on mobile.
// eslint-disable-next-line @typescript-eslint/no-unused-vars
function StoryTab({
  episode,
  storyDraft,
  saving,
  stream,
  onChange,
  onSave,
  onRun,
  onStop,
}: {
  episode: MobileEpisodeDetail | undefined
  storyDraft: string
  saving: boolean
  stream: MobileRunStatus
  onChange: (value: string) => void
  onSave: () => void
  onRun: () => void
  onStop: () => void
}) {
  const wordCount = storyDraft.trim().length
  const clipCount = Array.isArray(episode?.clips) ? episode.clips.length : 0
  return (
    <div className="space-y-4">
      <section className="rounded-[26px] bg-white p-4 shadow-sm ring-1 ring-slate-200/80">
        <div className="flex items-start justify-between gap-3">
          <div>
            <div className="text-xs font-semibold text-blue-600">故事输入</div>
            <div className="mt-1 text-lg font-semibold text-slate-950">{episode?.name || '当前剧集'}</div>
          </div>
          <div className="rounded-2xl bg-slate-100 px-3 py-2 text-right">
            <div className="text-base font-semibold text-slate-950">{wordCount}</div>
            <div className="text-[10px] text-slate-500">字符</div>
          </div>
        </div>
        <textarea
          value={storyDraft}
          onChange={(event) => onChange(event.target.value)}
          placeholder="在这里填写或修改本集故事内容"
          className="mt-4 h-[42vh] w-full resize-none rounded-[22px] border border-slate-200 bg-slate-50 p-4 text-sm leading-7 text-slate-800 outline-none focus:border-blue-400 focus:bg-white"
        />
        <div className="mt-3 grid grid-cols-2 gap-2">
          <button
            type="button"
            disabled={saving || stream.running}
            onClick={onSave}
            className="rounded-2xl bg-slate-950 px-4 py-3 text-sm font-semibold text-white active:scale-95 disabled:opacity-50"
          >
            {saving ? '保存中' : '保存故事'}
          </button>
          {stream.running ? (
            <button
              type="button"
              onClick={onStop}
              className="rounded-2xl bg-red-600 px-4 py-3 text-sm font-semibold text-white active:scale-95"
            >
              停止生成
            </button>
          ) : (
            <button
              type="button"
              disabled={saving || !storyDraft.trim()}
              onClick={onRun}
              className="rounded-2xl bg-blue-600 px-4 py-3 text-sm font-semibold text-white active:scale-95 disabled:opacity-50"
            >
              生成剧本
            </button>
          )}
        </div>
      </section>
      <div className="grid grid-cols-2 gap-2">
        <div className="rounded-[22px] bg-violet-50 px-4 py-3">
          <div className="text-lg font-semibold text-violet-700">{clipCount}</div>
          <div className="text-xs text-violet-600/75">已拆分片段</div>
        </div>
        <div className="rounded-[22px] bg-blue-50 px-4 py-3">
          <div className="text-lg font-semibold text-blue-700">{stream.running ? '运行中' : '就绪'}</div>
          <div className="text-xs text-blue-600/75">故事转剧本</div>
        </div>
      </div>
      <RunProgressPanel stream={stream} />
    </div>
  )
}

function ScriptTab({
  clips,
  panelGroups,
  stream,
  onRunAll,
  onRunClip,
  onStop,
  onGoStory,
  onOpenAssets,
  onOpenMenu,
}: {
  clips: MobileClip[]
  panelGroups: ReturnType<typeof getSortedPanelGroups>
  stream: MobileRunStatus
  onRunAll: () => void
  onRunClip: (clipId: string) => void
  onStop: () => void
  onGoStory: () => void
  onOpenAssets: () => void
  onOpenMenu: (clip: MobileClip) => void
}) {
  const panelCountByClip = new Map(panelGroups.map((group) => [group.clipId, group.panels.length]))
  if (clips.length === 0) {
    return (
      <div className="space-y-3">
        <MobileEmptyState title="暂无剧本片段" description="先在故事页生成剧本，生成后会在这里编辑和绘制分镜。" />
        <button
          type="button"
          onClick={onGoStory}
          className="w-full rounded-[22px] bg-blue-600 px-4 py-3 text-sm font-semibold text-white shadow-sm active:scale-[0.99]"
        >
          去填写故事
        </button>
        <RunProgressPanel stream={stream} />
      </div>
    )
  }

  return (
    <div className="space-y-4">
      <section className="rounded-[26px] bg-slate-950 p-4 text-white shadow-sm">
        <div className="flex items-center justify-between gap-3">
          <div>
            <div className="text-xs font-semibold text-white/55">剧本片段</div>
            <div className="mt-1 text-xl font-semibold">{clips.length} 个片段</div>
          </div>
          {stream.running ? (
            <button
              type="button"
              onClick={onStop}
              className="rounded-full bg-red-500 px-3 py-2 text-xs font-semibold text-white active:scale-95"
            >
              停止
            </button>
          ) : (
            <button
              type="button"
              onClick={onRunAll}
              className="rounded-full bg-blue-500 px-4 py-2 text-xs font-semibold text-white active:scale-95"
            >
              全部生成分镜
            </button>
          )}
        </div>
      </section>
      <button
        type="button"
        onClick={onOpenAssets}
        className="flex min-h-11 w-full items-center justify-center gap-2 rounded-[20px] bg-white px-4 text-sm font-semibold text-slate-700 shadow-sm ring-1 ring-slate-200/80"
      >
        <AppIcon name="folderHeart" className="h-4 w-4" />
        管理并核对本集资产
      </button>
      <RunProgressPanel stream={stream} />
      {clips.map((clip, index) => {
        const summary = formatClipSummary(clip.screenplay, clip.content) || '暂无片段内容'
        const panelCount = panelCountByClip.get(clip.id) || 0
        const range = typeof clip.start === 'number' && typeof clip.end === 'number'
          ? `${clip.start}-${clip.end}`
          : null
        const characters = parseNameList(clip.characters)
        const props = parseNameList(clip.props)
        return (
          <article key={clip.id} className="overflow-hidden rounded-[26px] bg-white shadow-sm ring-1 ring-slate-200/80">
            <div className="border-b border-slate-100 px-4 py-3">
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <div className="text-base font-semibold text-slate-950">片段 {index + 1}</div>
                  <div className="mt-1 text-xs text-slate-400">{range ? `${range}s` : '未设置时间段'}</div>
                </div>
                <span className="shrink-0 rounded-full bg-blue-50 px-2.5 py-1 text-xs font-semibold text-blue-600">
                  {panelCount} 分镜
                </span>
              </div>
              <p className="mt-3 whitespace-pre-wrap break-words text-sm leading-6 text-slate-600">{summary}</p>
              {clip.location || characters.length > 0 || props.length > 0 ? (
                <div className="mt-3 flex flex-wrap gap-1.5 text-xs">
                  {clip.location ? <span className="rounded-full bg-slate-100 px-2 py-1 text-slate-600">{clip.location}</span> : null}
                  {characters.slice(0, 4).map((name) => <span key={name} className="rounded-full bg-violet-50 px-2 py-1 text-violet-600">{name}</span>)}
                  {props.slice(0, 4).map((name) => <span key={name} className="rounded-full bg-amber-50 px-2 py-1 text-amber-700">{name}</span>)}
                </div>
              ) : null}
            </div>
            <div className="grid grid-cols-2 gap-2 p-4">
              <button
                type="button"
                disabled={stream.running}
                onClick={() => onRunClip(clip.id)}
                className="rounded-2xl bg-blue-600 px-3 py-2.5 text-sm font-semibold text-white shadow-sm active:scale-95 disabled:opacity-50"
              >
                {stream.running ? '生成中' : panelCount > 0 ? '重新生成本片段分镜' : '生成本片段分镜'}
              </button>
              <button type="button" onClick={() => onOpenMenu(clip)} className="rounded-2xl bg-slate-950 px-3 py-2.5 text-sm font-semibold text-white active:scale-95">
                更多操作
              </button>
            </div>
          </article>
        )
      })}
    </div>
  )
}

function StoryboardTab({
  panels,
  panelGroups,
  copiedPanelId,
  regeneratingPanelId,
  copiedFrameId,
  regeneratingFrameId,
  activeImageTargetIds,
  expandedClipIds,
  onToggleClipSummary,
  onPreview,
  onCopyPrompt,
  onCopyFramePrompt,
  onRegenerate,
  onRegenerateFrame,
  onDownloadAllImages,
  onGenerateAllImages,
  onTogglePreviousTail,
  onOpenPromptDetail,
  onOpenPanelMenu,
  onOpenFrameMenu,
  onEditFrame,
}: {
  panels: MobilePanel[]
  panelGroups: ReturnType<typeof getSortedPanelGroups>
  copiedPanelId: string | null
  regeneratingPanelId: string | null
  copiedFrameId: string | null
  regeneratingFrameId: string | null
  activeImageTargetIds: Set<string>
  expandedClipIds: Set<string>
  onToggleClipSummary: (clipId: string) => void
  onPreview: (url: string) => void
  onCopyPrompt: (panel: MobilePanel) => void
  onCopyFramePrompt: (frame: MobilePanelFrame) => void
  onRegenerate: (panel: MobilePanel) => void
  onRegenerateFrame: (panelId: string, frameId: string) => void
  onDownloadAllImages: () => void
  onGenerateAllImages: () => void
  onTogglePreviousTail: (panel: MobilePanel, storyboardId: string) => void
  onOpenPromptDetail: (panel: MobilePanel) => void
  onOpenPanelMenu: (state: PanelMenuState) => void
  onOpenFrameMenu: (state: FrameMenuState) => void
  onEditFrame: (frame: MobilePanelFrame) => void
}) {
  const taskQueue = useTaskQueue()

  if (panels.length === 0) {
    return <MobileEmptyState title="暂无分镜" description="请先在剧本页生成本集分镜。" />
  }

  return (
    <div className="space-y-5">
      <MobileGenerationQueueBar />
      <div className="grid grid-cols-2 gap-2">
        <button type="button" onClick={onGenerateAllImages} className="flex min-h-12 items-center justify-center gap-2 rounded-[20px] bg-blue-600 px-3 text-sm font-semibold text-white shadow-sm active:scale-[0.99]">
          <AppIcon name="imagePreview" className="h-4 w-4" />
          生成待生成图片
        </button>
        <button type="button" onClick={onDownloadAllImages} className="flex min-h-12 items-center justify-center gap-2 rounded-[20px] bg-slate-950 px-3 text-sm font-semibold text-white shadow-sm active:scale-[0.99]">
          <AppIcon name="download" className="h-4 w-4" />
          下载全部
        </button>
      </div>
      {panelGroups.map((group) => (
        <section key={group.storyboardId} className="space-y-4">
          <div className="sticky top-[70px] z-20 rounded-2xl border border-slate-200/80 bg-white/95 px-3 py-2 shadow-sm backdrop-blur">
            {(() => {
              const expanded = expandedClipIds.has(group.clipId)
              const hasLongSummary = Boolean(group.summary && group.summary.length > 48)
              return (
            <div className="flex items-center justify-between gap-3">
              <div className="min-w-0">
                <div className="text-sm font-semibold text-slate-900">{group.title}</div>
                {group.summary ? (
                  <div className={`mt-1 whitespace-pre-wrap break-words text-xs leading-5 text-slate-500 ${expanded ? '' : 'line-clamp-3'}`}>
                    {group.summary}
                  </div>
                ) : null}
                {hasLongSummary ? (
                  <button
                    type="button"
                    onClick={() => onToggleClipSummary(group.clipId)}
                    className="mt-1 text-xs font-semibold text-blue-600"
                  >
                    {expanded ? '收起片段内容' : '展开全部片段内容'}
                  </button>
                ) : null}
              </div>
              <span className="shrink-0 rounded-full bg-blue-50 px-2 py-1 text-[11px] font-semibold text-blue-600">
                {group.panels.length} 镜
              </span>
            </div>
              )
            })()}
          </div>
          {group.panels.map((panel, panelIndexInGroup) => {
            const index = panels.findIndex((item) => item.id === panel.id)
            const panelOrder = panel.panelNumber || index + 1
            const imageUrl = getPanelImageUrl(panel)
            const frames = getSortedFrames(panel)
            const duration = getPanelDuration(panel)
            const names = parseNameList(panel.characters)
            const hasPreviousPanel = canReferencePreviousPanel(panels, panel.id)
            const panelQueueStatus = getMobileQueueUiStatus(taskQueue.queue, `panel-${panel.id}`)
            const panelImageState = resolveMobileImageCardState({
              queueStatus: panelQueueStatus,
              mutationPending: regeneratingPanelId === panel.id,
              activeTask: activeImageTargetIds.has(panel.id),
              hasImage: Boolean(imageUrl),
            })
            const panelIsBusy = isMobileImageCardBusy(panelImageState)
            return (
          <article key={panel.id} className="relative overflow-hidden rounded-[26px] border border-slate-300 bg-white shadow-[0_14px_34px_rgba(15,23,42,0.10)]">
            <div className="absolute inset-y-0 left-0 w-1.5 bg-blue-600" />
            <div className="relative flex items-center justify-between gap-3 border-b border-slate-200 bg-slate-950 px-4 py-3 text-white">
              <div className="flex min-w-0 items-center gap-2">
                <span className="shrink-0 rounded-full bg-white px-2.5 py-1 text-xs font-bold text-slate-950">
                  #{panelOrder}
                </span>
                <div className="min-w-0">
                  <div className="truncate text-sm font-semibold">分镜 {panelOrder}</div>
                  <div className="mt-0.5 truncate text-[11px] text-white/60">
                    {panel.shotType || panel.location || '未命名镜头'}
                  </div>
                </div>
              </div>
              <div className="flex shrink-0 items-center gap-1.5">
                {panel.panelMode === 'group' ? (
                  <span className="rounded-full bg-blue-500/20 px-2 py-1 text-[11px] font-semibold text-blue-100 ring-1 ring-blue-300/30">
                    分镜组
                  </span>
                ) : null}
                {duration !== null ? (
                  <span className="rounded-full bg-white/12 px-2.5 py-1 text-xs font-semibold text-white ring-1 ring-white/15">
                    {duration}s
                  </span>
                ) : null}
              </div>
            </div>
            <button
              type="button"
              className="relative block w-full bg-slate-100"
              style={{ aspectRatio: '16 / 9' }}
              onClick={() => imageUrl && onPreview(imageUrl)}
            >
              {imageUrl ? (
                // eslint-disable-next-line @next/next/no-img-element
                <img src={imageUrl} alt={`分镜 ${index + 1}`} className="h-full w-full object-cover" />
              ) : (
                <div className="flex h-full items-center justify-center text-sm text-slate-400">暂无图片</div>
              )}
              {imageUrl ? (
                <div className="absolute bottom-3 right-3 rounded-full bg-white/95 px-2.5 py-1 text-xs font-semibold text-slate-700 shadow-sm">
                  点按预览
                </div>
              ) : null}
              {!imageUrl && panelIsBusy ? (
                <span className="absolute inset-0 flex items-center justify-center bg-slate-950/45 text-sm font-semibold text-white backdrop-blur-[1px]">
                  {getMobileImageCardStateLabel(panelImageState)}
                </span>
              ) : imageUrl && panelIsBusy ? (
                <span className="absolute bottom-3 left-3 rounded-full bg-blue-600 px-2.5 py-1 text-xs font-semibold text-white shadow-sm">
                  {getMobileImageCardStateLabel(panelImageState)}
                </span>
              ) : null}
            </button>
            {shouldDisplayPanelFrames(frames) ? (
              <div className="border-y border-slate-200 bg-slate-100/80 p-3">
                <div className="mb-2 flex items-center justify-between gap-2">
                  <div className="text-xs font-semibold text-slate-600">分镜组关键帧</div>
                  <div className="flex items-center gap-2">
                    <span className="rounded-full bg-white px-2 py-0.5 text-[10px] font-semibold text-slate-500 ring-1 ring-slate-200">
                      {frames.length} 帧
                    </span>
                    <button
                      type="button"
                      onClick={() => onOpenPromptDetail(panel)}
                      className="flex min-h-9 items-center gap-1 rounded-full bg-slate-950 px-3 text-[11px] font-semibold text-white active:scale-95"
                    >
                      <AppIcon name="externalLink" className="h-3.5 w-3.5" />
                      查看分镜提示
                    </button>
                  </div>
                </div>
                <div className="flex gap-2 overflow-x-auto pb-1">
                {frames.map((frame) => {
                  const frameUrl = displayMediaUrl(frame.imageMedia?.url || frame.media?.url || frame.imageUrl)
                  const frameQueueStatus = getMobileQueueUiStatus(taskQueue.queue, `panel-frame-${frame.id}`)
                  const frameImageState = resolveMobileImageCardState({
                    queueStatus: frameQueueStatus,
                    mutationPending: regeneratingFrameId === frame.id,
                    activeTask: activeImageTargetIds.has(frame.id),
                    hasImage: Boolean(frameUrl),
                  })
                  const frameIsBusy = isMobileImageCardBusy(frameImageState)
                  return (
                    <div
                      key={frame.id}
                      className="w-40 shrink-0 overflow-hidden rounded-2xl bg-white shadow-sm ring-1 ring-slate-200"
                    >
                      <button
                        type="button"
                        className="relative block h-20 w-full bg-slate-100"
                        onClick={() => frameUrl && onPreview(frameUrl)}
                      >
                        {frameUrl ? (
                          // eslint-disable-next-line @next/next/no-img-element
                          <img src={frameUrl} alt={`F${frame.frameIndex + 1}`} className="h-full w-full object-cover" />
                        ) : (
                          <div className="flex h-full items-center justify-center text-xs text-slate-400">{getMobileImageCardStateLabel(frameImageState)}</div>
                        )}
                        <span className="absolute left-1.5 top-1.5 rounded-full bg-white/95 px-1.5 py-0.5 text-[10px] font-semibold text-slate-950">
                          F{frame.frameIndex + 1}
                        </span>
                        <span className="absolute right-1.5 top-1.5 rounded-full bg-black/65 px-1.5 py-0.5 text-[10px] font-semibold text-white">
                          {frame.frameTimeSec}s
                        </span>
                        {!frameUrl && frameIsBusy ? (
                          <span className="absolute inset-0 flex items-center justify-center bg-black/35 text-[11px] font-semibold text-white backdrop-blur-[1px]">
                            {getMobileImageCardStateLabel(frameImageState)}
                          </span>
                        ) : frameUrl && frameIsBusy ? (
                          <span className="absolute bottom-1.5 left-1.5 rounded-full bg-blue-600 px-1.5 py-0.5 text-[10px] font-semibold text-white shadow-sm">
                            {getMobileImageCardStateLabel(frameImageState)}
                          </span>
                        ) : null}
                      </button>
                      <div className="space-y-2 p-2">
                        <div className="flex items-center justify-between gap-1">
                          <span className="truncate text-[11px] font-semibold text-slate-600">
                            {frame.frameRole || '关键状态'}
                          </span>
                          <MobileImageStatePill state={frameImageState} />
                        </div>
                        <div className="grid grid-cols-3 gap-1">
                          <button
                            type="button"
                            disabled={!frameUrl}
                            onClick={() => frameUrl && onPreview(frameUrl)}
                            className="rounded-xl bg-slate-100 px-1 py-1.5 text-[11px] font-semibold text-slate-700 disabled:opacity-40"
                          >
                            预览
                          </button>
                          <button
                            type="button"
                            onClick={() => onCopyFramePrompt(frame)}
                            className="rounded-xl bg-slate-100 px-1 py-1.5 text-[11px] font-semibold text-slate-700"
                          >
                            {copiedFrameId === frame.id ? '已复制' : '复制'}
                          </button>
                          <button
                            type="button"
                            onClick={() => onEditFrame(frame)}
                            className="rounded-xl bg-slate-100 px-1 py-1.5 text-[11px] font-semibold text-slate-700"
                          >
                            编辑
                          </button>
                          <button
                            type="button"
                            disabled={frameIsBusy}
                            onClick={() => onRegenerateFrame(panel.id, frame.id)}
                            className="rounded-xl bg-blue-600 px-1 py-1.5 text-[11px] font-semibold text-white disabled:opacity-50"
                          >
                            {frameIsBusy ? getMobileImageCardStateLabel(frameImageState) : '重生'}
                          </button>
                          <button
                            type="button"
                            onClick={() => onOpenFrameMenu({ frame, panel })}
                            className="rounded-xl bg-slate-950 px-1 py-1.5 text-[11px] font-semibold text-white"
                          >
                            更多
                          </button>
                        </div>
                      </div>
                    </div>
                  )
                })}
                </div>
              </div>
            ) : null}
            <div className="space-y-3 p-4">
              <div className="flex flex-wrap items-center gap-1.5">
                <MobileImageStatePill state={panelImageState} />
                <StatusPill running={panel.videoTaskRunning} label={panel.videoTaskRunning ? '生视频中' : '视频'} />
                {panel.panelMode === 'group' ? <span className="rounded-full bg-blue-50 px-2 py-0.5 text-[11px] font-medium text-blue-600">分镜组</span> : null}
              </div>
              {hasPreviousPanel ? (
                <button
                  type="button"
                  role="switch"
                  aria-checked={Boolean(panel.usePreviousPanelTailAsReference)}
                  onClick={() => onTogglePreviousTail(panel, group.storyboardId)}
                  className={`flex min-h-11 w-full items-center justify-between rounded-2xl px-3.5 py-2.5 text-left ring-1 transition active:scale-[0.99] ${panel.usePreviousPanelTailAsReference ? 'bg-emerald-50 text-emerald-700 ring-emerald-200' : 'bg-slate-50 text-slate-600 ring-slate-200'}`}
                >
                  <span className="flex min-w-0 items-center gap-2 text-sm font-semibold">
                    <AppIcon name="link" className="h-4 w-4 shrink-0" />
                    <span>{panel.usePreviousPanelTailAsReference ? '已连接上一分镜尾帧' : '连接上一分镜尾帧'}</span>
                  </span>
                  <span className={`relative h-6 w-11 shrink-0 rounded-full transition ${panel.usePreviousPanelTailAsReference ? 'bg-emerald-500' : 'bg-slate-300'}`}>
                    <span className={`absolute top-0.5 h-5 w-5 rounded-full bg-white shadow-sm transition ${panel.usePreviousPanelTailAsReference ? 'left-[22px]' : 'left-0.5'}`} />
                  </span>
                </button>
              ) : null}
              <div>
                <div className="text-base font-semibold">{panel.shotType || '未命名镜头'}</div>
                <p className="mt-1 line-clamp-3 text-sm leading-6 text-slate-600">{panel.description || '暂无画面描述'}</p>
              </div>
              {names.length > 0 || panel.location ? (
                <div className="flex flex-wrap gap-1.5 text-xs">
                  {panel.location ? <span className="rounded-full bg-slate-100 px-2 py-1 text-slate-600">{panel.location}</span> : null}
                  {names.slice(0, 4).map((name) => <span key={name} className="rounded-full bg-slate-100 px-2 py-1 text-slate-600">{name}</span>)}
                </div>
              ) : null}
              <div className="flex gap-2">
                <button
                  type="button"
                  onClick={() => onCopyPrompt(panel)}
                  className="flex-1 rounded-2xl border border-slate-200 px-3 py-2.5 text-sm font-semibold text-slate-700 active:scale-95"
                >
                  {copiedPanelId === panel.id ? '已复制' : '复制提示词'}
                </button>
                <button
                  type="button"
                  onClick={() => onRegenerate(panel)}
                  disabled={panelIsBusy}
                  className="flex-1 rounded-2xl bg-blue-600 px-3 py-2.5 text-sm font-semibold text-white shadow-sm active:scale-95 disabled:opacity-60"
                >
                  {panelIsBusy ? getMobileImageCardStateLabel(panelImageState) : '重生图片'}
                </button>
                <button
                  type="button"
                  onClick={() => onOpenPanelMenu({
                    panel,
                    storyboardId: group.storyboardId,
                    hasNext: panelIndexInGroup < group.panels.length - 1,
                    hasPrevious: hasPreviousPanel,
                  })}
                  className="rounded-2xl bg-slate-950 px-3 py-2.5 text-sm font-semibold text-white shadow-sm active:scale-95"
                >
                  操作
                </button>
              </div>
            </div>
          </article>
            )
          })}
        </section>
      ))}
    </div>
  )
}

function VideosTab({
  panels,
  copiedPanelId,
  activeVideoTargetIds,
  onGenerateAll,
  onGenerateVideo,
  onCopyPrompt,
  onViewPrompt,
  onEditVideoPrompt,
  onPreviewImage,
  onOpenMenu,
}: {
  panels: MobilePanel[]
  copiedPanelId: string | null
  activeVideoTargetIds: Set<string>
  onGenerateAll: () => void
  onGenerateVideo: (panel: MobilePanel) => void
  onCopyPrompt: (panel: MobilePanel) => void
  onViewPrompt: (panel: MobilePanel, prompt: string) => void
  onEditVideoPrompt: (panel: MobilePanel) => void
  onPreviewImage: (url: string) => void
  onOpenMenu: (panel: MobilePanel) => void
}) {
  const taskQueue = useTaskQueue()

  if (panels.length === 0) {
    return (
      <div className="space-y-3">
        <MobileGenerationQueueBar />
        <button
          type="button"
          onClick={onGenerateAll}
          className="flex w-full items-center justify-center gap-2 rounded-[22px] bg-blue-600 px-4 py-3 text-sm font-semibold text-white shadow-sm active:scale-[0.99]"
        >
          <AppIcon name="video" className="h-4 w-4" />
          一键生成全部成片
        </button>
        <MobileEmptyState title="暂无成片视频" description="视频生成完成后会在这里展示。" />
      </div>
    )
  }

  return (
    <div className="space-y-3">
      <MobileGenerationQueueBar />
      <div className="grid grid-cols-2 gap-2">
        <button
          type="button"
          onClick={onGenerateAll}
          className="flex items-center justify-center gap-2 rounded-[22px] bg-blue-600 px-4 py-3 text-sm font-semibold text-white shadow-sm active:scale-[0.99]"
        >
          <AppIcon name="video" className="h-4 w-4" />
          一键生成全部
        </button>
        <button
          type="button"
          onClick={() => {
            for (const panel of panels) {
              const videoUrl = getPanelVideoUrl(panel)
              if (videoUrl) void downloadRemoteFile(videoUrl, `video-${panel.panelNumber || panel.panelIndex + 1}.mp4`)
            }
          }}
          className="flex items-center justify-center gap-2 rounded-[22px] bg-slate-950 px-4 py-3 text-sm font-semibold text-white shadow-sm active:scale-[0.99]"
        >
          <AppIcon name="download" className="h-4 w-4" />
          下载全部
        </button>
      </div>
      {panels.map((panel, index) => {
        const videoUrl = getPanelVideoUrl(panel)
        const imageUrl = getPanelImageUrl(panel)
        const frames = getSortedFrames(panel)
        const videoPrompt = panel.panelMode === 'group'
          ? panel.groupVideoPrompt || panel.videoPrompt || ''
          : panel.videoPrompt || panel.groupVideoPrompt || ''
        const videoQueueStatus = getMobileQueueUiStatus(taskQueue.queue, `video-panel-${panel.id}`)
        const videoState = resolveMobileVideoCardState({
          queueStatus: videoQueueStatus,
          activeTask: Boolean(panel.videoTaskRunning || activeVideoTargetIds.has(panel.id)),
          hasVideo: Boolean(videoUrl),
        })
        const videoIsBusy = isMobileVideoCardBusy(videoState)
        return (
          <article key={panel.id} className="overflow-hidden rounded-[24px] bg-white shadow-sm ring-1 ring-slate-200/80">
            {videoUrl ? (
              <video src={videoUrl} controls playsInline preload="metadata" className="block w-full bg-black" style={{ aspectRatio: '16 / 9' }} />
            ) : (
              <div className="relative w-full bg-black" style={{ aspectRatio: '16 / 9' }}>
                {imageUrl ? (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img src={imageUrl} alt={`视频 ${index + 1}`} className="h-full w-full object-cover opacity-75" />
                ) : null}
                <span className="absolute inset-0 flex items-center justify-center bg-black/35 text-sm font-semibold text-white">{getMobileVideoCardStateLabel(videoState)}</span>
              </div>
            )}
            <div className="space-y-3 p-4">
              <div className="flex items-center justify-between gap-2">
                <div className="min-w-0">
                  <div className="text-base font-semibold">视频片段 {panel.panelNumber || index + 1}</div>
                  <div className="mt-0.5 text-xs text-slate-400">{getPanelDuration(panel) ?? '-'}s</div>
                </div>
                <div className="flex items-center gap-1.5">
                  {panel.panelMode === 'group' || frames.length > 1 ? (
                    <span className="rounded-full bg-blue-100 px-2 py-1 text-[11px] font-semibold text-blue-700">分镜组 · {frames.length} 帧</span>
                  ) : null}
                  <MobileVideoStatePill state={videoState} />
                </div>
              </div>
              <p className="mt-1 line-clamp-2 text-sm leading-6 text-slate-500">{panel.description || panel.videoPrompt || '暂无描述'}</p>
              {frames.length > 0 ? (
                <section className="rounded-[20px] bg-slate-100 p-3 ring-1 ring-slate-200/80">
                  <div className="mb-2 flex items-center justify-between gap-2">
                    <div className="text-xs font-semibold text-slate-700">
                      {panel.panelMode === 'group' || frames.length > 1 ? '成片分镜组关键帧' : '成片关键帧'}
                    </div>
                    <span className="text-[10px] font-medium text-slate-500">按视频时间顺序</span>
                  </div>
                  <div className="flex gap-2 overflow-x-auto pb-1">
                    {frames.map((frame) => {
                      const frameUrl = displayMediaUrl(frame.imageMedia?.url || frame.media?.url || frame.imageUrl)
                      return (
                        <button
                          key={frame.id}
                          type="button"
                          disabled={!frameUrl}
                          onClick={() => frameUrl && onPreviewImage(frameUrl)}
                          className="w-32 shrink-0 overflow-hidden rounded-2xl bg-white text-left shadow-sm ring-1 ring-slate-200 disabled:opacity-70"
                        >
                          <div className="relative h-20 bg-slate-200">
                            {frameUrl ? (
                              // eslint-disable-next-line @next/next/no-img-element
                              <img src={frameUrl} alt={`F${frame.frameIndex + 1}`} className="h-full w-full object-cover" />
                            ) : (
                              <span className="flex h-full items-center justify-center text-[11px] text-slate-400">暂无图片</span>
                            )}
                            <span className="absolute left-1.5 top-1.5 rounded-full bg-white/95 px-1.5 py-0.5 text-[10px] font-bold text-slate-950">F{frame.frameIndex + 1}</span>
                            <span className="absolute right-1.5 top-1.5 rounded-full bg-black/65 px-1.5 py-0.5 text-[10px] font-semibold text-white">{frame.frameTimeSec}s</span>
                          </div>
                          <div className="truncate px-2 py-2 text-[11px] font-semibold text-slate-600">{frame.frameRole || '关键状态'}</div>
                        </button>
                      )
                    })}
                  </div>
                </section>
              ) : imageUrl ? (
                <section className="rounded-[20px] bg-slate-100 p-3 ring-1 ring-slate-200/80">
                  <div className="mb-2 text-xs font-semibold text-slate-700">成片首帧</div>
                  <button type="button" onClick={() => onPreviewImage(imageUrl)} className="relative block w-full overflow-hidden rounded-2xl bg-slate-200" style={{ aspectRatio: '16 / 9' }}>
                    {/* eslint-disable-next-line @next/next/no-img-element */}
                    <img src={imageUrl} alt="成片首帧" className="h-full w-full object-cover" />
                    <span className="absolute bottom-2 right-2 rounded-full bg-black/65 px-2 py-1 text-[10px] font-semibold text-white">点按预览</span>
                  </button>
                </section>
              ) : null}
              <section className="rounded-[20px] border border-blue-200 bg-blue-50 p-3 shadow-sm">
                <div className="flex items-center justify-between gap-2">
                  <div className="flex items-center gap-2 text-sm font-semibold text-blue-950">
                    <span className="flex h-8 w-8 items-center justify-center rounded-xl bg-blue-600 text-white">
                      <AppIcon name="edit" className="h-4 w-4" />
                    </span>
                    视频提示词
                  </div>
                  <span className="rounded-full bg-white px-2 py-1 text-[10px] font-semibold text-blue-700 ring-1 ring-blue-100">
                    {videoPrompt.length} 字
                  </span>
                </div>
                <p className="mt-3 line-clamp-4 whitespace-pre-wrap text-sm leading-6 text-slate-700">
                  {videoPrompt || '暂无视频提示词，点击编辑补充。'}
                </p>
                <div className="mt-3 grid grid-cols-3 gap-2">
                  <button type="button" disabled={!videoPrompt} onClick={() => onViewPrompt(panel, videoPrompt)} className="min-h-11 rounded-2xl bg-white px-2 text-xs font-semibold text-blue-700 ring-1 ring-blue-200 disabled:opacity-40">展开查看</button>
                  <button type="button" onClick={() => onEditVideoPrompt(panel)} className="min-h-11 rounded-2xl bg-blue-600 px-2 text-xs font-semibold text-white">编辑提示词</button>
                  <button type="button" disabled={!videoPrompt} onClick={() => onCopyPrompt(panel)} className="min-h-11 rounded-2xl bg-white px-2 text-xs font-semibold text-slate-700 ring-1 ring-slate-200 disabled:opacity-40">{copiedPanelId === panel.id ? '已复制' : '复制'}</button>
                </div>
              </section>
              <div className="grid grid-cols-2 gap-2">
                <button
                  type="button"
                  onClick={() => onGenerateVideo(panel)}
                  disabled={videoIsBusy}
                  className="rounded-2xl bg-blue-600 px-3 py-2.5 text-sm font-semibold text-white shadow-sm active:scale-95 disabled:opacity-50"
                >
                  {videoIsBusy ? getMobileVideoCardStateLabel(videoState) : videoUrl ? '重新生成' : '生成视频'}
                </button>
                <button
                  type="button"
                  onClick={() => onOpenMenu(panel)}
                  className="rounded-2xl bg-slate-950 px-3 py-2.5 text-sm font-semibold text-white shadow-sm active:scale-95"
                >
                  更多操作
                </button>
              </div>
            </div>
          </article>
        )
      })}
    </div>
  )
}

function TasksTab({
  tasks,
  loading,
  cancellingTaskId,
  onCancel,
  onRefresh,
  onDismissFailed,
}: {
  tasks: MobileTask[]
  loading: boolean
  cancellingTaskId: string | null
  onCancel: (taskId: string) => void
  onRefresh: () => void
  onDismissFailed: (taskIds: string[]) => void
}) {
  const taskQueue = useTaskQueue()
  const [statusFilter, setStatusFilter] = useState<'all' | 'active' | 'completed' | 'failed'>('all')
  if (loading) return <MobileLoadingState label="正在加载任务..." />

  const filteredTasks = tasks.filter((task) => {
    if (statusFilter === 'active') return task.status === 'queued' || task.status === 'processing'
    if (statusFilter === 'completed') return task.status === 'completed'
    if (statusFilter === 'failed') return task.status === 'failed' || task.status === 'canceled'
    return true
  })
  const failedTaskIds = tasks.filter((task) => task.status === 'failed').map((task) => task.id)

  if (tasks.length === 0) {
    return <MobileEmptyState title="暂无任务" description="图片、视频、文本生成任务会在这里显示。" />
  }

  return (
    <div className="space-y-3">
      <div className="rounded-[22px] bg-white p-3 shadow-sm ring-1 ring-slate-200/80">
        <div className="flex gap-1 overflow-x-auto pb-1">
          {([
            ['all', '全部'],
            ['active', '执行中'],
            ['completed', '已完成'],
            ['failed', '失败/取消'],
          ] as const).map(([value, label]) => (
            <button key={value} type="button" onClick={() => setStatusFilter(value)} className={`shrink-0 rounded-full px-3 py-2 text-xs font-semibold ${statusFilter === value ? 'bg-slate-950 text-white' : 'bg-slate-100 text-slate-600'}`}>{label}</button>
          ))}
        </div>
        <div className="mt-2 grid grid-cols-2 gap-2">
          <button type="button" onClick={onRefresh} className="rounded-2xl bg-slate-100 px-3 py-2.5 text-xs font-semibold text-slate-700">刷新任务</button>
          <button type="button" disabled={failedTaskIds.length === 0} onClick={() => onDismissFailed(failedTaskIds)} className="rounded-2xl bg-red-50 px-3 py-2.5 text-xs font-semibold text-red-600 disabled:opacity-40">清理失败记录</button>
          {taskQueue.enabled ? (
            <>
              <button type="button" disabled={!taskQueue.activeItem?.taskId} onClick={() => { void taskQueue.cancelCurrent() }} className="rounded-2xl bg-amber-50 px-3 py-2.5 text-xs font-semibold text-amber-700 disabled:opacity-40">取消当前队列</button>
              <button type="button" onClick={taskQueue.clearPending} className="rounded-2xl bg-slate-100 px-3 py-2.5 text-xs font-semibold text-slate-700">清空未开始</button>
            </>
          ) : null}
        </div>
      </div>
      {filteredTasks.length === 0 ? <MobileEmptyState title="当前筛选暂无任务" /> : null}
      {filteredTasks.map((task) => {
        const running = task.status === 'queued' || task.status === 'processing'
        return (
          <article key={task.id} className="rounded-[24px] bg-white p-4 shadow-sm ring-1 ring-slate-200/80">
            <div className="flex items-start justify-between gap-3">
              <div className="min-w-0">
                <div className="truncate text-sm font-semibold">{task.type}</div>
                <div className="mt-1 text-xs text-slate-500">{task.targetType || '-'} · {task.status}</div>
                <div className="mt-1 text-xs text-slate-400">更新于 {formatDateTime(task.updatedAt)}</div>
              </div>
              <span className={`shrink-0 rounded-full px-2 py-1 text-xs font-medium ${running ? 'bg-amber-100 text-amber-700' : task.status === 'failed' ? 'bg-red-100 text-red-600' : 'bg-emerald-100 text-emerald-700'}`}>
                {task.status}
              </span>
            </div>
            {task.error?.message || task.errorMessage ? (
              <p className="mt-3 rounded-xl bg-red-50 p-3 text-xs leading-5 text-red-600">{task.error?.message || task.errorMessage}</p>
            ) : null}
            {running ? (
              <button
                type="button"
                disabled={cancellingTaskId === task.id}
                onClick={() => onCancel(task.id)}
                className="mt-3 w-full rounded-2xl bg-red-600 px-3 py-2.5 text-sm font-semibold text-white active:scale-95 disabled:opacity-60"
              >
                {cancellingTaskId === task.id ? '取消中' : '取消任务'}
              </button>
            ) : null}
          </article>
        )
      })}
    </div>
  )
}
