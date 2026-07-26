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
  assert.match(pipeline, /pending-create[\s\S]*(原样重放[\s\S]*run-request\.json|run-request\.json[\s\S]*(完全相同|原样重放))/i)
  assert.match(pipeline, /多个候选|歧义[\s\S]*停止/i)
  assert.match(pipeline, /pinned rules|固定规则[\s\S]*(不可变|不覆盖)/i)
  assert.match(pipeline, /输入[\s\S]*Codex[\s\S]*rules[\s\S]*本地输出[\s\S]*validate[\s\S]*dry-run[\s\S]*commit[\s\S]*checkpoint[\s\S]*(停止|恢复)/i)

  assert.match(artifacts, /聚合[\s\S]*单 Artifact/i)
  assert.match(artifacts, /external key/i)
  assert.match(artifacts, /appearanceKey[\s\S]*(location|场景)[\s\S]*(prop|道具)[\s\S]*(clip|片段)[\s\S]*(storyboard|分镜)[\s\S]*(panel|面板)[\s\S]*(frame|帧)/i)
  assert.match(artifacts, /引用[\s\S]*(存在|可解析)/i)
  assert.doesNotMatch(artifacts, /\$schema[\s\S]*"properties"/i, '不得手抄完整 JSON Schema')

  assert.match(recovery, /find-local-run[\s\S]*\.waoo-agent\/runs[\s\S]*\.waoo-agent\/intake/i)
  assert.match(recovery, /pending-create[\s\S]*完全相同[\s\S]*create-run/i)
  assert.match(recovery, /pinned|固定.*ruleSetHash[\s\S]*(不一致|停止)/i)
  assert.match(recovery, /同(?:一)? target[\s\S]*一次.*重试/i)
  assert.match(recovery, /不调用后端生成(?:降级)?/i)
})
