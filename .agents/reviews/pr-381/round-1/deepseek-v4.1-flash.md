## 一、读代码证实的问题（按严重度）

### 1. 高：取消检测在生产路径永远为 false，P3-2 的修复没有真正生效

- 文件:行：`apps/agent-service/src/production-run-memory.ts:373`、`apps/agent-service/src/service-main.ts:1269-1281`、`apps/agent-service/src/service-main.ts:1423-1435`
- 问题：`searchCancelled` 只看异步上下文里的 `MemorySearchRequest.signal`：
  ```ts
  () => scope.getStore()?.signal?.aborted === true,
  ```
  但生产里两个真正的 `embedWithin` 包装都没有把任何 signal 放进这个上下文：
  ```ts
  return memory.embedWithin(
    {
      ownerId: configuration.ownerId,
      agentId: configuration.agentId,
      runId: invocation.runId,
      executionLease,
      deadlineAt: ...,
      dataClassification: invocation.dataClassification,
      slot: `${slot}:${invocation.toolCallId}`,
    },
    operation,
  );
  ```
  另一个包装（1374 行附近开始）同样没有 `signal`。而 `RuntimeRequest` 本身也没有 signal 字段（`packages/application/src/ports/intelligence.ts:161-180`）。因此 `scope.getStore()?.signal` 在生产中始终是 `undefined`，`searchCancelled()` 恒为 false；取消导致的 `assertActive`/嵌入失败仍会走到 `onVectorFailure`，继续写 `retrieval_degrade` 决策记录。
- 证据：`apps/agent-service/src/production-memory-composition.ts:147-149`
  ```ts
  onVectorFailure: (error, scope) => {
    if (!searchCancelled()) options.onVectorFailure(error, scope);
  },
  ```
  现有取消测试只是直接注入回调，或在测试里直接调用 `memory.search({ signal })`：
  ```ts
  let cancelled = true;
  composition.bindEmbeddingBoundary(
    () => { throw new Error(cancelled ? "RUN_CANCELLED" : "PROVIDER_DOWN"); },
    1000,
    () => cancelled,
  );
  ```
  （`apps/agent-service/test/local-embedding-composition.unit.test.ts:272-276`）
  以及 `apps/agent-service/test/production-model-composition.unit.test.ts:904-916` 的 `signal: controller.signal`。两者都没有覆盖 `service-main` 的实际接线。
- 建议：把运行取消信号一路传到 `RunEmbeddingContext.signal`（例如让 `embedWithin` 接受并传递 abort signal），或直接从 `assertActive`/运行状态判断取消；同时增加一个经过 `service-main` 包装或真实 `embedWithin` 链路的反向用例，证明取消时确实不调用 `onVectorFailure`。

### 2. 中：新增的固定提示文字会进入全局 `TRUSTED_PROMPT_TEXTS`，可能改变老对话的遮盖字节

- 文件:行：`packages/prompt-catalog/src/memory.ts:83`、`packages/prompt-catalog/src/trusted.ts:10-13`、`packages/application/src/services/model-egress.ts:225`、`packages/sensitive-capture/src/redaction.ts:248-256`
- 问题：新加的 Gemma 查询前缀长度 29，会被 `trustedPromptTexts` 收进全局固定文字清单：
  ```ts
  segments: [text("task: search result | query: "), slot("query")],
  ```
  ```ts
  export const TRUSTED_PROMPT_TEXTS: readonly string[] = trustedPromptTexts(
    [background, chat, mail, memory, review, runtime, tools].flatMap((module) =>
      Object.values(module),
    ),
  );
  ```
  ```ts
  trusted: this.#options.trusted ?? TRUSTED_PROMPT_TEXTS,
  ```
  遮盖逻辑会把清单里的文字整段跳过。于是老对话里如果恰好出现这个 29 字符字面量，原本会被遮的内容现在可能不再被遮，请求开头的字节就会变一次。作者“本机嵌入不改变聊天模型请求的任何字节”的绝对说法因此不成立；规则文件第 11 条明确提醒改提示词文字要评估固定文字清单。
- 证据：`packages/sensitive-capture/src/redaction.ts:248-256`
  ```ts
  const trusted = (options.trusted ?? []).filter(
    (value) => [...value].length >= TRUSTED_TEXT_MINIMUM_CHARACTERS,
  );
  ...
  const spans = filler === undefined ? [] : trustedSpans(input, trusted);
  ```
- 建议：把 `layer: "embedding"` 的提示从 `TRUSTED_PROMPT_TEXTS` 排除，或至少把该清单的哈希纳入 `embeddingIdentity` 并在 ADR/PR 说明中记录“老对话可能因清单变化改变一次遮盖字节”。无论采用哪种，都要补一条针对固定文字清单变化的 prompt-prefix 检查。

### 3. 中：`artifactSha256` 与 `TARGET_EMBEDDING_JSON` 的生产端、消费端校验不一致（I-73 类问题）

- 文件:行：`scripts/delivery-mode/make-packet.py:266-274`、`packages/platform-node/src/strict-configuration.ts:139-143`、`packages/platform-node/src/strict-configuration.ts:366-367`、`scripts/delivery-mode/embedding-artifact-check.py:33`
- 问题：出包脚本只做了很松的校验：
  ```py
  if target['provider'] == 'local-onnx' and (target.get('disclosure') != 'local_only' or target.get('secretRef') is not None or not re.fullmatch(r'[0-9a-f]{64}', str(target.get('artifactSha256')))):
  ...
  if "'" in encoded or '\\' in encoded:
  ```
  它允许：
  - 全零的 64 位十六进制 `artifactSha256`；
  - 非 local-onnx provider 也带 `artifactSha256`；
  - 缺 `cost`、`capabilities`、`allowedDataClassifications` 等完整描述字段的目标；
  - 不在 `EMBEDDING_PROFILES` 里的 provider/model。
  这些值随后会被更严格的消费端拒绝：
  ```ts
  if (!/^[a-f0-9]{64}$/.test(candidate) || /^0{64}$/.test(candidate))
    throw invalid(field, "must be a lowercase sha256 digest");
  ...
  } else if (descriptor.artifactSha256 !== undefined)
    throw invalid(`${field}.artifactSha256`, "is only supported for local-onnx");
  ```
  或者直到 `createProductionMemoryCompositionFromConfiguration` 的 `embeddingProfileFor` 才抛 `EMBEDDING_PROFILE_UNKNOWN`。结果是出包/预检通过、维护或服务启动时才失败，属于 I-73 说的“两边校验没对上”。
- 证据：`scripts/delivery-mode/embedding-artifact-check.py:33` 也只校验：
  ```py
  if not SAFE_NAME.fullmatch(model) or not re.fullmatch(r'[0-9a-f]{64}', artifact_sha256):
      return 'target-invalid'
  ```
  `scripts/delivery-mode/test_make_packet.py:569-572` 的反向用例没有覆盖全零摘要、gateway 带 artifact、缺字段、未知 profile 这几种情况。
- 建议：在 `make-packet.py` 中至少拒绝全零摘要、拒绝非 local-onnx 的 `artifactSha256`、要求完整键集合，并对 provider/model/dimensions 做与 `EMBEDDING_PROFILES` 相同的白名单校验；`embedding-artifact-check.py` 同样拒绝全零。补相应反向用例，确保每个出包产出的值都能通过 `strict-configuration` 和 composition。

### 4. 低：数据导出测试没有正向对照，作者“两条集成测试有正向对照”的说法不准确

- 文件:行：`test/integration/data-export.test.ts:159-193`、`test/integration/sqlite-recovery-point.test.ts:555`
- 问题：恢复点测试确实有正向对照：
  ```ts
  const plain = await readFile(source.databasePath);
  expect(plain.includes(vector)).toBe(true);
  ```
  但数据导出测试只断言导出结果里找不到向量/词/模型名，没有断言这些内容确实在源数据库中存在。作者的说法“两条集成测试有正向对照”与代码不符；威胁模型文档本身也只把正向对照归给恢复点测试（“同一个向量在原库文件里能找到”只出现在恢复点那一条）。
- 证据：`test/integration/data-export.test.ts:191-193`
  ```ts
  expect(everything.includes(form)).toBe(false);
  expect(everything.includes(Buffer.from("zebrapluto"))).toBe(false);
  expect(everything.includes(Buffer.from("jina-fixture#1"))).toBe(false);
  ```
- 建议：在导出测试里增加 `source.database.prepare(...).get()` 或读原始 DB 文件的正向断言，证明插入的向量和词确实存在；同时修正 PR 说明或威胁模型措辞。

### 5. 低：本地运行时对“已开始推理”的取消不生效，`close()` 也没有等待在途推理

- 文件:行：`packages/platform-node/src/local-onnx-embedding.ts:408-422`、`packages/platform-node/src/local-onnx-embedding.ts:316-324`
- 问题：`#drain` 在调用 `model.run` 之前就把 abort 监听器移除了：
  ```ts
  item.signal?.removeEventListener("abort", item.onAbort);
  if (item.signal?.aborted) {
    item.reject(item.signal.reason);
    continue;
  }
  ...
  const vector = await model.run(ids);
  ```
  因此推理一旦开始，调用方再 abort 不会让该请求失败；`embedOnce` 的外层超时/取消也不会打断这次 `fetch`，只能等推理结束。`close()` 只拒绝仍在 `#pending` 里的请求，然后立即 `model.close()`；它没有等待正在执行 `model.run` 的那一项。
- 说明：`model.close()` 与在途 `InferenceSession.run` 并发时 ONNX Runtime 的具体行为我未运行验证，属于推测风险；但在途请求无法响应取消是读代码可以直接确认的。
- 建议：运行中至少重新检查 `signal.aborted` 并在返回前拒绝；或把 `model.run` 与 signal 做竞态。`close()` 应记录并在途 drain 完成后再释放 session，或明确声明关闭期间不保证取消。

### 6. 低：本地向量补算失败后在本进程内不会重试

- 文件:行：`apps/agent-service/src/service-main.ts:1529-1552`
- 问题：`caughtUp` 在调用 `catchUpLocalVectors()` 之前就置为 true；失败只写一条诊断，不重置：
  ```ts
  if (!ready || caughtUp) return;
  caughtUp = true;
  void catchUpLocalVectors().catch((error: unknown) =>
    writeServiceDiagnostic(errorOutput, {
      component: "agent-service",
      event: "memory.embedding_catch_up_failed",
      code: stableErrorCode(error),
    }),
  );
  ```
  如果 `requeueStaleMemoryVectors` 或 episode backfill 中途失败，本进程运行期间不会再补算，直到重启。
- 建议：失败时重置 `caughtUp` 或用有限次数的退避重试；把“已排回/已补算”的进度记下来，避免长期滞留旧向量。

## 二、推测与未核实

- `close()` 与在途 ONNX 推理并发是否会导致原生崩溃/未定义行为：未运行验证，仅从调用顺序推测有风险。
- 生产 CI 是否实际执行新加的 `packages/platform-node/test/local-onnx-embedding.unit.test.ts`、`apps/agent-service/test/local-embedding-composition.unit.test.ts`：未核实测试入口。
- ADR 中写的 jina 具体 `artifactSha256 = dcf55...`：仓库里没有可直接计算的构建产物，未核实。
- 现有任何真实对话里是否包含 `"task: search result | query: "` 这个字面量：未核实；因此第 2 条影响范围是“窄但真实存在的可能”。

## 侧重检查

- **不可信输入 / 路径穿越**：检查了 `localOnnxArtifactDirectory` 的 model/摘要正则、manifest 的文件名白名单、`verifyLocalOnnxArtifact` 的 `lstat`/符号链接拒绝、`embedding-artifact-check.py` 的 SAFE_NAME。未发现路径穿越或符号链接绕过；但 Python 检查与运行时检查的字段严格度不完全一致（第 3 条）。
- **注入 / 出包安全**：检查了 `make-packet.embedding_target` 对 `'` 和 `\` 的拒绝、`ensure_ascii=True`、`json.loads('...')` 与 JS 字面量两种嵌入方式。结论：只要经过该函数，经过的 JSON 文本嵌进 Python/JS 是安全的；问题是该校验允许的字段范围比消费端窄/宽不一致。
- **资源耗尽**：本地输入有 `EMBEDDING_INPUT_LIMIT`（16 KiB）、`MAXIMUM_INPUT_TOKENS=8192`、默认 64 条的队列上限、顺序推理。发现“在途推理不响应取消”和“失败补算不重试”两个可用性问题。
- **不可撤销操作**：重建索引只清空可重建的 `memory_search_index` 与 `memory_episodes.embedding*`，不是正文；恢复点备份只加密数据库快照和密文 payload 文件，模型目录不会进入备份；导出不读索引表，也不含每日摘要。未发现新增不可恢复的数据删除。
- **规则文件/文档与代码一致性**：
  - ADR 的多数描述与代码一致：artifact 目录结构、manifest 校验、符号链接拒绝、状态机、队列上限、0 成本、健康项、重建索引清 episode 向量。
  - 作者关于“两条集成测试有正向对照”的说法不准确（第 4 条）。
  - “上线包检查和上线前检查确认文件已装好”也不完全准确：实际生产机文件检查只在 `deploy-preflight.py`（`scripts/delivery-mode/deploy-preflight.py:148`），出包检查主要验证目标描述和模板生成，不验证目标机上的模型目录。
  - ADR 说“调用方放弃了的请求直接出队”，更准确的表述是“仍在队列中的请求出队”；已开始推理的请求不会因 abort 立刻结束（第 5 条）。

## 必答问题

1. **会不会改变模型已经见过的请求开头？**
   就本次 diff 直接改动的路径：系统提示、工具定义、历史消息都没有改；记忆只影响选中哪些记忆，选中结果仍在最后一条用户消息/本轮追加内容里，且本 diff 没有改变记忆插入位置。因此正常内容仍是“只追加，每轮会变的值在末尾”。
   但不能接受作者“任何字节都不变”的绝对表述：新增 Gemma 提示前缀进入 `TRUSTED_PROMPT_TEXTS`，在旧对话恰好包含该字面量时可能改变遮盖结果，从而使请求开头变化一次（见第 2 条）。所以结论是：**普通路径满足规则；边角路径不满足“绝对不变”。**

2. **同一段文字在不同请求里会变成不同字节吗？**
   同一构建、同一输入下：查询/文档模板由 `renderPrompt` 按固定段顺序拼接；`embeddingIdentity` 由固定顺序的 JSON 字符串哈希得到；`EMBEDDING_PROFILES`、manifest 文件遍历、`listUnindexed` 等列表顺序固定；没有时间字段；遮盖的 `known` 集合是每次 `exchange` 新建的。因此同一段文字在同一构建内应得到相同字节。
   跨构建有一个真实缺口：`embeddingIdentity` 不包含 `TRUSTED_PROMPT_TEXTS` 清单；这次新增的 Gemma 前缀可能改变遮盖，却不会让旧向量失效，导致“同一文本在不同版本/不同请求里嵌入不同字节但索引仍复用”。这是第 2 条建议要补的部分。

3. **改动有没有对应的自动检查，反向用例是否真的会失败？**
   有：本地模型的加载/摘要不匹配/符号链接拒绝、网络断开下本地检索成功与网关失败、加载中退回关键词、队列上限、队列中取消、配置违规、备份额外断言、出包目标违规等。
   但有三处反向用例不足：
   - 取消检测的反向用例直接注入 `cancelled` 回调或直接给 `memory.search` 传 signal，**没有覆盖 `service-main` 不传 signal 的生产接线**；把生产接线保持现状，这个用例照样通过，因此它证明不了 P3-2 修复在生产生效（第 1 条）。
   - 数据导出测试没有正向对照，无法证明“确实插入过但没导出”（第 4 条）。
   - `make-packet` 的反向用例没有覆盖全零摘要、gateway 带 `artifactSha256`、缺字段、未知 profile（第 3 条）。
   另外现有 `check:prompt-prefix` 不会覆盖 `TRUSTED_PROMPT_TEXTS` 清单变化，因此第 2 条也没有自动检查兜底。

4. **改动产生或修改的每个值，每个使用它的地方都能接受吗？**
   - `embedder.model` 从裸模型名变成 `模型名#哈希`：`HybridMemoryProvider` 的 upsert/search、episode 的 attach/search/listUnembedded 都使用同一个 `embedder.model`，索引端和查询端一致；代价是所有旧索引行会被视为未建索引，网关部署首次升级也会全量重算（ADR 已说明，但 PR 说明没提）。
   - `artifactSha256`：运行时、配置解析、部署预检都接受小写 64 位摘要；但出包脚本还接受全零，严格配置拒绝全零，两端不一致（第 3 条）。
   - `minimumSimilarity` / `memoryMinimumSimilarity` 变成可选：`service-main.ts:1676-1678` 已用 `profile.proactiveMinimumSimilarity`/`profile.chatMinimumSimilarity` 兜底，消费端能接受。
   - `TARGET_EMBEDDING_JSON`：经过 `make-packet.embedding_target` 的字符串不含 `'`/`\`，嵌进 Python `json.loads('...')` 和 JS 字面量是安全的；但该函数允许的字段/取值集合小于严格配置能接受的范围，存在“包能出、服务不能起”的晚失败（第 3 条）。
   - `memory_episodes` 的 `embeddedEpisodes`/`clearedEpisodeVectors`：计划、结果、Admin CLI 输出和测试都已同步，未发现遗漏。
   - 新 prompt 清单项：`prompt-manifest.json` 新条目齐全，原有 `memory.embedding-query-instruction` 的文字和 sha 未变；QWEN3 查询模板拼出的字节与旧 `instructedQuery` 相同（`"Instruct: " + 文字 + "\nQuery:" + query`），这一点核对一致。

**总体判断**：方向正确，本地模型文件校验、路径/摘要/符号链接防护和备份/导出隔离做得比较扎实；但 P3-2 取消接线是必须先在合并前修复的高优先级问题，出包与严格配置的双端校验、固定文字清单对聊天遮盖的影响、以及导出测试的正向对照也需要补上。
