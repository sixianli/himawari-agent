## 侧重检查

- **只读/资源/不可逆操作**：新脚本只用 `readFileSync/readdirSync` 和 stdout，不联网、不写文件、不执行外部命令；`loadRounds` 同步读取整份 `usage.jsonl`，账本规模小，资源风险可接受。`compare` 只按传入参数计算，没有不可撤销操作。
- **错误路径与不可信输入**：目录不存在时返回空（有测试）；坏 JSON 行被静默丢弃；`at` 缺失会让 `localeCompare` 抛错或让“取最后一条”失效；`--cut` 不校验格式；`verdicts.jsonl` 缺失被当成 0 条意见；CSV 未转义。
- **安全**：`--reviews-dir` 可指向任意本地目录，这是本机分析工具的预期能力；输出里可能出现账本字段中的逗号、换行或公式前缀，导出 CSV 后由电子表格打开时有公式注入面（低风险，见下）。
- **规则/文档与代码一致性**：`selfCheckCache` 的产生端、打印端、消费端一致；但“中高严重度”集合比 `model-review.md` 的 schema 宽；文档说 `--csv` 可按 PR 或日期查，脚本没有 `--pr`/`--date`；“941 轮”实际是 941 条模型运行行。
- **未核实**：本工作区是 sparse checkout，没有 `.agents/reviews/` 下的真实账本，无法核对真实数据里重复行的比例、旧记录是否都带 `at`；只能以仓库里的 baseline CSV 和代码为准。

## 读代码证实的

### 1. 高 同一轮的多模型结果被当成多轮统计，优化前后口径不一致

文件：`scripts/model-review/review-speed-report.mjs:50-52,69-98,120-121,129-131`

问题：去重键是 `(pr, round, model)`，所以同一轮跑两个模型会生成两条“轮”。`byPr`、`rounds`、`roundsPerPr`、`mediumHighPerRound`、`stepsFull/stepsIncremental`、`turnaround` 都按这些行计算。ADR 0270 之前第 1 轮默认跑两个模型，之后默认只跑 DeepSeek，因此“复核轮数”“每个 PR 平均轮数”“每轮中高意见数”在优化前被系统性放大，前后对比不是同一口径。

证据：

```js
const key = `${pr}\0${record.round}\0${record.model}`;
...
for (const round of rounds) byPr.set(round.pr, [...(byPr.get(round.pr) ?? []), round]);
...
["复核轮数", (s) => s.rounds, 0],
["每个 PR 平均轮数", (s) => s.roundsPerPr, 2],
...
mediumHighPerRound: rounds.length
  ? sum(rounds.map((round) => round.mediumHigh)) / rounds.length
  : null,
```

`docs/assets/review-cost/2026-11-14-review-rounds-baseline.csv:2-3` 中 PR 255 第 1 轮有 GLM、DeepSeek 两行，且都算作“轮”；同一轮的 `verdicts.jsonl` 还会被两个模型行各数一次。

建议：轮级指标按 `(pr, round)` 去重后再算，明确选一个代表结果（优先非 `substitute` 的默认模型，或明确按模型分栏）；把“模型运行次数”和“复核轮数”分成两个指标。`mediumHigh` 每轮只计一次。补一条同轮双模型的测试，断言 `rounds`/`roundsPerPr` 不翻倍。

### 2. 中 “每个 PR 复核费用”没有算失败尝试，`prSpend` 算了却没有使用

文件：`scripts/model-review/review-speed-report.mjs:48,62,92,126`；测试 `test/tooling/review-speed-report.test.mjs:84`

问题：`spend` 确实把失败记录计入 `prSpend`，但 `prSpend` 之后从未被任何统计或输出引用；表格里的“每个 PR 复核费用中位”用的是 `costPerPr`，只把 `outcome === "ok"` 的轮（`rounds`）的 `cost` 相加。失败尝试、重试、`costUnknown`/`inFlight` 的预留都没有进入任何展示指标。测试只验证了 `prSpend` 包含失败费用，没有验证最终展示的 `costPerPr`。

证据：

```js
spend.set(pr, (spend.get(pr) ?? 0) + (Number(record.cost) || 0));
...
round.prSpend = spend.get(round.pr) ?? 0;
...
costPerPr: median([...byPr.values()].map((list) => sum(list.map((round) => round.cost)))),
```

测试里失败轮 `cost: 0.1` 只体现在 `expect(rounds[1].prSpend).toBeCloseTo(0.1 + 0.05 + 0.1)`，而 `costPerPr` 仍只有 0.1+0.05。

建议：`costPerPr` 改用每个 PR 的 `prSpend`；如果要和账本预算口径一致，按 `spentOf` 的方式处理 `costUnknown`/`inFlight`（`opencode-review.mjs:1196-1205`）。另外增加“总费用/失败尝试费用”行或列。补反向测试：一个失败轮必须进入展示的每 PR 费用。

### 3. 中 缺失的 `verdicts.jsonl` 被静默当成“0 条中高意见”，会拉低中高意见指标

文件：`scripts/model-review/review-speed-report.mjs:8-9,29-34`

问题：`readJsonLines` 在文件不存在时返回空数组，`mediumHighCount` 直接返回 0。脚本无法区分“这一轮没有意见”和“这一轮没有提交判定文件”。旧轮次（尤其 `verdicts.jsonl` 成为固定流程之前）会被计成 0，使优化前的“每轮成立的中高意见数”偏低。这与 `model-review.md:66` 的要求相反：“某一轮的 `verdicts.jsonl` 没有提交时，这一节打印一行说明列不出那一轮，不静默略过。”

证据：

```js
function readJsonLines(path) {
  if (!existsSync(path)) return [];
```

建议：把缺失的 verdicts 记成 `null`/未知并从均值中排除，或至少在输出中打印缺失轮次；补一条“只有 usage、没有 verdicts 目录”的反向测试。

### 4. 中 `sincePreviousMs` 在跨分界和同轮多模型时会误导

文件：`scripts/model-review/review-speed-report.mjs:55-60,74-76,129`

问题：`sincePreviousMs` 在按分界拆分 cohort 之前就计算好了。跨过分界的 PR，其分界后第一条记录的“上一轮”在分界前，可能产生数小时的间隔；只要小于 6 小时就会被算进“优化后”的 turnaround，抬高优化后时长。更常见的是同轮多模型：同一轮第二个模型的 `sincePreviousMs` 是它和前一个模型之间的启动间隔，不是“从上一轮到这一轮”。

证据：

```js
round.sincePreviousMs = before === undefined ? null : Date.parse(round.at) - before;
...
const turnaround = rounds
  .filter((round) => round.sincePreviousMs !== null && round.sincePreviousMs < 6 * 3600_000)
  .map((round) => round.sincePreviousMs / 60_000);
```

baseline CSV 第 3 行 PR 255 第 1 轮 DeepSeek 的 `sincePreviousMs=9135`，实际是同一轮里 GLM→DeepSeek 的 9 秒间隔，不是上一轮到这一轮。

建议：先按 `(pr, round)` 合并成轮，再在同一 cohort 内计算相邻轮间隔；跨分界后的第一轮标为 `null`（或不参与该 cohort 的 turnaround）。表格标题写明“上一轮结束到这一轮结束”，并说明多模型时如何取值。

### 5. 中低 `--cut` 不校验格式，字符串比较会静默把数据分错组

文件：`scripts/model-review/review-speed-report.mjs:105-107,184-195`

问题：分界比较是 `round.at < cutIso` 的字符串比较，没有 `Date.parse` 或格式校验。传入 `2026-11-14`、`2026-11-14T14:38:00+09:00` 或带空格的时间时不会报错，但结果会静默错误。例如 `--cut 2026-11-14` 会让所有 `2026-11-14T...` 都满足 `>= cut`，优化前为空。`--csv` 的 `--cut` 过滤同样如此。

证据：

```js
export function compare(rounds, cutIso) {
  const before = rounds.filter((round) => round.at < cutIso);
  const after = rounds.filter((round) => round.at >= cutIso);
...
if (args.includes("--csv")) {
  process.stdout.write(renderCsv(cut ? rounds.filter((round) => round.at < cut) : rounds));
```

建议：要求 `--cut` 是 `YYYY-MM-DDTHH:mm:ss(.sss)Z`，校验 `Date.parse` 有限，否则以 `REVIEW_SPEED_REPORT_INVALID_CUT` 退出 2；比较用毫秒数。补一条非法 `--cut` 的反向测试。

### 6. 低 `readJsonLines` 静默吞坏行，`at` 未校验还会让排序抛错

文件：`scripts/model-review/review-speed-report.mjs:8-18,52,55`

问题：坏 JSON 行被 `catch {}` 丢弃，报告会少算而不提示。`loadRounds` 直接调用 `a.at.localeCompare(b.at)` 和 `record.at > earlier.at`，但 `opencode-review.mjs` 的 `parseUsage` 只对 `plan-claims` 强制 `at` 格式（`opencode-review.mjs:2165-2171`），普通记录允许缺 `at`。旧账本若缺 `at`，报告会抛 `TypeError` 或错误地去重。

建议：复用或模仿 `parseUsage` 的校验；对缺 `at` 的记录打印警告并跳过，对坏行打印行号，不要静默丢弃。

### 7. 低 中高严重度集合比 `model-review.md` 的 schema 宽

文件：`scripts/model-review/review-speed-report.mjs:6,31-33`；`opencode-review.mjs:1284`；`model-review.md:61`

问题：脚本接受 `medium-high`、`medium`、`high`，而规范的 `VERDICT_SEVERITIES` 只有 `["low", "medium-high"]`。对合规数据没有影响，但两侧校验口径不一致：工作区里若出现 `severity: "high"` 的判定，`parseVerdicts` 会拒绝，报告却会把它算成中高。

证据：

```js
const MEDIUM_HIGH = new Set(["medium-high", "medium", "high"]);
```

建议：从 `opencode-review.mjs` 导出并复用 `VERDICT_SEVERITIES`，中高集合定义为 `VERDICT_SEVERITIES.filter(s => s !== "low")`，避免以后 schema 变化时两边脱节。

### 8. 低 文档与实现/数据不一致

文件：`docs/assets/review-cost/2026-11-14-review-speed-data.txt:41-43`；`scripts/model-review/review-speed-report.mjs:177-195`

问题：
- 文档说“`--csv` 按 PR 或日期查逐轮数据”，但脚本没有 `--pr` 或 `--date`，只有 `--reviews-dir` 和 `--cut`。
- 文档说 baseline 是“941 轮”，但 CSV 是 941 条数据行，且包含同一 PR 同一轮的多个模型行（第 2-3 行已证明），不是 941 个复核轮。
- `runSeconds` 表格行写“DeepSeek 一次运行时长”，但代码对所有模型取 `runMs` 中位；目前旧 GLM 记录缺 `runMs` 才看起来像只统计 DeepSeek。

建议：文档改成“导出逐轮/逐模型数据，自己在 CSV 里筛选”，或实现 `--pr`/`--date`；把“941 轮”改成“941 条模型运行记录（含同一轮多个模型）”；把 `runSeconds` 的行标题改成“一次运行时长中位”。

### 9. 低 CSV 未转义，账本字段可破坏导出或触发公式注入

文件：`scripts/model-review/review-speed-report.mjs:143-174`

问题：所有列直接 `join(",")`，没有引号转义。`model`、`at` 等字段来自 `usage.jsonl`，而本脚本不按 `parseUsage` 校验就读取；含逗号、换行或以 `= + - @` 开头的值会破坏 CSV 结构，导出后在电子表格里打开有公式注入风险。

证据：

```js
lines.push(
  columns
    .map((column) => {
      if (column === "incremental") return round.previous ? 1 : 0;
      return round[column] ?? "";
    })
    .join(","),
);
```

建议：加 CSV 转义（字段含逗号/引号/换行时加引号并双写引号），对以公式前缀开头的字符串加前导单引号；或明确只在终端查看、不导出给电子表格。

## 推测

- 第 1 条的实际影响幅度需要真实账本才能量化；sparse checkout 没有 `.agents/reviews/`，无法确认 baseline 里重复 `(pr, round)` 的具体比例。但代码结构和 baseline 前几行已足以证明重复存在。
- 第 9 条的“公式注入”需要账本里出现恶意或异常的模型名/字段；正常由复核脚本写出的记录里模型名受 `REVIEW_MODELS` 限制。风险低，但脚本本身没有校验，属于不可信输入面。
- 旧 `usage.jsonl` 是否普遍带 `at` 未核实；`opencode-review.mjs` 的校验不强制普通记录带 `at`，所以第 6 条的崩溃风险在理论上成立。

## 必答问题

1. **会不会改变模型已经见过的请求开头？** 不会。改动只涉及只读报告脚本、`SELF_CHECK_OK` 的打印、`usage.jsonl` 新增 `selfCheckCache` 字段、文档/测试和一份 baseline CSV。没有改动 `buildPrompt`、系统提示、工具定义、历史或遮盖逻辑；`selfCheckCache` 只在 `opencode-review.mjs:4025` 写进账本，`SELF_CHECK_OK` 只在 `3949-3950` 打印。因此发给模型的内容仍然只追加，每轮变化的值仍只在最后一条用户消息里。
2. **会不会让同一段文字在不同请求里变成不同字节？** 不会影响模型请求字节。`selfCheckCache` 依赖自检缓存状态，但只进账本和 stdout；报告输出依赖账本和时间，也不会发给模型。没有新增遮盖、无序集合或带时间的请求字段。
3. **有没有对应的自动检查，反向用例是否真的会失败？** 有一部分。已有：`median`、cohort 拆分、缺失目录、失败轮不进 `rounds` 但进 `prSpend`、`selfCheckCacheLabel` 三态。缺口：没有同轮多模型、同一 `(pr,round,model)` 多条记录取最后一条、跨分界 `sincePreviousMs`、非法 `--cut`、缺失 `verdicts.jsonl`、失败尝试进入展示费用、CSV 转义的测试；也没有一条集成测试断言账本真的写入 `selfCheckCache` 且 `SELF_CHECK_OK` 用同一个函数。因此第 1、2、3、4 条问题不会被现有测试拦住。
4. **改动产生或修改的每个值，使用它的地方都能接受吗？**
   - `selfCheckCache`：产生端只给 `hit`/`miss`/`off`；报告把缺失当未知、只在 `hit` 时计入命中；CSV 原样输出；`--report`、`delegate.mjs check`、`assertReviewed` 不拒绝额外字段。两端兼容。
   - `mediumHigh`：产生端按 `valid === true && class === "error" && severity ∈ {medium-high, medium, high}`；消费端用于均值。合规 schema 只有 `low`/`medium-high`，多出的 `medium`/`high` 不兼容 schema，但对现有合规数据无害。
   - `prSpend`：产生端正确包含失败记录，但没有任何输出消费它；真正展示的 `costPerPr` 走另一条路径，漏掉失败费用。
   - `sincePreviousMs`：被 turnaround 消费；跨分界和同轮多模型时语义不对。
   - `--cut`：用户产生，`compare` 和 `--csv` 消费，完全没有校验。
   - CSV 格式：没有仓库内消费者，但未转义，外部电子表格消费时可能出错。
