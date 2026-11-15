你是独立的方案审核者。
你能用的工具：read、grep、glob、websearch、webfetch，以及 git diff、git log、git show、git blame、git status 这几条 git 命令。不能修改任何文件，不能运行别的命令。可以用 websearch 搜索、用 webfetch 读网页；业界做法只认一手来源（官方文档、各大 AI 公司的工程文章、成熟开源项目的源码），每条都附网址。
下面是一份还没动手实施的方案。逐条对照代码和一手来源核对：有没有漏掉的场景、判断错的地方、和业界成熟做法不一致的地方。方案作者的说法可能有错。
做法：先想清楚要回答哪几个问题、需要看哪些文件或资料，再直接去读这些地方；不要漫无目的地浏览代码，也不要用相同或相近的参数反复调用工具。读到的内容一旦足以下结论，就停止调用工具，写出结论；没读到的地方标「未核实」，不要为了查全而一直查下去。
列出的方案只是参考，请从问题本身出发，提出你认为更好的方案。
必答问题：
1. 这个改动会不会改变模型已经见过的请求开头？包括系统提示、工具定义、历史消息、遮盖结果。要求回答：发给模型的内容是不是仍然只在末尾追加，每轮会变的值是不是都在最后一条消息里。依据：[发给模型的内容只追加](../../.claude/rules/prompt-prefix.md#rules)。
2. 这个改动会不会让同一段文字在不同请求里变成不同的字节（例如依赖前后文的遮盖、带时间的字段、无序的集合）？
3. 改动有没有对应的自动检查，反向用例是否真的会失败？
4. 改动产生或修改的每个值（标识、字段、配置键、清单项、序列化格式），每一个使用它的地方都能接受吗？逐个找到产生它的地方和使用它的地方，核对两端的校验，只看改动本身不够。依据：[I-73](../../docs/incidents-and-gates.md#incidents)，双模型复核只看了改动，没问“清单里的 id 能通过后端校验吗”。
你的额外侧重：错误路径、不合规范或不可信的输入、安全、资源耗尽、不可撤销的操作，以及规则文件、说明文档和代码是否一致。有时另有一个复核者侧重别的方面，有时只有你一个，所以你都要回答全部必答问题、报告你发现的任何问题；侧重只决定你先查什么。在结论之前单独写一节「侧重检查」，列出你查过的这类路径和结论。
输出格式：按严重度从高到低排列，每条写：严重度、问题、证据（文件:行引用的代码，或网址和原话）、你建议怎么改。把「证实的」和「推测」分开写。最后写：如果由你来定，你会怎样改这份方案，并逐条回答必答问题。用简体中文。

---- 本次材料 ----
仓库就是当前目录，已检出 19c5c4852fc32c0f3c2917847fc6d09180358f81。
待审核的方案：
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
9. ARM 测试机线程原来打算把 ARM 的工具链放在独立的锁文件里。来源：分支 `claude/project-thread-q668e8` 的 `docs/adr/0253-support-linux-arm64-for-test-and-qualification.md` 决定第 3 条，原话“ARM 的工具链放在独立的锁文件里，有自己的校验和自己的摘要字段；`ci/toolchain-lock.json`、`ci/policy.json`、`scripts/ci/check-policy.mjs`、`scripts/ci/aggregate.mjs` 和工作流文件不改”。代码还没写。
10. ADR 0253 原先不让 ARM 进必过检查。来源：同一份文件，原话“把 linux-arm64 加进 `ci/policy.json` 的必过检查｜不采用｜测试机可能被 Oracle 回收，不能让必过检查依赖它”。
11. OpenSSH 可以把一把密钥限制成只能执行一条固定命令。来源：https://man.openbsd.org/sshd#AUTHORIZED_KEYS_FILE_FORMAT ，原话 “command="command" Specifies that the command is executed whenever this key is used for authentication. The command supplied by the user (if any) is ignored.”“restrict Enable all restrictions, i.e. disable port, agent and X11 forwarding, as well as disabling PTY allocation and execution of ~/.ssh/rc.”
12. gitleaks、semgrep、actionlint、Node、Python 是否都有 linux-arm64 的官方发布：DeepSeek 的独立方案列了各自的发布页，我没有逐个打开，未核实；工具链 PR 里逐个下载并核对校验值时才算核实。
13. GitHub 把作业派给带齐 `runs-on` 标签的任何一个空闲 runner，没有空闲的就排队。来源：https://docs.github.com/en/actions/reference/runners/self-hosted-runners ，原话 “When routing a job to a self-hosted runner, GitHub looks for a runner that matches the job's `runs-on` labels and groups”“If GitHub doesn't find an online and idle runner that matches the job's `runs-on` labels and groups, then the job will remain queued until a runner comes online.”
14. 自托管 runner 上跑过的代码可能留下长期影响。来源：https://docs.github.com/en/actions/reference/security/secure-use ，原话 “Self-hosted runners for GitHub do not have guarantees around running in ephemeral clean virtual machines, and can be persistently compromised by untrusted code in a workflow.”
15. 报告的架构现在必须等于策略里成员写的架构。来源：`scripts/ci/aggregate.mjs` 第 99 到 101 行，原话 `for (const field of ["node", "os", "arch"])`、`if (result.toolchain[field] !== member[field])`；`scripts/ci/run.mjs` 第 131、132 行，原话 `if (hosted && (member.os !== process.platform || member.arch !== process.arch))`、`throw new Error("CI_RUNNER_PLATFORM_MISMATCH");`。

## 和独立方案比较后的取舍

DeepSeek 的独立方案（`round-1/deepseek-v4.1-flash.md`）和我原来的方案主方向相同（报告经受限 ssh 送回 CI 服务器、汇总端照旧按摘要核对、build 和 browser、coverage 不搬）。三处不同，逐条定了：

- 采纳“共用标签”：我原来把 policy、static 固定在 ARM 上，Oracle 机器一停全部 PR 就卡住，要靠回退 PR 救。改成两台机器的 runner 都带一个新标签，哪台空就哪台接；Oracle 不在时作业自动落回 CI 服务器，不用改代码。代价是同一个检查这次在 x64、下次在 ARM 上跑，所以上线前要先对比两边结果，日志里写明这次的架构。
- 采纳“一份锁文件”：ARM 的工具条目加进现有的 `ci/toolchain-lock.json`，不另开一份。理由：汇总时只核对这一份的摘要（前提 7），另开一份就要给每份报告再加一个摘要字段并在汇总端核对，多一套东西。代价是主锁文件的摘要变一次，和平时升级一个工具一样。这和 ARM 测试机线程原来的打算（独立锁文件，前提 9）不同，要和它重新约定。
- 部分采纳“先搬 security”：security 最简单，先用它验证整条路；static 和 policy 在 Oracle 上实跑、结果和 x64 一致之后再加进来。不采纳“policy 不搬”：policy 是最长的两个作业之一，而且别的作业要等它，它能在 ARM 上跑才省得最多。

## 方案

### 搬哪些作业

- 新标签 `ci-linux`：CI 服务器的 1、2 号 runner 同时带 `ci-vps` 和 `ci-linux`；Oracle 上的 runner 只带 `ci-linux`。
- 第一步只让 security 用 `runs-on: ci-linux`；Oracle 上实跑对比通过后，static、policy 也改成 `ci-linux`。
- build、browser、coverage 留在 `ci-vps`（前提 5，线上是 x64）；汇总作业按 ADR 0256 在 `ci-vps-gate`。
- Oracle 机器装 2 个 runner（`ci-arm-1`、`ci-arm-2`）。同时能跑的检查作业从 2 个变 4 个。
- `ci/policy.json` 的成员加一个可选字段，写明这个检查允许的架构（security、static、policy 是 x64 和 arm64，其余只有 x64）；不写就只允许成员原来的那一种架构。

### 报告怎样交到汇总作业手里

- 汇总作业仍在 CI 服务器上，仍从本机目录 `/srv/gh-runner-share` 收报告、按摘要核对（前提 4）。
- 每个用 `ci-linux` 的作业在 `put` 之后多一步 `run-share.mjs push`：在 CI 服务器上跑时什么都不做；在 Oracle 上跑时，用 ssh 把报告目录打成 tar 流送到 CI 服务器。Oracle 上 `put` 写的是本机的一个暂存目录，摘要照旧写进作业输出。
- CI 服务器上新建一个专用账号，只放一把公钥，公钥带 `restrict,command="…"`（前提 11）：不管对方发什么命令，只执行仓库里的一个接收脚本。接收脚本只接受“运行号-重试号/报告名”这种名字（和 `run-share.mjs` 用同一条规则），先解到暂存目录，拒绝符号链接、跳出目录的路径和超过大小上限的内容，目标已存在就拒绝，权限设成和本机 `put` 一样，最后改名放进共享目录。
- 摘要经 GitHub 的作业输出传，文件经 ssh 传；汇总作业 `collect` 时按摘要核对，途中被改或没传完都会判失败。
- 私钥放在 Oracle 机器 runner 用户的目录里，由安装脚本生成，不进仓库，不进 GitHub 的密钥设置。跑在 Oracle 上的 PR 代码读得到这把私钥，但它只能往共享目录里送一份新报告，冒充别的运行的报告过不了摘要核对。能塞满 CI 服务器磁盘是剩下的风险，靠大小上限和每小时清理挡。
- CI 服务器的防火墙只对 Oracle 机器的地址放开 ssh 端口。

### 工具链和摘要核对

- `install-tools.mjs` 认 linux-arm64，`ci/toolchain-lock.json` 每个工具补 linux-arm64 的下载地址和校验值；锁文件校验按平台检查文件名（ARM 条目里混进 x64 的文件必须失败）。
- `run.mjs` 和 `aggregate.mjs` 现在要求报告的架构等于成员写的架构，改成“在成员允许的架构里”。x64 和 ARM 的报告带同一个锁文件摘要，汇总端核对不用改。
- `check-policy.mjs`：允许 arm64 的只能是 security、static、policy，而且必须 `runs-on: ci-linux`；build、browser、coverage 必须 `ci-vps` 且只有 x64；`push` 那一步逐字比对。按现有的升级链加一段，让“目标分支还是旧策略”的 PR 能通过。
- 这修改了 ADR 0253 里“这些文件不改”“ARM 的工具链放在独立的锁文件里”和“ARM 不进必过检查”三条，ADR 里写明；必过检查并不依赖 Oracle 机器在线（它不在时由 x64 接）。

### Oracle 机器上怎么装

- 沿用 `scripts/operations/ci-runner/` 的做法：每个 runner 一个专用用户、systemd 服务、`ProtectHome=yes`、`ProtectSystem=strict`、`ReadWritePaths` 只放开 runner 自己的目录和本机暂存目录，不进 docker 组；防火墙对 runner 账号拒绝私有网段、元数据服务地址和本机监听端口。
- 内存归一个分组管，上限 18 GB，给测试留 6 GB。CPU 不设硬上限，用 `CPUWeight` 让 CI 和测试同时跑时 CI 占多数。
- 这台机器同时是测试机，上面有测试用的数据和配置。runner 用户读不到别的用户的家目录，但 GitHub 官方说明自托管 runner 上的代码可以留下长期后门，systemd 的限制只是降低风险。仓库私有、只有 Andy 和他的代理提交，这和 CI 服务器接受的前提相同；差别是这台机器上还有别的东西。这一条要 Andy 知道并点头。
- 安装脚本从 Mac 上跑。Andy 要做的：在 Mac 上跑一条命令装 Oracle 上的 runner，一条命令在 CI 服务器上建接收账号、放公钥并给 1、2 号 runner 加 `ci-linux` 标签。

### 机器不在时

- Oracle 机器停了、被回收、runner 掉线：`ci-linux` 的作业由 CI 服务器的 1、2 号 runner 接，速度回到现在的样子，不用改代码。
- 作业跑到一半 Oracle 掉了：那个作业失败，汇总判失败，重跑整轮。
- 接收账号或网络坏了：`push` 失败，作业失败，不会被当成通过。在 Mac 上把 Oracle 两个 runner 的 `ci-linux` 标签去掉，作业就全走 CI 服务器。
- 暂停和恢复脚本要把 Oracle 的 runner 一起管，体检时一起报。

### 顺序

1. 工具链 PR：`install-tools.mjs` 和锁文件认 linux-arm64（和 ARM 测试机线程商量由谁做）。
2. 在 Oracle 机器上手工跑一次 security、static、policy 检查，记时间和内存，和 x64 的结果逐项对比。比 CI 服务器慢一倍以上，或结果不一致，就停下来重新商量。
3. 安装脚本 PR：Oracle 上的 runner、CI 服务器上的接收账号和接收脚本、`run-share.mjs push`、测试、运行手册。Andy 在 Mac 上装好，确认 runner 在线、送一份测试报告能到。
4. 策略和工作流 PR：先只改 security。跑通后再一个 PR 把 static、policy 加进来。
5. 观察一周，按架构统计时长、排队时间和失败率，再决定 Oracle 上加不加第 3 个 runner。

### 不做的

- 不用 GitHub 产物或缓存传报告（前提 8）。
- 不把 build、browser、coverage 搬到 ARM（前提 5）。
- 不在两台机器之间挂网络文件系统：`run-share.mjs` 的权限和改名操作靠本机文件系统的行为，网络盘上不一定成立。
- 不让同一个检查在两种架构上各跑一遍：时间加倍，和提速相反。
- 不把作业固定在 ARM 上（我原来的方案）：Oracle 一停就要靠回退 PR。

## 花钱

GitHub 上 0 元。Oracle 机器的费用 Andy 已说不用担心。

## 验证

- `run-share` 的测试：x64 上 `push` 什么都不做；ARM 上没配置对端时失败；接收脚本拒绝非法名字、重复、超大、符号链接、跳出目录的路径（每条一个反向用例）。
- `policy.test.mjs` 反向用例：security 改回 `ci-vps` 而策略没改必须失败；build 改到 `ci-linux` 必须失败；build 的报告写着 arm64，汇总必须失败；锁文件的 ARM 条目缺一个或混进 x64 文件必须失败。
- runner 脚本的测试：Oracle 的 runner 带了 `ci-vps` 必须失败；暂停后 Oracle 的 runner 还带着 `ci-linux` 必须失败。
- 上线后：真实 PR 运行里 security 落在 `ci-arm-*` 上、`ci/required` 成功的至少一次，落在 `ci-vps-*` 上成功的至少一次；停掉 Oracle 的 runner，确认作业自动由 CI 服务器接。
- 一周后量排队时间，和 2026-11-12 的数字对比。
