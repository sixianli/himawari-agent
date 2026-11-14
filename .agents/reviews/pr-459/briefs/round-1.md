# 作者说明：固定工具链认 linux-arm64（Oracle 的 ARM 机器分担 CI 检查的第 1 步）

背景：Andy 要把一台 Oracle 的 ARM 机器（Ubuntu 24.04，aarch64）用来分担 CI 的 security、static、policy 三项检查。这个 PR 只做第 1 步：让固定工具链（`scripts/ci/install-tools.mjs` 按 `ci/toolchain-lock.json` 下载并校验的 Node、Python、actionlint、gitleaks、Semgrep）能装在 linux-arm64 上。工作流 `.github/workflows/ci.yml` 和策略 `ci/policy.json` 都没动，现有 x64 的 CI 行为应当完全不变。

这个 PR 改了什么：

- `ci/toolchain-lock.json`：每个工具补 linux-arm64 的下载地址和 SHA-256，版本和 linux-x64 相同。
- `scripts/ci/platforms.mjs`（新）：平台到产物名的唯一一张表（darwin-arm64 对 macos-arm64、linux-x64、linux-arm64）；`buildPlatformKey` 遇到不认识的组合抛 `CI_PLATFORM_UNSUPPORTED`。
- `scripts/ci/run.mjs`、`local.mjs`、`build.mjs`、`browser.mjs`、`test.mjs`：原来写的是“是 macOS 就 macos-arm64，否则 linux-x64”，改成调 `buildPlatformKey()`。
- `scripts/ci/install-tools.mjs`：平台清单取自 `supportedPlatforms()`；`validateToolchainLock` 按每种工具的文件命名检查 linux-arm64 条目。
- `scripts/ci/contracts.mjs`：转出 `buildPlatformKey`、`hostPlatform`、`supportedPlatforms`。
- 测试：`test/tooling/toolchain-platforms.test.mjs`（新）、`test/tooling/quality-local.test.mjs`。

分支里的 `.agents/reviews/topic-ci-oracle/` 是方案讨论记录，不是这次要复核的代码，不用看。

请重点核对：

1. x64 的 CI 和 macOS 本机入口的行为有没有任何变化（产物名、平台判断、锁文件校验）。
2. `validateToolchainLock` 有没有一种本应拒绝的锁文件被放行：linux-arm64 条目里放 x64 的文件、放别的工具的文件、缺条目、wheel 放错平台。只给 linux-arm64 写了文件名规则，linux-x64 和 darwin-arm64 的条目没有同样的检查，这会不会让错误溜过去。
3. 锁文件里 linux-arm64 的每个下载地址，主机名是否都在 `install-tools.mjs` 允许的下载主机里，文件名和地址是否对得上同一个版本。
4. `buildPlatformKey()` 在 linux-arm64 上返回 `linux-arm64`：`run.mjs`、`build.mjs`、`browser.mjs`、`test.mjs` 里用它的地方，在 x64 机器上取 x64 产物的行为是否不变；ARM 机器上如果有人跑 build 或 browser，会不会悄悄产出或取用错架构的东西而不报错。
