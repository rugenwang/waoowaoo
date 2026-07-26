# 新建项目视觉设置设计

## 目标

让 `$waoo-video-creator` 在项目不存在时，接收用户提供的画幅和风格，并在创建项目的同一个 Agent Data API 请求中保存它们。

## 边界

- 仅影响 `POST /api/agent/v1/projects/resolve` 的**新建**分支。
- 请求专用初始化字段为 `initialVideoRatio` 与 `initialArtStyle`；两者要么同时缺省，要么同时有效。这不是现有 run 的 override，也不会传给 `create-run`。
- 已有同名项目永远不更新，响应仍为 `created: false`；本次请求携带的视觉设置被忽略，项目保存的设置是唯一来源。
- 新项目未提供视觉设置时保持原有用户偏好/默认值行为。
- 后续运行一律从 `creator-rules` 读取并固定项目设置；不会把聊天参数带入 `create-run`、图片生成或旧生成队列。
- 不新增、调用或修改任何旧生成、视频、任务或模型接口。

## 数据流

1. 用户向 Skill 提供 `projectName`、`sourceText`，可选 `initialVideoRatio` 和 `initialArtStyle`（可使用中文标签“比例”“风格”，Skill 解析为 UI value）。
2. Skill 仅把这两个专用字段传给 `resolve-project`，不使用 `--art-style-override`、`--video-ratio-override` 或任何 run 参数。
3. Agent API 契约验证画幅为 `ASPECT_RATIO_CONFIGS` 的 key，风格为 `ART_STYLES` 中的 value。
4. 服务端找到既有项目即直接返回，不写任何项目设置。
5. 服务端创建项目时，用这两个值覆盖新建 `NovelPromotionProject` 的对应初始字段。
6. Skill 继续获取 `creator-rules`；其返回值是唯一用于后续创作和图片的画幅/风格来源，并随 run 固定。

## 安全与幂等

- 当 `initialVideoRatio` 和 `initialArtStyle` 都缺省时（无论 `description` 是否存在），保持既有 `sha256("resolve-project:" + normalizedName)` key；description 不影响旧 key，保证已有客户端的重试与兼容。
- 仅当完整初始化字段对存在时，resolve 的幂等键才由共享 canonical JSON 计算：`{ name, description?, initialVideoRatio, initialArtStyle }`；字段值均为 trim 后的 value。服务端与 Node 客户端使用同一 canonical-json 定义；不能手写拼接。
- 同名项目存在时不比较、不修改设置；这是保护既有项目的强约束。
- 只接受项目 UI 已支持的画幅和值；不接受 prompt、模型、端点或任意风格文本。

## 验收

- 新项目携带 `initialVideoRatio=16:9` 和 `initialArtStyle=chinese-xianxia` 时，数据库项目设置保存对应值，规则包返回对应值。
- 已有项目携带其他值仍保持原设置且 `created: false`。
- 缺一项、未知风格、非法画幅被 Agent API 在写入前拒绝。
- Skill 客户端只在 resolve 阶段传递这两个参数；`find-local-run`、`fetch-rules`、`create-run` 与全部图片步骤都不能接收或使用它们。文档与边界测试明确这不是 override，既有项目不覆盖。
- 原有 resolve 请求（仅 name/description）和旧功能继续通过。
