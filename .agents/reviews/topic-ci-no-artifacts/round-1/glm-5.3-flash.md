仓库情况已经足够清楚。现在核实几个关键的外部事实：日志与作业摘要是否计入存储、日志保留期和大小上限。
# 方案：CI 彻底不再使用 GitHub 产物

## 一、方案依赖的前提（读代码或来源证实的）

1. **日志和作业摘要不计入产物存储额度。**GitHub 官方计费页：「If you run a workflow that generates many log files and a long job summary, these files do not count towards the repository owner's artifact storage allowance.」（https://docs.github.com/en/billing/concepts/product-billing/github-actions）
2. **没有付款方式时额度用完即拦，且拦的状态持续到账单周期开始。**同页：「If your account does not have a valid payment method on file, usage is blocked once you use up your quota.」「your accrued storage charges reset to zero at the start of each billing cycle」；Free 计划产物存储 500 MB、与 Packages 共享。所以「只留几 KB 的 gate 产物」仍然会在本周期被拦，去掉全部上传是唯一稳的路线。
3. **作业摘要（job summary）每步上限 1 MiB，且不占存储。**官方 workflow-commands 页：「each step is restricted to a maximum size of 1MiB」；`GITHUB_STEP_SUMMARY` 显示在运行摘要页（https://docs.github.com/en/actions/reference/workflows-and-actions/workflow-commands）。日志单行/单作业的上限官方没有查到明确数字（未核实），所以诊断输出要做按文件截断的保护。
4. **main 的三个作业和 PR 的作业都在同一台 runner（ci-vps）上，能读到共享目录和 gate 目录。**`.github/workflows/main.yml` 三个作业均 `runs-on: ci-vps`；ADR 0238 决定第 5 条：runner 服务带 `HIMAWARI_CI_SHARE` 环境变量和 `SupplementaryGroups=gh-ci-share`（docs/adr/0238…md:66-69、docs/runbooks/ci-vps-runner-runbook.md:61）。
5. **轻量确认的可信度来自 gate 内容核对，不来自产物的存放位置。**`verifyGate` 逐项核对 context/summary 与 main 合并提交上的 `ci/policy.json`、`ci/toolchain-lock.json` 字节哈希，并用 GitHub API 核对 testedSha 的 tree 和 parents（scripts/ci/main-evidence.mjs:132-189）。换成从磁盘读同样的字节，证明力不变。
6. **run-share 已经提供「按摘要存取、不覆盖、取时重算」的机制**，且 `collect` 只认 result.json、多出的文件无害（scripts/ci/run-share.mjs:72-136；scripts/ci/aggregate.mjs:246-274 readReportEnvelopes 只走目录找 result.json）。
7. **check-policy 已经把产物规则写成硬规则并有反向测试的现成骨架**：upload 白名单在 scripts/ci/check-policy.mjs:502-552，反向用例在 test/tooling/policy.test.mjs:645-694；`check:ci-policy` 是 `npm run check` 的一步（package.json:27、92）。
8. **clean-old.sh 每小时删共享目录里 6 小时前的目录**（ADR 0238 决定 6），所以 gate 不能放在 `/srv/gh-runner-share` 里面，否则活不过 6 小时。
9. 发现 PR 成功运行的窗口是 24 小时（main-evidence.mjs:107-108 `now - Date.parse(r.updated_at) < 24h`）。

## 二、方案本身

### 1. gate 结论放哪里、保存多久

- 在 CI VPS 上新建**与共享目录平级的 gate 目录** `/srv/gh-runner-gate`（同样 2770、root:gh-ci-share，两个 runner 的 `ReadWritePaths` 加上它，新增环境变量 `HIMAWARI_CI_SHARE_GATE`）。放在平级目录而不是 `/srv/gh-runner-share/gate/`，是为了不被每小时清理（前提 8）和 `run-share remove`（run-share.mjs:138-140 只删运行目录，但配合平级目录连误删的可能都没有）碰到。
- `run-share.mjs` 新增 `gate` 子命令：`gate --from .ci-output/gate` → 写入 `$HIMAWARI_CI_SHARE_GATE/<runId>-<attempt>/`（沿用 put 的「临时名 + 摘要不变再改名、已存在即失败」语义），每次执行时顺带删掉 7 天前的 gate 目录（自清理，不需要 root cron）。
- **保存 7 天**：发现窗口 24 小时（前提 9），重跑尝试（runId-attempt 各自独立）和延迟合并都有富余；每个 gate 几 KB，磁盘无忧。
- `ci/required` 的步骤改为：入口检查 → collect → required.mjs → `run-share.mjs gate --from .ci-output/gate`（`if: REQUIRED_AFTER_ENTRY`，保持「入口检查失败后不运行任何后续步骤」的规则形状）→ 打印 gate 的 context/summary 到日志 → `remove`。上传 `gate-<runId>-<attempt>` 的步骤删除。

### 2. main 确认怎么证明（同等可信度）

- **plan（main/evidence）**：`discover` 不再列产物 API，改为要求 `$HIMAWARI_CI_SHARE_GATE/<runId>-<attempt>/` 存在且有 context.json/summary.json；`verify` 从磁盘读这两个文件，verifyGate 逻辑一行不改（核对 policy/toolchain 哈希、API 核对 testedCommit）。verify 通过后把 gate 目录的树摘要写进 decision。
- **计划产物传递不再走 GitHub 产物**：plan 用现成机制 `run-share.mjs put --name main-evidence --from .ci-output/main-evidence --output-key main-evidence`，把 candidate/decision/gate 一起放进本轮运行目录，摘要写进作业输出；`plan.outputs.evidence` 从 artifact-id 变成 64 位摘要。
- **confirm（main/confirmation）**：下载步骤换成 `run-share.mjs get --name main-evidence --digest "$CI_MAIN_EVIDENCE_DIGEST" --to .ci-output/main-evidence`（get 重算摘要，run-share.mjs:92-112）；`main-confirm.mjs` 完全不改——它开头就重新调 `main-evidence verify`（main-confirm.mjs:33），等于在真实 main 提交上把证据再核一遍。链路是：plan 核对字节 → put 校验同一份字节 → 输出摘要 → get 按摘要收 → confirm 再核内容。
- 任何一环拿不到（gate 目录被清、被删、机器重装、API 失败）都落到 `mode=full`，完整 CI 兜底，失败方向安全，与今天一致。
- **信任等级与今天相同，没有变弱**：今天同样存在「PR 作业可以伪造一份 gate 产物」的可能；gate 内容核对才是不变量。唯一新前提是「gate 字节从 required 写入到 main 读取之间未被改」——ADR 0238 已接受同机任务可互相改文件的威胁模型（0238 后果第 3 段）。

### 3. 诊断怎么给人看

- 新脚本 `scripts/ci/emit-diagnostics.mjs`：遍历 `.ci-output/public/{reports,diagnostics}`，文本文件（publish.mjs 已经遮盖并过白名单）按文件头分隔符打到作业日志（`::group::` 折叠），单文件超上限（如 200 KB）就截断并注明；二进制（截图/trace）按路径+sha256 列清单；同时向 `$GITHUB_STEP_SUMMARY` 写一行指针（摘要 1 MiB/步，前提 3）。
- 六个检查作业的「保留失败诊断」步骤、required 的 gate 上传、main 的两处报告上传、quality 的全部上传，统一换成 emit 步骤（条件不变：`always() && steps.publish.outcome == 'success'`）。
- 六个检查作业的 `put` 改为 `--from .ci-output/public`（报告+诊断都进共享目录，诊断文件不进 result.json 的 reports 清单，对 required 收集无害，前提 6），这样截图/trace 至少 Andy 能 SSH 上去拿。

### 4. 防回归（check-policy 硬规则 + 反向测试）

| 规则改动 | 反向用例 |
|---|---|
| validateWorkflow：删除 upload 白名单（check-policy.mjs:502-513），改为「任何 `actions/(upload\|download)-artifact` 都失败」 | 6 个作业 + required 各注入一次 upload/download → 抛错 |
| required 的 gateUploads 断言（546-552）换成「恰好一条 `run-share.mjs gate` 步骤，条件 `REQUIRED_AFTER_ENTRY`」 | 删掉 gate 步骤、或改条件、或多加一条 → 抛错 |
| 各检查作业新增「恰好一条 emit 步骤，命令串逐字固定」 | 删掉 emit 或改参数 → 抛错 |
| main-workflow.mjs：禁止两个 artifact action（去掉 92-96 的 download 豁免），断言 put/get 命令串和 `evidence` 输出是摘要表达式 | main.yml 加回 download、evidence 换成 artifact-id → 抛错 |
| quality-policy.mjs：expectedJobs 深度相等里去掉 upload/download、handoff 改造 | 多留任何一个 upload → `CI_QUALITY_WORKFLOW_MISMATCH` |
| install-tools.mjs:123-134 的期望 action 集合去掉 upload/download-artifact，`ci/toolchain-lock.json` 同步删两条目 | 两端只改一边时 `npm run check` 必失败 |
| test/tooling/ci-optimization.test.mjs:100-103 的 `uploads.length > 0` 改为 `=== 0`；gate-lifecycle.test.mjs:461-482 同步改 | — |

全部挂在 `check:ci-policy`（package.json:92），属于 `npm run check`。测试骨架沿用 policy.test.mjs 现成的 mutate→`toThrow` 模式，每条新规则对应一条让 assert 条件为假的用例，失败是构造上必然；我没有条件实际运行，未核实。

### 5. 要改的文件（清单）

`.github/workflows/ci.yml`、`main.yml`、`quality.yml`；`scripts/ci/run-share.mjs`（gate 子命令）、`main-evidence.mjs`（discover 读磁盘）、新增 `emit-diagnostics.mjs`；`check-policy.mjs`、`main-workflow.mjs`、`quality-policy.mjs`；`install-tools.mjs` + `ci/toolchain-lock.json`；`ci/policy.json`、`ci/policy.schema.json`、`ci/quality-policy.json`（retentionDays 见取舍 3）；`test/tooling/policy.test.mjs`、`ci-optimization.test.mjs`、`gate-lifecycle.test.mjs`；新 `docs/adr/0242-*.md`（amends 0238、0241，amended_by 双向关联），runbook 第 49-62、108、194、224、258-262 行区域的目录清单与排查表。VPS 运维：install-runner.sh 增建 `/srv/gh-runner-gate`（合并后重跑安装脚本，同 ADR 0238 的既有流程）。

## 三、考虑过但不选的做法

- **gate 继续上传 GitHub（只留几 KB）**：前提 2——额度一满连 KB 级上传也被拦，2026-11-12 的事实就是如此；目标 1 是「额度被拦时也能变绿」。
- **gate 放 `/srv/gh-runner-share` 里面**：6 小时就被 clean-old.sh 删（前提 8），覆盖不了 24 小时发现窗口。
- **从 required 的作业日志经 API 抓 gate 摘要来绑定内容**：main.yml 本来就在同一台机器上，直接读磁盘更简单可靠；日志解析脆、又多一个 API 依赖。日志摘要行只保留给人看。
- **把诊断提交到仓库分支或 Release**：需要 `contents: write`，违反 ADR 0238 决定 4「任何作业都不再有写权限」，且污染历史。
- **VPS 上起 HTTP 文件服务给代理看截图**：新开公网服务和端口、要处理鉴权，ADR 0238 已为更小的需求拒绝过起服务（0238 比较过的方案第 3 条）。
- **只改 main.yml、ci.yml 不动**：ci.yml 六处诊断上传 + gate 上传仍会被拦，ci/required 红着，合并等 CI 就停摆。

## 四、风险和反例

- **gate 目录在 VPS 上被清/被删/写失败** → mode=full，多跑一轮完整 CI；不会假绿。反例：runner 重装后忘建 gate 目录 → 所有轻量确认退化为完整 CI，约 90 分钟/次——runbook 排查表加一条 `CI_SHARE_GATE_ROOT_REQUIRED`。
- **7 天自清理失效**（runner 长期不跑 CI，没人触发剪枝）→ gate 目录堆积；KB 级，量级无害。
- **日志体积**：单作业日志上限未核实（前提 3），emit 按文件截断是保护性设计；若 GitHub 截断整作业日志，文本诊断兜底在共享目录里（6 小时内）+ Andy SSH。
- **同机篡改 gate**：verifyGate 能挡「旧 policy/旧工具链/别的提交」的 gate，挡不住知情人完整伪造——与今天的产物方案同级，已在 ADR 0238 接受。可选加固：把 gate 树摘要也用 API 与 PR 运行的 required 日志比对（另出方案）。
- **quality.yml 的 handoff 失去 report- 产物**：改为只导 gate 证据（见取舍 2）。
- **规则改了但 workflow 忘改**：`check:ci-policy` 本地就红（前提 7），不会走到 GitHub。

## 五、需要人拍板的取舍

1. **二进制诊断（截图/trace）从此不在 GitHub UI 里看**：文本全在日志里，截图要么 Andy SSH（现状能力），要么以后给 VPS 加鉴权 HTTP 端点（本方案不做）。
2. **quality.yml 的 handoff 作业**：建议改成 runs-on: ci-vps、从 gate 目录只导 gate 证据、结果打到日志；或干脆整个删掉（它只能手动触发）。取舍归 Andy。
3. **retentionDays 是否删除**：它存在的唯一理由是限定产物保留期；建议连同 policy.schema.json 和 upgradeArtifactRetention 一起删，否则就是一个没有消费者的死字段（I-73 教训）。改动面大一点，但干净。
4. **可选加固**（gate 摘要跨 API 比对日志）做不做。

## 六、证实的与推测的分开

- **证实（读代码/官方页）**：前提 1-9 全部；本节引用的各脚本行为、规则位置、测试骨架、runbook 相关行。
- **推测**：作业日志单文件/单作业的实际上限（未核实，官方未查到数字，emit 按此做了防御）；反向用例在 CI 里确实运行失败（构造上必然，未实际运行）；quality.yml 当前已被 ADR 0176 停用、改造不影响任何在跑流程（ADR 0238 后果第 8 段）。

## 七、必答问题

1. **会不会改变模型已经见过的请求开头？** 不会。改动只落在 `.github/workflows/*`、`scripts/ci/*`、`ci/*.json`、docs——没有一处被组装模型请求的运行时代码读取（packages/ 内无对 scripts/ci 的引用，已 grep 证实）；不新增、不修改任何系统提示、工具定义、历史消息或遮盖结果，也就没有「已发内容被改写」的点，[prompt-prefix 规则第 4/5 条](../../.claude/rules/prompt-prefix.md#rules)（只追加、存原样）所约束的对象本次完全没被触碰。所有每轮会变的值（运行号、尝试号、摘要、诊断）都只存在于 CI 内部通道，不进任何模型请求。
2. **同一段文字会不会在不同请求里变成不同字节？** 不会。本次改动不产生模型请求，不存在遮盖、时间字段或无序集合进入请求的路径。CI 侧新增的值都是「写一次、读多次」：gate 用 `JSON.stringify(value, null, 2)` 固定序列化（required.mjs:29-33），摘要键序由构造顺序固定（aggregate.mjs:220-242），存取全靠 SHA-256 树摘要核对。唯一约束写进 emit 的设计里：日志文本不再被解析回任何请求。
3. **有没有对应的自动检查，反向用例真的会失败？** 有。check-policy 三套校验器各加硬规则，规则与反向用例一一对应（见二.4 表）；每条用例都是让某一条 assert 的条件为假，同 harness 的现有用例（policy.test.mjs:645-694）证明这个构造有效。「跑过」未核实（我无运行权限），合入前跑 `npm run check:ci-policy` 即可闭环。
4. **每个产生/修改的值，两端都能接受吗？** 逐个核对过：① gate 目录名 `<runId>-<attempt>`——产生端用 runName 的既有正则（run-share.mjs:34-38），消费端 main-evidence 用 `positive()`/`sha()` 校验并通过 verifyGate 绑定到 API 核实的 runId/attempt，一致；② `main-evidence` 共享名与 evidence 输出——产生端 put 校验 NAME 正则与摘要格式，消费端 get 校验 DIGEST 正则并重算，main-workflow.mjs 两端规则字符串同步改；③ toolchain-lock 的 action 集合——install-tools.mjs:123-134 与 validateWorkflow 的 action-lock 检查两端同步删，只改一边会在 `npm run check` 失败；④ put `--from .ci-output/public`——消费端 readReportEnvelopes 只认 result.json，多出的诊断文件不进摘要核对路径，无害（aggregate.mjs:246-274）；⑤ retentionDays 若删，schema/upgrade 函数/policy.json/quality-policy.json/test:896 五处一起动，由 `check:ci-policy` 守两端；⑥ emit 输出无机器消费者，人看的内容已经过 publish.mjs 的 `assertPublicArtifacts` 白名单。没有出现「一端生成、另一端校验对不上」的值（I-73 的教训逐项排过）。
