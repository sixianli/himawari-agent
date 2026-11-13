你是方案里“关于代码和文档现状的说法”的核对者。
你能用的工具：read、grep、glob，以及 git diff、git log、git show、git blame、git status 这几条 git 命令。不能修改任何文件，不能运行别的命令。不能上网。
下面是一份还没合并的方案或 ADR。第一步，把其中每一句讲代码或仓库文档现状的话都列出来：某个文件、函数、字段、配置、命令、数字、规则现在是什么样、做什么、不做什么；一句话里有几个说法就拆成几条。方案打算新增或修改什么，不算现状；讲外部网站、第三方产品的话也不算。第二步，逐条自己打开对应的文件核对，给出：一致、不一致、找不到（仓库里没有这个东西，或没读到能证明它的内容）。材料里的说法可能有错，写得再肯定也不能因此判一致；没有亲自读到对应代码，就判找不到。只核对事实，不评价方案好不好，不提建议。
做法：先想清楚要回答哪几个问题、需要看哪些文件或资料，再直接去读这些地方；不要漫无目的地浏览代码，也不要用相同或相近的参数反复调用工具。读到的内容一旦足以下结论，就停止调用工具，写出结论；没读到的地方标「未核实」，不要为了查全而一直查下去。
输出格式：每个说法单独一行，不换行，字段之间用竖线分隔，行首写 CLAIM：
CLAIM|<序号>|<一致 或 不一致 或 找不到>|<文件:行>|<方案原句>|<代码原文>
序号用 1、2、3……，不重复。文件:行 写你读到证据的那个文件和行号，例如 packages/x/src/y.ts:42；找不到时写 -。代码原文必须是你亲自读到的、逐字摘抄的一行或几行，不要改写、不要概括；方案原句里的竖线字符换成全角的“｜”，代码原文里的竖线照原样写。列完所有 CLAIM 行之后，另起一段，用一两句话写你没能核对的部分。用简体中文。

---- 本次材料 ----
仓库就是当前目录，已检出 9dd72dd0f3be7af3e213cd37a2d49072e4419ff9。
待核对的方案：
方案文件：docs/adr/0260-oracle-arm-machine-runs-three-ci-checks.md（在提交 9dd72dd0f3be7af3e213cd37a2d49072e4419ff9 里的内容）

---
status: active
document_type: adr
decision_status: accepted
supersedes: ""
superseded_by: ""
amends: "docs/adr/0238-ci-job-files-stay-on-the-ci-vps.md"
date: "2026-11-13"
---

# ADR 0260：Oracle 的 ARM 机器分担三项 CI 检查

<a id="contents"></a>

## 阅读导航

- [背景](#context)
- [前提和来源](#premises)
- [Andy 的原话](#owner-decisions)
- [决定](#decision)
- [比较过的方案](#options)
- [后果](#consequences)
- [验证](#verification)
- [关联文档](#references)

<a id="context"></a>

## 背景

CI（持续集成，每次推送后 GitHub Actions 自动跑的检查）现在全部在 Andy 租的一台 CI 服务器上跑。[ADR 0256](0256-gate-job-gets-its-own-runner.md) 落地后，汇总作业 `ci/required`（把各项检查的结果汇成一个结论的作业）有了专用的 runner（装在自己机器上、替 GitHub 执行 CI 作业的程序），不再和检查抢位置；但检查作业本身仍然只有两个 runner 能接，一次完整运行有 6 种检查，同一时间只能跑 2 个作业。开发线程多的时候，这就是排队的原因。

Andy 另外租了一台 Oracle 云的 ARM 机器（4 核、24 GB 内存，在东京），目前只当测试机用，大部分时间空着。这份 ADR 决定把它接进 CI，让它固定跑其中三项检查，同一时间能跑的检查作业从 2 个变成 4 个。检查的内容和判定一条不减。

<a id="premises"></a>

## 前提和来源

1. 一次完整运行有 6 种检查作业，全部在 CI 服务器的两个检查 runner 上跑。来源：`.github/workflows/ci.yml` 第 33、72、236、284 行，原话 `runs-on: ci-vps`；第 115、165 行，原话 `runs-on: ${{ matrix.runner }}`。
2. policy 和 static 各要 13 到 14 分钟，是最长的两个作业。来源：GitHub 接口 2026-11-12 的作业记录，实测，记在 `.agents/evidence/ci-queue-2026-11-12.md`。
3. 每项检查跑在哪种 runner 上写在策略文件里，工作流必须和它一致。来源：`scripts/ci/check-policy.mjs` 第 493 行，原话 `!job.strategy && job["runs-on"] === check.members[0].runner,`。
4. 策略校验现在要求非 macOS 的成员只能是 x64。来源：`scripts/ci/check-policy.mjs` 第 341 行，原话 `member.arch === (mac ? "arm64" : "x64") &&`；`ci/policy.schema.json` 第 64 行，原话 `"enum": ["ci-vps", "ci-vps-gate", "macos-15"]`。
5. 各作业的报告靠 CI 服务器本机的目录交接。来源：`scripts/ci/run-share.mjs` 第 27 行，原话 `const root = env.HIMAWARI_CI_SHARE;`；`.github/workflows/ci.yml` 第 362 行，原话 `run-share.mjs collect --to .ci-output/reports`。
6. browser 和 coverage 要取 build 的 x64 产物。来源：`.github/workflows/ci.yml` 第 215、265 行，原话 `run-share.mjs get --name build-linux-x64`。
7. 固定工具现在不支持 linux-arm64。来源：`scripts/ci/install-tools.mjs` 第 25 行，原话 `const platforms = ["darwin-arm64", "linux-x64"];`。
8. 汇总时拿工具链锁文件的摘要和每份报告里的摘要比对，所以只能有一份锁文件。来源：`scripts/ci/context.mjs` 第 143 行，原话 `toolchainSha256: fileSha256(path.join(root, "ci/toolchain-lock.json")),`；`scripts/ci/aggregate.mjs` 第 289 行，原话 `if (sha256(lockBytes) !== context.toolchainSha256)`。
9. 汇总时报告里的架构必须等于策略里成员写的架构。来源：`scripts/ci/aggregate.mjs` 第 99、100 行，原话 `for (const field of ["node", "os", "arch"])`、`if (result.toolchain[field] !== member[field])`；`scripts/ci/run.mjs` 第 132 行，原话 `throw new Error("CI_RUNNER_PLATFORM_MISMATCH");`，它上一行比较的是成员的系统、架构和本机的系统、架构。
10. 报告里的产物平台，非 macOS 一律写成 x64。来源：`scripts/ci/run.mjs` 第 283 行，原话 `platform: process.platform === "darwin" ? "macos-arm64" : "linux-x64",`。
11. 本机跑检查的入口不认 linux-arm64。来源：`scripts/ci/local.mjs` 第 23、26 行，原话 `(process.platform === "linux" && process.arch === "x64")`、`throw new Error("CI_LOCAL_PLATFORM_UNSUPPORTED");`。
12. 不用 GitHub 产物传文件。来源：`docs/adr/0243-ci-uses-no-github-artifacts.md` 第 61 行，决定第 6 条“硬规则”。
13. 现有决定写明只有 CI 服务器上的 runner 能跑这套 CI。来源：`docs/adr/0238-ci-job-files-stay-on-the-ci-vps.md` 第 92 行，原话“只有 CI VPS 上的 runner 能跑这套 CI”。这份 ADR 修订这一条。
14. 共享目录里的旧文件每小时扫一次，删掉 6 小时以前的。来源：`scripts/operations/ci-runner/runners.sh` 第 9 行，原话 `RUNNER_SHARE_KEEP_MINUTES=360`；`scripts/operations/ci-runner/gh-runner-clean.timer` 第 5 行，原话 `OnCalendar=hourly`。
15. OpenSSH 可以把一把密钥限制成只能执行一条固定命令。来源：https://man.openbsd.org/sshd#AUTHORIZED_KEYS_FILE_FORMAT ，原话 “command="command" Specifies that the command is executed whenever this key is used for authentication. The command supplied by the user (if any) is ignored.”
16. GitHub 把作业派给带齐标签的空闲 runner，没有就排队。来源：https://docs.github.com/en/actions/reference/runners/self-hosted-runners ，原话 “If GitHub doesn't find an online and idle runner that matches the job's `runs-on` labels and groups, then the job will remain queued until a runner comes online.”
17. 自托管 runner 上跑过的代码可能留下长期影响。来源：https://docs.github.com/en/actions/reference/security/secure-use ，原话 “Self-hosted runners for GitHub do not have guarantees around running in ephemeral clean virtual machines, and can be persistently compromised by untrusted code in a workflow.”
18. 未核实：各个固定工具（Node、Python、gitleaks、semgrep、actionlint）都有 linux-arm64 的官方发布。工具链 PR 里逐个下载并核对校验值时才算核实。
19. 未核实：Oracle 机器上测试用的东西放在哪些目录。安装脚本装 runner 之前在机器上实查，以实查为准。

<a id="owner-decisions"></a>

## Andy 的原话

- 2026-11-12 21:55 JST：“你以后不用担心我那台 Oracle 云服务器费用的问题”，并要求把这台机器完全用起来给 CI 提速。
- 2026-11-13 01:01 JST：“那个 Oracle 的加速方案不用给我看了，方案出来之后直接实施，赶快把它加速，把整个 CI 流水线搞快起来”。

方案经过两轮模型讨论（独立方案一轮，审核一轮），记录在 `.agents/reviews/topic-ci-oracle/`。

<a id="decision"></a>

## 决定

### 1. 哪些检查在哪台机器上跑

- Oracle 机器上装 2 个 runner，名字 `ci-arm-1`、`ci-arm-2`，标签 `ci-arm`。security、static、policy 三项检查改成只在 `ci-arm` 上跑。
- build、browser、coverage 留在 CI 服务器的 `ci-vps` 上（前提 6：后两项要用 x64 的构建产物）；汇总作业仍在 `ci-vps-gate` 上。
- 每项检查固定在一种机器上跑，不让两台机器共用一个标签自动分流：同一个提交每次都在同一种架构上检查，结果才可比。
- 策略文件里每项检查写明允许的架构：security、static、policy 允许 arm64，应急时也允许 x64；其余只允许 x64。策略校验、策略的格式定义、汇总和运行入口同步修改（前提 3、4、9）。
- 运行入口不再把“不是 macOS”一律当成 x64（前提 10）：不认识的系统和架构组合直接失败；会出产物的检查在 arm64 上跑直接失败。本机入口认 linux-arm64（前提 11）。

### 2. 报告怎样交到汇总作业手里

- Oracle 上的作业照旧把报告写到本机的暂存目录，摘要照旧经 GitHub 的作业输出传给汇总作业。
- 方向是 CI 服务器去 Oracle 取，不是 Oracle 往 CI 服务器送。Oracle 上不放任何能连别处的钥匙。
- Oracle 上建一个专用账号，只放一把公钥，公钥限制成只能执行一个固定的发送脚本（前提 15），并且只接受来自 CI 服务器地址的连接。发送脚本装在 root 所有、runner 写不了的系统目录里，不加载检出目录里的任何代码；它只接受“运行号-重试号/报告名”这种名字，把那个目录里的普通文件按文件数和大小上限打成一段 JSON 输出。
- 汇总作业在收齐报告之前多一步：本机共享目录里没有、而策略写着可以在 arm64 上跑的报告，用 ssh 从 Oracle 取。ssh 固定对方的主机密钥，设连接超时和总超时。取回的 JSON 按名字规则、文件数、单个文件和合计的大小上限检查后写进共享目录，再照旧按摘要核对。途中被改、没传完、Oracle 连不上，都是汇总判失败，不会被当成通过。
- 传的是 JSON，不是 tar 包：JSON 里装不了符号链接、硬链接和设备文件。
- 私钥由安装脚本在 CI 服务器上生成，放在汇总 runner 的目录里，两个检查 runner 看不到；不进仓库，不进 GitHub 的密钥设置。这把钥匙泄露了也只能读 Oracle 上的 CI 报告。
- Oracle 的暂存目录每小时清一次，删掉 6 小时以前的（前提 14 的同一规则）。

### 3. 工具链

- 仍然只有一份工具链锁文件（前提 8），每个工具补上 linux-arm64 的下载地址和校验值。锁文件校验按每个工具各自的文件命名检查平台：ARM 条目里混进 x64 的文件必须失败，任何一个工具缺 ARM 条目也必须失败。
- 这个 PR 由 ARM 测试机线程做，附上每个工具在 ARM 上下载、校验通过的记录（前提 7、18）。

### 4. Oracle 机器上怎么装

- 安装脚本给 Oracle 单独一套配置：主机名、arm64 的 runner 安装包和校验值、用户、目录、服务文件、防火墙规则、内存分组。暂停、恢复、注册、卸载脚本同时管两台机器。
- 每个 runner 一个专用用户和一个 systemd 服务，看不到 `/home`，只能写自己的目录和暂存目录；测试数据的目录逐个列为不可见，装完逐个验证确实读不到（前提 19）；防火墙对 runner 账号拒绝私有网段、云的元数据地址和本机监听端口。
- 两个 runner 的内存合计上限 18 GB，给测试留 6 GB；CPU 不设硬上限。

### 5. Oracle 不在时

- Oracle 停了或 runner 掉线：三项检查排队等着（前提 16），不会被当成通过。在 Mac 上跑一条应急命令，把 `ci-arm` 标签临时加到 CI 服务器的两个检查 runner 上，作业由它们接，速度回到现在的样子；Oracle 恢复后再跑一次去掉。
- 这和 ADR 0256 给汇总 runner 准备的应急做法相同：要人跑一条命令，不自动回退。

### 6. 先试跑，用数据决定切换

- 切换之前加一个不计入必过结论的试跑工作流：每个 PR 的 security、static、policy 在 Oracle 上多跑一遍，和 x64 的结论逐次对比。试跑只占 Oracle，不占 CI 服务器。
- 连续 20 次结论一致、ARM 上的时长不超过 x64 的 1.5 倍，才切换；否则停下来带着数据找 Andy。
- 切换时先切 security，跑通后切 static 和 policy，同时去掉试跑工作流。

### 7. 顺序

1. 工具链 PR（ARM 测试机线程）。
2. 安装 PR：Oracle 上的 runner、发送账号和发送脚本、取报告的那一步、两台机器的暂停恢复、应急脚本、测试、运行手册。Andy 在 Mac 上运行安装命令。
3. 策略 PR：允许架构的字段、运行入口和本机入口的改动、试跑工作流。
4. 试跑并收集数据。
5. 切换 PR。
6. 观察一周，按架构统计时长、排队时间和失败率，再决定 Oracle 上加不加第 3 个 runner。

<a id="options"></a>

## 比较过的方案

- 让 Oracle 把报告送到 CI 服务器：不采用。要在 Oracle 上放一把能连 CI 服务器的私钥，那里跑的 PR 代码读得到它；还要在 CI 服务器上新开一个能写共享目录的账号。
- 两台机器共用一个标签，谁空谁接：不采用。同一个提交可能这次在 x64 上、下次在 ARM 上检查，结果不可比，出了差异也查不清。
- 用 GitHub 的产物或缓存传报告：不采用（前提 12）。
- 把 build、browser、coverage 也搬到 ARM：不采用（前提 6），生产是 x64。
- 在两台机器之间挂网络文件系统：不采用，多一个会坏的东西，权限也更难收紧。
- 每次运行签发一把短期凭证：不采用。方向反过来之后钥匙只读、只能读 CI 报告，再加一套签发服务不值得。
- ARM 的工具链用独立的锁文件：不采用（前提 8）。
- 不试跑直接切换：不采用。ARM 上的结论和时长没有数据之前，不能让必过检查依赖它。

<a id="consequences"></a>

## 后果

- 同一时间能跑的检查作业从 2 个变成 4 个；policy、static、security 和 build 可以同时在两台机器上跑。
- 必过检查开始依赖 Oracle 这台机器。它被回收或停机时，三项检查会排队，直到有人跑应急命令。
- 这台机器同时是测试机。上面的限制挡得住“顺手读到测试数据”，挡不住有人存心利用系统漏洞（前提 17）；仓库是私有的，只有 Andy 和他的代理提交，这和 CI 服务器接受的前提相同，差别是这台机器上还有别的东西。
- [ADR 0238](0238-ci-job-files-stay-on-the-ci-vps.md) 的“只有 CI 服务器上的 runner 能跑这套 CI”改为：三项检查可以在 Oracle 上跑，报告由汇总作业取回（前提 13）。共享目录的信任范围没有变大：往里写的仍然只有 CI 服务器上的 runner 账号。
- ARM 测试机线程原先打算让 ARM 用独立的锁文件、不进必过检查；这份 ADR 定为一份锁文件、ARM 进必过检查，那边的 ADR 落地时按这份修订。
- GitHub 上不花钱。Oracle 机器的费用 Andy 已说不用担心。

<a id="verification"></a>

## 验证

- 发送脚本：非法名字、不存在的目录、符号链接、超过文件数、超过大小，每条一个反向用例。
- 取报告：对端超时、主机密钥不对、JSON 里有非法路径、重复路径、超大文件、合计超限、摘要对不上，每条一个反向用例。
- 策略：security 改到 `ci-arm` 而策略没改必须失败；build 改到 `ci-arm` 必须失败；build 的报告写着 arm64，汇总必须失败；基准是旧策略、提议的是新策略能通过。
- 工具链：锁文件的 ARM 条目缺一个、或混进 x64 的文件必须失败。
- runner 脚本：Oracle 的 runner 带了 `ci-vps` 必须失败；应急命令在暂停状态下拒绝执行。
- 安装后在 Oracle 上验证 runner 账号读不到每一个测试数据目录。
- 切换后：真实 PR 的三项检查落在 `ci-arm-1` 或 `ci-arm-2` 上、`ci/required` 成功；停掉 Oracle 的 runner、跑应急命令，确认作业由 CI 服务器接并成功。
- 一周后量排队时间，和 `.agents/evidence/ci-queue-2026-11-12.md` 的数字对比。

<a id="references"></a>

## 关联文档

- [ADR 0176：CI 在自己的服务器上跑](0176-ci-on-ovh-vps.md)
- [ADR 0238：CI 作业的文件留在 CI 服务器上](0238-ci-job-files-stay-on-the-ci-vps.md)
- [ADR 0243：CI 不用 GitHub 产物](0243-ci-uses-no-github-artifacts.md)
- [ADR 0256：汇总作业用专用 runner](0256-gate-job-gets-its-own-runner.md)
- [CI 服务器 runner 运行手册](../runbooks/ci-vps-runner-runbook.md)
