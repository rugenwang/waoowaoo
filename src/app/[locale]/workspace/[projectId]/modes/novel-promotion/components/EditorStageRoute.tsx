'use client'

import { useEffect, useMemo, useState } from 'react'
import { apiFetch } from '@/lib/api-fetch'
import { createProjectFromPanels, reconcileProjectWithPanels, VideoEditorStage, type VideoEditorProject } from '@/features/video-editor'
import { useWorkspaceProvider } from '../WorkspaceProvider'
import { useWorkspaceStageRuntime } from '../WorkspaceStageRuntimeContext'
import { useWorkspaceEpisodeStageData } from '../hooks/useWorkspaceEpisodeStageData'

type EditorPanelSource = Parameters<typeof createProjectFromPanels>[1][number]

export default function EditorStageRoute() {
  const runtime = useWorkspaceStageRuntime()
  const { projectId, episodeId } = useWorkspaceProvider()
  const { clips, storyboards } = useWorkspaceEpisodeStageData()
  const [initialProject, setInitialProject] = useState<VideoEditorProject | null>(null)
  const [loading, setLoading] = useState(true)

  const sourcePanels = useMemo<EditorPanelSource[]>(() => {
    const sortedStoryboards = [...storyboards].sort((left, right) => {
      const leftIndex = clips.findIndex((clip) => clip.id === left.clipId)
      const rightIndex = clips.findIndex((clip) => clip.id === right.clipId)
      return (leftIndex < 0 ? 9999 : leftIndex) - (rightIndex < 0 ? 9999 : rightIndex)
    })

    return sortedStoryboards.flatMap((storyboard) => (
      [...(storyboard.panels || [])]
        .sort((left, right) => (left.panelIndex ?? 0) - (right.panelIndex ?? 0))
        .map((panel) => ({
          id: panel.id,
          storyboardId: storyboard.id,
          panelIndex: panel.panelIndex,
          description: panel.description || undefined,
          duration: panel.duration ?? undefined,
          groupDurationSec: panel.groupDurationSec ?? undefined,
          videoUrl: panel.videoUrl || undefined,
          lipSyncVideoUrl: panel.lipSyncVideoUrl || undefined,
          imageUrl: panel.imageUrl || undefined,
          videoPrompt: panel.videoPrompt || undefined,
          groupVideoPrompt: panel.groupVideoPrompt || undefined,
          panelMode: panel.panelMode,
        }))
    ))
  }, [clips, storyboards])

  useEffect(() => {
    let cancelled = false
    async function loadEditorProject() {
      if (!episodeId) return
      setLoading(true)
      try {
        const response = await apiFetch(`/api/novel-promotion/${projectId}/editor?episodeId=${episodeId}`)
        const data = response.ok ? await response.json() : null
        const savedProject = data?.projectData as VideoEditorProject | null | undefined
        if (!cancelled) {
          setInitialProject(savedProject
            ? reconcileProjectWithPanels(savedProject, sourcePanels)
            : createProjectFromPanels(episodeId, sourcePanels))
        }
      } finally {
        if (!cancelled) setLoading(false)
      }
    }
    void loadEditorProject()
    return () => {
      cancelled = true
    }
  }, [episodeId, projectId, sourcePanels])

  if (!episodeId) return null

  if (loading || !initialProject) {
    return (
      <div className="glass-surface p-6 text-sm text-[var(--glass-text-secondary)]">
        正在加载剪辑工程...
      </div>
    )
  }

  return (
    <VideoEditorStage
      key={initialProject.id}
      projectId={projectId}
      episodeId={episodeId}
      initialProject={initialProject}
      sourcePanels={sourcePanels}
      defaultVideoModel={runtime.videoModel || undefined}
      onBack={() => runtime.onStageChange('videos')}
      onUpdateVideoPrompt={runtime.onUpdateVideoPrompt}
      onGenerateVideo={runtime.onGenerateVideo}
    />
  )
}
