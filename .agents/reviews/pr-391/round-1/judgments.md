# PR 391 第 1 轮逐条判断

| 编号 | 意见 | 判断 | 依据和处理 |
|---|---|---|---|
| ds-1 | 设计规范第 129、274 行仍写“只有 required 有写权限 / 不配置 write” | 成立，会出错，中高 | 读 `docs/execution/specs/2026-09-03-github-ci-quality-gates-design.md` 确认。已改两处，写明 `main.yml` 的 `full` 必须正好授予这三项权限及原因（I-93）。ADR 0201 是已采纳的决定记录，不改正文，以规范为现行说明。 |
| ds-2 / glm-3 | 跨工作流权限覆盖检查不在本地 `npm run check` 里 | 成立，会出错，中高 | `package.json` 的 `check:steps` 不跑 tooling 测试，快速模式合并不等 CI。已把检查做成 `validateCallerGrantsCalledPermissions`，放进 `scripts/ci/main-workflow.mjs`，由 `check-policy.mjs` 的 `main()` 调用，属于 `check:ci-policy`。 |
| ds-3 / glm-1 | 覆盖循环没有反向用例 | 成立，会出错，低 | 已补用例：被调用方要 write 调用方给 read、调用方没写 job 级权限、ci.yml 顶层新增 `issues: read`、把修复退回成 read，四种都必须失败。 |
| ds-4 / glm-2 | `full-permissions` 比较依赖键顺序 | 成立，会出错，低 | 改成按排序后的键值对比较；补用例：调换顺序通过，多给 `contents: write` 仍失败。 |
| ds-5 | 其余作业只读没被测试证明 | 不成立 | GitHub 文档：可复用工作流里未声明 `permissions` 的作业使用被调用工作流顶层的 `permissions`，调用方授予的是上限。`ci.yml` 顶层只有 `contents: read`、`pull-requests: read`，`check-policy.mjs` 已拒绝 `required` 以外的作业带写权限。 |
