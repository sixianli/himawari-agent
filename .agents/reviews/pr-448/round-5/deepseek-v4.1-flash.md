测试未运行（本次只能用 read/grep/git 只读命令），以下全部是对照代码的静态核对。最高严重度是「低」，未发现会阻断合并的代码错误；第 4 轮两条修改基本到位。

## 结论概览

- 说法 1（`stoodIn` 条件）：**成立**。`coveragePoints` 的 `stoodIn` 现在要求同轮存在被替补模型自己的非 `ok`、无 `substitute` 记录，且有一条 `substitute: true` 的 `ok` 记录。
- 说法 2（文档写明改默认与替补条件）：**大体成立**，但文档点名的“要一起改的测试文件”不完整（见发现 2）。
- 说法 3（不许改写旧 ADR，只记 `amended_by`）：**成立**。`.agents/instructions/document-governance.md:18` 明确“绝不改写先前 ADR 的决定内容”，`:55` 要求“用新 ADR 取代旧 ADR，而不是改写旧 ADR”；仓库已有大量 `amends`/`amended_by` 先例（如 ADR 0030、0031、0177）。0175 只加了 `amended_by` 一行，0259 逐条写明修正范围。

## 发现（按严重度）

### 低 1 — `delegate.mjs check` 与合并门对“替补算数”的条件不一致
**文件:行**：`scripts/model-review/delegate.mjs:363-370`，`scripts/model-review/opencode-review.mjs:1283-1293`

**问题**：`checkResult` 的 `finished()` 只要求“有一条 `ok`，且它是该模型的直接记录或 `substituteFor` 指向该模型”，没有采用本轮新增的“被替补模型必须在同一轮有一条未通过记录”这一条件；而且它用 `!record.substitute`，合并门用 `record.substitute === undefined`。对正常脚本写出的账本两边一致，但对 `substitute: false/null` 之类手工或异常账本，`delegate.mjs check` 可能报 `ok`，而合并门随后报 `no-complete-round`。

**证据**：
```js
// delegate.mjs:363-370
const finished = (model) =>
  added.some(
    (record) =>
      record.outcome === "ok" &&
      ((record.model === model && !record.substitute) ||
        (record.substitute && record.substituteFor === model)),
  );
```
```js
// opencode-review.mjs:1283-1293
const stoodIn = (model) =>
  inRound.some(
    (record) =>
      record.model === model && record.substitute === undefined && record.outcome !== "ok",
  ) &&
  passed.some(
    (record) =>
      record.substitute === true &&
      record.substituteFor === model &&
      record.model === SUBSTITUTES[model],
  );
```

**建议**：让 `delegate.mjs check` 复用 `coveragePoints` 的判定，或至少把 `!record.substitute` 改成 `record.substitute === undefined`，并补一条“只有替补 ok、没有原模型失败记录”的 delegate 反向用例。

### 低 2 — 文档点名的“改默认要一起改的测试”不全
**文件:行**：`.agents/instructions/model-review.md:4`、`test/tooling/plan-claims-gate.test.mjs:238-240`

**问题**：文档说改 `review-models.json` 的 `default` 时脚本不用改，但要一起改 `opencode-review.test.mjs`、`opencode-review-merge-gate.test.mjs` 里的断言。实际 `plan-claims-gate.test.mjs` 也把当前默认写死为 `[deepseek]`，改默认后同样会失败，却未被列出。

**证据**：
```js
// plan-claims-gate.test.mjs:238-240
it("[claims] needs a committed file, a topic, and no hand-written brief; defaults to DeepSeek only", () => {
  const options = parseArgs(argv);
  expect(options.models).toEqual([deepseek]);
```
```md
// model-review.md:4（节选）
...测试里按现在的默认值（只有 DeepSeek）写的断言一起改（`test/tooling/opencode-review.test.mjs`、`test/tooling/opencode-review-merge-gate.test.mjs` 里对 `DEFAULT_REVIEW_MODELS` 的断言...
```

**建议**：把 `plan-claims-gate.test.mjs` 也写上，或改成从配置推导期望值（如 `expect(options.models).toEqual(DEFAULT_REVIEW_MODELS)`），避免每改一次默认要到处找断言。

### 低 3 — 规则文件里“第 2 轮起只有它一个”已过时
**文件:行**：`.agents/instructions/model-review.md:104`

**问题**：该句仍以“第 2 轮起只有 DeepSeek”解释为什么把“文档与代码一致”并入 DeepSeek 侧重；按本 PR 后的默认，方案讨论和代码复核的**每一轮**（含第 1 轮）都只有 DeepSeek。

**证据**：
```md
// model-review.md:104（节选）
...因为第 2 轮起只有它一个，GLM 那份侧重没人看...
```
与 `model-review.md:4`、`:49` 的“每一轮默认只跑 DeepSeek”不一致。

**建议**：改成“默认每轮都只有它一个”，或删掉“第 2 轮起”的限定。

### 低 4 — “失败记录必须在同一轮”缺少独立反向用例
**文件:行**：`test/tooling/opencode-review-merge-gate.test.mjs:1078-1084`、`scripts/model-review/opencode-review.mjs:1284-1287`

**问题**：新增的反向用例只覆盖“完全没有失败记录”的情况。若把实现里的 `inRound` 过滤去掉（改为在全部记录里找失败记录），这条用例仍然通过；也就是说“这一轮里”这一半条件没有反向测试保护。

**证据**：
```js
// 新增用例
f.writeLedger([ok(1, f.reviewed, glm, { substitute: true, substituteFor: deepseek })]);
expect(f.check().problems).toEqual(["no-complete-round"]);
```
```js
// 实现
inRound.some(
  (record) =>
    record.model === model && record.substitute === undefined && record.outcome !== "ok",
)
```

**建议**：补一条“第 1 轮 DeepSeek 失败、第 2 轮只有 GLM 替补 ok”的用例，应报 `no-complete-round`（或对应 `unreviewed`），以锁住同一轮约束。

### 低 5 — 改 `substitutes` 映射会让旧账本按新映射重算
**文件:行**：`scripts/model-review/opencode-review.mjs:974`、`:1288-1293`、`:1310-1314`

**问题**：`coveragePoints` 用**当前**配置的 `SUBSTITUTES` 判断历史替补记录是否算数。以后若 Andy 调整 `review-models.json` 的 `substitutes`，旧账本里已有的替补轮次可能突然不再算数（只会更严，不会更松）。ADR 0259 只在“改 default”的语境下承诺“旧账本仍然能读”，没有提醒改 `substitutes` 的这个后果。影响是推测的，但代码依赖可证实。

**证据**：
```js
export const SUBSTITUTES = reviewModels.substitutes;
...
record.model === SUBSTITUTES[record.substituteFor]
```

**建议**：在 ADR/说明里写明“改 `substitutes` 会改变历史轮次的算法”，或判断时优先信任记录里已有的 `substituteFor` 与 `allowed` 清单，减少对当前映射的依赖。

### 低 6 — 委派补跑说明的“去掉 --models”表述与现在总有 `--models` 不符
**文件:行**：`scripts/model-review/delegate.mjs:106-128`、`:137`

**问题**：`reviewArgv` 现在无条件生成 `--models <值>`，补跑说明仍写“上面那条去掉 `--models` 后，加 `--round ... --models <短名>`”。按字面只删 `--models` 会留下原模型名成为位置参数，正确做法应是删掉该项及其值。

**证据**：
```js
// delegate.mjs:115-116
"--models",
(task.models ?? DEFAULT_REVIEW_MODELS.map(shortModel)).join(","),
```
```js
// delegate.mjs:137
...命令是上面那条去掉 --models 后，加 --round <那一轮的序号> --models <那个模型的短名>...
```

**建议**：改成“去掉 `--models` 及其值后”。

## 必答问题

### 1. 会改变模型已见过的请求开头吗？
**不会（已核实）**。改动没有碰 `buildPrompt`：固定部分（角色、工具、任务、必问问题、侧重、输出格式）在 `opencode-review.mjs:345-361`，随轮变化的值（`head`、`base`、`previous`、本轮材料）都在末尾的 `material`（`:362-374`）。改默认只改变“跑哪个模型/生成哪一份固定侧重”，同一模型的开头仍逐字节相同；第 1 轮替补是新的 GLM 会话，用 GLM 自己的固定侧重，不是在同一请求前面插入内容。追加式重试/追问逻辑未改。

### 2. 同一段文字会在不同请求里变成不同字节吗？
**不会（已核实）**。改动没有把配置、集合或时间写进提示词。新增的 `new Set`（`opencode-review.mjs:1294-1302`）只用于计算 `needed/by` 和筛选账本记录，不参与提示词拼接；账本里的 `at`（`:3339`）本来就不发给模型。因此不存在“依赖前后文的遮盖、带时间的字段、无序集合”进入请求的问题。

### 3. 有没有自动检查，反向用例真的会失败吗？
**有，且主要反向用例确实会失败（已核实其逻辑）**：
- `stoodIn` 修复：新增用例 `opencode-review-merge-gate.test.mjs:1078-1080` 只放一条 GLM 替补记录，期望 `no-complete-round`。按改动前的逻辑，`both=false`、`covering` 会接受这条替补记录并判为 `substitute`，所以该用例在旧代码上会失败，能拦住回归。
- 第 1 轮替补：`opencode-review.test.mjs:589-611` 现在要求 `previous` 为空时仍返回 GLM 替补，旧代码会返回 `null`，会失败。
- 第 1 轮单模型默认：`opencode-review-merge-gate.test.mjs:2355-2394` 断言默认只跑默认模型，旧代码的 `ARG_FIRST_ROUND_NEEDS_BOTH_MODELS` 会抛错。
- 配置校验：`opencode-review.test.mjs:508-560` 覆盖空、重复、越界、非法格式、`substitutes` 为空/自映射/越界、文件不可读、`default` 非法。
- **缺口**：如上“发现 4”，“失败记录必须在同一轮”没有独立反向用例；`delegate` 与合并门的不一致也没有测试。文档改动本身没有自动检查（符合预期）。

### 4. 改动产生/修改的每个值，各使用方都能接受吗？
逐项核对结果：
- `review-models.json` 的 `allowed/default/substitutes`：产生于配置文件；由 `readReviewModels`/`reviewModelsProblems`（`opencode-review.mjs:58-92`）校验非空、去重、短名不重复、格式合法、`default`/`substitutes` 属于 `allowed`；`REVIEW_MODELS`/`DEFAULT_REVIEW_MODELS`/`SUBSTITUTES`（`:96-97`、`:974`）的消费方（`parseArgs:2819`、`coveragePoints:1294-1314`、`delegate.reviewArgv:116`、`reserveModels:3016-3019`、`reviewConfig`/gateway）都能接受。测试还核对每个 `allowed` 模型都有 `MODEL_LENSES`、`MODEL_OUTPUT_LIMITS` 和 `gateway.json` 条目（`opencode-review.test.mjs:525-530`）。
- 新增的 `by` 值 `requested/default/substitute`：只被 `walkChain:1346`、`REVIEW_CHAIN` 输出 `:1525`、`accept-low` 判断 `:1562`、`report:1646` 和测试消费，均按字符串比较，能接受。
- `substitute: true`/`substituteFor`：产生于 `runOne` 的 `extra`（`:3409-3412`），账本组装 `:3338-3368` 原样写入；`delegate`（`326/341/367`）和 `coveragePoints`（`1283-1314`）都能接受；正常写入的记录要么无该字段、要么 `true`（`runOne` 的 `extra` 只在替补时传入，`git log -S` 也未在脚本里找到写 `substitute:false` 的版本）。
- `--models` 默认值：`parseArgs` 默认 `DEFAULT_REVIEW_MODELS`（`:2819`），`delegate.reviewArgv` 也显式传同一默认（`delegate.mjs:116`），`checkResult` 又用 `parseArgs(reviewArgv(task))` 算期望模型（`delegate.mjs:301`），两端一致。
- **唯一未对齐**：`delegate` 的 `!record.substitute` 与合并门的 `record.substitute === undefined`，以及是否要求同轮失败记录，见发现 1。
- 未核实：`review-models.json` 是否被打包/部署清单排除、外部文档治理校验器对 0259 的 frontmatter 判定（只能看到仓库内规则和既有先例）。

## 侧重检查

- **错误路径**：配置缺失/JSON 非法/结构非法都会在模块加载时以 `REVIEW_MODELS_CONFIG_INVALID` 失败（`:83-92`）。替补只在 `outcome === "api-error"`、`retry === "retried"`、错误可重试时发生（`:980-988`）；替补前重新做预算检查（`:3397-3406`）。第 1 轮替补已生效。缺点：`readReviewModels` 在模块顶层执行，`delegate.mjs` 若配置坏了会在 import 阶段抛异常，提示不如 `main().catch` 友好（低）。
- **不合规范/不可信输入**：模型名被限制为 `^[\w.-]+\/[\w.-]+$`，不会出现控制字符或额外 `/` 的路径拼接；`allowed` 短名必须唯一，避免 `MODEL_LENSES`/`MODEL_OUTPUT_LIMITS`/路由组键冲突。账本来自已提交文件，本就按“防手误不防有意”信任；`substitute` 字段类型没有被 `parseUsage` 校验，`"true"`/`false` 会被当作无效替补而不是拒绝，属既有行为，不因本次改动新增风险。
- **安全**：没有新增密钥、命令拼接或外部输入；`--models` 仍经 `parseArgs` 白名单校验（`:2873-2886`）。未发现凭据泄露面。
- **资源耗尽**：第 1 轮现在也会预留 GLM（`reserveModels:3016-3019` → `:3294`），这是保守方向；真实花费仍受每模型 0.2 美元和替补前的 `budgetCheck` 约束。配置在 import 时读取，仓库文件规模可控。
- **不可撤销操作**：无。只读合并门和账本追加逻辑未改变写入语义。
- **规则/文档与代码一致**：ADR 0259 与 0175 的 `amends`/`amended_by` 双向指向、0175 正文保留旧决定，符合治理规则；`model-review.md:68` 与 `coveragePoints` 的新条件一致。仍有过时/不完整处：`model-review.md:104` 的“第 2 轮起”与测试文件清单（发现 2、3）。旧 ADR 0175 正文本身未改，符合作者第 3 条的说法。
