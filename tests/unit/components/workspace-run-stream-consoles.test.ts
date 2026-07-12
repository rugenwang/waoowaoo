import * as React from 'react'
import { createElement } from 'react'
import { describe, expect, it, vi } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import WorkspaceRunStreamConsoles from '@/app/[locale]/workspace/[projectId]/modes/novel-promotion/components/WorkspaceRunStreamConsoles'

const llmStageStreamCardProps = vi.hoisted(() => [] as Array<{
  title: string
  onRetryStage?: (stepId: string) => void
}>)

vi.mock('next-intl', () => ({
  useTranslations: () => (key: string) => key,
}))

vi.mock('@/components/llm-console/LLMStageStreamCard', () => ({
  __esModule: true,
  default: (props: { title: string; onRetryStage?: (stepId: string) => void }) => {
    llmStageStreamCardProps.push(props)
    return createElement('section', null, `LLMStageStreamCard:${props.title}`)
  },
}))

function createStreamState(overrides?: Partial<React.ComponentProps<typeof WorkspaceRunStreamConsoles>['storyToScriptStream']>) {
  return {
    status: 'running' as const,
    isVisible: true,
    isRecoveredRunning: true,
    stages: [],
    selectedStep: null,
    activeStepId: null,
    outputText: '',
    activeMessage: '',
    overallProgress: 0,
    isRunning: false,
    errorMessage: '',
    stop: () => undefined,
    reset: () => undefined,
    selectStep: () => undefined,
    retryStep: async () => ({
      runId: 'run-1',
      status: 'running',
      summary: null,
      payload: null,
      errorMessage: '',
    }),
    ...overrides,
  }
}

describe('WorkspaceRunStreamConsoles', () => {
  it('shows fallback running console when a recovered run has no stages yet', () => {
    Reflect.set(globalThis, 'React', React)
    llmStageStreamCardProps.length = 0

    const html = renderToStaticMarkup(
      createElement(WorkspaceRunStreamConsoles, {
        storyToScriptStream: createStreamState(),
        scriptToStoryboardStream: createStreamState({
          status: 'idle',
          isVisible: false,
          isRecoveredRunning: false,
        }),
        storyToScriptConsoleMinimized: false,
        scriptToStoryboardConsoleMinimized: true,
        onStoryToScriptMinimizedChange: () => undefined,
        onScriptToStoryboardMinimizedChange: () => undefined,
      }),
    )

    expect(html).toContain('LLMStageStreamCard:runConsole.storyToScript')
  })

  it('surfaces retry submission failures instead of failing silently', async () => {
    Reflect.set(globalThis, 'React', React)
    llmStageStreamCardProps.length = 0
    const alertMock = vi.fn()
    const promptMock = vi.fn(() => '')
    vi.stubGlobal('alert', alertMock)
    vi.stubGlobal('prompt', promptMock)
    vi.stubGlobal('window', {
      alert: alertMock,
      prompt: promptMock,
    })

    renderToStaticMarkup(
      createElement(WorkspaceRunStreamConsoles, {
        storyToScriptStream: createStreamState({
          stages: [{
            id: 'failed-step',
            title: '失败步骤',
            status: 'failed',
            progress: 0,
          }],
          retryStep: async () => {
            throw new Error('retry rejected')
          },
        }),
        scriptToStoryboardStream: createStreamState({
          status: 'idle',
          isVisible: false,
          isRecoveredRunning: false,
        }),
        storyToScriptConsoleMinimized: false,
        scriptToStoryboardConsoleMinimized: true,
        onStoryToScriptMinimizedChange: () => undefined,
        onScriptToStoryboardMinimizedChange: () => undefined,
      }),
    )

    llmStageStreamCardProps[0]?.onRetryStage?.('failed-step')
    await new Promise((resolve) => setTimeout(resolve, 0))

    expect(alertMock).toHaveBeenCalledWith('重试失败：retry rejected')
    vi.unstubAllGlobals()
  })
})
