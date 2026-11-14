### 1. 中 — “每件方案 1 美元”仍可通过换 `--topic` 重开账本绕过

- 文件:行：`.agents/instructions/model-review.md:31`、`.claude/rules/owner-standing-rules.md:16`、`scripts/model-review/opencode-review.mjs:1143-1150`、`scripts/model-review/opencode-review.mjs:2834-2837`、`scripts/model-review/plan-claims.mjs:245-257`
- 问题：新规则说的是“一个 PR 或一件方案”的 1 美元线，但 `plan-claims` 的账本按 `--topic` 分目录，`budgetCheck` 只读当前 `options.out/usage.jsonl`；同一份方案换一个 topic 就换一本账。合并门 `plan-claims.mjs` 又会扫描所有 topic ledger，所以拆账后仍能找到满足合并要求的记录。
- 证据（读代码证实）：
  - `opencode-review.mjs:1143-1149`：`const spent = spentOf(records); ... const line = ASK_FIRST_LINE_USD[mode]; if (total <= line) return null;`
  - `opencode-review.mjs:3462`：`const records = options.selfCheckOnly ? [] : readUsage(options.out);`
  - `opencode-review.mjs:2834-2837`：`if (pr !== undefined) return \`pr-${pr}\`; if (topic !== undefined) return \`topic-${topic}\`;`
  - `plan-claims.mjs:245-257`：`for (const ledger of topicLedgers(...)) { ... if (record.mode === "plan-claims") records.push(...) }`
  - 历史交接也承认过这个机制：`.agents/handoffs/2026-11-05-opencode-review-plan-v2.md:69`：“`--topic` 换个短名仍能重开一本账”。
- 推测：是否真的有人会换 topic 来省钱，无法从代码判断；但“同一份方案可以存在多本账、合并门仍全部认”是代码事实。
- 建议：让 plan-claims 的预算按 `claimsFile`/`claimsSha256` 跨 topic 汇总，或要求同一 `claimsFile` 只能用一个 topic；至少加一个测试：同一份 ADR 在两本 topic 账本里都有记录时，`budgetCheck` 仍按合计金额判断。

### 2. 中 — 新增的“全项目每天 5 美元”没有实现，也没有明确的汇总输入

- 文件:行：`.claude/rules/owner-standing-rules.md:16`、`.agents/instructions/model-review.md:66`、`scripts/model-review/opencode-review.mjs:3591`、`scripts/model-review/opencode-review.mjs:3627`、`scripts/model-review/opencode-review.mjs:3704`、`.agents/instructions/model-review-card.md:18`
- 问题：规则把每天 5 美元交给“协调者汇总核对”，但脚本只输出单次/单本账的 `REVIEW_SPENT_TOTAL`，记录分散在各 `pr-*`、`topic-*` 目录的 `usage.jsonl`；没有脚本或规则规定协调者从哪里取得所有当天花费，快速流程卡也仍只写“超过 1 美元时先问”。
- 证据（读代码证实）：
  - `opencode-review.mjs:3591`：记录里有 `at: new Date().toISOString()`，技术上可做日期汇总。
  - `opencode-review.mjs:3627`：`appendFileSync(join(options.out, "usage.jsonl"), ledgerLine(record));`，只写当前账本。
  - `opencode-review.mjs:3704`：只打印 `REVIEW_SPENT_TOTAL ${totalSpent.toFixed(4)} ${options.out}`，是本账本的合计。
  - `model-review-card.md:18`：仍然只要求“会超过 1 美元时先问 Andy”。
- 推测：协调者可以手工翻分支和账本，但未合并 PR 的账本不在 `main` 上，“全项目当天合计”没有可靠、可重复的数据来源；按 JST 还是 UTC 算“当天”也没有定义。
- 建议：增加只读的日报/汇总子命令，按 `at`（明确时区，建议 JST）扫描所有 `.agents/reviews/**/usage.jsonl`；或者明确要求线程每次把 `REVIEW_SPENT_TOTAL` 和 `at` 报给协调者并记进一个中央日账。同步更新快速流程卡。

### 3. 低 — `model-review.md` 第 5 步把“合并条件”写成了“CI 门槛”，与当前交付模式不一致

- 文件:行：`.agents/instructions/model-review.md:71`、`.agents/instructions/delivery-mode.md:27-28`
- 问题：第 5 步写“过了交付模式写的 CI 门槛，线程就自己合并”，但当前 `delivery-mode.md:27` 明确说“合并不等 PR 上的 CI，下面这条门槛暂停”；实际合并条件还包括本地 `npm run check`、`--assert-reviewed` 输出 `REVIEW_CURRENT`、已合进最新 `main`。链接虽然指向正确段落，但这句概括会让读者误以为必须等 CI 变绿，或误以为 CI 过了就够。
- 证据（读代码证实）：
  - `model-review.md:71`：“过了[交付模式](delivery-mode.md#fast-mode)写的 CI 门槛，线程就自己合并”。
  - `delivery-mode.md:27`：“合并不等 PR 上的 CI，下面这条门槛暂停。合并仍要：本地基本检查（`npm run check`）通过、复核没有中、高意见……且 `--assert-reviewed` 输出 `REVIEW_CURRENT`、已合进最新的 `main`。”
  - `owner-standing-rules.md:43` 用的是“过了交付模式写的合并条件”，措辞与交付模式一致。
- 建议：第 5 步改成“过了交付模式写的合并条件”，或直接列出本地检查、`REVIEW_CURRENT`、最新 `main` 三项，避免与交付模式的临时例外冲突。

### 4. 低 — 新测试锁住了 plan-claims 和 plan，但没有锁 plan-review 仍为 0.5

- 文件:行：`test/tooling/opencode-review-merge-gate.test.mjs:1955-1968`、`.agents/instructions/model-review.md:136`
- 问题：作者说“plan/plan-review 仍 0.5”，新测试只断言了 `plan` 和 `plan-claims`；整个测试目录里没有对 `budgetCheck({ mode: "plan-review" })` 的断言。将来若有人误改 `plan-review` 的阈值，现有测试不会失败。标题说“same one-dollar line as code review”，但测试也没有和 `code-review` 直接比较。
- 证据（读代码证实）：
  - 新测试中只有：
    - `budgetCheck({ mode: "plan", records, models: REVIEW_MODELS })`
    - `budgetCheck({ mode: "plan-claims", records, models: REVIEW_MODELS })`
    - `budgetCheck({ mode: "plan-claims", records: [record(0.4), record(0.3)], models: REVIEW_MODELS })`
  - 全仓搜索 `budgetCheck`，测试里没有 `mode: "plan-review"` 的调用。
- 建议：在新测试里补 `plan-review` 的 0.5 断言，并补一条 `code-review` 的 1 美元断言，或改成按模式参数化测试，明确固定四个模式的先问线。

## 侧重检查

- 花费与资源耗尽：查了 `budgetCheck`、`spentOf`、`readUsage`、`reviewKey`、`plan-claims.mjs` 的 ledger 扫描。结论：单本账的 1 美元线有效；但 plan-claims 可按 topic 拆账，且每天 5 美元没有汇总实现。
- 错误路径与不可信输入：查了 `--topic` 的 `TOPIC_PATTERN`、`--claims-file` 处理、`plan-claims.mjs` 对记录和引文的校验。没有发现本次改动新增的注入或资源耗尽路径；新的花钱绕过点来自账本键，而不是新的输入解析。
- 安全与不可撤销操作：查了 `.claude/rules/owner-standing-rules.md:43` 和 `.agents/instructions/delivery-mode.md:27-28`。自己合并仍是可回滚操作，且仍要求复核和本地检查；未发现新的高严重度安全问题。规则文件本身的改动不在“等 Andy 说合并”的清单里，这是治理上的取舍，不是本次代码错误。
- 规则/文档一致性：`plan-claims` 的 1 美元、`plan`/`plan-review` 的 0.5 与脚本一致；新增链接的锚点 `#money-and-models`、`#authorization-deploys-and-merges`、`#fast-mode` 都存在。第 5 步的“CI 门槛”是唯一一处措辞不一致。
- 旧规则残留：现行规则文件里没有发现 plan-claims 仍写 0.5；只有 `.agents/handoffs/2026-11-05-*` 里的历史交接记录和 `model-review.md:197` 的旧段落“先问线都照旧”可能被误读，它们不是当前阈值定义。
- 未核实：没有实际运行测试或 `check:instruction-links` / `check:docs-links`；反向用例是否失败是按断言和金额算术推断的。

## 必答问题

1. **不会改变模型已经见过的请求开头。** `buildPrompt` 只用 `MODE_TEXT`、固定句子、`questions`、侧重和末尾材料（`opencode-review.mjs:350-379`）；`reviewQuestions` 只抽取 `checklist` 锚点到下一节（`opencode-review.mjs:286-296`、`:2775-2782`），本次 `model-review.md` 的改动都在该段之外（checklist 在 `:77-83`）。`ASK_FIRST_LINE_USD` 只用于 `budgetCheck`，不进入提示词。发给模型的内容仍是固定开头加末尾材料，`head`、`base`、`previous`、`brief` 都在最后的 material 块里。
2. **不会让同一段文字在不同请求里变成不同字节。** 本次只改静态 Markdown 文字和一个数值常量；没有改序列化、遮盖、时间字段或集合顺序。`budgetCheck` 的费用输出是 `toFixed(3)`，结果是确定的。
3. **有部分自动检查，但覆盖不全。** 新测试确实锁住 plan-claims=1：若把常量改回 0.5，`0.26+0.4=0.66>0.5` 会让第一条 plan-claims 断言失败；`0.7+0.4=1.1` 且 `askFirstLine=0.5` 会让第二条失败。这是读代码加算术推断，**未实际运行测试**。每天 5 美元、合并规则、`plan-review=0.5` 都没有对应的自动检查。
4. **1 美元这个值两端一致；5 美元没有使用端。** 1 由 `opencode-review.mjs:160` 产生，唯一消费者是 `budgetCheck:1147`，接受数字；`approvedUsd` 和 CLI 调用也接受。文档和测试都写 1。5 美元只出现在规则文字里，没有代码或汇总脚本消费它，也没有规定协调者从哪个账本汇总，因此无法做两端校验。
