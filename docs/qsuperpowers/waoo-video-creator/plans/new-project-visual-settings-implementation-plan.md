# 新建项目视觉设置实施计划

> **给智能代理工作者：** 必需：使用 qsuperpowers:subagent-driven-development（如果有子代理可用）或 qsuperpowers:executing-plans 来执行此计划。步骤使用复选框（`- [ ]`）语法进行跟踪。

**目标：** 允许 WAOO 创作 Skill 仅在自动新建项目时保存用户指定的画幅和风格，并保护既有项目设置不被覆盖。

**架构：** 扩展现有 resolve-project Agent 契约及服务的创建分支；客户端与 Skill 仅在 resolve 阶段传递可选的初始化设置。后续 run 仍只读取和固定 creator-rules。

**技术栈：** Next.js Route、Zod、Prisma、Node test runner、Codex Skill 文档。

---

### 任务 1：扩展受控项目初始化接口

**文件：**

- 修改：`src/lib/agent-api/contracts/project.ts`
- 修改：`src/lib/agent-api/services/project-resolver.ts`
- 修改：`src/lib/agent-api/idempotency.ts`
- 修改：`src/app/api/agent/v1/projects/resolve/route.ts`
- 测试：`tests/unit/agent-api/project-resolver.test.ts`
- 测试：`tests/unit/agent-api/contracts.test.ts`
- 测试：`tests/unit/agent-api/idempotency.test.ts`

- [ ] 先写失败测试：新建项目保存成对的合法 `videoRatio/artStyle`；已有项目不覆盖；缺一项或未知值拒绝。
- [ ] 运行上述定向测试，确认因字段尚不被契约/服务支持而失败。
- [ ] 用最小实现扩展 Zod 契约（专用 `initialVideoRatio/initialArtStyle`）、resolve 输入和 `novelPromotionProject.create` 数据；复用项目已有的风格与画幅允许列表。
- [ ] 将规范化初始化设置加入 resolve 幂等材料：只含 name 的旧请求保持既有 key；带初始化字段的请求使用共享 canonical JSON，服务端与 Node 客户端不得各自拼接。
- [ ] 运行单元与 Agent route 契约测试。
- [ ] 提交：`feat(agent): initialize new project visual settings`

### 任务 2：把初始化选项限定到 Skill 的项目创建阶段

**文件：**

- 修改：`skills/waoo-video-creator/scripts/waoo-client.mjs`
- 修改：`skills/waoo-video-creator/tests/waoo-client.test.mjs`
- 修改：`skills/waoo-video-creator/tests/e2e-client-flow.test.mjs`
- 修改：`skills/waoo-video-creator/SKILL.md`
- 修改：`skills/waoo-video-creator/references/api-contracts.md`
- 修改：`skills/waoo-video-creator/references/pipeline.md`
- 修改：`skills/waoo-video-creator/tests/skill-boundaries.test.mjs`

- [ ] 先写失败测试：`resolve-project` 仅传递成对 `--initial-video-ratio/--initial-art-style` 参数；其余命令和 `create-run` 不接受或使用它们。
- [ ] 运行 Skill 定向测试，确认失败。
- [ ] 实现客户端参数验证、resolve 请求体与幂等键；更新 E2E mock 覆盖新建后 rules 的设置。
- [ ] 更新 Skill 输入说明：用户可提供画幅/风格，解析为专用初始化字段且仅用于新项目；已有项目以保存设置为准；旧 `--*-override` flags 仍禁止从 Skill 使用。
- [ ] 运行 `npm run test:waoo-video-creator-skill`、格式校验及相关 Agent API 测试。
- [ ] 提交：`feat(skill): initialize new project visual settings`

### 任务 3：最终隔离与回归验证

**文件：**

- 修改（如需要）：`tests/regression/agent-api-legacy-isolation.test.ts`

- [ ] 验证新字段不允许任何模型、prompt、任务或旧生成接口。
- [ ] 验证现有项目不被覆写、规则固定仍成立、Agent-only 保护仍成立。
- [ ] 运行目标测试与完整 Skill 测试；记录已存在且无关的仓库基线失败（如有）。
- [ ] 提交：`test(agent): cover visual settings initialization isolation`
