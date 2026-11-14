本轮范围：只审 `3d2f3bd..fb1b9e3` 的增量（`review-speed-report.mjs`、其测试、`review-speed-data.txt` 第 3 行），并沿证据核对了 `opencode-review.mjs` 的 `selfCheckCache` 改动、`model-review.md` 的严重度定义和 baseline CSV。`.agents/reviews/pr-521/*` 在稀疏检出中不可读，实际 verdicts/usage 数据未核实；受工具限制没有实际运行测试，以下“测试会失败/会通过”均为阅读推断。

### 1. 中 没有成功轮的 PR 的失败费用被丢弃，孤儿重试在跨分界 PR 上会记到错误的一侧
文件:行：`scripts/model-review/review-speed-report.mjs:106`
问题：新的孤儿重试循环只在 PR 至少有一条 `ok` 记录时才能挂账；`const owner = sorted.find(...)` 找不到就整笔丢掉。且它把失败轮的费用挂到该 PR **最早的成功轮**，不看失败记录自己的时间，跨过分界时会把分界之后的失败费用算进“优化前”。
证据：
```js
106:  for (const [key, cost] of retry) {
107:    if (placed.has(key)) continue;
108:    const owner = sorted.find((round) => round.pr === Number(key.split("\0")[0]));
109:    if (owner) owner.retryCost += cost;
110:  }
```
建议：按失败记录自己的 `pr/round/at` 归组，不要借用最早成功轮；PR 一条成功轮都没有时也要保留这笔费用（单列“无成功轮的花费”或按时间归 cohort）。补两个反向用例：只有失败记录的 PR、失败轮在分界后的分裂 PR。

### 2. 中低 `costUnknown`/`inFlight` 仍按原始 `cost` 计，费用会偏低（上轮意见 2 只修了一半）
文件:行：`scripts/model-review/review-speed-report.mjs:83`、`:152`
问题：失败重试和 `costPerPr` 都直接取 `record.cost`，未处理账本里表示“费用读不到/最后一步在途”的标记。`opencode-review.mjs` 自己在算钱时用的是保守公式，报告却用低估的原始值。
证据：
```js
83:        retry.set(retryKey, (retry.get(retryKey) ?? 0) + (Number(record.cost) || 0));
...
152:        sum(list.map((round) => (Number(round.cost) || 0) + round.retryCost)),
```
对照 `scripts/model-review/opencode-review.mjs:1200`：
```js
1200:      (record.costUnknown || record.inFlight
1201:        ? Math.max(record.cost + WRAP_UP_RESERVE_USD, COST_LIMIT_PER_MODEL_USD)
1202:        : record.cost),
```
新的表头写了“按账本里的 `cost` 字段”，只说明了取字段，没说明该字段在这些记录上偏低。建议复用 `spentOf` 的公式，或在表头/文档明确“`costUnknown`/`inFlight` 记录未按保守值上浮”，并补测试。

### 3. 低 完整 CSV 的 `sincePreviousMs` 在跨分界 PR 上仍按全局前一轮算，与对比表口径不一致
文件:行：`scripts/model-review/review-speed-report.mjs:237`、`docs/assets/review-cost/2026-11-14-review-speed-data.txt:43`
问题：`compare` 的 turnaround 只在同一 cohort 内用 `intervals` 重算（`review-speed-report.mjs:128`），但 `renderCsv` 对完整导出按全部行重算，跨分界 PR 在分界后的第一条记录会带上跨越分界的间隔。文档又让用户“在导出的表里按日期筛”，筛出“优化后”后第一条就会用到这个跨 cohort 值。
证据：
```js
237:  const since = new Map();
238:  for (const { group, sincePreviousMs } of intervals(rounds))
239:    for (const row of group.rows) since.set(row, sincePreviousMs);
```
建议：导出时也按 cohort/cut 切分，或增加一列标明该间隔是否跨 cohort；至少把“手工按日期筛后首行间隔会跨分界”写进文档。现有测试 `test/tooling/review-speed-report.test.mjs:226` 只覆盖 `--csv --cut`。

### 4. 低 新文档把 baseline 的 `mediumHigh` 说成按单条模型运行算，与数据不符
文件:行：`docs/assets/review-cost/2026-11-14-review-speed-data.txt:3`
问题：baseline 的 `mediumHigh` 是**每轮**算的，不是按单条模型运行算；同一轮两个模型的该列相同。真正会让 baseline 与新脚本不同的是旧脚本的严重度集合多了 `medium`/`high`，以及 `sincePreviousMs` 的口径。
证据：baseline 同一 PR 同一轮两行同值：
```text
2026-11-14-review-rounds-baseline.csv:33  263,1,...,glm-5.3-flash,...,5
2026-11-14-review-rounds-baseline.csv:38  263,1,...,deepseek-v4.1-flash,...,5
```
旧脚本（`git show 87d343a57:scripts/model-review/review-speed-report.mjs`）里 `round.mediumHigh = mediumHighCount(reviewsDir, round.pr, round.round)` 也是按轮赋值。建议把那句改成：“`sincePreviousMs` 按单条模型运行算；`mediumHigh` 按轮算，但旧脚本的严重度集合含 `medium`/`high`，所以可能不同。”

### 5. 低 “格式错误 verdicts”修复只挡住 JSON 解析失败，合法 JSON 的 `null` 仍会让脚本崩溃
文件:行：`scripts/model-review/review-speed-report.mjs:15`、`:37`
问题：`JSON.parse("null")` 成功，`rows.invalid` 仍是 0；随后 `row.valid` 对 `null` 会抛 `TypeError`，报告直接异常退出，而不是像“没有可用 verdicts”那样返回 `null`。测试只写了 `not json`。
证据：
```js
15:      rows.push(JSON.parse(line));
...
37:  return rows.filter(
38:    (row) => row.valid === true && row.class === "error" && MEDIUM_HIGH.has(row.severity),
39:  ).length;
```
建议：解析后要求是非 `null` 对象，否则计入 `invalid`；usage 读取处（`:78` 的 `record.mode`）同理。补 `null`、数组、字符串行的测试。

### 6. 低 同一轮同一模型有多条 `ok` 记录时只留最后一条，先前成功尝试的费用没有计入任何地方
文件:行：`scripts/model-review/review-speed-report.mjs:87`
问题：去重只保留最新的 `ok` 记录，`steps/token/at` 取最新是对的；但若同一轮同一模型因重跑产生两条 `ok`，前一条的真实花费不再进入 `retry`（只有非 `ok` 才进），`costPerPr` 会少算。代码行为确定，实际是否会发生这种“双成功”记录属于推测。
证据：
```js
87:      const key = `${pr}\0${record.round ?? 1}\0${record.model}`;
89:      if (!earlier || Date.parse(record.at) > Date.parse(earlier.at))
90:        rounds.set(key, { pr, ...record, round: record.round ?? 1 });
```
建议：指标取最新记录的同时，把未选中的成功尝试 `cost` 累加到该轮的重试费用，或明确说明只统计最后一轮成功尝试。

### 7. 低 新增的 `NO_DIR` 分支和“零成功轮”场景没有自动测试；测试名与覆盖不符
文件:行：`scripts/model-review/review-speed-report.mjs:267`、`test/tooling/review-speed-report.test.mjs:202`、`:236`
问题：`REVIEW_SPEED_REPORT_NO_DIR` 只存在于 `main`，测试仍只验证 `loadRounds` 返回 `[]`；名为“counts failed cost of a round that never succeeded”的用例里 PR 12 仍有第 1 轮成功，未覆盖 `sorted.find` 找不到 owner 的分支。
证据：
```js
267:  if (!existsSync(reviewsDir)) {
268:    console.error(`REVIEW_SPEED_REPORT_NO_DIR ${reviewsDir}`);
```
```js
207:          record({ round: 1, at: "2026-11-14T10:00:00.000Z", cost: 0.1 }),
208:          record({ round: 2, at: "2026-11-14T10:20:00.000Z", outcome: "failed", cost: 0.3 }),
```
建议：把参数/退出码处理抽成可测函数或加 CLI 测试；增加只有失败记录、无成功轮的 PR 用例。

### 8. 低 `roundsWithoutVerdicts` 把格式错误的 verdicts 文件也报成“没有 verdicts.jsonl”
文件:行：`scripts/model-review/review-speed-report.mjs:160`、`:197`
问题：格式错误现在返回 `null`，计入了“没有 verdicts.jsonl 的轮数”，标签会让人以为文件不存在。这是修复意见 7 后遗留的措辞问题。
证据：
```js
160:    roundsWithoutVerdicts: groups.length - judged.length,
...
197:    ["没有 verdicts.jsonl 的轮数", (s) => s.roundsWithoutVerdicts, 0],
```
建议：把标签改成“没有可用 verdicts 的轮数”，或分别统计缺失与格式错误。

**上一轮意见核对**
- 1（多模型轮重复采样）：已改好。`cohortStats` 改为按 `roundGroups` 汇总 `steps/cost/input`（`review-speed-report.mjs:117`），新测试 11 覆盖。
- 2（失败重试费用）：部分改好。孤儿失败轮现在会挂账，但见意见 1、2、6 的残留。
- 4（跨分界重复计轮）：已改好。`compare` 用 `group.end` 整轮归 cohort（`:169`），测试 11 覆盖；`costPerPr` 在跨分界 PR 上仍是两侧各算一部分，但不再重复计轮。
- 5（文档说脚本不在仓库）：已改好，`review-speed-data.txt:3` 已指向仓库脚本。
- 6（时间/文本反向用例）：已改好。新增的 `2026-11-14T10:00:00+09:00` 用例在按文本比较时会得到不同结果（测试 `:153`）。
- 7（畸形 verdicts 当成 0 条）：基本改好，见意见 5 对“合法 JSON 非对象”的残留。
- 8（baseline CSV 口径说明）：部分改好；说明加了，但 `mediumHigh` 的原因写错（意见 4）。
- 9（未使用的 `distinctPerPr`）：已删除。
- 10（缺目录静默空报告）：已改好行为（`main:267`），但没有测试（意见 7）。

**侧重检查**
- 错误路径：`--cut` 非法在 `compare` 和 `main` 都会拒绝（`:168`、`:262`）；缺目录现在退出码 2；畸形 verdicts 部分覆盖（见意见 5）；CSV 公式注入有转义（`:212`）。
- 不合规范/不可信输入：`readJsonLines` 接受任意合法 JSON（含 `null`），会崩溃（意见 5）；`usage.jsonl` 的坏行仍被静默跳过，不像 verdicts 那样报 `invalid`；`record.round` 未按整数校验就用于拼路径，理论上可路径穿越读任意 `verdicts.jsonl`——这是旧代码，增量未触及，未单列为本轮意见。
- 资源耗尽：报告一次性读入全部账本，账本量级小，未见新增的无界循环或递归。
- 不可撤销操作/安全：脚本只 `stat/read`，没有写文件、调用外部命令或网络；确认符合“只读账本、不花钱、不写文件”。
- 规则/文档与代码一致：`model-review.md:61` 和 `opencode-review.mjs:1284` 只允许 `low`/`medium-high`，报告只数 `medium-high`（`:6`），代码与规则一致；作者说法里的 `medium`/`high` 不对，是旧脚本写法，已在新脚本中去掉。文档 `review-speed-data.txt:3` 对 baseline `mediumHigh` 的解释与数据不符（意见 4）。

**必答问题**
1. **不会改变模型已见过的请求开头。** 增量只改账本写入和只读报告：`selfCheckCache` 在 `opencode-review.mjs:3949` 计算、`:4025` 写进 `usage.jsonl`，不进入提示组装路径（提示在 `:3826` 前后构建）；`SELF_CHECK_OK` 的输出字符串与旧表达式逐字等价（`:3950`）。报告脚本不产生模型请求。PR 自带的复核记录也只会在同一 PR 的下一轮作为 `--previous` 材料追加在末尾。因此发给模型的内容仍是只追加，变化值（`selfCheckMs`/`selfCheckCache`）只在账本里，不在请求开头或最后一条消息。
2. **不会让模型见过的文字在不同请求里变成不同字节。** `selfCheckCacheLabel` 是固定映射（`off`/`hit`/`miss`），报告输出不进入任何请求。报告自身按 `at` 排序、取中位数，未见依赖 `Date.now()` 或无序集合序列化到提示；唯一理论上的非确定性是同一 PR 两条记录时间完全相同时依赖目录读取顺序，属于极端情况，且不影响模型请求。
3. **有对应自动检查，反向用例多数会真的失败。** 多模型轮旧实现会算两轮、旧 `compare` 会把分裂轮拆到两个 cohort、旧代码会把畸形 verdicts 当 0 条、按文本比较会在新加的时间用例上给出不同结果；这些新用例在旧实现上会失败（依据旧版 `review-speed-report.mjs` 已读）。缺口：`NO_DIR` CLI 分支、无成功轮 PR 的失败费用、合法 JSON 非对象、完整 CSV 跨分界间隔没有反向用例；测试未实际运行，执行结果未核实。
4. **增量产生/修改的值逐个核对：** `selfCheckCache` 生产者 `opencode-review.mjs:3949`/`:4025`，消费者 `review-speed-report.mjs:138` 和文档 `review-speed-data.txt:41`，取值集合与文档一致，账本校验不拒绝未知字段；`mediumHigh` 生产者 `:36`，消费者 `:132`/`:159`/CSV 列，取值与 `model-review.md:61`、`VERDICT_SEVERITIES` 一致；`retryCost` 只被 `:152` 消费；`rows.invalid` 只在 `mediumHighCount` 内部消费；`REVIEW_SPEED_REPORT_NO_DIR` 只写 stderr/退出码 2；`round ?? 1` 会进入分组键和 `pr-${pr}/round-${round}` 路径，报告没有校验整数，见侧重检查里的旧代码风险。除上面几条意见外，两端校验可以接受。
