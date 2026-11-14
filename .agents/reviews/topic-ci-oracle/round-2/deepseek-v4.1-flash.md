## 结论摘要

方向上有合理的部分：不搬 `build`/`browser`/`coverage`、报告仍走摘要核对、Oracle 离线时回到 CI 服务器，这些都符合现有 ADR 0238/0243 的约束。但这份方案在几个关键处站不住：

- 把长期 SSH 私钥放在会执行 PR 代码的测试机上，再用一个“仓库里的接收脚本”作为唯一边界；这个边界比方案描述得弱。
- 接收账号要能写共享目录，就必然能删改别的运行；ADR 0238 已经明确承认这一点，方案却写成“只能送一份新报告”。
- 共用标签让必过检查在 x64/ARM 间不确定，方案只做一次手工对比，没有持续门槛。
- 新标签、新字段、新锁文件条目、`push` 命令的消费者并没有全部更新；有几处会直接失败或静默标错平台。

下面按严重度排列。**“证实的”**是仓库代码或方案原文能直接支持的；**“推测/未核实”**单独列。

---

## 证实的发现（高）

### 1. 强制命令若执行 PR 检出里的脚本，接收账号会被 PR 代码接管

**严重度：高**

**问题**：方案说公钥带 `restrict,command="…"`，只执行“仓库里的一个接收脚本”。但 CI 服务器上的 runner 检出的是 PR 合并提交，PR 代码可以改这份检出里的任何文件；`gh-runner.service.in:36` 又把 runner 的工作目录设为可写。只要 `command=` 指向工作区里的脚本（或脚本从工作区 `import`），恶意 PR 就能让接收账号执行自己的代码，接收账号的约束就失效了。

**证据**：
- `scripts/operations/ci-runner/gh-runner.service.in:36`：`ReadWritePaths=@ROOT@/runner @ROOT@/home @ROOT@/logs @SHARE@`
- `.github/workflows/ci.yml:43-46`：`actions/checkout` 检出 PR 合并提交。
- 方案原文：“只执行仓库里的一个接收脚本”。

**建议**：`authorized_keys` 的 `command=` 必须指向 **root 所有、不可被 runner 写**的路径（例如 `/usr/local/libexec/himawari-ci-receive`），脚本不得从工作区加载模块；账号 shell 设为 `nologin`，`~/.ssh` 设为 root 只读或通过 `AuthorizedKeysCommand` 管理。OpenSSH 的 `command=`/`restrict` 语义本身没问题（https://man.openbsd.org/sshd#AUTHORIZED_KEYS_FILE_FORMAT），问题在“脚本放哪里”。

### 2. 接收账号对共享目录的组写权限，等于能删改别的运行

**严重度：高**

**问题**：接收账号必须能写 `/srv/gh-runner-share`，而该目录是 `root:gh-ci-share 2770`，接收账号要进 `gh-ci-share` 才能写；一旦进了组，它就能读写、删除**所有** run 目录，不只是本次运行。摘要核对只能发现“存进去之后内容被改”，挡不住“把别的运行的报告删掉/改名/抢先创建”，结果是 DoS，不是完整性。方案“只能往共享目录里送一份新报告”的说法不成立。

**证据**：
- `docs/adr/0238-ci-job-files-stay-on-the-ci-vps.md:91`：“两个 runner 的任务都能读写整个共享目录，所以一个任务能读、改、删共享目录里任何一轮运行的文件……摘要核对能发现文件在存和取之间被改，但挡不住有意改摘要的任务。”
- `docs/adr/0238-ci-job-files-stay-on-the-ci-vps.md:66-69`：共享目录属主 root、组 `gh-ci-share`、权限 `2770`，runner 用 `SupplementaryGroups=gh-ci-share`。
- `scripts/ci/run-share.mjs:17-20`：`SHARED_MODE=0o2770`。
- 方案原文：“接收脚本只接受……目标已存在就拒绝……能塞满 CI 服务器磁盘是剩下的风险”。

**建议**：接收账号不要直接写共享根目录。让它写一个独立的 inbox（例如 `/srv/gh-ci-inbox/<run>/<name>`，只允许接收账号写、runner 只读），由 CI 服务器上的可信步骤在校验后原子移动到共享目录；或者用 ACL 只给“新建/写入”权限，不给已有 run 目录的删除权限。这样“只能送新报告”才成立。

### 3. tar 是不可信输入，方案的解包防护不完整

**严重度：高**

**问题**：方案只列了“符号链接、跳出目录的路径、超过大小上限”。真实 tar 攻击面还包括：硬链接（指向宿主机文件）、设备/FIFO/特殊文件、绝对路径、`..` 段、setuid/setgid 位、稀疏文件、gzip 解压炸弹、先建符号链接再往里写、超多条目耗尽 inode。只限制压缩后大小不能限制解压后大小；只检查条目名字不检查“解析后的真实路径”也不够。任何一处漏掉，攻击者就能以接收账号写任意可写路径（包括 `~/.ssh/authorized_keys`），从而持久化。

**证据**：
- 方案原文：“拒绝符号链接、跳出目录的路径和超过大小上限的内容”。
- `scripts/ci/artifact-files.mjs:46` 只在**读取报告**时拒绝符号链接，不是接收端的解包器。
- `scripts/operations/ci-runner/clean-old.sh:24-26`：共享目录的兜底清理是 6 小时；`job-started.sh:17` 只检查 16 GiB 可用空间，不能限制单个上传。

**建议**：不要自己写 tar 解析器。用经过审计的解包库，或让 OpenSSH 官方 `rrsync`（https://github.com/openssh/openssh-portable/blob/master/contrib/rrsync）承担受限目录内的 rsync 接收；如果必须用 tar，先枚举条目并拒绝所有非普通文件/硬链接/特殊文件/绝对路径/`..`，再在全新目录中解包，限制总条目数、单文件大小、解压后总字节，解包后用 `treeDigest` 校验；接收进程放进独立 systemd 服务，设 `MemoryMax`、`TasksMax`、`IPAddressDeny=any`、`ProtectSystem=strict`、`PrivateTmp`。

### 4. Oracle 上的 PR 代码能读测试数据和配置；现有 systemd 限制不隐藏文件

**严重度：高**

**问题**：方案说“runner 用户读不到别的用户的家目录”，但 `ProtectHome=yes` 只隐藏 `/home`、`/root`、`/run/user`；`ProtectSystem=strict` 只是把文件系统变**只读**，不是**不可见**。如果测试数据/配置在 `/srv`、`/opt`、`/var/lib` 等位置，runner 用户仍可读；防火墙只按 runner UID 拒绝私有网段和本机端口，公网出口仍开放，读到的数据可以外传。这台机器“上面有测试用的数据和配置”，这正是与 CI 服务器最大的差别。

**证据**：
- `scripts/operations/ci-runner/gh-runner.service.in:31-37`：`ProtectSystem=strict`、`ProtectHome=yes`、`ReadWritePaths=...`、`InaccessiblePaths=-/run/docker.sock -/var/run/docker.sock -@OTHER_ROOT@`。
- `scripts/operations/ci-runner/runners.sh:59-72`：防火墙只按 UID 拒绝私有地址/本机端口，不限制公网。
- 方案原文：“runner 用户读不到别的用户的家目录，但 GitHub 官方说明自托管 runner 上的代码可以留下长期后门”。

**建议**：给所有测试数据/配置路径加 `InaccessiblePaths`（或把 runner 放进只挂载工作区的容器/VM）；不要依赖“家目录隐藏”；把测试数据和 CI 放在不同机器是最稳的。至少要在安装脚本里列出并验证这些路径，而不是只写一句“读不到”。

### 5. 长期 SSH 私钥放在 PR 可读的 Oracle runner 家目录，强制命令不防泄露/重放

**严重度：高**

**问题**：方案明确说“跑在 Oracle 上的 PR 代码读得到这把私钥”。`command=`/`restrict` 只限制这把钥匙在 CI 服务器上能做什么，不能阻止 PR 代码把私钥带走、在别处重放，也不能阻止它用合法格式反复上传、抢占别人的 `run/name`。这是一把长期凭证，违反“不可信代码旁边不放长期凭证”的常规做法。

**证据**：
- 方案原文：“私钥放在 Oracle 机器 runner 用户的目录里……跑在 Oracle 上的 PR 代码读得到这把私钥”。
- `scripts/operations/ci-runner/gh-runner.service.in:36`：runner 家目录在 `ReadWritePaths` 内。
- GitHub 官方原话（方案前提 14 引用）：https://docs.github.com/en/actions/reference/security/secure-use ：“Self-hosted runners for GitHub do not have guarantees around running in ephemeral clean virtual machines, and can be persistently compromised by untrusted code in a workflow.”

**建议**：最稳的是把方向反过来——由 CI 服务器的可信步骤 SSH 到 Oracle **拉取**报告，私钥只放在 CI 服务器（它本来就运行 PR 代码，信任边界没有变），Oracle 上不放任何能连 CI 服务器的钥匙。或者用 GitHub OIDC 换取每次运行的短期凭证（https://docs.github.com/en/actions/concepts/security/openid-connect），不要把长期私钥交给测试机。若保留 push，至少加 `from=` 限制、密钥轮换、每 run 的一次性 token、上传速率/配额；这些仍不如反向拉取。

### 6. 暂停/恢复只操作一个标签；CI 服务器 runner 同时带 `ci-vps`/`ci-linux` 后，暂停不彻底

**严重度：高**

**问题**：现有暂停逻辑只移除/检查 `RUNNER_LABEL`（`ci-vps`）。方案要让 CI 服务器的 1、2 号 runner 同时带 `ci-vps` 和 `ci-linux`。暂停时只移除 `ci-vps`，`ci-linux` 还在，GitHub 仍会把 `security`/`static`/`policy` 作业派给正在维护的 runner；`runner-pause.sh` 在等待空闲期间也可能有新 `ci-linux` 作业进来。恢复时也只加回 `ci-vps`，`ci-linux` 的状态没有核对。

**证据**：
- `scripts/operations/ci-runner/mac-runners.sh:4`：`LABEL=$RUNNER_LABEL`
- `scripts/operations/ci-runner/pause-runners.sh:37-57`：只 `remove_label` / 检查 `LABEL`
- `scripts/operations/ci-runner/runner-pause.sh:25`：提示只移除 `$RUNNER_LABEL`
- `test/tooling/ci-runner-scripts.test.mjs:335-342`：只断言 `ci-vps` 被移除。

**建议**：暂停/恢复按 runner 的**完整标签集**处理（移除所有会接作业的标签，或直接调 GitHub API 把 runner 设为 offline），并分别核对 CI 服务器和 Oracle 两台机器；测试要覆盖“CI 服务器 runner 的 `ci-linux` 也被移除”和“Oracle runner 的 `ci-vps` 不存在”。

### 7. 新值的消费者没有全部更新：`ci-linux`、`allowedArch`、`linux-arm64`、`push` 两端不一致

**严重度：高**

**问题**：这正是 I-73 的教训——值产生出来了，但使用它的地方不接受。方案只写了“改成允许”，没有逐项落到代码：

- `ci-linux`：`ci/policy.schema.json:63-65` 的 `runner` 枚举只有 `ci-vps`/`macos-15`；`check-policy.mjs:318-331` 硬编码非 mac 成员必须 `runner === linuxRunnerLabel`（`ci-vps`）且 `arch === x64`；`test/tooling/ci-runner-scripts.test.mjs:319-332` 明确断言 `RUNNER_LABEL=ci-vps`、`RUNNER_HOST=ci-vps`。不改进这些，policy/static 直接红。
- `allowedArch`（名称未定）：`ci/policy.schema.json:56` 成员 `additionalProperties:false`；`check-policy.mjs:464-471` 对多成员检查要求 workflow 的 `matrix.include` 与 policy 成员 canonical JSON 完全相同。如果把这个字段加到 `build`/`browser` 的成员，matrix 也要同步，否则矩阵比对失败。
- `linux-arm64`：`install-tools.mjs:25` 的 `platforms`、`:80-83` 的 `platformArtifacts`、`:152` 的 semgrep wheels 都按“所有平台必须有条目”校验；`local.mjs:20-26` 明确拒绝 linux-arm64；`quality-policy.mjs:66-70` 只有 `linux-x64`/`darwin-arm64`。
- `push`：`run-share.mjs:144` 的 `parseArguments` 允许列表还没有 `push`；`check-policy.mjs:550` 逐字匹配 `put` 步骤，方案要新增逐字匹配 `push`；`run-share.mjs:26-32` 的 `shareRoot` 要求 Oracle 上有一个本地绝对目录。
- 报告里的 `artifact.platform`：`run.mjs:283,477,561` 把“非 darwin”一律写成 `linux-x64`；`ci/result.schema.json:232-234` 的枚举也只有 `linux-x64`/`macos-arm64`。如果 ARM 上误跑 `build`/`coverage`，会被标成 x64 并通过部分校验。

**建议**：把新值列成清单，逐个改产生端和消费端，并加“消费端拒绝错误值”的测试。特别是：
- 新增 `linuxArmCapableRunnerLabel` 常量，**不要改** `linuxRunnerLabel`（升级函数还要用旧值）。
- `run.mjs` 用 `${process.platform}-${process.arch}` 或显式允许集合，遇到未知组合直接失败，不要静默标成 `linux-x64`。
- `result.schema.json` 的 `artifacts.platform` 要么加 `linux-arm64`，要么在 policy 层保证 artifact 作业永远不会跑 ARM，并在 `run.mjs` 里断言。

### 8. `install-tools` 的平台是“全有或全无”，ARM 工具闭包未核实，可能拖垮 x64

**严重度：高**

**问题**：`platformArtifacts(value)` 要求 `Object.keys(value)` 恰好等于 `platforms`。把 `linux-arm64` 加进 `platforms` 后，**每一个**工具（Node、Python、actionlint、gitleaks、semgrep 的整个 wheel 闭包）都必须有 ARM 条目；任何一个缺失，`validateToolchainLock` 在 **x64 作业上也会失败**。方案说“每个工具补 linux-arm64”，但 semgrep 的传递依赖闭包很大，方案自己也承认未逐个打开。我核实了 semgrep 1.152.0 本身有 aarch64 wheel（PyPI JSON：`semgrep-1.152.0-...-none-musllinux_1_0_aarch64.manylinux2014_aarch64.whl`），但闭包里其他包是否都有 aarch64 wheel 仍未核实。

**证据**：
- `scripts/ci/install-tools.mjs:25`：`const platforms = ["darwin-arm64", "linux-x64"];`
- `scripts/ci/install-tools.mjs:80-83`：`fields(value, platforms, ...)`
- `scripts/ci/install-tools.mjs:152`：`fields(semgrep.wheels, platforms, "Semgrep wheels")`
- 方案原文：“DeepSeek 的独立方案列了各自的发布页，我没有逐个打开，未核实”。

**建议**：不要让一个共享锁的 `platforms` 强制所有工具全平台。要么按工具声明支持的平台子集（`platformArtifacts` 接受 subset），要么按 ADR 0253 原计划用独立 ARM 锁文件，并在报告里加一个 `toolchain` 映射（x64/arm64 各一个摘要）。至少工具链 PR 必须先证明：ARM 的 Node/Python/actionlint/gitleaks/semgrep 闭包全部可下载且校验通过，同时 x64 的 lock 校验仍然通过。

---

## 证实的发现（中）

### 9. 共用标签让必过检查在两种架构间不确定，方案没有持续对比门槛

**严重度：中高**

**问题**：`ci-linux` 作业可能这次落 x64、下次落 ARM。平台相关的测试结果、扫描结果、时序都可能不同；方案只做一次手工对比，之后没有门槛。`aggregate.mjs:99-101` 只检查报告里的 arch 在允许集合内；`run.mjs:585-587` 只打印 `checkId/matrixKey`，不打印架构；`GateSummary` 的 `checks` 也没有 arch 字段。结果是同一个 PR 可能因为落到不同机器而红/绿，且汇总日志里看不出这次是哪个架构。

**证据**：
- `scripts/ci/aggregate.mjs:99-101`：`for (const field of ["node", "os", "arch"])`
- `scripts/ci/run.mjs:585-587`：只输出 `${result.checkId}/${result.matrixKey}`。
- 方案原文：“不做的：不让同一个检查在两种架构上各跑一遍：时间加倍，和提速相反。”

**建议**：至少三选一：
1. 先只让 ARM 跑**非必过**的 advisory 作业，x64 仍是必过；连续 N 次结果一致后再提升。
2. 对要搬的检查做双跑，以 x64 为主、ARM 为 advisory，发现分歧就失败/告警；只对 `security` 这种便宜的检查先做。
3. 明确把某些检查固定到某个架构（例如 security 固定 ARM，policy/static 固定 x64），不要用共享标签做必过检查。
另外，把 `toolchain.arch` 写进 gate summary/日志，便于事后判断。

### 10. `push` 的传输、超时、host key、Oracle 暂存清理都没有落到方案

**严重度：中**

**问题**：`run-share.mjs` 没有 `push` 命令，`shareRoot` 要求本地目录；方案没有写 Oracle 本地暂存目录在 push 成功后如何删除。`clean-old.sh` 只清理 CI 服务器的 `RUNNER_SHARE_ROOT`，不会清理 Oracle 的暂存目录；长期运行会积累报告。SSH 也没有指定 `BatchMode`、`ConnectTimeout`、`ServerAliveInterval`、`StrictHostKeyChecking=yes`/固定 known_hosts；网络半断时 `push` 可能挂到作业 60 分钟超时。

**证据**：
- `scripts/ci/run-share.mjs:26-38`：`shareRoot`/`runName` 只认本地目录和环境变量。
- `scripts/ci/run-share.mjs:138-140`：`remove` 只删 `root/run`。
- `scripts/operations/ci-runner/clean-old.sh:24-26`：只清理 `RUNNER_SHARE_ROOT`。
- `scripts/operations/ci-runner/mac-runners.sh:9`：现有 SSH 选项有 `BatchMode`/`ConnectTimeout`/`ServerAlive`，但没有 `StrictHostKeyChecking`。

**建议**：`push` 成功后删除 Oracle 暂存目录；给 push 步骤加超时；固定 CI 服务器 host key；失败时清理半成品；把 Oracle 暂存目录纳入清理脚本或 `job-completed.sh`。

### 11. 安装/运维脚本是单机、x64、1|2 号专用，Oracle 场景没有真正覆盖

**严重度：中**

**问题**：现有脚本不是“换一台机器就能用”：
- `runners.sh:1-3` 只有 `RUNNER_IDS="1 2"`、`RUNNER_HOST=ci-vps`、`RUNNER_LABEL=ci-vps`；`require_runner_host` 只允许 `ci-vps`。
- `register-runner.sh:11-14` 只接受 `1|2`；`uninstall-runner.sh:10-13` 只接受 `2|all`。
- `install-runner.sh:4-6` 下载的是 `actions-runner-linux-x64-2.338.2.tar.gz`，没有 arm64 的 SHA。
- `prepare-vps.sh:5-25` 硬编码 Ubuntu 24.04、x64 Node，并安装 `build-essential`/`bwrap` 等；Oracle 的方案没有提这些前置依赖。
- `mac-runners.sh:5` 只 SSH 到 `CI_VPS`，无法同时管理 Oracle。

方案说“沿用做法”“安装脚本从 Mac 上跑”，但没有说明这些脚本如何拆成两套 host。

**证据**：上述行号。

**建议**：为 Oracle 单独一套 host 配置（主机名、用户、目录、runner tarball 的 arm64 SHA、systemd 单元、防火墙表）；`register/uninstall/pause/resume` 支持两台 host；`prepare-vps.sh` 的 ARM 版本安装 `build-essential`、`bwrap`、`socat`、`ripgrep` 等；在 `test/tooling/ci-runner-scripts.test.mjs` 里加两主机对照。

### 12. `local.mjs` 明确拒绝 linux-arm64，方案第 2 步“手工跑”没有可用入口

**严重度：中**

**问题**：方案第 2 步要求在 Oracle 上手工跑 `security`、`static`、`policy`。自然的本地入口 `scripts/ci/local.mjs` 只允许 `darwin-arm64` 和 `linux-x64`，并且把平台硬编码成 `macos-arm64`/`linux-x64`。如果按 `local.mjs` 跑，Oracle 上会直接 `CI_LOCAL_PLATFORM_UNSUPPORTED`。

**证据**：
- `scripts/ci/local.mjs:20-26`：只接受 `darwin-arm64`/`linux-x64`。
- `scripts/ci/local.mjs:38`：`process.platform === "darwin" ? "macos-arm64" : "linux-x64"`。

**建议**：要么把 `local.mjs` 加上 `linux-arm64` 并修正平台映射，要么在方案里明确第 2 步使用 `run.mjs --check ...` 而不是 `local.mjs`，并给出可复制的命令。

### 13. Native 依赖/安装依赖在 ARM 上未核实，可能卡住 static/policy/security

**严重度：中**

**问题**：每个作业都跑 `install-dependencies.mjs`，仓库有 `better-sqlite3` 等原生依赖；`ci/toolchain-lock.json` 的 `nativeDependencies` 允许 `build`。Oracle 上是否有编译器、Python、头文件、`bwrap`、Playwright 依赖，方案没有列。`prepare-vps.sh` 在 CI 服务器上装了这些，但 Oracle 的安装步骤没有对应内容。只改 `install-tools.mjs` 和锁文件不一定够。

**证据**：
- `scripts/operations/ci-runner/prepare-vps.sh:25`：安装 `build-essential unzip xz-utils bubblewrap socat ripgrep apparmor-utils`。
- `scripts/ci/install-dependencies.mjs` 在每个作业的 workflow 步骤里运行（如 `ci.yml:52-53`、`:92-93`、`:304-306`）。
- 方案原文：工具链 PR 只提 `install-tools.mjs` 和锁文件。

**建议**：把 `install-dependencies.mjs`、原生依赖、Playwright、`bwrap`、AppArmor 的 ARM 验证纳入工具链 PR；在 Oracle 上跑一次完整 `npm ci`/`check` 并把结果作为 PR 的证据。

### 14. `clean-old.sh` 是“每小时跑一次、删 6 小时前的”，不是“每小时清理”

**严重度：中**

**问题**：方案说“能塞满 CI 服务器磁盘是剩下的风险，靠大小上限和每小时清理挡”。定时器确实是每小时，但保留期是 `RUNNER_SHARE_KEEP_MINUTES=360`，即 6 小时。恶意上传可以占用磁盘最长 6 小时；`job-started.sh` 的 16 GiB 下限只能让后续作业失败，不能阻止填满。

**证据**：
- `scripts/operations/ci-runner/runners.sh:7`：`RUNNER_SHARE_KEEP_MINUTES=360`
- `scripts/operations/ci-runner/clean-old.sh:25`：`-mmin +"$RUNNER_SHARE_KEEP_MINUTES"`
- `scripts/operations/ci-runner/gh-runner-clean.timer:5`：`OnCalendar=hourly`

**建议**：把“每小时清理”改成“每小时扫一次、删除超过 6 小时”的准确说法；对无人认领/非当前运行的上传目录用更短保留期；加全局磁盘配额或 `tmpfs`/独立分区，超限直接拒绝上传。

### 15. ADR/文档与代码不一致：ADR 0256 尚未落地，ADR 0238 的“只有 CI VPS 能跑”没有改

**严重度：中**

**问题**：
- 方案前提 4 说“汇总作业按 ADR 0256 在 `ci-vps-gate`”，但当前 `ci.yml:327` 仍是 `runs-on: ci-vps`，`runners.sh:1-3` 只有 1、2 号，没有 `ci-vps-gate`。ADR 0256 虽已 accepted，但代码未实现。
- ADR 0238:92 明确写“只有 CI VPS 上的 runner 能跑这套 CI……换到 GitHub 托管的 runner 上会以 `CI_SHARE_ROOT_REQUIRED` 失败。这是有意的”。方案要让 Oracle 跑，必须 amend 这条以及 ADR 0238:91 的信任模型。
- ADR 0253 不在当前检出里（sparse checkout / 另一分支），方案引用它的内容无法在本仓库核对。

**证据**：上述行号；`git log` 显示 ADR 0256 是最近提交但 `ci.yml` 未改。

**建议**：把 ADR 0256 作为前置依赖写进顺序（或先落地 ADR 0256）；在方案里明确要 amend ADR 0238 的哪些决定/后果，以及 ADR 0253 由哪个线程维护；更新 runbook 和 `test/tooling/ci-runner-scripts.test.mjs`。

### 16. 验证清单的负例不够，有些按当前代码不会真的失败

**严重度：中**

**问题**：
- “锁文件的 ARM 条目混进 x64 文件必须失败”：当前 `artifact()`（`install-tools.mjs:59-71`）只检查文件名与 URL 最后一段一致、摘要格式，不检查平台。新增检查要覆盖 Node（`linux-arm64`）、Python（`aarch64-unknown-linux-gnu`）、actionlint（`linux_arm64`）、gitleaks（`linux_arm64`?）、semgrep（`manylinux2014_aarch64`）各自不同的命名；一个简单的 `includes("linux-arm64")` 会漏。
- “security 改回 ci-vps 而策略没改必须失败”：policy 来自 base 分支，测试必须同时覆盖 base policy、proposed policy 和升级函数；只改 workflow 的测试可能因为旧 policy 的其他断言失败，而不是因为目标条件。
- “暂停后 Oracle 的 runner 还带着 ci-linux 必须失败”：还要加 CI 服务器 runner 的 `ci-linux` 移除用例。
- 接收脚本没有硬链接、特殊文件、解压炸弹、符号链接后写、超时、host key 的负例。

**证据**：`install-tools.mjs:59-71`；`check-policy.mjs:1355-1373`；`pause-runners.sh`；方案的“验证”一节。

**建议**：每个负例都断言具体错误码；对平台文件名按工具分别测；对接收脚本用真实恶意 tar 样本（硬链接、`../`、绝对路径、FIFO、炸弹）测；把“x64 和 ARM 结果一致”做成持续对比，而不是一次性手工。

---

## 推测/未核实

- **semgrep 闭包的 aarch64 完整性**：我核实了 semgrep 1.152.0 本身有 aarch64 wheel（PyPI JSON 的 `...-none-musllinux_1_0_aarch64.manylinux2014_aarch64.whl`），但锁文件里每个传递依赖是否都有 aarch64 wheel 未逐个核实；`ruamel.yaml.clib`、`cffi` 等需要再看。
- **gitleaks/actionlint 的 linux-arm64 发布物**：GitHub 发布页返回 403，未能直接核实；需要在工具链 PR 里逐个下载并核对 SHA。
- **Oracle 测试数据/配置的实际路径**：未核实；如果都在 `/home` 下，`ProtectHome=yes` 能挡住；如果在 `/srv`/`/opt`，挡不住。
- **接收脚本是否真的会放在 PR 检出里**：方案原文“仓库里的一个接收脚本”有歧义；如果实际安装到 root-owned 路径，发现 1 的风险会降低，但仍需在方案里写死。
- **Oracle 上 native npm 依赖、Playwright、`bwrap` 是否可用**：未核实；需要实际跑一次 `npm ci`/`check`。
- **13–14 分钟和提速幅度**：来自 GitHub API 的外部实测，仓库内无法核实。
- **ADR 0253 的原文**：当前检出中没有该文件，按方案引用核对，未直接读原文。
- **“接受 `ci-linux` 的作业会自动回退到 CI 服务器”**：GitHub 的标签路由行为本身有官方文档支持（https://docs.github.com/en/actions/reference/runners/self-hosted-runners），但“online 但坏掉的 Oracle runner 也会自动回退”不成立——只有离线/无空闲 runner 才会排队等别的 runner，坏掉但 online 的 runner 会持续接作业并失败。

---

## 侧重检查

我重点查了错误路径、不可信输入、安全、资源耗尽、不可撤销操作、文档/代码一致性，结论如下：

- **错误路径**：`push` 失败、接收失败、部分传输、Oracle 离线、作业中途掉线都能让 `collect` 缺报告，`required` 判失败，不会误判通过；但“目标已存在就拒绝”+ 可预测的 `run/name` 会让恶意方抢先占位，把别人的作业弄失败（DoS）。Oracle 本地暂存目录没有清理路径。`push` 没有超时/host key 固定，可能挂到作业超时。
- **不可信输入**：SSH 的 `SSH_ORIGINAL_COMMAND`、run/name、tar 流都是不可信输入。方案只给了名字正则和“符号链接/路径/大小”，缺硬链接、特殊文件、绝对路径、解压炸弹、超多条目、`~/.ssh/authorized_keys` 持久化防护。`restrict` 不等于“安全解包”。
- **安全**：长期私钥在 PR 可读目录；接收脚本可能来自 PR 检出；接收账号在共享组里有删改权限；接收账号不是 runner UID，现有 runner 防火墙不限制它的出站/本机端口；Oracle 测试数据可能被读。`command=`/`restrict` 本身是正确的一手做法（OpenSSH man page），但它只约束“命令”，不约束“脚本来源/账号文件系统/网络”。
- **资源耗尽**：磁盘（共享目录 6 小时保留、无全局配额、Oracle 暂存不清理）、内存/CPU（接收进程没有 cgroup 限制；Oracle 上 CPU 只设 `CPUWeight`，CI 可能饿死测试）、解压后大小无上限、文件数/inode 无上限。
- **不可撤销操作**：接收账号可删除/覆盖别的运行；`remove` 删除整个 run 目录；暂停/移除标签、停止 runner 可能中断作业；现有安装脚本有备份/恢复，但方案没有把 Oracle 的安装纳入同样的回滚设计。
- **规则/文档一致性**：ADR 0238 的“只有 CI VPS 能跑”和信任模型没有改；ADR 0256 未落地但被当作前提；ADR 0253 不在当前检出；`ci/policy.schema.json`、`ci/result.schema.json`、`check-policy.mjs`、`aggregate.mjs`、`run.mjs`、`local.mjs`、`test/tooling/ci-runner-scripts.test.mjs` 都没有在方案里逐项对应。
- **KV 缓存/提示前缀**：这个改动不碰模型请求组装；现有 `npm run check` 里的 `check:prompt-prefix` 仍会在 `static` 作业执行。没有发现“改变已发请求开头”的路径。

---

## 如果由我来定，我会怎样改这份方案

1. **先改信任方向，不要把长期私钥放到 Oracle。** 由 CI 服务器上的可信步骤 SSH 到 Oracle 拉取报告（CI 服务器本来就在跑 PR 代码，信任边界不变），或者用 GitHub OIDC 换每次运行的短期凭证。Oracle 上不放能连 CI 服务器的长期钥匙。
2. **接收端不要自定义 tar 管道。** 用 OpenSSH `rrsync`/受限 rsync，或经过审计的解包库；接收账号写独立 inbox，不给共享根目录的组写/删除权限；接收进程放进独立 systemd 沙箱，限制内存、CPU、文件数、解包后字节，禁止出站网络。
3. **不要把必过检查放到不确定的共用标签上。** 先做 `security` 的 **advisory** ARM 作业（x64 仍必过），连续一段时间结果一致后再提升；或者固定 `security` 到 ARM、`policy`/`static` 留 x64，并提供明确的回退标签。把 `toolchain.arch` 写进 gate summary 和日志，建立分歧检测。
4. **工具链按平台子集/独立锁文件处理。** 不要因为加 ARM 而让 x64 的 lock 校验依赖所有 ARM 闭包；先证明 Node/Python/actionlint/gitleaks/semgrep 闭包和 native 依赖在 ARM 上全部可用，再决定合并方式。`local.mjs` 加 ARM 或明确用 `run.mjs`。
5. **把安装/运维做成两台 host 的显式配置**：Oracle runner 用 arm64 的 `actions-runner` tarball 和独立 SHA；`prepare-vps` 的 ARM 版本装 `build-essential`/`bwrap`/Playwright 依赖；`register/uninstall/pause/resume` 支持两台；暂停移除**所有**接作业标签。
6. **逐项更新消费者并加负例**：`ci-linux`、`allowedArch`、`linux-arm64`、`push`、`artifact.platform`、`toolchainSha256`、`HIMAWARI_CI_SHARE`、共享组、gate summary 的 arch。`run.mjs` 不要静默把非 darwin 标成 `linux-x64`。
7. **文档和顺序**：先落地 ADR 0256（或把 `required` 的 runner 依赖去掉），再改 ADR 0238 的“只有 CI VPS 能跑”和信任模型，更新 ADR 0253 的约定；更新 runbook 和 `test/tooling/ci-runner-scripts.test.mjs`。不要在一个 PR 里同时改策略、工作流、工具链和 runner 安装。

---

## 必答问题

### 1. 这个改动会不会改变模型已经见过的请求开头？

**不会。** 方案只动 CI 工作流、策略、工具链、报告传输和 runner 安装脚本；这些都不组装或修改发给模型的内容。`.claude/rules/prompt-prefix.md:4` 的适用范围是“系统提示、工具定义、历史、资料块、遮盖和压缩”；方案没有改 `packages/prompt-catalog`、runtime、出口遮盖、历史保存或工具定义。`static` 作业仍运行 `npm run check`（包含 `check:prompt-prefix`），所以现有门槛不会被移除；把它搬到 ARM 只改执行位置，不改请求字节。新增的 `runId`、`toolchain.arch`、报告时间等只存在于 CI 报告，不进模型请求。**结论：发给模型的内容仍然只在末尾追加；每轮会变的值没有进入请求开头。**

### 2. 这个改动会不会让同一段文字在不同请求里变成不同的字节？

**对模型请求不会。** 方案没有新增遮盖、时间字段、无序集合到提示里。CI 侧的报告摘要按 `run-share.mjs:59-65` 对路径排序、只取 `[path, sha256, bytes]`，文件模式不进摘要，跨 SSH 传输不会改变摘要。新增的 `toolchain.arch` 会随架构不同，这是 CI 报告的正常差异，不是模型请求；但它会让“同一个检查”在 x64/ARM 产生不同结果，这是第 9 条的 CI 非确定性，需要单独用双跑/固定架构/分歧门槛处理。

### 3. 改动有没有对应的自动检查，反向用例是否真的会失败？

**有，但不够。** 现有 `check-policy.mjs`、`aggregate.mjs`、`ci-runner-scripts.test.mjs` 会守住大部分；方案列的负例方向对，但：
- `ci-linux`、`allowedArch`、`linux-arm64`、`push` 的消费端还没有全部更新，按当前代码有些负例不会到达目标断言。
- “锁文件混进 x64 文件”当前 `artifact()` 不检查平台；新增检查要覆盖不同工具的平台命名。
- “security 改回 ci-vps”必须同时覆盖 base policy/proposed policy/升级函数。
- 暂停测试只覆盖一个标签；要加 CI 服务器 `ci-linux` 的移除用例。
- 接收脚本缺硬链接、特殊文件、解压炸弹、符号链接后写、超时、host key 的负例。
- 没有“同一提交在 x64 和 ARM 结果一致”的持续门槛。
现有 `check:prompt-prefix` 不受影响，但它不是这个改动的检查。

### 4. 每个新值/改动的两端校验

| 值/字段 | 产生它的地方 | 使用/校验它的地方 | 两端是否接受 |
|---|---|---|---|
| `ci-linux` | `ci/policy.json` 成员、`ci.yml` `runs-on`、runner 注册 | `ci/policy.schema.json:63-65` 枚举；`check-policy.mjs:318-331,474`；`contracts.mjs:7`；`test/tooling/ci-runner-scripts.test.mjs:319-332`；`mac-runners.sh:4` | **不接受**：schema/validatePolicy/测试仍只认 `ci-vps`；需新增常量，保留旧值给升级函数 |
| `allowedArch`（名称未定） | `ci/policy.json` | `policy.schema.json:56`（`additionalProperties:false`）；`validatePolicy`；`aggregate.mjs:99-101`；`run.mjs:131-132`；`check-policy.mjs:464-471` 矩阵 canonical | **部分不接受**：schema/validatePolicy/aggregate 未更新；若加到多成员，matrix 必须同步 |
| `linux-arm64` | `ci/toolchain-lock.json` | `install-tools.mjs:25,80-83,152`；`verifyInstalledTools:328-345`；`run.mjs:103-110`；`aggregate.mjs:99-105`；`local.mjs:20-26`；`quality-policy.mjs:66-70` | **不接受/高风险**：平台全有或全无；`local.mjs` 拒绝；semgrep 闭包/native 依赖未核实 |
| `push` | `run-share.mjs` | `run-share.mjs:144` 参数列表；`check-policy.mjs:550` 的 put 逐字比对；`ci.yml` steps；测试 | **未实现**：需加命令、参数、逐字比对、负例；Oracle 本地 `shareRoot` 要存在 |
| `run/name` | `run-share.mjs:34-38`、`NAME` 正则 | receiver、`collect`/`get`、`publishedMembers:114-122` | 规则一致才行；receiver 必须用同一正则，且只允许自己的 run/name |
| `toolchainSha256` | `context.mjs:143`、`install-tools.mjs:417/567` | `aggregate.mjs:288-290`、result schema | **接受**：同一提交同一锁；加 ARM 条目只是一次正常摘要变化 |
| `artifact.platform` | `run.mjs:283,477,561`、`build.mjs:133` | `aggregate.mjs:184,201-215`、`result.schema.json:232-234` | **不接受/脆弱**：非 darwin 一律 `linux-x64`；schema 没有 `linux-arm64`；必须 policy 禁止 + `run.mjs` 显式拒绝未知组合 |
| `runner`（security/static/policy → `ci-linux`） | `ci/policy.json` | `check-policy.mjs:474`、schema | 需同时改；旧 `linuxRunnerLabel` 不能改，升级函数要用旧值 |
| `ci-vps-gate` | ADR 0256 | `ci/policy.json` required、schema、`check-policy` | **当前代码没有**：`ci.yml:327` 仍是 `ci-vps`，`runners.sh:1-3` 只有 1、2；方案前提 4 与 HEAD 不一致 |
| `HIMAWARI_CI_SHARE`/共享组 | service template/install | `run-share.mjs:26-47`、`collect` | 需接收账号在 `gh-ci-share` 组；方案未写明；Oracle 暂存清理未覆盖 |
| `RUNNER_SHARE_KEEP_MINUTES=360` | `runners.sh:7` | `clean-old.sh:25` | 方案说“每小时清理”，实际保留 6 小时；描述不一致 |

**一句话**：新值不是“加进去就行”，`ci-linux`、`allowedArch`、`linux-arm64`、`push`、`artifact.platform` 都至少有一个消费端当前不接受；按 I-73 的教训，必须逐个找到产生端和消费端，补两端的校验和反向用例。
