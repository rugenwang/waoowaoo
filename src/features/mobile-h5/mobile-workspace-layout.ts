export const MOBILE_SETTINGS_SECTIONS = [
  { key: 'basic', label: '基础设置', description: '画面风格与比例' },
  { key: 'models', label: '模型设置', description: '分析、图片、视频与音频模型' },
  { key: 'image', label: '图片设置', description: '本地生图尺寸、步数与提示词' },
  { key: 'video', label: '视频设置', description: '视频时长与生成能力' },
  { key: 'audio', label: '音频设置', description: '语速与配音模型' },
  { key: 'tasks', label: '任务设置', description: '队列和进度显示' },
] as const

export type MobileSettingsSectionKey = (typeof MOBILE_SETTINGS_SECTIONS)[number]['key']

export function getMobileWorkspaceLayout() {
  return {
    page: 'min-w-0 space-y-3 overflow-x-hidden pb-24',
    list: 'grid grid-cols-1 gap-3',
    card: 'overflow-hidden rounded-[24px] bg-white shadow-sm ring-1 ring-slate-200/80',
    touchButton: 'inline-flex min-h-10 items-center justify-center rounded-2xl px-3 text-sm font-semibold active:scale-[0.98] disabled:opacity-50',
    bottomSheet: 'max-h-[86vh] w-full overflow-y-auto rounded-t-[28px] bg-white p-4 pb-[calc(1rem+env(safe-area-inset-bottom))] shadow-2xl',
  }
}
