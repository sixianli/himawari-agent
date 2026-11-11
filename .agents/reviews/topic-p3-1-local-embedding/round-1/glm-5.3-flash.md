我先按问题列出需要读的文件：嵌入现状（embedding.ts）、出口遮盖（model-egress.ts）、装配与配置校验（production-memory-composition.ts、strict-configuration.ts）、运行时边界（production-run-memory.ts）、持久化与重建（sqlite-memory-operations.ts、service-main.ts、episodes.ts）、评测脚本、以及规则文件（prompt-prefix、incidents-and-gates、pi 规则、verified-download）。
最后核对一处：`safeReference` 是否允许斜杠（决定 `model: "jinaai/..."` 能否通过配置校验，这正是 I-73 那类「两端校验」问题）。
# P3-1 方案：找记忆的向量模型改为本机计算（可配置、可切换）

## 一、方案依赖的前提

**读代码或来源证实的**

1. 现有嵌入只有一条外网路径：`GatewayEmbedder` 经 `egress.exchange(ctx).wrapFetch(fetch)` POST OpenAI 兼容 `/embeddings`，base64 返回（packages/memory-engine/src/embedding.ts:187-228）。出口按路径选遮盖器，`/embeddings` 走 `redactEmbeddings`（packages/application/src/services/model-egress.ts:263-267）；遮盖器只要求 URL 路径以 `/embeddings` 结尾、body 是 JSON，并不限定主机（model-egress.ts:180-193、288-292）。
2. 记账走 `EmbeddingBoundary`（production-run-memory.ts:102-318）：结算要求 `usage.reportedCostMicros` 是 `>= 0` 的整数（:184-190），校验函数 `gatewayEmbeddingUsage` 要求 `data[0].embedding` 长度等于维度、`providerMetadata.gateway.generationId` 与 `routing.finalProvider` 非空字符串（embedding.ts:90-98），但不要求是真实网关返回——也就是说本机实现可以按同一张“响应合同”伪造这两个字段。
3. 重建索引的机制已存在：`listUnindexed`/`listUnembedded` 按 `embedding_model != @model OR embedding_dimensions != @dimensions` 选行（packages/persistence-sqlite/src/sqlite-memory-operations.ts:1394-1406、1477-1490），启动时批量重排进投影队列（apps/agent-service/src/service-main.ts:1186-1199），对话片段用 `backfillEmbeddings`（packages/memory-engine/src/episodes.ts:268-285），另有 `memory.reindex` 管理命令（apps/admin-cli/src/memory-command.ts:25-59）。查询只使用同模型同维度的存量向量。
4. 装配端写死了外网：`provider !== "vercel-ai-gateway"` 直接抛错、必须有密钥、`queryInstruction` 和默认阈值 0.6 都只在 8B 时给（apps/agent-service/src/production-memory-composition.ts:57-104）。配置校验对 embedding 描述符只给 `vercel-ai-gateway` 加了特例（model 必须 8B、维度 4096/1024、必须有 secretRef，packages/platform-node/src/strict-configuration.ts:331-345），`provider` 本身没有白名单；`safeReference` 允许 `/`、`.`、`-`（strict-configuration.ts:94-100），所以 `jinaai/jina-embeddings-v5-text-small-retrieval` 能过校验——这与 I-73 的坑不同：`embedding_model` 在库里是和配置串直接做 SQL 相等的自由文本（sqlite-memory-operations.ts:1400-1401），没有第二个校验器。
5. 前缀只有查询侧且已登记：`MEMORY_EMBEDDING_QUERY_INSTRUCTION` 是 prompt-catalog 的 fixedPrompt，purpose 明说“改它会让已存的向量和新查询对不上”（packages/prompt-catalog/src/memory.ts:36-43）；文档侧无前缀（hybrid-memory-provider.ts:102、episodes.ts:301）。查询与文档在调用点可区分（upsert=文档、search=查询）。
6. 仓库没有任何 onnxruntime / @huggingface/transformers 依赖（全仓 package.json 搜索无结果），新依赖版本必须精确写死（.agents/instructions/pi-and-workspace.md:26-27）。
7. 评测脚本写死外网 8B：GatewayEmbedder + `QWEN3_*` 常量 + 费用上限（test/integration/memory-retrieval-eval/live.test.ts:158-179）。
8. 模型卡证实：jina-embeddings-v5-text-small-retrieval 为 677M 参数、1024 维（Matryoshka 32–1024）、last-token pooling、查询前缀 `Query: `、文档前缀 `Document: `、许可 CC BY-NC 4.0、官方 ONNX 在 `onnx/model.onnx` 子目录（https://huggingface.co/jinaai/jina-embeddings-v5-text-small-retrieval ，Usage 一节原文 "query_prompt = f\"Query: {query}\""、"document_prompt = f\"Document: {document}\""、"The model is licensed under CC BY-NC 4.0"）。
9. 工具可行性证实：transformers.js 的 `pipeline('feature-extraction', …)` 支持 `{ pooling: 'last_token', normalize: true }` 与本地加载、`dtype` 选择（https://huggingface.co/docs/transformers.js/api/pipelines ，FeatureExtractionPipelineOptions 原文："`pooling` (`'none'|'mean'|'cls'|'first_token'|'eos'|'last_token')`"、"Whether or not to normalize the embeddings"）；`quantize_dynamic(model_input, model_output, weight_type=QuantType.QInt8)` 是官方动态量化 API，动态量化不用校准数据，默认 `per_channel=False`、权重对称（https://onnxruntime.ai/docs/performance/model-optimizations/quantization.html ；https://github.com/microsoft/onnxruntime/blob/main/onnxruntime/python/tools/quantization/quantize.py 的 `DynamicQuantConfig` 与 `quantize_dynamic` 文档字符串）。
10. Pi 提供的是模型调用/Agent 循环（ADR 0198：`@earendil-works/pi-ai`、`pi-coding-agent`），Himawari 的嵌入路径本来就是自有的 `GatewayEmbedder`；只有 `packages/runtime-pi` 能 import `@earendil-works/pi-*`（.agents/instructions/pi-and-workspace.md:27）。Pi 是否有现成嵌入 API：**未核实**（同级 pi-mono 检出不在此工作区），但即使有，也属于模型运行时域而非本仓引用边界内。

**推测的**

- onnxruntime-node CPU 在同机同文件下逐次推理字节级确定（常见行为，但未在本机验证，需要用测试证实，见下文测试 8）。
- `quantize_dynamic` 对同一 fp32 输入在同版本工具链下产出逐字节相同的文件（动态量化无随机性，但未验证，需要“跑两次比 sha256”证实）。
- 服务启动时对 571 MB 文件算 SHA-256 约 1–2 秒（常规磁盘速度推算）。

## 二、方案

### 1. 模块划分

- **`packages/memory-engine/src/embedding.ts`**：`Embedder` 接口加可选第二参 `role?: "query" | "document"`；`GatewayEmbedder` 忽略它（外网 8B 行为字节不变，指令仍走 `queryInstruction`）。契约不变：请求仍是 `{model, input, dimensions}` 的 OpenAI 兼容形状，响应仍是 `EmbeddingResponse`。
- **新包 `packages/embedding-local`**（平台适配器包，与 memory-engine 解耦，避免 onnxruntime-node 原生二进制拖进所有使用方）：实现 `LocalOnnxEmbedder`，依赖精确版本的 `@huggingface/transformers@4.3.1`，配置项：`modelPath`、`tokenizerDir`、`pooling: "last_token"`、`queryPrefix`、`documentPrefix`、`model`、`dimensions`、`modelSha256`。加载时 `env.allowRemoteModels = false`，只从本地目录读，杜绝运行时偷偷联网。
- **`apps/agent-service/src/production-memory-composition.ts`**：按 `descriptor.provider` 分派——`vercel-ai-gateway` 走现有 `GatewayEmbedder` 分支（含 secretRef、8B 指令），`local-onnx` 走 `LocalOnnxEmbedder` 分支（无密钥）；删掉“阈值默认值只认 8B”的分支（见 §3 配置）。`queryInstruction`/前缀机制互斥，谁也不碰对方的输入字节。
- **`packages/platform-node/src/strict-configuration.ts`**：embedding 描述符的 `rejectUnknown` 清单加 `"local"`；新增 `local` 块解析：`modelPath`（必须绝对路径且在状态目录树下）、`modelSha256`（64 位十六进制）、`pooling`（只允许 `"last_token"`，其余值拒绝并提示不支持）、`queryPrefix`/`documentPrefix`（可选字符串）。`provider === "local-onnx"` 时要求 `local` 块存在、`secretRef` 为 null；`vercel-ai-gateway` 的既有特例保持不变。
- **调用点**（hybrid-memory-provider.ts:102/:144、episodes.ts:226/:301/:342）：搜索传 `role: "query"`，写入传 `role: "document"`。

### 2. 照旧经过统一出口（关键点）

`LocalOnnxEmbedder` 不另开 HTTP、也不绕开遮盖：它的 `#send` 仍然构造与外网完全相同的请求体 `{model, input, dimensions, encoding_format: "base64"}`，仍然调用 `egress.exchange(ctx).wrapFetch(本机函数)`，URL 用 `http://127.0.0.1/embeddings`。出口层按路径尾缀选中 `redactEmbeddings`，对 `input` 做遮盖、记账 sightings——model-egress.ts 只看路径尾缀和 body（前提 1），不区分主机，所以**本机模型走的是和外网逐字节相同的遮盖代码路径，model-egress.ts 一行不用改**。`本机函数` 拿到遮盖后的 JSON，跑 tokenizer + ONNX，返回合成的 `EmbeddingResponse`：`data[0].embedding` 为 base64 Float32、`usage.prompt_tokens = usage.total_tokens = tokenizer 计数`、`providerMetadata.gateway = { generationId: sha256(请求体) 前 32 位, routing.finalProvider: "local-onnx", cost: {input:0, output:0, cacheRead:0, cacheWrite:0} }`——这刚好满足 `gatewayEmbeddingUsage` 的全部校验和 `settle` 的 `reportedCostMicros >= 0`（前提 2），边界（期限、分级、预算预留/结算、超时重试）原封不动复用，只是金额恒为 0。

### 3. 配置表达（换模型不改代码）

```json
"modelDescriptors": [{
  "ref": "model-memory-embedding",
  "role": "embedding",
  "provider": "local-onnx",
  "model": "jinaai/jina-embeddings-v5-text-small-retrieval",
  "version": "onnx-dynamic-int8-ort1.22.1",
  "disclosure": "local_only",
  "secretRef": null,
  "capabilities": ["embedding"],
  "allowedDataClassifications": [同现值],
  "cost": { "input": 0, "output": 0, "cacheRead": 0, "cacheWrite": 0 },
  "dimensions": 1024,
  "local": {
    "modelPath": "/var/lib/himawari/state/models/jina-v5-text-small-retrieval.int8.onnx",
    "modelSha256": "<实测 64 位>",
    "tokenizerDir": "/var/lib/himawari/state/models/jina-v5-tokenizer",
    "pooling": "last_token",
    "queryPrefix": "Query: ",
    "documentPrefix": "Document: "
  }
}],
"memory": { "dimensions": 1024, "minimumSimilarity": 0.30, … }
```

- **换模型 = 改配置 + 放文件**：换 Qwen3-Embedding-0.6B int8 就是改 `model`/`dimensions`/`local.*`/`minimumSimilarity`；换回外网 8B 就是把描述符换回 `vercel-ai-gateway` 形状。前缀、pooling、文件、维度全部数据化，代码里不出现新模型名（符合“不在代码里写死模型名”）。
- **阈值**：`memory.minimumSimilarity` 从“可选、8B 时有默认”改为对本地模型直接显式写 0.30（0 < x < 1 的校验已在 strict-configuration.ts:1293-1298）。同时把外网 8B 的默认值分支从 composition 里删掉，改为配置里写死 0.6——阈值跟着配置走，不再跟代码里的模型名走。
- **前缀登记**：`Query: ` 与 `Document: ` 作为两个 fixedPrompt 登记进 prompt-catalog（id 如 `memory.embedding-query-prefix`、`memory.embedding-document-prefix`，layer `"embedding"`，usedBy 指向新包），composition 从 catalog 取值填进 `local` 配置默认值——这样 `check:prompt-catalog` 的门槛自动覆盖它们，也满足“新加提示词要登记并通过检查”。

### 4. 记账与度量

预算预留/结算、期限、数据分级、超时重试全部沿用 production-run-memory.ts 现有边界，无需改动；成本为 0，预算记账里本地嵌入表现为 0 微秒支出 + 调用次数。诊断事件里 `finalProvider = "local-onnx"` 自然区分本地/外网来源。

### 5. 模型文件上生产

- **不进发布包**。发布包是代码 + 锁定 node_modules（scripts/delivery-mode/make-packet.py 的 MATERIAL_FILES），571 MB 二进制会让每次发布膨胀且把发版和换模型耦合。
- **放 `${stateRoot}/models/`**（即 /var/lib/himawari/state/models/）：复用“状态目录在状态树下”的既有校验思路（strict-configuration.ts:1301-1304 的先例），随状态盘备份/迁移走，且不随发版回滚消失。
- **首次上机是独立停止点**：先在本机/Hermes 用 `scripts/ci/verified-download.mjs` 的 `downloadVerified({url, sha256})` 拿官方 fp32 `model.onnx`（URL 带 HF commit 锚定 revision），跑 §6 的量化脚本得到 int8 文件并记录 sha256；向测试机/生产机拷贝前按约束先问 Andy，一次操作、留记录。注意 `downloadVerified` 的缓存单条上限 512 MB（verified-download.mjs:19），571 MB 文件会自动跳过缓存直接下载，行为正确无需改。
- **启动校验**：服务启动加载模型前对文件算 SHA-256，与 `local.modelSha256` 不符就拒绝启动——配置里的哈希把“文件在哪、是哪个文件”钉死。

### 6. 量化可复现性

新增 `scripts/embedding/quantize.py`（或 .mjs 调 Python），内容：pinned `onnxruntime==1.22.1`、pinned onnx 版本；输入 = 官方 fp32 `model.onnx`（记录其 sha256 和 HF commit）；调用 `quantize_dynamic(input, output, weight_type=QuantType.QInt8)` 全默认参数（前提 9）；输出文件 sha256 写进脚本旁的 manifest（`source-sha256`、`tool-versions`、`output-sha256`、`output-bytes`）。验证方式：同输入同版本连跑两次，两次输出 sha256 必须一致——不一致就说明不可复现，阻止上线。评测用的 int8 文件与 manifest 一起归档（本机留存 + Andy 批准后上机），仓库只进 manifest。

### 7. 重建索引与切换期间

- 改配置（model 变 1024 维）后，启动时 `listUnindexed`/`listUnembedded` 自动把**全部**旧向量行挑出重排（前提 3），不需要新迁移代码；“不考虑旧数据兼容、做彻底”正好落在这套现有机制上：旧 4096 向量不删也不读，被同模型同维度过滤天然隔离。
- **切换期间行为**：向量信号逐条补齐前，检索由关键词 + 实体 + 融合排名承担（结构不变）；已补的行立即参与向量召回，新旧向量不会混算。本地 26 ms/句（云端实测），几千条记忆是分钟级；重排批量走投影队列限速，不抢对话请求。
- 兜底：`memory.reindex` 管理命令可手动触发/补漏；投影失败重试沿用现有 attempt/lease。

### 8. 断网检索测试

`LocalOnnxEmbedder` 的 send 不触碰全局 fetch。集成测试：`globalThis.fetch` 换成一律 throw 的桩（或 undici dispatcher 拒绝非回环地址），配 `LocalOnnxEmbedder` + 真实 SQLite 跑 `search`，断言返回融合结果且向量信号在——这就是“外网一抖聊天也没有记忆”的反例测试；外网 embedder 在同桩下必须失败（红绿对照）。

### 9. 评测脚本

live.test.ts/live.mjs 把写死的 `QWEN3_8B` 换成按环境变量选择 embedder：`HIMAWARI_MEMORY_EVAL_EMBEDDER=gateway|local`；local 模式从 `HIMAWARI_MEMORY_EVAL_MODEL_PATH` 等读文件、费用上限不适用（记 `costMicros: 0`），round.json 增加 `model`、`modelSha256`、`provider` 字段；thresholds 机制沿用（含 0 与 0.30 两档对比）。评测基线：开工具前先用现有数据集对比新旧模型命中率，差距明显就停下给 Andy 看（BL-008 已有此约定）。

### 10. 要加的测试（每条含反向用例）

1. `LocalOnnxEmbedder` 单测：维度/归一化/`role` 选前缀；**反向**：`role:"query"` 与 `role:"document"` 输出向量必须不同（前缀丢了测试即红）。
2. 出口遮盖：输入含银行卡号/密码时，sightings 有上报、送进模型的是遮盖后的文本（喂给 ONNX 的字符串断言）；**反向**：构造绕开 egress 的用法，断言 embedder 拒绝（镜像 `EMBEDDING_BOUNDARY_REQUIRED`）。
3. 记账合成响应：`gatewayEmbeddingUsage` 通过、`settle(0)` 被调；**反向**：去掉 `providerMetadata.gateway` → `EMBEDDING_GATEWAY_METADATA_MISSING`。
4. strict-configuration：local 块解析、`memory.dimensions` 相等、`secretRef` 必须为 null、`pooling` 白名单；**反向**：local-onnx 缺 `local` 块、维度不一致、带 secretRef、未知 pooling 各一条，均须失败。
5. composition 分派：local-onnx 无密钥可装配；**反向**：`secretRef` 非空拒绝。
6. 启动哈希：文件被改一字节 → 启动失败（先红后绿：注入篡改文件断言拒绝）。
7. 确定性：同文本两次 embed 逐字节相等。
8. 断网检索（§8，红绿对照）。
9. 切换重建：改 model 串后 `listUnindexed` 返回旧行（integration）。
10. 复现性脚本：两次量化 sha256 相等（CI 跳过重跑，用 manifest 存档比对）。

### 11. 文档

ADR 0213（换向量模型与服务方：决定、后果、许可 CC BY-NC 4.0 的说明）+ 威胁模型小节（正文加密存储；关键词/向量索引从明文派生；防备份与导出泄露、不防本机入侵，引用 C4）+ 关闭 BL-20261028-008。

## 三、考虑过但不选的做法

1. **给 ModelEgress 加“本机嵌入专用遮盖 API”**：要在共享出口上开新口子、加规则分支，而现有 `/embeddings` 路径遮盖器零改动可复用（前提 1），选后者。
2. **用 llama.cpp / TEI 单独起进程开端口**：违背“不另开进程或端口”（BL-008 方案原文），多一个部署面和故障点。
3. **模型文件进发布包**：包膨胀 571 MB、换模型要发版、回滚会把模型一起卷回去；放状态目录更符合数据自持。
4. **双索引灰度（新旧向量并存）**：主人已定不考虑旧数据兼容、做彻底；现有模型过滤已保证不混算，双索引只加复杂度。
5. **把阈值默认值继续按模型名写在代码里**：正是“写死模型名”的反面教材；改为配置显式。
6. **把 `@huggingface/transformers` 塞进 memory-engine**：原生依赖会拖累所有使用方；独立适配器包与仓库 platform-adapter 惯例一致。
7. **沿用 `queryInstruction` 机制给 jina 拼 `Query: `**：8B 的 `Instruct: …\nQuery:…` 是外网 8B 的任务指令（catalog purpose 明说改了会对不上已存向量），与 jina 的双前缀语义不同；且文档侧没有对称机制。改成 `role` 参数 + 前缀配置更通用。

## 四、风险与反例

- **精度下降**（4096→1024 维、int8 量化）：0.30 阈值是未验证的假设。反例：某类查询命中数骤降。缓解：开工具前跑评测集对比，不达标交 Andy。
- **ONNX 推理不确定**：同输入两次向量不同 → 确定性测试红、缓存语义被破坏。缓解：测试 7；真发生则固定 ORT 线程数/禁用并行归约。
- **内存 +1.1 GB 常驻**（实测），生产 10-28 时可用 6.6 GB：加载失败或 OOM。缓解：启动就绪预算里计入加载 2.2 s；监控进程 RSS。
- **`redactEmbeddings` 对本机路径的误伤**：遮盖后文本进的是本机模型，占位符会参与语义——这与外网现状一致（外网模型也只见遮盖后文本），不新增风险，但评测要在遮盖开启下跑。
- **量化文件不可复现/被替换**：sha256 钉死 + 启动校验失败即拒绝启动（测试 6）。
- **I-73 式“两端校验”残留**：`safeReference` 已允许斜杠（strict-configuration.ts:96），`embedding_model` 无第二校验器（前提 4），但新 `local` 块的每个键、`finalProvider` 字符串要按测试 3/4 把两端（产生=解析器/合成响应，使用=校验/记账/SQL 匹配）都过一遍。

## 五、需要人拍板的取舍

1. 模型文件放 `${stateRoot}/models/`（随状态备份走、复用校验）还是独立目录（省备份空间）——我推荐前者。
2. CC BY-NC 4.0 为非商业许可：自托管个人使用没问题，但若未来对外提供服务需重新评估——建议写进 ADR。
3. 评测对比若显示新模型明显变差，是否接受用更大模型（0.6B int8）或降阈值换召回。
4. 首次向生产机传模型文件的操作窗口（按约束需 Andy 批准）。

## 六、必答问题逐条回答

**1. 会不会改变模型已经见过的请求开头？**
不会。嵌入是后台辅助调用（prompt-prefix 规则第六节“后台调用”，.claude/rules/prompt-prefix.md:65-66），不进入对话请求；检索结果的注入机制不变，仍只落在每轮最后一条消息。系统提示、工具定义、历史消息、遮盖结果的组装代码零改动；`check:prompt-prefix` 的逐字节比对和反向用例照跑照过。发给模型的内容仍然只在末尾追加，每轮会变的值仍在最后一条消息里——本改动没有引入任何新的每轮变化值。

**2. 会不会让同一段文字在不同请求里变成不同字节？**
本改动不碰消息字节。嵌入输入侧：遮盖仍是确定性的（规则第 11 条，且遮盖代码未改）；前缀是常量；ONNX 推理在同 pinned 文件（启动哈希校验）+ pinned 运行时下应逐字节相同，由测试 7 证实，不确定即阻断。集合/JSON 无新无序结构。唯一漂移源是将来换 tokenizer/ORT 版本——那属于换模型，会触发全量重建而非静默不一致。

**3. 有没有对应的自动检查，反向用例真的会失败？**
有，见 §10 十条：每条都写了红绿反向（前缀丢失、绕开出口、缺网关元数据、缺 local 块、维度不齐、带 secretRef、错误 pooling、篡改模型文件、断网外网 embedder 必败、量化不可复现），全部进 `npm run check`。

**4. 产生/修改的每个值，使用端都能接受吗？**
- `provider: "local-onnx"`：产生于配置解析（strict-configuration.ts 新分支，provider 本无白名单）；使用端 production-memory-composition.ts:58 目前直接抛错——本方案改它，是唯一需要双侧同步的端；`gate.begin` 的 provider 字段（production-run-memory.ts:226）只透传记账，接受任意稳定串。
- `model: "jinaai/…"`：`safeReference` 允许斜杠（strict-configuration.ts:96，与 I-73 的 `machineString` 不同）；入库/查询两端都用同一配置串做相等比较（前提 4），无第二校验器。
- `dimensions: 1024`：两端校验已存在且闭合——`memory.dimensions` 相等（strict-configuration.ts:1311-1320）、composition 相等（composition.ts:62）、边界请求检查（production-run-memory.ts:136）、向量 blob 长度（sqlite-memory-operations.ts:1413-1418）、响应校验（embedding.ts:86）。
- `minimumSimilarity: 0.30`：解析校验 (0,1)（strict-configuration.ts:1293-1298）→ HybridMemoryProvider 构造校验（hybrid-memory-provider.ts:51-53）→ 搜索 SQL 使用；composition 里删 8B 默认分支后不再有第三端。
- `cost 0 / finalProvider / generationId`：产生于合成响应；使用端 `gatewayEmbeddingUsage`（结构校验）、`settle`（≥0 即可，production-run-memory.ts:184-190）、诊断展示——全部闭合。
- `local.modelPath/modelSha256/pooling/前缀`：产生于配置解析（新，测试 4 覆盖），使用于启动加载器（新，测试 6 覆盖）与 prompt-catalog 门槛（前缀登记后自动覆盖）。
- 新依赖 `@huggingface/transformers@4.3.1`：精确版本、只进新包，符合 pi-and-workspace.md:26-27 的写死规则。
