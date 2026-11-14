结论：方向基本正确（把宽容放在“生成清单”层、边界校验继续严格，不用 `--ro-bind-try`，不把 ARM 放进必过策略，这些都对），但方案现在**不能直接开工**。主要问题不是 `/lib64` 那一个函数，而是“ARM 物料仍是 x64”“出包链没有目标平台这个一等值”“工具链锁覆盖层与现有校验器冲突”“主机身份校验被改成现场探测”这几处会直接卡住 PR3 验收，并留下 I-73 型的生产者/消费者不互认。

# 证实的

## 高

### 1. ARM 包仍会装 x64 的 Python 和原生 node_modules
- 问题：方案只改“平台/ABI 字段”，但包里的 `python-3.12.10.tar.gz` 是固定 x64 发行物，`node-modules.tar.gz` 也来自 x64 构建（`better-sqlite3` 是原生模块）。在 ARM 上安装后，Python 会 `Exec format error`，SQLite 加载失败，真消息发不出去。
- 证据：
  - `scripts/delivery-mode/make-packet.py:49-50` 固定 `PYTHON_MATERIAL = ('python-3.12.10.tar.gz', 'f50d…')`，`:391-392` 校验这个 x64 摘要。
  - `scripts/delivery-mode/packet-template/install/__PKT_LABEL__-artifact-install.mjs:53-58` 解压并执行该 Python。
  - `scripts/delivery-mode/packet-template/install/collect-installer-dependencies.mjs:15` 要求 `process.arch === "x64"`；`:89` 写出 `platform`，但安装脚本 `:60-61` 读 `node-modules.json` 时**没有校验 `platform`**，只校验 node 版本和摘要。
  - `scripts/ci/install-dependencies.mjs:353-361` 在 ARM 上需要重新构建 `better-sqlite3`。
  - `packet-template/inputs/finalize-bindings.py:215`、`inputs/verify-finalize-bindings.py:83/302`、`install/S9-clean-transport.py:26` 都固定写着 `python-3.12.10.tar.gz`。
- 建议：把 Python 归档、node_modules 归档、npm-ls 证明都定义为“按目标平台区分的物料”，在 ARM 上现场构建/收集；安装脚本增加 `dependencies.platform === "<artifact platform>"` 校验；所有 finalize/S9/verify 消费者同步。反向用例：x64 node_modules 装到 ARM 必须失败，反之亦然。

### 2. 出包链没有“目标平台”这个一等值
- 问题：方案说“从 artifact-record 读平台”，但 `make-packet.py` 没有目标平台参数；它直接 glob `linux-x64-abi127-`，而 `run-packet-checks.py`、`build-candidate.sh`、`run-release-walkthrough.sh` 也各自写死。若 materials 目录同时有 x64 和 ARM 产物，当前逻辑会因为“不是恰好一个”而拒绝，或者随机选中不可预期的包。
- 证据：`scripts/delivery-mode/make-packet.py:385/428`；`scripts/delivery-mode/run-packet-checks.py:163`；`scripts/delivery-mode/hermes/build-candidate.sh:44/46`；`scripts/delivery-mode/hermes/run-release-walkthrough.sh:31`。
- 建议：给 `make-packet.py prepare` 增加显式 `--target-platform linux-x64|linux-arm64`（或 `--artifact-record`），所有 glob 改成按 `os/arch/abi` 精确匹配；把 `ARTIFACT_PLATFORM`、`ARTIFACT_ARCH`、`ARTIFACT_ABI` 写进 packet 参数，并让 seal、安装、回执、`run-packet-checks` 逐端交叉校验。测试：两种产物同时存在时必须明确选一种，缺目标产物时必须拒绝。

### 3. 工具链覆盖层与现有校验器不兼容，且 `toolchainSha256` 会把 ARM 工具链记成 x64
- 问题：方案说“新增独立的 `ci/toolchain-lock.linux-arm64.json`，只在 ARM 上合并进内存；第一步只放 Node、Python”。但 `validateToolchainLock` 要求顶层字段完整、平台键**精确等于** `["darwin-arm64","linux-x64"]`；Semgrep wheels 也要求精确平台键。部分 ARM 锁无法通过校验；把 `platforms` 改成包含 `linux-arm64`，主 x64 锁又会因为缺少该键而失败。另外 `context.mjs:143` 和安装记录只哈希主锁文件，ARM 安装的记录会声称自己用的是 x64 工具链锁。
- 证据：`scripts/ci/install-tools.mjs:25`、`:80-83`、`:121`、`:137-152`、`:247-251`、`:461-473`、`:417/567`；`scripts/ci/context.mjs:143`。
- 建议：先按现状校验主锁，再在**校验之后**做 ARM 覆盖；不要改全局 `platforms`，或改成“每个锁文件声明自己的平台键集合”。ARM 的安装/上下文需要单独的 `toolchainSha256`（新增本地字段，保持 x64 context 字节不变），否则就要在文档里明确“toolchainSha256 只证明主锁”。测试：x64 context 与 installation 记录逐字节不变；ARM 记录能指出实际用的 ARM 锁。

### 4. 两套平台命名被一个函数合并
- 问题：构建产物名用 `macos-arm64`，工具链锁键用 `darwin-arm64`。方案说“新增统一平台名函数，替换前提 6 的各处”，但前提 6 包含 `install-tools.mjs:25` 的 `darwin-arm64`。若统一成 `macos-arm64`，macOS 工具链键找不到；若统一成 `darwin-arm64`，构建产物名又会与 `build.mjs`/`local.mjs` 不一致。
- 证据：`scripts/ci/local.mjs:38`、`build.mjs:133`、`run.mjs:283/477/561`、`test.mjs:151`、`browser.mjs:128` 用 `macos-arm64`；`install-tools.mjs:25/464` 用 `${process.platform}-${process.arch}` 即 `darwin-arm64`；`scripts/ci/quality-policy.mjs:68` 也用 `darwin-arm64`。
- 建议：明确两个函数/两个域：`buildPlatformName()` 输出 `macos-arm64|linux-x64|linux-arm64`；`toolchainPlatformKey()` 输出 `darwin-arm64|linux-x64|linux-arm64`。只给工具链域新增 `linux-arm64`，不要改 macOS 键。

### 5. 主机身份校验从“固定事实”改成“现场探测”，削弱来源证明
- 问题：方案把构建身份的平台、主机名、uid 改成配置字段，并让 ARM“用现场探测生成的配置”。这等于把“构建必须发生在指定机器/用户”变成“机器自己说自己是谁”，校验就被绕过了。而且不只是 `capture-build-source-inputs.template.mjs:115`，同一文件的 `:96/119/126/127` 也硬编码 uid 1000；`install` 脚本、工具准备、验收脚本还硬编码 `hermes-home`/`__PKT_HOSTNAME__`。方案只列了其中一处，范围不够。
- 证据：`scripts/delivery-mode/hermes/capture-build-source-inputs.template.mjs:96/115/119/126/127/139`；`packet-template/install/__PKT_LABEL__-artifact-install.mjs:19-20`；`packet-template/acceptance/cloud/prepare-runtime-tools.py:24`；`packet-template/acceptance/cloud/basis-04/run-stage-03.py:95`；`packet-template/acceptance/cloud/run-network-preparation.py:45`。
- 建议：ARM 使用**提交进仓库的固定测试 profile**（明确主机名、uid、平台、架构），不要从当前机器探测生成期望值；继续拒绝 root；保留 x64 的默认值逐字节不变；增加反向用例：主机名/uid/架构不匹配必须失败。把所有硬编码主机身份的脚本列全并统一从 profile 取。

## 中

### 6. `/lib64` 修复范围不全
- 问题：方案列出的位置不够。除了它列的测试夹具/探针，至少还有：
  - `scripts/delivery-mode/packet-template/measurement/probe/read-driver.mjs:43`
  - `packet-template/acceptance/cloud/adapters/probe-foreground.mjs:100`、`probe-authorized-network.mjs:81`、`probe-public-search.mjs:40`、`probe-linux-worker-loss.mjs:35`、`probe-network-boundary.mjs:72`
  - `packet-template/acceptance/cloud/basis-04/` 下的同名副本
  - `packet-template/acceptance/cloud/basis-04/run-network-preparation.py:20`（fd 的 x86_64 下载，方案只提了 `download-question-12.py:14`）
  - `basis-04/run-stage-03.py:253/478` 的 `linux-x64` 正则与 `build-linux-x64` 目录
- 建议：用一次全仓 grep 生成清单，而不是按方案列表逐个改；把“未加保护地 realpath `/lib64`”做成一个检查（例如只允许出现在白名单文件里），以后新增探针会被拦下。

### 7. `isolation.ts` 的改动依据不成立
- 问题：方案说自检无条件 `--symlink usr/lib64 /lib64` 是问题。bubblewrap 官方文档写明 `--symlink SRC DEST` 只是“在 DEST 创建指向 SRC 的符号链接”，**不要求 SRC 存在**。所以在没有 `/usr/lib64` 的 ARM 上，这个悬空链接本身不会让自检失败；改它反而引入宿主依赖，并且现有假 bwrap 测试 `capability-isolation.unit.test.ts:99` 明确要求这段参数。
- 证据：[bwrap.xml 的 `--symlink` 条目](https://raw.githubusercontent.com/containers/bubblewrap/main/bwrap.xml)（“Create a symlink at DEST with target SRC”）；`packages/platform-node/test/capability-isolation.unit.test.ts:93-102`；`packages/platform-node/src/capabilities/isolation.ts:528-554`。
- 建议：先在没有 `/usr/lib64` 的 ARM 环境跑一次现有自检，确认是否真的失败；若没失败，**不要改**。若确实要按存在性加，必须注入探测并同步修改假 bwrap 测试，且说明这只是卫生问题，不是修复根因。

### 8. 可选判定过粗，且只看 `/lib64`
- 问题：用 `realpath` 的 `ENOENT` 判断“可选条目不存在”，会把**悬空符号链接**也当成“不存在”跳过；如果 `/lib64` 是一个坏链接，x64 上也会被静默丢弃。另外 ARM 发行版并不都缺 `/usr/lib64`（例如 Fedora/RHEL aarch64 有），只处理 `/lib64` 可能漏掉真正需要绑定的 `/usr/lib64`。
- 证据：`scripts/delivery-mode/packet-template/signing/cloud-seal.mjs:334-364`；`packages/runtime-sandbox/src/policy.ts:64-72`。
- 建议：可选条目先 `lstat`：只有路径本身不存在才跳过；`lstat` 成功但 `realpath` 失败（悬空链接）应当报错。可选组同时考虑 `/lib64` 和 `/usr/lib64`；并按现有 x64 行为做 golden。若担心被替换，再校验目标属主为 root、不是用户可写目录。

### 9. x64 基线是手工比对，不是自动门槛；`runtimeDigest` 也会变
- 问题：方案说“改前记录、改后逐值比对”，这不能防以后回归。更关键的是：把新函数放进 `packages/runtime-sandbox/src` 会改变 runtime 构建产物，`digestSandboxRuntime` 的 `runtimeDigest` 在 x64 上也会变，seal 清单和资格回执里的这个值不可能“逐值不变”。另外如果新函数被 `job-host-main.ts`/`sandbox-sdk*.ts` 引用，会触发 `check:probe-sources`，而且只改 `probe-sources.json` 不够，探头里的 built digest 需要真实构建（I-79 的教训）。
- 证据：`scripts/check-probe-sources.mjs:6-11`、`:111-125`；`scripts/delivery-mode/probe-sources.json`；`docs/incidents-and-gates.md:117`（I-79）；`packet-template/signing/cloud-seal.mjs:322`（`runtimeDigest` 进入清单）。
- 建议：加自动化 golden：x64 的 seal `readOnlyToolchainPaths`、policy digest、自检参数单独做快照；明确把 `runtimeDigest`/源码哈希列为“预期变化”并更新签名基线，不要承诺它不变。新函数放在**不被 probe-sources 跟踪**的新文件里；若必须改那三个文件，计划里写明要在 Hermes/ARM 上重新构建探头并更新 built digest。

### 10. 模型可见命令清单与实际清单可能分歧
- 问题：模型看到的“可用命令”由 `SANDBOX_READ_ROOTS` 常量计算（`service-main.ts:236`），而实际绑定清单在 ARM 上会过滤掉 `/lib64`。如果某个命令的链接落在 `/usr/lib64`，清单可能告诉模型“可用”，沙箱却没绑定。方案说“SANDBOX_READ_ROOTS 不变”，这在 x64 上没问题，但在 ARM 上制造了两端不一致。
- 证据：`apps/agent-service/src/sandbox-command-inventory.ts:4-22`、`:70-86`、`:118`；`apps/agent-service/src/service-main.ts:236`；`packet-template/signing/cloud-seal.mjs:334-353`。
- 建议：让 `inspectSandboxCommands` 接受实际 host binding 的 `readOnlyToolchainPaths`（或对同一过滤函数处理两边），并加一个 ARM 夹具测试：清单里可用的命令，其链接目标必须在绑定清单内。

### 11. 本地 ARM 合成 policy 成员会绕过检查；`aggregate.mjs` 仍写死 x64
- 问题：`run.mjs` 的 `selectCheck` 只认 `ci/policy.json` 里的矩阵成员，`local.mjs` 直接传 `linux-arm64` 会 `CI_MATRIX_UNSUPPORTED`。方案说“合成一个 linux-arm64 成员”，这是本地代码绕过策略检查；同时方案明确不改 `aggregate.mjs`，但它 `:201` 仍把消费产物平台写死为 `linux-x64`。如果本地 ARM 的 build 结果以后走到 aggregate，就会错标。
- 证据：`scripts/ci/run.mjs:46-47`、`:89`；`scripts/ci/local.mjs:73-80`；`scripts/ci/aggregate.mjs:201`。
- 建议：定义显式的“本地证据 profile”，不要无痕修改 policy；若 aggregate 可能处理 ARM，至少改成按 build 产物取平台；加测试：托管环境（`GITHUB_ACTIONS=true`）不允许合成成员，本地合成成员带明确 scope。

### 12. ARM 上的 `npm test` 还缺浏览器和系统依赖
- 问题：`npm test` 是 `local.mjs --check coverage`，会跑需要 Playwright 的测试；仓库的托管流程是单独 `playwright install`，而方案说“第一步只放 Node、Python”。Playwright 从 1.62 起支持 Linux arm64，但需要安装浏览器和系统依赖；不装的话 ARM 上 `npm test` 不会“通过”。
- 证据：`package.json` 的 `"test": "node scripts/ci/local.mjs --check coverage"`；`.github/workflows/ci.yml:96/217/261` 有单独的 Playwright 安装步骤；[Playwright 系统要求](https://playwright.dev/docs/intro#system-requirements)（Debian 12/13、Ubuntu 22.04/24.04，x86-64 或 arm64）；[Playwright 发布说明](https://playwright.dev/docs/release-notes)（Linux arm64 使用 Chrome for Testing 构建）。
- 建议：ARM 本地也显式执行 `playwright install --with-deps`，或把覆盖测试限制在不依赖浏览器的项目；在验收里写清“npm test”到底包含哪些 project，避免“通过”定义模糊。

## 低

### 13. EACCES 反向用例在 root 下可能假通过
- 问题：方案要求“EACCES 必须抛”，但测试若以 root 运行，`chmod 000` 仍可读，反向用例不会真的失败；用临时目录 chmod 也很难稳定制造 EACCES。
- 证据：`packages/runtime-sandbox/src/policy.ts:64-72` 的严格 realpath；方案自己的反向用例描述。
- 建议：给路径解析函数注入 fs 操作（或注入 `realpath`/`lstat`），用 stub 明确返回 `EACCES`、`ENOENT`、悬空链接三种情况；并做一次“撤掉实现，测试必须失败”的变异验证。

### 14. fd 下载有两份，SHA 未核实
- 问题：方案只提 `download-question-12.py:14`，但 `basis-04/run-network-preparation.py:20` 还有一份 x86_64 URL；两处都写死了成员路径和输出文件名（`download-question-12.py:88/100`；`run-network-preparation.py:107/118`）。aarch64 资产名和 SHA 需要从官方 release 的校验文件取，不能凭记忆。
- 证据：上述行；方案自己写“未核实 aarch64 文件名/SHA”。
- 建议：把架构→URL/SHA/成员名做成一个清单（或每个平台一份），两处共用；下载后校验 SHA；从 [sharkdp/fd releases](https://github.com/sharkdp/fd/releases/tag/v10.5.0) 的官方 `.sha256` 取值。

### 15. `deploy-preflight.py` 解析源码字面量，不解析生成清单
- 问题：它从 seal 源码的 `readOnlyToolchainPaths: [` 到 `protectedPaths: [` 之间抽字面量。方案保留 `/lib64` 字面量后，x64 检查能过；但在 ARM 上，生成的清单已经过滤掉 `/lib64`，deploy-preflight 仍然会把 `/lib64` 传给 `sandbox-command-links.py`。虽然该脚本对不存在的根只做字符串匹配、不会报错，但“检查的和实际用的不是同一个值”是 I-73 型的隐患。
- 证据：`scripts/delivery-mode/deploy-preflight.py:83/123-128/153/233`；`scripts/delivery-mode/sandbox-command-links.py:14-19`。
- 建议：要么让 deploy-preflight 读生成好的 host binding，要么明确 ARM 永远不走这条预检；并在文档里写清这个限制。

### 16. 引用依据语境不贴切
- 问题：方案引用 Anthropic sandbox-runtime 的“A directory that is not there is skipped: bwrap cannot bind a missing source”。这句话确实存在，但上下文是**给 deny 路径做 pin**，不是“只读 allow 清单”。用它来证明“可选系统目录可以跳过”方向没错，但论证不够贴切；本仓库 `check-srt-boundary.mjs:149-165` 的 `existsSync` 先过滤更直接。
- 证据：[linux-sandbox-utils.ts](https://raw.githubusercontent.com/anthropics/sandbox-runtime/main/src/sandbox/linux-sandbox-utils.ts) 中该注释位于 pin/mount 逻辑；`packages/runtime-sandbox/scripts/check-srt-boundary.mjs:149-165`。
- 建议：改引本仓库已有先例，或明确说明“这是 deny pin 的同类原则，不是同一函数”。

### 17. 文档/ADR/事故门槛没有纳入方案
- 问题：仓库对边界、交付、事故门槛有明确文档纪律；方案没有说更新哪份设计文档/ADR，也没有说给 `check:prompt-prefix`、`check:delivery-packet`、`check:delivery-deploy` 增加什么新用例。尤其是“ARM 包是非生产候选”这个值，如果没有文档和签名/校验门槛，以后很容易被绕开。
- 证据：`docs/incidents-and-gates.md:112`（I-73）；`.claude/rules/prompt-prefix.md:74/84`；方案本身没有文档清单。
- 建议：加一份 ADR/设计记录，写清“可选路径的判定规则、两套平台名、ARM 非生产标记、x64 基线”；把关键反向用例挂到现有 `check:*` 门槛上。

# 未核实/推测

以下没有在代码或一手资料中确认，方案应标为待验证，不能当既成事实：
- “integration 198 失败中 101 条是 `ENOENT realpath '/lib64'`”只有机器实测来源，仓库里没有记录；而且实际 `/lib64` 调用点比方案列的多。
- “ARM 机没有 `/lib64`、`/usr/lib64`”只对特定发行版成立；Fedora/RHEL aarch64 可能有 `/usr/lib64`。
- SRT npm 包在 ARM 上是否附带 arm64 seccomp helper/BPF，需在实际安装后确认；源码里的 arm64 哈希只能说明上游支持。
- semgrep、gitleaks、actionlint 的 linux-arm64 发行物是否齐全；方案已决定先不跑扫描器，但这也意味着 ARM 上不能声称“完整检查”。
- Playwright 在该 ARM 机器上的系统依赖、WebKit/Firefox 是否可用；官方文档支持 Debian/Ubuntu arm64，但发行版和依赖仍需现场验证。
- fd v10.5.0 的 aarch64 资产名和 SHA 是否如方案预期；需要官方 release 校验文件。
- ARM 机上 bwrap 0.11.2、socat、apparmor profile 是否在 `cloud-seal` 要求的固定路径；`cloud-seal` 还要求 root 和固定 `/var/lib/himawari`、`/opt/himawari` 布局。
- `isolation.ts` 自检在无 `/usr/lib64` 的 ARM 上是否真的失败；按 bwrap 文档推测不会。
- `npm test` 在 ARM 上具体会跑哪些 vitest project、是否包含需要 x64-only 二进制的测试。
- `JOB_HOST_NOT_READY` 等其余失败是否都是 `/lib64` 的连带。

# 侧重检查

- **错误路径**：方案的“可选 ENOENT 跳过、必选缺失抛错、EACCES 抛错”方向正确；但 `realpath` 的 ENOENT 同时覆盖“路径不存在”和“悬空符号链接”，会静默吞掉坏主机；EACCES 反向用例在 root 下不可靠。应注入 fs、区分 `lstat` 与 `realpath`，并保留 policy 的严格校验。
- **不合规范/不可信输入**：`node-modules.json` 的生产者写了 `platform`（`collect-installer-dependencies.mjs:89`），消费者安装脚本没校验（`__PKT_LABEL__-artifact-install.mjs:60-61`）；`make-packet.py` 的生产者没有目标平台一等值；`toolchainSha256` 生产的是主锁摘要，ARM 实际用的是另一份锁。这些都是 I-73 型问题。签名/回执端 `cloud-protected-prepare.mjs:38-41` 已经绑定 host/platform/arch，方向对，但包物料和工具链没有同样绑定。
- **安全**：可选路径如果被替换成指向用户可写目录的符号链接，会变成额外只读暴露面；建议校验属主和规范化路径。ARM 测试机上执行 `cloud-seal` 需要 root 并写生产式路径，必须使用一次性机器/独立签名密钥，绝不能带生产签名密钥。ARM 包的“非生产候选”如果是可手改的字段，等于没有保护；应是签名回执/构建产物的一部分，并让安装脚本和 deploy 预检都拒绝生产用途。
- **资源耗尽**：ARM 包会同时需要 ARM Python、ARM node_modules，体积和构建时间都翻倍；`npm test` + Playwright + 可能的原生编译需要磁盘和 CPU。方案应明确不在同一个 packet materials 目录里混放 x64/ARM，避免 `make-packet` 的“恰好一个”逻辑和磁盘压力。
- **不可撤销操作**：`cloud-seal`/安装写 `/var/lib/himawari`、`/opt/himawari`，删改不可逆；测试机应一次性、无生产数据、无生产密钥。ARM 包的安装目标必须显式拒绝生产 `purpose`，不能只靠 deploy 预检。
- **规则/文档/代码一致性**：问道 1 的规则与方案结论一致（不改请求开头）；但方案没有列文档/ADR 更新，也没有把“ARM 非生产”写成可执行门槛。`.claude/rules/prompt-prefix.md:74/84` 要求任何可能改请求开头的改动先出方案，本方案做到了；下一步应把新增门槛写进 `docs/incidents-and-gates.md` 和相应 ADR。

# 如果由我定，我会这样改这份方案

1. **先做 PR0：清点和门槛，不改行为。** 全仓 grep `/lib64`、`linux-x64`、`process.arch`、`hermes-home`、`__PKT_HOSTNAME__`、`python-3.12.10.tar.gz`、`node-modules.json`，生成清单；加一个检查：未列入白名单的 `/lib64` 直接失败。把方案列的 101 条失败按文件归类，确认到具体调用点。
2. **PR1 只做根因，不动 `isolation.ts`。** 写一个 `optionalRealpath`：输入按顺序，`lstat` 区分“不存在”和“悬空链接”，只对前者跳过；可选组含 `/lib64` 与 `/usr/lib64`；放在新文件里，避免碰 probe-sources 跟踪的三个源码。调用点改 seal、测试夹具、探针；policy 继续严格。x64 用 golden 测试而不是手工比对。
3. **PR2 做 ARM 本地证据，不碰托管策略。** 两个平台名函数；主锁文件不动，ARM 覆盖在校验之后；ARM 工具链摘要是独立值；`local.mjs` 用显式本地 profile，不用无痕修改 `ci/policy.json`；`aggregate` 若可能处理 ARM 就改成按产物取平台；ARM 上显式安装 Playwright 浏览器/系统依赖，或缩小 `npm test` 的 project 范围。
4. **PR3 做平台化出包。** `make-packet.py` 加显式目标平台；Python、node_modules、npm-ls、fd 全部按平台；安装脚本校验 `dependencies.platform`、artifact record、`materials.purpose` 三者一致；生产用途拒绝 ARM；ARM 主机身份用提交进仓库的固定 profile，不从现场探测。加负向矩阵：x64/ARM 包互换、回执互换、x64 node_modules 装 ARM、ARM 包走生产 purpose，都必须失败。
5. **PR4 验收。** 在一次性 ARM 机器上跑：`npm test`（明确 project 范围）、`check:srt-boundary`、真实沙箱探针、seal、资格回执、真消息收发；x64 跑值级 golden 和 `check:prompt-prefix`/`check:delivery-*`。同时写 ADR/文档和事故门槛。

# 必答问题

**1. 这个改动会不会改变模型已经见过的请求开头？**
不会，前提是方案只改沙箱清单、CI 和交付链，不改系统提示、工具定义、历史或遮盖。模型可见的运行环境说明仍是最后一条用户消息，`production-run-policy.ts:87-89` 生成、`runtimeEnvironmentNotice` 在 `:192-239` 组装，现有 `check:prompt-prefix` 守只追加。需要注意两点：
- 方案说“模型唯一可见的是沙箱可用命令”不准确；运行环境说明还包括工作目录、文档技能目录、搜索/抓取服务商（`production-run-policy.ts:204-237`），ARM 上这些路径/值也可能不同，但它们仍应只出现在最后一条消息。
- `SANDBOX_READ_ROOTS` 本身不变，但模型可见命令是按该常量算的（`service-main.ts:236`），实际绑定清单在 ARM 上会变；若两边不一致，模型会被误导。这不是前缀问题，但要修（见中 10）。
建议加一条检查：ARM 变化只允许出现在“本轮追加的运行时环境说明”，不得改写此前的系统提示/历史/遮盖。

**2. 会不会让同一段文字在不同请求里变成不同的字节？**
不会自动发生，但方案有两个风险：
- 产品侧和 packet 侧各放一份“同逻辑”函数，若实现漂移，同一输入会产生不同清单字节；应单源生成或加字节级一致性检查。
- 新函数按宿主文件系统存在性过滤，同一份源码在不同机器上生成不同清单字节；这不进模型提示，但会进入签名清单/回执，必须明确这是“按宿主机绑定”，并用保序、去重、固定 JSON 键顺序的方式序列化。
- `runtimeEnvironmentNotice` 里的命令清单必须来自确定的候选顺序（`SANDBOX_COMMAND_CANDIDATES` 已固定），不能依赖 `readdir` 顺序；现有 `inspectSandboxCommands` 用候选顺序过滤，符合要求。
结论：只要坚持“固定顺序 + 单源/一致性检查 + 不把宿主探测结果放进历史”，就没有问题；现方案的“两处同逻辑”需要补一致性门槛。

**3. 有没有对应的自动检查？反向用例真的会失败吗？**
方向有，但不够，且反向用例的可行性要验证：
- 方案已有：EACCES 抛、必选缺失抛、policy 拒绝不存在路径、x64 `/lib64` 仍在清单。
- 缺：ARM 形态夹具（无 `/lib64`/无 `/usr/lib64`）生成清单并通过 policy；悬空符号链接必须抛而不是跳过；两处 helper 字节一致；`make-packet` 目标平台选择；x64/ARM 包与回执互换必须拒绝；`dependencies.platform` 与 artifact platform 不一致必须拒绝；工具链覆盖层在 x64 主锁上校验通过、ARM 覆盖后也通过；`local` 合成成员在 `GITHUB_ACTIONS=true` 下必须拒绝；没有未加保护的 `/lib64` realpath。
- 现有 EACCES 用例若以 root 跑会假通过；需要注入 fs 或明确非 root 测试环境。所有反向用例应在旧实现上确认会失败（变异验证），否则等于没进门槛。

**4. 每个新值、每个使用它的地方都能接受吗？**
不能，逐个核对后发现这些两端不一致：
- `readOnlyToolchainPaths`：`policy.ts:64-72`、`sandbox-host-verifier.ts:252-255`、`production-sandbox-control.ts:883/943` 都能接受较短的列表；但模型可见命令用的是 `SANDBOX_READ_ROOTS`，不读实际清单，ARM 上可能分歧（中 10）。
- 平台名：构建域用 `macos-arm64`（`local.mjs:38` 等），工具链域用 `darwin-arm64`（`install-tools.mjs:25`、`quality-policy.mjs:68`）。一个函数覆盖两域会坏（高 4）。
- `toolchainSha256`：`context.mjs:143` 和 `install-tools.mjs:417/567` 都只哈希主锁；ARM 覆盖后仍记主锁摘要，消费端 `aggregate.mjs:289`、`check-coverage.mjs:134`、`main-evidence.mjs:218` 都会接受这个“错身份”（高 3）。
- ARM 锁键：`validateToolchainLock` 的 `platformArtifacts`/`semgrep.wheels` 要求精确平台键；部分 ARM 锁无法通过（高 3）。
- artifact platform/abi：`build.mjs:106-115` 产出 `{os,arch,abi}`，`verify-artifact.mjs:34-51` 接受 `arm64`；但 `make-packet.py:385/428`、`run-packet-checks.py:163`、`build-candidate.sh:44/46`、`run-release-walkthrough.sh:31` 仍写死 `linux-x64-abi127-`（高 2）。
- `dependencies.platform`：`collect-installer-dependencies.mjs:89` 产出，`__PKT_LABEL__-artifact-install.mjs:60-61` 不校验（高 1）。
- `python-3.12.10.tar.gz` / SHA：`make-packet.py:49-50/391-392`、`finalize-bindings.py:215`、`verify-finalize-bindings.py:83/302`、`S9-clean-transport.py:26`、安装脚本 `:53-58` 都固定 x64 文件名/SHA（高 1）。
- hostname/uid：`capture-build-source-inputs.template.mjs:96/115/119/126/127`、`__PKT_LABEL__-artifact-install.mjs:19-20`、`prepare-runtime-tools.py:24`、`run-stage-03.py:95` 等各自硬编码；方案只改一处不够（高 5）。
- fd URL/SHA：`download-question-12.py:14-15/88/100` 与 `basis-04/run-network-preparation.py:20/107/118` 两份（低 14）。
- `runtimeDigest`：新 helper 放进 `packages/runtime-sandbox/src` 后 x64 也会变；seal/回执消费它（高 9）。
结论：方案“逐个交叉校验”的方向对，但现在只写了原则，没有把这些具体两端的校验列全；按 I-73 的教训，必须把每个值在“产生处”和“使用处”都点名并写测试。
