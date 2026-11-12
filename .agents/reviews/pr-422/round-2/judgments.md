# PR 422 第 2 轮逐条判断

没有需要改代码的中、高意见。

- r2-ds-1（模型标高）：新登记的例外在本 PR 自己的 CI 和合并后第一次 main 运行里不生效，因为 CI 只用 base 分支上的例外清单做匹配，产物检查会报 PUBLIC_ARTIFACT_CONTAINS_SECRET。说的是事实，但这是门禁的既定设计（PR 不能给自己批例外，测试“候选分支自加例外不改变受审阅base”钉住了这一点），不是本 PR 的缺陷，也不该为了让本 PR 变绿去改门禁。CI 线程 11-12 已确认这属于“已知密钥误报”，按 Andy 11-12 的长期授权不等 CI 合并，PR 描述里写明。合并后例外进入 main，之后的 PR 正常。不改。
- r2-ds-2（低，可以更好）：sourceProofSha256 和 sourceReview 没有代码核对，只是审阅记录。属实，是现有机制的情况，不在本 PR 范围；列给 Andy。
- r2-ds-3（低，可以更好）：docs/execution/plans/2026-09-03-github-ci-quality-gates-plan.md 和 docs/backlog/BL-20261003-001 还写旧的批准评论和 node-forge 1.4.0。属实；按快速模式规则记 Docs: deferred，列给 Andy。
- 模型标“未核实”的几项：批准评论 6816148518 已发在 PR 422，正文按 security-owner-review.mjs 的解析方式本地核对过 manifestSha256 一致；各条 fileSha256 和 findings 由脚本从 npm tarball 算出，并核对 tarball 的 sha512 等于锁文件 integrity、成员字节等于安装文件。
