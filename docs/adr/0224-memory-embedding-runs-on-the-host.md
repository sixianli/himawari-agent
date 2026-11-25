---
status: active
document_type: adr
decision_status: accepted
supersedes: ""
superseded_by: ""
date: "2026-11-11"
covers: ".agents/instructions/prompt-prefix.md, apps/admin-cli/test/memory-reindex-cli.unit.test.ts, apps/agent-service/src/production-memory-composition.ts, apps/agent-service/test/local-embedding-composition.unit.test.ts, apps/agent-service/test/production-model-composition.unit.test.ts, packages/application/src/embedding-profiles.ts, packages/memory-engine/src/embedding.ts, packages/memory-engine/test/episode-backfill.unit.test.ts, packages/persistence-sqlite/src/data-export/snapshot.ts, packages/persistence-sqlite/src/migrations/0052_memory_engine.sql, packages/persistence-sqlite/src/sqlite-recovery-point.ts, packages/platform-node/test/local-onnx-embedding.unit.test.ts, packages/platform-node/test/startup-configuration.unit.test.ts, scripts/delivery-mode/test_make_packet.py, scripts/embedding-models/build-artifact.py, scripts/embedding-models/make-test-fixture.py, test/tooling/artifact.test.mjs"
verified_at: "1f73e976913bbac15088d045988be291fd60d8dd"
---

# ADR 0224：记忆向量改在本机算，外网服务保留为可选

<a id="contents"></a>

## 阅读导航

- [背景](#context)
- [前提](#premises)
- [决定](#decision)
- [放弃的做法](#options)
- [后果](#consequences)
- [验证](#verification)
- [参考](#links)

<a id="context"></a>

## 背景

按意思找记忆，要先把文字变成一串数字（向量，这一步叫嵌入，embedding），再比较两串数字有多接近。到这次为止，嵌入一律经 Vercel AI Gateway（Vercel 的模型网关）发给外网的 Qwen3-Embedding-8B：每次找记忆都要把主人的问题、每条记忆的正文发到第三方，一次往返约 0.8 到 1.4 秒（[BL-20261028-008](https://github.com/sixianli/himawari-agent/blob/34de855ff109a53391cfc0d59706bcf44ba7f4a5/docs/archive/backlog/BL-20261028-008-local-memory-embedding.md)），断网或额度用完时只能退回关键词（[ADR 0223](0223-chat-memory-lookup-falls-back-to-keywords.md)）。

产品愿景要求“自有优先、数据自持”。Andy 在实施清单 P3-1 里要求：先交候选报告，他选定后用本机模型替换外网服务、重建索引；外网服务保留为可选；嵌入请求照旧走统一出口（Himawari 所有发给模型的请求都经过的那一层，负责遮盖敏感信息和记账）；不动检索结构（向量、关键词、实体三路加融合排名）；写明检索索引的威胁模型。

候选报告（2026-11-11，[Claude Doc](https://claude.ai/artifact/NyEzaCHor3J2ygNV3gtt8E)）比较了三个能在生产机 CPU 上跑的模型。Andy 选了 jina-embeddings-v5-text-small-retrieval 的 int8 量化版，聊天找记忆的门槛 0.30，并要求“设计时候要方便后续灵活切换”。

<a id="premises"></a>

## 前提

1. 嵌入原来只支持网关一家：改动前 `apps/agent-service/src/production-memory-composition.ts` 在 `embedding.provider !== "vercel-ai-gateway"` 时抛出 `MEMORY_EMBEDDING_PROVIDER_UNSUPPORTED`（main 上 cb9c281 版本）。
2. 门槛和模型绑在代码常量上：改动前 `packages/memory-engine/src/embedding.ts` 有 [QWEN3_MEMORY_MINIMUM_SIMILARITY](https://github.com/sixianli/himawari-agent/blob/54e1bec4fb4df525ecf3f87143e917a748d2b0fa/apps/agent-service/src/production-memory-composition.ts) 和 [QWEN3_MEMORY_QUERY_INSTRUCTION](https://github.com/sixianli/himawari-agent/blob/54e1bec4fb4df525ecf3f87143e917a748d2b0fa/apps/agent-service/src/production-memory-composition.ts)，换模型时门槛不会跟着换。
3. 嵌入经统一出口：`packages/memory-engine/src/embedding.ts:259` 用 `exchange.wrapFetch(...)` 包住发送函数，遮盖和记账都在这层里。
4. 索引存什么：`packages/persistence-sqlite/src/migrations/0052_memory_engine.sql` 的 `memory_search_index` 存 `embedding BLOB`（向量原样，不加密），`memory_search_terms` 是关键词全文索引；`schema-catalog.ts:541` 原话“derived from the active Memory revision and rebuilt from encrypted content”，加密方式写的是 `metadata_only`。记忆正文在 `payloads` 里加密保存。
5. 备份怎么做：`packages/persistence-sqlite/src/sqlite-recovery-point.ts:618` 先把整库拷成 `product.sqlite.plaintext.tmp`，`:642` 再用备份密钥逐个加密成 `objects/`，然后删掉明文临时文件；`:677` 的排除清单是 `runtime`、`cache`、`locks`、`sockets`、`logs`、`secrets`。
6. 导出读哪些表：`packages/persistence-sqlite/src/data-export/snapshot.ts:33` 的 `readSnapshot` 只读记忆、历史、出处、实体、人物、整理记录、决策记录等，不读 `memory_search_index`、`memory_search_terms` 或 `memory_episodes` 的向量列。
7. 模型许可：jina v5 small 的模型卡写明 CC BY-NC 4.0，商业使用要另行取得许可（[模型卡](https://huggingface.co/jinaai/jina-embeddings-v5-text-small-retrieval)）；Qwen3-Embedding-0.6B 是 Apache 2.0（[模型卡](https://huggingface.co/Qwen/Qwen3-Embedding-0.6B)）。
8. 向量能部分反推出原文：Morris 等人 2023 年的论文 *Text Embeddings Reveal (Almost) As Much As Text* 原话“a multi-step method that iteratively corrects and re-embeds text is able to recover 92% of 32-token text inputs exactly”（[arXiv 2310.06816](https://arxiv.org/abs/2310.06816)）。
9. ONNX Runtime 官方提供 Node.js 绑定 `onnxruntime-node`，可在进程内加载 ONNX 模型推理（[官方文档](https://onnxruntime.ai/docs/get-started/with-javascript/node.html)）；动态 int8 量化支持按通道（per-channel）量化（[量化文档](https://onnxruntime.ai/docs/performance/model-optimizations/quantization.html)）。

<a id="decision"></a>

## 决定

1. **嵌入模型按“档案”登记。**新增 `packages/application/src/embedding-profiles.ts`，每个可用的嵌入模型一份档案：服务方（`local-onnx` 或 `vercel-ai-gateway`）、模型名、支持的维度、取向量的方式、查询和文档前缀（登记在 `packages/prompt-catalog`）、聊天和主动检查各自校准过的门槛、许可、上游仓库和固定的版本号。现在登记四份：网关上的 Qwen3-Embedding-8B（原来的，门槛 0.6 / 0.45）、本机 jina v5 small int8（0.30 / 0.20）、本机 Qwen3-Embedding-0.6B int8（0.52 / 0.47）、本机 EmbeddingGemma 2（0.78 / 0.74）。配置写的服务方加模型名找不到档案，或维度不在档案里，启动就拒绝（`EMBEDDING_PROFILE_UNKNOWN`、`EMBEDDING_PROFILE_DIMENSIONS_UNSUPPORTED`）。切换模型只改配置里那一条嵌入模型描述，门槛自动跟着换；配置里显式写的门槛仍然优先。这取代 [ADR 0115](0115-memory-search-relevance-threshold-and-retrieval-eval.md) 第 1 条里“换成其他向量模型又没配门槛时拒绝启动（[MEMORY_MINIMUM_SIMILARITY_REQUIRED](https://github.com/sixianli/himawari-agent/blob/54e1bec4fb4df525ecf3f87143e917a748d2b0fa/apps/agent-service/src/production-memory-composition.ts)）”这一半：门槛改由档案提供，那个错误码已删除；Qwen3-8B 的 0.6 门槛不变。
2. **生产默认用本机 jina int8，外网 Qwen3-8B 保留为可选。**本机模型在服务进程里用 `onnxruntime-node` 1.30.0 加 `@huggingface/tokenizers` 0.2.0 计算，不另开进程或端口，不需要显卡。本机配置必须是 `disclosure: local_only`、`secretRef: null`、费用全为 0，并带 `artifactSha256`。
3. **本机模型照样走统一出口。**本机运行时对外是一个 `fetch` 函数，地址是 `http://local-onnx.invalid/v1/embeddings`，由 `EgressEmbedder` 用同一个 `wrapFetch` 包住；遮盖、记账和网关请求是同一段代码。本机请求按 0 成本记账，回应里必须带 `providerMetadata.local.runtime = "onnxruntime-node"`。
4. **模型文件固定版本、带校验。**模型文件放在 `<stateRoot>/models/<模型名>/<artifactSha256>/`，里面有 `manifest.json`（列出每个文件的 sha256）和模型、分词器文件；`artifactSha256` 是 `manifest.json` 的 sha256，写在配置里。加载前逐个核对哈希、拒绝符号链接。文件由 `scripts/embedding-models/build-artifact.py` 从固定版本号的上游下载、按通道做 int8 量化后生成，jina 这份的 `artifactSha256` 是 `dcf55698530d735cf4ab00ddd4406e88ff74b09de204a6a4c1e2c7078e753366`。往测试机或生产机放模型文件之前先问 Andy。
5. **向量身份带上配方。**索引里记的模型名是 `模型名#哈希前 16 位`，哈希覆盖前缀和取向量方式、维度、`artifactSha256` 和遮盖规则版本。任一项变了，旧向量自动算“没建索引”，后台按新身份重算。
6. **模型在后台加载，加载好之前只用关键词和实体。**状态有 `idle`、`loading`、`ready`、`failed`、`closed`；没到 `ready` 时嵌入报 `EMBEDDING_LOCAL_NOT_READY`，检索退回关键词和实体（同 [ADR 0223](0223-chat-memory-lookup-falls-back-to-keywords.md)）。第一次到 `ready` 后，把记忆排回待建索引并补算向量。请求排一个有上限的队（默认 64 个），聊天的查询排在后台补算前面；调用方放弃了的请求还在排队时直接出队，已经在算的算完后不返回向量；关闭时先等正在算的那一条算完再释放模型；单条输入超过 8192 个 token 就拒绝。补算每日摘要时，只有确属这一条内容的问题（超过 8192 个 token、算出的向量不合法、服务方以 413 或 422 拒绝这条输入；服务方以 400 拒绝时，要同一次补算里另有一条成功，才认定是这一条的问题，否则当作整体性失败）才算“这一条算不出来”：跳过它、接着往后翻页，它要等一段时间才再试（1 小时起、每次加倍、最长 24 小时，记在服务内存里，最多记 1 万条，重启后清空；时钟回拨使等待超过 24 小时时立即再试）。在等的条目直接跳过、不占名额，所以坏条目再多也挡不住后面的好条目。模型没就绪、队列满、超时、执行权失去这类整体性的失败，不记在哪一条头上，直接让这次补算报错，下次照常从头试。这次有条目算不出来、一条也没补上时也报错。本机模型第一次就绪后的全量补算报错时，按 1 分钟起、每次加倍、最长 1 小时的间隔重试；剩下的只有在等的坏条目时，补算就算完成，那些条目到时间后，由之后某次运行时附带的补算再试（服务没有新运行时不会主动去试）。健康检查多一项非必需的 `memory-embedding`。
7. **上线脚本支持换嵌入模型。**实例配置 `configTargets.embedding` 写目标嵌入描述，出包时生成 `TARGET_EMBEDDING_JSON`；切换检查和维护脚本只允许把唯一那条嵌入描述整条换成它、把 `memory.dimensions` 改成它的维度，并去掉旧模型的门槛覆盖值，别的配置字段一处不许动。出包时目标描述按服务启动的同类条件核对：键要齐、引用名的写法、服务方加模型名必须是已登记的档案、维度在档案里、费用是有限的非负数字、能力和数据分类不许重复、数据分类和公开范围是已知值、本机模型的哈希是 64 位小写十六进制且不能全为 0、只有本机模型能带 `artifactSha256`、网关模型必须有密钥引用。目标是本机模型时，上线前检查（`deploy-preflight.py`）会在生产机上按服务加载时的规则核对模型目录：哈希、维度、文件只能是规定的那几个，不全或不符就停；包里的目标缺模型名、哈希或维度也停。清理旧版本时不碰 `models/` 目录。
8. **重建索引一并清空每日摘要的向量。**`memory reindex` 管理命令在清空记忆索引的同时，把 `memory_episodes` 的向量列置空，计划和结果里报告条数。
9. **检索索引的威胁模型**写在 [记忆检索索引的威胁模型](../memory-index-threat-model.md)：索引从明文派生，防备份和导出泄露，不防本机入侵。

同一处代码顺带修掉 [ADR 0223](0223-chat-memory-lookup-falls-back-to-keywords.md) 后果里留下的问题：运行已被取消时嵌入失败，不再写检索降级的决策记录（运行内的记忆模块把“当前运行是否已取消”交给检索层判断）。

依据的原则：用户主权（数据不出主人控制的机器）优先于主动性与效率；记忆可靠性靠评测数字和“加载失败时退回关键词”兜底。

<a id="options"></a>

## 放弃的做法

- **用 `@huggingface/transformers`（transformers.js）跑模型。**候选报告就是用它测的，输出和直接调用 `onnxruntime-node` 逐位一致（点积 1.000000，最大差约 4e-8）。它多带一整套浏览器和多后端代码、默认还会去网上取模型；直接用 ONNX Runtime 加分词器库依赖更少，加载路径完全由我们控制。
- **另开一个嵌入服务进程（例如 Text Embeddings Inference）。**多一个要守护、要鉴权的端口和进程；单人使用的负载用进程内推理足够。
- **留在网关上的 Qwen3-8B。**主人的每句话和每条记忆都要发到第三方，一次多 1 秒左右，断网就失去按意思找。
- **选 Qwen3-Embedding-0.6B（Apache 2.0）。**评测命中率低于 jina；许可没有限制。保留为登记好的档案：Himawari 要收费之前换成它（见后果）。
- **把模型文件打进上线包。**上线包会大约 600 MB，每次上线都要传；放在状态目录里按哈希定位，换版本时上线包不变。

<a id="consequences"></a>

## 后果

- **数字（合成评测集，真实代码路径，门槛 0.30）：**主评测集（40 条该找到、48 条无关）命中 90%，需要推理才能对上的 55.6%，精确率 80.4%，无关句带出记忆 1 次；另外新写的 70 条留出集命中 70%，需要推理的 60%（18/30），无关句带出 0 次。查询中位数约 35 毫秒，加载约 3.7 秒，进程约多占 1.35 GB 内存。对比：网关 Qwen3-8B 在主评测集 0.6 门槛下命中 80%（2026-11-11 同日基线，见候选报告）。这些轮次是用 `--no-record` 跑的，数字记在本 ADR 和候选报告里。
- **许可：**jina v5 small 是 CC BY-NC 4.0，Andy 自用不收费可以用；Himawari 一旦对外收费，要先换成 Qwen3-0.6B 或取得 jina 的商业许可。换模型只改配置里那条描述并重建索引。
- **升级本身也会重算一次：**索引里记的模型名从纯模型名改成了 `模型名#哈希`，所以即使仍用网关模型，第一次升到这个版本时所有记忆和每日摘要也会按旧向量作废、后台重算一次（网关模型会产生一次全量嵌入费用）。这是有意的：旧向量没有记下前缀和遮盖规则，无法判断是否还能用。
- **切换要重建：**从 4096 维换到 1024 维，`memory.dimensions`、所有记忆和每日摘要的向量都要重算。改配置后旧向量自动作废，后台补算；`memory reindex` 可以一次清空。换回网关模型同样要重算。
- **上线：**生产机要先放好模型目录（约 600 MB，属于“往生产机放模型文件”，要 Andy 同意），上线包配置里写 `configTargets.embedding`；没放好时上线前检查会停。回滚到旧版本会恢复旧配置，回到网关模型，同样要重算一次向量。
- **内存：**常驻多约 1.35 GB（生产机当时可用约 6.6 GB）。
- **每日摘要：**`memory_episodes` 的向量补算只看有关键词条目的摘要（`JOIN memory_episode_terms`）。没有关键词条目的是只含 sensitive 内容、本来就不进索引的摘要，这是有意的，这次不改。
- **遮盖用的固定文字清单不变：**出口遮盖会跳过提示词目录里不少于 24 个字符的固定文字（[KV 缓存规则第 11 条](../../.agents/instructions/prompt-prefix.md#deterministic)），清单变了，含这段文字的老对话请求开头会变一次。新增的向量前缀里，除了原有的 Qwen3 查询指令（本来就在清单里），每段都短于 24 个字符（EmbeddingGemma 的查询前缀拆成两段写），清单和改动前完全一样，`prompt-rendering-golden.unit.test.ts` 检查向量前缀不往清单里加东西。
- **依赖：**新增 `onnxruntime-node` 1.30.0 和 `@huggingface/tokenizers` 0.2.0，版本写死；出包时只保留当前平台的 ONNX Runtime 二进制，去掉 CUDA 和 TensorRT 的部分。

<a id="verification"></a>

## 验证

- `packages/platform-node/test/local-onnx-embedding.unit.test.ts`：用一个 263 KB 的测试模型（`test/fixtures/local-onnx-embedding/`，由 `scripts/embedding-models/make-test-fixture.py` 生成）断网加载并回答嵌入请求；反向：文件哈希不对、`manifest.json` 哈希不对或写的是别的模型、经符号链接的目录，都拒绝加载；聊天查询排在后台补算前面、超过队列上限拒绝、调用方放弃的请求出队、正在算时放弃的不返回向量、关闭时等正在算的那条算完；上游下载脚本和 TypeScript 档案的仓库、版本号、维度一致。
- `apps/agent-service/test/local-embedding-composition.unit.test.ts`：本机配置断网也能按向量找到记忆，模型看到的是遮盖后的输入；反向：同样断网时网关模型按向量什么也找不到；加载中退回关键词；每份档案都能通过配置、组装和准入；文件、前缀或遮盖规则变了，向量身份跟着变；运行已取消时不写检索降级记录、真正失败时写一条。
- `apps/agent-service/test/production-model-composition.unit.test.ts`：聊天检索的运行取消信号传到嵌入；模型调用记忆工具时运行已失去执行权（执行权检查报 `NOT_AUTHORITATIVE`），也不写检索降级记录；同一错误码但不是执行权检查报的（例如边界没绑定）、嵌入服务真出错，都照样写；MCP 读取的调用方取消时也不写。
- `packages/memory-engine/test/episode-backfill.unit.test.ts`：一条每日摘要算不出向量时，其余照常补算；一页全失败时报错；每次只补一条时也能越过算不出的那条。
- `packages/platform-node/test/startup-configuration.unit.test.ts`：本机配置必须 `local_only`、无密钥、0 成本、带 `artifactSha256`，每种违规都按原因拒绝。
- `scripts/delivery-mode/test_make_packet.py`、`test_deploy.py`、`test_release_cleanup.py`：切换检查只换嵌入描述和维度；目标不合规（缺键、未登记的档案、维度不对、全 0 哈希、网关带哈希或缺密钥等）时出包拒绝，出包脚本里的档案清单和 TypeScript 档案一致；上线前检查在模型目录不全时停；清理不碰 `models/`；上线前检查对维度不符、多出文件的模型目录也停；ONNX Runtime 打包只留当前平台的二进制、去掉 CUDA 和 TensorRT（`test/tooling/artifact.test.mjs`）。
- `apps/admin-cli/test/memory-reindex-cli.unit.test.ts`：重建索引报告并清空每日摘要的向量。
- 备份和导出：见 [威胁模型文档的“自动检查”一节](../memory-index-threat-model.md#checks)。

<a id="links"></a>

## 参考

- [BL-20261028-008 找记忆的向量化改在生产机本机计算](https://github.com/sixianli/himawari-agent/blob/34de855ff109a53391cfc0d59706bcf44ba7f4a5/docs/archive/backlog/BL-20261028-008-local-memory-embedding.md)
- [ADR 0075 自研记忆引擎](0075-self-built-memory-engine.md)
- [ADR 0223 聊天找记忆时嵌入失败退回关键词](0223-chat-memory-lookup-falls-back-to-keywords.md)
- [记忆检索索引的威胁模型](../memory-index-threat-model.md)
