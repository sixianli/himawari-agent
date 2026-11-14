**本轮范围**

- 看了 `git diff 41951a7..3fef85d`，并把它拆开：属于 PR 506 第 2 轮的只有 `0f252e6`（`scripts/model-review/opencode-review.mjs`、`.claude/rules/owner-standing-rules.md`、`test/tooling/opencode-review-merge-gate.test.mjs`、第 1 轮记录）和 `3fef85d`（`low-fix-refusals.jsonl`）。`ad2164c` 是合入 `origin/main`，其余约 290 个文件属于别的 PR，没有整份重读；只核对了合并后本 PR 的这几行有没有被改回去（`0f252e6..3fef85d` 对 `dailySpend`、`parseArgs` 没有改动）。
- 没有运行测试（工具限制）。涉及时间解析行为的结论标了「推理」；`git` 替身拒绝读取 `.agents/reviews/**`，所以账本里的实际数值「未核实」。

**作者说法核对**

- `claimsFileRecords`：属实。当前代码在 `scripts/model-review/opencode-review.mjs:1240-1245`，只扫 `topic-*`，`exceptKey` 排除本题账本；`plan-claims` 在 `3495-3496` 强制用 `--topic`，不会落到 `pr-*`。
- `--spend-day [--date]`：基本属实，但“拒绝无法解析的时间”只对字符串成立，见意见 1；入口和输出格式没有端到端测试，见意见 2。
- `check-incident-gates.mjs`：属实。目录被 `47-51` 的 `try/catch` 转成 `INCIDENT_LIST_UNREADABLE`；不认识参数在 `101-106` 以 `INCIDENT_ARGUMENT_UNKNOWN` 退出 2。
- ADR 0269 前提 6、两份规则文字同步：属实，当前 `.agents/instructions/model-review.md:140` 与 `.claude/rules/owner-standing-rules.md:17` 都是“只算这个工作区里已有的账本”。

**意见**

### 1. 低：dailySpend 对 `at` 的异常值仍不统一拒绝，可能漏算或再抛不可读错误

文件: scripts/model-review/opencode-review.mjs:1250-1257

问题:
- `1251` 行把缺少 `at`、`at` 为数字/null 的记录当成“不是这一天”直接跳过，而同属“无法解析”的字符串却在 `1253-1256` 抛 `USAGE_LEDGER_INVALID`。两者都可能让当天的 `total` 偏低。
- `1257` 行 `new Date(ms + JAPAN_OFFSET_MS).toISOString()` 没有兜底：`Date.parse` 能接受 `+275760-09-13T00:00:00.000Z`（可表示的最大时刻），加 9 小时后越界，`toISOString` 仍会抛 `RangeError: Invalid time value`，正是上一轮第 3 条要消掉的错误类型（此点属推理，未在本机运行验证）。
- 不带时区的 `at`（如 `2026-11-14T23:30:00`）由 `Date.parse` 按运行机器的本地时区解释；同一本账本换一台时区不同的机器，可能落到日本日期的另一侧。这是确定性问题，但正常写入端 `3991` 都写 `toISOString()` 的 Z 时间，`plan-claims` 在 `2169-2170` 也强制 Z，所以只影响手工或旧格式账本。

证据（读代码证实）:
- `1251: if (typeof record.at !== "string") return false;`
- `1252-1256: const ms = Date.parse(record.at); if (!Number.isFinite(ms)) throw new Error("USAGE_LEDGER_INVALID ...");`
- `1257: return new Date(ms + JAPAN_OFFSET_MS).toISOString().slice(0, 10) === date;`
- `3991: at: new Date().toISOString(),`
- `2164-2170` 只对 `mode === "plan-claims"` 校验 `at` 是 Z 格式。

建议: 把 `at` 校验集中成一处：不是字符串、`Date.parse` 不是有限数、或 `ms + JAPAN_OFFSET_MS` 超出 `±8.64e15` 时，统一抛带账本名和行号的 `USAGE_LEDGER_INVALID`；至少给 `toISOString` 包 try/catch。对无时区的 `at` 要么拒绝（要求以 Z 结尾），要么明确按 UTC 解释。

### 2. 低：`--spend-day` 的 CLI 入口、输出格式和“先合 main”口径没有端到端自动检查

文件: test/tooling/opencode-review-merge-gate.test.mjs:2313-2354

问题: 新测试只直接调用 `dailySpend`、`parseArgs` 和 `DAILY_SPEND_LINE_USD`，没有 spawn `node scripts/model-review/opencode-review.mjs --spend-day --repo <tmp>`。因此 `main` 里的日本“今天”计算、输出行格式和“只读、不碰 opencode/不花钱”的路由都没有自动检查；`spendDayLines` 也没有被任何测试直接调用。改坏 `3725-3729` 或输出格式，现有测试不会红。

证据:
- `scripts/model-review/opencode-review.mjs:3725-3729`：`const today = new Date(Date.now() + JAPAN_OFFSET_MS)...; for (const line of spendDayLines(dailySpend(...))) console.log(line); return;`
- `test/tooling/opencode-review-merge-gate.test.mjs:2326-2353` 只有函数级断言，没有 CLI 子进程用例。

建议: 加一个子进程用例：临时目录放两本账，运行 `--spend-day --date ...`，断言 `REVIEW_SPEND_DAY_ITEM`/`REVIEW_SPEND_DAY ... over=` 两行、退出码 0、未出现 `REVIEW_PID` 或其他花钱输出；再覆盖不传 `--date` 时的日本“今天”。

### 3. 低：说明文字说“每本账打一行”，代码只打当天有记录的账本

文件: .agents/instructions/model-review.md:140（对应 scripts/model-review/opencode-review.mjs:1259）

问题: 规则写“每本账打一行 `REVIEW_SPEND_DAY_ITEM`”，代码只在 `records.length > 0` 时 push，当天没有花费的账本不会出现 ITEM 行；另外 `1229-1236` 只收 `pr-*`/`topic-*` 目录，和“所有 `.agents/reviews/*/usage.jsonl`”的字面也不完全一样（合法目录名恰好只有这两种，所以现在没有漏算）。这不影响数值正确性，只是说明与实现不一致。

证据:
- `.agents/instructions/model-review.md:140`：“每本账打一行 `REVIEW_SPEND_DAY_ITEM`”。
- `scripts/model-review/opencode-review.mjs:1259: if (records.length > 0) items.push({ key, usd: spentOf(records), records: records.length });`
- `1229-1236` 的 `entry.name.startsWith("pr-") || entry.name.startsWith("topic-")`。

建议: 把文字改成“每本当天有花费的账本打一行”，或者让代码对零记录账本也打印一行 usd=0.000。

**读代码证实的**

- 第 1 轮三条意见都已改：`owner-standing-rules.md:17` 的“只算已合进 main”已改成“工作区里已有的账本”；`dailySpend` 对无法解析的字符串抛 `USAGE_LEDGER_INVALID`；`--date` 加了与 `toISOString().slice(0,10)` 的回环比较（`3373-3377`），并加了 `2026-02-31` 反向用例（测试 `2351`）。
- `claimsFileRecords` 不会重复算本题账本：`exceptKey` 是当前 `reviewKey`，且 `plan-claims` 必须是 `--topic`；测试 `2303-2307` 覆盖了其他 topic、其他文件、其他 mode 和缺失目录。
- 损坏的别的账本会在 `readUsage`/`parseUsage` 处抛 `USAGE_LEDGER_INVALID`，`sameFileRecords` 在 `3820-3829` 花钱前计算，属于“拒绝而不是猜已花多少”，和现有测试 `2366` 的取向一致。
- `--spend-day` 在 `3441-3444` 只接受 `--spend-day/--repo/--date`，在 `main` 的 `3725-3729` 直接返回，不安装 gateway、不启动 opencode、不进 `buildPrompt`。
- `--date` 与 `--spend-day` 的互斥在 `3439-3440`；`--report`/`--assert-reviewed` 的分支在 `3446-3463`，没有被新的 spend-day 分支改到。
- 日本时间换算是固定 +9 小时再取 UTC 日期（`3726`、`1257`）；日本没有夏令时，这个换法对带 Z 的时间正确，测试 `2320-2332` 覆盖了 14:50Z/15:10Z 的跨日边界。
- 两份规则文字现在与 `reviewLedgers` 的“工作区账本”口径一致；`check-incident-gates` 的两个新错误码与测试 `175-192` 一致。

**推测/未核实**

- “`+275760-09-13T00:00:00.000Z` 加 9 小时后 `toISOString` 抛 `RangeError`”按 JS Date 规范和引擎最大值推理，未实际运行。
- `Date.parse("2026-02-31")` 会被 V8 滚到别的日期，因此新增回环断言在修复前确实会失败；依据是仓库自己的 `packages/gateway-contracts/src/contracts-v2.ts:1249-1257` 也用同样的回环比对来拒绝“不是真实日历日”，以及 `docs/adr/0262-memory-time-scope-comes-from-the-model.md:50` 记载 `2026-02-30` 会被“悄悄换算成别的日子”。未实际运行。
- `.agents/reviews/pr-506/usage.jsonl` 和 `low-fix-refusals.jsonl` 的实际内容未核实（git 替身拒绝 records 路径）。

**侧重检查**

- 错误路径：`--date` 非法格式（`3373-3378`）、`at` 不可解析（`1253-1256`）、事故清单是目录（`check-incident-gates.mjs:47-51`）、未知参数（`101-106`）都有可读错误码；残余问题见意见 1。
- 不可信输入：`at` 的非字符串、无时区、极值三类未完全覆盖（意见 1）；`reviewLedgers` 的目录名来自 `readdirSync` 的单个路径分量，`join` 不会越出 `.agents/reviews`，未发现目录穿越。
- 安全与不可逆操作：`--spend-day` 路径只做 `readUsage`/`readdir` 和字符串输出，不写文件、不调模型、不装依赖；没有不可撤销操作。`--claims-file` 的产生端（CLI `3354-3357`）和读取端（`parseUsage` 的 `claimsValid`，`plan-claims.mjs:17-24`）都拒绝 `.`、`..`、空段、绝对路径。
- 资源耗尽：新增代码只多看每本账一次，未新增无界循环；超大 `usage.jsonl` 的内存占用是既有行为；错误信息用 `slice(0, 40)` 截断，未新增日志放大。
- 规则/文档/代码一致：上一轮第 1 条已修好；发现的残余是意见 3 的“每本账打一行”措辞。ADR 0269 前提 6 与作者说法一致。
- 参数解析：`--date` 只能和 `--spend-day` 用的情形已覆盖（`3439-3440` + 测试 `2353`）；`--report`/`--assert-reviewed`/`--judge-skeleton`/`--finish-round` 的检查顺序未被破坏。
- 合并层面：`previousProblem`/`lowFixChecker` 来自 `origin/main`，不属本 PR；其直接使用端 `assertReviewed:1670` 和 `main:3868` 的签名、参数、测试都接得上，未发现合并把本 PR 的修复覆盖掉。

**必答问题**

1. 不会改变复核模型已经见过的请求开头。本增量没有改 `buildPrompt`（`352-396`）；固定前缀仍由 `MODE_TEXT`、`FOCUS_SENTENCE`、`RULE_16_SENTENCE`、必答问题、模型侧重和输出格式拼成。改动的两份规则文字：`.claude/rules/owner-standing-rules.md` 根本不参与复核提示；`.agents/instructions/model-review.md` 只通过 `reviewQuestions` 取 `<a id="checklist">` 到下一个 `<a id=` / `## ` 的段落（`288-299`），这次改的 `61` 行附近和 `140` 行都不在这个段落里。`--spend-day` 在 `3725-3729` 直接返回，不调用模型。因此发给模型的内容没有变，仍然只有固定前缀和末尾材料，每轮会变的提交、上一轮意见等都在材料里。

2. 不会。本增量的新值都是 CLI 输出或异常信息，不进入模型请求；`dailySpend` 的“今天”只影响本地报表。唯一相关的确定性风险是意见 1 里“无时区 `at` 按运行机器时区解释”，但正常写入的账本都是 Z 时间，且本改动没有引入遮盖规则或无序集合。

3. 有，但不完整。第 3 条：新测试 `2333-2334` 写 `at: "not-a-date"` 并断言抛 `USAGE_LEDGER_INVALID`，修复前会抛 `RangeError`，反向用例确实会失败。第 5 条：新测试 `2351` 断言 `2026-02-31` 抛 `ARG_INVALID --date`，修复前会通过（V8 把日期滚到 3 月），反向用例会失败；仓库里同类回环校验和 ADR 0262 支持这个判断。第 1 条只是文档措辞，没有自动检查。另外 `--spend-day` 的 CLI 入口和输出格式没有端到端测试（意见 2）。

4. 逐个核对：`USAGE_LEDGER_INVALID`（新抛点 `1255`）的使用端是 `main().catch`（`4127-4130`，打印 message 并以 2 退出）和测试的 `toThrow`，可以接受；`--date`（产生 `3372-3378`，使用 `3439-3440`、`3727`、`dailySpend`）两端都是同一种 `YYYY-MM-DD` 字符串，可以接受；`DAILY_SPEND_LINE_USD`/`spendDayLines`（`1223`、`1265-1273`，使用端 `3727` 和文档）数值 5 与文档一致，但“每本账打一行”的措辞见意见 3；`claimsFileRecords`（`1240-1245`，使用端 `3820-3829`）本增量没改，`exceptKey` 排除本题账本、`plan-claims` 强制 `--topic`、`--claims-file` 两端都过 `validClaimsFile`，不会重复算，损坏的别的账本会在花钱前以 `USAGE_LEDGER_INVALID` 停下；`check-incident-gates` 的两个新错误码分别被 CLI 输出和测试使用，可以接受。增量里从 main 合进来的 `previousProblem`/`lowFixChecker` 不属本 PR，直接使用端也能接上。
