import * as React from 'react'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import { NextIntlClientProvider } from 'next-intl'
import type { AbstractIntlMessages } from 'next-intl'
import { AI_EDIT_BUTTON_CLASS } from '@/components/ui/ai-edit-style'

const locationImageListMock = vi.hoisted(() => vi.fn((props: { mode?: string; overlayActions?: React.ReactNode }) => (
  createElement('div', { 'data-location-image-list-mode': props.mode }, props.overlayActions ?? null)
)))
const uploadMutationMock = vi.hoisted(() => ({
  isPending: false,
  mutate: vi.fn(),
}))

vi.mock('@/lib/query/mutations', () => ({
  useUploadProjectLocationImage: () => uploadMutationMock,
  useCancelTask: () => ({ isPending: false, mutate: vi.fn() }),
}))

vi.mock('@/lib/query/hooks/useTaskTargetStateMap', () => ({
  useTaskTargetStateMap: () => ({
    getState: () => null,
  }),
}))

vi.mock('@/lib/task-queue', () => ({
  useTaskQueue: () => ({
    queue: [],
  }),
}))

vi.mock('@/app/[locale]/workspace/[projectId]/modes/novel-promotion/components/assets/location-card/LocationCardHeader', () => ({
  default: () => createElement('div', null),
}))

vi.mock('@/app/[locale]/workspace/[projectId]/modes/novel-promotion/components/assets/location-card/LocationCardActions', () => ({
  default: () => createElement('div', null),
}))

vi.mock('@/app/[locale]/workspace/[projectId]/modes/novel-promotion/components/assets/location-card/LocationImageList', () => ({
  default: locationImageListMock,
}))

vi.mock('@/components/ui/icons', () => ({
  AppIcon: () => createElement('span', null),
}))

vi.mock('@/components/ui/icons/AISparklesIcon', () => ({
  default: (props: { className?: string }) => createElement('svg', { className: props.className, 'data-icon': 'ai-sparkles' }),
}))

vi.mock('@/components/task/TaskStatusInline', () => ({
  default: () => createElement('span', null),
}))

vi.mock('@/components/image-generation/ImageGenerationInlineCountButton', () => ({
  default: () => createElement('button', null),
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

vi.mock('@/lib/task/presentation', () => ({
  resolveTaskPresentationState: () => null,
}))

const messages = {
  assets: {
    image: {
      upload: '上传图片',
      uploadReplace: '上传替换图片',
      edit: '编辑图片',
      undo: '撤回',
      regenerateStuck: '重新生成',
    },
    location: {
      regenerateImage: '重新生成场景',
      edit: '编辑场景',
      delete: '删除场景',
    },
    prop: {
      regenerateImage: '重新生成道具',
      edit: '编辑道具',
      delete: '删除道具',
    },
  },
} as const

const TestIntlProvider = NextIntlClientProvider as React.ComponentType<{
  locale: string
  messages: AbstractIntlMessages
  timeZone: string
  children?: React.ReactNode
}>

describe('LocationCard AI edit button', () => {
  it('uses the shared AI edit button style in single-image mode', async () => {
    locationImageListMock.mockClear()
    Reflect.set(globalThis, 'React', React)
    const { default: LocationCard } = await import('@/app/[locale]/workspace/[projectId]/modes/novel-promotion/components/assets/LocationCard')
    const html = renderToStaticMarkup(
      createElement(
        TestIntlProvider,
        {
          locale: 'zh',
          messages: messages as unknown as AbstractIntlMessages,
          timeZone: 'Asia/Shanghai',
        },
        createElement(LocationCard, {
          location: {
            id: 'prop-1',
            name: '银质餐具',
            summary: '银质西式餐具套装',
            selectedImageId: 'prop-image-1',
            images: [
              {
                id: 'prop-image-1',
                imageIndex: 0,
                description: '银质餐具套装，包含刀叉与汤匙，金属光泽冷白',
                imageUrl: 'https://example.com/prop.png',
                previousImageUrl: null,
                previousDescription: null,
                isSelected: true,
              },
            ],
          },
          assetType: 'prop',
          onEdit: () => undefined,
          onDelete: () => undefined,
          onRegenerate: () => undefined,
          onGenerate: () => undefined,
          onImageClick: () => undefined,
          onImageEdit: () => undefined,
          projectId: 'project-1',
        }),
      ),
    )

    expect(html).toContain('data-icon=\"ai-sparkles\"')
    for (const token of AI_EDIT_BUTTON_CLASS.split(' ')) {
      expect(html).toContain(token)
    }
    const firstCall = locationImageListMock.mock.calls[0]?.[0] as { aspectClassName?: string } | undefined
    expect(firstCall?.aspectClassName).toBe('aspect-[3/2]')
  })

  it('passes a square image slot to project location cards', async () => {
    locationImageListMock.mockClear()
    Reflect.set(globalThis, 'React', React)
    const { default: LocationCard } = await import('@/app/[locale]/workspace/[projectId]/modes/novel-promotion/components/assets/LocationCard')
    renderToStaticMarkup(
      createElement(
        TestIntlProvider,
        {
          locale: 'zh',
          messages: messages as unknown as AbstractIntlMessages,
          timeZone: 'Asia/Shanghai',
        },
        createElement(LocationCard, {
          location: {
            id: 'location-1',
            name: '餐厅',
            summary: '极简餐厅',
            selectedImageId: 'location-image-1',
            images: [
              {
                id: 'location-image-1',
                imageIndex: 0,
                description: '极简餐厅室内空间',
                imageUrl: 'https://example.com/location.png',
                previousImageUrl: null,
                previousDescription: null,
                isSelected: true,
              },
            ],
          },
          assetType: 'location',
          onEdit: () => undefined,
          onDelete: () => undefined,
          onRegenerate: () => undefined,
          onGenerate: () => undefined,
          onImageClick: () => undefined,
          onImageEdit: () => undefined,
          projectId: 'project-1',
        }),
      ),
    )

    const firstCall = locationImageListMock.mock.calls[0]?.[0] as { aspectClassName?: string } | undefined
    expect(firstCall?.aspectClassName).toBe('aspect-square')
  })

  it('falls back to single failed-image mode with upload when all generated options failed', async () => {
    locationImageListMock.mockClear()
    Reflect.set(globalThis, 'React', React)
    const { default: LocationCard } = await import('@/app/[locale]/workspace/[projectId]/modes/novel-promotion/components/assets/LocationCard')
    const html = renderToStaticMarkup(
      createElement(
        TestIntlProvider,
        {
          locale: 'zh',
          messages: messages as unknown as AbstractIntlMessages,
          timeZone: 'Asia/Shanghai',
        },
        createElement(LocationCard, {
          location: {
            id: 'location-failed',
            name: '冷殿_晨',
            summary: '姜璃感应同心玉异动',
            selectedImageId: 'failed-1',
            images: [
              {
                id: 'failed-1',
                imageIndex: 0,
                description: '方案1',
                imageUrl: null,
                previousImageUrl: null,
                previousDescription: null,
                isSelected: true,
                lastError: { code: 'GENERATION_FAILED', message: 'failed' },
              },
              {
                id: 'failed-2',
                imageIndex: 1,
                description: '方案2',
                imageUrl: null,
                previousImageUrl: null,
                previousDescription: null,
                isSelected: false,
                lastError: { code: 'GENERATION_FAILED', message: 'failed' },
              },
              {
                id: 'failed-3',
                imageIndex: 2,
                description: '方案3',
                imageUrl: null,
                previousImageUrl: null,
                previousDescription: null,
                isSelected: false,
                lastError: { code: 'GENERATION_FAILED', message: 'failed' },
              },
            ],
          },
          assetType: 'location',
          onEdit: () => undefined,
          onDelete: () => undefined,
          onRegenerate: () => undefined,
          onGenerate: () => undefined,
          onImageClick: () => undefined,
          onImageEdit: () => undefined,
          projectId: 'project-1',
        }),
      ),
    )

    const firstCall = locationImageListMock.mock.calls[0]?.[0] as { mode?: string } | undefined
    expect(firstCall?.mode).toBe('single')
    expect(html).toContain('title="上传图片"')
  })
})
