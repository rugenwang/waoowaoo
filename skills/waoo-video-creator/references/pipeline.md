# 运行流水线

运行时 `rules.json` 和已下载 contracts 是权威。本文件仅规定操作顺序，不复制创作 Prompt；内置 `imagegen` 不可用时停止并说明，绝不生成视频。

## 开始前的恢复决策

解析项目后，skill 使用 `projectName/sourceText`，以及仅允许成对提供的新项目初始化 `initialVideoRatio/initialArtStyle`。该 pair 只在 `resolve-project` 创建缺失项目时使用，精确同名项目绝不写入或覆盖当前设置；随后以 `projectId/sourceHash` 扫描正式 run 与 intake，**再**获取当前规则。`inputKindHint=auto`、`locale=zh`、`episodeSplitHint=auto` 及 effective options 来自运行时规则；不得把初始比例/风格或其他 art-style、video-ratio、split 字段作为 run 覆盖项。唯一正式候选：加载其固定规则、effective options、fingerprint 和 episode definitions，执行 `get-run`/`snapshot` 恢复。唯一 `pending-create`：只原样重放其 `run-request.json`，不得重新分析。多个候选即歧义，列出 runId/fingerprint 后停止。无候选才 fetch-rules 并新建指纹。客户端覆盖 flags 仅供高级手动/恢复操作，skill 不得使用。

固定的 pinned rules 不可变、不可被当前规则覆盖；规则升级必须新建运行。

## 阶段表

每阶段均按：输入 → Codex 判断 → 读取 rules → 本地输出 → `validate-manifest` → dry-run → `--commit` → checkpoint；任一契约、哈希、歧义或依赖错误都停止并转恢复。

| 阶段 | 输入与 Codex 判断 | 规则/本地输出 | 校验、提交与 checkpoint |
|---|---|---|---|
| 阶段 0 预检 | source、项目、覆盖项；判断单/全集，**固定分集、episodeKey、名称与简介** | 固定 rules、source、definition、effective options、intake | preflight；创建/恢复 run；保存 manifest。阶段 1 不得重新拆集或改名 |
| 阶段 1 故事 | 固定 definition；生成或整理每集 `novelText`，不得改事实 | story rules；`story.json` | `validate-manifest --stage story`；`commit-story --dry-run`，再 `--commit`；故事 receipt |
| 阶段 2 资产与剧本 | 提取一致性资产、Clip 与忠实剧本 | asset/screenplay rules；`assets.json`、`screenplay.json` | assets 与 screenplay 各 dry-run/commit；双 receipt |
| 阶段 3 资产图片 | 先由 pinned rules+source 写本地 visual bible input，执行无 HTTP 的 `set-visual-bible` 并核对 `visual-bible.json`/manifest hash；再按视觉基准、角色 appearance、场景、道具每目标一次 imagegen | 图片相关 rules；`visual-bible.json`、`images/assets`、上传回执 | 检查 visual bible hash 和图片，upload；每图 checkpoint |
| 阶段 4 分镜 | 每 Clip 一个 storyboard；摄影、演技、Panel、Frame 和依赖 | storyboard rules；`storyboards.json` | `validate-manifest --stage storyboards`；dry-run/commit；分镜 receipt |
| 阶段 5 分镜图片 | 按 storyboard/panel/frame 拓扑和本地参考生图 | 图片/引用 rules；`images/storyboards`、上传回执 | 检查图片，upload；每帧 checkpoint |
| 阶段 6 完成 | 汇总 hashes 与上传回执，定位缺项 | pinned rules；`receipts.json` | `validate-manifest --stage finalize`，`finalize`；completed 或确切 missing |

图片生成失败同一 target 只可针对性重试一次；依赖图缺失则停在相关帧。动态脚本可保存，但不得提交视频任务。
