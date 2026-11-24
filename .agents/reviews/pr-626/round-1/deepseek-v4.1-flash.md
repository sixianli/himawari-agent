**总体判断**：这两处改动（recall 的 `dispatchState`、清理时跳过“点名秘密”的结果）在类型和主要消费方上没有硬错误；`namesRememberedValue` 对同一段原文是纯函数，不会引入每轮变化的时间/随机值。真正值得担心的是：清理判定没有和出口遮盖共用“会话冻结的规则集/trusted”，以及这个“保留整条结果”的修法会让既有对话的开头在升级后从中间被改写，并给不可信网页一个永久免清理的开关。

### 1、中、升级后会把旧对话里已经清理过的“点名密码”结果重新放回请求开头，破坏“只在末尾追加”
- 文件:行：`packages/runtime-pi/src/tool-result-clearing.ts:94-98`、`:157-161`，调用点 `packages/runtime-pi/src/pi-runtime-adapter.ts:1569-1572`
- 问题：清理集合每次都由完整原始历史重算，不持久化。旧版本里某个点名密码的旧工具结果会被清成一行占位；新版本对同一段存储历史会跳过它，于是那次请求在**中间位置**把占位换回整页原文（密码本身再被遮盖）。这不是末尾追加，而是一次历史上的中间改写；没有迁移逻辑，也没有跨版本测试。
- 证据（读代码证实）：旧实现的过滤只有 `!cleared.has(result.id) && !settings.keepToolNames.has(result.name)`；新实现加入 `result.namesSecret ??= namesMaskedSecret(result.message); return !result.namesSecret;`，且 `clearToolResults(event.messages, clearing)` 每个 context 钩子都从头重算。
- 推测：对已经部署的对话，下一次请求的 prompt 前缀会在旧清理点发生变化，缓存失效；如果该位置之前已经发送过占位，模型看到的历史字节会倒退。
- 建议：若接受这是一次性策略变更，就在文档里明说并用测试模拟“旧版本已清理、新版本重算”的历史；若要守住只追加，需要把“该结果已清理”的标记/指纹随会话持久化，而不是每次只靠原文重算。

### 2、中、清理判定没有用会话冻结的 `redactionRuleset`/`trusted`，与出口遮盖并非“同一套规则”
- 文件:行：`packages/runtime-pi/src/tool-result-clearing.ts:64-68`、`packages/sensitive-capture/src/redaction.ts:440-443`、`:350-356`；`packages/runtime-pi/src/pi-runtime-adapter.ts:1505-1521` 对比 `:1753`；`packages/application/src/services/model-egress.ts:284-288`
- 问题：`clearing` 只带 trigger/keep/keepNames，没有 ruleset；`namesRememberedValue` 用默认 `EGRESS_RULESET_CURRENT` 且不传 `trusted`。生产出口遮盖却使用 prompt bundle 里冻结的 `redactionRuleset` 和 `TRUSTED_PROMPT_TEXTS`。当前规则集只有 1 和 2，且 `namesRememberedValue` 只会“多认”，所以**目前不会漏判，方向是过度保留**；但判定与遮盖不一致，文档里“和出口遮盖用同一套规则”不成立，且以后规则集/默认值变化时，同一段历史算出的清理字节可能随版本改变。
- 证据（读代码证实）：`redactionRuleset` 由 `bundle?.redactionRuleset` 传给 `admitPiStream`，最终进 `egress.exchange({..., redactionRuleset})`；`clearing` 构造处没有它。`redactForEgress` 在未传 `ruleset` 时用 `options.ruleset ?? EGRESS_RULESET_CURRENT`；未传 `trusted` 时 `trusted=[]`。规则集 1 的旧对话不走 `PASSWORD_WORDED_ASSIGNMENT` / `PASSWORD_BARE_VALUE`，而 `namesRememberedValue` 会走。
- 推测：旧对话里“password is xxxxxx”这类松散写法会被无谓地永久保留；如果将来默认规则集改成更窄的规则，默认值又与会话冻结值不同，就可能从“过度保留”翻成真正的漏判。
- 建议：把 `bundle.redactionRuleset` 一并放进 `ToolResultClearingSettings` 并传给 `namesRememberedValue`，同时传入与出口一致的 `trusted`（或明确记录这个差异是故意的）；补 ruleset=1 和含 trusted 文本的用例。

### 3、中、不可信工具结果只要包含一行“password: 六个字符以上”就永久免清理（注入/资源耗尽）
- 文件:行：`packages/runtime-pi/src/tool-result-clearing.ts:94-98`、`packages/sensitive-capture/src/redaction.ts:310-329`、`:340-349`
- 问题：任何网页正文、搜索结果、文件内容都能自己写“password: abcdef”或“验证码 123456”，使 `namesRememberedValue` 为真，从而被永久跳过清理。攻击者可借此让大量大块内容留在上下文里，抬高每轮 token 成本、提前触发压缩；这是新加的、由不可信输入直接控制的豁免开关。
- 证据（读代码证实）：`PASSWORD_ASSIGNMENT` 对关键字后的任意非空白串匹配；`mask` 在 `original.length >= KNOWN_VALUE_MINIMUM_LENGTH`（6）时写入 `known`；`namesRememberedValue` 只看 `known.size > 0`；候选过滤直接 `return !result.namesSecret`，对结果大小没有上限。
- 推测：在长期运行的子线程里，多次网页读取就能把清理线以上全部占满且永不清理。
- 建议：更好的根因修法是把“出口遮盖认出过的秘密值”（或它的 HMAC 指纹加必要片段）随会话持久化，让出口遮盖不依赖那条原文，从而仍然可以清掉整页；退一步可只保留点名秘密的短摘录而不是整条结果，并对豁免总量设上限。

### 4、低、Recall 修复没有被阻断检查按名字要求，`[CLEAR-6]` 也没测“找不到”和 projection 的实际状态
- 文件:行：`scripts/check-prompt-prefix.mjs:10-22`、`packages/runtime-pi/test/prompt-prefix.compat.test.ts:1546-1561`、`.agents/instructions/prompt-prefix.md:66`
- 问题：`REQUIRED_NAMES` 只加了 `[CLEAR-7]`，没有 `[CLEAR-6]`；`REQUIRED = 18` 远低于该文件实际匹配 `[I-66]` 的用例数，删掉 `[CLEAR-6]` 也不会让计数失败，于是问题 1 的回归不会被阻断检查挡住。`[CLEAR-6]` 标题写“found or not”，但只测了 found；只断言保存的 `details`，没有断言 projection 真的不再产出 `runtime.tool_outcome.unresolved`。文档也只列到 `[CLEAR-1]` 到 `[CLEAR-5]` 再加 `[CLEAR-7]`，漏了 `[CLEAR-6]`。
- 证据（读代码证实）：`REQUIRED_NAMES` 内容与 `it("[CLEAR-6] ...")` 未出现其中；测试里 `expect(recalls).toHaveLength(1)` 后只 `toMatchObject({ productOutcome: "succeeded", dispatchState: "accepted" })`。
- 建议：把 `[CLEAR-6]` 加入 `REQUIRED_NAMES`；补 not-found 用例并直接断言 projection 没有 `unresolved` 记录；同步文档列表。

### 5、低到中、每个 context 钩子都会对未清理结果重跑整套遮盖正则，被保留的秘密结果永不清理，成本持续
- 文件:行：`packages/runtime-pi/src/tool-result-clearing.ts:64-69`、`:94-98`，调用点 `packages/runtime-pi/src/pi-runtime-adapter.ts:1569-1572`
- 问题：`namesSecret` 的 `??=` 只在单次 `clearedToolResultIds` 调用内有效，`seen` 每次新建；被认定“点名秘密”的结果又永远不进 `cleared`，所以每次请求都会重新对它的全文跑一遍密码/验证码/机器密钥等全局正则。这是和出口遮盖之外的第二遍扫描；大网页会线性放大 CPU，且受第 3 条影响可持续增长。
- 证据（读代码证实）：过滤顺序是先 `cleared.has`/`keepToolNames.has`，再 `namesMaskedSecret`；`seen` 是函数局部数组，缓存不会跨调用。
- 推测：如果对话里有几 MB 的“点名秘密”网页，每轮都会在上下文钩子里额外扫一遍。
- 建议：用 `WeakMap`/对象稳定标识缓存每条消息的判定，或按根因持久化秘密值而不是保留整页；至少对豁免结果的大小设限。

### 6、低、作者称 `known`/Exchange“按一次运行新建”，与代码不符（实际每个模型请求新建）
- 文件:行：`packages/runtime-pi/src/pi-runtime-adapter.ts:1138-1145`、`packages/runtime-pi/src/pi-model-transport.ts:312`
- 问题：`egress.exchange({...})` 在 `admitPiStream` 每次流式调用里创建，后台调用也在每次 `invoke` 里创建；不是一次 run 一个。这个错误不推翻修法，但会误导对“为什么下一轮认不出”的解释：如果真按 run 持久，`known` 还会带着旧值，问题表现会不同。
- 证据（读代码证实）：两处 `const exchange = this.#egress.exchange(...)` 都在单次请求函数内部。
- 建议：更正 PR/材料里的说法。

### 7、低、用 `accepted` 表示纯本地取回在语义上不准确，根因其实在 projection 对所有工具一视同仁
- 文件:行：`packages/runtime-pi/src/pi-runtime-adapter.ts:2257-2267`、`packages/application/src/services/thread-execution-projection.ts:387-394`
- 问题：`dispatchState: "accepted"` 在其他工具里表示“外部派发已被接受、可能有副作用”；取回工具只在内存里查历史。当前 projection 接受该值、UI 用 `productOutcome` 判失败，所以没有现实消费者被破坏；但把语义借给本地操作，后续任何按 `accepted` 做补偿/审计的逻辑都会被误导。
- 证据（读代码证实）：projection 的允许值就是 `not_sent | possibly_sent | accepted`；`legacyNotDispatched` 名单不含取回错误码，所以 found/not-found 都不再 unresolved。`RuntimeToolSettledResult` 的类型也允许 `accepted`。
- 建议：在 projection 里对 `tool-result-recall` 显式豁免（或增加 `not_applicable`/`local` 状态），而不是把本地查询伪装成已派发；补 not-found 的 projection 断言。

**一、侧重检查**

- 错误路径：取回 not-found 现在 `productOutcome=failed + dispatchState=accepted + isError=true`。读 `thread-execution-projection.ts:387-394` 证实不会被判 unresolved，工具记录仍会以 `failed` 呈现（`:451-457`），所以不会“假成功”，但会丢掉原先的 `not_dispatched` 状态；该路径没有专门的集成断言。
- 不可信输入/注入：第 3 条；任何工具结果文本都能触发豁免，且豁免没有大小或数量上限。
- 资源耗尽：第 5 条；重复正则扫描 + 永久保留；`namesMaskedSecret` 对 malformed content 是安全的（`.text` 非字符串即跳过），不会因坏块抛错。
- 安全/遮盖完整性：当前 `namesRememberedValue` 只会比生产规则“多认”，不会少认，所以**当前版本不会因为它而漏遮**。但保留整页只解决“点名值被清掉”这一问题；`known` 要求值长度 ≥6，4–5 位验证码本来就只遮点名那一处，后续裸值不会被记入 `known`，保留该结果也救不了，文档把“密码或验证码”说成一类需要补一句前提。带尾随标点/大小写变化的后续裸值也可能对不上，这是既有遮盖的限制，不是本 diff 引入。
- 规则/文档一致性：第 2、4、6 条；`.agents/instructions/prompt-prefix.md:65` 的“和出口遮盖用同一套规则”与实际代码不符。

**二、必答问题**

1. **会不会改变模型已见过的请求开头？** 本 diff 自己不引入“每轮变”的新字段：`dispatchState` 在持久化的 `details` 里，模型可见的是 `content`（取回成功仍是原文、失败仍是同一段提示）；`namesSecret` 是原文内容的纯函数，不看时间/邻接消息。可就固定版本、固定历史而言，清理结果仍是确定性的，钩子仍然只做“把某些旧结果换成占位”，之后新增消息只追加。**但**有两个真实例外：(a) 第 1 条，升级后旧对话中曾被清理的点名密码结果会从中间被换回原文；(b) 清理机制本身在每次越过清理线时会把中间若干结果换成占位，这本来就是规则允许的一次性开头变化，本 diff 没有改变它。`details` 是否完全不被 Pi 转换进请求体我没有逐行核实，但即使被序列化，它在历史里固定，也不会每轮变化。

2. **同一段文字会不会在不同请求里变成不同字节？** 同一版本内，`namesRememberedValue` 无随机、无时间、无外部状态（每次新建 `known`），`namesSecret` 也只缓存在单次调用里，不会让同一段历史得出不同清理集合。真正会导致“同一段文字字节变化”的是：清理判定没有使用会话冻结的 `redactionRuleset`（第 2 条）——升级规则集后旧对话的清理集合可能变；以及旧版本/新版本之间的清理策略差异（第 1 条）。另外，出口遮盖的 `known` 本身依赖同请求中更早的消息（既有行为），所以新增“保留点名结果”会让后续裸值的遮盖字节变化，这是修复的本意，且对同一历史是确定的。

3. **有没有对应自动检查，反向用例真会失败吗？** `[CLEAR-7]` 和 `tool-result-clearing.unit.test.ts` 的反向用例逻辑上是真的反向：旧实现会把 `call-0` 清掉，导致后续 assistant 消息里的裸密码不再被 `known` 遮盖，测试会失败；实测路径我未运行（不能执行测试），是按代码推演。缺口是：`[CLEAR-6]` 没进 `REQUIRED_NAMES`，not-found 没测，projection 的 lifecycle 没测，ruleset=1/trusted 不一致没测，跨版本前缀回退没测，性能/豁免上限没测。

4. **改动产生/修改的每个值，使用方都能接受吗？** `dispatchState: "accepted"`：类型允许，`thread-execution-projection.ts:393-394` 的白名单接受，工具记录失败状态仍由 `productOutcome`/`isError` 决定；`pi-tool-batch-continuation` 只看 `productOutcome`，Web 记忆补偿逻辑只针对 Web 工具，取回不经过它，所以当前没有消费者拒绝它（语义问题见第 7 条）。`namesRememberedValue`：已从 `packages/sensitive-capture/src/index.ts` 导出，`runtime-pi` 的 `package.json` 已依赖该包，唯一使用点是清理模块。`namesSecret`：仅局部 `seen` 字段，不落盘、不序列化。`[CLEAR-7]` 名称与脚本逐字匹配。唯一“生产端有、消费端没要求”的是 `[CLEAR-6]`（第 4 条）。
