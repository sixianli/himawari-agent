<a id="test-and-production-hosts"></a>
# 测试主机与生产主机

当 `DELIVERY_MODE` 写着 `fast` 时，[交付模式](delivery-mode.md#fast-mode) 替换下文中关于上线和生产访问的细节；下面的主机边界在两种模式下都适用。

<a id="where-tests-run"></a>
## 测试在哪里跑

- 定向测试和提交前的基本检查（`npm run check`、`npm run build`、这次改动的测试文件）在云端线程自己的容器里跑。云端容器是 claude.ai 给每个云端线程开的一次性 Linux 机器，线程结束就回收。
- 完整测试由 GitHub CI（持续集成，推送和开 PR 时自动跑的检查）跑：PR 上的 `ci/required` 跑基础测试和与改动相关的测试，合进 `main` 后由 `Main confirmation` 跑全量。CI 只用 GitHub 免费的标准托管机器（[ADR 0292](../../docs/adr/0292-how-ci-runs-now.md#runners)）。
- 没有单独的测试服务器。Hermes（家里那台 Linux 机器）和原来云服务器上的测试账号 `himawari-ci` 都不再当测试机用，相关的包装脚本、安静主机检查和目录约定已删除。
- Andy 的 Mac 上开的会话不跑服务器端的测试：推送分支，让 CI 跑，或者交给云端线程。

<a id="macbook"></a>
## MacBook

- 绝不在 Andy 的 MacBook 上运行 Himawari 服务器端的构建和测试：不跑 `npm run check`、`npm test`、任何 Vitest 项目或产品路径资格验证，也不在 Mac 上起 Himawari 服务。发现那里有这类进程在运行时要停止它。
- 苹果客户端（`clients/apple/` 下的 iPhone、Apple Watch、Mac App 和它们的扩展）的构建、单元测试和打包，在 GitHub 的 macOS 机器（GitHub Actions 提供的、装好 Xcode 的云端 Mac）上做，iPhone 和 Mac 版都经 TestFlight（苹果的测试版分发服务）装到 Andy 的设备上，不依赖 Andy 的 Mac。依据 [ADR 0309](../../docs/adr/0309-apps-sign-in-with-passkeys-and-the-web-is-removed.md#decision) 决定第 14 条（Andy 2026-11-26 定：不再依赖他的 Mac）。客户端测试不在任何 Mac 上起 Himawari 服务。端到端测试也在 GitHub 的 `macos-26` 机器上跑：`apple/iphone-e2e` 作业用 `clients/apple/scripts/e2e.sh` 在那台机器上起一个只供测试的后端（`test/ios-e2e/backend.ts`：真的设备接口和 Pi 运行，模型换成 Pi 官方的 faux 替身），这个脚本不得在 Andy 的 Mac 上运行。

<a id="production"></a>
## 生产机

- 生产运行在 Oracle 东京的 ARM 机上（地址在上线时用 `--host` 或 `HIMAWARI_PACKET_HOST` 指定；旧的 x86 云服务器 2026-11-25 已退租）。上线、重启、回滚由 Claude 自己执行，不需要用户对每次上线再授权（Andy 2026-11-26 取消了这个限制）；删除或不可逆地改动生产数据、花钱超预算仍要先问。细节见[交付模式](delivery-mode.md#fast-mode)。
- 上线包在生产机上一个没有 sudo 权限的构建账号 `himawari-build` 里构建和检查（`scripts/delivery-mode/hermes/builder-arm64.json`；目录名 `hermes` 是历史名字，里面已经没有 Hermes 的配置）。
- 测试绝不以 root 或生产账号运行，绝不读生产机密。
- 在 Mac 上只读查看生产机时（只在 `DELIVERY_MODE` 写着 `fast` 时适用），用 `bash scripts/operations/prod-read.sh <查询>`，不要用 ssh 在生产机上跑任意命令。它只接受固定的几种查询：服务状态、日志、磁盘、数据库里的运行状态（含 `tables`、`columns`、`rows`），以及三个固定查询 `rule-memories`（规则类记忆的元数据，不含原话）、`system-instruction`（生产配置里的 `runPolicy.systemInstruction` 一个字段）和 `gmail-decisions`（最近 100 条 Gmail 决策记录的元数据，不含邮件和记忆正文）；参数用严格的正则校验，数据库只以只读方式打开。用法见脚本的 `usage`，测试在 `test/tooling/prod-read.test.mjs`。

<a id="platforms"></a>
## 平台不能互相代替

- 一个平台的结果不能代替另一个平台：Mac 和 Linux 不能互相验证；CI 的 x64 机器和云端容器在时序、并发或沙箱方面的结论，不能代表生产的 ARM 机。生产上的行为以上线后的读回（`/health/ready`）和 Andy 的试用为准。
- 不要放宽测试时限，也不要设置 `HIMAWARI_TEST_TIMEOUT_MS`；超时是一个需要诊断和修复的缺陷。
