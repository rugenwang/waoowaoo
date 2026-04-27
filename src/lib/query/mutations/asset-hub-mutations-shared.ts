import type { QueryClient } from '@tanstack/react-query'
import { queryKeys } from '../keys'
import { invalidateQueryTemplates } from './mutation-shared'

export const GLOBAL_ASSET_PROJECT_ID = 'global-asset-hub'

export function invalidateGlobalCharacters(queryClient: QueryClient) {
  // 资产库页面使用 unified assets（queryKeys.assets.*）渲染，
  // 仅刷新 legacy 的 globalAssets.characters 会导致 UI 不更新
  // （表现为：生成后点对号没反应，关掉页面再打开才生效）。
  return invalidateQueryTemplates(queryClient, [
    queryKeys.globalAssets.characters(),
    queryKeys.assets.all('global', null),
  ])
}

export function invalidateGlobalLocations(queryClient: QueryClient) {
  return invalidateQueryTemplates(queryClient, [
    queryKeys.globalAssets.locations(),
    queryKeys.assets.all('global', null),
  ])
}

export function invalidateGlobalVoices(queryClient: QueryClient) {
  return invalidateQueryTemplates(queryClient, [
    queryKeys.globalAssets.voices(),
    queryKeys.assets.all('global', null),
  ])
}
