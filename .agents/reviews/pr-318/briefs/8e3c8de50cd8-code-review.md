# PR 318 第 2 轮材料：复核第 1 轮意见的修改

上一轮（第 1 轮，提交 43038ee916a8）中危意见：`ci.yml` 里 `edited` 事件的并发组后缀用 `github.run_id`，每次编辑落在不同的组，连续改标题会叠出多轮不会被取消的完整 CI。

本轮修改：
- `.github/workflows/ci.yml` 并发组里 `edited` 的后缀改为固定值 `'edited'`；`scripts/ci/check-policy.mjs` 的期望串同步；`test/tooling/policy.test.mjs` 夹具同步并新增两条反向用例（缺 `edited` 段、`edited` 段不对时必须报错）。
- ADR 0190 和 CI 设计文档的措辞：非草稿 PR 的 `edited` 完整运行、草稿上跳过；不再承诺仓库外 Auto-fix 的行为；说明连续编辑互相取消、最多保留一轮。
- 本分支还合并了 main（`git diff` 里 main 带来的无关改动不需要复核）。

请查：并发组表达式在各种事件下的取值（synchronize、ready_for_review、edited、workflow_call）是否符合 ADR；反向用例是否真的会在改回 `run_id` 或删掉 `edited` 段时失败。
作者说法：Hermes 上 policy、aggregate、main-evidence、quality-policy 测试 824 通过 0 失败；`check-policy`、`biome` 通过（合并 main 后的结果在 PR 里补）。
这个改动不会改变模型已经见过的请求开头（只改 CI 工作流、CI 脚本、测试和文档）。
