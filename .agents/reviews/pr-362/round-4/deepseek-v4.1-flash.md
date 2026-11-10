## 复核结论（按严重度）

### 中：`[COMPACT-1]` 的断言并不能证明“压缩没有被改写”，ADR 0207 关于退路覆盖的说法不成立

- 文件:行：`packages/runtime-pi/test/prompt-prefix.compat.test.ts:947-954`
- 问题：`[COMPACT-1]` 只筛选包含 `<conversation>` 的摘要请求，然后只对这批请求断言 `tools` 为空、系统提示是 Pi 的 `context summarization assistant`。改写后的共享开头请求不含 `<conversation>`（`[COMPACT-2]` 自己在 `:1030` 断言了这一点），因此它完全不会被这个用例检查。
- 证据：
  ```ts
  const summaries = bodies.filter((body) => body.includes("<conversation>"));
  expect(summaries.length).toBeGreaterThan(0);
  for (const summary of summaries) {
    const parsed = JSON.parse(summary);
    expect(parsed.tools).toBeUndefined();
    expect(parsed.messages[0].content).toContain("context summarization assistant");
  }
  ```
  以及 `[COMPACT-2]` 的 `:1030`：
  ```ts
  expect(JSON.stringify(summary)).not.toContain("<conversation>");
  ```
- 影响：ADR 0207 第 5 条写“`[COMPACT-1]` 的两条用例里压缩没有被改写……间接覆盖退路”。实际上这个用例只能证明“还存在至少一个 Pi 默认摘要请求”，不能证明共享改写没有发生，也不能证明退回原因（拆分轮/溢出/对不上/窗口放不下）。如果 `[COMPACT-1]` 的场景里第一个摘要请求其实已被改写、只是后面又有一次默认压缩，这个用例仍会通过。作者已承认“具体退回原因未断言”，但“间接覆盖退路”仍被高估。
- 建议：在 `[COMPACT-1]` 里挂 `onCompactionSummaryRequest`，显式断言 `sharedHead === false`，并断言至少一个可区分的退回原因；或者给摘要请求加测试专用标记，区分“Pi 默认摘要”和“共享摘要”。

### 中：`lastRequest` 仍是在 `admitPiStream` 之前记录，和提交说明“确认会发出请求后才记录”不一致

- 文件:行：`packages/runtime-pi/src/pi-runtime-adapter.ts:1663-1668`
- 问题：`lastRequest = { context, options }` 位于 `admitPiStream` 调用之前。`admitPiStream` 仍可能因为窗口耗尽、准入被拒、绑定不匹配等返回失败流，此时请求从未发出，但 `lastRequest` 已经被更新。
- 证据：
  ```ts
  if (!summaryContext) lastRequest = { context, options };
  else
    this.#dependencies.onCompactionSummaryRequest?.(request, {
      sharedHead: shared !== undefined,
    });
  return admitPiStream(...)
  ```
  失败分支例如 `pi-runtime-adapter.ts:1034-1037`：
  ```ts
  if (clampMaxTokensToContext(model, transcript, desiredMaxTokens) < ...)
    return failedPiStream(model, PI_CONTEXT_WINDOW_EXHAUSTED);
  ```
  以及 `:1087-1093` 的准入拒绝分支。
- 影响：后续压缩可能以一条“从未真正发出”的普通请求的系统提示/工具/历史作为共享开头。不会改变模型已经见过的内容，也不影响正确性，但会让缓存命中预期失真，且与 ADR 0165 里“上一次已通过检查、即将发出的普通请求”的严格说法不完全一致。
- 建议：把赋值移到 `admitPiStream` 成功拿到 `fresh` permit 之后（例如通过回调），或在失败返回前清掉这次记录；同步修正提交说明/ADR 的措辞。

### 中（偏安全，部分未核实）：摘要请求现在携带完整工具，含执行句柄工具；模型返回工具调用时是否会执行，没有测试

- 文件:行：`packages/runtime-pi/src/compaction-prefix.ts:62-71`，`packages/runtime-pi/src/pi-runtime-adapter.ts:1641-1651`
- 问题：共享摘要上下文直接复用 `lastRequest` 的 `tools`，包括 `execution_task_start`、`execution_task_cancel` 这类可能产生外部/不可撤销效果的工具。ADR 0207 后果段声称“Pi 把没有文字的摘要当作失败……不改变对话内容”，但没有任何用例让摘要请求返回 tool call 来验证。
- 证据：
  ```ts
  return {
    ...lastRequest,
    messages: [...]
  };
  ```
  适配器把共享上下文直接交给 `admitPiStream`，摘要请求的工具就是上一次普通请求的完整工具集。
- 影响：如果 Pi 的摘要路径对工具调用的处理与 ADR 假设不同，模型在压缩阶段可能触发工具执行，属于安全/不可撤销操作风险；目前只能依赖对 Pi 内部实现的阅读结论，没有自动保护。
- 建议：增加一条端到端反向用例：摘要请求返回 `tool_calls`，断言不执行任何工具、`compaction_end` 无有效结果、以 `PI_COMPACTION_FAILED` 写日志。若 Pi 确实不执行，也应把这条行为固定成测试。

### 低到中：窗口估算没有计入 `withPlaceholderLegend` 追加的说明；估算器与真正发送时的窗口检查不是同一套

- 文件:行：`packages/runtime-pi/src/compaction-prefix.ts:56-61`，`packages/runtime-pi/src/pi-runtime-adapter.ts:1032-1037`
- 问题：`sharedSummaryContext` 用 `/3`、`/1.2` 的启发式估算“历史+系统提示+工具+指令”，但 `admitPiStream` 真正发送前会先 `withPlaceholderLegend(context)`，在系统提示后追加一段固定说明（`egress-context.ts:15-20`），这段没有算进估算。估算和 `clampMaxTokensToContext` 使用的 token 计算也不是同一套。
- 证据：
  ```ts
  const estimated =
    approximateTokens(lastRequest.systemPrompt ?? "") +
    approximateTokens(JSON.stringify(lastRequest.tools ?? [])) +
    approximateTokens(COMPACTION_SUMMARY_INSTRUCTION.text) +
    history.reduce(...);
  if (estimated + COMPACTION_REQUEST_ROOM_TOKENS + maxTokens > contextWindow) return undefined;
  ```
- 影响：如果估算低估，代码会先选择共享请求，随后在 `admitPiStream` 里以 `PI_CONTEXT_WINDOW_EXHAUSTED` 失败，而不是按 ADR 承诺“放不进窗口就退回 Pi 默认请求”。默认请求通常更大，所以未必更差，但“退回”这条语义不严格成立。
- 建议：把 `withPlaceholderLegend` 后的实际系统提示纳入估算，或复用 `clampMaxTokensToContext` 的同一套 token 计算；若共享请求被窗口检查拒绝，考虑显式回落到默认摘要路径并记录原因。

### 低：`compaction.summary_request` 日志在准入前写，统计的是“尝试”而不是“已发出”，且没有自动检查

- 文件:行：`packages/runtime-pi/src/pi-runtime-adapter.ts:1664-1667`，`apps/agent-service/src/service-main.ts:1884-1890`
- 问题：与 `lastRequest` 一样，日志回调在 `admitPiStream` 之前触发。准入失败、窗口耗尽、请求未发出的情况也会记 `compaction.summary_request`，`sharedHead` 统计因此偏大。另外没有任何测试断言这个回调被调用、`sharedHead` 的 true/false 是否正确、服务端字段类型是否匹配。
- 证据：
  ```ts
  this.#dependencies.onCompactionSummaryRequest?.(request, {
    sharedHead: shared !== undefined,
  });
  return admitPiStream(...)
  ```
  `service-main.ts` 把 `sharedHead` 直接交给 `writeServiceDiagnostic`；`writeServiceDiagnostic` 接受 boolean（`packages/platform-node/src/service-runtime.ts:67-72`），类型上是安全的。
- 建议：把日志移到实际已进入发送路径之后（例如 `admitPiStream` 成功后），并加一条用例覆盖 `sharedHead: true` 和 `false` 两种值；同时确认运维文档里登记了该日志。

### 低：`sharedSummaryOptions` 只沿用 `sessionId`/`cacheRetention`，没有处理其他会影响缓存匹配的选项

- 文件:行：`packages/runtime-pi/src/compaction-prefix.ts:31-42`，测试 `packages/runtime-pi/test/prompt-prefix.compat.test.ts:1215-1225`
- 问题：函数只从 `lastOptions` 取 `cacheRetention` 和 `sessionId`，其余 `options` 原样来自 Pi 的摘要调用。`reasoning`、`toolChoice`、`temperature` 等如果与普通请求不同，即使前缀字节相同也可能不命中缓存（规则第 8 条也提到 `tool_choice` 会失效）。
- 证据：
  ```ts
  const { cacheRetention: _cache, sessionId: _session, ...rest } = options ?? {};
  return { ...rest, ...cacheRetention..., ...sessionId... };
  ```
  `[COMPACT-2]` 只比对 `summary.tools` 和 `summary.messages`，没有断言请求选项。
- 影响：核心目标“吃到缓存”可能因未知选项差异落空；属于未核实风险，不是已证实缺陷。
- 建议：如果 Pi 的摘要 options 确实带有不同的 `reasoning`/`toolChoice`，应明确沿用普通请求的值或记录放弃理由；端到端测试里补一条摘要请求与普通请求关键选项相同的断言。

### 低：`prompt-manifest.json` 的 `usedBy` 没有门禁，sha256 本次未重算

- 文件:行：`packages/prompt-catalog/prompt-manifest.json:411-415`，`apps/agent-service/test/prompt-catalog.unit.test.ts:181-194`
- 问题：`prompt-catalog` 检查只核对 id 是否存在、`sha256` 是否等于 `digest(segments)`、`changedIn`/`reason` 是否非空；`usedBy` 只写不查。本次把 `usedBy` 改成 `packages/runtime-pi/src/compaction-prefix.ts` 是对的（该文件确实引用 `COMPACTION_SUMMARY_INSTRUCTION`），但没有自动保护。
- 证据：
  ```ts
  if (!row) problems.push(`PROMPT_MANIFEST_MISSING ${entry.id}`);
  else {
    if (row.sha256 !== digest(entry)) problems.push(`PROMPT_MANIFEST_STALE ${entry.id}`);
    ...
  }
  ```
  没有读取 `entry.usedBy` 的逻辑。
- 影响：将来 `usedBy` 写错不会被发现；本次 `sha256` 我无法在只读环境里重算，标“未核实”，但按代码看 `check:prompt-catalog` 能兜住文本摘要。
- 建议：若要靠 `usedBy` 做审计，补一条“`usedBy` 指向的文件必须真实存在且包含该 id”的检查；否则在文档里说明它只是说明性字段。

### 低：文档与代码还有两处小差异

- `docs/kv-cache-guide.md` 的“生产监控”和 `.claude/rules/prompt-prefix.md:76-79` 没有提到新增的 `compaction.summary_request`，但 ADR 0207 第 6 条说生产里靠它统计改写比例。
- 提交说明写“`lastRequest` 只在确认会发出请求后记录”，与上面 `pi-runtime-adapter.ts:1663` 的实际位置不一致。

---

## 读代码证实的 vs 推测/未核实

**读代码证实的：**
- `[COMPACT-1]` 只检查含 `<conversation>` 的 body，无法观察共享摘要。
- `lastRequest` 与 `compaction.summary_request` 都在 `admitPiStream` 之前触发。
- 窗口估算没有计入 `withPlaceholderLegend` 追加的说明。
- 摘要请求复用了 `lastRequest.tools`（含句柄工具），没有工具调用返回的测试。
- `sharedSummaryOptions` 只沿用 `sessionId`/`cacheRetention`。
- `prompt-catalog` 检查不核对 `usedBy`。
- `purpose: "other"` 会被 `lowCacheHitRate` 排除（`packages/application/src/ports/model-usage.ts:47-55` 有 `purpose !== "chat"` 判断），不会混进对话低命中告警。
- `writeServiceDiagnostic` 接受 boolean 字段，`sharedHead` 类型两端匹配。

**推测/未核实：**
- `[COMPACT-1]` 里共享改写到底有没有发生、是否有后续默认压缩；需要作者给出实测或加断言。
- Pi 的摘要路径是否会执行工具调用；ADR 说不会，但没有可执行证据。
- `approximateTokens` 的 `/1.2` 对实际 tokenizer 是保守还是低估。
- Pi 是否真的在普通请求的 `options` 里提供 `sessionId`/`cacheRetention`，从而让摘要请求沿用会话亲和。
- Pi 的摘要 options 是否带有与普通请求不同的 `reasoning`/`toolChoice`，导致缓存不命中。
- `prompt-manifest.json` 的 `sha256` 是否与文本完全一致（无法在本环境重算，但检查脚本存在）。

---

## 侧重检查

- **错误路径**：钩子 `compactionPrefixMessages` 有 `try/catch`（`pi-runtime-adapter.ts:1495-1502`），`sharedSummaryContext` 对没有上一次请求、历史不一致、窗口不满足都有 `undefined` 退路，基本合理；但退回原因没有端到端断言。
- **不合规范/不可信输入**：`firstKeptEntryId` 来自 Pi，`prefix` 与 `lastRequest.messages` 用 `isDeepStrictEqual` 全文比对，匹配不上就退回；没有引入新的输入信任边界。新增指令来自提示词目录，`trusted-prompt-egress` 会遍历所有目录条目并要求原样发送、无拦截（`apps/agent-service/test/trusted-prompt-egress.unit.test.ts:112-127`），这条路径是覆盖到的。
- **安全/不可撤销操作**：摘要请求携带完整工具（含执行句柄工具），没有测试模型返回 tool call 的情况，是本轮最值得补的安全反向用例。
- **资源耗尽**：窗口估算使用启发式且漏了占位符说明；如果低估，可能在准入阶段才失败，而不是提前退回默认摘要。压缩本身是低频操作，`JSON.stringify`/深比较的 O(n) 成本可接受。
- **规则/文档/代码一致性**：prompt-prefix 规则第 13 条、ADR 0207、pi-development-guide 与实现基本一致；不一致点集中在 `[COMPACT-1]` 的“退路覆盖”说法、提交说明里的 `lastRequest` 时机，以及运维文档未登记新日志。

---

## 必答问题

1. **会不会改变模型已经见过的请求开头？**
   正常对话请求没有改动：`shared` 只在 `summaryContext` 为真时使用（`pi-runtime-adapter.ts:1638-1651`），因此普通请求仍走原来的 `himawariRequestContext`。摘要请求本身用的是上一次普通请求的 `systemPrompt`、`tools` 和前 `prefix.length` 条消息（`compaction-prefix.ts:52-71`），是上一次请求开头的子集，不会改写已经发过的字节；新指令只在最后追加。摘要成功后下一次普通请求开头会因压缩变一次，这是规则第 12 条允许的压缩例外。
   需要留意：`lastRequest` 可能在请求真正发出前就被记录（见发现二），后续摘要可能以一个“未发出的开头”为基准，但这不会改变模型已经见过的内容。
2. **同一段文字会不会在不同请求里变成不同字节？**
   没有发现新的非确定性：指令文本固定在提示词目录并有 sha 记录；历史取自上一次请求；`sessionId`/`cacheRetention` 取自上一次请求的稳定值；新增的只有最后一条消息里的 `timestamp`（`compaction-prefix.ts:69`），属于最后一条消息，符合“会变的值放最后”。遮盖方面依赖规则第 11 条的“只依赖自己和前面的内容”：摘要把切点后的消息丢掉，如果某条口令/验证码是在切点之后才点名的，普通请求里点名消息之前的消息本来也不受它影响，所以前缀字节应当一致；但目前没有针对“点名消息在切点之前/之后”的摘要请求测试，属于覆盖缺口。
3. **有没有对应的自动检查，反向用例是否真的会失败？**
   有：`[COMPACT-2]` 端到端用例和 5 条单元用例都带 `[I-66]`，被 `check:prompt-prefix` 收集（`scripts/check-prompt-prefix.mjs:9`）。单元反向用例直接调用 `sharedSummaryContext`，改坏“历史不一致/没有上一次请求/窗口放不下”的退路会失败；撤掉改写时 `[COMPACT-2]` 找不到含 `Do NOT continue it` 的摘要 body，也会失败。
   但：`[COMPACT-1]` 的“不改写”退路没有真正被断言（见发现一）；拆分轮、溢出、切点找不到、工具调用返回、日志回调都没有自动检查。`REQUIRED=8` 也没有随新增用例提高，删除若干新用例仍可能通过门槛。
4. **改动产生或修改的每个值，使用它的地方都能接受吗？**
   - `runtime.compaction.summary-instruction`：生产端 `fixedPrompt` → `prompt-manifest.json` 有对应行，`prompt-catalog.unit.test.ts` 会校验 id、sha 摘要、`changedIn`、`reason`；`trusted-prompt-egress.unit.test.ts` 会遍历所有目录条目并要求原样发送。`usedBy` 没有校验。
   - `sharedHead`：适配器依赖类型 → `ProductionRunCompositionOptions` → `service-main` 的 `writeServiceDiagnostic`，后者接受 boolean，类型和序列化都能接受；但没有运行时/测试断言 true/false 的值。
   - `compaction.summary_request`：没有事件白名单/注册表，`writeServiceDiagnostic` 接受任意 `string | number | boolean | string[]` 字段，所以 event 名和 `runId`/`sharedHead` 不会因 schema 被拒；代价是没有编译期保护。
   - `purpose: "other"`：`lowCacheHitRate` 明确排除非 `chat`，`cache-hit-report.mjs` 按 `purpose` 分组，均可接受。
   - `sessionId`/`cacheRetention`：`SimpleStreamOptions` 接受；但 Pi 是否真的在普通请求里提供这两个值、摘要调用是否由此使用同一会话亲和，未核实。
