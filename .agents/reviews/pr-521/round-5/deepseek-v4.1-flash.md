## 先说结论：增量与上一轮意见

`git diff 2dbd4b8a9..c37618e52 -- scripts/model-review/review-speed-report.mjs` 只有一处行为改动（`cohortStats` 的 `labelled` 过滤）加六行测试，另改了一行 `model-review.md`。上一轮列出的 5 条代码问题，**没有一条被这次增量碰到**；下面逐条核对后仍然成立。增量本身（缓存 `off` 不计入命中率分母）改对了，没有发现新错。

---

### 1. 中 失败费用仍在两种情况下丢失或记到错误一侧

**文件：行**：`scripts/model-review/review-speed-report.mjs:82-84`、`107-111`、`153-157`

**问题（读代码证实）**：
- 没有成功轮的 PR：失败记录只进 `retry` 表，而 `retry` 的孤儿记录靠 `sorted.find(...)` 找同 PR 的第一个成功轮；PR 没有任何成功轮时 `owner` 为 `undefined`，费用被静默丢弃，该 PR 也不进 `costPerPr`。
- 跨分界的 PR：孤儿重试永远挂到该 PR **最早**的成功轮上，不管失败轮发生在分界前还是分界后；`compare` 再按轮所在 cohort 汇总，于是分界后的失败费用可能被算进“优化前”。

**证据**：
```js
82:       if (record.outcome !== "ok") {
83:         const retryKey = `${pr}\0${record.round ?? 1}`;
84:         retry.set(retryKey, (retry.get(retryKey) ?? 0) + (Number(record.cost) || 0));
...
107:   for (const [key, cost] of retry) {
108:     if (placed.has(key)) continue;
109:     const owner = sorted.find((round) => round.pr === Number(key.split("\0")[0]));
110:     if (owner) owner.retryCost += cost;
111:   }
```
```js
153:     costPerPr: median(
154:       [...byPr.values()].map((list) =>
155:         sum(list.map((round) => (Number(round.cost) || 0) + round.retryCost)),
```
测试 `test/tooling/review-speed-report.test.mjs:254-264` 明确断言“只有失败记录的 PR”`costPerPr` 为 `null`，等于把“费用丢弃”固定成了预期。

**建议**：失败记录要带自己的 `at` 保留下来；只失败的 PR 至少应以“只有费用、没有轮”的形式进入 cohort 汇总；孤儿重试按失败记录自己的时间/轮次归 cohort，而不是挂到最早成功轮。补一条“失败轮在分界后、成功轮在分界前”的反向测试。

---

### 2. 中低 `costUnknown`/`inFlight` 仍按原始 `cost` 计入，费用偏低

**文件：行**：`scripts/model-review/review-speed-report.mjs:122`、`155`；`scripts/model-review/opencode-review.mjs:516-517`、`1017-1022`、`1196-1204`

**问题（读代码证实）**：当某一步没有合法 cost 时，账本只累加其余合法部分并置 `costUnknown`；`inFlight` 表示还有未结算的请求。预算判断 `spentOf` 对这两种记录取 `max(cost + 预留, 每模型上限)` 的保守值，但报表的 `costFull`/`costIncremental`/`costPerPr` 直接用 `record.cost`。同一份账本，在“能不能花钱”和“实际花了多少”两处口径不一致，报表会系统性偏低。

**证据**：
```js
516:       if (validCost(part.cost)) usage.cost += part.cost;
517:       else usage.costUnknown = true;
```
```js
1019:   const inFlight = runs.some((run) => run.inFlight);
...
1022:   if (inFlight) usage.inFlight = true;
```
```js
1200:       (record.costUnknown || record.inFlight
1201:         ? Math.max(record.cost + WRAP_UP_RESERVE_USD, COST_LIMIT_PER_MODEL_USD)
1202:         : record.cost),
```
报表侧：
```js
122:     cost: sum(group.rows.map((row) => row.cost)),
```

**建议**：复用 `spentOf` 的保守口径，或明确标记/排除这两类记录并单独报告条数；至少不能让“费用中位”把不确定花费当成确定花费。补一条 `costUnknown: true` 的测试。

---

### 3. 中低 verdicts 的“可读性”判定比权威解析器宽，null/数组/基本类型或缺字段行被当成 0 条中高意见

**文件：行**：`scripts/model-review/review-speed-report.mjs:8-22`、`33-41`；`scripts/model-review/opencode-review.mjs:1299-1334`；`.agents/instructions/model-review.md:61`

**问题（读代码证实）**：`readJsonLines` 只把 JSON 解析失败计为 `invalid`；`null`、字符串、数字被直接跳过且不计错，数组因为 `typeof [] === "object"` 被当成记录压入。`mediumHighCount` 又只看三个字段。于是：
- 只有 `null`、`[]`、`"x"`、`42` 的 `verdicts.jsonl` 返回 0 条中高意见，算作“可读、没有意见”，而不是“格式错误”；
- 缺 `id`/`model`/`quote`/`trigger`/`consequence` 的行只要带 `valid:true`、`class:"error"`、`severity:"medium-high"`，也会被计数。

这与 `parseVerdicts` 不一致（后者对同样的行抛 `VERDICTS_INVALID`），也与表头“文件不存在或格式错误”的说明不一致，会直接影响 `mediumHighPerRound`、`roundsWithoutVerdicts` 和“44% 因为上一轮有成立的中高意见”这一结论。

**证据**：
```js
16:       if (parsed !== null && typeof parsed === "object") rows.push(parsed);
...
17:     } catch {
18:       rows.invalid += 1;
19:     }
```
```js
38:   return rows.filter(
39:     (row) => row.valid === true && row.class === "error" && MEDIUM_HIGH.has(row.severity),
40:   ).length;
```
权威解析器：
```js
1314:       const valid =
1315:         verdict !== null &&
...
1317:         VERDICT_TEXT_FIELDS.every(filled) &&
1318:         REVIEW_MODELS.includes(verdict.model) &&
...
1331:       if (!valid || seen.has(verdict.id)) throw new Error(`VERDICTS_INVALID ${path}:${number}`);
```
`model-review.md:61` 说格式不对脚本以 `VERDICTS_INVALID` 拒绝。测试 `test/tooling/review-speed-report.test.mjs:237-252` 反而断言 `null` 行对应 `mediumHigh` 为 0。

**建议**：`verdicts.jsonl` 直接复用 `parseVerdicts`（或完整复制其校验），任何一行不合格就让该轮返回 `null`；宽松的“跳过空行”只留给 `usage.jsonl`。补 `null`、数组、基本类型、缺字段四类反向用例。

---

### 4. 低 同一轮同一模型多条 `ok` 时只留最后一条，先前成功尝试的费用没有计入任何地方

**文件：行**：`scripts/model-review/review-speed-report.mjs:88-92`

**问题（读代码证实）**：去重键是 `pr/round/model`，只保留 `at` 最大的一条 `ok`；被覆盖的 `ok` 记录既不进 `retry`（非 `ok` 才进），也不参与任何求和，费用、步数、token 全部丢失。正常流程里 `roundForRun` 会拒绝同轮同模型的再次成功（`opencode-review.mjs:2231-2233`），但合并/复制账本、或将来新增写入方时没有这层保证。另外 `at` 完全相同时保留的是先读到的一条，不是“最后一条”。

**证据**：
```js
88:       const key = `${pr}\0${record.round ?? 1}\0${record.model}`;
89:       const earlier = rounds.get(key);
90:       if (!earlier || Date.parse(record.at) > Date.parse(earlier.at))
91:         rounds.set(key, { pr, ...record, round: record.round ?? 1 });
```

**建议**：遇到同一键的第二条 `ok` 时，要么把先前 `ok` 的费用并入 `retryCost`/单独统计，要么发出告警并跳过而不是静默覆盖；补一条“同轮同模型两条 `ok`”的测试。

---

### 5. 低 账本里的 `round` 未校验就拼进读盘路径，和 `parseUsage` 不一致

**文件：行**：`scripts/model-review/review-speed-report.mjs:34`、`48`、`88`；`scripts/model-review/opencode-review.mjs:2131-2132`、`2180-2193`

**问题（读代码证实）**：`pr` 来自目录名 `^pr-(\d+)$`，是安全的；`round` 直接取自账本 `record.round ?? 1`，可以是字符串、浮点、`0`、负数或带 `/` 的路径片段，然后被拼成 `round-${round}/verdicts.jsonl`。权威账本解析器要求 `round` 是安全正整数，否则整份账本 `USAGE_LEDGER_INVALID`；报表却会照读，可能读到不是本轮的 `verdicts.jsonl`（路径穿越），也可能把字符串轮次和数字轮次当成不同轮统计。只读脚本降低了危害，但两份代码对同一账本给出不同结论。

顺带：报表也没有像 `parseUsage` 那样校验 `cost`（负数会原样累加），见 `84`、`155`。

**证据**：
```js
34:   const file = join(reviewsDir, `pr-${pr}`, `round-${round}`, "verdicts.jsonl");
```
```js
2131:       const roundValid =
2132:         record?.round === undefined || (Number.isSafeInteger(record.round) && record.round > 0);
...
2192:       )
2193:         throw new Error(`USAGE_LEDGER_INVALID ${path}:${number}`);
```

**建议**：在使用 `round` 前做 `Number.isSafeInteger(round) && round > 0` 校验，不合格就跳过并计数/打印；最好直接复用 `parseUsage` 读账本。补 `round: "2"`、`0`、`"../../x"` 的测试。

---

## 推测与未核实

- 上述 1、2、3 对 ADR 0270 具体数字的影响程度**未核实**：本工作区是 59% 的稀疏检出，`.agents/reviews/pr-*` 不在工作区；尝试 `git show 2d7d3847c:.agents/reviews/pr-521/round-4/verdicts.jsonl` 时被环境以 `REVIEW_GIT_REFUSED records-path` 拒绝。因此无法统计真实的“只有失败记录的 PR”“跨分界孤儿重试”“null/数组 verdicts”数量，也无法独立核对上一轮 5 条意见的原文与严重度；这里以用户给出的清单和当前代码为准。
- 报表 `cohortStats` 的 `turnaround` 在 after 子集上重算，因此每个跨分界 PR 在分界后的第一条间隔会被丢掉（`sincePreviousMs` 为 `null`），而这一条往往正是过渡期的长间隔。这是代码读出来的行为；它对中位数的影响大小属于推测，**未核实**。
- `selfCheckSeconds` 仍把 `off`、`miss`、`hit` 三种自检混在一个中位数里，而命中率又排除了 `off`。这是有意的取舍还是遗漏，**未核实**。

## 侧重检查

- **错误路径**：缺目录 CLI 返回 `REVIEW_SPEED_REPORT_NO_DIR`（`review-speed-report.mjs:274-278`），非法 `--cut` 返回 2（`269-273`），缺 `verdicts.jsonl` 返回 `null`（`35`），JSON 解析失败返回 `null`（`17-19`、`37`）。结论：缺目录/非法时间处理正确；verdicts 的 schema 错误没有按“格式错误”处理（意见 3）。
- **不合规范或不可信输入**：账本 `round`、`cost`、行结构都没有按 `parseUsage`/`parseVerdicts` 校验（意见 3、5）；CSV 对以 `=+-@` 开头的字符串做了防公式注入（`216-221`），这点正确；模型名/时间等字符串进 CSV 前有转义。
- **安全**：脚本只 import 读文件 API（`node:fs` 的 `existsSync/readdirSync/readFileSync`），没有 `spawn`、网络或写文件，输出只到 stdout/stderr（`2-4`、`262-296`）。`selfCheckCacheWrite` 是既有代码，缓存目录 `0o700`、文件 `0o600`（`2847-2852`），新增字段不涉及密钥；`ledgerLine` 仍经过 `maskSecretLikeDeep`（`3282-3284`）。
- **资源耗尽**：`readJsonLines` 用 `readFileSync` + `split` 整份读入，没有大小上限；账本在仓库内、由复核流程写入，风险低，且本次增量未改变这一点。
- **不可撤销操作**：本 PR 的报表是只读；账本追加是既有流程；没有新增删除、覆盖或付款操作。
- **规则/文档一致性**：`model-review.md:61` 只允许 `low`/`medium-high`，`VERDICT_SEVERITIES`（`opencode-review.mjs:1284`）和报表 `MEDIUM_HIGH`（`review-speed-report.mjs:6`）一致；“medium/high”本来就不是合法取值，报表只认 `medium-high` 是对的。`model-review.md:201` 对 `selfCheckCache` 的 `hit/miss/off` 描述与 `selfCheckCacheLabel`（`2823-2826`）、打印（`3949-3950`）和账本写入（`4025`）一致。`speed-data.txt:41-45` 对 CSV 语义和跨分界 `sincePreviousMs` 的限制有说明。
- **增量本身**：`af58efb07` 把 `labelled` 从 `!== undefined` 收紧为只认 `hit`/`miss`（`139-141`），与生产者只产出这三个值一致；新增测试用 `hit/miss/off` 断言 `0.5`，改回旧过滤会得到 `0.333`，是有效的反向用例。`SELF_CHECK_OK` 的输出字节没变（只是把同一表达式提成函数）。**没有发现增量引入的新错**。
- **范围外**：`2dbd4b8..c37618e` 还包含把 main（PR 435/443/520/522 等）合入的改动；这些不属于 PR 521，我只确认了它们没有改 `scripts/model-review/review-speed-report.mjs` 和 `opencode-review.mjs` 的 `selfCheckCache` 生产者，没有逐份复读。

## 必答问题

1. **不会改变模型已见过的请求开头。** 本改动只新增/读取账本字段和只读报表，没有碰系统提示、工具定义、历史消息或遮盖。报表不向模型发任何东西；`selfCheckCache` 只由自检的缓存键和命中状态决定，不进入复核请求。发给模型的内容仍然只在本轮末尾追加，每轮变化的值仍不在本改动涉及的系统提示/工具定义里（本改动没有改变这条性质）。
2. **不会让同一段文字在不同请求里变成不同字节。** `selfCheckCache` 的值是 `hit`/`miss`/`off`，不含时间、不含前后文；报表只读账本，不参与请求序列化或遮盖。增量没有改 `maskSecretLike*` 或任何请求构造。
3. **只有部分自动检查，且不完整。** 新加的“cache-off 不计入分母”测试是真正的反向用例；缺目录（CLI）、只有失败记录、缺失/非法 verdicts、null 行也有测试。但意见 1、2、4、5 没有测试；“只有失败记录”的测试还把丢弃费用断言成预期；`SELF_CHECK_OK` 与账本字段只用同一个函数的单元测试保证，没有端到端断言两者相等。因此反向覆盖不足。
4. **增量产生/修改的值，直接使用端都能接受。**
   - 生产者：`selfCheckCacheLabel`（`opencode-review.mjs:2823-2826`），在 `3949` 用于打印、`4025` 写入账本。
   - 使用端：`review-speed-report.mjs:139-142` 只认 `hit`/`miss`（`off` 被排除，符合本次修改意图）；`renderCsv` 原样输出该列；`parseUsage` 不拒绝未知字段，`ledgerLine` 直接 JSON 序列化，所以新增字段不会让账本校验失败；`SELF_CHECK_OK` 的输出保持原字节；基线 CSV 表头与 `renderCsv` 的列顺序一致。
   - 没有新增导出的函数、配置键或清单项（`selfCheckCacheLabel` 是新增导出，但只在主脚本和测试中使用）。
   - 但报表自己产生的 `mediumHigh`、`sincePreviousMs`、`cost` 虽然只被 `renderTable`/`renderCsv` 和测试消费，其输入校验却比权威解析器宽（意见 3、5），两端对“什么算可读账本”还没有对齐。

另外逐项回答你点名要查的：

- **同一 PR、同一轮、同一模型多条记录取最后一条**：正常情况下一条 `ok` 时没问题；多条 `ok` 时会丢掉先前成功尝试的费用（意见 4）；`at` 相同则保留先读到的一条，不是最后一条。
- **失败尝试费用是否仍算进 PR 花费**：同一轮有成功记录、或 PR 任意轮有成功记录时会算；PR 完全没有成功轮时被丢弃；跨分界时可能算到较早的 cohort（意见 1）。
- **`sincePreviousMs` 跨分界是否误导**：对比表里 `cohortStats` 对子集重新调用 `intervals`，分界后每个 PR 的第一条为 `null`，不会把跨分界间隔算进去；`--csv` 不带 `--cut` 时会保留跨分界间隔，`speed-data.txt:45` 已明确提醒要排除或重算；基线 CSV 是按单条模型运行算的，`speed-data.txt:3` 也说明了不能和新列直接比。**没有未说明的误导**，但 after 子集丢掉每个 PR 的首条过渡间隔这一统计偏差未在文档里说明。
- **中高意见判定是否和 `model-review.md` 一致**：判定字段 `valid === true`、`class === "error"`、`severity === "medium-high"` 与规范一致；规范只允许 `low`/`medium-high`，`medium`/`high` 不是合法值，不应计数。问题是报表没有同时核对整行是否合法（意见 3）。
- **`selfCheckCache` 是否改变 `SELF_CHECK_OK` 输出或账本其他字段**：`SELF_CHECK_OK` 的输出字节不变（同一表达式抽成函数）；账本只多这一字段，其他字段未改；`selfCheckCacheLabel` 的输出与旧表达式等价。
- **测试是否有反向用例（失败的轮、缺目录）**：有缺目录、只有失败记录、非法 verdicts、null 行、cache-off 的测试；但意见 1/2/4/5 缺少反向用例，且“只有失败记录”的测试锁定的是被质疑的行为。

## 本轮查过的范围

`git diff f81cf9c..c37618e` 的全部 PR 521 文件（`scripts/model-review/review-speed-report.mjs`、`scripts/model-review/opencode-review.mjs`、两个测试、`model-review.md`、`docs/assets/review-cost/*`），以及 `git diff 2dbd4b8..c37618e` 中与 PR 521 有关的 `af58efb07` 增量；对 `review-speed-report.mjs` 逐行读完，并核对了其生产者/消费者 `parseUsage`、`parseVerdicts`、`spentOf`、`selfCheckCacheLabel`、`delegate.mjs`。未复读 main 合入的其它 PR 代码；`.agents/reviews` 实际账本与第 4 轮 verdicts 因稀疏检出和环境拒绝读记录路径而未核实。
