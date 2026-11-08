# 复核报告：PR3「搜索词、网址、TypeSafe 先遮再发」（f0478c4 → e5edb54）

## 侧重检查（我走的流程和结论）

我沿最普通的 web_search 流程从入口走到结束，逐段读了：

1. 模型发出工具调用 → `production-runtime-tools.ts:1120-1133`（`#executeRequest`，此处对 `executeProductionCodingRequest` 的抛出没有任何 catch）→ `production-coding-workflow.ts:124-186`（binding 校验、`outboundWebArguments` 入口遮盖：`apps/agent-service/src/production-coding-workflow.ts:108-122`，实测遮盖函数来自 `services.externalTag`）→ 校验（188-215，此时用的是遮后参数）→ 冻结 checkpoint（246-270，`stableCall(call)` 存的是**原始**参数，仅内部存储）→ 组装授权 intent（280、316：`resourceRef` 和 `input-digest` 都基于遮后参数）→ 456-490 服务进程内搜索路径 / 512-548 句柄+沙箱路径（`ctx.save("input")` 存遮后输入）。
2. `externalTag` 的来源：`service-main.ts:885-888` 懒创建 `createProductionModelEgress(configuration, sources)`；与聊天用的是同一配置、同一密钥来源（`service-main.ts:646` 的 `sources` 同源；`production-model-egress.ts:64-89` 从同一 `payload-encryption` 密钥引用派生同一把密钥，HMAC 确定性）。
3. 每一个新值的产生端和使用端：`external.ts` 的新函数 → 被 workflow 入口、三个提供方/传输层、检查脚本消费；`delayedTag` 字符串校验：`letters()` 产出 8 个小写字母（model-egress.ts:112-118、120-125），恰好满足占位符模式 `[a-z]{8}`（redaction.ts:61、420，external.ts:29-31），聊天侧流式恢复器和出口位符识别都能接受——两端匹配。
4. 测试覆盖：7 个 `[mask-not-block]` 测试 + 新增 `external.unit.test.ts`（120 行）+ 检查脚本的 3 条新用例；也核对了「反向用例」的注册和实现（`test/tooling/egress-redaction-check.test.mjs:134-165`，fixture 写入无遮盖的源文件并断言具体报错文本）。
5. 规则对照：读了 `.claude/rules/prompt-prefix.md` 全文（第 4、5、10、11 条是本 PR 的判据）和 `docs/incidents-and-gates.md:112`（I-73）。
6. **没有覆盖**：无法运行命令（npm test / check 不能执行），所以「换回 origin/main 后 10 条失败」的断言我没有实测；`WebToolMemory.key` 的内部序列化、intent 合约对 `coding:` 前缀 id 的其余校验我没展开读——标「未核实」。

结论：主流程的关键断言（入口遮一次、纵深二次遮、缓存键用遮后值、占位符可幂等重遮）都有实现和测试对应；问题集中在下面的低级条目。

---

## 问题清单（按严重度从高到低）

**1. 低 · apps/agent-service/src/production-coding-workflow.ts:184-186 + apps/agent-service/src/test 调用链**
问题：`externalTag` 取密钥失败时整个 web 工具调用以未捕获异常向上抛，而该函数所有其它失败都返回 `failed("WEB_…")` 结构体；异常走到 `production-runtime-tools.ts` 之外，行为是「运行失败」而不是「工具失败」，也与同文件内 recall/reminder 的 catch-转失败（production-runtime-tools.ts:662-684）不一致。另外 `createProductionModelEgress` 的 `derived ??=`（production-model-egress.ts:75-85）把**一次瞬时失败的 rejected promise 永久缓存**：一次密钥服务抖动后，web 外发会持续失败直到进程重启（聊天那条线的缓存是独立的，次序上先于工具调用成功过一次，所以「聊天已失败所以无所谓」的辩护不完全成立——作者自己的判断是「可以接受」，我认为可接受但应统一成 failed 结果）。
证据：workflow 115 行 `const tag = await services.externalTag?.();` 无 try/catch；118-120 直接使用；136-215 同函数其它错误路径全部 `return failed(...)`。
建议：把 `outboundWebArguments` 的 await 包进 catch，返回 `failed("WEB_SEARCH_INPUT_INVALID")`/`WEB_FETCH_INPUT_INVALID`（密钥不可得时密钥本来也派生不出占位符）；或至少允许密钥派生重试而不是缓存 rejected promise。

**2. 低 · packages/sensitive-capture/src/external.ts:141（声明与实现不一致，「读代码证实的」）**
问题：作者说「片段（`#` 之后）里的内容只按文字规则遮，不按参数名遮」。实际上 `withoutSensitiveParameters` 用 `input.indexOf("?")` 定位查询，若 `?` 出现在片段里（例如 `https://a/#/reset?token=x`），片段尾部会被当查询按参数名遮。
证据：external.ts:141 `const query = input.indexOf("?",)` 只找第一个 `?`，不看它在不在 `#` 之后；`fragment = input.indexOf("#", query)` 只找 `?` 之后的 `#`。
建议：改声明文字即可（多遮不是泄漏）；若要严格符合声明，先把 `?` 限定在第一个 `#` 之前。

**3. 低 · scripts/check-egress-redaction.mjs:210-214、244-250**
问题：本 PR 给 `SENSITIVE_GATE_CALLS` 建了双向检查（350-354 行：登记了但已无调用 → 报错删行），但新的 `REQUIRED_EXTERNAL_REDACTION_CALLS` 只有单向：文件里出现出口 pattern 才检查遮盖调用在不在；出口 pattern 消失或被挪走后登记行不会被发现。而且检查是**按文件**的（244-250 行对整份文件文本匹配 `\bredactForExternalText\(`），不是按出口点：将来若搜索路径的重遮被挪走、fetch 路径仍在，文件级检查照样通过，搜索词就会裸发。
证据：210-214 只查「登记的外部出口必须在表里」；244-250 以 `pattern.test(text)`（整文件）为前提；e4 的反向用例只覆盖「整份文件缺一个函数」。
建议：加一条和 350-354 对称的「登记了但已无外部出口」反向检查；如需按出口点，最小做法是在每个 `fetch/callTool` 发送点的关键字（例如 `callTool(`、`fetchImpl(`）旁边断言遮盖调用在其前面的代码块里。

**4. 低 · 边界行为变化（读代码证实，风险极小）**
问题：遮盖会把值变长（`[密码#abcdefgh]` 约多 10 个字符，百分号编码后约 30 字节），而两个限制都按**遮后**长度判：入口 `Buffer.byteLength(args["query"]) > 4096`（production-coding-workflow.ts:192）和 DeepSeek 的 `[...query].length > 128`（deepseek-web-provider.ts:70-71）。旧代码里「password: xxx」这类查询原文通过且长度临界点以下，现在可能在临界点被拒（这类查询以前多数被整段拦下，所以实际影响仅限密码/验证码类）。另一侧：纯密钥查询遮后变短，4097 字节的查询可变合法——这正是 PR 目标。
建议：在文档或测试里记一句「限制按遮后长度」，避免以后当 bug 排查。

**5. 信息（不算缺陷）· packages/sensitive-capture/src/redaction.ts:66、304**
问题补充说明：作者说「两个不同的密码得到不同的占位符，搜索缓存不会串」——对密码/验证码成立（带编号 tag）。但机器密钥的占位符是固定的 `[密钥]`（`MACHINE_SECRET_PLACEHOLDER = "[密钥]"`，无编号）：两个只在密钥值上不同的搜索得到相同遮后 query → 相同缓存键 → 第二个命中缓存。语义上无害：发给搜索引擎的字节本来就相同，结果相同。但「缓存不会串」的声明只覆盖了密码一类，机器密钥类会合并。

**6. 信息 · 产物一致性核对（全部读代码证实，无问题）**
- 四个文件（exa、deepseek、typesafe、production-coding-workflow）已无 `scanMachineSecrets`/`assertMachineSecretFree` 调用，与 `SENSITIVE_GATE_CALLS` 的删行一致（grep 证实：platform-node/src 只剩 trusted-model-provider.ts:127、strict-configuration.ts:1183 有 `assertMachineSecretFree`，均仍登记 KEEP）。
- `check:egress-redaction` 挂进 `npm run check`（package.json:27、50），包含脚本及其 tooling 测试。
- 出口 pattern 的字符串只出现在登记过的三个 src 文件里（grep 证实），不会触发「未登记的外部出口」误报。
- 删除的注释逐条见到 diff，新代码无注释，与项目规则一致。

**未核实**：作者宣称的反向验证（换回 8 个源文件 → 10 条新测试失败）我无法运行测试证实；我读过的反向用例（egress-redaction-check.test.mjs:141-155、152 行的「每个登记文件都写明函数」）设计上确实会在 reverte 后失败，以及各 `[mask-not-block]` 测试在旧代码下会失败（旧代码走 `scanMachineSecrets` 拒绝路径，测试断言的是「成功且发出遮后字节」），但 10 条这个数字本身未核实。

---

## 必答问题逐条

**1. 会不会改变模型已经见过的请求开头？——不会。**
读代码证实：本 PR 对发给模型的请求本身只动了 `model-egress.ts` 的重构——旧的内联 tag `(kind, secret) => letters(sign(key, "${kind}\0${secret}"))` 与新 `placeholderTag`（model-egress.ts:120-125、218 行处）逐字符相同，同一个 `await this.#options.key()`（199 行）。遮后的 query/url 只进：外部请求、`WebToolMemory.key`（449-455）、`hostWeb.execute` 实参（468）、`ctx.save("input")`（514-527）、授权 intent 的 `input-digest`/`resourceRef`（280、316）——都不写回历史。历史里的工具调用参数仍是模型原文（`stableCall(call)` 用原始参数存 checkpoint，production-coding-workflow.ts:56-70、247 行）。新出现在工具结果里的遮后 url（例如 `parseExaFetchResult` 返回的 `url`，exa-public-search.ts:117）只属于**新产生**的、追加在末尾的工具结果；以前这类搜索根本不执行（`scanMachineSecrets` 拦下），既有历史里没有这类结果，故已发内容逐字节不变。结论：满足 prompt-prefix.md 第 4 条。

**2. 会不会让同一段文字在不同请求里变成不同字节？——不会。**
读代码证实：占位符编号是 `HMAC(同一把密钥, kind\r\0value)`（production-model-egress.ts:77-87 派生自同一密钥引用 `payload-encryption`，HMAC 确定性），聊天和外部用同一来源，且 external 用无状态调用（无 `known` 跨请求记忆），同一段文字 → 同一字节。已知与请求历史无关的规则（redactForEgress 的 trusted 机制外部不传，未用）。幂等性有测试直接锁定（external.unit.test.ts:80-86、111-118：「已遮过再遮不变，带不带编号一样」）。`JSON` 序列化等未新增可变字段。仅两个和「不同字节」相关的注意点：密钥轮换仍会整体改变占位符字节（prompt-prefix.md 第 79 行已把这条列为排查项，非本 PR 引入）；机器密钥占位符无编号使**不同密钥值**在出口处字节相同（问题 5 的说明），方向上不会造成不稳定。

**3. 有没有对应的自动检查，反向用例会不会真的失败？**
读代码证实（除运行外）：`scripts/check-egress-redaction.mjs` 新增了双向约束（登记表必须有函数名 / 有登记文件必须被执行检查覆盖），挂进 `npm run check`（package.json:27、50）；反向用例写了对具体报错文本的断言（egress-redaction-check.test.mjs:141-165），我把 fixture 语义核对了会按设计报错。7 个 `[mask-not-block]` 测试抓的是不同层（DeepSeek HTTP body、Exa MCP 参数、TypeSafe HTTP body、hostWeb 实参、沙箱保存输入），按行核对旧代码下这些测试会失败（旧代码走的是拒绝/裸发路径）。**未核实**：实际运行结果，包括作者宣称的「10 条失败」计数。

**4. 改动产生或修改的每个值，两端都能接受吗？**
逐对核对：`redactForExternalQuery/text` → DeepSeek（trim 后仍走原有校验）、Exa（同）、TypeSafe（`redactedState` 仅遮 `state`，问题清单不遮，合成用原始 envelope——typesafe-jev-transport.ts 的 `#prepare`/`#synthesize` 链条已确认）；`redactForExternalUrl` → `validatePublicFetchUrl`（exa-public-search.ts:120-144，接受遮后字符串：≤8192 字节、可 `new URL`、无 userinfo、公网 host——遮后值全部满足，user:pass 在遮盖阶段已摘除）、DeepSeek `#post` body、Exa `callTool` 参数；`externalTag` 返回的编号线（8 个小写字母）满足两侧占位符模式 `[a-z]{8}`（ militia-egress 流式恢复器、external 的 own-placeholder 检测都在用同一形态）；`[密钥]` 与聊天占位符同形（无编号）；`resourceRef`/`input-digest` 只是 hash 输入从原文改为遮后值，`coding:hash` 格式未变；登记表键与真实文件、真实 pattern 一致（grep 证实）。未发现两端校验不匹配。**未核实**：`WebToolMemory.key` 的具体序列化函数与 intent 合约对 id 的完整 schema（格式未变，风险低）。
