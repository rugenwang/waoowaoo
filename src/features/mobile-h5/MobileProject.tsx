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
import MobileShell, { MobileEmptyState, MobileLoadingState } from './MobileShell'
import {
  copyText,
  displayMediaUrl,
  formatDateTime,
  getPanelDuration,
  getPanelImageUrl,
  getPanelVideoUrl,
  getSortedPanelGroups,
  getSortedFrames,
  getSortedPanels,
  parseNameList,
} from './mobile-utils'
import type {
  MobileEpisodeDetail,
  MobileEpisodeSummary,
  MobilePanel,
  MobilePanelFrame,
  MobileProjectDetail,
  MobileTask,
} from './types'

type MobileTab = 'storyboard' | 'videos' | 'tasks'

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
  | { kind: 'duration'; panel: MobilePanel; storyboardId: string }

interface PanelMenuState {
  panel: MobilePanel
  storyboardId: string
  hasNext: boolean
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

function BottomTabs({
  value,
  counts,
  onChange,
}: {
  value: MobileTab
  counts: Record<MobileTab, number>
  onChange: (next: MobileTab) => void
}) {
  const items: Array<{ key: MobileTab; label: string; icon: 'imagePreview' | 'video' | 'refresh' }> = [
    { key: 'storyboard', label: '分镜', icon: 'imagePreview' },
    { key: 'videos', label: '成片', icon: 'video' },
    { key: 'tasks', label: '任务', icon: 'refresh' },
  ]

  return (
    <nav className="fixed inset-x-0 bottom-0 z-40 border-t border-slate-200/80 bg-white/95 px-4 pb-[calc(0.5rem+env(safe-area-inset-bottom))] pt-2 backdrop-blur-xl">
      <div className="mx-auto grid max-w-md grid-cols-3 gap-2">
        {items.map((item) => {
          const active = value === item.key
          return (
            <button
              key={item.key}
              type="button"
              onClick={() => onChange(item.key)}
              className={`flex h-14 flex-col items-center justify-center rounded-2xl text-xs font-semibold transition active:scale-95 ${active ? 'bg-slate-950 text-white shadow-sm' : 'text-slate-500 hover:bg-slate-100'}`}
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
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/80 p-4" onClick={onClose}>
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
  const [tab, setTab] = useState<MobileTab>('storyboard')
  const [copiedPanelId, setCopiedPanelId] = useState<string | null>(null)
  const [copiedFrameId, setCopiedFrameId] = useState<string | null>(null)
  const [expandedClipIds, setExpandedClipIds] = useState<Set<string>>(new Set())
  const [preview, setPreview] = useState<{ type: 'image' | 'video'; url: string } | null>(null)
  const [panelMenu, setPanelMenu] = useState<PanelMenuState | null>(null)
  const [frameMenu, setFrameMenu] = useState<FrameMenuState | null>(null)
  const [dialog, setDialog] = useState<MobilePanelDialog | null>(null)
  const [dialogDraft, setDialogDraft] = useState('')
  const [frameTimeDraft, setFrameTimeDraft] = useState('')
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
      if (!response.ok) throw new Error('提交生图任务失败')
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
        await requestJson(`/api/novel-promotion/${projectId}/generate-video`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            storyboardId,
            panelIndex: panel.panelIndex,
            panelId: panel.id,
            videoModel,
          }),
        }, '提交视频生成失败')
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

  const handleGenerateAllVideos = useCallback(async () => {
    if (!selectedEpisodeId) return
    const videoModel = projectQuery.data?.project.novelPromotionData?.videoModel || ''
    if (!videoModel) {
      alert('项目还没有配置默认视频模型，请先在 PC 端项目设置里配置。')
      return
    }
    try {
      await requestJson(`/api/novel-promotion/${projectId}/generate-video`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ all: true, episodeId: selectedEpisodeId, videoModel }),
      }, '批量生成视频失败')
      await refreshMobileData()
    } catch (error) {
      alert(error instanceof Error ? error.message : '批量生成视频失败')
    }
  }, [projectId, projectQuery.data?.project.novelPromotionData?.videoModel, refreshMobileData, requestJson, selectedEpisodeId])

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
  const panels = getSortedPanels(episode)
  const panelGroups = getSortedPanelGroups(episode)
  const videoPanels = panels.filter((panel) => getPanelVideoUrl(panel))
  const runningTasks = (tasksQuery.data?.tasks || []).filter((task) => task.status === 'queued' || task.status === 'processing')

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
        <MobileEmptyState title="暂无剧集" description="请先在 PC 端导入或创建剧集。" />
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
            </div>
          </section>

          <section className="mb-4 rounded-[24px] bg-white p-4 shadow-sm ring-1 ring-slate-200/80">
            <div className="flex items-start justify-between gap-3">
              <div className="min-w-0">
                <div className="text-xs font-medium text-slate-400">当前剧集</div>
                <div className="mt-1 truncate text-lg font-semibold">{episode?.name || '加载中'}</div>
              </div>
              <button
                type="button"
                onClick={() => {
                  void episodeQuery.refetch()
                  void tasksQuery.refetch()
                }}
                className="inline-flex h-9 items-center gap-1.5 rounded-full bg-slate-100 px-3 text-xs font-semibold text-slate-700 active:scale-95"
              >
                <AppIcon name="refresh" className="h-3.5 w-3.5" />
                刷新
              </button>
            </div>
            <div className="mt-4 grid grid-cols-3 gap-2 text-center">
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
          {!episodeQuery.isLoading && !episodeQuery.isError && tab === 'storyboard' ? (
            <StoryboardTab
              panels={panels}
              panelGroups={panelGroups}
              copiedPanelId={copiedPanelId}
              regeneratingPanelId={regenerateImage.variables || null}
              copiedFrameId={copiedFrameId}
              regeneratingFrameId={regenerateFrameImage.variables?.frameId || null}
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
              onRegenerate={(panelId) => regenerateImage.mutate(panelId)}
              onRegenerateFrame={(panelId, frameId) => regenerateFrameImage.mutate({ panelId, frameId })}
              onDownloadAllImages={handleDownloadAllImages}
              onOpenPanelMenu={setPanelMenu}
              onOpenFrameMenu={setFrameMenu}
              onEditFrame={(frame) => openDialog({ kind: 'frame-edit', frame })}
            />
          ) : null}
          {!episodeQuery.isLoading && !episodeQuery.isError && tab === 'videos' ? (
            <VideosTab
              panels={panels}
              onPreview={(url) => setPreview({ type: 'video', url })}
              onCopyPrompt={handleCopyPrompt}
              copiedPanelId={copiedPanelId}
              onGenerateAll={handleGenerateAllVideos}
              onGenerateVideo={(panel) => void runPanelCommand(panel, panel.storyboardId || '', 'generateVideo')}
              onEditVideoPrompt={(panel) => openDialog({ kind: 'video-prompt', panel, storyboardId: panel.storyboardId || '' })}
              onEditDuration={(panel) => openDialog({ kind: 'duration', panel, storyboardId: panel.storyboardId || '' })}
              onUploadVideo={(panel) => openUpload({ kind: 'panel-video', panelId: panel.id })}
            />
          ) : null}
          {tab === 'tasks' ? (
            <TasksTab
              tasks={tasksQuery.data?.tasks || []}
              loading={tasksQuery.isLoading}
              cancellingTaskId={cancelTask.variables || null}
              onCancel={(taskId) => cancelTask.mutate(taskId)}
              onRefresh={() => void tasksQuery.refetch()}
            />
          ) : null}
          <BottomTabs
            value={tab}
            counts={{ storyboard: panels.length, videos: videoPanels.length, tasks: runningTasks.length }}
            onChange={setTab}
          />
        </>
      )}

      {preview ? <PreviewModal type={preview.type} url={preview.url} onClose={() => setPreview(null)} /> : null}
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
          <SheetButton label={panelMenu.panel.usePreviousPanelTailAsReference ? '关闭上一尾帧' : '引用上一尾帧'} icon="link" onClick={() => void runPanelCommand(panelMenu.panel, panelMenu.storyboardId, 'togglePreviousTail')} />
          <SheetButton label="生成视频" icon="video" tone="primary" onClick={() => void runPanelCommand(panelMenu.panel, panelMenu.storyboardId, 'generateVideo')} />
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
      {dialog ? (
        <div className="fixed inset-0 z-50 flex items-end bg-black/45" onClick={() => setDialog(null)}>
          <div className="w-full rounded-t-[28px] bg-white p-4 pb-[calc(1rem+env(safe-area-inset-bottom))]" onClick={(event) => event.stopPropagation()}>
            <div className="mx-auto mb-3 h-1.5 w-10 rounded-full bg-slate-200" />
            <div className="mb-3 text-base font-semibold text-slate-950">
              {dialog.kind === 'panel-edit' ? '编辑分镜' : dialog.kind === 'insert-panel' ? '插入分镜要求' : dialog.kind === 'frame-edit' ? '编辑关键帧' : dialog.kind === 'duration' ? '修改时长' : '编辑视频提示词'}
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
  )
}

function StoryboardTab({
  panels,
  panelGroups,
  copiedPanelId,
  regeneratingPanelId,
  copiedFrameId,
  regeneratingFrameId,
  expandedClipIds,
  onToggleClipSummary,
  onPreview,
  onCopyPrompt,
  onCopyFramePrompt,
  onRegenerate,
  onRegenerateFrame,
  onDownloadAllImages,
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
  expandedClipIds: Set<string>
  onToggleClipSummary: (clipId: string) => void
  onPreview: (url: string) => void
  onCopyPrompt: (panel: MobilePanel) => void
  onCopyFramePrompt: (frame: MobilePanelFrame) => void
  onRegenerate: (panelId: string) => void
  onRegenerateFrame: (panelId: string, frameId: string) => void
  onDownloadAllImages: () => void
  onOpenPanelMenu: (state: PanelMenuState) => void
  onOpenFrameMenu: (state: FrameMenuState) => void
  onEditFrame: (frame: MobilePanelFrame) => void
}) {
  if (panels.length === 0) {
    return <MobileEmptyState title="暂无分镜" description="请先在 PC 端生成分镜。" />
  }

  return (
    <div className="space-y-5">
      <button
        type="button"
        onClick={onDownloadAllImages}
        className="flex w-full items-center justify-center gap-2 rounded-[22px] bg-slate-950 px-4 py-3 text-sm font-semibold text-white shadow-sm active:scale-[0.99]"
      >
        <AppIcon name="download" className="h-4 w-4" />
        下载本集全部分镜图
      </button>
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
            </button>
            {frames.length > 1 ? (
              <div className="border-y border-slate-200 bg-slate-100/80 p-3">
                <div className="mb-2 flex items-center justify-between">
                  <div className="text-xs font-semibold text-slate-600">分镜组关键帧</div>
                  <div className="rounded-full bg-white px-2 py-0.5 text-[10px] font-semibold text-slate-500 ring-1 ring-slate-200">
                    {frames.length} 帧
                  </div>
                </div>
                <div className="flex gap-2 overflow-x-auto pb-1">
                {frames.map((frame) => {
                  const frameUrl = displayMediaUrl(frame.imageMedia?.url || frame.media?.url || frame.imageUrl)
                  const isGenerating = frame.generationStatus === 'processing' || regeneratingFrameId === frame.id
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
                          <div className="flex h-full items-center justify-center text-xs text-slate-400">待生成</div>
                        )}
                        <span className="absolute left-1.5 top-1.5 rounded-full bg-white/95 px-1.5 py-0.5 text-[10px] font-semibold text-slate-950">
                          F{frame.frameIndex + 1}
                        </span>
                        <span className="absolute right-1.5 top-1.5 rounded-full bg-black/65 px-1.5 py-0.5 text-[10px] font-semibold text-white">
                          {frame.frameTimeSec}s
                        </span>
                        {isGenerating ? (
                          <span className="absolute inset-0 flex items-center justify-center bg-black/35 text-[11px] font-semibold text-white backdrop-blur-[1px]">
                            生成中
                          </span>
                        ) : null}
                      </button>
                      <div className="space-y-2 p-2">
                        <div className="flex items-center justify-between gap-1">
                          <span className="truncate text-[11px] font-semibold text-slate-600">
                            {frame.frameRole || '关键状态'}
                          </span>
                          <span className={`shrink-0 rounded-full px-1.5 py-0.5 text-[10px] font-semibold ${isGenerating ? 'bg-amber-100 text-amber-700' : frameUrl ? 'bg-emerald-100 text-emerald-700' : 'bg-slate-100 text-slate-500'}`}>
                            {isGenerating ? '生成中' : frameUrl ? '已生成' : '待生成'}
                          </span>
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
                            disabled={isGenerating}
                            onClick={() => onRegenerateFrame(panel.id, frame.id)}
                            className="rounded-xl bg-blue-600 px-1 py-1.5 text-[11px] font-semibold text-white disabled:opacity-50"
                          >
                            重生
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
                <StatusPill running={panel.imageTaskRunning} label={panel.imageTaskRunning ? '生图中' : '图片'} />
                <StatusPill running={panel.videoTaskRunning} label={panel.videoTaskRunning ? '生视频中' : '视频'} />
                {panel.panelMode === 'group' ? <span className="rounded-full bg-blue-50 px-2 py-0.5 text-[11px] font-medium text-blue-600">分镜组</span> : null}
              </div>
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
                  onClick={() => onRegenerate(panel.id)}
                  disabled={regeneratingPanelId === panel.id}
                  className="flex-1 rounded-2xl bg-blue-600 px-3 py-2.5 text-sm font-semibold text-white shadow-sm active:scale-95 disabled:opacity-60"
                >
                  {regeneratingPanelId === panel.id ? '提交中' : '重生图片'}
                </button>
                <button
                  type="button"
                  onClick={() => onOpenPanelMenu({
                    panel,
                    storyboardId: group.storyboardId,
                    hasNext: panelIndexInGroup < group.panels.length - 1,
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
  onPreview,
  onCopyPrompt,
  onGenerateAll,
  onGenerateVideo,
  onEditVideoPrompt,
  onEditDuration,
  onUploadVideo,
}: {
  panels: MobilePanel[]
  copiedPanelId: string | null
  onPreview: (url: string) => void
  onCopyPrompt: (panel: MobilePanel) => void
  onGenerateAll: () => void
  onGenerateVideo: (panel: MobilePanel) => void
  onEditVideoPrompt: (panel: MobilePanel) => void
  onEditDuration: (panel: MobilePanel) => void
  onUploadVideo: (panel: MobilePanel) => void
}) {
  if (panels.length === 0) {
    return (
      <div className="space-y-3">
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
        return (
          <article key={panel.id} className="overflow-hidden rounded-[24px] bg-white shadow-sm ring-1 ring-slate-200/80">
            <button
              type="button"
              className="relative block w-full bg-black disabled:cursor-default"
              style={{ aspectRatio: '16 / 9' }}
              disabled={!videoUrl}
              onClick={() => videoUrl && onPreview(videoUrl)}
            >
              {imageUrl ? (
                // eslint-disable-next-line @next/next/no-img-element
                <img src={imageUrl} alt={`视频 ${index + 1}`} className="h-full w-full object-cover opacity-80" />
              ) : null}
              <span className="absolute inset-0 flex items-center justify-center">
                <span className="flex h-12 w-12 items-center justify-center rounded-full bg-white/90 text-slate-950 shadow-lg">
                  <AppIcon name="play" className="h-5 w-5" />
                </span>
              </span>
              {!videoUrl ? (
                <span className="absolute inset-0 flex items-center justify-center bg-black/45 text-sm font-semibold text-white">
                  待生成
                </span>
              ) : null}
            </button>
            <div className="space-y-3 p-4">
              <div className="flex items-center justify-between gap-2">
                <div className="min-w-0">
                  <div className="text-base font-semibold">视频片段 {panel.panelNumber || index + 1}</div>
                  <div className="mt-0.5 text-xs text-slate-400">{getPanelDuration(panel) ?? '-'}s</div>
                </div>
                <StatusPill running={panel.videoTaskRunning} label={panel.videoTaskRunning ? '生成中' : '视频'} />
              </div>
              <p className="mt-1 line-clamp-2 text-sm leading-6 text-slate-500">{panel.description || panel.videoPrompt || '暂无描述'}</p>
              <div className="grid grid-cols-2 gap-2">
                <button
                  type="button"
                  onClick={() => onCopyPrompt(panel)}
                  className="rounded-2xl border border-slate-200 px-3 py-2.5 text-sm font-semibold text-slate-700 active:scale-95"
                >
                  {copiedPanelId === panel.id ? '已复制' : '复制提示词'}
                </button>
                <button
                  type="button"
                  onClick={() => onEditVideoPrompt(panel)}
                  className="rounded-2xl border border-slate-200 px-3 py-2.5 text-sm font-semibold text-slate-700 active:scale-95"
                >
                  编辑提示词
                </button>
                <button
                  type="button"
                  onClick={() => onGenerateVideo(panel)}
                  disabled={panel.videoTaskRunning}
                  className="rounded-2xl bg-blue-600 px-3 py-2.5 text-sm font-semibold text-white shadow-sm active:scale-95 disabled:opacity-50"
                >
                  {panel.videoTaskRunning ? '生成中' : '重生视频'}
                </button>
                <button
                  type="button"
                  onClick={() => onUploadVideo(panel)}
                  className="rounded-2xl bg-slate-950 px-3 py-2.5 text-sm font-semibold text-white shadow-sm active:scale-95"
                >
                  上传视频
                </button>
                <button
                  type="button"
                  onClick={() => onEditDuration(panel)}
                  className="rounded-2xl bg-slate-100 px-3 py-2.5 text-sm font-semibold text-slate-700 active:scale-95"
                >
                  改秒数
                </button>
                <button
                  type="button"
                  disabled={!videoUrl}
                  onClick={() => videoUrl && void downloadRemoteFile(videoUrl, `video-${panel.panelNumber || index + 1}.mp4`)}
                  className="rounded-2xl bg-slate-100 px-3 py-2.5 text-sm font-semibold text-slate-700 active:scale-95 disabled:opacity-40"
                >
                  下载
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
}: {
  tasks: MobileTask[]
  loading: boolean
  cancellingTaskId: string | null
  onCancel: (taskId: string) => void
  onRefresh: () => void
}) {
  if (loading) return <MobileLoadingState label="正在加载任务..." />

  if (tasks.length === 0) {
    return <MobileEmptyState title="暂无任务" description="图片、视频、文本生成任务会在这里显示。" />
  }

  return (
    <div className="space-y-3">
      <button
        type="button"
        onClick={onRefresh}
        className="w-full rounded-[22px] bg-white px-4 py-3 text-sm font-semibold text-slate-700 shadow-sm ring-1 ring-slate-200/80 active:scale-[0.99]"
      >
        刷新任务
      </button>
      {tasks.map((task) => {
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
