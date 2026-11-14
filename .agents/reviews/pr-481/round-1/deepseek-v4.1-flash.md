未运行测试（本环境只允许 git 读命令），以下均为静态核对。

## 结论

没有发现会改变模型请求开头、或破坏账本读取/`--assert-reviewed`/`--report` 的问题。主要风险集中在新增的诊断值：`gatewayTiming` 会把失败请求当成缓存未命中并清掉基线；标题请求的识别依赖仓库里没有留证的 `effort=low` 字段；计价改动的外部前提也没有自动检查。

## 问题（读代码证实）

### 1. 中：失败请求会被算成“缓存未命中”，并清掉同一会话的基线

- 文件:行：`scripts/model-review/gateway.mjs:544-559`
- 问题：`own` 只按 `req` 和 `effort` 过滤，没有排除非 2xx 行。失败请求通常没有 token 字段，`number(line.cache_read)` 变成 0；只要前一次成功请求的上下文大于 0，`0 < before / 2` 就成立，`cacheMisses` 加一。随后 `previousContext.set(line.session, 0)` 又把基线清掉，导致下一次成功请求因为 `before === 0` 完全不被检查。
- 证据：

```js
const own = (lines ?? []).filter(
  (line) => line && typeof line === "object" && line.req === group && line.effort !== "low",
);
...
const context = number(line.in) + number(line.cache_read);
const before = previousContext.get(line.session) ?? 0;
if (before > 0 && number(line.cache_read) < before / 2) {
  cacheMisses += 1;
  missTokens += number(line.in);
}
previousContext.set(line.session, context);
```

同文件的用量汇总明确区分了失败行（`gateway.mjs:508-510`），测试里也构造过 `status: 502`/`404` 的行，说明失败行是正常可能出现的。只要 Magpie 给失败行也带 `session`（这正是该功能的前提），就会稳定误报。
- 建议：缓存基线只使用 `line.status >= 200 && line.status < 300` 的行；失败行可以继续计入 `requests`/`modelMs`（如果希望反映重试耗时），但不要参与 `cacheMisses`/`missTokens`。补一条“200 → 502 → 200”的用例，期望 `cacheMisses` 只由中间的真实 502 之外的逻辑决定。

### 2. 中低：`session` 缺失或不是字符串时，所有请求会被合并成同一个会话

- 文件:行：`scripts/model-review/gateway.mjs:551-559`
- 问题：`previousContext` 直接用 `line.session` 做 Map 键。若 Magpie 的用量行没有 `session`，所有行的键都是 `undefined`，不同会话（重试、起标题、换服务方）会被串在一起比较；若字段名实际不是 `session`，同样退化。代码没有校验这个字段存在或是字符串。
- 证据：

```js
const before = previousContext.get(line.session) ?? 0;
...
previousContext.set(line.session, context);
```

新增测试只给 DeepSeek 模型用了一个会话 `"s"`，另一个会话 `"g"` 属于不同 `req`，被前面的过滤排除了，并没有验证“同一模型的两个 session 不会互相比较”（`test/tooling/review-gateway.test.mjs:1296-1305`）。
- 建议：只接受字符串 `session`，缺失时跳过缓存判断（不要退化成全局键）；增加“同一模型、两个 session 交替出现”的用例。

### 3. 低：`readGatewayRests` 把所有读取/解析错误都吞成空列表

- 文件:行：`scripts/model-review/gateway.mjs:572-585`
- 问题：`catch { return []; }` 让“文件不存在”“文件写到一半不是合法 JSON”“权限错误”“字段结构不对”全部表现成“没有服务方在休息”。这正是新功能要解释换服务方原因的时候，信息反而会静默消失。
- 证据：

```js
export function readGatewayRests(root) {
  try {
    const rests = JSON.parse(readFileSync(join(root, "config", "magpie", "rests.json"), "utf8"));
    return Object.entries(rests ?? {})
      ...
  } catch {
    return [];
  }
}
```

测试只覆盖“文件不存在”和一个对象映射的正常样例（`test/tooling/review-gateway.test.mjs:1338-1347`），没有 malformed JSON、数组根节点、字段缺失或控制字符的用例。
- 建议：区分文件不存在（正常无输出）和读取/解析失败（打印 `GATEWAY_REST_UNREADABLE <原因>` 或类似诊断）；补 malformed JSON 的反向用例。若确认 Magpie 的 `rests.json` 是数组而不是对象映射，当前 `Object.entries` 会输出下标而不是服务方名，需要用真实样例锁住 schema。

### 4. 低：`GATEWAY_REST` 只清理空白字符，没有清理其他控制字符

- 文件:行：`scripts/model-review/gateway.mjs:577-581`
- 问题：`String(part).replace(/\s+/g, "_")` 能处理换行、制表符，但处理不了 ESC（`\u001b`）等其他控制字符。`why` 来自 Magpie 记录的错误原因，若夹带终端控制序列，会污染终端/CI 日志。来源是本机 Magpie 临时文件，风险低，但不是零。
- 证据：

```js
[provider, rest.why ?? "unknown", rest.status ?? "-", rest.until ?? "-"]
  .map((part) => String(part).replace(/\s+/g, "_"))
```

- 建议：复用现有的 `printable`/控制字符清理逻辑，或至少去掉 `\p{Cc}`；同时限制 `why` 的最大长度。

### 5. 低：委托复核的最终汇报没有带上新增的 `REVIEW_TIMING` / `GATEWAY_REST`

- 文件:行：`scripts/model-review/delegate.mjs:165`
- 问题：委托提示只要求转述 `REVIEW_RESULT`、`GATEWAY_USAGE`、`REVIEW_SPENT_TOTAL`。新增的两类诊断只出现在脚本控制台和账本里，Mac 侧通过委托线程拿到的最终回复不会包含它们，新功能的可见性在默认的“Mac 交给云端”流程里会打折。
- 证据：

```js
在你自己的最后回复里写：推送后的分支头提交、每个模型的 REVIEW_RESULT 行、GATEWAY_USAGE 行、REVIEW_SPENT_TOTAL 行。
```

- 建议：把 `REVIEW_TIMING`（以及有服务方休息时的 `GATEWAY_REST`）加入委托汇报要求，或明确说明这些只从云端日志读取。

## 推测 / 未核实

### A. 中（未核实）：标题请求的识别完全依赖 `effort === "low"`

- 文件:行：`scripts/model-review/gateway.mjs:544-546`；测试 `test/tooling/review-gateway.test.mjs:1297`
- 问题：代码假定起标题请求在 Magpie 用量行里一定有 `effort: "low"`，且与主请求同属 `group/review-*`。仓库里没有任何真实的 Magpie `usage.jsonl` 样例，测试只是自己造了 `effort: "low"` 的一行。如果实际标题行的 `effort` 缺失、是别的值，标题行会被当成普通请求。此时主会话第一条请求的 `cache_read` 通常是 0，而标题上下文可能已经大于 0，于是第一条主请求会被误记成一次缓存未命中。
- 证据：

```js
(line) => line && typeof line === "object" && line.req === group && line.effort !== "low",
```

```js
at({ session: "s", effort: "low", in: 1400, cache_read: 0, ms: 3000, ttft_ms: 2000 }),
```

- 建议：用一条真实 Magpie 用量行做 fixture，确认标题请求的可区分字段；不要只靠 `effort` 字符串。若只能靠 `effort`，至少补一个“标题行缺 effort”的用例来固定预期行为（跳过还是计入）。

### B. 中（未核实）：计价改动的外部前提没有自动验证

- 文件:行：`scripts/model-review/gateway.mjs:520-524`；测试 `test/tooling/review-gateway.test.mjs:1277-1292`
- 问题：新测试验证的是“代码按 `in/out/cache_read` 三项算”，不是“Magpie 的 `out` 确实包含 reasoning”。仓库里没有真实 Magpie 用量样本，无法核实作者说的“28 次请求核对”。该公式应用在所有按美元计价的服务方（`opendesign`、`opencode-go`），只要其中任何一家的 `out` 实际不含 reasoning，账本就会从“多算”变成“少算”；而 `withProviderMoney` 只会取较大值，不会修正少算。
- 证据：

```js
const usd =
  (required(line.in) * price.input +
    required(line.out) * price.output +
    tokens(line.cache_read) * price.cache_read) /
  1e6;
```

现有自检只检查 OpenCode 侧费用大于 0（`opencode-review.mjs:2535-2536`），没有把 Magpie 折算出的 USD 与 OpenCode 的费用对比。
- 建议：在自检的假上游里返回带 reasoning token 的用量，同时断言 Magpie 折算 USD 与 OpenCode 计算的费用一致；或提交一条真实 Magpie 用量 fixture。这样 Magpie 升级改变 `out` 语义时测试会失败。

### C. 低（未核实）：`rests.json` 的真实 schema

- 文件:行：`scripts/model-review/gateway.mjs:572-581`
- 问题：代码假定文件根是对象映射，字段是 `why`/`status`/`until`。Magpie 实际可能使用别的字段名或数组结构；若如此，功能会静默失效而不是报错。测试只验证了作者自己设定的 schema。
- 建议：用真实 Magpie 生成的 `rests.json` 做 fixture；根不是对象时显式报错而不是静默返回。

## 侧重检查

- **错误路径**：`readGatewayRests` 吞掉所有错误（问题 3）；`gatewayTiming` 对缺失/非法 `ms`、`ttft_ms`、`in`、`cache_read` 静默按 0 处理，可能低估耗时；失败请求行未特殊处理（问题 1）。
- **不合规范或不可信输入**：`usage.jsonl` 非对象行在 `summarizeGatewayUsage` 有处理，`gatewayTiming` 也会过滤；但 `session`/`effort` 的类型没有校验，`rests.json` 根类型也没有校验。
- **安全**：新增内容不包含密钥，账本字段是数字；`GATEWAY_REST` 打印的 `why` 来自本机 Magpie 文件，除空白外未清理其他控制字符（问题 4）。
- **资源耗尽**：`readGatewayUsage`/`readGatewayRests` 都一次性读整个文件，`gatewayTiming` 用 `Math.max(...own.map(...))` 展开数组；正常复核请求数很小，未发现现实可达的耗尽路径，属于既有模式。
- **不可撤销操作**：本改动只读临时用量文件、追加账本、打印日志；没有删除或覆盖用户文件的操作。
- **规则/文档与代码一致**：`.agents/instructions/model-review.md:193` 的公式、`REVIEW_TIMING`、`GATEWAY_REST` 格式与代码一致；`runMs` 从 `reviewModel` 调用前开始计时，和“这个模型从启动到结束”基本一致；不一致的是委托提示没有转述新增诊断（问题 5），以及计价前提无法从仓库核实（推测 B）。

## 必答问题

1. **会不会改变模型已经见过的请求开头？** 不会。这个 diff 没有改 `buildPrompt`、`reviewConfig`、工具定义、历史组装或遮盖逻辑；`selfCheckMs`、`runMs`、`gatewayTiming`、`GATEWAY_REST` 都是复核结束后写入账本或打印到控制台，不进入发给模型的内容。复核请求仍然是固定内容在前、只在末尾追加本轮材料；每轮会变的计时/休息信息没有进入请求。依据 [prompt-prefix.md:27-28、35](.claude/rules/prompt-prefix.md)。

2. **会不会让同一段文字在不同请求里变成不同的字节？** 对模型可见的内容不会。新增的计时和休息信息本身随运行变化，但只写入 `usage.jsonl` 和控制台，账本是追加写的，不会被当作请求内容；`readGatewayRests` 还做了排序，输出稳定。没有新增依赖前后文的遮盖、时间字段进入提示词或无序集合进入请求。若指账本字节，计时字段当然每次不同，但这不影响请求摘要或缓存。

3. **有没有对应的自动检查，反向用例真的会失败？** 有，但不完整。计价反向用例有效：把代码改回 `(out + reasoning)` 时，`toBeCloseTo(expected)` 会失败，`not.toBeCloseTo(doubled)` 也会失败。计时用例能抓住 `effort` 过滤被删除（`requests` 从 4 变 5）和求和错误。缺口是：没有失败请求（502/429）夹在成功请求之间的用例；没有同一模型两个 session 的用例；没有真实 Magpie 标题行的 fixture；没有 malformed `rests.json` 的用例；计价部分没有和真实 Magpie 用量/OpenCode 费用交叉验证（推测 B）。

4. **每个新值的使用方都能接受吗？**
   - `usd`/`costFromProviders`：产生于 `gateway.mjs:520-526`，经 `gatewayRecordFields`（`opencode-review.mjs:2971`）、`providersValid`（`:1718-1732`）、`withProviderMoney`（`:2995-2998`）、`providerMoneyUsd`（`:2989-2992`）、`creditsPerUsd`（`gateway.mjs:453-463`）、`spentOf`（`:1126-1134`）和 `--report` 使用。两端都只要求有限非负数，新值更小仍合法；但若计价前提错误，会少记账本费用。
   - `selfCheckMs`/`runMs`：产生于 `opencode-review.mjs:3308`、`:3357`，写入账本 `:3383-3384`，由 `timingLine` 读取 `:3011-3012`；`parseUsage` 不校验未知字段，`delegate.mjs` 的 `hasControlText` 接受数字，`--report` 忽略，均能接受。
   - `gatewayTiming`：产生于 `gateway.mjs:542-570`，写入 `opencode-review.mjs:3385`，由 `timingLine` 读取；数值都是有限非负数，账本/合并检查能接受。
   - `GATEWAY_REST`：产生于 `gateway.mjs:572-586`，经 `startGateway` 的 `rests`（`:841`）到 `opencode-review.mjs:3451` 打印；没有其他消费方，`--assert-reviewed`/`--report` 不读取它。唯一不一致是委托汇报没有转述（问题 5）。
   - 没有新增配置键、清单项或序列化格式；`gateway.json`、`review-models.json` 都没改。账本读取和合并前检查未发现被新字段破坏。
