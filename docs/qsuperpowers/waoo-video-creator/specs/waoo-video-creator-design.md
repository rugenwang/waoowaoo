# waoo 全流程视频创作 Skill 设计

**状态：** 高层方案已确认，等待书面规格确认

**日期：** 2026-07-24

**范围：** 从项目名称和单集/全集剧本开始，完成故事、资产、资产图片、分镜和分镜图片；不生成视频

## 1. 背景

waoo 当前已经具备完整的项目、剧集、资产、剧本、分镜、媒体存储和后台展示能力，也保留了后端模型生成流程。新能力不是替换现有流程，而是增加一条 Codex 客户端编排通道：

- Codex 负责全部文字理解、内容生成、创作决策和图片生成。
- waoo 提供版本化创作规则、纯数据增删改、图片上传和后台展示。
- 原有页面、原有后端模型任务和原有生成接口保持可用，行为不变。

现有后端分析入口会提交模型任务，例如：

- `src/app/api/novel-promotion/[projectId]/analyze/route.ts`
- `src/app/api/novel-promotion/[projectId]/story-to-script-stream/route.ts`
- `src/app/api/novel-promotion/[projectId]/script-to-storyboard-stream/route.ts`

这些入口不属于新 Skill 的允许调用范围。现有上传路由证明数据回填方向可行，但新 Skill 需要更稳定的批量提交、幂等和断点续跑能力。

## 2. 目标

用户只需提供：

1. 项目名称。
2. 一集剧本、故事梗概或全集剧本。

系统完成：

1. 查找项目；没有项目时自动创建。
2. 创建一集或多集，并生成集名、简介和故事正文。
3. 分析角色、形象变化、场景、关键道具、剧情片段和标准剧本。
4. 由 Codex 客户端生成全部资产图片并上传。
5. 由 Codex 客户端生成分镜规划、摄影规则、演技指导、详细分镜和关键帧定义。
6. 由 Codex 客户端生成每个关键帧图片并上传到对应记录。
7. 校验后台可见数据的完整性。
8. 在视频生成前停止。

## 3. 非目标

- 不生成视频。
- 不生成配音、口型同步或剪辑工程。
- 不删除或替换现有项目。
- 不自动覆盖来源不同的已有剧集。
- 不迁移或关闭原有后端生成流程。
- 不把 waoo 的模型配置、模型网关或任务队列作为新 Skill 的生成依赖。
- 不把完整创作规则复制并固化在 Skill 中。

## 4. 核心边界

### 4.1 职责划分

| 能力 | Codex 客户端 | waoo |
|---|---|---|
| 故事扩写与整理 | 负责 | 不生成 |
| 角色/场景/道具分析 | 负责 | 校验并保存 |
| 剧情拆分与标准剧本 | 负责 | 校验并保存 |
| 分镜、摄影、演技和关键帧设计 | 负责 | 校验并保存 |
| 资产图片和分镜图片生成 | 负责 | 上传、存储、关联 |
| 创作规则 | 读取并执行 | 唯一来源、版本管理 |
| 后台展示 | 不负责 | 复用现有页面 |
| 视频生成 | 本期不执行 | 原能力保留 |

### 4.2 禁止调用

新 Skill 不得调用以下类型的接口或模块：

- `/analyze`
- `/ai-story-expand`
- `/story-to-script-stream`
- `/script-to-storyboard-stream`
- `/generate-image`
- `/generate-character-image`
- `/regenerate-*`
- `/generate-video`
- 任何会调用 `maybeSubmitLLMTask`、`executeAiTextStep`、模型网关、媒体生成提供商或 BullMQ 生成任务的入口

Agent API 自身也不得导入或间接调用上述生成能力。

## 5. 总体架构

```text
项目名称 + 剧本
        |
        v
waoo-video-creator Skill
  ├─ 获取 waoo 规则包
  ├─ Codex 生成故事和结构化数据
  ├─ imagegen 生成全部图片
  ├─ 本地校验和运行清单
  └─ 调用 Agent Data API
        |
        v
waoo Agent Data API
  ├─ Token 鉴权和用户隔离
  ├─ Zod/业务规则校验
  ├─ 幂等事务写入
  ├─ 媒体上传与关联
  └─ 完整性快照
        |
        v
现有 MySQL / 媒体存储 / waoo 后台页面
```

## 6. 规则所有权

### 6.1 单一规则源

waoo 项目是创作规则的唯一来源。第一版直接复用现有规则文件及项目配置，包括但不限于：

- `lib/prompts/novel-promotion/agent_character_profile.zh.txt`
- `lib/prompts/novel-promotion/select_location.zh.txt`
- `lib/prompts/novel-promotion/select_prop.zh.txt`
- `lib/prompts/novel-promotion/agent_clip.zh.txt`
- `lib/prompts/novel-promotion/screenplay_conversion.zh.txt`
- `lib/prompts/novel-promotion/agent_storyboard_plan.zh.txt`
- `lib/prompts/novel-promotion/agent_cinematographer.zh.txt`
- `lib/prompts/novel-promotion/agent_acting_direction.zh.txt`
- `lib/prompts/novel-promotion/agent_storyboard_detail.zh.txt`
- `lib/prompts/novel-promotion/storyboard_prompt_refine.zh.txt`

Skill 只保存如何获取、组合和执行规则的流程，不保存这些规则的长期副本。

### 6.2 版本化规则包

新增只读接口：

```http
GET /api/agent/v1/projects/{projectId}/creator-rules?locale=zh
```

响应至少包含：

```json
{
  "schemaVersion": 1,
  "ruleSetVersion": "2026.07.24",
  "contentHash": "sha256:...",
  "locale": "zh",
  "projectSettings": {
    "artStyle": "realistic",
    "artStylePrompt": null,
    "videoRatio": "9:16",
    "imageResolution": "2K",
    "forcedStoryboardDurationSec": null
  },
  "rules": [
    {
      "id": "character-profile",
      "kind": "hard-and-creative",
      "content": "...",
      "hash": "sha256:..."
    }
  ],
  "contracts": [
    {
      "id": "waoo-agent-story.v1",
      "url": "/api/agent/v1/contracts/waoo-agent-story.v1",
      "hash": "sha256:..."
    },
    {
      "id": "waoo-agent-assets.v1",
      "url": "/api/agent/v1/contracts/waoo-agent-assets.v1",
      "hash": "sha256:..."
    },
    {
      "id": "waoo-agent-screenplay.v1",
      "url": "/api/agent/v1/contracts/waoo-agent-screenplay.v1",
      "hash": "sha256:..."
    },
    {
      "id": "waoo-agent-storyboards.v1",
      "url": "/api/agent/v1/contracts/waoo-agent-storyboards.v1",
      "hash": "sha256:..."
    }
  ]
}
```

`contentHash` 由所有规则内容、契约版本和会影响创作的项目设置共同计算。后续请求中的 `ruleSetHash` 必须等于该 `contentHash`。
契约端点返回由服务端 Zod Schema 转换得到的 JSON Schema。附录 A 中的类型和约束是规范性定义；JSON Schema、服务端校验器和 Skill 本地校验器必须由同一契约源生成，不允许分别手写。

### 6.3 硬规则与创作规则

- 硬规则：字段结构、名称引用、禁止编造、时长范围、关键帧依赖、图片上传目标和数据完整性。Codex 必须严格遵守。
- 创作规则：镜头选择、节奏、构图、光线、表演表达和提示词组织。Codex 可在不违反硬规则和原文事实的前提下优化。
- 如果 Codex 发现规则矛盾，不得静默选择。运行应停止在提交前，报告冲突和涉及的规则 ID。
- 规则优化必须修改 waoo 中的规则源；不得只修改 Skill 形成隐性分叉。

### 6.4 运行时固定规则

每次运行开始时下载规则包并保存到运行目录。运行和断点恢复始终使用该快照。若 waoo 当前规则哈希已经变化：

- 新运行使用新规则。
- 已开始的运行默认继续使用原快照。
- 用户显式要求升级规则时，创建新的运行版本，不在原运行中混用。

## 7. Agent Data API

### 7.1 鉴权

新增独立凭据：

- `WAOO_AGENT_API_ENABLED`
- `WAOO_AGENT_TOKEN`
- `WAOO_AGENT_USER_ID`

请求使用：

```http
Authorization: Bearer <WAOO_AGENT_TOKEN>
X-Waoo-User-Id: <user-id>
```

要求：

- Token 在所有环境都必须存在，开发环境不得无 Token 放行。
- Token 不写入 Skill 文件、运行清单或日志。
- 服务端必须校验 `X-Waoo-User-Id` 与允许用户一致。
- 所有项目、剧集、资产、分镜和媒体操作都必须再次校验项目所有权。
- 默认只允许配置的本地 waoo 地址；非本地地址必须显式配置。

### 7.2 API 端点

规范端点：

```text
POST /api/agent/v1/projects/resolve
GET  /api/agent/v1/projects/{projectId}/creator-rules
GET  /api/agent/v1/contracts/{contractId}
POST /api/agent/v1/projects/{projectId}/runs
GET  /api/agent/v1/runs/{runId}
PUT  /api/agent/v1/runs/{runId}/assets
PUT  /api/agent/v1/runs/{runId}/episodes/{episodeKey}/story
PUT  /api/agent/v1/runs/{runId}/episodes/{episodeKey}/screenplay
PUT  /api/agent/v1/runs/{runId}/episodes/{episodeKey}/storyboards
POST /api/agent/v1/runs/{runId}/uploads
GET  /api/agent/v1/runs/{runId}/snapshot
POST /api/agent/v1/runs/{runId}/finalize
```

所有 POST/PUT 写请求都必须携带 `Idempotency-Key` 请求头，但不同类型接口的幂等材料和正文能力不同：

| 接口类型 | `Idempotency-Key` 计算 | 规则哈希 | `artifactHash` | `dryRun` |
|---|---|---|---|---|
| `POST /projects/resolve` | `sha256("resolve-project:" + normalizedProjectName)` | 不需要 | 不需要 | 不支持 |
| `POST /projects/{projectId}/runs` | 请求中的 `runFingerprint` | 请求正文必填 | `definitionHash` 负责集清单校验 | 不支持 |
| 四个 Artifact PUT：assets/story/screenplay/storyboards | 请求中的 `artifactHash` | `CommitEnvelope` 必填 | 必填 | 支持 |
| `POST /uploads` | `sha256(canonicalJson({runId,targetType,targetKey,variantIndex,contentSha256}))` | 从运行记录固定值校验，不在 multipart 重复传递 | 文件使用 `contentSha256` | 不支持 |
| `POST /finalize` | `sha256(canonicalJson(requestBody))` | 请求正文必填 | expected 中是各 Artifact 哈希 | 不支持 |

只有四个 Artifact PUT 支持 `dryRun=true`。dry-run 只执行完整契约、引用和业务校验，不写数据库、媒体存储或运行回执。其他写接口收到未定义的 `dryRun`、`artifactHash` 或规则字段时按 `additionalProperties: false` 返回 `CONTRACT_INVALID`。

### 7.3 项目解析规则

`POST /projects/resolve` 接收项目名称：

1. 对名称做 trim，不做模糊纠错。
2. 找到一个精确同名项目时复用。
3. 没有精确同名项目时创建项目和 `NovelPromotionProject`。
4. 找到多个精确同名项目时返回冲突，禁止随机选择。
5. 不自动删除、重命名或合并项目。

### 7.4 运行和剧集幂等

`sourceHash` 只标识原始来源：

```text
sourceHash = sha256(UTF8(normalizeLineEndings(sourceText).trim()))
```

是否恢复运行由 `runFingerprint` 决定，而不是只由 `sourceHash` 决定：

```text
runFingerprint = sha256(canonicalJson({
  projectId,
  sourceHash,
  inputKindHint,
  locale,
  effectiveOptions: {
    artStyle,
    videoRatio,
    episodeSplitHint
  },
  ruleSetHash
}))
```

`canonicalJson` 要求对象键按 Unicode 码点排序、数组保持原顺序、字符串使用 UTF-8、不得包含未定义字段。客户端在计算指纹前必须完成缺省值归一化：

- `inputKindHint` 未提供时固定为 `auto`。
- `locale` 未提供时固定为 `zh`。
- `artStyle` 和 `videoRatio` 使用用户覆盖值；没有覆盖时使用规则包中的项目有效值。
- `episodeSplitHint` 未提供时固定为 `auto`。

因此仅提供项目名称和正文时也能得到唯一指纹。创建运行接口只接受归一化后的必填值，不在服务端再次猜测缺省值。

默认策略：

- 相同项目、相同 `runFingerprint`：恢复同一运行。
- 相同来源但 locale、有效覆盖项、分集提示或规则哈希不同：创建新运行。
- 不同来源：创建新运行和新剧集。
- 全集运行中的每集使用稳定 `episodeKey`，例如 `episode-001`。
- 运行创建的剧集可以在同一运行重试时更新。
- Skill 不自动选择并覆盖运行前就存在的剧集。

新增独立的轻量运行记录，保存：

- `runId`
- `userId`
- `projectId`
- `sourceHash`
- `runFingerprint`
- `inputKindHint`
- `locale`
- `effectiveOptionsJson`
- `ruleSetVersion`
- `ruleSetHash`
- `status`
- `currentStage`
- `episodeMapJson`
- `receiptJson`
- 时间字段

运行记录只保存映射、哈希和状态，不保存 Token。

### 7.5 剧集编号分配

创建新运行时，服务端在同一数据库事务中：

1. 对 `NovelPromotionProject` 对应项目行加写锁。
2. 查询该项目当前最大 `episodeNumber`；没有剧集时视为 0。
3. 按请求中 `episodes[].ordinal` 顺序，连续分配 `max + 1 ... max + N`。
4. 不填补历史删除留下的空号。
5. 将 `episodeKey -> episodeId -> episodeNumber` 映射写入运行记录。
6. 同一 `runFingerprint` 重试时直接返回原映射，不再次分配。
7. 并发唯一键冲突时回滚并在重新读取最大编号后最多重试一次；第二次失败返回 `EPISODE_NUMBER_CONFLICT`。

`episodeKey` 仅在一个运行内唯一。不同运行都可以使用 `episode-001`，因为服务端通过 `runId + episodeKey` 解析目标，不把它直接当作 `episodeNumber`。

### 7.6 外部键

Codex 提交的数据使用稳定外部键，不依赖数据库 UUID：

- `characterKey`
- `appearanceKey`
- `locationKey`
- `propKey`
- `episodeKey`
- `clipKey`
- `storyboardKey`
- `panelKey`
- `frameKey`

服务端提交成功后返回外部键到数据库 ID 的映射。图片上传使用外部键，服务端负责解析真实目标。

### 7.7 通用响应与错误

所有成功响应：

```json
{
  "success": true,
  "requestId": "req_xxx",
  "data": {}
}
```

所有失败响应：

```json
{
  "success": false,
  "requestId": "req_xxx",
  "error": {
    "code": "CONTRACT_INVALID",
    "message": "human readable message",
    "field": "storyboards[0].panels[1].frames[0].frameTimeSec",
    "retryable": false,
    "details": {}
  }
}
```

规范错误码：

| HTTP | code | 含义 |
|---|---|---|
| 400 | `CONTRACT_INVALID` | 类型、必填项或范围错误 |
| 400 | `REFERENCE_INVALID` | 外部键无法解析或类型错误 |
| 400 | `ARTIFACT_HASH_MISMATCH` | 请求内容与声明哈希不一致 |
| 401 | `AGENT_UNAUTHORIZED` | Token 无效或缺失 |
| 403 | `AGENT_FORBIDDEN` | 用户或项目不属于调用者 |
| 404 | `AGENT_RESOURCE_NOT_FOUND` | 项目、运行或目标不存在 |
| 409 | `PROJECT_NAME_AMBIGUOUS` | 存在多个精确同名项目 |
| 409 | `RUN_DEFINITION_CONFLICT` | 相同运行指纹对应不同集清单 |
| 409 | `EPISODE_NUMBER_CONFLICT` | 剧集编号并发分配失败 |
| 409 | `ASSET_IDENTITY_CONFLICT` | 同名/别名资产身份字段冲突 |
| 409 | `RULESET_MISMATCH` | 提交规则版本与运行固定版本不同 |
| 413 | `UPLOAD_TOO_LARGE` | 图片超过配置上限 |
| 415 | `UPLOAD_TYPE_UNSUPPORTED` | 文件不是允许的图片类型 |
| 422 | `RUN_INCOMPLETE` | 完成校验发现缺失项 |
| 500 | `AGENT_INTERNAL_ERROR` | 未分类服务端错误 |

所有 4xx 默认 `retryable=false`；`EPISODE_NUMBER_CONFLICT` 第二次失败、存储暂时不可用和明确的网络错误可以返回 `retryable=true`。

## 8. 数据提交契约

### 8.1 故事

每集故事至少包含：

```json
{
  "episodeKey": "episode-001",
  "name": "第一集名称",
  "description": "集简介",
  "inputKind": "outline|story|screenplay",
  "novelText": "最终故事页面正文",
  "sourceHash": "sha256:..."
}
```

`episodeNumber` 由服务端在创建运行时分配，是响应字段，不允许客户端指定。

输入处理规则：

- 梗概或简短创意：Codex 扩写。
- 完整故事：Codex 整理可读性，不改变事实和剧情结果。
- 标准剧本：保留内容，可生成适合故事页面展示的正文，但不得新增剧情。
- 全集：优先使用明确的集标题或分集标记；没有标记时由 Codex 按剧情闭环拆集。

### 8.2 资产

资产提交包括：

- 角色基础资料和别名。
- 角色关系与称呼映射。
- 角色形象列表及变化原因。
- 角色视觉描述。
- 场景名称、简介、描述和可用站位。
- 道具名称、简介和纯视觉描述。

规则：

- 资产名称匹配使用确定性规范化：Unicode NFC、trim、连续空白折叠为一个空格、ASCII 字母转小写；不做拼音、同义词或模糊匹配。
- 对每个请求角色构建身份集合：规范化后的请求主名称和所有非空请求别名。对每个已有角色构建身份集合：规范化后的已有主名称和从 `aliases` JSON 数组解析出的所有非空已有别名。两个集合有任一交集即视为命中；不区分“主名命中别名”或“别名命中主名”。
- 已有 `aliases` 为 null、非法 JSON 或非字符串数组时按空数组处理并记录警告，不进行模糊修复。
- 场景和道具只按规范化主名称匹配。
- 没有命中时创建新资产；唯一命中时复用；多个命中时返回 `ASSET_IDENTITY_CONFLICT`。
- 场景与道具即使同名也属于不同 `assetKind`；请求类型与已有类型不一致时返回冲突。
- gender 的规范值只允许 `male`、`female`、`nonbinary`、`unknown`。客户端在提交前把 `男/male/m/男性` 归一为 `male`，把 `女/female/f/女性` 归一为 `female`，把 `非二元/nonbinary/non-binary` 归一为 `nonbinary`，缺失或其他值归一为 `unknown`。
- 服务端读取已有 `profileData.gender` 时使用同一算法；`profileData` 缺失、非法 JSON、gender 缺失或无法识别时视为 `unknown` 并记录警告。只有请求和已有 gender 都不是 `unknown` 且二者不同才返回身份冲突。
- 年龄变化通过 Appearance 表达，不以 `ageRange` 差异判定角色冲突。
- 唯一命中且没有身份冲突时，以已有资产为准，不覆盖已有名称、视觉描述、已选图片或 profileData。只允许幂等追加尚不存在的别名、Appearance 和空图片槽位。
- Appearance 按 `runId + appearanceKey` 映射；复用已有角色时，只有 `changeReason` 规范化后与已有 Appearance 精确相等才可复用，否则创建新的 Appearance。
- 请求中的 `appearanceOrdinal` 只定义本次角色形象的顺序，不直接写数据库 `appearanceIndex`。新建角色时按 ordinal 分配 0..N-1；复用角色并新增形象时，在角色行锁保护的事务中从该角色现有最大 `appearanceIndex + 1` 连续分配。同一运行重试使用原外部键映射，不再次分配。
- 场景描述、站位和道具描述不同不触发身份冲突，也不覆盖已有内容；它们作为本次运行的创作上下文保存在本地清单。只有新建资产才写入这些字段。
- 不删除任何现有资产或图片。
- 角色形象、场景图片槽位和道具图片槽位在落库时创建。
- 资产提交不触发任何图片生成任务。

### 8.3 剧本

每集包含按顺序排列的 Clip：

- 原文开始和结束锚点。
- 摘要。
- 唯一场景引用。
- 角色和道具引用。
- 原文内容。
- 标准剧本 JSON。

标准剧本必须保持原文事实、对白和时间顺序，不得添加原文不存在的动作、对白、旁白、人物情绪或特效。

### 8.4 分镜

每个 Clip 对应一个 Storyboard。Storyboard 包含：

- 摄影方案。
- 按顺序排列的 Panel。
- 每个 Panel 的画面描述、景别、运镜、角色、场景、道具、时长和动态提示词。
- 每个 Panel 的关键帧数组。
- 每帧的时间、作用、依赖、静态图片提示词、动态提示词和引用策略。

提交前必须满足：

- `panelNumber` 和 `frameIndex` 连续。
- 第一帧时间为 0。
- 依赖只能指向更早的帧。
- 场景、角色、形象和道具引用必须能解析到现有资产。
- 关键帧时间不超过 Panel 时长。
- `single` 只有一个 hero 帧。
- `group` 至少两个帧。
- 不创建视频或音频任务。

## 9. Skill 工作流

Skill 名称：`waoo-video-creator`

默认安装目录：

```text
~/.codex/skills/waoo-video-creator/
├── SKILL.md
├── agents/openai.yaml
├── scripts/
│   ├── waoo-client.mjs
│   └── validate-manifest.mjs
└── references/
    ├── api-contracts.md
    ├── pipeline.md
    ├── artifact-schemas.md
    └── recovery.md
```

### 9.1 输入

必填：

- `projectName`
- `sourceText`

可选：

- `inputKindHint`
- `locale`
- `artStyleOverride`
- `videoRatioOverride`
- `episodeSplitHint`

可选项不提供时使用项目规则和 Codex 判断，不要求用户补充模型配置。

### 9.2 本地运行目录

每次运行创建：

```text
waoowaoo/.waoo-agent/runs/{runId}/
├── source.md
├── rules.json
├── story.json
├── assets.json
├── screenplay.json
├── storyboards.json
├── manifest.json
├── receipts.json
└── images/
    ├── assets/
    └── storyboards/
```

该目录加入 `.gitignore`。生成图片必须从 Codex 默认图片目录复制到此工作区目录后再上传。

### 9.3 阶段

#### 阶段 0：预检

1. 校验 waoo 地址和 Token。
2. 解析或创建项目。
3. 获取并固定规则包。
4. 将未提供的 `inputKindHint`、`locale` 和有效选项归一化为 7.4 规定的默认值。
5. 计算 `sourceHash` 和包含所有有效选项的 `runFingerprint`。
6. 只做运行定义所需的前置分析：判断单集/全集、拆分全集、生成稳定 `episodeKey`、集名和简介。此时不生成或提交 `novelText`。
7. 计算 `definitionHash`，创建或恢复运行，由服务端一次性分配剧集编号。

#### 阶段 1：故事和剧集

1. 读取阶段 0 已固定的分集边界、集名和简介，禁止在同一运行中重新拆集或改名。
2. 对每集内容判断最终 `inputKind`。
3. 梗概扩写、完整故事整理或标准剧本转故事页面正文，生成 `novelText`。
4. 本地验证。
5. `dryRun` 验证后提交。

如果阶段 1 发现阶段 0 的边界、集名或简介必须改变，则当前运行保持 `incomplete` 并报告 `RUN_DEFINITION_CONFLICT`。客户端必须使用明确修订后的 `episodeSplitHint` 创建新运行，使 `runFingerprint` 发生变化；不得修改已创建运行的集清单。

#### 阶段 2：资产和标准剧本

1. 分析角色、关系、别名和形象变化。
2. 分析需要制作的场景及其空间锚点。
3. 仅提取需要跨场景保持一致的关键道具。
4. 拆分 Clip。
5. 生成标准剧本。
6. 验证名称引用和原文忠实性。
7. 提交资产和剧本。

#### 阶段 3：资产图片

生成顺序：

1. 项目视觉基准。
2. 主角色基础形象。
3. 角色子形象。
4. 场景图。
5. 道具图。

每张图：

1. 使用 waoo 规则、项目风格和资产描述构造图片生成输入。
2. 需要一致性时使用之前生成的本地图片作为参考。
3. 通过客户端 `imagegen` 单独生成。
4. 检查主体、身份、服装、场景、构图、比例和禁止项。
5. 保存到运行目录。
6. 计算文件哈希。
7. 使用 Agent 上传接口上传并记录回执。

后续资产图不得调用 waoo 的图片模型。

#### 阶段 4：分镜设计

按现有规则顺序完成：

1. 分镜规划。
2. 摄影规则。
3. 演技指导。
4. 详细分镜。
5. 关键帧和引用策略。
6. 静态生图提示词。
7. 为未来视频阶段保留动态脚本，但不执行视频生成。

每个 Clip 独立生成和校验，全部通过后事务提交。

#### 阶段 5：分镜图片

生成顺序：

1. 按 Storyboard 顺序。
2. 按 Panel 顺序。
3. 按关键帧依赖拓扑顺序。

每帧参考输入：

- 当前场景选中图。
- 当前角色对应形象图。
- 当前可见道具图。
- 本 Panel 中声明依赖的前序关键帧。
- 规则允许时的上一 Panel 尾帧。

每帧由客户端 `imagegen` 生成。上传第一帧时同步 Panel 主图；其余帧只更新对应 PanelFrame。

#### 阶段 6：完成校验

检查：

- 所有集都有故事正文。
- 所有引用资产存在。
- 所有要求出图的资产已上传。
- 所有 Clip 有 Storyboard。
- 所有 Panel 有关键帧。
- 所有关键帧有图片。
- 数据库不存在由本运行创建的视频、配音或生成任务。

全部通过才把运行标记为 `completed`。

## 10. 图片生成一致性

### 10.1 项目视觉基准

Skill 在生图前根据项目规则生成结构化视觉基准，至少固定：

- 画风和媒介。
- 色彩、对比度和光线倾向。
- 人物写实或风格化程度。
- 镜头画幅。
- 时代和地域视觉约束。
- 禁止元素。

视觉基准是运行数据，不替代 waoo 规则。

### 10.2 人物一致性

- 先生成并确认基础形象，再生成子形象。
- 子形象使用基础形象作为参考，只改变规则中声明的持续性变化。
- 分镜必须引用具体 `appearanceKey`，禁止只引用角色名后临时猜测造型。
- 同一集内同一形象始终使用同一资产参考图。

### 10.3 场景和空间一致性

- 场景资产图包含稳定空间锚点。
- 分镜角色站位必须使用场景规则中有效站位或明确的相对位置。
- 相邻分镜没有移动行为时保持左右、前后景和朝向。
- 关键帧依赖用于锁定已经发生的空间和道具状态。

## 11. 错误处理和恢复

| 错误 | 处理 |
|---|---|
| waoo 不可访问 | 预检失败，不生成、不写入 |
| Token 无效 | 立即停止，不降级到 Session 或无鉴权 |
| 规则包缺失或哈希无效 | 停止运行 |
| 规则冲突 | 提交前报告，不静默选择 |
| JSON/业务契约失败 | Codex 根据字段错误本地修正后重新 dry-run |
| 图片生成失败 | 对同一目标进行一次针对性重试；仍失败则标记阻塞 |
| 图片质量不合格 | 保留失败版本但不上传，调整单一问题后重新生成 |
| 上传超时 | 使用目标外部键和文件哈希幂等重试 |
| 客户端中断 | 从 manifest 和服务端 snapshot 恢复缺失步骤 |
| 依赖资产图片缺失 | 阻止相关分镜图片生成，不使用无参考替代 |
| 完成校验失败 | 运行保持 `incomplete`，列出具体缺失项 |

任何失败都不得触发 waoo 后端模型作为降级方案。

## 12. 媒体上传幂等

Agent 上传接口接收：

- `runId`
- `targetType`
- `targetKey`
- `contentSha256`
- `file`

服务端行为：

1. 校验目标属于运行项目。
2. 查询 `receiptJson` 中相同目标和文件哈希。
3. 已成功上传则返回原回执。
4. 未上传则复用现有媒体存储服务处理图片。
5. 更新数据库目标和运行回执。

上传接口不调用图片生成器，不接受远程模型任务 ID。

## 13. 兼容性

- 新接口全部位于 `/api/agent/v1`，不改变现有路由契约。
- 新运行记录独立于现有 Task 和 GraphRun。
- 生成结果写入现有 Project、Episode、Character、Location、Clip、Storyboard、Panel、PanelFrame 和 MediaObject 数据结构，现有页面直接可见。
- 若需要抽取已有上传或持久化逻辑，只抽取无行为变化的服务层，并用原路由回归测试保护。
- Agent API 不要求项目配置 `analysisModel`、`characterModel`、`locationModel` 或 `storyboardModel`。
- 旧流程仍可以对普通项目继续使用原模型配置。

## 14. 测试

### 14.1 单元测试

- 规则包清单、版本和哈希稳定性。
- Token 鉴权和用户隔离。
- 项目精确匹配和多同名冲突。
- 源哈希、运行指纹和选项变化后的恢复行为。
- 所有提交契约。
- 外部键到数据库 ID 映射。
- Panel、Frame 顺序和依赖校验。
- 上传目标和文件哈希幂等。

### 14.2 集成测试

- 无项目时创建项目。
- 有同名项目时复用。
- 单集完整提交。
- 全集多集提交。
- 中断后恢复且不重复创建。
- 已有资产复用和冲突返回。
- 资产、剧本、分镜事务回滚。
- 图片上传后现有读取接口可返回稳定媒体 URL。
- `finalize` 能准确报告缺失项。

### 14.3 边界测试

在 Agent API 测试中对以下行为建立守卫：

- 不创建 Task、TaskEvent 或 GraphRun。
- 不调用 `maybeSubmitLLMTask`。
- 不调用 `executeAiTextStep`。
- 不调用任何图片、视频或音频 Provider。
- 不读取用户模型 API Key。
- 不提交视频任务。

### 14.4 回归测试

- 现有项目、剧集、资产和分镜 API 契约继续通过。
- 现有前端创作流程继续通过。
- 现有上传路由行为不变。
- 新增 Agent API 后，现有 API 生成守卫不被绕过。

## 15. 验收标准

1. 仅提供项目名称和一集剧本，可以在后台看到新建或复用的项目、剧集、故事、资产、资产图、分镜和全部关键帧图。
2. 仅提供项目名称和全集剧本，可以创建多集并逐集完成相同流程。
3. waoo 日志和数据库能证明运行期间没有创建任何后端 AI 生成任务。
4. 运行中断后可以恢复，已完成数据和图片不重复。
5. 相同源输入重复执行不会创建重复剧集、资产、分镜或媒体。
6. 不同源输入默认在同一项目中新建剧集，不覆盖旧剧集。
7. 每次运行可以追溯使用的规则版本和哈希。
8. 视频、配音和口型同步数据保持未生成状态。
9. 原有 waoo 创作功能和接口行为不受影响。

## 16. 分阶段交付

### 交付 A：纯数据网关

- 鉴权。
- 规则包。
- 项目解析。
- 运行记录。
- 故事、资产、剧本和分镜 dry-run/提交。
- 快照和完成校验。

### 交付 B：Skill 文本流程

- Skill 骨架。
- 规则读取和固定。
- 单集/全集故事。
- 资产、剧本和分镜生成。
- 本地清单、校验和恢复。

### 交付 C：图片流程

- 资产图生成和检查。
- 分镜关键帧依赖生成。
- 幂等上传。
- 完整性检查。

### 交付 D：端到端验收

- 单集样例。
- 全集样例。
- 中断恢复。
- 旧流程回归。
- 明确停止在视频生成前。

## 17. 设计决策摘要

- waoo 是规则、数据、媒体和展示中心。
- Codex 是唯一的文本和图片生成执行者。
- Skill 不复制长期规则，而是每次获取版本化规则包。
- Agent API 是纯数据通道，禁止任何模型和任务队列依赖。
- 使用外部键、源哈希、规则哈希和文件哈希实现幂等与恢复。
- 默认不覆盖既有剧集。
- 本期以完整、可恢复的“分镜图片已上传”为终点。

## 附录 A：规范请求与响应契约

本附录是 Agent API v1 的规范性接口定义。实现时使用 Zod 表达这些类型，并从 Zod 生成 JSON Schema。除明确标记为开放 JSON 的字段外，所有对象都使用 `additionalProperties: false`。

### A.1 通用标量和包装

```ts
type ExternalKey = string
// ^[a-z0-9][a-z0-9._-]{0,63}$

type Sha256 = string
// ^sha256:[a-f0-9]{64}$

type Locale = 'zh' | 'en'
type InputKind = 'outline' | 'story' | 'screenplay'
type InputKindHint = 'auto' | InputKind
type RunStatus =
  | 'created'
  | 'story_committed'
  | 'assets_committed'
  | 'screenplay_committed'
  | 'storyboards_committed'
  | 'images_in_progress'
  | 'incomplete'
  | 'completed'
  | 'failed'

type CommitEnvelope<T> = {
  schemaVersion: 1
  ruleSetVersion: string       // 1..64 chars
  ruleSetHash: Sha256
  artifactHash: Sha256         // canonicalJson(data) 的哈希
  dryRun: boolean
  data: T
}

type Success<T> = {
  success: true
  requestId: string
  data: T
}

type Failure = {
  success: false
  requestId: string
  error: {
    code: string
    message: string
    field?: string
    retryable: boolean
    details?: Record<string, string | number | boolean | null>
  }
}
```

每个 POST/PUT 请求除鉴权头外都必须包含：

```ts
type WriteHeaders = {
  'Idempotency-Key': Sha256
}
```

各端点的 `Idempotency-Key` 材料严格使用 7.2 的矩阵；该请求头不重复出现在 JSON 或 multipart 正文中。

所有用户可见文本 trim 后必须非空。名称最大 100 字符，简介最大 2,000 字符，普通描述和提示词最大 20,000 字符，故事正文和 Clip 内容最大 500,000 字符。数组上限由契约固定：单次运行最多 200 集、500 个项目资产、每集 1,000 个 Clip、每个 Clip 200 个 Panel、每个 Panel 20 个 Frame。

### A.2 项目解析

```ts
type ResolveProjectRequest = {
  name: string
  description?: string
}

type ResolveProjectResponse = Success<{
  projectId: string
  name: string
  created: boolean
}>
```

`POST /api/agent/v1/projects/resolve` 只接受上述请求。它不接受 userId、模型配置或数据库 ID 覆盖。

### A.3 规则和契约

```ts
type CreatorRulesResponse = Success<{
  schemaVersion: 1
  ruleSetVersion: string
  contentHash: Sha256
  locale: Locale
  projectSettings: {
    artStyle: string
    artStylePrompt: string | null
    videoRatio: string
    imageResolution: string
    forcedStoryboardDurationSec: number | null
  }
  rules: Array<{
    id: ExternalKey
    kind: 'hard' | 'creative' | 'hard-and-creative'
    content: string
    hash: Sha256
  }>
  contracts: Array<{
    id: ExternalKey
    url: string
    hash: Sha256
  }>
}>

type ContractResponse = Success<{
  id: ExternalKey
  hash: Sha256
  jsonSchema: Record<string, unknown>
}>
```

`GET /creator-rules` 的 `contentHash` 必须等于返回内容的服务端规范哈希。`GET /contracts/{contractId}` 只允许读取当前规则包列出的契约 ID。

### A.4 创建或恢复运行

```ts
type EffectiveOptions = {
  artStyle: string
  videoRatio: string
  episodeSplitHint: string       // 默认固定为 "auto"，最大 2,000 字符
}

type RunEpisodeDefinition = {
  episodeKey: ExternalKey
  ordinal: number                // 从 1 开始连续
  sourceHash: Sha256
  name: string
  description?: string
}

type CreateRunRequest = {
  schemaVersion: 1
  sourceHash: Sha256
  runFingerprint: Sha256
  inputKindHint: InputKindHint
  locale: Locale
  effectiveOptions: EffectiveOptions
  ruleSetVersion: string
  ruleSetHash: Sha256
  definitionHash: Sha256         // canonicalJson(episodes) 的哈希
  episodes: RunEpisodeDefinition[]
}

type CreateRunResponse = Success<{
  runId: string
  resumed: boolean
  status: RunStatus
  projectId: string
  sourceHash: Sha256
  runFingerprint: Sha256
  episodes: Array<{
    episodeKey: ExternalKey
    episodeId: string
    episodeNumber: number
    name: string
  }>
}>
```

虽然用户输入时 `inputKindHint` 和 `locale` 可省略，进入此请求前必须分别归一化为 `auto` 和 `zh`，因此在 `CreateRunRequest` 中是必填字段。服务端重新计算 `runFingerprint` 和 `definitionHash`。客户端声明值不一致时返回 `ARTIFACT_HASH_MISMATCH`。同一指纹已有运行但 `definitionHash` 不同时返回 `RUN_DEFINITION_CONFLICT`。

### A.5 故事提交

```ts
type StoryArtifact = {
  episodeKey: ExternalKey
  sourceHash: Sha256
  inputKind: InputKind
  name: string
  description?: string
  novelText: string
}

type StoryCommitRequest = CommitEnvelope<StoryArtifact>

type StoryCommitResponse = Success<{
  dryRun: boolean
  episodeKey: ExternalKey
  episodeId: string
  episodeNumber: number
  artifactHash: Sha256
}>
```

`episodeKey` 必须存在于运行定义；name 必须与运行定义一致，修改分集清单需要新运行。

### A.6 资产提交

```ts
type RoleLevel = 'S' | 'A' | 'B' | 'C' | 'D'
type Gender = 'male' | 'female' | 'nonbinary' | 'unknown'

type CharacterAppearanceArtifact = {
  appearanceKey: ExternalKey
  appearanceOrdinal: number      // 本次请求内从 1 开始连续，不是数据库索引
  changeReason: string
  visualDescription: string
}

type CharacterArtifact = {
  characterKey: ExternalKey
  name: string
  aliases: string[]
  introduction: string
  gender: Gender
  ageRange?: string
  roleLevel: RoleLevel
  archetype?: string
  personalityTags: string[]      // 0..5
  eraPeriod?: string
  socialClass?: string
  occupation?: string
  costumeTier?: number           // 1..5
  suggestedColors: string[]      // 0..3
  primaryIdentifier?: string
  visualKeywords: string[]       // 0..10
  appearances: CharacterAppearanceArtifact[]
}

type LocationArtifact = {
  locationKey: ExternalKey
  name: string
  summary: string
  availableSlots: string[]       // 0..20
  descriptions: string[]         // 1..10；每项对应一个图片槽位
}

type PropArtifact = {
  propKey: ExternalKey
  name: string
  summary: string
  visualDescription: string
}

type AssetsArtifact = {
  characters: CharacterArtifact[]
  locations: LocationArtifact[]
  props: PropArtifact[]
}

type AssetsCommitRequest = CommitEnvelope<AssetsArtifact>

type AssetsCommitResponse = Success<{
  dryRun: boolean
  artifactHash: Sha256
  characters: Array<{
    characterKey: ExternalKey
    characterId: string
    reused: boolean
    appearances: Array<{
      appearanceKey: ExternalKey
      appearanceId: string
      appearanceIndex: number    // 服务端解析后的真实数据库索引
      reused: boolean
    }>
  }>
  locations: Array<{
    locationKey: ExternalKey
    locationId: string
    reused: boolean
    imageSlotIds: string[]
  }>
  props: Array<{
    propKey: ExternalKey
    propId: string
    reused: boolean
    imageSlotIds: string[]
  }>
  warnings: Array<{
    code: 'EXISTING_ASSET_PRESERVED'
    targetKey: ExternalKey
    field: string
  }>
}>
```

角色的 `appearanceOrdinal` 必须从 1 连续递增；场景 descriptions 顺序和所有外部键在同一请求中必须唯一。实际 `appearanceIndex` 只出现在响应中。

### A.7 标准剧本提交

```ts
type ScreenplayAction = {
  type: 'action'
  text: string
}

type ScreenplayDialogue = {
  type: 'dialogue'
  characterKey: ExternalKey
  parenthetical?: string
  lines: string
}

type ScreenplayVoiceover = {
  type: 'voiceover'
  characterKey?: ExternalKey
  speakerLabel?: string          // characterKey 缺失时必填，例如“旁白”
  text: string
}

type ScreenplayScene = {
  sceneNumber: number            // 从 1 开始连续
  heading: {
    intExt: 'INT' | 'EXT'
    locationKey: ExternalKey
    time: string
  }
  description: string
  characterKeys: ExternalKey[]
  content: Array<ScreenplayAction | ScreenplayDialogue | ScreenplayVoiceover>
}

type ClipArtifact = {
  clipKey: ExternalKey
  ordinal: number                // 从 1 开始连续
  startText: string
  endText: string
  summary: string
  locationKey: ExternalKey | null
  characterKeys: ExternalKey[]
  propKeys: ExternalKey[]
  content: string
  screenplay: {
    originalText: string
    scenes: ScreenplayScene[]
  }
}

type ScreenplayArtifact = {
  episodeKey: ExternalKey
  clips: ClipArtifact[]
}

type ScreenplayCommitRequest = CommitEnvelope<ScreenplayArtifact>

type ScreenplayCommitResponse = Success<{
  dryRun: boolean
  episodeKey: ExternalKey
  artifactHash: Sha256
  clips: Array<{
    clipKey: ExternalKey
    clipId: string
    ordinal: number
  }>
}>
```

`startText` 和 `endText` 必须能按顺序定位到该集 `novelText`；`screenplay.originalText` 必须等于 Clip content。所有资产外部键必须在运行资产映射中存在。

### A.8 分镜提交

```ts
type PanelCharacterRef = {
  characterKey: ExternalKey
  appearanceKey: ExternalKey
  slot: string
}

type PhotographyRuleArtifact = {
  panelNumber: number
  composition: string
  lighting: string
  colorPalette: string
  atmosphere: string
  technicalNotes: string
  depthOfField?: string
  colorTone?: string
  characters: Array<{
    characterKey: ExternalKey
    blocking: string
  }>
}

type ActingDirectionArtifact = {
  panelNumber: number
  characters: Array<{
    characterKey: ExternalKey
    acting: string
  }>
}

type OrderedReference =
  | { kind: 'frame'; targetKey: ExternalKey }
  | { kind: 'previous-panel-tail'; targetKey: ExternalKey }
  | { kind: 'location'; targetKey: ExternalKey }
  | { kind: 'character-appearance'; targetKey: ExternalKey }
  | { kind: 'prop'; targetKey: ExternalKey }

type FrameArtifact = {
  frameKey: ExternalKey
  frameIndex: number             // 从 0 开始连续
  frameTimeSec: number           // 整数，第一帧为 0
  frameRole: 'hero' | 'transition' | 'action' | 'reaction' | 'detail'
  dependencyFrameKeys: ExternalKey[]
  imagePrompt: string
  videoPrompt: string
  referencePolicy: {
    orderedReferences: OrderedReference[]
  }
}

type PanelArtifact = {
  panelKey: ExternalKey
  panelNumber: number            // 从 1 开始连续
  description: string
  characters: PanelCharacterRef[]
  propKeys: ExternalKey[]
  locationKey: ExternalKey | null
  sceneType: string
  sourceText: string
  shotType: string
  cameraMove: string
  videoPrompt: string
  durationSec: number            // 1..20 的整数
  panelMode: 'single' | 'group'
  groupVideoPrompt: string | null
  usePreviousPanelTailAsReference: boolean
  frames: FrameArtifact[]
}

type StoryboardArtifact = {
  storyboardKey: ExternalKey
  clipKey: ExternalKey
  photographyPlan: {
    visualStrategy: string
    continuityRules: string[]
    rules: PhotographyRuleArtifact[]
  }
  actingDirections: ActingDirectionArtifact[]
  panels: PanelArtifact[]
}

type StoryboardsArtifact = {
  episodeKey: ExternalKey
  storyboards: StoryboardArtifact[]
}

type StoryboardsCommitRequest = CommitEnvelope<StoryboardsArtifact>

type StoryboardsCommitResponse = Success<{
  dryRun: boolean
  episodeKey: ExternalKey
  artifactHash: Sha256
  storyboards: Array<{
    storyboardKey: ExternalKey
    storyboardId: string
    clipKey: ExternalKey
    panels: Array<{
      panelKey: ExternalKey
      panelId: string
      frames: Array<{
        frameKey: ExternalKey
        frameId: string
      }>
    }>
  }>
}>
```

`single` 必须有且只有一个 `hero` Frame，`groupVideoPrompt` 必须为 null。`group` 必须有 2..20 个 Frame，`groupVideoPrompt` 必须非空。`dependencyFrameKeys` 只能引用同一 Panel 内更小 `frameIndex` 的 Frame。`previous-panel-tail` 只能引用当前 Storyboard 中前一个 Panel 的最后一帧。

### A.9 图片上传

`POST /api/agent/v1/runs/{runId}/uploads` 使用 `multipart/form-data`：

```ts
type UploadFields = {
  targetType:
    | 'character-appearance'
    | 'location-image'
    | 'prop-image'
    | 'panel-frame'
  targetKey: ExternalKey
  variantIndex: number           // 从 0 开始
  contentSha256: Sha256
  file: File                     // image/png | image/jpeg | image/webp
}

type UploadResponse = Success<{
  runId: string
  targetType: UploadFields['targetType']
  targetKey: ExternalKey
  variantIndex: number
  contentSha256: Sha256
  mediaId: string
  storageKey: string
  url: string
  reused: boolean
  panelImageUpdated?: boolean
}>
```

`character-appearance` 的 targetKey 是 `appearanceKey`；`location-image` 是 `locationKey`；`prop-image` 是 `propKey`；`panel-frame` 是 `frameKey`。`variantIndex` 对场景和道具选择图片槽位，对角色表示候选图序号；PanelFrame 固定为 0。

### A.10 运行读取、快照和完成

```ts
type RunResponse = Success<{
  runId: string
  projectId: string
  status: RunStatus
  currentStage: string
  sourceHash: Sha256
  runFingerprint: Sha256
  ruleSetVersion: string
  ruleSetHash: Sha256
  episodes: Array<{
    episodeKey: ExternalKey
    episodeId: string
    episodeNumber: number
    status: RunStatus
  }>
}>

type SnapshotResponse = Success<{
  runId: string
  status: RunStatus
  committedArtifactHashes: {
    assets?: Sha256
    stories: Record<ExternalKey, Sha256>
    screenplays: Record<ExternalKey, Sha256>
    storyboards: Record<ExternalKey, Sha256>
  }
  uploads: Array<{
    targetType: 'character-appearance' | 'location-image' | 'prop-image' | 'panel-frame'
    targetKey: ExternalKey
    variantIndex: number
    contentSha256: Sha256
    mediaId: string
    url: string
  }>
  missing: Array<{
    code: string
    targetType: string
    targetKey: ExternalKey
    message: string
  }>
}>

type FinalizeRequest = {
  schemaVersion: 1
  ruleSetHash: Sha256
  expected: {
    assets: Sha256
    stories: Record<ExternalKey, Sha256>
    screenplays: Record<ExternalKey, Sha256>
    storyboards: Record<ExternalKey, Sha256>
  }
}

type FinalizeResponse = Success<{
  runId: string
  status: 'completed'
  completedAt: string
  counts: {
    episodes: number
    characters: number
    locations: number
    props: number
    clips: number
    storyboards: number
    panels: number
    frames: number
    uploadedImages: number
  }
}>
```

存在任何 `missing` 项时，`finalize` 返回 HTTP 422 `RUN_INCOMPLETE`，运行状态更新为 `incomplete`，不得返回部分成功。
