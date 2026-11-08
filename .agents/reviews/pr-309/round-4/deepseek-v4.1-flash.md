# PR 309 第 4 轮复核结论

本轮增量只有一条排序修改和一个用例（`8072eb5b`、`cac3d60c`），再加上合并 main。以下按严重度排列。

---

## 中：新增用例不能证明排序修复；`source_key` 在生产也不是“推送编号”

**文件:行**
- `test/integration/proactive-mail-check.test.ts:1148-1170`
- `packages/persistence-sqlite/src/proactive-push-backoff.ts:54`
- `packages/testing/src/deterministic.ts:31-34`
- `apps/agent-service/src/service-main.ts:208`

**问题（读代码证实）**

旧实现是：

```sql
ORDER BY feedback.first_sent_at DESC, insight.id DESC
```

新实现只把 tie-break 换成：

```sql
ORDER BY feedback.first_sent_at DESC, feedback.source_key DESC, insight.id DESC
```

旧实现本来就有 `insight.id DESC` 这个唯一 tie-break，所以“每次读计数相同”在旧代码上已经成立；新改动真正改变的只是同一毫秒内两条推送的先后。

新增用例做不到“去掉修复就失败”：

- 两条反馈的 `first_sent_at` 相同：`sent(h, first, h.clock.now())` 和 `sent(h, second)` 用的是同一个 `h.clock.now()`（`test:1152-1153`，`sent` 定义在 `810-829`）。
- 两条推送的 id 由同一个 `DeterministicIdGenerator` 顺序分配：第一次是 `proactive-push-0001` / `source-insight-0001`，第二次是 `...-0002`。`#finish` 先分配 push id 再分配 insight id（`proactive-mail-check-service.ts:1256,1261`），所以 `source_key` 的顺序和 `insight.id` 的顺序一致。
- 因此旧排序 `insight.id DESC` 和新排序 `source_key DESC` 在这组数据上给出同一顺序：第二条（未点开）先、第一条（已点开）后，计数都是 1。把 `8072eb5b` 那一行改回去，这个用例仍然通过。
- 该用例对顺序其实是敏感的（反序会得 0），但它只能证明“第二条排前”，而旧实现也满足这一点，不能区分修复前后。

更关键的是，生产的 id 不是序号：

```ts
return Object.freeze({ next: (namespace: string) => `${namespace}:${randomUUID()}` });
```

`source_key` 在生产是随机 UUID 字符串（`service-main.ts:208`），`sourceKey DESC` 只是把“按随机 insight UUID 排”换成“按随机 push UUID 排”，并不能保证 ADR 0184 第 3 条要求的“从最近一条往前数”。测试里的序号式 id 恰好掩盖了这一点。

**建议**

- 构造能让两种排序结果相反的数据：同一 thread 被再次推送（旧 insight id 复用，而新的 `push_source_key` 更大），或直接插入两行让“已点开”的那条 `source_key` 更大、`insight.id` 更小；断言具体顺序或台阶变化，而不是只看最终计数。
- 若确实需要“最近一条在前”，tie-break 应使用真正的时序，例如 `feedback.rowid DESC`（`web_push_feedback` 是普通 rowid 表）或 `proactive_pushes.created_at/入队顺序`，而不是随机 UUID 字符串。

---

## 低：overview 的 `backoff` 没有走 `clean()`，畸形发件人域名可能让整条快照校验失败

**文件:行**
- `apps/agent-service/src/production-proactive.ts:371`（`backoff: overview.backoff.map((entry) => ({ ...entry }))`）
- `apps/agent-service/src/production-proactive.ts:74-76`（其它文本都会 `clean()`）
- `packages/application/src/services/proactive-mail-check-service.ts:111-115`
- `packages/gateway-contracts/src/validation.ts:78-95`

**问题（部分推测）**

其它从邮件来的文本（`from`、`subject` 等）在返回快照前都会经过：

```ts
function clean(text: string, limit: number): string {
  return [...text.replace(/\p{Cc}+/gu, " ").trim()].slice(0, limit).join("");
}
```

但新增的 `classKey` / `domain` 是原样返回。`classKey` 来自 `fromAddress` 的域名：

```ts
export function proactivePushClass(fromAddress: string): string | null {
  if (!fromAddress.includes("@")) return null;
  const domain = senderDomain(fromAddress);
  return domain.length === 0 ? null : `due:${domain}`.slice(0, 128);
}
```

`senderAddress` 的正则不排除控制字符（`gmail-source.ts:164-169`），而网关 `boundedString` 明确拒绝 `code < 0x20` 和 `0x7f`。一旦某个被推送提醒的发件人域名里带控制字符，`proactive.overview.snapshot` 会在网关校验处整条失败，提醒页无法加载。需要畸形 `From` 头才能触发，所以标为推测。

**建议**：在 `proactivePushClass` 生成处只保留域名合法字符（或至少去掉 `\p{Cc}`），或在 `production-proactive.ts` 对 `classKey`/`domain` 也调用 `clean()`，并补一个含控制字符的用例。

---

## 低：新增的 backoff 列表没有上限

**文件:行**
- `packages/persistence-sqlite/src/proactive-push-backoff.ts:179-197`
- `packages/application/src/services/proactive-overview.ts:280-292`

**问题（读代码证实）**

```sql
SELECT ... FROM proactive_push_backoff
WHERE owner_id = ? AND agent_id = ?
ORDER BY class_key
```

没有 `LIMIT`，`readProactiveOverview` 又把所有 `stage > 0` 的类别全部放进快照。相比之下，overview 里其它列表都有上限（`insights` 最多 500、`audit`/`decisions` 也有截断）。类别来自发件人域名，长期累积后快照会无界增长。`countIgnoredPushes` 无 `LIMIT` 是作者已按 D2 接受的历史项，这里不重复；但 `listBackoff` 是本 PR 新增的读取路径。

**建议**：给 `listBackoff` 加固定上限或分页，或在 overview 截断并返回总数，保持与现有列表一致。

---

## 低：active 规格与代码不一致

**文件:行**
- `docs/execution/specs/2026-10-29-proactive-loop-v1-gmail-design.md:299`（生产配置清单）
- `docs/execution/specs/2026-10-29-proactive-loop-v1-gmail-design.md:302`（网页接口命令清单）
- `docs/adr/0184-back-off-ignored-proactive-pushes.md:62`（门槛/测试清单）

**问题（读代码证实）**

该规格 `status: active`，但：

- 生产配置清单没有新增的 `runPolicy.proactive.backoffThreshold`。
- 网页接口清单没有新增的 `proactive.backoff.restore`。
- ADR 0184 的后果清单没有列出本轮新增的“同一毫秒排序”用例。

**建议**：更新这两处规格，或在 ADR 里明确 v1 规格不再维护；把新用例补进 ADR 的门槛清单。

---

## 侧重检查

| 类别 | 检查结果 |
|---|---|
| 错误路径 | `proactive.backoff.restore` 对未知/已恢复类别（`changes === 0`）抛 `PROACTIVE_RECORD_NOT_FOUND`（`production-proactive.ts:524-531`），生产测试覆盖未知类别与 `classKey: null`（`proactive-production.test.ts:662-670`）。恢复成功后再次恢复会报错，这是可接受但用户可感知的行为。 |
| 不可信输入 | 分类键来自邮件发件人域名，长度被 `slice(0,128)` 限制；`push_class`/`class_key` 的 DB CHECK 是 1–128，网关注入命令也是 `boundedString(128)`，长度两端一致。风险点是控制字符未清洗（见上）。 |
| 安全 | 域名明文存储是 ADR 0184 明确接受的设计；`proactive_push_backoff` 随 Owner/Agent 级联、断开 Gmail（`sqlite-proactive-operations.ts:463-465`）和清除记录（`:486-494`）一起删除。新增命令走现有 Gateway 会话/CSRF 路径，没有新增模型工具。`classKey: null` 会恢复全部类别，比 ADR 描述的“每类一个按钮”更宽，需确认是否有意；不影响安全边界（同一主人）。 |
| 资源耗尽 | `countIgnoredPushes` 无 `LIMIT`（已接受 D2）；`listBackoff` 无上限（见上）；`previewBackoff` 的 classKeys 来自本轮推送，数量受单次检查限制，问题不大。 |
| 不可撤销操作 | 迁移 0081 把最低可写版本提到 81，旧程序回滚会被拒绝；ADR 0184:66 已写明。恢复降频本身不删规则、可再次触发，不是不可撤销操作。 |
| 文档一致性 | ADR 0184 的阈值、台阶、点开优先、`ignored_count` 上限、2xx 才计数与代码一致；迁移 0081 与 ADR 编号 0184 不与 main 的 0081/0183 冲突；活跃 v1 规格未同步新命令/配置（见上）。 |

---

## 必答问题

### 1. 会不会改变模型已经见过的请求开头？

**不会。**

- PR 的 47 个改动文件里没有 `packages/prompt-catalog`、系统提示、工具定义或历史组装代码；`proactivePrompt(...)` 在 `proactive-mail-check-service.ts:726` 构建，PR 新增逻辑都在模型返回之后（`#gateBackoff` 从 `875` 行才调用），`pushClass` 只由 `fromAddress` 计算，未进入 prompt。
- 没有新增模型调用：新逻辑只调用 `store.previewBackoff/listBackoff/restoreBackoff`；ADR 0184 第 7 条也明确不新增提示词/工具，聊天里的一句话恢复没有做。
- 因此“只在末尾追加、每轮变化的值只在最后一条消息”这一约束没有被这个 PR 触碰。未运行 `npm run check:prompt-prefix`，结论来自代码和 diff。

### 2. 同一段文字会不会在不同请求里变成不同字节？

**对发给模型的内容不会**，因为本 PR 没有修改任何模型可见文本。

对新增的非模型数据：

- `proactivePushClass` 是确定性的（`senderDomain` 转小写、固定前缀、固定截断）。
- `#gateBackoff` 的 `classKeys` 显式 `.sort()`；overview 的 backoff 列表由 `ORDER BY class_key` 固定顺序。
- `changedAt`/`ignoredCount` 会随时间变化，但只出现在网页快照，不进入模型请求。
- `source_key` 在生产是随机 UUID，但每行固定，所以同一数据库状态下重复读取的顺序稳定；它的问题不是“字节不确定”，而是“顺序不代表时间”（见第一条）。

### 3. 有没有对应的自动检查？反向用例真的会失败吗？

- **排序修复**：有新增用例 `[PA-6] orders pushes sent in the same millisecond...`，但如第一条所证，去掉 `8072eb5b` 的排序修改后它仍然通过，**不是有效的反向用例**。
- 其它 PA-6 反向用例（点开优先于“不需要”、未送达不计数、地板规则、无 `@` 地址、阈值 0）在代码逻辑上是有效的。
- **迁移**：通用迁移测试已把 `CURRENT_SCHEMA_SEQUENCE` 和 `readMigrationLedger` 长度改到 81；但作者明确没有补专门的 80→81 升级合同测试（`87636974` 提交说明“留给 Andy”）。
- 合并 main 后未见迁移序号、ADR 编号、契约字段或测试清单冲突：`0081_proactive_push_backoff.sql` 唯一，`0184` 唯一，`proactiveOverviewSnapshotSchema` 的 `backoff` 字段与 fixture、e2e、production 输出一致。

### 4. 每个产生/修改的值，使用它的地方都能接受吗？

逐项核对（读代码）：

- **`source_insights.push_class`**：生产者 `proactivePushClass` 最长 128 → DB CHECK 1–128 → `countIgnoredPushes` 用完全相同的字符串比较；一致。已知风险：超长域名截断可能合并两个类别（作者按 D1 接受），控制字符未清洗（见上）。
- **`proactive_push_backoff.class_key`**：同源最长 128 → DB CHECK 1–128 → overview 的 `domain`（网关 `boundedString(128)`）和 `proactive.backoff.restore` 命令（`boundedString(128)`）；一致。
- **`stage`**：`stageOf` 只产生 0/1/2 → DB CHECK 0–2 → overview 过滤 `>0` 后交给网关 `integer(1,2)`；一致。
- **`ignored_count`**：写入 `Math.min(ignoredCount, 1000)` → DB CHECK 0–1000 → overview 网关 `integer(0)`；一致。
- **时间字段**（`since_at`/`last_push_at`/`stage_changed_at`/`updated_at`/`restored_at`）：来自经过 `this.time()` 校验的 `now`/`decision.checkedAt` → 网关 `timestamp`；一致。
- **`step_decision_id`**：指向同一事务内已插入的 `decision_ledger.id`，FK 存在；一致。
- **`proactive.overview.snapshot.backoff`**：生产输出、e2e fixture、控制中心测试 fixture 都已补 `backoff`，schema 把它设为必填；一致。
- **`backoffThreshold`**：`strict-configuration.ts` 默认 3、范围 0–10 → `ProactiveConfiguration` → `production-proactive.ts:177` 传给服务；一致。活跃规格未同步（见上）。
- **`proactive.backoff.restore`**：已加入 `GATEWAY_V2_MESSAGE_TYPES`、`schemasByType`、gateway fixture、`PRODUCTION_PROACTIVE_OPERATIONS`、控制中心 `send`；网关按 `command.type.startsWith("proactive.")` 路由；一致。生产集成测试是直接调 `execute`，未走真实 HTTP/CSRF 路径，这条端到端链路未核实。
- **迁移上限**：`LATEST_MIGRATION_SEQUENCE`、迁移测试、`SUPPORTED_SCHEMA_MAX = 81` 一致；`check-audit-schema-range` 会继续守护这个值。

**总结**：本轮没有发现会改变模型请求开头、破坏迁移编号或 ADR 编号的问题；最需要处理的是排序回归用例没有真正覆盖修复，以及新增 `backoff` 输出未清洗/无上限这两个低风险问题。
