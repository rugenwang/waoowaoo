import * as React from 'react'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import { NextIntlClientProvider } from 'next-intl'
import type { AbstractIntlMessages } from 'next-intl'

const idleMutation = {
  isPending: false,
  mutate: vi.fn(),
}

vi.mock('@/lib/query/mutations', () => ({
  useGenerateCharacterImage: () => idleMutation,
  useSelectCharacterImage: () => idleMutation,
  useUndoCharacterImage: () => idleMutation,
  useUploadCharacterImage: () => idleMutation,
  useDeleteCharacter: () => idleMutation,
  useDeleteCharacterAppearance: () => idleMutation,
  useUploadCharacterVoice: () => idleMutation,
  useGenerateLocationImage: () => idleMutation,
  useSelectLocationImage: () => idleMutation,
  useUndoLocationImage: () => idleMutation,
  useUploadLocationImage: () => idleMutation,
  useDeleteLocation: () => idleMutation,
  useCancelTask: () => idleMutation,
}))

vi.mock('@/components/ui/icons', () => ({
  AppIcon: (props: { className?: string; name?: string }) =>
    createElement('span', { className: props.className, 'data-icon': props.name }),
}))

vi.mock('@/components/task/TaskStatusOverlay', () => ({
  default: () => createElement('div', null, 'overlay'),
}))

vi.mock('@/components/task/TaskStatusInline', () => ({
  default: () => createElement('span', null, 'inline'),
}))

vi.mock('@/components/media/MediaImageWithLoading', () => ({
  MediaImageWithLoading: (props: { containerClassName?: string; className?: string }) =>
    createElement('div', {
      className: [props.containerClassName, props.className].filter(Boolean).join(' '),
    }),
}))

vi.mock('@/components/image-generation/ImageGenerationInlineCountButton', () => ({
  default: () => createElement('button', null, 'count'),
}))

vi.mock('@/lib/task/presentation', () => ({
  resolveTaskPresentationState: () => null,
}))

vi.mock('@/lib/task-queue', () => ({
  useTaskQueue: () => ({
    enabled: false,
    queue: [],
    enqueue: vi.fn(),
  }),
}))

vi.mock('@/lib/query/hooks/useTaskTargetStateMap', () => ({
  useTaskTargetStateMap: () => ({
    getState: () => null,
  }),
}))

vi.mock('@/lib/image-generation/use-image-generation-count', () => ({
  useImageGenerationCount: () => ({
    count: 1,
    setCount: vi.fn(),
  }),
}))

vi.mock('@/lib/image-generation/count', () => ({
  getImageGenerationCountOptions: () => [{ value: 1, label: '1' }],
}))

vi.mock('@/app/[locale]/workspace/asset-hub/components/VoiceSettings', () => ({
  default: () => createElement('div', null, 'voice-settings'),
}))

const messages = {
  assetHub: {
    generateFailed: '生成失败',
    selectFailed: '选择失败',
    uploadFailed: '上传失败',
    confirmDeleteLocation: '确认删除场景',
    confirmDeleteProp: '确认删除道具',
    confirmDeleteCharacter: '确认删除角色',
    cancel: '取消',
    delete: '删除',
    propLabel: '道具',
    locationLabel: '场景',
  },
  assets: {
    image: {
      generateCountPrefix: '生成',
      generateCountSuffix: '张',
      generating: '生成中',
      generatingPlaceholder: '正在生成',
      regenerateStuck: '重新生成',
      regenCountPrefix: '重生成',
      undo: '撤回',
      upload: '上传',
      uploadReplace: '替换',
      edit: '编辑',
      selectCount: '选择数量',
      confirmOption: '确认选择',
      optionNumber: '方案 {number}',
      generatedProgress: '已生成 {generated}/{total}',
      optionSelected: '已选择方案 {number}',
      selectFirst: '请选择方案',
    },
    common: {
      generateFailed: '生成失败',
    },
    location: {
      regenerateImage: '重生成场景',
      edit: '编辑场景',
      delete: '删除场景',
    },
    prop: {
      regenerateImage: '重生成道具',
      edit: '编辑道具',
      delete: '删除道具',
    },
    character: {
      deleteWhole: '删除整个角色',
      primary: '主形象',
      secondary: '子形象',
      delete: '删除角色',
      deleteOptions: '删除选项',
    },
    video: {
      panelCard: {
        editPrompt: '编辑',
      },
    },
  },
} as const

const TestIntlProvider = NextIntlClientProvider as React.ComponentType<{
  locale: string
  messages: AbstractIntlMessages
  timeZone: string
  children?: React.ReactNode
}>

function renderWithIntl(node: React.ReactElement) {
  return renderToStaticMarkup(
    createElement(
      TestIntlProvider,
      {
        locale: 'zh',
        messages: messages as unknown as AbstractIntlMessages,
        timeZone: 'Asia/Shanghai',
      },
      node,
    ),
  )
}

describe('asset hub card aspect ratio', () => {
  it('keeps prop cards at the same 3:2 ratio as character assets while generation is running', async () => {
    Reflect.set(globalThis, 'React', React)
    const { default: LocationCard } = await import('@/app/[locale]/workspace/asset-hub/components/LocationCard')
    const html = renderWithIntl(
      createElement(LocationCard, {
        location: {
          id: 'prop-1',
          name: '鼠标',
          summary: '电脑鼠标',
          folderId: null,
          images: [
            {
              id: 'prop-image-1',
              imageIndex: 0,
              description: null,
              imageUrl: null,
              previousImageUrl: null,
              isSelected: false,
              imageTaskRunning: true,
            },
          ],
        },
        assetType: 'prop',
      }),
    )

    expect(html).toContain('aspect-[3/2]')
    expect(html).toContain('data-icon="image"')
    expect(html).not.toContain('min-h-[100px]')
  })

  it('keeps location cards square while generation is running', async () => {
    Reflect.set(globalThis, 'React', React)
    const { default: LocationCard } = await import('@/app/[locale]/workspace/asset-hub/components/LocationCard')
    const html = renderWithIntl(
      createElement(LocationCard, {
        location: {
          id: 'location-1',
          name: '餐厅',
          summary: '极简餐厅',
          folderId: null,
          images: [
            {
              id: 'location-image-1',
              imageIndex: 0,
              description: null,
              imageUrl: null,
              previousImageUrl: null,
              isSelected: false,
              imageTaskRunning: true,
            },
          ],
        },
        assetType: 'location',
      }),
    )

    expect(html).toContain('aspect-square')
    expect(html).toContain('data-icon="image"')
    expect(html).not.toContain('min-h-[100px]')
  })

  it('keeps character cards at the fixed 3:2 ratio while generation is running', async () => {
    Reflect.set(globalThis, 'React', React)
    const { CharacterCard } = await import('@/app/[locale]/workspace/asset-hub/components/CharacterCard')
    const html = renderWithIntl(
      createElement(CharacterCard, {
        character: {
          id: 'character-1',
          name: '沈烬',
          folderId: null,
          customVoiceUrl: null,
          appearances: [
            {
              id: 'appearance-1',
              appearanceIndex: 0,
              changeReason: '默认形象',
              description: null,
              imageUrl: null,
              imageUrls: [],
              selectedIndex: null,
              previousImageUrl: null,
              previousImageUrls: [],
              imageTaskRunning: true,
            },
          ],
        },
      }),
    )

    expect(html).toContain('aspect-[3/2]')
    expect(html).not.toContain('min-h-[100px]')
  })

  it('does not offer to confirm a failed location option without an image and still exposes upload', async () => {
    Reflect.set(globalThis, 'React', React)
    const { default: LocationCard } = await import('@/app/[locale]/workspace/asset-hub/components/LocationCard')
    const html = renderWithIntl(
      createElement(LocationCard, {
        location: {
          id: 'location-failed',
          name: '鬼门',
          summary: '失败场景',
          folderId: null,
          images: [
            {
              id: 'location-image-1',
              imageIndex: 0,
              description: null,
              imageUrl: null,
              previousImageUrl: null,
              isSelected: true,
              imageTaskRunning: false,
              lastError: { code: 'IMAGE_FAILED', message: '生成失败' },
            },
            {
              id: 'location-image-2',
              imageIndex: 1,
              description: null,
              imageUrl: null,
              previousImageUrl: null,
              isSelected: false,
              imageTaskRunning: false,
              lastError: { code: 'IMAGE_FAILED', message: '生成失败' },
            },
          ],
        },
        assetType: 'location',
      }),
    )

    expect(html).not.toContain('确认选择')
    expect(html).toContain('data-icon="upload"')
  })

  it('exposes upload when a character image generation failed without producing an image', async () => {
    Reflect.set(globalThis, 'React', React)
    const { CharacterCard } = await import('@/app/[locale]/workspace/asset-hub/components/CharacterCard')
    const html = renderWithIntl(
      createElement(CharacterCard, {
        character: {
          id: 'character-failed',
          name: '谢无妄',
          folderId: null,
          customVoiceUrl: null,
          appearances: [
            {
              id: 'appearance-failed',
              appearanceIndex: 0,
              changeReason: '默认形象',
              description: null,
              imageUrl: null,
              imageUrls: [],
              selectedIndex: null,
              previousImageUrl: null,
              previousImageUrls: [],
              imageTaskRunning: false,
              lastError: { code: 'IMAGE_FAILED', message: '生成失败' },
            },
          ],
        },
      }),
    )

    expect(html).toContain('生成失败')
    expect(html).toContain('data-icon="upload"')
  })
})
