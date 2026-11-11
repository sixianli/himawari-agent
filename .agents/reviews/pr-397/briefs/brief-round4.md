# PR 397 第 4 轮作者说明

第 3 轮意见和逐条判断见 `.agents/reviews/pr-397/round-3/judgments.md`。本轮只看 8857f6b4 之后的修改（d32cb2d8）：

- `scripts/ci/publish.mjs`：新增 `artifacts`（`keep` 默认、`omit`），`omit` 时跳过 `kind: "artifact"` 的报告；CLI 新增 `--artifacts`，quality 模式拒绝它。
- `scripts/ci/main-confirm.mjs`：发布构建和安全检查时传 `--artifacts omit`，`main-confirmation-` 产物不再带构建归档。
- 测试：`gate-lifecycle.test.mjs`（omit/keep/非法值）、`main-confirmation.test.mjs`（两次发布都带 omit）、`ci-runner-scripts.test.mjs`（组和目录都已存在时照常重装）。
- 文档：ADR 0238 第 4 条范围、`CI_SHARE_DIGEST_INVALID`；运维手册；设计说明第 296 行。

请核对：
1. 跳过归档后，发布出来的 `result.json` 仍能通过 `CheckResult` 校验，`assertPublicArtifacts` 的 entries 与实际文件一致；有没有别的地方读 `main-public` 里的构建归档。
2. `--artifacts` 参数解析和非法值处理有没有漏洞；ci.yml 里各作业的 publish 行为是否不变。
3. 修改有没有引入新问题。
