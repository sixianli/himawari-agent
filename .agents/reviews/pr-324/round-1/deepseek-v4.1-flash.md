## 侧重检查（先于结论）

- **不可信/不合规范输入**：`isModelVisible(string)` 对任意字符串返回 false（`model-visibility.ts:23-25`），不会崩溃；`highestClassification` 对运行时缺失/非法的 classification 会因 `RANK[value] === undefined` 而静默忽略，只保留 floor（`model-visibility.ts:35-41`）。类型层面有约束，但这是“上游一旦给错值就低标”的信任边界。
- **错误路径**：`#raiseVisible` 对非模型可见分类直接 `throw TypeError`（`pi-runtime-adapter.ts:1163-1168`）；工具返回 restricted 会让整个 run 失败，这符合“restricted 不给模型”，但不是优雅降级。准入拒绝在 fetch 之前（`pi-runtime-adapter.ts:971-990`），请求确实不会发出。
- **安全/隐私**：restricted 在上下文、历史、工具检索、整理、事件段、Gmail、每日复盘各路径都被过滤（见下）；但发现最终回答/助手消息仍按运行分级落库，见问题 1。事件段补嵌入仍是旧分级，见问题 6（ADR 已承认）。
- **资源耗尽**：`#visibleClassification` 在 run 的 finally 里删除（`pi-runtime-adapter.ts:1150-1156`）；`modelVisibleClassifications()` 是冻结常量，没有无界增长或重复分配问题。
- **不可逆操作**：本次没有新增不可逆操作；置顶、整理的事务行为未被改动。
- **规则/文档一致性**：prompt-prefix 的“只追加、字节确定”没有被破坏（见必答 1、2）；但 ADR 0185 仍有与代码冲突的旧结论（问题 2）。

---

## 发现（按严重度）

### 1. 高【读代码证实】最终回答、助手消息、运行内 trace 仍按运行分级（private）落库，敏感记忆内容被“降级”

**文件:行**
- `packages/runtime-pi/src/pi-runtime-adapter.ts:1809-1813`
- `packages/runtime-pi/src/pi-runtime-adapter.ts:2126-2137`、`:2210-2219`
- `packages/application/src/services/context-projection-service.ts:152-169`
- `packages/persistence-sqlite/src/sqlite-run-lifecycle-operations.ts:762-794`、`:837-849`
- `packages/memory-engine/src/episodes.ts:154-174`、`:186-189`

**问题**
`captureHistory` 已经改成 `this.#visibleOf(request)`（`:1617-1621`），但最终回答仍是：

```ts
const contentRef = await this.#dependencies.projection.captureFinalAnswer({
  runId: request.runId,
  text: redactMachineSecrets(text),
  dataClassification: request.dataClassification,
});
```

`request.dataClassification` 仍是运行分级（private）。`ContextProjectionService.captureFinalAnswer` 用该值写入 final_answer payload（`:163-169`）。随后 run completion 直接用 final answer payload 的分类来提交助手消息：

```ts
let dataClassification = input.dataClassification;
if (input.output.kind === "assistant-answer") {
  ...
  dataClassification = classification(answer["classification"]);
}
...
this.thread.commitAssistantMessage({ ..., dataClassification, ... });
```

因此，当本轮 `memory.recall` 返回敏感记忆、模型在回答里复述“主人对青霉素过敏”时，最终回答和助手消息仍标为 private。`MemoryEpisodeService` 只看消息的 `dataClassification`（`:154-174`），会把这段回答当作 private 内容生成 private 事件段，并把摘要生成调用按 private 准入（`:186-189`）。这直接违反目标 4“派生内容取来源的最高分级”，也让敏感文本有机会以 private 名义发给只批准 private 的服务方。

（`runtime.message`、`tool_result`、`provider_request` 等 trace 也同样使用 `request.dataClassification`，虽不直接进模型，但属于同一分类失真。）

**建议**
至少让 `captureFinalAnswer` 使用 `this.#visibleOf(request)`；消息/工具 result trace 若会影响下游派生分类，也应一并使用。补充反向测试：在 `memory.recall` 返回 sensitive 后，断言最终回答 payload 和提交的助手消息分类为 sensitive。当前 `test/integration/memory-model-visible.test.ts` 的 `captureFinalAnswer` 是直接返回 `"final-answer"` 的桩，覆盖不到这个缺口。

---

### 2. 中【读代码证实】ADR 0185 与代码不一致：仍写“sensitive 不带入档案块”

**文件:行**
- `docs/adr/0185-mark-passwords-and-keys-sensitive-instead-of-dropping-them.md:61`
- `packages/application/src/services/owner-profile-service.ts:327-330`
- `packages/application/src/services/context-formation-service.ts:228-233`

**问题**
ADR 0185 仍写：

> `sensitive` 记忆不进全文和实体索引、不带入档案块……

但代码现在明确把 sensitive 记忆纳入档案块：

```ts
const dataClassification = highestClassification(
  floor ?? "public",
  memories.map(({ dataClassification }) => dataClassification),
);
```

且 `context-formation-service.ts` 以 `modelVisibleCeiling()`（sensitive）调用 `profile.compose`。新增的括注只纠正了“模型看不到”，没有纠正“不带入档案块”，与 ADR 0192 自己的说明也不一致。

**建议**
在 ADR 0185 的括注里同时声明“档案块限制已由 ADR 0192 取消”，或改写原句，避免后续按旧结论做安全判断。

---

### 3. 中低【推测，需核实】敏感历史消息里的附件仍按运行分级读取，可能让投影直接失败

**文件:行**
- `packages/application/src/services/context-projection-service.ts:352-359`
- `packages/application/src/services/context-projection-service.ts:481-514`
- `packages/application/src/services/context-projection-service.ts:526-547`

**问题**
历史消息本身允许读到 sensitive：

```ts
const stored = await this.readText(input, item.contentRef, "context history", item.dataClassification, modelVisibleCeiling());
const content = item.role === "owner" ? await this.expandAttachments(input, stored) : stored;
```

但 `expandAttachments` 内部读取附件时没有传 ceiling：

```ts
await this.readText(input, ref as PayloadRef, "attachment")
```

`readText` 默认 ceiling 是 `input.dataClassification`（运行分级）。如果一条 sensitive 历史消息带 sensitive 附件（上传接口允许任意分级，`http-gateway-server.ts:1272-1289`），历史消息能通过，附件会抛 “Payload exceeds the Run data classification”，整个 run 失败。需要确认附件分级是否可能高于运行分级；代码本身允许这种组合。

**建议**
把 `expandAttachments` 的 ceiling 显式传成当前消息的可见上限（sensitive），或在 `readText` 调用处传 `modelVisibleCeiling()`。

---

### 4. 低【读代码证实】反向准入用例用的是桩，不是真实准入服务；且缺少最终回答分类的反向用例

**文件:行**
- `test/integration/memory-model-visible.test.ts:319-334`
- `packages/application/src/services/model-invocation-admission-service.ts:481-487`

**问题**
用例里的 `admission` 是测试自定义函数，直接：

```ts
if (!input.allowed.includes(admission.dataClassification))
  throw new Error("Model descriptor does not allow the requested data classification");
```

它不是 `ModelInvocationAdmissionService.#validateInput`。因此这条“反向用例”验证的是“适配器把升高后的分级传给了 gate，且 gate 拒绝时不发请求”，并没有走真实的描述符校验。真实校验确实存在（`model-invocation-admission-service.ts:482`），但这条集成用例不能单独证明它。

同时没有反向用例覆盖：restricted 工具结果、敏感工具结果导致最终回答/助手消息分类升高（即问题 1）。

**建议**
用真实 `ModelInvocationAdmissionService` 或补一条针对 `allowedDataClassifications` 的集成断言；并补最终回答分类的反向用例。

---

### 5. 低【读代码证实】`ProactiveMemoryHit.dataClassification` 可选且默认 private，依赖实现方自觉

**文件:行**
- `packages/application/src/ports/proactive-checks.ts:170-174`
- `packages/application/src/services/proactive-mail-check-service.ts:1216-1222`
- `apps/agent-service/src/production-proactive-memory.ts:59-63`

**问题**
端口字段是可选的：

```ts
readonly dataClassification?: DataClassification;
```

Gmail 服务在缺失时按 private 处理：

```ts
dataClassification: hit.dataClassification ?? "private",
```

生产实现会填，但任何其他 `ProactiveMemoryRecall` 实现如果返回敏感记忆却忘了填，就会把敏感文本按 private 送进 Gmail 判断。这是“清单字段两端校验”的弱点。

**建议**
把 `ProactiveMemoryHit.dataClassification` 改为必填；缺失即拒绝，而不是默认 private。

---

### 6. 低【读代码证实，ADR 已承认】敏感事件段的补嵌入仍按 private 分级

**文件:行**
- `apps/agent-service/src/production-memory-episodes.ts:76-83`、`:92-93`
- `apps/agent-service/src/production-run-memory.ts:121-124`

**问题**
回填嵌入使用原始 `request`：

```ts
await this.#within(request, "memory-episode-backfill", () =>
  this.#options.service.backfillEmbeddings({ ... }),
);
```

而嵌入分类取自 `context?.dataClassification`（private）。因此敏感事件段若在摘要时嵌入失败、后续被 `backfillEmbeddings` 补嵌入，嵌入请求会按 private 标注。ADR 0192 已明确把“事件段补嵌入的分级标注”留给下一个 PR，所以这是已知延后项；但如果部署的嵌入服务只批准 private，敏感文本就会以 private 名义发出。

**建议**
在下个 PR 前，至少让 `backfillEmbeddings` 按 `episode.dataClassification` 包一层 `embedWithin`；若确认本次不做，应在发布说明中明确该风险。

---

## 作者说法核对

1. **“名单只到 private 的服务方遇到含敏感内容的请求会被准入拒绝、请求不发出”**：基本成立，但集成反向用例用的是桩，不是真实准入服务（见问题 4）。真实校验在 `model-invocation-admission-service.ts:482`。
2. **“只含 private 内容的对话仍按 private 发送”**：成立。`ContextProjectionService` 的 `contentClassification` 是 floor + 所有来源最大值；只有 private 时保持 private，集成反向用例也覆盖了。
3. **“工具结果带 contentClassification 时后续模型调用按升高后的分级准入；分级记在适配器按运行 Map，运行结束清掉”**：成立。`pi-runtime-adapter.ts:1582-1583`、`:2041-2042`、`:1155`。
4. **“Gmail 检查的提示词字节不变（序列化只取原字段）”**：成立。`proactivePrompt` 显式只映射 `mailId/id/text/tentative`（`proactive-mail-check-service.ts:382-397`），golden 测试只给 fixture 增加了字段而没有改快照。
5. **ADR 0192 存在**：成立；但其“存历史都用它”的说法对最终回答/助手消息不成立（问题 1）。

---

## 必答问题

**1. 会不会改变模型已经见过的请求开头？发给模型的内容是不是仍然只在末尾追加，每轮会变的值是不是都在最后一条消息里？**

不会。`resolveProjection` 每次运行只调用一次（`pi-runtime-adapter.ts:1230-1252`），记忆/工具结果作为新的工具消息追加；`turnPrompt` 把当前时间、记忆块、运行环境、最后一条用户消息都放在本轮追加的那条用户消息里（`pi-runtime-adapter.ts:600-618`），系统提示和工具定义不变。新增的分类只影响准入元数据，不进入请求体字节。新增的 `[RULE-memory-visible]` compat 用例也验证了敏感记忆和敏感检索结果在后续轮次只追加。**本轮分类变化不改变已发请求的字节。**

**2. 会不会让同一段文字在不同请求里变成不同字节（遮盖依赖前后文、带时间的字段、无序集合）？**

未发现新增的不确定性。`highestClassification` 是求最大值，与遍历顺序无关；`modelVisibleClassifications()` 返回固定顺序的冻结数组；Gmail 提示词显式剔除新增的 `dataClassification`，字节保持不变；档案块 marker 不包含 classification（`runtime-environment-block.ts:30-43`）。没有新增时间、随机数或无序集合。需要注意：档案块会因本轮选中哪些记忆而变化，但那是新的追加内容，不是同一段已发文字的重新序列化。

**3. 改动有没有对应的自动检查，反向用例是否真的会失败？**

有，且多数反向用例在修复前应当失败：集成用例覆盖敏感记忆准入、private 名单拒绝、restricted 排除、私有对话保持 private、工具结果升高后续调用；单元/集成测试覆盖记忆检索、整理、事件段、Gmail、档案块、每日复盘、置顶、退役配置。但有三处不足：
- 准入反向用例使用桩而非真实 `ModelInvocationAdmissionService`（问题 4）；
- prompt-prefix 的 `[RULE-memory-visible]` 用例即使不修分类也会通过，因为它只验证字节追加，不验证分类；
- 缺少“敏感工具结果 → 最终回答/助手消息分类”的反向用例（问题 1）。
我无法运行测试，以上是按代码和测试断言判断。

**4. 改动产生或修改的每个值，每一个使用它的地方都能接受吗？**

- `retiredKeys`：由 `parseRunPolicy` 产生（`strict-configuration.ts:1177-1179`），由 `service-main.ts:658-664` 消费并写诊断；两端一致。
- `allowedDataClassifications` 新增 `sensitive`：严格配置和 `model-invocation-admission-service.ts:482` 都接受；配置模板已加。
- `RuntimeProjection.contentClassification` / `RuntimeToolSettledResult.contentClassification`：由投影和工具产生，适配器消费；类型为 `DataClassification`，接受。
- `EpisodeSegment.dataClassification` / `PromptMemory.dataClassification`：生产端和测试端都补齐，消费端接受。
- 置顶清单：控制中心 `PINNABLE` 与服务端 `PINNABLE_CATEGORIES` 都是 identity/preference/relationship/goal/project/rule，两端一致。
- **例外**：最终回答/助手消息的分类链没有接受升高后的可见分类（问题 1）；`ProactiveMemoryHit.dataClassification` 可选并默认 private（问题 5），是弱契约。
