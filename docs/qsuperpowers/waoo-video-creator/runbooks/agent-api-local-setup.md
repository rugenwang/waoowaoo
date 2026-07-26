# WAOO Agent API 本地配置与回滚手册

## 适用边界

本机的 WAOO 应用由用户在 Mac 上本地启动。Docker 只承载正式依赖服务，例如 MySQL、Redis 和 MinIO。

本手册不会、也不要创建、启动、停止或删除任何 WAOO 应用容器，不修改、重启或清理用户的正式 MySQL、Redis、MinIO 等 Docker 依赖。所有应用级启停都由用户自行操作 Mac 上的本地 WAOO 进程。

Agent API 是可选、默认关闭的本地数据接口。它只负责读取创作规则、写入 Codex 产出的结构化数据与上传图片；不应触发 WAOO 的模型、Worker 或任务队列。

## 1. 只读确认本地登录用户 ID

优先在已登录的 WAOO 页面、账户信息或项目信息中确认当前用户，再将该用户与项目归属对应。不要根据顺序、默认值或猜测填写 ID。

如果页面无法直接确认，可由熟悉当前本地数据库的人使用只读账号执行类似查询：

```sql
SELECT id, name, email, updatedAt
FROM `user`
ORDER BY updatedAt DESC
LIMIT 20;
```

查询本身只提供候选项，仍必须与当前登录账号和其拥有的项目核对。不得修改用户表，不得为了接入 Agent API 新建、复制或更换正式用户。

## 2. 生成仅用于本地的长随机 Token

在 Mac 本地生成至少 32 字节的加密随机值，例如：

```sh
openssl rand -hex 32
```

请只把真实 token 和经确认的 user ID 写入不受版本管理的本地 `.env`，不要写入 `.env.example`、文档、脚本、提交记录或聊天内容：

```dotenv
WAOO_AGENT_API_ENABLED=true
WAOO_AGENT_TOKEN=<本地生成的长随机值>
WAOO_AGENT_USER_ID=<已与当前登录账号核对的 ID>
WAOO_AGENT_UPLOAD_MAX_BYTES=10485760
WAOO_AGENT_UPLOAD_MAX_PIXELS=40000000
```

Agent 在本地产生的临时恢复文件应保存在已被 Git 忽略的 `.waoo-agent/` 目录中；该目录不应存放 token、user ID 或数据库凭据。

`WAOO_AGENT_UPLOAD_MAX_BYTES` 限制单个上传文件的字节数，默认示例为 10 MiB。`WAOO_AGENT_UPLOAD_MAX_PIXELS` 限制图片解码后的总像素数（宽 × 高），默认示例为 4000 万。两者必须是正整数，不要用过大数值绕过上传保护。

## 3. 启用并进行只读冒烟检查

1. 在本地 `.env` 保存配置后，由用户自行重启 Mac 上的 WAOO 本地进程，使环境变量生效。不要操作 Docker 中的 WAOO 应用容器，也不要重启正式依赖。
2. 在浏览器中确认目标项目属于同一用户，记下项目 ID。
3. 只请求创作规则读接口：`GET /api/agent/v1/projects/<projectId>/creator-rules?locale=zh`。请求头必须包含 `Authorization: Bearer <token>` 和 `X-Waoo-User-Id: <userId>`。
4. 确认响应包含规则、项目设置、contract 引用及内容 hash；同时检查响应不包含模型或供应商配置，尤其不应出现 `model`、`provider`、`apiKey` 或任何凭据值。如果出现，立即关闭 Agent API 并停止使用。

未提供项目/剧本与 Agent 凭据时，不进行任何真实 HTTP 写入冒烟；写入验收延后到用户明确提供输入并确认目标项目之后。

## 4. 验证不触发旧任务体系

在真实写入验收前后，用同一个只读数据库连接分别执行并保存结果：

```sql
SELECT COUNT(*) AS task_count FROM tasks;
SELECT COUNT(*) AS task_event_count FROM task_events;
SELECT COUNT(*) AS graph_run_count FROM graph_runs;
SELECT COUNT(*) AS usage_cost_count FROM usage_costs;
```

只读计数应在 Agent 纯数据流程前后保持不变。为避免把其他用户同期活动误判为 Agent 行为，验收时应保证本地没有其他创作任务；如果计数变化，先关闭 Agent API，再调查，不得删除任务或计费记录来“恢复”计数。

## 5. 关闭与回滚

### 立即关闭 Agent API

1. 将本地 `.env` 中的 `WAOO_AGENT_API_ENABLED` 改为 `false`，或删除该变量。
2. 由用户自行重启 Mac 上的 WAOO 本地进程。
3. 确认 Agent API 不再可用；不需要停止或删除任何 Docker 容器。
4. 如果不再使用，从本地 `.env` 删除 token 和 user ID。不要把它们转存到其他受版本管理的文件。

### 数据库 migration 回滚（高风险，手工审批）

安全的应用回滚不需要删表：先关闭 Agent API，回退应用代码，保留未被旧代码使用的 `agent_creation_runs` 表，等待经审批的维护窗口。

如果确实必须完全撤销 `20260724000100_add_agent_creation_runs` migration，必须由数据库负责人审批，并在操作前：

1. 停止 Mac 上的本地 WAOO 应用进程，不停止 Docker 依赖。
2. 完成可验证、可恢复的 MySQL 备份，并确认还原方法。
3. 只核对该 Agent migration 创建的 `agent_creation_runs` 表、索引和外键，不将其他 migration 或业务表包含在回滚范围内。
4. 导出并审核该表中的现有数据；删表会永久删除 Agent run 恢复信息。
5. 由数据库负责人根据 migration SQL 编写并审核精确的反向 SQL，再在维护窗口执行。本手册不自动执行、也不提供可直接复制运行的删表命令。
6. 只在反向 SQL 成功且验证完成后，才由负责人按团队的 Prisma migration 历史管理流程处理该 migration 记录。`prisma migrate resolve --rolled-back` 只修改 migration 历史，不会自动撤销表或数据，不得把它当作数据库回滚。

回滚后先保持 `WAOO_AGENT_API_ENABLED=false`，再由用户自行启动 Mac 本地 WAOO，验证原有页面、队列与依赖服务仍正常。
