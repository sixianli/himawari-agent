# 作者说明：PR 459 第 2 轮，只看对第 1 轮意见的修改

背景同第 1 轮：这个 PR 让固定工具链（`scripts/ci/install-tools.mjs` 按 `ci/toolchain-lock.json` 下载并校验的 Node、Python、actionlint、gitleaks、Semgrep）能装在 linux-arm64 上，工作流和策略都不动，ARM 机器之后只跑 policy、static、security 三项检查。

第 1 轮六条意见的处理（逐条判断在 `.agents/reviews/pr-459/round-1/judgments.md`）：

- 第 1、2 条：linux-arm64 上会生成或读取构建产物的检查，改成一开始就明确拒绝。`scripts/ci/platforms.mjs` 新增 `artifactPlatformKey`，只认 macos-arm64 和 linux-x64，其他抛 `CI_ARTIFACT_PLATFORM_UNSUPPORTED`；`run.mjs`、`build.mjs`、`browser.mjs`、`test.mjs` 原来调 `buildPlatformKey` 的地方都换成它；`local.mjs` 在不带参数、build、coverage 三种情况下先调它。`quality-local.test.mjs` 的 linux-arm64 用例改成只跑三项检查，并断言另外三种情况被拒绝且一条命令都不执行。
- 第 3、4、5 条：`install-tools.mjs` 的文件名规则改成三个平台都有，由工具种类和 `version` 字段拼出确切文件名（Semgrep 的 wheel 按平台用正则），没有规则的平台直接失败。`toolchain-platforms.test.mjs` 补了互换、放错架构、版本对不上、wheel 混平台的反向用例。
- 第 6 条判为不成立：`run.mjs` 读入产物时要求 `producer.matrixKey` 等于主机平台。

请重点核对：

1. x64 的 CI 和 macOS 本机入口的行为有没有变化：`artifactPlatformKey` 在这两个平台上的返回值是否和原来的 `buildPlatformKey` 完全相同；新的确切文件名规则会不会拒绝现在锁文件里合法的 linux-x64 或 macos-arm64 条目。
2. linux-arm64 上 policy、static、security 三项检查的路径里，还有没有会调到 `artifactPlatformKey` 而被误拒的地方（`run.mjs` 里它在哪一步被调用）。
3. `local.mjs` 的拒绝条件有没有漏掉会碰构建产物的检查（例如 browser），或者多拒了不碰产物的检查。
4. 文件名规则有没有仍然放行的错误锁文件。
