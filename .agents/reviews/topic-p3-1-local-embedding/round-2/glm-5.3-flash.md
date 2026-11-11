# 审核结论：P3-1 记忆向量本机化方案

## 侧重检查（先看我走过的流程）

普通流程「主人发一条消息 → 带记忆回答」：

1. **读**：对话轮内 `MemoryPort.search` → `production-run-memory.ts` 的 `embedOnce`（准入、预算预留、3 秒超时重试，production-run-memory.ts:29、305-318，方案引用属实）→ `GatewayEmbedder.embed`（embedding.ts:168-185，先拼 `instructedQuery` 再发）→ `egress.exchange(ctx).wrapFetch`（embedding.ts:193-194）→ `model-egress.ts` 的 `redactEmbeddings` 对 `embedding_input` 遮盖（model-egress.ts:493-502）→ 检索结果进最后一条用户消息。
2. **写**：记忆捕获 → 投影 job → `HybridMemoryProvider`（hybrid-memory-provider.ts:102 `embedder.embed(input.content)`，**文档侧无前缀**）→ 写 `memory_search_index`（sqlite-memory-operations.ts:1005）。
3. **启动**：`service-main.ts:1183-1199` 按模型/维度重排不一致记忆（方案引用属实）；对话片段走 `backfillEmbeddings` → `listUnembedded`（sqlite-memory-operations.ts:1397-1398 确有 `JOIN memory_episode_terms`，方案指出的漏补问题属实）。
4. **维护**：`himawari-admin memory reindex` → `restoreIdleArchivesAndClearMemoryIndex` 只 `DELETE FROM memory_search_index`（sqlite-memory-maintenance.ts:74-76，方案属实）。

**无测试覆盖的路径**：`check:prompt-prefix` 只测主对话，不碰嵌入路径；`check:egress-redaction` 只查调用形状；`hybrid-memory-provider.unit.test.ts` 全用假 embedder；真实评测要走外网。本机化后新出现且方案未列覆盖的：本机 fetch 返回非 2xx 时 `gatewayErrorDetails` 的解析（embedding.ts:231-242）、并发排队、`usage` 本机分支在 mail 路径（production-run-memory.ts:197-215）下的结算。

## 证实的问题（按严重度）

**高 H1｜identity 不含前缀/指令哈希，§4 的声明自相矛盾。**
§4 说 identity = `<档案 id>@<模型文件 sha256 前 12 位>`，“同名模型换量化文件**或前缀**时也会触发重算”。但改前缀不改变模型文件哈希。而重算的触发点只比较 `embedding_model`/`embedding_dimensions`（sqlite-memory-operations.ts:1400-1401、1485-1486）。prompt-catalog 里该条目的 purpose 自己写着「改它会让已存的向量和新查询对不上」（packages/prompt-catalog/src/memory.ts:38）——改指令后，新查询用新指令编码、旧向量是旧指令编码，静默失配且永不重算。**建议**：identity 加入“查询指令 + 文档前缀文本”的哈希，例如 `<档案id>@<模型sha前12>@<前缀sha前8>`。

**高 H2｜§1 与 §2 对 `minimumSimilarity` 直接矛盾。**
§1：「`memory.minimumSimilarity` 不写时取档案建议值」；§2：「改为必填，删掉按 8B 模型名给默认阈值的分支」。两处只能取一个。另注意：`HybridMemoryProvider` 内部还有 `minimumSimilarity ?? 0` 的第三层默认（hybrid-memory-provider.ts:51、163），以及 proactive 路径引用 `proactiveConfiguration.memoryMinimumSimilarity`（service-main.ts:1623）也要一起核对。

**高 H3｜两端校验没核对完——正是 I-73 的教训。**
- 组装处现在**硬拒**非 `vercel-ai-gateway` 的 provider、`secretRef` 解析为 null 即抛错（production-memory-composition.ts:58-65）。方案没有列这两处分支要改。
- `OpenAiCompatibleEmbedder` 无条件发 `authorization: Bearer ${await this.#options.apiKey()}`（embedding.ts:199），本机时 apiKey 从哪来没写。
- descriptor 的 `version` 和 `cost` 是必填字段（strict-configuration.ts:318-320、329 `modelCost`），方案没写 local 档案这两项的取值。
- 缺一道 I-73 式的门：档案清单生成的每个 id 应当被 `parseProductConfiguration`（strict-configuration）正向接受、被旧 provider 校验拒绝，并核对档案引用的目录条目确实存在。方案只有分散的单测，没有这道双向一致性门。**建议**：仿照 `npm run check:model-ref-contract`（apps/agent-service/test/model-ref-contract.unit.test.ts，见 docs/incidents-and-gates.md I-73 行）加 `check:embedding-profiles`。

**中 M1｜fp32 ONNX 大小 571 MB 是错的，自量化方案低估了难度。**
官方仓库 `jinaai/jina-embeddings-v5-text-small-retrieval` 权重 596M 参数 BF16（HF API：`"safetensors":{"parameters":{"BF16":596049920}}`，https://huggingface.co/api/models/jinaai/jina-embeddings-v5-text-small-retrieval ），fp32 ONNX（`onnx/model.onnx` + `onnx/model.onnx_data`）约 2.3–2.4 GB，不是 571 MB。下载、磁盘、预检时间都要按 2.4 GB 估。官方仓库**没有** int8 ONNX；社区量化版（cstr/jina-embeddings-v5-text-small-retrieval-onnx-int8，https://huggingface.co/cstr/jina-embeddings-v5-text-small-retrieval-onnx-int8 ）原话：“vanilla `quantize_dynamic` collapses on the same probe”，要 SmoothQuant α=0.8 图改写才可用。**建议**：直接把方案里的备选升为主案——量化一次、int8 产物作为发布材料上传、锁文件记哈希；自量化只作可选项。

**中 M2｜文档侧前缀的落点没列全，改不全就会静默失配。**
现在文档侧（记忆正文、对话片段）都不带前缀直接 embed（hybrid-memory-provider.ts:102；episodes.ts:301 是 `${episode.day}\n${text}`）；查询侧 `instructedQuery` 把 Qwen 格式硬编码成 `Instruct: …\nQuery:`（embedding.ts:27-28），被 hybrid-memory-provider.ts:147 和 episodes.ts:229 两处引用。档案化必须同时改这三个调用点，方案只写了“前缀登记进 prompt-catalog、档案引用目录条目”。片段的 `${day}\n${text}` 是否保留 day 前缀也要在档案里写死，否则切模型时格式漂移。

**中 M3｜`check-egress-redaction.mjs` 的清单加法有一处不对。**
方案说「允许文件**和必须调用清单**加入新文件」。必须调用清单（`REQUIRED_REDACTION_CALLS`，scripts/check-egress-redaction.mjs:8-16）要求文件里出现 `exchange.wrapFetch(`——`LocalOnnxEmbeddingServer` 是被注入的 fetch 实现，它不该也不含 `wrapFetch`；它只能进 `ALLOWED_EGRESS_FILES`（其 URL 字面量含 `/embeddings`）。改名后的 `OpenAiCompatibleEmbedder` 仍在 embedding.ts（须调用清单不变）。

## 推测的问题

**推 1｜"每次只送一句避免批次遮盖不一致”的理由不成立（结论无害）。**
遮盖状态是每次请求新建的（model-egress.ts:201 `sightings = new Map`、#known/#table 属于单个 exchange），跨请求没有“前面见过的值后面也遮”；而且现有代码本来就是单句（embedding.ts:177 `input` 是 string，model-egress.ts:495 只处理字符串或数组）。批量问题在当前代码里不存在，这条可以删掉，避免误导后来人以为曾有过批量路径。

**推 2｜短前缀不进受信文字清单。**
prompt-catalog 只收 ≥24 字符的固定文字为受信文本（packages/prompt-catalog/src/entry.ts:59 `TRUSTED_TEXT_MINIMUM_LENGTH = 24`），"Query: "（7 字）、"Document: "（10 字）会按外来内容过遮盖。对这些固定字面量无实际影响，但方案引用规则第 53 条（"遮盖规则不碰固定文字"）时应写明这条例外。

**推 3｜启动只核对文件大小不核对哈希，崩溃重启会绕过预检。**
服务器在两次部署之间若因崩溃重启，直接以未验证的 1 GB 文件起服务。1 GB 全量 SHA-256 在启动时约 2–4 秒，不算“拖慢启动”；建议启动也校验，或至少写进威胁模型。

**推 4｜回退外网 8B 时自动重算不会触发。**
外网 identity 保持 model 原值（§4），回退后此前 8B 时代的旧行（若未被覆盖）会原样匹配，`listUnindexed` 找不到差异；本机时代的行会被重排，但方案该写明“重算一次”由谁执行（admin reindex？启动补索引？），只有 ADR 一句话不够。

**推 5｜`memory.dimensions` 需同步改。**
组装处校验 `embedding.dimensions !== configuration.memory.dimensions` 即抛（production-memory-composition.ts:62-63），切换 1024 维档案时配置里 `memory.dimensions` 也要一起改，方案提了"dimensions"但没指明是这一处；`test/fixtures/product-path-configuration.ts` 的验收配置也要跟着过 `parseProductConfiguration`。

**未核实**：评测下限命中率 0.725 的出处；备份/导出是否携带索引（方案自己也标了“要核对”）；`@huggingface/transformers` 4.3.1 对 last-token pooling 的支持程度（4.3.1 确实存在，2026-10-06 发布，依赖 onnxruntime-node 1.30.0，https://github.com/huggingface/transformers.js/releases —— jina v5 small-retrieval 的官方 ONNX 只输出 `last_hidden_state`，需自行池化，HF 官方讨论确认：https://huggingface.co/jinaai/jina-embeddings-v5-text-small/discussions/12 ）。

## 如果由我来定这份方案

1. §1 保留，但 identity 改为三段式（模型哈希 + 前缀哈希），并在 §5 加反向用例：只改目录里的指令文字，重建必须触发。
2. §1/§2 统一为「`minimumSimilarity` 必填」，同时核对 proactive 路径和 provider 内部 `?? 0` 默认。
3. §2 补齐：composition 的 provider/secret 分支、apiKey 处理（本机传恒定占位符并断言本机 fetch 忽略 header）、descriptor 的 `version`/`cost` 取值；新增 `check:embedding-profiles` 双端一致性门。
4. §3 主案改为「int8 产物一次量化、作为发布材料分发、锁文件记哈希」；尺寸按 fp32 2.4 GB 重估。
5. §4 明确文档侧三处调用点和 day 前缀；明确回退 8B 的重算执行者。
6. §5 增加两条：真实模型“同文本两次嵌入逐字节相同”；本机 fetch 非 2xx 错误解析。
7. §2 删除“每次只送一句”的遮盖理由；脚本清单只加允许文件。

## 必答问题逐条

1. **不会改变模型已见过的请求开头。**改动只影响嵌入这条后台单句请求：无历史、无系统提示，请求体单条 `input`，每轮唯一可变值（被嵌入文本）就是请求主体本身；前缀拼接发生在出口遮盖之前，与现状一致（embedding.ts:180 → 193-194）。主对话请求组装完全不变，检索结果仍按规则放最后一条用户消息。满足 append-only 规则。
2. **基本不会，两个例外。**输入构造（档案前缀 + 文本）、JSON 键序（固定字面量，production-run-memory.ts:151 的 operationKey）、identity、prompt_tokens 均确定；遮盖在密钥不变时确定（规则第 11 条）。例外：int8 量化产物跨机器字节不一致（方案已知，建议改为分发固定产物）；ONNX 同文本跨次运行的逐字节确定性无一手来源背书，建议落成自动断言。无时间字段、无依赖前后文的遮盖进入嵌入输入（单请求单句）。
3. **有，反向用例设计上会失败**（配置正反例、哈希不符拒载、fetch 只接受 /embeddings、遮盖后文本断言）。缺口：档案 id↔配置↔目录条目的一致性门（I-73 教训）、同文本确定性断言、`check:real-admission` 对新入口文件的登记未提。
4. **逐值：`identity`**——写入/查询/启动重排/补索引/评测各点（sqlite-memory-operations.ts:1114、1329、1400、1485，service-main.ts:1187-1197）都是 TEXT 比较，可接受，但不含前缀哈希是漏洞（H1）；**`provider:"local-onnx"`/`disclosure:"local_only"`**——枚举已含 local_only（packages/application/src/ports/configuration.ts:26），provider 是自由 `safeReference`（strict-configuration.ts:96，连字符允许），但 composition 端未列改动（H3）；**`artifact`**——需进 strict-configuration 字段白名单 + 预检 + 启动 + 锁文件 + `test/fixtures/product-path-configuration.ts`，方案覆盖前三者；**`cost=0`/`estimatedCostMicros=0`**——`safeInteger(…, minimum=0)`（sqlite-model-budget-operations.ts:125）接受 0，settle 要求非负数也满足；**`version`/`cost` 必填**——方案漏写取值（H3）。
