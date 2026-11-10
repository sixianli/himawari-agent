# PR 362 第 6 轮复核结论

我按 `4ee327a8..f80e53c4` 的增量为主、结合 `eb12828..f80e53c4` 的全量改动核对。增量本身只改了两处：`assertKnown` 加 `compacting` 条件，以及 ADR 0207 第 6 条和 `.claude/rules/prompt-prefix.md`、kv-cache 指南等文档。

## 问题（按严重度）

### 中：ADR 0207 第 6 条把 `[COMPACT-3]` 当成“Pi 摘要路径本来就不执行工具”的证明，但当前 HEAD 上这条用例证明不了

- 文件: `docs/adr/0207-compaction-request-reuses-conversation-head.md:52`，`packages/runtime-pi/test/prompt-prefix.compat.test.ts:1037-1072`，`packages/runtime-pi/src/pi-runtime-adapter.ts:1709-1716`
- 问题: ADR 写“`[COMPACT-3]` 证明这一点”。但在加了 `compacting` 判断后，`assertKnown` 会在 `executeTool` 真正调用 `tools.execute` 之前抛出 `RUNTIME_TOOL_EXECUTION_STOPPED`：
  ```ts
  assertKnown: (toolCallId) => {
    if (compacting || unknownTool || ...)
      throw new Error("RUNTIME_TOOL_EXECUTION_STOPPED");
  },
  ```
  而 `[COMPACT-3]` 只断言 `executed` 为空和出现 `PI_COMPACTION_FAILED`：
  ```ts
  expect(executed).toEqual([]);
  expect(failures.map((failure) => failure.code)).toContain("PI_COMPACTION_FAILED");
  ```
  即使 Pi 真的尝试执行工具，`CountingTools.execute` 也不会被调用，`executed` 仍为空。因此 HEAD 上的 `[COMPACT-3]` 无法区分“Pi 不执行工具”和“新防线拦住了执行”。
- 证据: 上述 `assertKnown` 在 `executeTool` 的最前面被调用（`pi-runtime-adapter.ts:2093-2101`），抛错发生在任何工具执行之前。
- 建议: 把 ADR 改写成“`[COMPACT-3]` 只证明当前组合下没有产品工具被执行”，不要写成证明 Pi 的行为；或者补一条不依赖真实 Pi 的用例。现有 `packages/runtime-pi/test/runtime-event-contract.unit.test.ts` 的夹具可以直接执行 `customTools[0].execute(...)`，在脚本里先 `emit({ type: "compaction_start" })`，再执行工具，断言抛出 `RUNTIME_TOOL_EXECUTION_STOPPED`。若确实要证明 Pi 不执行，需要保留加入防线之前的运行结果，或做一次去掉防线的对照运行。

### 中低：第 6 轮新增的防线没有自动检查，且用整个 `compacting` 窗口当闸门

- 文件: `packages/runtime-pi/src/pi-runtime-adapter.ts:1711`、`:1766-1770`
- 问题: 作者已说明没有反向用例。当前 `compacting` 从 `compaction_start` 一直保持到 `compaction_end`，这期间**所有**工具执行都会被拒绝，而不只是摘要请求返回的工具调用。若某次压缩因异常/中止没有发出 `compaction_end`，`compacting` 会一直为真，同一次 run 后续的正常工具调用会全部失败。代码只在 `compaction_end` 里复位，没有 `finally`。
  ```ts
  if (event.type === "compaction_start") compacting = true;
  if (event.type === "compaction_end") {
    compacting = false;
    compactionPrefix = undefined;
  ```
- 证据: 重置只发生在这一个分支；`assertKnown` 的 `compacting` 判断无其他清理路径。
- 说明: “Pi 是否在所有中止/失败路径都发 `compaction_end`”我没有 Pi 源码可核实（仓库未安装 `node_modules`），标为未核实。
- 建议: 在 `runtime-event-contract.unit.test.ts` 里加正/反向用例（`compaction_start` 后执行工具必须被拒，`compaction_end` 后必须恢复）；考虑把闸门收窄为“摘要请求在途”而不是整个压缩窗口，并在 `run()` 的异常/收尾路径复位。

### 中低（部分推测）：窗口估算对中文可能偏低、未计占位符说明，且估算通过后若仍超窗不会回退

- 文件: `packages/runtime-pi/src/compaction-prefix.ts:24-31`、`:56-61`，`packages/runtime-pi/src/pi-runtime-adapter.ts:1031-1037`
- 问题: 估算式为 `ascii/3 + 非ASCII/1.2`。英文侧大致保守，但中文侧相当于约 0.83 token/字；若实际 tokenizer 接近 1 token/字或更高，这是低估，提交说明里的“按中文保守计”方向可能相反。另外估算只含 `systemPrompt + tools + instruction + history`，不含 `admitPiStream` 随后追加的 `EGRESS_PLACEHOLDER_LEGEND_WITH_RESTORE`，也不含出口遮盖后占位符膨胀。`sharedSummaryContext` 自己的估算通过后，`admitPiStream` 还能用 `clampMaxTokensToContext` 判出 `PI_CONTEXT_WINDOW_EXHAUSTED` 并直接失败，此时不会回退到 Pi 默认摘要。
  ```ts
  return Math.ceil(ascii / 3 + (text.length - ascii) / 1.2);
  ...
  if (estimated + COMPACTION_REQUEST_ROOM_TOKENS + maxTokens > contextWindow) return undefined;
  ```
- 证据: 计算式中没有 legend/遮盖后长度；`admitPiStream` 的窗口检查在改写之后才执行。
- 说明: 实际中文 token 比、以及生产窗口（100 万）下是否会真的触发，需要实测，标为推测。
- 建议: 用真实 tokenizer 估算或把中文系数调得更保守；把 legend 和出口遮盖后的膨胀计入；若 `admitPiStream` 判超窗，考虑放弃改写并回退 Pi 默认请求。

### 低：ADR 0165 第 7 条与代码/新 ADR 矛盾（文档不一致）

- 文件: `docs/adr/0165-freeze-the-request-head-per-conversation.md:90`，`docs/adr/0198-upgrade-pi-to-1-5-0.md:83`，对照 `docs/adr/0207-compaction-request-reuses-conversation-head.md:84`
- 问题: ADR 0165 仍写“适配器只改写对话请求（带工具数组的请求），压缩请求原样放行”；ADR 0198 仍写“压缩请求仍不沿用原对话开头”。代码现在会在条件满足时改写摘要请求（`pi-runtime-adapter.ts:1638-1652`）。ADR 0207 的关联文档只是口头说明覆盖，旧 ADR 正文没有标注。
- 建议: 在 ADR 0165 第 7 条和 ADR 0198 相应位置加“已被 ADR 0207 部分取代/见 ADR 0207”的交叉引用，避免后来者按旧结论改代码。

### 低：会话编号/缓存设置“取自上一次普通请求”只有纯函数单测，未验证真实请求

- 文件: `packages/runtime-pi/test/prompt-prefix.compat.test.ts:1255-1265`，`packages/runtime-pi/src/pi-runtime-adapter.ts:1638-1652`
- 问题: 单测只用合成的 `{ sessionId: "himawari-1", cacheRetention: "long" }` 验证 `sharedSummaryOptions`，端到端 `[COMPACT-2]` 的回环服务也不检查 `sessionId`/`x-session-affinity` 请求头。生产里普通请求的 `options.sessionId` 是否真的由 Pi 填好，仓库内没有自动证据。
- 建议: 在 `[COMPACT-2]` 的 loopback 里记录摘要请求和普通请求的 `session_id`/`x-session-affinity`，断言两者一致。

### 低（推测）：摘要请求复用普通系统提示后，模型若返回“普通回答”而不是摘要，没有校验

- 文件: `packages/runtime-pi/src/compaction-prefix.ts:63-71`，`docs/adr/0207-compaction-request-reuses-conversation-head.md:74`
- 问题: 现在摘要请求使用原对话系统提示 + 末尾指令。只防住了工具执行；若模型忽略“只回复结构化摘要”而返回一段普通回答，Pi 仍可能把这段文字当成摘要写入历史（ADR 只提到“没有文字的摘要当作失败”）。
- 说明: 行为依赖模型和 Pi 的解析，未核实；ADR 已承认摘要质量需付费评测。
- 建议: 至少加一条人工/付费评测关注点；如可行，在改写后校验摘要格式，或在失败时回退。

## 侧重检查

- **错误路径**: `compactionPrefixMessages` 外层有 try/catch（`pi-runtime-adapter.ts:1496-1500`），钩子失败会退回默认摘要，不会崩溃；`sharedSummaryContext` 在无上一次请求、前缀不匹配、放不下时返回 `undefined`。新增 `assertKnown` 抛错路径没有测试；`compacting` 未在异常路径复位是潜在错误路径问题（见上）。
- **不合规范/不可信输入**: 历史、工具结果仍是不可信内容，但和普通请求走同一套出口遮盖、准入、预算；摘要在末尾追加固定指令，模型若被诱导调用工具，产品工具入口会拒绝。没有新增对模型输出的解析。
- **安全**: 新增回调只把 `sharedHead` 布尔值写日志（`service-main.ts:1884-1890`），不打印历史/工具；摘要请求仍走 `admitPiStream` 的出口遮盖；完整工具定义原本普通请求就会发送，未引入新的秘密泄露面。
- **资源耗尽**: 共享前缀 + 完整工具可能让摘要请求变大；有窗口估算和 4096 余量，但存在中文低估、legend/遮盖膨胀未计、超窗后不回退的问题（见上）。
- **不可撤销操作**: 新增防线直接阻止压缩期间的工具执行，方向正确；但只在 `compaction_start..compaction_end` 生效，若 Pi 在 `compaction_end` 之后才执行摘要产生的工具调用，防线覆盖不到（推测，需 Pi 源码确认）。
- **文档与代码一致性**: ADR 0207 与代码基本一致；ADR 0165/0198 仍是旧说法；ADR 0207 对 `[COMPACT-3]` 的证据强度说过头。

## 必答问题

1. **会不会改变模型已见过的请求开头？**
   不会改变普通对话请求。改动只影响压缩摘要这一条侧请求：它从 `lastRequest` 复用系统提示、工具和切点前历史（`pi-runtime-adapter.ts:1638-1652`），只在末尾追加固定指令（`compaction-prefix.ts:63-71`）；`compacting` 判断只影响工具执行，不影响请求内容。普通请求仍只在末尾追加，每轮变化的值（时间、资料）仍只在最后一条消息里。需要注意：摘要请求本身不是“对上一次请求的完整追加”，它按压缩语义丢弃切点之后的消息，这是规则第 12/13 条允许的压缩例外，不是改写已发给模型的开头。

2. **同一段文字会不会在不同请求里变成不同字节？**
   就本改动的代码看，没有引入新的不确定性：共享前缀直接取自 `lastRequest.context`（系统提示、工具数组、消息对象原样复用），指令是目录里的固定文本，唯一的生成字段是 `timestamp = history.at(-1)?.timestamp ?? 0`，由历史决定；`cacheRetention/sessionId` 从上次普通请求复制。工具数组没有重新排序。出口遮盖仍是每请求确定性的（仓库规则要求），我没有读到能证明“占位符编号一定跨请求相同”的细节，标为未深入核实。

3. **有没有自动检查，反向用例真的会失败吗？**
   有：`[COMPACT-2]` 端到端用例和 `sharedSummaryContext`/`sharedSummaryOptions` 的单元反向用例。撤掉改写后 `[COMPACT-2]` 在 `expect(summaries).toHaveLength(1)` 处失败；单元反向用例直接断言 `undefined`，会失败。`[COMPACT-1]` 只证明有退回默认摘要，ADR 现在已经如实这么写。**第 6 轮新增的 `compacting` 防线没有反向用例**；`[COMPACT-3]` 不能充当它的反向用例（理由见第一条问题）。`compactionPrefixMessages` 的 overflow/拆分轮/切点找不到分支也没有直接用例，作者已承认。

4. **改动产生的每个值，使用它的地方都能接受吗？**
   - `onCompactionSummaryRequest` / `sharedHead`：适配器产生，`production-run-composition.ts` 透传，`service-main.ts` 写入 `writeServiceDiagnostic`（允许 boolean），测试也消费，类型和取用都一致。
   - prompt id `runtime.compaction.summary-instruction`：在 `runtime.ts` 导出、manifest 有登记、会进入 `TRUSTED_PROMPT_TEXTS`；`check:prompt-catalog` 的 `manifestProblems` 会检查 digest/reason。manifest 的 sha256 我无法用允许的命令重算，**未核实**其是否正确（提交说明称该检查通过）。
   - `sharedSummaryContext` 返回的 `Context` 交给 `admitPiStream`/`normalizeContext`，字段形态与普通请求一致；`compactionPrefix` 在比较 `isDeepStrictEqual` 通过后才会被使用，长度/内容两端对得上。
   - `sharedSummaryOptions` 返回 `SimpleStreamOptions`，只从上次请求复制 `cacheRetention`/`sessionId`；Pi 1.5.0 的字段名我未能从源码核实（仓库无 `node_modules`），但现有代码按提交证据应已通过类型检查。
   - 文档侧存在两端不一致：ADR 0165 第 7 条、ADR 0198 第 83 行仍描述旧行为，见上。
