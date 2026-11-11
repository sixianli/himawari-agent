## 侧重检查

- **错误路径**：查了参数解析、`--days/--end`、`--miss-cost`、owner/agent 配对、数据库打开、时间格式断言、多 scope 分支。见 `scripts/calibration-report/thresholds.mjs:22-35`、`:48-67`、`packages/calibration/src/index.ts:662-668`。结论：大多能报错，但缺值参数会被静默当成 `"1"`（见下文低危项）。
- **不合规范/不可信输入**：SQL 全部参数化；`kind`、`outcome`、`category`、`owner_rating`、`confidence_permille` 都有库表 CHECK 约束（`packages/persistence-sqlite/src/migrations/0069_decision_ledger.sql:5-55`）。报告只输出 id、分数、分类，不输出正文。
- **安全/不可撤销**：数据库以 `readonly: true, fileMustExist: true` 打开（`thresholds.mjs:55-58`），脚本没有写库、没有改门槛，属于不可撤销操作的风险很低。
- **资源耗尽**：确认有 O(N²) 计算和“读取所有决策类别”的查询，见下文中危项。
- **规则/文档一致**：本改动不碰提示词组装；`prompt-prefix.md` 的“只追加、会变的值放最后一条”没有被违反。作者说明里有几处与代码不完全一致，见下文。

## 读代码证实的问题

### 1. 高：`kept_tentative` 被同时当作“已开口”和“门槛未开口”，报告的核心指标会失真

**文件:行**：`packages/calibration/src/thresholds.ts:35-36`、`:103-106`、`:194-196`、`:237-238`；`packages/application/src/services/automatic-memory-service.ts:165-184`

**问题**：`kept_tentative` 被列入门槛决定，且 `positiveOutcomes` 只有 `kept`，所以 `sampleTruth` 把 `kept_tentative + useful` 判成 `shouldAct`。但 `kept_tentative` 的实际分数一定低于现行门槛；`curvePoint` 又按 `score >= threshold` 判断“开口”。结果是一条**实际已被保留（tentative）**的记录，在当前门槛下被算成“漏报”，重跑时还可能被标成“沉默变成开口”。这与报告自己写的“漏报 = 按这个门槛会沉默、但你评为该开口”不一致。

**证据**：
```ts
// thresholds.ts:35-36
gatedReasons: Object.freeze(["auto_committed", "kept_tentative", "confidence_below_threshold"]),
positiveOutcomes: Object.freeze(["kept"]),

// thresholds.ts:103-106
const acted = gate.positiveOutcomes.includes(outcome);
if (rating === "useful") return acted ? "shouldAct" : "shouldNot";
...
if (!acted && rating === "missed") return "shouldAct";

// thresholds.ts:194-196
const acts = sample.score >= threshold;
if (acts && sample.truth === "shouldNot") disturbances += 1;
if (!acts && sample.truth === "shouldAct") misses += 1;

// automatic-memory-service.ts:165-184
candidate.confidencePermille <
  (this.options.automaticConfidencePermille ?? thresholdFor(...))
  ...
  "kept_tentative",
```
**影响**：大量 `kept_tentative` 的 useful 评价会把当前误漏报曲线整体偏向“漏报”，从而把建议门槛压低。`replay` 的 `usefulSilenceBroken`/`usefulSilenced` 文案对这些记录也不成立。

**建议**：明确门槛控制的到底是“自动存入”还是“是否保留”。如果是自动存入，应把“开口”基准改为 `reason_code === "auto_committed"`，并把 `kept_tentative` 单列（或先排除，等评价语义明确）；如果“保留即开口”，则当前点不能用 `score >= threshold` 来模拟。补一条 `kept_tentative + useful/unneeded` 的反向测试。

### 2. 中：启用分类覆盖后，overall 的“现行门槛”和 replay 的 before 会互相矛盾

**文件:行**：`packages/calibration/src/thresholds.ts:159`、`:173-183`、`:357-373`、`:237`

**问题**：每个样本保存的是 `currentThreshold = thresholdFor(gate, row.category)`；但 overall 段落的 current 固定用 `gate.defaultThreshold`。启用 `byCategory` 后：
- `currentPoint` 用 `defaultThreshold` 计算；
- `replay` 的 `before` 用每条的 `currentThreshold`；
- `thresholdCandidates` 只加入每条样本的 `currentThreshold`，若所有分类都被覆盖且没有样本分数恰好是默认值，overall 的默认门槛甚至不会进入候选集。

**证据**：
```ts
// :159
currentThreshold: thresholdFor(gate, row.category),

// :357-361
const overall = analyzeSegment(
  gate, null, set.samples, gate.defaultThreshold, required, missCostRatios,
);

// :181
values.add(sample.currentThreshold);

// :237
const before = sample.score >= sample.currentThreshold;
```
**影响**：这是 P4-7 填入 `byCategory` 后才会触发的潜在错误；当前 `byCategory` 为空，所以线上行为还没变。但任务明确要求登记表支持分类覆盖，届时报告会给出自相矛盾的“现在门槛”和重跑结果。

**建议**：有分类覆盖时，overall 不应假装存在一个全局现行门槛；要么只做分类报告，要么让 overall 的 currentPoint/replay 都使用“每条按分类取当前门槛”的真实动作，并显式把 `defaultThreshold` 加入候选集。补一个非空 `byCategory` 的测试。

### 3. 中：报告会把所有决策类别读进内存，并对样本做 O(N²) 曲线计算

**文件:行**：`scripts/calibration-report/thresholds.mjs:74-83`；`packages/calibration/src/thresholds.ts:173-205`、`:402-407`

**问题**：`THRESHOLD_SQL.rows` 没有按 `kind` 过滤，会把 `proactive`、`consolidation` 等全部历史决策读出来；`analyzeSegment` 对最多约 `2N` 个候选门槛逐个 `curvePoint`，每个又遍历 N 条样本，整体约 O(N²)。生产库的 decision_ledger 可能很大，手动运行也可能占大量内存/CPU。

**证据**：
```ts
// thresholds.mjs:74-83
const read = database.transaction(() => {
  assertTimestampFormat(database);
  ...
  rows: database.prepare(THRESHOLD_SQL.rows).all(...parameters),
  counts: database.prepare(THRESHOLD_SQL.kindCounts).all(...parameters),
})();
const analyses = THRESHOLD_GATES.map((gate) =>
  analyzeGate(gate, read.rows, { required, missCostRatios }),
);

// thresholds.ts:177-183
const values = new Set<number>([0, scoreMax + 1]);
for (const sample of samples) { values.add(sample.score); ... }
return [...values].sort(...);

// thresholds.ts:193-197
for (const sample of samples) {
  const acts = sample.score >= threshold;
  ...
}
```
**建议**：SQL 只取 `THRESHOLD_GATES` 需要的 `decisionKind`（可分批或只取 memory_candidate），并按 score 排序后用前缀和计算每个候选门槛的 disturbances/misses，降到 O(N log N)；对超大库给出上限或警告。

### 4. 低：登记表的 `scoreField` 没有被 SQL 使用，未来换分数字段会静默取错

**文件:行**：`packages/calibration/src/thresholds.ts:33`、`:402-407`

**问题**：`ThresholdGate.scoreField` 声明了分数字段，但查询固定写死 `confidence_permille AS score`。以后新增的 gate 如果分数不在这个字段，报告不会报错，只会把分数当成 `null` 全部计入“没有分数”。

**证据**：
```ts
// :33
scoreField: "confidencePermille",

// :403-404
rows: `SELECT id, kind, COALESCE(outcome, verdict) AS outcome, reason_code AS reasonCode,
    owner_rating AS ownerRating, category, confidence_permille AS score, checked_at AS decidedAt
```
**建议**：要么删掉 `scoreField`，明确目前只支持 `confidencePermille`；要么按 gate 生成/校验 SQL，遇到不支持的字段直接抛错。

### 5. 低：参数缺值会被当成 `"1"`，带 `=` 的数据库路径会被截断

**文件:行**：`scripts/calibration-report/thresholds.mjs:25`、`:55-64`

**问题**：`const [key, value = "1"] = ...split("=")` 导致：
- `--db` 单独出现时会尝试打开当前目录下的文件 `1`；
- `--db=/path/a=b` 会被截成 `/path/a`；
- `--owner` 单独给值 `"1"`，再配 `--agent=...` 会静默使用错误 scope；
- 显式给 `--owner/--agent` 时没有核对两者是否真实存在，拼错只会得到“样本不足”。

**证据**：
```js
const [key, value = "1"] = argument.replace(/^--/u, "").split("=");
...
if (options.has("owner") !== options.has("agent"))
  throw new TypeError("THRESHOLD_SCOPE：--owner 和 --agent 要一起给，或者都不给。");
...
scope = { ownerId: options.get("owner"), agentId: options.get("agent") };
```
**建议**：要求所有带值参数必须显式 `=值` 且非空；用 `indexOf("=")` 只切第一个等号；对显式 scope 做一次存在性校验，不存在就报错。

### 6. 低：作者说明与代码有几处不一致

- 作者说复用 `packages/calibration` 的 `findScopes`，实际 `findScopes` 在 `scripts/calibration-report/calibration.mjs:11`，不在 `packages/calibration`。
- 报告头部写“两者都除以已评价总数”（`packages/calibration/src/thresholds.ts:514`），但代码分母是 `samples.length`，已排除“已评价但不由门槛决定”“没有分数”“评价和结果对不上”的记录（`:128-151`、`:202-203`）。统计保证本身没问题，但文案应写成“已评价且纳入统计的样本数”。
- 作者说“不到 N 时只输出样本不足”，实际还会输出报告标题、N、跳过条数等，只是不给曲线和建议值（`:509-527`）。

## 推测/风险

- `packages/calibration/src/index.ts:985` 的 `export * from "./thresholds.ts"` 与 `thresholds.ts:1` 反向导入形成循环。当前 `thresholds.ts` 顶层不读取 `WILSON_Z/proportion`，所以没有触发 TDZ；但以后若在顶层调用这些函数就会变成初始化错误。建议把共用统计函数抽到独立模块，避免循环。
- 报告直接把数据库里的 `id`、`kind` 原样写进终端。虽然正常 ledger id 是哈希，但库文件若来自不可信来源，id 里的控制字符可能污染终端。这个风险很低，未核实实际威胁模型。
- 未来 `rule_review` 若带分数但未登记 gate，当前“没有分数门槛的决策类别”文案会无条件说“这类决策没有记录分数”（`:531-535`），可能误导。当前 schema 还禁止非 memory_candidate 写 `confidence_permille`，所以只是未来风险。

## 必答问题

### 1. 会不会改变模型已经见过的请求开头？

**不会（针对本次 diff）。** 这次没有改任何提示词、工具定义、历史或遮盖代码；新增的是离线报告脚本，生产路径只把自动记忆门槛从字面量 `850` 改成从登记表读默认值 `850`，且 `byCategory` 为空，`thresholdFor` 必然返回 850。因此行为与改动前相同，发给模型的内容仍只在末尾追加，每轮变化的值仍应放在最后一条消息里（`prompt-prefix.md:27-29`）。

需要说明的是：如果将来 P4-7 填了 `byCategory`，自动记忆的保留/暂存结果会变化，进而可能改变“本轮选中的记忆”。按规则这些记忆应只出现在最后一条消息；**本次未读提示词组装/记忆注入代码，未核实这一点**。

### 2. 会不会让同一段文字在不同请求里变成不同字节？

**模型请求：不会。** 没有新增时间字段、无序集合或依赖前后文的遮盖；登记表是静态常量，`thresholdFor` 是纯函数，分类来自已约束的数据库字段。

**报告输出：** 不用 `--days` 时是确定的；用 `--days` 时标题里的日期来自 `now`，同一天内稳定、跨天会变。这是报告本身的预期，不会进入模型请求。

### 3. 有没有对应的自动检查，反向用例是否真的会失败？

有新增 `test/integration/threshold-suggestion.test.ts`，并且被 `ci/policy.json` 的 `test/integration/**/*.test.ts` 覆盖。

- N 的反向测试是真实有效的：`worstCaseIntervalWidth(n) <= 0.1` 且 `worstCaseIntervalWidth(n-1) > 0.1`（`:96-102`），门槛算法放宽或收紧都会失败。
- 样本不足、曲线、建议值、replay、无分数类别、无参数运行、坏参数都有覆盖。
- **覆盖缺口**：没有 `kept_tentative` 用例，因此上面第 1 个问题不会被测试发现；没有非空 `byCategory` 用例；`keeps the live auto-commit threshold in one place` 只检查登记表常量等于 850（`:258-262`），没有检查 `automatic-memory-service` 真的走登记表；没有 `--days/--end` 和显式 owner/agent 的过滤测试。建议补这些反向用例。

### 4. 改动产生/修改的每个值，两端都能接受吗？

逐个核对如下：

- **`defaultThreshold = 850`**：产生于 `thresholds.ts:37`，使用于 `automatic-memory-service.ts:167-169` 和报告。服务端做的是 `confidencePermille` 整数比较，850 可接受；当前 `byCategory` 为空，行为不变。**已核实一致。** 但若某调用方设置了 `automaticConfidencePermille`，报告仍显示 850，无法反映实际配置；代码里除 golden 测试外未发现生产设置该选项。
- **`decisionKind = "memory_candidate"`**：与库表 `kind` 的 CHECK 和生产者一致（`0069_decision_ledger.sql:5-9`、`automatic-memory-service.ts:532`）。**一致。**
- **`gatedReasons`**：`auto_committed`、`kept_tentative`、`confidence_below_threshold` 都能在生产代码中找到产生处（`automatic-memory-service.ts:183`、`:198`、`:190`）。**一致。**
- **`positiveOutcomes = ["kept"]`**：库表允许 `kept`，但把 `kept_tentative` 也当作“kept/已开口”与曲线实际动作不一致，见第 1 个问题。**语义不一致。**
- **分类键**：`THRESHOLD_CATEGORIES`（`thresholds.ts:3-15`）与 `MEMORY_CATEGORIES`（`packages/application/src/ports/memory-projection.ts:13-24`）以及库表 CHECK（`0069_decision_ledger.sql:29-35`）目前完全相同，`thresholdFor` 读到的分类能通过后端校验。**目前一致**，但两份常量重复，未来新增分类容易漂移；建议只保留一份来源。
- **`scoreField`**：声明了但 SQL 固定用 `confidence_permille`，见第 4 个问题。**当前只有一个 gate 时没影响，未来不一致。**
- **报告候选值/建议值**：只用于输出，不回写；`0`、`scoreMax + 1`、分数、分数 +1、现行门槛都在合法范围。**不会影响后端校验。**
- **无分数类别**：用 `kindCounts` 列出，新增库表允许的类别不会让脚本报错；当前 `rule_review` 尚未在 migration 中，若直接插入会被数据库 CHECK 拒绝，这是另一 PR 需要同步处理的 schema 变更，不属于本改动。
- **报告输出字段**：SQL 别名 `score`、`ownerRating`、`reasonCode`、`decidedAt` 与 `ThresholdDecisionRow` 一致；`COALESCE(outcome, verdict)` 对 memory_candidate 取 outcome，能接受。

**结论**：本次 diff 的生产行为实际未变，报告可以运行；但报告对 `kept_tentative` 的统计/重跑语义有实质问题，分类覆盖和未来分数字段也存在未闭合的设计缺口。
