## 发现的问题

未发现高危问题。以下按严重度排列。

### 中：规则来源记忆处于 `trashed` / `deletion_pending` / `deleted_verified` 时，仍使用旧分级，和「已删按 sensitive」的说法不一致

- 文件：`apps/agent-service/src/production-memory-control.ts:441-447`
- 问题（读代码证实）：`#ruleClassification` 只在记录读不到、owner 不符、agent 不符时返回 `sensitive`，没有检查 `record.status`。而 `memory_records.status` 改为 `trashed`、`deletion_pending`、`deleted_verified` 时，`0087_rule_book_memory_link.sql:301-361/363-402` 的触发器会把规则置为 `needs_review`，规则仍保留 `source_memory_id`，此时 `state.read` 仍能读到记录，于是会返回该记忆原来的 `public/private/sensitive` 分级。
- 证据：

```ts
const record = sourceMemoryId
  ? await this.options.state.read(sourceMemoryId as MemoryId).catch(() => undefined)
  : undefined;
if (!record || record.ownerId !== ownerId || record.agentId !== agentId) return "sensitive";
return classificationRank(record.dataClassification) > classificationRank("private")
  ? record.dataClassification
  : "private";
```

`home-feed.test.ts:922-939` 目前只测了 `source_memory_id = NULL`，没有测 `status = trashed/deleted_verified`。

- 建议：对 `record.status` 做明确处理，至少把 `trashed`、`deletion_pending`、`deleted_verified` 当作「已删」返回 `sensitive`；补一条真实 SQLite 用例，直接把来源记忆状态改为 `trashed` 或 `deleted_verified` 后再断言规则分级。

### 低：并发写入「后写的整批失败」只对成功行成立

- 文件：`packages/persistence-sqlite/src/migrations/0095_home_item_scores.sql:30-32`、`packages/persistence-sqlite/src/sqlite-home-urgency-operations.ts:256`
- 问题（读代码证实）：唯一索引只约束 `status = 'done'`：

```sql
CREATE UNIQUE INDEX home_item_scores_done
  ON home_item_scores(owner_id, agent_id, item_key, text_digest)
  WHERE status = 'done';
```

因此两次并发写同一件事、同一摘要时，如果后写的是 **failed** 行，它不会触发唯一约束，仍会写入成功；作者所说「两次并发写入时后写的整批失败」只对后写包含成功行的批次成立。`home-urgency.test.ts:1143` 测的是同一批次里包含重复成功行会整批回滚，也没有真正并发启动两个写入者。

- 建议：把这句说法限定为「后写的成功行批次整批失败」，或补一条真正并发两次 `recordCall` 的用例；如果希望失败行也不能与已有成功行重复，需要另加约束或写入前检查。

### 低：提示和回答的释放是 best-effort，失败路径没有测试

- 文件：`packages/application/src/services/home-urgency.ts:554-555`
- 问题（读代码证实）：释放调用被 `.catch(() => undefined)` 吞掉，所以「打分调用结束后，提示和回答都释放」在释放本身失败时并不成立。`home-urgency.test.ts:1274-1281` 只测了成功调用，没有覆盖 `model.failed`、超时、`readOutput` 抛错等失败路径。
- 证据：

```ts
await authority.release().catch(() => undefined);
await model.release([authority.inputRef, ...outputs]).catch(() => undefined);
```

- 建议：保留 best-effort 可以，但补一条模型失败/超时后仍释放输入和已产出的输出引用的用例；如果释放失败需要可观测，至少写诊断日志。

### 低：`approvalCopy` 返回的句子没有像首页读取那样再过一次 `line`

- 文件：`packages/application/src/services/home-urgency.ts:313-316`、`apps/agent-service/src/production-home.ts:546`
- 问题（读代码证实）：首页读取会再调用 `line(copy?.sentence, 2000)`，而 `approvalCopy` 直接返回 `seal.open` 得到的原文。对当前正常写入的数据两者相同（写入时 `parseHomeUrgency` 已拒绝控制字符和方向字符），但未来推送直接读 `approvalCopy` 时，没有读取时的二次校验；ADR 里「读取时逐项核对……含换行、控制字符或改变文字方向的字符」在这条路径上只对按钮文字成立。
- 证据：

```ts
return {
  sentence: sentence ?? null,
  affirmLabel: acceptsHomeAffirmLabel({...}) ? row.affirmLabel : null,
};
```

```ts
const sentence = line(copy?.sentence, 2000);
```

- 建议：让 `approvalCopy` 也返回经过统一的单行校验/裁剪的句子，或在文档里明确「句子只在写入时校验」。

## 读代码证实的结论

- `home_item_scores` 的 UPDATE 触发器、DELETE 触发器、唯一成功索引存在（`0095_home_item_scores.sql:30-60`）。
- `recordCall` 的 records/failures 插入包在同一个事务里（`sqlite-home-urgency-operations.ts:256`），失败会整批回滚。
- 模型失败、漏编号、编造编号、超限时，条目仍留在首页并标为 `unscored`；失败行用于退避（`home-urgency.ts:434-493`）。
- 存储失败时会释放在本次调用中已密封的句子，并在内存中记录退避（`home-urgency.ts:480-492`）。
- 审批句子的密封内容在删除线程/运行时由 `#runPayloadRefs` 收集，并随审批/评分行级联删除（`sqlite-governed-deletion.ts` 新增查询；测试 `home-urgency.test.ts:1119/1244`）。
- 停服时 `http` 资源先于 `repository` 关闭，`ProductionHomeControl.stopScoring()` 会等待正在进行的 `#running`（`production-service-lifecycle.ts` 的逆序关闭；`production-home.ts:770-780`）。
- 新增 `HOME_URGENCY` 提示词已登记到 prompt manifest；它加入 `TRUSTED_PROMPT_TEXTS` 只影响输入中真实出现该固定文字的范围，不会改变不含该文字的旧对话的遮盖结果（`redaction.ts` 的 `trustedSpans`/`restore` 逻辑）。

## 推测

- 如果两个进程同时对同一批条目打分，并且一个成功、一个失败，可能出现同一 `item_key + text_digest` 同时有一行 `done` 和一行 `failed`。这不影响首页显示，因为 `scored` 查询优先，且失败行不会阻止成功行存在，但与「后写整批失败」的说法不精确一致（见上）。
- 审批 `facts` 中的 `targets`、`recipients` 等数组按存储快照的顺序序列化；如果同一逻辑输入被以不同数组顺序重新写入快照，理论上会产生不同字节。当前代码没有发现运行时重排来源，因此不能确认这是实际问题。

## 侧重检查

- **不可信/不合规范输入**：`parseHomeUrgency` 拒绝非整数/越界分数、越界编号、重复编号、空/多行/超长/控制字符/方向字符文字；候选 key 在首页 source 层经过 `fitsContract`（`HOME_KEY_MAXIMUM = 160`）过滤，小于数据库 `item_key` 的 256 上限。未发现新增输入可直接绕过。
- **敏感/受限数据**：`restricted` 在打分前直接跳过，数据库 `CHECK` 也不接受 `restricted`；模型不允许看的分级只发送 `kind` 和 `deadline`。测试 `home-urgency.test.ts:983-1036` 覆盖。
- **资源耗尽**：每天调用次数/费用从表里统计，`perCall`、`referenceLimit`、`HOME_URGENCY_ITEMS_PER_READ = 2000` 和输出字节上限都在；但 `store.recordCall` 失败时模型费用没有落表，只有进程内退避，进程重启后会重试，这是一个残余风险，符合作者「存储写不进时内存退避」的设计。
- **不可撤销操作**：`home_item_scores` 的 UPDATE 被触发器禁止，DELETE 只在 owner/agent/approval 已删除时放行；测试覆盖直接 UPDATE/DELETE 被拒。
- **删除路径**：删除线程/运行会先收集 `sentence_ref`，再删运行，审批和评分行级联，最后删除 payload；测试 `home-urgency.test.ts:1244-1272` 覆盖密封句子随线程删除。
- **停服顺序**：`http` 在 `repository` 之前关闭，`stopScoring()` 等待当前 `#running`；但 `setInterval` 已排队但尚未开始执行的回调存在极小窗口，可能在 `stopScoring()` 检查 `#running` 之后才启动，当前没有测试覆盖这个窗口。
- **规则/文档与代码一致**：来源规则分级的「已删」行为不一致已在上面列出；其余 ADR 0255 描述（唯一成功行、退避、每日计数、审批文字读取校验、模型配置要求、独立后台调用）和代码基本一致。

## 必答问题

1. **是否改变模型已经见过的请求开头？**
   读代码证实：本改动没有修改对话请求的组装路径、系统提示、工具定义、历史消息或已有遮盖逻辑。新增的是一个独立的 `HOME_URGENCY` 后台请求，固定提示词在最前，之后是参照、新条目，最后一行才是 `now`、`timeZone`、`language`、`affirmMax`。因此现有对话的请求开头不变；新请求每次都是独立请求，不是往旧请求尾部追加。需要说明的是，如果把这个后台调用当成连续请求看，中间的「参照」段会随已打分条目变化，但它属于后台调用本轮的数据，不是会话历史。

2. **同一段文字会不会在不同请求里变成不同字节？**
   读代码证实：提示词里事实对象的键按字典序排序，`reference` 和 `fresh` 按 `item_key` 排序，每轮变化的 `now/timeZone/language/affirmMax` 只放在最后一行；`maskFact` 对每个字符串独立调用 `maskSensitiveText`，没有传入跨请求的 `known` 上下文，所以同一字符串的遮盖结果稳定。未发现集合或对象遍历顺序进入提示词。审批 facts 里的数组依赖存储快照顺序，属于潜在理论风险，当前未见代码在请求间重排。

3. **有没有对应的自动检查，反向用例真的会失败吗？**
   读代码证实：有。`test/integration/home-urgency.test.ts` 覆盖重复写入整批回滚、每日调用/费用上限、失败退避、存储失败释放句子、审批校验、删除、停服等待、分批读取；`packages/application/test/home-urgency.unit.test.ts` 覆盖提示词顺序/确定性、模型回复解析、控制字符与方向字符、字数上限；`home-feed.test.ts` 覆盖规则来源分级；`startup-configuration.unit.test.ts` 覆盖非 `openai-completions` 的 `modelRef` 被拒。**未运行测试**（本轮工具只能读代码和 git），所以不能实际确认反向用例在修复前会红、修复后会绿。测试缺口：没有真正的双并发写入用例；没有模型失败/超时后的释放用例；没有来源记忆 `trashed/deleted_verified` 状态的分级用例。

4. **每个新值产生端和使用端的校验是否都能接受？**
   读代码证实：`item_key` 生产端上限 160、数据库上限 256；`text_digest` 为 64 位小写 SHA-256；`score` 0 到 1000 两端一致；`affirm_label` 模型解析上限、配置语言上限、数据库 64 上限、首页契约 64 上限一致；`copy_locale` 长度 2 到 16 且读取时要求等于请求语言；`data_classification` 生产端排除 `restricted`，数据库 CHECK 也排除；`purpose = "home-urgency"` 同时存在于 `MODEL_USAGE_PURPOSES`、迁移 CHECK 和测试；`modelRef` 在显式配置时同时经 `strict-configuration.ts` 的 `openai-completions + private` 校验和 `service-main.ts` 的 generation descriptor 查找。当前没有发现两端不接受的已产生值。两处维护性风险：`HOME_URGENCY_ITEMS_PER_READ` 与 `sqlite-home-urgency-operations.ts` 的 `ITEM_LIMIT` 是两个独立的 2000；`affirmLabelMax` 若只配置一种语言，不会自动合并默认的另外两种语言。
