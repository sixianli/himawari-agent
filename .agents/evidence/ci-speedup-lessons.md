# CI 提速经验记录

> **只是参考，不是规则**。这里记的是另一个线程给 Himawari 的 CI 提速时积累的经验，不是“CI 开源工具”线程必须遵守的规则，也不限定它的方案范围。开源工具面对的用户、机器和约束都不一样，这里的做法换个场景可能不是最好的。请从问题本身出发，大胆想更好的做法和更多可能性；这里的数据和踩过的坑可以拿来验证想法，不必照搬。

这份文档记的是“让 CI 变快变顺”线程给 Himawari 的 CI 提速时做过的每一项优化：发现了什么、前后实测数据、成功还是失败、为什么，以及对“CI 开源工具”线程有什么用。Andy 2026-11-15 要求从这天起持续记，开源工具线程重新开工时先读这份。CI（持续集成）是每次推送后 GitHub Actions 自动跑的检查；runner 是装在自己机器上、替 GitHub 执行 CI 作业的程序，一个 runner 一次只跑一个作业。

- [机器和作业现状](#setup)
- [优化记录](#entries)
- [踩过的坑](#pitfalls)
- [可供参考的几点](#takeaways)
- [怎样追加](#how-to-add)

<a id="setup"></a>
## 机器和作业现状

数据截至 2026-11-15。

| 机器 | 配置 | runner | 跑什么 |
| --- | --- | --- | --- |
| CI 服务器（OVH） | 8 vCPU、22 GB | `ci-vps-1`、`ci-vps-2`、`ci-vps-3`（合计内存上限 16 GB） | build、三份 tests、三个 browser |
| CI 服务器（同一台） | 单独内存池，预留 2 GB、上限 4 GB | `ci-vps-gate` | 汇总作业 `ci/required` |
| Oracle 东京 ARM | 4 核 24 GB | `ci-arm-1`、`ci-arm-2` | policy、static、security、tooling |

来源：`docs/runbooks/ci-vps-runner-runbook.md` 第 17、67、180 行；`.github/workflows/ci.yml` 各作业的 `runs-on`。表里只列 `ci.yml` 一次完整运行的作业；另外 `main.yml` 的 `main/evidence`（约 20 秒）跑在 `ci-vps`，`merge-queue.yml` 跑在 `ci-arm`（CI 门禁临时放宽期间只手动触发）。

一次完整运行的依赖顺序：policy → build → tests（三份）和 browser（三个）→ `ci/required`；static、security、tooling 只等 policy。

<a id="entries"></a>
## 优化记录

每条按“做了什么 / 前后数据 / 结果 / 为什么 / 可供参考的地方”写。

<a id="gate-runner"></a>
### 1. 汇总作业单独一个 runner（ADR 0256，2026-11-13）

- 做了什么：给 `ci/required` 单独装一个 runner（`ci-vps-gate`），放进自己的内存池（当时上限 2 GB；2026-11-14 收报告时在 2 GB 处被系统杀掉一次，调到 4 GB），检查作业不能占它。
- 之前：2026-11-12 19:30 JST 有 28 次运行在排队，其中 20 次的检查作业早已跳过或取消，只剩 `ci/required` 在等 runner；main 合并后的确认运行等了近 4 小时才开始第一个作业（`.agents/evidence/ci-queue-2026-11-12.md`）。
- 之后：草稿运行的汇总 7 秒结束（运行 43257576947，`.agents/evidence/ci-gate-memory-2026-11-13.md`）。2026-11-15 04:07–06:43 UTC 的 100 次运行里，`ci-vps-gate` 跑了 82 次 `ci/required`，只占它 5% 的时间。
- 结果：成功。
- 为什么：排队的主因不是机器慢，而是几秒钟就能结束的汇总作业排在 13 分钟的检查作业后面。汇总作业几乎不吃资源，给它专用位置的代价很小。
- 可供参考：这里是先看排队里是什么作业在等，再决定加机器还是调度。“轻作业专用通道”很便宜，收益很大。

<a id="arm-checks"></a>
### 2. policy、static、security 搬到 Oracle ARM（ADR 0266，2026-11-13）

- 做了什么：Oracle ARM 机器装两个 runner，三项不依赖 x64 的检查搬过去；汇总作业用受限 ssh 密钥去 ARM 取报告。原计划试跑 20 次结论一致再切，实际 Andy 要求马上切，没有等，改为切换后看真实运行数据（ADR 0266 决定第 6 条），试跑工作流已删除。
- 试跑数据（2026-11-13 PR 464 上的一次试跑，数字出自线程当时的记录，仓库里没有归档，未核实）：policy ARM 13:49 对 x64 14:08，static 15:00 对 14:10，security 5:36 对 5:39（分:秒）。ARM 4 核和 x64 8 核单项速度差不多。
- 结果：成功，CI 服务器的 runner 少了三个长作业。
- 为什么：这几项检查不依赖 x64 构建产物，可以放到别的架构的机器上。
- 可供参考：异构机器可以按“作业需不需要某种架构的产物”来分活。这里是先切、再用真实运行数据观察，同时保留 x64 作为应急。

<a id="no-coverage-on-prs"></a>
### 3. PR 上不再统计覆盖率，tooling 测试单独在 ARM 并行（ADR 0267，2026-11-14）

- 做了什么：原来的 `coverage` 作业带覆盖率插桩跑六个测试项目，还要先等 policy，而 policy 里又跑了一遍 tooling 测试。改成：PR 上的 `tests` 不插桩；tooling 测试单独成一个作业在 ARM 上跑，和 tests 并行；覆盖率计划改到每天 03:00 JST 在 main 上量一次。
- 之前：coverage 作业约 60 分钟（Andy 原话“不要再把那个老的 coverage 再拿去跑 60 分钟了”）；同一批 tooling 测试在 policy 和 coverage 里各跑一遍（`.agents/evidence/ci-test-timing-2026-11-13.md`）。policy 作业 13 到 14 分钟。
- 之后：tests 作业约 50 分钟（`.agents/evidence/ci-tests-split-2026-11-15.md`）；policy 作业约 3 分 20 秒（2026-11-15 run 43680214152：06:00:35–06:03:56）。
- 结果：第 1 步成功，policy 从 13 分钟降到 3 分钟，后面所有作业都提早开始。第 2 步（夜里量覆盖率）还没做，在那之前覆盖率暂时没人统计（ADR 0267 第 83 行；`ci/quality-policy.json` 里定时任务是 `"enabled": false`）。
- 为什么：重复执行和插桩是纯开销；覆盖率不需要每个 PR 都量。
- 可供参考：这次收益来自找出“同一批测试跑了两遍”和“每次都做、其实每天做一次就够”的步骤。

<a id="tests-split"></a>
### 4. tests 作业拆成三台并行（ADR 0275，PR 545，2026-11-15）

- 做了什么：一个 tests 作业依次跑五个项目，拆成三个并行成员：integration 第 1 份、integration 第 2 份（测试文件按路径排序后轮流分），others（unit、contracts、e2e、pi-compat）。同时把 tooling 测试的单条超时从 5 秒放到 30 秒。
- 之前：tests 一个作业约 50 分钟（integration 2021 秒、unit 596 秒、contracts 110 秒）。同一台机器上另外两个 runner 在 browser 跑完后闲着。从第一个作业开始到整次运行结束约 59 分钟。
- 之后（拆分后第一次 main 运行，run 43675431801，作业时间见 `.agents/evidence/ci-runs-2026-11-15.md`）：integration-1 17 分钟、integration-2 25 分钟、others 16 分钟（测试本身用时），tests 这一段 36 分钟；整次运行 46 分钟。三个成员全绿，没有内存超限被杀。
- 结果：成功，tests 段 50 → 36 分钟，整次 59 → 46 分钟。ADR 预计 tests 段 20 分钟，实际 36 分钟，差在 integration-1 等了 15 分钟才拿到 runner，以及两份 integration 不平均（17 对 25 分钟）。
- 为什么：拆分前一台 runner 串行跑，另外两台闲着。
- 可供参考：按文件个数平分不等于按用时平分，用历史用时分份可能更平均。并行成员多于 runner 时，排队会吃掉一部分收益。

<a id="arm-tooling-timeout"></a>
### 5. ARM 上 tooling 测试偶尔超时（2026-11-15，和第 4 条同一个 PR）

- 发现：连续两次 main 运行，tooling 各有两条测试超过 vitest 默认的 5 秒超时而失败，两次失败的测试不全相同；第三次全过。101 个 tooling 测试文件里 59 个起子进程、29 个建临时 git 仓库，4 核机器上和 static 同时跑时负载到每核 1.45（run 43671620922）。
- 做法：tooling 的单条超时放到 30 秒，没有减并发（减并发会让整个作业变慢，而失败是单条超时，不是并发出错）。
- 之后：拆分后的几次 main 运行里 tooling 没再因超时失败（run 43675431801、43678751781 都是 success）。
- 结果：成功（还在观察）。
- 可供参考：起子进程、建 git 仓库的测试在小核数机器上和别的作业挤在一起时，固定 5 秒超时太紧。先看是不是卡死（再跑一次能过就不是），再调超时。

<a id="oracle-utilization"></a>
### 6. Oracle 利用率（2026-11-15 测量，优化进行中）

- 测量（`.agents/evidence/ci-runs-2026-11-15.md`）：2026-11-15 04:07–06:43 UTC 的 100 次运行里，`ci-arm-1` 有 53% 的时间在跑作业，`ci-arm-2` 是 60%；CI 服务器三个 runner 各约 58% 到 60%。
- 发现：run 43675431801（共 46 分钟）里，ARM 在第 25 分钟跑完自己的四项，最后约 21 分钟 ARM 上没有这次运行的作业；run 43678751781（共 50 分钟）里是第 31 分钟跑完、最后约 20 分钟空着。同一时间 CI 服务器三个 runner 要排 7 个作业（build、三份 tests、三个 browser），integration-1 在两次运行里分别等了 15 分钟和 9 分钟才拿到 runner。24 GB 内存基本没用上（未实测内存，按 runner 只有两个推断）。
- 计划：把一份 integration 挪到 ARM，和 CI 服务器并行，省掉 integration-1 等 runner 的 9 到 15 分钟（估算，未实测）。要先解决三件事：
  1. integration 测试在 ARM 上能不能过（沙箱等和系统相关的用例没在 ARM 上跑过）。
  2. tests 作业要拿本次的 build 产物核对，现在只能从 CI 服务器本机取（`scripts/ci/run-share.mjs` 的 `get` 只读本机目录），`scripts/ci/run.mjs` 也要求产物的平台和本机一致；ARM 上的作业需要新的取产物办法，或者让 ARM 自己出产物。
  3. ARM 只有 4 核，tooling 和 static 同时跑时每核负载已到 1.45；再加 integration 可能更挤，要先量。
- 结果：待补。

<a id="pitfalls"></a>
## 踩过的坑

| 事件 | 发生了什么 | 原因 | 怎么防 |
| --- | --- | --- | --- |
| 产物存储爆了（I-95，2026-11-11 起，11-12 登记） | 所有 PR 和 main 的 `ci/required` 在上传步骤失败，删旧产物 9 小时后仍被拒 | 每次运行都往 GitHub 产物存储上传完整报告，免费额度 500 MB 按小时累计，用完就拦，删了也要到下个账单周期才清零 | 报告放 CI 服务器本机目录，GitHub 上只放 KB 级汇总；Andy 定的规则：绝不在 GitHub 上花钱 |
| main 上 30 多次合并没跑 CI（I-93，2026-11-10 起，11-11 登记） | `main.yml` 每次都 `startup_failure`，一个作业都没启动，没人发现 | 被调用的 `ci.yml` 要的权限比调用方 `main.yml` 给的大，GitHub 在启动时整个拒掉 | 检查脚本核对调用方和被调用方的权限 |
| 被取消作业的子进程逃过清理（I-99，2026-11-13） | 下一个作业报 `CI_OUTPUT_ALREADY_EXISTS`，什么也没跑 | runner 取消作业时只对步骤的 bash 发信号，作业结束时只清理带本作业 `RUNNER_TRACKING_ID` 的进程；检查脚本起的子进程没带这个变量 | 子进程继承 `RUNNER_TRACKING_ID` |
| CI 从 10-25 起没成功过（I-102，2026-11-14） | 三个浏览器检查都过，汇总仍判失败 | 汇总脚本递归读报告目录里所有叫 `result.json` 的文件，把浏览器场景写的同名文件当成检查结果 | 只读约定位置的报告；汇总规则有测试 |
| runner 在线但不领活（2026-11-14） | `ci-vps-3` 从 20:24 JST 起 40 分钟不接活，没人发现，Andy 来催 | 原因未查清，重启服务后恢复 | 每小时一次的定时检查：某标签有作业排队满 20 分钟而有 runner 空着，就给 Andy 发重启命令 |
| 合并太快，lint 警告进了 main（I-100，2026-11-14） | 所有合了 main 的 PR 的 static 变红 | 推送钩子只跑格式检查不跑 lint，PR 在 static 跑完前就合了 | 推送钩子加 lint |
| 发布验收的定位直接写在测试里（2026-11-15，PR 565） | main 上 `npm run check` 挂了，所有合 main 的 PR 都卡住 | 85c11a949 的提交说明写着“云端会话未跑 npm run check，只对改动的测试文件跑了 biome check” | 合并前本地 `npm run check` 必过 |
| main 确认运行一路被取消 | 合并很频繁时，`Main confirmation` 只有正在跑的那次能跑完，排队的被新的替掉，显示 cancelled | 工作流并发组 `main-confirmation`、`cancel-in-progress: false`：同时只跑一个，新排队的替掉旧排队的 | 看 main 状态时只看跑完的那几次；不要把 cancelled 当失败 |
| webkit 随机失败 | `page.goto: WebKit encountered an internal error` | 快速连续跳页时 WebKit 自身出错（本机复现约三到五成），未修 | 再出现时单独查根因 |

<a id="takeaways"></a>
## 可供参考的几点

下面是这个线程自己的体会，只供参考，不一定适合开源工具的场景。

1. 先量再改：这里每一项优化，都是先从 GitHub 接口读作业的开始、结束时间和 runner 名，算出排队时间和忙闲比例，才发现问题。
2. 排队往往比机器慢更伤：轻作业排在重作业后面（第 1 条）、并行成员多于 runner（第 4 条）、一台机器先跑完就闲着（第 6 条）。
3. 去掉重复和不必要的工作最划算：同一批测试跑两遍、每个 PR 都量覆盖率（第 3 条）。
4. 按文件个数平分，用时不一定平均（第 4 条：17 对 25 分钟），按历史用时分可能更好。
5. 小核数机器上，起子进程的测试用 5 秒超时显得太紧（第 5 条）。
6. 免费额度会悄悄耗光：这里的做法是报告和产物放自己的机器，GitHub 上只放小汇总。
7. runner 会“在线但不领活”：这里靠定时检查发现，也许还有更好的办法。
8. 这个项目的做法是每个事故都配一道自动检查，目的是让同样的错不再犯。

<a id="how-to-add"></a>
## 怎样追加

每做一项优化或踩一个坑，在“优化记录”或“踩过的坑”里加一条：写清做了什么、前后实测数据（耗时、排队时间、利用率，附运行号或证据文件）、成功还是失败、为什么。计划中的写“待补”，实测后补上数据。
