# 整合后的方案（第 2 版）：把 Oracle 的 ARM 机器接进 CI

第 1 版经 DeepSeek 审核（`round-2/deepseek-v4.1-flash.md`，逐条判断见 `round-2/judgments.md`）后改成这一版。改动最大的三处：报告改由 CI 服务器去 Oracle 取，不再由 Oracle 往 CI 服务器送；检查固定在一种机器上跑，不用两台机器共用的标签；先试跑、用数据决定再切换。

## 前提和来源

1. 一次完整运行有 6 个检查作业，现在全部在 CI 服务器的两个 runner（装在自己机器上、替 GitHub 执行 CI 任务的程序）上跑。来源：`.github/workflows/ci.yml` 第 33、72、236、284 行 `runs-on: ci-vps`；第 115、165 行 `runs-on: ${{ matrix.runner }}`。
2. policy 和 static 各要 13 到 14 分钟，是最长的两个作业。来源：GitHub 接口 2026-11-12 的作业记录（实测，不是仓库里的文件）。
3. 每个检查在 `ci/policy.json` 里写死了跑在哪种 runner、哪种系统和架构上。来源：`ci/policy.json` 里 policy 检查的成员，原话 `"runner": "ci-vps"`、`"os": "linux"`、`"arch": "x64"`；`scripts/ci/check-policy.mjs` 第 474 行 `!job.strategy && job["runs-on"] === check.members[0].runner`。
4. 报告靠 CI 服务器本机的目录交接，汇总作业按摘要核对后收齐。来源：`scripts/ci/run-share.mjs` 的 `shareRoot`（读 `HIMAWARI_CI_SHARE`，要求本机目录）、`put`、`collect`；`.github/workflows/ci.yml` 第 65、362 行。
5. browser 和 coverage 要取 build 的 x64 产物。来源：`.github/workflows/ci.yml` 第 215、265 行，原话 `run-share.mjs get --name build-linux-x64`。
6. 固定工具现在不支持 linux-arm64。来源：`scripts/ci/install-tools.mjs` 第 25 行，原话 `const platforms = ["darwin-arm64", "linux-x64"];`。
7. 汇总时拿 `ci/toolchain-lock.json` 的摘要和每份报告上下文里的摘要比对。来源：`scripts/ci/context.mjs` 第 143 行；`scripts/ci/aggregate.mjs` 第 288、289 行，原话 `if (sha256(lockBytes) !== context.toolchainSha256)`。
8. 不用 GitHub 产物。来源：`docs/adr/0243-ci-uses-no-github-artifacts.md` 决定第 6 条，原话“`scripts/ci/check-policy.mjs` 拒绝 `ci.yml` 任何作业用 `actions/upload-artifact` 或 `actions/download-artifact`”。
9. ARM 测试机线程原来打算把 ARM 的工具链放在独立的锁文件里。来源：分支 `claude/project-thread-q668e8` 的 `docs/adr/0253-support-linux-arm64-for-test-and-qualification.md` 决定第 3 条，原话“ARM 的工具链放在独立的锁文件里，有自己的校验和自己的摘要字段；`ci/toolchain-lock.json`、`ci/policy.json`、`scripts/ci/check-policy.mjs`、`scripts/ci/aggregate.mjs` 和工作流文件不改”。代码还没写。
10. ADR 0253 原先不让 ARM 进必过检查。来源：同一份文件，原话“把 linux-arm64 加进 `ci/policy.json` 的必过检查｜不采用｜测试机可能被 Oracle 回收，不能让必过检查依赖它”。
11. OpenSSH 可以把一把密钥限制成只能执行一条固定命令。来源：https://man.openbsd.org/sshd#AUTHORIZED_KEYS_FILE_FORMAT ，原话 “command="command" Specifies that the command is executed whenever this key is used for authentication. The command supplied by the user (if any) is ignored.”“restrict Enable all restrictions, i.e. disable port, agent and X11 forwarding, as well as disabling PTY allocation and execution of ~/.ssh/rc.”
12. gitleaks、semgrep、actionlint、Node、Python 是否都有 linux-arm64 的官方发布：DeepSeek 的独立方案列了各自的发布页，我没有逐个打开，未核实；工具链 PR 里逐个下载并核对校验值时才算核实。
13. GitHub 把作业派给带齐 `runs-on` 标签的任何一个空闲 runner，没有空闲的就排队。来源：https://docs.github.com/en/actions/reference/runners/self-hosted-runners ，原话 “When routing a job to a self-hosted runner, GitHub looks for a runner that matches the job's `runs-on` labels and groups”“If GitHub doesn't find an online and idle runner that matches the job's `runs-on` labels and groups, then the job will remain queued until a runner comes online.”
14. 自托管 runner 上跑过的代码可能留下长期影响。来源：https://docs.github.com/en/actions/reference/security/secure-use ，原话 “Self-hosted runners for GitHub do not have guarantees around running in ephemeral clean virtual machines, and can be persistently compromised by untrusted code in a workflow.”
15. 报告的架构现在必须等于策略里成员写的架构。来源：`scripts/ci/aggregate.mjs` 第 99 到 101 行，原话 `for (const field of ["node", "os", "arch"])`、`if (result.toolchain[field] !== member[field])`；`scripts/ci/run.mjs` 第 131、132 行，原话 `if (hosted && (member.os !== process.platform || member.arch !== process.arch))`、`throw new Error("CI_RUNNER_PLATFORM_MISMATCH");`。
16. 共享目录里一个任务能删改任何一轮运行的文件，这是已接受的现状。来源：`docs/adr/0238-ci-job-files-stay-on-the-ci-vps.md` 第 91 行，原话“两个 runner 的任务都能读写整个共享目录，所以一个任务能读、改、删共享目录里任何一轮运行的文件，不只是本轮的”。
17. ADR 0238 写明只有 CI 服务器上的 runner 能跑这套 CI。来源：同一份文件第 92 行，原话“只有 CI VPS 上的 runner 能跑这套 CI：作业要靠 `HIMAWARI_CI_SHARE` 和共享目录”。这个方案要修订这一条。
18. 报告里的产物平台，非 macOS 一律写成 x64。来源：`scripts/ci/run.mjs` 第 283 行，原话 `platform: process.platform === "darwin" ? "macos-arm64" : "linux-x64",`。
19. 本机跑检查的入口不认 linux-arm64。来源：`scripts/ci/local.mjs` 第 20 到 26 行，原话 `(process.platform === "linux" && process.arch === "x64")`、`throw new Error("CI_LOCAL_PLATFORM_UNSUPPORTED");`。
20. 策略校验现在要求非 macOS 的成员只能是 x64、只能用 `ci-vps`。来源：`scripts/ci/check-policy.mjs` 第 321 到 324 行，原话 `member.arch === (mac ? "arm64" : "x64") &&`、`member.runner === (mac ? "macos-15" : linuxRunnerLabel),`；`ci/policy.schema.json` 第 64 行，原话 `"enum": ["ci-vps", "macos-15"]`。
21. static、build、security 都要等 policy 跑完才开始。来源：`.github/workflows/ci.yml` 第 73、74 行 `needs:` / `- policy`，第 285、286 行同样。
22. 共享目录的旧文件每小时扫一次，删掉 6 小时以前的。来源：`scripts/operations/ci-runner/runners.sh` 第 7 行 `RUNNER_SHARE_KEEP_MINUTES=360`；`scripts/operations/ci-runner/gh-runner-clean.timer` 第 5 行 `OnCalendar=hourly`。
23. Oracle 机器上测试用的东西放在哪里：未核实（只有 ARM 测试机线程 2026-11-12 的自述，不算来源）。它说现在全部在 `/home/ubuntu` 下（代码、测试日志、观察脚本），没有密钥和真实数据，`/srv`、`/opt`、`/var/lib` 下没放东西；以后做安装和资格验证时会有状态目录和测试用的签名密钥，位置定之前先告诉 CI 线程。安装脚本装 runner 之前在机器上实查一遍，以实查为准。runner 用独立账号，不用 `ubuntu`；`/etc/apparmor.d/bwrap` 两条规则不能屏蔽，runner 跑沙箱测试也要用。

## 三方比较后的取舍

独立方案（`round-1/`）和我的第 1 版方向相同；审核（`round-2/`）提了 16 条，13 条采纳，3 条部分采纳。影响方案走向的几条：

- 采纳“把方向反过来”：第 1 版把一把能连 CI 服务器的私钥放在 Oracle 机器上，那里跑的 PR 代码读得到它，还要在 CI 服务器上新开一个能写共享目录的账号。改成由 CI 服务器上的汇总作业去 Oracle 取报告：Oracle 上不放任何能连别处的钥匙；钥匙放在 3 号 runner（只跑汇总作业）的目录里，1、2 号 runner 看不到这个目录；这把钥匙泄露了也只能读 Oracle 上的 CI 报告，写不了任何东西。
- 采纳“不自己解 tar 包”：取回来的是一段 JSON（文件名、字节数、内容），按现有的名字规则、文件数和大小上限检查后写入，再按摘要核对。JSON 里装不了符号链接、硬链接、设备文件，这一类攻击面直接没有了。
- 采纳“必过检查不能这次 x64、下次 ARM”：放弃第 1 版采纳的共用标签。改成固定：security、static、policy 在 Oracle 上跑，build、browser、coverage 在 CI 服务器上跑，日志和汇总结论里写明架构。Oracle 不在时，在 Mac 上跑一条应急命令把 Oracle 的标签临时加到 CI 服务器的 1、2 号 runner 上（和 ADR 0256 给 3 号 runner 准备的应急做法相同），不用改代码。代价是不再自动回退，要人跑一条命令；好处是同一个提交每次都在同一种机器上跑，结果可比。
- 采纳“先试跑再切换”：切换之前加一个不计入必过结论的试跑工作流，每个 PR 的 security、static、policy 在 Oracle 上多跑一遍，和 x64 的结论逐次对比。连续 20 次结论一致、ARM 上的时长不超过 x64 的 1.5 倍才切换；否则停下来带着数据找 Andy。试跑只占 Oracle，不占 CI 服务器，不会让现在的队更长。
- 部分采纳“工具链用独立锁文件或按工具声明平台”：仍用一份锁文件（理由同第 1 版：汇总只核对一个摘要）。审核担心“加了 ARM 平台后任何一个工具缺 ARM 条目，x64 也跟着失败”，这正是想要的：缺条目应该在工具链 PR 里就红，而不是切换时才发现。ARM 测试机线程已逐个下载核对过 5 个工具和 9 个 aarch64 的 Python 包，证据放在工具链 PR 里。
- 部分采纳“Oracle 上的测试数据要藏起来”：做法采纳（服务文件里把测试数据和配置的目录逐个列为不可见，安装脚本装完逐个验证确实读不到）；“把 CI 和测试放到不同机器”不采纳，Andy 要的就是把这台机器用起来。剩下的风险照实告诉 Andy。
- 部分采纳“每次运行换一把短期凭证（OIDC）”：不做。方向反过来之后钥匙只读、只能读 CI 报告，再加一套签发短期凭证的服务不值得。

## 方案

### 哪些作业在哪台机器上跑

- Oracle 上装 2 个 runner（`ci-arm-1`、`ci-arm-2`），标签 `ci-arm`。security、static、policy 最终改成 `runs-on: ci-arm`。
- build、browser、coverage 留在 `ci-vps`（前提 5）；汇总作业在 `ci-vps-gate`（ADR 0256，要先落地）。
- policy 在 Oracle 上跑完后，static、security 在 Oracle 上跑，build 同时在 CI 服务器上跑（前提 21）。两台机器各管一半，同时能跑的检查作业从 2 个变 4 个。
- `ci/policy.json` 每个成员加一个可选字段，写明这个检查允许的架构：security、static、policy 允许 x64 和 arm64（应急时在 x64 上跑），其余只允许 x64。`check-policy.mjs`、`ci/policy.schema.json`、`aggregate.mjs`、`run.mjs` 同步（前提 15、20）；新增一个标签常量，原来的 `linuxRunnerLabel` 不动，旧策略的升级函数还要用它。
- `run.mjs` 不再把“不是 macOS”一律当成 x64（前提 18）：遇到不认识的系统和架构组合直接失败；会出产物的检查在 arm64 上跑直接失败。
- `local.mjs` 认 linux-arm64（前提 19），试跑前在 Oracle 上手工跑检查用它。

### 报告怎样交到汇总作业手里

- Oracle 上的作业照旧 `put`，写到 Oracle 本机的暂存目录，摘要照旧经 GitHub 的作业输出传。
- Oracle 上新建一个专用账号，只放一把公钥，公钥带 `restrict,command="…"`（前提 11）和 `from="CI 服务器的地址"`。不管对方发什么，只执行一个固定的发送脚本。发送脚本装在 root 所有、runner 写不了的系统目录里，不放在检出的仓库里，也不加载检出目录里的任何代码。它只接受“运行号-重试号/报告名”这种名字，把那个目录里的普通文件按文件数和大小上限打成一段 JSON 输出；别的什么都不做。
- 汇总作业在 `collect` 之前多一步 `run-share.mjs pull`：本机共享目录里没有、而策略里写着可以在 arm64 上跑的那几份报告，用 ssh 从 Oracle 取。ssh 固定对方的主机密钥，设连接超时和总超时。取回的 JSON 按名字规则、文件数、每个文件和合计的大小上限检查，写进共享目录（权限和本机 `put` 一样），然后 `collect` 照旧按摘要核对。途中被改、没传完、Oracle 连不上，都是汇总判失败，不会被当成通过。
- 私钥由安装脚本在 CI 服务器上生成，放在 3 号 runner 的目录里，不进仓库，不进 GitHub 的密钥设置。
- Oracle 的暂存目录每小时扫一次，删掉 6 小时以前的，和 CI 服务器的规则相同（前提 22）；作业开始前可用空间不够就失败。
- 这修订了 ADR 0238 的“只有 CI 服务器上的 runner 能跑这套 CI”（前提 17）；共享目录本身的信任范围（前提 16）没有变大：往里写的还是 CI 服务器上的 runner 账号。

### 工具链

- 工具链 PR 由 ARM 测试机线程做：`install-tools.mjs` 认 linux-arm64，`ci/toolchain-lock.json` 每个工具补 linux-arm64 的下载地址和校验值，锁文件校验按每个工具各自的文件命名检查平台（ARM 条目里混进 x64 的文件必须失败），导出“平台对应哪些条目”的函数给策略校验用。PR 里附上每个工具和每个 Python 包在 ARM 上下载、校验通过的记录。
- 依赖安装（含要编译的包）、`bwrap`、编译工具在 Oracle 上实际装一遍、跑一遍 `npm run check`，结果作为证据。

### Oracle 机器上怎么装

- 安装脚本单独给 Oracle 一套配置：主机名、arm64 的 runner 安装包和它的校验值、用户、目录、服务文件、防火墙表、内存分组。暂停、恢复、注册、卸载、体检脚本同时管两台机器；暂停时把 runner 身上所有会接作业的标签都去掉（ADR 0256 的实现已经这样做）。
- 每个 runner 一个专用用户、systemd 服务、`ProtectHome=yes`、`ProtectSystem=strict`，只放开 runner 自己的目录和暂存目录；测试数据和配置的目录（前提 23 的清单）逐个列为不可见，装完逐个验证读不到；防火墙对 runner 账号拒绝私有网段、元数据服务地址和本机监听端口。
- 内存归一个分组管，上限 18 GB，给测试留 6 GB；CPU 用权重，不设硬上限。
- 要 Andy 知道并点头的一条：这台机器同时是测试机。上面这些限制挡得住“顺手读到测试数据”，挡不住有人存心利用系统漏洞；仓库私有、只有 Andy 和他的代理提交，这和 CI 服务器接受的前提相同，差别是这台机器上还有别的东西。

### Oracle 不在时

- Oracle 停了、被回收、runner 掉线：三个检查排队等着。在 Mac 上跑一条应急命令，把 `ci-arm` 标签临时加到 CI 服务器的 1、2 号 runner 上，作业就由它们接，速度回到现在的样子；Oracle 恢复后再跑一次去掉。体检脚本发现 Oracle 的 runner 离线时直接提示这条命令。
- Oracle 的 runner 在线但坏了（接了作业就失败）：同一条应急命令之前，先把 Oracle 两个 runner 的标签去掉。
- 作业跑到一半 Oracle 掉了：那个作业失败，汇总判失败，重跑整轮。

### 顺序

1. ADR 0256 的两个 PR 先落地（3 号 runner 在线、汇总作业已切过去）。
2. 工具链 PR（ARM 测试机线程）。
3. 安装 PR：Oracle 上的 runner、发送账号和发送脚本、`run-share.mjs pull`、两台机器的暂停恢复、应急脚本、测试、运行手册。Andy 在 Mac 上装。
4. 策略 PR：允许架构的字段、`run.mjs` 和 `local.mjs` 的改动、试跑工作流（不计入必过）。
5. 试跑：至少连续 20 次、结论和 x64 一致、时长不超过 1.5 倍。数据报给 Andy。
6. 切换 PR：先 security；跑通后 static、policy。同一个 PR 里去掉试跑工作流。
7. 观察一周，按架构统计时长、排队时间和失败率，再决定 Oracle 上加不加第 3 个 runner。

### 不做的

- 不用 GitHub 产物或缓存传报告（前提 8）。
- 不把 build、browser、coverage 搬到 ARM（前提 5）。
- 不在两台机器之间挂网络文件系统。
- 不在 Oracle 上放能连 CI 服务器的钥匙，不在 CI 服务器上开能写共享目录的新账号。
- 不让两台机器共用一个标签自动分流（第 1 版的做法，审核后放弃）。

## 花钱

GitHub 上 0 元。Oracle 机器的费用 Andy 已说不用担心。

## 验证

- 发送脚本：非法名字、不存在的目录、符号链接、超过文件数、超过大小，每条一个反向用例，断言具体的报错。
- `pull`：对端超时、主机密钥不对、JSON 里有非法路径、重复路径、超大文件、合计超限、摘要对不上，每条一个反向用例。
- 策略：security 改到 `ci-arm` 而策略没改必须失败；build 改到 `ci-arm` 必须失败；build 的报告写着 arm64，汇总必须失败；目标分支是旧策略、提议的是新策略能通过，反过来混写必须失败。
- 工具链：锁文件的 ARM 条目缺一个、或混进 x64 的文件必须失败，按每个工具的命名各测一条。
- runner 脚本：Oracle 的 runner 带了 `ci-vps` 必须失败；暂停后任何一台机器的 runner 还带着会接作业的标签必须失败；应急命令在暂停状态下拒绝执行。
- 安装后在 Oracle 上验证：runner 账号读不到清单里的每一个测试数据目录。
- 上线后：真实 PR 运行里三个检查落在 `ci-arm-*` 上、`ci/required` 成功；停掉 Oracle 的 runner、跑应急命令，确认作业由 CI 服务器接并成功。
- 一周后量排队时间，和 2026-11-12 的数字对比。
