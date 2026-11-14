# PR 414 第 5 轮增量复核（9e44dbc5..85239d09）

本轮增量 8 个文件：`production-owner-rules.ts`、`rule-types.ts`、`web-push-gate.ts`、`sqlite-web-push-operations.ts` 及 4 个测试文件。未改文档。以下结论按严重度排列。

---

## 发现（读代码证实）

### 1. 中高：`needs_review` 的静默规则被 `deferItem` 当成“已失效”，延后不落库，提醒可能在静默结束前过期被吞

**文件**
- `packages/persistence-sqlite/src/sqlite-web-push-operations.ts:417-433`
- `apps/agent-service/src/service-main.ts:2385-2396`
- `packages/persistence-sqlite/src/sqlite-owner-rule-operations.ts:86-91`
- `packages/application/src/rules/rule-book.ts:14-15`
- `apps/agent-service/src/production-web-push.ts:420-423, 478-500`

**问题**
`deferItem` 新增的依据核对只接受 `status = 'active'`：

```417:433:packages/persistence-sqlite/src/sqlite-web-push-operations.ts
const current = this.database.prepare(
  `SELECT 1 FROM rule_book_rules
   WHERE owner_id = ? AND agent_id = ? AND rule_id = ? AND revision = ? AND status = 'active'`,
);
...
if (stale) return true;
```

但生产端 `readPushRules` 读的是 `includeRetired: false`，该查询明确包含 `needs_review`：

```88:88:packages/persistence-sqlite/src/sqlite-owner-rule-operations.ts
   AND (? = 1 OR status IN ('active', 'needs_review'))
```

```14:15:packages/application/src/rules/rule-book.ts
export function ruleIsEnforced(status: RuleStatus): boolean {
  return status === "active" || status === "needs_review";
}
```

`enforceableOwnerRule` 也只排除 `retired`（`rule-types.ts:436-447`），因此 `needs_review` 规则会进入闸门、会命中、会返回 `defer`；随后 `deferItem` 却因 `status = 'active'` 判定 stale，直接 `return true`，**在 UPDATE 和写决策记录之前返回**。

`#deferred` 把这个 `true` 当成“已延后/本轮跳过”：

```485:500:apps/agent-service/src/production-web-push.ts
let stored = false;
try {
  stored = await store.deferItem({...});
} catch {
  this.#options.onGateFailure?.({ sourceKey: item.sourceKey });
}
gated.set(item.sourceKey, stored);
return stored;
```

因此这条推送：
- 没有写入 `defer_until`；
- 没有执行有效期延长（延长只在 `deferItem` 成功时生效，见 `production-web-push.ts:478-484`）；
- 没有写 `web_push` 决策记录。

下一轮 `#deliver` 先按**原始** `expiresAt` 判过期：

```420:423:apps/agent-service/src/production-web-push.ts
if (Date.parse(now) >= Date.parse(item.expiresAt)) {
  await this.#record(entry, now, "expired", null);
  continue;
}
```

具体后果：一条到点提醒若在 23:30 到期、原始寿命是 6 小时（到期后 05:30），静默时段是 23:00–07:00，则在 05:30 被记为 `expired`，07:00 静默结束后也不会再发。正常 `active` 规则会延长到 08:00，这正是现有用例 `production-web-push.test.ts:741-770` 在守的行为。

`needs_review` 不是假想状态：迁移 0087 会在规则来源记忆被改/删时把 `active` 规则改成 `needs_review`（`0087_rule_book_memory_link.sql:301-361`，ADR 0211 第 3 条）。因此这不是纯理论路径。

**与说明文档不一致**：ADR 0242 决定 6 写“延后后有效期延长到延后时刻再加 1 小时”（`docs/adr/0242-hard-rules-step4-unified-push-gate.md:54`），决定 8 写“每次延后写一条决策记录”（同文件 `:56`）。stale 分支两者都跳过了。

**建议**
- 让两端使用同一个“有效”定义：`deferItem` 改成 `status IN ('active','needs_review')` 或直接复用 `ruleIsEnforced`。
- 如果产品上决定 `needs_review` 规则不应再拦推送，则应在 `readPushRules`/闸门处一致地排除它，并明确文档，而不是在 `deferItem` 里静默变成“跳过但不延后”。
- 补反向用例：规则为 `needs_review`、到点提醒的原始 `expiresAt` 早于静默结束，断言推送被延后且有效期被延长、最终在静默结束后发出（当前代码会失败）。

---

### 2. 中：一次性范围词仍不完整，“这个月 / 今年 / 明年 / 本季度”等限时请求会被自动立成永久规则

**文件**
- `apps/agent-service/src/production-owner-rules.ts:124-207`（`ONE_OFF_MARKERS`）
- `apps/agent-service/src/production-owner-rules.ts:431-444`（`isStandingQuote`）

**问题**
本轮补了 `下周`、`下个`、`下星期`、`这个周`、`这周`、`本周`、`这个星期`、`后天`、`这两天`、`上周`、`上个`、`next week`、`this weekend`、`last night` 等，但词表里完全没有月份、年份、季度维度的词：

- 没有 `这个月`、`本月`、`下个月`（只有 `下个` 可偶然覆盖）、`上个月`（只有 `上个` 可偶然覆盖）；
- 没有 `今年`、`明年`、`去年`；
- 没有 `这个季度`、`本季度`、`下个季度`；
- 英文没有 `this month`、`next month`、`last month`、`this year`。

而判定逻辑是：

```438:442:apps/agent-service/src/production-owner-rules.ts
const standing =
  STANDING_MARKERS.some((marker) => containsMarker(rest, marker)) ||
  (QUIET_REQUEST_MARKERS.some((marker) => containsMarker(rest, marker)) &&
    RECURRING_TIME_MARKERS.some((marker) => containsMarker(rest, marker)));
return standing && !ONE_OFF_MARKERS.some((marker) => containsMarker(rest, marker));
```

因此 `这个月晚上别提醒我`、`明年晚上别提醒我`、`本季度夜里别提醒我`、`this month at night don't remind me` 都满足“静默请求 + 反复时段词 + 无一次性词”，会被判为长期话术；在 `production-owner-rules.ts:776` 满足 `explicit` 后直接 `#activate`，自动生成永久 `push_quiet_hours` 规则。这与本轮“补范围一次性词”的说法不符，也是比“误判为提议”更危险的方向：会多立一条永久规则（虽可撤销，但用户没有要求永久生效）。

现有新增测试只覆盖了 `这个周末`、`下周三`、`后天`、`昨晚`、`this weekend`、`next week`（`test/integration/production-memory-capture.test.ts:2119-2124`），没有月/年/季度用例。

**建议**
- 补齐上述月、年、季度中英文标记，并加 `isStandingQuote("这个月晚上别提醒我") === false`、`isStandingQuote("明年夜里别提醒我") === false` 等用例。
- 顺带考虑反向误判：`从下周起每晚别提醒我` 现在会因 `下周` 被当成一次性而不自动生效（只会生成提议）。这比误立永久规则安全，但建议明确是否需要支持“未来起算的长期规则”。

---

### 3. 低：`deferItem` 返回 `true` 同时表示“已延后”和“没写但本轮跳过”，接口语义含混，且 ADR 未记录该分支

**文件**
- `packages/persistence-sqlite/src/sqlite-web-push-operations.ts:433`
- `apps/agent-service/src/production-web-push.ts:485-500`
- `docs/adr/0242-hard-rules-step4-unified-push-gate.md:54,56`

**问题**
`deferItem` 在 stale 时返回 `true`，但它没有写入任何东西；`#deferred` 用这个布尔值决定“本轮是否跳过”，于是“已延后”“依据已失效所以暂缓”“行不存在所以没写”三种情况都不可区分。本轮没有同步更新 ADR，ADR 仍写“每次延后写一条决策记录”“有效期延长到延后时刻再加 1 小时”。

另外，`web-push-gate.ts:90-100` 把扫描中命中的规则全部记入 `ruleRefs`，但最后 `slice(0, 16)`；当同一主人有超过 16 条规则参与连续静默时，决策记录不会“记全”，且被截掉的那条若被撤销，`deferItem` 的 stale 检查也看不到它（不过数据库触发器仍会清空延后，因此不是发送正确性问题，只是依据记录不完整）。

**建议**
- 把返回值改成可区分的结果（如 `"deferred" | "stale" | "missing"`），或至少加注释并在 ADR 中写明 stale 分支。
- 在 ADR/设计文档里明确“stale 时本轮不发、不写记录、不延长有效期”，并说明与决定 6/8 的关系。
- 如确实要求记全，可提高上限或明确“最多记 16 条”。

---

### 4. 低：迁移契约测试只填了 8 张重建表中的 3 张，另外 5 张的数据保留没有被验证

**文件**
- `packages/persistence-sqlite/test/web-push-gate-migration.contract.test.ts:67-79`
- `packages/persistence-sqlite/src/migrations/0093_web_push_gate.sql:30-36`（八张 `_keep` 表）

**问题**
用例只插入了 `decision_ledger`、`decision_signals`、`decision_prereviews`，并只断言这三张表的行数和 `foreign_key_check`：

```69:72:packages/persistence-sqlite/test/web-push-gate-migration.contract.test.ts
expect(database.prepare("SELECT count(*) FROM decision_ledger").pluck().get()).toBe(1);
expect(database.prepare("SELECT count(*) FROM decision_signals").pluck().get()).toBe(1);
expect(database.prepare("SELECT count(*) FROM decision_prereviews").pluck().get()).toBe(1);
expect(database.pragma("foreign_key_check")).toEqual([]);
```

`source_insights`、`proactive_processed_messages`、`decision_ledger_payloads`、`proactive_push_backoff`、`muse_reference_entries` 在迁移前都没有数据，所以即使列映射遗漏或数据丢失，这个测试也不会失败。SQL 本身逐列核对过后看起来是完整的，但这是“读代码判断”，不是测试保证。

另外，`rule_book_rules_release_push_*` 三个触发器目前只被 `production-web-push.test.ts:675-691` 的“撤销规则立即放出”用例间接覆盖；迁移契约测试没有断言这三个触发器在 0093 后仍存在。ADR 0242 决定 6 特意警告“以后谁重建 `rule_book_rules` 必须一并重建”，但契约测试没有守住这一点。

**建议**
- 在迁移前向八张表各插入至少一行，迁移后断言行数和关键列；补 `foreign_key_check`。
- 在迁移契约测试中查询 `sqlite_master`，断言三个 release 触发器和两张表的 immutable 触发器都存在。

---

## 作者说法核对

- “闸门在 `#deliver`；审批、Muse 告警和认不出的来源代码直接放行”：**已核实**。`PUSH_RULE_PROTECTED_CLASSES` 含 `approval`、`muse_outage`、`unknown`（`web-push-gate.ts:17-21`），`#deferred` 在 454-457 行直接放行。
- “规则读取或判断出错：推送照发并调 `onGateFailure`”：**已核实**。`web-push-gate.ts:107-109`、`production-web-push.ts:460-474, 486-498`。但注意 `unreadablePushRule` 抛错会让**所有**推送类别都不再应用任何 push 规则（fail-open 到全部规则失效），不是只跳过坏规则。
- “`deferItem` 和出站表更新同一事务”：**已核实**（`sqlite-web-push-operations.ts:415-466`）。
- “同一轮同一类推送只判断一次”：**已核实**（`production-web-push.ts:417, 458-472`）。
- “延后 ≤24h、有效期延长到 until+1h、总寿命 ≤48h”：**代码已核实**（`web-push-gate.ts:23, 87-104`；`production-web-push.ts:25-26, 478-484`）。但 stale 分支会绕过延长，见发现 1。
- “决策记录 `web_push`/`deferred` 同事务写，不进每日打分和校准”：**已核实**（`deferItem:449-463`；`daily-review.ts:352-354`；校准组列表没有 `web_push`）。
- “迁移 0093 重建八张表、保留 `decision_prereviews` 不可改触发器”：**已核实** SQL 与重建后的触发器定义（`0093_web_push_gate.sql:323-339`）。
- “一句话立规则词表加了‘别提醒我’等”：**已核实，但不完整**（见发现 2）。
- “`rule_set` 工具定义改了，老对话重建一次缓存（主人已同意）”：**已核实**工具文本与参数 schema 都变了（`prompt-catalog/src/tools.ts:231`、`production-owner-rules.ts:278-303`、`prompt-manifest.json:829-832`）；ADR 0242 前提 4 记录了 Andy 的同意。
- “测试推送不走闸门”：**已核实**（`sendTest` 在 `production-web-push.ts:254-281`，不调用 `#deferred`）。
- “`npm run check` 只有已有 onnx 类型错误 / 相关测试都通过”：**未核实**，本轮工具只允许读文件和部分 git 命令，不能运行测试。
- “第 5 轮：`deferItem` 核对依据仍是同一版本且有效”：**同一版本已核实**，但“有效”的判定与闸门不一致（`needs_review`），见发现 1。
- “决策依据记全扫描中扣住推送的规则”：**已核实扫描逻辑**（`web-push-gate.ts:90-100`），但受 `slice(0, 16)` 限制（见发现 3）。
- “`unreadablePushRule` 也认 `push_` 开头的 type”：**仅对象形态已核实**（`rule-types.ts:428-432`）；字符串形态的参数只会命中精确的 `push_quiet_hours` 文本，见“推测”。

---

## 推测 / 未核实

1. **发现 1 的实际损失频率**：`needs_review` 状态可达性由迁移 0087/ADR 0211 证实；“6 小时提醒跨过静默时段才会真正丢失”是代码推演，未用测试复现。
2. **发现 2 的触发方式**：需要模型把整句 `这个月晚上别提醒我` 原样作为 `quote` 传入且 `inferred=false`。`#ownerSaid` 要求整段子句匹配（`production-owner-rules.ts:453-462, 510-527`），所以模型若只引用 `晚上别提醒我` 不会自动生效；但模型按工具说明原样引用整句时，`isStandingQuote` 会误判为长期。
3. **字符串形态的不可读 push 规则**：如果 `row.parameters` 是 JSON 字符串而不是对象，且类型拼写为 `push_quiet_hour`（少了 s），`unreadablePushRule` 既看不到对象上的 `type`，文本里也不含精确的 `push_quiet_hours`，会静默忽略而不告警。该形态在生产正常写入路径下不可达（`fromRow` 会 `JSON.parse`），但数据导入/损坏时可能。
4. **规则原文未核实**：请求引用的 `.claude/rules/prompt-prefix.md` 不在当前 checkout 中，本报告只能以 ADR 0164/0165/0242 的转述为准。

---

## 侧重检查

- **错误路径**：`readPushRules` 抛错 → 闸门 fail-open，推送照发并 `onGateFailure`（已核实）。`deferItem` 抛错（含 ledger 写失败）→ 事务回滚、推送照发并告警（已核实，且有 `production-web-push.test.ts:625-649` 反向用例）。**但 stale 不是错误路径**，它静默跳过本轮、不告警、不记录，正是发现 1 的问题。
- **不合规范/不可信输入**：规则参数有 `periods` 1–8、`days` 1–7、`classes` 1–3 上限，时钟正则、`additionalProperties: false`（`rule-types.ts:223-289`）已核实。`deferItem` 对 `ruleRefs` 有 1–16、长度 ≤256、去重校验（`sqlite-web-push-operations.ts:404-410`）已核实。`defer_until` 在 DB 有长度 24 CHECK，`defer_rule_refs` 有 JSON array CHECK（0093:1-5）已核实。未发现可注入路径。
- **安全**：审批/Muse/unknown 由代码直接放行，不能被规则拦住（已核实）；规则只能延后 `scheduled_reminder`/`run_result`/`mail_reminder`，不能影响审批和告警（`PUSH_QUIET_CLASSES` 与 protected 集合，已核实）；没有新增把敏感内容写进日志的路径，`onGateFailure` 只记 `sourceKey`（已核实）。未发现越权或凭据泄露。
- **资源耗尽**：闸门每分钟扫描最多 1440 次/类别，决策按 `pushClass` 缓存（每轮最多 3 次规则读取）；`ruleRefs` 上限 16。没有新增无界循环或集合。**但发现 1 使 `needs_review` 推送每 10 秒重新进入 `listDue` 并重复读取规则/计算内容**，在超过 50 条待发时还会挤占本轮的发送名额，属于需要修复的次要资源问题。
- **不可撤销操作**：规则创建可撤销；延后由 `rule_book_rules` 三个触发器在规则新增/修改/删除时清空（0093:9-27，已核实）；迁移 0093 不可逆，但沿用既有迁移/快照机制，不是本增量新增风险。
- **文档与代码一致**：本轮改了 `deferItem` 语义和一次性词表，但 **ADR 0242 未同步**（发现 3）；`schema-catalog.ts:835-839` 对 `decision_ledger` 的描述仍未提到 `web_push` 种类（`decision_ledger` 条目列的是 proactive、memory candidate、consolidation、truncation、retrieval degrade、external read、rule review、failed memory capture）。属于文档小缺口。

---

## 必答问题

### 1. 会不会改变模型已经见过的请求开头？是否仍然只在末尾追加？

**本轮第 5 轮增量：不会。** 这 8 个文件都不在 prompt/system/tool 目录，也没有改历史消息或遮盖规则；`readPushRules`、`deferItem`、词表判定都只在推送服务端执行，不进入模型请求。

**整个 PR：会改变一次请求开头，但不是在运行时每轮追加。** `tools.rule-set` 的文本和 `params` JSON Schema 都变了：

- 文本：`packages/prompt-catalog/src/tools.ts:226-231`，`prompt-manifest.json:829-832` 的 sha256/`changedIn: ADR 0242` 已更新；
- 参数结构：`apps/agent-service/src/production-owner-rules.ts:278-303` 新增 `periods`、`classes`。

按 ADR 0165，工具参数结构变化会为每个老对话触发一次 `tool_schema_changed` 换新（`docs/adr/0165-...md:66`），因此老对话下一轮的系统提示/工具数组会换一次，**不是“只在末尾追加”**；ADR 0242 前提 4 和后果记录了 Andy 已同意这次一次性的缓存失效（`docs/adr/0242-...md` 前提 4 / 后果“上线后，所有老对话的第一轮请求开头变一次”）。除这次已批准的换新外，每轮会变的延后时刻、规则版本、决策编号都只落在数据库/推送侧，不进入模型请求；`rule_set` 的试算例子/回放结果是工具结果，属于末尾追加。`.claude/rules/prompt-prefix.md` 原文不在 checkout 中，**未核实**其确切措辞。

### 2. 会不会让同一段文字在不同请求里变成不同的字节？

**本轮增量：不会。** 新增的 `refSet` 最终 `.sort()`（`web-push-gate.ts:90, 100`），`ruleRef` 是 `id@revision` 的确定性拼接，`defer_rule_refs` 在 `deferItem` 里再次排序后 `JSON.stringify`（`sqlite-web-push-operations.ts:411, 442`）；时区格式器按 timeZone 缓存且 `Intl.DateTimeFormat` 输出稳定（`proactive-rules.ts:169-191`）。延后到几点依赖 `now`，但它只写入 `web_push_outbox`/决策记录，不发给模型。规则示例/试算由排序后的 `periods`/`classes` 生成，确定性不变。未发现新的“同文不同字节”来源。

### 3. 有没有对应的自动检查？反向用例真的会失败吗？

**有，且本轮新增的三类反向用例在改动前都会失败（按代码推断，未运行测试）：**

- `web-push-gate.unit.test.ts:41-60`：断言扫描后 `ruleRefs` 包含后段才命中的 `owner:late@1`；旧代码只取 `first` 命中的规则，会失败。
- `production-web-push.test.ts:693-718`：撤销竞态下断言 `deferUntil` 为 null、ledger 为空、本轮不发、下一轮发；旧 `deferItem` 会写延后和 ledger，会失败。
- `rule-type-push-quiet-hours.unit.test.ts:152-154`：`{type:"push_quiet_hour",...}` 必须被判不可读；旧逻辑文本里不含精确 `push_quiet_hours`，会返回 false，会失败。
- `production-memory-capture.test.ts:2119-2124`：新增的 `这个周末/下周三/后天/昨晚/this weekend/next week` 断言在未加词前会返回 true，会失败。

**缺口：**
- 没有 `needs_review` + 短寿命提醒的用例（发现 1 的核心）。
- 没有 `这个月/今年/明年/本季度/this month/next month` 的用例（发现 2）。
- 迁移契约测试只覆盖 3/8 张表的数据保留（发现 4）。

### 4. 每个新值/字段，产生端和使用端都接受吗？逐项核对两端

- **`defer_until`**：产生端 `web-push-gate.ts:95/103` 是 `Date#toISOString()`；使用端 `deferItem` 用 `this.time` 校验、DB 列 CHECK `length=24`、`listDue` 按字符串比较（`0093:1-2`，`sqlite-web-push-operations.ts:336`）。**接受**。
- **`defer_rule_refs` / `ruleRefs`**：产生端 `web-push-gate.ts:90-100` 生成排序去重后的 `id@revision`，最多 16 条；使用端 `deferItem` 校验 1–16、长度 ≤256、去重（`sqlite-web-push-operations.ts:404-410`），DB CHECK 为 JSON array（`0093:4-5`），决策记录 `inputs.ruleIds` 会被 gateway schema 以 `boundedString(256)` 接收（`contracts-v2.ts` decision chain rules item）。**接受**。
- **延后后的 `expiresAt`**：产生端 `production-web-push.ts:478-484`，使用端 `deferItem` 校验 ISO 并写库。**正常路径接受；stale 路径根本不写**（发现 1）。
- **`web_push` / `deferred`**：产生端 `deferItem:449-463`；DB CHECK 只允许 `web_push` + `deferred`（`0093`），`DECISION_KINDS`/`DECISION_OUTCOMES` 已加（`ports/decision-ledger.ts:37-58`），gateway enum、data-export schema 已加，`daily-review.ts:352-354` 主动排除，校准组列表不含。**接受**。
- **`push_quiet_hours` 类型**：`RULE_TYPES`、`RULE_KINDS`、`OWNER_RULE_KINDS`、`field-catalog` 的 `push_delivery`、data-export `STORED_KINDS`/文案、gateway rule kind enum、control-center i18n 都有。**接受**。外部 MCP 的 `EXTERNAL_RULE_TYPES` 仍只有两种邮件规则，这是 ADR 0226 的既有边界，不是遗漏。
- **规则 `status`**：产生端（`readPushRules`）接受 `active` 和 `needs_review`，消费端（`deferItem`）只接受 `active` —— **不接受，正是发现 1**。
- **超过 16 条依据规则**：产生端截断到 16（`web-push-gate.ts:100`），消费端校验上限 16，因此接口接受，但“记全”只能到 16 条；见发现 3。
