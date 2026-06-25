import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import {
  MOBILE_SETTINGS_SECTIONS,
  getMobileWorkspaceLayout,
} from '@/features/mobile-h5/mobile-workspace-layout'
import {
  canReferencePreviousPanel,
  resolveSelectedPanelFrameId,
  shouldDisplayPanelFrames,
} from '@/features/mobile-h5/mobile-utils'

describe('mobile workspace layout', () => {
  it('defines a single-column touch layout', () => {
    const layout = getMobileWorkspaceLayout()

    expect(layout.list).toContain('grid-cols-1')
    expect(layout.touchButton).toContain('min-h-10')
    expect(layout.bottomSheet).toContain('rounded-t-[28px]')
    expect(layout.page).toContain('overflow-x-hidden')
  })

  it('keeps all project setting groups reachable', () => {
    expect(MOBILE_SETTINGS_SECTIONS.map((section) => section.key)).toEqual([
      'basic',
      'models',
      'image',
      'video',
      'audio',
      'tasks',
    ])
  })

  it('does not embed desktop script, storyboard, video, or settings surfaces', () => {
    const projectSource = readFileSync(resolve(process.cwd(), 'src/features/mobile-h5/MobileProject.tsx'), 'utf8')
    const settingsSource = readFileSync(resolve(process.cwd(), 'src/features/mobile-h5/MobileProjectSettings.tsx'), 'utf8')

    expect(projectSource).not.toContain("components/ScriptView")
    expect(projectSource).not.toContain('StoryboardStageView')
    expect(projectSource).not.toContain('MobileFullVideoStage')
    expect(projectSource).not.toContain('完整功能')
    expect(projectSource).not.toContain('快速浏览')
    expect(settingsSource).not.toContain('SettingsModal')
    expect(settingsSource).not.toContain('ConfigModals')
  })

  it('only allows panels after the first global panel to reference the previous tail', () => {
    const panels = [
      { id: 'panel-1' },
      { id: 'panel-2' },
      { id: 'panel-3' },
    ]

    expect(canReferencePreviousPanel(panels, 'panel-1')).toBe(false)
    expect(canReferencePreviousPanel(panels, 'panel-2')).toBe(true)
    expect(canReferencePreviousPanel(panels, 'panel-3')).toBe(true)
    expect(canReferencePreviousPanel(panels, 'missing')).toBe(false)
  })

  it('displays the keyframe group even when a panel has only one frame', () => {
    expect(shouldDisplayPanelFrames([])).toBe(false)
    expect(shouldDisplayPanelFrames([{ id: 'frame-1' }])).toBe(true)
    expect(shouldDisplayPanelFrames([{ id: 'frame-1' }, { id: 'frame-2' }])).toBe(true)
  })

  it('selects a valid frame for the mobile prompt detail', () => {
    const frames = [
      { id: 'frame-3', frameIndex: 2 },
      { id: 'frame-1', frameIndex: 0 },
      { id: 'frame-2', frameIndex: 1 },
    ]

    expect(resolveSelectedPanelFrameId(frames, null)).toBe('frame-1')
    expect(resolveSelectedPanelFrameId(frames, 'frame-2')).toBe('frame-2')
    expect(resolveSelectedPanelFrameId(frames, 'deleted-frame')).toBe('frame-1')
    expect(resolveSelectedPanelFrameId([], 'frame-1')).toBeNull()
  })

  it('uses mobile-safe asset profile actions and dialogs', () => {
    const characterSectionSource = readFileSync(resolve(process.cwd(), 'src/app/[locale]/workspace/[projectId]/modes/novel-promotion/components/assets/CharacterSection.tsx'), 'utf8')
    const assetsModalsSource = readFileSync(resolve(process.cwd(), 'src/app/[locale]/workspace/[projectId]/modes/novel-promotion/components/assets/AssetsStageModals.tsx'), 'utf8')
    const profileCardSource = readFileSync(resolve(process.cwd(), 'src/app/[locale]/workspace/[projectId]/modes/novel-promotion/components/assets/CharacterProfileCard.tsx'), 'utf8')
    const profileDialogSource = readFileSync(resolve(process.cwd(), 'src/app/[locale]/workspace/[projectId]/modes/novel-promotion/components/assets/CharacterProfileDialog.tsx'), 'utf8')
    const assetsStageSource = readFileSync(resolve(process.cwd(), 'src/app/[locale]/workspace/[projectId]/modes/novel-promotion/components/AssetsStage.tsx'), 'utf8')

    expect(characterSectionSource).toContain('mobile={mobile}')
    expect(assetsModalsSource).toContain('mobile={mobile}')
    expect(profileCardSource).toContain("mobile ? 'grid grid-cols-1 gap-2")
    expect(profileDialogSource).toContain('env(safe-area-inset-bottom)')
    expect(assetsStageSource).not.toContain('fixed bottom-[calc(5.5rem+env(safe-area-inset-bottom))]')
    expect(assetsStageSource).toContain('min-h-11 w-full')
  })

  it('keeps mobile character asset queue feedback keyed by appearance id', () => {
    const assetsStageSource = readFileSync(resolve(process.cwd(), 'src/app/[locale]/workspace/[projectId]/modes/novel-promotion/components/AssetsStage.tsx'), 'utf8')
    const characterCardSource = readFileSync(resolve(process.cwd(), 'src/app/[locale]/workspace/[projectId]/modes/novel-promotion/components/assets/CharacterCard.tsx'), 'utf8')
    const characterSectionSource = readFileSync(resolve(process.cwd(), 'src/app/[locale]/workspace/[projectId]/modes/novel-promotion/components/assets/CharacterSection.tsx'), 'utf8')

    expect(assetsStageSource).toContain('uiKey: `character-${id}-${appearanceId}-group`')
    expect(assetsStageSource).toContain('requireSubmittedTaskId(data, \'角色图片\')')
    expect(assetsStageSource).toContain('throw new Error(`${label}任务提交成功但未返回任务 ID`)')
    expect(characterSectionSource).toContain('`character-${character.id}-${appearance.id}-group`')
    expect(characterCardSource).toContain('const assetQueuePrefix = `character-${character.id}-${appearance.id}`')
    expect(characterCardSource).toContain('const groupTaskKey = `${assetQueuePrefix}-group`')
    expect(characterCardSource).toContain('key.startsWith(assetQueuePrefix)')
    expect(characterCardSource).toContain("item.status === 'pending'")
    expect(characterCardSource).toContain('已加入队列')
    expect(characterCardSource).toContain('isAnyTaskQueued')
    expect(characterCardSource).not.toContain('`character-${character.id}-${appearance.appearanceIndex}-group`')
  })

  it('shows mobile asset cards as queued when their own task is waiting', () => {
    const characterActionsSource = readFileSync(resolve(process.cwd(), 'src/app/[locale]/workspace/[projectId]/modes/novel-promotion/components/assets/hooks/useCharacterActions.ts'), 'utf8')
    const locationCardSource = readFileSync(resolve(process.cwd(), 'src/app/[locale]/workspace/[projectId]/modes/novel-promotion/components/assets/LocationCard.tsx'), 'utf8')
    const batchSource = readFileSync(resolve(process.cwd(), 'src/app/[locale]/workspace/[projectId]/modes/novel-promotion/components/assets/hooks/useBatchGeneration.ts'), 'utf8')

    expect(characterActionsSource).toContain('`character-${characterId}-${appearanceId}-group`')
    expect(characterActionsSource).toContain('`character-${characterId}-${appearanceId}-${imageIndex}`')
    expect(batchSource).toContain('`character-${character.id}-${appearance.id}-group`')
    expect(locationCardSource).toContain("item.status === 'pending'")
    expect(locationCardSource).toContain('已加入队列')
    expect(locationCardSource).toContain('isAnyTaskQueued')
  })

  it('provides an app-native full-screen storyboard prompt detail', () => {
    const detailSource = readFileSync(resolve(process.cwd(), 'src/features/mobile-h5/MobileStoryboardPromptDetail.tsx'), 'utf8')
    const projectSource = readFileSync(resolve(process.cwd(), 'src/features/mobile-h5/MobileProject.tsx'), 'utf8')

    expect(detailSource).toContain('h-[100dvh]')
    expect(detailSource).toContain('env(safe-area-inset-bottom)')
    expect(detailSource).toContain('完整提示词')
    expect(detailSource).toContain('复制提示词')
    expect(detailSource).toContain('编辑提示词')
    expect(detailSource).toContain('重新生成')
    expect(projectSource).toContain('<MobileStoryboardPromptDetail')
    expect(projectSource).not.toContain("from '@/app/[locale]/workspace/[projectId]/modes/novel-promotion/components/storyboard/PanelCard'")
  })
})
