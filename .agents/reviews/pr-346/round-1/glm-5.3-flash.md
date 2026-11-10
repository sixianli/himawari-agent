# 代码复核报告（PR 346，a9af0f75）

## 发现的问题（按严重度从高到低）

### 1.（中）`packages/runtime-pi/src/pi-runtime-adapter.ts:1666-1670` — PI_COMPACTION_FAILED 的 message 未清洗，可能与 I-44 的日志原则冲突
**问题**：新增的压缩失败上报把 `event.errorMessage` 原样写进 `model.stream_failed` 服务日志；而同类路径（模型流失败，2225-2231 行）刻意用 `loggableModelFailure` 把供应商原文收敛成固定本地原因或状态码。压缩失败恰恰源于对供应商发出的摘要请求（503 等），errorMessage 很可能携带供应商返回内容。
**证据**：
```ts
1667:  this.#dependencies.onModelStreamFailed?.(request, {
1668:    code: "PI_COMPACTION_FAILED",
1669:    message: event.errorMessage,      // 原样透传，未过 loggableModelFailure
```
对比 `2227-2230`：`message: loggableModelFailure(event.message.errorMessage)`。
`service-main.ts:1884-1891` 把 `failure.message` 原样写日志。I-44 的修复承诺「模型流失败写 `model.stream_failed` 日志，只含固定的本地原因或状态码，不含供应商原文」（docs/incidents-and-gates.md:82）。
**建议**：对 `event.errorMessage` 过一遍 `loggableModelFailure`（或至少在测试中断言 message 不含供应商原文）；若 pi 1.5.0 的 `compaction_end.errorMessage` 只含本地文本，在注释/ADR 里写明依据。
**读代码证实**：透传路径与两条路径的不一致；**推测**：pi 是否真会把供应商原文放进 `compaction_end.errorMessage`（`node_modules/@earendil-works/pi-coding-agent` 不在本次 sparse checkout 里，库源码未核实）。

### 2.（中低）`packages/runtime-pi/src/pi-runtime-adapter.ts:1621-1623` — compacting 期间无回退，异常事件序列会把普通请求也拦死
**问题**：`compacting` 为 true 时只尝试 `himawariSummaryContext`；它对「带工具的请求」返回 undefined（670 行），于是普通请求会以 PI_REQUEST_TOOLS_DIVERGED 被拒——而改动前这些请求本可发出。若 pi 出现 `compaction_start` 后没有配对 `compaction_end` 的异常序列（中断、崩溃边缘），同一 run 后续所有请求一次都发不出去。
**证据**：
```ts
1621:  const context = compacting
1622:    ? himawariSummaryContext(requested)
1623:    : himawariRequestContext(requested, systemPrompt, requestTools);
```
`670: if (getCurrentTools(requested.messages).length > 0) return undefined;` → `1627: if (!context) return failedPiStream(model, PI_REQUEST_TOOLS_DIVERGED);`
**建议**：改为 `compacting ? (himawariSummaryContext(requested) ?? himawariRequestContext(requested, systemPrompt, requestTools)) : himawariRequestContext(...)`，或按「有无工具」而不是按事件标志分流；并补一条 `compaction_start` 后跟普通带工具请求的反向用例。
**读代码证实**：分支结构本身；**推测**：pi 是否真会产生不配对的 `compaction_start`（事件源码未核实）。

### 3.（低）压缩成功后的请求开头变化首次变得可达，且无逐字节正向检查
**问题**：改动前压缩摘要请求全被拒（生产压缩从未成功过），压缩后「换头」路径（2293-2309 的 `compaction_proposed`、1693-1704 的 steer 追加、下一轮以摘要替代历史）从未真正走到。本 PR 首次在生产启用它，但 COMPACT-1 两条测试对压缩后的普通请求没有任何前缀断言，`findConversationBreak` 也没有跑过压缩场景。作者承认「那是后续 PR」——如实，但这是本次改动带来的新暴露面，需记录在案。
**证据**：测试 `prompt-prefix.compat.test.ts:833-864` 只断言 `summaries` 内容、`failures` 为空、出现 `runtime.compaction_proposed`；无 `findConversationBreak(bodies)`。
**建议**：在后续 PR 落地前，至少在 incidents-and-gates.md 或 ADR 0198 里记录「压缩例外已首次在生产可达，前缀检查覆盖待补」。

### 4.（低）文档与代码不一致：ADR 0198 仍写「不一致就不发这次请求」，无任何文档记录压缩例外
**问题**：docs/adr/0198-upgrade-pi-to-1-5-0.md:50 写「Pi 当前能执行的工具名必须和我们声明的工具名一致，不一致就不发这次请求（`PI_REQUEST_TOOLS_DIVERGED`）」，现在无工具的压缩摘要请求是明确例外；`docs/` 全目录 grep `PI_COMPACTION_FAILED`/`compaction_start` 无结果，incidents-and-gates.md 也没有本次改动的门槛条目。
**建议**：补一条 ADR 或在 0198/0165 里追加例外说明与门槛（两条 COMPACT-1）。

### 5.（低）失败上报条件留有缺口，测试断言偏弱
**问题**：`1666` 行要求 `event.result === undefined && !event.aborted && event.errorMessage` 三者同时成立才上报；若 pi 以「无结果、未中止、无 errorMessage」收尾，仍然静默。测试 2 只断言 `failures.map(code)` 含 PI_COMPACTION_FAILED，不校验 message、不校验 run 事件序列。
**证据**：`1666: if (event.result === undefined && !event.aborted && event.errorMessage)`；测试 `prompt-prefix.compat.test.ts:866-889`。
**建议**：`errorMessage` 缺失时至少上报固定文本（如 "compaction ended without result"）。

## 侧重检查

走了一条最普通的使用流程：owner 发消息 → `service-main.ts` 组装依赖（onModelStreamFailed 在 1884 行）→ `PiAgentRuntimeAdapter.run` → `resolveProjection` → 建 Pi session、替换 `streamFunction`（1620）→ `admitPiStream`（941：准入 permit、`withPlaceholderLegend`、egress.exchange 遮盖 1048-1055、用量记录 1093-1118）→ 事件映射（2193-2245、2293-2310）→ `captureHistory`（1672-1690）→ 下轮 `nativeHistory` 回放（701-703）。
- **已测覆盖**：普通多轮/工具/遮盖/称呼/记忆日期（同文件既有用例）；本次两条 COMPACT-1 覆盖「压缩摘要放行」「压缩失败上报」。
- **无测试覆盖的路径**：① 压缩后下一轮的投影恢复与前缀行为（测试的 `ConversationProjection.proposeCompaction` 只是 stub，145-147 行，不回放 compaction）；② `compaction_start` 无 `compaction_end` 的分支（1621-1623）；③ PI_COMPACTION_FAILED 的 message 内容；④ `runtimeEnvironmentAfterCompaction` 的 steer（1693-1704，COMPACT-1 场景无 context blocks，未必触发）。
- 作者称「apps/agent-service 有 108 条失败，在 main 上同样失败」：**未核实**（我不能运行测试）。

## 必答问题逐条

**1. 会不会改变模型已见过的请求开头？** 不会。`compacting=false` 时走原 `himawariRequestContext`，diff 未动它；压缩摘要在改动前因 660-661 行工具不一致被 `1627` 拦成 `PI_REQUEST_TOOLS_DIVERGED`，一次都没发出去过——所以新放行的摘要请求是「新增请求」，不存在被改写的已见开头；每轮会变的值（时间、记忆、本轮提问）仍在原路径最后一条消息里。**但要注意**：压缩一旦成功，同一 run 内压缩后的普通请求会第一次真的换头（见问题 3），作者已声明为后续 PR。`.claude/rules/prompt-prefix.md` 本身不在本次检出内，规则第 12 条「压缩例外」原文**未核实**（ADR 0198:55、ADR 0165:103 间接印证例外存在）。

**2. 会不会同段文字不同字节？** 未见此风险。`himawariSummaryContext`（669-678）对消息数组保序 filter、取第一条 system 做系统提示，纯确定性；`compacting` 只由会话事件序列决定，不依赖时间或无序集合；摘要请求仍走 `admitPiStream` 的确定性出口遮盖（1048-1055，规则版本随冻结 bundle 固定）。**未核实**：Pi 自带摘要系统提示文本是否恒定（库源码缺失），测试只断言它含 "context summarization assistant"。

**3. 有没有自动检查、反向用例会不会失败？** 有：两条 [COMPACT-1] 在 `prompt-prefix.compat.test.ts`（I-66 门槛文件，属 `check:prompt-prefix`）。逻辑推演：无修复时摘要请求走 `himawariRequestContext` → 660-661 返回 undefined → 1627 拒发，测试 1 的 `summaries.length > 0` 失败；`PI_COMPACTION_FAILED` 字符串只在新增分支产生，测试 2 失败。**未核实**：未能实际执行测试（工具受限）。

**4. 产生的每个值，使用端都能接受吗？** 新值只有 `PI_COMPACTION_FAILED`（1668）与测试辅助变量 `PROMPT_TOKENS`（仅测试内）。`PI_COMPACTION_FAILED` 唯一消费点是 `onModelStreamFailed` → `service-main.ts:1884-1891` 原样写 `model.stream_failed` 日志，无白名单校验（全仓 grep 无其他消费点），两端核对无校验拒绝风险；但 message 未经清洗，见问题 1。测试端消费于 849/871 行，可接受。`himawariSummaryContext` 产出的 `Context`（systemPrompt/tools/messages）进入 `admitPiStream` 的 `normalizeContext(withPlaceholderLegend(...))`（974 行），与普通请求同一条校验链，两端一致。

**作者说法核对结果**：①「仍走 admitPiStream（预算准入、出口遮盖、用量记录）」——属实（1620-1648）；②「没有改变任何普通对话请求」——属实（普通路径代码未动，压缩窗口内带工具请求仍被拒）；③「没有让压缩请求沿用原开头；那是后续 PR」——属实；④「service-main.ts 已把 PI_COMPACTION_FAILED 写成 model.stream_failed 日志」——属实但**未清洗 message**（问题 1）；⑤「撤掉修复后两条测试都失败」——逻辑推演成立，未实测；⑥「apps/agent-service 108 条失败在 main 上同样失败」——未核实。
