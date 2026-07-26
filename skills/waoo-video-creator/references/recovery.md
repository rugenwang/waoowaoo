# 精确恢复流程

恢复使用旧 run 的 pinned rules；当前服务端规则变化不影响旧 run。若本地 `rules.json` 与固定 `ruleSetHash` 不一致，立即停止；不得用新规则覆盖旧 hash 或重新猜内容。

1. 执行 `find-local-run`，同时扫描 `.waoo-agent/runs` 与 `.waoo-agent/intake`。
2. 命中 `pending-create` 时，重验 source/rules/definition/run-request hash；仅以完全相同的 `run-request.json` 重放 create-run POST。获得 runId 后生成并校验 manifest，再原子转正。
3. 命中正式 run 时，读取 manifest、完整 rules.json、run-request.json、source、definition 与 receipts，重验 source/rule/fingerprint hash。
4. 执行 `get-run` 和 `snapshot`；服务端已提交 artifact hash 是事实，只有与本地 artifact hash 相等才标记完成。
5. 上传按 `target + variant + content hash` 对齐 receipt，找出第一个 missing 项并从此继续。
6. 本地 Artifact 或其依赖图片丢失时停止并报告；不得凭新规则补猜。
7. 同一 target 图片失败或质检不合格，只做一次针对性重试；仍失败保持阻塞。
8. finalize 为 incomplete 时逐项修复后重试；绝不调用后端生成降级，也不触发生成、视频或语音任务。
