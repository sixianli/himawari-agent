# PR 409 第 1 轮作者说明

Andy 2026-11-11 同意：草稿 PR 不跑 CI、合并前等 CI 变绿、runner 保留 npm 缓存（本 PR 只做前两项和“改标题不重跑”）。决定见 `docs/adr/0241-draft-prs-skip-ci-and-merge-waits-for-green.md`。

改动：
- `.github/workflows/ci.yml`：6 个检查作业带草稿条件；`ci/required` 第一步 bash 判草稿/上游取消失败；之后的 gate 上传和共享目录删除改为 `always() && steps.entry.outcome == 'success'`；去掉 `edited` 事件和并发组的 edited 段。
- `scripts/ci/check-policy.mjs`：对应硬规则。
- 测试：`test/tooling/policy.test.mjs` 反向用例，`test/tooling/ci-optimization.test.mjs` 执行入口 bash。
- 文档：ADR 0241、ADR 0191 标为被取代、交付模式、AGENTS.md、设计说明。

请核对：
1. GitHub 表达式 `contains(needs.*.result, 'cancelled')` 和 `github.event_name == 'pull_request' && github.event.pull_request.draft == true` 在 workflow_call（main.yml 调用）、workflow_dispatch、非草稿 PR 上的取值，会不会误判失败或漏判。
2. 草稿条件加到 policy 后，下游作业（依赖 policy）在草稿上和非草稿上的行为；main.yml 调用 ci.yml 时是否仍全部运行。
3. 入口失败后不删共享目录、不上传 gate，会不会让 main 的证据或 main-evidence.mjs 出问题；被取消运行的残留目录靠每小时清理是否足够。
4. 去掉 edited 后有没有别的地方（main-evidence、aggregate、文档、测试）还依赖它。
5. 合并规矩的文字是否清楚，有没有和其他指令文件冲突。
