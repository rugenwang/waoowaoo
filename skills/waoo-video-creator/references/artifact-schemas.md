# Artifact 映射与引用

运行时下载的 JSON Schema 是权威；本文只说明聚合文件如何拆成服务端单 Artifact，绝不手抄完整 Schema。

## 聚合到单 Artifact

`story.json`、`screenplay.json`、`storyboards.json` 按 `episodeKey` 聚合；提交时 `commit-story`、`commit-screenplay`、`commit-storyboards` 各提取一集。`assets.json` 是运行级单 Artifact，由 `commit-assets` 一次提交。每个提交的 `artifactHash` 由客户端对该单 Artifact 计算；不得把聚合文件整体哈希冒充单集哈希。

## external key 命名

使用稳定、可读、同类唯一的 lower-kebab key，例如 `hero-lin`、`hero-lin.base`、`market-night`、`jade-token`、`episode-001`、`clip-001`、`board-001`、`panel-001`、`frame-001`。external key 不是数据库 ID，不跨 run 猜测复用。

## 引用图

`characterKey` 拥有一个或多个具体 `appearanceKey`；每个分镜角色必须引用 appearanceKey。Clip 和 Panel 引用一个 location（场景）及可见 prop（道具）；场景站位只能使用该 location 的有效 slot。`episodeKey → clipKey → storyboardKey → panelKey → frameKey` 构成顺序拓扑；每个 Clip 恰好一个 storyboard，Frame 依赖只可指向更早 frame。

图片参考以目标类型加 key 表达：角色形象用 appearanceKey，场景/道具用 locationKey/propKey，画面连续性用 frameKey。提交前所有引用必须存在、类型正确且可解析；external key 全局按其领域唯一，禁止同键重名或悬空引用。

业务约束：剧本锚点回到 `novelText`，不得新增事实/对白/时间顺序；panelNumber 与 frameIndex 连续，首帧时间为 0，frame 时间不越过 Panel 时长。图片只上传本 run 的本地合格文件和对应 receipt。
