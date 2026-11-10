output_needle
The assistant message that would follow this tool result is:

# 复核结论

## 读代码证实的发现

### 低：失败标识改名只改了一半，旧文档仍写 `PI_REQUEST_TOOLS_DIVERGED`
- 严重度：低
- 文件:行：`docs/adr/0198-upgrade-pi-to-1-5-0.md:50`、`:55`
- 问题：代码把常量改成了 `PI_REQUEST_HEAD_DIVERGED`（`packages/runtime-pi/src/pi-runtime-adapter.ts:389`、`:444`、`:1617`），但 ADR 0198 仍把当前行为的失败名写成旧值。ADR 0208 新记录说“原 `PI_REQUEST_TOOLS_DIVERGED`”，但 ADR 0198 没有同步。读代码的人会以为生产仍报旧名。
- 证据：`grep` 结果里，`docs/adr/0198-upgrade-pi-to-1-5-0.md:50` “不一致就不发这次请求（`PI_REQUEST_TOOLS_DIVERGED`）”，`:55` 同；代码 `const PI_REQUEST_HEAD_DIVERGED = "PI_REQUEST_HEAD_DIVERGED";`（`pi-runtime-adapter.ts:389`）。
- 建议：在 ADR 0198 对应两处加“（第 3 步后改名 `PI_REQUEST_HEAD_DIVERGED`，见 ADR 0208）”或标注该段为历史描述；否则至少别让“当前行为”字样继续指向旧名。

### 低：文档把“失败码”写成 `PI_REQUEST_HEAD_DIVERGED`，实际 `runtime.failed.errorCode` 仍是 `PI_MODEL_ERROR`
- 严重度：低
- 文件:行：`docs/adr/0208-adopt-pi-official-request-head-and-session-runtime-wrapper.md:101`
- 问题：`PI_REQUEST_HEAD_DIVERGED` 是错误消息文本，经 `loggableModelFailure` 原样保留；`runtime.failed` 的 `errorCode` 由 `modelFailureCode` 映射，仍是 `PI_MODEL_ERROR`。文档写“失败码”，容易让排查者按 `errorCode` 搜不到。
- 证据：`pi-runtime-adapter.ts:428-436` `modelFailureCode` 对非状态码返回 `"PI_MODEL_ERROR"`；`:439-448` `loggableModelFailure` 原样返回 `PI_REQUEST_HEAD_DIVERGED`；`:2280-2286` 用 `modelFailureCode` 作为 `errorCode`，`loggableModelFailure` 作为 `message`。
- 建议：把 ADR 0208 第 101 行的“失败码”改成“错误消息/诊断消息”，或说明 `runtime.failed.errorCode` 仍是 `PI_MODEL_ERROR`。

### 低：`[D1]` 用例并不能单独证明“冻结工具声明是通过钩子发出的”
- 严重度：低
- 文件:行：`packages/runtime-pi/test/prompt-prefix.compat.test.ts:851-868`
- 问题：最终请求里的工具来自代理返回的 `context.tools`（`frozenTools`），不是来自钩子的 head。即使钩子用实时工具，只要代理的深度核对被去掉，这条用例仍会看到冻结说明。它真正锁住的是“钩子缺失/返回空时，新代理核对会拒发”，不是“钩子本身携带冻结工具”。作者说“手动把钩子改成什么都不返回后……没有提交成用例”，其实这条用例在钩子返回空时会因零请求而失败，已算一个间接反向保护；但它不覆盖“head 提示词相同、工具声明不同”的拒绝路径。
- 证据：`pi-runtime-adapter.ts:670-675` 返回 `tools`（`frozenTools`）和 `messages: rest`；`admitPiStream` 在 `:1023` 用 `normalizeContext(withPlaceholderLegend(context))` 重新生成请求头，因此最终工具声明来自 `context.tools`。`prompt-prefix.compat.test.ts:858` 只断言 `bodies` 长度和工具说明。
- 建议：补一条反向用例：让 `shapeContext` 只改第 0 条 head 的工具声明、保留相同系统提示，断言零请求；这样才直接覆盖“整条开头深比较”里的工具部分。另可把“钩子返回空 → 拒发”写成显式用例，避免文档里“没有提交成用例”的说法误导。

## 推测/未核实

- 严重度：中（未核实）——`createInitialSystemMessage`、`getCurrentTools`、`context_with_system` 的 `emitContext` 行为、`normalizeContext` 是否原样保留 head，这些都在 `@earendil-works/pi-ai` / `pi-coding-agent` 的依赖源码里；当前稀疏检出没有 `node_modules`，我无法直接读实现。作者的“447 条通过、黄金请求通过、`check:prompt-prefix` 28 条通过”都依赖这些运行时行为，我未运行测试，标为未核实。
- 严重度：中（未核实）——摘要/压缩请求是否真的绕过 `context_with_system`。代码靠 `compacting` 标志走 `himawariSummaryContext`（`pi-runtime-adapter.ts:1611-1613`），并有 `[COMPACT-1]` 用例断言摘要请求的工具为空、系统消息含 “context summarization assistant”（`prompt-prefix.compat.test.ts:915-922`）。如果这个前提不成立，钩子会把摘要提示替换成冻结开头，`himawariSummaryContext` 可能返回 undefined，再回落到 `himawariRequestContext`；有工具时会被深度核对拒发（较安全），无工具时可能把摘要请求当普通对话发出去。依赖源码未核实。
- 严重度：中（未核实）——授权扩展在 `context_with_system` 钩子链里的执行顺序。代理的核对能拒绝“在我们之后”改写 head 的扩展；但如果授权扩展在我们的钩子之前运行，我们的钩子会用冻结 head 覆盖它对提示词的改动，代理看不到、也不会拒发。代码只能保证“最终 requested.messages[0] 等于冻结 head”；它不能区分这个 head 是谁写的。Pi 的 `extensionFactories` 与 `additionalExtensionPaths` 的加载顺序未核实。
- 严重度：低（未核实）——`createInitialSystemMessage` 对空 `systemPrompt` 的行为。若生产出现空系统指令且该函数返回 undefined，钩子会返回无 head 的历史，代理的 `!head` 分支会拒发。当前测试没有空 `systemInstruction` 用例；生产 `production-run-policy.ts` 会拼入固定身份文字，实际不太可能为空。

## 侧重检查（错误路径、不合规范/不可信输入、安全、资源耗尽、不可撤销操作、文档与代码一致性）

- 错误路径：钩子抛错时 Pi 只记录并放行（ADR 0208 前提 2，未在依赖源码核实）；代理侧 `himawariRequestContext` 在 `:1617` 对不匹配返回 `failedPiStream(PI_REQUEST_HEAD_DIVERGED)`，`deferredPiStream` 在 `:839-847` 捕获异常并转成错误流。已确认：失败前不会调用 `admitPiStream`，因此不会消耗准入/预算，也不会向服务方发请求。
- 不可逆操作：`himawariRequestContext` 在 `:1613` 计算，`takeReplay()` 在 `:1615` 消费一次性回放；若 head 不匹配但有回放，回放仍会返回（`:1616`），不产生请求。没有发现新的不可撤销副作用。
- 不可信输入：`frozenTools` 来自 `JSON.parse(bundle.tools)`（`:1373-1376`），`providerTool`（`:546-557`）假定 `name/description/parameters` 存在；损坏的冻结包可能让 `createInitialSystemMessage` 抛错，`deferredPiStream` 会兜成 “Model request failed”，不发请求。这个风险在改动前就存在，不是本次新增。
- 资源耗尽：新增每请求一次 `createInitialSystemMessage`（钩子）和一次（代理核对），加上 `isDeepStrictEqual`，复杂度与系统提示/工具大小线性相关；未发现无界增长。
- 安全：新错误消息是固定常量，不泄露服务方原文；钩子 `hidden: true` 与现有隐藏扩展一致（`:1482-1490`）。
- 文档与代码一致性：ADR 0208 第 3 步记录与代码主体一致（钩子返回 head + 去 system 历史、工具名不一致返回 undefined、代理核对第 0 条和后续 system）；不一致点在上述旧错误名和“失败码”措辞。`docs/pi-development-guide.md:73`、`:179`、`:348` 与代码一致。
- 自动检查：三条拒发用例（`pi-runtime-adapter.compat.test.ts:628-679`）在去掉核对后会因 `providerCalls` 变成 1 而失败；`[D1]` 用例在钩子缺失/返回空时会因零请求失败；黄金请求（`pi-runtime-adapter.compat.test.ts:2957-2966`）未改 fixture，若最终字节变化会失败。但“head 提示词相同、工具声明不同”没有直接反向用例（见上）。

## 必答问题

1. **会不会改变模型已经见过的请求开头？** 读代码看，不会。最终发给服务方的字节由 `admitPiStream` 在 `:1023` 用 `normalizeContext(withPlaceholderLegend(context))` 重新生成，输入是代理返回的 `systemPrompt`、`tools`、`messages: rest`（`:675`）；钩子的 head 在代理里被剥掉（`:672-675`），不会进入最终请求。改动仍然只在末尾追加：head 固定，历史是 `requested.messages.slice(1)`，每轮变化的值在最后一条用户消息里（`turnPrompt`，`:613-632`）。依据：发给模型的内容只追加。黄金请求 fixture 未改，若最终字节变化该用例会失败（作者称通过，我未运行，未核实）。

2. **会不会让同一段文字在不同请求里变成不同字节？** 读代码看，不会新增不确定性。`frozenRequestTools` 只用 `Set` 做成员判断（`:648-650`），不遍历集合；`tools` 顺序来自冻结包 JSON 顺序加句柄工具顺序（`:1373-1377`），与改动前一致；没有时间字段。`createInitialSystemMessage` 是否含时间/随机字段无法从当前检出核实，但黄金请求和 `check:prompt-prefix` 的多轮逐字节断言若通过即可排除（未运行，未核实）。

3. **有没有对应的自动检查，反向用例是否真的会失败？** 有：三条拒发用例、一条放行用例、`[D1]` 冻结工具说明用例、`[COMPACT-1]` 摘要用例、未改的黄金请求。三条拒发用例去掉核对会失败；`[D1]` 在钩子缺失/返回空时会因零请求失败；黄金请求在最终字节变化时会失败。缺口是“head 提示词相同、工具声明不同”没有直接反向用例；另外“钩子返回空 → 拒发”没有以显式用例命名提交，只由 `[D1]` 间接覆盖。作者“手动验证 74 条失败、没有提交成用例”的说法与 `[D1]` 的存在略有出入。

4. **每个新值的使用方都能接受吗？**
   - `PI_REQUEST_HEAD_DIVERGED`：产生于 `:389`，使用于 `:444`（诊断消息白名单）、`:1617`（失败流）、测试 `pi-runtime-adapter.compat.test.ts:2252`、`prompt-prefix.compat.test.ts:882`。应用侧 `service-main.ts:1884-1891` 只把它当 `message` 写诊断，不校验枚举；没有仓库内消费者依赖旧名。仓库外日志告警若按旧字符串匹配会断，未核实。
   - `himawari-request-head`：只在 `:1483` 注册，`hidden: true` 与现有隐藏扩展同字段（`:1494`、`:1526`），没有清单/配置键引用它。
   - `ContextWithSystemEvent` / `createInitialSystemMessage`：类型与函数来自 Pi 依赖；能否在锁定的 1.5.0 导出、签名是否匹配，依赖源码不在当前检出，未核实（但 tsc 若跑过应能发现）。
   - `requestTools` 作为新参数传入两个本地函数：调用点 `:1487`、`:1613` 都来自同一 `const requestTools`（`:1373-1378`），两端一致。
   - `shapeContext` 新测试参数：`createAdmissionAdapter` 追加在末尾（`:531`），现有调用点不受影响；新用例按第 9 个参数传入（`:660-673`），位置正确。
   - `request-head.ts` 的 `.ts` 导入：`tsconfig.base.json:3` 开启 `allowImportingTsExtensions`，可接受。
