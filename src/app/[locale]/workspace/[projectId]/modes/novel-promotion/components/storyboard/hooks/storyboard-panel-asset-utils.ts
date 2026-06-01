'use client'

import { logError as _ulogError } from '@/lib/logging/core'
import { extractErrorMessage } from '@/lib/errors/extract'
import type {
  Character,
  Location,
  NovelPromotionClip,
  Prop,
} from '@/types/project'
import type { SelectedAsset } from './useImageGeneration'

export function getErrorMessage(error: unknown, fallback: string): string {
  return extractErrorMessage(error, fallback)
}

function parseAssetNames(value: string | null | undefined): string[] {
  if (!value) return []
  try {
    const parsed = JSON.parse(value)
    if (!Array.isArray(parsed)) return []
    return parsed
      .map((item) => {
        if (typeof item === 'string') return item.trim()
        if (item && typeof item === 'object') {
          const name = (item as Record<string, unknown>).name
          return typeof name === 'string' ? name.trim() : ''
        }
        return ''
      })
      .filter(Boolean)
  } catch (error) {
    _ulogError('Failed to parse asset names:', error)
    return []
  }
}

interface BuildDefaultAssetsForClipParams {
  clipId: string
  clips: NovelPromotionClip[]
  characters: Character[]
  locations: Location[]
  props: Prop[]
}

export function buildDefaultAssetsForClip({
  clipId,
  clips,
  characters,
  locations,
  props,
}: BuildDefaultAssetsForClipParams): SelectedAsset[] {
  const clip = clips.find((item) => item.id === clipId)
  if (!clip) return []

  const assets: SelectedAsset[] = []

  const characterNames = parseAssetNames(clip.characters)
  if (characterNames.length > 0) {
    for (const characterName of characterNames) {
      const character = characters.find(
        (item) => item.name.toLowerCase() === characterName.toLowerCase(),
      )
      if (!character?.appearances) continue

      const appearances = character.appearances || []
      const firstAppearance = appearances[0]
      if (!firstAppearance?.imageUrl) continue

      const displayName = appearances.length > 1 && firstAppearance.changeReason
        ? `${character.name} - ${firstAppearance.changeReason}`
        : character.name
      assets.push({
        id: character.id,
        name: displayName,
        type: 'character',
        imageUrl: firstAppearance.imageUrl,
        appearanceId: firstAppearance.appearanceIndex,
        appearanceName: firstAppearance.changeReason,
      })
    }
  }

  if (clip.location) {
    const location = locations.find(
      (item) => item.name.toLowerCase() === clip.location?.toLowerCase(),
    )
    if (!location?.images) return assets

    const selectedImage = location.selectedImageId
      ? location.images.find((image) => image.id === location.selectedImageId)
      : location.images.find((image) => image.isSelected) ||
        location.images.find((image) => image.imageUrl) ||
        location.images[0]

    if (selectedImage?.imageUrl) {
      assets.push({
        id: location.id,
        name: location.name,
        type: 'location',
        imageUrl: selectedImage.imageUrl,
      })
    }
  }

  const propNames = parseAssetNames(clip.props)
  if (propNames.length > 0) {
    for (const propName of propNames) {
      const prop = props.find(
        (item) => item.name.toLowerCase() === propName.toLowerCase(),
      )
      if (!prop?.images) continue

      const selectedImage = prop.selectedImageId
        ? prop.images.find((image) => image.id === prop.selectedImageId)
        : prop.images.find((image) => image.isSelected) ||
          prop.images.find((image) => image.imageUrl) ||
          prop.images[0]

      if (selectedImage?.imageUrl) {
        assets.push({
          id: prop.id,
          name: prop.name,
          type: 'prop',
          imageUrl: selectedImage.imageUrl,
        })
      }
    }
  }

  return assets
}
