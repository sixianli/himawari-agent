你是独立的方案设计者。
你能用的工具：read、grep、glob、websearch、webfetch，以及 git diff、git log、git show、git blame、git status 这几条 git 命令。不能修改任何文件，不能运行别的命令。可以用 websearch 搜索、用 webfetch 读网页；业界做法只认一手来源（官方文档、各大 AI 公司的工程文章、成熟开源项目的源码），每条都附网址。
下面只给了问题、目标和约束，没有给出任何人的方案；材料里如果提到某种做法，只作参考。先读代码弄清现状，再独立提出你认为最好的方案，不要假设已经有人想好了答案。
做法：先想清楚要回答哪几个问题、需要看哪些文件或资料，再直接去读这些地方；不要漫无目的地浏览代码，也不要用相同或相近的参数反复调用工具。读到的内容一旦足以下结论，就停止调用工具，写出结论；没读到的地方标「未核实」，不要为了查全而一直查下去。
列出的方案只是参考，请从问题本身出发，提出你认为更好的方案。
必答问题：
1. 这个改动会不会改变模型已经见过的请求开头？包括系统提示、工具定义、历史消息、遮盖结果。要求回答：发给模型的内容是不是仍然只在末尾追加，每轮会变的值是不是都在最后一条消息里。依据：[发给模型的内容只追加](../../.claude/rules/prompt-prefix.md#rules)。
2. 这个改动会不会让同一段文字在不同请求里变成不同的字节（例如依赖前后文的遮盖、带时间的字段、无序的集合）？
3. 改动有没有对应的自动检查，反向用例是否真的会失败？
4. 改动产生或修改的每个值（标识、字段、配置键、清单项、序列化格式），每一个使用它的地方都能接受吗？逐个找到产生它的地方和使用它的地方，核对两端的校验，只看改动本身不够。依据：[I-73](../../docs/incidents-and-gates.md#incidents)，双模型复核只看了改动，没问“清单里的 id 能通过后端校验吗”。
输出格式：先列方案依赖的前提，每个前提附来源（文件:行或网址）和原话；再写方案本身、考虑过但不选的做法及原因、风险和反例、需要人拍板的取舍。把「读代码或来源证实的」和「推测」分开写。最后逐条回答必答问题。用简体中文。

---- 本次材料 ----
仓库就是当前目录，已检出 aa1b0b0b551f5d7843ac0f7120f649f74bf12e5f。
问题、目标和约束：
# P3-1：找记忆用的向量模型从外网服务改为在服务进程本机计算

## 问题
Himawari 按意思找记忆前，要把一句话变成一串数字（向量）。现在这一步经 Vercel AI Gateway 调外网的 alibaba/qwen3-embedding-8b（4096 维）。这与产品原则“自有优先、数据自持”（docs/product-vision.md）矛盾，外网一抖聊天就没有记忆；生产实测向量化网络请求中位数约 1392 ms（docs/backlog/BL-20261028-008-local-memory-embedding.md）。

## 目标
1. 生产默认用本机模型算向量：jinaai/jina-embeddings-v5-text-small-retrieval（Qwen3 架构，677M 参数，1024 维，last-token pooling，查询前缀 "Query: "、文档前缀 "Document: "，许可 CC BY-NC 4.0）。官方只提供 fp32 ONNX（2.3 GB）；评测用的是用 onnxruntime 1.22.1 `quantize_dynamic(QInt8)` 自己转出的 571 MB int8 文件。主人（Andy）已选定这个模型，阈值 0.30。
2. 主人要求：设计要方便以后灵活切换模型（例如换成 Qwen3-Embedding-0.6B int8 或 EmbeddingGemma 2，或换回外网 8B），不改代码或尽量少改。
3. 断网时检索可用（向量 + 关键词 + 实体 + 融合排名都在本机）。
4. 现有记忆和对话片段的向量全部改用新模型重算（重建索引）。
5. 写一条 ADR（换向量模型和服务方），以及一段威胁模型文档：记忆正文加密存储，但关键词检索索引从明文派生；它防备份和导出泄露，不防本机入侵（已定决策 C4）。关闭 Backlog BL-20261028-008。

## 约束（来自仓库规则或主人的决定）
- 外网网关保留为可选。
- 嵌入请求必须照旧经过统一出口 ModelEgress（packages/application/src/services/model-egress.ts，先遮盖密钥、密码、验证码、银行卡号、证件号，并记账），即使是本机模型也不能绕开。
- 不改检索结构（向量 + 关键词 + 实体 + 融合排名）。
- 新加或改动的提示词要登记进 packages/prompt-catalog 并通过它的检查。
- 识别敏感内容的规则只能写在专门的那个包里。
- 依赖版本写死；不在代码和评测里写死 anthropic/、openai/ 模型名；能动态获取的不写死。
- 不写代码注释。新测试要进仓库自动检查。
- 往测试机或生产机下载模型文件前要先问主人。
- Pi 优先规则（.agents/instructions/pi-and-workspace.md、docs/pi-development-guide.md）：只有 packages/runtime-pi 可以引用 @earendil-works/pi-*；Pi 是否提供嵌入能力需核对。
- 不考虑旧数据兼容，做彻底（主人 11-09 定）。

## 已核对的事实（文件:行）
- packages/memory-engine/src/embedding.ts：`GatewayEmbedder` 经 `egress.exchange(ctx).wrapFetch(fetch)` POST `${baseUrl}/embeddings`（OpenAI 兼容格式，base64 返回）；常量 `QWEN3_EMBEDDING_8B_*`、`QWEN3_MEMORY_MINIMUM_SIMILARITY = 0.6`；`instructedQuery()` 生成 `Instruct: …\nQuery:…`。
- packages/application/src/services/model-egress.ts:263-267：出口按请求路径选遮盖方式，`/embeddings` 走 `redactEmbeddings`（遮 `input` 字段）。
- apps/agent-service/src/production-memory-composition.ts:57-108：只接受 `provider === "vercel-ai-gateway"`；必须有密钥；`queryInstruction` 只在 8B 时给；`minimumSimilarity` 取配置或 8B 默认值。
- packages/platform-node/src/strict-configuration.ts:262-345、1279-1320：模型描述字段 ref/role/provider/model/version/allowedDataClassifications/disclosure(local_only|trusted_remote|external_remote)/secretRef/capabilities/cost/dimensions；provider 为 vercel-ai-gateway 时 model 必须是 8B、维度 4096 或 1024；`memory.dimensions` 必须等于嵌入模型维度；`memory.minimumSimilarity` 可选。
- apps/agent-service/src/production-run-memory.ts:100-318：嵌入边界（boundary）负责期限、数据分级、预算预留/结算（结算要求 `reportedCostMicros`），超时重试一次。
- packages/persistence-sqlite/src/sqlite-memory-operations.ts:1384-1490：索引和对话片段按 `embedding_model` + `embedding_dimensions` 存，查询只用同模型同维度的向量；`listUnindexed`/`listUnembedded` 会列出模型或维度不一致的行；apps/agent-service/src/service-main.ts:1183-1198 启动时把这些记忆重新排进投影队列；packages/memory-engine/src/episodes.ts:268 `backfillEmbeddings` 补对话片段向量。
- 评测：evals/memory-retrieval/dataset.json + test/integration/memory-retrieval-eval/live.test.ts + scripts/memory-retrieval-eval/live.mjs（现在只支持外网 8B，要确认花费）。
- 上线：scripts/delivery-mode/make-packet.py 在 Hermes 上构建 `linux-x64-abi127-<commit>-*.tar.gz` 发布包；scripts/ci/verified-download.mjs 有按 SHA-256 校验的下载工具。生产状态目录 /var/lib/himawari/state，生产机 10-28 时可用内存约 6.6 GB。
- 云端实测（4 核）：`@huggingface/transformers` 4.3.1（底层 onnxruntime-node）用 `pipeline("feature-extraction", repo, { dtype: "q8" })` + `{ pooling: "last_token", normalize: true }` 可跑；加载约 2.2 s，常驻内存约 +1.1 GB，单句约 26 ms。

## 想请你回答
给出完整方案：模块怎么分、配置怎么表达“哪个模型、文件在哪、前缀、pooling、维度、阈值”、怎样经统一出口、怎样记账、模型文件怎么上生产（下载、校验、放哪、进不进发布包）、自己量化文件的可复现性、怎样重建索引和切换期间的行为、断网检索怎么测、评测脚本怎么改、要加哪些测试、风险。
