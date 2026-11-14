## 一、按严重度排列的问题

### 1. 高：撤销时 `revise` 与写 `undone_revision` 不是原子操作，半撤销会永久卡死
**文件:** `packages/memory-engine/src/conversation-review.ts:55-79`

**问题:** 每条改动先调用 `memory.revise()` 改回记忆，再单独调用 `markChangeUndone()` 记录“已改回后的修订号”。如果进程在两次写之间崩溃，或 `markChangeUndone` 因磁盘/数据库错误失败，记忆已经被改回，但 `undone_revision` 仍是空。下次点撤销时：

- `isReviewChangeUndone` 要求 `memory.revision === undoneRevision`，不成立；
- `isReviewChangeUndoable` 要求 `memory.revision === afterRevision`，也不成立（记忆已是 `afterRevision + 1`）。

于是整批抛 `MEMORY_CHANGED_AFTER_REVIEW`，永远无法再撤销，`markUndone` 也永远到不了。这与作者说法第 3 条“撤销可续做”，以及 ADR 0231 第 82 行“撤销中途失败可以接着做”直接不符。

**证据（读代码证实）:**
```ts
// packages/memory-engine/src/conversation-review.ts:55-75
for (const { change, memory, generationId } of planned) {
  const revised = await options.memory.revise({ ... });
  await options.store.markChangeUndone({
    reviewId: review.id,
    memoryId: memory.id,
    undoneRevision: revised.revision,
  });
}
```
```ts
// packages/application/src/ports/memory-conversation-review.ts:100-108
export function isReviewChangeUndoable(change, memory): boolean {
  return (
    memory !== undefined &&
    change.afterRevision !== null &&
    (memory.revision === change.afterRevision || isReviewChangeUndone(change, memory))
  );
}
```
```ts
// packages/memory-engine/src/conversation-review.ts:47-48
if (!memory || !isReviewChangeUndoable(change, memory))
  throw new ApplicationPortError(PORT_ERROR_CODES.CONFLICT, "MEMORY_CHANGED_AFTER_REVIEW");
```
崩溃/失败本身是“推测”的时点，但一旦发生，卡死是代码必然结果。

**建议:** 把“撤销意图”先写下去再改记忆（写入预期修订号 `memory.revision + 1`，`revise` 必然 `+1`）；或提供一个在同一个持久化事务里完成 `revise` 和 `undone_revision` 的端口操作。只改 `isReviewChangeUndoable` 放宽判断也可作为兜底，但“预期修订号先写”与这次“先记后写”的思路一致，且能区分“已改回”和“别人改过”。

---

### 2. 高：`processCommittedRun` 在“新建已写、取代未写”时重试不能收敛
**文件:** `apps/agent-service/src/production-memory-conversation-review.ts:834-848`、`packages/application/src/services/durable-memory-service.ts:124-164`

**问题:** 作者说法第 4 条声称 `processCommittedRun` 中途失败也能靠 `#settle` 收敛。但 `applyProposal` 对“同一个 create 提案已存在”的情况会提前 `return existing`，**不会执行后面的 `supersedes`**：

```ts
// packages/application/src/services/durable-memory-service.ts:123-140
if (proposal.decision === "create") {
  const existing = await this.options.state.read(proposal.memory.id);
  if (existing) {
    const sameProposal = ...;
    if (sameProposal) {
      if (existing.status === "active")
        await this.proposeProjection(existing, "upsert", generationId);
      return existing;          // <-- 不会走到 164 行的 supersede
    }
    ...
  }
  ...
}
...
if (proposal.supersedes) await this.supersede(proposal.supersedes, saved, generationId);
```

失败时序：`processCommittedRun` 先保存新记忆，随后 `supersede(old)` 抛错/进程崩溃。`#settle` 看到新记忆存在，记下 `created`；旧记忆还没被取代，`superseded` 意图被删掉。下次重试时 `#plan` 仍看到旧记忆有效，候选仍带 `supersedes`，但 create 因同提案提前返回，取代永远不会重做；`#settle` 再次删掉 `superseded` 意图，最后 review 被标成 `completed`，只留下 `created` 改动。结果：新旧两条互相冲突的记忆同时有效，旧记忆永远不被取代，而页面显示回看成功。

**证据（读代码证实）:** 上面两段代码；`#commit` 在 `processCommittedRun` 之后只调用 `#settle`：
```ts
// production-memory-conversation-review.ts:834-851
await service.processCommittedRun({ ... });
await this.#settle(plan.review);
return (await this.#options.store.listChanges(plan.review.id)).filter(
  (change) => change.sourceMessageId === message.id && change.afterRevision !== null,
);
```
失败发生在 create 与 supersede 之间是“推测”的故障点，但该故障点一旦发生，上述不收敛是确定的。

**建议:** 让 `applyProposal` 在“同提案已存在”时仍补做 `supersedes`（最好把 create + supersede 放进同一事务）；或在回看重试路径中把 `superseded` 意图保留并显式重试。仅仅依赖 `#settle` 无法修复，因为 `#settle` 只能补记/删除，不能重放 `supersede`。

---

### 3. 中：`#settle` 的“取代是否发生”判断会误记，且改前值从被过滤的 plan 快照取得
**文件:** `apps/agent-service/src/production-memory-conversation-review.ts:610-618, 746, 795, 854-884`

**问题:** 这次修改把 `superseded` 意图的改前值从原来的 **提交时新读的 `current`** 改成了 **plan 阶段的 `known`**：

```ts
// 现在的写法（本次改动）
if (candidate.supersedes)
  await intent(candidate.supersedes, "superseded", known.get(candidate.supersedes));
```
```ts
// production-memory-conversation-review.ts:746
const known = new Map(plan.existing.map(({ id, memory }) => [id as string, memory]));
```
而 `plan.existing` 明确过滤掉了已被取代的记忆：
```ts
// production-memory-conversation-review.ts:612-618
if (
  !memory ||
  memory.status !== "active" ||
  !allowed(memory.dataClassification) ||
  (memory.attributes?.supersededBy ?? null) !== null
)
  continue;
```
因此 `candidate.supersedes` 对应的记忆在 plan 里 `supersededBy` **必然为 null**，`beforeSupersededBy` 也必然为 null。于是 `#settle` 的判断退化为“只要 `supersededBy !== null` 就算本批改过”：

```ts
// production-memory-conversation-review.ts:871-878
const happened =
  memory !== undefined &&
  (change.action === "created" ||
    (change.action === "superseded"
      ? supersededBy !== null && supersededBy !== change.beforeSupersededBy
      : memory.attributes?.tentative !== true));
```

如果在这几毫秒里**另一个写入者/另一批整理**把旧记忆取代成了别的记忆，`processCommittedRun` 的 `supersede` 会因为旧记忆已被取代而直接返回（`durable-memory-service.ts:549-551`），本批实际没取代它，但 `#settle` 仍记为“已取代”，把别人的 `supersededBy` 算成本批改动。撤销时会把 `supersededBy` 清回 null，**抹掉别人后来的取代**。`confirmed` 同类：只看 `tentative !== true`，如果记忆在这段时间被别人转正或被归档，也会误记为本批确认。

**证据（读代码证实）:** 上述行号；改前值来源回归可直接对照上一版（上一版用 `current.get(candidate.supersedes)`，`current` 是提交前的新读取，未做 superseded 过滤）。实际并发交错是“推测”，但“`beforeSupersededBy` 在 plan 快照下永为 null”是代码事实。

**建议:** 在写意图时重新读取目标记忆（不要用被过滤的 plan 快照）记录真实的 `beforeSupersededBy`/`beforeValidTo`；取代意图还应记录**预期的新记忆 id**，`#settle` 用 `supersededBy === 预期新 id` 判断，而不是“非空且不等于 before”。`confirmed` 建议记录 `beforeTentative`。ADR 第 83 行只承认“主人恰好改了旧记忆内容”的空隙，没有覆盖这条回归。

---

### 4. 中（条件性）：直接修改已存在的 0091 迁移，已应用旧 0091 的库会 digest 不匹配
**文件:** `packages/persistence-sqlite/src/migrations/0091_memory_conversation_review.sql:1-49`、`packages/persistence-sqlite/src/migration-engine.ts:845-858`

**问题:** 本提交在同一迁移文件里把 `id` 上限从 300 改为 128、删除 `memory_id` 外键、允许 `after_revision` 为空、新增 `undone_revision` 和删除触发器。迁移引擎把已应用迁移的 digest 当作不可变定义校验：

```ts
// migration-engine.ts:845-858
if (
  definition.name !== record.name ||
  definition.phase !== record.phase ||
  definition.digest !== record.digest
) {
  throw new SqliteMigrationError(
    SQLITE_MIGRATION_ERROR_CODES.DIGEST_MISMATCH,
    `Applied migration ${record.sequence} does not match the immutable definition`,
    ...
  );
}
```
任何在 0847 之后已经跑过 0091 的开发库/测试库/已部署库，升级到 1f9f6534 时都会直接 `SQLITE_MIGRATION_DIGEST_MISMATCH`，并且新列/新触发器不会补上。PR 尚未合并时这不算线上问题，但“修改已应用迁移”违反仓库自己的不可变迁移规则；是否有真实库已应用旧 0091 属于“未核实”。

**建议:** 如果 0847 可能已被任何持久化环境应用，新增 `0092_memory_conversation_review_undo.sql` 做 `ALTER TABLE`/补触发器，而不是改 0091；若确定只在本 PR 内使用，至少要在提交说明里写明“0091 变更前必须丢弃旧库”，并加一条迁移契约测试覆盖。

---

### 5. 低：自动检查没有覆盖最容易出错的几条路径
**文件:** `test/integration/memory-conversation-review.test.ts:498-534`、`test/integration/data-export.test.ts:200-213`

**问题:** 新增的反向用例确实能失败：
- `failWrite` 用例能抓住“`generations.request` 失败后 `#settle` 未删除意图”；
- `failSettles` 用例能抓住“失败批次被 `listWithChanges` 列出”；
- `resumes an undo` 用例能抓住“`markChangeUndone` 没有逐条写入”；
- 数据导出用例覆盖了 `undone_revision` 往返和“导入记录不影响游标”。

但没有测试：
1. `markChangeUndone` 本身失败/进程在 `revise` 与 `markChangeUndone` 之间崩溃（问题 1）；
2. `processCommittedRun` 在 create 成功、supersede 之前失败（问题 2）；
3. 删除记忆/删除主人时删除触发器和级联是否清干净（全仓未找到对应用例）；
4. 另一个写入者在 plan 与 settle 之间取代/转正旧记忆（问题 3）；
5. ID 长度测试只验证 `createMemoryId` 辅助函数，没有真正走 SQLite 的 `id <= 128`、`memory_id <= 256` 约束。

**证据:** `test/integration/memory-conversation-review.test.ts:515-524` 只让第二次 `revise` 抛错，没有让 `markChangeUndone` 抛错；`test/integration/memory-conversation-review.test.ts:436-448` 只调用 `conversationReviewId`/`createMemoryId`。删除触发器没有测试。

**建议:** 按上面四条补反向用例；删除触发器至少覆盖“直接删除 `memory_records` 行”和“删除 owner 级联”两种路径。

---

### 6. 低：`markChangeUndone` 可覆盖已有 `undone_revision`，且“已改回”只按修订号判断
**文件:** `packages/persistence-sqlite/src/sqlite-memory-conversation-review-operations.ts:272-288`、`packages/application/src/ports/memory-conversation-review.ts:89-98`

**问题:** `markChangeUndone` 的 UPDATE 没有 `undone_revision IS NULL` 条件，重复或并发撤销会覆盖已有的撤销修订号。另外 `isReviewChangeUndone` 只比较 `memory.revision === undoneRevision`。正常情况下修订号单调递增，别人后续改动不会等于旧的撤销号，所以不会误判；但如果同一 memory id 被删除后重建、修订号又从 1 开始，而本批的 `afterRevision` 恰好是 1，`isReviewChangeUndoable` 会把这个新记忆当成原记忆可撤销（“推测”，概率极低，依赖 id 复用）。

**建议:** 增加 `AND undone_revision IS NULL` 或显式校验状态；若在意 id 复用，额外记录并校验 `createdAt`/内容引用等不可复用标识，而不是只靠修订号。

---

## 二、侧重检查

### 错误路径
- **撤销中途失败:** 问题 1，`revise` 已生效但 `undone_revision` 未写 → 整批永久 `MEMORY_CHANGED_AFTER_REVIEW`。
- **写入前/写入中失败:** 意图行写入失败、`generations.request` 失败这两条路径能靠 catch 里的 `#settle` 收敛（代码与测试一致）。
- **`processCommittedRun` 中途失败:** create 成功、supersede 未成功时不能收敛，见问题 2。
- **`#settle` 失败:** `runDue` 的 `gave_up` 分支 `await this.#settle(review)` 没有 `.catch`；持续失败会让 review 停在 `running`、`attempts` 每轮递增，而不是给出明确失败状态。属于数据库持续故障场景，严重度低于问题 1/2，但错误路径不干净。

### 不合规范或不可信的输入
- 模型输出的 `messageId` 必须命中本段 owner 消息（`owners` map），`existingMemoryId`/`supersedes`/`alsoSeenIn` 必须命中 `plan.existing` 的 id，敏感候选在解析阶段直接丢弃，未发现跨 owner/agent 注入记忆的路径。
- `reviewId` 来自网关 `machineString`，撤销命令先通过 `listWithChanges` 做 owner/agent 归属校验，再进 engine；engine 里还会检查状态与 `undoneAt`。
- `markChangeUndone` 校验了 `Number.isSafeInteger` 且 `>= 2`，DB 还有 `undone_revision > after_revision` 的 CHECK。`recordChange` 对非 created 的未知 memory id 仍会 `PORT_NOT_FOUND`。这部分两端校验基本对得上。

### 安全
- 未发现新增的密钥、日志泄露或 SQL 拼接；新增 SQL 全部参数化。
- 外键换成触发器后，“created 意图可以指向尚不存在的记忆”是刻意放宽；生产代码里这个 id 由 `generationId + ordinal` 派生，不受模型直接控制，风险可接受；但若未来有新的 `recordChange` 调用方，应用层必须继续保证只有 created + `afterRevision === null` 才能引用不存在的 id。

### 资源耗尽
- 候选数 `MAXIMUM_REVIEW_CANDIDATES = 24`，消息 120 条、16000 字符、相关记忆 30 条、每天新增 5 条，均为有界值。
- ID 改为 SHA-256 定长后，`review.id` 46 字符、generation id 46 字符、created memory id 约 55-56 字符，均远低于 128；这正好消除了原来长 episode/message id 撑爆网关/数据库上限的风险。
- 若 `#settle` 永远不运行，pending 意图行会残留；但每批最多约 48 行，且 review 被删除时会级联删除，不构成无界增长。

### 不可撤销的操作
- 撤销本身是软操作：created → archived，superseded → 恢复 `supersededBy`/`validTo`，confirmed → tentative。没有硬删除。
- 但问题 1 会让“已经改回的记忆”停在不可再撤销的状态；问题 3 的误记会让撤销清掉别人后来的取代，属于“撤销越权”。

### 规则文件、说明文档与代码一致性
- ADR 0231 第 66 行“游标只看对应日摘要还在的回看记录”与 `position` 的 `EXISTS memory_episodes` 一致。
- ADR 第 72 行“`alsoSeenIn` 里的消息编号不算证据”与 `parseConversationReview` 只查 `existing` 一致。
- ADR 第 82 行“撤销中途失败可以接着做”与问题 1 不一致。
- ADR 第 80 行“写到一半失败也不会……重试也不会把已改过的值当成改前的值”与问题 2、问题 3 不完全一致；第 83 行只承认了“主人改了旧记忆内容”的窄空隙。
- 0091 直接修改与迁移引擎“不可变定义”的规则不一致，见问题 4。

---

## 三、必答问题

### 1. 这个改动会不会改变模型已经见过的请求开头？
**不会（就 6389102f..1f9f6534 这段增量而言）。**

- 本提交没有改系统提示、工具定义、历史消息、出口遮盖或任何 `prompt-catalog` 文本；改动集中在回看编号/生成编号、数据库表、数据导出、撤销逻辑。
- 回看是独立的后台调用（ADR 0231 第 1 条），`conversationReviewPrompt` 每次从固定指令 + 本轮数据 + 最后的 `memory.conversation-review.day` 重新组装；`generateText` 把 prompt 写成一次新的 `inputRef` 发给辅助模型，不把 prompt 写回线程历史（`apps/agent-service/src/production-model-composition.ts:569-576`）。
- 因此发给主模型的内容仍然只在末尾追加；会变的值（回看日期、本轮检索到的旧记忆等）都只出现在这次独立调用的末尾数据里，不在任何已冻结的会话开头。辅助调用即使复用线程的冻结前缀，也只是读取并在末尾追加，不改写已存历史。

### 2. 同一段文字会不会在不同请求里变成不同字节？
**本提交本身不会新增这种不确定性。**

- `conversationReviewId` / `conversationReviewGenerationId` 是 `SHA-256(episodeId[+messageId])` 的定长十六进制，和时钟、随机数、数据库顺序无关。
- 回看 prompt 的数据顺序被固定：消息按 `sequence`，相关记忆 id `.sort()` 后读取，人物按 `updatedAt`/`id` 排序，子分类按类别排序后每类名字 `.sort()`；`subCategories` 的对象键顺序来自 SQL 的 `ORDER BY category, ...`，是可确定的。
- 会变的值只有本来就应随轮次变化的 `day`（放在 prompt 最后一行）以及本轮检索结果；同一份输入在同一状态下应得到相同字节。
- 遮盖/还原依赖 `placeholderTable` 的 tag，但还原后存入记忆的正文是原文，不改变模型已见会话前缀的字节。

### 3. 改动有没有对应的自动检查，反向用例是否真的会失败？
**有部分检查，但关键失败点缺失。**

现有且有效的：
- `failSettles: 2` 用例能验证“失败状态的 review 不被 `listWithChanges` 列出、重试时能补记”；
- `failWrite: true` 用例能验证“`generations.request` 失败后 pending 意图被删除”；
- “resumes an undo” 用例能验证“第一次撤销在第二次 `revise` 前中断后，第二次能接着完成”，并断言中途写入了 `undoneRevision`；
- 数据导出用例验证 `undone_revision` 往返和“导入记录不影响 `position`”；
- ID 用例能抓住旧的长 ID 格式（因为 `createMemoryId` 会在超过 128 时抛错）。

缺失的：
- 没有让 `markChangeUndone` 失败或在它之前崩溃的用例；
- 没有 `processCommittedRun` 在 create 之后、supersede 之前失败的用例；
- 没有删除记忆/删除主人时触发器与级联清理的用例；
- 没有“并发写入者先取代/转正旧记忆，`#settle` 是否会误记”的用例；
- ID 用例没有真正执行 SQLite 的 128/256 长度校验。

### 4. 改动产生或修改的每个值，使用它的人都能接受吗？
逐个核对如下：

| 值 | 产生处 | 使用处/校验 | 结论 |
|---|---|---|---|
| `review.id`（46 字符） | `conversationReviewId` | `begin` 的 `text(...,128)`、0091 的 `id CHECK 128`、data-export schema `text(1,128)`、网关 `machineString`、payload ref `<=400` | 两端可接受 |
| generation id（46 字符） | `conversationReviewGenerationId` | `memory_generations.id`、`checkpoint:` job id、`memory:<generation>:<ordinal>`（约 56）、content/approval ref | 长度都远低于现有上限，可接受 |
| created memory id | `memory:${generationId}:${ordinal}` | `createMemoryId`（1..128）、`memory_conversation_review_changes.memory_id CHECK 1..256`、data-export 导入过滤 `importedMemoryIds` | 可接受 |
| `afterRevision: number|null` | 意图写入（null）、`#settle`（实际 revision）、导入 | `production-memory-control` 过滤 null、`listWithChanges`/`dayUsage` 要求非空、export snapshot `after_revision IS NOT NULL`、export schema `integer(1)`、import | 可接受；所有读取处都先过滤 null 或本来就只处理已 settled 的行 |
| `undoneRevision` | `markChangeUndone` | 0091 `CHECK (> after_revision)`、`isReviewChangeUndone`、data-export schema `nullable(integer(2))`、import | 两端基本一致；导出 schema 不校验“大于 afterRevision”，但导入时 DB CHECK 会拒绝 |
| `discardChange` / `markChangeUndone` 操作名 | port/durable-adapter | sqlite `execute` switch、`durable-adapters.ts:1003-1008` | 两端一致 |
| 删除触发器 | 0091 | 删除 `memory_records` 时清理改动行；review/owner/agent 仍有级联 | 代码上应能清干净（触发器的 EXISTS 写法与 0087 的删除触发器同思路），但没有自动测试 |

发现的不一致不是“校验长度对不上”，而是问题 3 的**改前值来源**（plan 快照过滤了已被取代的记忆，导致 `beforeSupersededBy` 恒为 null）和问题 4 的**迁移 digest 不可变**。

---

## 四、作者说法逐条核对

1. **“回看编号、生成编号改为 SHA-256 前 32 位定长；表 id 上限 128”** —— **属实**。`conversationReviewId`/`conversationReviewGenerationId` 和 0091 的 `CHECK (length(id) BETWEEN 1 AND 128)` 对应。
2. **“撤销只对 completed、gave_up 开放；listWithChanges 只列这两种”** —— **属实**。`UNDOABLE_REVIEW_STATUSES` 与 `listWithChanges` 的 `status IN ('completed','gave_up')` 一致。
3. **“撤销可续做：每改回一条写 undone_revision，再撤销时跳过已改回的”** —— **部分不实**。跳过已改回和逐条写入确实存在，但 `markChangeUndone` 失败/崩溃后不能续做，见问题 1。
4. **“先记后写，各种失败点都能收敛”** —— **部分不实**。意图行、`generations.request`、`#settle` 失败基本能收敛；`processCommittedRun` 在 create 与 supersede 之间失败不能收敛，见问题 2；`#settle` 的判断还会误记，见问题 3。
5. **“alsoSeenIn 只认已有记忆编号；相关记忆按编号排序；游标只看日摘要还在的回看记录”** —— **属实**。`parseConversationReview` 只查 `existing`，`ids` 读取顺序有 `.sort()`，`position` 有 `EXISTS memory_episodes`，数据导出用例也覆盖了导入记录不移动游标。

---

## 五、未核实

- `.agents/reviews/pr-395/round-1/judgments.md` 的实际内容：`git show` 对该 records 路径返回 `REVIEW_GIT_REFUSED`，本次只能依据题面转述的第 1 轮意见。
- 真实环境里是否已经有库应用过旧的 0091（决定问题 4 是否已经实际发生）。
- 生产是否存在多个 agent-service 实例同时跑回看（决定问题 3 的并发发生概率；仓库代码里 `#pending` 只防单实例并发）。
- 辅助模型 `auxiliaryModel.invoke` 是否复用线程历史前缀；只确认了它把 prompt 作为新的 `inputRef` 发送、没有回写线程历史，因此不影响主请求已见前缀。
- 本次只读代码，未运行测试；文中“测试会/不会失败”的结论来自对测试断言和代码路径的静态核对。
