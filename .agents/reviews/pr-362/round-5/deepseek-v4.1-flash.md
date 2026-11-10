# PR 362 第 5 轮复核（`4ee327a8`，增量 `8045ffcc..4ee327a8`）

## 侧重检查

- **错误路径**：压缩钩子在 `packages/runtime-pi/src/pi-runtime-adapter.ts:1495-1501` 用 `try/catch` 包住，任何异常都静默退回 `compactionPrefix = undefined`；这保证不会因钩子报错中断对话，但也会让改写功能整体失效且只有指标可看。`compaction_end` 失败仍有 `PI_COMPACTION_FAILED`（同文件 `1767-1771`）。【读代码证实】
- **不合规范或不可信输入**：`firstKeptEntryId` 找不到时 `cut <= 0` 退回；prefix 为空退回；历史与上一次普通请求不一致时 `isDeepStrictEqual` 退回（`packages/runtime-pi/src/compaction-prefix.ts:14-22, 53-55`）。输入全部来自 Pi 会话，不直接接受外部字符串。【读代码证实】
- **安全**：新增 `compaction.summary_request` 日志只写 `runId` 和布尔值，没有敏感内容（`apps/agent-service/src/service-main.ts:1884-1890`）。摘要请求复用原对话的系统提示、工具和历史，数据范围没有扩大。【读代码证实】
- **资源耗尽 / 窗口**：窗口估算按字符近似（ASCII `/3`、非 ASCII `/1.2`），加 4096 余量（`compaction-prefix.ts:23-29, 56-61`）；没有计入出口遮盖图例和占位符展开。若低估，共享摘要请求可能先被判为放得下，随后在 `admitPiStream` 里失败，而不是按设计“放不下就退回 Pi 默认请求”。【推测】
- **不可撤销操作**：产品代码没有在压缩期间强制拒绝工具调用，只依赖 Pi 的摘要流程不执行工具；`[COMPACT-3]` 只通过自定义 `SearchTools` 端口计数，未覆盖内置文件/命令/沙箱/句柄工具（见问题 2）。【读代码证实测试范围；Pi 是否保证不执行工具未核实】
- **规则/文档一致性**：`.claude/rules/prompt-prefix.md:60-61`、`docs/kv-cache-guide.md:68`、`docs/pi-development-guide.md:270` 与生产实现基本一致。**不一致点在 ADR 0207:51 与测试 947 行**：ADR 声称同一轮压缩“既有改写，也有退回”，但测试只断言存在 `false`，从未断言存在 `true`；作者说明里的“只证明存在 Pi 默认摘要请求”与 ADR 原文也不一致。

---

## 问题（按严重度）

### 1. 中：ADR 对 `[COMPACT-1]` 覆盖范围的描述强于测试实际证明的内容
- 文件:行：`docs/adr/0207-compaction-request-reuses-conversation-head.md:51`；`packages/runtime-pi/test/prompt-prefix.compat.test.ts:947`
- 问题：ADR 写“同一轮压缩既有改写的摘要请求，也有退回 Pi 默认的摘要请求……覆盖退路”，但本轮测试只新增了 `expect(shared).toContain(false)`，没有任何 `expect(shared).toContain(true)`。因此它只能证明至少有一条摘要请求没有共享开头；如果**全部**摘要请求都退回默认，测试仍通过。它也完全没有断言退回原因。
- 证据：
  - `docs/adr/0207...:51`：“`[COMPACT-1]` 里同一轮压缩既有改写的摘要请求，也有退回 Pi 默认的摘要请求（断言至少出现一条不共享开头的），覆盖退路”
  - `prompt-prefix.compat.test.ts:947`：`expect(shared).toContain(false);`
  - 作者说明：“断言改为 shared 里含 false，并如实说明只证明存在 Pi 默认摘要请求”——这与 ADR 的“既有……也有……”不一致。
- 补充推测：如果 `[COMPACT-1]` 的 `false` 来自拆分轮或切点找不到，那么同一段 ADR 后面“拆分轮、溢出、钩子里切点找不到这几种退回，没有单独的用例”也与实际间接覆盖相矛盾；具体是哪条退回分支，测试没有留下证据。
- 建议：若要保留 ADR 的说法，测试应断言实际序列，例如至少同时断言 `shared` 含 `true` 和 `false`，并尽量固定退回原因；否则把 ADR 改成“只证明存在未共享的摘要请求，不能证明同轮仍有共享改写，也不能证明退回原因”。

### 2. 中：`[COMPACT-3]` 只覆盖自定义工具端口，生产代码没有额外的“压缩期间禁止执行工具”防线
- 文件:行：`packages/runtime-pi/test/prompt-prefix.compat.test.ts:1037-1071`；`packages/runtime-pi/src/pi-runtime-adapter.ts:1495-1501, 1639-1668`
- 问题：测试名说“never runs a tool”，但实际只是把 `SearchTools` 包成 `CountingTools`，统计经产品 `execute` 端口发出的自定义工具调用。生产代码把完整的 `lastRequest.tools` 直接交给摘要请求，没有在产品侧设置“压缩请求禁止工具执行”的标记。若 Pi 升级后改变摘要请求的工具调用处理，或调用的是内置文件/命令/沙箱工具，本测试不一定能拦住。
- 证据：
  - 测试：`class CountingTools extends SearchTools { override async execute(...) { executed.push(...) } }`（`1038-1043`）
  - 测试只覆盖 `reminder_set`（`1058-1059`）
  - 生产代码在压缩时仍把 `lastRequest.context` 整体复用，包括 `tools`（`sharedSummaryContext` 的 `...lastRequest`，`compaction-prefix.ts:62-65`）
- 判断：测试能证明当前 Pi 的摘要路径不会把该自定义工具调用落到产品端口（读测试与适配器代码可证）；但“任何工具都不会执行”及“Pi 升级后仍安全”属于推测，未核实。
- 建议：在生产侧增加压缩请求的工具执行拒绝（例如把 `compacting` 状态传入工具执行入口并直接拒绝），或至少把内置文件写工具/沙箱工具纳入 `[COMPACT-3]` 的测试范围；并在 Pi 升级检查里明确锁定这一行为。

### 3. 低：`[COMPACT-3]` 没有验证压缩失败后对话内容没有被破坏/下一轮仍可继续
- 文件:行：`packages/runtime-pi/test/prompt-prefix.compat.test.ts:1048-1071`
- 问题：测试用 `conversation(..., false)` 关闭了最终事件断言，只检查 `shared[0]`、`executed` 和 `PI_COMPACTION_FAILED`。ADR 的后果写“失败……不改变对话内容”，但测试没有验证运行最终是失败还是继续、下一轮是否还能发请求。
- 证据：`await conversation(turns, ..., false)` 后直接进入 `expect(shared[0])...`；`conversation` 的 `expectCompleted` 参数在 `expectCompleted` 为真时才断言 `runtime.completed`。
- 建议：增加断言，例如最终事件类型、对话历史未被写入工具结果、下一轮仍能正常请求；这才能覆盖 ADR 的“失败不改变对话内容”。

### 4. 低：`sharedHead` 日志在准入之前写入，统计的是“尝试改写”而不是“实际发出的共享摘要请求”
- 文件:行：`packages/runtime-pi/src/pi-runtime-adapter.ts:1663-1668`；`apps/agent-service/src/service-main.ts:1884-1890`
- 问题：`onCompactionSummaryRequest` 在 `admitPiStream` 之前调用。预算准入失败、模型绑定失败、上下文窗口失败等情况下仍然会记录 `sharedHead: true`。ADR 说“生产里可以直接统计命中改写的比例”，但该日志实际统计的是尝试次数，可能高估。
- 证据：
  - `if (!summaryContext) lastRequest = ... else this.#dependencies.onCompactionSummaryRequest?.(request, { sharedHead: shared !== undefined });`
  - 下面才 `return admitPiStream(...)`
- 建议：把日志移到真正开始发出请求之后（或准入通过之后），或把字段改名为 `attemptedSharedHead` 并在文档里说明统计口径。

### 5. 低：窗口估算没有覆盖工具定义/图例/占位符的极端情况，且缺少针对 `compactionPrefixMessages` 退回分支的用例
- 文件:行：`packages/runtime-pi/src/compaction-prefix.ts:56-61`；`packages/runtime-pi/test/prompt-prefix.compat.test.ts:1260-1274`
- 问题：反向用例只测了历史为空、历史不一致、系统提示过大，没有用超大工具定义测窗口；也没有直接测试 `compactionPrefixMessages` 的拆分轮、溢出、切点找不到分支。当前生产代码在钩子异常时静默退回，因此这些分支如果写错，只会表现为“压缩请求不共享”，不会被直接测试点名。
- 证据：测试的窗口反向用例只构造 `compactUser("汉".repeat(30_000))` 和超长 `systemPrompt`，`tools` 始终为空；`compactionPrefixMessages` 没有对应 describe。
- 建议：增加 `compactionPrefixMessages` 的单元测试，至少覆盖 `reason: "overflow"`、`isSplitTurn: true`、`firstKeptEntryId` 不在 entries 中；窗口用例加入大工具定义。窗口估算若保留近似值，应在 ADR 里明确“近似值可能低估，最终由 `admitPiStream` 兜底”。

### 6. 低（文档细节）：作者称“增量只含测试和 ADR 文档”，但增量还包含 `.agents/reviews/pr-362/**` 复核记录
- 文件:行：`git diff 8045ffcc..4ee327a8 --stat`
- 问题：增量确实没有生产代码改动，但还新增了 `.agents/reviews/pr-362/round-1..4` 和 `usage.jsonl`。这不是功能问题，只是说法不精确。
- 建议：在说明里写成“测试、ADR 与复核记录”，避免复核者按“只有两个文件”核对时产生困惑。

---

## 必答问题

### 1. 改动会不会改变模型已经见过的请求开头？
**增量本身不会**：`8045ffcc..4ee327a8` 只改了测试和 ADR，生产代码未动（`git diff --stat` 已核对）。

就完整改动而言：
- 主对话链路仍然只在末尾追加；每轮会变的时间、记忆、运行环境仍放在最后一条用户消息（原有机制未改）。
- 压缩摘要请求是一个**独立的分叉请求**，不是主链路的下一轮：它复用上一次普通请求的系统提示、工具定义和切点之前的历史，末尾追加固定的 `COMPACTION_SUMMARY_INSTRUCTION`。它不会改写、重排或删除这个前缀；`sharedSummaryContext` 先逐条比较 `lastRequest.messages.slice(0, prefix.length)` 与钩子算出的 prefix，只有完全相同才改写（`compaction-prefix.ts:52-55`）。
- 严格说，它没有把上一次普通请求的**全部**内容原样保留后再追加，而是保留了切点之前的历史并丢掉切点之后的部分，再追加指令；这是 ADR 0207 / 规则第 13 条允许的压缩分叉，不是“对完整上一条请求的 append-only”。
- 压缩成功后，下一次普通请求的开头会变一次，这是规则第 12 条允许的压缩例外，ADR 也写明。
- 依据：`.claude/rules/prompt-prefix.md` 第 4、12、13 条；ADR 0207 第 2、3 条。

### 2. 会不会让同一段文字在不同请求里变成不同的字节？
**增量不会**（没有生产改动）。完整改动中，摘要请求的可变部分也做了固定：
- 指令来自 `COMPACTION_SUMMARY_INSTRUCTION`，固定文本；
- 追加消息的 `timestamp` 取 `history.at(-1)?.timestamp ?? 0`，不是当前时间（`compaction-prefix.ts:66-70`）；
- 系统提示、工具、历史直接复用上一次普通请求的对象，顺序不变；
- `sessionId`、`cacheRetention` 从 `lastOptions` 继承，不是每轮随机（`sharedSummaryOptions`）；
- 出口遮盖对同一段前缀重新执行，但规则是只依赖自身和前面内容，且新增指令来自提示词目录、属于固定文字，不会反过来改变前面已发内容的遮盖字节。
- 例外/风险：若上一次普通请求在准入阶段失败，`lastRequest` 仍可能指向一个从未真正发出的上下文（作者已承认）。这不会让同一段文字产生两种字节，但会让摘要请求以未发出的上下文作为“共享开头”，导致缓存不命中或与真实已发字节不一致。
- 未核实：Pi 是否对相同 `Context` 做额外可变序列化；仓库内没有 Pi 包源码，无法直接读 `compaction.js` / `agent-session.js`。

### 3. 有没有对应的自动检查，反向用例是否真的会失败？
- `[COMPACT-3]` 属于 `npm run check:prompt-prefix`（测试名带 `[I-66]`，`scripts/check-prompt-prefix.mjs` 会选中）。按代码，它会在以下情况失败：摘要请求没有被共享改写（`shared[0]` 非 `true`）、工具端口被执行、没有出现 `PI_COMPACTION_FAILED`。
- 但它**不是反向/变异用例**，而是正向行为测试；且如问题 2 所述，只覆盖自定义工具端口，未覆盖内置文件/沙箱/句柄工具；如问题 3 所述，未验证失败后的对话状态。
- `[COMPACT-1]` 新增的 `expect(shared).toContain(false)` 只会在一件事上失败：没有任何未共享的摘要请求。它不能证明 ADR 所说的“同轮既有共享又有退回”，也不能证明退回原因；如果所有摘要请求都退回默认，它仍通过。因此对问题 1 的覆盖是**偏弱**的。
- 前几轮加入的 `sharedSummaryContext` 单元反向用例是有效的：历史不一致、没有上一次请求、prefix 为空、窗口放不下时都断言 `undefined`；删掉对应的检查会失败。`sharedSummaryOptions` 只有正向用例；`compactionPrefixMessages` 的拆分轮/溢出/切点找不到没有直接用例。
- 我能读代码判断“哪些断言会失败”，但**没有运行测试**（工具限制），所以执行结果未实测。

### 4. 改动产生或修改的每个值，使用它的地方都能接受吗？
逐项核对如下：

| 值 | 产生处 | 使用处 | 结论 |
|---|---|---|---|
| `runtime.compaction.summary-instruction` | `packages/prompt-catalog/src/runtime.ts:236-278`；`prompt-manifest.json` 新条目 | `packages/runtime-pi/src/compaction-prefix.ts:3` 导入并使用；prompt-catalog 测试要求 manifest 有该 id 且 sha 匹配；`[I-78]` 全目录 egress 测试会遍历它 | 两端类型/命名一致；**sha256 是否匹配未核实**（无法运行哈希工具） |
| `COMPACTION_SUMMARY_INSTRUCTION.text` | 同上 | 作为摘要请求最后一条 user 消息；也进入 `trustedPromptTexts` 固定文字清单 | 文本不含日期/时间/哈希；未运行确认 egress 原样通过 |
| `onCompactionSummaryRequest` | `PiAgentRuntimeAdapterDependencies`（adapter:217） | `ProductionRunCompositionOptions`（composition:141-145）→ `createProductionRunComposition`（445-452）→ `service-main.ts:1884-1890` | 类型一致；`writeServiceDiagnostic` 接受 boolean；但服务层没有自动测试锁定这条 wiring |
| `sharedHead` | adapter:1666 `shared !== undefined` | 服务日志、`[COMPACT-1]`/`[COMPACT-3]` 测试 | 类型接受；语义是“尝试共享”，不是“实际发出”，见问题 4 |
| `compaction.summary_request` | service-main:1887 | `writeServiceDiagnostic` 接收任意 `event` 字符串；未发现其他解析器 | 接受；无消费端校验，也没有专门测试 |
| `PI_COMPACTION_FAILED` | adapter:1769 | `onModelStreamFailed` → 服务日志；`[COMPACT-1]`、`[COMPACT-3]` 测试 | 既有错误码，两端一致 |
| `sharedSummaryOptions` 的输出 | `compaction-prefix.ts:31-43` | `admitPiStream` 的 `options` 参数 | 它会删掉 Pi 摘要请求的 `cacheRetention`/`sessionId`，从 `lastOptions` 继承；类型接受 |
| `approximateTokens` / `4096` 余量 | `compaction-prefix.ts:23-29,56-61` | 仅 `sharedSummaryContext` 窗口判断 | 无外部消费者；估算精度是风险，不是接口不匹配 |

**结论**：未发现“产生端与使用端校验不一致”的 I-73 类问题；最大的未核实项是 manifest 的 sha256 与 Pi 源码行为。

---

## 未核实

- `@earendil-works/pi-coding-agent` / `pi-ai` 源码未安装、仓库内不存在，无法直接读 `compaction.js`、`agent-session.js` 验证：拆分轮是否发两次摘要、摘要路径是否绝对不执行工具、`session_before_compact` 与 `compaction_start` 的事件顺序。
- 未运行 `npm run check:prompt-prefix`、`npm run check:prompt-catalog`，因此 `[COMPACT-1]`/`[COMPACT-2]`/`[COMPACT-3]` 的实际通过情况和 manifest 哈希未实测。
- 服务端 `compaction.summary_request` 日志没有找到对应的自动化用例，wiring 通过读代码确认，未执行验证。
