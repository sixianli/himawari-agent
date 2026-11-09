## 证实的（按严重度）

### 1. 高：把机器密钥算进“凭证型”，但 `[密钥]` 根本还原不了，验收标准 #1 对密钥必然失败

- 问题：方案第一步把 `machine-secret` 列入可召回凭证，并声称“模型回答里原样写占位符，主人看到原值”。但机器密钥的占位符是固定的 `[密钥]`：没有编号、不进还原表、`EGRESS_PLACEHOLDER_PATTERN` 也不匹配它。ADR 0183 已明确写“`[密钥]` 没有编号、无法还原”。
- 证据：
  - `packages/sensitive-capture/src/redaction.ts:69-70`（`MACHINE_SECRET_PLACEHOLDER = "[密钥]"`）、`:331-338`（机器密钥直接替换，不调用会写 `table` 的 `mask()`）、`:65`（还原正则不含 `[密钥]`）。
  - `packages/sensitive-capture/src/restoration.ts:51-53`：`restorePlaceholders` 在文本不含 `#` 时直接返回原文。
  - `packages/runtime-pi/src/egress-context.ts:30-39`：还原只替换文字块，且依赖 `exchange.restore()`。
  - `docs/adr/0183-mask-only-when-data-leaves-and-keep-the-original-inside.md:38,51`。
  - 更糟的是现有提示词已经对模型承诺了错误行为：`packages/prompt-catalog/src/chat.ts:255,267` 把 `[密钥]` 和密码、验证码、卡号、证件号列在一起，并说“回答里需要提到它们时请照原样写出，系统在显示给主人时会换回原值”。
- 建议：第一步先从“凭证型”里排除 `machine-secret`；或者先实现带编号、可进还原表的机器密钥占位符（这会引入新的密钥映射和存储，不是小改）。同时修正图例，明确 `[密钥]` 不能被还原。

### 2. 高：索引端用“当前规则”判断凭证型，聊天出口用“对话冻结的旧规则”遮盖，旧对话可能把原密码发给模型

- 问题：方案说“用遮盖文建索引，发出去的字节和今天聊天里发的遮盖内容同类”。但两端的规则集不是同一个：
  - 索引端会按当前规则（默认 ruleset 2）识别“凭证型”；
  - 聊天出口按每个对话冻结的 `redactionRuleset` 遮盖（`pi-runtime-adapter.ts:1567`）。
  - ruleset 1 不识别“密码 abc12345”这种没有冒号/“是”的宽松写法，现有测试明确证明 ruleset 1 时请求体里仍含 `abc12345`，ruleset 2 才遮。
  - 因此，一条在 ruleset 2 下被判定为凭证型、带 `abc12345` 的记忆，在冻结为 ruleset 1 的老对话里被 recall 返回后，出口不会遮它，原值直接发给模型。这不是缓存问题，是泄密。
- 证据：
  - `packages/sensitive-capture/src/redaction.ts:53-54`（`EGRESS_RULESET_FIRST_LOOSE_PASSWORDS = 2`）、`:350-356`（只有 ruleset ≥ 2 才应用宽松密码规则）。
  - `packages/runtime-pi/src/pi-runtime-adapter.ts:1567`（把 `bundle.redactionRuleset` 传给出口）。
  - `packages/runtime-pi/test/prompt-prefix.compat.test.ts:633-642`（ruleset 1 时断言请求体仍含 `abc12345`）、`:644-653`（ruleset 2 才遮）。
  - `packages/application/src/ports/intelligence.ts:438-451`：`RuntimeToolInvocation` 里没有 `redactionRuleset`，recall 服务端目前拿不到本对话的冻结规则集。
- 建议：recall 在返回凭证型记忆前，必须确认“本对话冻结的出口规则集”一定能把这条记忆里的凭证值遮掉；做不到就不返回（或只返回已遮盖文本，并接受无法还原给主人）。需要把 `redactionRuleset` 传进工具调用，或由出口层在发送前做一次“该记忆是否被本规则集完整遮盖”的校验。必须补一个 ruleset 1 的反向测试。

### 3. 高：“不需要改嵌入模型的 allowedDataClassifications”是错的，全文和向量两条路都被现有分类门槛挡住

- 问题：方案声称“向量用遮盖文去嵌入，不需要改嵌入模型的 `allowedDataClassifications`”。但代码里嵌入是否发生完全由**记忆的分类**决定，不由内容的遮盖结果决定：
  - `HybridMemoryProvider` 只有 `#embeddable.has(memory.dataClassification)` 才嵌入；`embeddableClassifications` 直接来自嵌入模型的 `allowedDataClassifications`。
  - 投影调用的准入检查也按 `projection.memory.dataClassification` 校验，sensitive 会被拒 `EMBEDDING_REQUEST_OUTSIDE_POLICY`。
  - 全文词项也不是“算了就能进”：SQLite 写入时用 `INDEXED_ENTITY_CLASSIFICATIONS`（只含 public/private）把 sensitive 的 terms 直接丢掉。
  - 这个常量同时控制实体表和 FTS 词项。要放行凭证记忆的词项，就会顺带放行实体表，和方案“实体表仍不写”冲突。
- 证据：
  - `apps/agent-service/src/production-memory-composition.ts:101`（`embeddableClassifications: embedding.allowedDataClassifications`）。
  - `packages/memory-engine/src/hybrid-memory-provider.ts:85-102`（terms 只看 `LEXICAL_CLASSIFICATIONS`，嵌入只看 `#embeddable.has(memory.dataClassification)`）。
  - `apps/agent-service/src/production-run-memory.ts:120-139`（投影的 classification 取 `projection.memory.dataClassification`，不在允许列表就拒绝）。
  - `packages/persistence-sqlite/src/sqlite-memory-operations.ts:146`（`INDEXED_ENTITY_CLASSIFICATIONS = new Set(["public","private"])`）、`:799-805`（实体表门槛）、`:1008-1014`（FTS terms 门槛）。
- 建议：不要直接改全局的 `LEXICAL_CLASSIFICATIONS`/`INDEXED_ENTITY_CLASSIFICATIONS`。单独做一条“凭证记忆投影”路径：在 `sensitive-capture` 里提供一个函数同时返回遮盖文和“是否凭证型”，索引端只对凭证型放入受限索引；实体表保持不写。嵌入部分要单独决定：要么明确把嵌入模型配置为允许 sensitive（并更新 ADR/配置），要么放弃向量、只做受限全文索引。现在的“两者都不改”不可实现。

### 4. 高：与已接受的 ADR 冲突——ADR 0185 明确说敏感记忆读取需要“经主人确认的路径”，方案却说第一步不需要 Andy 确认

- 问题：ADR 0185 的后果一节写得很清楚：`sensitive` 记忆不进全文和实体索引，所以模型检索不到；“要让模型能用，需要另做经主人确认的敏感记忆读取路径”。方案第一步的核心正是“让模型能用”，却写“零新增主人确认”“第一步不需要他确认任何事”。这不是实现细节，是改变已批准的政策。
- 证据：
  - `docs/adr/0185-mark-passwords-and-keys-sensitive-instead-of-dropping-them.md:61`。
  - `docs/adr/0183-mask-only-when-data-leaves-and-keep-the-original-inside.md:39,47`（敏感信息需主人批准、存储侧仍然标敏感）。
  - `apps/agent-service/src/production-run-policy.ts:77`、`apps/agent-service/src/production-http-composition.ts:864-877`：模型披露门槛是按运行分类判断的；recall 把 sensitive 内容放进一个 declared `private` 的请求里，实际上绕过了这层门槛。
- 建议：把“凭证型 sensitive 可被 recall”作为一次明确的政策变更交给 Andy 拍板，并更新 ADR 0185/0183；或者实现一个默认关闭、主人明确授予的“允许对话召回敏感记忆”开关（按对话或按记忆），并在 recall 服务里强制校验，而不是只放宽分类过滤。

### 5. 中高：按方案字面在 `hybrid-memory-provider.ts` 直接调用 `redactForEgress`，现有自动检查会失败

- 问题：方案写“在 `hybrid-memory-provider.ts` 的 `upsert` 用 `redactForEgress(原文)`”。`check:egress-redaction` 规定只有出口模块能直接调用 `redactForEgress`，其他文件直接调用会被判违规。
- 证据：`scripts/check-egress-redaction.mjs:178-181`（`redactForEgress` 只允许出现在 `REDACTOR_ONLY_FILES`）、`:18-26`（登记表不含 `hybrid-memory-provider.ts`）。
- 建议：把“检测凭证 + 生成索引用遮盖文”封装在 `packages/sensitive-capture` 里，例如 `redactForMemoryIndex()`，索引端只调用这个函数；不要靠把索引文件加进 `REDACTOR_ONLY_FILES` 来绕过规则。

### 6. 中：补投影的分析只对了一半；一旦把 sensitive 加进 `embeddableClassifications`，会反复补投影，甚至可能把健康类记忆送去嵌入

- 问题：方案风险 5 说“已有 sensitive 凭证型记忆修订没变，不会被重投影”。如果只改词项，这成立；但如果按方案做向量，就必须把 sensitive 加进 `embeddableClassifications`。此时 `listUnindexed` 的条件是：
  - `m.classification IN embeddable AND (embedding_model IS NULL OR ...)`
  - 所有现有 sensitive 记忆都有索引行但 `embedding_model` 为 null，因此会在启动时被全部选中；
  - 非凭证型的健康/财务 sensitive 永远不会产生嵌入，`embedding_model` 永远是 null，于是**每次启动都会再次被选中、再次排投影**；
  - 如果 `upsert` 没有额外判断，健康/财务文本会被送去嵌入，直接违反方案“健康、财务不放开”。
- 证据：
  - `packages/persistence-sqlite/src/sqlite-memory-operations.ts:1446-1478`（`listUnindexed` 的 SQL 条件）。
  - `apps/agent-service/src/service-main.ts:1177-1193`（启动时循环调用 `listUnindexed` 并 `requeueProjection`）。
  - `docs/execution/specs/2026-10-25-self-built-memory-engine-design.md:126`（启动补投影的意图）。
- 建议：做一次**定向**补投影：只扫描 active、sensitive、`sensitiveTopic` 为 other/空、且检测为凭证型的记忆，排队一次即可；不要把 `sensitive` 整体加入 `embeddableClassifications`。补投影必须测试“健康/财务记忆不会被嵌入、不会每次启动重复排队”。如果确实要加投影策略版本，用一次性任务或明确的 expand 迁移，不要把“加列”当成无需设计的小事。

### 7. 中：召回出的原密码会以 `private` 分类写进工具结果/trace，后续按分类保护的消费者会低估它

- 问题：recall 返回的 `text` 是原文；Pi 捕获 `tool_result` 时用的是 `request.dataClassification`（正常对话是 private），而不是内容实际达到的 sensitive。这样原始密码会以 private 分类落进工具结果 payload/trace。ADR 0183 要求“卡号、证件号至少标成敏感”，但这条路径没有按内容提升分类。方案没有提到这一点。
- 证据：
  - `packages/runtime-pi/src/pi-runtime-adapter.ts:2180-2190`（`tool_result` 用 `request.dataClassification`）。
  - `packages/runtime-pi/src/pi-runtime-adapter.ts:316-339`（`redactObservation` 只遮机器密钥和 URL 敏感参数，不遮密码）。
  - ADR 0183:39。
- 建议：工具结果要么按实际内容分类为至少 sensitive，要么显式带上 `classification` 字段，供 trace、导出、保留策略使用；同时在测试里断言“recall 工具结果的持久化分类不是 private”。

### 8. 中：索引变化会改变自动上下文的候选池，可能把本来的 private 记忆挤出去

- 问题：`HybridMemoryProvider.search` 先融合并截取 top-N，然后 `DurableMemoryService.search` 才按分类过滤。凭证型 sensitive 进入索引后，会占据候选名额，可能把原本能进自动上下文的 private 记忆挤出 top-N。方案说“自动上下文保持只取 public/private”只保证了输出分类，没有保证选择结果不变。
- 证据：
  - `packages/memory-engine/src/hybrid-memory-provider.ts:169-180`（先 `fuseCandidates` 取 limit）。
  - `packages/application/src/services/durable-memory-service.ts:370-411`（后按 `allowedClassifications` 过滤）。
  - `apps/agent-service/src/production-run-memory.ts:357-363`（自动上下文传入 public/private）。
- 建议：对自动上下文这类不允许 sensitive 的搜索，把分类过滤下推到 provider/SQL，或者按允许分类多取候选再截断；补一个“加入凭证记忆前后，自动上下文选中的 private 记忆不变”的回归测试。

### 9. 中：反向验收大多不是自动测试，而且“全文/向量没有原值”很容易空跑通过

- 问题：方案的反向验收是手工场景。尤其第 2 条“全文词项表、向量输入里没有原值（去掉遮盖时测试必须失败）”：
  - 现在的持久化层会把 sensitive 的 terms 直接丢掉，所以“表里没有原值”在完全不写索引时也成立；
  - 如果测试只断言“没有原值”，去掉遮盖仍然会通过，因为根本没有 terms；
  - 必须同时断言“语境词进去了、嵌入发生了”，否则测不出实现是否正确。
- 证据：`packages/persistence-sqlite/src/sqlite-memory-operations.ts:1008-1014`；现有召回测试 `apps/agent-service/test/production-memory-recall.unit.test.ts:82-98,235-243` 只覆盖分类过滤。
- 建议至少补这些自动测试：
  1) 正向：凭证记忆的 `terms` 含“Wi-Fi/密码”等语境词、`embedding` 非空，且不含原值；去掉遮盖后失败。
  2) 健康/财务 sensitive 不进词项、不做嵌入、不进 recall。
  3) ruleset 1 的对话召回凭证记忆时，要么不返回，要么请求体里不含原值。
  4) 机器密钥：要么不返回，要么主人看到的仍是 `[密钥]`（按决策断言）。
  5) 已有记忆升级后的定向补投影；重复启动不重复排队。
  6) recall 工具结果持久化的分类不是 private。
  7) `check:egress-redaction` 通过。

### 10. 中：第二步选项 C 说“只对 recall 生效”，但把 sensitive 加进聊天模型配置是全局的

- 问题：`allowedDataClassifications` 是模型描述符级别的；加 `sensitive` 后，`production-run-policy.ts:77` 和 `production-http-composition.ts:864-877` 对所有 declared 分类为 sensitive 的运行都会放行，而不只是 recall。反过来，工具结果不会改变本次运行的 `dataClassification`，所以“给模型加 sensitive”并不能精准地把召回路径限定住。自动上下文仍看 `maxMemoryClassification`，是另一套开关。
- 证据：`apps/agent-service/src/production-run-policy.ts:77`；`apps/agent-service/src/production-http-composition.ts:864-877`；`apps/agent-service/src/production-run-memory.ts:357-363`；设计规格 `docs/execution/specs/2026-10-25-self-built-memory-engine-design.md:108`。
- 建议：不要用全局模型配置实现“只对 recall 生效”。用一个显式的、按对话或按记忆的授权（默认关），在 recall 服务里校验；配置和代码都围绕这个授权，而不是围绕模型分类。

### 11. 低 / 文档一致性

- 索引用的无 tag 遮盖文对银行卡保留了后四位（`redaction.ts:385`：`银行卡 尾号${digits.slice(-4)}`），和方案“值本身不进索引”不完全一致；至少要在方案里承认这是值派生信息。
- `sensitiveTopic` 是单值（`packages/application/src/ports/automatic-memory.ts:115-126`、`apps/agent-service/src/production-memory-control.ts:79-81`）。一条被合并/总结的记忆可能同时含凭证和其他敏感话题；只靠 `sensitiveTopic === "other"` 无法证明整条记忆都是凭证型。需要确认记忆粒度，或在方案里明确这个假设及失败方向。
- 设计规格 `docs/execution/specs/2026-10-25-self-built-memory-engine-design.md:67,70,162` 明确写“sensitive 以上不进全文和实体索引”“全文索引和向量是明文衍生物”，方案要改这条风险判断，但方案没有提到更新该文档。
- 如果按第 1 条修图例（`chat.ts` 系统提示文字），那是一次系统提示文字变更：老对话按冻结继续用旧字节，新对话用新字节（`.claude/rules/prompt-prefix.md:41-43`）。这不是“不改开头”，需要在 KV 缓存规范里记录一次。

## 推测 / 未核实

- **混合话题记忆**：如果自动整理把“Wi-Fi 密码”和“我对青霉素过敏”合进同一条记忆，且模型把 `sensitiveTopic` 标成 `other`，方案会把整条返回给模型，健康信息也会进入出口。现有红action只遮凭证值，不遮健康内容。需要看实际整理粒度和 `sensitiveTopic` 的准确性；我未核实生产数据。
- **旧 ruleset 对话是否仍在生产使用**：代码路径和测试都证明 ruleset 1 的行为，但我没有核实生产库中是否还有冻结在 ruleset 1 的对话。哪怕只有历史对话，这也是必须处理的安全路径。
- **补投影成本**：一次性重投影会触发真实嵌入调用和预算预留；未核实现有记忆规模和预算额度。
- **recall 重新执行**：分数里含 `now` 和 `lastUsedAt`（`packages/memory-engine/src/fusion.ts:40-48,99-114`），所以同一查询在不同时间重新执行，排序可能不同。正常对话中 recall 结果会写入历史后冻结，但恢复/重放路径如果重新执行 recall，可能得到不同结果。未核实恢复路径是否重跑 recall。

## 侧重检查

- **错误路径**：
  - 机器密钥无法还原（第 1 条）。
  - 旧 ruleset 不遮宽松密码（第 2 条）。
  - 如果某条记忆里的机器密钥被 `scanMachineSecrets` 认出但 `redactForEgress` 没遮住，`model-egress.ts:233-246` 会 `refuse` 整个模型请求；一条“毒记忆”可让该对话每轮都失败。方案没有讨论这个失败方向。
  - `readText` 解密失败会被 `production-memory-recall.ts:221` 静默跳过，凭证记忆会静默消失；这对安全是保守的，但用户会看到“没找到”，需要在测试里覆盖。
- **不合规范或不可信输入**：
  - 记忆文本可以包含字面量 `[密码#abcdefgh]` 或 `[密钥]`。`redactForEgress` 会把它们当成已经是占位符，不写还原表；最坏情况下与同一次请求里真实值的占位符同名，`restore()` 会把字面量还原成那个真实值。不会泄露给模型，但会污染主人看到的内容和落库文本。建议在测试里覆盖“记忆里含字面占位符”。
  - 单值 `sensitiveTopic` 无法证明整条记忆只含凭证话题（推测）。
- **安全**：第 2、3、4、7、10 条是主要安全/政策缺口。最严重的是第 2 条：方案的安全论证依赖“出口一定遮”，但出口规则集是按对话冻结的，索引端没有校验这一点。
- **资源耗尽**：第 6 条的启动重复补投影；一次全量补投影的嵌入费用；recall 现在需要为候选 sensitive 记忆解密并跑 `redactForEgress` 才能判断凭证型（`production-memory-recall.ts:213-221` 目前是先分类过滤再读文本，方案会改变这个顺序），单次 recall 的解密/正则成本会上升，虽然候选数受 `limit*3` 限制，仍建议给凭证判定结果加缓存或把“是否凭证型”持久化为投影字段。
- **不可撤销操作**：方案本身没有不可撤销的外部操作；补投影只改索引，可重建。但“一次全量重投影”会消耗嵌入预算，且如果按第 6 条误把健康记忆送去嵌入，是不可撤回的外部披露。
- **规则/文档一致性**：
  - `check:egress-redaction` 会挡直接 `redactForEgress`（第 5 条）。
  - ADR 0185 要求主人确认的读取路径，方案说不需要（第 4 条）。
  - 提示词图例承诺 `[密钥]` 可还原，和代码不一致（第 1 条）。
  - 设计规格第 67/70/162 行仍写 sensitive 不进全文/实体索引，方案没说要改（第 11 条）。
  - 如果改图例，要按 `.claude/rules/prompt-prefix.md:41-43` 记录“只对新对话生效”。

## 如果由我来定，我会怎样改

1. **拆成两个独立变更**：
   - **A. 凭证记忆投影**：在 `packages/sensitive-capture` 提供 `analyzeCredentialMemory(text, topic)`，返回 `{ isCredential, redactedText }`；索引端只对 `isCredential && (topic === "other" || topic == null)` 写受限词项/向量。不要改全局 `LEXICAL_CLASSIFICATIONS`、`INDEXED_ENTITY_CLASSIFICATIONS`；单独加凭证索引开关，实体表继续不写。
   - **B. 嵌入政策**：单独决定嵌入模型是否允许接收“已遮盖的凭证语境”。允许就更新配置/ADR 和 `embedOnce` 的准入；不允许就只做受限词项，不要假装“不需要改配置”。
2. **先排除机器密钥**，直到有带编号、可还原的机器密钥占位符；同时修正 `CHAT_EGRESS_LEGEND*` 里“所有占位符都能还原”的错误承诺。
3. **recall 加“冻结规则集”校验**：把 `redactionRuleset` 传进 `RuntimeToolInvocation`；凭证记忆只有在“本对话的出口规则集能遮住它”时才返回。旧规则集或未知规则集时，宁可只返回已遮盖文本或不返回。
4. **把“允许召回凭证记忆”做成显式授权**（默认关，按对话或按记忆），并更新 ADR 0185/0183；不再声称“第一步不需要 Andy 确认”。
5. **工具结果按内容分类**至少 sensitive，或带独立 classification 字段，避免 trace/导出/保留策略把它当 private。
6. **自动上下文搜索下推分类过滤**，确保加入凭证索引不会挤掉 private 记忆。
7. **测试按上面第 9 条补齐**；尤其要有一个“ruleset 1 老对话 + 凭证记忆”的反向测试，和“健康/财务不会被嵌入”的反向测试。
8. **补投影用定向一次性任务**，不轻率加列；如果确实要加“投影策略版本”，按 expand 迁移、启动顺序和旧版本回滚一起设计。

## 必答问题

1. **会不会改变模型已经见过的请求开头？**
   - 按方案字面，不会：`recall` 工具和参数结构不变，敏感结果只出现在工具结果（追加消息）里；系统提示、工具定义、历史都不改。每轮会变的值（recall 结果、时间）都在最后一条消息/工具结果里，符合 `.claude/rules/prompt-prefix.md:27-29,35` 和 OpenAI “Append new messages rather than rewriting earlier turns”（https://developers.openai.com/api/docs/guides/prompt-caching ）。
   - 但有两个例外要写明：修图例会改系统提示文字，只对新对话生效（`.claude/rules/prompt-prefix.md:41-43`）；如果为了实现第 2 条把 `redactionRuleset` 带进工具调用，不涉及请求字节，但会改变“是否返回该记忆”的行为。
   - 自动上下文内容仍在最后一条消息；第 8 条的候选被挤出只影响最后一轮内容，不影响前缀。
2. **同一段文字会不会在不同请求里变成不同字节？**
   - 模型可见的已发内容不会：占位符由稳定的 HMAC 生成（`packages/application/src/services/model-egress.ts:121-126`），密钥来自 payload-encryption secret（`apps/agent-service/src/production-model-egress.ts:77-86`），历史存原文、每次按同一规则重新遮盖（`docs/kv-cache-guide.md:60`）。
   - 但“跨请求”不是全局确定：出口规则集按对话冻结，同一段文字在 ruleset 1 和 ruleset 2 的对话里会遮成不同结果，这正是第 2 条的安全问题。索引端还用无 tag 的 `redactForEgress`（`[密码]`、`[银行卡 尾号1234]`），和模型看到的 `[密码#hash]` 不是同一字节，但索引文本不发给模型，不能把两套占位符混用或拿去还原。
   - 机器密钥固定成 `[密钥]`，不同值会合并成同一个占位符；这不会导致“同值不同字节”，但会破坏区分和还原。
3. **有没有对应的自动检查，反向用例真的会失败吗？**
   - 现有的 `check:prompt-prefix`（`scripts/check-prompt-prefix.mjs`，至少 8 条 `[I-66]`）只检查追加/前缀，不检查 rollback；现有召回测试（`apps/agent-service/test/production-memory-recall.unit.test.ts:82-98,235-243`）只覆盖分类过滤；`check:egress-redaction` 只检查调用点。
   - 方案给的反向验收大多不是自动测试，而且第 2 条很容易空跑通过（因为 sensitive terms 现在根本不会写入）。必须补正向断言和上述 ruleset 1、机器密钥、健康不嵌入、补投影、持久化分类等测试，否则“去掉遮盖测试必须失败”不能成立。
4. **每个新值/改动的每个使用点都能接受吗？**
   - “凭证型”：索引端和 recall 端必须用同一个函数；但索引端用当前规则，出口用冻结规则，这是第 2 条的断点。
   - `sensitiveTopic`：写入端/DB 校验 `SENSITIVE_TOPICS`（`packages/application/src/ports/automatic-memory.ts:115-126`、`packages/persistence-sqlite/src/sqlite-memory-operations.ts:127-136`），recall 端只接受 other/null，这一点一致；但单值无法证明整条记忆只含凭证话题（推测）。
   - 索引遮盖文/terms：产生端是 `HybridMemoryProvider.upsert`，消费端是 SQLite 的 `memory_search_terms`；当前被 `INDEXED_ENTITY_CLASSIFICATIONS` 丢掉，方案必须改持久化端，且不能顺带写实体表。
   - `embeddableClassifications`：产生端是嵌入模型配置，消费端有 `HybridMemoryProvider`、`listUnindexed`、`embedOnce` 三处；加 sensitive 必须三处同时接受，否则投影失败；加进去后健康记忆也会被反复补投影（第 6 条）。
   - “投影策略版本”（如果新增）：会进入 DB 迁移、`listUnindexed`、索引写入/读取、备份/传输/管理 CLI；方案没有逐个核对。能不用列就不用列。
   - 工具结果分类：产生端是 `pi-runtime-adapter.ts:2180-2190` 的 `request.dataClassification`，消费端是 trace/导出/保留策略；需要按内容提升到 sensitive（第 7 条）。
   - 第二步的“允许对话用到敏感记忆”开关：如果做成模型配置，会被 `production-run-policy.ts:77`、`production-http-composition.ts:864-877` 全局消费，不是只对 recall 生效（第 10 条）。
