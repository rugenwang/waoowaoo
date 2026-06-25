export function getStoryInputComposerLayoutClasses(mobile: boolean) {
  if (mobile) {
    return {
      footer: 'flex flex-col gap-3 px-4 pb-4',
      selectors: 'w-full overflow-x-auto pb-1',
      selectorInner: 'flex min-w-max items-center gap-2',
      actions: 'grid w-full grid-cols-2 gap-2 [&>button]:w-full [&>button]:justify-center',
    }
  }

  return {
    footer: 'flex items-center gap-2 overflow-x-auto px-5 pb-4',
    selectors: 'flex min-w-max flex-1 items-center gap-2',
    selectorInner: 'contents',
    actions: 'ml-auto flex min-w-max items-center gap-2',
  }
}
