# 线程的方案：把 Oracle 的 ARM 机器接进 CI

## 前提和来源

1. 一次完整运行有 6 个检查作业，现在全部在 CI 服务器的两个 runner（装在自己机器上、替 GitHub 执行 CI 任务的程序）上跑。来源：`.github/workflows/ci.yml` 第 33、72、236、284 行 `runs-on: ci-vps`；第 115、165 行 `runs-on: ${{ matrix.runner }}`。
2. policy 和 static 各要 13 到 14 分钟，是最长的两个作业。来源：GitHub 接口 2026-11-12 的作业记录（实测，不是仓库里的文件）。
3. 每个检查在 `ci/policy.json` 里写死了跑在哪种 runner、哪种系统和架构上。来源：`ci/policy.json` 里 policy 检查的成员，原话 `"runner": "ci-vps"`、`"os": "linux"`、`"arch": "x64"`；`scripts/ci/check-policy.mjs` 第 474 行 `!job.strategy && job["runs-on"] === check.members[0].runner`。
4. 报告靠 CI 服务器本机的目录交接，汇总作业按摘要核对后收齐。来源：`scripts/ci/run-share.mjs` 的 `shareRoot`（读 `HIMAWARI_CI_SHARE`，要求本机目录）、`put`、`collect`；`.github/workflows/ci.yml` 第 65、362 行。
5. browser 和 coverage 要取 build 的 x64 产物。来源：`.github/workflows/ci.yml` 第 215、265 行，原话 `run-share.mjs get --name build-linux-x64`。
6. 固定工具现在不支持 linux-arm64。来源：`scripts/ci/install-tools.mjs` 第 25 行，原话 `const platforms = ["darwin-arm64", "linux-x64"];`。
7. 汇总时拿 `ci/toolchain-lock.json` 的摘要和每份报告上下文里的摘要比对。来源：`scripts/ci/context.mjs` 第 143 行；`scripts/ci/aggregate.mjs` 第 288、289 行，原话 `if (sha256(lockBytes) !== context.toolchainSha256)`。
8. 不用 GitHub 产物。来源：`docs/adr/0243-ci-uses-no-github-artifacts.md` 决定第 6 条，原话“`scripts/ci/check-policy.mjs` 拒绝 `ci.yml` 任何作业用 `actions/upload-artifact` 或 `actions/download-artifact`”。
9. ARM 测试机线程会先交一个小 PR：`install-tools.mjs` 认 linux-arm64、新增 `ci/toolchain-lock.linux-arm64.json`、导出“平台到锁文件路径”的函数。来源：分支 `claude/project-thread-q668e8` 的 `docs/adr/0253-support-linux-arm64-for-test-and-qualification.md` 决定第 3 条（ARM 的工具链放在独立的锁文件里）；小 PR 的拆法是两个线程的约定，代码还没写，未核实。
10. ADR 0253 原先不让 ARM 进必过检查。来源：同一份文件，原话“把 linux-arm64 加进 `ci/policy.json` 的必过检查｜不采用｜测试机可能被 Oracle 回收，不能让必过检查依赖它”。本方案要改这一条，理由见下面“机器不在时”。
11. OpenSSH 可以把一把密钥限制成只能执行一条固定命令。来源：https://man.openbsd.org/sshd#AUTHORIZED_KEYS_FILE_FORMAT ，原话 “command="command" Specifies that the command is executed whenever this key is used for authentication. The command supplied by the user (if any) is ignored.”“restrict Enable all restrictions, i.e. disable port, agent and X11 forwarding, as well as disabling PTY allocation and execution of ~/.ssh/rc.”
12. gitleaks、semgrep、actionlint 是否都有 linux-arm64 的官方发布：未核实，决定 security 搬不搬之前要先查。

## 方案

### 搬哪些作业

- policy 和 static 搬到 Oracle 机器，`ci/policy.json` 里这两个检查的成员改成 `"runner": "ci-arm"`、`"arch": "arm64"`，`ci.yml` 里 `runs-on: ci-arm`。它们不产出给别的作业用的文件，只交报告。
- build、browser、coverage 留在 CI 服务器（前提 5，线上是 x64）。
- security 第一步不搬；前提 12 查清并在 Oracle 上实跑通过后，再用同样的办法搬。
- Oracle 机器装 2 个 runner（`ci-arm-1`、`ci-arm-2`，标签只有 `ci-arm`）。效果：policy、static 两个最长的作业不再占 CI 服务器的两个 runner，CI 服务器只剩每次运行约 6 分钟的 build 加 browser、coverage、security；同时能跑的检查作业从 2 个变 4 个。
- 每个作业固定在一种架构上跑，不做“哪台空就去哪台”的混合池：`ci/policy.json` 的成员模型就是一个成员一种架构（前提 3），同一条检查这次在 x64、下次在 ARM，失败了很难重现。

### 报告怎样交到汇总作业手里

- 汇总作业仍在 CI 服务器上，仍从本机目录 `/srv/gh-runner-share` 收报告、按摘要核对。
- Oracle 上的作业跑完后，用 ssh 把报告目录打成 tar 流送到 CI 服务器。CI 服务器上新建一个专用账号，只放一把公钥，公钥带 `restrict,command="…"`（前提 11）：不管对方发什么命令，只执行仓库里的一个接收脚本。接收脚本只接受“运行号-重试号/报告名”这种名字，只写进共享目录里本次运行的子目录，已存在就拒绝，超过大小上限就拒绝，解包时拒绝符号链接和跳出目录的路径，权限设成和本机 `put` 一样。
- `run-share.mjs` 加一个子命令 `send`：先算摘要写进作业输出（和 `put` 相同的算法），再送出去。摘要经 GitHub 的作业输出传，文件经 ssh 传；汇总作业 `collect` 时按摘要核对，途中被改或没传完都会判失败。
- 私钥放在 Oracle 机器 runner 用户的目录里，由安装脚本生成，不进仓库，不进 GitHub 的密钥设置。跑在 Oracle 上的 PR 代码读得到这把私钥，但它只能往共享目录里送一份新报告，冒充别的运行的报告过不了摘要核对。
- CI 服务器的防火墙只对 Oracle 机器的地址放开 ssh 端口。

### 工具链和摘要核对

- 报告的上下文加一个平台字段；`context.mjs` 按平台取对应锁文件的摘要（用 ARM 线程导出的那个函数）。
- `aggregate.mjs` 按每份报告的平台取对应锁文件核对；`ci/policy.json` 写明每个检查允许的平台，报告的平台和策略不符就判失败。
- `check-policy.mjs`：policy、static 必须 `runs-on: ci-arm`，其余检查不得在 `ci-arm` 上；送报告的步骤逐字比对。按现有的升级链加一段，让“旧策略的 main 上的 PR 把策略升级到新策略”能通过。
- 这修改了 ADR 0253 里“这些文件不改”和“ARM 不进必过检查”两条，ADR 里写明。

### Oracle 机器上怎么装

- 沿用 `scripts/operations/ci-runner/` 的做法：专用用户、systemd 服务、`ReadWritePaths` 只放开 runner 目录、内存归一个 slice 管（上限 16 GB，给测试留 8 GB）。CPU 不设硬上限，CI 和测试同时跑时由 systemd 的 `CPUWeight` 让 CI 占多数。
- runner 用户读不到测试机上别的用户的目录（测试数据、密钥）。
- 安装脚本从 Mac 上跑（和现在装 CI 服务器的方式一样），Andy 要做的是在 Mac 上跑两条命令：一条装 Oracle 上的 runner，一条在 CI 服务器上建接收账号并放公钥。

### 机器不在时

- Oracle 机器停了，policy 和 static 没有 runner 接，所有 PR 的 `ci/required` 会一直等。
- 应对：仓库里备一个“回退”提交的做法，写进运行手册：把 `ci/policy.json` 和 `ci.yml` 里 policy、static 改回 `ci-vps`、x64。这个 PR 自己的 CI 也等不到结果，按 Andy 2026-11-12 的长期授权（CI 本身坏了时不等 CI 直接合并）合并。合并后新的 PR 运行就回到 CI 服务器。
- runner 体检脚本把 Oracle 的两个 runner 一起报，掉线时能看到。
- Andy 的账号是付费的（4 核超出免费额度），按 Oracle 的说明，闲置回收只针对免费账号：未核实，写 ADR 前要查 Oracle 官方文档。

### 顺序

1. ARM 线程的小 PR 合并（工具链认 linux-arm64）。
2. 先量：在 Oracle 机器上手工跑一次 policy 和 static 检查，记时间和内存。比 CI 服务器慢一倍以上就停下来重新商量。
3. PR A：安装脚本、接收脚本、`run-share.mjs send`、测试、运行手册。Andy 在 Mac 上装好，确认两个 runner 在线、送一份测试报告能到。
4. PR B：`ci/policy.json`、`ci.yml`、`check-policy.mjs`、`aggregate.mjs`、`context.mjs`、测试、ADR。
5. 观察一周，再决定 security 搬不搬、Oracle 上加不加第 3 个 runner。

### 不做的

- 不用 GitHub 产物或缓存传报告（前提 8）。
- 不把 build、browser、coverage 搬到 ARM（前提 5）。
- 不在两台机器之间挂网络文件系统或建专用隧道：多一个常驻服务，报告只有几百 KB，一次 ssh 就够。
- 不让同一个检查在两种架构上各跑一遍：时间加倍，和提速相反。

## 花钱

GitHub 上 0 元。Oracle 机器的费用 Andy 已说不用担心。

## 验证

- `run-share` 的测试：`send` 的摘要和 `put` 相同；接收脚本拒绝非法名字、重复、超大、符号链接、跳出目录的路径（每条一个反向用例）。
- `policy.test.mjs` 反向用例：policy 改回 `ci-vps` 而策略没改必须失败；build 改到 `ci-arm` 必须失败；报告平台和策略不符，汇总必须失败；ARM 报告带 x64 锁文件的摘要，汇总必须失败。
- 上线后：一次真实 PR 运行里 policy、static 在 `ci-arm-*` 上跑，`ci/required` 成功；停掉 Oracle 的 runner 演练一次回退。
- 一周后量排队时间，和 2026-11-12 的数字对比。
