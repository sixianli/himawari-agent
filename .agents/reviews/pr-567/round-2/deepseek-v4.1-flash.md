**本轮查过的范围**

对比了 `4851fd3..c9c5dc2` 的增量，并回看 `a809a33..c9c5dc2` 的完整文档改动。读了 `ci-speedup-lessons.md`、新增的 `ci-runs-2026-11-15.md`、`ci-tests-split/ci-test-timing/ci-gate-memory/ci-queue` 证据，ADR 0256/0266/0267/0275（用 0268 核对 merge-queue 触发方式），事故清单 I-93/95/99/100/102，`ci.yml/main.yml/merge-queue.yml/quality.yml`，运行手册第 17/67/180 行，`run-share.mjs/run.mjs/platforms.mjs`，`ci/quality-policy.json`，以及提交 `85c11a949`、`4f47e0fec`、`54ada5efd`、`fc187d6a5`、`07808c095`。GitHub 运行号 43680214152、43671620922 等外部数据无法离线核对，标为未核实。

**上一轮意见核对**

- 第 1 条已改：第 3 条现在写“计划”，并明确“第 2 步还没做”。但新引用的 `ci/quality-policy.json` 证据不对，见意见 2。
- 第 2 条已改：与 ADR 0266 决定第 6 条一致，试跑数据也标了“仓库里没有归档，未核实”。
- 第 3 条已改：`docs/runbooks/ci-vps-runner-runbook.md:67` 确认汇总 runner 预留 2 GB、上限 4 GB。
- 第 4 条已改：run 1 的 25 + 21 = 46；run 2 实际是 30m34s + 19m38s ≈ 50m12s，按“第 31 分钟/约 20 分钟”可接受。
- 第 5 条已改：补了 build 产物取不到、ARM 4 核已有负载两项前提；但“省 9 到 15 分钟”的收益仍与数据矛盾，见意见 1。
- 第 6 条部分改：补了 `main/evidence`、`merge-queue`，仍漏 `main/confirmation`，见意见 4。
- 第 7 条已改：I-93/I-95 的“起始/登记”日期与事故表一致。

### 1（中）第 6 条“省掉 integration-1 等 runner 的 9 到 15 分钟”与同一份证据里的 ARM 占用时间矛盾

文件：`.agents/evidence/ci-speedup-lessons.md:86`，数据在 `.agents/evidence/ci-runs-2026-11-15.md:9-21、32-44`。

问题：计划说把一份 integration 挪到 ARM 可以省掉 integration-1 等 runner 的 9 到 15 分钟；但按文档自己的作业时间，ARM 在 build 结束后并没有空闲到能让 integration 立即开始。

证据（读代码证实）：
- run 43675431801：build 04:33:29 结束；ARM 上 static 到 04:45:14、tooling 到 04:48:58；integration-1 04:48:50 才开始。
- run 43678751781：build 05:23:55 结束；ARM 上 tooling 到 05:32:59、static 到 05:40:33；integration-1 05:32:45 开始。

推算（非直接实测，按上面的时间）：
- run 1 最早只能提前到 04:45:14（arm-2 空出），约省 3 到 4 分钟，不是 15 分钟。
- run 2 的最早空出时间 05:32:59 比 integration-1 实际开始 05:32:45 还晚，基本省不了。
- “7 个作业（build、三份 tests、三个 browser）”里 build 在 ARM 空出前已经结束；同一时刻 VPS 上实际剩 6 个作业。

建议：改成“收益取决于 ARM 何时空出；按这两次数据 run 2 可能为 0，run 1 最多几分钟，需先量”，不要把 9 到 15 分钟写成计划收益。

### 2（中低）第 3 条把 `ci/quality-policy.json` 的定时开关当成覆盖率夜间任务的证据

文件：`.agents/evidence/ci-speedup-lessons.md:58`。

问题：`ci/quality-policy.json` 的 `schedule` 控制的是 Quality 工作流，不是覆盖率；仓库里没有覆盖率的定时工作流。该文件的 cron 是 03:23 UTC（12:23 JST），也不是文档写的 03:00 JST。

证据（读代码证实）：
- `ci/quality-policy.json:4`：`"schedule": { "enabled": false, "cron": "23 3 * * *", "timezone": "UTC" }`
- `scripts/ci/context.mjs:113`：`const policyPath = "ci/quality-policy.json";`；`:119`：`if (!policy.schedule.enabled) throw new Error("CI_QUALITY_SCHEDULE_DISABLED");`
- `.github/workflows/quality.yml:1`：“schedule 尚未授权”；workflows 里没有 coverage 的 schedule。

建议：删掉这条证据，改为“仓库里没有覆盖率的定时工作流”+ ADR 0267 第 83 行；或者明确说 Quality 的开关只是类似机制，不是覆盖率任务。

### 3（中低）takeaway 第 7 条说“这里靠定时检查发现”runner 不领活，但仓库里没有这个定时检查

文件：`.agents/evidence/ci-speedup-lessons.md:118`，对应第 101 行的“每小时一次的定时检查”。

问题：文档把“runner 在线但不领活”的自动发现写成已有做法；仓库里只有每小时清理旧工作目录的 `gh-runner-clean.timer`，没有“某标签排队满 20 分钟且 runner 空着就通知/重启”的检查。

证据（读代码证实）：
- `scripts/operations/ci-runner/gh-runner-clean.timer:5`：`OnCalendar=hourly`，它运行的是 `clean-old.sh`，只清理 `_work`/`_diag`。
- `.github/workflows` 里没有相关定时工作流。
- `mac-runners.sh` 只查询 `busy` 给暂停/恢复用，没有排队超时判断。

未核实：这个检查可能跑在仓库外（例如 Andy 的 Mac 上的 cron/launchd），但文档没有给出位置，仓库里找不到。

建议：如果没实现，改成“计划加自动发现”；如果已实现，写清脚本或定时器位置，并说明它不在本仓库。

### 4（低）上一轮第 6 条仍漏了 `main/confirmation`

文件：`.agents/evidence/ci-speedup-lessons.md:24`。

问题：新增说明只列了 `main/evidence` 和 `merge-queue`，没有列 `main/confirmation`；上一轮第 6 条点名要补三个。

证据（读代码证实）：`.github/workflows/main.yml` 的 `confirm:` 作业 `name: main/confirmation`，`runs-on: ci-vps`；该作业在轻量确认时运行，和表中 `ci-vps` 的负载有关。

建议：在说明里补 `main/confirmation`（跑在 `ci-vps`，轻量确认时用），或把“表里只列 ci.yml”改成同时列 `main.yml` 的两个作业。

### 5（低）第 4 条把 17/25/16 分钟写成可由 `ci-runs` 核对，但该文件只有作业起止时间

文件：`.agents/evidence/ci-speedup-lessons.md:67`。

问题：该行说“作业时间见 `ci-runs-2026-11-15.md`”，但该文件的 integration-1/2/others 只有 job 起止：20m23s/29m1s/19m41s，不是 17/25/16。17/25/16 是“测试本身用时”，需要作业日志里的 `durationMs` 或减去约 3 分钟准备，仓库里没有这份记录。

证据（读代码证实）：`ci-runs-2026-11-15.md:16-20`；`ci-tests-split-2026-11-15.md:13` 说拆分前 setup 约 3 分钟；`ci-speedup-lessons.md:67`。

建议：在 `ci-runs` 补上从作业日志读到的各项目 `durationMs`，或把 17/25/16 标成“job 时长减约 3 分钟准备的估算”。

### 6（低）“让 ARM 自己出产物”还缺一个前提：当前平台清单不接受 linux-arm64 产物

文件：`.agents/evidence/ci-speedup-lessons.md:88`。

问题：计划把“让 ARM 自己出产物”作为替代办法，但 `platforms.mjs` 的 `artifactPlatformKey()` 只接受 `macos-arm64`、`linux-x64`；linux-arm64 会直接报 `CI_ARTIFACT_PLATFORM_UNSUPPORTED`，`run.mjs` 的 `--input` 还要求 producer 的 matrixKey 等于本机 platform。

证据（读代码证实）：
- `scripts/ci/platforms.mjs:15-21`：`ARTIFACT_PLATFORM_KEYS = Object.freeze(["macos-arm64", "linux-x64"])`；`artifactPlatformKey` 对不在清单里的平台抛错。
- `scripts/ci/run.mjs:610-617`：`producer.matrixKey !== platform` 时抛 `CI_ARTIFACT_PRODUCER_INVALID`。

建议：补一句“ARM 出产物要先把 linux-arm64 加进产物平台清单和 build 矩阵”，否则这不是低成本的替代方案。

### 7（低）takeaway 第 1 条“每一项优化都先从 GitHub 接口读作业起止和 runner 名”不成立

文件：`.agents/evidence/ci-speedup-lessons.md:112`。

问题：第 5 条 tooling 超时来自测试失败日志，第 3 条覆盖率来自 Andy 的观察和本地计时；不是每项优化都从 GitHub API 的作业起止/runner 名开始。

证据（读代码证实）：
- `ci-speedup-lessons.md:75`：tooling 失败来自连续两次 main 运行的测试失败。
- `ci-speedup-lessons.md:56`：coverage 60 分钟来自 Andy 原话；`ci-test-timing-2026-11-13.md:3` 说明数据是云端容器里本地命令的计时，不是 GitHub 接口作业时间。

建议：改成“这些优化大多先量了数据；来源包括 GitHub API 的作业时间、作业日志和本地计时”，避免以后只盯着 API。

### 8（低）作者说“只新增 ci-speedup-lessons.md”，实际本轮还新增了 ci-runs 和复核记录

文件：`a809a33..c9c5dc2` 的 diff。

问题：作者说“只新增 `.agents/evidence/ci-speedup-lessons.md`，不改代码”。实际 `c9c5dc2` 还新增了 `.agents/evidence/ci-runs-2026-11-15.md`（本轮核心数据）和 `.agents/reviews/pr-567/...` 记录；“不改代码”成立，但“只新增一个文件”不准确。作者还说运行号数据“仓库里只有部分记录（ci-tests-split）”，但 `ci-runs` 已记录 43675431801、43678751781，只有 43680214152、43671620922 仍是转述。

证据（读代码证实）：`git diff --stat a809a33..c9c5dc2` 显示 8 个文件，新增 `ci-runs` 和 review 文件。

建议：更正说明，明确 `ci-runs` 也是本轮新增的证据文件，避免复核范围漏掉它。

**侧重检查**

- 错误路径/引用：逐个核对了引用的文件、行号、提交和运行号。runbook 17/67/180、ADR 0267 第 83 行、I-93/I-95 日期、`85c11a949`/`4f47e0fec`/`54ada5efd`/`fc187d6a5` 都存在且对得上；发现 `quality-policy` 指错文件（意见 2）和 `main/confirmation` 漏项（意见 4）。
- 不可信输入：43680214152、43671620922、17/25/16、59 分钟基线和 1.45 负载无法离线核对。文档有的标了“未核实”（试跑数据），有的没有（17/25/16、59 分钟基线、1.45 负载）；建议统一标注。
- 安全：新增文档没有密钥、令牌或私钥，只含 runner 名、运行号和耗时。计划中的“ARM 取产物/ARM 出产物”会新增跨机器信任路径；现有 `run-share` 有摘要核对和受限 ssh，但文档没有写新路径必须保留摘要校验，建议补一句（不是本次代码改动）。
- 资源耗尽：ARM 4 核负载已在计划里提到；但“省 9 到 15 分钟”没有考虑 ARM 自身被 tooling/static 占用（意见 1）。
- 不可撤销操作：无；纯文档。
- 规则/文档一致性：顶部“只是参考，不是规则”与 Andy 的“给以后线程学”一致，降低了被当成硬规则的风险；但 takeaway 第 7 条把未实现的定时检查写成已有（意见 3），第 1 条把数据来源说成全是 GitHub API（意见 7）。

**必答问题**

1. **不涉及。** 改动只有 `.agents/evidence` 下的 Markdown（本增量还加了 `ci-runs` 和复核记录），没有改系统提示、工具定义、历史消息或遮盖结果。全仓库 grep 没有代码读取 `ci-speedup-lessons.md`，它不会被注入请求。因此不存在“只在末尾追加、每轮变化值都在最后一条消息”的问题。
2. **不涉及。** 文档是静态 Markdown，没有按请求序列化的字段、时间戳或无序列集合；运行号、提交号都是固定字符串，不会让同一段文字在不同请求里变成不同字节。
3. **没有对应的自动检查。** 全仓库 grep 没有测试或脚本引用 `.agents/evidence` 或 `ci-speedup-lessons`；CI policy 测试不覆盖这类文档。因此没有反向用例可失败。能离线核对的（提交存在性、文件/行号、算术）本轮人工核对了，发现上面几处不一致；运行号只能靠外部 API，无法在测试里复现。若要把这份文档当证据，建议加一个只检查引用文件和提交是否存在的轻量测试，运行号标为外部未核实。
4. **大部分直接使用端能接受，有三处不能接受或需要补：**
   - 文件路径 `ci-runs-2026-11-15.md` 被 lessons 第 3/67/84 行引用，文件存在；锚点 `#takeaways` 与标题一致。
   - 提交 `54ada5efd`、`fc187d6a5`、`85c11a949`、`4f47e0fec`、`07808c095` 都存在，PR 464/545 存在；run 43675431801/43678751781 在 `ci-runs` 中有记录，43680214152/43671620922 没有，无法离线核对。
   - `ci/quality-policy.json` 存在，但它的使用端是 Quality 工作流（`context.mjs` 的 `CI_QUALITY_SCHEDULE_*`），不是覆盖率；见意见 2。
   - `run-share.mjs` 的 `get` 只读本机、`collect` 有远程拉取；`run.mjs` 的 `--input` 要求 producer matrixKey == 本机 platform；`platforms.mjs` 不接受 linux-arm64 产物；见意见 6。
   - `main.yml` 的 `main/evidence` 和 `merge-queue` 的 `ci-arm` 都对；`main/confirmation` 漏了；见意见 4。
   - runbook 第 17/67/180 行、ADR 0267 第 83 行、I-93/I-95 日期都对得上。

**作者说法核对**

- “这个改动不涉及发给模型的请求”：成立。
- “只新增 `.agents/evidence/ci-speedup-lessons.md`，不改代码”：不改代码成立；只新增一个文件不成立，本轮还新增了 `ci-runs-2026-11-15.md` 和复核记录。
- “运行号数据来自 GitHub 接口，仓库里只有部分记录（ci-tests-split）”：不完整；`ci-runs-2026-11-15.md` 已记录 43675431801、43678751781，43680214152、43671620922 仍只有转述。
