# waoo Agent Data API 实施计划

> **给智能代理工作者：** 必需：使用 qsuperpowers:subagent-driven-development（如果有子代理可用）或 qsuperpowers:executing-plans 来执行此计划。步骤使用复选框（`- [ ]`）语法进行跟踪。

**目标：** 在不改变 waoo 既有创作流程的前提下，新增一组只负责规则读取、结构化数据落库、图片上传和运行恢复的 `/api/agent/v1` 接口，供 Codex `waoo-video-creator` Skill 使用。

**架构：** Agent API 使用独立 Token 鉴权和独立 `AgentCreationRun` 运行记录；Zod 是请求契约的唯一实现源，并导出 JSON Schema 给客户端校验。所有写入都通过无模型依赖的 service 层进入现有 Project、Episode、Character、Location/Prop、Clip、Storyboard、Panel、PanelFrame 和 MediaObject 表。新代码不得导入任务提交器、模型网关、LLM、图片/视频 provider 或模型密钥配置。

**技术栈：** Next.js 15 Route Handlers、TypeScript、Zod 3、zod-to-json-schema、AJV 8、Prisma 6/MySQL、Sharp、Vitest

---

## 执行前约束

- 所有相对路径和命令均从 `/Users/wangrugen/duanju/waoowaoo` 执行。
- 规范来源：`docs/qsuperpowers/waoo-video-creator/specs/waoo-video-creator-design.md`，尤其是第 7～12 节和附录 A。
- 当前工作树已有用户未提交修改，包含现有 Prompt、Panel/PanelFrame 路由和创作编排代码。执行时不得清理、覆盖或格式化这些无关修改。
- 除明确列出的共享 helper 外，不修改任何既有 `/api/novel-promotion` 行为；Agent API 只能新增 `/api/agent/v1` 路由。
- 本计划不创建 Skill、不调用 `imagegen`、不生成视频、不创建 Task/GraphRun、不调用模型。
- 每个任务先写失败测试，再写最小实现，再运行目标测试；只有目标测试通过后才提交。
- 任何真实数据库集成测试都使用测试库；不得指向用户生产库。

## 任务 1：建立规范哈希、契约和 JSON Schema 单一实现源

**文件：**

- 修改：`package.json`
- 修改：`package-lock.json`
- 新建：`src/lib/agent-api/canonical-json.ts`
- 新建：`src/lib/agent-api/entity-id.ts`
- 新建：`src/lib/agent-api/contracts/common.ts`
- 新建：`src/lib/agent-api/contracts/project.ts`
- 新建：`src/lib/agent-api/contracts/run.ts`
- 新建：`src/lib/agent-api/contracts/story.ts`
- 新建：`src/lib/agent-api/contracts/assets.ts`
- 新建：`src/lib/agent-api/contracts/screenplay.ts`
- 新建：`src/lib/agent-api/contracts/storyboards.ts`
- 新建：`src/lib/agent-api/contracts/upload.ts`
- 新建：`src/lib/agent-api/contracts/finalize.ts`
- 新建：`src/lib/agent-api/contracts/registry.ts`
- 新建：`tests/fixtures/agent-api/hash-vectors.json`
- 新建：`tests/unit/agent-api/canonical-json.test.ts`
- 新建：`tests/unit/agent-api/entity-id.test.ts`
- 新建：`tests/unit/agent-api/contracts.test.ts`

- [ ] **步骤 1：安装明确的直接依赖**

运行：

```bash
npm install zod-to-json-schema@^3.24.6 ajv@^8.17.1
```

预期：`package.json` 和 `package-lock.json` 同时更新；`zod-to-json-schema` 与 `ajv` 出现在直接依赖中。

- [ ] **步骤 2：先写 canonical JSON 与哈希失败测试**

在 `tests/unit/agent-api/canonical-json.test.ts` 覆盖：

- 对象键按 Unicode 码点递归排序；
- 数组顺序保持不变；
- `undefined`、非有限数值和不支持的值被拒绝；
- CRLF/CR 原文统一为 LF 后再 trim；
- SHA-256 格式固定为 `sha256:<64 个小写十六进制字符>`；
- 同一语义对象不同键顺序得到相同哈希；
- `sourceHash`、`definitionHash`、`runFingerprint` 使用设计文档规定的精确材料。
- 固定的跨实现 `hash-vectors.json` 同时给后端测试和后续 Skill Node 脚本测试使用。

`entity-id.test.ts` 覆盖：

- `runId + entityType + externalKey` 得到稳定、合法 UUID；
- entityType/externalKey/runId 任一不同则 ID 不同；
- 数据库身份状态未被其他 run 改变时，dry-run 和真正 commit 使用同一 ID；
- helper 不读写数据库。

运行：

```bash
npx vitest run tests/unit/agent-api/canonical-json.test.ts
```

预期：失败，提示模块不存在。

- [ ] **步骤 3：实现最小 canonical JSON 和哈希 helper**

在 `canonical-json.ts` 导出：

```ts
canonicalJson(value: unknown): string
sha256Prefixed(input: string | Buffer): string
normalizeSourceText(sourceText: string): string
hashSourceText(sourceText: string): string
hashArtifact(data: unknown): string
buildRunFingerprint(input: {
  projectId: string
  sourceHash: string
  inputKindHint: 'auto' | 'outline' | 'story' | 'screenplay'
  locale: 'zh' | 'en'
  effectiveOptions: {
    artStyle: string
    videoRatio: string
    episodeSplitHint: string
  }
  ruleSetHash: string
}): string
```

不要用 `JSON.stringify(value, Object.keys(value).sort())`，因为它不能正确递归排序。

在 `entity-id.ts` 用 SHA-256 构造带正确 UUID version/variant bits 的稳定 ID。所有由 run 新建、且 dry-run 响应必须提前返回 ID 的 Character、Appearance、Location/Prop、LocationImage、Clip、Storyboard、Panel、Frame 都使用该 helper；复用旧资产时仍返回旧数据库 ID。这样 dry-run 可以返回规范的 projected ID 而不产生数据库写入；若 dry-run 与 commit 之间另一个 run 创建了可复用资产，commit 以最新确定性匹配得到的真实复用 ID 为准。

- [ ] **步骤 4：先写所有 Zod 契约的失败测试**

`contracts.test.ts` 逐项验证设计文档附录 A：

- `ExternalKey`、`Sha256`、locale、input kind、run status；
- 所有对象拒绝未知字段；
- 名称、简介、普通文本、故事正文和数组上限；
- `appearanceOrdinal`、sceneNumber、clip ordinal、panelNumber、frameIndex 连续性；
- `single/group` Frame 规则；
- 帧时间、依赖方向和 previous-panel-tail 规则；
- screenplay 中原文锚点和资产引用的结构形态；
- upload 字段只接受允许的 targetType、MIME 和非负 variantIndex；
- `CommitEnvelope` 固定 `schemaVersion: 1`；
- JSON Schema 注册表包含项目解析、运行、story、assets、screenplay、storyboards、upload、finalize 契约；
- `waoo-agent-upload.v1` 的 JSON Schema 把 multipart file 表达为必填 binary string，并保留允许 MIME/大小说明；服务端仍用同一 Zod upload schema 的 file-like refinement（`arrayBuffer/type/size/name`）校验真实 File；
- AJV 可以编译每份导出的 JSON Schema；
- 测试 AJV 实例显式注册 `binary` format 后可以编译每份导出的 JSON Schema；
- 普通 JSON 契约使用同一 fixture 比较 Zod/AJV；multipart upload 使用成对适配 fixture：Zod 侧传 file-like 对象，AJV 侧把同一文件元数据投影成 binary string，再断言字段/MIME/大小结果一致。

运行：

```bash
npx vitest run tests/unit/agent-api/contracts.test.ts
```

预期：失败，提示契约模块不存在。

- [ ] **步骤 5：按附录 A 实现 Zod 契约**

要求：

- 每个 object 使用 `.strict()`；
- 只在附录明确为开放 JSON 的 `details`/`jsonSchema` 处允许任意键；
- 跨字段约束用 `.superRefine()`，错误 path 必须能形成 API 的 `field`；
- 业务数据库引用检查不写进 Zod，留给对应 service；
- `registry.ts` 使用 `zod-to-json-schema` 从相同 Zod schema 导出 Draft-07 JSON Schema，不维护第二份手写 Schema；
- 对 Zod custom file-like 节点使用 `zod-to-json-schema` 的固定 override 输出 `{type: "string", format: "binary"}`；override 本身放在 registry 并有一致性测试，不能另建手写 upload schema。不要在模块加载期直接引用可能在 Node 18 测试环境中不存在的全局 `File` 构造器；
- `contracts.test.ts` 创建 AJV 时调用 `addFormat('binary', true)`；不要关闭全部 strict 校验来掩盖 Schema 错误；
- 固定并测试 contract ID：
  - `waoo-agent-resolve-project.v1`
  - `waoo-agent-create-run.v1`
  - `waoo-agent-story.v1`
  - `waoo-agent-assets.v1`
  - `waoo-agent-screenplay.v1`
  - `waoo-agent-storyboards.v1`
  - `waoo-agent-upload.v1`
  - `waoo-agent-finalize.v1`

- [ ] **步骤 6：运行目标测试和类型检查**

```bash
npx vitest run tests/unit/agent-api/canonical-json.test.ts tests/unit/agent-api/entity-id.test.ts tests/unit/agent-api/contracts.test.ts
npx tsc --noEmit
```

预期：两组测试通过；TypeScript 无新增错误。

- [ ] **步骤 7：提交**

```bash
git add package.json package-lock.json src/lib/agent-api/canonical-json.ts src/lib/agent-api/entity-id.ts src/lib/agent-api/contracts tests/fixtures/agent-api/hash-vectors.json tests/unit/agent-api
git commit -m "feat(agent-api): add canonical contracts"
```

## 任务 2：新增独立运行表和测试清理支持

**文件：**

- 修改：`prisma/schema.prisma`
- 新建：`prisma/migrations/20260724000100_add_agent_creation_runs/migration.sql`
- 修改：`tests/helpers/db-reset.ts`
- 修改：`tests/helpers/fixtures.ts`
- 新建：`tests/integration/agent-api/run-persistence.integration.test.ts`

- [ ] **步骤 1：先写运行记录持久化失败测试**

覆盖：

- User 和 Project 可以关联多个 Agent run；
- `[userId, projectId, runFingerprint]` 唯一；
- 删除 Project/User 时级联删除 run；
- LongText 字段可以保存 episode、asset、clip、storyboard、artifact hash 和 upload receipt 映射；
- 测试 reset helper 先删 Agent run，再删 Project/User，不触发外键失败。

运行：

```bash
BILLING_TEST_BOOTSTRAP=1 npx vitest run tests/integration/agent-api/run-persistence.integration.test.ts
```

预期：失败，Prisma Client 中不存在 `agentCreationRun`。

- [ ] **步骤 2：增加 Prisma model**

新增 `AgentCreationRun`：

```prisma
model AgentCreationRun {
  id                   String   @id @default(uuid())
  userId               String
  projectId            String
  sourceHash           String   @db.VarChar(71)
  runFingerprint       String   @db.VarChar(71)
  inputKindHint        String   @db.VarChar(16)
  locale               String   @db.VarChar(8)
  effectiveOptionsJson String   @db.Text
  ruleSetVersion       String   @db.VarChar(64)
  ruleSetHash          String   @db.VarChar(71)
  definitionHash       String   @db.VarChar(71)
  status               String   @default("created") @db.VarChar(32)
  currentStage         String   @default("created") @db.VarChar(64)
  episodeMapJson       String   @db.LongText
  assetMapJson         String?  @db.LongText
  clipMapJson          String?  @db.LongText
  storyboardMapJson    String?  @db.LongText
  artifactHashesJson   String?  @db.LongText
  receiptJson          String?  @db.LongText
  lastErrorJson        String?  @db.LongText
  completedAt          DateTime?
  createdAt            DateTime @default(now())
  updatedAt            DateTime @updatedAt
  user                 User     @relation(fields: [userId], references: [id], onDelete: Cascade)
  project              Project  @relation(fields: [projectId], references: [id], onDelete: Cascade)

  @@unique([userId, projectId, runFingerprint])
  @@index([projectId, status])
  @@index([userId, createdAt])
  @@map("agent_creation_runs")
}
```

同时给 `User` 和 `Project` 添加命名清晰的关系数组。

- [ ] **步骤 3：写显式 MySQL migration**

迁移必须：

- 创建 `agent_creation_runs`；
- 创建唯一键、状态索引和用户时间索引；
- 创建到 `user(id)`、`projects(id)` 的 cascade 外键；
- 不改 Task、GraphRun 或既有创作表。

- [ ] **步骤 4：生成 Prisma Client 并更新 fixture/reset**

```bash
npx prisma generate
```

在 `resetNovelPromotionState()` 和会删除 Project 的 reset 路径中，先执行：

```ts
await prisma.agentCreationRun.deleteMany()
```

在 `tests/helpers/fixtures.ts` 增加最小 `createFixtureAgentRun()`。

- [ ] **步骤 5：应用测试迁移并运行测试**

使用项目现有测试库启动方式后运行：

```bash
docker compose --project-name waoowaoo-test-runtime -f docker-compose.test.yml up -d --wait mysql
DATABASE_URL='mysql://root:root@127.0.0.1:3307/waoowaoo_test' npx prisma migrate deploy
docker compose --project-name waoowaoo-test-runtime -f docker-compose.test.yml down -v --remove-orphans
BILLING_TEST_BOOTSTRAP=1 npx vitest run tests/integration/agent-api/run-persistence.integration.test.ts
```

预期：迁移只作用于 disposable `waoowaoo_test`；唯一键、级联和大映射测试通过。不得在未显式设置测试 `DATABASE_URL` 时运行迁移验收。

- [ ] **步骤 6：提交**

```bash
git add prisma/schema.prisma prisma/migrations/20260724000100_add_agent_creation_runs tests/helpers/db-reset.ts tests/helpers/fixtures.ts tests/integration/agent-api/run-persistence.integration.test.ts
git commit -m "feat(agent-api): persist creation runs"
```

## 任务 3：实现 Agent 专用错误包装、鉴权和写请求幂等校验

**文件：**

- 新建：`src/lib/agent-api/errors.ts`
- 新建：`src/lib/agent-api/http.ts`
- 新建：`src/lib/agent-api/auth.ts`
- 新建：`src/lib/agent-api/idempotency.ts`
- 新建：`tests/unit/agent-api/auth.test.ts`
- 新建：`tests/unit/agent-api/http.test.ts`
- 新建：`tests/unit/agent-api/idempotency.test.ts`
- 修改：`scripts/guards/api-route-contract-guard.mjs`
- 修改：`tests/unit/guards/api-route-contract-guard.test.ts`

- [ ] **步骤 1：先写失败测试**

鉴权测试覆盖：

- `WAOO_AGENT_API_ENABLED !== "true"` 一律 404/禁用；
- Token 缺失、配置缺失、Bearer 不匹配均为 `AGENT_UNAUTHORIZED`；
- Token 使用恒定时间比较，不回显；
- `X-Waoo-User-Id` 缺失或不等于 `WAOO_AGENT_USER_ID` 为 `AGENT_FORBIDDEN`；
- user 不存在为 `AGENT_FORBIDDEN`；
- 项目或 run 不属于该 user 时为 `AGENT_FORBIDDEN`，不存在时为 `AGENT_RESOURCE_NOT_FOUND`。

HTTP/幂等测试覆盖：

- 每个成功/失败响应都有 `requestId`；
- Zod issue 转为 `CONTRACT_INVALID` 和首个精确 `field`；
- 未分类异常不泄漏堆栈、Token、数据库文本；
- POST/PUT 缺少或错误 `Idempotency-Key` 被拒绝；
- 各端点使用设计 7.2 的精确计算材料。

运行：

```bash
npx vitest run tests/unit/agent-api/auth.test.ts tests/unit/agent-api/http.test.ts tests/unit/agent-api/idempotency.test.ts tests/unit/guards/api-route-contract-guard.test.ts
```

预期：新测试失败。

- [ ] **步骤 2：实现统一 Agent 错误和 route wrapper**

`errors.ts` 定义设计文档列出的全部错误码、HTTP 状态和默认 retryable。

`http.ts` 提供：

```ts
agentRoute(handler)
agentSuccess(requestId, data, init?)
parseAgentJson(request, schema)
toAgentFailure(error, requestId)
```

`agentRoute` 负责 requestId、错误归一化和日志脱敏；路由文件不得重复拼响应 envelope。

- [ ] **步骤 3：实现独立鉴权**

`auth.ts` 提供：

```ts
requireAgentAuth(request): Promise<{ userId: string }>
requireAgentProject(request, projectId)
requireAgentRun(request, runId)
```

不要复用 `INTERNAL_TASK_TOKEN`，不要回退到 NextAuth Session，也不要读取用户模型/API Key。

- [ ] **步骤 4：实现幂等 helper**

导出并测试：

```ts
requireIdempotencyKey(request, expectedHash)
resolveProjectIdempotencyKey(normalizedName)
uploadIdempotencyKey({ runId, targetType, targetKey, variantIndex, contentSha256 })
finalizeIdempotencyKey(body)
```

- [ ] **步骤 5：让现有路由守卫识别专用鉴权**

在 `api-route-contract-guard.mjs` 的授权调用模式中加入：

```js
/\brequireAgentAuth\s*\(/
/\brequireAgentProject\s*\(/
/\brequireAgentRun\s*\(/
```

测试确认 Agent 路由需要 `agentRoute/apiHandler` 之一和显式 Agent auth；普通路由规则保持不变。若选择让 `agentRoute` 成为新 wrapper，守卫的 wrapper 检测也要显式允许它，不得把整个 `/api/agent` 放进 allowlist。

- [ ] **步骤 6：运行测试**

```bash
npx vitest run tests/unit/agent-api/auth.test.ts tests/unit/agent-api/http.test.ts tests/unit/agent-api/idempotency.test.ts tests/unit/guards/api-route-contract-guard.test.ts
npm run check:api-handler
```

预期：全部通过。

- [ ] **步骤 7：提交**

```bash
git add src/lib/agent-api/errors.ts src/lib/agent-api/http.ts src/lib/agent-api/auth.ts src/lib/agent-api/idempotency.ts tests/unit/agent-api scripts/guards/api-route-contract-guard.mjs tests/unit/guards/api-route-contract-guard.test.ts
git commit -m "feat(agent-api): add isolated auth and errors"
```

## 任务 4：发布项目规则包和 JSON Schema

**文件：**

- 新建：`lib/prompts/agent-creator/pipeline-hard-rules.zh.txt`
- 新建：`lib/prompts/agent-creator/pipeline-hard-rules.en.txt`
- 新建：`lib/prompts/agent-creator/asset-image-generation.zh.txt`
- 新建：`lib/prompts/agent-creator/asset-image-generation.en.txt`
- 新建：`lib/prompts/agent-creator/storyboard-image-generation.zh.txt`
- 新建：`lib/prompts/agent-creator/storyboard-image-generation.en.txt`
- 新建：`lib/prompts/agent-creator/quality-check.zh.txt`
- 新建：`lib/prompts/agent-creator/quality-check.en.txt`
- 新建：`src/lib/agent-api/rules/manifest.ts`
- 新建：`src/lib/agent-api/rules/load-rule-bundle.ts`
- 新建：`src/app/api/agent/v1/projects/[projectId]/creator-rules/route.ts`
- 新建：`src/app/api/agent/v1/contracts/[contractId]/route.ts`
- 新建：`tests/unit/agent-api/rules.test.ts`
- 新建：`tests/integration/api/contract/agent-data-routes.test.ts`

- [ ] **步骤 1：先写规则包失败测试**

覆盖：

- 规则包包含以下现有项目 Prompt 的当前内容和 hash：
  - `np_episode_split`
  - `np_ai_story_expand`
  - `np_agent_character_profile`
  - `np_agent_character_visual`
  - `np_select_location`
  - `np_select_prop`
  - `np_agent_clip`
  - `np_screenplay_conversion`
  - `np_agent_storyboard_plan`
  - `np_agent_cinematographer`
  - `np_agent_acting_direction`
  - `np_agent_storyboard_detail`
  - `np_single_panel_image`
  - `np_storyboard_prompt_refine`
- 同时包含四份 Agent 专用硬规则；
- locale 只取 `zh|en`；
- projectSettings 从当前 NovelPromotionProject 和 `getArtStylePrompt()` 实时解析；
- `contentHash` 等于“去掉 contentHash 字段后的 data 对象”的 canonical hash；
- 后续 run/commit 使用的 `ruleSetHash` 就是该 `contentHash`，不再计算第二种规则哈希；
- 每个 rule hash 等于其 UTF-8 原文 hash；
- contracts 的 hash 等于 JSON Schema canonical hash；
- contract route 只能访问 manifest 列出的 ID；
- 修改任一 Prompt 内容会改变规则包 contentHash；
- 返回体不含 analysisModel、imageModel、provider、API Key 或 Token。

运行：

```bash
npx vitest run tests/unit/agent-api/rules.test.ts tests/integration/api/contract/agent-data-routes.test.ts
```

预期：失败，路由和 loader 不存在。

- [ ] **步骤 2：实现固定 manifest**

`manifest.ts` 显式列出 rule ID、kind、现有 Prompt ID/Agent 专用文件和 contract ID，不扫描整个 Prompt 目录，避免无关 Prompt 改动导致规则版本漂移。

固定 `ruleSetVersion` 为可读版本，例如 `waoo-creator-v1`；内容变化由 `contentHash` 精确识别，版本升级规则在代码注释和测试中写明。

- [ ] **步骤 3：实现规则包 loader**

使用现有：

```ts
getPromptTemplate(promptId, locale)
getArtStylePrompt(project.artStyle, locale)
```

读取 Agent 专用文本时只允许 manifest 内的相对路径。返回的 `projectSettings`：

- `artStyle`
- `artStylePrompt`
- `videoRatio`
- `imageResolution`
- `forcedStoryboardDurationSec`

- [ ] **步骤 4：实现两个 GET 路由**

`creator-rules`：

- 专用鉴权；
- 校验项目归属；
- locale query 缺省为 `zh`；
- 返回固定版本、内容哈希、规则和契约 URL。

`contracts/[contractId]`：

- 专用鉴权；
- 只读取注册表；
- 返回 JSON Schema 和 hash；
- 不接受任意文件路径。

- [ ] **步骤 5：运行测试**

```bash
npx vitest run tests/unit/agent-api/rules.test.ts tests/integration/api/contract/agent-data-routes.test.ts
```

预期：规则、hash、鉴权和契约测试通过。

- [ ] **步骤 6：提交**

```bash
git add lib/prompts/agent-creator src/lib/agent-api/rules src/app/api/agent/v1/projects/'[projectId]'/creator-rules src/app/api/agent/v1/contracts/'[contractId]' tests/unit/agent-api/rules.test.ts tests/integration/api/contract/agent-data-routes.test.ts
git commit -m "feat(agent-api): publish creator rules"
```

## 任务 5：实现精确项目解析

**文件：**

- 新建：`src/lib/agent-api/services/project-resolver.ts`
- 新建：`src/app/api/agent/v1/projects/resolve/route.ts`
- 新建：`tests/unit/agent-api/project-resolver.test.ts`
- 新建：`tests/integration/agent-api/project-resolver.integration.test.ts`

- [ ] **步骤 1：先写失败测试**

覆盖：

- 名称 trim 后精确复用；
- 不做 ASCII lowercase、拼音、模糊或 contains；
- MySQL 默认不区分大小写 collation 下仍由 JS `===` 做最终精确过滤；
- 0 个精确命中时创建 Project + NovelPromotionProject；
- 新项目继承 UserPreference 中允许的有效默认值，非法 artStyle 回退 `american-comic`；
- 1 个精确命中返回 `created: false`；
- 多个精确命中返回 `PROJECT_NAME_AMBIGUOUS`；
- 不修改复用项目；
- 并发同名解析最终只允许本次调用确定地得到一个项目；若发现多个则返回冲突，不随机选；
- Idempotency-Key 必须等于 `sha256("resolve-project:" + trimmedName)`。

运行：

```bash
npx vitest run tests/unit/agent-api/project-resolver.test.ts
BILLING_TEST_BOOTSTRAP=1 npx vitest run tests/integration/agent-api/project-resolver.integration.test.ts
```

预期：失败。

- [ ] **步骤 2：实现纯数据 project resolver**

复制现有 `/api/projects` POST 的有效默认值语义，但不要让新 service 依赖 HTTP/Session。使用事务一次创建 Project 和 NovelPromotionProject。

为保证没有项目名唯一索引时仍满足 resolve 幂等，在事务开始后对当前 `user` 行执行 `SELECT id FROM user WHERE id = ? FOR UPDATE`，然后重新执行精确同名查询，再决定复用/创建/冲突。不要新增会改变旧项目功能的全局项目名唯一索引。

不要在本任务重构旧 `/api/projects` 路由；这可最大限度避免改变旧流程。两处共享的默认字段清单应以测试锁定，后续再单独提炼。

- [ ] **步骤 3：实现 resolve 路由**

请求只接受 `{name, description?}`；禁止 userId、模型字段和 `dryRun`。返回 `{projectId, name, created}`。

- [ ] **步骤 4：运行测试**

```bash
npx vitest run tests/unit/agent-api/project-resolver.test.ts
BILLING_TEST_BOOTSTRAP=1 npx vitest run tests/integration/agent-api/project-resolver.integration.test.ts
```

预期：全部通过。

- [ ] **步骤 5：提交**

```bash
git add src/lib/agent-api/services/project-resolver.ts src/app/api/agent/v1/projects/resolve tests/unit/agent-api/project-resolver.test.ts tests/integration/agent-api/project-resolver.integration.test.ts
git commit -m "feat(agent-api): resolve creator projects"
```

## 任务 6：创建或恢复运行，并原子分配剧集编号

**文件：**

- 新建：`src/lib/agent-api/run-state.ts`
- 新建：`src/lib/agent-api/services/run-service.ts`
- 新建：`src/app/api/agent/v1/projects/[projectId]/runs/route.ts`
- 新建：`src/app/api/agent/v1/runs/[runId]/route.ts`
- 新建：`tests/unit/agent-api/run-service.test.ts`
- 新建：`tests/integration/agent-api/run-create.integration.test.ts`
- 新建：`tests/concurrency/agent-api/run-create.concurrency.test.ts`

- [ ] **步骤 1：先写失败测试**

覆盖：

- 服务端重算 definitionHash 和 runFingerprint；
- 客户端 hash 不一致返回 `ARTIFACT_HASH_MISMATCH`；
- 新 fingerprint 首次创建时，ruleSetVersion/hash 必须等于当前发布规则包；
- 相同 fingerprint 的既有 run 必须先按唯一键恢复，再按该 run 已固定的 ruleSetVersion/hash 校验请求；服务端当前规则已经更新不能阻止旧 run 恢复；
- episode ordinal 必须从 1 连续、episodeKey 唯一；
- 首次运行在事务内创建 run 和 N 个空正文 episode；
- 在 `novel_promotion_projects` 行执行 `SELECT ... FOR UPDATE`；
- 从当前 max episodeNumber 后连续追加，不填历史空号；
- 相同 fingerprint 返回同一 run 和原 episode 映射；
- 同 fingerprint、不同 definitionHash 返回 `RUN_DEFINITION_CONFLICT`；
- 两个不同 fingerprint 并发创建不会分配重复编号；
- P2002 并发冲突最多重试一次，第二次返回 retryable 的 `EPISODE_NUMBER_CONFLICT`；
- GET run 只返回本 user 的规范 RunResponse。

运行：

```bash
npx vitest run tests/unit/agent-api/run-service.test.ts
BILLING_TEST_BOOTSTRAP=1 npx vitest run tests/integration/agent-api/run-create.integration.test.ts tests/concurrency/agent-api/run-create.concurrency.test.ts
```

预期：失败。

- [ ] **步骤 2：实现 typed run state codec**

`run-state.ts` 集中解析/序列化：

- episode map；
- asset map；
- clip map；
- storyboard/panel/frame map；
- artifact hashes；
- upload receipts。

所有 JSON 从数据库读出时再次用 Zod 校验；损坏数据转 `AGENT_INTERNAL_ERROR`，不要静默变成空对象。

- [ ] **步骤 3：实现 run service**

事务顺序：

1. 校验 project 所有权，并用请求中已归一化值重算 fingerprint/definitionHash；
2. 先读取相同唯一键 run；存在时校验请求规则值等于 run 固定值、definitionHash 一致并直接恢复，不比较当前发布规则；
3. 只有不存在既有 run 时，加载当前 creator-rules，校验请求 ruleSetVersion/hash；
4. 锁 NovelPromotionProject 行；
5. 重新读取相同 run，避免锁等待期间重复；若此时出现，按步骤 2 恢复；
6. 再次确认当前规则 hash 未在锁等待期间变化；
7. 读取最大 episodeNumber；
8. 按 ordinal 创建 episode；
9. 创建 AgentCreationRun 并保存 episode map；
10. 更新 NovelPromotionProject.lastEpisodeId 为最后新建 episode。

状态 helper 只允许单向推进；`incomplete/failed` 可以在修复后回到对应已提交阶段，`completed` 不再接受 Artifact 写入。

- [ ] **步骤 4：实现 POST/GET 路由**

POST 的 Idempotency-Key 必须等于正文 runFingerprint。GET 不写任何状态。

- [ ] **步骤 5：运行测试**

```bash
npx vitest run tests/unit/agent-api/run-service.test.ts
BILLING_TEST_BOOTSTRAP=1 npx vitest run tests/integration/agent-api/run-create.integration.test.ts tests/concurrency/agent-api/run-create.concurrency.test.ts
```

预期：全部通过，数据库中无 Task/GraphRun。

- [ ] **步骤 6：提交**

```bash
git add src/lib/agent-api/run-state.ts src/lib/agent-api/services/run-service.ts src/app/api/agent/v1/projects/'[projectId]'/runs src/app/api/agent/v1/runs/'[runId]'/route.ts tests/unit/agent-api/run-service.test.ts tests/integration/agent-api/run-create.integration.test.ts tests/concurrency/agent-api/run-create.concurrency.test.ts
git commit -m "feat(agent-api): create resumable runs"
```

## 任务 7：提交故事 Artifact

**文件：**

- 新建：`src/lib/agent-api/services/story-service.ts`
- 新建：`src/app/api/agent/v1/runs/[runId]/episodes/[episodeKey]/story/route.ts`
- 新建：`tests/unit/agent-api/story-service.test.ts`
- 新建：`tests/integration/agent-api/story-commit.integration.test.ts`

- [ ] **步骤 1：先写失败测试**

覆盖：

- Envelope 规则版本/hash 与 run 固定值一致；
- artifactHash 等于 canonical data hash；
- path episodeKey、data.episodeKey 和 run episode map 三者一致；
- sourceHash 与 run definition 中该集 sourceHash 一致；
- name 与运行定义一致；
- dryRun 执行完整校验但不更新 Episode/run；
- commit 只更新 run 创建的 Episode 的 description/novelText；
- 同 hash 重试返回同一回执；
- 不触碰运行前剧集；
- 所有集提交后状态推进为 `story_committed`，部分提交时 currentStage 反映进度但不谎报完成。

- [ ] **步骤 2：实现 story service 和 route**

route 只做鉴权、解析、幂等头校验和调用 service。service 在事务中锁 run，更新 Episode、artifactHashesJson 和状态。

- [ ] **步骤 3：运行测试并提交**

```bash
npx vitest run tests/unit/agent-api/story-service.test.ts
BILLING_TEST_BOOTSTRAP=1 npx vitest run tests/integration/agent-api/story-commit.integration.test.ts
git add src/lib/agent-api/services/story-service.ts src/app/api/agent/v1/runs/'[runId]'/episodes/'[episodeKey]'/story tests/unit/agent-api/story-service.test.ts tests/integration/agent-api/story-commit.integration.test.ts
git commit -m "feat(agent-api): commit story artifacts"
```

## 任务 8：提交资产 Artifact，执行确定性复用

**文件：**

- 新建：`src/lib/agent-api/asset-identity.ts`
- 新建：`src/lib/agent-api/services/asset-service.ts`
- 新建：`src/app/api/agent/v1/runs/[runId]/assets/route.ts`
- 新建：`tests/unit/agent-api/asset-identity.test.ts`
- 新建：`tests/unit/agent-api/asset-service.test.ts`
- 新建：`tests/integration/agent-api/assets-commit.integration.test.ts`
- 新建：`tests/concurrency/agent-api/appearance-index.concurrency.test.ts`

- [ ] **步骤 1：先写身份规范化失败测试**

覆盖：

- NFC、trim、连续空白折叠、ASCII lowercase；
- 不做 Unicode lowercase、拼音、同义词或模糊；
- aliases null/非法 JSON/非字符串数组按空数组并产生 warning；
- 请求和现有 name+aliases 任一交集即命中；
- 多命中冲突；
- gender 中文/英文规范化与 unknown 规则；
- 只有两边均为已知且不同时冲突；
- location/prop 按规范化主名和 assetKind 分开匹配。

- [ ] **步骤 2：先写资产 service 失败测试**

覆盖设计 8.2 和附录 A.6：

- external key/ordinal/slot 唯一性；
- dryRun 无写入；
- dryRun 对新资产返回 `entity-id.ts` 计算的 projected IDs，但不保存映射；
- 无命中创建 Character + N 个 Appearance；
- 唯一命中保留已有名称、描述、profileData、选图，只追加缺失 alias/appearance/空槽；
- 每个请求中的 Appearance 获得一个、每个 Location/Prop description 获得一个只属于当前 run 的图片候选槽；复用资产时在现有候选之后追加空槽，且不改变原 selectedIndex/selectedImageId；
- 严格保持规范的 AssetsCommitResponse，不给角色 appearance 响应添加 `variantIndex` 字段。客户端按约定对每个 appearance 始终上传 `variantIndex=0`，服务端由 `assetMapJson` 把这个 run-local 0 映射到实际 `imageUrls` 下标；场景/道具响应里的 `imageSlotIds` 只包含本 run 创建的 LocationImage；
- 同 run+external key 重试复用原 run-owned 槽位，不重复追加；
- 新角色 appearanceIndex 按 ordinal 映射到 0..N-1；
- 复用角色按 changeReason 精确规范化复用，否则在角色锁下从 max+1 追加；
- 同 run+appearanceKey 重试不再分配；
- location/prop 使用 `NovelPromotionLocation.assetKind` 区分；
- description 数组创建对应 LocationImage 空槽；
- 返回完整外部键映射和 `EXISTING_ASSET_PRESERVED` warnings；
- 提交后没有 Task、TaskEvent、GraphRun、UsageCost。

- [ ] **步骤 3：实现 identity helper 和事务 service**

角色 profileData 只在新建时写入结构化 JSON，完整保存 gender、ageRange、roleLevel、archetype、personalityTags、eraPeriod、socialClass、occupation、costumeTier、suggestedColors、primaryIdentifier、visualKeywords，并把新建角色 `profileConfirmed` 设为 true；复用时不覆盖已有 profileData/profileConfirmed。新建角色的 aliases 写 JSON 数组，introduction 写现有独立字段；每个 Appearance 的 visualDescription 同时写 description 和单元素 descriptions JSON 数组。

Location/Prop 使用现有 location-backed 数据结构，但在 Agent 事务内直接创建 `NovelPromotionLocation` 与 `LocationImage`，不要调用任何 generate action。
LocationImage.availableSlots 使用现有 `stringifyLocationAvailableSlots()` 编码；Prop 的 visualDescription 写入其唯一/对应图片槽 `description`，Location 的 descriptions 按顺序写入各槽。

图片候选采用 run-owned 槽位，不把 `variantIndex` 当成历史数组的裸下标：

- 每个 Appearance 在本 run 恰好分配一个候选，规范内可推导的上传坐标固定为 run-local `variantIndex=0`。新建 Appearance 的 0 映射到其第一个候选；复用 Appearance 时保留原 `imageUrl`、`imageUrls`、`selectedIndex`，在 `imageUrls` 末尾幂等追加 `''`，并把这个实际数组下标记录到 `assetMapJson`。图片质量重试或同目标新 hash 只替换这个 run-owned 槽，不新增第二个候选。
- 每个 Location/Prop description 分配一个本 run 的 `LocationImage` 空槽。复用资产时从现有最大 index 后追加，保留原 `selectedImageId`；响应 `imageSlotIds` 只返回这些新建或已由同 run 映射的槽位。
- `assetMapJson` 必须同时保存数据库实体 ID 与 run-local variant/slot 映射，后续 upload、snapshot、finalize 只能通过该映射解析目标。这样本次运行始终生成并持有自己的参考图，同时不会覆盖复用资产原来选中的图片。
- dry-run 只返回稳定 projected slot ID/映射，不向历史数组或表追加；commit 在锁内重新解析，若并发导致复用身份变化，以真实 ID 更新响应映射。

事务开始时先锁当前 NovelPromotionProject 行，串行化同项目的资产身份匹配/新建，避免两个 run 同时创建同名资产。对复用角色再执行明确角色行锁以分配 appearanceIndex；映射先查 run 中已有 external key，再做身份匹配。
对最多 500 个资产的 interactive transaction 显式设置与项目现有分镜事务同量级的 `maxWait`/`timeout`，并在超时时返回可诊断错误；不要依赖 Prisma 默认 5 秒。

- [ ] **步骤 4：实现 route**

Idempotency-Key 等于 artifactHash。`dryRun=true` 不更新 run 映射和状态。

- [ ] **步骤 5：运行测试**

```bash
npx vitest run tests/unit/agent-api/asset-identity.test.ts tests/unit/agent-api/asset-service.test.ts
BILLING_TEST_BOOTSTRAP=1 npx vitest run tests/integration/agent-api/assets-commit.integration.test.ts tests/concurrency/agent-api/appearance-index.concurrency.test.ts
```

预期：全部通过。

- [ ] **步骤 6：提交**

```bash
git add src/lib/agent-api/asset-identity.ts src/lib/agent-api/services/asset-service.ts src/app/api/agent/v1/runs/'[runId]'/assets tests/unit/agent-api/asset-identity.test.ts tests/unit/agent-api/asset-service.test.ts tests/integration/agent-api/assets-commit.integration.test.ts tests/concurrency/agent-api/appearance-index.concurrency.test.ts
git commit -m "feat(agent-api): commit deterministic assets"
```

## 任务 9：提交标准剧本和 Clip 映射

**文件：**

- 新建：`src/lib/agent-api/screenplay-validation.ts`
- 新建：`src/lib/agent-api/services/screenplay-service.ts`
- 新建：`src/app/api/agent/v1/runs/[runId]/episodes/[episodeKey]/screenplay/route.ts`
- 新建：`tests/unit/agent-api/screenplay-validation.test.ts`
- 新建：`tests/integration/agent-api/screenplay-commit.integration.test.ts`

- [ ] **步骤 1：先写失败测试**

覆盖：

- episodeKey 解析；
- ordinal/sceneNumber 连续；
- startText/endText 可按顺序定位在该集 novelText；
- `screenplay.originalText === clip.content`；
- character/location/prop 外部键都存在于 run asset map；
- dialogue/voiceover 的人物或 speakerLabel 约束；
- dryRun 不创建 Clip；
- dryRun 对新 Clip 返回稳定 projected clipId；正常无并发修订时 commit 使用同一 ID；
- commit 按 ordinal 创建 Clip，保存 JSON 字段并建立 clipKey 映射；
- 同 hash 重试返回原映射；
- 不修改运行前 Clip；
- 没有创建 Storyboard、Task 或模型调用。

- [ ] **步骤 2：实现验证和 service**

数据库字段映射：

- `summary/content/startText/endText` 直接写文本；
- `location` 写解析后的资产显示名；
- `characters/props` 写稳定 JSON 名称数组，保持现有页面兼容；
- `screenplay` 写规范 screenplay JSON；
- `createdAt` 按 ordinal 使用稳定递增值，确保现有页面排序。

不同 hash 的修订只允许更新相同 run+clipKey 映射的 run-owned Clip；新增/删除 clipKey 会返回 `RUN_DEFINITION_CONFLICT`，要求新运行，避免隐式删除已有内容。

- [ ] **步骤 3：实现 route、运行测试并提交**

```bash
npx vitest run tests/unit/agent-api/screenplay-validation.test.ts
BILLING_TEST_BOOTSTRAP=1 npx vitest run tests/integration/agent-api/screenplay-commit.integration.test.ts
git add src/lib/agent-api/screenplay-validation.ts src/lib/agent-api/services/screenplay-service.ts src/app/api/agent/v1/runs/'[runId]'/episodes/'[episodeKey]'/screenplay tests/unit/agent-api/screenplay-validation.test.ts tests/integration/agent-api/screenplay-commit.integration.test.ts
git commit -m "feat(agent-api): commit screenplay artifacts"
```

## 任务 10：提交摄影方案、分镜、Panel 和 Frame

**文件：**

- 新建：`src/lib/agent-api/storyboard-validation.ts`
- 新建：`src/lib/agent-api/services/storyboard-service.ts`
- 新建：`src/app/api/agent/v1/runs/[runId]/episodes/[episodeKey]/storyboards/route.ts`
- 新建：`tests/unit/agent-api/storyboard-validation.test.ts`
- 新建：`tests/integration/agent-api/storyboards-commit.integration.test.ts`

- [ ] **步骤 1：先写失败测试**

覆盖：

- 每个 run-owned Clip 恰好一个 Storyboard；
- storyboardKey/clipKey/panelKey/frameKey 唯一；
- panels 和 frames 连续；
- frame 0 时间为 0，其他帧不递减且不超过 durationSec；
- `single`/`group` 模式约束；
- 帧依赖只能引用同 Panel 更小 frameIndex；
- previous-panel-tail 只能引用同 Storyboard 上一个 Panel 的最后 Frame；
- orderedReferences 中 character appearance、location、prop、frame 均可解析；
- photography rule/acting direction 的 panelNumber 和 characterKey 有效；
- dryRun 无数据库写入；
- dryRun 返回稳定 projected storyboard/panel/frame IDs；commit 使用同一 external-key 派生 ID；
- commit 一次事务创建 Storyboard、Panel、PanelFrame 并保存映射；
- Panel 的兼容字段 `location/characters/props/photographyRules/actingNotes` 可被现有页面读取；
- `PanelFrame.dependencyFrameIds`、`promptJson`、`referencePolicy` 保存规范 JSON；
- 不创建图片、视频、语音或任务。

- [ ] **步骤 2：实现验证和事务 service**

字段映射至少包括：

- Storyboard：`storyboardTextJson = JSON.stringify(规范 StoryboardArtifact)`、`photographyPlan = JSON.stringify(photographyPlan)`、真实 panelCount；
- 对应 Clip 的 `shotCount` 同步为真实 Panel 数；
- Panel：
  - `sourceText -> srtSegment`；
  - `locationKey -> location` 显示名；
  - characters 写兼容 JSON 对象数组 `[{name, appearance, slot}]`，其中 appearance 来自映射形象的 changeReason；
  - `propKeys -> props` 的名称 JSON 数组；
  - 写 description、shotType、cameraMove、sceneType、duration、panelMode、groupVideoPrompt、videoPrompt；
  - `imagePrompt` 取 hero/第一 Frame 的 imagePrompt，供现有 single Panel 页面兼容；
  - `groupDurationSec` 只在 group 模式写 durationSec，`groupPlanJson` 保存该 Panel 的规范 frames；
  - `photographyRules` 写该 panelNumber 的摄影 rule JSON，`actingNotes` 写对应演技 JSON；
  - 写 `usePreviousPanelTailAsReference`；
- Frame：
  - 写 frameIndex/time/role、imagePrompt、videoPrompt；
  - 把 `dependencyFrameKeys` 解析成同 Panel 的 frameIndex 数组后，用现有 `serializePanelFrameDependencyPlan()` 格式写 `dependencyFrameIds`；首帧 previous-panel-tail 用 `FP` 标记；
  - `promptJson` 保存规范 FrameArtifact；
  - `referencePolicy` 保存规范 orderedReferences JSON；
  - 初始 generationStatus 为 null；
- 第一帧在上传前不写 Panel image。

不同 hash 修订只允许更新相同外部键拓扑；拓扑变化返回 `RUN_DEFINITION_CONFLICT`，避免删除已上传媒体。
对最多 1,000 Clip × 200 Panel 的请求先在事务外完成纯校验，再在事务内批量/分段 createMany 或受控写入，并显式设置事务 `maxWait`/`timeout`；不要在持锁事务中重复做 Prompt 文本分析。

- [ ] **步骤 3：实现 route、运行测试并提交**

```bash
npx vitest run tests/unit/agent-api/storyboard-validation.test.ts
BILLING_TEST_BOOTSTRAP=1 npx vitest run tests/integration/agent-api/storyboards-commit.integration.test.ts
git add src/lib/agent-api/storyboard-validation.ts src/lib/agent-api/services/storyboard-service.ts src/app/api/agent/v1/runs/'[runId]'/episodes/'[episodeKey]'/storyboards tests/unit/agent-api/storyboard-validation.test.ts tests/integration/agent-api/storyboards-commit.integration.test.ts
git commit -m "feat(agent-api): commit storyboard artifacts"
```

## 任务 11：实现确定性、幂等的本地图片上传

**文件：**

- 修改：`src/lib/media/service.ts`
- 修改：`src/lib/media/image-url.test.ts` 或新建：`tests/unit/media/media-sha256.test.ts`
- 新建：`src/lib/agent-api/services/upload-service.ts`
- 新建：`src/app/api/agent/v1/runs/[runId]/uploads/route.ts`
- 新建：`tests/unit/agent-api/upload-service.test.ts`
- 新建：`tests/integration/agent-api/upload.integration.test.ts`
- 新建：`tests/concurrency/agent-api/upload-receipt.concurrency.test.ts`

- [ ] **步骤 1：先写失败测试**

覆盖：

- 只接受 PNG/JPEG/WebP；
- 文件原始 bytes 的 SHA-256 必须等于 contentSha256；
- 大于配置上限返回 413；
- targetKey 必须映射到当前 run/project 的正确类型；
- panel-frame variantIndex 固定为 0；
- character-appearance 的 variantIndex 固定为 0，并精确解析到本 run 分配的实际 `imageUrls` 下标；其他值或历史候选下标返回 `REFERENCE_INVALID`；
- location/prop 的 variantIndex 必须在该 targetKey 的 run-owned `imageSlotIds` 数组范围内，并精确解析到对应 slot；不得指向运行前 LocationImage，越界返回 `REFERENCE_INVALID`；
- 确定性 storage key 包含 runId、targetType、targetKey、variantIndex 和 content hash；
- receipt 的唯一逻辑键严格为 `targetType + targetKey + variantIndex + contentSha256`；四项全相同才返回原 media/receipt，不重复候选；
- 同 target/hash 但 variantIndex 不同是两个独立回执，不得交叉复用；
- 同目标不同 hash 是新版本，只允许安全替换该 run-owned 槽位；
- 并发上传不同目标不会覆盖 receiptJson；
- 新建 CharacterAppearance 的首个 run-owned 候选成为主图；复用 Appearance 只更新本 run 候选，原 imageUrl/selectedIndex 保持不变；
- 新建 Location/Prop 的首个 run-owned slot 成为 selectedImage；复用 Location/Prop 只更新本 run slot，原 selectedImageId 保持不变；
- 同 run 重试资产提交不会多追加候选/slot，upload 也无法构造 variantIndex 覆盖运行前候选/slot；
- PanelFrame 更新 generationStatus；frameIndex 0 同步 Panel 主图，其他 Frame 不覆盖 Panel；
- receipt/response 的 contentSha256 保存客户端原始 bytes hash；MediaObject.sha256 保存 Sharp 规范化后实际存储 JPEG bytes 的 hash，并保存实际 mime、size、width、height；
- 上传不产生 Task/GraphRun/UsageCost。

- [ ] **步骤 2：让 MediaObject helper 支持 sha256**

给 `ensureMediaObjectFromStorageKey()` metadata 增加可选 `sha256`，并在 existing/upsert 路径正确回填；用已有媒体测试保证旧调用不传 sha256 时行为不变。

- [ ] **步骤 3：实现 upload service**

处理顺序：

1. 鉴权并读取 run 映射；
2. 校验 multipart 字段、MIME、size、raw content hash；
3. 按 `targetType + targetKey + variantIndex + contentSha256` 先查 receipt，并完成 slot 范围校验；
4. 用 Sharp rotate 并规范化为 JPEG，读取尺寸并计算实际存储 bytes hash；
5. 上传到确定性 key，例如 `agent-runs/{runId}/{targetType}/{targetKey}/{variantIndex}/{rawHash}.jpg`；
6. 创建/复用 MediaObject；
7. 事务锁 run，重新检查 receipt；
8. 更新目标表、receiptJson 和 `images_in_progress` 状态。

替换当前图时沿用现有撤回语义：LocationImage.previousImageUrl 和 Panel.previousImageUrl/previousImageMediaId 先保存旧值；PanelFrame 没有 previous 字段，因此旧版本只保留在 receipt/MediaObject；CharacterAppearance 保留其他候选。角色和场景/道具的“当前目标”始终先通过 run-owned 映射解析；复用资产的历史选中图绝不因本 run 上传而改变。不得删除旧存储对象。

存储上传在数据库长事务外完成；并发重复允许覆盖同一确定性 key 的相同 bytes。

- [ ] **步骤 4：实现 multipart route**

route 必须自己解析 File，不接受 sourceImageUrl 或远程 URL。Idempotency-Key 使用设计 7.2 的 canonical material。

- [ ] **步骤 5：运行测试**

```bash
npx vitest run tests/unit/agent-api/upload-service.test.ts tests/unit/media/media-sha256.test.ts
BILLING_TEST_BOOTSTRAP=1 npx vitest run tests/integration/agent-api/upload.integration.test.ts tests/concurrency/agent-api/upload-receipt.concurrency.test.ts
```

预期：全部通过。

- [ ] **步骤 6：提交**

```bash
git add src/lib/media/service.ts tests/unit/media/media-sha256.test.ts src/lib/agent-api/services/upload-service.ts src/app/api/agent/v1/runs/'[runId]'/uploads tests/unit/agent-api/upload-service.test.ts tests/integration/agent-api/upload.integration.test.ts tests/concurrency/agent-api/upload-receipt.concurrency.test.ts
git commit -m "feat(agent-api): upload generated images"
```

## 任务 12：实现 snapshot 与 finalize 完整性校验

**文件：**

- 新建：`src/lib/agent-api/services/snapshot-service.ts`
- 新建：`src/lib/agent-api/services/finalize-service.ts`
- 新建：`src/app/api/agent/v1/runs/[runId]/snapshot/route.ts`
- 新建：`src/app/api/agent/v1/runs/[runId]/finalize/route.ts`
- 新建：`tests/unit/agent-api/snapshot-service.test.ts`
- 新建：`tests/integration/agent-api/finalize.integration.test.ts`

- [ ] **步骤 1：先写失败测试**

snapshot 覆盖：

- 返回所有已提交 artifact hash 和 upload receipt；
- 缺失 story/assets/screenplay/storyboards；
- 每个 run-owned CharacterAppearance candidate 图片缺失；
- 每个 run-owned Location/Prop image slot 图片缺失；
- 复用资产已有历史图片不能替代本 run-owned 图片完成条件；
- 每个 run Clip 缺 Storyboard；
- Panel 缺 Frame、Frame 缺图；
- 外部映射损坏；
- 任何带 `meta.agentCreationRunId=runId` 的 Task 或 GraphRun 被列为 forbidden missing。

finalize 覆盖：

- ruleSetHash 和 expected hashes 必须与 run 完全一致；
- missing 非空返回 422 `RUN_INCOMPLETE` 并把状态写为 incomplete；
- 完整时一次事务写 completed/completedAt；
- 返回真实 counts；
- 同 finalize body 重试返回相同完成结果；
- completed run 再写 Artifact 被拒绝；
- 没有创建视频、配音或任何生成任务。

- [ ] **步骤 2：实现 snapshot**

missing 项使用稳定 code/targetType/targetKey；顺序固定，保证恢复时 manifest diff 可重复。

任务禁止检查只识别明确的 `agentCreationRunId` 标记；真正的“Agent 代码绝不提交任务”由任务 13 的静态守卫和集成计数双重保证。

- [ ] **步骤 3：实现 finalize**

POST Idempotency-Key 等于 canonical request body hash。完整性检查和状态更新使用同一数据库事务视图，避免检查后又发生变化。

- [ ] **步骤 4：运行测试并提交**

```bash
npx vitest run tests/unit/agent-api/snapshot-service.test.ts
BILLING_TEST_BOOTSTRAP=1 npx vitest run tests/integration/agent-api/finalize.integration.test.ts
git add src/lib/agent-api/services/snapshot-service.ts src/lib/agent-api/services/finalize-service.ts src/app/api/agent/v1/runs/'[runId]'/snapshot src/app/api/agent/v1/runs/'[runId]'/finalize tests/unit/agent-api/snapshot-service.test.ts tests/integration/agent-api/finalize.integration.test.ts
git commit -m "feat(agent-api): finalize complete creation runs"
```

## 任务 13：接入项目路由契约、需求矩阵和“零模型调用”硬守卫

**文件：**

- 修改：`tests/contracts/route-catalog.ts`
- 修改：`tests/contracts/route-behavior-matrix.ts`
- 修改：`tests/contracts/requirements-matrix.ts`
- 修改：`tests/integration/api/contract/agent-data-routes.test.ts`
- 新建：`scripts/guards/no-agent-api-generation-bypass.mjs`
- 新建：`tests/unit/guards/no-agent-api-generation-bypass.test.ts`
- 修改：`package.json`
- 新建：`tests/regression/agent-api-legacy-isolation.test.ts`

- [ ] **步骤 1：先扩展 route catalog 和需求矩阵**

新增：

- category：`agent`
- contractGroup：`agent-data-routes`
- 12 个规范路由文件；
- P0 要求 `REQ-AGENT-CREATOR-DATA-ONLY`，关联 Agent contract、integration、guard 和 regression tests。

同时在 `route-behavior-matrix.ts`：

- 把 `CONTRACT_TEST_BY_GROUP['agent-data-routes']` 映射到 `tests/integration/api/contract/agent-data-routes.test.ts`；
- 让 `resolveChainTest()` 对 `src/app/api/agent/` 返回 `tests/regression/agent-api-legacy-isolation.test.ts`，不要错误地归入现有 image chain。

否则新增 union 成员会使 TypeScript/行为路由覆盖门禁失败，或给 Agent 路由挂上无关的旧图片生成测试。

`agent-data-routes.test.ts` 必须行为验证所有方法：

- 无 Agent Token 均非 2xx；
- 有效 Agent auth 到达 service mock；
- 未知字段被拒绝；
- POST/PUT 缺 Idempotency-Key 被拒绝；
- GET 不要求 Idempotency-Key。

- [ ] **步骤 2：先写静态守卫失败测试**

守卫扫描：

- `src/app/api/agent`
- `src/lib/agent-api`

禁止 import/call 片段至少包括：

- `maybeSubmitLLMTask`
- `executeAiTextStep`
- `createTask`、`submitTask`、`submitTaskWithBilling`
- `@/lib/model-gateway`
- `@/lib/llm`
- `@/lib/providers`
- `@/lib/workers`
- `@/lib/run-runtime`
- `@/lib/config-service`
- `llmApiKey`、`falApiKey`、`googleAiKey`、`arkApiKey`、`qwenApiKey`
- 旧 AI/生图/生视频路由 URL。

允许的存储、Sharp、Prompt 读取和普通 Prisma import 不应误报。

- [ ] **步骤 3：实现守卫并加入 test:guards**

新增 script：

```json
"check:no-agent-api-generation-bypass": "node scripts/guards/no-agent-api-generation-bypass.mjs"
```

并接入 `test:guards`，不是只放一个没人调用的脚本。

- [ ] **步骤 4：写旧流程隔离回归**

验证：

- 旧 `/api/projects` 和 `/api/novel-promotion` 路由仍使用原 Session auth；
- 旧 Prompt 文件、旧任务类型和旧 worker 数量/入口不因 Agent API 改变；
- Agent 提交一次完整纯数据 fixture 前后，Task、TaskEvent、GraphRun、UsageCost 数量不增加；
- Agent run 结果可以通过现有读取 API 查询到；
- 不存在 videoUrl、audioUrl、lipSync 或视频任务。

- [ ] **步骤 5：运行门禁**

```bash
npm run check:no-agent-api-generation-bypass
npm run check:api-handler
npm run check:test-route-coverage
npm run check:test-behavior-route-coverage
npm run check:requirements-matrix
npx vitest run tests/unit/guards/no-agent-api-generation-bypass.test.ts tests/integration/api/contract/agent-data-routes.test.ts tests/regression/agent-api-legacy-isolation.test.ts
```

预期：全部通过。

- [ ] **步骤 6：提交**

```bash
git add tests/contracts/route-catalog.ts tests/contracts/route-behavior-matrix.ts tests/contracts/requirements-matrix.ts tests/integration/api/contract/agent-data-routes.test.ts scripts/guards/no-agent-api-generation-bypass.mjs tests/unit/guards/no-agent-api-generation-bypass.test.ts package.json tests/regression/agent-api-legacy-isolation.test.ts
git commit -m "test(agent-api): enforce data-only boundary"
```

## 任务 14：配置文档、完整验证和交付检查

**文件：**

- 修改：`.env.example`
- 修改：`.gitignore`
- 新建：`docs/qsuperpowers/waoo-video-creator/runbooks/agent-api-local-setup.md`

- [ ] **步骤 1：记录最小配置**

`.env.example` 增加空值示例：

```dotenv
WAOO_AGENT_API_ENABLED=false
WAOO_AGENT_TOKEN=
WAOO_AGENT_USER_ID=
WAOO_AGENT_UPLOAD_MAX_BYTES=10485760
```

不得提交真实 Token。

`.gitignore` 增加：

```gitignore
.waoo-agent/
```

runbook 说明：

- 如何定位本地 user id；
- 如何生成长随机 Token；
- 如何启用/关闭 Agent API；
- 如何请求 creator-rules 做 smoke check；
- 如何确认返回中无模型配置；
- 如何回滚 migration；
- 如何验证 Task/GraphRun 未增加。

- [ ] **步骤 2：运行聚焦测试**

```bash
npx vitest run tests/unit/agent-api tests/unit/guards/no-agent-api-generation-bypass.test.ts
BILLING_TEST_BOOTSTRAP=1 npx vitest run tests/integration/agent-api tests/concurrency/agent-api tests/integration/api/contract/agent-data-routes.test.ts tests/regression/agent-api-legacy-isolation.test.ts
```

预期：全部通过。

- [ ] **步骤 3：运行项目门禁**

```bash
npm run check:no-agent-api-generation-bypass
npm run check:api-handler
npm run check:test-route-coverage
npm run check:requirements-matrix
npm run typecheck
npm run test:guards
npm run build
```

预期：全部通过，包含 Next.js Route Handler 生产构建。如果被执行前就存在的工作树问题阻断，记录精确命令、精确错误和与本功能无关的证据；不得修改用户无关代码来“顺便修好”。

- [ ] **步骤 4：做本地 HTTP smoke test**

在本地 waoo 服务和测试账号上依次调用：

1. resolve project；
2. creator-rules；
3. create run；
4. 四类 Artifact dry-run；
5. 四类 Artifact commit；
6. 使用小型本地 fixture 图上传所有目标；
7. snapshot；
8. finalize。

检查：

- waoo 页面可见项目、故事、资产、剧本、分镜和图片；
- snapshot missing 为空；
- run completed；
- Task、GraphRun、UsageCost 不增加；
- 视频和配音字段为空。

- [ ] **步骤 5：最终提交**

```bash
git add .env.example .gitignore docs/qsuperpowers/waoo-video-creator/runbooks/agent-api-local-setup.md
git commit -m "docs(agent-api): add local setup runbook"
```

## 后端完成定义

- 12 个规范端点全部实现且只走 Agent 专用鉴权。
- Zod、JSON Schema、服务端解析和客户端可下载契约来自同一源。
- 同一 runFingerprint 恢复同一 run，不重复创建剧集或外部映射。
- 资产匹配、appearanceIndex、剧集编号和 upload receipt 在并发下确定。
- 所有 dry-run 都是零写入。
- 现有页面能直接看到 Agent 写入结果。
- Agent 路径静态和动态验证都不创建 Task/GraphRun、不读取模型密钥、不调用任何生成 provider。
- 旧 API、旧 Prompt 和旧创作流程行为保持不变。
- 后端完成后再执行 `waoo-video-creator` Skill 计划；不要提前用 Skill 调未完成的契约。
