# 复核报告：PR 416 第 1 轮（CI 不用 GitHub 产物，ADR 0243）

## 侧重检查（普通流程走查与测试覆盖）

我走的主流程：PR 推送 → `ci.yml` 六个检查作业 → `run-share` 放报告 → `ci/required`（entry → collect → `required.mjs` 打印 gate 到日志并写作业摘要）→ 合并 → `main.yml` plan（`pushIdentity` → `discoverEvidence` 列作业/下载日志/`decodeGate` → `verifyGate` → mode=light）→ confirm 作业（装工具依赖 → 重新 `discover` → `main-confirm.mjs` 里再次 `verify` → build/security/smoke → 写作业摘要）。

覆盖结论（读代码证实）：
- `gate-log.mjs` 编解码有正向和大量反向用例（`main-evidence.test.mjs` 10 种拒绝模式、`gate-lifecycle.test.mjs` 用真实策略跑 `required.mjs` 再 `decodeGate` stdout，覆盖了多行 base64 分块）。
- 三个工作流的硬规则都有反向用例：`policy.test.mjs` 的 `[I-94]`（4 个作业 × 2 个 action）、gate 步骤缺失/条件/换目录、诊断摘要缺失/重复/条件/换目录/换标题；`ci-optimization.test.mjs` 对 `main.yml` 加回 upload、删掉 rediscover、换摘要目录的反例；`quality-policy.test.mjs` 的“GitHub artifact upload / handoff job restored / handoff input restored”。我核对了断言顺序（`check-policy.mjs:480` 的 artifact 拒绝在 `:495` 工具链锁检查之前；`main-workflow.mjs` 同样把 `github-artifact` 放在每步循环最前），反例确实会因新规则本身失败，而不是被别的检查顺便拦住——测试夹具里的 lock 也确实还含这两个 action（`policy.test.mjs:56-57`），反例是真实的。我无法运行测试（工具受限），“反向用例真的失败”是读代码推断，未运行。
- 没有测试覆盖的地方：真实 GitHub 作业日志的原始字节格式（时间戳格式、`##[group]`、密钥遮盖 `***`、超长行）只用合成 `timestamped()` 夹具模拟过；confirm 作业“重新 discover 失败 → 整个确认作业变红”这条路径只有 `main-workflow.mjs` 的结构断言（rediscover 在 confirm 之前），没有行为测试。

## 发现（按严重度从高到低）

1. **低 · docs/execution/specs/2026-09-03-github-ci-quality-gates-design.md:320 · 设计文档与代码不一致（残留旧产物说法）**。证据：该行仍写“完整报告和诊断 screenshot/trace 都只在 GitHub 上保留 1 天（2026-11-06 起……见 ADR 0174）”；而 `check-policy.mjs:480` 现在拒绝一切 artifact 步骤，ADR 0243:81 明说“截图、trace、完整日志这类大文件不能再从 GitHub 网页下载”。同文件 ：250 的“公开仓库的 Actions artifacts 可由登录用户下载”作为上限描述尚可，但 ：320 是对现状的陈述，已假。建议改 ：320 为“不再上传，材料只在 CI 服务器重跑或本地复现”。
2. **低 · scripts/ci/main-evidence.mjs:254-261 + .github/workflows/main.yml:68-71 · confirm 作业重新 discover 失败时步骤显示为绿，且没有自动回退**。证据：`main()` 的 try 捕获一切异常，discover 失败只写 `decision.json`（mode=full），脚本结尾 `await main()` 不设 `process.exitCode`（main-evidence.mjs:289-290），rediscover 步骤退出码 0；失败要到 `main-confirm.mjs:33-34`（`MAIN_EVIDENCE_NO_LONGER_VALID`）才让作业变红。结果安全（不会误判通过），但比 plan 作业更难看懂，且轻量路径现在每次合并都要再做一轮 API 发现（旧做法只读 plan 交来的文件），API 抖动、日志被删、24 小时窗口错过都会把“本可轻量确认”的合并变成整轮红。建议：discover 失败时设非零退出码（plan 的 verify 步骤带 `if: always()`，不受影响），或在 confirm 的 rediscover 失败时直接让该步骤红。
3. **低 · scripts/ci/ci-summary.mjs:19-31 · 文件整读进内存、二进制判定只看前 8 KiB**。证据：`readFileSync(file.full)` 无大小上限；`bytes.subarray(0, SAMPLE_BYTES).includes(0)` 只在前 8 KiB 找 NUL。一个 NUL 出现在 8 KiB 之后、恰好是合法 UTF-8 的大文件会被当文本，控制字符（含 ANSI 转义）可能原样进作业摘要；超大诊断文件可能耗尽 runner 内存。建议：加单文件字节上限（超限按“二进制/超大”列名字），并把内容里的 `\p{Cc}` 一并替换。
4. **信息 · scripts/ci/gate-log.mjs:13 · 解码对真实日志格式的假设未在真实日志上验证**。时间戳正则 `/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z /` 若与实际格式不符，BEGIN 行识别失败 → `MAIN_GATE_LOG_MISSING` → 退回完整 CI（安全失败，只损可用性）；GitHub 密钥遮盖把 `***` 混进 base64 → 字符集断言失败 → 同样退回。我核对了 base64 标准字母表不含 `-`，正文行不可能被时间戳正则误剥。风险可接受，但建议合并后第一次 main 轻量确认时人工核对一次真实日志字节（ADR 0243 也说了旧 PR 运行会退回完整 CI，正好有对照）。
5. **信息 · ci/security-exceptions.json:2092-2298 · 8 条例外结构合规，Owner 同意无法从代码核实**。我读了 `security-exceptions.mjs:108-188`：`proposedAt` 2026-11-04 与 `expiresAt` 2026-12-04 恰 30 天（`:129` ≤ 30 天 ✓）、格式 `T00:00:00Z`（`:139`）、未过期（今天 2026-11-12）、identity 无重复（`:176-184`）、kind 在白名单。8 条 path 各不相同。但 “Andy 已同意”是 `reviewEvidence` 里的一句话，`reviewReference` 指向 PR 372/381 而非 Owner 评论——本地检查不联网核对 Owner 批准（I-90 行自述），只有 CI 会拦，未核实。
6. **信息 · 旧的 ADR 0238:64,95 和 ADR 0241:54,58 文字仍描述产物上传/下载**。仓库既有惯例是被取代的 ADR 原文不动、由新 ADR 声明 amends（ADR 0243:63 已逐条声明），可接受；真正的活文档是设计文档（见第 1 条）。

未核实：GitHub 仓库设置的保留期是否真改为 3 天、 Andy 的同意原话、`main-confirm.mjs` 深层测试、`export-evidence.mjs` 其余测试（`evidence.test.mjs`、`gate-lifecycle.test.mjs:753-796` 仍在测它的 CLI，与 ADR 0243:59“保留”一致）。

## 必答问题逐条回答

**1. 是否仍只在末尾追加、每轮变的值都在最后一条消息里？** 本 PR 完全不触碰 Himawari 的模型请求（改动只在 `scripts/ci/`、`.github/workflows/`、`ci/`、文档），没有任何系统提示、工具定义或历史消息被改动；作者说法“本 PR 不涉及 Himawari 的模型请求”与代码一致。无可答的“追加”问题，前提成立。

**2. 同一段文字会不会在不同请求里变成不同字节？** 读代码证实：gate 的 `{context, summary}`（`gate-log.mjs:14-27` encodeGate）里没有时间字段——`context` 来自 `context.mjs:134-145`（只有 runId/attempt/各 SHA/摘要），`summary` 来自 `aggregate.mjs:220-242`（对象字面量，键序固定，无时间戳）；作业摘要表和 `ci-summary.mjs` 的输出都先排序（`listFiles` 按相对路径排序）再渲染，上限/截断/遮盖都是确定性的。两次读取（plan 与 confirm）解的是同一份日志字节。没有发现依赖前后文或无序集合的值。

**3. 有没有对应的自动检查、反向用例是否真的会失败？** 有（详见侧重检查一节）：`npm run check:ci-policy` 三个校验器 + `[I-94]`/gate 步骤/摘要步骤反例 + `decodeGate`/`githubLog`/`ci-summary` 的负向测试，断言顺序保证了反例命中的是新规则本身。但我只能读不能跑，未实际执行。

**4. 每个产生/使用的值两端是否都核对过？** 逐对核对（读代码证实）：`REQUIRED_GATE_COMMAND`（check-policy.mjs:39-40）↔ ci.yml:366 逐字一致；encodeGate 标记/摘要 ↔ 同模块 decodeGate；`{context,summary}` ↔ `verifyGate`（main-evidence.mjs:184-243）逐字段核对 runId/attempt/base/head/tested SHA、策略与工具链摘要、矩阵完备；`jobId` 写入 candidate.json，消费端只要求正整数、不参与校验，无错配；`mode` 输出 ↔ main.yml:21,46,51；`ci-summary` 的 `--title/--from` ↔ 三个校验器的期望串逐字一致；toolchain-lock 删两项 ↔ install-tools.mjs:123 的固定清单同步删；`retentionDays` 保留 ↔ quality-policy.mjs:44（常量 1/1）和 export-evidence.mjs:110,161 仍消费，与 ADR 0243:61 的说法一致，未见误导性消费。唯一两端没法在本仓库内对上的是 8 条例外的 Owner 批准（见发现 5，未核实）。

对 PR 侧 7 个核对点的简答：①信任边界没有变弱——伪造恰好一段要么让真 gate 不打印（required 步骤失败 → 作业非 success → discover 拒绝）、要么多出一段（解码失败 → 完整 CI）、要么改 `scripts/ci/`（合并时 `MAIN_VALIDATION_CHANGED`，main-evidence.mjs:102-113 拦下）；对 gate 内容的信任根仍是“被测提交自己的 CI 说了算”，与产物时代相同，`verifyGate` 的逐项内容核对是真正的边界（ADR 0243 前提 4 的说法成立）。②格式风险都安全失败（见发现 4）；令牌只在 api.github.com 那次请求带上，跳转请求无 headers、拒绝非 HTTPS 和带账号的地址（main-evidence.mjs:63-77，有测试）。③重跑尝试/24 小时边界/日志删除都以“拿不到合格 gate → mode=full”收场，confirm 侧 rediscover 拿到的是与本次 identity（before/after/head/tree）自洽的证据，两次发现选到同一 head 的不同成功 run 也仍验证同一份代码；唯一代价是变红而不是回退（发现 2）。④`ci-summary` 只 import 内置模块和零依赖的 redact-text.mjs，遮盖先于截断（有测试），排序/上限/计数正确；整读大文件是小隐患（发现 3）。⑤handoff 删除干净，`export-evidence.mjs` 保留且其 `retentionDays` 消费仍在，ADR 说法与代码一致。⑥见第 3 条必答。⑦设计文档 :320 有一处过期（发现 1），其余一致。
