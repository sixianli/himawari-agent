## 读代码证实的发现（按严重度）

**1. 中 — `packages/runtime-pi/src/pi-runtime-adapter.ts:723-730`：窗口估算对中文是低估，不是“保守”，且漏算发送时追加的占位符说明**

证据：
```ts
const fixedChars =
  (lastRequest.systemPrompt?.length ?? 0) +
  JSON.stringify(lastRequest.tools ?? []).length +
  COMPACTION_SUMMARY_INSTRUCTION.text.length;
const estimated =
  history.reduce((total, message) => total + estimateTokens(message), 0) +
  Math.ceil(fixedChars / 3);
```
`withPlaceholderLegend` 在真正发送时还会给系统提示追加 `EGRESS_PLACEHOLDER_LEGEND_WITH_RESTORE`（`packages/runtime-pi/src/egress-context.ts:15-20`），这部分没算。更重要的是，系统提示和工具说明大量是中文，按 3 字符/token 估是乐观而不是保守。后果是本该退回 Pi 默认请求的场景可能被放行，进入 `admitPiStream` 后才被窗口检查拒绝，导致这次压缩失败而不是退路（这一层是推测）。现有测试用的中文系统提示很短，覆盖不到。

建议：系统提示、工具、指令和占位符说明都用 `estimateTokens` 或直接对 `withPlaceholderLegend(context)` 之后的最终 context 估算；补一条中文大提示词、接近窗口边界的用例。

**2. 中 — `packages/runtime-pi/src/pi-runtime-adapter.ts:1699-1709` 与 `packages/runtime-pi/test/prompt-prefix.compat.test.ts:981-1026`：新增的 `cacheRetention`/`sessionId` 改写完全没有自动检查**

证据：
```ts
const { cacheRetention: _dropped, sessionId: _droppedSession, ...rest } = options ?? {};
options = {
  ...rest,
  ...(lastRequest?.options?.cacheRetention === undefined
    ? {}
    : { cacheRetention: lastRequest.options.cacheRetention }),
  ...(lastRequest?.options?.sessionId === undefined
    ? {}
    : { sessionId: lastRequest.options.sessionId }),
};
```
`[COMPACT-2]` 只解析请求体并比较 `tools` 和 `messages`，没有任何地方检查请求选项。作者也承认测试夹具看不到请求选项。这是本改动收益的核心（Magpie 会话亲和、缓存保留策略），写错会静默退化成“能发但吃不到缓存”，测试不会失败。

建议：用假的 `modelRuntime`/`streamSimple` 捕获 `options`，断言摘要请求拿到上一次普通请求的 `cacheRetention`/`sessionId`，并且 Pi 自己摘要请求的 `"none"`/`sessionId` 被丢掉；加一条反向用例。

**3. 中 — `packages/runtime-pi/src/pi-runtime-adapter.ts:698-704、718-730` 与测试 `981-1026`：新加的多个退路条件没有专门用例**

证据（条件本身）：
```ts
if (event.reason !== "manual" && event.reason !== "threshold") return undefined;
if (event.preparation.isSplitTurn) return undefined;
...
if (cut <= 0) return undefined;
...
if (history.length !== prefix.length || !isDeepStrictEqual(history, prefix)) return undefined;
...
if (estimated + COMPACTION_REQUEST_ROOM_TOKENS + maxTokens > contextWindow) return undefined;
```
作者说明已承认：拆分轮、溢出、对不上、放不进窗口各自没有用例；工具调用/工具结果历史的 COMPACT 用例也没有。`[COMPACT-1]` 只是间接看到“出现了一个 Pi 默认摘要”，没有断言“这次压缩没有被改写”或断言退回原因。若有人误删 `reason` 允许清单或窗口判断，尤其是溢出场景被错误改写，现有测试不一定失败，而压缩失败可能让长对话卡死（I-92 同类后果）。

建议：这两个函数是纯函数，可直接单测：非 manual/threshold、`isSplitTurn`、`firstKeptEntryId` 找不到/在 0、与上一次请求不一致、各类窗口边界都必须返回 `undefined`；再补一条带工具调用/工具结果历史的正常改写用例。

**4. 低 — `packages/runtime-pi/src/pi-runtime-adapter.ts:1685-1697`：`sharedSummaryContext` 没有兜底异常，和钩子的处理不一致**

证据：钩子里有 `try/catch`（`1541-1547`），但主路径：
```ts
const shared =
  summaryContext && lastRequest
    ? sharedSummaryContext(lastRequest.context, compactionPrefix, model.contextWindow, ...)
    : undefined;
```
`sharedSummaryContext` 里的 `JSON.stringify(lastRequest.tools ?? [])`、`estimateTokens`、`isDeepStrictEqual` 若抛错，会直接让本次摘要请求失败，而不是退回 `summaryContext`。这会把一个“本可退回 Pi 默认请求”的情况变成压缩失败。

建议：在 `sharedSummaryContext` 内部或调用处包 `try/catch`，出错时返回 `undefined`，保留默认压缩路径，并记录一次可观察的降级原因。

**5. 低 — `packages/runtime-pi/src/pi-runtime-adapter.ts:1541-1547`：钩子的 `catch` 完全静默**

证据：
```ts
try {
  compactionPrefix = compactionPrefixMessages(event);
} catch {
  compactionPrefix = undefined;
}
```
一旦 Pi 的 `branchEntries`/`buildSessionProjection` 语义变化，功能会静默退化为全价默认压缩，没有任何日志、指标或用例能看出“退路发生了”。建议至少记录一个计数/日志；这与找问题 3 的退路用例可以一起补。

**6. 低 — `packages/runtime-pi/test/prompt-prefix.compat.test.ts:1016-1019` 与 `docs/adr/0207-...md:51`：测试用结构化相等，不是“逐字节相同”**

证据：
```ts
expect(summary.tools).toEqual(normal.tools);
expect(summary.messages.slice(0, -1)).toEqual(
  normal.messages.slice(0, summary.messages.length - 1),
);
```
`toEqual` 不验证 JSON 键顺序和实际字节；本文件已有的 `findPrefixBreak` 才会比较原始字节（`packages/runtime-pi/test/helpers/prompt-prefix.ts:17-21、45-56`）。ADR 说“逐字节相同”，用这条断言来支撑略强。建议改成复用 `findPrefixBreak` 或直接截取原始 body 的 messages 前缀比较；注意摘要请求本身会截断尾部，不能直接整段调用普通前缀检查。

## 推测 / 未核实

- **摘要范围重建方式**：代码用 `buildSessionProjection(event.branchEntries)` 重建切点前的消息（`pi-runtime-adapter.ts:700-706`），而 `docs/pi-development-guide.md:256-258` 显示 Pi 事件本身带 `preparation.messagesToSummarize`。`branchEntries` 是否等同于 Pi 内部使用的 `pathEntries`、`messagesToSummarize` 是否与“切点前全部消息”一致，本次环境没有 `node_modules`，**未核实**。如果两者不一致，当前代码仍可能因为“是上一次请求的前缀”而通过检查，但总结的并不是 Pi 打算删除的那段历史，存在丢失信息的设计风险。
- **摘要请求里模型返回工具调用是否真的不会执行**：ADR 说 Pi 把它当失败；Pi 1.5.0 源码未能在本环境核对，**未核实**。
- **prompt manifest 新增条目的 `sha256`** 是否等于 `JSON.stringify(segments)` 的 SHA-256：本环境只能读文件、不能计算哈希，**未核实**。若不一致，`npm run check:prompt-catalog` 会失败。
- **`[COMPACT-1]` 为什么当前“没有被改写”**：测试只看到 Pi 默认摘要存在，没有断言退回原因，也没有断言没有改写；具体触发点和切点差异**未核实**。

## 侧重检查

- **错误路径**：钩子有 `try/catch`；主路径 `sharedSummaryContext` 没有（见发现 4）；窗口估算失败只会返回 `undefined`，不会抛错。
- **不合规范/不可信输入**：`reason`、`isSplitTurn`、`firstKeptEntryId`、`branchEntries` 都来自 Pi 事件，不是终端用户直接输入；`firstKeptEntryId` 找不到返回 `undefined`。用户内容只经历史进入，仍走同一套出口遮盖。
- **安全**：摘要请求仍走 `admitPiStream`，同一出口遮盖和预算准入；工具定义只是此前已发给模型的内容，未新增披露；固定指令来自提示词目录，不拼接用户输入。摘要请求若被模型返回工具调用，按 ADR 不会执行（Pi 内部行为未核实）。出口遮盖是逐消息向前生效的（`packages/sensitive-capture/src/redaction.ts:411-425`），截掉尾部不会改变前缀消息的遮盖结果。
- **资源耗尽**：窗口估算偏低估（见发现 1）；摘要请求最多包含切点前历史加完整工具定义，未发现额外无界循环。
- **不可撤销操作**：压缩本身会替换历史；本次改动改变摘要请求形态，可能影响摘要质量，ADR 已承认需要付费评测；没有发现新增的删除/覆盖操作。
- **规则、说明文档与代码一致性**：`.claude/rules/prompt-prefix.md:60-61`、`docs/kv-cache-guide.md` 第 13 条、`docs/adr/0207`、`docs/backlog/BL-20261109-8w6ct3...`、I-92 的措辞与代码的 `reason` 允许清单、切点范围、退路条件基本一致；两处表述偏强：“按 3 字符一个 token 保守估”和“逐字节相同”。

## 必答问题

**1. 会不会改变模型已经见过的请求开头？**
正常对话请求的组装没有改：系统提示、工具定义、历史仍走原来的 `himawariRequestContext`；本轮会变的时间、记忆、环境说明仍在最后一条用户消息里。摘要请求是旁路请求：它复用上一次普通请求的系统提示、工具和切点之前的消息，只在末尾追加固定指令，没有改写已发内容。需要说明的是，它相对上一次普通请求是“取前缀再追加”，会丢掉切点之后的消息，不是整段消息列表的严格末尾追加；这不改变会话里已发出的内容，缓存仍能命中共同前缀。压缩成功后下一次普通请求开头会变，这是规则第 12 条允许的既有例外，ADR 也写明了。

**2. 同一段文字会不会在不同请求里变成不同字节？**
读代码未发现本次新增的不确定性：指令是提示词目录里的固定文本；追加消息的 `timestamp` 取历史最后一条（`history.at(-1)?.timestamp ?? 0`），不是当前时间；复用的前缀消息是同一批对象；出口遮盖密钥在进程内稳定、规则只依赖当前消息和前面消息（`redaction.ts:411-425`），截掉后面的消息不会改变前缀的遮盖结果；`cacheRetention`/`sessionId` 不影响请求体字节。`withPlaceholderLegend` 每次追加的是固定文本。唯一需要保持的前提是：出口遮盖密钥和规则集不变，且 Pi 的序列化对同一消息对象稳定——这两点属于既有前提，本次未改变。

**3. 有没有对应的自动检查，反向用例是否真的会失败？**
有正向检查：`[COMPACT-2]` 在 `npm run check:prompt-prefix` 覆盖范围内（测试位于 `[I-66]` describe 下，脚本按 `[I-66]` 过滤，`scripts/check-prompt-prefix.mjs:8-27`）。撤掉改写后不会出现带 `Do NOT continue it` 的请求，过滤结果为空，这条用例会失败——这一点读断言可以确认。但反向/退路覆盖不足：拆分轮、溢出、对不上、放不进窗口、工具调用/工具结果历史都没有专门用例；`cacheRetention`/`sessionId` 没有断言；`[COMPACT-1]` 只是间接看到 Pi 默认摘要存在，没有断言退回原因。因此“新增失败路径都有检查”不成立，只能算部分覆盖。

**4. 改动产生或修改的每个值，使用它的地方都能接受吗？**
逐个核对的结果：新标识 `runtime.compaction.summary-instruction` 在 `runtime.ts` 产生，manifest 有对应行，`usedBy` 指向真实存在的 `pi-runtime-adapter.ts`，并随 `export * from "./runtime.js"` 进入 `TRUSTED_PROMPT_TEXTS`，这些消费方都接受；`purpose: "other"` 是既有联合类型并被用量存储接受；`cacheRetention`/`sessionId` 是从 `SimpleStreamOptions` 解构出的合法字段，复制回同一类型的 options 没有问题。I-92、ADR 0207、backlog `done` 的编号和引用都能对上。**未核实**的是 manifest 新增 `sha256` 是否与文本实际摘要一致；若不一致，`npm run check:prompt-catalog` 会失败。整体没有发现“产生端有值、消费端校验不接受”的硬错误，但选项值和 manifest 摘要缺少端到端断言。
