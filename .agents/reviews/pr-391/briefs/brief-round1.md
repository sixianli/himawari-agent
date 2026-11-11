# PR 391 作者说明

## 问题
main.yml 自 2026-11-10 16:11 JST 起每次都 startup_failure。PR 347（ADR 0201）让 ci.yml 的 required 作业申请 `actions: write`（删除本次运行的报告产物），而 main.yml 的 full 作业通过 `uses: ./.github/workflows/ci.yml` 调用它时只继承工作流级的 `actions: read`。GitHub 规定被调用的可复用工作流拿不到超过调用方的权限，于是整轮在启动前失败。

## 改动
- main.yml 的 full 作业显式写 permissions：contents: read、actions: write、pull-requests: read。
- scripts/ci/main-workflow.mjs：原来要求 full 不得有 permissions，现在要求正好是上面这组（错误码 full-permissions）。
- test/tooling/ci-optimization.test.mjs 新增 [I-93] 测试：ci.yml 顶层和每个作业申请的每项权限，都不能高于 main.yml full（或工作流级）授予的权限；并验证把 actions 改回 read 时 validateMainWorkflow 抛 full-permissions。
- docs/incidents-and-gates.md 新增 I-93 一行。

## 作者的说法，请核对
1. 这组权限是最小的：只有 required 作业需要 actions: write，其余作业只读。full 作业授予 actions: write 不会让 main 上的 plan/confirm 作业拿到写权限。
2. [I-93] 测试能拦住同类回归：以后 ci.yml 任何作业新增更高权限而 main.yml 没跟上，测试会失败。
3. 不影响 PR 触发的 ci.yml（pull_request 事件）的权限。

## 约束
不写代码注释；不改 ci.yml 的 job 数量和 DAG（check-policy.mjs 校验）。
