## 结论（按严重度）

### 1. 【中】【读代码证实】每日摘要补算的“跳过坏的一条”没有覆盖生产上的 `limit: 1` 调用，一条永久失败的摘要会一直挡住后面的摘要

- 位置：`packages/memory-engine/src/episodes.ts:286-314`；`apps/agent-service/src/production-memory-episodes.ts:77-89`；`apps/agent-service/src/service-main.ts:1530-1547`
- 问题：`backfillEmbeddings` 在页内逐条 `catch` 后 `continue`，但只有 `failure && embedded === 0` 才抛错。生产每轮运行调用它时 `limit: 1`，于是每次只取最老的一条未嵌入摘要；若这条是永久失败（例如超过 `EMBEDDING_INPUT_LIMIT` 的 16 KiB，或超过本机 8192 token），它永远不会被标记、也不会被跳过，`ORDER BY created_at, id` 会每轮都返回同一条。后续摘要因此永远拿不到向量；`catch` 还会把错误吞掉，只调用一次 `onFailure`，没有“跳过了 N 条”的诊断。
- 证据：
  - `packages/memory-engine/src/episodes.ts:313`：`if (failure && embedded === 0) throw failure.error;`
  - `apps/agent-service/src/production-memory-episodes.ts:77-89`：`backfillEmbeddings({ ... limit: 1 ... }).catch(this.#options.onFailure)`
  - `apps/agent-service/src/service-main.ts:1545-1546`：`if (embedded === 0) break;`
- 建议：给补算加持久化的失败标记/重试时间（或在本轮内维护“已失败 episode id 集合”并支持游标），让 `limit: 1` 能前进到后面的条目；单独记录被跳过的条数和原因。仅靠“一页全失败才抛错”不能解决 limit=1 的饥饿。

### 2. 【中】【读代码证实】把所有 `NOT_AUTHORITATIVE` 都当成“本轮已不归我”，会吞掉真实的边界/执行上下文配置错误

- 位置：`apps/agent-service/src/production-run-memory.ts:377-379`；`apps/agent-service/src/production-memory-composition.ts:151-153`；`packages/memory-engine/src/embedding.ts:230-236`
- 问题：抑制检索降级记录的条件是“信号已中止，或错误码是 `NOT_AUTHORITATIVE`”。但 `NOT_AUTHORITATIVE` 也用于真实故障：
  - `EMBEDDING_BOUNDARY_REQUIRED`：边界没有绑定，通常是启动/装配 bug；
  - `EMBEDDING_EXECUTION_CONTEXT_REQUIRED`：调用方没带 run/lease/分类，可能是调用路径错误；
  - `EMBEDDING_ADMISSION_REQUIRED`：准入解析返回空。
  这些情况下检索会静默退回关键词/实体，且**不写检索降级决策记录**，线上很难发现。
- 证据：
  - `production-run-memory.ts:377-379`：
    ```ts
    (error) =>
      scope.getStore()?.signal?.aborted === true ||
      (error instanceof ApplicationPortError && error.code === PORT_ERROR_CODES.NOT_AUTHORITATIVE),
    ```
  - `embedding.ts:232-236`：没有边界时抛 `new ApplicationPortError(PORT_ERROR_CODES.NOT_AUTHORITATIVE, "EMBEDDING_BOUNDARY_REQUIRED")`
- 建议：只对“确认是取消/失去执行权”的错误抑制，例如同时要求 `signal.aborted` 为真，或匹配明确的错误消息（`EMBEDDING_EXECUTION_CONTEXT_REQUIRED` 的取消分支）和准入 `NOT_AUTHORITATIVE`，不要按整个错误码一刀切。

### 3. 【低】【读代码证实】向量身份从“纯模型名”改成 `模型名#哈希`，即使文字和模型都没变，也会让全部旧向量在升级后失效并触发重算

- 位置：`packages/memory-engine/src/embedding.ts:209`；`apps/agent-service/src/production-memory-composition.ts:163-167`；`apps/agent-service/src/service-main.ts:1205-1222`
- 问题：旧版 `GatewayEmbedder` 用 `this.model = options.model`（纯模型名）写入 `memory_search_index.embedding_model` / `memory_episodes.embedding_model`；新版 `EgressEmbedder` 用 `this.model = options.identity`（`模型名#sha256前16位`）。所以升级后 `listUnindexed` 会把所有旧记忆判为未索引，启动时 `requeueStaleMemoryVectors` 全部重新排队；如果仍配置网关模型，会重新产生一次全量外部嵌入费用。ADR 说的是“配方任一项变了才重算”，但这里即使配方文字不变，存储格式变化本身也造成全量失效。
- 证据：
  - `embedding.ts:209`：`this.model = options.identity;`
  - `service-main.ts:1211`：`model: embedder.model,`
  - `production-memory-composition.ts:163-167`：返回 `identity`，`HybridMemoryProvider` 用它作为 `embedder.model`
  - 旧代码 diff：`- this.model = options.model;`
- 建议：在 ADR/上线说明里明确“这是一次与配方无关的全量重算”；或对旧纯模型名做兼容映射，避免只想升级代码却产生整库重嵌成本。

### 4. 【低】【读代码证实】出包时嵌入目标校验与服务启动校验并不等价，ADR 的“按服务启动相同的条件核对”说法过强

- 位置：`scripts/delivery-mode/make-packet.py:283-291`；`packages/platform-node/src/strict-configuration.ts:341-391`
- 问题：`make-packet` 对网关目标只检查 `cost` 的键、`capabilities` 是列表、`allowedDataClassifications` 是非空列表，不检查元素值和数值类型，也不校验 `disclosure` 枚举；服务启动会用 `modelCost`（非负数字）、`classifications`（合法分类）、`stringArray`、`safeReference` 等拒绝这些值。因此出包可能接受了启动必拒的目标，等 S7 写入后才失败。
- 证据：
  - `make-packet.py:283-288` 只做 `set(target['cost']) != {...}`、`'embedding' not in target['capabilities']`、`isinstance(... list)` 等检查；网关分支只要求 `secretRef` 是非空字符串。
  - `strict-configuration.ts:341-361`：`stringArray`、`classifications`、`modelCost`、`safeReference`；`:390-391` 网关还要求 `secretRef`。
- 建议：把目标校验抽成与启动解析共用的一份规则（或在出包里直接调用同一份 schema），至少补齐 `disclosure`、分类枚举、`capabilities` 元素、`cost` 数值与 `ref/version` 的 `safeReference` 约束。

### 5. 【低】【读代码证实 + 一处推测】部署前模型目录检查比运行时校验宽松，且对畸形 `artifactSha256` 会抛 `TypeError` 而不是干净拒绝

- 位置：`scripts/delivery-mode/embedding-artifact-check.py:51-68`；`packages/platform-node/src/local-onnx-embedding.ts:105-135`；`scripts/delivery-mode/make-packet.py:285`
- 问题：
  - 运行时要求 `manifest.dimensions === 配置维度`（`local-onnx-embedding.ts:124-125`），并要求 manifest 文件集合只能是 required ∪ optional（`:91-98`）；部署前脚本只查 schema/model/required 子集，不查 dimensions，也允许额外文件。于是预检可能显示 `ok`，服务加载却报 `EMBEDDING_ARTIFACT_PROFILE_MISMATCH` / `EMBEDDING_ARTIFACT_FILES_INVALID`，静默退回关键词。
  - `make-packet.py:285` 用 `str(target['artifactSha256'])` 做正则，然后 `set(target['artifactSha256'])`。如果 JSON 里是 64 位整数（字符串化后也匹配 `[0-9a-f]{64}`），`set(int)` 会抛 `TypeError`，而 `embedding_target` 的异常路径没有捕获它。
- 证据：
  - `embedding-artifact-check.py:56` 只比较 `schema`、`model`、`files`；`embedding-artifact-check.py:58-68` 没有 dimensions 检查。
  - `local-onnx-embedding.ts:124-125`：`if (manifest.model !== input.model || manifest.dimensions !== input.dimensions) throw ...`
  - `make-packet.py:285`：`... or set(target['artifactSha256']) == {'0'}`
- 建议：预检复用运行时的 manifest 规则（含 dimensions、文件白名单、目录所有权），并先做 `isinstance(artifactSha256, str)` 再 `set()`。

### 6. 【低】【读代码证实】几处新行为缺少自动检查，反向用例覆盖不完整

- 位置：`scripts/package-node-runtime.mjs:32-48`；`apps/agent-service/test/prompt-rendering-golden.unit.test.ts:218-219`；`test/integration/memory-evaluation.test.ts:561-564`
- 问题：
  - `keepsNativeBinary` 没有任何测试；打包时若过滤器写错，会把当前平台的 ONNX Runtime 二进制删掉，直到部署时才暴露。
  - golden 只测了 `MEMORY_EMBEDDING_QUERY_INSTRUCTION.text`，没有测 `embeddingQueryText(QWEN3_EMBEDDING_8B_PROFILE, q)` 的完整 `Instruct: ...\nQuery:` 字节；`memory-evaluation` 在缓存文本对不上时会自动退回 term-hash，而不是失败，所以前缀被误改也不会让测试变红。
  - `searchCancelled` 没覆盖 MCP/external-read 的 `mailScope`：`production-mcp-read.ts` 把请求 `signal` 放进 `MailEmbeddingContext`，而抑制条件只看 run 的 `scope.signal`；客户端取消 MCP `find_memories` 时仍可能写一条检索降级记录（这条是“推测/未覆盖”，因为还要看具体错误类型）。
- 证据：
  - `package-node-runtime.mjs:32-48` 的过滤函数没有被测试引用。
  - `prompt-rendering-golden.unit.test.ts:218-219` 只快照 instruction 文本。
  - `memory-evaluation.test.ts:561-564` 的 `completeVectors` 返回 `null` 后走 hash 模式。
- 建议：加 `keepsNativeBinary` 单测（当前平台保留、其他平台/架构删除、CUDA/TensorRT 删除）；加 qwen/jina/gemma 完整渲染字节的 golden；为 MCP 取消和 `EMBEDDING_BOUNDARY_REQUIRED` 这类“非取消的真实失败”补反向用例。

---

## 读代码证实的 / 推测的 分开列出

**读代码证实的**
- 合并结果保留了 P3-3 的 `relevance`、`dedupeSameSource`、`onRelevanceUnknown`：`production-memory-composition.ts:140-169`，`hybrid-memory-provider.ts:77-79,167-199`，`service-main.ts:362-372`。
- 本 PR 的取消判断、本机运行时关闭都在：`production-run-memory.ts:360-380`，`production-memory-composition.ts:170-180`，`service-main.ts:588` 注册了 `memoryComposition.close`。
- `NOT_AUTHORITATIVE` 抑制过宽、`EMBEDDING_BOUNDARY_REQUIRED` 会被吞：见发现 2。
- 每日摘要页内跳过、页全失败报错：见发现 1；`limit: 1` 的生产调用会饥饿。
- `make-packet` 与服务启动校验不等价：见发现 4。
- 预检与运行时校验差异、`set(int)` 问题：见发现 5。
- 旧纯模型名 → 新 `model#hash` 会触发全量重嵌：见发现 3。
- `MEMBER_PROMPT_TEXTS` 会收新 embed 前缀，Gemma 查询前缀 29 字符进可信清单：`packages/prompt-catalog/src/trusted.ts:10-13` + `packages/prompt-catalog/src/entry.ts:61-75`；ADR 0224:86 已承认可能改变老对话请求开头一次。
- 本机运行时：畸形请求 400/404、队列上限、取消不返回向量、关闭等待在算的一条，均有代码与单测：
  - `packages/platform-node/src/local-onnx-embedding.ts:266-282`（400/404）、`:330-347`（关闭等待）、`:369-390`（运行中 abort 不返回）。

**推测 / 未核实**
- 提示词最终注入到哪条消息的具体位置未核实；本次 diff 没有改 `runtime-pi`/`context-projection-service` 的组装代码，因此只能确认“新目录项是 embedding 层，不进聊天消息”，不能确认渲染位置。
- ONNX Runtime 多线程下浮点向量是否逐位确定未验证；这属于向量数值而非文本字节问题。
- `prompt-manifest.json` 新增的 SHA 值未计算核对。
- ADR 0224 里 jina 的 `artifactSha256: dcf556...` 是否等于 `build-artifact.py` 实际产物未验证（当前生产实例也没有 `configTargets.embedding`）。
- `EGRESS_RULESET_CURRENT` 是否覆盖“以后新增可信固定文字导致老内容遮盖变化”的情况未核实；这会影响向量身份是否应自动失效。

---

## 侧重检查

- **错误路径**：本机加载失败会进入 `failed`，检索退回关键词；`LocalOnnxEmbeddingRuntime.close()` 会拒绝排队请求、等待在算请求，再释放模型（`local-onnx-embedding.ts:330-347`）。补算的失败路径存在饥饿问题（发现 1）。
- **不合规范/不可信输入**：配置严格解析覆盖本机模型的 `local_only`、无密钥、零成本、`artifactSha256`、档案模型/维度；本机 HTTP 请求校验 model/dimensions/input，畸形请求 400、未知路由 404。出包与预检的校验弱于启动解析（发现 4、5）。
- **安全**：模型目录用固定正则和 sha256 目录名，拒绝符号链接（`local-onnx-embedding.ts:49-63,105-135`）；manifest 文件白名单阻止路径注入；嵌入请求仍走 `ModelEgress.wrapFetch` 遮盖（`local-onnx-embedding.ts` 作为允许出口文件加入 `check-egress-redaction.mjs`）。未发现新增绕过出口的路径。
- **资源耗尽**：本机队列按 interactive/background 分别限 64（`local-onnx-embedding.ts:292-296,369-390`）；单条输入上限 8192 token、生产入口 16 KiB；补算 `for(;;)` 只在 `embedded === 0` 时结束，但正常页有进展时会一直跑到清空，若持续产生新摘要会长期占用后台队列（interactive 会插队，不会饿死查询）。模型常驻约 1.35 GB，属已知代价。
- **不可撤销操作**：`memory reindex` 现在会清空全部 `memory_episodes` 向量（`sqlite-memory-maintenance.ts:82-91`），计划里新增 `embeddedEpisodes` 条数、确认串仍是 `REINDEX_MEMORY_<agentId>`（`memory-command.ts:47,55-79`）。数据是派生可重算的，但重算会被发现 1 的饥饿问题影响；操作本身是明确确认的。
- **规则/文档/代码一致性**：ADR 0224 对 Gemma 固定文字影响请求开头的说明与代码一致；ADR 58 条“按服务启动相同的条件核对”与 `make-packet` 实际校验不完全一致（发现 4）；`MEMORY_EMBEDDING_QUERY_INSTRUCTION.usedBy` 只写了 `embedding-profiles.ts`，但 `prompt-catalog/src/memory.ts:53` 也引用它，元数据不完整（低）。

---

## 必答问题

### 1. 会不会改变模型已经见过的请求开头？发给模型的内容是不是仍然只在末尾追加，每轮会变的值是不是都在最后一条消息里？

**聊天/模型请求的组装没有改。** 新 prompt-catalog 条目 `layer: "embedding"`，只用于算向量，不进入系统提示、工具定义或历史消息；本次 diff 也没有改 `runtime-pi` 或上下文投影的渲染代码。因此“系统提示/工具/历史只追加、每轮变化值在最后一条消息”这条规则在代码路径上没有被这次改动直接破坏（最终注入位置未逐行核实）。

**唯一例外是遮盖固定文字清单。** 新增的 Gemma 查询前缀 `task: search result | query: ` 有 29 个字符，会进入 `TRUSTED_PROMPT_TEXTS`（`trusted.ts:10-13`、`entry.ts:61-75`）。如果某个老对话的历史里恰好原样出现这段文字、旁边又有会被认成敏感值的内容，重新遮盖可能改变该对话已经发过的历史字节——这是一次性、非追加的变化。ADR 0224:86 明确写了这个代价，但按 `prompt-prefix.md` 第 6/11 条，这类变化应有 Andy 同意和记录；请确认这个同意已经拿到。

另外，向量身份变化不影响模型请求开头，只影响索引派生数据和是否重算。

### 2. 会不会让同一段文字在不同请求里变成不同的字节？

**本次新增的嵌入文本和标识是确定的，未发现新的不确定性。**
- 嵌入输入由固定前缀 + 原文拼成（`embeddingQueryText` / `embeddingDocumentText`），没有时间、随机数或无序集合。
- `embeddingIdentityFor` 对 `[recipe, artifactSha256, redactionRuleset]` 做 `JSON.stringify` 后哈希，顺序固定（`embedding-profiles.ts:157-192`）。
- 本机 `fetch` 对每个请求独立解析 body，不依赖前后请求；`ModelEgress` 每次 `#send` 都新建 `Exchange`，`#known` 不跨请求，因此同一段嵌入文本不会因前面的请求而改变遮盖结果。
- 出包的 `TARGET_EMBEDDING_JSON` 使用 `json.dumps(..., sort_keys=True)`，manifest 也用 `sort_keys=True`（`make-packet.py:289`、`build-artifact.py`），序列化顺序固定。
- P3-3 的融合/去重排序在 SQLite 与 JS 两路都有 id 作为并列时的次序，合并结果保留了这些代码。

**潜在风险（推测）**：向量身份只覆盖 `EGRESS_RULESET_CURRENT` 和当前档案的 recipe，不覆盖整个可信固定文字清单。如果以后只改 prompt-catalog 的固定文字、没有 bump 规则版本，某些记忆正文的遮盖结果可能变化但身份不变，旧向量不会自动重算。这不是本次 PR 已发生的问题，但值得在设计上补一条约束。

### 3. 有没有对应的自动检查，反向用例是否真的会失败？

**有，而且多数反向用例是真的会失败：**
- `packages/platform-node/test/local-onnx-embedding.unit.test.ts`：损坏文件哈希、错误 manifest 哈希、写别的模型名、符号链接、队列上限、排队取消、运行中取消、关闭等待、畸形请求、8192 边界；这些都会在对应实现回退时失败。
- `apps/agent-service/test/local-embedding-composition.unit.test.ts`：断网本机可向量检索、网关断网找不到、加载中退回关键词、取消不写降级、真实失败写降级、每份档案可配置/组装/准入、身份随文件/前缀/规则版本变化。
- `apps/agent-service/test/production-model-composition.unit.test.ts`：运行取消信号传到嵌入；失去 lease 时 `NOT_AUTHORITATIVE` 不记录；真实 provider 失败仍记录。这个用例确实覆盖了“真实 `NOT_AUTHORITATIVE` 被当成取消”的主路径，但没有覆盖 `EMBEDDING_BOUNDARY_REQUIRED` 这类同码但不是取消的路径（发现 2）。
- `packages/memory-engine/test/episode-backfill.unit.test.ts`：一条失败、其余成功；一页全失败报错。
- `packages/platform-node/test/startup-configuration.unit.test.ts`：本机模型的 `local_only`、空密钥、零成本、artifact 必填、大小写/全零哈希、未知档案、错误维度都拒绝；网关带 artifact 也拒绝。
- `scripts/delivery-mode/test_make_packet.py`：非法本地/网关目标拒绝、profile 清单与 TS 源一致。
- `scripts/delivery-mode/test_deploy.py`：模型目录损坏、符号链接、非本机目标不检查。
- `test/integration/data-export.test.ts`、`sqlite-recovery-point.test.ts`：都有“源库确实存在向量/词”的正向对照，再断言导出/备份里没有。

**缺口：** 发现 1 的 `limit: 1` 饥饿、发现 2 的非取消 `NOT_AUTHORITATIVE`、发现 4/5 的出包与预检一致性、`keepsNativeBinary`、qwen 完整渲染字节，目前都没有会让实现回退时变红的自动检查。

### 4. 每个改动产生的值，所有使用方都能接受吗？

- **`EmbeddingRequest.identity`（新字段）**：只在 `EgressEmbedder.#embed` 构造请求时产生，`embedOnce` 用它参与 operationKey 哈希；所有 `EmbeddingRequest` 字面量在测试里都补了 `identity`（`production-model-composition.unit.test.ts:891,987,1070,1174,1663` 等）。使用方可接受。
- **`embedder.model`（现在是 `模型名#hash`）**：写入 `memory_search_index.embedding_model`、`memory_episodes.embedding_model`，并被 `listUnindexed` / `listUnembedded` 用来判断是否过期。存储层只校验非空/字符串，能接受；但旧行是纯模型名，会被判过期（发现 3）。
- **`artifactSha256`**：配置解析用 `sha256Digest` 拒绝非 64 位小写十六进制和全零；组装层要求本机必填、网关禁用；运行时用于目录名和 manifest 校验；出包/预检也有检查。各端基本一致，但预检少查 dimensions/额外文件（发现 5）。
- **`TARGET_EMBEDDING_JSON`**：`make-packet` 生成排序后的 JSON 字符串，`S7-switch-start-readback.py`、`maintenance-common.mjs`、`verify-switch-config-fixtures.py`、`deploy-preflight.py` 都按字符串再解析；`'`/`\` 已被拒绝，单引号模板和 JS 直接嵌入都能接受。格式一致。
- **`MemoryReindexPlan.embeddedEpisodes` / `MemoryReindexResult.clearedEpisodeVectors`**：只有 `apps/admin-cli/src/memory-command.ts:66,78` 和对应测试使用，已同步；没有其他后端校验会拒绝新增字段。
- **`memory.minimumSimilarity` / `runPolicy.proactive.memoryMinimumSimilarity` 变为可选**：`parseProactive` 省略该键，`service-main.ts:1696-1698` 用 `profile.proactiveMinimumSimilarity` 兜底；S7 在切换嵌入模型时删除旧覆盖值。搜索了所有引用，没有发现其他消费者直接假定它存在。
- **`EMBEDDING_PROFILES` 的 Python 副本**：`test_make_packet.py` 会解析 TS 源并逐项比较 provider/model/dimensions；本地三个档案的仓库/版本/维度也与 `build-artifact.py` 有测试对照。值本身一致。
- **prompt manifest 新 ID**：`prompt-manifest.json` 已新增 5 项，`prompt-catalog/src/memory.ts` 也新增同名条目；哈希值未计算核对（未核实）。`MEMORY_EMBEDDING_QUERY_INSTRUCTION.usedBy` 元数据漏了 `prompt-catalog/src/memory.ts` 这个使用方（低）。
