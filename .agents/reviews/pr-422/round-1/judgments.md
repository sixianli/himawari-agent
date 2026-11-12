# PR 422 第 1 轮逐条判断

- ds-1 / glm-3（高，会出错）：`ci/security-exceptions.json` 里 6 条 @octokit、2 条 universal-github-app-jwt 例外指向已删除的包，2 条嵌套 zod 例外还写 4.4.3（锁文件已是 4.6.7）；`.github/security-review-manifest.json` 的 node-forge 还写 1.4.0。CI 的 security 步骤会报 SECURITY_EXCEPTION_DEPENDENCY_UNKNOWN。成立。改例外要 Andy 同意，而且 CI 线程的 PR 416 正在改同一个文件（加 MCP server 2.0.0 的 6 条），所以等 416 合并、Andy 同意后在本 PR 里一次改完；已向 Andy 提出。
- ds-2 / glm-1（高，会出错）：覆盖率检查写死 vitest 和 @vitest/coverage-v8 为 4.1.9，升到 4.1.12 会让覆盖率检查失败。成立。已改：vitest 和 coverage 退回 4.1.9（它们的公告只涉及测试运行器本身的 mock 和浏览器模式，不进生产包），升级留给 CI 线程连同覆盖率基线一起做。
- glm-2（高，会出错）：`installable-node-services.test.ts` 断言运行时清单里 client 是 2.0.0。成立。清单版本由 `scripts/package-node-runtime.mjs` 从安装的包读出；本地重新打包后清单里是 2.3.1。已改断言为 2.3.1。
- ds-3（中）：`test/integration/qualification/evidence/s1-task2-dependency-matrix.json` 还列着被删的包。不成立：这是 2026-09 那次依赖选型的资格证据，记录的是当时的候选，没有任何检查拿它对照现状。
- glm-4（中）：Hermes 两个资格脚本断言 platform-node 下的 zod 是 4.4.3。不成立：脚本检查的是 2026-09-13 那次准备好的候选源码目录（`B/'source'`，逐文件核对摘要），不是当前仓库，那份源码里仍是 4.4.3。
- glm-5（中）：ADR 0021 决定第 4 条写“固定 client 2.0.0”。成立，属于文档与代码不一致。按快速模式规则先记 `Docs: deferred (fast mode)`，列给 Andy；client 仍是精确版本锁定，只是版本号变了。
- ds-4（低）：README 等文档写 Vitest 4.1.9。vitest 已退回 4.1.9，不再不一致。
- ds-5 / glm-6（低，可以更好）：锁文件里还有 nanoid、postcss、嵌套 rolldown 等随 vite 8.3.8 带来的变化，说明里没列全。已在 PR 描述里补全。
