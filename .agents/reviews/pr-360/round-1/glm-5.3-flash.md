# 复核结论（PR 360，D1 第 3 步）

## 发现的问题（按严重度从高到低）

**1. 中低 | packages/runtime-pi/src/pi-runtime-adapter.ts:1485-1490 | 钩子失效没有提交成自动用例**
问题：整个「开头不对就不发」的保证，一半压在 `himawari-request-head` 钩子上；钩子没注册、被删或抛错时没有任何提交在仓库里的用例会失败。作者自己在 ADR 里承认「把钩子改成什么都不返回后 74 条失败（手动验证，没有提交成用例）」。
证据：src 侧钩子注册于 `pi.on("context_with_system", …)`（1486 行）；全部测试文件里没有一处模拟「钩子缺失」的 fixture。
建议：补一条自动用例（例如 fixture 开关剥掉该 extensionFactory，断言拒发；或在代理核对路径外，直接断言 resourceLoader 注册了该钩子）。安全性上缺口不大（见必答 3 的 fail-closed 论证），但这是回归检测缺口。

**2. 低 | packages/runtime-pi/src/pi-runtime-adapter.ts:662,670-675 | 两个 fail-closed 分支无用例，且属未声明的行为收紧**
问题：a) `head ? [head] : []`（662）与 `!head`（673）：`createInitialSystemMessage` 返回 undefined（空提示且无工具）时整个会话拒发，无测试。b) `requested.messages` 为空数组时，旧代码会发出 `{messages: []}` 的空请求，新代码因 `first === undefined ≠ head` 拒发——行为变了，作者说明未提。
证据：`const [first, ...rest] = requested.messages; if (!head || !isDeepStrictEqual(first, head)) return undefined;`（672-673）。
建议：各补一条单元用例，或至少在 ADR 里记一句。

**3. 低 | 无测试覆盖：缓存预热器拿到冻结开头**
问题：ADR 0208 第 3 步记录称「第 3 步之后预热重放的开头就是冻结的开头」，但没有对应用例；预热路径（settings `cacheWarming: "streaming"`，1457 行）只有 D7 打开后才真正生效，生产未配 `promptCache`。这是 ADR 自己列的 D7 前遗留，可接受，但应保持列出。
建议：在 D7 打开前的清单里保留此项（ADR 已列，确认即可）。

**4. 极低 | docs/adr/0198-upgrade-pi-to-1-5-0.md:55、docs/engineering-casebook.md:5439 | 历史文档仍写旧失败码 `PI_REQUEST_TOOLS_DIVERGED`**
证据：代码中旧名已无残留（grep 全仓只剩这两处文档引用）；ADR 0208 第 3 步记录了改名。历史记录可保留，但 ADR 0198 第 55 行以现在时描述检查行为，易误导。
建议：在 ADR 0198 该行加一句「后更名为 `PI_REQUEST_HEAD_DIVERGED`，见 ADR 0208」。

**5. 极低 | docs/adr/0208-…md | 文件末尾缺换行符**（diff 显示 `\ No newline at end of file`）。

---

## 侧重检查（流程走查）

普通流程：主人发消息 → `adapter.run` → 投影 + `promptBundles.resolve` → `systemPrompt`/`requestTools`（pi-runtime-adapter.ts:1367-1378）→ `DefaultResourceLoader`（含钩子扩展工厂，1481-1567）→ `createAgentSession` → Pi agent loop `emitContext`（钩子换头）→ `normalizeContext` → `governedRuntime.streamSimple`（1608-1641）→ `himawariRequestContext` 核对 → `admitPiStream`（准入/预算/遮盖，989 起，1023 行 `normalizeContext(withPlaceholderLegend(context))` 重建请求）→ provider。

覆盖情况：
- 代理拒发逻辑：三条反向 + 一条放行（pi-runtime-adapter.compat.test.ts:628-700，faux session 直接喂坏头，断言 `providerCalls === 0`）——真实覆盖。
- 钩子本身：由真实 Pi 会话用例间接覆盖——`[D1]` 旧版工具说明（prompt-prefix.compat.test.ts:851，且在 `[I-66]` describe 内，会被 `check:prompt-prefix` 选中运行，scripts/check-prompt-prefix.mjs:8-27 按 fullName 匹配）；`[ADR-0198]` 名称不一致拒发（870）；`[COMPACT-1]` 摘要请求（885、929）。
- 无覆盖的路径：钩子抛错/未注册；`head === undefined`；空 messages；预热器路径（见问题 1、2、3）。

文档一致性：pi-development-guide.md:73/179/348 与 ADR 0208 第 3 步记录均与代码一致；prompt-prefix 规则（.claude/rules/prompt-prefix.md:74）描述的反向用例仍在。

---

## 必答问题

**1. 会不会改变模型已经见过的请求开头？——不会（读代码证实）。** 最终交给 `admitPiStream` 的 context 形状与改动前一致：`{systemPrompt, tools, messages: rest}`（670-675），`systemPrompt`/`tools` 来源未变（1367-1378），`rest` 与旧版 `filter(非system)` 在无中途 system 消息时等价；请求字节由 `admitPiStream:1023` 的 `normalizeContext` 从这三个值重建，与 Pi 管线里那条 head 消息无关。每轮变化的值（时间、资料块）仍只在最后一条用户消息（`turnPrompt`，613-631，钩子只滤 system 不触碰它）。两处收紧（中途 system 消息、空消息列表由静默处理改为拒发）只在异常场景拒发，不改变正常请求字节。

**2. 会不会让同一段文字在不同请求里变成不同字节？——不会（读代码证实）。** head 每次由同一冻结输入重建：`systemPrompt` 冻结、`requestTools` 来自冻结 JSON 字符串（保序）加固定顺序的 handleDescriptors（1373-1377），无时间、无集合遍历依赖；`isDeepStrictEqual` 每轮比较的是同一确定性构造。遮盖逻辑本次未改。

**3. 有没有自动检查、反向用例会不会真失败？——大部分有。** 三条拒发反向用例直接喂坏头给代理，断言零 provider 调用，会真失败；`[D1]` 在 `check:prompt-prefix` 门槛内。缺口是「钩子本身失效」无提交用例（问题 1）。fail-closed 论证（部分推测，因读不到 Pi dist）：钩子缺失时 Pi 用自己的 head（`systemPromptOverride` 返回同一冻结提示 + Pi 活工具），若与冻结 head 深比较不等则拒发；若恰相等则字节也相同，无害——所以缺测试是回归检测缺口而非安全缺口。

**4. 每个新值的两端核对。** `PI_REQUEST_HEAD_DIVERGED`：产生于 1617，允许原样出现在失败日志（444），测试断言（2252、882）；旧名代码中零残留。`himawari-request-head` 扩展名：仅本文件注册、`hidden: true`。`request-head.ts` 测试助手：两个测试文件引用，它用同一 `normalizeContext`/真实 loader 造头，与代理重算路径同源。`isDeepStrictEqual` 对 Pi 消息对象（字段顺序、undefined 属性、原型）的判定：两侧都出自同一 pi-ai 构造函数，且真实会话测试（[D1]、golden、28 条前缀检查）通过即为经验证据——但 Pi dist（`createInitialSystemMessage`/`normalizeContext`/`getCurrentTools`/`emitContext` 容错/`noExtensions` 与 extensionFactories 的关系）本机未安装、无法直接读，**未核实**；测试运行数字（447/28/74 条）也未运行验证。钩子被授权扩展后续改写：改 head 会被代理深比较拒发（读代码证实）；改历史不会被核对（与改动前相同暴露，非回归）。压缩、审批回放（1615-1616 先于核对取回放，不发请求）、工具循环保护分支：未受影响，`[COMPACT-1]` 用例证实摘要请求仍带 Pi 自带摘要提示且 `tools` 为空（915-922）。
