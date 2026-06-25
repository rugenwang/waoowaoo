export function getAssetLayoutClasses(mobile: boolean) {
  if (mobile) {
    return {
      stage: 'space-y-3',
      section: 'space-y-3',
      sectionHeader: 'flex items-center justify-between gap-3 rounded-[20px] bg-white px-3 py-3 shadow-sm ring-1 ring-slate-200/80',
      groupGrid: 'grid grid-cols-1 gap-3',
      characterGroup: 'w-full rounded-[22px] bg-white p-3 shadow-sm ring-1 ring-slate-200/80',
      assetGrid: 'grid grid-cols-1 gap-4',
      locationGrid: 'grid grid-cols-1 gap-3',
      card: 'w-full rounded-[22px] bg-white p-3 shadow-sm ring-1 ring-slate-200/80',
    }
  }

  return {
    stage: 'space-y-4',
    section: 'glass-surface p-6',
    sectionHeader: 'flex items-center justify-between mb-6',
    groupGrid: 'grid grid-cols-1 md:grid-cols-2 gap-6',
    characterGroup: 'glass-surface rounded-xl p-4',
    assetGrid: 'grid grid-cols-2 sm:grid-cols-3 gap-3',
    locationGrid: 'grid grid-cols-2 sm:grid-cols-3 md:grid-cols-3 lg:grid-cols-6 xl:grid-cols-6 gap-6',
    card: 'flex flex-col gap-2',
  }
}
