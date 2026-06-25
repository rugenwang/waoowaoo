export type MobilePrimaryTab = 'story' | 'script' | 'storyboard' | 'videos' | 'more'

export type MobileMoreDestination =
  | 'assets'
  | 'voice'
  | 'tasks'
  | 'project-settings'
  | 'global-assets'
  | 'api-settings'

export type MobileWorkspaceTab = MobilePrimaryTab | MobileMoreDestination

export interface MobileNavigationItem<T extends string> {
  key: T
  label: string
  icon: AppIconName
  description?: string
  externalPath?: string
}

export const MOBILE_PRIMARY_TABS: readonly MobileNavigationItem<MobilePrimaryTab>[] = [
  { key: 'story', label: '故事', icon: 'edit' },
  { key: 'script', label: '剧本', icon: 'clapperboard' },
  { key: 'storyboard', label: '分镜', icon: 'imagePreview' },
  { key: 'videos', label: '成片', icon: 'video' },
  { key: 'more', label: '更多', icon: 'menu' },
]

export const MOBILE_MORE_DESTINATIONS: readonly MobileNavigationItem<MobileMoreDestination>[] = [
  { key: 'assets', label: '项目资产', icon: 'folderCards', description: '角色、场景、道具和项目音色' },
  { key: 'voice', label: '配音', icon: 'mic', description: '台词、音色、情绪和批量生成' },
  { key: 'tasks', label: '任务队列', icon: 'refresh', description: '查看进度、错误并取消任务' },
  { key: 'project-settings', label: '项目设置', icon: 'settingsHexMinor', description: '模型、画面、视频和本地生成参数' },
  { key: 'global-assets', label: '全局资产中心', icon: 'coins', description: '跨项目管理和复用资产', externalPath: '/mobile/assets' },
  { key: 'api-settings', label: 'API / 模型设置', icon: 'settingsHexAlt', description: '供应商、模型和默认能力配置', externalPath: '/mobile/settings' },
]

const MOBILE_WORKSPACE_TAB_KEYS = new Set<string>([
  ...MOBILE_PRIMARY_TABS.map((item) => item.key),
  ...MOBILE_MORE_DESTINATIONS.filter((item) => !item.externalPath).map((item) => item.key),
])

export function isMobileWorkspaceTab(value: unknown): value is MobileWorkspaceTab {
  return typeof value === 'string' && MOBILE_WORKSPACE_TAB_KEYS.has(value)
}

export function getMobilePrimaryTab(value: MobileWorkspaceTab): MobilePrimaryTab {
  return MOBILE_PRIMARY_TABS.some((item) => item.key === value)
    ? value as MobilePrimaryTab
    : 'more'
}
import type { AppIconName } from '@/components/ui/icons'
