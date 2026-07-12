'use client'

import { useCallback, useEffect, useMemo, useState, type ReactNode } from 'react'
import { AppIcon } from '@/components/ui/icons'
import { ART_STYLES, VIDEO_RATIOS } from '@/lib/constants'
import type { CapabilitySelections, CapabilityValue, ModelCapabilities } from '@/lib/model-config-contract'
import { apiFetch } from '@/lib/api-fetch'
import { useUpdateProjectConfig } from '@/lib/query/hooks'
import { useUserModels, type UserModelOption } from '@/lib/query/hooks/useUserModels'
import { getMobileProjectSettingsSnapshot } from './mobile-project-settings'
import { MOBILE_SETTINGS_SECTIONS, type MobileSettingsSectionKey } from './mobile-workspace-layout'
import type { MobileNovelPromotionData } from './types'
import { DEFAULT_LTX_VIDEO_LORAS, type LtxVideoLoraConfig } from '@/lib/ltx-lora-config'

interface MobileProjectSettingsProps {
  projectId: string
  projectData: MobileNovelPromotionData | null | undefined
  onClose: () => void
  onUpdated: () => void
}

interface SelectOption {
  value: string
  label: string
}

function SettingsSection({
  title,
  description,
  open,
  onToggle,
  children,
}: {
  title: string
  description: string
  open: boolean
  onToggle: () => void
  children: ReactNode
}) {
  return (
    <section className="overflow-hidden rounded-[22px] bg-white shadow-sm ring-1 ring-slate-200/80">
      <button type="button" onClick={onToggle} className="flex min-h-16 w-full items-center gap-3 px-4 py-3 text-left">
        <div className="min-w-0 flex-1">
          <div className="text-sm font-semibold text-slate-950">{title}</div>
          <div className="mt-0.5 text-xs text-slate-500">{description}</div>
        </div>
        <AppIcon name="chevronDown" className={`h-4 w-4 shrink-0 text-slate-400 transition-transform ${open ? 'rotate-180' : ''}`} />
      </button>
      {open ? <div className="space-y-4 border-t border-slate-100 p-4">{children}</div> : null}
    </section>
  )
}

function FieldShell({ label, hint, children }: { label: string; hint?: string; children: ReactNode }) {
  return (
    <label className="block">
      <span className="mb-1.5 block text-xs font-semibold text-slate-600">{label}</span>
      {children}
      {hint ? <span className="mt-1 block text-[11px] leading-5 text-slate-400">{hint}</span> : null}
    </label>
  )
}

function SelectField({ label, value, options, disabled, onChange }: {
  label: string
  value?: string | null
  options: SelectOption[]
  disabled?: boolean
  onChange: (value: string) => void
}) {
  return (
    <FieldShell label={label}>
      <select
        value={value || ''}
        disabled={disabled}
        onChange={(event) => onChange(event.target.value)}
        className="min-h-12 w-full rounded-2xl border border-slate-200 bg-slate-50 px-3 text-sm text-slate-800 outline-none focus:border-blue-400 disabled:opacity-50"
      >
        <option value="">未选择</option>
        {options.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
      </select>
    </FieldShell>
  )
}

function NumberField({ label, value, min = 1, max, step = 1, onCommit }: {
  label: string
  value: number
  min?: number
  max?: number
  step?: number
  onCommit: (value: number) => void
}) {
  return (
    <FieldShell label={label}>
      <input
        key={`${label}-${value}`}
        type="number"
        defaultValue={value}
        min={min}
        max={max}
        step={step}
        onBlur={(event) => {
          const next = Number(event.currentTarget.value)
          if (Number.isFinite(next) && next !== value) onCommit(next)
        }}
        className="min-h-12 w-full rounded-2xl border border-slate-200 bg-slate-50 px-3 text-sm font-semibold text-slate-800 outline-none focus:border-blue-400"
      />
    </FieldShell>
  )
}

function ToggleField({ label, description, checked, onChange }: {
  label: string
  description?: string
  checked: boolean
  onChange: (checked: boolean) => void
}) {
  return (
    <label className="flex min-h-14 items-center gap-3 rounded-2xl bg-slate-50 px-3 py-2">
      <span className="min-w-0 flex-1">
        <span className="block text-sm font-semibold text-slate-800">{label}</span>
        {description ? <span className="mt-0.5 block text-[11px] leading-4 text-slate-500">{description}</span> : null}
      </span>
      <input type="checkbox" checked={checked} onChange={(event) => onChange(event.target.checked)} className="h-5 w-5 accent-blue-600" />
    </label>
  )
}

function formatLoraLines(rows: LtxVideoLoraConfig[]): string {
  return rows.map((item) => `${item.path} | ${item.weight}`).join('\n')
}

function parseLoraLines(value: string): LtxVideoLoraConfig[] {
  return value
    .split('\n')
    .map((line) => {
      const [pathPart, weightPart] = line.split('|')
      const path = (pathPart || '').trim()
      const weight = Number((weightPart || '').trim())
      return path && Number.isFinite(weight) ? { path, weight } : null
    })
    .filter((item): item is LtxVideoLoraConfig => item !== null)
}

function capabilityFields(capabilities: ModelCapabilities | undefined, namespace: 'llm' | 'image' | 'video' | 'audio') {
  const value = capabilities?.[namespace]
  if (!value || typeof value !== 'object') return []
  return Object.entries(value)
    .filter(([key, options]) => key.endsWith('Options') && Array.isArray(options) && options.length > 0)
    .map(([key, options]) => ({ field: key.slice(0, -7), options: options as CapabilityValue[] }))
}

function CapabilityFields({ modelKey, models, namespace, selections, onChange }: {
  modelKey?: string | null
  models: UserModelOption[]
  namespace: 'llm' | 'image' | 'video' | 'audio'
  selections: CapabilitySelections
  onChange: (next: CapabilitySelections) => void
}) {
  const model = models.find((item) => item.value === modelKey)
  const fields = capabilityFields(model?.capabilities, namespace)
  if (!modelKey || fields.length === 0) return null
  const selected = selections[modelKey] || {}
  return (
    <div className="space-y-3 rounded-2xl border border-blue-100 bg-blue-50/60 p-3">
      <div className="text-xs font-semibold text-blue-700">{model?.label || modelKey} 能力参数</div>
      {fields.map((field) => (
        <SelectField
          key={field.field}
          label={field.field.replace(/([A-Z])/g, ' $1')}
          value={selected[field.field] === undefined ? '' : String(selected[field.field])}
          options={field.options.map((value) => ({ value: String(value), label: String(value) }))}
          onChange={(raw) => {
            const sample = field.options[0]
            const value: CapabilityValue = typeof sample === 'number'
              ? Number(raw)
              : typeof sample === 'boolean'
                ? raw === 'true'
                : raw
            onChange({ ...selections, [modelKey]: { ...selected, [field.field]: value } })
          }}
        />
      ))}
    </div>
  )
}

export default function MobileProjectSettings({ projectId, projectData, onClose, onUpdated }: MobileProjectSettingsProps) {
  const modelsQuery = useUserModels()
  const updateMutation = useUpdateProjectConfig(projectId)
  const snapshot = useMemo(() => getMobileProjectSettingsSnapshot(projectData), [projectData])
  const [openSections, setOpenSections] = useState<Set<MobileSettingsSectionKey>>(new Set(['basic', 'models']))
  const [search, setSearch] = useState('')
  const [savingKey, setSavingKey] = useState<string | null>(null)
  const [statusMessage, setStatusMessage] = useState<string | null>(null)
  const [loraText, setLoraText] = useState(() => formatLoraLines(snapshot.localVideoLoras))
  const models = modelsQuery.data || { llm: [], image: [], video: [], audio: [], lipsync: [] }
  useEffect(() => {
    setLoraText(formatLoraLines(snapshot.localVideoLoras))
  }, [snapshot.localVideoLoras])
  const visibleSections = useMemo(() => {
    const keyword = search.trim().toLowerCase()
    if (!keyword) return MOBILE_SETTINGS_SECTIONS
    return MOBILE_SETTINGS_SECTIONS.filter((section) => `${section.label}${section.description}`.toLowerCase().includes(keyword))
  }, [search])

  const update = useCallback(async (key: string, value: unknown) => {
    setSavingKey(key)
    setStatusMessage(null)
    try {
      await updateMutation.mutateAsync({ key, value })
      onUpdated()
      setStatusMessage('已保存')
      window.setTimeout(() => setStatusMessage(null), 1200)
    } catch (error) {
      setStatusMessage(error instanceof Error ? error.message : '保存失败')
    } finally {
      setSavingKey(null)
    }
  }, [onUpdated, updateMutation])

  const updateProgressPopup = useCallback(async (value: boolean) => {
    await update('progressPopupEnabled', value)
    await apiFetch('/api/user-preference', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ progressPopupEnabled: value }),
    })
  }, [update])

  const toggleSection = (key: MobileSettingsSectionKey) => {
    setOpenSections((previous) => {
      const next = new Set(previous)
      if (next.has(key)) next.delete(key)
      else next.add(key)
      return next
    })
  }

  return (
    <div className="fixed inset-0 z-50 overflow-y-auto bg-[#f4f6f8] pb-[calc(1rem+env(safe-area-inset-bottom))]">
      <header className="sticky top-0 z-20 border-b border-slate-200/80 bg-white/95 px-4 pb-3 pt-[calc(0.75rem+env(safe-area-inset-top))] backdrop-blur">
        <div className="flex items-center gap-3">
          <button type="button" onClick={onClose} className="flex h-10 w-10 items-center justify-center rounded-full bg-slate-100 text-slate-600">
            <AppIcon name="chevronLeft" className="h-5 w-5" />
          </button>
          <div className="min-w-0 flex-1">
            <h2 className="text-base font-semibold text-slate-950">项目设置</h2>
            <p className="text-xs text-slate-500">修改后自动保存</p>
          </div>
          <span className={`text-xs font-semibold ${statusMessage === '已保存' ? 'text-emerald-600' : 'text-slate-500'}`}>
            {savingKey ? '保存中...' : statusMessage}
          </span>
        </div>
        <div className="relative mt-3">
          <AppIcon name="search" className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400" />
          <input value={search} onChange={(event) => setSearch(event.target.value)} placeholder="搜索项目设置" className="h-11 w-full rounded-2xl bg-slate-100 pl-10 pr-3 text-sm text-slate-800 outline-none focus:ring-2 focus:ring-blue-200" />
        </div>
      </header>

      <main className="mx-auto max-w-md space-y-3 p-4">
        {visibleSections.map((section) => (
          <SettingsSection
            key={section.key}
            title={section.label}
            description={section.description}
            open={openSections.has(section.key)}
            onToggle={() => toggleSection(section.key)}
          >
            {section.key === 'basic' ? (
              <>
                <SelectField label="画面风格" value={projectData?.artStyle} options={ART_STYLES.map((item) => ({ value: item.value, label: item.label }))} onChange={(value) => void update('artStyle', value)} />
                <SelectField label="视频比例" value={projectData?.videoRatio} options={VIDEO_RATIOS.map((item) => ({ value: item.value, label: item.label }))} onChange={(value) => void update('videoRatio', value)} />
              </>
            ) : null}

            {section.key === 'models' ? (
              <>
                <SelectField label="分析模型" value={projectData?.analysisModel} options={models.llm} disabled={modelsQuery.isLoading} onChange={(value) => void update('analysisModel', value)} />
                <SelectField label="角色图片模型" value={projectData?.characterModel} options={models.image} disabled={modelsQuery.isLoading} onChange={(value) => void update('characterModel', value)} />
                <SelectField label="场景图片模型" value={projectData?.locationModel} options={models.image} disabled={modelsQuery.isLoading} onChange={(value) => void update('locationModel', value)} />
                <SelectField label="分镜图片模型" value={projectData?.storyboardModel} options={models.image} disabled={modelsQuery.isLoading} onChange={(value) => void update('storyboardModel', value)} />
                <SelectField label="图片编辑模型" value={projectData?.editModel} options={models.image} disabled={modelsQuery.isLoading} onChange={(value) => void update('editModel', value)} />
                <SelectField label="视频模型" value={projectData?.videoModel} options={models.video} disabled={modelsQuery.isLoading} onChange={(value) => void update('videoModel', value)} />
                <SelectField label="语音模型" value={projectData?.audioModel} options={models.audio} disabled={modelsQuery.isLoading} onChange={(value) => void update('audioModel', value)} />
              </>
            ) : null}

            {section.key === 'image' ? (
              <>
                <div className="grid grid-cols-2 gap-3">
                  <NumberField label="通用宽度" value={snapshot.localImageWidth} onCommit={(value) => void update('localImageWidth', value)} />
                  <NumberField label="通用高度" value={snapshot.localImageHeight} onCommit={(value) => void update('localImageHeight', value)} />
                  <NumberField label="通用步数" value={snapshot.localImageSteps} onCommit={(value) => void update('localImageSteps', value)} />
                  <NumberField label="文生图步数" value={snapshot.localT2ISteps} onCommit={(value) => void update('localT2ISteps', value)} />
                  <NumberField label="文生图宽度" value={snapshot.localT2IWidth} onCommit={(value) => void update('localT2IWidth', value)} />
                  <NumberField label="文生图高度" value={snapshot.localT2IHeight} onCommit={(value) => void update('localT2IHeight', value)} />
                  <NumberField label="图生图宽度" value={snapshot.localI2IWidth} onCommit={(value) => void update('localI2IWidth', value)} />
                  <NumberField label="图生图高度" value={snapshot.localI2IHeight} onCommit={(value) => void update('localI2IHeight', value)} />
                  <NumberField label="图生图步数" value={snapshot.localI2ISteps} onCommit={(value) => void update('localI2ISteps', value)} />
                </div>
                <ToggleField label="启用分镜提示词精炼" checked={snapshot.localStoryboardPromptRefineEnabled} onChange={(value) => void update('localStoryboardPromptRefineEnabled', value)} />
                <SelectField label="精炼级别" value={snapshot.localStoryboardPromptRefineLevel} options={[{ value: 'conservative', label: '保守' }, { value: 'medium', label: '标准' }, { value: 'simple', label: '简洁' }]} onChange={(value) => void update('localStoryboardPromptRefineLevel', value)} />
                <ToggleField label="优先使用分镜描述" checked={snapshot.localStoryboardUsePanelDescriptionEnabled} onChange={(value) => void update('localStoryboardUsePanelDescriptionEnabled', value)} />
                <CapabilityFields modelKey={projectData?.storyboardModel} models={models.image} namespace="image" selections={snapshot.capabilityOverrides} onChange={(value) => void update('capabilityOverrides', value)} />
              </>
            ) : null}

            {section.key === 'video' ? (
              <>
                <SelectField label="分镜组时长倾向" value={snapshot.forcedStoryboardDurationSec === null ? '' : String(snapshot.forcedStoryboardDurationSec)} options={[{ value: '', label: '由 AI 决定' }, ...[8, 10, 15, 20].map((value) => ({ value: String(value), label: `${value} 秒` }))]} onChange={(value) => void update('forcedStoryboardDurationSec', value ? Number(value) : null)} />
                <CapabilityFields modelKey={projectData?.videoModel} models={models.video} namespace="video" selections={snapshot.capabilityOverrides} onChange={(value) => void update('capabilityOverrides', value)} />
                <FieldShell label="本地视频 LoRA" hint="仅 Local 视频模型生效。每行格式：LoRA路径 | 权重，按行顺序加载。">
                  <textarea
                    value={loraText}
                    onChange={(event) => setLoraText(event.target.value)}
                    onBlur={() => void update('localVideoLoras', parseLoraLines(loraText))}
                    rows={6}
                    className="w-full rounded-2xl border border-slate-200 bg-slate-50 px-3 py-2 text-xs font-mono leading-5 text-slate-800 outline-none focus:border-blue-400"
                  />
                  <button
                    type="button"
                    className="mt-2 min-h-10 rounded-2xl bg-slate-900 px-4 text-xs font-semibold text-white"
                    onClick={() => {
                      const text = formatLoraLines(DEFAULT_LTX_VIDEO_LORAS)
                      setLoraText(text)
                      void update('localVideoLoras', DEFAULT_LTX_VIDEO_LORAS)
                    }}
                  >
                    恢复默认 LoRA
                  </button>
                </FieldShell>
              </>
            ) : null}

            {section.key === 'audio' ? (
              <>
                <NumberField label="配音语速" value={Number(projectData?.ttsRate || 1)} min={0.5} max={2} step={0.1} onCommit={(value) => void update('ttsRate', String(value))} />
                <CapabilityFields modelKey={projectData?.audioModel} models={models.audio} namespace="audio" selections={snapshot.capabilityOverrides} onChange={(value) => void update('capabilityOverrides', value)} />
              </>
            ) : null}

            {section.key === 'tasks' ? (
              <ToggleField label="启用任务队列与进度弹窗" description="与 PC 项目队列设置共用" checked={snapshot.progressPopupEnabled} onChange={(value) => void updateProgressPopup(value)} />
            ) : null}
          </SettingsSection>
        ))}
      </main>
    </div>
  )
}
