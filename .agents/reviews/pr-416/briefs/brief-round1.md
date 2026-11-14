# PR 416 第 1 轮作者说明

问题：GitHub 免费账号的产物（artifact）额度 500 MB 按小时累计整个账单周期，用完即拦，2026-11-11 起所有 CI 运行的上传步骤失败，`ci/required` 全红。Andy 2026-11-12 同意“彻底不用 GitHub 产物”的方案（方案讨论记录在 `.agents/reviews/topic-ci-no-artifacts/`）。决定见 `docs/adr/0243-ci-uses-no-github-artifacts.md`，事故 I-94。

改动：
- `scripts/ci/gate-log.mjs`（新）：汇总结论 `{context, summary}` 的 base64 编码和解码，前后标记 + SHA-256；解码时去掉 GitHub 日志每行的时间戳，要求恰好一段。
- `scripts/ci/required.mjs`：打印汇总结论到 stdout，写作业摘要表。
- `scripts/ci/main-evidence.mjs`：discover 改为列出该次尝试的作业、找唯一成功的 `ci/required`、下载作业日志（`githubLog`：只对 api.github.com 带令牌，手动跟一次 HTTPS 跳转且不带令牌）、解码，写 `.ci-output/main-evidence/gate/{context,summary}.json`；verify 不变。
- `.github/workflows/main.yml`：删下载、上传产物；确认作业先重新 discover 再跑 main-confirm；两个作业最后一步写作业摘要。
- `.github/workflows/ci.yml`、`quality.yml`：上传诊断改为 `scripts/ci/ci-summary.mjs`（新）写作业摘要；删 quality 的 handoff 作业和 `ci_run_id` 输入。
- 硬规则：`check-policy.mjs`、`main-workflow.mjs`、`quality-policy.mjs`；两个 artifact action 从 `ci/toolchain-lock.json` 和 `install-tools.mjs` 删除。
- 另外两个独立提交：`ci/security-exceptions.json` 加 8 条公开依赖误报例外（Andy 已同意）；交付模式和 AGENTS.md 写入 Andy 2026-11-12 “不等 CI”的长期授权。

约束：不花 GitHub 的钱；任何作业不带写权限；main 的轻量确认在证据有任何不符时必须退回完整 CI；代码不写注释；发给模型的内容只追加（本 PR 不涉及 Himawari 的模型请求）。

请核对：
1. 汇总结论放进日志后，main 轻量确认的信任边界有没有变弱：同一个 `ci/required` 作业日志里，别的步骤或 PR 自己的代码能不能伪造一段汇总结论，或让解码拿到别人的结论；“恰好一段”的要求够不够。
2. GitHub 作业日志的实际格式（时间戳前缀、BOM、`##[group]` 行、密钥遮盖 `***`、超长行）会不会让解码失败或误读；下载日志接口的跳转处理是否正确，令牌会不会泄露到存储地址。
3. 确认作业重新 discover 时，和路径选择作业的结果可能不一致的情况（PR 又跑了一次尝试、24 小时窗口边界、日志被删），是否都安全地失败而不是误判通过。
4. `ci-summary.mjs` 写进作业摘要的内容会不会泄露密钥或未遮盖的内容；截断、排序、上限是否正确；`plan` 作业没装依赖，`ci-summary.mjs` 只能用 Node 内置模块和 `redact-text.mjs`。
5. 删掉 quality.yml 的 handoff 后，`export-evidence.mjs` 和别的地方还有没有依赖它；保留的 `retentionDays` 字段是否会误导。
6. 硬规则和反向用例是否真的会拦住把上传、下载产物加回三个工作流。
7. 文档（ADR 0243、设计文档、I-94 行、交付模式）和代码是否一致。
