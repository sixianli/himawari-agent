## 结论摘要
改动本身很小：只放行了 Pi 的“压缩摘要请求”，并把压缩失败日志改成 `loggableModelFailure`。核心安全边界（预算准入、出口遮盖）仍然经过，没有看到直接的数据泄露或越权。主要问题集中在两处：第二轮的“回落”改动没有任何自动检查；摘要请求仍按 `purpose: "chat"` 记账，会把压缩调用混进聊天缓存命中率/费用统计。

---

## 发现（按严重度从高到低）

### 1. 中：第二轮新增的“回落”逻辑没有测试，撤掉它现有用例仍会全绿
- 位置：`packages/runtime-pi/src/pi-runtime-adapter.ts:1621`
- 问题：这一轮唯一的行为改动是 `(compacting ? himawariSummaryContext(requested) : undefined) ?? himawariRequestContext(...)`。但两条 `[COMPACT-1]` 测试都只覆盖“压缩中无工具摘要请求成功/失败”，没有任何用例在 `compaction_start` 之后、`compaction_end` 之前发出带工具的请求；我在 `packages/runtime-pi/test` 下也搜不到任何测试使用 `compaction_start`。把这一行改回 a9af 的写法（`compacting ? himawariSummaryContext(requested) : himawariRequestContext(...)`），这两条用例仍会通过，只有真实 Pi 在压缩期间出现带工具请求时才会暴露。
- 证据：
  - `packages/runtime-pi/src/pi-runtime-adapter.ts:1621-1623`：
    ```ts
    const context =
      (compacting ? himawariSummaryContext(requested) : undefined) ??
      himawariRequestContext(requested, systemPrompt, requestTools);
    ```
  - `packages/runtime-pi/test/prompt-prefix.compat.test.ts:841-898` 两条 `[COMPACT-1]` 断言的是 `<conversation>` 摘要体、`PI_COMPACTION_FAILED`、`runtime.compaction_proposed`，没有断言压缩期间带工具请求走冻结工具。
- 建议：增加一条兼容测试：先注入 `compaction_start`，再让 `streamFunction` 收到带工具的 `TranscriptContext`，断言请求体使用冻结工具且不出现 `PI_REQUEST_TOOLS_DIVERGED`；反向用例是删掉 `?? himawariRequestContext(...)` 后该用例失败。

### 2. 中低：摘要请求按 `purpose: "chat"` 记账，压缩会把聊天缓存命中率和费用统计带偏
- 位置：`packages/runtime-pi/src/pi-runtime-adapter.ts:1052`、`:1104`
- 问题：摘要请求现在会真正发出去（此前带冻结工具时基本被拦），但仍以 `purpose: "chat"`、`source: "agent-stream"` 记入模型用量。`lowCacheHitRate` 只排除非 chat，因此后续对话里的压缩摘要请求会被当成普通聊天请求；它的系统提示与主线不同，命中率通常很低，从而触发假的 `cache.follow_up_low_hit`。每轮按 purpose/run 统计费用时也会把整段对话再算一次。
- 证据：
  - `packages/runtime-pi/src/pi-runtime-adapter.ts:1052-1054`：`source: "chat"`, `purpose: "chat"`
  - `packages/runtime-pi/src/pi-runtime-adapter.ts:1099-1105`：`record({ ..., purpose: "chat", source: "agent-stream" })`
  - `packages/application/src/ports/model-usage.ts:47-56`：只有 `observation.purpose !== "chat"` 时才返回 `null`，否则计算低命中率
  - `apps/agent-service/src/cache-hit-monitor.ts:25-39`：低命中且 `isFollowUpTurn` 时上报
  - 作者说“要新增 purpose 值和迁移，计划第 2 步改为 other”不准确：`MODEL_USAGE_PURPOSES` 已有 `"other"`（`packages/application/src/ports/model-usage.ts:11`），迁移 `0068_model_usage_observations.sql:6-10` 也已允许 `'other'`，改成 `other` 不需要新迁移，只需把 `compacting` 传进 `admitPiStream`/`recordUsage`。
- 建议：至少先把压缩摘要请求记为 `other`（或新增专门值并同步迁移），或在缓存监控中排除压缩请求；否则上线后每次压缩都会产生一条误导性的低命中日志。

### 3. 中低：`[COMPACT-1]` 没有验证压缩后的主对话仍按冻结头追加，也没验证压缩后重试使用冻结工具
- 位置：`packages/runtime-pi/test/prompt-prefix.compat.test.ts:841-872`
- 问题：整个文件的主题是 prompt-prefix，但这条新用例只检查摘要请求的形状和 `compaction_proposed` 事件，没有对压缩后的正常请求调用 `findPrefixBreak`/比较工具列表。压缩是唯一会合法改写历史的前缀事件，恰恰最需要证明“压缩之后又恢复只追加、工具仍是冻结的那份”。
- 证据：`packages/runtime-pi/test/prompt-prefix.compat.test.ts:860-871` 只断言 summary 数量和事件类型，没有任何 `findPrefixBreak` 或 `tools` 断言；而辅助函数 `findConversationBreak` 就在同文件 `:23` 导入。
- 建议：在压缩成功后，取压缩后的两条正常请求（重试请求和下一轮）单独比较前缀字节，并断言其 `tools` 等于冻结工具；反向用例可让“压缩后重试”错误使用摘要系统提示或空工具。

### 4. 低（部分推测）：`compacting` 是单个布尔值，且“无工具”被当成摘要请求的唯一判据
- 位置：`packages/runtime-pi/src/pi-runtime-adapter.ts:669`、`:1621`、`:1663`
- 问题：`compacting` 只在 `compaction_end` 时复位。作者在 commit 里自己写了“避免 compaction_start 无配对结束时拦死后续请求”，说明无配对的场景被认为可能发生。若真发生，后续“无工具”的普通请求仍会走 `himawariSummaryContext`，改用 Pi 的第一条 system 消息和 `tools: []`；在冻结工具非空、而 Pi 当前工具为空的异常分歧场景下，这会绕过 `PI_REQUEST_TOOLS_DIVERGED` 把请求发出去。正常无工具请求的 `first.content` 通常等于冻结 `systemPrompt`，所以实际影响有限，这一节属于推测。
- 证据：
  - `packages/runtime-pi/src/pi-runtime-adapter.ts:669-677`：只判断 `getCurrentTools(...).length > 0`，满足就取 `first.content` 和 `tools: []`
  - `packages/runtime-pi/src/pi-runtime-adapter.ts:1663-1665`：只在 `compaction_end` 复位
  - `git log` 的 b816e286 提交说明：`避免 compaction_start 无配对结束时拦死后续请求`
- 建议：在 run 的 `finally` 里显式复位或改为每次 `streamFunction` 调用前由事件状态推导；更稳妥的判据是同时识别 Pi 的摘要 system prompt（或显式的 compaction 原因），而不是仅凭“没有工具”。

### 5. 低：文档与作者说明有几处与代码不完全一致
- 位置：`docs/adr/0165-freeze-the-request-head-per-conversation.md:90`、`.claude/rules/prompt-prefix.md:60-61`、`packages/runtime-pi/src/pi-runtime-adapter.ts:436-446`
- 问题：
  - ADR 0165 说“压缩请求原样放行”，但代码现在会经 `himawariSummaryContext` 重组，并在 `withPlaceholderLegend` 里给摘要系统提示追加出口遮盖图例；语义上保留了 Pi 的摘要提示，但不是字面上的“原样”。
  - 规则 13 要求压缩请求沿用原对话系统提示和工具；新测试 `prompt-prefix.compat.test.ts:864-866` 反而固定了“无 tools + Pi 自己的摘要系统提示”。这是已记录的 known gap（`BL-20261109-8w6ct3`），但测试应注明待办，否则以后修规则 13 时容易被这条测试挡住。
  - 作者说“测试断言 message 只能是 provider_status_NNN 或 provider_message_withheld”，但 `loggableModelFailure` 还有三个原样放行的分支：`"Model invocation "` 前缀、`"Model budget accounting is unavailable"`、`PI_REQUEST_TOOLS_DIVERGED`。这三条都是本地安全文案，不构成泄露，但断言与实现不完全一致。
- 证据：
  - `packages/runtime-pi/src/pi-runtime-adapter.ts:436-446`：
    ```ts
    if (
      message.startsWith("Model invocation ") ||
      message === "Model budget accounting is unavailable" ||
      message === PI_REQUEST_TOOLS_DIVERGED
    )
      return message;
    ```
  - `packages/runtime-pi/test/prompt-prefix.compat.test.ts:864-866` 断言 `tools` 为 `undefined` 且系统消息含 `"context summarization assistant"`。
- 建议：在测试或注释里引用 `BL-20261109-8w6ct3`；ADR/说明改成“压缩摘要请求走 Pi 自己的摘要提示，不沿用对话头”，并把 `loggableModelFailure` 的三个放行分支写清楚。

### 6. 低（推测）：失败摘要请求可能被重复上报两种 code，测试也没有锁定完整集合
- 位置：`packages/runtime-pi/src/pi-runtime-adapter.ts:1666-1670`、`:2225-2230`
- 问题：如果 Pi 也把内部摘要请求的失败作为一条 `message_end`（`stopReason === "error"`）发给订阅者，那么同一次失败会同时产生 `PI_MODEL_UNAVAILABLE`（或 `PI_MODEL_ERROR`）和 `PI_COMPACTION_FAILED` 两条 `model.stream_failed` 日志。新测试只用 `failures.find(...)` 找 `PI_COMPACTION_FAILED`，不检查 `failures` 的完整内容，因此重复上报或漏报都不会被发现。Pi 是否对摘要请求发 `message_end`，我没有源码可核实。
- 证据：`packages/runtime-pi/test/prompt-prefix.compat.test.ts:895-897` 使用 `find`；`pi-runtime-adapter.ts:2225-2230` 对任意 assistant `message_end` 的 `stopReason === "error"` 都会上报。
- 建议：测试改为断言失败集合的准确内容，或在 `compaction_end` 上报前确认该失败尚未通过 `message_end` 报过。

---

## 侧重检查（错误路径 / 不合规输入 / 安全 / 资源 / 不可逆操作 / 文档）
- **错误路径**：摘要请求失败时仍走 `admitPiStream` 的准入与出口遮盖，`onModelStreamFailed` 只写诊断，不进入用户可见的 `runtime.failed`；日志文案改为 `loggableModelFailure`，符合 I-44 的“不写供应商原文”约定（`pi-runtime-adapter.ts:1666-1670`、`apps/agent-service/src/service-main.ts:1884-1891`）。
- **不可信输入**：`himawariSummaryContext` 对第一条 system 消息要求 `typeof first.content === "string"`，否则回落（`:672`）；`event.errorMessage` 被当作 string 使用，没有运行时类型校验，但这是既有模式。
- **安全边界**：摘要请求没有绕过预算、出口遮盖或分类检查——它仍调用 `admitPiStream({...request, dataClassification: this.#visibleOf(request)}, ..., bundle?.redactionRuleset)`（`:1634-1648`、`:1048-1055`）。未发现新增的明文外泄路径。
- **资源耗尽**：摘要请求会把整段对话发给模型，且会新增一次模型调用；`clampMaxTokensToContext` 只限制输出 token，不限制输入大小，实际由 Pi 的触发阈值兜底，这一点我没有 Pi 源码可核实（未核实）。
- **不可逆操作**：压缩会改写历史/追加 `context_edit`，属于规则 4/12 允许的压缩例外，摘要也仍以 `proposeCompaction` 保存（`:2293-2309`）；但该改动是让这条此前在冻结工具下走不通的路径真正生效，上线前应确认 ADR 记录齐全。
- **文档一致性**：ADR 0165:90、规则 13、BL-20261109-8w6ct3 与代码大体一致，但“原样放行”措辞和新测试固定 known gap 两点如上；作者提到的 ADR 0201 目前不存在（`docs/adr` 下只有 0199、0200），属于后续计划，未核实。

---

## 必答问题

**1. 会不会改变模型已经见过的请求开头？**
- 普通（非压缩）请求：不会。`himawariRequestContext` 未被改动（`pi-runtime-adapter.ts:652-667`），系统提示、工具、历史仍来自冻结 bundle；每轮变化值仍在最后一条用户消息里（本次改动没有触碰该逻辑）。
- 但这次改动会让“自动压缩”在冻结工具下真正成功。压缩成功后 Pi 会用摘要替换/移除前面的历史（`compactionSummary`/`context_edit`），所以压缩点之后的主对话请求不再是压缩前请求的字节前缀。这是规则第 4、12 条允许的压缩例外（并指向 ADR 0198）；在本次改动前该摘要请求在冻结工具下被 `PI_REQUEST_TOOLS_DIVERGED` 拦住，因此“这个例外真正开始发生”是本次改动的直接结果，应在上线说明中写明。
- 摘要请求本身不是“末尾追加”：新测试明确断言它不带工具、使用 Pi 自己的摘要系统提示（`prompt-prefix.compat.test.ts:864-866`），不沿用原对话开头。这是规则 13 的既有已知差距，不是本次新增，但本次让它被实际执行。
- 结论：不能笼统回答“仍然只在末尾追加”。非压缩路径是；跨压缩点不是，属于有 ADR 依据的压缩例外。

**2. 会不会让同一段文字在不同请求里变成不同字节？**
- 本次 diff 没有引入新的不确定性：`himawariSummaryContext` 只取第一条 system、按原顺序保留其余消息，没有时间、随机数、Set/Map 遍历排序（`:669-677`）。出口遮盖的 exchange 是每个请求新建的（`packages/application/src/services/model-egress.ts:524-526`），摘要请求不会改变后续请求的遮盖字节。
- 会变的是压缩摘要内容本身（模型输出）以及 Pi 对压缩请求的序列化方式；这是压缩固有行为，不是本 diff 引入的“同段文字因前后文而不同”。Pi 内部是否包含时间等字段，我没有源码可核实（未核实）。

**3. 有没有对应的自动检查？反向用例真的会失败吗？**
- 摘要成功、摘要失败两条 `[COMPACT-1]` 有测试。按代码推断：删掉 `himawariSummaryContext`，摘要请求会在 HTTP 前被 `PI_REQUEST_TOOLS_DIVERGED` 拦住，`summaries.length` 为 0，第一条失败；删掉 `PI_COMPACTION_FAILED` 上报，第二条找不到该 code；把 `loggableModelFailure` 改回原文，第二条的 `provider_(status_...|message_withheld)` 正则也不匹配（原始错误会以 `503` 或供应商文字开头）。这三类反向用例应会失败，但未在本环境实际运行（依赖未安装，未核实）。
- 第二轮新增的“回落”没有测试，也没有反向用例：现有两条 `[COMPACT-1]` 在撤掉 `?? himawariRequestContext(...)` 后仍会通过（见发现 1）。这是明确的自动检查缺口。
- 另外缺少压缩后主对话“继续只追加”及“重试仍用冻结工具”的断言（见发现 3）。

**4. 改动产生/修改的每个值，使用它的地方都能接受吗？**
- `"PI_COMPACTION_FAILED"`：产生于 `pi-runtime-adapter.ts:1668`，唯一消费者是 `apps/agent-service/src/service-main.ts:1884-1891` 的诊断日志；类型是 `string`，没有白名单校验，可接受。仓库里没有把它当 `runtime.failed`/UI 错误码使用（已搜 `PI_COMPACTION_FAILED`，仅测试和这里）。
- `loggableModelFailure` 的返回值：`provider_status_NNN`/`provider_message_withheld` 以及三个本地放行字符串都只进同一诊断日志，不泄露供应商原文；但作者“只能是前两种”的说法不准确（见发现 5）。
- `context`（`systemPrompt` 来自 Pi 摘要提示、`tools: []`）：消费端是 `normalizeContext` + `admitPiStream`，仍过准入、出口遮盖和 token 上限，结构可接受。
- `purpose: "chat"`：`MODEL_USAGE_PURPOSES` 和 SQLite 迁移都接受 `"chat"`，但语义消费端（缓存命中监控、按 purpose 统计）会把压缩摘要请求当普通聊天请求，产生发现 2 的偏差；`"other"` 已存在且迁移已允许，改成它比其他方案成本更低。
- `compacting` 布尔、测试里的 `PROMPT_TOKENS` 全局：前者不序列化，后者只影响测试，没有生产使用方问题。
- 未核实的值：`compaction_end.errorMessage` 的实际格式、Pi 是否对摘要请求发 `message_end`、`compaction_start` 是否总与 `compaction_end` 配对——本仓库是 sparse checkout，没有 `node_modules/@earendil-works` 源码，无法确认。
