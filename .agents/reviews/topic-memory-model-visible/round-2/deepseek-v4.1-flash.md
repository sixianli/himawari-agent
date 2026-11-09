I'll start by reading the governing rules and the key code the plan cites, then verify claims against first-party sources.
Bash is restricted to git commands only. I'll use glob/grep/read. Let me map the cited files.
Now researching first-party sources on memory dates, archiving/decay, and sensitive-data handling.
# 方案审核：存入记忆的内容必须能被模型看到（第 2.1 版）

已按仓库 `a4f01e6b` 核对代码，并查了一手资料。下面先给「已证实」的问题，再给「推测/未核实」，然后单独写「侧重检查」，最后回答必答问题并给出我的改法。

---

## 一、已证实的问题（按严重度）

### 1. 阻断：自动带入和档案块会被 `context-projection` 直接拒绝，方案没有改这个消费端

方案只列了检索、recall、自动带入、档案等「取数」位置，但敏感记忆一旦变成 `kind: "memory"` 或 `owner-profile` 上下文块，投影阶段会做第二次分级校验：

- `context-formation-service.ts:628-634` 把选中的记忆写成 context block，`dataClassification` 原样带上。
- `context-projection-service.ts:397-409` 读取该块，`readText(..., block.dataClassification)`。
- `context-projection-service.ts:516-537`：

```ts
if (CLASSIFICATION_RANK[payload.dataClassification] > CLASSIFICATION_RANK[input.dataClassification])
  throw new ApplicationPortError(..., "Payload exceeds the Run data classification");
```

- 记忆正文 Payload 的分级与记忆本身强制相等：`sqlite-memory-operations.ts:693-694`。

而聊天运行仍是 private（方案自己说不改）。所以只要选中一条 sensitive 记忆，或把档案块分级抬到 sensitive（方案第 3 节明确要这么做），投影就会抛 `INVALID_OPERATION: ... exceeds the Run data classification`，整轮失败，而不是「看不到」。方案「10 个地方」里没有这一处。

**建议：** 把「运行/工具分级」和「可发给模型的提示内容分级」拆成两个概念。投影读取 context block 时使用后者，并让它进入模型准入；或者明确让运行分级随内容升到 sensitive（但工具授权上限会挡住，需同时处理）。必须补一条「private 运行 + sensitive 记忆能完成 form → projection → admit」的端到端测试。

---

### 2. 阻断：只拆 `maxMemoryClassification` 不够，代码里还有独立的 `request.dataClassification` 过滤

方案前提 6 把 `context-formation-service.ts:279-286` 描述成「按 min(运行分级, maxMemoryClassification) 过滤」，但实际是两个独立条件：

```ts
CLASSIFICATION_RANK[candidate.dataClassification] <= CLASSIFICATION_RANK[request.maxMemoryClassification] &&
CLASSIFICATION_RANK[candidate.dataClassification] <= CLASSIFICATION_RANK[request.dataClassification]
```

同样地：

- 历史过滤：`context-formation-service.ts:194-198`
- 截断原因计算：`context-formation-service.ts:323-332`
- 自动带入的搜索策略：`production-run-memory.ts:355-363` 用 `request.dataClassification` 切分允许集合
- recall：`production-memory-recall.ts:160-163` 用 `invocation.dataClassification`
- 档案 compose 的入参：`context-formation-service.ts:236-240` 仍传 `min(maxMemoryClassification, dataClassification)`

只动 `maxMemoryClassification`，private 运行仍然读不到 sensitive，目标达不成。

**建议：** 明确列出并替换所有「记忆读取」的 `dataClassification` 判断，而不是只拆一个配置键；同时用一条统一策略对象作为唯一来源，避免漏点。

---

### 3. 高（安全）：这是实际的「分级洗白」，且绕过了模型描述符的允许名单

生产模板里聊天模型只允许 public/private：

- `production-shape-config-template.json:63-66`（聊天模型）
- `production-shape-config-template.json:104-107`（嵌入模型）

模型准入按**运行分级**校验，而不是按请求里实际包含的内容分级：

- `model-invocation-admission-service.ts:481-486`
- `model-router-service.ts:235-236`

方案保持运行分级 private，把 sensitive 记忆塞进最后一条用户消息，于是聊天模型会收到「标记为 private、实际含 sensitive」的内容，描述符的 `allowedDataClassifications` 形同虚设。嵌入路径不同：`production-run-memory.ts:120-130` 用的是记忆自身分级，所以方案说「嵌入模型允许名单加 sensitive」，但聊天描述符没有对应处理。

这正是方案第四节「部分采纳」DeepSeek 意见时没有解决的问题，也对应 I-73 的教训：产生方（记忆）的值变了，消费方（模型准入）的校验没有跟着变。

**建议：** 给模型准入增加「本次提示内容的最高分级」，由实际进入请求的记忆/派生内容计算；描述符必须显式允许该分级。若不愿让外部服务商接收 sensitive，就不要把原文放进请求，改为在本地生成脱敏摘要，或按用户显式授权路由到允许 sensitive 的服务商。不能靠「运行标 private」蒙混过去。

---

### 4. 高（必答 1）：改遮盖图例会改掉**所有老对话**的系统提示，不是「只对新对话生效」

方案第 5 节写「这会改系统提示文字，按规则只对新对话生效」。代码不是这样：

- 冻结的是 `productSystemPrompt(...)`，不含图例：`pi-runtime-adapter.ts:1239-1249`。
- 图例是在每次模型调用时追加的：`pi-runtime-adapter.ts:1037` 调用 `withPlaceholderLegend(context)`；`egress-context.ts:15-20` 直接拼到 `systemPrompt` 末尾。
- 因此图例文字一改，**所有已有对话**下一次请求的系统提示尾部就变了，后面整段历史按全价重算。状态不是「只影响新对话」。
- 另外 `[密钥]` 确实不能还原：`EGRESS_PLACEHOLDER_PATTERN` 只含密码/验证码/证件号/银行卡（`redaction.ts:65`），`model-egress.ts:156-159` 只按该正则还原，测试 `model-egress.unit.test.ts:460` 明确 `exchange.restore("[密钥]")` 原样返回；提示词却把它列进「会换回原值」（`prompt-catalog/src/chat.ts:267`）。

**建议：** 二选一：(a) 把图例纳入线程提示词包一起冻结，老对话保持旧图例；(b) 明确接受一次全量缓存失效，写进 ADR/上线说明，并补一条「已有冻结 bundle 的线程在升级后请求头不变」的测试。图例文字同时改为「`[密钥]` 不会还原」。

---

### 5. 高（安全）：把 sensitive 文本送进本地 FTS 是新增的明文落盘风险，而遮盖是启发式的

索引词和实体名是明文存储的：

- `schema-catalog.ts:548-553`、`597-602`：「contentless FTS5 terms for public and private Memory」。
- `sqlite-memory-operations.ts:799-804` 写 `memory_entities`。
- `sqlite-memory-operations.ts:1013-1014`、`1248-1253` 写 `memory_search_terms` / `memory_episode_terms`。

方案说「建索引前先遮盖，值不进本地索引」。但遮盖是规则启发式：规则集 1 连「Wi-Fi 密码 abc12345」都不遮（前提 13，`redaction.ts:350-363` 只在 ruleset ≥ 2 启用宽松形式），其它未覆盖格式（无关键词的 token、部分账号、地址等）同样可能漏。只要漏一个，明文就进 FTS/实体表。此前 sensitive 根本不进索引，所以这是方案新引入的暴露面。

**建议：** 敏感记忆的索引不要依赖「先遮再存」作为唯一防线。可以：只索引分级允许的实体 id；对 FTS/实体行加密；或对 sensitive 只索引人工/规则白名单里的语境词，绝不索引原文分词。补一条「用当前规则识别不出的秘密格式不得进入索引」的失败关闭测试。同步更新 `schema-catalog` 里「public and private」的说明。

---

### 6. 高（必答 4）：派生内容「跟来源取最高」与 `maxMemoryClassification` 仍管摘要/历史相冲突

方案第 4 节要求摘要、整理结果、工具结果取来源最高分级；同时第 1 节又说 `maxMemoryClassification` 继续管历史消息和摘要。两者组合会出问题：

- 摘要超过 `maxMemoryClassification` 会被静默丢掉：`context-formation-service.ts:176-185`。
- `runtimeHistory` 引用超过 `min(dataClassification, maxMemoryClassification)` 会抛 `RUNTIME_HISTORY_CLASSIFICATION_DENIED`：`context-formation-service.ts:146-154`。
- 历史消息超过 `maxMemoryClassification` 会被过滤：`context-formation-service.ts:194-198`。

现有整理代码本身就在「洗白」：`consolidation.ts:507-511` 把反思结果一律定为 `public` 或 `private`，从不为 `sensitive`；`REVIEWABLE` 也只有 public/private（`consolidation.ts:35`）。方案若把 sensitive 纳入整理，必须同时改这里，否则要么继续洗白，要么生成 sensitive 反思后让下一轮 private 运行丢掉摘要甚至抛错。

**建议：** 派生内容单独记「来源最高分级 + provenance」，读取策略与 `maxMemoryClassification` 解耦；修 `#reflect`、`episodes` 的分级；补「sensitive 记忆参与整理后，下一轮 private 运行仍能拿到摘要」的测试。

---

### 7. 高（不可逆/资源）：重建索引和恢复归档缺少顺序、幂等、可恢复设计

- 归档时索引行会删（`sqlite-memory-operations.ts:653-660`）；索引范围要求 `status='active'`（`:240-244`）；补索引只扫 active（`:1446-1478`）。方案把「重建索引」放第一期、「恢复闲置归档」放第二期。若先重建、后恢复，恢复出来的记忆没有索引，仍然搜不到。顺序必须反过来，或合并成一次迁移。
- 「恢复因闲置被归档的记忆」不能简单恢复所有 archived：合并重复也会把被合并项设为 archived（`consolidation.ts:350-353`），若一刀切恢复会把已合并掉的重复条目复活。必须只选 `consolidation` 变更里 `action='archive'` 且未 undone 的记录，并排除 `merge`。
- 方案说「重启两次不重复」，但没说用什么持久标记；重建要解密全部记忆、重新嵌入，没写分批、断点、单条失败隔离、磁盘/费用上限。
- 恢复是批量状态变更，属于不可撤销操作；没有 dry-run 数量、备份、确认步骤。

**建议：** 一次版本化迁移：先恢复（只限 `action='archive'` 且未 undone），再重建索引；用 schema 版本/迁移账本做幂等标记；支持断点续跑和单条失败记录；上线前 dry-run 并备份；补「跑两次结果一致」「合并归档不被复活」的反向测试。

---

### 8. 中（必答 4）：档案/置顶通道比方案描述窄，健康、财务根本进不了

- 档案只收 5 类：`owner-profile-service.ts:24-30`（identity / preference / relationship / goal / project）。health、finance 不在其中。
- 档案上限目前压到 private：`owner-profile-service.ts:17,149-151`；compose 入参又传 min：`context-formation-service.ts:236-240`。
- 置顶只允许 6 类：`production-memory-control.ts:57-64`（identity / preference / relationship / goal / project / rule），且还有分级检查 `:904-906`；health、finance 不在可置顶类别。

所以「档案块可选入 sensitive 记忆」「允许手动置顶 sensitive」这两句，对健康/财务记忆并不成立；它们只能走 recall/自动带入，不能走档案/置顶。方案把这两条当成「能看到」的通道，实际覆盖不到目标内容。

**建议：** 明确列出每个通道实际覆盖的类别；若希望健康/财务进档案，需要新增类别白名单或单独的「置顶上下文」通道，并重新评估每轮发送的隐私成本。

---

### 9. 中（必答 3）：自动检查覆盖不足，反向用例不保证会失败

方案列了 `[RULE-memory-visible]`，但：

- 只列 recall、自动带入、档案、整理四个通道；情景摘要、Gmail 主动检查、tentative 路径、档案 agenda 没有对应行为测试。
- `check:prompt-prefix` 只跑同一次运行内的追加；图例改动（问题 4）不会被它发现，因为它不会在两次发布之间比较已有冻结 bundle。
- 「把任一通道改回只取 public、private，对应测试必须失败」需要每个通道有可注入的策略缝；若所有通道都调用同一个固定返回 sensitive 的函数，测试改的是公共函数，无法证明某个通道单独退化会被抓到。
- 没有失败关闭测试（无法识别格式的秘密不得进索引）、没有重建失败/缺 Payload/嵌入失败的故障注入、没有「恢复归档后索引存在」的测试。
- 图例的提示词金样只验证文字，不验证冻结线程的请求头。

**建议：** 每个通道一个可注入的 `MemoryReadPolicy`，逐个写正向 + 反向；新增老线程升级测试、索引失败关闭测试、迁移幂等测试；把 `[RULE-memory-visible]` 纳入 `npm run check`。

---

### 10. 中（与业界最佳实践不一致）：敏感记忆默认可见，缺少用户显式同意与「永不保存」清单

官方做法明显更保守：

- Anthropic Help Center：默认**不**把健康、种族、宗教、政治、性别认同等敏感主题存入记忆；用户需在设置里打开「Include sensitive topics in memory」，且**每次保存都会出现提示**；拒绝或关闭后「removes any sensitive items already saved to memory」。政府证件号、犯罪记录、金融账号、移民身份「never saved to memory, even if you ask」。
  https://support.claude.com/en/articles/11817273-use-claude-s-chat-search-and-memory-to-build-on-previous-context
- ChatGPT：保存的记忆「always considered in future responses」，同时 Plus/Pro 会把「less important ones to the background」，依据「how recent ... and how often」；并且「ChatGPT looks for relevant context when it is likely to improve a response」。
  https://help.openai.com/en/articles/8590148-memory-in-chatgpt
- Gemini：Memory 开启时「Gemini may use sensitive info you provided in your chats to personalize your experience」，并提供 Temporary Chat。
  https://support.google.com/gemini/answer/16598469?hl=en

方案方向（记忆应该能被模型用到、闲置只降权不隐藏）与 ChatGPT/Letta/Zep 大体一致；但「sensitive 默认全部对模型可见、只遮凭证」比 Claude 的默认策略激进，也没有区分健康/财务/证件/金融账号的「永不保存」。`sqlite-memory-operations.ts:127-136` 的 `SENSITIVE_TOPICS` 范围很广（health、finance、beliefs、intimacy、third_party、location、legal），并不只是密码。

**建议：** 至少加一层按类别的可见性开关：默认只让用户显式同意的类别进入每轮上下文；证件号/金融账号沿用「不存」或「只存不可还原的占位」；健康/财务单独授权。这样既满足「尽量给模型」，又不把敏感内容默认推给外部服务商。

---

### 11. 低（必答 2）：日期与索引遮盖的字节确定性还没定义

- 方案第 7 节的日期示例 `[2021-03 至 2024-08]` 没有规定时区、精度、是否输出 `present`。若用「至今」「N 天前」或本地化月份名，同一条记忆会随请求时间/时区变字节。Zep 的格式是固定时间戳区间并写 `present`：
  `# format: FACT (Date range: from - to)`，示例 `(2024-11-14 02:13:19+00:00 - present)`。
  https://help.getzep.com/retrieving-memory
- 索引遮盖如果复用出口遮盖的 `known` / `tag` / `trusted`，同一段记忆在不同请求或不同 prompt-catalog 版本下可能遮出不同结果。出口占位符 tag 是带密钥的 HMAC（`model-egress.ts:121-126`），密钥轮换后字节会变；`trusted` 清单随提示词版本变（`redaction.ts:218-276`）。索引必须使用固定规则集、无 `known`、无 `trusted` 的上下文无关遮盖。
- 记忆选择顺序本身有固定排序（`context-formation-service.ts:258-260` 按 score + id），这点没问题；但日期渲染要避免 Map 遍历、locale、相对时间。

**建议：** 明确规定：ISO `YYYY-MM-DD` 或 `YYYY-MM`，固定时区（配置项），无「至今/几天前」，无本地化月份；索引遮盖用 `redactForEgress(text, { ruleset: 固定版本 })`，不传 `known`/`trusted`/`tag`；补字节稳定性测试。

---

### 12. 低（文档/代码一致性）

- `schema-catalog.ts:548-553,597-602` 仍写「for public and private Memory」，方案说不改表结构但语义已变，必须同步。
- 方案第 7 节说「同一条记忆的日期固定，字节确定」，但没覆盖上面第 11 条的时区/相对时间风险。
- 方案说「第 1 版只写了后两处，审核补全」，但归档索引删除实际在 `sqlite-memory-operations.ts:653-660`，与 `:240-244`、`:1446-1478` 是不同机制，文档里要分清。
- 方案「四处现有的写死名单」低估了实际数量：至少还有 `consolidation.ts:35`、`episodes.ts:19`、`production-proactive-memory.ts:51`、`production-memory-recall.ts:160-163`、`production-run-memory.ts:357-363`、`context-formation-service.ts:196-197,283-285,327-331`。静态检查换成行为测试后，这份清单必须完整，否则「所有通道」只是口号。

---

## 二、推测 / 未核实（不作为定论）

1. **摘要是否真的由记忆生成**：方案说「用 sensitive 记忆生成的摘要」会取最高分级，但我没有核实线程摘要的生成输入到底是否包含记忆；若只来自对话（private），第 6 条的摘要冲突可能不会触发。需要看摘要生成服务后才能定。
2. **后台任务的资源放大**：Gmail 检查、整理、情景摘要如果都读 sensitive，会显著增加外部请求和费用；方案只问「允不允许」，没给调用量/费用估算。未核实实际频率。
3. **Gmail 检查对 tentative 的处理**：`production-proactive-memory.ts:47` 传 `includeTentative: true`。若允许 sensitive，未确认的敏感记忆也会在无人值守时被使用。是否需要排除 tentative，方案未提。
4. **老对话先检测再拒绝的失败打开**：方案用当前规则检测记忆是否含凭证；任何当前规则识别不出的凭证仍会返回给规则集 1 老对话。是否比新对话更危险取决于漏检格式，未做穷举。
5. **方案引用的 arxiv 论文**（Generative Agents、Mem0）我这次没有逐篇抓原文；Zep、Letta、OpenAI、Anthropic 是我实际读到的一手页面。Mem0「直接 DELETE」的建议不采用这一点方向正确，但请以原文为准。

---

## 三、侧重检查

我按你要求的侧重逐项查了：

**错误路径**
- 投影阶段 `readText` 越级抛错：已确认（问题 1），这是最严重的错误路径。
- 老对话 recall 预检测：`production-memory-recall.ts:213-217` 只用 `status === "active"`，若新增「含凭证不返回」需要额外的失败关闭逻辑；方案未定义检测失败时的行为。
- 索引重建：缺 Payload/解密失败/嵌入失败没有单条隔离；`listUnindexed` 只扫 active（`:1469`），恢复归档前后顺序会漏索引。
- 还原：`[密钥]` 不可还原（问题 4）；`restorePlaceholders` 只认带 8 位小写编号的四种占位符（`restoration.ts:51-53`）。

**不合规范 / 不可信输入**
- recall 工具入参校验很严：query 长度、日期正则、未知字段拒绝（`production-memory-recall.ts:93-121`），这部分没问题。
- 记忆正文现在是不可信数据（可来自 Gmail、网页、第三方），方案把它更多送入模型，但没有重申「记忆是证据不是指令」。Zep 的官方安全指南明确要求把检索内容当作不可信数据、放在最低权限通道，并「Do not insert retrieved context into a system message」；本项目把记忆放在最后一条用户消息（`turnPrompt`），方向正确，但方案没有覆盖 Gmail 记忆带来的提示注入风险。
  https://help.getzep.com/memory-security
- 索引词/实体有 64 字符、512 条上限（`sqlite-memory-operations.ts:148-149`），资源上限存在；但遮盖不保证不漏秘密（问题 5）。

**安全**
- 模型描述符分级绕过：已确认（问题 3）。
- 本地 FTS/实体明文：已确认（问题 5）。
- 锁屏推送：`production-web-push.ts:486-498` 对 sensitive/restricted 隐藏正文；方案不把敏感改标 private 的理由成立，但把档案块抬到 sensitive 后，需要确认推送/日志链路不会因为「块分级变高」而出现新的隐藏或报错。
- Zep 一手资料直接反对把凭证放进记忆供模型使用：「Memory is evidence ... not ... credential ... Resolve sensitive values from an authenticated system of record instead of copying them from memory.」（https://help.getzep.com/memory-security）方案的「占位符可见、显示时还原」部分符合，但把密码/证件号/卡号长期存在记忆里仍与该建议有张力。

**资源耗尽 / 不可撤销**
- 全量重建索引需要解密所有记忆、重新嵌入；方案没有分批、限速、费用上限、断点。未核实生产记忆量，但这是明显的资源风险。
- 批量恢复归档、批量重建都是不可撤销操作；方案没有 dry-run、备份、确认。恢复若误选 merge 归档，会复活重复条目（问题 7）。
- 图例改动会让所有老对话缓存失效一次；这是可接受的成本，但必须显式承认，不能写成「只影响新对话」。

**规则 / 文档 / 代码一致**
- `prompt-prefix.md:35,41` 要求「已发内容只追加」「改提示词只对新对话生效」；图例改动违反后者的实际实现（问题 4）。
- `schema-catalog` 的 public/private 说明、ADR 0185 的后果、设计规格行号需要同步（问题 12）。
- 方案说「四处写死名单」，实际更多（问题 12）。

---

## 四、如果由我来定，我会怎样改这份方案

1. **先拆两个轴，不要用一个全局常量。**
   - 轴 A：存储/保留（哪些记忆存在、归档/失效）。
   - 轴 B：模型可见性（哪些通道、哪些类别、是否每轮、是否后台）。
   - 用 `MemoryReadPolicy` 对象显式表达「运行分级 + 通道 + 用户授权 + 类别」，recall、自动带入、档案、整理、摘要、Gmail 全部走它。默认：sensitive 只在用户显式同意时进入每轮上下文；证件号/金融账号不进入「可还原」通道。

2. **先修消费端，再放数据。**
   - 明确修改 `context-projection-service.ts:516-537`（不能再用运行分级拒绝 context block）。
   - 明确修改 `context-formation-service.ts` 的三处 `dataClassification` 过滤、`production-run-memory.ts:355-363`、`production-memory-recall.ts:160-163`、`owner-profile-service.ts:149-151`。
   - 先写「private 运行 + sensitive 记忆」的端到端测试，作为开工门槛。

3. **分类不洗白。**
   - 模型准入和出口网关按「实际内容最高分级」校验，描述符必须显式允许 sensitive；若不允许，就不发原文。
   - 嵌入模型加 sensitive 可以，但聊天模型不能靠「运行标 private」绕过。
   - 修 `consolidation.ts:507-511`、`episodes.ts:19,26` 的派生分级。

4. **索引只放安全的东西。**
   - sensitive 不索引原文分词；只索引语境白名单或加密后的词项；遮盖必须上下文无关、固定规则集、无 `known`/`trusted`。
   - 加失败关闭测试：无法识别的秘密格式不得进 FTS/实体表。
   - 同步 `schema-catalog` 说明。

5. **第二期用现有排序实现「变淡」，不要新增不可逆迁移。**
   - 已确认检索打分本来就有 recency（`fusion.ts:20-30,40-48,101-106`，半衰期 90 天、权重 0.1），所以方案里「未核实」的答案是「已用到时间和最后使用时间」。取消闲置归档后，旧记忆自然靠 recency 降权；是否把权重调高再评估。
   - 迁移一次完成：只恢复 `action='archive'` 且未 undone 的 consolidation 记录，然后重建索引；用迁移账本幂等标记，支持断点和单条失败；上线前 dry-run + 备份。

6. **图例与提示词冻结。**
   - 把图例纳入线程提示词包一起冻结，老对话保持旧图例；若做不到，就明确接受一次全量缓存失效并写进上线说明。
   - 图例不再承诺 `[密钥]` 还原。
   - 补「已有冻结 bundle 的线程升级后请求头不变」的测试。

7. **日期格式固定。**
   - ISO、固定时区、无相对时间；有区间写区间，仍有效写 `present`（对齐 Zep 的 `FACT (Date range: from - to)`）。
   - 补字节稳定性测试。

8. **测试清单。**
   - 每个通道正向 + 反向；老线程；失败关闭索引；迁移幂等；派生摘要不被丢；后台任务不得读凭证/不得读 tentative sensitive；`[密钥]` 不还原；`check:prompt-prefix` 覆盖图例升级场景。

---

## 五、必答问题逐条回答

**Q1：会不会改变模型已经见过的请求开头？发给模型的内容是不是仍然只在末尾追加，每轮会变的值是不是都在最后一条消息里？**

- 记忆日期、档案内容、更多记忆被选中：这些都在最后一条用户消息的 `<himawari-context>` 里（`pi-runtime-adapter.ts:598-616`；`context-formation-service.ts:628-634`），**这部分满足只追加**。
- **图例改动不满足**：它在每次调用时追加到系统提示（`pi-runtime-adapter.ts:1037`；`egress-context.ts:15-20`），会改变所有老对话的请求头。方案说「只对新对话生效」是错的。必须按第四节第 6 条处理，否则违反 `prompt-prefix.md:35,41`。
- 另外，档案块分级抬到 sensitive 本身不改字节，但会触发投影拒绝（问题 1），那是功能阻断，不是缓存问题。

**Q2：会不会让同一段文字在不同请求里变成不同的字节？**

- 日期：如果只用固定 ISO/固定时区/无「至今」，同一条记忆字节稳定；若用本地化月份、相对时间、`now` 计算，就会变。方案还没定义，需补规范。
- 索引遮盖：如果复用出口遮盖的 `known`/`tag`/`trusted`，同一段文字可能因请求上下文、prompt-catalog 版本、密钥轮换而不同。索引必须使用上下文无关、固定规则集的遮盖。
- 记忆选择排序已有 `score + id` 固定顺序（`context-formation-service.ts:258-260`），这点没问题；但新增日期时不要引入 Map 遍历或 locale 依赖。
- recall 结果里的 `current` 依赖 `now`（`production-memory-recall.ts:228`），它出现在工具结果里，属于末尾数据，不破坏前缀，但同一问题不同时间返回不同字节是可接受的，需在测试里按「工具结果」而非「前缀」对待。

**Q3：改动有没有对应的自动检查，反向用例是否真的会失败？**

- 方案列了 `[RULE-memory-visible]`，方向对，但覆盖不足：缺情景摘要、Gmail、tentative、agenda；缺老线程升级测试；缺失败关闭索引测试；缺迁移幂等/故障注入测试；「任一通道改回」需要每通道可注入策略，否则无法证明单独退化会被抓到。
- 现有 `check:prompt-prefix` 只验证同一运行内的追加，不会发现图例升级导致的全局前缀变化。必须新增对应测试。

**Q4：改动产生或修改的每个值，每一个使用它的地方都能接受吗？**

不能，已找到多处消费端不匹配：

- `context-projection-service.ts:516-537` 会拒绝 sensitive context block（问题 1）。
- 聊天模型描述符只允许 public/private，但运行仍是 private（问题 3）。
- `owner-profile-service.ts:149-151,165-166` 和 `context-formation-service.ts:236-240` 仍把档案压在 private；`production-memory-control.ts:57-64` 的置顶类别不含 health/finance（问题 8）。
- `consolidation.ts:507-511` 派生反思从不产出 sensitive（问题 6）。
- `[密钥]` 的还原承诺与 `EGRESS_PLACEHOLDER_PATTERN`/`restore` 不一致（问题 4）。
- `schema-catalog` 的 public/private 说明与新的索引语义不一致（问题 12）。
- 迁移顺序「先重建索引、后恢复归档」会让恢复的记忆没有索引（问题 7）。

这些都必须逐个改消费端并写契约测试，这正是 I-73 的教训：不能只改产生方，也不能只复核 diff。
