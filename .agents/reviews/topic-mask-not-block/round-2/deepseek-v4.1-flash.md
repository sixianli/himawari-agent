# 审核结论

方向是对的：把“命中就整段拒绝”改成“在真正的出口遮值”，符合 Andy 的决定，也和 ADR 0146 的“发送时遮盖”一致。但这份方案把“出口遮盖已经覆盖工具结果”当成了既定事实，实际有多个缺口；另外“删错误码、改分类、还原占位符”没有按 I-73 的要求核对生产端到消费端。

## 一、已证实的问题（按严重度）

### 高

**1. 工具结果不是“整段都会被遮”**
- 问题：工具结果在运行时是一整段 `pi-result.v1` JSON 字符串（`packages/runtime-pi/src/pi-runtime-adapter.ts:2011`），出口遮盖把它当纯文本跑规则，并未解析内部字段。`packages/application/src/services/model-egress.ts:397` 对 `data:` 开头的字符串直接放行；`:346-366` 对 `file`、`input_file`、`document` 等 opaque 类型整块跳过；`:411-414` 跳过 `name`、`id` 等键和推理字段。更关键的是，`packages/sensitive-capture/src/redaction.ts:62-63` 的密码规则和 `machine-secrets.ts:39-42` 的赋值规则要求关键词后紧接 `:`/`=`，所以 JSON 里的 `"password":"hunter2..."`、`"api_key":"..."` 匹配不到。
- 证据：`pi-host-publication.ts:158-163` 原来扫描的是序列化后的整个信封；改成不拦后，这类结构化密钥会原样进入模型请求。
- 建议：在工具边界按结构化数据遮盖，或让出口遮盖解析 `pi-result.v1`/JSON 后递归遮盖；只对非文本媒体跳过 `data:`；不要无条件跳过 `file`/`input_file`/`document`；补 `{"password":"..."}`、`data:`、附件文本的端到端用例。

**2. 命令完整输出确认会进模型请求，且 base64 绕过出口遮盖**
- 问题：方案把“完整输出会不会进模型请求”留到开工第一步核实。代码已经显示会进：`pi-host-publication.ts:173-185` 把 `fullOutput` 写进结果信封，`pi-output-export.ts:43-50` 把原始字节 base64。出口遮盖看到的是 base64，规则匹配不到；导出前的检查只有 `containsToolOutputSecret`（机器密钥），密码、银行卡、证件号不在检查范围。
- 证据：`pi-output-export.ts:43-50`；`pi-host-publication.ts:100-117` 的 `serialize`。
- 建议：既然是模型结果，就先对可解码的 UTF-8 文本遮值再 base64；二进制要明确策略。遮值后会改变字节，必须重新计算大小并处理上限；`digest`/`byteLength` 不能再声称是原文件的校验值，建议保留原文件摘要、另加“已遮值”标记。

**3. 自动整理记忆的占位符没有可用的“对应表”**
- 问题：后台模型调用 `PiModelTransport` 创建 `exchange`（`packages/runtime-pi/src/pi-model-transport.ts:313`），输出只经过 `StreamingMachineSecretRedactor`（`:336`、`:383-406`），没有调用 `exchange.restore`。`production-model-composition.ts:597-615` 只是把输出文本拼起来。`exchange.table` 只在本次请求**新遮到**值时填充（`model-egress.ts:142-149`、`redaction.ts:194-204`）。
- 影响：方案说“用这次请求的对应表还原后存”，但表没有暴露到记忆整理层；历史里带过来的占位符、以及 `[密钥]`（机器密钥）都不在表里，无法还原。配合 `credentialFindings` 不再把占位符当凭据，最后会把 `[密钥]`/`[密码#...]` 当成正常记忆存下来。
- 建议：给后台传输加一个显式的“还原输出”选项并暴露表；或者记忆只存原文引用、显示/发送时再解析；明确 `[密钥]` 无法还原时的行为。不要承诺表外内容也能还原。

**4. 存储侧的 `restricted` 分类仍然会拦下或降级**
- 问题：即使删掉 `scanMachineSecrets`，存储侧还有 `containsRestrictedIdentifier` 和 `restricted` 分类：`production-memory-control.ts:164-171` 拒绝，`:558-559` 拒绝 `restricted`；`production-reminder-writer.ts:192-203`、`:220-221` 同样；`automatic-memory-service.ts:144-149` 无条件排除 `restricted` 候选；`production-memory-capture.ts:281-289` 只要命中宽规则就标成 `restricted`。
- 影响：“不加分类下限”不是无操作，它会改变 `dataClassification`，进而影响记忆召回和模型披露策略；如果出口遮盖漏掉卡号，可能把卡号送到更低信任的模型上下文。
- 建议：把“是否含敏感值”和“数据分类”分开决定；明确是否保留 `restricted` 并在出口遮；对银行卡、证件号、提醒、审批编辑各加用例。不要为了“存得下”直接降级分类。

**5. 搜索缓存键用无编号占位符会串结果，URL 参数规则也会误伤**
- 问题：方案让 `redactForExternalText` 生成不带编号的占位符，又用它做结果匹配和缓存键。`packages/platform-node/src/web-tool-memory.ts:37-57` 的键就是查询词；两个不同密码都会变成 `[密码]`，缓存键相同，第二次查询会拿到第一次的结果。`packages/sensitive-capture/src/identifiers.ts:15-20` 的 `isSensitiveQueryParameter` 是子串匹配，`monkey`、`hockey` 都会命中 `key`，`sig` 反而匹配不到。
- 证据：`web-tool-memory.ts:37-57`；`identifiers.ts:15-20`。
- 建议：缓存键/身份标识使用带编号的确定性占位符（HMAC(kind+value)），不要用裸占位符；URL 参数用整名匹配或白名单，并单独处理 `sig`、`X-Amz-*` 等签名参数。补“两个不同密钥不串缓存”和“签名 URL”用例。

**6. 网页搜索/读网页在 provider 层仍然整段拒绝**
- 问题：方案说删掉 `web-provider-failure.ts` 里的 2 条提示就能“照常返回”，但真正拒绝在 provider：`exa-public-search.ts:251`、`:320` 抛 `WEB_SEARCH_OUTPUT_REDACTED`/`WEB_FETCH_OUTPUT_REDACTED`；`deepseek-web-provider.ts:33` 抛 `*_OUTPUT_REDACTED`；`untrusted-content.ts:27-29` 还会把网页内容里的机器密钥替换成 `[REDACTED_MACHINE_SECRET]`。
- 影响：只删提示不解决问题，搜索/读网页仍会失败；如果改掉这些抛错，又要同步 `WebProviderFailureCode`（`packages/application/src/ports/web-providers.ts:62`）和测试。
- 建议：把 provider 的抛错改成遮值；明确 `untrusted-content` 的机器密钥替换是否保留；更新错误码联合类型、`web-provider-failure.ts:48-51,84-87` 和测试。

**7. 对话标题的 fallback 用原文，推送路径可能带出原始密钥**
- 问题：`production-thread-titles.ts:74`、`:94` 现在用 `assertMachineSecretFree` 拦住含机器密钥的标题；生成失败时 `:92` 调用 `openingWords(text)`，而 `:152-156` 直接从**原始用户消息**截前 24 个字。如果删掉最后的 `assert` 来“照常存”，一条以 `AKIA...`、JWT、私钥开头的消息就会原样变成标题；`production-web-push.ts:507-535` 又把标题作为推送正文发出去。
- 影响：这是新出现的原始密钥落库/出站路径，不是“页面自己看”那么简单。
- 建议：fallback 用遮值后的文本，或保留最终检查并把不安全标题换成安全占位；推送前明确是否要再遮一次。

### 中

**8. 错误码不能全局删除**
- 问题：方案说“删掉的错误码：全局清理测试、文档、页面文案”，但很多码仍会被存活路径产生：
  - `PI_TEXT_READ_REJECTED` 仍用于 NUL/非 UTF-8：`packages/runtime-pi/src/host-read-only-executor.ts:139-145`、`packages/platform-node/src/files/sandboxed-coding-operations.ts:164-166`；
  - `MEMORY_TEXT_REFUSED` 仍用于空文本/`restricted`：`production-memory-control.ts:559,733`；
  - `REMINDER_TEXT_REFUSED` 仍用于空文本/`restricted`：`production-reminder-writer.ts:221`；
  - `AI_GATEWAY_INPUT_REJECTED` 仍用于出口自检和未知路径：`pi-model-transport.ts:295,410,424`、`model-egress.ts:167-185`。
- 影响：删掉会破坏 NUL/空文本/拒发路径的测试和旧持久化数据；这正是 I-73 的教训：产生端删了，消费端不一定接受。
- 建议：逐个错误码列产生者和消费者，只删真正不再产生的；旧值继续被接受；同步 union、测试、i18n；加“产生→消费”契约测试。

**9. 保留的出口自检仍然会整请求拒发，而且发生在写入之后**
- 问题：方案保留 `model-egress.ts:213-217` 的自检。只要遮完仍有机器密钥，`pi-model-transport.ts:409-411` 就把整次请求判为 `AI_GATEWAY_INPUT_REJECTED`。对写文件/编辑来说，文件可能已经写成功（参见 `docs/backlog/BL-20261017-001` 的“写后才拒”），模型却拿不到结果。
- 另外，方案说“只在出口自检拒发时产生新记录”，但记录器目前只有 `reportEgress`（outcome `masked`，`sensitive-interception-recorder.ts:63-81`）；`withheld` 只在枚举和 UI 里存在（`sensitive-interceptions.ts:35`），没有生产者；`production-model-egress.ts:87` 也只注册了 `reportEgress`。
- 影响：这是“整段拦下”的另一种形式，且发生在不可撤销操作之后；记录页也不会出现方案承诺的新记录。
- 建议：加 `withheld` 生产者（不记录密钥值）；拒发要可重试/幂等；写操作之后不要把整次请求打死，宁愿在工具边界先遮；补“写入成功后自检失败”的用例。

**10. 调用点登记检查不够，现有出口检查也没覆盖 TypeSafe/Exa/DeepSeek**
- 问题：`scripts/check-egress-redaction.mjs:8-16` 只要求主对话、后台、嵌入 3 个出口；`:50-65` 的 `EGRESS_PATTERNS` 只认 `/embeddings`、`/chat/completions`、`modelRuntime.stream`，不认 `/v1/systemone`、`/v1/tools/search`、`/v1/tools/fetch`。方案新加的“调用点登记”只检查这四个函数有没有被调用，不检查返回值是否被使用、遮出来的值是否能被下游接受。
- 影响：注册一个调用但忽略返回值就能绕过；新增外部出口不会被发现；这正是 I-73 说的“只看了改动，没问清单里的值能不能过后端校验”。
- 建议：把 `REQUIRED_REDACTION_CALLS`/`EGRESS_PATTERNS` 扩到 TypeSafe、Exa、DeepSeek、`fullOutput`；加“抓取真实出站字节”的端到端用例和确定性用例；登记表只作为辅助 lint。

**11. `production-coding-workflow.ts:194` 不是 DeepSeek 说的那个安全漏洞**
- 问题：`production-coding-workflow.ts:194` 确实没用返回值，但 `deepseek-web-provider.ts:131-132` 和 `exa-public-search.ts:277` 都会再次 `validatePublicFetchUrl` 并使用返回值。真正的风险是“工作流存的 `args`、缓存键、provider 实际读取的 URL 可能不是同一个值”；`web-tool-memory.ts:46` 的 fetch 键仍用 `args["url"]`。
- 建议：在入口处净化/规范化一次，把同一个值用于校验、缓存键、保存的输入和 provider；provider 继续二次校验作为纵深防御。

**12. 规则文件、ADR、界面文案和代码会不一致**
- 问题：`docs/adr/0146-...md:44` 还写着“存储边界的‘命中机器密钥就拒绝’不变”，`:50` 也基于“发送时遮盖”而非“写入时遮盖”；`docs/adr/0167-...md:61` 明确说存储侧保留宽规则。界面文案也有“看起来像密码或密钥的搜索词会被拦下”（`apps/control-center/src/i18n/resources/zh-CN.ts:882`）、“还没有拦下过敏感信息”（`:1172`）、“整段没发给模型”（`:1177`、`:1211`）。
- 建议：PR 5 要明确 supersede/更新 0146、0148、0167，列出所有 i18n 和文档改动；否则实现和说明会继续互相矛盾。

### 低 / 待核实

- **Muse 外部输入存原文**：`production-muse-intake.ts:388-395` 的 `storable`、`:453-458` 的 `keep` 现在会扣住外部来源里的机器密钥。改成存原文后，外部持有 Muse 密钥的人可以把私钥等写进数据库。它目前似乎只用于页面/推送，不发给模型；但这是防御纵深问题，建议至少对机器密钥保留“入库前遮”或明确记录理由。
- **提醒/标题的 Web Push**：`production-web-push.ts:472-498` 直接读提醒原文，`:507-535` 读标题。Web Push 是外部 HTTP 出口；即使推送库对浏览器端点加密，服务端仍把正文交给推送服务。需要明确“推给自己”算不算允许的明文去向。
- **资源耗尽**：改成不拦后，原本被替换成一句提示的大段输出会进入历史；`redaction.ts:268-282` 对每个 `known` 值建一次正则并扫全文，`known` 越多越慢。`fullOutput` base64 还会放大 token 和 CPU。建议加上限（已知值数量、单次遮值字节数、完整输出预算）。
- **附件 opaque 类型**：`model-egress.ts:346-366` 对 `file`/`input_file`/`document` 整块跳过；我没有确认附件文本是否以这些类型发送。若会，附件里的密钥不会被遮。
- **“49 处”数量**：当前是 detached + sparse checkout，未与 `origin/main` 对比，无法核实 49 这个数字。而且清单混入了元数据/配置检查（`trusted-model-provider.ts:127`、`strict-configuration.ts:1183`、`reflection-service.ts:144`），它们并不是“整段拦下内容”。
- **`ThreadCheckpointService`/`ReflectionService` 生产未实例化**：grep 只在测试里看到构造，生产很可能确实没有；未完全核实。
- **`typesafe` 响应遮值**：如果直接对原始 JSON 字符串跑 `redactForEgress`，`"password":"..."` 同样匹配不到；应按解析后的字段遮。

## 二、侧重检查

我重点查了这些路径：

- **错误路径**：出口自检拒发（`model-egress.ts:213-217` → `pi-model-transport.ts:409-411`）、provider 输出拒绝（Exa/DeepSeek）、工具发布 `withhold()`（`pi-host-publication.ts:131-156`）、标题生成失败 fallback（`production-thread-titles.ts:92`）、web push 内容构造（`production-web-push.ts:472-535`）。结论：拒发仍可能发生在写入之后；provider 层拒绝没被方案覆盖；标题 fallback 是新泄漏点。
- **不合规范/不可信输入**：Muse HTTP 入库（`production-muse-intake.ts:388-395`）、网页 URL（`validatePublicFetchUrl`）、搜索查询、TypeSafe 的 `state`。结论：URL/参数的二次校验存在，但子串匹配会误伤/漏签名参数；Muse 存原文是防御纵深退步。
- **安全/出站**：模型（`model-egress`）、嵌入（`embedding.ts:193-194`）、TypeSafe（`typesafe-jev-transport.ts:295,387`）、Exa（`:251,320`）、DeepSeek（`:33`）、Web Push（`production-web-push.ts`）。结论：前三类有明确路径，后两类仍有整段拒绝，Web Push 未被方案归类。
- **资源耗尽**：大工具输出、`fullOutput` base64、`known` 循环。结论：需要预算/上限。
- **不可撤销操作**：写/编辑/复制/移动；`pi-host-publication.ts:359` 先写文件，再整理结果。结论：保留的整请求拒发会重现 BL-20261017-001 的“写后失败”。
- **规则/文档/代码一致性**：ADR 0146 第 44/50 条、ADR 0167 第 61 条、`check-egress-redaction.mjs`、i18n。结论：方案需要显式更新这些文件，不能只说“清理错误码和文档”。

## 三、如果由我定，我会怎样改

1. **先统一“出口遮盖契约”**：所有出站（模型、嵌入、TypeSafe、Exa、DeepSeek、Web Push、日志/导出）都必须调用同一个确定性遮值函数；用带编号的占位符做身份和缓存键，绝不裸 `[密码]`。
2. **先补出口缺口，再拆拦截面**：解析工具结果 JSON、修 `data:`/opaque 跳过、处理 `fullOutput` base64、补结构化密钥规则。否则“改成不拦”只是把泄漏从工具层挪到出口层。
3. **存储侧分开“检测”和“分类”**：记忆/提醒/标题可以存原文，但不要顺手删 `restricted` 分类而不评估召回和披露策略；先加一个开关和测试，再决定是否降级。
4. **自动整理记忆不要依赖“这次请求的对应表”**：要么让后台传输显式还原输出，要么记忆只存原文引用；`[密钥]` 明确无法还原。`credentialFindings` 的改动单独出测试，不要顺带改。
5. **保留旧错误码的消费能力**：只删不再产生的代码，不删消费者；新增 `withheld` 记录路径，不记录密钥值；写操作之后的拒发要可重试/幂等。
6. **测试改成永久的入口级行为测试**：每个出站抓取实际字节，正向断言“遮了且其余不变”，反向断言“没密钥时是原文”，再断言“去掉遮值实现就失败”。调用点登记只做辅助。
7. **每个 PR 按“出口”切，不要按“函数”切**，并把 ADR/i18n 一起改；PR 1 的登记表只能作为过渡，不能替代行为测试。

## 四、必答问题

**1. 会不会改变模型已经见过的请求开头？**

按方案的理想实现，**不会**：旧历史消息不重写，新工具结果只是在末尾追加；记忆/提醒/标题都在最后一条用户消息的 `<himawari-context>` 里（`pi-runtime-adapter.ts:600-616`），不在系统提示或工具定义里。依据：`.claude/rules/prompt-prefix.md:35-36` 要求只追加；`:6` 说“匹配是逐字节的：开头任何一处变了，从那里往后全部按全价重算”（Anthropic: https://platform.claude.com/docs/en/build-with-claude/prompt-caching ，OpenAI: https://developers.openai.com/api/docs/guides/prompt-caching ，DeepSeek: https://api-docs.deepseek.com/guides/kv_cache ）。

但有三个必须守住的前提：

- 新追加的工具结果/fullOutput 必须在**发送时**用稳定密钥遮值，不能用依赖“这次请求后面内容”的临时表；否则同一段历史在不同请求里可能变成不同字节。
- 不能改占位符说明/系统提示文字（方案没有改，正确）。
- 记忆、提醒、标题必须继续只出现在最后一条消息；如果哪天被塞进系统提示，就会破坏前缀。现有 `check:prompt-prefix` 还没有覆盖“原来被整段扣下、现在原样进入历史的工具结果”和 `fullOutput`，必须扩展。

**2. 会不会让同一段文字在不同请求里变成不同字节？**

模型请求方向：**只要复用现有的带密钥 HMAC 占位符，就是确定的**；`redactForEgress` 的 tag 只取决于密钥和值（`redaction.ts:194-204`），和请求顺序无关。但方案新增的部分有两个问题：

- `redactForExternalText` 不带编号，确定性有了但**不唯一**：不同密钥映射到同一个 `[密码]`，缓存键/结果匹配会串（见问题 5）。
- 自动整理记忆“用这次请求的对应表还原”本身是**请求相关**的；同一段模型输出在不同请求里可能因为表不同而存成不同文本。这不是模型前缀问题，但违反“同一段文字每次同样字节”的原则。若还要把它再送回模型，就会间接影响后续字节。
- 现有的 `named-earlier` 例外已经允许“点名消息被压缩后，后面遮法变化”（`.claude/rules/prompt-prefix.md:53`）；方案不要扩大这个例外。

建议：所有需要身份/缓存/持久化的地方都用带编号的确定性值；不要用裸占位符；记忆还原要么可复现，要么不承诺。

**3. 有没有对应的自动检查？反向用例真的会失败吗？**

现有检查：`npm run check:prompt-prefix` 覆盖多轮、工具调用、银行卡、记忆/时间、冻结，并有 3 条反向用例（`packages/runtime-pi/test/prompt-prefix.compat.test.ts`）；`npm run check:egress-redaction` 要求 3 个出口并禁止重复规则（`scripts/check-egress-redaction.mjs:8-16`）。

方案的测试计划不够：

- “每个改成不拦的用例先在旧代码跑一次”是一次性人工验证，不是永久回归保护。
- 没有覆盖 TypeSafe/Exa/DeepSeek/Web Push/fullOutput 的出口。
- 没有覆盖结构化 JSON 密钥、`data:`、opaque 附件、base64 完整输出。
- 调用点登记只证明“调用了”，不证明“用对了”，不能替代 I-73 的两端校验。
- 没有 `withheld` 记录的测试，也没有“写入后自检失败”的测试。

建议补：每个出口抓真实字节的正/反向用例；两次相同前缀请求的字节一致性用例；旧错误码仍被消费端接受的契约测试；遮值实现被删掉时必须失败的负向测试；`check:egress-redaction` 扩展到全部出口。

**4. 改动产生的每个值，两端都能接受吗？**

逐项核对后，不能直接说“能”：

- **无编号占位符**：`EGRESS_PLACEHOLDER_PATTERN` 只认 `[密码#xxxxxxxx]`（`redaction.ts:55`），裸 `[密码]` 不会被 `restore` 还原；用作缓存键还会串结果。要么不用裸占位符，要么明确它只用于一次性外部文本，不参与身份。
- **净化后的 URL**：`production-coding-workflow.ts:194` 忽略返回值，但 provider 会再次校验并使用（`deepseek-web-provider.ts:131-132`、`exa-public-search.ts:277`）；真正要统一的是入口、缓存键、保存输入和 provider 的值。`isSensitiveQueryParameter` 的子串匹配还会误伤 `monkey` 等参数（`identifiers.ts:15-20`）。
- **错误码**：`PI_TEXT_READ_REJECTED` 仍被 NUL/非 UTF-8 使用（`host-read-only-executor.ts:139-145`、`sandboxed-coding-operations.ts:164-166`）；`MEMORY_TEXT_REFUSED`、`REMINDER_TEXT_REFUSED`、`AI_GATEWAY_INPUT_REJECTED` 也仍有生产者。不能全局删；旧持久化值也要继续被接受。参照 I-73（`docs/incidents-and-gates.md` 第 I-73 行）。
- **`withheld` 记录**：端口/契约/UI 已经接受 `withheld`（`sensitive-interceptions.ts:35`），但记录器没有生产者（`sensitive-interception-recorder.ts:63-81`）；要新增，且 `category`/`ruleId`/`fingerprint` 必须合法、不能带密钥值。
- **`fullOutput.digest`/`byteLength`**：遮值后重新计算，消费端会以为它对应原文件；要么保留原文件摘要，要么改字段语义并更新所有使用处。
- **`dataClassification`**：从 `restricted` 降到 `private` 会被记忆召回/披露策略接受，但这是策略变化，不只是序列化变化；要逐处确认（`automatic-memory-service.ts:144-149`、`production-memory-control.ts:558-559`）。
- **搜索/缓存键**：`web-tool-memory.ts:37-57` 和 `ctx.save("input", ...)`（`production-coding-workflow.ts:497-508`）必须使用和 provider 相同的净化值，否则缓存、审计和实际请求三份值不一致。
- **Muse/提醒/标题**：`production-muse-intake.ts:453-458`、`production-reminder-writer.ts:220-221`、`production-thread-titles.ts:92-94` 和 `production-web-push.ts:472-535` 都要逐个决定“存原文后，哪些消费端还能接受”。标题 fallback 目前明确不能接受。
