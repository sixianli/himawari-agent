我先说明本轮范围：看了 `fb1b9e3..2dbd4b8` 的增量 diff，通读了当前 `review-speed-report.mjs`、`test/tooling/review-speed-report.test.mjs`、`opencode-review.mjs` 中 `selfCheckCache`/`spentOf`/`parseUsage`/`parseVerdicts` 相关段，读了 `prompt-prefix.md`、`model-review.md`、`review-speed-data.txt` 和基线 CSV 的抽样行，并用了 `git diff/log/show`。没有运行 vitest（本轮命令受限），`.agents/reviews/pr-521` 下的记录正文没有读到（`git show` 对该路径返回 `REVIEW_GIT_REFUSED`），因此涉及真实记录分布的地方标为未核实。

**作者说法核对**

- “上一轮成立的会出错意见，作者已修改”不成立：增量只动了空行过滤、表头文字、文档和测试，上一轮 #1、#2、#6 的代码路径完全没变，见下面意见 1、2、4。
- 上一轮 #4 已改好：文档第 3 行改成“`mediumHigh` 两边都按轮算”，我抽查基线 CSV 的同一 `pr,round` 多模型行确实同值（如 263 轮 1 两个模型都是 5，266 轮 1 都是 3，278 轮 1 都是 7）；基线 `sincePreviousMs` 确实是按单条模型运行算的（255 轮 1 两条相差 9135ms）。
- 上一轮 #5 的“崩溃”已修：`null` 不会再让脚本抛 `TypeError`；但修法带来了新的统计口径问题，见意见 3。
- 上一轮 #8 只改了文字标签：解析失败的坏文件会被算作“没有可读 verdicts”，但合法 JSON 的 `null`/数组/基本类型仍被当成“可读且 0 条意见”，与标签“文件不存在或格式错误”仍不一致，见意见 3。

### 1. 中 上一轮 #1 未修：没有成功轮的 PR 的失败费用仍然被丢弃，跨分界 PR 的孤儿重试仍可能记到错误一侧

- 文件:行：`scripts/model-review/review-speed-report.mjs:82-86`、`:107-111`、`test/tooling/review-speed-report.test.mjs:254-264`
- 问题：失败记录只进入 `retry`；只有存在同 `pr,round` 的 `ok` 记录时才会被放回 `retryCost`。整个 PR 都没有成功轮时，`sorted.find(...)` 返回 `undefined`，费用直接消失；有成功轮但失败轮本身没有成功记录时，费用被塞给该 PR 最早的成功轮，而不是按失败记录自己的时间归属分界。
- 证据（读代码证实）：
  - `review-speed-report.mjs:107-111`
    ```js
    for (const [key, cost] of retry) {
      if (placed.has(key)) continue;
      const owner = sorted.find((round) => round.pr === Number(key.split("\0")[0]));
      if (owner) owner.retryCost += cost;
    }
    ```
  - 新加的测试把丢弃行为写成了期望：`review-speed-report.test.mjs:257-260`
    ```js
    expect(loadRounds(dir)).toEqual([]);
    ...
    expect(stats.costPerPr).toBeNull();
    ```
- 建议：PR 费用应从该 PR 的所有记录（成功 + 失败）直接汇总，不依赖“必须有一个成功轮”的 owner；孤儿重试按失败记录自己的 `at` 归入分界，或单独作为该 PR 的失败费用。补两个反向用例：只有失败记录的 PR 仍要有费用；失败轮在分界后、最早成功轮在分界前时，费用应算到分界后。

### 2. 中低 上一轮 #2 未修：`costUnknown`/`inFlight` 仍按原始 `cost` 计入，费用会偏低

- 文件:行：`scripts/model-review/review-speed-report.mjs:122`、`:153`；对照 `scripts/model-review/opencode-review.mjs:1196-1204`
- 问题：脚本对所有记录直接 `Number(round.cost) || 0`，没有识别 `costUnknown`/`inFlight`。而复核脚本自己把这两种记录视为“费用未知、至少按上限估”：
- 证据（读代码证实）：
  - `review-speed-report.mjs:153`
    ```js
    sum(list.map((round) => (Number(round.cost) || 0) + round.retryCost)),
    ```
  - `opencode-review.mjs:1200-1202`
    ```js
    (record.costUnknown || record.inFlight
      ? Math.max(record.cost + WRAP_UP_RESERVE_USD, COST_LIMIT_PER_MODEL_USD)
      : record.cost)
    ```
- 建议：`costPerPr` 复用 `spentOf` 的估算口径，或在表里单列“其中 N 条费用未知”，避免把下限当真实费用。补一条 `costUnknown: true` 的反向用例。

### 3. 中低 合法 JSON 的 `null`/数组/基本类型被当作“可读 verdicts 里的 0 条中高意见”，格式错误不再计入未读轮数

- 文件:行：`scripts/model-review/review-speed-report.mjs:14-19`、`:36-40`；测试 `test/tooling/review-speed-report.test.mjs:237-252`
- 问题：增量把 `null` 静默跳过，但没有把它计入 `rows.invalid`。于是 `verdicts.jsonl` 只有 `null` 时，`mediumHighCount` 返回 0，而不是 `null`；该轮会被当成“有可读 verdicts、零条中高意见”进入分母，拉低 `mediumHighPerRound`。这与同一提交改出来的标签“文件不存在或格式错误”直接矛盾。
- 证据（读代码证实）：
  - `review-speed-report.mjs:15-16`
    ```js
    const parsed = JSON.parse(line);
    if (parsed !== null && typeof parsed === "object") rows.push(parsed);
    ```
  - `review-speed-report.mjs:36-40`
    ```js
    const rows = readJsonLines(file);
    if (rows.invalid > 0) return null;
    return rows.filter(...).length;
    ```
  - 测试把它固定成 0：`review-speed-report.test.mjs:248`
    ```js
    expect(rounds[0].mediumHigh).toBe(0);
    ```
- 建议：对 `verdicts.jsonl` 的合法 JSON 非对象行也累加 `rows.invalid`（或单独标记 schema 错误），使 `mediumHighCount` 返回 `null`；把测试期望改成 `mediumHigh === null`、`roundsWithoutVerdicts === 1`。如果确实想忽略 `null`，表头就不要再写“格式错误”，并在文档里说明“只统计 JSON 对象行”。

### 4. 低 上一轮 #6 未修：同一轮同一模型多条 `ok` 时只保留最后一条，先前成功尝试的费用没有计入任何地方

- 文件:行：`scripts/model-review/review-speed-report.mjs:88-92`
- 问题：按 `pr,round,model` 去重时，新的 `ok` 记录直接覆盖旧记录；旧的成功记录既不在 `rounds` 里，也不进 `retry`，其 `cost`/`steps`/token 全部丢失。若两次成功尝试是真实的两次运行，费用应计入该 PR。
- 证据（读代码证实）：
  ```js
  const key = `${pr}\0${record.round ?? 1}\0${record.model}`;
  const earlier = rounds.get(key);
  if (!earlier || Date.parse(record.at) > Date.parse(earlier.at))
    rounds.set(key, { pr, ...record, round: record.round ?? 1 });
  ```
- 建议：保留“最后一条”作为该模型该轮的代表值可以，但应把更早 `ok` 尝试的 `cost` 单独累加到 `retryCost` 或单独的 `earlierOkCost`，确保 PR 费用不丢；补一条同轮同模型两条 `ok` 的反向用例。

### 5. 低 账本里的 `round` 未校验就拼进读盘路径，和权威解析器的校验不一致

- 文件:行：`scripts/model-review/review-speed-report.mjs:34`、`:91`、`:97`；对照 `scripts/model-review/opencode-review.mjs:2131-2132`
- 问题：`record.round` 直接来自 JSONL，脚本用 `` `round-${round}` `` 拼路径。`parseUsage` 要求 `round` 是正整数，但报告脚本绕过了它。一个格式错误或被手工构造的账本记录可以用 `round: "../..."` 把读取目标指到别的目录；虽然最终文件名固定为 `verdicts.jsonl`、脚本只读且不输出文件内容，危害有限，但仍属于不可信输入进入路径。
- 证据（读代码证实）：
  - `review-speed-report.mjs:91`
    ```js
    rounds.set(key, { pr, ...record, round: record.round ?? 1 });
    ```
  - `review-speed-report.mjs:34`
    ```js
    const file = join(reviewsDir, `pr-${pr}`, `round-${round}`, "verdicts.jsonl");
    ```
  - `opencode-review.mjs:2131-2132`
    ```js
    const roundValid =
      record?.round === undefined || (Number.isSafeInteger(record.round) && record.round > 0);
    ```
- 建议：在 `loadRounds` 里按 `parseUsage` 的规则校验 `round`，非法记录跳过或计入 invalid 统计；`mediumHighCount` 只接受已校验的整数。

### 6. 低 自检缓存命中比例把 `off` 算进分母，禁用缓存时命中率会被拉低

- 文件:行：`scripts/model-review/review-speed-report.mjs:139-140`、`:163`；文档 `docs/assets/review-cost/2026-11-14-review-speed-data.txt:41`
- 问题：`labelled` 包含 `hit`、`miss`、`off`，命中率分母是全部标记记录。`off` 表示缓存被环境变量关掉，不是“没命中”，把它算作非命中会让“自检缓存命中比例”在禁用缓存的运行里偏低。
- 证据（读代码证实）：
  ```js
  const labelled = rounds.filter((round) => round.selfCheckCache !== undefined);
  const hits = labelled.filter((round) => round.selfCheckCache === "hit").length;
  ...
  selfCheckHitRate: labelled.length ? hits / labelled.length : null,
  ```
- 建议：命中率用 `hit / (hit + miss)`，`off` 单独给数量；或者表头明确写“全部新记录中含 `hit` 的比例”。

### 7. 低 新账本字段 `selfCheckCache` 没写进规则文件的账本字段说明

- 文件:行：`scripts/model-review/opencode-review.mjs:4024-4026`；`.agents/instructions/model-review.md:201`
- 问题：代码在账本记录里新增了 `selfCheckCache`，但规则文件只写“每条记录还记耗时：`selfCheckMs`（自检）、`runMs`（这个模型从启动到结束）”，没有提到 `selfCheckCache` 及其取值。后续按规则读账本的人不会知道这个字段，属于规则/文档与代码不一致。
- 证据（读代码证实）：
  ```js
  selfCheckMs,
  selfCheckCache,
  runMs,
  ```
- 建议：在 `model-review.md` 的账本字段说明里补上 `selfCheckCache`（`hit`/`miss`/`off`），并说明旧记录没有该字段。

**读代码证实的**

- `review-speed-report.mjs` 只 `import { existsSync, readdirSync, readFileSync }`，只往 stdout/stderr 写，不写文件、不花钱；符合“只读账本”的约束。
- `selfCheckCacheLabel` 的返回值与旧的内联表达式等价：旧代码 `cacheKey ? (cached ? "hit" : "miss") : "off"`，新函数 `if (!cacheKey) return "off"; return cached ? "hit" : "miss";`，因此 `SELF_CHECK_OK` 对同一输入输出相同字节。
- `selfCheckCache` 只被 `review-speed-report.mjs`（`labelled`/`hits`/CSV 列）和文档使用；`parseUsage` 没有未知字段白名单，`ledgerLine` 只做遮盖，新增字段不会让账本读取失败，也没有改动其他字段。
- `MEDIUM_HIGH = new Set(["medium-high"])` 与 `model-review.md` 的“severity 是 `low` 或 `medium-high`”以及 `opencode-review.mjs` 的 `VERDICT_SEVERITIES = ["low", "medium-high"]`、`parseVerdicts` 校验一致；`ROUND_SUMMARY` 用 `severity !== "low"`，对合法数据等价。问题里说的 `medium`/`high` 不是当前规范允许的值。
- `compare` 按 `group.end` 整轮归入分界，因此对比表的 `turnaroundMin` 不会把跨分界轮的间隔算进去；`--csv` 不带 `--cut` 时导出的首条“优化后”记录会跨分界，文档第 45 行已经提醒要排除或重算。这一点文档与代码一致。
- 基线 CSV 的 `mediumHigh` 抽样确实同轮同值（263/266/268/274/278/294/295 等），文档 #4 的说法成立。

**推测（未核实）**

- 真实账本里 `costUnknown`/`inFlight`、同轮同模型多条 `ok` 的实际频率没有统计；如果很少，意见 2、4 的金额偏差有限，但代码路径确实存在。
- `round` 路径穿越的实际危害取决于是否存在恶意的 `usage.jsonl`；脚本只读且目标文件名固定为 `verdicts.jsonl`，所以我没有把它评为中高。
- `off` 缓存是否常见取决于 `HIMAWARI_REVIEW_SELFCHECK_CACHE=off` 的使用场景，未核实。
- 基线 CSV 我只抽样了若干同轮多模型行，没有逐行重算 941 行；`mediumHigh` 按轮的结论是抽样加代码/文档核对的结果。

**侧重检查**

- 错误路径：查了坏 JSON、合法 JSON 的 `null`、缺失 `verdicts.jsonl`、缺失 `--reviews-dir`、非法 `--cut`、只有失败记录的 PR、失败重试、同轮多模型、跨分界轮。缺目录和非法 `--cut` 会以非零退出码报错；坏 JSON 解析错误会计入 `invalid`；`null` 不崩溃但被静默当成可读空文件（意见 3）。
- 不合规范/不可信输入：`round` 未校验即进路径（意见 5）；`model` 只用于键和 CSV，CSV 已对 `=+-@` 等前缀转义；`at` 有 `Date.parse` 校验；`cost` 用 `Number` 兜底，非数字会变 0，可能低估但不会崩。
- 安全：报告不联网、不写文件、不打印账本原文；CSV 公式注入有处理（`csvCell`）。未发现泄密路径。
- 资源耗尽：`readFileSync` 整文件读取，没有大小上限；异常大的 `usage.jsonl`/`verdicts.jsonl` 会占用内存，但这是本地只读报告，未作为正式意见上报。
- 不可撤销操作：没有；脚本只读 stdout/stderr。
- 规则/说明文档与代码一致：`prompt-prefix.md` 相关规则未被触碰；`model-review.md` 缺 `selfCheckCache` 说明（意见 7）；`review-speed-data.txt` 的 `mediumHigh` 口径已改对，`sincePreviousMs` 口径也与基线 CSV 相符。

**必答问题**

1. **不会改变模型已经见过的请求开头。** 改动只涉及只读报告脚本、账本字段和日志行；`selfCheckCache` 在自检结束后才计算并写入 `usage.jsonl`（`opencode-review.mjs:3949-3950`、`:4025`），不进入系统提示、工具定义、历史或遮盖结果，也没有触碰任何 prompt 组装路径。发给模型的内容仍然只在末尾追加，本轮没有新增“每轮会变”的值进入请求前部；依据 `prompt-prefix.md` 第 1 至 4 条。
2. **不会让模型请求里的同一段文字变成不同字节。** 没有改遮盖、序列化、工具或历史逻辑；`selfCheckCache` 的 `hit/miss/off` 只写账本，报告脚本也不参与请求组装。报告输出本身对同一账本基本确定（按 `at` 排序）；唯一会随运行环境变化的是账本里的 `selfCheckCache`，但它不会发给模型。
3. **有自动检查，但覆盖不全。** `null` 的用例是真反向用例：改动前 `loadRounds` 会对 `null` 取 `record.mode` 抛错，改动后通过。缺目录、非法 `--cut`、失败重试、同轮多模型、坏 verdicts 都有用例。但上一轮 #1、#2、#6 没有会失败的反向用例；`test/tooling/review-speed-report.test.mjs:254-264` 反而把“只有失败记录的 PR 费用为 `null`”写成期望，修好 #1 会让这条测试失败。`selfCheckCacheLabel` 只测了三个映射，没有断言 `SELF_CHECK_OK` 或账本字段真的写出。
4. **增量产生/修改的值的直接使用端基本能接受，但有两处不一致。**
   - `selfCheckCacheLabel`：只被 `opencode-review.mjs:3949` 和测试使用，返回值与旧表达式等价。
   - `selfCheckCache` 字段：被 `review-speed-report.mjs:139-140/163/237` 和文档消费；`parseUsage` 不拒绝未知字段，`ledgerLine` 只做遮盖，旧记录没有该字段时报告用 `!== undefined` 区分，能接受。
   - `REVIEW_SPEED_REPORT_NO_DIR`：目前只有新增测试使用，没有别的包装脚本依赖它。
   - `mediumHigh` 的 severity 判定与 `model-review.md`/`parseVerdicts` 一致（只认 `low`、`medium-high`）；报告用精确 `medium-high`，对合法数据等价于 `!== "low"`。
   - 不一致的两处：账本 `round` 未按 `parseUsage` 校验就进路径（意见 5）；`selfCheckCache` 没写进规则文件（意见 7）。
   - 文档里“基线 `mediumHigh` 按轮算、同轮同值”经基线 CSV 抽样核对成立；`sincePreviousMs` 基线按单条模型运行算也与 CSV 相符。
