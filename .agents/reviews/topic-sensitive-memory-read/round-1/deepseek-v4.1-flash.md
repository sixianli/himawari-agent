# 敏感记忆的可检索读取方案

## 证据等级说明

- **[已证实]**：本次读过代码或一手来源，附文件行号/网址。
- **[推测]**：根据现有结构推断，需实现和测试验证。
- **[未核实]**：本次没有读到足够证据，明确标出。

---

## 一、方案依赖的前提

### P1. 发给模型的内容只能追加，头和工具按对话冻结 [已证实]

来源：`.claude/rules/prompt-prefix.md:27-31`、`:35-36`、`:41-44`。

原话：

> “固定的在前，会变的在后。顺序是：工具定义 → 系统提示 → 历史 → 最后一条用户消息。”

> “已经发给过模型的内容，不得改动、重排或删除，只能在末尾追加。”

> “系统提示和工具按对话冻结……只有下面这些情况才换新一次……工具集合变了（工具名，或者去掉说明文字后的参数结构）……”

结论：新能力不能靠新增工具或改 `recall` 参数实现；敏感结果只能出现在追加的工具结果或最后一条用户消息里。

### P2. 敏感信息只在出口遮盖，内部存原文；占位符可还原 [已证实]

来源：ADR 0183 `docs/adr/0183-mask-only-when-data-leaves-and-keep-the-original-inside.md:46-51`。

原话：

> “敏感信息只在数据发往外部（模型、网页搜索、TypeSafe 这类外部服务）时遮盖；Himawari 自己的存储和界面展示用主人的原文。”

> “模型回复里的占位符，写库前还原。”

代码：`packages/sensitive-capture/src/redaction.ts:295-313` 生成 `[密码#abcdefgh]` 一类占位符；`packages/sensitive-capture/src/restoration.ts:51-53` 负责还原；`packages/runtime-pi/src/egress-context.ts:42-106` 在流式输出里还原；`packages/prompt-catalog/src/chat.ts:258-268` 已告诉模型“回答里原样写占位符，显示时会换回原值”。

结论：模型可以只拿占位符/引用工作，最终展示由本地还原。这是本方案的基础。

### P3. `sensitive` 记忆现在三路都进不了模型 [已证实]

来源：

- 不进全文/实体索引：`packages/memory-engine/src/hybrid-memory-provider.ts:18` 的 `LEXICAL_CLASSIFICATIONS = new Set(["public","private"])`；同文件 `:85-87`，不在集合里的记忆 `terms` 为空；`:97` 只有 `embeddableClassifications` 里的才生成 embedding。
- 不进向量：生产配置 `scripts/delivery-mode/packet-template/maintenance/production-shape-config-template.json:104-107` 嵌入模型只允许 `public`、`private`。
- `recall` 排除：`apps/agent-service/src/production-memory-recall.ts:160-163` 按本次运行分级取允许列表，普通对话是 private；`:217` 过滤掉不允许的分级。
- 档案块排除：`packages/application/src/services/owner-profile-service.ts:17` 只取 `public`、`private`；`:149-152` 上限压到 private。
- 设计规格：`docs/execution/specs/2026-10-25-self-built-memory-engine-design.md:162` 原话：“全文索引和向量是明文衍生物 | `sensitive` 以上不进全文和实体索引；全文表不存原文”。

### P4. 生产聊天模型是外部服务，只允许 public/private [已证实]

来源：`production-shape-config-template.json:63-67`：

> `"allowedDataClassifications": ["public","private"]`，`"disclosure": "external_remote"`

嵌入模型同文件 `:104-107` 也只允许 public/private。`apps/agent-service/src/production-run-policy.ts:77` 和 `apps/agent-service/src/production-model-composition.ts:563` 都按 `allowedDataClassifications` 拒绝。

结论：按现行策略，sensitive 明文不应发给这个模型。要么只发引用/占位符，要么 Andy 另拍板改模型/分级策略。

### P5. 现有“显式记住/审批”已经是持久授权 [已证实]

来源：`packages/application/src/services/automatic-memory-service.ts:133-137`（restricted 丢弃）、`:144-163`（sensitive 且非显式则进待批准）、`:190-203`（显式批准直接提交）。

提示词：`packages/prompt-catalog/src/memory.ts:16-18` 要求健康、财务、密码等标 `sensitive`，主人说“记住/别忘了”时 `explicit` 填 true。

结论：一条 active 的 sensitive 记忆，已经意味着主人明说记住、批准过、或主人自己创建/勾选导入。**不需要每次查询再确认一次**。

### P6. 字节必须确定，遮盖必须确定 [已证实]

来源：`.claude/rules/prompt-prefix.md:6`、`:51-54`。

原话：

> “同样的内容，每次都要序列化成同样的字节。”

> “遮盖敏感信息必须是确定的。一条消息遮成什么样，只能取决于它自己和它前面的内容，不能取决于它后面的内容。”

代码：`packages/application/src/services/model-egress.ts:120-125` 用 HMAC 生成 8 位占位符标签，同一值同一密钥得到同一标签。

结论：敏感记忆的引用 token 必须由“稳定密钥 + 记忆 ID + 版本”确定生成，不能带随机数、当前时间、无序集合。

### P7. I-73 的教训：产生值和消费值两端都要核对 [已证实]

来源：`docs/incidents-and-gates.md:112`（I-73 行）。

原话：

> “双模型复核只看了 diff，没问「清单里的 id 能通过后端校验吗」。”

结论：token 格式、记忆 ID、revision、`sensitiveTopic`、配置键、序列化字段，逐个找产生处和消费处，核对两端校验。

### P8. Claude 的一手做法：默认不存敏感话题，用户可一次打开，每次保存有提示；证件号始终不存 [已证实]

来源：<https://claude.com/blog/claudes-memory-works-everywhere-and-you-decide-whats-in-it>（2026-11-08 读取）。

原话：

> “Claude does not store subjects considered sensitive, like health or beliefs, to memory by default, but if those are the topics you're tired of re-explaining, you can turn them on in Memory settings.”

> “With the setting turned on, each time Claude saves something on one of these topics to memory, you'll see a notice.”

> “This includes sensitive identification numbers (SSN, government ID numbers, etc.)…”

结论：业界做法是“一次授权、长期有效 + 保存时可见提示 + 某些值永久不存”。这支持减少逐次确认，但把“是否允许这类敏感话题进入记忆/模型”做成一次性开关。

### P9. 如果要做可检索索引，应该用带密钥的 HMAC，而不是裸哈希 [已证实]

来源：RFC 2104 <https://www.rfc-editor.org/rfc/rfc2104>。

原话：

> “HMAC can be used in combination with any iterated cryptographic hash function… in combination with a secret shared key.”

> “the minimal recommended length for K is L bytes.”

> “Keys need to be chosen at random… and periodically refreshed.”

结论：规模变大后要建索引，只能用 HMAC 词项哈希，不能把明文词项写进 FTS；密钥要独立管理、可轮换。

---

## 二、方案本身

### 2.1 总体思路

**不建敏感明文索引；MVP 只在 `recall` 被调用时本地扫描；模型只拿到签名的引用 token，不拿正文；显示端本地展开 token。**

一句话：**“模型能定位、能引用，但不拥有明文；主人能看到明文。”**

这同时满足：

- 不进全文索引、不进向量；
- 不把 sensitive 明文发给外部模型；
- 不新增工具、不改系统提示，不破坏 KV 缓存；
- 显式记住/审批即授权，不逐次确认。

### 2.2 检索：MVP 用本地扫描，不建索引

在 `ProductionMemoryRecall` 的现有 `provider.search` 之外，增加一条 **仅对 sensitive 生效的本地检索路径**（建议放在独立服务 `SensitiveMemoryRecallService`）：

1. 只在该次 `recall` 调用时执行，不进入每轮自动上下文。
2. 用 `productMemoryState.listActive(ownerId, agentId)` 取 active 记忆，过滤 `dataClassification === "sensitive"`，排除 `restricted`（restricted 本来就不会成为 active 记忆）。
3. 对每条记录解密正文（`readText`）。
4. 先跑 `redactForEgress`（不传 `tag`），把密码、验证码、银行卡、证件号等替换掉，避免用秘密值本身参与匹配。
5. 用现有 `indexTerms`/`queryTerms` 做词项重叠匹配；对中文仍用 `Intl.Segmenter` 和二字切片。
6. 打分：匹配词项数为主，重要度、新近度为辅；排序固定为“分数降序 → memoryId 升序”，保证字节确定。
7. 最多扫 N 条（建议先 1000），有超时预算；超限或超时记录诊断日志，只记数量/ID，不记正文和词项。
8. 命中结果**不返回正文**，只返回引用 token 和必要元数据（见 2.3）。

**代价：**

- 每次 `recall` 是 O(N) 解密 + 分词；敏感记忆通常只有几十到几百条，可接受；数量大时延迟上升。
- 没有语义检索，只能词面/词项重叠。主人说“上网口令”而记忆写“Wi-Fi 密码”可能匹配不到；需要少量同义词归一（密码/口令/password、过敏、收入等）或让模型换一个 query 再查。
- 不产生任何新的明文索引，也不调用嵌入模型，符合“不把明文关键词落到全文索引或向量”。

### 2.3 规模变大后的索引：HMAC 词项索引

当 sensitive 记忆超过阈值（例如 1000 条）或 p95 延迟超预算，再加：

- 新表 `memory_sensitive_terms(memory_id, term_hash)`，只存 `HMAC-SHA-256(indexKey, redacted_term)`，不存明文。
- `indexKey` 用独立 secret ref（例如 `memory-index-hmac`），不要复用 payload 加密密钥；按 RFC 2104 要求随机生成、可轮换。
- 建索引前先 `redactForEgress`，所以密码/卡号/证件号的值本身不会被哈希进索引；健康/财务等词项以 HMAC 形式存在。
- 查询时对 query terms 做同样 HMAC，按匹配词项数排序。
- 密钥缺失时 fail closed：敏感记忆不可检索，普通记忆不受影响；密钥轮换时后台重建索引，不调用模型。
- **永远不**把 sensitive 内容写进 FTS5 明文表，也**永远不**生成 embedding。

**代价：** 新密钥、重建索引、密钥轮换流程；HMAC 词项仍是“可被离线猜测验证”的派生数据，只是没有明文；仍然没有语义检索。

### 2.4 结果形态：模型只拿签名引用，不拿正文

`recall` 返回的敏感项建议形如：

```json
{
  "text": "[敏感记忆#<memoryId>@<revision>#<signature>]",
  "sensitive": true,
  "current": true,
  "recordedAt": "...",
  "validFrom": null,
  "validTo": null
}
```

- `text` 里没有正文，也没有 topic/摘要等可能泄露内容的字段；模型只知道“有一条相关敏感记忆”。
- `signature` 用服务端密钥对 `ownerId + agentId + memoryId + revision` 做 HMAC，截取固定长度。它防止网页/工具结果里的伪造 token 被显示端当真的展开。
- token 是确定性的：同一记忆、同一 revision、同一密钥，每次生成完全相同的字节。
- 在工具结果里追加一条固定说明（新的 prompt-catalog 条目，例如 `TOOL_RESULT_RECALL_SENSITIVE`）：

> “`sensitive` 为 true 的结果是主人的敏感记忆，正文没有提供给模型。回答需要提到时，把 `text` 里的 `[敏感记忆#...]` 原样写出，系统显示给主人时会换回原文；不要猜内容。涉及健康、财务、法律等判断时，不要替主人推断，提醒主人查看记录。”

这条说明只出现在本次工具结果里，属于追加内容，不影响前缀。

### 2.5 显示端：本地展开 token

新增 `SensitiveMemoryReferenceResolver`，只在“给主人看”的最后一层运行：

1. 识别 `[敏感记忆#<memoryId>@<revision>#<signature>]`。
2. 校验签名；不通过就原样保留，不展开。
3. 校验 owner/agent 作用域、记忆存在、`status === "active"`、`revision` 匹配、`dataClassification === "sensitive"`（不接受 restricted）。
4. 解密正文，替换 token。
5. revision 不匹配或记忆已删除时，不静默换新内容，显示“这条记忆已更新/已删除，点击查看最新”，避免旧答案被新内容悄悄改写。
6. 建议只在聊天界面显示时展开；推送继续显示“你有一条私密提醒”，导出默认保留 token 或由主人显式选择展开。

**为什么不把正文写回最终答案：** 写回会新增一份明文副本，并且最终答案的分级会与运行分级（private）不一致。保留 token、显示时展开，可以让历史、工具结果、最终答案都保持“无敏感明文”，只有原始记忆 payload 存明文，符合 ADR 0183 的“内部存储用原文”最小化原则。

### 2.6 内容进模型请求的具体规则

| 记忆类型 | 模型看到什么 | 需要主人同意吗 |
|---|---|---|
| public / private | 和现在一样，正文进上下文/`recall` | 不需要 |
| sensitive：密码、密钥、验证码、银行卡、证件号（`sensitiveTopic: "other"` 或遮盖命中） | **只看到 token**，永不看到明文；回答里原样写 token，显示时还原 | 不需要逐次确认；显式记住/审批即授权 |
| sensitive：健康、财务、法律、亲密关系、他人隐私、位置 | **默认只看到 token**，不看到明文；模型只能提示主人查看记录，不能替主人推理 | 不需要逐次确认；但“让模型读明文做推理”需要一次性授权（见下） |
| restricted | 仍按现有规则丢弃/不可检索 | 不适用 |

**如果 Andy 以后要求模型对健康/财务做推理**：需要一次性按 topic 打开“允许把这类敏感记忆明文发给模型”，并且要有一个 `allowedDataClassifications` 包含 `sensitive` 的模型描述；同时这是一次分级提升，可能要求新对话或显式重建提示包。当前生产配置不满足，不能默默做。

### 2.7 授权：一次，不逐次

- **显式“记住”**：`AutomaticMemoryService` 已经直接提交 sensitive 记忆（`:144-163`、`:190-203`），这就是一次持久授权。之后任何对话都可 `recall` 这条记忆，默认只给 token。
- **非显式敏感候选**：仍走现有待批准；批准后成为 active，即可被 `recall`。未批准、被拒绝、过期的候选不可检索。
- **主人手动创建/导入**：导入时敏感行默认不勾选（ADR 0185 `:45`），主人勾选并导入即视为授权。
- **全局/单条开关（后续）**：可以加“这条记忆不要在对话里被引用”的单条开关，或全局“敏感记忆可被对话查询（内容仍遮盖）”。默认建议：显式/审批/手动创建的 active sensitive 默认可引用；导入的敏感行在导入时默认不勾选。
- **只有“明文披露给模型”需要新的一次性授权**，不是每次提问确认。默认不做。

### 2.8 KV 缓存怎么不破

- **不新增工具，不改 `recall` 的 schema。** 敏感能力在服务端根据记忆分级/授权开关决定，模型不需要传新参数。这样工具集合和工具定义字节不变。
- **不改系统提示的现有对话。** 如果要给新对话补充 `[敏感记忆#...]` 的说明，只改 prompt catalog，对老对话不生效（规则第 6 条：改提示词只对新对话生效）。老对话靠工具结果里的固定说明。
- **敏感结果只追加在工具结果里**，不放进系统提示、工具定义、主人档案块、历史前缀。`OwnerProfileService` 继续只取 public/private。
- **token 确定性**：由 HMAC + memoryId + revision 生成，不带随机数、不带当前时间；命中排序固定。
- **工具结果可重放**：`production-runtime-tools.ts:655-661` 已经按 toolCallId 复用已存结果，避免同一工具调用重新算出不同字节。
- **不要重写历史**：显示端展开只发生在“给主人看”的最后一步，不把展开后的明文写回历史/请求；否则下一轮前缀会变（I-66 的同类问题）。
- 如果以后加“最后一条用户消息里的敏感查询提示”，它是每轮可变的尾巴，符合规则第 2 条；不要加到系统提示。

### 2.9 反向验收

建议的测试清单（正反都要）：

1. **正向**：显式保存“Wi-Fi 密码是 abc12345”后，`recall("Wi-Fi 密码")` 返回一条 `sensitive` 引用；模型请求体里**不出现** `abc12345`，只出现 `[敏感记忆#...]`。
2. **反向：未授权不返回**。待批准/被拒绝/已删除/已归档/`restricted` 的敏感记忆，`recall` 不返回。去掉授权检查时这条测试必须失败。
3. **反向：分类门槛**。private 运行的自动上下文（`ContextFormationService`）和 owner profile 不得出现 sensitive 记忆；有人把 `PROFILE_CLASSIFICATIONS` 或 `maxMemoryClassification` 放宽时测试失败。
4. **反向：索引无明文**。检查 FTS 表、向量表、`memory_sensitive_terms`：不得出现密码/卡号/证件号明文；如果把敏感正文写进索引，测试失败。
5. **反向：token 不可伪造**。用伪造的 `[敏感记忆#...]` 或改 revision 的 token 测试显示端不展开；去掉签名校验时测试失败。
6. **反向：token 双端校验**。产生端只接受 active sensitive 记忆；消费端校验 owner/agent/status/revision/classification；用别的 owner、别的 agent、过期 revision、已删除记忆测试都不展开。
7. **反向：缓存前缀**。在现有 `npm run check:prompt-prefix` 的多轮场景中加入一次敏感 `recall`，断言后一次请求以前一次请求为前缀；故意把历史里的 token 换成明文或改写历史，检查必须报失败。
8. **确定性**。同一记忆同一 revision 连续两次 `recall` 得到完全相同的 token bytes；打乱数据库返回顺序，结果排序不变。
9. **不泄漏到模型**。用测试模型桩收请求体，断言密码、卡号、证件号、健康/财务正文都不出现；只出现 token。
10. **显示面**。聊天界面 token 展开为原文；推送不展开且不显示敏感正文；导出按约定处理；记忆页仍显示原文。
11. **密码识别缺口**。`password is abc12345`、`Wi-Fi 密码 abc12345` 等 ADR 0188 覆盖的写法要进 sensitive 并只给 token；未识别成敏感时，至少不能因 `classificationWithIdentifiers` 漏掉而被当普通记忆索引进 FTS。
12. **I-73 类双端**：如果新增配置键（扫描上限、超时、索引开关），严格配置解析、生产模板、启动校验、测试夹具四处都要接受；如果新增 `sensitiveTopic` 值或属性字段，写入端、读取端、UI、导入导出都要接受，未知值不能导致崩溃或误放行。

### 2.10 最小可行的第一步与扩展

**第一步（MVP，建议先做）：**

1. 在 `ProductionMemoryRecall` 增加“本地扫描 active sensitive 记忆”的路径，只在该工具被调用时执行。
2. 结果只返回签名 token，不返回正文。
3. 增加显示端 resolver，在聊天界面展开 token。
4. 不新增工具、不改 schema、不建索引、不调嵌入、不加新配置。
5. 先覆盖“密码/密钥/验证码/银行卡/证件号”和“健康/财务等直接查找”；模型只负责定位和引用，不负责推理。
6. 用上面的反向测试验收。

这样，主人说“记住我家 Wi-Fi 密码是 abc12345”，之后问“家里 Wi-Fi 密码是多少”，模型能 `recall` 到这条记忆，回答里带 token，显示时变成正确密码；外部模型全程没看到 `abc12345`。

**第二步：** 当敏感记忆数量或延迟超过预算，加 HMAC 词项索引；仍然不建明文 FTS、不做向量。

**第三步：** 如果 Andy 要求模型对健康/财务做推理，单独拍板：是否允许某个模型接收 sensitive 明文、按 topic 一次性授权、如何提升运行分级；否则保持 token-only。

**第四步：** UI 加单条“不要在对话里引用”开关、审计记录、命中率/延迟监控。

---

## 三、考虑过但不选的做法及原因

1. **把 sensitive 正文写进 FTS/向量。** 不选。违反规格 `:162`“全文索引和向量是明文衍生物”；嵌入还会把明文发给外部模型；生产嵌入配置也只允许 public/private。
2. **把 sensitive 正文放进 `recall` 工具结果，靠出口遮盖自动打码。** 不选。出口遮盖只认密码/验证码/银行卡/证件号，健康/财务不会遮；而且运行历史（`runtime-history-service.ts:45-63`）和工具结果 artifact（`production-runtime-tools.ts:2288-2305`）会按本次运行的 private 分级存下明文，造成分级不一致和额外明文副本。这正是 I-73 那类“两端没核对”的风险。
3. **新增 `recall_sensitive` 工具或给 `recall` 加参数。** 不选。工具集合/参数结构变化会触发按对话换新（规则第 6、7 条）；而且模型不需要知道“敏感模式”，服务端根据授权决定即可。
4. **每次查询都问主人“可以查这条吗”。** 不选。违反 `docs/product-vision.md:58`“常规判断应由规则手册预先授权，不逐次确认”；显式记住/审批已经是一次授权。
5. **把整个对话分级提升到 sensitive。** 不选。当前外部模型只允许 public/private，会直接触发 `RUN_POLICY_MODEL_DISCLOSURE_DENIED`；而且会把所有内容都抬到 sensitive，范围过大。
6. **因为主人自己在聊天里说过健康信息，就直接把记忆明文再发给模型。** 不选。记忆分级是 sensitive，现行策略明确不发给这个模型；主人不一定记得以前说过，且没有逐次授权。
7. **换一个更贵的模型专门处理敏感内容。** 不选。约束是“不使用贵模型”；换模型还会破坏同一对话的服务方缓存。
8. **用裸 SHA-256 词项哈希建索引。** 不选。短词/常见词可被字典反推；应按 RFC 2104 用带密钥的 HMAC，并独立管理密钥。
9. **把所有敏感内容自动记住、自动可用。** 不选。Claude 的一手做法也是默认不存敏感话题、用户显式打开；本项目已有“非显式敏感进待批准”的流程，保留它。

---

## 四、风险和反例

1. **健康/财务推理缺失。** 反例：主人问“我对青霉素过敏，能不能吃阿莫西林？”模型只看到 token，不能推理，可能给泛泛建议。缓解：工具结果明确要求“不要替主人推断，提醒查看记录”；聊天界面把记忆卡片展示给主人；如果 Andy 要求模型真正推理，走一次性明文披露授权，且需要合适的模型。
2. **词面检索漏召回。** 反例：记忆是“Wi-Fi 密码”，主人问“上网口令”。缓解：密码/口令/password 等同义词归一；模型可换 query 再查；规模大时 HMAC 索引也只能解决词面匹配，不能解决语义匹配。
3. **扫描延迟。** 反例：敏感记忆几千条，每次 `recall` 都解密扫描，拖慢回复。缓解：上限 + 超时 + 诊断；超过阈值转 HMAC 索引。
4. **token 伪造/提示注入。** 反例：网页内容里塞入 `[敏感记忆#...]`，模型照抄，显示端误展开。缓解：token 带服务端 HMAC 签名；显示端校验签名、作用域、revision；不展开未签名 token。
5. **记忆更新后的旧 token。** 反例：主人改了密码，旧回答里的 token 还指向旧 revision。缓解：token 带 revision；不匹配时显示“已更新”，不静默展示新值。
6. **显示面遗漏。** 反例：聊天界面展开了，但导出/网页推送没处理，主人看到 token 或 token 被当普通文字。缓解：逐面测试；推送继续隐藏敏感正文；导出由主人选择是否展开。
7. **密码识别仍是启发式。** 反例：全字母口令、关键词和值之间隔很多词的写法认不出，可能被当普通 private 记忆。缓解：保留 `classificationWithIdentifiers`；在敏感扫描里对 `sensitiveTopic === "other"` 的内容也先跑 `redactForEgress`；反向测试覆盖 ADR 0188 的写法。[已证实风险存在，ADR 0188 后果页已写明]
8. **后台整理/情景摘要可能把敏感内容发给模型。** [未核实] 本次没有逐行核对 `production-memory-consolidation.ts` 和 `production-memory-episodes.ts` 的检索过滤；它们把请求分级强制成 private（`:112`、`:95`），如果检索层没有排除 sensitive，就是与本次同类的缺口，应另做反向验收。
9. **查询参数本身含秘密。** 反例：主人直接问“abc12345 是什么”，模型把秘密放进 `recall` 的 query，工具意图 artifact 可能按 private 存下明文。缓解：对工具参数里的可识别秘密做遮盖/提升存储分级；反向测试检查工具意图 payload。
10. **token 暴露内部记忆 ID。** 模型会看到 `memoryId`。这通常不算秘密，但如果认为 ID 也是敏感元数据，可以改成不透明句柄 + 服务端映射表；代价是多一张表和一次查找。

---

## 五、需要 Andy 拍板的取舍

1. **健康/财务是否允许模型看明文做推理？** 当前生产模型只允许 public/private。若不允许，就接受“模型只能定位、主人看原文”的 token 方案；若允许，需要指定模型/provider，并接受一次性的按 topic 授权和可能的新对话重建。
2. **“敏感记忆可被对话引用（内容仍遮盖）”默认开还是关？** 建议：显式记住/审批/手动创建的 active sensitive 默认可引用；导入的敏感行默认不勾选（沿用 ADR 0185）。
3. **最终答案存 token 还是存展开后的明文？** 建议存 token，显示时展开，减少明文副本；代价是所有显示面都要走 resolver。若坚持 ADR 0183 的“写库前还原”，则最终答案 payload 要标成 sensitive，并处理历史过滤。
4. **推送/导出是否展开 token？** 建议推送不展开（继续“你有一条私密提醒”），导出由主人显式选择。
5. **什么时候从本地扫描升级到 HMAC 索引？** 建议先定一个阈值（例如 active sensitive 记忆 > 1000 条，或 `recall` p95 超过 300ms）。
6. **是否加“最后一条用户消息里的敏感查询提示”？** 它能提高模型主动调用 `recall` 的概率，但会改变最后一条用户消息的字节；这是规则允许的，但需要接受每轮尾巴变化。

---

## 六、逐条回答必答问题

### 1. 怎样让 `sensitive` 记忆能被找到，同时不把明文关键词落到全文索引或向量里？

**MVP：不建索引，`recall` 时本地扫描 active sensitive 记忆。** 解密后先 `redactForEgress` 去掉密码/验证码/银行卡/证件号，再分词做词项重叠匹配；结果只返回签名引用 token。这样 FTS、向量、实体表里都没有任何 sensitive 明文，也没有新的明文副本。

**规模变大后：** 加 `memory_sensitive_terms` 表，只存 `HMAC-SHA-256(indexKey, redacted_term)`；查询侧对 query terms 做同样 HMAC。密钥独立、可轮换，密钥缺失时 fail closed。仍然不生成 embedding、不写 FTS 明文。

**代价：** MVP 是 O(N) 解密 + 分词，只支持词面匹配；规模方案需要新密钥、重建索引和轮换流程，且仍然没有语义检索。

### 2. 找到之后，内容怎样进模型的请求？哪些情况模型根本不该看到明文，哪些情况要不要主人同意？

**内容本身不进模型请求，进的是引用。** 敏感命中作为工具结果追加在末尾，形如 `[敏感记忆#<id>@<revision>#<sig>]`；模型只看到引用，看不到正文。回答需要提到时原样写出 token，显示端本地展开为原文。

- **密码、密钥、验证码、银行卡、证件号：** 模型永远不该看到明文；只给 token。主人明说记住/批准即授权，不需要逐次确认。
- **健康、财务、法律、亲密关系、他人隐私、位置：** 默认也只给 token；模型可以定位、提示主人查看，但不能替主人推理。如果 Andy 要求模型读明文推理，需要一次性按 topic 授权，并且模型本身允许 sensitive；当前配置不允许。
- **public/private：** 维持现状。
- **待批准/被拒绝/已删除/restricted：** 不返回。

### 3. 主人确认的次数怎样压到最少？哪些可以一次授权、长期有效，哪些可以自动放行？

- **一次授权、长期有效：** 主人说“记住/别忘了”时的那次显式确认；非显式敏感候选在待批准里批准的那次；主人手动创建/勾选导入的那次。之后所有对话都可 `recall`，默认只给 token，不再逐次确认。
- **自动放行：** active sensitive 记忆的 token 化检索；密码/密钥/卡号/证件号的引用；public/private 记忆照旧。
- **需要新确认的只有：** 把某类敏感记忆的**明文**发给模型做推理（一次性按 topic 打开）；或在设置里主动关闭/打开某个敏感话题的可用性。默认不做明文披露，所以日常零新增确认。

### 4. 怎样不破坏 KV 缓存规则？

- 不新增工具、不改 `recall` 的参数结构；敏感能力在服务端根据记忆授权决定，模型不需要新模式。
- 敏感结果只追加在工具结果里，不塞进系统提示、工具定义、档案块、历史前缀。
- token 由 HMAC + memoryId + revision 确定生成，不带随机数/当前时间；命中排序固定（分数降序 → memoryId 升序）。
- 工具结果按 toolCallId 复用已存结果（`production-runtime-tools.ts:655-661`），避免同一调用重算出不同字节。
- 显示端只在最后一层展开 token，不把展开后的明文写回历史/请求；否则会重演 I-66 的前缀变化。
- 如果要加 `[敏感记忆#...]` 的说明，放在工具结果的固定说明里；改系统提示只对新对话生效，不影响老对话。

### 5. 怎样做反向验收（不该读到的时候读不到）？

见 2.9 的 12 条。核心是：

- 未批准/被拒绝/删除/归档/restricted 的敏感记忆，`recall` 必须不返回；去掉授权检查时测试必须失败。
- private 运行的自动上下文和 owner profile 不得出现 sensitive；放宽分类过滤时测试失败。
- FTS/向量/HMAC 表不得出现密码、卡号、证件号明文；把敏感正文写进索引时测试失败。
- 伪造/篡改/跨 owner/跨 agent/revision 过期的 token 不得展开；去掉签名或作用域校验时测试失败。
- 多轮带敏感 `recall` 的请求仍必须“后一次以前一次为前缀”；故意改写历史时检查必须报失败。
- 测试模型桩收请求体，断言明文不出现，只出现 token。

### 6. 最小可行的第一步是什么，后面怎么扩？

**第一步：** 只做“token 化敏感召回”：

1. `recall` 被调用时本地扫描 active sensitive 记忆；
2. 命中只返回签名 token，不返回正文；
3. 聊天显示端本地展开 token；
4. 不新增工具、不建索引、不调嵌入、不加新配置；
5. 覆盖密码/密钥/验证码/银行卡/证件号，以及健康/财务的直接查找；
6. 用 2.9 的反向测试验收。

这一步就能让“家里 Wi-Fi 密码是多少”答对，且模型全程看不到密码。健康/财务的直接查找也能答对；模型不能做推理，这是明确的边界。

**后面：** 敏感记忆数量/延迟超阈值 → 加 HMAC 词项索引；Andy 要求模型对健康/财务推理 → 单独拍板一次性明文披露 + 合适的模型；最后加单条开关、审计和监控。
