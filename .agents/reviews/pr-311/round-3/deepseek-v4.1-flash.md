## 结论摘要

本 PR 的核心功能基本成立：跳转、不可查计数、提醒单列、脚本与页面的分类在代码层面大体一致；本次增量修的四点（等待就绪、脚本长度过滤、反向用例、共用 content_ref 用例）都在代码和测试里找得到对应。发现的问题按严重度如下，主要是**概览变更通知没有跟上新派生字段**，以及 **ADR 两处描述与代码不一致**。

---

## 发现（按严重度）

### 1. 中：`sourceMessageId` 是线程数据的派生值，但没有进入 `revision()` 变更指纹，概览可能长期停在旧值

**文件:行**：`apps/agent-service/src/production-memory-control.ts:220-259`、`:346`，使用处 `apps/agent-service/src/production-approval-gateway.ts:150-166`

**问题**：新增的 `sourceMessageId` 由 `thread_messages`/`threads` 实时算出，但 `revision()` 只列出记忆记录、历史条数、设置、people、imports、pins、approvals 等：

```ts
async revision(): Promise<string> {
  ...
  return JSON.stringify([
    active.map(({ id, revision }) => [id, revision, historyCount.get(id) ?? 0]),
    ...
    inactive.map(({ id, revision }) => [id, revision]),
    settings.updatedAt,
    (await this.options.book.latestGeneration(scope)) ?? null,
    people.map(...), suggestions.map(...), imports.map(...), pins.map(...),
  ]);
}
...
sourceMessageId: earliestSourceMessage(memory, sourceMessages),
```

删除来源消息、把消息改成未提交、或把来源对话移入回收站，都不会改变上面任何一个分量，因此 `revision()` 字符串不变。`production-approval-gateway.ts:150-166` 用它决定是否发 `snapshot_required`：

```ts
const version = JSON.stringify([
  authority, await searchAuthorization.revision(), await options.memoryControl?.revision(), ...
]);
if (version !== previous) { ... yield { kind: "snapshot_required", ... }; }
```

**后果（推断，基于上述用法）**：记忆页最多要等 5 分钟轮询（`apps/control-center/src/memory.ts:17,95-99`）或下一次记忆变更才会重新拉概览；期间旧的“跳到原话”按钮仍在，点击后消息已不存在，`takeMessageFocus` 会消费请求但找不到目标，表现为“点了没反应”，与 ADR“找不到显示来源已不可查”不一致。

**建议**：把来源匹配结果（或影响它的线程状态/消息水位）纳入 `revision()`，并补一个“删除来源消息后 `revision()` 改变”的集成用例。若有意接受 5 分钟陈旧，应写进 ADR 已知局限。

---

### 2. 低：ADR 称“脚本会把回收站里的对话算作来源已不可查”，对提醒类记忆不成立

**文件:行**：`docs/adr/0186-memory-jumps-to-the-owners-original-message.md:56`，对应代码 `scripts/operations/memory-source-report.mjs:20-36`

**证据**：

```sql
WHEN m.source_thread_id IS NOT NULL THEN
  CASE WHEN EXISTS ( ... t.message_status='committed' ...
    AND h.status NOT IN ('trashed','deletion_pending','deleted_verified') ) THEN 'jump'
  WHEN EXISTS ( ... length(p.source_id)<=512 )
    AND NOT EXISTS ( ... length(p.source_id)<=512
      AND p.source_id NOT LIKE 'memory-content:reminder:%' ) THEN 'reminder'
  ELSE 'unavailable' END
```

线程状态只出现在 `jump` 分支。对话在回收站时 `jump` 为假，但纯提醒引用的记忆仍落进 `reminder`。页面侧（`apps/control-center/src/memory-source.ts:21-29`）同样仍是 `reminder`。所以 ADR 这句只对非提醒的捕获记忆成立。

**建议**：改成“脚本会把回收站里、非提醒合成的来源算作来源已不可查；纯提醒引用仍归提醒”。

---

### 3. 低：ADR 说“最早的一条历史记录读不出文字时，页面不显示这条记忆”，代码并非如此

**文件:行**：`docs/adr/0186-memory-jumps-to-the-owners-original-message.md:55`，对应代码 `apps/agent-service/src/production-memory-control.ts:322-327`

**证据**：

```ts
const text = await textOfRef(memory.contentRef);
if (!text) continue;
...
for (const event of history.get(memory.id) ?? []) {
  const eventText = await textOfRef(event.contentRef);
  if (!eventText) continue;
  nodes.push({ ... sourceDeleted: event.sourceDeleted, ... });
}
```

概览只在**记忆本身**的文字读不出时跳过整条记忆；历史事件文字读不出时只跳过该事件。于是“最早历史事件读不出”时页面仍显示这条记忆，只是 `history[0]` 变成下一条可读事件，`memorySourceState` 的 `deleted`/`tidy` 判定可能与脚本按数据库最早事件判定不同。ADR 把两件事混成了一件。

**建议**：把该条改成“记忆本身的文字读不出时页面跳过整条；只有最早历史事件文字读不出时，页面跳过该事件，`deleted`/`tidy` 取第一条可读历史，脚本按数据库最早事件判定，可能不同”。

---

### 4. 低：新增值的关键反向用例仍有缺口（页面/网关侧的 512 过滤、真实跳转接线）

**文件:行**：`test/integration/memory-source-browser.test.ts:99-102`、`apps/control-center/src/app.tsx:452-455`、`test/integration/memory-source-report.test.ts:120-126`

- `>512` 引用的过滤只在**脚本**测试里覆盖（`memory-source-report.test.ts` 的 `memory:reminder-long`）。页面的一致性依赖网关 `production-memory-control.ts:347` 的过滤，但没有用例把长引用喂给 `memory.overview.read` 验证：删掉网关过滤时，没有页面/契约测试会因“页面与脚本不一致”而失败（理论上会因 `boundedString(512)` 校验失败，但没有用例触发）。
- 浏览器用例点击“跳到原话”后只 `await page.waitForURL(/\/threads\/thread-main/)`，不检查滚动/高亮；`app.tsx:452-454` 里 `if (messageId) requestMessageFocus(...)` 的接线若被删，现有单测（直接调用 `requestMessageFocus` 或 mock `onOpenThread`）都不会失败。真实链路缺一条端到端断言。

**建议**：加一条网关概览含超长引用的用例（断言 `sourceRefs` 被截断且分类与脚本一致）；浏览器用例补断言目标 owner 消息获得 `data-focused` 或 `scrollIntoView` 生效。

---

### 5. 低（信息）：`512` 这个限制在四个地方各写一份，缺少共享常量

产生/使用处：`production-memory-control.ts:312,347`、`packages/gateway-contracts/src/contracts-v2.ts:941`、`scripts/operations/memory-source-report.mjs:26,31,34`。当前值一致，但任一处单独改动都会让页面/脚本/契约再次分叉。建议提取共享常量或至少加注释性约束测试（不写注释的前提下用测试锁定）。

---

## 读代码证实的 / 推测的

**读代码证实的**
- 网关概览的 `sourceRefs` 已过滤 `length <= 512`，`sourceMessageId` 由 `findOwnerMessages` + `earliestSourceMessage` 计算（`production-memory-control.ts:308-318,346-347`）。
- `findOwnerMessages` 只返回 `role='owner'`、`message_status='committed'`、线程不在 trashed/deletion_pending/deleted_verified 的消息，按线程分组、每批 200 个引用（`sqlite-memory-book-operations.ts:556-587`）。
- 彻底删除对话时会 `UPDATE memory_records SET source_thread_id = NULL` 并把历史 `source_deleted=1`（`sqlite-governed-deletion.ts:768-775`），所以已删除对话不会走到“来源已不可查 + 来源对话入口”，这条链路是对的。
- 新增 `sourceMessageId` 通过 `nullable(machineString)`；消息 id 由 `identifier.ts` 的同一正则生成（`^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$`），两端校验相容。
- 脚本新增反向用例确实能失败：去掉 `message_status='committed'` 会让 `memory:partial` 变 `jump`；去掉线程状态会让 `memory:in-trash`/`memory:being-deleted` 变 `jump`；去掉长度过滤会让 `memory:reminder-long` 变 `unavailable`；把提醒条件放宽成“存在提醒引用即可”会让 `memory:reminder-mixed` 变 `reminder`。
- 页面新增“来源已不可查 + 来源对话”分支由 `item.sourceThreadId` 决定（`memory-page.tsx:543-557`），单测点击它会因按钮不存在而抛错（`memory-interactions.unit.test.ts:700-701`），是有效反向用例。
- `message-focus` 新测试能失败：恢复旧的“请求后固定 10 秒过期”会在 `:123` 失败；永不按错线程过期会在 `:130` 失败；错线程消费请求会在 `:124/:127` 失败。

**推测 / 未核实**
- 第 1 条中“概览长期不刷新”的后果是基于 `revision()` 消费方式推断的，未实际运行推送链路。
- `sequence` 在 `thread_messages` 中是否被数据库约束为每对话唯一未核实；若有并列 `sequence`，`toSorted` 的并列顺序依赖查询顺序（同一数据库下通常稳定，但不值得依赖）。
- `findOwnerMessages` 每次概览读取按来源对话逐条查询、且 `lookups` 无上限；大量记忆/对话时可能放大查询次数（资源/性能推断，未压测）。
- 回收站对话“打开后读不出内容”的 UI 表现未实际打开验证。

---

## 侧重检查（错误路径、不可信输入、安全、资源、规则/文档一致）

- **已删除对话**：治理删除清空 `memory_records.source_thread_id` 并置历史 `source_deleted=1`，页面落到“来源对话已删除”，不会给出无效入口。已核实。
- **回收站/删除中对话**：网关与脚本都排除跳转；非提醒记忆变“来源已不可查”。页面仍会给“来源对话”入口，ADR 已声明为已知范围。提醒记忆在回收站仍归“提醒”，与脚本一致，但 ADR 表述有误（发现 2）。
- **未提交/部分提交消息**：网关与脚本都排除，反向用例覆盖。
- **agent 与 owner 共用 content_ref**：`role='owner'` 过滤，新集成用例真实共用同一 ref，并在 owner 消息删除后断言为空，能抓住角色过滤回退。
- **超长引用**：跳转与提醒判定都排除 >512；概览 `sourceRefs` 过滤以满足契约 `boundedString(512)`。页面侧无直接反向用例（发现 4）。
- **不可信输入/注入**：`sourceMessageId` 只用于与 DOM `dataset.messageId` 相等比较，不做选择器拼接；`findOwnerMessages` 全部参数绑定、按 200 分批，无 SQL 注入。该 port 的 `lookups` 形状未做运行时校验，但属内部端口，和同类 `memoryBook.*` 操作一致。
- **资源耗尽**：视图读取是只读查询；新增按来源对话的 N 次查询，理论上随“不同来源对话数”增长，属低风险性能问题。
- **不可撤销操作**：本次无写命令、无迁移，脚本以 `readonly: true, fileMustExist: true` 打开数据库。
- **规则/文档一致**：ADR 两处表述与代码不一致（发现 2、3）；代码无新增注释，符合“不写代码注释”。

---

## 必答问题

**1. 会不会改变模型已经见过的请求开头？**
不会。本次改动只涉及控制中心的记忆页、`memory.overview.read` 的展示字段、只读持久化查询、报表脚本和测试/ADR；没有触碰 `packages/prompt-catalog`、`runtime-pi`、上下文组装、历史序列化或出口遮盖。新增的 `sourceMessageId`/`sourceRefs` 消费方只有 `memory-source.ts`、`memory-page.tsx`、`memory-panel.tsx`（grep 证实）。因此发给模型的内容仍然只在末尾追加，没有把每轮变化的值放进系统提示/工具定义/历史开头，符合 `prompt-prefix.md` 第 2、4 条。**未核实**：我未逐行读全部 prompt 组装代码，但改动文件清单里没有一条位于该路径。

**2. 会不会让同一段文字在不同请求里变成不同字节？**
对模型请求：不会，本改动不向任何模型请求写入内容。对新增的展示/报表值：`findOwnerMessages` 按 `sequence` 排序、`earliestSourceMessage` 用稳定的 `toSorted` 取最早；`sources()` 对 `sourceRefs` 按 `source_type, source_id` 排序；脚本按固定 `SOURCE_STATES` 聚合。没有时间字段或无序集合进入请求。唯一理论风险是同一对话内 `sequence` 并列时选最早依赖查询顺序（未核实数据库是否保证唯一）。

**3. 有没有对应的自动检查？反向用例真的会失败吗？**
有，且我核对了失败条件：`message-focus.unit.test.ts` 的慢加载/错线程过期用例能分别抓住“恢复固定 10 秒”“永不过期”“错线程消费”；`memory-interactions.unit.test.ts` 的“来源已不可查仍可打开来源对话”点击会因按钮缺失抛错；`production-memory-capture.test.ts` 的共用 `content_ref` 用例能抓住去掉 `role='owner'` 过滤；`memory-source-report.test.ts` 的 `partial`/`in-trash`/`being-deleted`/`reminder-long`/`reminder-mixed` 能分别抓住去掉 committed、线程状态、512 长度过滤和提醒“全为提醒引用”条件。**缺口**见发现 4：网关侧超长引用过滤和 `app.tsx` 的真实跳转接线没有会失败的反向用例。

**4. 新增/修改的每个值，两端都能接受吗？**
- `sourceMessageId`：产生于 `production-memory-control.ts:346`；契约 `contracts-v2.ts:940` 为 `nullable(machineString)`；消息 id 生成规则与 `machineString` 完全一致（`domain/src/identifiers.ts:39` 同正则），使用方 `memory-source.ts:23`、`memory-page.tsx:520-527`、`ChatHistory` 的 `dataset` 比较都能接受。✅
- 过滤后的 `sourceRefs`：产生于 `production-memory-control.ts:347`；契约 `contracts-v2.ts:941` 为 `array(boundedString(512))`，所以过滤是必须的；使用方 `memory-source.ts:24-25` 与 `memory-panel.tsx:163` 都能接受，后者只用它和当前轮消息的 contentRef 比对，长引用被丢弃不会匹配到短 contentRef。✅
- `memoryBook.findOwnerMessages`：端口 `memory-book.ts:121`、实现 `durable-adapters.ts:958`、SQL 分发 `sqlite-memory-book-operations.ts:106` 三处齐全；参数绑定、分批 200，返回结构与 `MemorySourceMessage` 一致。✅
- i18n 键：`message-ids.ts` 已列全，`en/ja/zh-CN` 三份资源都有；`memory.page.origin` 的 `select` 增加了 `reminder`，`originImport` 的 `source` 对 `himawari` 走 `other`，与 `MEMORY_IMPORT_SOURCES = ["codex","assistant","himawari"]` 兼容。✅
- 脚本：`SOURCE_STATES`、`renderCounts` 标签与 `.d.mts` 声明一致。✅
- 遗留风险：`512` 常量在四处重复（发现 5），不是当前错误，但容易再次造成页面/脚本/契约分叉。
