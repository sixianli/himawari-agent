## 结论

发现的问题按严重度排列。标「读代码证实」的，是我在当前检出代码里直接读到的；标「推测」的，是按代码路径推断、未复现。

### 中：首页打分请求的输入提示 payload 没有被释放

- 文件:行：`packages/application/src/services/home-urgency.ts:521-555`
- 问题（读代码证实）：`#invoke` 把提示写进 `authority.inputRef`，结束时只释放 `outputs`，始终没有释放 `inputRef`。`home_item_scores` 也没有存这个引用，所以没有任何后续路径会清它。每次打分都会在 `payloads` 里留下一条无引用的提示明文（已加密，但仍是主人内容，含审批收件人、标题等）。
- 证据：

```ts
// home-urgency.ts
527:        inputRef: authority.inputRef,
...
553:    } finally {
554:      await authority.release().catch(() => undefined);
555:      await model.release(outputs).catch(() => undefined);
556:    }
```

对照已有后台调用，`proactive-mail-check-service.ts:1279-1280` 明确把 `authority.inputRef` 放进 `trace.payloads`，并在 `:761-763` 释放：

```ts
1280:    trace.payloads.push({ ref: authority.inputRef, role: "model_input" });
...
761:        if (trace.payloads.length > 0)
762:          await this.#options.model
763:            .release(trace.payloads.map(({ ref }) => ref))
```

- 建议：在 `finally` 里把 `authority.inputRef` 和 `outputs` 一起交给 `model.release`，或在 `#run` 末尾统一释放；并仿照 `apps/agent-service/test/model-payload-cleanup.unit.test.ts:204-220` 增加首页打分的清理用例。否则长期运行会无界累积提示 payload，也不符合“删除数据时一并清掉”的预期。

### 中：`homeUrgency.modelRef` 的配置校验和实际模型出口不一致

- 文件:行：`packages/platform-node/src/strict-configuration.ts:1820-1832`，`apps/agent-service/src/production-model-composition.ts:508-513`
- 问题（读代码证实）：配置校验只要求“不是 embedding、接受 private”，没有要求 `api === "openai-completions"`；但 `proactiveModel` 会拒绝非 completions 的模型。于是 `homeUrgency.modelRef` 指向 `typesafe-systemone` 模型时，配置校验通过，服务启动时 `proactiveModel` 抛 `PROACTIVE_MODEL_DISCLOSURE_DENIED`，不是清晰的配置错误。
- 证据：

```ts
// strict-configuration.ts
1823:    if (
1824:      !descriptor ||
1825:      descriptor.role === "embedding" ||
1826:      !descriptor.allowedDataClassifications.includes("private")
1827:    )
```

```ts
// production-model-composition.ts
508:    const descriptor = options.descriptors.find((item) => item.ref === modelRef);
509:    if (
510:      descriptor?.api !== "openai-completions" ||
511:      !descriptor.allowedDataClassifications.includes("private")
512:    )
513:      throw new Error("PROACTIVE_MODEL_DISCLOSURE_DENIED");
```

- 建议：像 `realEval` 的校验一样加入 `descriptor.api !== "openai-completions"`，并在 `startup-configuration.unit.test.ts` 里加一个 specialist/非 completions 的拒绝用例。这正是 I-73 说的“清单/配置产生的值要能通过下一段校验”。

### 中：来源记忆被删后，待重审规则会退回 `private`

- 文件:行：`apps/agent-service/src/production-memory-control.ts:425-444`，`apps/agent-service/src/production-owner-rules.ts:522`
- 问题（读代码证实逻辑，实际泄露取决于摘要内容）：`#ruleClassification` 在 `sourceMemoryId` 为空、记录不存在或不属于本人时直接返回 `private`。但规则的 `summary` 仍保存在规则参数里；规则的来源记忆被删除后，规则仍可能是 `needs_review`，`summary` 还在。若原记忆因摘要里的收件人、金额等被判为 `sensitive`，删除来源后这条规则会被降为 `private`，在首页打分时可能作为 `facts.label` 发给只接受 `private` 的模型。
- 证据：

```ts
// production-memory-control.ts
439:  ): Promise<ProductMemoryRecord["dataClassification"]> {
440:    if (!sourceMemoryId) return "private";
441:    const record = await this.options.state.read(sourceMemoryId as MemoryId);
442:    if (!record || record.ownerId !== this.options.configuration.ownerId) return "private";
443:    return classificationRank(record.dataClassification) > classificationRank("private")
444:      ? record.dataClassification
445:      : "private";
```

规则内存文本本身包含摘要：

```ts
// production-owner-rules.ts
522:        text: `${proposal.quote}\n${parsed.summary}`,
```

现有测试也证明了来源删除后规则仍保留摘要、只是 `quote` 变空：`test/integration/production-memory-capture.test.ts:2192-2200`。

- 建议：在规则上持久化创建时的分级（或至少随规则保存），来源不可读/已删除时使用保守上限；如果只能用来源记忆，缺失时不要退回 `private`。另外这里只检查了 `ownerId`，没有检查 `agentId` 和 `status`，也建议一并核对。

### 低：单条规则读失败会让整组规则从首页消失

- 文件:行：`apps/agent-service/src/production-memory-control.ts:425-434`
- 问题（读代码证实）：`rulesNeedingReview` 用 `Promise.all` 并发读取每条规则的来源记忆，没有逐条 `catch`。任一 `state.read` 失败都会让整个 `rules` source 抛错，`HomeFeedService.#collect` 会把这个 source 整体跳过，所有规则一起消失，而不是只有读不到的那条降级。
- 证据：

```ts
425:  async rulesNeedingReview() {
426:    const rules = ((await this.options.ownerRules?.list()) ?? []).filter(
427:      ({ status }) => status === "needs_review",
428:    );
429:    return Promise.all(
430:      rules.map(async (rule) => ({
431:        ...rule,
432:        dataClassification: await this.#ruleClassification(rule.sourceMemoryId),
433:      })),
434:    );
```

- 建议：逐条读失败时退回保守分级并继续，或用 `readMany` 一次读取并处理缺失项；不要把整个 source 连坐。

### 低：声称核对了“语言”，实际只核对了打分时记录的语言标签

- 文件:行：`packages/application/src/services/home-urgency.ts:304-309`，`:135-140`
- 问题（读代码证实，文档/说法与代码不一致）：`approvalCopy` 只比较 `row.copyLocale === input.locale`。`copyLocale` 是打分时请求的语言，不是模型实际写出的语言。模型如果被要求写英文却写了中文，只要 `copyLocale` 当时记为 `en`，读取时就会当作合格。ADR 和作者说法里的“文字的语言和读的人的语言不同”并不成立，成立的是“打分时请求的语言和读取语言不同”。
- 证据：

```ts
304:    if (
305:      row === undefined ||
306:      row.approvalRequestId !== input.approvalRequestId ||
307:      row.copyLocale !== input.locale
308:    )
309:      return { sentence: null, affirmLabel: null };
```

- 建议：要么在 ADR/说明里改成“请求语言一致”，要么真正做语言检测；不要声称已经核对了文字本身的语言。

### 低（推测）：`stopScoring` 可能无限等待

- 文件:行：`packages/application/src/services/home-urgency.ts:510-515`、`:523`，`apps/agent-service/src/production-home.ts:775-779`
- 问题（推测）：`stopScoring` 等待 `#running` 结束，但 `model.prepare` 没有 abort signal，只有模型 `invoke` 用了 `AbortSignal.timeout`。如果具体模型实现或准备阶段不响应超时，服务关闭会一直卡在 `await this.#urgency?.settled()`。
- 证据：

```ts
510:    const authority = await model.prepare({
511:      invocationId,
512:      prompt,
513:      deadlineAt: new Date(startedAt + settings.requestTimeoutMs).toISOString(),
514:      dataClassification,
515:    });
...
523:        signal: AbortSignal.timeout(settings.requestTimeoutMs),
```

- 建议：给准备和整个打分收尾一个有界等待，或保证 `prepare` 也受 deadline/abort 约束；否则一次模型端异常就能拖住停服。

---

## 侧重检查

- **错误路径**：`recordCall` 在事务里整批插入，唯一索引冲突会回滚整批（`sqlite-home-urgency-operations.ts:256-275`），存储失败时服务会释放已密封句子并做内存退避（`home-urgency.ts:480-489`）。这一部分与作者说法一致。遗漏的是输入提示 payload 的释放，见上。
- **不可信输入**：模型输出限制分数 0–1000、编号范围、重复编号取第一条、句子 400 字符、按钮 64 字符，并拒绝控制字符和主要双向控制符（`home-urgency.ts:127`、`:223-241`）；提示词也明确把条目内容标成不可信数据。未发现新的注入或崩溃路径。
- **分级与遮盖**：`restricted` 在 `#run` 开头被过滤；未获准的条目只发 `kind`/`deadline` 和参照分数；事实先过 `maskSensitiveText`，对象键排序。规则来源缺失时的 `private` 回落是本次新引入的风险点，见上。
- **删除/不可撤销**：`home_item_scores` 有 UPDATE 拦截、DELETE 触发器（`0095_home_item_scores.sql:48-58`）；`#runPayloadRefs` 会把审批句子引用纳入删除（`sqlite-governed-deletion.ts:1043-1052`），集成测试 `home-urgency.test.ts:1240-1267` 覆盖了线程删除后分数和密封句子一起清掉。直接单独删除 `approval_requests` 会级联删分数，但不会走 `#runPayloadRefs` 清句子 payload；目前没看到这种单独删除的生产路径，标为未证实的产品风险。
- **资源耗尽**：输出有 16KB 上限，`perCall`/`referenceLimit`/每日次数费用都有上限，读取按 2000 分批；但输入提示 payload 无引用累积（见上），审批 `facts` 也没有统一的字段长度上限，异常大的 intent 可能放大提示和费用估算。
- **规则/文档一致性**：ADR 0255 的大部分决定与代码一致；不一致主要是“语言核对”的表述和 claim 11 缺失来源时的 `private` 回落。`docs/incidents-and-gates.md#I-73` 所要求的配置值到消费端校验问题，在 `homeUrgency.modelRef` 上仍然存在。

---

## 作者说法逐条核对

1. ✅ 基本符合。唯一索引 `home_item_scores_done` 和 `recordCall` 事务能保证同 item/同 digest 只有一行成功记录、整批回滚；但测试 `home-urgency.test.ts:1139-1217` 是顺序重复插入，不是真实并发写者。
2. ✅ 符合。失败记录按 `created_at >= since` 过滤，内存 `#storeFailedAt` 也会退避；存储失败路径释放了已密封句子。
3. ✅ 符合。`countSince` 按 `invocation_id` 分组、取 `max(cost_micros)`（`sqlite-home-urgency-operations.ts:131-138`）。
4. ✅ 对经过 governed deletion 的线程/运行删除成立，测试覆盖；直接删审批行的句子 payload 清理未覆盖（推测风险）。
5. ✅ 对现有有效行基本成立；`approvalCopy` 和首页读都会校验指纹、`copyLocale` 和按钮文字规则，返回同一份文字。推送仍未接上。
6. ✅ 代码上是独立 `proactiveModel` 请求，写入自己的 payload，不改线程提示、工具或历史。
7. ✅ 两部分测试都存在，另外还有 `test/integration/home-feed.test.ts`。
8. ✅ 标题分级不高于审批分级才放进 `conversation`（`production-home.ts:532-537`）。
9. ✅ `scores()`、`#run` 的 `listScores`/`listRecentFailures` 都按 2000 分批；测试主要验证了 `scores()` 跨 2000 边界和单次读取上限拒绝，失败记录的分批没有单独覆盖。
10. ✅ 模型输出解析和读时按钮校验都拒绝 Cc、Zl、Zp、U+061C、U+200E/F、U+202A–202E、U+2066–2069。
11. ⚠️ 来源记忆存在时取来源分级并夹到不低于 `private`；来源被删后回落到 `private`，可能低于原分级，见上。
12. ✅ 正常路径会等当前打分结束；但等待没有上限，见上。

---

## 必答问题

**1. 会不会改变模型已经见过的请求开头？**

对已经发出的对话请求：不会。打分走独立的 `proactiveModel` 调用，提示写到自己的 payload（`production-model-composition.ts:530-540`），没有修改线程的提示、工具或历史。

对这个新的后台请求本身：固定提示 `HOME_URGENCY.text` 在最前，`参照：` 和 `新条目：` 是本次输入、位于中间，最后一行才是 `now/timeZone/language/affirmMax`（`home-urgency.ts:178-196`）。所以它不是“只在末尾追加”的历史结构；不过每次都是全新的独立请求，不存在改写此前已发请求前缀的问题。若期望多次首页打分之间共享稳定前缀，`参照` 段会破坏前缀复用；这是设计取舍，不是对已发内容的修改。

**2. 同一段文字会不会在不同请求里变成不同字节？**

不会因为前后文遮盖而变化：`maskSensitiveText` 对每个事实独立调用，`maskFact` 递归排序对象键，`open` 按 item key 排序，数组保持源顺序。固定的单元测试 `home-urgency.unit.test.ts:81-105` 和集成测试 `home-urgency.test.ts:588-602` 覆盖了键顺序和存储顺序不影响输出。会变的只有最后一行的 `now`，以及本次参照集/新条目集本身；这是输入变化，不是同一输入的不同字节。注意 `Object.fromEntries` 遇到纯数字键时 JS 会按数字排序，但当前事实键都是固定字符串，不影响。

**3. 有没有对应自动检查，反向用例会失败吗？**

有：方向控制字符、2000 分批、停止等待、删除后清分数和句子、按钮文字回落、标题分级、每日上限/重试、同一文本唯一成功行都有对应用例；从代码看，去掉这些修复后对应用例应该会失败（本轮只读代码，未运行测试）。

缺口：没有真实两个并发写者的用例（只有顺序重复插入验证事务回滚）；没有首页打分输入 payload 释放的用例；没有 `homeUrgency.modelRef` 指向非 `openai-completions` 模型的拒绝用例；没有“单条规则来源读取失败”的降级用例；“语言”只测了语言标签不一致，没有测模型实际写错语言。

**4. 每个产生或修改的值，使用它的地方都能接受吗？**

大体能对上：`HOME_URGENCY_ITEMS_PER_READ = 2000` 对存储端 `ITEM_LIMIT = 2000`；按钮 64 字符对 DB 检查和合约上限；`home-urgency` 用途同时出现在迁移、`MODEL_USAGE_PURPOSES` 和控制中心文案；`homeFeed`/`homeUrgency` 数值边界和消费端一致；`HOME_KEY_MAXIMUM = 160` 比 DB 的 256 更严，不会产生存不进去的 key。

确认对不上的一处是 `homeUrgency.modelRef`：配置端接受非 `openai-completions` 的 generation 模型，`proactiveModel` 端拒绝，导致启动失败。另一个是规则来源缺失时 `private` 回落的语义值，见上。
