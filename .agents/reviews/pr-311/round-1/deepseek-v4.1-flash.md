## 读代码证实的问题

### 1. 高：来源对话已进回收站（或正在删除）时，仍显示“跳到原话”，但详情页根本不返回消息

**文件:行**：`packages/persistence-sqlite/src/sqlite-memory-book-operations.ts:565-571`、`packages/persistence-sqlite/src/sqlite-thread-operations.ts:1515-1516`、`packages/persistence-sqlite/src/sqlite-governed-deletion.ts:320-325,767-769`、`apps/control-center/src/components/chat-history.tsx:116-127`

**问题**：`findOwnerMessages` 只查 `thread_messages`，不 join `threads`，也不过滤 `message_status`。把对话丢进回收站只改 `threads.status`，不清 `memory_records.source_thread_id`；但读取对话详情时 `listMessages` 对 `trashed/deletion_pending/deleted_verified` 一律返回空。结果是：这类记忆的 `sourceMessageId` 非空，界面显示“跳到原话”并计入“能跳到原话”；点进去只能看到欢迎页/空对话，`ChatHistory` 找不到目标后静默 `clearMessageFocus()`。

**证据**：
```ts
// sqlite-memory-book-operations.ts:565-571
FROM thread_messages
WHERE owner_id = ? AND agent_id = ? AND role = 'owner'
  AND content_ref IN (...)
ORDER BY thread_id, sequence
```
```ts
// sqlite-thread-operations.ts:1515-1516
if (!thread || ["trashed", "deletion_pending", "deleted_verified"].includes(thread.status))
  return [];
```
```ts
// sqlite-governed-deletion.ts:320-325（丢回收站只改 threads）
"UPDATE threads SET status = 'trashed', revision = revision + 1 WHERE id = ? AND status = 'open'"
// 767-769（只有真正硬删除才清 source_thread_id）
"UPDATE memory_records SET source_thread_id = NULL WHERE source_thread_id = ?"
```
```ts
// chat-history.tsx:116-127
const request = pendingMessageFocus();
if (!request || !focusThreadId || request.threadId !== focusThreadId || !focusMessages) return;
const target = ...
clearMessageFocus();          // 先清请求
if (!target) return;          // 找不到就直接放弃
```

**建议**：`findOwnerMessages` 加入 `JOIN threads` 并只认 `status = 'open'`，同时加 `message_status = 'committed'`，与 `listMessages` 的可见性一致；回收站中的来源应按产品定义归为“来源对话已删除”或“来源已不可查”，并同步修改报告脚本。另建议把 `clearMessageFocus()` 放到确认目标存在之后（或加超时），避免静默吞掉请求。

---

### 2. 中：提醒工具生成的记忆会被误报“来源已不可查”，并丢掉原本可用的“来源对话”入口

**文件:行**：`apps/agent-service/src/production-reminder-writer.ts:185-187,221-222,384-390`、`apps/control-center/src/memory-source.ts:13`、`apps/control-center/src/components/memory-page.tsx:531-536`

**问题**：提醒工具创建记忆时，`sourceThreadId` 是当前对话，但 `sourceRefs` 是合成出来的 `memory-content:reminder:*` 或新 payload，不可能等于任何 `thread_messages.content_ref`。于是 `memorySourceState` 判成 `unavailable`：用户看到“来源已不可查”，顶部也把它计入“来源已不可查”条数。实际上来源对话是明确且可打开的；改动前这里还会显示“来源对话”按钮，现在链接也没了。这会永久推高这个 PR 最核心的“来源已不可查”数字。

**证据**：
```ts
// production-reminder-writer.ts:185-187
if (contentRef === undefined) {
  text = (input.text ?? "").trim();
  contentRef = `memory-content:reminder:${input.key}`;
}
// 221-222
sourceThreadId: (input.sourceThreadId ?? null) ...,
sourceRefs: [contentRef],
// 384-390（工具入口）
const created = await this.#writer.create({
  key: ...,
  text,
  due,
  repeat,
  sourceThreadId: invocation.context?.threadId ?? null,
});
```
```ts
// memory-source.ts:13
if (item.sourceThreadId) return item.sourceMessageId ? "jump" : "unavailable";
```
```ts
// memory-page.tsx:531-536
) : origin === "unavailable" ? (
  message("memory.page.sourceUnavailable")
) : ...
```

**建议**：不要把“来源对话存在但找不到对应原话”和“来源不可查”混为一类。可增加 `reminder`/`no-quote` 来源状态，或在创建提醒记忆时记录真实来源消息 id；详情页对 `unavailable` 仍保留打开来源对话的按钮。ADR 0185 的类别表也应补上提醒类。

---

### 3. 中：页面条数和报告脚本并不是“同一定义”

**文件:行**：`apps/agent-service/src/production-memory-control.ts:212-218,312-316`、`scripts/operations/memory-source-report.mjs:36-38`、`docs/adr/0185-memory-jumps-to-the-owners-original-message.md:42-45`

**问题**：页面数字来自 `overview.memories`。服务端只取 `INACTIVE_SHOWN = 500` 条非活跃记忆（archived/trashed 合在一起限 500），并且 `if (!text) continue` 会跳过文字读不出的记忆。脚本则直接统计全库 `status IN ('active','archived')`，也不按 owner/agent 过滤。ADR 说两边“按同一定义数出”，但实际在 archived 超过 500、多 owner/agent、或内容不可读时数字会不一致。

**证据**：
```ts
// production-memory-control.ts:212-217
return this.options.book.listInactive({
  ...this.#scope(),
  trashedAfter: this.#trashCutoff(),
  limit: INACTIVE_SHOWN,   // = 500
});
// 312-316
if (memory.status !== "active" && memory.status !== "archived" && memory.status !== "trashed") continue;
const text = await textOfRef(memory.contentRef);
if (!text) continue;
```
```js
// memory-source-report.mjs:36-38
`SELECT ${STATE_EXPRESSION} AS state, COUNT(*) AS count
 FROM memory_records m WHERE m.status IN ('active', 'archived')
 GROUP BY state`
```

另外，ADR 把“整理记忆产生的”列为 tidy，但整理产生的 insight 记忆会继承 `sourceThreadId`（`packages/memory-engine/src/consolidation.ts:530`），按 `memory-source.ts:13` 会被算成 jump/unavailable，而不是 tidy。

**建议**：服务端单独返回一份按全库定义的计数（和脚本同查询/同范围），或者明确写“页面数字是当前加载集合、脚本是全库”，不要让 ADR 声称两者同义；脚本加上 owner/agent 维度或注明只适用于单 owner 库；tidy 的判定不要只靠 `sourceThreadId === null`。

---

### 4. 中低：每次打开记忆页都会全表扫描 `thread_messages`，大库上有资源风险

**文件:行**：`packages/persistence-sqlite/src/sqlite-memory-book-operations.ts:552-574`、`packages/persistence-sqlite/src/migrations/0015_thread_lifecycle_and_search.sql:80`

**问题**：`findOwnerMessages` 每次记忆概览读取都会执行，查询条件没有 `thread_id`，只按 `content_ref IN (...)` 匹配；而 `thread_messages` 上没有 `content_ref` 索引，也没有 `(owner_id, agent_id)` 索引，只有 `(thread_id, sequence)` 和 `(thread_id, turn_id, sequence)`。所以这是一个跨全部消息的扫描。返回后 `earliestSourceMessage` 又对每条记忆扫描整个结果数组，复杂度 O(记忆数 × 命中消息数)。记忆页每 5 分钟还会自动刷新。

**证据**：
```ts
// sqlite-memory-book-operations.ts:565-569
FROM thread_messages
WHERE owner_id = ? AND agent_id = ? AND role = 'owner'
  AND content_ref IN (...)
ORDER BY thread_id, sequence
```
```sql
-- 0015_thread_lifecycle_and_search.sql:80（唯一的 thread_messages 二级索引）
CREATE INDEX thread_messages_turn_index ON thread_messages(thread_id, turn_id, sequence);
```

**建议**：把来源对话 id 一起下推到 SQL（`thread_id IN (...)`），利用现有 `thread_id` 前缀索引缩小扫描；按 threadId 分组后再匹配，避免 O(M×R)。如果允许迁移，再加 `content_ref` 索引；不允许迁移就至少限制扫描范围。

---

### 5. 低：导入来源只在最近 20 个批次里能写出来

**文件:行**：`apps/agent-service/src/production-memory-control.ts:237,521`、`apps/control-center/src/components/memory-page.tsx:533-535`

**问题**：`imports` 只取最近 `IMPORTS_SHOWN = 20` 个批次。更早的导入记忆在详情里 `importSource` 查不到，会退回通用文案“导入”，没有写“导入自 Codex / 其他 AI / Himawari 导出文件”。作者“导入来的记忆写明来源”的说法只对最近 20 批成立。

**证据**：
```ts
const imports = await this.options.book.listImportBatches({ ...scope, limit: IMPORTS_SHOWN });
...
: origin === "import" && importSource
  ? message("memory.page.originImport", { source: importSource })
  : message("memory.page.origin", { o: origin })
```

**建议**：把批次来源放进每条记忆的概览字段（服务端反查一次），或在详情打开时按需查询该 batchId；否则在 ADR 里写明“超过 20 批只显示通用导入”。

---

### 6. 低：`MESSAGE_FOCUS_EVENT` 没有监听者，且请求在目标不存在时被静默丢弃

**文件:行**：`apps/control-center/src/message-focus.ts:8-11`、`apps/control-center/src/components/chat-history.tsx:114-128`

**问题**：`requestMessageFocus` 会 `window.dispatchEvent(new Event(MESSAGE_FOCUS_EVENT))`，但全仓库没有 `addEventListener(MESSAGE_FOCUS_EVENT, ...)`；实际生效完全依赖 `ChatHistory` 的 effect 依赖变化。当前从记忆侧页跳转会重新挂载 `ChatHistory`，所以能工作；但如果以后 `ChatHistory` 已以相同 `detail/contentByRef` 挂载，请求不会触发滚动。另外 effect 在查找目标前就 `clearMessageFocus()`，目标不在 DOM 时请求被永久丢掉（回收站线程问题就是这样静默失败的）。定时器也没有清理。

**建议**：真正监听该事件，或用 state/store 传递请求；把清理放到成功找到目标之后，并给失败设置可观察的反馈（例如仍显示“来源已不可查”）；为 `setTimeout` 加 cleanup。

---

### 7. 低：测试覆盖有实质缺口

**文件:行**：`test/integration/memory-source-report.test.ts:84-95`、`test/integration/production-memory-capture.test.ts:1869-1897`

**问题**：
- 报告测试只插入了一条 owner 消息，没有插入“同一 `content_ref` 的 agent 消息”，所以去掉 `role = 'owner'` 过滤时测试仍会通过；`只匹配 Andy` 没有被反向证明。
- 没有“同一对话中多条匹配取序号最小”的测试。
- 服务端集成测试用原生 `DELETE FROM thread_messages` 模拟来源消失（`deleteThreadMessages`），但真实产品路径是整对话进回收站/硬删除；前者会保留 `source_thread_id` 走 unavailable，后者会清空成 deleted，二者不同。因此测试没有覆盖我在第 1 条指出的真实回收站路径。
- 没有页面数字与脚本数字一致性的测试；也没有提醒记忆/无原话分类的测试。

**建议**：补 agent 消息同 ref 的反向用例、多条匹配取最早用例、真实 trash→read 的集成用例，以及 UI 计数与脚本计数的一致性测试。

---

## 推测与未核实

- **未核实**：生产/Hermes 真实库的条数、archived 是否超过 500、提醒记忆的实际数量、大库上 `findOwnerMessages` 的实际耗时。作者已自述没跑真实库，我也无法执行命令。
- **未核实**：真实浏览器里回收站对话是否还能从其他入口打开；但按当前代码，`listMessages` 对 trashed 返回空是确定的。
- **推测**：如果回收站里的对话在侧栏根本不可选，第 1 条的表现会是“跳到原话”打开空对话/欢迎页，而不是报错；具体呈现未在浏览器验证。
- **未核实**：`npm run check`、`check:prompt-prefix`、新增测试是否实际通过；本次只做静态读码。

---

## 侧重检查

- **错误路径**：检查了来源对话被 trashed/deletion_pending/deleted_verified、来源消息被删、目标消息不在 DOM、`refs` 为空、`refs` 超 512、CLI 参数错误、数据库文件不存在、`sourceMessageId` 为 null 等路径。回收站路径有实质缺陷；其余大多有保护或按设计处理。
- **不合规范/不可信输入**：`refs` 用参数化 SQL，消息 id 只用于 `dataset` 字符串比较，不拼进选择器；导入来源受 `IMPORT_SOURCES` 和迁移 CHECK 约束。没有发现注入风险。服务端对话概览只认当前 owner/agent，脚本没有这个限制（见第 3 条）。
- **安全**：新增的是只读网关查询和只读脚本；脚本以 `readonly: true, fileMustExist: true` 打开数据库，不写不删；没有把密钥/内容写日志。未发现安全问题。
- **资源耗尽**：`findOwnerMessages` 没有索引支撑且每次概览都跑；`earliestSourceMessage` 是 O(M×R)。见第 4 条。
- **不可撤销操作**：本次没有新增写操作、删除操作或迁移；报告脚本只读。没有不可撤销风险。
- **规则文件/说明文档与代码一致**：ADR 0185 的主干描述（只读、用 sourceRefs、取最早）与代码一致；但“页面与脚本同一定义”“整理记忆归 tidy”“导入都写明来源”这几处与代码不完全一致；回收站/提醒类也没有在 ADR 的类别里说明。

---

## 必答问题

### 1. 会不会改变模型已经见过的请求开头？

**不会（静态核对）**。本次改动只影响 `memory.overview.snapshot` 这个网关响应和网页显示；`sourceMessageId` 没有进入系统提示、工具定义、历史消息或出口遮盖。`findOwnerMessages` 走的是只读 `context.read`，没有写历史。全仓库检索 `sourceMessageId` 只出现在契约、概览生产、前端和测试里，不在 prompt/egress 代码里。因此发给模型的请求内容仍然是“只在末尾追加”，每轮变化的值仍只可能在最后一条消息里。
**未核实**：没有实际运行 `npm run check:prompt-prefix`。

### 2. 会不会让同一段文字在不同请求里变成不同字节？

**不会进入模型请求，因而不会影响缓存字节**。新增的 `sourceMessageId` 只在网关响应和 UI 中；其计算是确定性的：`findOwnerMessages` 按 `thread_id, sequence` 排序，`earliestSourceMessage` 再按 `sequence` 排序，`Set` 只用于成员判断，不参与顺序。没有时间字段、随机值或依赖遍历顺序的集合输出。
**未核实**：真实数据库上同一状态的重复请求未实测。

### 3. 有没有对应的自动检查，反向用例真的会失败吗？

**有测试，但不足以证明所述全部行为**。有效的反向点包括：报告测试排除了跨对话、对不上引用、回收站状态的记忆；`message-focus` 测试要求别的对话/不存在的消息不滚动且清空 pending；网页测试要求手动添加和整理产生的记忆不计入“已不可查”。按代码推理，去掉对应过滤/状态分支这些断言会失败。
**但缺口明确**：没有 agent 消息同 `content_ref` 的反向用例（`role='owner'` 过滤未被证明）；没有“多条匹配取最早”的测试；服务端测试用原生 DELETE 而不是真实回收站/硬删除路径；没有 UI 计数与脚本计数一致性的测试；回收站线程和提醒记忆的分类没有测试。
**未核实**：测试本身是否全部通过（未运行）。

### 4. 每个新值两端都能接受吗？

逐个核对如下：
- **`sourceMessageId`**：产生端是 `thread_messages.id` 经 `earliestSourceMessage`；消费端是网关契约 `nullable(machineString)`、前端 `MemoryItem`、`memorySourceState`、`memory-page`。线程详情里的 `messageId` 也是 `machineString`，类型上两端一致。**但语义上不保证消费端能显示这条消息**：回收站/未提交消息不会出现在详情里（第 1 条）。这是本次最重要的“两端不一致”。
- **`memoryBook.findOwnerMessages`**：端口定义 `packages/application/src/ports/memory-book.ts:121`、SQLite 适配器 `durable-adapters.ts:958`、操作分发 `sqlite-memory-book-operations.ts:106` 三处名称一致；返回结构 `MemorySourceMessage` 与 SQL 别名、`earliestSourceMessage` 使用的字段一致。
- **导入来源值**：数据库 CHECK 和 `IMPORT_SOURCES` 是 `codex/assistant/himawari`，新 i18n 的 select 写的是 `codex/assistant/other`，`himawari` 落 `other`，能接受；`MESSAGE_SAMPLE_VALUES` 给了 `codex` 样例。
- **新增 i18n 键**：`message-ids.ts`、en/ja/zh-CN 三份资源都加了对应键；带占位符的三个也加了 sample。`check:locale` 应能兜住遗漏，但本次未运行。
- **报告脚本的状态/标签**：`SOURCE_STATES`、`STATE_EXPRESSION` 与 `renderCounts` 覆盖一致；总数由各状态求和，分组结果一致。
- **测试夹具**：`gateway-v2.fixture.ts`、`control-center-browser-server.mjs`、`memory-interactions` 的 `memoryItem` 都补了 `sourceMessageId`；未发现漏掉的生产端构造函数。

结论：除“回收站/未提交消息”这一类语义不一致和页面/脚本计数定义不一致外，其余新增值两端可以接受。
