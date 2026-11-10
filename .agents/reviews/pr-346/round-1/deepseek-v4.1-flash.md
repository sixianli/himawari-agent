以下结论基于当前检出 `a9af0f75` 与基准 `bf2b7234` 的 diff，以及我亲自读到的源码。受工具限制，我没有运行测试，也无法读取 `node_modules` 里的 Pi 源码，涉及 Pi 内部事件保证的地方会标为“未核实”。

## 发现的问题（按严重度排序）

### 1. 【中】压缩失败的日志会写入上游原文，绕过现有的“日志只留本地原因/状态码”约定

- 文件: `packages/runtime-pi/src/pi-runtime-adapter.ts:1666`
- 问题: 新加的压缩失败上报直接把 `event.errorMessage` 原样写进 `onModelStreamFailed`。正常模型失败路径会先经过 `loggableModelFailure`，把上游原文替换成 `provider_message_withheld` 或 `provider_status_NNN`；这条新路径绕过了它。
- 证据（亲自读到）:

```ts
// pi-runtime-adapter.ts:1666
if (event.result === undefined && !event.aborted && event.errorMessage)
  this.#dependencies.onModelStreamFailed?.(request, {
    code: "PI_COMPACTION_FAILED",
    message: event.errorMessage,
  });
```

对比正常路径：

```ts
// pi-runtime-adapter.ts:2225
if (event.message.stopReason === "error") {
  const code = modelFailureCode(event.message.errorMessage);
  this.#dependencies.onModelStreamFailed?.(request, {
    code,
    message: loggableModelFailure(event.message.errorMessage),
  });
```

`loggableModelFailure` 的规则：

```ts
// pi-runtime-adapter.ts:436-445
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

而生产接线会原样写 message：

```ts
// apps/agent-service/src/service-main.ts:1884
onModelStreamFailed: (request, failure) =>
  writeServiceDiagnostic(errorOutput, {
    component: "agent-service",
    event: "model.stream_failed",
    runId: request.runId,
    code: failure.code,
    message: failure.message,
  }),
```

`writeServiceDiagnostic` 只做机器密钥形状的遮盖：

```ts
// packages/platform-node/src/service-runtime.ts:71
const serialized = JSON.stringify({ timestamp: new Date().toISOString(), ...diagnostic });
output.write(`${redactMachineSecrets(serialized)}\n`);
```

这与 `docs/incidents-and-gates.md` 的 I-44 约定不一致：I-44 明确写“模型流失败写 `model.stream_failed` 日志，只含固定的本地原因或状态码，不含供应商原文”。新路径可能把供应商错误正文、用户相关内容写进服务日志。
- 建议: 改成 `message: loggableModelFailure(event.errorMessage)`，并仿照 `pi-runtime-adapter.compat.test.ts:2149-2177` 加一条断言，确保压缩失败日志里不出现上游原文。

### 2. 【低-中】摘要请求被记为 `purpose: "chat"`，会触发低缓存命中监控和报表噪声

- 文件: `packages/runtime-pi/src/pi-runtime-adapter.ts:1104`、`apps/agent-service/src/cache-hit-monitor.ts:25-39`、`packages/application/src/ports/model-usage.ts:47-56`、`packages/persistence-sqlite/src/sqlite-model-usage-operations.ts:64-75`
- 问题: 摘要请求仍然走 `admitPiStream`，用量记录写死为 `purpose: "chat"`。低命中监控把任何 `purpose === "chat"`、上游报告了缓存用量、输入 ≥1024 token 的“后续轮次请求”都算进去。摘要请求本身按规则第 13 条就“不沿用原开头”，是天然冷请求；一旦上游报告缓存用量，它会被当成低命中对话请求，写 `cache.follow_up_low_hit`，并进入 `--by turn` 报表，掩盖真正的对话缓存回归。
- 证据（亲自读到）:

```ts
// pi-runtime-adapter.ts:1104
purpose: "chat",
source: "agent-stream",
```

```ts
// model-usage.ts:47
export function lowCacheHitRate(observation: ModelUsageObservation): number | null {
  if (
    observation.purpose !== "chat" ||
    !observation.cacheReported ||
    observation.inputTokens < MINIMUM_CACHEABLE_INPUT_TOKENS
  )
    return null;
```

```ts
// sqlite-model-usage-operations.ts:64
private isFollowUpTurn(input: { ownerId: string; agentId: string; runId: string }): boolean {
  return (
    this.database
      .prepare(
        `SELECT 1 FROM runs r JOIN runs earlier
           ON earlier.owner_id = r.owner_id AND earlier.agent_id = r.agent_id
          AND earlier.thread_id = r.thread_id AND earlier.id <> r.id
          AND earlier.created_at < r.created_at
         WHERE r.owner_id = ? AND r.agent_id = ? AND r.id = ? LIMIT 1`,
      )
      .get(input.ownerId, input.agentId, input.runId) !== undefined
  );
}
```

- 证实与推测: 代码路径已证实；是否在生产触发取决于上游是否对该摘要请求报告缓存用量，这一点未核实。
- 建议: 给摘要请求单独的 `purpose`（例如新增 `"compaction"` 并更新 `MODEL_USAGE_PURPOSES`、界面/报表映射），或在低命中判定中排除压缩用途；至少不要让它参与 `cache.follow_up_low_hit`。

### 3. 【低】失败判定仍可能静默漏报：`result` 缺失但 `errorMessage` 为空时不会上报

- 文件: `packages/runtime-pi/src/pi-runtime-adapter.ts:1666`
- 问题: 条件要求 `event.errorMessage` 为真。PR 的目标是“`compaction_end` 无结果时不再静默忽略”，但如果 Pi 发出 `compaction_end` 且 `result` 缺失、`aborted` 为 false、`errorMessage` 为空或缺失，仍然不会写日志；另外 `=== undefined` 也不覆盖 `null`。
- 证据: 同上第 1666 行；新增测试只覆盖了 HTTP 503（Pi 应带 `errorMessage`）的路径。
- 证实与推测: 代码条件确定；Pi 是否会在失败时保证 `errorMessage` 非空无法从当前检出的仓库确认（无 Pi 源码），标为“未核实”。
- 建议: 确认 Pi 的 `compaction_end` 契约；若不能保证，至少把 `result == null && !aborted` 当作失败，并使用固定的本地说明（不要再写上游原文），或者只在明确的失败 `reason` 上触发，同时加一条 `compaction_end` 无 result、无 errorMessage 的用例。

### 4. 【低】新增测试的覆盖缺口

- 文件: `packages/runtime-pi/test/prompt-prefix.compat.test.ts:833-888`
- 问题: 两条 `[COMPACT-1]` 用例覆盖了“成功摘要”和“503 失败上报”，但没有覆盖：
  - 带工具调用/工具结果的对话触发压缩（现实中常见，且 Pi 对这类历史的摘要序列化可能不同）；
  - 失败日志的 message 是否被脱敏；
  - 压缩失败后同一会话继续发出的普通请求是否仍使用冻结开头、`compacting` 是否已复位；
  - `compaction_end` 无 `result` 且无 `errorMessage` 的路径。
- 证据: 两条用例的对话都只是长文本，没有工具调用，失败用例只断言 `code`：

```ts
// prompt-prefix.compat.test.ts:887
expect(failures.map((failure) => failure.code)).toContain("PI_COMPACTION_FAILED");
```

- 建议: 补上上述反向/边界用例，尤其是“压缩会话包含工具调用”和“失败后下一请求仍走冻结工具”的用例。

### 5. 【信息】压缩请求仍不沿用原对话开头，属于已登记差距

- 文件: `packages/runtime-pi/src/pi-runtime-adapter.ts:669-678`
- 说明: `himawariSummaryContext` 使用 Pi 自己的系统提示、`tools: []`，不是冻结的系统提示/工具。它不是一个“只在末尾追加”的对话请求，而是独立的辅助请求。这与规则第 13 条、ADR 0198 和 `docs/backlog/BL-20261109-8w6ct3-compaction-request-reuses-conversation-head.md` 的已知差距一致，不是本 PR 新引入的缺陷；但本 PR 让压缩真正能在生产发生，因此压缩后的下一次普通请求会少一段历史、前缀变化一次（规则第 12 条允许的压缩例外）。

## 作者说法的核对

- “压缩期间的无工具摘要请求，用 `himawariSummaryContext` 原样放行”：基本正确，但“原样”不严格。代码会重建上下文：取第一条 system 作为 `systemPrompt`、过滤掉所有其他 system、强制 `tools: []`，随后 `admitPiStream` 还会通过 `withPlaceholderLegend` 追加出口遮盖图例。若 Pi 未来发出多条 system 消息，后面的会被静默丢弃（当前 Pi 是否如此未核实）。
- “仍走 `admitPiStream`（预算准入、出口遮盖、用量记录）”：正确，见 `pi-runtime-adapter.ts:1634-1648`。
- “压缩失败经 `onModelStreamFailed` 以 `PI_COMPACTION_FAILED` 写服务日志”：代码存在，但 message 原样写入，存在上面的日志泄露问题；且只在 `errorMessage` 非空时上报。
- “没有改变任何普通对话请求”：普通请求的组装分支没有改，这一点正确；但压缩一旦成功会替换历史，后续普通请求的前缀会变一次，这是压缩本身的后果，不能理解为“后续所有普通请求都完全不受影响”。
- “也没有让压缩请求沿用原开头；那是后续 PR”：正确，当前仍是 Pi 自己的摘要系统提示、无工具。
- “撤掉修复后两条测试都失败”：从代码推理成立：没有 `compacting` 时 `himawariRequestContext` 会用冻结工具而 Pi 摘要请求没有工具，`piTools.length !== declared.size` 直接返回 `undefined`，摘要请求不会发出。但我没有实际运行测试，标为“未执行、推理一致”。
- “apps/agent-service 有 108 条失败，在 main 上同样失败”：未核实，无法在当前只读环境运行测试。

## 侧重检查

- 错误路径: 查了摘要失败上报、`compaction_end` 无结果、失败后日志。发现原样日志泄露和 `errorMessage` 为空时的潜在漏报。
- 不合规范/不可信输入: 摘要请求的系统提示来自 Pi，不是用户输入；对话内容仍与普通请求一样经过出口遮盖。未发现新的用户可控输入绕过；但 `himawariSummaryContext` 对“第一条必须是字符串 system”较硬，否则回退到 `PI_REQUEST_TOOLS_DIVERGED`，该失败路径仍会产生压缩失败。
- 安全: 摘要请求仍经过 `admitPiStream` 的出口遮盖，未发现绕过；主要安全问题是日志中可能写入上游原文（发现 1）。
- 资源耗尽: 摘要调用会真实消耗模型预算和 token；这是修复的目标行为。Pi 的压缩阈值与重试配置未在本 PR 改变。未发现新的无界循环，但摘要请求持续失败时的重试/重复上报未覆盖。
- 不可撤销操作: 压缩会重写/摘要素历史，属于 Pi 既有压缩能力；本 PR 让它从“被拦截”变为“可执行”，会实际触发不可逆的上下文压缩。产品侧 `proposeCompaction` 仍在 `compaction_end` 时保存摘要建议（`pi-runtime-adapter.ts:2293-2308`），未看到本 PR 改变持久化路径。
- 规则/文档/代码一致性: ADR 0165/0198 说压缩请求“原样放行”，代码实际会重建 system/tools 并追加遮盖图例；规则第 13 条的缺口仍在；I-44 的日志卫生约定被新路径破坏。

## 必答问题

1. 这个改动会不会改变模型已经见过的请求开头？
   - 普通对话请求：不会。`streamFunction` 在非压缩时仍走 `himawariRequestContext`，系统提示、冻结工具、历史构造未变；每轮变化的时间、记忆、运行环境仍在最后一条用户消息里。
   - 摘要请求：它本身不是“在上一请求末尾追加”，而是 Pi 自己系统提示、无工具的独立请求；这是既有已知差距（规则第 13 条）。本 PR 没有改写已发消息的字节，但压缩成功后会替换历史，使压缩后的下一次普通请求少一段旧历史、前缀变化一次，这是压缩例外。
   - 因此严格说：不是所有请求都只在末尾追加；普通对话请求仍然只在末尾追加，摘要请求是例外，且该请求本来就不会命中原对话缓存。

2. 会不会让同一段文字在不同请求里变成不同字节？
   - 已发给模型的历史不会被本 PR 重新序列化，因此不会因为本改动让“已经发过的内容”变成不同字节。
   - 摘要请求把整段对话重新序列化成 Pi 的 `<conversation>` 形式，和普通请求的消息切分不同；出口遮盖是确定性的，但相同文字在“分条消息”和“一条序列化文本”里的上下文/邻近关系不同，不能假定摘要请求与普通请求遮出的字节完全一样。这一点不影响已发历史，但若要求跨请求逐字节一致，需要单独验证。
   - 未发现新增的时间字段、随机值或无序集合。

3. 有没有对应的自动检查，反向用例是否真的会失败？
   - 有，新增了两条 `[COMPACT-1]` 用例，位于 `prompt-prefix.compat.test.ts`，属于 `check:prompt-prefix` 阻断检查。
   - 从代码推理，撤掉修复后：摘要请求会被 `himawariRequestContext` 以 `PI_REQUEST_TOOLS_DIVERGED` 拦下，第一条用例收不到摘要请求；第二条用例也不会出现 503 的摘要失败，因此两条都应失败。我没有实际运行，标为“未执行”。
   - 反向覆盖不足：没有覆盖工具调用/工具结果场景的压缩、失败日志脱敏、压缩失败后普通请求仍走冻结开头、无 `errorMessage` 的 `compaction_end`。

4. 改动产生或修改的每个值，两端都能接受吗？
   - `PI_COMPACTION_FAILED`: 只作为 `onModelStreamFailed` 的 `code` 进入服务日志，没有看到会校验失败码的消费者；字符串形状符合现有日志习惯，可以接受。问题在 `message: event.errorMessage`，日志端只做机器密钥遮盖，不能保证不含上游原文。
   - `purpose: "chat"`（摘要请求沿用）: 存储端 `MODEL_USAGE_PURPOSES` 接受，不会报错；但下游低命中监控和报表把它当普通对话请求，产生发现 2 的问题。
   - `himawariSummaryContext` 返回的 `Context`: `tools: []`、`messages` 去掉 system 后交给 `normalizeContext`；新增测试验证了请求里 `tools` 未定义、第一条是 Pi 的摘要系统提示，说明当前 Pi 能接受。
   - `compacting` 布尔值: 仅被 `streamFunction` 读取；正常路径复位，但失败时依赖 Pi 发出 `compaction_end` 才会复位，这一契约未核实。
   - 测试里的 `PROMPT_TOKENS`: 仅测试使用，默认值在 `afterEach` 复位，不进入生产。
