## 复核范围与说明

- 已读：`git diff f9a440d1..3dc426a8`，并用 `fd283e43..3dc426a8` 对照整体改动；重点读了事件段回填、Gmail 提醒存档、`highestClassification`、工具结果分级和 pi 运行时。
- 受工具限制**没有运行任何测试**；下面关于测试的结论都来自读代码，不能代替实际执行结果。
- 未核实：所有非 SQLite 的 Store/Protector 实现（仓库里相关端口基本只有 SQLite/Node 实现）；控制中心的构建与端到端启停。

## 问题清单（按严重度）

### 1. 中：`backfillEmbeddings` 对每段调用 `within`，但生产逻辑槽位不含段标识；现在唯一只因为调用方固定 `limit: 1`

- 位置：`packages/memory-engine/src/episodes.ts:300-303`、`apps/agent-service/src/production-memory-episodes.ts:70-73,81-83`
- 证据：
  - `episodes.ts` 对 `episodes` 里的每一段都调用一次 `within(episode.dataClassification, ...)`，回调签名里没有段 id：
    ```ts
    vector: await (input.within ?? ((_, operation) => operation()))(
      episode.dataClassification,
      () => embedder.embed(`${episode.day}\n${text}`),
    ),
    ```
  - 生产包装只用 `slot + runId` 作为逻辑槽位，且 `backfillEmbeddings` 调用固定 `limit: 1`：
    ```ts
    return this.#options.embedWithin(request, `${slot}:${request.runId}`, operation);
    ...
    within: (dataClassification, operation) =>
      this.#within({ ...request, dataClassification }, "memory-episode-backfill", operation),
    ...
    limit: 1,
    ```
  - 同一运行同一个 `logicalSlot` 第二次开始会被当作 replay，进而抛错：`sqlite-model-invocation-operations.ts:455-468` 返回 `disposition: "replay"`；`production-run-memory.ts:238-242` 见非 `fresh` 就抛 `EMBEDDING_RESULT_REQUIRES_RECONCILIATION`。
- 结论：**当前生产每次运行最多补一段，所以槽位确实唯一**。但这是由 `limit: 1` 保证的，不是由槽位设计保证的；新单测用 `limit: 5` 且用自己的 `within` 桩，覆盖不到真实准入，`packages/memory-engine/test/episode-backfill.unit.test.ts:57-70` 反而证明一次调用会对多段使用同一槽位。
- 建议：让 `within` 回调带上段 id/序号，槽位改为 `memory-episode-backfill:<episodeId>:<runId>`；或在 `backfillEmbeddings` 内断言 `limit === 1`。再补一个经过真实 `memory.embedWithin`/准入的集成用例。

### 2. 中低：Gmail 提醒按“整批最高分级”存档；概览和推送能读出，但新增测试没有覆盖这两条读路径

- 位置：`packages/application/src/services/proactive-mail-check-service.ts:793-796,1084-1088,895,1299-1311`
- 证据：
  ```ts
  const dataClassification = highestClassification(
    "private",
    promptMemories.map((memory) => memory.dataClassification),
  );
  ...
  for (const [id, judgement] of outcome.judgements) {
    judged.set(id, judgement);
    judgedClassification.set(id, outcome.dataClassification ?? "private");
  }
  ...
  dataClassification: judgedClassification.get(item.messageId) ?? "private",
  ```
  这意味着同一批里只要有一封邮件命中敏感记忆，**整批每封邮件**的提醒都按 sensitive 存档，而不是按“这封邮件实际引用/带入的记忆”。同一条提醒的分级会随同批其它邮件变化（保守但依赖批次，不是逐邮件确定）。
- 读路径是通的：`readProactiveOverview` 用 `seal.open`（`proactive-overview.ts:125,144`），推送用 `production-proactive.ts:107-115` 的 `seal.open`；`createProactiveSeal.open` 不看 classification（`proactive-seal.ts:28-33`），只校验 contentType 并由 protector 解封。Payload 表 classification 有四种合法值 CHECK（`0001_initial_product_schema.sql:61`），所以 sensitive 存档可读、可推送。
- 但新测试 `test/integration/proactive-mail-check.test.ts:1830-1858` 只查 `source_insights JOIN payloads` 的 `payloads.classification`，**没有调用 `overview()` 或推送 `content()`**，所以“按 sensitive 存档后概览/推送仍能读出”没有自动回归。
- 建议：用 `Trace`/`memoryByMail` 或 `promptMemories[].mailId` 按邮件归因，计算每封邮件自己的最高分级；同时在新测试里加 `await h.overview()` 和推送内容断言。

### 3. 中低：新加的 sensitive/restricted 事件段补向量路径在生产上不可达；初次嵌入失败的 sensitive 事件段永远补不上

- 位置：`packages/persistence-sqlite/src/sqlite-memory-operations.ts:1397-1405,1259-1265,148`、`packages/memory-engine/src/episodes.ts:288`
- 证据：
  ```sql
  SELECT ... FROM memory_episodes e
  JOIN memory_episode_terms t ON t.rowid = e.rowid
  ...
  ```
  ```ts
  if (
    document.terms.length > 0 &&
    INDEXED_ENTITY_CLASSIFICATIONS.has(document.dataClassification)
  )
  ```
  `INDEXED_ENTITY_CLASSIFICATIONS = new Set(["public", "private"])`。因此 sensitive/restricted 事件段根本不会出现在 `listUnembedded` 里，新加的 `isModelVisible` 跳过和 `within` 分级在现有生产路径是死代码；`episode-backfill.unit.test.ts` 用 Store 桩绕过了这条 SQL。
- 额外后果：`#record` 在创建事件段时会直接 `embedder.embed`（`episodes.ts:338-344`），失败只记 `onEmbeddingFailure` 并存入空向量；由于该 sensitive 段没有 terms，之后**永远无法被补算**。这不是本 PR 之前的回归（之前 sensitive 段根本不生成），但和“事件段按自身分级补向量”的目标存在缺口。
- 建议：在 ADR/测试里明确“本 PR 不覆盖真实 SQL 路径”；如果希望 sensitive 段可补算，应让 `listUnembedded` 不依赖 terms（同时保留 `isModelVisible` 硬过滤），或在创建失败时登记可回填队列。

### 4. 中低（条件成立）：旧配置的模型名单不含 `sensitive` 时，Gmail 检查会整次失败而不是退化为只用 private 记忆

- 位置：`apps/agent-service/src/production-proactive-memory.ts:52`、`packages/application/src/services/proactive-mail-check-service.ts:1084-1088`、`apps/agent-service/src/production-model-composition.ts:521-523`
- 证据：
  - 召回改用 `modelVisibleClassifications()`（`["public","private","sensitive"]`），所以以前只召回 private 的 Gmail 检查现在会带入 sensitive 记忆。
  - `#judge` 用这些记忆算出 `dataClassification` 并传给 `model.prepare`；`prepare` 在名单不含该分级时直接 `throw new Error("PROACTIVE_MODEL_DISCLOSURE_DENIED")`。
  - 调用处 `.catch(...)` 把异常变成 `MODEL_CALL_ERROR`，随后 `stop = "failed"`（`proactive-mail-check-service.ts:770-790`），整次检查失败。
- 影响：错误是“失败关闭”的，但对没按 ADR 0192 更新模型名单的既有部署，升级后会因为一条敏感记忆导致所有 Gmail 检查失败，而不是只跳过那条记忆。生产模板已加 sensitive（`production-shape-config-template.json:104-108`），但启动时没有校验名单必须含 sensitive。
- 建议：要么在启动配置校验里要求启用的对话/嵌入模型包含 sensitive；要么在名单不含 sensitive 时让 Gmail 召回退化为 public/private，而不是让整次检查失败。

### 5. 低：文档说“不认识的分级直接报错”，实际只有 `highestClassification` 报错；`isModelVisible`/`classificationRank` 静默降级

- 位置：`packages/application/src/services/model-visibility.ts:24-29,36-40`、`docs/adr/0192-memory-is-visible-to-the-model.md:59`
- 证据：
  ```ts
  export function isModelVisible(classification: string): boolean {
    return (MODEL_VISIBLE as readonly string[]).includes(classification);
  }
  ...
  export function classificationRank(classification: DataClassification): number {
    return RANK[classification];
  }
  ```
  `isModelVisible("secret")` 返回 false，`classificationRank("secret" as never)` 返回 `undefined`。事件段、历史、记忆过滤都用 `isModelVisible`，未知值会被静默丢掉而不是报错。
- 建议：要么把 ADR 改成“`highestClassification` 遇到未知值报错，可见性判断按不可见处理”，要么让 `isModelVisible` 对未知值抛错（并检查所有调用方能把错误落到合适的失败路径）。

### 6. 低：`ProductionRuntimeTools` 的分级下限用的是“基础运行分级”，不是已经抬升的可见分级

- 位置：`packages/runtime-pi/src/pi-runtime-adapter.ts:1965`、`apps/agent-service/src/production-runtime-tools.ts:675-681`
- 证据：
  - 工具 invocation 的 `dataClassification` 始终是 `request.dataClassification`，不是 `#visibleOf(request)`：
    ```ts
    dataClassification: request.dataClassification,
    ```
    而同文件其它地方（`1160`、`1583`、`2041`）已经在用 `#visibleOf`。
  - 于是“本运行已因敏感记忆抬升为 sensitive”之后调用的后续工具，其 invocation 仍是 private；`recorded = highestClassification(invocation.dataClassification, ...)` 的下限仍是 private。
  - 模型可见历史在后续捕获时用的是 `#visibleOf`（`pi-runtime-adapter.ts:1620`），所以模型侧没有问题；风险在于工具结果**留档/工具内部按 invocation.dataClassification 选模型**的地方（例如 `production-file-read-services.ts:200`）可能把实际已处于敏感上下文中的后续工具输出仍标成 private。
- 建议：至少把工具结果记录的 floor 改为 `#visibleOf(request)`，或明确 ADR 的“运行分级”就是基础请求分级并在文档里写清这个差别。

### 7. 低：`[OM-14]` 用例标题说“even at low priority”，但本轮把该封邮件的 priority 从 low 改成了 medium

- 位置：`test/integration/proactive-mail-check.test.ts:2068,2082`
- 证据：
  ```ts
  it("[OM-14] keeps the older reminder open when the owner's own mail is judged act even at low priority", ...)
  ...
  h.script([{ id: "promise", result: "act", todo: "来月連絡する", priority: "medium" }]);
  ```
- 影响：原来的 low 场景会被 `keepOffReminderPage` 降成 ignore（`proactive-rules.ts:81-92`），改后实际测的是 medium 的 act 场景；标题与覆盖的路径不一致，low 优先级的反向覆盖丢失。
- 建议：要么改回 low 并保留该反向用例，要么把标题改成 medium，并另加一个明确验证 low 被降级但不影响旧提醒的用例。

### 8. 低：`#record` 仍然对任意 `indexed` 事件段直接嵌入，绕过 `within`/可见性硬边界

- 位置：`packages/memory-engine/src/episodes.ts:338-344`
- 证据：`#record` 里 `if (embedder && input.indexed) { ... await embedder.embed(...) }`，没有 `isModelVisible` 检查，也没有 `within`；而 `backfillEmbeddings` 有这两道。当前 `dueSegments` 只生成到 sensitive，所以生产走不到 restricted；但 `summarize` 是公开方法，未来若有别的调用方传入 restricted 段，会直接把 restricted 文本发给嵌入模型。
- 建议：在 `#record` 里同样用 `isModelVisible` 保证 invariant，或把嵌入动作统一收敛到一个受 `within` 约束的方法。

## 侧重检查

- **错误路径**
  - `highestClassification` 对未知值/`undefined` 抛 `TypeError`（`model-visibility.ts:36-40`）；`production-runtime-tools` 的 `try` 会接住它并把工具结果标成失败（`production-runtime-tools.ts:676-708`），不会把未知值写进 payload。这是失败关闭，符合方向。
  - 回填的 `within` 抛错会被 `production-memory-episodes.ts:85` 的 `catch(onFailure)` 接住，随后仍继续 `dueSegments`；不会阻断事件段摘要。
  - Gmail `model.prepare` 的名单拒绝会变成整次检查失败（见问题 4），这是现有错误路径里最需要注意的降级问题。
- **不可信输入**
  - 工具返回的 `contentClassification` 是外部/能力提供的字符串；现在会经 `highestClassification` 校验，未知值使该工具结果失败，而不是被当成低分级。未发现把未知值写库的路径。
  - 数据库读出的 classification：相关表（payloads、thread_messages、runtime_history、memory_episodes、model_invocation 等）都有四种枚举 CHECK（例如 `0001_initial_product_schema.sql:61`、`0053_memory_episodes.sql:13`），因此 `DATA_CLASSIFICATION_UNKNOWN` 在现有数据库路径上不会误报。**未发现误报路径**；真正的未知值只可能来自工具/外部适配器返回值。
- **安全**
  - restricted 仍被 `isModelVisible` 挡在模型和 embedding 之外（`episodes.ts:288`、`production-memory-recall.ts:219`、`context-formation`s `VISIBLE_RANK`）；`#raiseVisible` 遇到 restrict 会抛 `RUNTIME_CONTENT_NOT_MODEL_VISIBLE`（`pi-runtime-adapter.ts:1163-1175`）。
  - Gmail sensitive 提醒的概览/推送仍然能读出（`seal.open` 不按 classification 限制），这是本次要求核实的点，代码层面成立；但这也意味着敏感提醒文本会进入 Web Push，属于既有推送行为，不是本次新增的访问控制。
  - `ProactiveSealPort.seal` 的 `dataClassification` 是可选的，默认 private（`proactive-seal.ts:13`）。未来新调用方漏传会静默低标；`#seal` 默认参数同理。建议对“提醒内容”这类必须显式分级的路径保持必填。
- **资源耗尽 / 不可撤销**
  - 回填固定 `limit: 1`（`production-memory-episodes.ts:81`），没有新增无界循环或重试；未发现新的资源耗尽风险。
  - 本次没有删除/覆盖历史内容，都是新增 classification 元数据；未发现不可撤销操作。
- **规则/文档与代码一致**
  - ADR 0192:59 的“事件段补算向量按每段分级、restricted 不算向量”在服务层属实，但生产目前选不中 sensitive/restricted 段（见问题 3）。
  - ADR 0192:59 的“遇到不认识的分级直接报错”只对 `highestClassification` 成立，对 `isModelVisible`/`classificationRank` 不成立（见问题 5）。
  - `[OM-14]` 标题与 priority 不一致（见问题 7）。

## 必答问题

**1. 这个改动会不会改变模型已经见过的请求开头？**

- **增量 f9a440d1..3dc426a8 本身：不会。** 事件段回填只影响 embedding；Gmail 存档只影响 payload 的 classification；工具结果改的是 metadata 和写入 payload 的 classification，`modelContent` 原文未变；`highestClassification` 只是校验。没有改系统提示、工具定义、历史文本或遮盖规则。
- **整个 PR：对新对话仍只在末尾追加；对老对话有一次 ADR 明确接受的请求开头变化。** `context-formation-service.ts` 把上限从 `maxMemoryClassification` 改成固定的 `modelVisibleCeiling()`（第 146-228、270-308 行），使老对话里以前被挡的 sensitive 历史/摘要/记忆现在进入历史中段。这正是 `.claude/rules/prompt-prefix.md:35` 记录的例外（ADR 0192 后果），新对话不受影响。
- **每轮变化的值仍在最后一条消息里**：记忆、资料块、运行环境块都通过 `turnPrompt` 拼在最后一条用户消息（`pi-runtime-adapter.ts:600-618`）；新的 `contentClassification` 只作为元数据传给准入和记录，不进入提示文本。
- 需要留意的脆弱点：Gmail 侧调用为了保持字节不变，在 `proactive-mail-check-service.ts:383-395` 显式把 `dataClassification` 从记忆 JSON 中映射掉；如果以后有人改回直接 `JSON.stringify(memories)`，分类字段会进入 prompt，改变请求字节。

**2. 会不会让同一段文字在不同请求里变成不同的字节？**

- 没有发现新的字节不确定来源。新增分级计算 `highestClassification` 与顺序无关；`proactivePrompt` 的字段顺序保持 `{mailId,id,text,tentative?}`；没有新增时间字段、无序集合或依赖后文的遮盖。
- Gmail 提醒的**存档** ciphertext 每次不同，因为加密使用随机 nonce（`payload-protector.ts:194-224`），但这不是模型请求，且明文和 classification 是确定的。
- 唯一“随上下文变化”的是提醒的**存档分级**（整批最高），会因同批邮件不同而不同（问题 2）；它不影响模型请求字节，只影响存储标签。

**3. 改动有没有对应的自动检查，反向用例是否真的会失败？**

- 有：
  - `model-visibility.unit.test.ts` 覆盖未知值/`undefined` 抛错，覆盖 `isModelVisible` 的边界。
  - `episode-backfill.unit.test.ts` 覆盖 sensitive/private 各自分级、restricted 不嵌入；但用的是 Store 桩，不覆盖真实 SQL 和真实准入。
  - `proactive-mail-check.test.ts:1822-1858` 覆盖 sensitive → sensitive、private → private。
  - `memory-model-visible.test.ts` 覆盖 sensitive 记忆/附件/工具结果抬升和 private 反向。
- 不足/反向减弱：
  - 没有测试 `backfillEmbeddings` 在真实准入下 `limit > 1` 时的槽位唯一性（问题 1）。
  - 没有测试 sensitive 存档后 `overview()` 和推送仍能读出（问题 2）。
  - `production-runtime-tools` 的“工具不能把分级报低”没有直接用例：`production-runtime-tools.unit.test.ts` 只返回 private（第 1464-1470 行），真正的 floor 由 `model-visibility.unit.test.ts` 间接覆盖。
  - `[OM-14]` 原来覆盖 low，现改成 medium（问题 7）。
- 我无法运行测试，所以无法确认这些用例在当前提交上实际通过。

**4. 每个新值/改动值，产生处和使用处两端都能接受吗？**

- `RuntimeProjection.contentClassification`：产生于 `context-projection-service.ts:93-102`，使用于 `pi-runtime-adapter.ts:1249`（`#raiseVisible`）和测试。类型合法；未知值会被 `highestClassification` 拒绝；`restricted` 会使运行失败（有意）。
- `RuntimeToolSettledResult.contentClassification`：产生于 `production-runtime-tools.ts:695`、`production-memory-recall.ts:279`，使用于 `pi-runtime-adapter.ts:2041-2042`。目前只有记忆检索会产生（private/sensitive），不会产生 restricted；符合“fail closed”。
- `ProactiveSealPort.seal.dataClassification`：产生于 `proactive-mail-check-service.ts:1063-1067` 和 `proactive-seal.ts:13` 的默认值；写入 `payloads` 前经过 `PayloadProtector`，payloads 表 CHECK 接受四种值；读取端 `seal.open` 不看 classification，概览/推送接受。除提醒内容外，其它 `seal.seal` 调用都省略该字段，保持 private，行为不变。值本身没问题；默认 private 是“漏传即低标”的风险。
- `ProactiveMemoryHit.dataClassification`：产生于 `production-proactive-memory.ts:63`（来自 DB，CHECK 合法），使用于 `proactive-mail-check-service.ts:1233,1086`（`highestClassification` 会拒绝未知值）。接受。
- `MemoryEpisode.dataClassification` / `EpisodeSegment.dataClassification`：产生于 `episodes.ts:174`（`highestClassification("private", included)`），写入 `memory_episodes`（CHECK 合法），使用于 `episodes.ts:191,202,300`。接受。唯一缺口是 `#record` 的直接嵌入没有走可见性守卫（问题 8）。
- `MemoryEpisodeService.backfillEmbeddings.within`：新增可选参数，使用于 `production-memory-episodes.ts:82`，集成测试调用时省略也没问题。接受，但槽位设计有隐患（问题 1）。
- `RunPolicyConfiguration.retiredKeys`：产生于 `strict-configuration.ts:1177-1179`，仅在 `service-main.ts:658-662` 写日志；键值未校验，但内容是受信配置、且旧键确实不再生效，风险可接受。
- 被删除的 `maxMemoryClassification`：代码里已无引用（只有文档、测试和 qualification probe 还提旧键），配置解析会把它收进 `retiredKeys` 并继续启动。两端一致。
- `ProactiveCheckInsight.dataClassification`：两个构造点（`proactive-mail-check-service.ts:820-833`、`883-896`）都赋值；`#gateBackoff` 展开时保留；`#finish` 传给 `#seal`。类型层面两端一致；语义上是整批最高而非逐邮件（问题 2）。
