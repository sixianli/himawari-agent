## 结论范围

本轮只核了增量 `git diff ef96e46e..3d2f3bdd`，并沿证据追了它直接依赖的旧代码：完整读了 `scripts/model-review/review-speed-report.mjs`、增量测试、`opencode-review.mjs` 里 `selfCheckCacheLabel` 和写账本的两段、`model-review.md` 的 verdict schema/账本字段/轮次回退规则、`prompt-prefix.md`、两份 review-cost 文档和 baseline CSV 的前几行，并用 `git grep` 找了所有使用端。`.agents/reviews/pr-521/*` 实际账本因稀疏检出且 `git show` 被记录路径守卫拒绝，未读到，相关真实数据标“未核实”。

## 上一轮意见核对

- 1 部分改好：轮数、中高意见数、PR 费用已按 `pr+round` 分组；但步数/费用/输入 token 中位仍按模型运行统计（见意见 1）。
- 2 改好：有成功轮的失败尝试费用通过 `retryCost` 计入 PR 花费；但完全没有成功轮的失败费用仍会漏掉（见意见 2）。
- 3 改好：缺 `verdicts.jsonl` 返回 `null`，不再当 0；坏行仍被静默吞掉（见意见 7）。
- 4 部分改好：对比表在 cohort 内重算 `sincePreviousMs`；CSV 仍跨分界使用旧值（见意见 3），跨分界轮还会在两个 cohort 各算一次（见意见 4）。
- 5 改好：`main` 和 `compare` 都用 `Date.parse` 校验 `--cut`；但“按时间不按文本比较”的测试没有区分力（见意见 6）。
- 6 部分改好：`at` 不可用的记录已跳过，排序不再抛错；畸形行仍静默跳过（见意见 7）。
- 7 改好：`MEDIUM_HIGH` 只剩 `medium-high`，与 `model-review.md` 和 `VERDICT_SEVERITIES` 一致。
- 8 部分改好：数据说明第 42–43 行更新了；但同文件第 3 行仍说脚本不在仓库里（见意见 5），`model-review.md` 也没列新账本字段。
- 9 改好：`csvCell` 处理了引号、逗号、换行和常见公式前缀；前导空白后再跟公式字符未处理（见“推测”）。

## 读代码证实的意见

### 1. 中高 表里“轮”的步数、费用、输入中位仍按模型运行统计，多模型轮会被重复采样

文件：`scripts/model-review/review-speed-report.mjs:73-85,107-108,129-132,138,169-174`

问题：`loadRounds` 返回的是“每个模型每轮最后一条记录”（第 83 行 key 含 `record.model`），但 `cohortStats` 仍直接用这些行算“全量轮/增量轮”的步数、费用和输入中位：

```js
const full = rounds.filter((round) => !round.previous);
const incremental = rounds.filter((round) => round.previous);
...
stepsFull: median(full.map((round) => round.steps)),
costFull: median(full.map((round) => round.cost)),
...
inputPerRound: median(rounds.map((round) => round.input)),
```

而这些指标在表里仍叫“全量轮 步数中位”“全量轮 费用中位”“每轮输入 token 中位”（第 169–174 行）。同一轮跑两个模型时，这一轮会被当成两个样本；优化前多模型轮较多、优化后通常只有一个模型，两个 cohort 的费用/步数中位口径不同。这正是上一轮意见 1 未修完的部分。

建议：先按 `pr+round` 聚合再取中位（费用求和；步数、输入 token 需明确是求和还是取每轮最大值），或把行名改成“每次模型运行”。同时给两个模型同一轮的和一条模型运行各补一条断言。

### 2. 中 “含失败重试”仍漏掉没有成功轮的失败费用，也忽略 `costUnknown`/`inFlight`

文件：`scripts/model-review/review-speed-report.mjs:77-81,89-96,133-137`

问题：失败费用只按 `pr+round` 暂存，然后只在由成功记录生成的 group 上回填：

```js
if (!hasTime(record)) continue;
if (record.outcome !== "ok") {
  const retryKey = `${pr}\0${record.round}`;
  retry.set(retryKey, (retry.get(retryKey) ?? 0) + (Number(record.cost) || 0));
  continue;
}
...
const retryCost = retry.get(`${group.pr}\0${group.round}`) ?? 0;
```

如果一轮所有尝试都失败（没有 `outcome === "ok"` 的记录），这个轮不会进入 `rounds`，它的 `retryCost` 永远没有使用端，费用被丢掉；第 77 行还会把没有可用 `at` 的失败记录连同费用一起跳过。另外预算/花费的正式口径 `spentOf`（`opencode-review.mjs:1196-1204`）对 `costUnknown`/`inFlight` 会按保守公式放大，这里只用 `Number(record.cost) || 0`，失败尝试可能被低估。表名却写着“含失败重试”。

建议：把非 ok 记录的费用按 PR（或按 PR+round，但允许无成功轮的组）独立累计，并加到该 PR 总费用里；对 `costUnknown`/`inFlight` 复用正式口径，或明确说明这里统计的是账面 `cost`。

### 3. 中 CSV 里的 `sincePreviousMs` 仍跨分界计算，`--cut` 过滤后不重算

文件：`scripts/model-review/review-speed-report.mjs:88-96,198-230,246-250`

问题：`loadRounds` 在整份数据上算间隔并把值写进每一行：

```js
const sorted = [...rounds.values()].sort(...);
for (const { group, sincePreviousMs } of intervals(sorted)) {
  ...
  round.sincePreviousMs = sincePreviousMs;
```

`renderCsv` 直接打印已存的值，`--cut` 只是事后过滤，没有重算：

```js
renderCsv(cutMs === null ? rounds : rounds.filter((round) => Date.parse(round.at) < cutMs))
```

因此导出全量 CSV 后看“优化后”的第一轮时，`sincePreviousMs` 是从分界前那一轮算起（可能隔几小时/几天）；对比表因为 `cohortStats` 里重新调用 `intervals(rounds)` 才避开了这一点。这正是上一轮意见 4 的跨分界部分，只在表里修好，CSV 未修。

建议：在 `renderCsv` 前对过滤后的集合重算间隔，或给分界后每 PR 第一轮把 `sincePreviousMs` 置空，并在文档说明 CSV 与表的口径。

### 4. 中低 同一轮跨过分界时会在两个 cohort 各算一轮，轮数和中高意见数重复计数

文件：`scripts/model-review/review-speed-report.mjs:104-106,127,142,149-157`

问题：`compare` 先按每一条模型运行记录过滤：

```js
const before = rounds.filter((round) => Date.parse(round.at) < cutMs);
const after = rounds.filter((round) => Date.parse(round.at) >= cutMs);
```

如果同一轮的两个模型分别落在分界两侧，`roundGroups(before)` 和 `roundGroups(after)` 都会为这个 `pr+round` 建一个 group，于是 `rounds`、`roundsPerPr`、`mediumHighPerRound` 在两个 cohort 里各算一次。发生概率低，但和“同一轮多个模型只算一轮”的目标不一致。

建议：先按整份数据的 `pr+round` 分组，用 group 的结束时间（或首条记录时间）决定它属于哪个 cohort，再在 cohort 内统计。

### 5. 低 文档说“统计脚本不在仓库里”，与新增脚本和下一行命令直接矛盾

文件：`docs/assets/review-cost/2026-11-14-review-speed-data.txt:3,43`

问题：第 3 行仍写：

> 统计脚本是线程的临时脚本，不在仓库里；下面写明取法，换人可以重算。

而第 43 行和本次改动新增的 `scripts/model-review/review-speed-report.mjs` 明确让人运行仓库里的脚本。规则文件、说明文档和代码不一致。

建议：把第 3 行改成“统计脚本在 `scripts/model-review/review-speed-report.mjs`”，并说明 baseline 是旧口径快照。

### 6. 低 “按时间不按文本比较”的反向用例在旧实现上也会通过

文件：`test/tooling/review-speed-report.test.mjs:144-156`

问题：测试用例是：

```js
const [before, after] = compare(loadRounds(dir), "2026-11-14");
expect(before.rounds).toBe(0);
expect(after.rounds).toBe(1);
const [before2] = compare(loadRounds(dir), "2026-11-14T20:00:00+09:00");
expect(before2.rounds).toBe(1);
```

记录时间是 `2026-11-14T10:00:00.000Z`。旧实现用字符串比较 `round.at < cutIso`：`"2026-11-14T10..." < "2026-11-14"` 为 false、`"2026-11-14T10..." < "2026-11-14T20:00:00+09:00"` 为 true，结果和新实现完全一样。这半段用例不能防止退回字符串比较；只有前面的 `compare([], "soon")` 抛错能区分新旧实现。

建议：加一条字符串序和时间序相反的用例，例如记录 `2026-11-14T02:00:00.000Z`、分界 `2026-11-14T10:00:00+09:00`（即 01:00Z）：正确结果是“之后”，字符串比较会错判成“之前”。

### 7. 低 畸形的 `verdicts.jsonl` 仍被当成“0 条中高意见”，而不是“没有可用 verdicts”

文件：`scripts/model-review/review-speed-report.mjs:8-18,29-36,114-116,143`

问题：文件存在但所有行都解析失败时：

```js
try {
  rows.push(JSON.parse(line));
} catch {}
```

随后 `mediumHighCount` 返回 `0` 而不是 `null`，`judged` 会把它算进分母，`roundsWithoutVerdicts` 也不会增加。上一轮意见 3 只修了“文件缺失”，坏文件的静默归零仍在；上一轮意见 6 的“吞坏行”也只修了 `at` 校验部分。

建议：`readJsonLines` 遇到解析失败时抛出或返回可区分的错误，让该轮按“无可用 verdicts”处理并在表里单独计数，而不是当成 0 条意见。

### 8. 低 baseline CSV 的 `sincePreviousMs`/`mediumHigh` 是旧的按模型运行口径，和新脚本口径不一致

文件：`docs/assets/review-cost/2026-11-14-review-rounds-baseline.csv:2-3`；对照 `scripts/model-review/review-speed-report.mjs:54-63`

问题：baseline 里同一轮的两个模型：

```csv
255,1,2026-11-05T11:44:32.723Z,opencode-go/glm-5.3-flash,...,,,,,0
255,1,2026-11-05T11:44:41.858Z,opencode-go/deepseek-v4.1-flash,...,9135,0
```

同一轮第二个模型的 `sincePreviousMs=9135` 是距同一轮第一个模型的 9 秒，这是新旧脚本都有的旧口径；新脚本会按 group 给同一轮所有模型同一个间隔（这一轮是第一个轮，应为 null）。如果读者拿 baseline 的 `sincePreviousMs` 列按 PR 算间隔，会复现上一轮意见 4 的误导值。

建议：重新生成 baseline，或删除/标注其中的派生列，说明它只是旧脚本的原始快照，不能直接和新脚本 CSV 的对应列比较。

### 9. 低 `cohortStats` 里算了却从未读取的 `distinctPerPr`

文件：`scripts/model-review/review-speed-report.mjs:105-106`

问题：

```js
const distinctPerPr = new Map();
for (const group of groups) distinctPerPr.set(group.pr, (distinctPerPr.get(group.pr) ?? 0) + 1);
```

之后没有任何地方读取它。不是运行时错误，但是增量新加的无效计算，容易被误认为已经用于 `roundsPerPr`。

建议：删除；如果本意是算每 PR 轮数，`groups.length / byPr.size` 已经是平均值，按 PR 的中位需要另写。

### 10. 低 缺少 `--reviews-dir` 时静默输出空报告，路径写错看起来像“真的没有数据”

文件：`scripts/model-review/review-speed-report.mjs:65-66,245,258`；测试 `test/tooling/review-speed-report.test.mjs:171-173`

问题：`loadRounds` 对不存在的目录返回 `[]`，`main` 照常渲染表格（全是 `0`/`-`）。默认 `.agents/reviews` 在正常仓库存在，但在副本、稀疏检出或参数写错时会得到一份看似合法的零数据报告，容易被当成真实结论。

建议：`main` 里单独判断 `--reviews-dir` 不存在时报错退出（保留 `loadRounds` 返回 `[]` 给库函数/测试），或至少在表头打印实际使用的目录和记录数。

## 推测（未核实）

- 旧账本可能有没有 `round` 字段的记录（`model-review.md:136` 说“没有轮次字段的旧记录按第 1 轮算”，`delegate.mjs:315` 用 `record.round ?? 1`）。本脚本第 83 行直接用 `record.round`，这些记录会全部落进 `pr\0undefined` 一个组，`mediumHighCount` 也会去找 `round-undefined/verdicts.jsonl`。baseline 里我看到的记录都有 `round`，实际账本未读到，是否有这种旧记录未核实。
- 第 85 行用字符串 `record.at > earlier.at` 选“最后一条”。正常写账本用 `toISOString()`（总是 `Z`），没问题；但 `hasTime` 接受带时区的可解析时间，若存在 `+09:00` 这类记录，字符串比较可能选错“最后一条”。实际是否存在未核实。
- CSV 公式注入只拦首字符是 `= + - @ \t \r` 的字符串；以空格开头再接 `=` 的值没有被加 `'`。Excel 通常不把前导空格当公式，但不同表格软件行为未核实。
- baseline 是否会被下游用于计算间隔，未核实；我确认的只是它的列语义与当前脚本不一致。

## 侧重检查

- 错误路径：非法 `--cut` 在 `main` 和 `compare` 都会拒绝（第 240-244、150-151 行），好；缺目录静默空报告（意见 10）；缺 verdicts 文件已区分（好）；畸形 verdicts 行仍静默（意见 7）。
- 不可信输入：`model`、`at` 等来自账本，CSV 已做基本转义和公式前缀处理；`pr` 来自 `readdirSync` 且必须匹配 `^pr-\d+$`，没有路径穿越；`--reviews-dir` 是本地用户参数。未发现把账本内容拼进 shell/URL 的路径。
- 资源耗尽：`readJsonLines` 和 `loadRounds` 用 `readFileSync` 一次读整个账本，不流式；账本很大时内存/时间会线性增长，但对本地只读报表可接受，未见上限或分页。
- 不可撤销操作：脚本只 import `existsSync/readdirSync/readFileSync`，只写 stdout/stderr，不写文件、不联网、不花钱；`opencode-review.mjs` 的改动只在模型运行结束后往账本多写一个字段，无外部副作用。
- 规则/文档一致性：`medium-high` 判定与 `model-review.md:61`、`VERDICT_SEVERITIES` 一致（好）；数据说明第 3 行与脚本矛盾（意见 5）；`model-review.md:201` 枚举账本耗时字段时没有提 `selfCheckCache`，属文档缺口；baseline 列语义与脚本不一致（意见 8）。
- CSV 表头与 baseline 表头逐字一致（`pr,round,at,model,incremental,steps,input,output,reasoning,cacheRead,cacheWrite,cost,runMs,selfCheckMs,selfCheckCache,sincePreviousMs,mediumHigh`），格式端没有发现不兼容。

## 必答问题

1. **不改变模型已经见过的请求开头。** 增量只新增 `selfCheckCache` 字段：它由 `selfCheckCacheLabel` 在自检结束后计算（`opencode-review.mjs:3949-3950`），模型运行结束后才写进账本（`:4024-4025`、`:4044`）；`review-speed-report.mjs` 只读 `.agents/reviews` 并打印。没有改系统提示、工具定义、历史消息或遮盖逻辑。发给模型的内容仍只在末尾追加，每轮会变的值仍应在最后一条消息里——本次改动不涉及这一层（依据 `prompt-prefix.md` 第 4、10、11 条）。
2. **不会让模型请求里的同一段文字变成不同字节。** 新字段只在账本和控制台输出里，且 `SELF_CHECK_OK` 的 `cache=` 取值与改动前表达式完全一致。报告脚本不参与请求组装；它输出的行序在时间完全相同的记录之间依赖 `readdirSync`/插入顺序，但这只影响报表文本，不影响模型请求。
3. **有自动检查，但反向覆盖不完整。** 新测试覆盖了：缺目录、缺 verdicts、非法 cut、失败重试、同一轮多模型、无 `at` 记录、CSV 转义。真正会在旧实现上失败的有：非法 cut 抛错、多模型轮数、缺 verdicts 返回 null、`retryCost`、无 `at` 排序、CSV 转义。不会区分旧实现的是意见 6 的“按时间不按文本”半段；另外没有测“同一模型同一轮两条 ok 取最后一条”、混合“有 verdicts 的 0 条 + 缺 verdicts”分母、跨分界 CSV 间隔、跨分界轮双计、孤儿失败轮费用。
4. **新值的直接使用端已逐个核对：** `selfCheckCache` 的产生端是 `opencode-review.mjs:3949/4025`，使用端是 `review-speed-report.mjs:121-122/214` 和两个测试；账本写入只做遮盖后 JSON 序列化（`ledgerLine`，`:3282-3284`），`readUsage`、`spendOf`、`delegate.mjs check` 都按已知字段读取，没有发现会拒绝多出字段的校验。`selfCheckCacheLabel` 只在 `main` 和 `opencode-review.test.mjs` 使用，输出值 `off/miss/hit` 与旧表达式一致。`mediumHighCount` 返回 `null` 只被 `loadRounds:90` 和测试使用。`MEDIUM_HIGH = {"medium-high"}` 与 `model-review.md:61`、`opencode-review.mjs:1284` 的 `VERDICT_SEVERITIES` 一致。`retryCost`、`modelRuns`、`roundsWithoutVerdicts` 只被本文件的 `cohortStats`/`renderTable` 和测试使用。CSV 列与 baseline 表头一致，没有别的代码消费这些新列。唯一对不上的使用端是文档（意见 5、8）和未按 `round ?? 1` 处理旧记录（“推测”）。
