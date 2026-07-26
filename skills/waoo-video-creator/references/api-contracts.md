# Agent Data API 操作契约

本文件是调用导航，不是创作 Prompt 或 Schema 副本。运行时下载、校验并固定的 `rules.json` 与 contract JSON Schema 是唯一规则源和权威；出现差异时停止并以运行时文件为准。

## 环境与鉴权

```text
WAOO_BASE_URL=http://127.0.0.1:3000
WAOO_AGENT_TOKEN=...
WAOO_AGENT_USER_ID=...
WAOO_ALLOW_REMOTE_AGENT_API=false
WAOO_PROJECT_ROOT=/absolute/path/to/waoowaoo
```

只默认允许本地地址；远端必须显式允许且为 HTTPS。每个请求带 `Authorization: Bearer <token>` 和 `X-Waoo-User-Id: <user-id>`；Token 不写入日志、manifest 或回执。**不需要也不得读取 WAOO 的模型配置或模型 Key。**

## 端点与客户端命令

只使用下列 Agent API；`doctor` 复用只读项目解析 contract 检查连接、鉴权和版本。

| 命令 | 方法与端点 | 用途 |
|---|---|---|
| `resolve-project` | `POST /api/agent/v1/projects/resolve` | 精确同名复用或创建；歧义停止 |
| `fetch-rules` | `GET /api/agent/v1/projects/{projectId}/creator-rules` | 下载完整规则包 |
| `fetch-rules` | `GET /api/agent/v1/contracts/{contractId}` | 下载规则包列出的 contract |
| `create-run` | `POST /api/agent/v1/projects/{projectId}/runs` | 创建或按 fingerprint 恢复运行 |
| `get-run` | `GET /api/agent/v1/runs/{runId}` | 读取服务端运行状态 |
| `commit-assets` | `PUT /api/agent/v1/runs/{runId}/assets` | 提交资产 Artifact |
| `commit-story` | `PUT /api/agent/v1/runs/{runId}/episodes/{episodeKey}/story` | 提交单集故事 |
| `commit-screenplay` | `PUT /api/agent/v1/runs/{runId}/episodes/{episodeKey}/screenplay` | 提交单集剧本 |
| `commit-storyboards` | `PUT /api/agent/v1/runs/{runId}/episodes/{episodeKey}/storyboards` | 提交单集分镜 |
| `upload` | `POST /api/agent/v1/runs/{runId}/uploads` | 上传本地图片 |
| `snapshot` | `GET /api/agent/v1/runs/{runId}/snapshot` | 读取完整性快照 |
| `finalize` | `POST /api/agent/v1/runs/{runId}/finalize` | 校验并完成运行 |

`find-local-run` 仅扫描本地；不发送请求。规范 shape 必须从上述 contract 下载，本文不手抄 Schema。

## 信封、幂等与 dry-run

成功 envelope 为 `success: true, requestId, data`；failure envelope 为 `success: false, requestId, error:{code,message,field,retryable,details}`。保留 `code`、`field` 和 `requestId`，让 Codex 只修正指明的本地内容。

所有 POST/PUT 必带 `Idempotency-Key`：项目解析按规范化项目名；建 run 使用 `runFingerprint`；四类提交使用 `artifactHash`；上传使用 `runId + targetType + targetKey + variantIndex + contentSha256` 的 canonical hash；完成校验使用请求体 canonical hash。网络错误、5xx 或 `retryable:true` 才可重试，写请求重用原 key。

只有四个 `commit-*` 支持 `--dry-run`；默认 dry-run，只在显式 `--commit` 后写入。其他写接口禁止附加 dryRun 或未定义字段。

## 错误处置

`CONTRACT_INVALID`、`REFERENCE_INVALID`、`ARTIFACT_HASH_MISMATCH`：按 field 本地修正后重 dry-run。`PROJECT_NAME_AMBIGUOUS`、`RUN_DEFINITION_CONFLICT`、`RULESET_MISMATCH`：停止，不猜测或覆盖。认证、权限、未找到、上传类型/尺寸错误立即停止。`RUN_INCOMPLETE` 列出缺项后从缺项恢复。

## 禁止边界

禁止旧路由/模块：`analyze`、`ai-story-expand`、`story-to-script-stream`、`script-to-storyboard-stream`、所有 `generate`/`regenerate`、`video`、`voice`，以及模型网关、LLM task、媒体生成提供者与生成队列。waoo 仅校验、CRUD、上传和快照；本期不生成视频。
