I'll start by examining the diff and the referenced rules.
# 复核结论（PR 286，b736475 对比 7073268）

## 严重度排列的问题

**1. 中 — test/integration/production-http-composition-process.test.ts:76-88 — `isAgentRequest` 这个被 I-82 声明为门槛之一的改动，没有任何直接测试和反向用例**
- 证据（读代码证实）：`isAgentRequest` 定义在 test/integration/production-http-composition-process.test.ts:76-88，全部消费点只有本文件 88 行（`agentGenerationRequests`）和 1866 行（`agentRequests`）；全仓库 grep 无其它引用。docs/incidents-and-gates.md:120 把它列为「已落门槛」的两道之门之一。
- 推测（未证实，但结构上如此）：若有人把过滤器改回旧写法（旧 filter 数进背景请求），现有用例是否失败取决于「对话标题/记忆整理请求恰好落在各 slice 窗口内」——是时序相关的，不保证失败。也就是说这道门槛只有正向覆盖，旧行为不会稳定失败。
- 建议：把 `isAgentRequest` 抽到 `test/fixtures/`（或 file 内导出），加一个直接用例：输入 `messages[0] = { role: "system", content: CHAT_EGRESS_LEGEND.text }` 断言 `false`；再配一个反向断言（旧写法对同一输入返回 `true`）。

**2. 低 — test/integration/production-http-composition-process.test.ts:207、234 — provider stub 换成 `void readRequestBody(request).then(...)` 后没有 catch，流错误/JSON 失败变成 unhandledRejection**
- 证据（读代码证实）：两处 handler 都是 `void readRequestBody(request).then((body) => { JSON.parse(body); ... })`，无 `.catch`。旧写法在流中途被销毁时既不解析也不抛；新写法流错误会让 promise reject（`for await` 抛出），`JSON.parse` 失败同样 reject。
- 未证实是否真有触发路径：`dropEmbeddingConnections`（191-194 行）和 `providerAvailable=false`（185-189 行）都在读取之前就返回，我浏览到的用例没有故意在 body 中途断连的分支。风险是测试序列化失败时从「清晰断言失败」变成「unhandledRejection 拖垮整个 worker」。
- 建议：`.then(..., (error) => { capturedRequest.parseFailed = String(error); response.writeHead(500).end(); })` 之类兜底。

**3. 低 — .claude/rules/prompt-prefix.md:75 — 文档与代码不一致**
- 证据（读代码证实）：文档写「[PR-A]、[PR-B] 用例，用真实服务和 SQLite 抓取原始请求体来比对」；实际实现的抓取是测试进程内存里的 `providerRequests`（由自建 HTTPS provider stub 填充），SQLite 只用于记账断言（1723-1820 行）。本次 PR 改的正是这个文件的比对机制，文档没跟着说准确。
- 建议：改成「用测试内自建 HTTPS provider 记录原始请求体」。

**4. 信息（非缺陷）— 夹具补的 `egress` 与生产仍有两处可选参数差异**
- 证据（读代码证实）：生产 service-main.ts:295-300 还传了 `recorder`（敏感遮盖记库）和 `egressThreadOf`（run→thread 归属，SI-2）；夹具 production-service-main-child.mjs:130 两项都没传。生产的 `sensitiveInterceptions` 写库路径和背景遮盖的 thread 归属，在这个集成测试里覆盖不到（后者由 packages/runtime-pi/test/pi-model-transport.unit.test.ts:506-538 的 [SI-2] 单测覆盖）。「emodels 每一个使用它的地方都能接受」角度：这两处省略会让测试对「遮盖上报失败/归属失败」这类产品回归不敏感，建议在 I-82 或夹具注释里记一笔已知偏差。

## 侧重检查（指定侧重：测试覆盖、文档一致性、普通流程走查）

我走的普通流程：`thread.submit("你好")` → HTTP 服务 → run 执行 → pi-runtime-adapter 组装请求（冻结系统提示 + 工具 + 历史 + 追加运行环境说明在最后一条，pi-runtime-adapter.ts:1035 `withPlaceholderLegend`）→ 出口遮盖 `exchange.wrapFetch` → HTTPS 假 provider → `readRequestBody` 解码 → 比对。
- `readRequestBody`：有专门测试文件（3 个用例含真实 HTTP 分块和旧写法反向），并在该文件每个端到端请求上被走到。覆盖充分。
- 夹具 `egress` 丢失的反向覆盖：R2-L5 的“4 次调用都结算”断言（test/integration/production-http-composition-process.test.ts:1598-1623）本身就是反向检查，作者在云端复现过删掉 `egress` 该测试失败（声明，未核实）。
- `readRequestBody` 的字符串 chunk 分支（test/fixtures/request-body.ts:6）在集成环境永远走不到（HTTP 请求 chunk 总是 Buffer），属死分支但无害。
- 未跑任何测试；「10 个用例全过」「16134 字节」「快速模式不跑第 3 层」均为作者声明，未核实。

## 作者说法逐条核对

| 说法 | 结论 |
|---|---|
| 夹具没传 `egress` → `PiModelTransport.invoke` 抛 TypeError → PORT_INVALID_OPERATION | 证实机制：`PiModelTransportOptions.egress` 为必填（production-model-composition.ts:88），invoke 第 313 行 `this.#egress.exchange(...)` 直接解引用； việc 编译后 JS 无运行时检查，缺参即 undefined → TypeError。包装成 PORT_INVALID_OPERATION 的环节（stableErrorCode，packages/application/src/ports/common.ts:24）未逐行追到，标注机制吻合。夹具 9ac0769（Nov 5）已缺参数——按声明未核实 |
| `body += chunk` 在块边界切碎汉字 | 证实写法一致（diff 删除处），16134 这个数未核实；但反向用例从代码上证明了旧读法对任意“块断在汉字中间”的输入必产生 U+FFFD |
| 修好后背景请求第一条是 `CHAT_EGRESS_LEGEND` 而非系统提示 | 证实：`backgroundModelContext` 的 systemPrompt 就是 `EGRESS_PLACEHOLDER_LEGEND`（packages/runtime-pi/src/egress-context.ts:23-27），且出站体 messages[0] = `{role:"system", content: legend}`（pi-model-transport.unit.test.ts:543-546）；对话请求走 `withPlaceholderLegend`（systemPrompt = 产品提示 + WITH_RESTORE 说明，不等于 legend.text），不会被误判 |
| 产品代码没改、I-66 未违反 | 证实：`git diff --stat` 只有 5 个文件，全部在 test/fixtures、test/integration、docs |
| 生产 service-main.ts 传了 egress | 证实（service-main.ts:295、348） |

## 必答问题

1. **会不会改变模型已见过的请求开头？** 不会。产品组装代码零改动（diff 只含测试夹具、集成测试、incident 文档）。夹具补 `egress` 只是把测试假模型收到的请求从不完整状态对齐到生产状态（生产本就发送遮盖+legend；这些字节只存在于测试环境，不影响生产 KV 缓存）。追加性仍由 PR-A 的 `expectAppendOnly` + `requestHead`（1844-1949）和 PR-B 全组断言守护，每轮变化值（运行环境说明、标题、时间）都被断言在最后一条消息里（1950-1954）。聊天循环不换 system 提示、不重写历史，由 1960-2013 的工具循环用例覆盖。
2. **会不会让同一段文字在不同请求里字节不同？** 不会。新引入的值只有：`isAgentRequest` 的比较逻辑（不进请求）、`readRequestBody`（输出只取决于字节到达顺序，且对切法不敏感——这正是新测试的断言点）、夹具 `egress`（遮盖密钥来自固定 secret 文件 payload-kek.v1，按规则 11 确定性遮盖）。无时间字段、无无序集合、无依赖后文的遮盖新增。
3. **有没有自动检查、反向用例会不会真失败？** `request-body-decoding.test.ts` 落在 integration project（ci/policy.json:207-208 include `test/integration/**/*.test.ts`），test、node-floor、coverage 三个作业必跑；反向用例从代码可证：`head` 在「次」的第一字节后切断（cut = indexOf+1），旧写法 `body += head` 时 Buffer.toString('utf8') 把残留半字节替换成 U+FFFD，`expect(body).toContain("�")` 必失败。缺口见问题 1：`isAgentRequest` 无直接反向用例。
4. **每个值的产生端与消费端是否都接受？**
   - `egress` 键：消费端 `createProductionModelComposition` 必填项（production-model-composition.ts:88）→ `PiModelTransport`（228 行）；实参签名 `createProductionModelEgress(configuration, sources)` 与定义（production-model-egress.ts:64-68）吻合；判定所需的 `payload-encryption` 唯一引用由 rawConfiguration():416 提供、密钥文件 payload-kek.v1 在 secretDirectory（736 行）；同一调用形态在该夹具的 memoryCompositionFactory（166 行）早已在用，构造可行性已被既有测试验证。与生产的差异（无 recorder、无 egressThreadOf）见上文问题 4。
   - `CHAT_EGRESS_LEGEND.text`：有无漂移保护（apps/agent-service/test/prompt-rendering-golden.unit.test.ts:101 快照；check:prompt-catalog 属 npm run check）。
   - `readRequestBody`：消费端只有本文件两个 handler 和新测试，行为向后兼容（body 字符串 → JSON.parse，与旧相同）。
   - I-82 文档行：过 `check:incident-gates` 的结构检查，门槛点名的文件都存在。

**总评**：改动本身可信，爱心是它把端到端只追加门槛从「缺出口遮盖器的失真状态」修成生产等价状态，属于加强而非放松。主要缺一个 `isAgentRequest` 的直接/反向测试，以及 provider stub 的 rejection 兜底。
