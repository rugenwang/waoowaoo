'use client'

import { useEffect, useMemo, useState } from 'react'
import { createPortal } from 'react-dom'
import { AppIcon } from '@/components/ui/icons'
import { useProjectCharacters } from '@/lib/query/hooks/useProjectAssets'
import { useUploadProjectCharacterVoice } from '@/lib/query/mutations/character-voice-mutations'
import { useCloneProjectPanelDubbing, useExtractProjectPanelVocals } from '@/lib/query/mutations/useVideoMutations'
import { extractErrorMessage } from '@/lib/errors/extract'
import type { Character } from '@/types/project'
import type { MatchedVoiceLine, VideoPanel } from '../types'

type DubbingMode = 'video-vocal' | 'character-voice'

interface PanelDubbingDialogProps {
  open: boolean
  mode: DubbingMode
  projectId: string
  panel: VideoPanel
  voiceLines: MatchedVoiceLine[]
  onClose: () => void
}

function buildDefaultDialogue(voiceLines: MatchedVoiceLine[]): string {
  return voiceLines
    .map((line) => line.content.trim())
    .filter(Boolean)
    .join('\n')
}

function getCharacterLabel(character: Character): string {
  const hasVoice = !!character.customVoiceUrl
  return hasVoice ? character.name : `${character.name}（未设置音色）`
}

export default function PanelDubbingDialog({
  open,
  mode,
  projectId,
  panel,
  voiceLines,
  onClose,
}: PanelDubbingDialogProps) {
  const charactersQuery = useProjectCharacters(projectId)
  const extractVocals = useExtractProjectPanelVocals(projectId)
  const cloneDubbing = useCloneProjectPanelDubbing(projectId)
  const uploadCharacterVoice = useUploadProjectCharacterVoice(projectId)
  const defaultDialogue = useMemo(() => buildDefaultDialogue(voiceLines), [voiceLines])
  const defaultEndSec = Math.max(1, Math.ceil(panel.textPanel?.duration || 10))
  const [text, setText] = useState(defaultDialogue)
  const [startSec, setStartSec] = useState('0')
  const [endSec, setEndSec] = useState(String(defaultEndSec))
  const [selectedCharacterId, setSelectedCharacterId] = useState('')
  const [saveVoiceCharacterId, setSaveVoiceCharacterId] = useState('')
  const [promptText, setPromptText] = useState(defaultDialogue)
  const [promptTextDirty, setPromptTextDirty] = useState(false)
  const [extracted, setExtracted] = useState<{ audioKey: string; audioUrl: string } | null>(null)
  const [generatedAudioUrl, setGeneratedAudioUrl] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  const characters = charactersQuery.data || []
  const selectedCharacter = characters.find((character) => character.id === selectedCharacterId) || null
  const charactersWithVoice = characters.filter((character) => !!character.customVoiceUrl)
  const firstVoiceCharacterId = charactersWithVoice[0]?.id || ''
  const firstCharacterId = characters[0]?.id || ''

  useEffect(() => {
    if (!open) return
    setText(defaultDialogue)
    setStartSec('0')
    setEndSec(String(defaultEndSec))
    setSelectedCharacterId(firstVoiceCharacterId)
    setSaveVoiceCharacterId(firstCharacterId)
    setPromptText(defaultDialogue)
    setPromptTextDirty(false)
    setExtracted(null)
    setGeneratedAudioUrl(null)
    setError(null)
  }, [defaultDialogue, defaultEndSec, firstCharacterId, firstVoiceCharacterId, open])

  useEffect(() => {
    if (!open || mode !== 'character-voice' || promptTextDirty) return
    const nextPrompt = selectedCharacter?.voicePrompt?.trim()
      || (selectedCharacter ? `${selectedCharacter.name}的角色音色` : '')
      || defaultDialogue
    setPromptText(nextPrompt)
  }, [
    defaultDialogue,
    mode,
    open,
    promptTextDirty,
    selectedCharacterId,
    selectedCharacter?.name,
    selectedCharacter?.voicePrompt,
  ])

  useEffect(() => {
    if (!open || mode !== 'video-vocal' || promptTextDirty) return
    setPromptText(text)
  }, [mode, open, promptTextDirty, text])

  if (!open || typeof document === 'undefined') return null

  const panelId = panel.panelId || ''
  const isBusy = extractVocals.isPending || cloneDubbing.isPending || uploadCharacterVoice.isPending
  const canExtract = mode === 'video-vocal' && !!panelId && !!panel.videoUrl && Number(endSec) > Number(startSec)
  const canClone = !!panelId
    && !!text.trim()
    && (mode === 'character-voice' ? !!selectedCharacter?.customVoiceUrl : !!extracted?.audioKey)

  const handleExtract = async () => {
    setError(null)
    setGeneratedAudioUrl(null)
    try {
      const result = await extractVocals.mutateAsync({
        panelId,
        startSec: Number(startSec),
        endSec: Number(endSec),
      })
      setExtracted({ audioKey: result.audioKey, audioUrl: result.audioUrl })
    } catch (err: unknown) {
      setError(extractErrorMessage(err, '提取人声失败'))
    }
  }

  const handleSaveExtractedVoice = async () => {
    if (!extracted || !saveVoiceCharacterId) return
    setError(null)
    try {
      const response = await fetch(extracted.audioUrl)
      if (!response.ok) throw new Error(`下载人声失败(${response.status})`)
      const blob = await response.blob()
      await uploadCharacterVoice.mutateAsync({
        characterId: saveVoiceCharacterId,
        file: new File([blob], 'extracted-vocals.wav', { type: 'audio/wav' }),
        voicePrompt: promptText.trim() || text.trim(),
      })
      alert('已保存到角色音色')
    } catch (err: unknown) {
      setError(extractErrorMessage(err, '保存角色音色失败'))
    }
  }

  const handleClone = async () => {
    setError(null)
    setGeneratedAudioUrl(null)
    try {
      const result = await cloneDubbing.mutateAsync({
        panelId,
        mode,
        text: text.trim(),
        promptText: promptText.trim() || text.trim(),
        sourceAudioKey: mode === 'video-vocal' ? extracted?.audioKey : undefined,
        characterId: mode === 'character-voice' ? selectedCharacterId : undefined,
        syncPromptToCharacter: mode === 'character-voice',
      })
      setGeneratedAudioUrl(result.audioUrl)
    } catch (err: unknown) {
      setError(extractErrorMessage(err, '视频配音失败'))
    }
  }

  return createPortal(
    <div className="fixed inset-0 z-[10000] flex items-center justify-center bg-black/70 p-4 backdrop-blur-sm" onClick={isBusy ? undefined : onClose}>
      <div
        className="flex max-h-[92vh] w-full max-w-3xl flex-col overflow-hidden rounded-xl border border-[var(--glass-stroke-base)] bg-[var(--glass-bg-surface)] shadow-2xl"
        onClick={(event) => event.stopPropagation()}
      >
        <div className="flex items-center justify-between border-b border-[var(--glass-stroke-subtle)] px-5 py-4">
          <div>
            <div className="text-sm font-semibold text-[var(--glass-text-primary)]">
              {mode === 'video-vocal' ? '视频配音' : '角色视频配音'}
            </div>
            <div className="mt-1 text-xs text-[var(--glass-text-tertiary)]">
              分镜 {panel.panelIndex + 1} · 只生成并保存配音音频
            </div>
          </div>
          <button
            type="button"
            disabled={isBusy}
            onClick={onClose}
            className="rounded-full p-2 text-[var(--glass-text-tertiary)] transition hover:bg-[var(--glass-bg-muted)] hover:text-[var(--glass-text-primary)] disabled:cursor-not-allowed disabled:opacity-50"
          >
            <AppIcon name="close" className="h-5 w-5" />
          </button>
        </div>

        <div className="flex-1 space-y-4 overflow-y-auto p-5">
          {error && (
            <div className="rounded-lg border border-[var(--glass-stroke-danger)] bg-[var(--glass-tone-danger-bg)] px-3 py-2 text-xs text-[var(--glass-tone-danger-fg)]">
              {error}
            </div>
          )}

          <label className="block">
            <span className="mb-1 block text-xs font-medium text-[var(--glass-text-tertiary)]">配音台词</span>
            <textarea
              value={text}
              onChange={(event) => setText(event.target.value)}
              className="min-h-28 w-full resize-y rounded-lg border border-[var(--glass-stroke-base)] bg-[var(--glass-bg-muted)] px-3 py-2 text-sm leading-6 text-[var(--glass-text-secondary)] outline-none focus:border-[var(--glass-tone-info-fg)]"
            />
          </label>

          {mode === 'video-vocal' ? (
            <div className="rounded-lg border border-[var(--glass-stroke-base)] bg-[var(--glass-bg-muted)] p-3">
              <div className="mb-2 text-xs font-medium text-[var(--glass-text-tertiary)]">从当前视频截取区间并提取人声</div>
              <div className="grid grid-cols-2 gap-3">
                <label className="text-xs text-[var(--glass-text-tertiary)]">
                  开始秒
                  <input
                    type="number"
                    min="0"
                    step="0.1"
                    value={startSec}
                    onChange={(event) => setStartSec(event.target.value)}
                    className="mt-1 w-full rounded-lg border border-[var(--glass-stroke-base)] bg-[var(--glass-bg-surface)] px-3 py-2 text-sm text-[var(--glass-text-secondary)] outline-none"
                  />
                </label>
                <label className="text-xs text-[var(--glass-text-tertiary)]">
                  结束秒
                  <input
                    type="number"
                    min="0"
                    step="0.1"
                    value={endSec}
                    onChange={(event) => setEndSec(event.target.value)}
                    className="mt-1 w-full rounded-lg border border-[var(--glass-stroke-base)] bg-[var(--glass-bg-surface)] px-3 py-2 text-sm text-[var(--glass-text-secondary)] outline-none"
                  />
                </label>
              </div>
              <button
                type="button"
                onClick={handleExtract}
                disabled={!canExtract || extractVocals.isPending}
                className="mt-3 inline-flex items-center gap-2 rounded-lg bg-[var(--glass-accent-from)] px-4 py-2 text-sm font-medium text-white disabled:cursor-not-allowed disabled:opacity-50"
              >
                <AppIcon name={extractVocals.isPending ? 'refresh' : 'audioWave'} className={`h-4 w-4 ${extractVocals.isPending ? 'animate-spin' : ''}`} />
                {extractVocals.isPending ? '正在提取人声...' : '提取人声'}
              </button>

              {extracted && (
                <div className="mt-3 space-y-3">
                  <audio controls src={extracted.audioUrl} className="w-full" />
                  <div className="flex flex-wrap items-center gap-2">
                    <select
                      value={saveVoiceCharacterId}
                      onChange={(event) => setSaveVoiceCharacterId(event.target.value)}
                      className="min-w-44 rounded-lg border border-[var(--glass-stroke-base)] bg-[var(--glass-bg-surface)] px-3 py-2 text-xs text-[var(--glass-text-secondary)] outline-none"
                    >
                      {characters.map((character) => (
                        <option key={character.id} value={character.id}>{character.name}</option>
                      ))}
                    </select>
                    <button
                      type="button"
                      onClick={handleSaveExtractedVoice}
                      disabled={!saveVoiceCharacterId || uploadCharacterVoice.isPending}
                      className="rounded-lg border border-[var(--glass-stroke-base)] px-3 py-2 text-xs text-[var(--glass-text-secondary)] hover:bg-[var(--glass-bg-surface)] disabled:cursor-not-allowed disabled:opacity-50"
                    >
                      {uploadCharacterVoice.isPending ? '保存中...' : '保存为角色音色'}
                    </button>
                  </div>
                </div>
              )}
            </div>
          ) : (
            <label className="block">
              <span className="mb-1 block text-xs font-medium text-[var(--glass-text-tertiary)]">选择角色音色</span>
              <select
                value={selectedCharacterId}
                onChange={(event) => {
                  setSelectedCharacterId(event.target.value)
                  setPromptTextDirty(false)
                }}
                className="w-full rounded-lg border border-[var(--glass-stroke-base)] bg-[var(--glass-bg-muted)] px-3 py-2 text-sm text-[var(--glass-text-secondary)] outline-none"
              >
                {characters.map((character) => (
                  <option key={character.id} value={character.id} disabled={!character.customVoiceUrl}>
                    {getCharacterLabel(character)}
                  </option>
                ))}
              </select>
            </label>
          )}

          <label className="block">
            <span className="mb-1 block text-xs font-medium text-[var(--glass-text-tertiary)]">声音参考文案</span>
            <textarea
              value={promptText}
              onChange={(event) => {
                setPromptText(event.target.value)
                setPromptTextDirty(true)
              }}
              className="min-h-20 w-full resize-y rounded-lg border border-[var(--glass-stroke-base)] bg-[var(--glass-bg-muted)] px-3 py-2 text-sm leading-6 text-[var(--glass-text-secondary)] outline-none focus:border-[var(--glass-tone-info-fg)]"
            />
            <span className="mt-1 block text-xs text-[var(--glass-text-tertiary)]">
              {mode === 'character-voice'
                ? '确认配音后会同步保存到所选角色的声音文案描述。'
                : '保存为角色音色时会同步保存到所选角色的声音文案描述。'}
            </span>
          </label>

          {generatedAudioUrl && (
            <div className="rounded-lg border border-[var(--glass-stroke-base)] bg-[var(--glass-bg-muted)] p-3">
              <div className="mb-2 text-xs font-medium text-[var(--glass-text-tertiary)]">已生成配音</div>
              <audio controls src={generatedAudioUrl} className="w-full" />
            </div>
          )}
        </div>

        <div className="flex justify-end gap-3 border-t border-[var(--glass-stroke-subtle)] px-5 py-4">
          <button
            type="button"
            onClick={onClose}
            disabled={isBusy}
            className="rounded-lg border border-[var(--glass-stroke-base)] bg-[var(--glass-bg-muted)] px-4 py-2 text-sm text-[var(--glass-text-secondary)] transition hover:bg-[var(--glass-bg-surface)] disabled:cursor-not-allowed disabled:opacity-50"
          >
            关闭
          </button>
          <button
            type="button"
            onClick={handleClone}
            disabled={!canClone || cloneDubbing.isPending}
            className="inline-flex items-center gap-2 rounded-lg bg-[var(--glass-accent-from)] px-4 py-2 text-sm font-medium text-white transition hover:bg-[var(--glass-accent-to)] disabled:cursor-not-allowed disabled:opacity-50"
          >
            <AppIcon name={cloneDubbing.isPending ? 'refresh' : 'audioWave'} className={`h-4 w-4 ${cloneDubbing.isPending ? 'animate-spin' : ''}`} />
            {cloneDubbing.isPending ? '生成中...' : '确认配音'}
          </button>
        </div>
      </div>
    </div>,
    document.body,
  )
}
