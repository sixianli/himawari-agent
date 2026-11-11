审核基于 `aa1b0b0`。`plan.md` 不在当前仓库里（`.agents/tasks/**/plan.md` 未找到），所以“问题、目标、约束、已核对事实”只能按你贴出的方案正文核对；涉及 plan.md 的具体事实我标为“未核实”。

## 证实的（按严重度）

### 高

1. **启动预加载与 30 秒启动预算直接冲突**
   - 问题：方案同时写了“启动时预加载完成后才接请求”和“加载未完成时向量检索按失败处理、退回关键词”。前者会把模型加载时间加进启动时间；后者才是可行做法。生产实例的启动预算是 30 秒，而 backlog 实测模型加载约 20 秒（4 核云端），生产机磁盘随机读只有约 10 MB/s，571 MB 模型冷加载可能更慢。
   - 证据：`scripts/delivery-mode/instances/andy-production.json:25`（`startupReadyBudgetSeconds: 30`）、`docs/backlog/BL-20261028-008-local-memory-embedding.md:33-34`（约 20 秒、约 1.4 GB 内存）、方案第 2 节原文。
   - 建议：启动只做廉价检查，模型在后台加载；加载完成前向量检索按失败处理，保留关键词和实体；用 health 标记“记忆向量降级”，加载完成后自动恢复。不要把模型加载放进启动就绪路径；加载失败不能让服务起不来。上线前在生产同款磁盘上实测冷加载时间。

2. **`identity` 没有贯穿请求校验、准入和投影幂等键，带同维度的换模型/换量化文件会被挡住**
   - 问题：方案说“所有写入和查询统一用 `embedder.identity`”，但 `production-run-memory.ts:133` 要求 `request.model === descriptor.model`；`:151` 的幂等键是 `JSON.stringify(request)` 的哈希；`sqlite-model-budget-operations.ts:454-469` 对已有 `operationKey` 直接返回旧分配；`durable-memory-service.ts:586` 的投影 job id 只含 memory/revision/operation，`sqlite-memory-operations.ts:1539-1553` 会把同一个 job 重新置为 pending。结果：同名档案换量化文件、换前缀、或两个模型维度相同（如 jina 1024 与 Qwen3-0.6B 1024）时，重排的投影会命中旧预算分配并抛 `EMBEDDING_RESULT_REQUIRES_RECONCILIATION`，向量根本不会重算。方案里“同名模型换量化文件或前缀时也会触发重算”的结论不成立。
   - 证据：上述文件行；`packages/memory-engine/src/hybrid-memory-provider.ts:99-103,141-149` 和 `packages/memory-engine/src/episodes.ts:224-227,282-301,340-342` 现在直接用 `embedder.model`。
   - 建议：明确区分两个值：
     - `wireModel`：发给 provider 的模型 id，仍等于 `descriptor.model`，保住 `production-run-memory.ts:133` 和 `gatewayEmbeddingUsage` 的校验；
     - `identity`：只用于索引和查询过滤，形如 `<档案 id>@<artifact sha12>@<format sha12>`。
     把 `identity` 加进 `EmbeddingRequest`（或单独参数）并纳入 `baseOperationKey`，同时改 `HybridMemoryProvider`、`MemoryEpisodeService`、`service-main` 启动补索引、admin CLI、评测所有使用点。加反向测试：只改 artifact 哈希、维度不变，必须触发重算且不被预算层拒绝。

3. **`identity` 不包含前缀、pooling、归一化和遮盖规则，方案声称“换前缀会重算”是错的**
   - 问题：身份是 `<档案 id>@<模型文件 sha256 前 12 位>`。前缀、pooling、归一化、查询/文档格式、出口遮盖规则和遮盖密钥都不在里面。改前缀不会改变身份，旧向量不会重算；改遮盖密钥后同一段文字会遮成不同字节，旧向量同样不会重算。`prompt-catalog/src/memory.ts:38` 已经写明“改它会让已存的向量和新查询对不上”，但当前没有门槛。
   - 证据：方案第 4 节身份定义；`packages/prompt-catalog/src/memory.ts:36-43`；`apps/agent-service/src/production-model-egress.ts:77-84`（遮盖密钥来自 payload-encryption secret）。
   - 建议：`identity` 至少包含：档案 id、artifact sha256、查询前缀字节、文档前缀字节、pooling、normalize、dimensions、量化/运行时版本。若本机仍走出口遮盖，还要包含 `redactionRuleset` 和遮盖密钥版本；更简单的是本机 `local_only` 不做出口遮盖（数据没有离开本机），并改掉对应集成测试的预期。加测试：只改前缀或只轮换遮盖密钥，必须触发重算。

4. **部署切换脚本只批准 staticRoot、主模型窗口和 publicFetch，嵌入配置改动会被拒绝**
   - 问题：方案说“切换 = 改配置里的 model/artifact/dimensions + 重启”，但 `S7-switch-start-readback.py` 的 `static_root_configuration` 只允许改静态目录、主模型 contextWindow/maxTokens、publicFetch 字节数；`maintenance-common.mjs` 的 `staticRootConfiguration` 同样只改这三类。嵌入描述符、`memory.minimumSimilarity`、`artifact` 任何变化都会触发 `*_UNAPPROVED_CONFIG_FIELD_CHANGED`。`make-packet.py` 的 `configTargets` 也只有主模型和 publicFetch，没有嵌入目标值。方案只提了改两个 fixture，没提改这两个生产脚本和出包生成器。
   - 证据：`scripts/delivery-mode/packet-template/systemd/S7-switch-start-readback.py:146-166`、`scripts/delivery-mode/packet-template/maintenance/maintenance-common.mjs:343-365`、`scripts/delivery-mode/make-packet.py:188-189,217,264-282`、`scripts/delivery-mode/instances/andy-production.json:19-24`。
   - 建议：把嵌入目标（档案 id、provider、dimensions、artifact path/sha256/bytes、`memory.minimumSimilarity`）加入 `configTargets` 和两个生产函数；出包时从当前配置读原值、从实例文件读目标值；再更新 fixture。只改 fixture 不够，因为 fixture 直接 exec 生产函数。

5. **`verify-fixtures.mjs` 的反向用例会把新维度当作“未批准变化”，改完就不失败了**
   - 问题：反向用例把 `modelDescriptors[1].dimensions` 改成 `1024`，期望被拒绝。jina v5 small 的新维度正好是 1024，改完后这条用例会通过（不拒绝），变成假阴性。`verify-switch-config-fixtures.py` 还把 embedding 写死为 `qwen-embedding / 4096`，目标改成 jina 后连正向用例都对不上。
   - 证据：`scripts/delivery-mode/packet-template/maintenance/verify-fixtures.mjs:32,73`、`scripts/delivery-mode/packet-template/systemd/verify-switch-config-fixtures.py:37,46-48`。
   - 建议：反向用例用一个既不是原值也不是目标值的维度（如 768），另加一条“目标 embedding 描述符被接受”的正向用例；抓包生成器传入目标值后，再验证“改一个字节的 artifact 哈希必须被拒绝”。

6. **`minimumSimilarity` 方案自相矛盾，并会打断 I-23 门槛**
   - 问题：第 1 节说“不写时取档案建议值”，第 2 节说“改为必填、删掉按 8B 模型名给默认阈值的分支”。两者不能同时成立。现有 I-23 测试依赖“qwen 无配置时默认 0.6”和“未知模型无门槛时抛 `MEMORY_MINIMUM_SIMILARITY_REQUIRED`”；改成必填后，`selectedEmbeddingConfiguration` 里没有门槛的配置会直接启动失败，`:605` 的 0.6 断言也失效。
   - 证据：方案第 1、2 节；`apps/agent-service/src/production-memory-composition.ts:92-96`；`apps/agent-service/test/production-model-composition.unit.test.ts:605,609-642`；`scripts/check-memory-relevance.mjs` 要求 3 条 `[I-23]` 测试通过。
   - 建议：选一种策略。我建议：档案自带经过评测校准的建议阈值，`memory.minimumSimilarity` 可覆盖但必须 >0；未知档案一律拒绝启动。同步更新 `selectedEmbeddingConfiguration` 和 I-23 反向用例，保持 3 条 `[I-23]` 全过。不要用“模型名 == qwen-8b”做默认分支。

7. **对话片段不会在启动时“几十秒内重算完”**
   - 问题：`service-main.ts:1183-1199` 只重排记忆，不重排 `memory_episodes`；`ProductionMemoryEpisodes` 每次 run 只调用一次 `backfillEmbeddings({limit:1})`，所以切换后片段向量每次聊天补一条，语义检索会长期处于旧模型/无向量状态。方案“backfillEmbeddings 补对话片段，新模型几百条记忆几十秒内重算完”的判断是错的。另一个已确认的 bug：`listUnembedded` 里的 `JOIN memory_episode_terms` 会漏掉没有词表条目的片段。
   - 证据：`apps/agent-service/src/production-memory-episodes.ts:78-88`、`packages/memory-engine/src/episodes.ts:268-285`、`packages/persistence-sqlite/src/sqlite-memory-operations.ts:1397-1401`。
   - 建议：服务启动后在后台批量补片段向量（有界队列、低优先级），或在 `himawari-admin memory reindex` 里同时清空并重算片段；修掉 terms join；加测试：切换后无需用户聊天即可完成片段重算。

8. **档案注册表放 `memory-engine`，`platform-node` 的 strict-config 无法引用**
   - 问题：方案把档案放 `packages/memory-engine/src/embedding-profiles.ts`，但 strict-configuration 在 `packages/platform-node`。`platform-node` 的依赖白名单里没有 `memory-engine`，`package.json` 也没有这个依赖。要校验“档案存在”，只能复制一份档案列表或违反边界规则。
   - 证据：`packages/platform-node/package.json:9-28`、`scripts/boundary-policy.mjs:67-77`、`packages/platform-node/src/strict-configuration.ts:1287-1320`。
   - 建议：把档案注册表放到两边都能依赖的叶子包，例如 `packages/application/src/embedding-profiles.ts`，或新建无依赖的 `@himawari-agent/embedding-catalog`；若新建包，同步更新 `boundary-policy.mjs`。`memory-engine` 只放运行时和 ONNX 适配器。

### 中

9. **`local-onnx` 会在现有组装层被 provider/secret/apiKey 三道校验挡住**
   - 问题：`production-memory-composition.ts:58` 只要 provider 不是 `vercel-ai-gateway` 就抛 `MEMORY_EMBEDDING_PROVIDER_UNSUPPORTED`；`:64-67` 要求必须有 secret 且 secret source 适合生产。`GatewayEmbedder` 的 `apiKey` 也是必填（`embedding.ts:141`）。方案写了 `secretRef: null`，但没有改这些校验。
   - 证据：`apps/agent-service/src/production-memory-composition.ts:58-67`、`packages/memory-engine/src/embedding.ts:135-159`。
   - 建议：按 provider 分支组装；local-onnx 允许 `secretRef: null`、不调用 `resolveConfiguredSecretRequirement`、`apiKey` 可选；补一条“local-onnx 配置能成功组装并只接受本地 fetch”的测试，以及“local-onnx 配了 secret / 非 zero cost 时拒绝”的反向测试。

10. **`Embedder.embed(text)` 没有查询/文档角色，jina 和 EmbeddingGemma 的前缀会拼错**
    - 问题：jina v5 官方要求查询 `Query: `、文档 `Document: `；EmbeddingGemma 2 官方要求查询 `task: search result | query: `、文档 `title: none | text: `。方案只列了 `task: search result | query: `，漏了 EmbeddingGemma 的文档前缀；而 `HybridMemoryProvider` 和 `MemoryEpisodeService` 对查询、文档都调用同一个 `embed(text)`，无法区分角色。若把前缀放到 embedder，会和现有的 `queryInstruction` 重复；若只放查询侧，文档侧又会缺前缀。
    - 证据：`packages/memory-engine/src/hybrid-memory-provider.ts:141-149`、`packages/memory-engine/src/episodes.ts:219-229,282-301`；Jina 模型卡“queries get a `Query:` prefix and documents get `Document:`”（https://huggingface.co/jinaai/jina-embeddings-v5-text-small-retrieval）；EmbeddingGemma 模型卡“Document-style prompts follow the form `title: {title | "none"} | text:`”（https://ai.google.dev/gemma/docs/embeddinggemma/model_card）。
    - 建议：把接口改成 `embedQuery(text)` / `embedDocument(text)`（或 `embed(text, {kind})`），档案负责精确字节；删掉 `HybridMemoryProvider`/`MemoryEpisodeService` 里独立的前缀拼接，避免双重前缀；给每个档案加正向测试，断言查询和文档送进模型的是两种不同前缀。

11. **本机仍然走出口遮盖，会带来密钥轮换后的向量失效和“本地却记成外发”的语义问题**
    - 问题：方案让本机请求继续经过 `egress.exchange(ctx).wrapFetch(fetch)`。遮盖占位符由 payload-encryption 密钥派生，密钥轮换后同一段文字会遮成不同字节；身份又不含密钥版本，旧向量会静默失效。反过来，本机数据没有离开设备，却会像外网一样记入 sensitive interceptions，容易在界面/审计上被理解成“发给了外部模型”。另外，遮盖后的自检若拒绝某段文字（例如无法遮盖的机器密钥），本机也无法为这条记忆生成向量。
    - 证据：`apps/agent-service/src/production-model-egress.ts:77-84`、`packages/application/src/services/model-egress.ts:220-249`、方案第 2 节原文。
    - 建议：本机 `local_only` 明确不做外发遮盖（或使用与密钥无关的稳定占位），并改掉“断言送进模型的是遮盖后的文本”的测试；如果坚持遮盖，必须把 ruleset/密钥版本纳入 `identity`，并在密钥轮换时触发重算。`SensitiveInterceptionSource` 应区分本地还是外发，避免把本地计算记成外发。

12. **模型文件哈希校验前后矛盾，且没有原子下载保证**
    - 问题：第 2 节说进程启动加载前先核对 SHA-256；第 3 节说服务启动只核对 manifest 和文件大小，全量哈希放预检。两者矛盾。若启动只查大小，同大小的损坏/替换文件会被加载；下载中断留下同大小临时文件也可能被当成模型。威胁模型说“不防本机入侵”可以降低风险，但供应链和磁盘损坏仍应防。
    - 证据：方案第 2、3 节原文；`packages/platform-node/src/strict-configuration.ts:128-134` 的 `absolutePath` 只做绝对路径和规范化检查。
    - 建议：下载先写临时文件，校验 SHA-256 后原子 rename；加载前至少校验哈希（可以放后台，校验完成前 readiness=false，绝不加载未校验文件）；预检仍保留全量校验。路径必须限定在 `stateRoot/models` 下，拒绝符号链接和 `..`。

13. **`verified-download.mjs` 不适合下载 571 MB / 2.7 GB 模型**
    - 问题：该脚本的单文件缓存上限是 512 MB（`cacheEntryMaxBytes`），571 MB 的 int8 模型不会被缓存；2.7 GB 的 fp32 更不可能。`downloadVerified` 还会把整个响应读进 `arrayBuffer()`（2.7 GB 全在内存），单次请求 120 秒超时。方案说“同类做法”，如果直接复用会 OOM 或超时。
    - 证据：`scripts/ci/verified-download.mjs:19,158-177`。
    - 建议：新写流式下载器：边下边算 SHA-256、支持断点/重试、限制内存、按文件大小设置超时和磁盘预检。更好的做法是在 CI 生成一次 int8 产物作为发布资产，生产只下载 immutable 资产，不在生产机跑量化。

14. **新增 prompt-catalog 条目会打断 `check:prompt-catalog`，并可能改变 `TRUSTED_PROMPT_TEXTS`**
    - 问题：新增前缀条目必须同步更新 `packages/prompt-catalog/prompt-manifest.json`（每个条目要 sha256、changedIn、reason），否则 `check:prompt-catalog` 直接失败。另一个容易漏的点：`TRUSTED_PROMPT_TEXTS` 会收集所有目录条目中长度 >=24 的文本；新增长前缀会扩大“不遮盖”的固定文字集合。今天这些前缀不含敏感模式，但方案“遮盖规则不碰固定文字”的说法只对 >=24 字符的目录条目成立，`Query: `/`Document: ` 这种短前缀仍会被遮盖引擎处理。
    - 证据：`apps/agent-service/test/prompt-catalog.unit.test.ts:175-195,299-318`、`packages/prompt-catalog/src/entry.ts:59-70`、`packages/application/src/services/model-egress.ts:220-249`。
    - 建议：更新 manifest；加一条测试确认新增条目不会改变已有对话里遮盖结果；固定前缀尽量用不会命中敏感规则的字节，并在档案里把前缀作为精确常量测试。

15. **大量现有测试/配置写死了 qwen 8B / 4096**
    - 问题：方案只写了新增测试，没有列出现有硬编码的更新点。`test/fixtures/product-path-configuration.ts:124-143`、`production-model-composition.unit.test.ts:497,875,969,1068,1551`、`memory-retrieval-eval/live.test.ts:160-172` 都写死 `alibaba/qwen3-embedding-8b` / 4096。切换默认档案后这些测试会失败；`check:product-path-configuration`、`check:model-ref-contract` 也可能受影响。
    - 证据：上述文件行；`package.json:57,59` 的检查项。
    - 建议：建立单一档案来源，测试从档案取 id/dimensions/前缀；逐项更新 fixture 和评测，不要在多处复制模型字符串。

16. **主动邮件记忆的阈值没有跟着换模型**
    - 问题：方案只改 `memory.minimumSimilarity`，但 Gmail 主动检查用的是 `runPolicy.proactive.memoryMinimumSimilarity`，默认 0.45（`strict-configuration.ts:1054-1057`），生产在 `service-main.ts:1623` 使用。不同模型的相似度分布不同，换 jina 后 0.45 可能不再合适，会带出无关记忆或漏掉相关记忆。
    - 证据：`packages/platform-node/src/strict-configuration.ts:1054-1057`、`apps/agent-service/src/service-main.ts:1623`。
    - 建议：在档案里同时给 `proactiveMinimumSimilarity`（或用同一阈值），用记忆评测集按邮件场景校准；加一条主动检查的检索评测/反向测试。

17. **评测脚本本身写死网关和 qwen，`--embedder` 不能只加参数**
    - 问题：`live.mjs` 在解析参数后无条件向 `alibaba/qwen3-embedding-8b` 发预检请求，并要求 `--confirm-cost`；本机档案不应走这一步。`live.test.ts` 的 `production` 标志基于 `minimumSimilarity === QWEN3_MEMORY_MINIMUM_SIMILARITY`，历史基线比较也默认同一个模型；切换后会把不同模型的成绩当基线比较。
    - 证据：`scripts/memory-retrieval-eval/live.mjs:39-52,99-104`、`test/integration/memory-retrieval-eval/live.test.ts:160-172,262`。
    - 建议：按档案分支：本机跳过网关预检和费用确认，外网保留；`round.json`/`history.jsonl` 记录 `identity`、`profileId`、阈值和运行方式；基线只和同 `identity` 的记录比较；加测试“本机模式一次网关请求都不发”。

18. **严格配置校验还不够，不能只校验“档案存在、维度一致、路径在状态目录下”**
    - 问题：`rejectUnknown` 需要放行 `artifact`；`artifact` 是绝对路径，但“在状态目录下”还要限制在 `stateRoot/models`、拒绝符号链接、校验 sha256/bytes 与锁文件一致。`local-onnx` 还应强制 `disclosure === "local_only"`、`secretRef === null`、`cost` 全 0、`provider` 与档案 runtime 一致；external 档案不应带 `artifact`。否则配置可以把本地模型标成远程，或指向状态目录里的其他文件。
    - 证据：`packages/platform-node/src/strict-configuration.ts:271-344`（`rejectUnknown` 和 embedding 分支）、`:128-134`（路径）、`:337-344`（当前只对 vercel 做特殊校验）。
    - 建议：加上述校验和反向测试：路径在 `stateRoot` 但不在 `models/`、符号链接、sha 不匹配、bytes 不匹配、local 配了 secret、local cost 非 0，都必须拒绝启动。

19. **本地推理队列没有上限、没有优先级、没有取消传播**
    - 问题：方案只说“并发请求排队（一次一句）”。切换后启动补索引会排入大量投影；如果和用户对话同时发生，单队列会让前台找记忆排在后台重算后面，3 秒超时后失败，用户连续几轮只能用关键词。被超时/取消的请求如果仍在队列里，ONNX 还会继续白算，造成 CPU 浪费。
    - 证据：方案第 2、4 节；`production-run-memory.ts:305-318` 的 3 秒首试重试；现有 `HybridMemoryProvider.search` 失败会回退（`hybrid-memory-provider.ts:139-153`）。
    - 建议：有界队列；前台查询优先、后台补索引低优先级并限流；把 `AbortSignal` 传到队列项，开始前检查是否已取消；队列满时立即回退关键词而不是无限排队；加压力测试。

20. **admin reindex 清除片段向量需要同时改计数、输出和测试**
    - 问题：方案说 `himawari-admin memory reindex` 补上清对话片段向量，但 `planMemoryReindex` 只统计 `memory_search_index`，`restoreIdleArchivesAndClearMemoryIndex` 只删 `memory_search_index`，CLI 输出只有 `clearedIndexRows`；现有 `memory-reindex-cli.unit.test.ts` 也只断言记忆索引。
    - 证据：`packages/persistence-sqlite/src/sqlite-memory-maintenance.ts:30-48,74-76`、`apps/admin-cli/src/memory-command.ts:55-77`、`apps/admin-cli/test/memory-reindex-cli.unit.test.ts`。
    - 建议：在同一事务里清空 `memory_episodes` 的 `embedding_model/embedding_dimensions/embedding`，增加片段计数和输出字段，更新测试；如果启动后台补片段已经可靠，也可以不做这条命令，但方案里要选一个并写明。

### 低

21. **`check-egress-redaction.mjs` 的登记方式写错了**
    - 问题：方案说“允许文件和必须调用清单加入新文件”。`LocalOnnxEmbeddingServer` 如果包含 `local://.../embeddings` 字符串，会命中 `EGRESS_PATTERNS` 的 “embeddings request”，需要加到 `ALLOWED_EGRESS_FILES`；但它本身不调用 `exchange.wrapFetch`，加到 `REQUIRED_REDACTION_CALLS` 会要求一个不存在的调用，检查直接失败。
    - 证据：`scripts/check-egress-redaction.mjs:8-16,61-70,169-173`。
    - 建议：只把它登记为允许的非出口文件，并在注释里说明“本地函数，不联网”；真正的 `wrapFetch` 仍由 `embedding.ts` 满足。或者把 `local://` URL 字面量放在 embedder 里。

22. **重命名 `GatewayEmbedder` 会留下文档和测试引用**
    - 问题：`docs/adr/0146...:40`、`docs/engineering-casebook.md:2792` 和多个测试引用 `GatewayEmbedder`。方案没提文档/测试更新，改名后会出现陈旧引用。
    - 建议：保留 `export { OpenAiCompatibleEmbedder as GatewayEmbedder }` 兼容别名，或一次性更新所有引用并在 ADR 里记一笔。

23. **线程数、精确前缀、许可证等小问题**
    - `intraOpNumThreads = CPU/2` 在单核机器上会是 0；用 `Math.max(1, Math.floor(cpus/2))`，并考虑 `interOpNumThreads=1`。
    - jina v5 small retrieval 是 677M、1024 维、last-token pooling、CC BY-NC 4.0；EmbeddingGemma 2 文本模型是 768 维、query `task: search result | query: `、document `title: none | text: `。方案只写了部分前缀，且没说 EmbeddingGemma 的许可证（Gemma Terms）。这些要写进档案和 ADR。
    - 证据：Jina 模型卡 https://huggingface.co/jinaai/jina-embeddings-v5-text-small-retrieval ；Google 模型卡 https://ai.google.dev/gemma/docs/embeddinggemma/model_card 。

## 推测 / 未核实

1. **`@huggingface/transformers` 4.3.1 能否直接跑 jina v5 small retrieval 的 ONNX 未核实。** Jina 模型卡的 ONNX 示例用的是 Optimum `ORTModelForFeatureExtraction` + `trust_remote_code=True`，不是 transformers.js；transformers.js 4.3.1 的发布说明主要提 EmbeddingGemma 2。建议先做一个 spike：在 Node 22 + 固定 `onnxruntime-node` 下加载该 ONNX，验证 last-token pooling、1024 维和查询/文档前缀；跑不通就改用 `onnxruntime-node` 直接加载 + 自己 tokenizer/pooling，或单独的 text-embeddings-inference sidecar。
2. **生产机冷加载时间、内存占用未核实。** backlog 的 20 秒/1.4 GB 是 4 核云端、transformers 3.7.5 的数据；生产机磁盘更慢，jina 677M 也比 Qwen3-0.6B 大。必须在上线机同款磁盘上实测。
3. **发布包体积增加量未核实。** `@huggingface/transformers` 依赖 `onnxruntime-node`、`onnxruntime-web`、`sharp` 等；50–80 MB 可能低估。建议打包后跑一次 clean linux-x64 加载模型冒烟测试，确认原生库和动态 import 都在。
4. **导出是否包含向量未完全核实。** 备份已核实是 SQLite 快照后再加密，模型目录不在备份；数据导出走表数据（`packages/persistence-sqlite/src/data-export/`），我未逐项核对它是否包含 `memory_search_index`/`memory_episodes` 的向量。方案里“核对”要变成一条自动检查。
5. **`plan.md` 里的“已核对事实”和“0.725 命中率”来源未核实。** 仓库里没有 plan.md，历史评测 `evals/memory-retrieval/history.jsonl` 里只有 0.8@0.6 的记录，0.725 需要说明出处。

## 侧重检查

- **错误路径**：本机模型加载失败/文件缺失/哈希不符时，`HybridMemoryProvider.search` 会回退关键词（`hybrid-memory-provider.ts:139-153`）；`upsert` 会先写 null 向量再抛错（`:104-111`），投影 job 会重试。方案需要保证启动不被加载阻塞、队列不积压、失败可见。`production-run-memory.ts:305-318` 的 3 秒首试超时对本地推理仍会触发，模型加载期间会连续失败，建议本地不要复用网络超时或把加载与推理分开。
- **不可信输入**：`artifact.path`、`sha256`、`bytes`、`model`/档案 id、查询/文档前缀、tokenizer/config 文件、本地 fetch 的 URL/method/body、base64 向量长度和浮点值都要校验。方案只写了“档案存在、维度一致、路径在状态目录下”，不够；补路径逃逸/符号链接、sha/bytes 与锁文件一致、请求体字段白名单、维度/NaN 检查。
- **安全**：本机 `local_only` 不应把本地计算记成外发遮盖；若坚持走 egress，必须把遮盖密钥版本纳入身份并在轮换时重算。模型文件哈希预检和启动校验要一致，下载要原子化；威胁模型里“防备份/导出泄露”需要一条自动检查，不能只写在文档里。
- **资源耗尽**：最大风险是 fp32 2.7 GB 全量读入内存、512 MB 下载缓存上限、571 MB 模型冷加载、启动补索引 + 前台对话抢单队列、CPU 线程。建议流式下载、预置 int8 资产、后台加载、有界队列、前台优先、后台限流。
- **不可撤销操作**：向量被覆盖后，回退旧模型要重算一次；外部模型重算要花钱。`memory reindex` 会清空索引（已有 backup + confirm）。建议要么接受并写清回退成本，要么改成按身份并存的版本化向量表（`memory_id + identity` 唯一），切换只切读路径，回退不需要重算。
- **规则/文档/代码一致**：`prompt-prefix.md` 第 4 条“只追加”在方案里没有直接冲突（嵌入是旁路，记忆结果在最后一条消息），但新增 prompt-catalog 条目会影响 `TRUSTED_PROMPT_TEXTS`，需要测试；`BL-20261028-008` 明确要求“开工前先用记忆评测集对比模型，差距明显就不换，交给 Andy”，方案没有写这一步；`docs/adr/0119:71` 和 backlog 都记的是约 1.4 GB，方案的 +1.1 GB 需要实测更新；`GatewayEmbedder` 改名后 `docs/adr/0146`、`docs/engineering-casebook.md:2792` 会过期。

## 如果由我来定，我会怎样改

1. **先做 spike 和模型对比，不直接动工。** 在真实记忆评测集上跑 jina v5 small retrieval、Qwen3-Embedding-0.6B、当前 Qwen3-Embedding-8B，记录命中/无关带出/首句延迟/冷加载/内存；把结果和许可证选择交给 Andy。跑不通 ONNX 或差距明显，就停。依据是 `docs/backlog/BL-20261028-008-local-memory-embedding.md:35-36`。
2. **先定“嵌入契约”，再写代码。** 一个共享叶子包里的档案包含：id、runtime、wireModel、dimensions、pooling、normalize、queryPrefix、documentPrefix、artifact、minimumSimilarity（含评测依据）、proactiveMinimumSimilarity、formatVersion。`identity = profileId@artifactSha12@formatSha12`，只用于索引；`wireModel` 用于请求/响应/准入。
3. **改 Embedder 接口为查询/文档两个入口。** `embedQuery`/`embedDocument`，档案负责精确前缀；删掉 `HybridMemoryProvider`/`MemoryEpisodeService` 里各自的前缀逻辑，避免双重前缀。
4. **本机推理独立、后台加载、队列可控。** 不在启动路径加载模型；加载完成前 health 标记降级；有界队列、前台优先、后台限流、AbortSignal 传播；本地不经过外发遮盖（或使用与密钥无关的稳定变换），并相应调整测试。
5. **切换做成可回退的版本化向量。** 最好把向量表改成 `(memory_id, identity)` 复合键/独立表，切换只改读路径，回退不用重算；如果不想做迁移，就在 ADR 里明确回退要重算一次并测出成本。
6. **部署链路一起改。** `make-packet.py` 的 `configTargets`、`andy-production.json`、`S7-switch-start-readback.py`、`maintenance-common.mjs`、两个 fixture 都要支持嵌入目标；反向用例用第三维度值；preflight 校验 artifact 路径/sha/bytes/磁盘；下载器流式、原子、可恢复。
7. **把所有现有门槛更新和新增反向用例列成清单。** `check:prompt-catalog` manifest、`check:boundaries`、`check:egress-redaction`、`check:memory-relevance`、`check:product-path-configuration`、`check:model-ref-contract`、`check:delivery-*`、评测脚本，全部在开工前列出。
8. **文档写清。** ADR 记录模型对比、许可证、嵌入契约、身份、后台加载、回退成本、阈值校准；威胁模型记录本地遮盖/密钥轮换/备份导出；关闭 backlog 前把证据补全。

## 必答问题

1. **会不会改变模型已经见过的请求开头？**
   - 直接不会。嵌入是旁路调用，不进入系统提示、工具定义或聊天历史；记忆检索结果和阈值变化只会改变最后一条用户消息里的记忆选择，符合“只追加、每轮会变的值在最后一条消息”。我核对了 `public-search-authorization.ts:60-67`、`workspace-auto-authorization.ts:101-109`、`production-file-read-services.ts:197-200`、`production-sandbox-services.ts:176-182` 都过滤掉了 `role === "embedding"`，所以换嵌入描述符不会让 Web 搜索/工作区授权失效；`production-run-policy.ts:147-148` 的 prompt bundle identity 用的是主模型 ref，换嵌入也不会重建冻结的系统提示。
   - 间接风险有一个：新增 prompt-catalog 条目会改变 `TRUSTED_PROMPT_TEXTS`，理论上可能改变旧历史里同文字串的遮盖结果。新增条目是嵌入前缀，命中概率低，但方案应加一条测试确认“新增目录条目前后，已有对话的遮盖字节不变”。
   - 结论：只要不改共享的遮盖规则/固定文字集合，请求头只在末尾追加；需要补一条“对话中途切换嵌入档案，下一轮请求仍以上一轮请求为前缀”的自动测试。

2. **会不会让同一段文字在不同请求里变成不同的字节？**
   - 会，方案目前没有完全解决。风险点：
     - 遮盖占位符由 payload-encryption 密钥派生（`production-model-egress.ts:77-84`），密钥轮换后同一段文字遮成不同字节；`identity` 不含密钥版本，旧向量不会重算。
     - `identity` 不含查询/文档前缀、pooling、归一化、规则集版本；改前缀或规则集不会触发重算（方案却声称会）。
     - ONNX Runtime 的浮点结果可能随 CPU 内核、`intraOpNumThreads`、运行时版本变化；身份不含运行时/线程配置，跨机器恢复数据库时向量可能对不上。
     - 批量发送会让 `ModelEgress` 的 `#known` 在条目之间传递，后一条的遮法依赖前一条；方案“每次只送一句”能避免这一点，但真正的风险是密钥轮换和身份不完整。
   - 建议：把查询/文档前缀、pooling、normalize、dimensions、artifact、量化/运行时版本、遮盖规则/密钥版本全部纳入身份；或者本地 `local_only` 不做密钥相关遮盖；固定线程数并在 ADR 里说明“向量是本机/本运行时局部的，迁移数据库必须重算”。

3. **有没有对应的自动检查，反向用例真的会失败吗？**
   - 方案新增的单元/集成测试方向是对的，但现有门槛会先被打破：`check:prompt-catalog`（manifest 缺新条目）、`check:boundaries`（档案放 memory-engine 但 platform-node 要引用）、`check:memory-relevance`（I-23 的 0.6 断言和无门槛反向用例）、`check:product-path-configuration`/`check:model-ref-contract`（写死 qwen/4096）、`check:egress-redaction`（新文件的登记方式）、`check:delivery-*`（S7/maintenance/fixtures）。
   - 反向用例有一个**确定会变成假阴性**：`verify-fixtures.mjs:73` 把维度改成 1024，而 1024 正是新目标维度，改完不会再被拒绝。必须换成第三值（如 768），并另加“目标值被接受”的正向用例。
   - 需要补的反向用例：同档案只改 artifact 哈希（维度不变）必须重算且不被预算层拒绝；只改前缀必须重算；遮盖密钥轮换必须重算或明确本地不遮盖；模型文件缺失/哈希不符时服务仍能启动并回退关键词；启动不被模型加载阻塞；本机评测模式一次网关请求都不发；打包后的 release 在干净 linux-x64 上能加载原生库和模型。

4. **每个值的使用端都能接受吗？**
   - 不能，方案目前只说了“统一用 identity”，没有逐个核对两端：
     - `identity`：产生于档案/embedder，使用于 `MemoryIndexEmbedding.model`、`embedding_model` 列、`listUnindexed`/`listUnembedded`、`search` 过滤、`episodes.attachEmbedding`、`service-main` 启动补索引、admin CLI、评测。写入端 `sqlite-memory-operations.ts:983` 只要求非空，能接受；但 `production-run-memory.ts:133` 的请求模型校验、`:151` 的幂等键、`sqlite-model-budget-operations.ts:454-469` 的旧分配、`production-model-composition.ts:58-67` 的 provider/secret、`embedding.ts:141` 的 apiKey 都需要一起改。只改存储不改这些，会出现“配置能启动但重算被拒”或“根本组装不起来”。
     - `provider: "local-onnx"`：`parseModel` 目前对 embedding 不限制 provider，但 `production-memory-composition.ts:58` 会抛 `MEMORY_EMBEDDING_PROVIDER_UNSUPPORTED`；`embeddingAdmissionDescriptor` 会把 provider 传给准入，需要确认准入允许本地 provider。
     - `secretRef: null`：`production-memory-composition.ts:64-67` 目前要求必须有 secret；local 必须走分支。
     - `artifact.path/sha256/bytes`：strict-config 要放行 `artifact`，`deploy-preflight.py`、`S7`、`maintenance-common.mjs`、loader 都要能读；路径要限制在 `stateRoot/models` 且拒绝符号链接；`bytes` 要与锁文件和实际文件一致。
     - `memory.minimumSimilarity`：`strict-configuration.ts:1293-1298` 目前可选；`production-memory-composition.ts:92-96` 有 8B 默认分支；`HybridMemoryProvider` 默认 0；`service-main.ts:1623` 的主动检查用另一个阈值。四处要统一。
     - `prompt-catalog` 条目：`prompt-manifest.json`、`TRUSTED_PROMPT_TEXTS`、`prompt-catalog.unit.test.ts` 都要接受新条目。
     - 部署清单：`configTargets`、`andy-production.json`、`make-packet.py` 的模板变量、`S7`/`maintenance` 的 approved 变更模型、两个 fixture 都要接受嵌入目标值。
   - 结论：方案需要补一张“值 → 产生处 → 所有使用处 → 两端校验”的清单，并逐项加测试；只看新文件或只看改动本身不够，这正是 I-73 的教训。
