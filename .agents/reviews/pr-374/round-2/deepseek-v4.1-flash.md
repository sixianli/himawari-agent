## 读代码证实的问题（按严重度）

### 1. 中：记忆页的用量与真正发给模型的档案用了不同的分级上限，敏感置顶记忆超限时不会提示

- 文件：`apps/agent-service/src/production-memory-control.ts:555-559`、`packages/application/src/services/context-formation-service.ts:232-239`、`packages/application/src/services/model-visibility.ts:16-18`、`apps/control-center/src/components/memory-page.tsx:1284-1292`
- 问题：记忆页的 `profileUsage` 用 `maxClassification: "private"` 计算；真正组上下文时用的是 `modelVisibleCeiling()`，它返回 `"sensitive"`。因此敏感记忆会进入实际档案块、也会被计入决策记录里的 `pinned/used/queued`，但记忆页的 `usage.pinned` 会把它们排除。若主人置顶的是敏感记忆且它们超过 2000 字，实际每轮档案超限、决策记录也会写，但记忆页不会出现提示。这与 ADR 0214“主人在记忆页能看到这件事”不一致。
- 证据：

```ts
// production-memory-control.ts:555
const outline = await this.options.profile?.outline({
  ...
  maxClassification: "private",
```

```ts
// context-formation-service.ts:234
this.dependencies.profile.compose({
  ...
  maxClassification: modelVisibleCeiling(),
```

```ts
// model-visibility.ts:16
export function modelVisibleCeiling(): DataClassification {
  return "sensitive";
}
```

```tsx
// memory-page.tsx:1284
{usage.pinned > usage.limit ? (
```

- 建议：让记忆页的 `profileUsage` 与 `ContextFormationService` 使用同一分级上限；若记忆页确实只应展示 private 档案，则单独返回一份按 `modelVisibleCeiling()` 计算的 `profileUsage` 供提示使用。补一条“敏感置顶记忆超过上限时记忆页出现提示”的测试。

### 2. 低：验收第 4 条的字面条件与实现不一致：有单条放不下、但 `used < limit` 时也会写截断记录

- 文件：`packages/application/src/services/owner-profile-service.ts:222-231`、`packages/application/src/services/context-formation-service.ts:340-345`
- 问题：`fit` 遇到放不下的条目会加入 `queued` 并继续尝试后面的条目；因此完全可能出现 `queued.length > 0` 但 `used < limit`。而 `ContextFormationService` 只判断 `usage.queued.length > 0 || usage.pinned > usage.limit`，于是会写一条 `profile_budget_exceeded`。若“档案没超出字数时，不产生任何截断记录”按 `used <= limit` 理解，这里不成立；若按“有任何条目被挤掉”理解，则代码和 ADR 是对的，但验收文字需要改。
- 证据：

```ts
// owner-profile-service.ts:225
if (length > remaining) {
  queued.push(memory.id);
  return false;
}
```

```ts
// context-formation-service.ts:341-344
if (
  this.dependencies.ledger &&
  usage &&
  (usage.queued.length > 0 || usage.pinned > usage.limit)
)
```

- 建议：明确验收口径是“有条目被挤掉”还是“used 超过 limit”。若是前者，修改验收文字；若是后者，补上 `used >= limit` 条件并新增边界测试，避免“只丢掉一条超长记忆、used 仍小于上限”被记为超预算截断。

### 3. 低：本轮增量把去重排序改为 `rowid`，但没有能区分旧排序的自动检查

- 文件：`packages/persistence-sqlite/src/sqlite-decision-ledger-operations.ts:332-351`、`test/integration/decision-ledger.test.ts:1148-1152`
- 问题：本轮把 `ORDER BY checked_at DESC, id DESC` 改成 `ORDER BY rowid DESC`，但现有 `[P2-5]` 用例每轮都调用 `clock.advance(1000)`，`checked_at` 递增；测试用的 id 也基本按写入顺序生成。把排序改回旧实现，这些用例仍会通过。也就是说，本轮真正修的行为没有被测试锁住。
- 证据：

```ts
// sqlite-decision-ledger-operations.ts:335-338
`SELECT reason_code AS reasonCode, inputs FROM decision_ledger
 WHERE owner_id = ? AND agent_id = ? AND kind = ?
   AND reason_code IN (SELECT value FROM json_each(?))
 ORDER BY rowid DESC LIMIT 1`,
```

```ts
// decision-ledger.test.ts:1148-1151
form: async () => {
  round += 1;
  clock.advance(1000);
```

- 建议：增加一条用例：两次截断记录的 `decidedAt` 相同（或后写记录的 id 字典序更小），验证 `appendIfChanged` 仍以最后写入的那条做比较；把排序临时改回旧实现时这条用例必须失败。

## 推测（未运行验证）

- `rowid` 在导出/导入恢复后不一定保持原来的写入顺序：`decision_ledger` 是 `id TEXT PRIMARY KEY`（`0087_rule_book_memory_link.sql:17-18`），导出查询没有 `ORDER BY`（`data-export/snapshot.ts:123-125`），导入按导出顺序插入（`data-export/import.ts:484-505`）。恢复后“最新一条”可能是任意一条，最坏只会多写一条重复记录，不会破坏数据。SQLite 的 `VACUUM` 也可能重排无 `INTEGER PRIMARY KEY` 表的 rowid；当前仓库未搜到执行 `VACUUM` 的代码。
- 多进程/多写者同时调用 `appendIfChanged` 时，普通 `BEGIN` 事务可能让两个事务都读到旧记录后各自插入，产生重复记录。当前 `product-state-repository` 看起来只有一个写上下文，所以实际风险较低；未在多进程场景验证。

## 侧重检查

- **错误路径**：`appendIfChanged` 失败被 `context-formation-service.ts:369-370` 的 `.catch(() => undefined)` 吞掉，不影响本轮对话；新增的 `[P2-5] still forms the context...` 用例覆盖了该路径。`appendIfChanged` 内的 `assertDiskHeadroom`、`validateLedgerWrite` 失败也会走同一路径。
- **不合规范/不可信输入**：`validateLedgerWrite` 校验了 `profileBudget` 的整性、`limit >= 1`、`pinned <= used` 以及只允许 `context_truncation` 携带；`reasonCodes` 限制 1–16 个、每个 1–64 字符、必须包含 `write.reasonCode`。未校验“profile 原因码必须带 profileBudget”，但当前调用方总会带。导入路径绕过 `validateLedgerWrite`，但导入是主人自己的备份，不构成新的信任边界。
- **安全/隐私**：决策记录只写记忆编号、`ruleIds` 空数组和三个数字，不写正文；测试明确断言 `JSON.stringify(rows[0])` 不含 `PROFILE_TEXT["memory-rule-long"]`。未发现新增泄露面。
- **资源耗尽**：置顶没有硬上限，`fit` 对置顶条目直接 `return true`（`owner-profile-service.ts:224`），主人置顶越多，最后一条用户消息可无限变长，可能超出模型上下文窗口；ADR 0214 第 95-96 行明确接受这一取舍。记录本身有 200 个编号上限，且去重限制了写入频率。
- **不可逆操作**：本改动只新增写记录，没有删除或覆盖不可恢复的数据；失败时静默跳过。
- **文档/规则一致性**：ADR 0214、决策记录写入约定、规则手册清单与代码大体一致；“记忆页能看到”在敏感分级场景不成立（见问题 1）；“档案没超出字数就不记录”的字面边界与实现不完全一致（见问题 2）。

## 必答问题

1. **不会改变模型已经见过的请求开头。** 档案块仍由 `createEnvelope` 放进 `contextBlocks`（`context-formation-service.ts:628-634`），最终在 `pi-runtime-adapter.ts:623-641` 的 `turnPrompt` 中渲染为历史之后的新用户消息；`usage` 只用于写决策记录和记忆页，没有进入档案块正文。置顶预留只改变最后一条用户消息里选中的条目。没有发现把每轮变化的值塞进系统提示或工具定义。需要说明：本次没有新增针对该功能的 prompt-prefix 专项测试，依赖现有通用检查。

2. **没有引入新的、会让同一段文字跨请求变成不同字节的模型可见值。** `queued` 只进决策记录/记忆页，记录里的 `memoryIds` 在 `context-formation-service.ts:359` 显式排序；`pinnedUsed/used` 是确定性求和；档案块文本仍由规则、分类、重要度、置顶状态决定，和改动前一样。`decidedAt` 是时间值，但不发给模型。唯一跨请求变化的是数据库里的记录本身，不影响请求字节。

3. **有自动检查，反向用例能真正失败，但本轮增量的关键修复缺测试。** 已有 `test/integration/decision-ledger.test.ts` 的 `[P2-5]`（worker 和直连两种执行方式）、`owner-profile-service.unit.test.ts` 的 `[P2-5]`、`memory-interactions.unit.test.ts` 和 `memory-source-browser.test.ts` 的正反向用例，以及本轮新增的“写记录失败仍能组上下文”用例。反向用例检查了“无 `context_truncation` 行”“无提示”“`queued` 为空”，行为错误时会失败。缺口是：本轮 `ORDER BY rowid` 的改动没有能区分旧排序的用例（见问题 3），敏感置顶记忆的记忆页提示也没有测试（见问题 1）。

4. **逐个核对结果：**
   - `profile_budget_exceeded` / `profile_pinned_over_budget`：产生于 `context-formation-service.ts:355-356`；由 `appendIfChanged` 的 `reasonCodes` 校验和数据库 `reason_code` 长度约束接受；长度均小于 64，OK。
   - `profileBudget {limit, used, pinned}`：产生于 `context-formation-service.ts:361`；`validateLedgerWrite` 校验 `limit >= 1`、`used >= 0`、`pinned >= 0`、`pinned <= used`且只允许 `context_truncation`；`insertLedgerRow` 持久化，`entryFromRow` 读回；`DecisionLedgerEntry` 的 `Required<DecisionInputs>` 由 `entryFromRow` 补齐 `null`。两端接受，OK。
   - `appendIfChanged` 操作名：`durable-adapters.ts:1022` 发出，`sqlite-decision-ledger-operations.ts:252-253` 接收，`sqlite-durable-operations.ts` 按 `decisionLedger.` 前缀路由，OK。
   - `profileUsage.pinned`：`production-memory-control.ts:704` 产生，网关契约 `contracts-v2.ts:1244-1247` 要求 `integer(0)`，`memory-page.tsx:1284` 消费，结构和校验匹配。但它与真正上下文的计算分级不一致（见问题 1）。旧版快照若被持久化并重新校验，缺少 `pinned` 会失败；本次未发现持久化 `memory.overview.snapshot` 的生产者，标为未核实。
   - i18n 键 `memory.page.carry.pinnedOver`：`message-ids.ts`、`en/ja/zh-CN` 三份资源、`MESSAGE_SAMPLE_VALUES` 和 UI 都齐全，OK。
   - 测试环境变量 `HIMAWARI_PROFILE_PINNED_CHARACTERS`：只在 e2e fixture 中使用，OK。
   - 文档中的 `profileBudget` 字段说明与 `insertLedgerRow` 的额外持久化键一致，OK。

**未核实**：无法运行测试、类型检查或全仓 lint；未验证仓库外是否有消费者依赖 `memory.overview.snapshot` 的旧结构。
