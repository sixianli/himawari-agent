# PR 381 复核结论（606862d3，基准 a7e0299f）

说明：本复核的最大步数已到，以下为基于已读代码的完整结论，不再调用工具。所有引用均为我亲自读到的代码；未读到的标「未核实」。

## 侧重检查（走过的流程与结论）

普通流程：**主人发消息 → run 组装 → `ContextFormationService` 调 `memory.search`（context-formation-service.ts:241）→ `DurableMemoryService.search`（durable-memory-service.ts:405/418）→ `HybridMemoryProvider.search` → `embedQuery` → boundary（`embedOnce`）→ 准入 → `wrapFetch` → `LocalOnnxEmbeddingRuntime.fetch` → 队列 → ONNX 推理 → 归一化 → 三路融合 → 选中记忆进 run 输入最后一条消息（thread-execution-projection.ts:202-209、709-714）**。

- 已覆盖：runtime 加载/校验/队列（local-onnx-embedding.unit.test.ts）、配置校验（startup-configuration.unit.test.ts:165-224）、组合与关键词退回、P3-2 取消正反（local-embedding-composition.unit.test.ts）、取消时序（production-model-composition.unit.test.ts:850-930）。
- **无测试覆盖**：service-main.ts:1502-1553 的 `observe` 回调整条线（健康上报、`memory.embedding_local_state`、`catchUpLocalVectors` 触发与失败处理）——grep 测试文件零引用；`EMBEDDING_LOCAL_INPUT_LENGTH`、`EMBEDDING_LOCAL_CLOSED` 无用例；`production-http-composition-process` 作者自述未跑。

## 问题清单（严重度从高到低）

**1.（中）apps/agent-service/src/service-main.ts:1505-1546 — 补算循环一处失败全部中止且永不重试**
证据：`for (;;) { const embedded = await memoryEpisodes.backfillEmbeddings({...}); if (embedded === 0) break; }`；`backfillEmbeddings`（episodes.ts:281-300）逐条 `await embedDocument(...)`，任一条抛错直接传播；`caughtUp = true` 先置位，外层 `.catch()` 只写一条诊断。后果：失败摘要之后的所有摘要向量永远补不上。建议：逐条 try/catch 跳过并计数，或安排重试。

**2.（低）packages/platform-node/src/local-onnx-embedding.ts:23、421 — 8192 token 上限与出口 16384 字节上限不一致，拒绝路径无测试**
证据：`MAXIMUM_INPUT_TOKENS = 8192` 拒绝路径抛 `EMBEDDING_LOCAL_INPUT_LENGTH`；`production-run-memory.ts:29` `EMBEDDING_INPUT_LIMIT = 16384` 字节。切到本机后部分能过出口的文本建不上向量，超长查询还会记「检索降级」；该错误码无任何测试用例。建议：对齐或写明差异并补反向用例。

**3.（低）文档漂移 — docs/agent-rulebook-inventory.md:180、docs/adr/0115:42**
证据：C-8 写 `memoryMinimumSimilarity` 缺省 0.45，实际缺省已是档案的 `proactiveMinimumSimilarity`（jina 0.20，service-main.ts:1677）；ADR 0115:42 写「换其他模型没配门槛拒绝启动（`MEMORY_MINIMUM_SIMILARITY_REQUIRED`）」，该错误码已删，改为 `EMBEDDING_PROFILE_UNKNOWN` 或直接用档案门槛（[I-23] 用例已同步改）。建议：更新或在 ADR 0224 声明取代。

**4.（低）packages/platform-node/src/local-onnx-embedding.ts:322-330 — `fetch` 对畸形 body/URL 抛异常而非 4xx**
证据：`new URL(href)` 与 `JSON.parse(init.body)` 无 try/catch，非法 JSON 穿透 `wrapFetch` 而不是返回 `local_body_invalid`。当前唯一调用方总是发合法 JSON，属健壮性问题。

**5.（信息）** runtime-health.ts:58-67 将 `memory-embedding` 预置 healthy（required:false），首.observe 前短暂失真，无害；andy-production.json 无 `configTargets.embedding`，生产包 `TARGET_EMBEDDING_JSON` 为 "null"，与 ADR「生产换配置之前」一致，非缺陷。

## 作者说法核对（读代码证实，除标注外）

1. **属实**：不触碰提示组装/工具/历史/遮盖；`memory.embedding-query-instruction` manifest 哈希原样；qwen3 查询格式搬进目录后逐字节一致（file-summary-configuration.unit.test.ts:156 同格式断言）；门槛变化只影响选中哪些记忆，选中记忆仍进最后一条消息（context-formation-service.ts:281-286）。
2. **属实**：strict-configuration.ts:346-370 仅对两 provider 查档案与维度；`artifactSha256` 非 local-onnx 一律拒绝，有反向用例（startup-configuration.unit.test.ts:218-224）。
3. **属实**：make-packet.py `embedding_target()` 白名单键、`ensure_ascii=True` 后检查 `'` 和 `\` 否则 refuse；两个替换点（S7:161、maintenance-common.mjs:342）安全。
4. **属实**：composition.ts:147-148 + run-memory.ts:373 只看 run 信号；[P3-2] 反向用例方向正确。超时（deadline）不设 run 信号，仍记降级——该场景无专门用例（未核实覆盖）。
5. **属实**：备份只收 `data/product.sqlite` 与 `data/payload-ciphertext/*`（sqlite-recovery-point.ts:284、1139-1143），`models/` 不进备份；data-export 目录 grep 不到索引表；两条集成测试有正向对照（`expect(plain.includes(vector)).toBe(true)`）。

## 必答问题

- **Q1**：是，只在末尾追加。改动仅影响检索侧路，选中记忆仍在最后一条用户消息里；`check:prompt-prefix` 阻断检查继续适用。
- **Q2**：不会。嵌入输入 = 固定前缀 + 确定性遮盖文本；identity 的 recipe 为固定顺序数组 `JSON.stringify`，含 artifactSha256 与遮盖规则版本，无时间/无序集合。
- **Q3**：有自动检查且反向用例断言方向正确（读代码证实）；**是否在 CI 实际通过未核实**（无法运行命令），作者自述 fast-mode 全过、9 条失败与 main 相同。
- **Q4**：逐对核对过 `local-onnx`、`artifactSha256`、`identity`、`EMBEDDING_PRIORITY_HEADER`、可选 `memoryMinimumSimilarity`、[I-23] 错误码的产生端与使用端，两端校验一致；未发现 I-73 式「清单 id 过不了后端校验」的问题。

## 遗留与建议

- 未完成：未运行任何测试/构建核实（工具受限）；`listUnembedded` 排序稳定性、超时记降级的用例覆盖、`production-http-composition-process` 未核实。
- 建议：合入前优先处理问题 1（补算循环健壮性），并补 `EMBEDDING_LOCAL_INPUT_LENGTH` 用例；文档两处漂移可随完整模式文档批次一并修。
