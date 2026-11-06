# 去掉“整段拦下”、改为只遮敏感值的独立方案

## 结论先行

我认为最好的方案不是“把 49 处都改成同一个遮值函数”，而是按**内容最终去哪里**分三层：

1. **会发给模型的文字**：删掉各处的“整段拒绝”，原样进入历史/工具结果，由唯一的出口 `ModelEgress` 遮值；TypeSafe 这条不走出口的模型路径，必须在它自己的 transport 里补遮值。
2. **会发给模型以外服务的文字**：在 Exa、DeepSeek、TypeSafe 的发送边界遮值，不能原样放行。
3. **要求字节原样的复制、导出、恢复产物**：按 Andy 的决定原样放行，不遮也不拦。

两个“建议保留”的检查中，我的判断与线程建议不同：

- `model-egress.ts:214` 的遮后自检**保留**；
- `strict-configuration.ts:1183` 的配置校验**保留**；
- `trusted-model-provider.ts:127` 的请求前整包检查**不能原样保留**。它在出口遮盖之前执行，会把本来能被出口遮掉的密钥当成整包拒绝；如果保留它，删掉 49 处也没有效果。应删除，或收窄成“只检查出口不遮的不可逆字段”。

---

## 一、方案依赖的前提

### 读代码或一手来源证实的

| # | 前提 | 来源与原话 | 状态 |
|---|---|---|---|
| 1 | 模型缓存按逐字节前缀匹配，已发内容只能末尾追加 | `.claude/rules/prompt-prefix.md:6`：“匹配是逐字节的：开头任何一处变了，从那里往后全部按全价重算。”同文件 `:35`：“已经发给过模型的内容，不得改动、重排或删除，只能在末尾追加。”`[发给模型的内容只追加](../../.claude/rules/prompt-prefix.md#rules)`；Anthropic https://platform.claude.com/docs/en/build-with-claude/prompt-caching；OpenAI https://developers.openai.com/api/docs/guides/prompt-caching；DeepSeek https://api-docs.deepseek.com/guides/kv_cache | 已核实 |
| 2 | 历史存遮盖前原文，每次发送时重新遮；遮盖必须确定 | `.claude/rules/prompt-prefix.md:36`：“历史里存的是遮盖前的内容，每次发送时按确定的规则重新遮盖。”同文件 `:51-52`：“同样的内容，每次都要序列化成同样的字节。”“遮盖敏感信息必须是确定的。”`model-egress.ts:186-218` 每次请求对整段请求体重新遮 | 已核实 |
| 3 | 出口占位符由 HMAC 生成，同一值稳定 | ADR 0148 决定 4：“编号是 8 个小写字母，由 HMAC-SHA256（类型、值）取得”；`redaction.ts:186-206`、`model-egress.ts:186-218` | 已核实 |
| 4 | 存储侧现有规则故意偏宽，和出口规则用途不同 | ADR 0167 第 2 条：“存储这一侧宁可多拦，所以保留宽的规则。两套规则用途不同，都放在这个包里。”`identifiers.ts:1-6` 的 `containsRestrictedIdentifier` 不校验 Luhn/身份证校验位 | 已核实 |
| 5 | 复制、导出、恢复产物必须字节原样 | Andy 原话（材料）：“这些本来就不应该遮啊”；`workspace-copy-service.ts:62-99` 按字节保存并算 digest；`pi-output-export.ts:43-50` 返回 base64、长度、SHA-256；`production-sandbox-services.ts:1959-1988` 对 JSON 明文算 hash 并校验 | 已核实 |
| 6 | 配置文件只允许密钥引用，不允许直接写密钥 | `strict-configuration.ts:1182-1189`：`assertMachineSecretFree(JSON.stringify(input))`，失败抛 `SECRET_MATERIAL`，错误文字是“Configuration must contain only secret references” | 已核实 |
| 7 | TypeSafe 代码审核不经过出口遮盖 | `typesafe-jev-transport.ts:288-296` 自己拼 body、`:362-387` 自己 fetch/读响应；`production-model-composition.ts:381-383` 把 `typesafe-systemone` 路由到 `TypeSafeJevTransport`，不是 `PiModelTransport` | 已核实 |
| 8 | 网页搜索/抓取的查询词不经过模型出口 | `exa-public-search.ts:217`、`deepseek-web-provider.ts:77`；`scripts/check-egress-redaction.mjs:8-16,50-65` 只登记了主对话、辅助调用、嵌入三个模型/嵌入出口，网页 provider 不在其中 | 已核实 |
| 9 | `trusted-model-provider.ts:127` 在出口遮盖之前执行 | `trusted-model-provider.ts:125-127` 先 `assertMachineSecretFree(JSON.stringify(request))`；`production-model-composition.ts:377-384` 之后才调用 `piTransport.invoke`，而 `pi-model-transport.ts:313-314` 才 `exchange.wrapFetch` | 已核实 |
| 10 | 拦截记录已有三种结果；`withheld` 目前没有接线 | `ports/sensitive-interceptions.ts:35`：`["masked", "withheld", "not_saved"]`；`sensitive-interception-recorder.ts:63-109` 只产生 `masked` 和 `not_saved`；`components/sensitive-interceptions.tsx:72-78` 在 `withheld` 为 0 时本来就不显示该筛选项 | 已核实 |
| 11 | I-73 的教训是：改动的生产值必须逐个核对使用点的校验，不能只看 diff | `docs/incidents-and-gates.md:112`：“双模型复核只看了 diff，没问「清单里的 id 能通过后端校验吗」” | 已核实 |
| 12 | 业界主流做法是“遮命中片段”，不是“命中就整段拒绝” | AWS Bedrock Guardrails：“Mask — Sensitive information filter policies can anonymize or redact information from model requests or responses… replaces it with the PII type” https://docs.aws.amazon.com/bedrock/latest/userguide/guardrails-sensitive-filters.html；Google Sensitive Data Protection：“detects sensitive data… uses a de-identification transformation to mask, delete, or otherwise obscure the data” https://cloud.google.com/sensitive-data-protection/docs/deidentify-sensitive-data；Presidio：“Anonymizers are used to replace a PII entity text with some other value by applying a certain operator” https://microsoft.github.io/presidio/anonymizer/ | 已核实（一手文档） |

### 推测或未核实

- 我未逐一跑完所有 `ModelPort` 实现来证明“所有模型路径都只经过 Pi 出口或 TypeSafe”；只核实了生产组合里的两条主路径。
- `reflection-service` 的 `output.metadata` 用 grep 没找到其他读取点，但不能证明所有序列化/展示路径都不读。
- 旧提醒的 `contentRef` 指向的历史 payload 是否已经含原始密钥，未逐条枚举。
- 签名 URL（带 `sig=`、`token=`）遮值后是否还能抓取，未实测；按设计会失败。
- 另一个线程“自己的固定指令不检查”会改变出口遮盖的结果；合并顺序和对缓存的影响未核实。
- 测试只能在云服务器/Hermes 上跑；本方案没有实际运行 `npm run check`。

---

## 二、方案本身

### 2.1 总原则

1. **模型出口只留一个遮值点**：`ModelEgress` 继续负责主对话、辅助调用、嵌入。各业务点不再判断“有没有敏感信息”，不再把整段换成错误。
2. **非模型外部出口新增明确边界**：网页搜索/抓取、TypeSafe 在发送前遮值。它们不是模型请求，不能依赖 `ModelEgress`。
3. **字节原样操作不遮**：复制、导出、恢复产物、编辑前读取的原文，按 Andy 的决定原样放行。
4. **只保留“遮完仍漏”的 fail-closed 检查**：`model-egress.ts:214` 保留；`trusted-model-provider.ts:127` 收窄或删除；配置校验保留。
5. **不迁移旧数据、不改出口遮盖规则、不改占位符格式、不轮换密钥**，避免改变模型已经见过的请求前缀。

### 2.2 49 处逐项分类

分类说明：

- **遮值**：在该边界把敏感片段换成占位符，其余内容保留。
- **原样放行**：删掉该处检查；若内容之后会进模型请求，由出口遮。
- **原样放行（出口遮）**：同上，特别注明它最终会经过模型出口。
- **保留**：保留检查。
- **删除/收窄**：删除该检查，或只保留不可遮字段的检查。

| # | 位置 | 分类 | 理由 |
|---|---|---|---|
| 1 | `apps/agent-service/src/capability-programs/host-file-read.ts:146` | 原样放行（出口遮） | 只读工具读到的文字最终作为工具结果发给模型；删 `scanMachineSecrets`，保留 `\0` 二进制拒绝。 |
| 2 | `apps/agent-service/src/capability-programs/pi-coding-request.ts:207` | 原样放行（出口遮） | 命令输出是工具结果；删密钥检查，保留输出上限和流式截断。 |
| 3 | `apps/agent-service/src/production-coding-workflow.ts:175` | 遮值（外部查询） | 这是 `web_search` 查询词，会发给 Exa/DeepSeek；不在工具层整段拒，在 provider 发送前遮。 |
| 4 | `apps/agent-service/src/production-file-preparation.ts:52` | 原样放行 | 编辑前读取原文件用于比对/生成 diff；遮了会把文件写坏。保留 `\0` 检查。 |
| 5 | `apps/agent-service/src/production-file-preparation.ts:68` | 原样放行（出口遮） | `prepared.result` 是工具结果，最终走模型出口。 |
| 6 | `apps/agent-service/src/production-host-read.ts:77` | 原样放行（出口遮） | `output` 是工具结果；删密钥检查，保留大小/截断处理。 |
| 7 | `apps/agent-service/src/production-host-read.ts:78` | 原样放行（出口遮） | 同上，`content/details` 也是工具结果的一部分。 |
| 8 | `apps/agent-service/src/production-memory-capture.ts:281` | 删除“含受限标识即 restricted”的触发；原样放行 | 不再因为正则命中 16–19 位数字就把候选标成 restricted 并最终丢弃；是否存原文见问题 2。 |
| 9 | `apps/agent-service/src/production-memory-capture.ts:752` | 原样放行（出口遮） | 不再因为主人消息含机器密钥就跳过整次记忆抽取；抽取提示走出口遮。 |
| 10 | `apps/agent-service/src/production-memory-control.ts:167` | 原样放行（存原文） | 主人手动加/改记忆时不再因机器密钥整段拒；保留空文本检查。 |
| 11 | `apps/agent-service/src/production-memory-control.ts:168` | 原样放行（存原文） | 不再因宽泛的受限标识规则整段拒；若选“派生记录遮值”方案则改为遮值。 |
| 12 | `apps/agent-service/src/production-muse-intake.ts:392` | 原样放行（存原文） | Muse 写入的 title 不再因密钥/受限标识整条丢；`textWithheld` 设为 false。 |
| 13 | `apps/agent-service/src/production-muse-intake.ts:393` | 原样放行（存原文） | 同上，text 不再整条丢。 |
| 14 | `apps/agent-service/src/production-muse-intake.ts:457` | 遮值 | 只遮含敏感值的 option，保留其他 options；不再把整个 item 的 options 清空。 |
| 15 | `apps/agent-service/src/production-reminder-writer.ts:196` | 原样放行（存原文） | 提醒文字不再因机器密钥抛 `REMINDER_TEXT_REFUSED`；以后进模型时出口遮。 |
| 16 | `apps/agent-service/src/production-reminder-writer.ts:197` | 原样放行（存原文） | 不再因受限标识整段拒。 |
| 17 | `apps/agent-service/src/production-sandbox-control.ts:831` | 遮值（日志） | 诊断日志不是模型出口；把 `hostDetail.text` 用 `redactMachineSecrets` 遮后保留，而不是置 `null`，保留排障上下文。 |
| 18 | `apps/agent-service/src/production-sandbox-services.ts:1962` | 原样放行 | 恢复产物要能按原字节恢复；模型出口另行遮值。保留大小限制。 |
| 19 | `apps/agent-service/src/production-thread-titles.ts:74` | 原样放行（出口遮） | 标题生成是辅助模型调用，输入走出口遮；不再整段 `assert`。 |
| 20 | `apps/agent-service/src/production-thread-titles.ts:94` | 遮值（展示元数据） | 标题是展示用、不会再走出口；至少 fallback `openingWords(text)` 要遮，避免标题成为原文的第二份副本。 |
| 21 | `packages/application/src/services/automatic-memory-service.ts:78` | 保留检测，只作审计；不再用于丢弃 | 可以继续记录“候选里出现过什么类型”，但不能因 `candidateSecretFindings` 非空就整条丢；若选派生遮值，则用 `findSensitiveValues` 区分原始值和既有占位符。 |
| 22 | `packages/application/src/services/automatic-memory-service.ts:104` | 原样放行（出口遮） | 源文本含密钥不再让整次记忆抽取 `source_secret_excluded`；抽取调用走出口遮。 |
| 23 | `packages/application/src/services/automatic-memory-service.ts:278` | 原样放行（出口遮） | 审批后重读源文本时不再整段拒；出口遮。 |
| 24 | `packages/application/src/services/automatic-memory-service.ts:303` | 原样放行（存原文） | 编辑后的记忆不再因密钥整段拒；保留空文本检查。 |
| 25 | `packages/application/src/services/host-file-read-service.ts:153` | 原样放行（model/worker）；external_approved 建议遮值 | 模型/worker 路径由出口遮；`external_approved` 是真正离开信任边界的披露，建议在该分支遮值。这是需要拍板的点。 |
| 26 | `packages/application/src/services/model-egress.ts:214` | 保留（收窄/强化自检） | 这是“遮完仍检出机器密钥就不发”的 fail-closed，不是一刀切拦截；保留。可考虑扩到五类，但会增加一次扫描成本。 |
| 27 | `packages/application/src/services/reflection-service.ts:144` | 删除自检；原样放行 | `output.metadata` 目前只存不用（grep 未发现其他读取）；不为未使用字段让整次 reflection 失败。若以后展示/使用，在使用点遮。 |
| 28 | `packages/application/src/services/thread-checkpoint-service.ts:192` | 原样放行（出口遮） | 检查点源文本走 distill 模型出口；不再整段抛 `INVALID_OPERATION`。 |
| 29 | `packages/application/src/services/thread-checkpoint-service.ts:228` | 原样放行（存原文） | 摘要文本不再因密钥整段拒；保留空文本和分类下限检查。 |
| 30 | `packages/application/src/services/thread-checkpoint-service.ts:235` | 原样放行（存原文） | 候选文本不再因密钥整段拒；保留来源/分类校验。 |
| 31 | `packages/application/src/services/workspace-copy-service.ts:74` | 原样放行 | 复制要求字节原样（Andy 决定）；删密钥检查，保留空间预算和 digest。 |
| 32 | `packages/platform-node/src/deepseek-web-provider.ts:33` | 遮值 | 网页响应先遮再解析/返回，不再整段 `_OUTPUT_REDACTED`；响应最终会进工具结果，但这里先遮更稳。 |
| 33 | `packages/platform-node/src/deepseek-web-provider.ts:77` | 遮值 | 查询词在发给 DeepSeek 前遮。 |
| 34 | `packages/platform-node/src/exa-public-search.ts:121` | 遮值（URL 敏感字段） | `validatePublicFetchUrl` 里的整段拒改为：解析 URL、只遮敏感查询参数值/用户名密码，再做 SSRF 校验并返回净化后的 URL；调用方必须使用返回值。 |
| 35 | `packages/platform-node/src/exa-public-search.ts:217` | 遮值 | Exa 查询词发送前遮；MCP 匹配谓词也要用同一个遮后的 query。 |
| 36 | `packages/platform-node/src/exa-public-search.ts:251` | 遮值 | 搜索结果文字遮后再解析，不再整段 `WEB_SEARCH_OUTPUT_REDACTED`。 |
| 37 | `packages/platform-node/src/exa-public-search.ts:320` | 遮值 | 抓取内容遮后再解析，不再整段 `WEB_FETCH_OUTPUT_REDACTED`。 |
| 38 | `packages/platform-node/src/files/pi-host-publication.ts:139` | 删除（不再有 withhold 路径） | 这是 `withhold()` 生成占位提示后的自检；不再因 secret 走 `withhold()` 后，这段变成死代码。保留其他输出校验。 |
| 39 | `packages/platform-node/src/files/pi-host-publication.ts:154` | 删除（同上） | 同上。 |
| 40 | `packages/platform-node/src/files/pi-host-publication.ts:160` | 原样放行（出口遮） | `shown` 不再触发 `withhold()`；工具结果由模型出口遮。 |
| 41 | `packages/platform-node/src/files/pi-host-publication.ts:161` | 原样放行（出口遮） | 同上，`content/details` 不再触发整段替换。 |
| 42 | `packages/platform-node/src/files/pi-host-publication.ts:193` | 原样放行（出口遮） | `bounded` 只保留大小上限，删密钥检查。 |
| 43 | `packages/platform-node/src/files/pi-output-export.ts:43` | 原样放行 | 导出要求字节原样（Andy 决定）；删 `PI_OUTPUT_SECRET_REJECTED`，保留文件身份/大小/一致性检查。 |
| 44 | `packages/platform-node/src/files/sandboxed-coding-operations.ts:165` | 原样放行（出口遮） | 读工具需要原始字节做编辑；删密钥检查，保留 `\0` 检查。 |
| 45 | `packages/platform-node/src/strict-configuration.ts:1183` | 保留 | 配置不是模型内容；遮值会让配置失效，正确做法是拒绝明文密钥、要求用钥匙串/secret reference。 |
| 46 | `packages/platform-node/src/trusted-model-provider.ts:127` | 删除或收窄 | 原检查在出口之前，会拦住本可由 `ModelEgress` 遮掉的请求；建议删除，或只检查 `ModelEgress` 不处理的 reasoning/thinking 等不可遮字段。 |
| 47 | `packages/platform-node/src/typesafe-jev-transport.ts:295` | 遮值 | TypeSafe 不走出口；必须在 transport 里遮请求体，不能整包拒绝。 |
| 48 | `packages/platform-node/src/typesafe-jev-transport.ts:387` | 遮值 | TypeSafe 响应也遮后再解析，不再整段 `assertMachineSecretFree` 失败。 |
| 49 | `packages/runtime-pi/src/host-read-only-executor.ts:143` | 原样放行（出口遮） | 只读工具输出最终进模型；删 `assertMachineSecretFree`，保留 `\0`/UTF-8 检查。 |

> 额外：`scripts/evals/memory-capture-live.eval.ts:109` 不在 49 处产品代码里，但它模拟旧行为；应同步改成“记录但不丢”，否则 eval 会和产品行为脱节。

### 2.3 两个“建议保留”项和一个“线程建议保留但我建议改”的项

**A. `model-egress.ts:214`：保留。**
它是遮值后的最后一道 fail-closed：如果规则有洞，遮完仍检出机器密钥，就拒绝发送。它不会因为内容“本来有敏感值”而拒绝，只会在“遮失败”时拒绝。建议保留；如果担心性能，不要每请求扩到五类，可保留机器密钥检查，另加异步/抽样检查。

**B. `strict-configuration.ts:1183`：保留。**
这是配置边界，不是用户内容边界。配置里出现明文密钥，遮掉会让服务启动失败或行为不可预期；正确做法是拒绝并要求 secret reference/钥匙串。

**C. `trusted-model-provider.ts:127`：不建议原样保留。**
原因很具体：`TrustedModelProviderAdapter.invoke` 收到的是**出口遮盖之前**的 `ModelInvocationRequest`；PI 路径在 `pi-model-transport.ts:313-314` 才 `exchange.wrapFetch`。如果保留整包 `assertMachineSecretFree`，那么历史里只要有一条原始密钥，整次请求就会在这里被拒，后面出口根本没有机会遮。这样一来，删掉 49 处也没有效果。

建议二选一：

1. **删除**，完全依赖出口 + TypeSafe 自己的遮值；同时接受 ADR 0148 已记录的“reasoning 块不遮”缺口。
2. **收窄**：只扫描出口不处理的字段（`reasoning_content`、`reasoning`、`reasoning_details`、`reasoning_text`、`thinking`/`redacted_thinking` 块等），只有这些不可遮字段里发现原始密钥才拒绝。这样不会误伤可遮内容，又保留对签名推理块的保护。

我推荐第 2 种作为过渡；如果 Andy 要求“一处整段拦截都不留”，则选第 1 种，并把 reasoning 缺口写进 ADR。

### 2.4 非模型外部出口怎么遮

新增一个明确的边界，例如在 `sensitive-capture` 里提供：

- `redactForExternalText(text)`：直接复用 `redactForEgress` 的规则，但不带 HMAC tag（外部服务不需要还原，也不需要值身份）；输出 `[密钥]`、`[密码]`、`[验证码]`、`[银行卡 尾号NNNN]`、`[证件号]`。
- `redactForExternalUrl(url)`：解析 URL，只遮敏感查询参数的值和 userinfo，保留协议、host、path、其他参数；返回净化后的 URL。

使用点：

- `exa-public-search.ts`：`search` 的 query、`fetch` 的 URL、搜索结果文本、抓取结果文本。
- `deepseek-web-provider.ts`：query、响应文本。
- `production-coding-workflow.ts:175`：删掉整段拒；如果它保存的 tool input 需要一致，使用净化后的 query/URL（注意 memory cache key 也要用同一个值）。

**搜索会不会失效？**

- 如果敏感值只是查询词的一小部分（例如 `site:example.com password: hunter2`），遮成 `site:example.com password: [密码]` 后搜索仍能工作。
- 如果整个查询就是一个密钥，遮完只剩 `[密钥]`，搜索结果基本无意义；这是“不把密钥发给 Exa/DeepSeek”的代价，应该返回结果为空或正常失败，而不是整段拒绝。
- **签名 URL 是反例**：`?sig=...` 遮掉后签名失效，抓取一定失败。我的建议是接受一次正常的 provider 失败，并给出“URL 含凭证，已被遮值，无法抓取”的可理解错误；不要为了成功而把原始签名发出去。如果 Andy 不接受这种失败，就必须对签名 URL 保留整段拒绝，这是需要拍板的例外。

### 2.5 记录页面怎么处理

- **保留 `withheld` 枚举、数据库迁移和页面代码**。历史数据不能丢；页面现在在 `counts.withheld === 0` 时本来就不显示该筛选项（`components/sensitive-interceptions.tsx:72-78`）。
- **49 处不再产生 `withheld`**。改完后，正常新数据里这一栏应为 0；如果保留 `model-egress:214` 的 fail-closed，可以为“遮后仍漏导致整次请求未发”接一条 `withheld` 记录，但这是“出口拒绝”，不是“整段内容拦截”，文案要区分。
- `not_saved` 主要来自记忆的 `source_secret_excluded` / `candidate_secret_excluded`。改完后这两个分支不再丢弃内容，`not_saved` 会大幅减少或归零；保留枚举用于历史。
- 如果希望页面还能看到“存储/外部服务遮了值”，复用现有 `masked` + `memory_capture`/`memory_candidate`/`file`/`command_output`/`web_page` 等已有 source/part，**不要新增枚举值**，否则要同时改 DB CHECK、`SENSITIVE_INTERCEPTION_*` 常量和前端 `OUTCOME_FILTER`（I-73）。

---

## 三、问题 2：数据库里存原文还是存遮好的文字

我的推荐是：**原始对话/工具结果继续存原文；派生记录也优先存原文，发送时再遮。** 对模型生成的派生记录，模型只见过遮过的输入，所以它返回的往往本来就是占位符，不要尝试还原。

| 类别 | 建议 | 代价 |
|---|---|---|
| 记忆（自动抽取） | 存抽取结果原样；模型输入已被出口遮，所以结果里可能已经是 `[密码#...]`。**不要**为了“存原文”去还原占位符。 | 记忆里可能是占位符而不是原值；原始值仍在源对话历史里。 |
| 记忆（主人手动添加/编辑） | 存原文，界面显示原文；发给模型时出口遮。 | 数据库里有原始密钥（已有 payload 加密）；但符合 ADR 0146/0148 的“原文留在服务器，界面显示原文”。 |
| 提醒 | 存原文；提醒通知给主人时可以显示原文；进模型时出口遮。 | 原文在提醒 payload 里多一份副本；但主人本来就知道这个值。 |
| 对话检查点 | 存 distill 产出的原样；如果模型输出是占位符就存占位符。 | 摘要可能保留占位符；原始细节仍在对话历史。 |
| 对话标题 | 建议存原文，因为它是展示元数据、不会再走模型出口；如果 Andy 不想让标题页出现原值，则把标题生成结果和 `openingWords` fallback 都遮值后再存。 | 存原文：标题 payload 多一份原文；存遮值：标题显示占位符，且原值只能回源对话看。 |

**不选“全部写入时遮值”的原因**：

- ADR 0146 的“放弃的做法”已经写明：“写入时遮盖并落盘：会丢掉原件，规则升级后旧数据要重扫”。这条对聊天历史成立；对记忆、提醒、检查点也部分成立——源对话还在，但派生记录本身的原值没了。
- 写入时遮值需要把出口的 HMAC 密钥/标签逻辑引入存储层，或者使用无标签占位符；前者增加耦合和密钥轮换问题，后者丢失值身份（两个不同密码都变成 `[密码]`）。
- UI 会显示 `[密码#abcd]` 这类占位符，而 ADR 0148 的原则是“界面显示原文”。
- 如果仍要选这条路，建议只对**派生记录**（记忆、提醒、检查点、标题）遮，不动原始对话历史；并接受“原值只能回源对话看”的代价。

---

## 四、问题 3：发给模型以外服务的查询词怎么遮，遮了会不会让搜索失效

- **查询词**：在 provider 适配器发送前调用 `redactForExternalText`，使用无标签占位符。不要用 `containsRestrictedIdentifier` 这种宽规则，否则订单号、16 位数字会被误遮；用出口同一套带校验位的规则。
- **一致性**：Exa MCP 的响应匹配谓词里也用了 query（`exa-public-search.ts:226-229`），必须用遮后的 query；`production-coding-workflow` 保存的 tool input、memory cache key 也应使用同一个值。否则会出现“发出去的是遮后的，匹配的是原文”的问题。
- **URL**：只遮敏感参数值，不整段丢。`validatePublicFetchUrl` 要拆成“校验”和“净化”两个职责，所有调用方使用净化后的返回值；SSRF 校验仍然对净化后的 URL 做。
- **会不会失效**：部分遮通常不影响搜索；整句都是密钥时搜索会失去意义，这是安全的代价。签名 URL 会失效，这是必须接受的例外或需要单独拍板。
- **响应**：先遮再解析；如果遮值破坏了 JSON（极少见），先解析再递归遮字符串叶子。占位符放在 JSON 字符串里是合法的。

---

## 五、问题 4：记录页面的“整段没发给模型”还要不要

**要保留，但不再由这 49 处产生。**

- 保留枚举、DB 迁移、历史数据和页面代码；当计数为 0 时页面本来就不显示该筛选项。
- 新数据里，`withheld` 只应来自“出口遮完仍漏、整次请求未发”这种真正的 fail-closed，而不是“内容里出现了敏感信息”。文案建议从“整段没发给模型”改成“请求因遮值不完整未发送”，并只在 `MODEL_EGRESS_REFUSED` / `EGRESS_REDACTION_INCOMPLETE` 时接线。
- `not_saved` 保留给历史；如果记忆不再丢弃，新数据中它会归零。
- 不要新增 outcome 值；需要记录存储/外部遮值时复用 `masked` 和已有 source/part。

---

## 六、问题 5：会不会改变模型已经见过的请求开头

**按本方案不会。**

- 本方案不改系统提示、不改工具定义、不改历史顺序、不改出口遮盖规则、不改占位符格式、不轮换 HMAC 密钥、不迁移旧数据。
- 旧对话的历史保持原样；部署后只是在**末尾追加**新的用户消息/工具结果。工具结果以前被替换成 `PI_RESULT_SECRET_REJECTED` 等错误，旧线程里存的就是错误；新线程里存的是原文，发送时在末尾那条工具结果上遮值。
- 对同一段历史，出口每次重新遮出的字节相同（前提 2、3）。因此后一次请求以前一次请求为前缀。
- 走 `check:prompt-prefix` 必须继续通过；新增用例要带反向用例，证明“改写历史/把变化值放进系统提示”会被检查器抓住。
- **唯一会破坏前缀的情况**是：改 `redactForEgress` 规则、改占位符格式、轮换密钥、或另一个线程改变系统提示里的固定文字。这些都应作为独立的“缓存失效一次”决定，不能混进本改动。
- 如果选择“派生记录写入时遮值”，它只影响新写入的记录，不追溯旧记录；只要不把旧记录批量重写，就不会改变已发前缀。

---

## 七、问题 6：怎么测，怎么证明“以前被拦下的现在只遮了值”

### 7.1 门槛和测试层次

1. **单元/规则层**（`packages/sensitive-capture/test/`）：
   - `redactForExternalText` 正例：含 `sk-...`、`密码：...`、卡号、验证码、证件号的查询词 → 只遮对应片段，其他词保留。
   - 反例：订单号、时间戳、电话、日期不被误遮。
   - 确定性/幂等：同一输入多次遮出同样字节；已遮文本再遮不变。
   - URL：只遮 `token/key/secret/password/signature/credential` 参数值，host/path 不变；签名 URL 明确失败。
2. **服务层**（application/platform-node）：
   - 每个存储点：用 spy 仓库断言“不再抛 `*_REFUSED`/`*_EXCLUDED`”，并且保存的文本符合选定的存储策略。
   - 每个外部 provider：mock fetch/MCP，断言收到的 query/URL 已遮，原始值不出现。
   - TypeSafe：mock fetch，断言请求体/响应已遮；如果 JEV 服务端有摘要校验，用真实 schema 测试。
3. **端到端**（loopback 模型服务，参考 `prompt-prefix.compat.test.ts` 的 `loopback` 和 `readBody`）：
   - 对每一类至少一个正向、一个反向用例。

### 7.2 每一类的正向/反向用例

| 类别 | 正向 | 反向（证明测试会失败） |
|---|---|---|
| 读文件工具结果 | 文件含 `sk-...` + 唯一无害标记 `BENIGN-7f3a`；请求体含 `[密钥]` 和 `BENIGN-7f3a`，不含原始 key；不再返回 `PI_RESULT_SECRET_REJECTED` | 把 `ModelEgress` 换成 identity redactor，断言请求体出现原始 key → 测试必须失败；这证明正向断言有效。 |
| 命令输出 | `echo` 一个 Bearer token + 无害文本；工具结果含 `[密钥]` 和无害文本，exit code 保留 | 关闭出口遮，原始 token 出现 → 测试失败。 |
| 编辑前读取 | 文件含密钥，编辑仍能进行；写入内容/结果不被改成占位符 | 若在准备阶段遮值，断言文件内容被改坏 → 测试失败。 |
| 网页搜索/抓取 | query/URL 含密钥；mock provider 收到 `[密钥]`，无害词保留；响应含密钥时返回 `[密钥]` 而不是整段 error | 用 identity redactor，mock provider 收到原始密钥 → 测试失败。 |
| 记忆抽取 | 主人消息含密码；抽取请求体含 `[密码]`，候选仍被保存；不再 `source_secret_excluded`/`candidate_secret_excluded` | 保留旧的整段丢弃分支时，断言“候选被保存”失败。 |
| 主人手动记忆/提醒 | 文本含卡号；保存成功；读取到的文本按选定策略（原文或占位符） | 旧 `MEMORY_TEXT_REFUSED`/`REMINDER_TEXT_REFUSED` 若仍抛，测试失败。 |
| 对话检查点 | 源文本含密钥；distill 请求体含占位符；摘要/候选被保存 | 旧 `INVALID_OPERATION` 若仍抛，测试失败。 |
| 线程标题 | 首条消息含密钥；标题生成/fallback 不抛 `assert`；若选标题遮值，标题不含原值 | 旧 assert 若仍抛，测试失败。 |
| 复制/导出 | 源文件含 AWS key；复制/导出的字节 SHA-256 与源文件完全一致；不抛 `*_SECRET_REJECTED` | 若在复制/导出处遮值，digest 不等 → 测试失败。 |
| 配置 | 含明文密钥的配置仍被拒；含 secret reference 的配置通过 | 去掉配置校验后，明文密钥配置通过 → 测试失败。 |
| 出口自检 | 用一个故意漏遮的 redactor，断言 `ModelEgressRefusedError` 且请求没有到达 loopback 服务 | 去掉自检后，请求到达服务 → 测试失败。 |
| TypeSafe | 请求体含密钥；mock JEV 收到占位符；响应含密钥时被遮 | 去掉 transport 遮值后，mock 收到原始密钥 → 测试失败。 |

### 7.3 证明“以前被拦下的内容现在只遮了值”

- 用同一组 fixture，分别在旧提交 `8f3cddb3` 之后的当前行为和改动后跑：
  - 旧行为：断言返回错误码/抛出 `*_SECRET_REJECTED`/`*_EXCLUDED`/未保存。
  - 新行为：断言同一 fixture 现在返回成功，且结果里同时包含**无害标记**和**占位符**，不包含原始敏感值。
- 对模型请求，用真实 loopback 服务抓**原始 HTTP body**，逐字节检查：
  - 原始 key 不出现；
  - `BENIGN-*` 出现；
  - 占位符格式正确；
  - 第二次请求以前一次为前缀（`findConversationBreak`）。
- 对存储，直接读 SQLite/payload 明文（测试环境）核对选定策略。
- 对复制/导出，比较 SHA-256，而不是只看返回值。

### 7.4 反向用例必须真的会失败

- 不要只写“正常路径通过”的测试。每个正向断言配一个**负控**：把遮值函数替换成 identity，或者把旧检查加回去，断言测试失败。
- `check:egress-redaction` 的静态检查要加反向用例：在临时目录放一个在 `model-egress.ts` 之外直接调用 `redactForEgress(` 的文件，断言检查器报 violation；再放一个新增的整段拦截特征，断言新的“49 处清单”检查报 violation。
- 如果新增“49 处清单”检查，反向用例应证明：把任意一处从“放行”改回 `scanMachineSecrets`/`assertMachineSecretFree`/`containsRestrictedIdentifier` 整段拦截，检查会失败。这直接对应 I-73 的教训。

---

## 八、问题 7：分几个 PR、什么顺序

建议 **5 个 PR**，按依赖顺序：

### PR 1：地基（不改行为）
- 在 `sensitive-capture` 增加 `redactForExternalText`、`redactForExternalUrl`（或等价的边界函数），复用 `redactForEgress` 规则，不带 HMAC tag。
- 更新 `scripts/check-egress-redaction.mjs`：登记新的非模型外部出口，仍然禁止出口模块之外直接调用 `redactForEgress`；加反向测试。
- 增加一个“49 处清单”测试：把当前 49 个位置和分类写进测试数据，任何新增整段拦截、或旧位置回退，都失败。
- 不改任何业务行为，`npm run check` 应原样通过。

### PR 2：模型出口路径（最大一块）
- 删掉工具/文件/命令结果里的整段拦截：`host-file-read.ts`、`pi-coding-request.ts`、`production-file-preparation.ts`、`production-host-read.ts`、`pi-host-publication.ts`、`host-read-only-executor.ts`、`sandboxed-coding-operations.ts`。
- 保留 `\0`、大小、路径、identity、digest 检查。
- 删除或收窄 `trusted-model-provider.ts:127`；保留 `model-egress.ts:214`。
- 反向用例：identity redactor 会让原始密钥进入 loopback 请求体，测试必须失败。

### PR 3：派生存储（记忆、提醒、检查点、标题、Muse、reflection）
- 按本文问题 2 的决定删除整段拒绝；如果选“存原文”，本 PR 主要是删检查和改审计；如果选“派生遮值”，在本 PR 接 `redactForStorage`。
- 处理 `production-memory-capture.ts:281` 的 `restricted` 触发和 `automatic-memory-service.ts:144` 的 `restricted_excluded` 的耦合；保留“源分类本来就是 restricted”的治理边界。
- 更新 `sensitive-interception-recorder` 的审计映射（不要再把“只是出现敏感值”记成 `not_saved`，除非真的没存）。
- 测试：每个存储点一个正向、一个负控。

### PR 4：非模型外部出口
- Exa、DeepSeek 的 query/URL/response 遮值。
- TypeSafe 请求体和响应遮值；如果 JEV 服务端有摘要校验，改为在生成 state 时遮。
- 测试：mock provider 收到的是遮后值；identity redactor 负控失败。

### PR 5：字节原样 + 配置/自检 + 记录页/文档
- 复制、导出、恢复产物原样放行：`workspace-copy-service.ts:74`、`pi-output-export.ts:43`、`production-sandbox-services.ts:1962`。
- 保留 `strict-configuration.ts:1183` 和 `model-egress.ts:214`。
- 记录页文案：把 `withheld` 限定为出口拒绝；`not_saved` 只留历史；如需要，接 `masked` 的存储记录，复用现有枚举。
- 更新 ADR/incident、49 处清单、`scripts/evals/memory-capture-live.eval.ts`。
- 在 Hermes/云服务器跑 `npm run check` 和 `npm run check:prompt-prefix`。

顺序理由：先有边界函数和静态清单，才能安全删 49 处；先改模型出口，用户马上能感受到“不再整段失败”；存储和外部服务独立，可并行；记录页最后收尾，避免中途 UI 语义反复。

---

## 九、考虑过但不选的做法

| 做法 | 不选的原因 |
|---|---|
| 保留 `trusted-model-provider.ts:127` 整包检查 | 它在出口之前，会拦住本可由 `ModelEgress` 遮掉的请求；保留它等于本改动无效。 |
| 把所有 49 处都改成 `redactForEgress` | 复制、导出、编辑前读取需要字节原样；在这些地方遮值会写坏文件、破坏 digest/恢复。 |
| 把 TypeSafe 也接进 `ModelEgress` | 方向正确（统一出口），但改动面大于本次；先在 transport 内遮值，后续再统一。 |
| 存储全部写入时遮值 | ADR 0146 已拒绝“写入时遮盖并落盘”；会丢原件、UI 显示占位符、规则升级无法回补；且源对话仍在，安全收益有限。 |
| 用 `containsRestrictedIdentifier` 做遮值规则 | 它故意偏宽、不校验 Luhn/身份证校验位，会把订单号、16 位数字误遮；遮值应使用 `redactForEgress` 的校验规则。 |
| 删掉所有自检 | 失去“遮完仍漏”的 fail-closed；保留 `model-egress:214` 成本很低。 |
| 删掉 `withheld` 枚举/页面 | 历史数据无法显示，且出口拒绝仍然可能需要记录；保留枚举和页面，只是不再由 49 处产生。 |
| 发现敏感值就阻止网页搜索/抓取 | 这正是 Andy 要删的整段拦截；改为遮值，签名 URL 这类无法遮的例外单独处理。 |
| 引入 LiteLLM/Presidio 外部网关 | ADR 0148 已评估并拒绝；本改动不需要新增常驻服务。 |

---

## 十、风险和反例

1. **Reasoning/thinking 块不遮**：`ModelEgress` 明确跳过带签名的推理块（ADR 0148）。删掉 `trusted-model-provider` 的整包检查后，推理块里的原始密钥可能被再发。缓解：保留/新增“只检查不可遮字段”的收窄检查；或接受并在 ADR 写明。
2. **签名 URL 无法既遮又抓**：`?sig=` 遮掉就失效。反例：用户让 Himawari 抓一个带临时签名的下载链接。选择是“遮后失败”或“原样泄露”；我建议遮后失败并给明确错误，若 Andy 不接受则保留这一处整段拒绝作为例外。
3. **搜索质量下降**：查询词大部分是密钥时，遮后搜索无意义；这是安全代价。
4. **误遮**：`redactForEgress` 的银行卡规则有已知误遮率（ADR 0146 后果）；用不带 tag 的外部遮值会让误遮更明显。必须保留负例集，并记录每次误遮。
5. **存储原文的暴露面**：选“存原文”意味着记忆/提醒/检查点里多几份原始密钥；虽然有 payload 加密和访问控制，但这是真实的 at-rest 风险。若 Andy 更看重最小化，选“派生记录遮值”。
6. **记忆候选中的占位符**：模型只见过遮过的输入，候选可能本身就是 `[密码#...]`；`credentialFindings` 会把占位符也当凭据命中。若继续用它做丢弃判断，会继续误丢。必须改成“只对原始值遮/记录，不对既有占位符丢弃”。
7. **I-73 式契约断裂**：`redactForExternalUrl` 如果只校验不把净化后的 URL 传给 fetch，就会“检查了但没替换”；`validatePublicFetchUrl` 现有调用点 `production-coding-workflow.ts:194` 就是只校验不用返回值。必须逐个改成使用返回值。
8. **记录页枚举变化**：如果新增 outcome/source/part，DB CHECK、应用常量、前端 `OUTCOME_FILTER` 三处都要改；本次应尽量复用现有值。

---

## 十一、需要人拍板的取舍

1. **存储策略**：派生记录（记忆、提醒、检查点、标题）存原文还是写入时遮值？我推荐先“存原文、发送时遮”，与 ADR 0146/0148 一致；代价是 at-rest 多副本。
2. **`trusted-model-provider.ts:127`**：删除，还是收窄到不可遮字段？我推荐收窄；如果要求“零整段拦截”，则删除并接受 reasoning 缺口。
3. **`host-file-read-service.ts:153` 的 `external_approved`**：原样放行（按 owner grant）还是遮值（防止外部服务拿到密钥）？我倾向遮值，但需要确认外部消费方是否需要字节原样。
4. **签名 URL**：遮后失败是否可接受？如果不可接受，是否允许对这一种 URL 保留整段拒绝作为例外？
5. **标题**：存原文（界面显示原文）还是遮值（标题不出现原值）？我倾向遮 fallback，生成结果按模型输出原样存。
6. **出口自检是否扩到五类**：保留机器密钥检查成本低；扩到五类要多一次完整扫描，可能影响长历史延迟。是否值得？
7. **`withheld` 是否接出口拒绝记录**：保留历史枚举是确定的；是否把 `ModelEgressRefusedError` 接成 `withheld` 记录，需要产品确认页面语义。

---

## 十二、四条必答问题（逐条）

### 1. 会不会改变模型已经见过的请求开头？

**不会**，前提是遵守本方案的“不改出口规则、不改密钥、不迁移旧数据、不重写历史”。发给模型的内容仍然只在末尾追加；每轮会变的值（时间、记忆、运行环境说明）本来就在最后一条消息里。旧对话的历史不变；新内容只在尾部出现。`check:prompt-prefix` 必须继续通过，并加反向用例。依据：`.claude/rules/prompt-prefix.md:35-36,51-52`。

### 2. 会不会让同一段文字在不同请求里变成不同字节？

**不会引入新的不确定性**。出口遮值仍由内容 + 固定 HMAC 密钥决定；外部/存储遮值使用无标签的确定规则；不引入时间戳、随机数、无序集合。需要注意：

- 不要用 `Object.keys`/`Set` 的遍历顺序来决定遮值结果；
- 不要把时间、会话状态放进占位符；
- 不要在存储遮值里使用每次变化的随机 tag；
- 如果使用 HMAC tag，密钥轮换会改变同一原文的字节，这是已有风险，本方案不轮换。

### 3. 有没有对应的自动检查，反向用例是否真的会失败？

有，见问题 6。关键是每个正向断言配一个负控：把遮值换成 identity 或把旧检查加回去，测试必须失败；`check:egress-redaction` 和新增的“49 处清单”检查也要有临时文件的 violation 反向用例。否则“以前被拦下的现在只遮了值”无法证明。

### 4. 每个产生/修改的值，使用它的地方都能接受吗？

必须逐项核对，不能只看改动。重点清单：

| 值 | 产生处 | 使用处/校验 | 结论 |
|---|---|---|---|
| `[密钥]`/`[密码]`/`[验证码]`/`[银行卡 尾号NNNN]`/`[证件号]` | 新的外部/存储遮值 | 模型请求字符串（任意字符串可接受）；UI 展示；`redactForEgress`（幂等，不会二次遮）；`credentialFindings` 只认带 tag 的占位符；`EGRESS_PLACEHOLDER_PATTERN`/`locateMaskedValues` 只认带 tag 的占位符 | 如果存储用无标签占位符，UI 可显示；不会触发 restore；如果存储用带 tag，必须保证 tag 格式为 8 个小写字母且密钥稳定。 |
| `withheld`/`not_saved`/`masked` | 记录器 | DB CHECK（`0078_sensitive_interceptions.sql:20`）、前端 `OUTCOME_FILTER`（`components/sensitive-interceptions.tsx:15-19`） | 复用现有三值，不新增；否则三处都要改。 |
| `source`/`part` | 记录器 | DB CHECK（`0078...:6-14`）、前端 i18n | 只用已有 `memory_capture`/`memory_candidate`/`memory_source`/`file`/`command_output`/`web_page`/`tool_result`。 |
| `ruleId` | 遮值观察器 | DB CHECK 长度 1–128；recorder `memoryCategory` 只认部分 id | 新规则 id 不超过 128；如果存储侧记录新 kind，要更新 `memoryCategory`。 |
| `fingerprint` | recorder / egress | DB CHECK 长度 16–64；前端不显示原文 | 继续用 HMAC/SHA-256 hex 截断；不要用低熵值的裸哈希。 |
| `textWithheld` | Muse intake | `production-muse-intake-control.ts:128` 映射为 `withheld`；UI 期望 boolean | 设为 `false` 可接受；不要删字段，避免 schema/消费者断裂。 |
| `contentRef`/payload ref | 提醒/记忆 | 所有读取 payload 的路径 | 如果存储遮值需要新建 ref，必须逐一改读取方；优先保持原 ref 或写入时遮值。 |
| 标题长度 | 标题生成/遮值 | `production-thread-titles.ts:88` 要求 ≤120 且无换行 | 遮值后重新检查长度；占位符可能让标题变长。 |
| 复制/导出 digest | copy/export | `workspace-copy-service`、`pi-output-export` 的 SHA-256/base64 | 必须原样放行；一旦遮值，digest 校验会失败。 |
| 配置 secret refs | `strict-configuration` | `assertMachineSecretFree(JSON.stringify(input))` | 保留；遮值会让配置失效。 |
| 新边界函数 | `sensitive-capture` | `check-egress-redaction.mjs` 的 allowed files/required calls | 必须登记，否则 `npm run check` 失败。 |

**未核实**：`reflection.metadata` 的完整下游使用、旧提醒 `contentRef` 的所有生产方、`external_approved` 下游是否要求字节原样、JEV 服务端是否对 state 做摘要校验。这些应在对应 PR 里逐个补测试或标为已知缺口。
