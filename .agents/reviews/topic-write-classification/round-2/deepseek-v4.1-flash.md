## 一、证实的（按严重度）

### 1. 严重：漏了两个真实写入点，健康内容仍会以 private 入库并被外部读到

- **问题**：方案说“所有写入点”，但至少漏了 `keep(editedText)` 和网页提醒。
  - 待确认的外部提案被主人编辑后提交时，`production-mcp-memory-writer.ts:276-318` 只调用 `proposalClassification(text, proposal.category)`，它是同步的证件/凭据检测，不调模型。主人在编辑里加进“每周三去心理诊所”，仍会以 private 存。
  - 网页创建提醒时，`apps/control-center/src/memory.ts:389-394` 直接 `client.protectText(text, classificationWithIdentifiers(text, "private"))`，`production-reminder-writer.ts:228-238` 只接受已有 `contentRef`，不再判断。外部读取的 `reminders` 又只按记忆级别过滤（`production-reminder-writer.ts:338`），private 上限的接入读得到。
- **证据**：上述 `file:line`；`production-mcp-read.ts:1621-1640` 按 `sourceMemoryId` 的级别过滤规则，说明记住的级别就是外部可见性的唯一开关。
- **建议**：`keep` 的 `editedText`、网页提醒都必须走统一判断。扫描检查必须覆盖 `proposalClassification`、`protectText`、硬编码 `"private"` 和“已有 payload 直接复用”，反向用例各来一条；只扫 `classificationWithIdentifiers(text, "private")` 不够。

### 2. 严重：写入时同步调模型会超时、阻塞所有提议，并可被外部连接耗尽

- **问题**：`ProductionMcpMemoryWriter` 的 `#submit` 在 `#serially` 里（`production-mcp-memory-writer.ts:599-606`），同一队列还被 `listPending`、`listBatches`、`keep`、`decline` 使用。模型调用一放进去，一次慢调用会挡住整个写入器和待确认列表。`#proposeMemories` 一次最多循环提交 50 条（`production-mcp-read.ts:1217-1264`），`sync_memories` 默认最多 50 条、上限 200 条（`packages/application/src/ports/mcp-memory-sync.ts:43-59`）。外部推送 8 秒、两次尝试、几十条/十几批，很容易超过 MCP 读路径的 60 秒请求期限（`production-shape-config-template.json` 的 `providerRequestMs: 60000`）。写工具没有拿 `signal`，客户端断开也不会中止模型调用。
- **证据**：`production-mcp-memory-classification.ts:23-31` 的模型接口没有 deadline/AbortSignal；`service-main.ts:2034` 只用 `proactiveConfiguration.perCheckMs`；`sqlite-external-memory-proposal-operations.ts:165-172` 的待确认上限会被敏感内容填满，之后所有外部写入都报 `EXTERNAL_MEMORY_PROPOSAL_PENDING_FULL`。
- **建议**：给整次外部推送一个总期限，而不是每条/每批 8 秒；`propose_memories`、`sync_memories` 在写之前批量判一次；模型调用移出 `#serially`，或至少不阻塞读列表；未判完的条目以“待判=敏感”落库并返回 pending；按连接加写入/待确认配额；把 `signal` 传进判断调用。

### 3. 严重：默认配置下“发给判断模型时标 sensitive”会让判断器不可用，所有写入变成敏感

- **问题**：方案第 11 条要求按 sensitive 发给判断模型。但 `strict-configuration.ts:2283-2293` 只要求主动检查模型接受 private，`production-model-composition.ts:531-533` 在请求级别不在 `allowedDataClassifications` 时直接抛 `PROACTIVE_MODEL_DISCLOSURE_DENIED`。现有分类器构造用的就是主动检查模型（`service-main.ts:2028-2053`），而它的 `#ask` 现在写死 `dataClassification: "private"`（`production-memory-classification.ts:204`）。改成 sensitive 后，绝大多数只配了 `["public","private"]` 的部署会整批失败，全部按 `UNCLASSIFIED` 存成 sensitive；规则、提醒、提议全部变敏感，外部接入几乎什么都读不到。
- **证据**：上述 `file:line`；方案自己也承认“配置的模型不允许 sensitive 时判断器不可用、全部按敏感”。
- **建议**：新增一个明确允许 sensitive 的专用判断模型描述，启动时校验；没有就保留“确定性检测 + 外部自报 health/finance 下限”，外部写入拒绝/排队，而不是把主人的普通规则和提醒全变敏感。设置页必须明确写“敏感文字会发给哪个服务方”，并取得主人同意。

### 4. 严重：旧内容补判按字面会改写已发历史和提示词包，违反只追加

- **问题**：方案要补判的写入点包含 `production-think-runner.ts:178-209` 和 `production-task-proposals.ts:131-165`，它们写的是线程消息；也包含 `production-think-inbox.ts:205` 的摘要。给这些内容“另存一份敏感内容、切换引用”，就是改写历史消息的 `contentRef`/级别。`production-thread-prompt-bundle-operations.ts:169-172` 又要求提示词包级别与内容一致，级别变化可能触发重建/换新，改变模型已经见过的请求开头。`.agents/instructions/prompt-prefix.md:36` 规则 4 明确：已发给模型的内容只能在末尾追加，不得改动、重排或删除。
- **证据**：上述 `file:line`；方案说“逐条补判上面这些写入点存过的内容”，没有排除线程历史。
- **建议**：补判只覆盖“记忆内容、外部提案、同步条目”等可安全换引用的存储；绝不改写 `thread_messages`、线程提示词包、已发历史。加一条反向测试：补判前后，线程消息的 `contentRef` 和 classification 必须完全不变。

### 5. 高：程序里的敏感下限只覆盖 health/finance，低于提示词自己写的规则

- **问题**：`packages/prompt-catalog/src/memory.ts:7` 明确把健康、财务、宗教与政治观点、性与亲密关系、他人私事、精确住址与行踪、法律纠纷都列为 sensitive；但 `production-memory-classification.ts:46` 的 `SENSITIVE_CATEGORIES` 只有 `health`、`finance`，`:117` 只在 `requested === "sensitive" || SENSITIVE_CATEGORIES.has(category)` 时强制敏感。模型返回 `category:"other", classification:"private", topic:"location"` 时，topic 还会因为“不敏感”被丢弃，最终以 private 存。对话记忆采集 `production-memory-capture.ts:379-391` 更没有 category/topic 下限，只做 `classificationWithIdentifiers` 和来源取高，所以方案第 8 条说的“走同一套校验和取高”目前并不成立。
- **证据**：上述 `file:line`；`SENSITIVE_MEMORY_TOPICS` 在 `packages/application/src/ports/automatic-memory.ts:117-128` 有 8 个值。
- **建议**：只要 `topic` 是 `SENSITIVE_MEMORY_TOPICS` 中除 `other` 外的值，或 category 是 health/finance，一律敏感；分类器和对话采集/回看共用这个下限；topic 必须按白名单校验后再用。

### 6. 高：对不可信外部输入仍只靠同一个模型，prompt injection 能把敏感内容判成 private

- **问题**：方案自己写“同一个模型重复问防不了刻意的诱导”，但又拒绝第二次独立判断。外部 agent 的文本和固定指令放在同一个 prompt 里（`packages/prompt-catalog/src/memory.ts:92-97`），恶意文本只要让模型返回合法 JSON `classification:"private"`，健康/财务内容就会以 private 存，private 上限的其他外部连接就能读到。确定性检测只认证件、卡号、密码、密钥，认不出健康/财务。
- **证据**：上述 prompt；`production-memory-classification.ts:70-74` 的确定性检测范围；方案“放弃：外部内容问两次模型”一节。
- **建议**：这是安全场景，外部来源应例外：外部内容在主人明确确认前不得低于 sensitive；或只在模型判 private 时用第二个独立模型/独立提示复核（成本只落在外部写入上）。不能把单模型 verdict 当作对恶意输入的充分防线。

### 7. 高：`sensitive_topic` 的生产者和消费者没有闭合（正是 I-73 的教训）

- **问题**：方案只写“外部表加可空主题列，导出格式跟着升”，但没列全两端：
  - `production-mcp-memory-writer.ts:349-350` 创建记忆时仍用 `sensitiveTopicFor(proposal.category)`，只按 health/finance/other 推，不会读新列。
  - `sqlite-external-memory-proposal-operations.ts:148` 的提交校验只认 category/classification，没有 topic。
  - 导出 schema `data-export/schemas.ts:202-227`、`export.ts:667-706`、`verify.ts` 的 `ParsedExternalProposal`、`import.ts:813-819` 的 17 列 INSERT 都没有 topic。
  - `mcp_sync_entries` 加了 topic 也没有消费者：`sqlite-mcp-memory-sync-operations.ts:586-588` 提交外部提案时只传 category/classification。
- **证据**：上述 `file:line`；`docs/incidents-and-gates.md:112` 的 I-73 原文：“双模型复核只看了 diff，没问‘清单里的 id 能通过后端校验吗’”。
- **建议**：逐个写清 `topic` 的产生处、读取处、校验处：类型、提交、读取、keep、快照、导出 schema、verify、import、控制中心展示、`sensitiveTopicFor` 回退。加一条从“模型返回 topic”到“记忆 attributes.sensitiveTopic”的往返契约测试。`mcp_sync_entries` 如果最终没人读，就不要加这一列。

### 8. 高：“只升不降”没有覆盖同文早退、已提交提案和同步的上游写入

- **问题**：
  - `sqlite-mcp-memory-sync-operations.ts:561-575` 在同一 `textSha256` 时直接返回 “unchanged”，不会更新 classification；`:636-653` 和 `:753-768` 又无条件覆盖。后一次模型判成 private 会把前一次 sensitive 覆盖掉，同文重推判成 sensitive 又不会升级。
  - `sqlite-external-memory-proposal-operations.ts:151-157` 的去重按 `text_sha256` 且包含已提交提案；`production-mcp-memory-writer.ts:218-240` 对已提交提案直接返回，不会因后来判成 sensitive 而升级。
  - `production-mcp-sync.#storeText`（`production-mcp-sync.ts:435-436`）发现同 ref 已存在就直接返回，不检查 classification；`production-mcp-memory-writer.#storeText`（`:646-650`）则会抛冲突。前者是 fail-open。
- **证据**：上述 `file:line`。
- **建议**：先算“旧级别和新级别的较大值”，再用这个级别计算 `syncRef`/`proposalRef` 并写 payload；同文早退也要比较级别；已提交提案加一条“升级/审计”路径；`#storeText` 遇到分类不一致必须拒绝，不能静默复用。

### 9. 中：模型给出的 category 和两个外部清单不一致，`rule` 会撞后端校验

- **问题**：`production-memory-classification.ts:44` 接受 `MEMORY_CATEGORY_NAMES`（含 `rule`），但 `production-mcp-memory-writer.ts:46-56` 的 `EXTERNAL_PROPOSAL_CATEGORIES` 和 `production-mcp-sync.ts:33-35` 的 `MCP_SYNC_CATEGORIES` 都不含 `rule`。方案说“rule 归其他”，但“外部清单”其实有两份，必须分别映射；漏一个就会在 `sqlite-external-memory-proposal-operations.ts:147-148` 被拒，外部推送直接丢失。
- **证据**：上述 `file:line`；方案测试也提到“模型给外部表 rule 类别不会撞表约束”，说明作者知道有这个风险，但方案正文没有写清两个消费者的差异。
- **建议**：在边界处按 `EXTERNAL_PROPOSAL_CATEGORIES` / `MCP_SYNC_CATEGORIES` 分别校验和映射，`rule → other`；unknown → other；加表驱动测试。

### 10. 中：拟议的自动检查无法证明“所有写入点”

- **问题**：`npm run check:memory-write-classification` 只描述“扫描 apps/ 下所有加密存储的调用，级别不是来自统一写入口就失败”。静态扫描无法可靠判断数据流；会漏掉硬编码 `"private"`（`production-mcp-rule-writer.ts:89-96`）、已有 payload 复用（`production-owner-rules.ts:704-716`、`production-reminder-writer.ts:228-239`）、`keep(editedText)`、控制中心 `protectText`。反向用例只放一个 `classificationWithIdentifiers(text, "private")`，只覆盖一种形态。
- **证据**：上述 `file:line`；方案第 10 条。
- **建议**：用“单一 chokepoint + 品牌类型”从类型上限制只有统一函数能拿内存内容的加密写入；扫描器只做辅助，并维护全部 protect 调用点的显式清单。每个写入点一条集成测试（假的判断模型），反向用例覆盖：硬编码 private、编辑后提交、网页提醒、已有 payload 复用、同步同文早退。每条去掉修复都必须失败。

### 11. 中：补判的持久进度、预算、并发和旧副本清理都没定义

- **问题**：方案只说“按表和编号分批、记进度、中断能续、失败停下”，没有说进度存在哪、重启后怎么续、补判期间新写入怎么处理、补判用哪份额度、旧 private payload 是否还有别的引用。补判会新存一份敏感内容（类似 `production-memory-control.ts:1460-1482` 的 `memory-raised:`），每条都翻倍占存储。旧的那份“留着”时，如果同一个 `contentRef` 被规则、提醒、线程消息共享，只切换其中一条，另一条仍指向 private，外部读取仍可能读到。
- **证据**：上述 `file:line`；`packages/platform-node/src/payload-protector.ts:194-201` 说明分类在 AAD 里，不能原地改，必须新存一份。
- **建议**：加持久补判状态（表名、策略版本、游标、计数、失败原因）；单独限额和限速；用快照/水位处理补判期间的新写入；记录 `oldRef → newRef` 审计；确认旧 private payload 没有任何活引用后再决定保留或删除；进度页区分“已判/失败/按敏感待判”。

### 12. 中：失败按敏感 + 只升不降 + 没有降级入口，会把临时故障变成永久不可见

- **问题**：方案说判断失败按敏感、旧内容只升不降、只有主人页面能降。但 ADR 0260 后果里写明“网页上的纠正入口要等 iPhone 端”，目前没有这个操作。模型故障一天，当天所有规则/提醒/提议都变敏感，之后无法降回；任务/思考线程还可能因为主模型不接受 sensitive 而直接失败（`production-run-policy.ts:77-81` 抛 `RUN_POLICY_MODEL_DISCLOSURE_DENIED`）。
- **证据**：上述 `file:line`；`docs/adr/0260-memory-classification-on-the-server.md:86` 的后果。
- **建议**：本次先不做“只升不降”的永久承诺，或先实现主人纠正/审计；对主人自己写的规则、提醒，失败时至少保留“待判定”状态并允许重判，而不是永久敏感；任务/思考线程的模型选择要能在敏感时回退到允许 sensitive 的模型，否则不要把线程整体判敏感。

### 13. 中：新配置、提示词登记和 ADR 没有列生产者/消费者

- **问题**：写入判断的每日额度、三种超时都是新设置项，需要 `strict-configuration`、配置契约、默认值、控制中心页面和测试；方案只说“页面看得见能改”。`MEMORY_CLASSIFICATION.usedBy` 目前只写 `production-memory-classification.ts`，`purpose` 也只写“手动添加或导入”（`packages/prompt-catalog/src/memory.ts:84-99`），用于所有写入点后需要同步更新，否则提示词目录检查和文档会不一致。ADR 0260 决定 2/3 写的是“分类调用用主动检查模型、输入按 private”，ADR 0242 决定 7 写的是“推送时不调模型”，本方案都要修订，不能只在设计文档里说一句。
- **证据**：上述 `file:line`；方案第 8 条“要修订这一句”。
- **建议**：把新配置键、用量 purpose、提示词 `usedBy/purpose`、ADR 0260 和 ADR 0242 的修订列入同一 PR 的完成标准；`model_usage_observations.purpose` 有 CHECK 约束（ADR 0260 前提 7），新用途要么复用现有值，要么排改表。

### 14. 低—中：“同样文字同样字节”目前不成立

- **问题**：`memoryClassificationPrompt`（`production-memory-classification.ts:76-80`）和 `#batches`（`:169-187`）保留输入顺序。只把 id 改成内容摘要，不会让“同一组文字乱序进来”产生相同字节：JSON 数组顺序和批次边界都会变。不同写入点还用了不同的规范化（`normalizeProposalText`、`normalizeNoteText`、直接 `trim`），同一段可见文字可能摘要不同。模型输出本身也不确定，没有 verdict 缓存时同一段文字今天 private、明天 sensitive。
- **证据**：上述 `file:line`；方案测试“同样的文字乱序进来发给模型的字节相同”。
- **建议**：先定义规范化和摘要算法（NFC、换行、编码、SHA-256 截断），按摘要排序后再分批；用“文字摘要 + 提示词版本 + 策略版本”做 verdict 缓存，重复写入先查缓存，再按“只升不降”合并；测试写成“同一组条目任意顺序 → 字节相同”和“单独一条 → id 稳定”。

### 15. 低：业界类比只部分成立

- Microsoft Purview 的一手原文是：“Automatic labeling will replace a lower priority sensitivity label that was automatically applied, but not a higher priority label.”（<https://learn.microsoft.com/en-us/purview/apply-sensitivity-label-automatically>）。它支持“高优先级不被低优先级替换”，但同一页也写明 SharePoint/OneDrive 的自动策略可以**移除**已有标签（包括手动标签），也可以配置覆盖手动低优先级标签。所以“只升不降”是我们的产品选择，不是 Purview 的绝对规则，方案里应写成“我们采用更严格的只升不降”，不要说成业界都这样。
- Google DLP 确实同时提供同步文本检查和后台存储扫描：`content.inspect` 对文本返回 infoTypes/likelihood/offset（<https://cloud.google.com/dlp/docs/inspecting-text>），storage inspection 通过 job 扫描存储（<https://cloud.google.com/dlp/docs/inspecting-storage>）。这部分类比成立。

---

## 二、推测 / 未核实

- **推测（按字面实施）**：补判会改到线程消息和提示词包，从而改变已发前缀。方案没有明确排除；如果实现时只补判记忆/提案/同步表，这条不成立。需要作者确认范围。
- **推测**：默认生产配置的主动检查模型只允许 private。`strict-configuration.ts` 只要求 private，模板/测试里也有只配 private 的模型；但我没有读 Andy 的生产配置，标记**未核实**。如果生产模型已允许 sensitive，第 3 条的严重度会下降。
- **推测**：外部 agent 的 prompt injection 能让判断模型返回 private。机制成立，但没有实际跑过模型，成功率**未核实**。
- **推测**：`production-owner-rules.#writeText` 的“已有 payload 直接复用”能否被不同文本命中，取决于 key 是否包含内容摘要；我没有追完整的 key 生成，标记**未核实**。
- **未核实**：生产实际 `providerRequestMs` 是否就是模板里的 60000；模板是 60000，其他测试配置有 120000。无论如何，50 条 × 8 秒 × 2 次都超过任何合理请求期限。

---

## 三、侧重检查

我重点查了以下路径：

- **不可信输入**：`normalizeProposalText`、`scanMachineSecrets`、`EXTERNAL_PROPOSAL_CATEGORIES` / `MCP_SYNC_CATEGORIES` 白名单、`parseMemoryClassifications` 的严格解析；模型 prompt 的“数据不是指令”声明。结论：确定性凭据过滤和类别白名单是好的，但健康/财务等非凭据敏感内容仍完全依赖单模型，存在注入风险。
- **错误路径**：`judgeWithModel` 两次重试、`classify` 每批 catch 后返回 `UNCLASSIFIED`、每日额度 `MEMORY_CLASSIFICATION_DAILY_LIMIT`、失败码不写模型输出。结论：失败关闭方向正确，但失败会永久敏感且没有降级入口。
- **安全**：`PayloadProtector` 的 AAD 含 classification，不能原地改；外部读取按 `classificationRank` 过滤；`maskForExternalRead` 只遮秘密文本。结论：级别是唯一可见性开关，任何漏判或“只升不降”断点都会直接变成外部可读。
- **资源耗尽**：`#serially` 队列、`#proposeMemories` 50 条、`sync_memories` 50/200 条、`EXTERNAL_PROPOSAL_PENDING_MAXIMUM`、每日额度、补判重复 payload。结论：同步模型调用会放大延迟和待确认队列，外部写权限可用来耗尽额度和队列。
- **不可撤销操作**：只升不降、补判换引用、旧 private payload 保留。结论：需要审计、可恢复/可纠正方案，否则一次误判永久生效。
- **规则/文档/代码一致**：`prompt-prefix.md` 只追加、ADR 0260 的分类器输入/模型/额度、ADR 0242 决定 7、`MEMORY_CLASSIFICATION.usedBy`、I-73 的值两端校验。结论：方案至少漏了 ADR 0260/0242 的修订、提示词登记和 topic 的导出/导入链路。
- **值的两端**：`sensitive_topic`、`rule` category、新配置键、`decision_versions`/`confidence`、检查脚本。结论：topic 和 category 的 producer/consumer 没闭合，属于 I-73 同类问题。

---

## 四、如果由我来定，我会怎样改

1. **先做单一 chokepoint，不先改所有调用点。** 新增 `classifyAndProtectMemoryText(text, {source, baseClassification, externalCategory, existingClassification})`：规范化 → 确定性检测 → 外部类别/主题下限 → 模型判断（带总 deadline、可中止、额度）→ 取高 → 返回 `{classification, category, topic, failed, reason}` 并负责存敏感副本。所有内存内容只能经它加密写入，其他 `protector.protect` 调用用类型/清单挡住。
2. **写入路径异步化/有界化。** 外部 `propose_memories` 和 `sync_memories` 在请求内只做批量判断到总期限；没判完的以“待判=敏感”落库并返回 pending，后台继续。模型调用不要放在 `#serially` 队列里。每条外部连接加写入配额和待确认配额。
3. **判断模型单独配置并显式同意。** 新增允许 sensitive 的分类模型描述，启动时校验；没有就只保留确定性 + 外部 self-reported health/finance 下限，外部写入拒绝/排队。设置页说明“敏感文字会发给哪个服务方”，不要用 `dataClassification: "private"` 绕过披露检查。
4. **补判只碰安全范围。** 只补判记忆记录、`external_memory_proposals`、`mcp_sync_entries`、规则/提醒的 memory 内容；绝不改写线程消息、提示词包、已发历史。补判状态持久化（表 + 游标 + 策略版本 + 计数），单独预算/限速，记录 oldRef→newRef，确认旧 private payload 无引用。
5. **补齐 I-73 的值。** `topic` 从模型 → 提案行 → `keep` → 记忆 attributes → 导出 schema/verify/import/控制中心全链路，加往返测试；`mcp_sync_entries` 的 topic 如果没有消费者就删掉。category 按两个外部清单分别映射。
6. **修正敏感下限。** 任何 `SENSITIVE_MEMORY_TOPICS`（除 other）或 health/finance 一律敏感；分类器和 `production-memory-capture`/conversation review 共用。外部来源在主人确认前不得低于 sensitive。
7. **只升不降要覆盖所有分支。** 同文早退、已提交提案、同步条目、`keep(editedText)`、已有 payload 复用都要比较旧级别；`#storeText` 分类不一致必须拒绝。
8. **测试用假模型，反向用例按绕过形态写。** 每写入点：敏感句 → sensitive、普通句 → private、超时/失败/额度 → sensitive、已敏感不降、编辑后敏感、网页提醒敏感、外部 private 上限读不到。去掉 chokepoint/失败按普通/恢复无条件覆盖，对应用例必须失败。检查脚本改成“chokepoint + 显式调用点清单”，不要假装静态扫描能证明数据流。
9. **文档同步。** 修订 ADR 0260 决定 2/3、ADR 0242 决定 7；更新 `MEMORY_CLASSIFICATION.usedBy/purpose`；把“只升不降”写成产品选择（Purview 只支持“高优先级不被低优先级替换”，不是绝对不降级）；说明降级入口是否在本次范围。

---

## 五、逐条回答必答问题

**1. 会不会改变模型已经见过的请求开头？**

新写入本身不会。分类器是独立的后台调用，不改对话的系统提示、工具定义或历史；写入级别变化只会影响“本轮选中的记忆”是否出现在最后一条用户消息里，而每轮变化的值本来就在最后一条消息（`.agents/instructions/prompt-prefix.md:27-30,36`，ADR 0104/0149）。所以“发给模型的内容仍然只在末尾追加、每轮会变的值都在最后一条消息”这个要求在**新写入**范围内成立。

但**旧内容补判按字面会破坏它**：如果补判切换 `production-think-runner` / `production-task-proposals` 写下的线程消息或提示词包，就是改写已发历史；`production-thread-prompt-bundle-operations.ts:169-172` 还可能因级别不一致触发重建。必须在方案里明确“补判不碰线程历史/提示词包”，并加测试。

**2. 会不会让同一段文字在不同请求里变成不同字节？**

会，当前设计不足以保证：
- 分类器 prompt 的 `items` 数组保持输入顺序、批次按输入顺序切（`production-memory-classification.ts:76-80,169-187`），只把 id 改成内容摘要不够；乱序进来 JSON 数组和批次边界都会变。
- 不同写入点规范化不同（`normalizeProposalText`、`normalizeNoteText`、直接 `trim`），同一段可见文字可能摘要不同。
- 模型输出本身不确定，没有 verdict 缓存时同一段文字可能这次 private、下次 sensitive。

对**对话请求**的 KV 缓存没有直接影响（分类器是后台调用）；但方案自己承诺的“同样文字同样字节”和对应测试目前不成立。需要规范化 + 按摘要排序 + 稳定摘要算法 + verdict 缓存/只升不降。

**3. 有没有对应的自动检查，反向用例真的会失败？**

不够。现有 `production-memory-classification.unit.test.ts` 只覆盖分批、额度、失败码，没有覆盖超时、失败、健康/财务下限、topic。方案拟议的 `check:memory-write-classification` 只做“扫描 apps/ 下加密存储调用”，无法证明数据流，且漏掉 `keep(editedText)`、网页 `protectText`、硬编码 private、已有 payload 复用；反向用例只有一种 `classificationWithIdentifiers(text, "private")` 形态，不能保证去掉修复后真的失败。应改成“单一 chokepoint + 显式调用点清单 + 每个写入点的假模型测试 + 多种绕过形态的反向用例”。

**4. 每个新值的使用方都能接受吗？**

没有全部核对闭合：
- `sensitive_topic`：`production-mcp-memory-writer.ts:349-350` 仍按 category 推；`sqlite-external-memory-proposal-operations.ts:148` 不校验 topic；导出/导入/verify/schema 没加；`mcp_sync_entries` 的 topic 没有消费者。
- category：`rule` 在两个外部清单里的处理不同（`production-mcp-memory-writer.ts:46-56`、`production-mcp-sync.ts:33-35`），漏映射会在 `sqlite-external-memory-proposal-operations.ts:147-148` 被拒。
- 新配置键（额度、三种超时）没有写进 `strict-configuration`、契约、控制中心、默认值。
- `MEMORY_CLASSIFICATION.usedBy/purpose`、ADR 0260/0242、`package.json` 的 `check:steps` 都还没列。
- `decision_versions`/`confidence` 依赖另一份未定稿 ADR，方案目前是悬空依赖。

---

## 六、结论

方案方向是对的：写时判断、失败关闭、只升不降、旧内容补判，和 Purview/Google DLP 的“写入时打标 + 存量扫描”一致。但按原文实施会出现四类硬问题：漏写入点导致真实泄漏、同步模型调用导致超时/阻塞/DoS、默认模型不允许 sensitive 导致全量敏感、补判改写已发历史违反只追加。再加上 topic/category 的 I-73 链路没闭合、自动检查不足以证明“所有写入点”，我建议**不按当前版本动工**；先按上面第 1—9 条改方案，再让 Andy 决定额度和模型披露方式。
