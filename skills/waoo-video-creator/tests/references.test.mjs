import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const references = path.resolve(here, '../references')
const names = ['api-contracts.md', 'pipeline.md', 'artifact-schemas.md', 'recovery.md']

async function reference(name) {
  return readFile(path.join(references, name), 'utf8')
}

test('reference 文档定义受限的 Agent API 与运行时规则边界', async () => {
  const docs = Object.fromEntries(await Promise.all(names.map(async (name) => [name, await reference(name)])))
  const all = Object.values(docs).join('\n')

  for (const name of names) assert.ok(docs[name].length > 120, `${name} 应是可执行的操作说明`)
  assert.match(docs['api-contracts.md'], /WAOO_BASE_URL[\s\S]*WAOO_AGENT_TOKEN[\s\S]*WAOO_AGENT_USER_ID/)
  assert.match(docs['api-contracts.md'], /Authorization:\s*Bearer[\s\S]*X-Waoo-User-Id/i)
  assert.match(docs['api-contracts.md'], /success[\s\S]*failure[\s\S]*requestId/i)
  assert.match(docs['api-contracts.md'], /dry-run[\s\S]*--commit/i)
  assert.match(docs['api-contracts.md'], /幂等|Idempotency-Key/i)
  assert.match(docs['api-contracts.md'], /rules\.json[\s\S]*(权威|唯一规则源)/i)
  assert.match(docs['api-contracts.md'], /set-visual-bible[\s\S]*(manifest|hash)[\s\S]*(无 HTTP|不建 HTTP)/i)
  assert.match(docs['api-contracts.md'], /art-style-override[\s\S]*(高级手动|恢复)[\s\S]*skill/i)
  assert.match(docs['api-contracts.md'], /initial-video-ratio[\s\S]*initial-art-style[\s\S]*(创建|缺失项目)/i)
  assert.match(docs['api-contracts.md'], /created:false[\s\S]*(不得写入|不得.*设置)/i)
  for (const command of ['doctor', 'resolve-project', 'fetch-rules', 'find-local-run', 'create-run', 'get-run', 'commit-story', 'commit-assets', 'commit-screenplay', 'commit-storyboards', 'upload', 'snapshot', 'finalize']) {
    assert.match(docs['api-contracts.md'], new RegExp(command), `缺少命令 ${command}`)
  }

  for (const endpoint of all.match(/\/api\/[^\s)`]+/g) ?? []) {
    assert.match(endpoint, /^\/api\/agent\/v1\//, `只允许记录 Agent API: ${endpoint}`)
  }
  assert.match(all, /禁止[\s\S]*(analyze|story-to-script-stream|script-to-storyboard-stream)/i)
  assert.match(all, /禁止[\s\S]*(generate|regenerate|video|voice)/i)
  assert.doesNotMatch(all, /WAOO_(?:MODEL|OPENAI|ANTHROPIC|GEMINI|API_KEY)/i)
  assert.match(all, /不生成视频/)
  assert.match(all, /imagegen[\s\S]*(不可用|不可使用)[\s\S]*停止/i)
  assert.doesNotMatch(all, /完整(?:的)?\s*(?:waoo\s*)?(?:Prompt|提示词)原文/i)
})

test('pipeline 固定阶段、恢复候选与 Artifact 引用规则', async () => {
  const pipeline = await reference('pipeline.md')
  const artifacts = await reference('artifact-schemas.md')
  const recovery = await reference('recovery.md')

  for (const stage of ['阶段 0', '阶段 1', '阶段 2', '阶段 3', '阶段 4', '阶段 5', '阶段 6']) assert.match(pipeline, new RegExp(stage))
  assert.match(pipeline, /阶段 0[\s\S]*(分集|episode split)[\s\S]*(名称|name)[\s\S]*(简介|description)/i)
  assert.match(pipeline, /正式 run[\s\S]*intake[\s\S]*(当前规则|fetch-rules)/i)
  assert.match(pipeline, /projectName\/sourceText[\s\S]*initialVideoRatio\/initialArtStyle[\s\S]*(创建缺失项目|创建)[\s\S]*(不.*覆盖|绝不写入)/i)
  assert.match(pipeline, /不得[\s\S]*(?:art-style|video-ratio|split)[\s\S]*(?:run 覆盖|覆盖项)/i)
  assert.match(pipeline, /set-visual-bible[\s\S]*visual-bible\.json[\s\S]*hash/i)
  assert.match(pipeline, /pending-create[\s\S]*(原样重放[\s\S]*run-request\.json|run-request\.json[\s\S]*(完全相同|原样重放))/i)
  assert.match(pipeline, /多个候选|歧义[\s\S]*停止/i)
  assert.match(pipeline, /pinned rules|固定规则[\s\S]*(不可变|不覆盖)/i)
  assert.match(pipeline, /输入[\s\S]*Codex[\s\S]*rules[\s\S]*本地输出[\s\S]*validate[\s\S]*dry-run[\s\S]*commit[\s\S]*checkpoint[\s\S]*(停止|恢复)/i)

  assert.match(artifacts, /聚合[\s\S]*单 Artifact/i)
  assert.match(artifacts, /external key/i)
  assert.match(artifacts, /appearanceKey[\s\S]*(location|场景)[\s\S]*(prop|道具)[\s\S]*(clip|片段)[\s\S]*(storyboard|分镜)[\s\S]*(panel|面板)[\s\S]*(frame|帧)/i)
  assert.match(artifacts, /引用[\s\S]*(存在|可解析)/i)
  assert.doesNotMatch(artifacts, /\$schema[\s\S]*"properties"/i, '不得手抄完整 JSON Schema')
  assert.match(artifacts, /Clip\.locationKey.*字段必须提供.*可为\s*`?null`?/i)
  assert.match(artifacts, /Panel\.locationKey.*字段必须提供.*可为\s*`?null`?/i)
  assert.match(artifacts, /character.*appearance.*可以为空/i)
  assert.match(artifacts, /nullable 引用.*字段必须提供.*值为\s*`?null`?|字段必须提供.*nullable 引用.*值为\s*`?null`?/i)
  assert.match(artifacts, /仅在运行时.*Schema.*明确标为可选.*才可缺失/i)
  assert.doesNotMatch(artifacts, /可选引用可以缺失/i, 'nullable 字段不能被表述为可缺失')
  assert.doesNotMatch(artifacts, /场景站位只能使用.*有效 slot/i, '不得虚构 location availableSlots 的归属校验')
  assert.doesNotMatch(artifacts, /每个分镜角色必须引用 appearanceKey/i, 'appearance 不是强制字段')

  assert.match(recovery, /find-local-run[\s\S]*\.waoo-agent\/runs[\s\S]*\.waoo-agent\/intake/i)
  assert.match(recovery, /pending-create[\s\S]*完全相同[\s\S]*create-run/i)
  assert.match(recovery, /pinned|固定.*ruleSetHash[\s\S]*(不一致|停止)/i)
  assert.match(recovery, /同(?:一)? target[\s\S]*一次.*重试/i)
  assert.match(recovery, /不调用后端生成(?:降级)?/i)
})
