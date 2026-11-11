# PR 397 第 3 轮作者说明

第 2 轮意见和逐条判断见 `.agents/reviews/pr-397/round-2/judgments.md`（工作区里有这个文件，可以直接读）。本轮只看 11d223a8 之后的修改（8857f6b4）：

- `scripts/ci/check-policy.mjs`：upload-artifact 只许上传诊断目录（汇总作业只许上传 `.ci-output/gate/`）并保存 1 天；`test/tooling/policy.test.mjs` 反向和正向用例。
- `test/tooling/run-share.test.mjs`：collect 缺失时标准错误输出的 CLI 用例。
- 文档：运维手册排错表（摘要不符、退出码 71）、ADR 0238。

请核对：
1. 上传规则会不会误拦现有 `ci.yml` 的合法上传（7 个上传步骤），会不会漏掉别的把大文件传回 GitHub 的写法。
2. 第 2 轮判为不成立的 ds-3（组和目录都已存在时照常安装）理由是否站得住。
3. 修改有没有引入新问题。
