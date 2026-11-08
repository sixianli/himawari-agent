## 概览

我读了 `34843f5..1bea46f` 的完整改动和 `a4ab2d8..1bea46f` 的增量，重点核对了 `scripts/model-review/opencode-review.mjs`、`gateway.mjs`、`test/tooling/` 和文档。没有发现会改变模型请求开头、会让同一段文字在不同请求里变成不同字节、或让 `--providers` 绕过积分底线/悄悄使用未列出服务方的问题。发现 1 个具体的健壮性缺陷（覆盖记录 `problems` 元素类型未校验导致 `--report` 崩溃），以及若干低严重度的文档、诊断和测试问题。

`.agents/reviews/topic-review-control/proposal.md` 未读到：工作区里没有（sparse checkout 排除了 `.agents/reviews`），`git show` 又被复核沙箱以 `REVIEW_GIT_REFUSED records-path` 拒绝。所以 proposal 原文未核实，下面只对照代码、`model-review.md`、`AGENTS.md`、`owner-standing-rules.md`、ADR 0178 和测试。

---

## 读代码证实的问题

### 1. 低-中：覆盖记录的 `problems` 元素类型未校验，`--report` 会崩溃

文件：`scripts/model-review/opencode-review.mjs:1440`（配合 `:1528-1532`、`:1470-1472`）

问题：`--report` 只要看到 `problems` 是数组就逐项调用 `printable`，但 `parseUsage` 的 override 校验只检查 `head` 和 `quote`，不检查 `problems` 是否为字符串数组。提交一条 `problems: [3]`（或 `[null]`）的覆盖记录能通过 `parseUsage`，随后 `printable(3)` 里的 `[...text]` 抛 `TypeError`，`--report` 以 2 退出，而不是打印 `problems=invalid` 或报 `USAGE_LEDGER_INVALID`。这是第 3 轮“不是数组时打印 invalid”的修复没覆盖到的反向用例。

证据：

```js
// :1440
`REVIEW_OVERRIDE_RECORD head=${record.head} quote=${printable(record.quote)} problems=${Array.isArray(record.problems) ? record.problems.map(printable).join(",") || "none" : "invalid"}`,

// :1528-1532
const overrideValid =
  record?.mode !== "override" ||
  (COMMIT_PATTERN.test(record.head ?? "") &&
    typeof record.quote === "string" &&
    record.quote.trim() !== "");

// :1470-1472
export function printable(text) {
  return hasControlCharacter(text) ? JSON.stringify(text) : text;
}
```

`hasControlCharacter` 里是 `return [...text].some(...)`，数字/`null` 不可迭代。

建议：在 `parseUsage` 的 `overrideValid` 里要求 `record.problems === undefined || (Array.isArray(record.problems) && record.problems.every((p) => typeof p === "string"))`，或让 `printable` 对非字符串安全。补一条 `problems: [3]` 的反向测试。

### 2. 低：作者说法 1 与代码不一致——“每个模型都没有成员才失败”应为“任何一个”

文件：`scripts/model-review/opencode-review.mjs:2717-2727`、`:2739-2755`；`scripts/model-review/gateway.mjs:351-357`

问题：作者说“每个模型都没有成员才 `GATEWAY_PREFLIGHT_FAILED`”，代码是“任何一个要跑的模型没有成员就失败”。`addGroups` 对每个 model 调 `groupArgs`，`groupArgs` 在过滤后 `list.length === 0` 时抛 `GATEWAY_NO_MEMBERS`，外层 catch 包成 `GATEWAY_PREFLIGHT_FAILED`。

证据：

```js
// gateway.mjs:355-357
const list = (members ?? entry.members).filter(
  (member) => !dropProviders.includes(member.split("/")[0]),
);
if (list.length === 0) throw new Error(`GATEWAY_NO_MEMBERS ${model}`);
```

```js
// opencode-review.mjs:2717-2727
const addGroups = () => {
  for (;;) {
    try {
      live.addGroups(drop);
      return;
    } catch (error) {
      const member = error.message.match(/knows no model "([^"]+)"/)?.[1];
      if (!member || drop.includes(member.split("/")[0])) throw error;
      dropProviders([member]);
    }
  }
};
```

代码与 proposal/文档的“任何一个要跑的模型”一致，不需要改代码；需要改的是作者的说法。

### 3. 低：同轮重跑会覆盖/误留 `<model>.magpie-usage.jsonl` 诊断

文件：`scripts/model-review/opencode-review.mjs:1617-1618`、`:2898`、`:2952-2955`

问题：新增的诊断文件不在 `RAW_FILE_SUFFIXES` 里。同一轮重跑时 `keepEarlierAttempt(roundRawDir, name, RAW_FILE_SUFFIXES)` 不会把它改名成 `.attempt-N...`。如果新一次也 `costUnknownWhy`，`tryWrite` 直接覆盖，旧（例如被叫停那次）的 Magpie 用量记录丢失；如果新一次费用已知，旧文件还留在原位，容易被误认为本次记录。

证据：

```js
// :1617-1618
export const KEPT_FILE_SUFFIXES = [".prompt.md", ".md", ".stderr.txt"];
export const RAW_FILE_SUFFIXES = [".jsonl", ".thinking.md"];

// :2898
keepEarlierAttempt(roundRawDir, name, RAW_FILE_SUFFIXES);

// :2952-2955
tryWrite(
  join(roundRawDir, `${name}.magpie-usage.jsonl`),
  (gatewayUsage ?? []).map((line) => `${JSON.stringify(line)}\n`).join(""),
);
```

建议：把 `.magpie-usage.jsonl` 加入 raw 后缀列表，或按 attempt 编号命名；补一条同轮重跑保留旧诊断的测试。

### 4. 低：`SIGTERM` 也被记成 Andy 叫停

文件：`scripts/model-review/opencode-review.mjs:503-517`、`:2843-2844`

问题：`SIGTERM` 和 `SIGINT` 都调用 `ask(OWNER_STOPPED)`，因此容器/系统发来的 `SIGTERM` 也会被记成 Andy 叫停。`--report --stop three-rounds` 会把这种轮次排除（`:1407-1411`），可能少算一轮失败。文档只描述线程发 `kill -INT`。

证据：

```js
// :503-517
const handle = (signal) => {
  received += 1;
  const code = signal === "SIGINT" ? 130 : 143;
  ...
  ask(OWNER_STOPPED);
  ...
};
```

```js
// :2843-2844
process.on("SIGINT", onSignal);
process.on("SIGTERM", onSignal);
```

建议：`SIGINT` 用 `OWNER_STOPPED`，`SIGTERM` 用单独原因（或至少文档说明 SIGTERM 也算叫停）；补一条 SIGTERM 的测试。

### 5. 低：关键停止路径缺少端到端测试

文件：`test/tooling/opencode-review.test.mjs:1823-1925`、`:2093-2115`；代码 `scripts/model-review/opencode-review.mjs:949-970`

问题：`signalHandler`、`waitUnlessStopped`、`reviewModel` 都有单元测试，但没有端到端验证 `main` 收到 SIGINT 后 `runOne` 真的写出一行 `outcome: "owner-stopped"` 并退出 130；`reviewOnce` 里 `stopRequested` 时 `wrapUpSkipped = OWNER_STOPPED` 的分支（`:949-970`）没有测试。作者说“反向验证 7 处”，但这两条关键路径没有覆盖。

证据：

```js
// :949-961
const skipped = !wrapUp
  ? null
  : stopRequested
    ? OWNER_STOPPED
    : !session
      ? "no-session"
      ...
```

测试只直接调用 `requestStop`/`signalHandler`/`waitUnlessStopped`，没有对 `main` 发信号。

建议：加一个用假 opencode 子进程的集成测试，向脚本进程发 SIGINT，断言账本有 `owner-stopped`、退出码 130、无残留进程；再加一个 wrap-up 条件已满足但被叫停的用例。

### 6. 低：文档“认不出是哪个模型的行两个模型都算”比代码宽

文件：`scripts/model-review/gateway.mjs:440-447` 与 `.agents/instructions/model-review.md:141`

问题：文档说“认不出是哪个模型的行两个模型都算”，但代码只把“不是 JSON 对象/数组”的行计入 `unattributed`；JSON 对象但 `req` 不是已知 `group/...` 的行被 `continue` 静默跳过，不算给任何模型。影响被 `recorded < requested` 的 `costUnknown` 兜底，但文档比代码宽。

证据：

```js
if (!line || typeof line !== "object" || Array.isArray(line)) {
  unattributed += 1;
  continue;
}
const requested = typeof line.req === "string" ? line.req : "";
if (!requested.startsWith("group/")) continue;
const model = Object.keys(config.models).find((name) => groupName(name) === requested.slice(6));
if (!model) continue;
```

建议：要么把这类行计入 `unattributed`（注意别把标题请求算进去），要么把文档改成“不是 JSON 对象的行两个模型都算”。

### 7. 低（既有问题，非本次引入）：`REVIEW_OVERRIDE quote=` 仍原样输出

文件：`scripts/model-review/opencode-review.mjs:1359`

问题：`assertReviewed` 打印已提交覆盖记录时用 `REVIEW_OVERRIDE quote=${recorded.quote}` 原样输出；`parseUsage` 只拒绝 `\r\n`，不拒绝 ESC 等控制字符，手工写入的账本可以注入终端转义。新的 `REVIEW_OVERRIDE_RECORD` 已用 `printable`，但这一行没有。

证据：

```js
if (recorded) lines.push(`REVIEW_OVERRIDE quote=${recorded.quote} recorded=${recorded.head}`);
```

建议：这一行也用 `printable(recorded.quote)`，或在 `parseUsage` 里拒绝控制字符。

---

## 推测/未核实

- **`scripts/model-review/opencode-review.mjs:2743-2749`（推测）**：去掉一家后 `live.stop()`，立即用同一个端口 `addGroups()` + `serve()`。如果旧进程还没释放端口，或 Magpie 的 `group add` 不是幂等（对已存在的组报错），这一步会把“去掉一家”变成 `GATEWAY_PREFLIGHT_FAILED`。现有测试的缺失成员是第一个成员，`addGroups` 在添加任何组之前就失败，所以没覆盖“部分组已添加后重试”的情况。未运行 Magpie，无法证实。建议：重启到新端口/新 root，或捕获“组已存在”并继续。
- **proposal.md 未核实**：见概览，读取被沙箱拒绝。
- **“两组测试 194 条通过 / npm run check 通过”未核实**：不能运行命令。
- **Magpie `group add` 的实际幂等性和端口释放行为未核实**：只能读代码，不能跑真实 Magpie。

---

## 侧重检查

- **叫停路径**：查了 `requestStop`/`activeStops`/`signalHandler`/`waitUnlessStopped`/`runOpencode` 的 `stop`/`finish`/`cleanup`。正常叫停会 SIGTERM→10 秒后 SIGKILL，`finish` 读标记并保留 `owner-stopped`；`cleanup` 会 `stopAllGateways()` 并杀掉所有 `activeChildren`，未发现正常路径的进程泄漏。费用方面 `reviewModel` 等待重试时叫停保留第一次运行结果和 cost，`reviewOnce` 叫停不追问，`spentOf` 对 `costUnknown`/`inFlight` 用 `max(cost+0.05, 0.2)` 宁可多记。第二次信号/30 秒宽限会强制退出，可能来不及写账本，这是文档写明的取舍。
- **覆盖记录**：确认写入后 `overridden` 仍为 false，`main` 退出 5；提交后才通过 `recorded` 放行；`ledgerMatchesHead` 用空串比较，HEAD 和磁盘都没有账本时才新建；`main-not-merged`/`main-ref-missing` 仍拒绝。未发现账本未提交就放行的路径。已提交记录本身被信任（包括手写伪造）是文档写明的取舍。
- **`--providers`**：确认未列出的服务方进入 `unrequested`/`drop`，`withCredit` 不配置它们，`groupArgs` 按 `drop` 过滤成员；只有列表包含 CodeBuddy 时才 `accountUid`/`quota`，`usesCreditProvider` 控制积分底线。没有发现绕过积分底线或悄悄使用未列出服务方的路径。未知 id、控制字符、与 `--self-check-only` 同用都有校验。
- **不可信输入/安全**：`--providers` 的 id 在 `main` 对 `gateway.json` 校验；`gatewayDropped` 在 `parseUsage` 校验为非空字符串数组；覆盖记录的 `quote` 在写入前由 `parseArgs` 拒绝控制字符。发现的缺口是覆盖记录 `problems` 的元素类型（#1）和既有的 `REVIEW_OVERRIDE quote=` 原样输出（#7）。
- **文档一致性**：`model-review.md` 的“Andy 怎样控制复核”、第 6 步例外、`AGENTS.md`、`owner-standing-rules.md`、ADR 0178 后续与代码基本一致。发现的偏差是作者说法 1（#2）和“认不出模型的行”措辞（#6）。

---

## 必答问题

### 1. 这个改动会不会改变模型已经见过的请求开头？

不会。`buildPrompt` 未改（`opencode-review.mjs:277-305`），必问问题仍只从 checklist 抽取（`:220-230`）；新增的“Andy 怎样控制复核”一节在 checklist 之后，且有 `<a id="owner-control"></a>` 和 `## ` 分隔，测试也确认它不会变成第 5 个问题（`test/tooling/opencode-review.test.mjs` 的 `[owner control]` 用例）。叫停和 `--providers` 只影响进程控制、Magpie 配置和账本，不影响 prompt；账本目录 `.agents/reviews` 在复核副本里被 sparse-checkout 排除（`:2349`），所以新增的 `at` 时间戳也不在模型可见内容里。每轮变化的值（`head`/`base`/`previous`/`brief`）仍在 `buildPrompt` 末尾的“本次材料”里追加。

唯一既有例外是 CodeBuddy 11128 重写系统提示（ADR 0178）；本次没有扩大它，但 `--providers` 若选了 CodeBuddy 仍可能触发这个已知例外。

### 2. 会不会让同一段文字在不同请求里变成不同的字节？

本次新增的值都不进 prompt。`drop` 按 `gateway.json` 顺序返回（`:2757`），`gatewayDropped` 是数组；`costUnknownWhy` 和 `at` 时间戳只进账本/日志，且账本不在模型副本里。没有发现新的“依赖前后文遮盖/时间字段/无序集合”导致 prompt 字节变化。不同服务方可能有既有的系统提示改写（CodeBuddy 例外），这不是本次新增。

### 3. 改动有没有对应的自动检查，反向用例是否真的会失败？

有，且反向用例大多确实会失败：`ARG_INVALID --providers`、`ARG_PROVIDERS_NEED_GATEWAY`、`ARG_PROVIDERS_NOT_FOR_SELF_CHECK`、`USAGE_LEDGER_INVALID`（坏 `gatewayDropped`）、`REVIEW_OVERRIDE_REFUSED not-review-problems main-not-merged`、`REPORT_STOP_INCONSISTENT three-rounds` 等。缺口是：没有端到端 SIGINT→`owner-stopped` 账本→退出 130 的测试；没有 `wrapUpSkipped: owner-stopped` 分支的测试；没有 `problems: [3]` 的反向测试（所以 #1 的崩溃不会被现有测试发现）；没有覆盖 restart/port/idempotency 的测试（推测）。

### 4. 改动产生或修改的每个值，两端都能接受吗？

逐项核对：

- `outcome: "owner-stopped"`：`parseUsage` 接受非空字符串；`coveragePoints` 只收 `ok`；`reviewReport` 的 `three-rounds` 过滤它；`GUARD_DEFERS_TO_PARENT` 包含它。两端一致。
- `retry: "owner-stopped"`：`parseUsage` 不校验 `retry`，也没有消费者假定固定集合（`substituteFor` 只认 `"retried"`）。可以接受，但校验偏松。
- `gatewayDropped`：生产者是 `config.providers`/`only` 的 id，`parseUsage` 校验为非空字符串数组，`gatewayUsageLine` 打印。两端一致。
- `costUnknownWhy`：生产者是固定串和数字，消费者只有 `runOne` 打印；`parseUsage` 只查换行。可以接受。
- `--providers` 的 id：`parseArgs` 去重/拒绝空和控制字符；`main` 对 `gatewayConfig.providers` 校验；`startLiveGateway` 用 `only` 过滤。两端一致。
- `models.providers-differ`：`gatewayConfigProblems` 产生，`readGatewayConfig` 作为 `GATEWAY_CONFIG_INVALID` 的一部分抛出。两端一致。
- 覆盖记录的 `problems`：生产者是字符串数组，`reviewReport` 期望字符串数组，但 `parseUsage` 不校验元素类型，遇到 number/`null` 会崩（#1）。这是两端不一致。
- `.magpie-usage.jsonl`：生产者 `tryWrite`，消费者是人和调试脚本；同轮重跑保留策略不一致（#3）。
- `REVIEW_PID`/`REVIEW_STOPPED`/`REVIEW_STOPPING`/`GATEWAY_PROVIDER_DROPPED`/`GATEWAY_COST_UNKNOWN`/`REVIEW_DIAGNOSTIC_NOT_SAVED`：都是日志行，没有结构化消费者；`REVIEW_PID` 的文档说法与代码一致（第一行 stdout）。
