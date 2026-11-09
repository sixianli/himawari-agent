# 复核报告：ADR 0192 存入记忆的内容模型能看到（ee8306ba 对比 fd283e43）

## 侧重检查（先查测试覆盖、文档一致性、一条普通流程走通）

走的普通流程：主人发一条聊天消息 → `production-run-policy` 组装运行输入（`maxMemoryClassification` 已删）→ `ContextFormationService` 选记忆/档案块/历史 → `ContextProjectionService` 算 `contentClassification` 并投影 → `PiAgentRuntimeAdapter` 准入、发请求、执行工具（recall 报告分级）→ `captureHistory` 存历史 → `captureFinalAnswer` 存回答 → 下一轮重复。

逐段核对结果：
- 组装→投影→准入→发请求→存历史：有集成测试覆盖（`test/integration/memory-model-visible.test.ts`，含 2 条 REVERSE 用例），并有 `packages/runtime-pi/test/prompt-prefix.compat.test.ts` 的 `[RULE-memory-visible]` 用例，该文件在 `scripts/check-prompt-prefix.mjs:9` 的 `FILES` 里，属于阻断检查 `check:prompt-prefix`。**已核实。**
- 存最终回答（`captureFinalAnswer`）和压缩提案（`proposeCompaction`）的分级标注：**没有任何测试覆盖，且实现与 ADR 决定不一致**（见发现 1）。
- `apps/agent-service/src/production-run-memory.ts:358` 把记忆检索策略改成 `modelVisibleClassifications()`：全仓库测试没有引用 `modelVisibleClassifications`/`modelVisibleCeiling` 的 `.test.ts`（grep 零命中），这条生产接线改动**无直接测试**。
- 启动日志 `configuration.key_retired`（`apps/agent-service/src/service-main.ts:657-663`）：只有解析层测试（`startup-configuration.unit.test.ts:968`），**日志本身无测试**。
- 文档一致性：runbook、ADR 0112/0158/0185 的旧说法已同步改（diff 各 2 行）；i18n 三语言 pinHint 同步删了 sensitive 分支；golden 快照测试里 mail 提示词对象加了 `dataClassification` 字段但 `proactivePrompt` 序列化时剥掉，断言的仍是同一份 golden 文件——与“Gmail 提示词字节不变”互相印证。**一致。**
- Gmail 检查走 `prepare` 被拒（名单不含 sensitive）时：`proactive-mail-check-service.ts:760-774` 对 `#judge(...).catch(() => ({ judgements: undefined, ... }))`，降级为不判定而不是崩溃。**已核实。**

---

## 发现（按严重度从高到低）

### 1. 高 — 最终回答与压缩提案的派生内容没有按来源升分级，违反 ADR 0192 决定 3/4
- 文件：`packages/runtime-pi/src/pi-runtime-adapter.ts:1812`、`:2238`
- 问题：`captureFinalAnswer` 和 `proposeCompaction` 都用 `request.dataClassification`（聊天运行是 private），而同一处 `captureHistory` 用的是升高后的 `#visibleOf(request)`（`:1620`）。模型的回答引用了 sensitive 记忆（如“主人对青霉素过敏”）、压缩摘要把敏感历史浓缩进去，都会以 private 存进线程消息/压缩提案。
- 证据：
  - `:1809-1813` `captureFinalAnswer({ runId, text: redactMachineSecrets(text), dataClassification: request.dataClassification })`
  - `:2232-2239` `proposeCompaction({ ..., dataClassification: request.dataClassification })`
  - 对比 `:1617-1624` `captureHistory?.({ ..., dataClassification: this.#visibleOf(request), ... })`
- 后果：线程消息、线程摘要等派生通道以 private 标签把这些内容带进后续请求，`ContextProjectionService.contentClassification` 按标签取最高，结果按 private 准入——名单只到 private 的服务方会收到敏感记忆的派生内容，而出口遮盖只遮密码/验证码，健康、财务类文字不遮。目前同轮运行内被 `runtimeHistory` 引用本身已标 sensitive 所掩盖（下一轮仍按 sensitive 准入），但压缩、跨运行摘要等路径一旦替换掉 runtimeHistory 引用就回到 private。ADR 0192 决定 4 写明“派生内容取来源的最高分级”，这两处没做到。
- 建议：两处改用 `#visibleOf(request)`（或至少取 `max(request, #visibleOf)`），并补测试。

### 2. 中 — 对已含敏感标注历史的旧对话，新一轮请求会把之前被过滤的消息插进请求中段，ADR“不影响已发请求开头”的说法过强
- 文件：`packages/application/src/services/context-formation-service.ts:189-195`
- 问题：历史候选的过滤从 `<= min(run, maxMemoryClassification)`（生产为 private）改成 `<= sensitive`。旧配置下，一次 private 运行面对 sensitive 标注的线程消息会把它们从投影里剔除（模型从未见过）；升级后第一次运行会把这些消息插在历史中段。这不符合 `.claude/rules/prompt-prefix.md` 第 4 条“已经发给过模型的内容……只能在末尾追加”的字面要求，且会使该对话首次请求的缓存从插入点起整段失效。
- 证据：diff 中 `.filter(({ dataClassification = request.dataClassification }) => CLASSIFICATION_RANK[dataClassification] <= VISIBLE_RANK)` 取代了原来的 `<= CLASSIFICATION_RANK[request.maxMemoryClassification]`。
- 限定：聊天运行的 runtimeHistory 引用若是 sensitive，旧代码会在 formation 直接抛 `RUNTIME_HISTORY_CLASSIFICATION_DENIED`（那个对话本来就发不出去，谈不上破坏已发前缀）；所以受影响的是“线程消息（envelope.history）里带 sensitive 标注、且这些标注来自早前 sensitive 运行”的对话。生产聊天运行是否会出现 sensitive 运行，**推测，未核实**；若从未出现，此条只是理论边界。
- 建议：在 ADR 后果里写明这个一次性插入场景；或升级时对含 sensitive 历史的对话记日志/换新提示词。

### 3. 低 — 交付包模板里的探针副本仍在写已退役的配置键
- 文件：`scripts/delivery-mode/packet-template/acceptance/cloud/probe-source/test/qualification/sandbox-install-restart-probe.mjs:850`
- 证据：grep 显示该文件仍有 `maxMemoryClassification: "private"`；同名的源文件 `test/qualification/sandbox-install-restart-probe.mjs:847` 已在本次删除。
- 影响：该键已被接受且不生效（还会记 `key_retired` 日志），行为无害；但清单/哈希（`question-12-inputs.json` 固定 sha）与模板维护配置不同步。
- 建议：确认探针副本是否受 sha 固定；若更新需同步改哈希，或接受现状并注明。

### 4. 低 — `configuration.key_retired` 启动日志无测试
- 文件：`apps/agent-service/src/service-main.ts:657-663`
- 证据：只有 `packages/platform-node/test/startup-configuration.unit.test.ts:968-980` 验证 `retiredKeys` 解析，没有测试断言启动时真的打出这行日志。
- 建议：补一条日志断言，或接受。

### 5. 低 — `production-run-memory.ts:355-359` 检索策略改动无直接测试
- 证据：diff 把 `allowedClassifications` 从“按运行分级截取”改成 `modelVisibleClassifications()`；全仓库无测试引用该函数或断言这个策略值。
- 建议：在现有集成测试里补对检索策略的断言。

---

## 读代码证实的（作者说法逐条核对）

| 说法 | 结论 |
|---|---|
| 名单只到 private 的服务方遇到敏感请求会被拒、不发出 | **成立**。`model-invocation-admission-service.ts:482-487` 真实校验并抛错；集成测试 REVERSE 断言 `bodies` 为空 |
| 只含 private 内容的对话仍按 private 发送 | **成立**。`context-projection-service.ts` 以运行分级为 floor 取最高；测试断言 `admitted === ["private"]` |
| 工具结果带 contentClassification 时后续调用升准入；按运行 Map，运行结束清掉 | **成立**。`pi-runtime-adapter.ts:1136`（Map）、`:2041-2042`（工具结果升）、`:1583`（准入用 `#visibleOf`）、`:1155`（finally 清理） |
| Gmail 检查提示词字节不变 | **成立**。`proactive-mail-check-service.ts:382-393` 序列化只取 `mailId/id/text/tentative`；golden 快照和集成测试均断言字节 |
| 详细决定见 ADR 0192 | 文档存在且与代码基本一致，但决定 3/4 在 `captureFinalAnswer`/`proposeCompaction` 两处未落实（发现 1）；“已经发出的对话请求开头不受本决定影响”说法过强（发现 2） |
| `maxMemoryClassification` 退役：写了接受但不生效、启动记日志 | **成立**（strict-configuration.ts:1177-1179 接受、service-main.ts:657-663 记日志），日志无测试（发现 4） |
| 置顶只看类别 | **成立**。`production-memory-control.ts:954` 用 `isModelVisible`，`memory-page.tsx:78` 只查 `PINNABLE` 类别 |
| “修复前这组用例失败，报错……” | **未核实**（无法运行测试）；静态看旧代码 `readStored` 以运行分级为 ceiling 会抛 “Payload exceeds the Run data classification”，方向吻合 |

## 推测（未核实）

- 生产上是否存在 dataClassification 为 sensitive 的聊天运行/线程消息（决定发现 2 的实际影响面）。
- 交付包探针副本是否受 `check:probe-sources` 哈希固定而禁止修改。
- `check:untested-claims` 是否已把 ADR 0192 的门槛声明核对过。

---

## 必答问题

**1. 是否改变模型已见过的请求开头？**
系统提示、工具定义、遮盖逻辑零改动（diff 不含 prompt-catalog、工具 descriptor、遮盖代码；golden 快照未变）。`contentClassification` 只用于准入和存历史的标签，不进请求字节。记忆/档案块照旧渲染在 `turnPrompt`（最后一条用户消息，`pi-runtime-adapter.ts:600-619`），每轮会变的值仍在最后一条消息。**总体仍只在末尾追加**；唯一例外是发现 2：旧对话里此前被过滤的 sensitive 历史消息会被插入历史中段，属于对已发前缀的一次性破坏，ADR 对此说法不成立（过强）。

**2. 同一段文字会不会在不同请求里变成不同字节？**
未发现。Gmail 提示词序列化剥掉新增字段，字节不变；`highestClassification`/档案块 digest/事件段标注都是内容的确定函数；工具结果 JSON 仅在分级升高时多一个键，且按运行确定。无时间字段、无无序集合新增。**不会。**

**3. 有没有对应的自动检查，反向用例会不会真失败？**
阻断检查 `check:prompt-prefix` 包含新 `[RULE-memory-visible]` 用例（同一文件在 `scripts/check-prompt-prefix.mjs:9`）；集成测试含 2 条 REVERSE（名单只到 private 拒发、纯 private 不升）。反向用例能否真失败**未运行核实**，静态推断方向正确。缺口：启动日志、`production-run-memory` 接线、`captureFinalAnswer`/`proposeCompaction` 分级（发现 1）均无检查。

**4. 每个新产生/修改的值，两端核对是否都接受？**
- `RuntimeProjection.contentClassification`：唯一生产者是 `ContextProjectionService`，唯一消费者是 Pi 适配器（缺省回退运行分级，其他 3 个测试桩实现不设也安全）。✓
- `RuntimeToolSettledResult.contentClassification`：生产者 `ProductionRuntimeTools.#ownerScoped`（仅 recall），消费者适配器 `:2041`；缓存重放路径把标签一并持久化，读回保留。✓
- `ProactiveMemoryHit.dataClassification`：唯一生产者 `createProactiveMemoryRecall`，消费者 mail 检查缺省 private。✓
- `EpisodeSegment/MemoryEpisode.dataClassification`：生产者 `episodes.ts`，消费者 summarize、recall 分级、测试 fixture 均已更新；嵌入标注按 ADR 留给下个 PR。✓
- `RunPolicyConfiguration.retiredKeys`：生产者 strict-configuration（未知键列表仍含旧键，`:1112`），消费者 service-main 日志。✓
- 配置模板 `allowedDataClassifications` 加 sensitive：消费端有四处校验（admission `:482`、router `:235`、action-reviewer `:74`、proactive `prepare` 新增检查），全部按名单放行 sensitive。✓
- 未通过项：交付包探针副本仍写旧键（发现 3）；派生内容分级两端不一致（发现 1）。
