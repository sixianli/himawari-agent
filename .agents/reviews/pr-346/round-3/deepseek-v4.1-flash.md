# 复核结论

改动只让 Pi 在冻结工具下真正把压缩摘要请求发出去，并补上摘要请求的用量用途与压缩失败日志。正常对话请求路径没有变，用量 purpose 的新值 `other` 两端校验都通过。主要问题集中在：摘要请求在出口遮盖/敏感拦截一侧仍被标成 `chat`、摘要请求识别只靠全局布尔和形状、以及几处测试缺口。未发现会破坏正常对话前缀的高严重度问题。

---

## 一、读代码证实的问题

### 1. 中｜`packages/runtime-pi/src/pi-runtime-adapter.ts:1049-1055`（对照 `:955`、`:1105`、`:1649`）
**问题：** 摘要请求的用量记为 `other`，但同一个请求的出口遮盖/敏感拦截上下文仍写死为 `source: "chat"`、`purpose: "chat"`。作者说明只提“用量 purpose 改为 other”，没有处理这条路径。
**证据（亲自读到）：**
```ts
// :1049-1055
const exchange = egress.exchange({
  ownerId: request.ownerId,
  agentId: request.agentId,
  threadId: request.threadId,
  source: "chat",
  purpose: "chat",
  ...
});
```
```ts
// :1105
purpose: usagePurpose,
```
```ts
// :1649
summaryContext ? "other" : "chat",
```
**影响：** 同一个摘要请求在两张记录里用途不一致。生产 `productionSensitiveInterceptionRecorder` 会用 `context.source/purpose` 记录拦截；摘要请求把整段对话序列化成一条 user 消息，命中时会被记成 `source=chat`、`part=owner_message`，按对话用途统计和审计会把它当成主人正在说的话。现在没有消费者因 `purpose` 不同而报错，所以不是阻断问题，但“两端值必须一致”这条不满足。
**建议：** 把 `usagePurpose`（或专门的 `source/purpose`）传进 `egress.exchange`；`SENSITIVE_INTERCEPTION_SOURCES` 里没有压缩类来源，可新增或在文档里明确摘要仍按 `chat` 记录，二选一不能沉默。

---

### 2. 低~中｜`packages/runtime-pi/src/pi-runtime-adapter.ts:669-677`、`:1620-1624`、`:1665-1667`
**问题：** 摘要请求只靠“当前没有工具 + 第一条是 system 字符串”识别，而 `compacting` 是订阅事件维护的全局布尔值，没有和某一次请求绑定。`compaction_start` 没有配对的 `compaction_end` 时，后续普通请求会被误判为摘要请求。
**证据（亲自读到）：**
```ts
// :669-677
function himawariSummaryContext(requested: TranscriptContext): Context | undefined {
  if (getCurrentTools(requested.messages).length > 0) return undefined;
  const [first, ...rest] = requested.messages;
  if (first?.role !== "system" || typeof first.content !== "string") return undefined;
  return { systemPrompt: first.content, tools: [], messages: rest.filter(...) };
}
```
```ts
// :1622-1624
const summaryContext = compacting ? himawariSummaryContext(requested) : undefined;
const context = summaryContext ?? himawariRequestContext(...);
```
```ts
// :1665-1667
if (event.type === "compaction_start") compacting = true;
if (event.type === "compaction_end") { compacting = false; ... }
```
**影响：** 对带工具的普通请求，`himawariSummaryContext` 返回 `undefined`，会回落到冻结工具路径，问题不大；但对本来就没有工具的普通对话请求，会被当成摘要请求：用量记成 `other`、`systemPrompt` 改用请求里的第一条 system 消息、跳过 `PI_REQUEST_TOOLS_DIVERGED` 的冻结工具核对。因为本来就没有工具，实际泄露面很小，主要是统计和拦截语义错误。作者已承认“回落路径无专门测试（防御性代码，无配对的 compaction_start 属推测）”。
**建议：** 用 one-shot 标记代替持续布尔：`compaction_start` 时置“下一次请求是摘要”，`streamFunction` 消费后立即清除；`compaction_end`/`agent_end` 再兜底清除。或者校验 `first.content` 确实是 Pi 的摘要系统提示（测试里已用 `context summarization assistant` 断言），不要只认形状。

---

### 3. 低｜`packages/runtime-pi/src/pi-runtime-adapter.ts:436-445`、`:1668-1672`
**问题：** 压缩失败走 `loggableModelFailure` 后，本地产生的失败码不会原样保留，只有三条消息在白名单里；其它本地失败会被写成 `provider_message_withheld`。摘要失败还可能同时以 `message_end` 失败和 `compaction_end` 失败上报两次。
**证据（亲自读到）：**
```ts
// :436-445
function loggableModelFailure(errorMessage: string | undefined): string {
  const message = errorMessage ?? "";
  if (
    message.startsWith("Model invocation ") ||
    message === "Model budget accounting is unavailable" ||
    message === PI_REQUEST_TOOLS_DIVERGED
  )
    return message;
  const status = /^(\d{3})(?:\s|:)/.exec(message)?.[1];
  return status === undefined ? "provider_message_withheld" : `provider_status_${status}`;
}
```
```ts
// :1668-1672
if (event.result === undefined && !event.aborted && event.errorMessage)
  this.#dependencies.onModelStreamFailed?.(request, {
    code: "PI_COMPACTION_FAILED",
    message: loggableModelFailure(event.errorMessage),
  });
```
**影响：** 例如摘要请求被本地的 `PI_CONTEXT_WINDOW_EXHAUSTED` 拒绝时，`PI_COMPACTION_FAILED` 的 message 会变成 `provider_message_withheld`，看日志的人会误以为是供应商原文被隐藏，而不是本地窗口不足。若同一次失败同时产生 `message_end` 错误和 `compaction_end` 错误，会写两条 `model.stream_failed`。日志本身不泄密，只是可诊断性下降。作者把重复上报列为“推测，Pi 对摘要请求是否发 message_end 未核实”。
**建议：** 把本地 `failedPiStream` 的固定消息也加入白名单（或单独传 `code` 字段）；同一 attempt 只上报一次。

---

### 4. 低｜`packages/runtime-pi/test/prompt-prefix.compat.test.ts:841-909`
**问题：** 新增两条 `[COMPACT-1]` 用例只覆盖了“摘要请求能发出”和“失败有日志”，没有覆盖这次改动真正带来的主对话变化，也没有覆盖回落到普通路径。
**证据（亲自读到）：**
```ts
// :869-882
expect(purposes.filter((purpose) => purpose === "other").length).toBeGreaterThan(0);
expect(purposes.filter((purpose) => purpose === "chat").length).toBeGreaterThan(0);
const summaries = bodies.filter((body) => body.includes("<conversation>"));
...
expect(turnEvents.flat().some((event) => event.type === "runtime.compaction_proposed")).toBe(true);
```
```ts
// :906-908
const failure = failures.find((item) => item.code === "PI_COMPACTION_FAILED");
expect(failure).toBeDefined();
expect(failure?.message).toMatch(/^provider_(status_\d{3}|message_withheld)$/);
```
**影响：** 没有断言第三轮请求仍带冻结工具、压缩后主对话不再被改写、`(compaction_start 无配对)` 时普通请求仍走 `chat` 且带冻结工具，也没有断言摘要请求的出口/拦截 purpose（见问题 1）。作者把“压缩后主对话前缀检查”归到第 2 步，但这正是本次让压缩在冻结工具下第一次真正发生的行为，至少应确认下一轮仍按冻结工具发出。
**建议：** 在成功用例里加：第三轮请求的 `tools` 等于冻结工具、之后请求仍逐字节以前一请求为前缀（跳过压缩那一次）、摘要请求的 egress 记录不是 `chat`（若采纳问题 1 的修法）。补一条 `compaction_start` 后直接来普通请求的回落用例。

---

## 二、推测 / 未核实

### 5. 中（未核实）｜`packages/runtime-pi/src/pi-runtime-adapter.ts:974-980`
**推测：** 摘要请求仍走普通的上下文窗口检查。Pi 因上下文真正溢出而压缩时，摘要请求会把整段对话重新塞进一次请求；若输入已接近/超过 `contextWindow`，留给输出的空间可能小于 512，`clampMaxTokensToContext` 会直接返回 `PI_CONTEXT_WINDOW_EXHAUSTED`，摘要请求仍发不出去，压缩继续失败。
**证据（亲自读到）：**
```ts
const transcript = normalizeContext(withPlaceholderLegend(context));
if (
  clampMaxTokensToContext(model, transcript, desiredMaxTokens) <
  Math.min(desiredMaxTokens, MIN_CONTEXT_ANSWER_TOKENS)
)
  return failedPiStream(model, PI_CONTEXT_WINDOW_EXHAUSTED);
```
我读不到 `clampMaxTokensToContext` 的实现（依赖不在仓库），所以这条是推断，未核实。
**建议：** 用 `PROMPT_TOKENS >= contextWindow` 的场景补一条测试；若确认会被拦，摘要请求应跳过这个输出 token 下限检查，或使用专门的摘要准入检查。

---

## 三、侧重检查

- **错误路径：** 摘要失败会经 `onModelStreamFailed` 写 `PI_COMPACTION_FAILED`（日志侧）；但本地失败码会被 `loggableModelFailure` 吞掉（见问题 3），且可能重复上报（推测）。
- **不可信 / 不合规范输入：** 摘要请求的形状完全信任 Pi，未校验系统提示是否真是 Pi 的摘要提示（见问题 2）。好消息是发送时 `tools: []`，不会把冻结工具定义带出去；出口遮盖、分级 `this.#visibleOf(request)` 和 `bundle?.redactionRuleset` 仍然生效（`:1635-1649`）。
- **安全：** 摘要请求仍走 `egress.exchange` 与预算准入（`:1018-1055`、`:1120-1128`），没有绕过遮盖或准入；失败日志已改成只写状态码/固定文字，未发现供应商原文泄露。问题是敏感拦截记录的 `source/purpose` 仍为 `chat`，审计语义不准（见问题 1）。
- **资源耗尽：** 摘要请求会占用一次 `streamOrdinal` 和预算准入；压缩反复失败会重复消耗预算。生产写入 `model_usage_observations` 用 `INSERT OR IGNORE` 且 `purpose` 允许 `other`，不会因新值报错。
- **不可撤销操作：** 没有新增。压缩结果仍只经 `projection.proposeCompaction` 形成产品提案（`:2295` 起），不直接改产品状态。
- **规则/文档与代码一致性：** `docs/kv-cache-guide.md` 第 68 行仍写压缩请求“没做到沿用原对话开头”，ADR 0198 也把这个列为已知缺口；本次改动没有改变这个事实，规则第 12 条的压缩例外仍成立。新增的 `PI_COMPACTION_FAILED` 只进服务日志，没有需要同步的文档清单；本 PR 未改任何文档，作者把措辞留到 ADR 0201。未发现文档与代码矛盾。

---

## 四、必答问题

**1. 会不会改变模型已经见过的请求开头？**
正常对话请求不受影响：只有 `compacting` 为真时才走新分支（`:1622-1624`），其它情况仍用原来的 `himawariRequestContext`，系统提示/工具定义/历史仍然只在末尾追加，每轮会变的时间、记忆等仍在最后一条消息里（与现有 prompt-prefix 用例一致）。
但要说清两点：
- 摘要请求本身不是“在上一请求末尾追加”，而是一次全新的辅助请求：系统提示换成 Pi 的摘要提示、`tools: []`、消息是整段对话（`:669-677`）。它不改变主对话已发出的前缀。
- 压缩成功后，主对话下一请求会用摘要替换旧历史，这是规则第 12 条的压缩例外（ADR 0198 已把 `context_edit` 归入压缩）；本次改动正是让这条路径在冻结工具下第一次真正发生。规则第 13 条“压缩沿用原对话系统提示和工具”仍未满足，文档已记为已知差距，不是本次引入的新偏差。建议如问题 4 补上压缩后主对话仍按冻结工具、仍可继续追加的断言。

**2. 会不会让同一段文字在不同请求里变成不同的字节？**
本次没有往提示词里加时间、哈希、无序集合或依赖后续内容的遮盖。`himawariSummaryContext` 只是对 `requested.messages` 做确定性拆分；`usagePurpose`、`PI_COMPACTION_FAILED`、`compacting` 都不进提示词。出口遮盖仍是每次请求独立、确定性的。
需要留意的两点（不是本次造成的字节漂移）：摘要请求把整段对话作为一条消息遮，和主对话按消息逐条遮的结构不同，同一段文字在“摘要请求”和“主对话请求”里可能遮成不同字节，但两者是不同请求，不影响主对话缓存；Pi 的摘要系统提示不在 Himawari 的固定文字清单里，会被当外来内容扫描/遮盖，同一次请求内是确定的，但可能改写 Pi 自己的固定文字（未核实是否实际发生）。

**3. 有没有对应的自动检查，反向用例会失败吗？**
有两条 `[COMPACT-1]` 用例和新增的 `other` purpose 断言（`:841-909`）。按代码推断（未运行测试，工具限制）：
- 撤掉摘要放行：成功用例里不会有含 `<conversation>` 的请求，也不会有 `runtime.compaction_proposed` → 失败。
- 撤掉 `PI_COMPACTION_FAILED` 上报：失败用例找不到该 code → 失败。
- 把 `usagePurpose` 改回 `chat`：`other` 计数为 0 → 失败。
- 把 `loggableModelFailure` 改回原文：失败用例的 message 正则大概率不匹配 → 失败（依赖 Pi 原始 errorMessage 形态）。
缺口：回落路径（问题 2）、压缩后主对话前缀/冻结工具、出口/拦截 purpose、重复上报均无用例（问题 4）。

**4. 每个改动值，使用它的地方都能接受吗？**
- `purpose: "other"`：`packages/application/src/ports/model-usage.ts:3-12` 的 `MODEL_USAGE_PURPOSES` 包含 `other`；`packages/persistence-sqlite/src/sqlite-model-usage-operations.ts:20-23` 用同一清单校验；迁移 `0068_model_usage_observations.sql` 的 CHECK 也包含 `'other'`。`lowCacheHitRate` 只统计 `chat`（`model-usage.ts:49`），所以摘要不会混进缓存命中率。这一端通过。
- `PI_COMPACTION_FAILED`：只在 `pi-runtime-adapter.ts:1669-1672` 产生，唯一消费者是 `onModelStreamFailed`，生产 `apps/agent-service/src/service-main.ts:1884-1891` 只是写日志的 `code` 字段，没有允许清单校验。两端可接受。
- `usagePurpose` 参数：`admitPiStream` 只有一个调用点（`:1635-1650`），已按位置补上实参，默认值 `chat` 不改变旧行为。
- `summaryContext`：类型是 `Context`，直接交给 `admitPiStream`，经 `normalizeContext` 处理，测试已证明空 `tools` 可用。
- 不一致项：同一个摘要请求在用量里是 `other`，在 `egress.exchange` 里仍是 `chat`（问题 1）。这是本次应一并核对的两端。
