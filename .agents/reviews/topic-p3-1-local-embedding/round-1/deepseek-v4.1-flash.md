# 方案：把记忆向量化改成本机 ONNX，同时保留统一出口和模型身份

## 结论

这个改动不需要改变聊天请求的开头：向量化不在发给聊天模型的请求里；本轮检索到的记忆按现有规则只进最后一条用户消息。真正的风险不在 KV 缓存，而在三处：本机模型如何仍然经过 `ModelEgress`、向量身份变化后旧索引是否会混用、以及上线/回滚/部署配置校验是否能接受新的描述符。这三处必须一起改，不能只改 `embedding.ts`。

---

## 一、方案依赖的前提

### A. 已由仓库代码或一手来源证实

1. **发给聊天模型的内容只追加，每轮会变的值只放最后一条用户消息。**
   `.claude/rules/prompt-prefix.md:27-29`：
   > “固定的在前，会变的在后。顺序是：工具定义 → 系统提示 → 历史 → 最后一条用户消息。”
   > “每轮都会变的内容只放在最后一条用户消息里。”
   `.claude/rules/prompt-prefix.md:35-36`：
   > “已经发给过模型的内容，不得改动、重排或删除，只能在末尾追加。”
   > “出口遮盖是唯一的例外……遮盖密钥不变、前面的历史不变时，同一段内容每次遮出的字节相同。”

2. **遮盖必须逐字节确定，且不能依赖后面的内容。**
   `.claude/rules/prompt-prefix.md:51-53`：
   > “同样的内容，每次都要序列化成同样的字节。JSON 的键顺序、工具的顺序、列表的顺序……都要固定。”
   > “遮成什么样，只能取决于它自己和它前面的内容，不能取决于它后面的内容。”

3. **嵌入请求现在确实走统一出口，`/embeddings` 走 `redactEmbeddings(input)`。**
   `packages/memory-engine/src/embedding.ts:193-209`：`egress.exchange(...).wrapFetch(fetch)` 后 POST `/embeddings`。
   `packages/application/src/services/model-egress.ts:263-268`：路径以 `/embeddings` 结尾时选 `redactEmbeddings`。
   `packages/application/src/services/model-egress.ts:492-503`：只接受字符串或字符串数组的 `input`，逐项调用 `text(..., "embedding_input")`。

4. **嵌入边界负责期限、数据分级、预算预留/结算和一次超时重试。**
   `apps/agent-service/src/production-run-memory.ts:102-318`；当前结算要求 `reportedCostMicros`，且 `gatewayEmbeddingUsage` 强制要求网关的 `providerMetadata.gateway`（`production-run-memory.ts:266-270`、`embedding.ts:90-109`）。本机模型不能复用这段网关专用校验。

5. **当前生产配置只接受 `vercel-ai-gateway` 作为嵌入 provider。**
   `apps/agent-service/src/production-memory-composition.ts:57-65`：
   > `if (embedding.provider !== "vercel-ai-gateway") throw ...`
   该文件 69-94 行还要求密钥、且只在模型等于 8B 时注入查询指令和默认阈值。
   `packages/platform-node/src/strict-configuration.ts:337-344`：`vercel-ai-gateway` 的嵌入模型必须是 `alibaba/qwen3-embedding-8b`，维度只能 4096 或 1024，且必须有 `secretRef`。

6. **索引现在只按 `embedding_model + embedding_dimensions` 区分。**
   `packages/persistence-sqlite/src/sqlite-memory-operations.ts:1115-1116`、`1129-1130`：向量查询要求 `embedding_model = @model AND embedding_dimensions = @dimensions`。
   `sqlite-memory-operations.ts:1400-1401`、`1485-1486`：启动补索引按模型/维度判断旧行。
   `apps/agent-service/src/service-main.ts:1183-1198`：启动时把这些记忆重新排进投影队列。
   `packages/memory-engine/src/episodes.ts:268-307`：对话片段只补算模型/维度不一致的向量。
   **问题：换了量化文件、前缀或 pooling，但 `model` 字符串没变时，旧向量不会被识别为旧向量。**

7. **对话片段的补算还有一个额外过滤条件。**
   `packages/persistence-sqlite/src/sqlite-memory-operations.ts:1397-1401`：
   > `JOIN memory_episode_terms t ON t.rowid = e.rowid`
   没有词表条目的片段不会被 `listUnembedded` 列出。重建“所有对话片段”不能只依赖现有入口。

8. **现有 `memory reindex` 只清记忆索引，不清对话片段向量。**
   `packages/persistence-sqlite/src/sqlite-memory-maintenance.ts:74-76`：只 `DELETE FROM memory_search_index`。
   `apps/admin-cli/src/memory-command.ts:68-77`：命令也只报告 `clearedIndexRows`。不补这一点，达不到“记忆和对话片段全部重算”。

9. **Jina 模型的关键规格与许可。**
   Hugging Face 模型卡 <https://huggingface.co/jinaai/jina-embeddings-v5-text-small-retrieval> 原文：
   > “Parameters | 677M”
   > “Embedding Dimension | 1024”
   > “Pooling Strategy | Last-token pooling”
   > “Queries: `Query: ` prefix … Documents: `Document: ` prefix”（模型卡 vLLM 示例中 `query_prompt = f"Query: {query}"`、`document_prompt = f"Document: {document}"`）
   > “The model is licensed under CC BY-NC 4.0.”

10. **官方 ONNX 不是单个 2.3 GB 文件，而是主图和外部权重两个文件。**
    Hugging Face 文件 API <https://huggingface.co/api/models/jinaai/jina-embeddings-v5-text-small-retrieval/tree/main/onnx>：
    - `onnx/model.onnx`：1,266,078 字节
    - `onnx/model.onnx_data`：2,384,199,936 字节
    这会影响下载、校验和量化脚本：必须按文件清单校验，不能只写一个“模型文件”路径。

11. **Transformers.js 支持本机 `feature-extraction`、`last_token` pooling 和 `normalize`。**
    <https://huggingface.co/docs/transformers.js/en/api/pipelines> 原文：
    > “`pooling` (`'none' | 'mean' | 'cls' | 'first_token' | 'eos' | 'last_token'`)”
    > “`normalize` (`boolean`) … Whether to normalize the embeddings in the last dimension.”
    <https://huggingface.co/docs/transformers.js/en/api/env> 原文：
    > “`allowRemoteModels` … If set to `false`, it will have the same effect as setting `local_files_only=true`”
    > “`allowLocalModels` … defaults to `false` if running in-browser, and `true` otherwise.”

12. **`dtype: "q8"` 默认对应 `model_quantized.onnx`。**
    Transformers.js 维护者在 issue 中的原话：<https://github.com/huggingface/transformers.js/issues/1581>
    > “`q8` == `model_quantized.onnx`”
    因此自己量化的文件应安装为 `onnx/model_quantized.onnx`，或在加载时显式指定 `model_file_name`；要加 smoke test，不能只靠约定。

13. **ONNX Runtime 官方动态量化 API。**
    <https://onnxruntime.ai/docs/performance/model-optimizations/quantization.html> 原文：
    > “Python API for dynamic quantization is in module `onnxruntime.quantization.quantize`, function `quantize_dynamic()`”
    > “It is recommended to use dynamic quantization for RNNs and transformer-based models”

14. **I-73 的教训：清单/配置产生的值必须交给真正使用它的校验。**
    `docs/incidents-and-gates.md:112`：
    > “双模型复核只看了 diff，没问「清单里的 id 能通过后端校验吗」”
    本方案里对应的值是 `provider`、`model`、`version`、`local.directory`、`local.manifestSha256`、模板引用、维度、阈值。每一个都要同时核对“生产者”和“消费者”。

15. **现有发布材料的组成。**
    `scripts/delivery-mode/make-packet.py:48-49`：材料是 `context.json`、`source-build-inputs.json`、`node-modules.tar.gz`、`node-modules.json`、`npm-ls.json`、Python 包。
    `scripts/package-node-runtime.mjs:39-55`、`162-227`：发布运行时会复制外部依赖闭包，因此 `@huggingface/transformers`/`onnxruntime-node` 会进 `node-modules.tar.gz`；模型权重不必也不应进发布包。

16. **生产机与启动约束。**
    `docs/backlog/BL-20261028-008-local-memory-embedding.md:34`：
    > “生产机常驻多占约 1.4 GB 内存（当时可用 6.6 GB）；上线包约大 600 MB”
    `scripts/delivery-mode/instances/andy-production.json:25`：启动就绪预算 30 秒；`docs/incidents-and-gates.md` 的 I-28 记录启动时间在 12–31.5 秒波动。**模型加载和哈希校验不能阻塞服务启动。**

### B. 推测或尚未核实

- **Pi 是否提供嵌入能力：未核实。** 在当前仓库的 `packages/runtime-pi/package.json` 和 `docs/pi-development-guide.md` 中只看到文本生成、工具、会话等接口；`@earendil-works/pi-ai` 官方 README 的目录与 API 表也没有嵌入接口（<https://github.com/earendil-works/pi/blob/main/packages/ai/README.md>）。但当前 sparse checkout 没有 `node_modules`，没有逐份核对 1.5.0 的 `.d.ts`，所以只能写“未找到嵌入 API”，不能断言绝对没有。
- **Jina 的 int8 ONNX 在 transformers.js 4.3.1 下的输出与 Python/评测工具一致：材料说云端实测可跑，仓库内没有可复现实验。** 计划里要用固定输入和固定版本做 smoke test。
- **`quantize_dynamic` 在不同机器上是否逐字节可复现：未证实。** 计划要求同版本构建两次比对 SHA；若不稳定，就把它当作“固定二进制产物”发布，不在每次出包时重算。
- **量化后的实际文件名、大小、是否产生外部数据文件：未证实。** 材料说约 571 MB int8，但源文件是 2.38 GB 外部数据格式，最终输出必须由构建脚本写入 manifest，不靠口头数字。
- **生产实际 `/etc/himawari/config.json`、真实内存余量和并发下的 CPU 争用：未读生产机，未核实。**
- **本机 ONNX 推理在不同线程数下是否位级确定：未证实。** 向量不是发给聊天模型的字节，但会影响索引复现；计划固定线程数并允许使用余弦/容差测试，不把位级相同当作跨机器保证。

---

## 二、方案本身

### 1. 模块怎么分

建议分成四层，避免把 ONNX 细节塞进 `HybridMemoryProvider`：

1. **`packages/memory-engine/src/embedding.ts`**
   - 保留 `Embedder`、`GatewayEmbedder`、`normalizedVector`。
   - 把 `gatewayEmbeddingUsage` 拆成通用 `embeddingUsage`：
     - `costSource: "provider"`：网关，要求 `providerMetadata.gateway`，用 `reportedCostMicros`；
     - `costSource: "local"`：本机，要求 token 数是安全非负整数，`reportedCostMicros = 0`，不要求网关元数据。
   - `Embedder` 增加 `readonly identity: string`。`identity` 用于索引键；`model` 仍用于请求体中的 `model` 字段和模型绑定校验。对网关 `identity = model`，对本机 `identity = model@version`。

2. **`packages/memory-engine/src/local-onnx-embedding.ts`（新文件）**
   - `LocalOnnxEmbedder implements Embedder`。
   - 只负责：本机管线加载、tokenizer、`last_token`/其他 pooling、归一化、并发排队、线程数、输出维度和有限值校验。
   - **不直接调用管线处理未遮盖文字**。`embed(text)` 先构造与 OpenAI `/embeddings` 相同的 JSON，再走 `egress.exchange(ctx).wrapFetch(localFetch)`；`localFetch` 只做本机推理并返回带 `data[0].embedding`、`usage` 的响应。这样 `ModelEgress` 的 `redactEmbeddings` 仍然是唯一遮盖入口，且 `check:egress-redaction` 能机械检查。
   - 一次只发送一个 `input` 字符串，不把多个文档放进同一个 `/embeddings` 请求；避免出口的“前面见过的值后面也遮”导致同一段文字因同批其它文字而遮成不同字节。
   - 本地 `fetch` 目标用固定字符串（例如 `local://embedding/embeddings`），只借路径触发 `/embeddings` 规则，不产生网络请求。
   - 用单飞队列串行化推理，避免多个后台补索引和前台搜索同时抢占 CPU。

3. **`apps/agent-service/src/production-memory-composition.ts`**
   - 不再只接受 `vercel-ai-gateway`；按 `provider` 创建 `GatewayEmbedder` 或 `LocalOnnxEmbedder`。
   - 从 prompt-catalog 解析查询/文档模板，传给 `HybridMemoryProvider` 和 `MemoryEpisodeService`。
   - 阈值必须来自配置；删除“只有 8B 才给指令/默认阈值”的模型名分支。
   - `close()` 释放本地管线。

4. **`packages/memory-engine/src/hybrid-memory-provider.ts` 与 `episodes.ts`**
   - 增加 `queryPrefix`/`queryTemplate`、`documentPrefix`/`documentTemplate` 的通用应用点：
     - 查询：`Query: ${query}`；
     - 记忆正文：`Document: ${content}`；
     - 片段：`Document: ${day}\n${text}`。
   - 所有写入/查询的 `MemoryIndexEmbedding.model` 改用 `embedder.identity`。
   - `episodes.backfillEmbeddings` 的“未嵌入”列表不能只靠 `JOIN memory_episode_terms`；增加/改造一个“所有可见片段中身份不一致或为空”的查询，保证没有任何词表条目的旧片段也能重建。

5. **`apps/agent-service/src/production-run-memory.ts`**
   - 继续作为嵌入的唯一调度边界：期限、分级、准入、预算、重试都在这里。
   - 本机模型的 `estimatedCostMicros` 为 0；`settle` 允许 `reportedCostMicros = 0`；`markUnknown` 仍记录失败。
   - 本机不在网络失败时重试；只对“首次加载/冷启动超时”重试一次。新增 `attemptTimeoutMs` 描述符字段，避免沿用 3 秒网络首试上限卡住 2.2 秒模型加载。

### 2. 配置怎么表达

建议在嵌入描述符里增加一个受严格校验的 `local` 对象；网关描述符保持原字段。示例：

```json
{
  "ref": "local-jina-v5-small",
  "role": "embedding",
  "provider": "local-onnx",
  "model": "jinaai/jina-embeddings-v5-text-small-retrieval",
  "version": "q8-20261111-<输出manifest前12位>",
  "allowedDataClassifications": ["public", "private", "sensitive"],
  "disclosure": "local_only",
  "secretRef": null,
  "capabilities": ["embedding"],
  "cost": { "input": 0, "output": 0, "cacheRead": 0, "cacheWrite": 0 },
  "dimensions": 1024,
  "local": {
    "directory": "/var/lib/himawari/state/models/jina-v5-small-q8-<sha12>",
    "manifestSha256": "<64位十六进制>",
    "modelFile": "onnx/model_quantized.onnx",
    "dtype": "q8",
    "pooling": "last_token",
    "normalize": true,
    "queryTemplateRef": "memory.embedding.query-template.jina-v5-retrieval",
    "documentTemplateRef": "memory.embedding.document-template.jina-v5-retrieval",
    "attemptTimeoutMs": 15000,
    "intraOpThreads": 2,
    "interOpThreads": 1
  }
},
"memory": {
  "adapter": "himawari-sqlite",
  "version": "3.3.1",
  "storagePath": "/var/lib/himawari/state/data/memory",
  "dimensions": 1024,
  "minimumSimilarity": 0.30
}
```

关键设计：

- **不把前缀自由文本放配置。** `queryTemplateRef`/`documentTemplateRef` 指向 `packages/prompt-catalog` 里的条目：
  - Jina 查询固定文字 `Query: `（少于 24 字符，不会进入 `TRUSTED_PROMPT_TEXTS`）；
  - Jina 文档固定文字 `Document: `；
  - 换回 Qwen 时用带 `{instruction}`/`{query}` 槽的模板，渲染结果仍逐字节等于原 `Instruct: …\nQuery:…`，且新增的固定片段都是短文本。
  这样既满足“提示词必须登记进 prompt-catalog”，又避免新增长固定文字改变出口遮盖的 trusted 列表。
- **`provider`、`local` 都不能被旧解析器静默接受。** `strict-configuration.ts` 的 `rejectUnknown` 要显式加字段，并校验：
  - `local.directory` 是绝对路径、规范化后位于 `stateRoot` 下、不是符号链接；
  - `manifestSha256` 64 位小写十六进制；
  - `pooling` 枚举；
  - `attemptTimeoutMs` 在 1 到 `deadlines.providerRequestMs` 之间；
  - 线程数是正整数且有上限；
  - 本机 provider 的 `secretRef` 必须为 `null`，`cost` 必须全 0，`disclosure` 必须 `local_only`。
- **阈值必须显式配置。** 删除 `production-memory-composition.ts:92-96` 里按 8B 模型名给默认值的逻辑；所有 provider 都要求 `memory.minimumSimilarity`，本机生产配 0.30。这样换模型不需要改代码，也不会悄悄沿用别的模型的阈值。
- **维度双端校验。** `memory.dimensions` 必须等于描述符 `dimensions`（已有 `strict-configuration.ts:1315-1320`），本机管线实际输出又必须等于该维度；SQLite 的 BLOB 长度检查和查询维度校验继续生效。

### 3. 怎样经统一出口、怎样记账

本机嵌入的调用链固定为：

```text
HybridMemoryProvider / MemoryEpisodeService
  -> Embedder.embed(text)
  -> egress.exchange({ ownerId, agentId, threadId: null, source: "embedding", purpose: null })
  -> exchange.wrapFetch(localFetch)("local://embedding/embeddings", { body: JSON.stringify({ input: text, ... }) })
  -> ModelEgress.redactEmbeddings -> redactForEgress(text, "embedding_input")
  -> localFetch 解析已遮盖的 body，运行 ONNX，返回 data[0].embedding + usage
```

- **遮盖**：不新增出口、不新增路径、不在本机文件里读原文后绕过出口。`check:egress-redaction` 要把新文件加入 `REQUIRED_REDACTION_CALLS` 和 `ALLOWED_EGRESS_FILES`，并要求出现 `exchange.wrapFetch(`。
- **记账**：
  - 投影/前台搜索仍走 `production-run-memory.ts` 的准入和预算，预留 0，结算 0；
  - `ModelInvocationUsage` 记录本次 token 数（由 tokenizer 统计）和 `reportedCostMicros: 0`；
  - `embeddingFailureDiagnostic` 继续写 `memory.embedding_failed`；本机失败不会出现网关原文，但会写固定失败码和文件/模型身份；
  - 邮件检查的 `embedForMailCheck` 也走同一条边界，成本加 0。
- **不绕开本机离线保证**：服务启动和首次使用都不通过 `fetch` 下载模型；Transformers.js 初始化时设置 `env.allowRemoteModels = false`、`env.allowLocalModels = true`、`env.useFSCache = false`、`env.cacheDir = null`，并断言模型目录已存在。

### 4. 模型文件怎么上生产

**结论：模型权重不进发布包，单独一次供给到状态目录。**

理由：

- 571 MB ×（当前版 + 回退版）会持续占用根盘；I-33 已经记录过根盘不足导致上线失败。
- 模型是数据资产，不是代码；发布包的 SHA 清单适合代码和依赖，不适合每版重复携带大权重。
- 单独供给可以在不重打出包的情况下切换模型，符合“以后灵活换模型”。

具体做法：

1. **新增构建/供给脚本** `scripts/memory-embedding/provision-model.mjs`（可复用 `scripts/ci/verified-download.mjs:137-187` 的 `downloadVerified`）：
   - 必须带显式确认（例如 `--confirm-download MODEL_<输出sha>`）并先经 Andy 同意；没有确认一律拒绝。
   - 从固定 Hugging Face revision 下载 `onnx/model.onnx`、`onnx/model.onnx_data`、`config.json`、`tokenizer.json`、`tokenizer_config.json`、`special_tokens_map.json` 等；每个文件按 SHA-256 校验。
   - 在测试机/Hermes 上按 `scripts/memory-embedding/quantize-model.py` 量化：
     - Python 3.12.10（仓库已有该材料）；
     - `onnxruntime==1.22.1`、`onnx` 精确版本；
     - `quantize_dynamic(src, out, weight_type=QuantType.QInt8)`；
     - 输出安装为 `onnx/model_quantized.onnx`（如产生外部数据文件，一并写入 manifest）。
   - 生成 `manifest.json`：上游 repo revision、每个源文件 SHA、量化命令和版本、每个输出文件 SHA/大小、维度、pooling、模板引用、身份字符串。
   - 用固定输入跑一次管线，输出向量写入 smoke 结果；构建两次，若输出 SHA 不一致，脚本拒绝并提示“只能发布固定二进制，不可声称可重建”。
2. **放哪里**：
   - `/var/lib/himawari/state/models/<identity>/`，内容为 `config.json`、`tokenizer*.json`、`onnx/model_quantized.onnx`、`manifest.json`。
   - 属主 `himawari-prod`，目录 0755、文件 0644；配置里的 `local.directory` 必须在这个根下。
   - 目录名含 SHA 前缀，便于并存多个模型和回退。
3. **怎样上线**：
   - `deploy-preflight.py` 新增 `LOCAL_EMBEDDING_MODEL`：
     - 目录在 state root 下、无符号链接；
     - `manifest.json` 的 SHA 等于配置；
     - manifest 里每个文件存在且 SHA 匹配；
     - 剩余磁盘至少容纳“当前模型 + 回退目标 + 余量”；
     - 不通过就拒绝 `deploy.sh`，不启动服务。
   - 服务启动**不自动下载**；文件缺失是部署配置错误，不是运行时网络问题。
   - 运行期文件损坏/被删：本机嵌入失败，检索退化为关键词+实体+融合，写 `memory.embedding_failed`，不让聊天整轮失败。
4. **发布包**：
   - `node-modules.tar.gz` 里包含 `@huggingface/transformers` 和 `onnxruntime-node` 的 Linux x64 原生依赖；不包含 571 MB 模型文件。
   - `release-cleanup` 只删除当前版和回退版都不引用的模型目录；保留窗口中不能删旧模型，否则回退会失败。

### 5. 自己量化文件的可复现性

要达到“别人能复现”，manifest 必须至少记录：

- 上游 Hugging Face repo 的 `revision`（commit SHA，不用 `main`）；
- 源文件相对路径、字节数、SHA-256；
- Python、`onnx`、`onnxruntime`、`numpy` 的精确版本；
- 量化命令（含 `weight_type=QuantType.QInt8`、是否 `per_channel`、`reduce_range`、`use_external_data_format`）；
- 输出文件相对路径、字节数、SHA-256；
- 一次固定输入的输出向量摘要（或容差范围内的 golden）；
- 模型身份、维度、pooling、查询/文档模板引用；
- 许可证与归属说明。

**判定标准**：同一 manifest 在同一构建环境重跑两次必须得到相同输出 SHA；若某天发现跨机器不一致，就停止“可重建”声明，改为“固定哈希二进制供应”，并在 ADR 里记录。不要为了可复现而放宽到“输出差不多”。

### 6. 重建索引和切换期间的行为

**身份设计**：

- 本机 `identity = model@version`，`version` 包含量化产物摘要。
- 索引键继续使用现有 `embedding_model` 列，但存的是 `identity`；查询、`listUnindexed`、`listUnembedded`、评测历史都用同一个身份。
- 这样即使 `model` 同为 Qwen3 0.6B，只要量化文件或前缀变了，旧向量也不会被查询到。
- 网关保持 `identity = model`，这样回退到旧版本时代码仍能读旧身份；本机第一次切换会整体重建。

**重建命令**：

- 扩展现有 `himawari-admin memory reindex`：
  - 增加 `--embeddings-only`：只做向量身份切换，不恢复闲置归档；
  - 无论是否 `--embeddings-only`，都同时清空：
    - `memory_search_index`（已有）；
    - `memory_episodes.embedding_model/embedding_dimensions/embedding`（新增）。
  - 报告新增 `clearedEpisodeEmbeddings`、`embeddedEpisodesPending`。
- 对话片段的补算入口改为“所有可见、身份不一致或为空的片段”，不再要求 `memory_episode_terms` 存在。

**切换步骤**：

1. 先征得 Andy 同意，供给并校验新模型文件；
2. 停服务，`himawari-admin backup create`；
3. `himawari-admin memory reindex ...` 先报数，再带确认执行；
4. 改配置：嵌入描述符、`memory.dimensions`、`memory.minimumSimilarity`、模板引用、模型路径/manifest；
5. 上线预检通过后启动服务；
6. 启动时 `service-main.ts:1183-1198` 会把身份不一致的记忆重新排队；后台 worker 按现有节奏重建；片段由一个后台补算任务补齐；
7. 重建期间：旧记忆向量查不到，但关键词、实体、融合排名仍可工作；不会把新旧模型向量混在一起；
8. 重建完成后跑一次评测，确认 0.30 阈值下的命中率和无关带出没有恶化。

**回退**：

- 旧 release 的配置仍指向旧模型目录，模型目录在回退窗口内保留；
- 但索引已经被新身份重建，旧 release 会查不到新身份向量，需要再跑一次 `memory reindex` 回到旧身份。这个代价必须在 ADR 和上线操作包里写明，不能承诺“配置一改就回退”。

### 7. 断网检索怎么测

分两层：

- **自动单元/集成测试**：注入假的 `localFetch`/假管线，断言：
  - `exchange.wrapFetch` 被调用；
  - 发送给本地推理的 body 是遮盖后的 `input`；
  - 全程没有调用全局 `fetch`；
  - 向量+关键词+实体+融合仍返回结果。
- **可选真模型测试**：`HIMAWARI_LOCAL_EMBEDDING_LIVE=1` + `HIMAWARI_LOCAL_EMBEDDING_DIR`，加载真实 571 MB 文件，先设置 `env.allowRemoteModels=false`，再把全局 `fetch` 替换成抛错函数，搜索仍成功。这个测试不进普通 `npm run check`，但进上线前/评测机器的手动检查清单。
- **反向用例**：把 `env.allowRemoteModels` 改回 `true` 或去掉网络封锁，测试必须失败；把 `wrapFetch` 去掉，`check:egress-redaction` 必须失败。

### 8. 评测脚本怎么改

当前问题：
`scripts/memory-retrieval-eval/live.mjs:39-52` 固定 POST `alibaba/qwen3-embedding-8b`，且没有 `--confirm-cost` 不开跑；`test/integration/memory-retrieval-eval/live.test.ts:158-179` 也直接构造 `GatewayEmbedder`，阈值默认 `0,0.6`（`live.test.ts:151-155`）。

改法：

- `live.mjs` 增加后端选择：
  - `--provider=local` 或 `--model-config=<JSON>`（默认 local）；
  - `--local-model-dir`/`HIMAWARI_LOCAL_EMBEDDING_DIR`；
  - 只有 gateway 后端才要求 `--confirm-cost` 和 `AI_GATEWAY_API_KEY`；本机后端不要求费用确认，但仍要求模型 manifest SHA。
- `live.test.ts` 不再硬编码模型名和维度，改用与生产相同的 `createEmbedder` 工厂/配置解析；把成本回调只用于 gateway。
- 阈值从模型配置/评测参数读取，不写死 0.6；本机生产阈值 0.30，另可并列报告 0.20/0.30/0.40。
- `round.json` 记录 `provider`、`identity`、`modelManifestSha256`、`thresholds`、`datasetSha256`、`commit`；`history.jsonl` 对比只在同一 `identity` 内做基线，避免拿旧 8B 的数字评价新模型。
- 更新其余写死 Qwen 的辅助脚本：`scripts/memory-evaluation/embed-dataset.mjs:10`、验收探针 `sandbox-install-restart-model.mjs:9-10`、`sandbox-install-restart-probe.mjs:800-820` 等；这些值必须从配置/夹具读，或明确标注为“仅网关兼容性探针”。

### 9. 要加哪些测试和门槛

建议新增 `check:local-embedding`，放进 `package.json` 的 `check:steps` 与 `scripts/run-all-checks.mjs`：

1. **配置解析测试**
   - 接受本机描述符和 `local` 全部字段；
   - 拒绝未知字段、state root 外路径、符号链接、错误 manifest SHA、维度不一致、缺 `minimumSimilarity`、本机 `secretRef` 非空、本机 `cost` 非 0、非法 pooling/线程数/超时。
   - 网关描述符仍能解析，且本机字段不会漏进网关。
2. **本地 Embedder 单元测试**
   - 查询加 `Query: `，文档加 `Document: `；
   - `last_token`/`normalize` 传给管线；
   - 输出维度/有限值校验；
   - 经 `ModelEgress` 遮盖，且 `wrapFetch` 被调用；
   - 成本 0、token 数记录；
   - 冷启动超时用 `attemptTimeoutMs`，不沿用 3 秒网络首试。
3. **SQLite 身份测试（真实库）**
   - 同一维度、不同 `identity` 的旧行不被新查询带出；
   - `listUnindexed` 和 `listUnembedded` 都会列出旧身份行；
   - 没有词表条目的片段也能被补算；
   - `memory reindex --embeddings-only` 同时清记忆和片段向量，且不恢复归档；
   - 反向：删掉片段清理、忽略 identity、保留 `JOIN terms`，对应测试失败。
4. **离线检索集成测试**
   - 本机假管线 + 全局 fetch 抛错，搜索仍返回；
   - 反向：打开远程模型或去掉 `wrapFetch`，测试失败。
5. **出口检查**
   - 更新 `scripts/check-egress-redaction.mjs` 的 `REQUIRED_REDACTION_CALLS`/`ALLOWED_EGRESS_FILES`；
   - 反向：删除本地文件里的 `exchange.wrapFetch(` 或让本地推理直接读原文，检查必须失败。
6. **提示词目录检查**
   - 新模板条目登记 manifest；`check:prompt-catalog` 检查 digest、layer、usedBy、slot；
   - 反向：改模板但不更新 manifest，必须失败；模板里加入日期/时间/哈希或未登记 slot，必须失败。
7. **确认提示前缀未变**
   - `npm run check:prompt-prefix` 继续跑；新增断言：新加嵌入模板不会进入长 trusted 文本列表，系统提示/工具定义/历史不被本改动修改。
8. **部署/出包门槛**
   - `deploy-preflight.py` 新检查模型目录/manifest/文件 SHA/磁盘；
   - `make-packet.py` 确认模型文件不在 `MATERIAL_FILES`，但 node_modules 依赖闭包含 Transformers/ONNX Runtime；
   - `test_make_packet.py`、`test_deploy.py` 正反用例；
   - `verify-switch-config-fixtures.py`、`maintenance/verify-fixtures.mjs` 允许新的嵌入字段，同时仍拒绝未批准的字段（见下面第 4 问）。
9. **评测与检索相关性**
   - `check:memory-relevance` 增加本机配置：缺阈值拒绝启动、0.30 下无关句子不返回；
   - 发布走查 `accept-unrelated-no-memory` 用本机配置跑一次（至少在本机模型可用时）；
   - 反向：把阈值降为 0 或去掉过滤，测试失败。
10. **I-73 式契约测试**
   - 从配置模板生成嵌入描述符，依次交给：
     - `parseProductConfiguration`；
     - `resolveConfiguredModelDescriptorSet`；
     - `embeddingAdmissionDescriptor`；
     - `LocalOnnxEmbedder` 构造与请求校验；
     - 部署维护脚本的配置核对。
   - 任何一端不接受（例如 `provider` 拼写、`model` 引用、`local` 字段、维度、manifest SHA）都必须失败。反向用例要证明“只改前端显示、不改后端消费”会被抓住。

### 10. ADR、威胁模型和 Backlog

- 新增 ADR（当前最新是 `docs/adr/0212-...`，建议 `docs/adr/0213-local-memory-embedding.md`）：
  - 换向量模型和服务方；
  - 本机默认、网关保留可选；
  - 统一出口和零成本记账；
  - 模型身份/版本化、重建索引；
  - 模型文件单独供给、不进发布包；
  - 评测和回退代价。
- 新增威胁模型，建议 `docs/security/memory-retrieval-threat-model.md`，至少写：
  - 记忆正文加密；备份/导出中不出现正文；
  - 关键词索引、实体、对话片段词表是从明文（先按 ADR 0196 遮盖）派生的明文索引；
  - **向量 BLOB 也是从遮盖后文本派生的明文数据，可能泄露语义/可被反演，不在“正文加密”的保护范围内**；
  - 本机模型阻止内容离开主机，不改变“本机入侵不可防”的 C4 结论；
  - 模型文件来源、SHA 校验、供应链和许可风险；
  - 不在范围内的：本机 root/服务账号入侵、内存抓取、模型反演、备份介质未加密。
- 关闭 `docs/backlog/BL-20261028-008-local-memory-embedding.md`：把 `record_state` 改为关闭，写明 ADR、评测结果、上线版本；不要删历史。

---

## 三、考虑过但不选的做法

1. **继续用网关 8B，仅加超时/重试。**
   不选：不满足“自有优先、数据自持”和断网可用；网络请求中位数约 1392 ms 的问题仍在。

2. **用 Pi 的嵌入能力。**
   不选（至少现在）：没有找到 Pi 官方嵌入 API；仓库约束也只允许 `packages/runtime-pi` 引用 Pi。若未来 Pi 提供，应优先替换本机加载层，但当前不能假设。

3. **起一个本机 TEI/llama.cpp/Ollama HTTP 服务，仍走 OpenAI `/embeddings`。**
   不选：多一个进程、端口、健康检查、模型加载和权限面；故障域更大。当前内存/CPU 预算也不宽裕。
   优点是可以完全复用现有网关代码；如果后续需要多语言或多模型并发，可重新评估。

4. **把 571 MB 模型放进发布包。**
   不选：每版重复携带，当前+回退两份就超过 1 GB；I-33 已有根盘不足事故；模型切换还要重新出包。

5. **服务启动时自动从 Hugging Face 下载模型。**
   不选：违背断网可用；启动依赖外网；无法保证版本和 SHA；没有主人同意就下载也不符合约束。

6. **继续只按 `model + dimensions` 识别索引。**
   不选：同一模型换量化文件、前缀或 pooling 时不会触发重建，旧向量会混入新查询。必须引入 `identity`。

7. **把多个文档批量放进一个 `/embeddings` 请求以提高吞吐。**
   不选：出口的“前面出现过的值后面也遮”会依赖同批前文，可能让同一段文字在不同批次遮成不同字节。保持一条文本一次出口调用；本机内部如需批处理，也只对已分别遮盖的文本做推理。

8. **沿用 0.6 阈值，或按模型名在代码里给默认阈值。**
   不选：不同模型相似度分布不同；I-23 已证明没有门槛会显示无关记忆。阈值必须显式配置、评测后由 Andy 定。

9. **换回网关时复用旧 4096 维向量或截断。**
   不选：不同模型向量空间不兼容，必须重建。

10. **只改 `embedding.ts`，不动部署配置和索引身份。**
    不选：I-73 的教训就是“改动本身能跑，清单里的值过不了后端”。本方案必须同时改配置解析、生产组装、准入描述符、SQLite 身份、维护脚本、发布核验。

---

## 四、风险和反例

1. **0.30 阈值可能带出无关记忆（I-23 重演）。**
   反例：用户问“写 PDF”，仍带出“前同事叫林峰”。缓解：用真实评测集比较 0.20/0.30/0.40，生产加无关带出监控；发布走查保留 `accept-unrelated-no-memory`；不达标就不切。

2. **CC BY-NC 4.0 许可限制。**
   Himawari 目前是个人非商业使用；一旦商业化，必须换模型或取得 Jina 商业许可。ADR 必须写明，模型目录附 LICENSE/NOTICE。

3. **CPU/内存争用。**
   常驻约 +1.1 GB，4 核上单句约 26 ms；并发记忆搜索、后台补索引、执行命令同时跑时可能变慢。缓解：单飞队列、限制线程数、启动后台预热门槛、生产实测。

4. **启动时间和哈希校验。**
   571 MB 文件在慢盘上哈希可能数秒；直接放在启动路径会撞 I-28 的 30 秒预算。缓解：预检阶段校验，服务启动只做 stat/manifest 检查；首次加载后后台预热；加载完成前检索退化为关键词。

5. **原生依赖/ABI。**
   `onnxruntime-node` 带平台原生二进制；Hermes 构建机和生产 ABI 必须一致。缓解：`package-node-runtime` 的依赖闭包测试、在 Hermes 上真实导入并跑一次 smoke test。

6. **模型文件被清理或回退缺失。**
   回退版本可能引用旧模型目录；如果 `release-cleanup` 删了旧模型，回退启动失败。缓解：按当前+回退配置保留模型目录，清理测试覆盖。

7. **索引身份没有覆盖所有写入路径。**
   反例：某处仍用 `embedder.model` 而不是 `identity` 写片段，查询永远找不到它。缓解：类型上把索引键字段命名为 `identity`，并加真实 SQLite 测试覆盖记忆、片段、启动补索引、评测四条路径。

8. **片段补算被 `JOIN terms` 漏掉。**
   反例：旧敏感片段没有词表条目，重建后仍无向量。缓解：改查询并在测试里造一条无词表条目的片段，证明会补算。

9. **部署维护脚本拒绝新配置。**
   反例：`verify-switch-config-fixtures.py:73` 和 `verify-fixtures.mjs:73` 现在把“嵌入模型维度改为 1024”当作未批准变更；不更新它们，第一次上线会在 S7/维护阶段被自己的门槛拦下。缓解：本版把新的嵌入描述符字段加入允许列表，同时保留“未批准的模型/路径/SHA 变更必须拒绝”的反向用例。

10. **评测把本机和网关数字混在一起。**
    反例：`history.jsonl` 直接比较上次 8B 的命中率，得出错误结论。缓解：按 `identity` 分组比较。

11. **本机推理的浮点非确定性。**
    反例：同一文本两次得到最后几位不同的向量，导致 golden 测试不稳定。缓解：固定线程和版本；测试用容差/余弦；索引一致性按模型版本而非位级哈希。

---

## 五、需要 Andy 拍板的取舍

1. **接受 CC BY-NC 4.0 只用于个人非商业用途**，并在 ADR 写明未来商业化必须换模型/取得许可。
2. **模型权重不进发布包**，改为单独一次供给到 `/var/lib/himawari/state/models/...`；以及是否允许在 Hermes 构建时下载/量化后再上传，还是只在生产机下载。无论哪种，下载前都要 Andy 同意。
3. **确认生产阈值 0.30**：先用评测比较 0.20/0.30/0.40，接受“0.30 下无关带出不超过基线”才上线。
4. **接受本机模型约 +1.1 GB 常驻内存和 2 个 intra-op 线程**，或指定更保守的线程数/单飞队列策略。
5. **接受重建期间短暂“只有关键词/实体、没有向量”的降级窗口**，以及回退时需要再次重建索引的代价。
6. **接受把 `memory.minimumSimilarity` 改为必填、删除按模型名给默认阈值的旧行为**（旧配置需要补值，属于一次性迁移）。
7. **确认 ADR 编号 0213 和威胁模型文档位置**；确认 Backlog BL-20261028-008 的关闭方式。

---

## 六、逐条回答必答问题

### 1. 会不会改变模型已经见过的请求开头？发给模型的内容是不是仍然只在末尾追加，每轮会变的值是不是都在最后一条消息里？

**不会改变已有请求开头，前提是按本方案做。**

依据：
- 向量化本身不进入聊天请求；检索结果按现有设计进入“最后一条用户消息”的资料块。`.claude/rules/prompt-prefix.md:27-29` 要求“固定的在前，会变的在后”，并把“本轮选中的记忆”明确列为只放最后一条用户消息的内容。
- `.claude/rules/prompt-prefix.md:35-36` 要求已发内容只能末尾追加；本方案不改系统提示、工具定义、历史消息，也不改历史里的记忆块。
- 新增的查询/文档前缀只用于嵌入管线，不进入聊天消息。为了不改变出口遮盖的 trusted 文本列表，Jina 的 `Query: `、`Document: `都短于 24 字符；Qwen 模板复用已有长指令文本、新增固定片段也保持短文本，因此不会让旧历史中某段文字突然从“需要遮盖”变成“受信任不遮盖”。`.claude/rules/prompt-prefix.md:51-53` 的确定性和 `prompt-catalog` 的 trusted 列表规则仍然成立。
- 唯一会让“本轮内容”变化的是：新模型/新阈值导致最后一条用户消息里选中的记忆不同。这属于最后一条消息，允许变化；前面的系统提示、工具和旧历史不变。

需要守住的反例：不要把模型路径、SHA、加载时间、当前模型名写进系统提示或工具定义；不要在本轮开始前重写历史里的记忆块；不要新增长固定前缀到 trusted 列表。

### 2. 会不会让同一段文字在不同请求里变成不同的字节？

**对发给聊天模型的文字：不会。对嵌入输入：同一角色、同一模型身份下保持确定；查询和文档因前缀不同而有意不同。**

- 出口遮盖每次嵌入调用都新建 `exchange`，只按“更靠前的内容”和固定密钥遮盖；不依赖后面的消息。与 `.claude/rules/prompt-prefix.md:51-53` 一致。
- 本机嵌入一次只送一个字符串进 `/embeddings`，不把多个文档放在同一请求里，避免“同批前面的秘密影响后面的遮法”导致同一段文字因批次不同而不同。
- 不使用时间、随机数、无序集合或数据库返回顺序生成模型输入；模型身份和 version 来自配置。
- `Query: ` 与 `Document: ` 是模型要求的角色差异，不是同一角色内的不确定性。
- 本机 ONNX 的浮点结果可能受线程数/硬件影响；这不是聊天请求的字节，但会影响索引复现。方案固定线程数和版本，测试用容差，且重建时整体重算，避免新旧向量混用。

### 3. 改动有没有对应的自动检查，反向用例是否真的会失败？

有。核心门槛是新增 `check:local-embedding`，并扩展现有检查。至少包含：

- 配置解析正反用例：本机描述符接受；路径越界、manifest SHA 错、维度不符、缺阈值、本机密钥非空、成本非 0、非法 pooling/线程数/超时均拒绝。
- 出口检查：`check:egress-redaction` 要求本地文件出现 `exchange.wrapFetch(`；反向删掉它必须失败。
- 前缀/pooling/身份测试：去掉 `Query: `/`Document: `、改错 pooling、忽略 identity，对应测试必须失败。
- SQLite 真实测试：旧身份行不被新查询带出；`memory reindex --embeddings-only` 清记忆和片段；无词表条目的片段也能补算；反向删掉片段清理或保留 `JOIN terms` 必须失败。
- 离线测试：全局 `fetch` 抛错仍能检索；反向打开远程模型或绕过出口必须失败。
- 提示词目录：新模板登记 manifest；改模板不更新 manifest 必须失败。
- 部署：模型缺失/SHA 不符/磁盘不足拒绝上线；未批准的嵌入字段变更仍被维护脚本拒绝。反向用例要复制 `verify-switch-config-fixtures.py`、`verify-fixtures.mjs` 的现有做法，证明“允许项放行、未允许项拒绝”。
- I-73 式契约：配置生成的 provider/model/version/local 字段必须同时通过 `parseProductConfiguration`、生产描述符组装、`embeddingAdmissionDescriptor`、本机 Embedder 构造和部署配置核对；任何一端不接受就失败。

要求：每个反向用例先在未修复代码上运行并记录失败，再随修复一起进 `npm run check`；只写正向用例不算门槛。

### 4. 改动产生或修改的每个值，每一个使用它的地方都能接受吗？

下面按“生产者 → 消费者 → 两端校验”列出。**这正是 I-73 要求的核对方式，不能只看 `embedding.ts`。**

| 值 | 生产者 | 使用它的地方 | 两端必须满足的校验 |
|---|---|---|---|
| `provider = "local-onnx"` | 配置模板/生产配置 | `strict-configuration.parseModel`、`production-memory-composition`、`embeddingAdmissionDescriptor`、`resolveConfiguredModelDescriptorSet` | 严格配置显式允许；生产组装显式分支；准入描述符接受；CI 契约测试确认不是只在前端/模板出现 |
| `model`、`version` | 配置 | `LocalOnnxEmbedder.model`、`identity = model@version`、SQLite 查询键、启动补索引、片段补索引、评测历史 | `safeReference` 允许 `/`、`@`（`strict-configuration.ts:94-99`）；`identity` 在查询/写入/补算/评测四处一致；本机模型名不被误当成远程网关模型 |
| `local.directory` | 配置 | 严格配置、本机 Embedder、`deploy-preflight.py`、模型供给脚本、清理脚本 | 绝对路径、规范化、在 `stateRoot` 下、无符号链接、可读；预检和服务启动使用同一规则 |
| `local.manifestSha256` | 配置 | 严格配置、Embedder 加载前校验、预检、评测记录 | 64 位小写十六进制；文件实际 SHA 一致；不一致拒绝加载/上线 |
| `local.modelFile`、`dtype` | 配置/供给脚本 | Transformers.js 管线、预检、smoke test | 文件存在；`dtype=q8` 对应 `model_quantized.onnx`，或显式 `model_file_name`；输出维度 1024 |
| `local.pooling`、`normalize` | 配置 | `pipeline(... { pooling, normalize })`、本机 Embedder | 枚举限于 Transformers.js 支持值；`normalize=true`；输出有限且已归一化 |
| `queryTemplateRef`、`documentTemplateRef` | 配置 | prompt-catalog 解析、`HybridMemoryProvider`、`MemoryEpisodeService`、prompt-catalog 检查 | 条目存在、layer 合适、manifest digest 最新；渲染结果逐字节固定；不把长文本新增到 trusted 列表 |
| `dimensions` | 配置 | 严格配置、`memory.dimensions`、SQLite BLOB 长度、向量查询、Embedder 输出校验、评测 | 描述符 = memory = 实际输出 = 数据库长度；不匹配拒绝启动 |
| `memory.minimumSimilarity` | 配置 | 生产内存组装、`HybridMemoryProvider`、SQLite `signal >= threshold`、评测基线、发布走查 | 显式存在、0<值<1；本机 0.30；缺省不再按模型名补默认值；评测对比同一身份 |
| `cost` | 配置 | 准入描述符、预算 reserve/settle、模型调用记录 | 本机全 0；`safeInteger` 允许 0；`actualCost` 对本机按价格算 0；`reportedCostMicros=0` 可结算 |
| `disclosure = local_only` | 配置 | 严格配置、准入、披露策略、模型可见性 | 枚举合法；本机允许的分级（public/private/sensitive）与现有模型可见性一致；restricted 仍不索引 |
| `secretRef = null` | 配置 | `resolveConfiguredSecretRequirement`、`production-memory-composition`、准入描述符 | 本机允许 null；网关仍强制有密钥；不能把本机 null 漏进网关分支 |
| `attemptTimeoutMs`、线程数 | 配置 | `production-run-memory` 首试超时、`LocalOnnxEmbedder` session options | 在 `providerRequestMs` 内；正整数有上限；缺省不得回退到不适合本机的 3 秒网络首试 |
| 量化产物文件名/SHA | 供给脚本 manifest | 预检、服务加载、评测、清理、ADR | 源文件 SHA、输出 SHA、文件大小、文件名同时记录；服务不按“大约 571 MB”猜 |
| 新提示词条目 | `packages/prompt-catalog` | manifest、`check:prompt-catalog`、`TRUSTED_PROMPT_TEXTS`、Embedder 渲染 | digest 更新、reason/changedIn 填写、slot 合法、无日期/时间/哈希；长文本不误入 trusted |
| 部署配置新字段 | 配置模板/发布包 | `verify-switch-config-fixtures.py`、`maintenance/verify-fixtures.mjs`、`S7`、`make-packet` | 允许本版嵌入字段；仍拒绝未批准的其他字段；`test_make_packet.py`/`test_deploy.py` 正反用例更新 |

特别提醒三个容易漏的消费端：

- **`embeddingAdmissionDescriptor`**：它把 provider/model/version/cost 交给准入服务；本机 provider 不特判就可能被当成未知 provider。
- **`maintenance-common.mjs` / `verify-fixtures.mjs`**：现在把“嵌入维度从 4096 改为 1024”当成未批准变更（`verify-fixtures.mjs:73`）。不更新，第一次切换会在部署维护阶段失败。
- **验收探针和评测脚本**：`sandbox-install-restart-model.mjs:9`、`sandbox-install-restart-probe.mjs:800-820`、`scripts/memory-evaluation/embed-dataset.mjs:10` 仍写死 Qwen/4096；要么改成读配置，要么明确保留为“网关兼容探针”，不能让它们代表本机生产路径。

---

## 七、实施顺序建议

1. 先改配置模型/端口/身份和本地 Embedder，补单元测试；
2. 改 SQLite 身份、片段补算、reindex 命令，补真实库测试；
3. 补充给/量化/manifest 脚本和预检、清理、部署夹具；
4. 改评测和验收探针；
5. 写 ADR 和威胁模型；
6. 在测试机用真实模型跑评测和离线检索，把 0.30 的结果交给 Andy 拍板；
7. 再上线；上线后监控 `memory.embedding_failed`、检索耗时、无关带出和索引重建数量。
