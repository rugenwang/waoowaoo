import fs from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'

const promptDir = path.join(process.cwd(), 'lib/prompts/novel-promotion')
const promptFiles = [
  'agent_storyboard_plan.zh.txt',
  'agent_storyboard_plan.en.txt',
  'agent_storyboard_detail.zh.txt',
  'agent_storyboard_detail.en.txt',
  'agent_storyboard_insert.zh.txt',
  'agent_storyboard_insert.en.txt',
]

describe('storyboard prompt policy', () => {
  it.each(promptFiles)('%s uses the compact shared video policy', (fileName) => {
    const content = fs.readFileSync(path.join(promptDir, fileName), 'utf8')
    expect(content.split('\n').length).toBeLessThan(100)
    expect(content).toContain('镜头外角色')
    expect(content).toContain('【对白】')
    expect(content).toContain('【旁白】')
    expect(content).toContain('画面内所有可见人物嘴唇全程保持自然静止')
    expect(content).toMatch(/F1\/F2\/Fn/)
  })

  it('keeps required locale placeholders', () => {
    const detailZh = fs.readFileSync(path.join(promptDir, 'agent_storyboard_detail.zh.txt'), 'utf8')
    const detailEn = fs.readFileSync(path.join(promptDir, 'agent_storyboard_detail.en.txt'), 'utf8')
    for (const content of [detailZh, detailEn]) {
      expect(content).toContain('{panels_json}')
      expect(content).toContain('{characters_age_gender}')
      expect(content).toContain('{locations_description}')
      expect(content).toContain('{props_description}')
    }
  })

  it('keeps dialogue inside its matching timeline segment', () => {
    for (const fileName of promptFiles) {
      const content = fs.readFileSync(path.join(promptDir, fileName), 'utf8')
      if (fileName.endsWith('.zh.txt')) {
        expect(content).toContain('对白必须嵌入实际发生的时间段')
        expect(content).toContain('禁止在连续时间轴结束后单独输出对白')
      } else {
        expect(content).toContain('Dialogue must be embedded in the timeline segment where it occurs')
        expect(content).toContain('Do not output a separate dialogue list after the timeline')
      }
    }

    const regenerateRoute = fs.readFileSync(
      path.join(process.cwd(), 'src/app/api/novel-promotion/[projectId]/regenerate-video-prompt/route.ts'),
      'utf8',
    )
    expect(regenerateRoute).toContain('对白必须嵌入实际发生的时间段')
    expect(regenerateRoute).toContain('禁止在连续时间轴结束后单独输出对白')
  })

  it('shows an inline-dialogue timeline example', () => {
    for (const fileName of promptFiles) {
      const content = fs.readFileSync(path.join(promptDir, fileName), 'utf8')
      expect(content).toContain('00:00-00:03：平视中景固定镜')
      expect(content).toContain('低声说：【对白】林晚：「我明白了。」')
    }

    const regenerateRoute = fs.readFileSync(
      path.join(process.cwd(), 'src/app/api/novel-promotion/[projectId]/regenerate-video-prompt/route.ts'),
      'utf8',
    )
    expect(regenerateRoute).toContain('00:00-00:03：平视中景固定镜')
    expect(regenerateRoute).toContain('低声说：【对白】林晚：「我明白了。」')
  })
})
