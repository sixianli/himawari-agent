## 复核结果

说明：仓库里没有 `node_modules`，凡依赖 Pi 1.5.0 内部实现（`estimateTokens`、`buildSessionProjection`、`convertToLlm`、`session_before_compact` 的事件形状、扩展是否影响普通请求字节）的说法，我只能核对本仓库的调用与测试，标为「未核实」。我没有运行测试，只能读测试代码判断其语义。

---

### 高

**1. 「放不进窗口就退回默认请求」的估算漏了系统提示、工具定义和追加指令**
- 文件:行：`packages/runtime-pi/src/pi-runtime-adapter.ts:722-723`（对应 ADR `docs/adr/0207-compaction-request-reuses-conversation-head.md:48`）
- 证据：
  ```
  722:  const estimated = history.reduce((total, message) => total + estimateTokens(message), 0);
  723:  if (estimated + COMPACTION_REQUEST_ROOM_TOKENS + maxTokens > contextWindow) return undefined;
  ```
  但 `history` 是 `lastRequest.messages`，而正常请求返回的 Context 把系统提示和工具放在消息之外：
  ```
  679:  return { systemPrompt, tools, messages: rest };
  ```
  追加的 `COMPACTION_SUMMARY_INSTRUCTION` 也没算进去。ADR 却写「估算输入加输出上限加 4096 余量超过窗口」。
- 问题：真正发给模型的是 `normalizeContext(withPlaceholderLegend(context))`（`pi-runtime-adapter.ts:1071`），其中包含系统提示、完整工具定义和追加指令。压缩恰恰发生在接近窗口上限时，`history` 可能已经接近窗口；只留 4096 给系统提示+工具+指令，很容易不够。此时估算通过、不会退回 Pi 默认请求，随后 `admitPiStream` 的 `clampMaxTokensToContext` 会压缩输出上限（`1070-1076`），或在放不下时返回 `PI_CONTEXT_WINDOW_EXHAUSTED`，压缩失败——正是这次改动想避免的 I-92 类结果。ADR 的「不比现状差」在这条路径上不成立。
- 建议：用和 `admitPiStream` 同一套做法估算完整请求（`normalizeContext(withPlaceholderLegend(context))` + `clampMaxTokensToContext`，或至少把 `systemPrompt`、`tools`、指令一起算），再决定是否退回默认；测试里加一个「工具很多/前缀很大时必须退回」的正向用例。

### 中

**2. `sessionId` 没有像 `cacheRetention` 那样先丢掉，和「沿用上一次普通请求」不一致**
- 文件:行：`packages/runtime-pi/src/pi-runtime-adapter.ts:1689-1698`
- 证据：
  ```
  1689:  const { cacheRetention: _dropped, ...rest } = options ?? {};
  1690:  options = {
  1691:    ...rest,
  1692:    ...(lastRequest?.options?.cacheRetention === undefined
  1693:      ? {}
  1694:      : { cacheRetention: lastRequest.options.cacheRetention }),
  1695:    ...(lastRequest?.options?.sessionId === undefined
  1696:      ? {}
  1697:      : { sessionId: lastRequest.options.sessionId }),
  1698:  };
  ```
- 问题：`cacheRetention` 是先解构丢弃再按上次普通请求补回；`sessionId` 没有先丢。若上一次普通请求的 `options.sessionId` 是 `undefined`、而 Pi 的摘要请求自带 `sessionId`，`rest` 会把摘要请求自己的 `sessionId` 留下来，摘要请求就没有「沿用上一次普通请求」。这会破坏 Magpie 的会话亲和（`configured-model-binding.ts:295` 打开 `sendSessionAffinityHeaders`），可能拿不到缓存。ADR 第 3 条声称会话编号沿用普通请求。
- 建议：把 `sessionId` 也从 `rest` 里解构丢掉，再按 `lastRequest.options.sessionId` 补；补一条测试，断言摘要请求的会话编号/缓存设置与普通请求一致。是否真的会踩到取决于 Pi 是否给摘要请求设置 `sessionId`（未核实）。

**3. `[COMPACT-2]` 只证明「拿到的前缀是普通请求的前缀」，没证明「前缀是切点前的完整范围」；缓存参数和工具历史也没测**
- 文件:行：`packages/runtime-pi/test/prompt-prefix.compat.test.ts:1014-1022`；退路相关 `911-953`
- 证据：
  ```
  1016:  expect(summary.tools).toEqual(normal.tools);
  1017:  expect(summary.messages.slice(0, -1)).toEqual(
  1018:    normal.messages.slice(0, summary.messages.length - 1),
  1019:  );
  1021:  expect(JSON.stringify(summary)).not.toContain("<conversation>");
  ```
- 问题：
  - 如果 `compactionPrefixMessages` 因为切点算错只返回了很短的一段历史，这段仍然是 `normal.messages` 的前缀，这个用例照样通过；但 Pi 仍会按 `firstKeptEntryId` 丢掉后面的消息，造成摘要没覆盖被丢掉的内容（信息丢失）。测试没有断言「第一轮内容在、切点之后的内容不在」。
  - 用例的历史全是纯文本，没有工具调用/工具结果，而这正是 `convertToLlm` 最可能与实际发送消息不一致、也是生产最常见的场景。
  - 没有断言 `cacheRetention`/`sessionId`，所以「吃到缓存」的核心参数没有自动检查。
  - 用 `toEqual` 比较的是 parse 后的对象，不是字节；ADR 和 `docs/kv-cache-guide.md` 却写「逐字节相同」「`messages` 逐字节比」。这里没有调用 `findPrefixBreak` 的字节比较（也难怪：压缩请求会截短消息，`findPrefixBreak` 会报 `messages-shortened`）。
  - 退路只靠 `[COMPACT-1]` 隐含覆盖；该用例标题是「lets Pi's automatic summary request out…」，没有断言 `isSplitTurn`/overflow/对不上/放不下中的哪一种，ADR 第 5 条却称它是「拆分轮用例」。
- 建议：断言摘要请求历史的具体范围（例如包含第一轮文本、不含切点后的第二轮），用原始 body 的字节前缀比较；补工具调用/工具结果场景；补 cacheRetention/sessionId 断言；为 split-turn、overflow、前缀不匹配、窗口放不下各加一条明确的反向用例。

### 低

**4. 原因判断用的是「不是 overflow」的排除法，和 ADR 的「只处理 threshold/manual」不一致**
- 文件:行：`packages/runtime-pi/src/pi-runtime-adapter.ts:698`（ADR 第 47 行）
- 证据：
  ```
  698:  if (event.reason === "overflow" || event.preparation.isSplitTurn) return undefined;
  ```
- 问题：当前 Pi 类型只有 `manual | threshold | overflow` 时没问题；一旦上游新增原因（例如某种自动触发），代码会当成可改写，ADR 却写的是白名单。另外非 overflow 分支直接访问 `event.preparation`，没有 try/catch；若运行时缺字段会抛出（Pi 是否吞掉钩子错误未核实）。
- 建议：写成 `reason !== "manual" && reason !== "threshold"` 的允许清单，并给钩子加 try/catch，出错就回退默认。

**5. 文档与代码/测试有陈旧或不一致之处**
- 文件:行：
  - `docs/adr/0198-upgrade-pi-to-1-5-0.md:83` 仍写「已知缺口不变。压缩请求仍不沿用原对话开头」。
  - `docs/adr/0165-freeze-the-request-head-per-conversation.md:90` 仍写压缩用 Pi 自己的系统提示、不带工具。
  - `docs/incidents-and-gates.md:126`（I-92）仍写 `PI_REQUEST_TOOLS_DIVERGED`，当前代码只有 `PI_REQUEST_HEAD_DIVERGED`（`pi-runtime-adapter.ts:393`），对应测试也检查 HEAD（`prompt-prefix.compat.test.ts:908`）。
  - ADR 0207 第 5 条把 `[COMPACT-1]` 说成「拆分轮用例」，但测试没有这个断言。
- 问题：规则文件和 `docs/kv-cache-guide.md` 已更新，但旧 ADR 和事故清单会误导后续排查；I-92 的错误码和当前代码对不上。
- 建议：旧 ADR 加「已被 ADR 0207 更新」或在 ADR 0207 里列出被更新的结论；修正 I-92 的错误码；把退路测试命名/断言写清楚。

**6. 摘要请求带了工具但没有 `tool_choice: none`**
- 文件:行：`packages/runtime-pi/src/pi-runtime-adapter.ts:1683-1734`；指令 `packages/prompt-catalog/src/runtime.ts:244`
- 证据：改写后的 context 直接复用 `lastRequest.tools`，只靠指令文字「do NOT call any tools」约束；ADR 后果也承认「模型可能忽略…返回工具调用，Pi 把没有文字的摘要当作失败」。
- 问题：工具在上下文里，模型忽略指令时压缩会失败（`PI_COMPACTION_FAILED`），可靠性低于 Pi 默认请求。是否真的会执行工具未核实，但压缩失败路径是真实存在的。
- 建议：若 Pi 的 `SimpleStreamOptions` 支持，摘要请求显式带 `tool_choice: "none"`（保留工具定义以维持缓存前缀）；否则至少加压缩失败率监控。

---

## 侧重检查

我按「错误路径、不可信输入、安全、资源耗尽、不可撤销操作、规则/文档一致性」查了：

- **错误路径**：溢出/拆分轮/前缀对不上/没有上次普通请求都走 `undefined` 退回（`pi-runtime-adapter.ts:693-735`、`1673-1699`）；摘要失败经 `compaction_end` 写 `PI_COMPACTION_FAILED`（`1809-1813`），不写对话。发现窗口退回判断不完整（问题 1）和工具调用导致失败的风险（问题 6）。
- **不可信输入**：`branchEntries`/工具结果只用于选择和逐条比较，没有被当指令解析；但摘要请求会把工具结果按结构化原文发送（ADR 也承认不再截断到 2000 字符），大体积工具结果会放大输入，窗口判断又漏算工具/系统（问题 1）。
- **安全**：复用的前缀是出口遮盖前的 Context，摘要请求会再次走 `admitPiStream` 的遮盖；规则第 11 条和 `[I-78]` 的「同样内容遮成同样字节」测试支持确定性。新增指令自动进入 `TRUSTED_PROMPT_TEXTS`，我核对了文本没有会被判成 6 位验证码/密钥的内容，也没有 `必须/一律/MUST/CRITICAL` 或 `用户/Owner/Run/Handle/筛掉`。工具只发定义，不在压缩里执行（未核实）。
- **资源耗尽**：`buildSessionProjection`/`estimateTokens` 都是线性一次，没有循环；主要风险是上面说的窗口判断漏算导致请求过大/压缩失败。
- **不可撤销操作**：压缩会丢弃 `firstKeptEntryId` 前的消息；如果切点算短了就是不可恢复的信息丢失，而现有测试抓不到（问题 3）。没有新增文件/数据库写入；`other` 用量落库的 CHECK 约束接受（`migrations/0068_model_usage_observations.sql:6-11`）。
- **规则/文档一致性**：`.claude/rules/prompt-prefix.md:61` 和 `docs/kv-cache-guide.md:68,87` 已改成「做到」；但旧 ADR 和 I-92 仍有陈旧表述（问题 5）。
- **值两端核对**：新 prompt id 的 manifest 行格式、reason/changedIn 合法；`other` 在 `MODEL_USAGE_PURPOSES` 和 DB CHECK 里都接受；`cacheRetention`/`sessionId` 类型上受 `SimpleStreamOptions` 接受，但会话编号逻辑与声明不一致（问题 2）。

---

## 必答问题

**1. 会不会改变模型已经见过的请求开头？发给模型的内容是不是仍然只在末尾追加，每轮会变的值是不是都在最后一条消息里？**

- 普通对话请求：代码没有改写 `himawariRequestContext` 的构造，只是把结果存进 `lastRequest`（`1687`），普通请求的 context 不变；新增的扩展只注册 `session_before_compact`，本仓库看不到 Pi 是否会把扩展信息写进系统提示（未核实），但 `pi-runtime-adapter.compat.test.ts` 的 D4 golden 请求会拦截普通请求字节变化。
- 摘要请求：**不是**对紧邻的上一次请求做「只追加」——它只保留 `firstKeptEntryId` 之前的历史，切点之后的消息被丢掉，所以消息会变短。这正是规则第 13 条允许的压缩例外：系统提示、工具定义、切点前的历史都来自上一次普通请求（`sharedSummaryContext` 深比较通过才改写），末尾追加一条固定指令。
- 会变的值：时间、记忆日期、运行环境等都在被复用的 `lastRequest.messages` 里，没有搬到系统提示或中间消息；追加消息的 `timestamp` 取 `history.at(-1)?.timestamp ?? 0`（`731`），是确定值，不取当前时间。结论：普通轮仍然只在末尾追加；压缩轮是「保留原开头 + 截掉切点后的尾部 + 末尾追加固定指令」，这是有意为之，但和「只追加」的字面含义不同，文档应像 ADR 第 13 条那样把它写成压缩例外。

**2. 会不会让同一段文字在不同请求里变成不同字节？**

- 新增的指令是固定文本；工具顺序来自冻结的 `lastRequest.tools`；历史直接复用上一次普通请求的消息对象；追加消息的时间戳是确定的，没有引入无序集合或当前时间。
- 摘要请求会重新做一次出口遮盖和 `withPlaceholderLegend`，这依赖现有规则第 11 条和 `[I-78]`「同样内容遮成同样字节」的确定性，方向上不是新增的不确定来源。
- 未核实的风险：`lastRequest` 保存的是上一次请求的 `context`/`options` 引用，如果 Pi 在发送后原地修改消息对象，复用出来的字节可能变；我没有 Pi 源码可核对。

**3. 改动有没有对应的自动检查？反向用例真的会失败吗？**

- 有：`[COMPACT-2]` 位于 `[I-66]` describe 内，`scripts/check-prompt-prefix.mjs:27` 用 `-t "\[I-66\]"` 运行它，属于 `npm run check:prompt-prefix`。按测试代码，撤掉改写后没有任何 body 的末条消息包含 `Do NOT continue it`，`expect(summaries).toHaveLength(1)` 会失败，反向用例成立。
- 但反向覆盖不足：没有显式覆盖 split-turn、overflow、前缀不一致、窗口放不下、没有上次普通请求；`[COMPACT-1]` 只是隐含走到了某条退路，没有断言是哪一条。没有覆盖工具调用/工具结果历史，也没有覆盖 `cacheRetention`/`sessionId`。`toEqual` 不是字节比较。总结：正向用例能拦住「完全不改写」，拦不住「改写范围不对」「缓存参数没带上」和「各种退回路径」。

**4. 改动产生或修改的每个值，每个使用它的地方都能接受吗？**

- `runtime.compaction.summary-instruction`：manifest 有行、reason/changedIn 非空；`prompt-catalog.unit.test.ts` 会校验 digest 和未知项；`trusted-prompt-egress.unit.test.ts` 会把每个目录项当 system/user 各发一次并要求不变；`prompt-wording.unit.test.ts` 的禁用词/强调词检查我逐条看过文本，均通过。**manifest 里的 sha256 我无法在本环境计算，未核实**。
- 用量 `other`：`packages/application/src/ports/model-usage.ts:11` 和 `migrations/0068_model_usage_observations.sql:6-11` 都接受。
- `cacheRetention`/`sessionId`：类型上接受，但 `sessionId` 的补值逻辑和「沿用上一次普通请求」不完全一致（问题 2）。
- 新钩子、`buildSessionProjection`、`convertToLlm`、`estimateTokens`：是否能从锁定版本导出、事件形状是否如 ADR 所述，**因缺 `node_modules` 未核实**；若不一致会体现在 typecheck/运行，而不是本仓库文本里。
- 追加消息的 `role/content/timestamp`：是合法的 UserMessage 形状，`timestamp` 为数字；测试只断言了 `role: "user"`。

**未核实清单**：Pi 1.5.0 的 `estimateTokens` 是否只算消息还是算完整 Context、`buildSessionProjection` 的 `sourceEntry.id` 和 `convertToLlm` 与普通请求消息是否逐字节一致、`session_before_compact` 的事件字段和触发顺序、扩展是否影响普通请求字节、摘要请求是否可能执行工具、`prompt-manifest.json` 的 sha256 是否正确、生产环境的 `cacheRetention`/会话亲和是否真的变化。
