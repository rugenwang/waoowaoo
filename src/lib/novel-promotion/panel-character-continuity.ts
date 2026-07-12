type PanelCharacter = string | { name?: string | null }

export function normalizePanelLocationName(location: unknown): string | null {
  const value = typeof location === 'string' ? location.trim() : ''
  if (!value || value === '无' || value.toLowerCase() === 'none') return null
  return value
    .replace(/[（(].*?[）)]/g, '')
    .replace(/[_\-—｜|/\\\s]+/g, '')
    .toLowerCase()
}

export function isSamePanelLocation(left: unknown, right: unknown): boolean {
  const leftKey = normalizePanelLocationName(left)
  const rightKey = normalizePanelLocationName(right)
  return Boolean(leftKey && rightKey && leftKey === rightKey)
}

function collectCharacterNames(characters: unknown): Set<string> {
  const names = new Set<string>()
  if (!Array.isArray(characters)) return names

  for (const character of characters as PanelCharacter[]) {
    const rawName = typeof character === 'string' ? character : character?.name
    const name = rawName?.trim().toLocaleLowerCase()
    if (name) names.add(name)
  }
  return names
}

export function hasPanelCharacterContinuity(currentCharacters: unknown, nextCharacters: unknown): boolean {
  const currentNames = collectCharacterNames(currentCharacters)
  const nextNames = collectCharacterNames(nextCharacters)

  if (currentNames.size === 0 || nextNames.size === 0) {
    return currentNames.size === 0 && nextNames.size === 0
  }

  return [...currentNames].some((name) => nextNames.has(name))
}
