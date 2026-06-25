import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

describe('mobile video detail', () => {
  it('shows an obvious video prompt panel with direct view and edit actions', () => {
    const source = readFileSync(resolve(process.cwd(), 'src/features/mobile-h5/MobileProject.tsx'), 'utf8')

    expect(source).toContain('视频提示词')
    expect(source).toContain('展开查看')
    expect(source).toContain('编辑提示词')
    expect(source).toContain("panel.groupVideoPrompt || panel.videoPrompt")
  })

  it('shows ordered keyframes inside each mobile video card', () => {
    const source = readFileSync(resolve(process.cwd(), 'src/features/mobile-h5/MobileProject.tsx'), 'utf8')

    expect(source).toContain('成片分镜组关键帧')
    expect(source).toContain('getSortedFrames(panel)')
    expect(source).toContain('frame.frameTimeSec}s')
    expect(source).toContain('frame.frameRole')
    expect(source).toContain('成片首帧')
  })
})
