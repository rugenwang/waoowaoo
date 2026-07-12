'use client'

import { useCallback, useEffect, useMemo, useState } from 'react'
import { logError as _ulogError } from '@/lib/logging/core'
import type { VideoPanel } from '@/app/[locale]/workspace/[projectId]/modes/novel-promotion/components/video'

interface MutationLike<TInput = unknown> {
  mutateAsync: (input: TInput) => Promise<unknown>
}

interface PanelLinkUpdate {
  panelKey: string
  storyboardId: string
  panelIndex: number
  linked: boolean
}

interface UseVideoPanelLinkingParams {
  allPanels: VideoPanel[]
  updatePanelLinkMutation: MutationLike<{
    storyboardId: string
    panelIndex: number
    linked: boolean
  }>
}

export function useVideoPanelLinking({
  allPanels,
  updatePanelLinkMutation,
}: UseVideoPanelLinkingParams) {
  const [linkedOverrides, setLinkedOverrides] = useState<Map<string, boolean>>(new Map())

  const baseLinkedPanels = useMemo(() => {
    const map = new Map<string, boolean>()
    allPanels.forEach((panel) => {
      if (panel.linkedToNextPanel) {
        map.set(`${panel.storyboardId}-${panel.panelIndex}`, true)
      }
    })
    return map
  }, [allPanels])

  const panelKeys = useMemo(() => {
    const keys = new Set<string>()
    allPanels.forEach((panel) => {
      keys.add(`${panel.storyboardId}-${panel.panelIndex}`)
    })
    return keys
  }, [allPanels])

  const linkedPanels = useMemo(() => {
    const merged = new Map(baseLinkedPanels)
    linkedOverrides.forEach((value, key) => {
      if (value) merged.set(key, true)
      else merged.delete(key)
    })
    return merged
  }, [baseLinkedPanels, linkedOverrides])

  useEffect(() => {
    setLinkedOverrides((previous) => {
      if (previous.size === 0) return previous
      const next = new Map(previous)
      let changed = false
      previous.forEach((value, key) => {
        if (!panelKeys.has(key)) {
          next.delete(key)
          changed = true
          return
        }
        const baseValue = baseLinkedPanels.get(key) === true
        if (baseValue === value) {
          next.delete(key)
          changed = true
        }
      })
      return changed ? next : previous
    })
  }, [baseLinkedPanels, panelKeys])

  const applyOverride = useCallback((key: string, value: boolean) => {
    setLinkedOverrides((previous) => {
      const next = new Map(previous)
      const baseValue = baseLinkedPanels.get(key) === true
      if (baseValue === value) next.delete(key)
      else next.set(key, value)
      return next
    })
  }, [baseLinkedPanels])

  const handleToggleLink = useCallback(async (panelKey: string, storyboardId: string, panelIndex: number) => {
    const currentLinked = linkedPanels.get(panelKey) || false
    const newLinked = !currentLinked

    applyOverride(panelKey, newLinked)

    try {
      await updatePanelLinkMutation.mutateAsync({
        storyboardId,
        panelIndex,
        linked: newLinked,
      })
    } catch (error) {
      _ulogError('Failed to save link state:', error)
      applyOverride(panelKey, currentLinked)
    }
  }, [applyOverride, linkedPanels, updatePanelLinkMutation])

  const handleSetLinks = useCallback(async (updates: PanelLinkUpdate[]) => {
    const dedupedUpdates = updates.filter((update, index, list) =>
      update.panelKey
      && list.findIndex((candidate) => candidate.panelKey === update.panelKey) === index,
    )
    if (dedupedUpdates.length === 0) return

    const previousValues = new Map<string, boolean>()
    dedupedUpdates.forEach((update) => {
      previousValues.set(update.panelKey, linkedPanels.get(update.panelKey) || false)
      applyOverride(update.panelKey, update.linked)
    })

    try {
      await Promise.all(dedupedUpdates.map((update) =>
        updatePanelLinkMutation.mutateAsync({
          storyboardId: update.storyboardId,
          panelIndex: update.panelIndex,
          linked: update.linked,
        }),
      ))
    } catch (error) {
      _ulogError('Failed to save batch link state:', error)
      previousValues.forEach((value, key) => {
        applyOverride(key, value)
      })
      throw error
    }
  }, [applyOverride, linkedPanels, updatePanelLinkMutation])

  return {
    linkedPanels,
    handleToggleLink,
    handleSetLinks,
  }
}
