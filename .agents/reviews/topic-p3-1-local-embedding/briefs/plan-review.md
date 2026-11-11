# 线程方案：P3-1 记忆向量改在本机算（jina v5 small int8，可灵活切换）

问题、目标、约束和已核对事实同 plan.md。下面是线程的方案，请找漏掉的场景、判断错的地方、和业界成熟做法不一致的地方。

## 1. 模型档案（代码）+ 选择（配置）
- 新建 `packages/memory-engine/src/embedding-profiles.ts`：每个支持的模型一份“档案”，写明 id、维度、pooling（last_token/mean/模型自带 sentence_embedding）、查询和文档的输入格式、建议阈值、运行方式（local-onnx 或 gateway）。首批四份：jina-v5-text-small-retrieval（默认）、qwen3-embedding-0.6b、embeddinggemma-2、qwen3-embedding-8b（外网）。
- 查询/文档前缀（"Query: "、"Document: "、"task: search result | query: "、Qwen 的 Instruct 句）登记进 packages/prompt-catalog（现有 MEMORY_EMBEDDING_QUERY_INSTRUCTION 旁边），档案引用目录条目。
- 配置 `modelDescriptors[role=embedding]` 增加 `provider: "local-onnx"`，`disclosure: "local_only"`，`secretRef: null`，`model` 必须是已知档案 id，新增字段 `artifact: { path, sha256, bytes }`（模型文件在状态目录下，例如 /var/lib/himawari/state/models/<id>/<sha256>.onnx，外加 tokenizer.json、config.json 各自带哈希）；`memory.minimumSimilarity` 不写时取档案建议值。strict-configuration 对 local-onnx 校验：档案存在、维度与档案一致、文件路径在状态目录下。
- 切换 = 改配置里的 model/artifact/dimensions + 重启。已知档案之间切换不改代码；新模型要加一份档案（几十行）+ 目录条目。

## 2. 本机推理怎么经统一出口
- 新建 `LocalOnnxEmbeddingServer`（memory-engine 内）：进程启动时用 `@huggingface/transformers` 4.3.1（写死版本，`env.allowRemoteModels = false`，只读本地文件并先核对 SHA-256）加载模型；对外暴露一个 fetch 形状的函数，只接受 `POST local://embedding/v1/embeddings`，返回 OpenAI 兼容响应（base64 向量 + usage.prompt_tokens + cost 0 + providerMetadata）。
- 现有 `GatewayEmbedder` 改名为 `OpenAiCompatibleEmbedder`，baseUrl 和 fetch 由组装处注入；本机时 fetch = 上面的函数。请求仍经 `egress.exchange(ctx).wrapFetch(fetch)`，所以遮盖、拒绝和出口记录和外网完全一样。前缀在出口之前由档案拼好（和现在 Instruct 句一样，遮盖规则不碰固定文字）。
- 记账：usage 解析按 provider 分：外网照旧要求网关元数据；本机要求 prompt_tokens（由 tokenizer 算）且 cost=0；预算预留的 estimatedCostMicros 为 0。
- 每次只送一句（不批量），避免出口的“前面见过的值后面也遮”让同一句在不同批次遮成不同字节。
- 嵌入边界现在首次尝试 3 秒超时后重试（production-run-memory.ts:305-318 的 FIRST_EMBEDDING_ATTEMPT_MS）：本机模型改为启动时预加载完成后才接请求；加载未完成时向量检索按失败处理、退回关键词和实体，不让首轮聊天卡住。
- `memory.minimumSimilarity` 改为必填，删掉 production-memory-composition.ts 里按 8B 模型名给默认阈值的分支。
- scripts/check-egress-redaction.mjs 的允许文件和必须调用清单加入新文件。
- 推理放在主线程的 onnxruntime-node 异步调用里（它本身在原生线程池执行，不阻塞事件循环）；intraOpNumThreads 设为 CPU 数一半，避免和服务抢 CPU。并发请求排队（一次一句）。

## 3. 模型文件上生产
- 不进发布包（571 MB）。用仓库里的 `scripts/ci/verified-download.mjs` 同类做法：新脚本 `scripts/operations/fetch-embedding-model.mjs <档案 id>`，从 Hugging Face 固定 revision 下载 fp32 ONNX、tokenizer、config，按锁文件里的 SHA-256 校验；int8 由同一脚本调用固定版本的量化步骤生成，再校验结果哈希（锁文件 `packages/memory-engine/embedding-models.lock.json` 记 revision、每个文件 SHA-256、量化工具版本、产物 SHA-256）。若量化结果在不同机器上字节不一致，则改为：量化一次，把 int8 产物作为发布材料上传（GitHub Release 资产），锁文件记它的哈希。
- 部署前检查（deploy-preflight）：配置指向的模型目录在状态目录下、manifest 和每个文件 SHA-256 一致、磁盘够，否则不切换；服务启动只核对 manifest 和文件大小（全量哈希放预检，避免拖慢启动）。下载到 Hermes 和生产机前先问 Andy。
- 发布包清理时保留“当前版和回退版”配置引用的模型目录。部署维护脚本（verify-switch-config-fixtures.py、maintenance/verify-fixtures.mjs）现在把嵌入维度变化当未批准变更，要放行新字段并保留反向用例。
- 回退到外网 8B 也要重算一次索引，ADR 里写明。
- onnxruntime-node 的原生库（linux-x64）随 node_modules 进发布包，发布包会变大约 50–80 MB。

## 4. 重建索引和切换期间
- 不加迁移：索引行本来按 embedding_model + embedding_dimensions 存，现有启动逻辑（service-main.ts:1183）会把模型不一致的记忆重排进投影队列，`backfillEmbeddings` 补对话片段。新模型几百条记忆几十秒内重算完。
- 索引键改存“模型身份”`identity = <档案 id>@<模型文件 sha256 前 12 位>`（外网保持 model 原值），这样同名模型换量化文件或前缀时也会触发重算。所有写入和查询（记忆、对话片段、启动补索引、评测）统一用 `embedder.identity`。
- `listUnembedded` 现在 `JOIN memory_episode_terms`（sqlite-memory-operations.ts:1397），没有词表条目的片段不会被补算：改成不依赖 terms。`himawari-admin memory reindex` 现在只清 memory_search_index（sqlite-memory-maintenance.ts:74），补上清对话片段向量。
- 切换期间旧向量不参与查询（按模型过滤），只剩关键词和实体（评测下限命中率 0.725），算完自动恢复。
- 重算完成后旧模型的向量行被覆盖；不再需要清理。

## 5. 评测和测试
- 评测脚本 live.mjs / live.test.ts 增加 `--embedder <档案 id>`：本机档案不花钱、不需要 --confirm-cost；外网照旧。history.jsonl 只追加。round.json 增加 loadMs、单句耗时。
- 单元测试：档案前缀拼接、配置校验（local-onnx 正反例）、本机 fetch 函数只接受 /embeddings、哈希不符拒绝加载、usage 解析（本机 cost=0）。
- 集成测试：用一个极小的 ONNX 测试模型（几百 KB，仓库内）跑完整链路：写记忆 → 投影 → 断网（fetch 抛错）检索仍命中；出口遮盖确实作用于本机请求（输入里放银行卡号，断言送进模型的是遮盖后的文本）。
- 真实模型测试放 qualification 项目（需要模型文件，不在每次 CI 跑）。

## 6. 文档
- ADR（编号开工时核对，约 0216）：换成本机 jina v5 small int8、保留外网可选、许可（CC BY-NC，非商用；收费前换 Qwen3-0.6B）、档案机制。
- 威胁模型文档：记忆正文加密，关键词索引（FTS）和向量从明文派生；防备份和导出泄露（备份和导出里是否带索引要核对），不防本机入侵。
- 关闭 BL-20261028-008。

## 风险
- 内存 +1.1 GB；生产机 6.6 GB 可用。
- 自量化文件的可复现性。
- 并发对话时排队导致检索变慢。
- P3-3（融合后截断去重）同时在改融合排名，阈值可能要在它合并后重测。
