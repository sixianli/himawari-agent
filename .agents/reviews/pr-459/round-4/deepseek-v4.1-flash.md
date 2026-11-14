## 结论（按严重度）

### 1. [中] ARM 路径没有进入任何自动门槛，hosted policy/static/security 也仍然不接受 linux-arm64 成员

- 文件:行：`test/tooling/artifact-host.mjs:4-13`、`.github/workflows/ci.yml:33`、`ci/policy.json:10-18`、`scripts/ci/check-policy.mjs:337-343`
- 问题：`useArtifactCapableHost()` 的 ARM 分支只有在真实 linux-arm64 主机上才执行；现有 CI 的 policy 作业跑在 `ci-vps`（x64），所以这个分支每次都是 no-op。作者说的“用预加载脚本模拟 arm64”没有提交成自动检查，真实 ARM 下载/安装也没有作业覆盖。
- 证据：
  - `test/tooling/artifact-host.mjs:4`：`const ARTIFACT_HOSTS = ["darwin-arm64", "linux-x64"];`
  - `test/tooling/artifact-host.mjs:9`：`if (ARTIFACT_HOSTS.includes(hostPlatform())) return;`
  - `.github/workflows/ci.yml:33`：`runs-on: ci-vps`
  - `ci/policy.json:10-18`：policy 成员只有 `key: "default"`, `os: "linux"`, `arch: "x64"`。
  - `scripts/ci/check-policy.mjs:339-343`：`member.arch === (mac ? "arm64" : "x64")`，非 macOS 成员强制 x64。
- 建议：如果目标只是 “ARM 本机用 `scripts/ci/local.mjs --check ...` 跑”，请在说明里写清楚；如果目标是让 ARM 进入 hosted policy/static/security，必须同时改 `ci/policy.json`、`check-policy.mjs` 的成员校验，并增加一个真实或提交在仓库里的 linux-arm64 作业/模拟作业。否则这个 PR 最核心的 ARM 路径没有任何自动回归保护。

### 2. [中] `build`/`browser`/`test` 的拒绝不在函数入口，直接调用会先做大量工作或写输出

- 文件:行：`scripts/ci/build.mjs:47-134`、`scripts/ci/browser.mjs:75-80`、`scripts/ci/test.mjs:35`
- 问题：外层 `runCheck`/`local` 在创建输出前就调用 `artifactPlatformKey()` 拒绝，这是对的；但直接调用 `build()`、`runBrowser()`、`runTests()` 时，平台拒绝发生在很后面。`build()` 会先编译、打包、写 `artifact-record.json`，到 `build.mjs:134` 才 `artifactPlatformKey()` 抛错；`runBrowser()`/`runTests()` 也会先创建输出目录、解包/复制 artifact。
- 证据：
  - `scripts/ci/build.mjs:134`：`const platform = artifactPlatformKey();` 前面 47-132 行已经执行 tsc、vite、SQLite 探针、写记录。
  - `scripts/ci/browser.mjs:76-77`：`await mkdir(path.dirname(destination), { recursive: true }); await mkdir(destination, { recursive: false });`
  - `scripts/ci/test.mjs:35`：`const verified = await verifyArtifact({ archive: artifact, root, context });`
- 建议：把所有“会产生/读取构建产物”的函数入口也做一次平台判定，或把平台 key 作为显式参数传入。这样直接 CLI 和未来新增调用方都不会先产生副作用再失败。

### 3. [低] `artifact-host` 把所有未知平台都伪装成 linux-x64，且硬编码清单与 `platforms.mjs` 重复

- 文件:行：`test/tooling/artifact-host.mjs:4-13`、`scripts/ci/platforms.mjs:1-18`
- 问题：判断条件不是“仅模拟 linux-arm64”，而是“只要不是 darwin-arm64/linux-x64 就伪装成 linux/x64”。因此 win32、darwin-x64、linux-riscv64 等本来应被拒绝的平台，在这些测试文件里会被悄悄当成 linux-x64 跑。以后新增/删除 artifact-capable 平台时，两处清单也会漂移。
- 证据：
  - `test/tooling/artifact-host.mjs:4`：`const ARTIFACT_HOSTS = ["darwin-arm64", "linux-x64"];`
  - `test/tooling/artifact-host.mjs:10-13`：只判断“不在清单里”，然后改成 `linux`/`x64`。
  - `scripts/ci/platforms.mjs:11-18`：真正的 artifact-capable 清单是 `["macos-arm64", "linux-x64"]`，与测试里的主机清单是两套表示法。
- 建议：从 `platforms.mjs` 导出一个 `isArtifactCapableHost()`/`artifactPlatformKey` 判定；只对明确的 `linux-arm64` 做模拟，其他平台让测试按未支持平台失败。这样不会掩盖“不支持的平台被错误接受”的问题。

### 4. [低] security 日志的错误码正则比 `check-security` 的净化规则更窄

- 文件:行：`scripts/ci/run.mjs:275`、`scripts/ci/check-security.mjs:714`、`scripts/ci/check-security.mjs:756`
- 问题：`run.mjs` 只接受 `^[A-Z][A-Z_]*$`；而 `check-security` 的错误码净化是 `^[A-Z_]+$`。前者会丢掉以下划线开头的固定错误码，也丢掉任何含数字的固定码。当前代码里没有这种错误码，所以现在不会实际丢信息；但两处规则不一致，后续加错误码时容易踩坑。另一个取舍是 `security-exceptions` 的原始报错现在只从 stdout 消失，仍保留在 `security-report.json`，诊断需要去看报告。
- 证据：
  - `scripts/ci/run.mjs:275`：`/^[A-Z][A-Z_]*$/.test(entry.error ?? "")`
  - `scripts/ci/check-security.mjs:714`：`error: /^[A-Z_]+$/.test(error.message) ? error.message : "SECURITY_SCANNER_FAILED"`
  - `scripts/ci/check-security.mjs:756`：`/^[A-Z_]+$/.test(error.message) ? error.message : "SECURITY_PREFLIGHT_FAILED"`
- 建议：抽一个共享的 `isErrorCode()`，至少与 `check-security` 的 `^[A-Z_]+$` 一致；如果允许数字错误码（例如 `E2BIG` 之类），统一放宽为 `^[A-Z][A-Z0-9_]*$`，并加一条对应测试。当前这条改动不会丢掉现有固定码。

### 5. [低] `quality-policy` 仍只接受 linux-x64 和 darwin-arm64，与 `supportedPlatforms()` 新增的 linux-arm64 不一致

- 文件:行：`scripts/ci/platforms.mjs:1-5`、`scripts/ci/quality-policy.mjs:66-69`、`scripts/ci/quality.mjs:176-178`
- 问题：`supportedPlatforms()` 现在说有 linux-arm64，但 quality 的 node-observation 清单仍然只允许 `linux-x64`/`darwin-arm64`。真实 ARM 上如果执行 `quality.mjs --check node-observation`，会得到 `CI_OBSERVATION_PLATFORM_UNAVAILABLE`。这符合“ARM 只跑 policy/static/security”的范围，但和“linux-arm64 是支持平台”这一表述不完全一致；`quality-local.test.mjs` 是靠 `artifact-host` 把它伪装成 x64 才通过。
- 证据：
  - `scripts/ci/quality-policy.mjs:68`：`properties: { "linux-x64": distribution, "darwin-arm64": distribution },`
  - `scripts/ci/quality.mjs:176-178`：`const platform = \`${process.platform}-${process.arch}\`; ... if (!distribution) throw new Error("CI_OBSERVATION_PLATFORM_UNAVAILABLE");`
- 建议：如果 ARM 明确不跑 quality，在 PR 说明/规则里写死这一点；否则把 `linux-arm64` 的 nodeObservation artifact 清单补上，并加真实校验。

### 6. [低] 作者说明与代码有出入

- 文件:行：`test/tooling/artifact-host.mjs:4-13`、`test/tooling/pipeline.test.mjs:95`、`test/tooling/runner.test.mjs:155-192`、`test/tooling/test-timeout-entry.test.mjs:64-115`
- 问题：
  - “在 linux-x64 和 macOS 上完全不做事”不准确。macOS arm64 不做事，但 macOS x64 会进入伪装分支，因为清单里没有 `darwin-x64`。
  - “这些文件……用的是假的执行函数”不完全准确：`pipeline`/`runner`/`test-timeout-entry`/`gate-lifecycle` 会启动真实 `git` 或真实 Node 子进程；它们只是不依赖架构。我逐个查过这 6 个文件里读 `process.platform`/`process.arch` 的位置，目前没有发现会去找 x64 可执行文件的用例。
- 证据：
  - `artifact-host.mjs:4` 的 `ARTIFACT_HOSTS` 只有 `darwin-arm64` 和 `linux-x64`。
  - `pipeline.test.mjs:95`：`execFileSync("git", ["init", "--quiet", root]);`
  - `runner.test.mjs:155-162`：真实 `execute(process.execPath, ["-e", ...])`。
- 建议：把说明改成“除 darwin-arm64/linux-x64 外的所有平台都会被伪装”，并明确 macOS x64 也会被伪装；同时把“假的执行函数”改成“有一层 mock，但部分文件仍启动真实 git/Node 子进程”。

---

## 读代码证实的

- `artifact-host.mjs` 只在 `beforeAll` 里判断主机并修改全局 `process.platform`/`process.arch`，`afterAll` 恢复；在 darwin-arm64/linux-x64 上是 no-op。
- `quality-local.test.mjs` 的新 linux-arm64 用例在测试内再显式改成 `linux`/`arm64`，因此它确实还在验证 ARM 拒绝，不会因为 helper 的全局伪装而失效。
- `runner-orchestration.test.mjs` 的 linux-arm64 用例改用不展开原描述符的 `defineProperty`，与作者描述一致。
- `run.mjs:275` 确实只打印匹配 `^[A-Z][A-Z_]*$` 的 `entry.error`；`runner-orchestration.test.mjs` 新增的原始 JSON 报错不会被打印。
- `local.mjs:30` 和 `run.mjs:87` 在创建输出目录前就拒绝 ARM 上的 build/browser/coverage；对应测试会检查输出目录不存在、`state.calls` 为空。
- `test/tooling/toolchain-platforms.test.mjs` 覆盖了 linux-arm64 缺失、文件互换、版本不一致、macOS wheel 混入等反向用例。
- `gitleaks-config.test.mjs:132`、`toolchain-lifecycle.test.mjs:77`、`check-gitleaks.mjs` 等 6 个文件之外的平台读取点，现在都能在 `ci/toolchain-lock.json` 里找到 `linux-arm64` 条目；`artifact.test.mjs` 的 schema 允许 `linux`/`arm64`。我没有找到第二个必然在真实 linux-arm64 上失败的 policy 测试。

## 推测/未核实

- 作者说“改之前 6 个文件 135 条里 59 条失败，改之后全过”：我没有运行测试，仓库里也没有提交那个预加载脚本，无法复现，标为未核实。
- “整个 tooling 项目模拟后只多出 review-gateway.test.mjs 的 5 条失败”：同理未核实。`review-gateway.test.mjs` 使用真实 `installRealGateway()`，在真实 ARM 上会选 `linux-arm64`；模拟 x64 主机时选 arm64 二进制才会失败，作者的解释方向合理，但“真实 ARM 上能过”没有证据。
- `ci/toolchain-lock.json` 里 linux-arm64 的 URL/SHA 是否能下载、解包、运行：代码只校验文件名、URL 主机和 SHA 格式，没有在 x64 CI 上实际下载这些 arm64 包；真实 ARM 也没跑过，未核实。
- 作者说“macOS 上完全不做事”：按代码只有 darwin-arm64 不做事，darwin-x64 会伪装；这是由代码直接推出的，不是推测，但作者的说法可视为不准确。

---

## 侧重检查

- 错误路径：ARM 拒绝在 `runCheck`/`local` 的早期发生，测试也验证了未创建输出；但直接调用 `build()`/`runBrowser()`/`runTests()` 仍会先做工作，见问题 2。
- 不可信输入：security 日志只接受固定错误码，原始 JSON 报错被过滤且整行经过 `redactText`；`entry.id`/`entry.status` 没有 schema 校验，但生产里是代码内固定字面量，未发现外部可注入路径。
- 安全：新增的 arm64 下载仍走原来的 `https` 白名单、文件名规则和 SHA-256 校验；没有放松下载校验。风险在于 arm64 内容从未在自动检查中真正下载/执行过，属于未验证供应链面。
- 资源耗尽：`--max-old-space-size=4096` 把 tsc 的堆上限提高到 4 GB；如果 ARM runner 内存更小，可能从“Node 堆溢出”变成“整机 OOM”。没有对实际峰值或 runner 内存做检查。
- 不可撤销操作：测试本身都在临时目录；`artifact-host` 的全局修改会在 `afterAll` 恢复。没有发现新增删除/覆盖真实数据的路径。
- 规则/文档一致性：prompt-prefix 规则未被触及；作者说明里“macOS 完全不做事”和“用的是假的执行函数”与代码不完全一致；`platforms.mjs`、`policy.json`、`check-policy.mjs`、`quality-policy.mjs` 对“支持平台”的口径没有完全统一。

---

## 必答问题

### 1. 这个改动会不会改变模型已经见过的请求开头？

不会。这个 PR 的改动集中在 `scripts/ci/`、`test/tooling/`、`ci/toolchain-lock.json`、`package.json`，没有改任何模型请求组装、系统提示、工具定义、历史消息或遮盖实现。没有新增“发给模型的内容”，更谈不上在开头还是末尾追加。`prompt-prefix.md` 的“已经发出的内容不得改动，只能在末尾追加”在这里自然满足。没有发现每轮变化的值被放进请求；本轮新增的 `linux-arm64` 平台键、security 日志行都只在 CI 内部使用。

### 2. 会不会让同一段文字在不同请求里变成不同的字节？

不会。没有改 JSON 序列化、遮盖、工具顺序或历史存储。`toolchain-lock.json` 的平台清单顺序是固定的，但它不进入模型请求；security 日志和平台 key 也不进入模型请求。因此不存在“依赖前后文的遮盖、带时间字段、无序集合”导致模型请求字节变化的问题。

### 3. 改动有没有对应的自动检查，反向用例是否真的会失败？

有，但覆盖不完整：

- `test/tooling/toolchain-platforms.test.mjs`：正向覆盖三个平台和 lock 中的 arm64 条目；反向覆盖缺 linux-arm64、linux-x64/arm64 文件互换、版本不一致、macOS wheel 混入、wheel 名/版本不一致。如果去掉 `validateToolchainLock` 里的新校验，这些反向用例会失败。
- `test/tooling/quality-local.test.mjs:578-603`：linux-arm64 上只跑 policy/static/security、拒绝 build/coverage，并验证拒绝时没有输出。若删掉 `local.mjs:30` 的前置拒绝，`check=undefined` 会先执行 policy，`state.calls` 不再为空，用例会失败；若同时删掉 `run.mjs:87`，build 会继续执行，也会失败。
- `test/tooling/runner-orchestration.test.mjs:384-403`：linux-arm64 上 build/browser/coverage 在创建输出前拒绝。若删掉 `run.mjs:87`，mock 的 build 会成功，断言会失败。
- `test/tooling/runner-orchestration.test.mjs:762-777`：security 日志只输出固定错误码。若恢复成打印所有 `entry.error`，会多出原始 JSON 报错行，精确数组断言会失败。
- `test/tooling/run-all-checks.test.mjs:80-88`：typecheck 的两个 tsc 命令必须带 `--max-old-space-size=4096`。若回退 `package.json`，正则断言会失败。

未覆盖的正是问题 1：没有自动检查在 linux-arm64 上运行这 6 个文件；`artifact-host` 的伪装分支在 x64 CI 上是 no-op；真实 ARM 的 lock 下载/安装也没有作业。作者的手工预加载验证不算仓库里的自动检查。

### 4. 每个产生/修改的值，使用它的地方都能接受吗？

逐项核对：

- `supportedPlatforms()` 新增 `linux-arm64`：消费者是 `install-tools.mjs` 的 lock 校验和 `local.mjs` 的主机检查。`ci/toolchain-lock.json` 现在为 node/python/actionlint/gitleaks/semgrep 都提供了 linux-arm64 条目，`validateToolchainLock` 的 `fields(...)` 要求恰好三套平台键，仓库 lock 满足。
- `buildPlatformKey("linux","arm64") -> "linux-arm64"`：消费者是 `local.mjs` 的 summary 和 build 路径。linux-arm64 的 local 只跑 policy/static/security，不会生成 build 产物，接受。
- `artifactPlatformKey()`：消费者是 `build.mjs`、`browser.mjs`、`test.mjs`、`run.mjs`、`local.mjs`。它明确拒绝 linux-arm64，符合“不生成/读取构建产物”的目标；`verify-artifact.mjs` 仍允许 manifest 的 `os: linux, arch: arm64`，但 ARM 上构建流程已被外层拒绝，不会走到真正的消费。
- `ci/toolchain-lock.json` 的 linux-arm64 清单项：消费者是 `verifyInstalledTools`、`check-gitleaks.mjs`、`toolchain-lifecycle.test.mjs`、`gitleaks-config.test.mjs`。它们按 `installation.platform` 或 `${process.platform}-${process.arch}` 取值，条目存在；但真实下载内容未在自动检查中验证。
- `run.mjs` 的 security 错误码字符串：只作为 stdout 日志，不进入任何 schema；测试用精确字符串断言。现有固定错误码都符合新正则，没有丢失；潜在风险只是未来出现下划线开头/带数字的码。
- `--max-old-space-size=4096`：`package.json` 和 `quality.mjs` 的消费者都是 Node，参数位置正确（脚本名之前）。没有序列化/schema 消费者。
- 不一致点：`ci/policy.json`/`check-policy.mjs` 的 hosted 成员校验仍要求非 macOS 为 x64；`quality-policy.mjs:68` 的 nodeObservation 仍只接受 x64/darwin-arm64。也就是说 `linux-arm64` 这个值目前只在 `local` 和 `install-tools` 路径被接受，在 hosted policy 成员和 quality node-observation 路径不被接受。这正是 I-73 提醒的“清单里的值要逐端核对”：目前没有线上故障，因为 PR 没有把 linux-arm64 加进这些清单；但如果声称“ARM 机器跑 policy/static/security”，需要先补这两端。
