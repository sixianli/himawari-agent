# PR 318 第 3 轮材料：复核第 2 轮低危文字修改和 ADR 改号

第 2 轮（提交 8e3c8de50cd8）没有中、高危意见，三条低危都是文档措辞，判断见 `.agents/reviews/pr-318/round-2/judgments.md`，已改：
- ADR 里关于策略检查步骤级 `if` 的范围说法；
- 设计文档里“所有 edited 事件”的说法；
- ADR 里“更省”改成写明代价。

本轮新增：main 上 PR 322 已占用 ADR 0190，所以把本 PR 的 ADR 从 `docs/adr/0190-draft-pull-requests-run-fast-checks-only.md` 改名为 `docs/adr/0191-draft-pull-requests-run-fast-checks-only.md`，正文编号和设计文档里的引用同步改为 0191。工作流、检查脚本和测试没有改动。本分支另合并了最新 main（`git diff` 里 main 带来的无关改动不需要复核）。

请只看第 2 轮提交之后本 PR 自己的改动，查：三处措辞现在是否与 `.github/workflows/ci.yml`、`scripts/ci/check-policy.mjs` 的实际行为一致；ADR 改号后有没有遗漏的旧编号或坏链接。
作者说法：Hermes 上 policy 测试和相关文件 825 通过 0 失败（第 2 轮时），改号只动文档。
这个改动不会改变模型已经见过的请求开头（只改 CI 工作流、检查脚本和文档）。
