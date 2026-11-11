## 读代码证实的问题

### 1. 中 — 一次性词表不完整，新增长期说法会把“明天/暂时/先”这类话直接立成长期硬规则

- 文件：`apps/agent-service/src/production-owner-rules.ts:79-92`、`94-136`、`360-372`；相关承诺在 `docs/adr/0242-hard-rules-step4-unified-push-gate.md:53`
- 问题：判断逻辑是“同一从句里命中任一 `STANDING_MARKERS`，且不命中任何 `ONE_OFF_MARKERS`，就算长期有效”。这次新增了 `别提醒我` 等长期词，但一次性词只补了 `现在/今夜/一会/right now/for now`，没有 `明天、明早、明晚、暂时、先、目前、这几天、tomorrow、temporarily`。因此下面这些句子现在会被判为长期规则，而 ADR 说的是“带一次性词只算提议”：
  - `明天别提醒我`
  - `暂时别提醒我`
  - `先别提醒我`
  - `don't remind me tomorrow`
- 证据：
  - `STANDING_MARKERS` 里有 `"别提醒我"`（第 79 行）。
  - `ONE_OFF_MARKERS` 从第 94 行到第 136 行完整列表里没有上述词。
  - 判断逻辑只依赖这两份表：
    ```ts
    const rest = STANDING_STARTS.reduce((text, start) => text.replaceAll(start, " | "), clause);
    return (
      STANDING_MARKERS.some((marker) => containsMarker(rest, marker)) &&
      !ONE_OFF_MARKERS.some((marker) => containsMarker(rest, marker))
    );
    ```
    (`production-owner-rules.ts:366-369`)
- 影响：模型只要为这类话调用 `rule_set` 并给出重复的 `periods`，规则会直接 `active`，不需要主人确认；原本“明天早上别提醒我”会变成每周固定时段的长期静默规则。现有测试只覆盖了 `今晚/这次/现在`，没有覆盖 `明天/暂时/先/tomorrow`。
- 建议：补齐一次性词（至少 `明天/明早/明晚/暂时/先/眼下/目前/这几天/最近/tomorrow/temporarily` 及日文对应词）；更稳妥的是要求“长期有效”必须显式出现长期起始词或期限词，`别提醒我` 只作为辅助条件，不能单独把整句判为长期。

### 2. 低 — 闸门按分钟扫描最长 24 小时，每一步都新建 `Intl.DateTimeFormat`，会同步占用事件循环

- 文件：`packages/application/src/services/web-push-gate.ts:87-96`、`packages/application/src/services/proactive-rules.ts:169-183`
- 问题：为了找静默结束时刻，最多循环 1440 次；每次 `hitsAt(candidate)` 都会调用 `pushDeliveryFacts` → `zonedParts`，而 `zonedParts` 每次调用都 `new Intl.DateTimeFormat(...)` 和 `formatToParts`。如果规则覆盖全天（例如测试里的 `00:00–23:59` + `23:59–00:00`），就每次完整扫 1440 分钟；同一轮里最多三个非保护类别，因此最坏约 4320 次时区格式化加若干万次规则求值，都是同步执行。
- 证据：
  ```ts
  for (let at = base + MINUTE_MS; at <= limit; at += MINUTE_MS) {
    const candidate = new Date(at).toISOString();
    if (hitsAt(candidate).length === 0) { until = candidate; break; }
  }
  ```
  (`web-push-gate.ts:90-96`)
  ```ts
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat("en-US", { timeZone, ... }).formatToParts(new Date(at))...
  );
  ```
  (`proactive-rules.ts:170-183`)
- 影响：静默时段内每次有新的待发推送时会阻塞服务事件循环数十到数百毫秒；主人可以合法地建一条“全天静默”规则，反复触发。
- 建议：不要按分钟扫。直接由 `periods` 计算当前所在时段的结束分钟（已有 `quietEnd` 类逻辑可复用），或按每个时段的边界逐段判断；至少复用同一个 `Intl.DateTimeFormat`，并给扫描设更小的上限。

### 3. 低 — “读不懂的静默规则整类放行并告警”只在 `parameters.type` 完好时成立

- 文件：`packages/application/src/rules/rule-types.ts:426-431`、`apps/agent-service/src/service-main.ts:2392-2395`
- 问题：`unreadablePushRule` 只在 `row.parameters` 是对象、且 `row.parameters.type` 恰好等于已注册的 `push_delivery` 类型时才返回 true。如果存储的规则 `type` 被改成拼错的值、丢失、或整个 `parameters` 不是对象，函数返回 false，`readPushRules` 静默跳过这条规则，既不放行整类也不告警。测试甚至明确断言 `row("not an object")` 为 false。
- 证据：
  ```ts
  const type =
    typeof row.parameters === "object" && row.parameters !== null
      ? (row.parameters as Record<string, unknown>)["type"]
      : undefined;
  return registry.some(({ id, gate }) => id === type && gate === "push_delivery");
  ```
  (`rule-types.ts:427-431`；测试见 `rule-type-push-quiet-hours.unit.test.ts:145`)
- 影响：损坏方式恰好落在 `type` 字段时，静默规则会悄悄失效，和 ADR 0242 第 7 条“不会悄悄当成没有这条规则”的承诺不一致。它仍然是 fail-open，不会吞推送，所以严重度低。
- 建议：对 `push_quiet_hours` 的损坏不只认 `type` 字段；例如对任何无法解析且原始参数文本里出现 `push_quiet_hours` 的行都视为不可读，或对所有无法解析的主人规则统一告警（至少不静默）。

### 4. 低 — 迁移契约只验证了 8 张重建表中的 3 张，其余 5 张丢行不会被发现

- 文件：`packages/persistence-sqlite/test/web-push-gate-migration.contract.test.ts:66-79`、`packages/persistence-sqlite/src/migrations/0093_web_push_gate.sql:28-34`
- 问题：迁移 0093 复制并重建 8 张表，但契约测试只向 `decision_ledger`、`decision_signals`、`decision_prereviews` 各插一条并检查数量；`source_insights`、`proactive_processed_messages`、`decision_ledger_payloads`、`proactive_push_backoff`、`muse_reference_entries` 没有种子数据，复制列写错或漏列也不会让测试失败。
- 证据：测试只断言
  ```ts
  expect(... "SELECT count(*) FROM decision_ledger" ...).toBe(1);
  expect(... "SELECT count(*) FROM decision_signals" ...).toBe(1);
  expect(... "SELECT count(*) FROM decision_prereviews" ...).toBe(1);
  ```
  (`web-push-gate-migration.contract.test.ts:69-71`)
- 影响：迁移数据丢失的回归风险没有被自动检查覆盖；我对照过 0089/0091 的定义，0093 目前看起来是完整的，但测试守不住以后。
- 建议：给其余五张表各插一行（包括外键指向的 payload/processed message），迁移后逐表比较行内容；再加一条 `web_push_outbox` 延后列和触发器的契约断言。

### 5. 低 — `rule_set` 工具说明承诺“历史邮件回放”，但 push 规则永远没有回放

- 文件：`packages/prompt-catalog/src/tools.ts:231`、`apps/agent-service/src/production-owner-rules.ts:544-545`
- 问题：工具说明仍写“返回里有试算例子和在历史邮件上的回放结果，照实告诉主人”，但 `#replay` 对 `push_delivery` 直接返回 null。模型可能向主人声称做过邮件回放或把 `replay: null` 解释错。
- 证据：
  ```ts
  if (!this.#options.replay || rule.gate !== "mail_item") return null;
  ```
  (`production-owner-rules.ts:545`)
- 影响：低，只是工具输出与说明不一致，不影响闸门。
- 建议：说明里改成“邮件类规则有历史邮件回放；push_quiet_hours 只有试算例子”，或在返回结构里显式区分“没有回放”。

## 推测 / 未核实

- 【推测】第 3 轮 `d2dd9c28` 只改了 `TOOL_RULE_SET.text`，没有改工具参数结构；按 `.claude/rules/prompt-prefix.md:41-43`，纯说明文字变化不会触发已冻结对话换新。如果 `c685/e067` 曾先部署、老对话已经用旧说明重建过，那么这些对话不会因 `d2dd` 再重建，会继续保留自相矛盾的旧说明。本次作为一个 PR 一起上线则没有这个问题；“是否曾分段上线”未核实。
- 【未核实】我没有运行任何测试，也没有计算 `prompt-manifest.json` 的 SHA-256；因此“`npm run check` 只有 onnx 类型错误”“清单哈希匹配”均未独立验证。
- 【未核实】生产配置是否一定提供 `runPolicy.timeZone`。如果缺失，闸门会按 `UTC` 判断静默时段（`production-web-push.ts:465`），会导致按主人本地时间写的规则在错误时段生效。

## 侧重检查

- 错误路径：
  - `readPushRules` 抛错 → `decision = { action: "deliver", failed: true }`，推送照发并调 `onGateFailure`（`production-web-push.ts:460-475`）。确认。
  - `PushGate.decide` 内部抛错 → `DELIVER_FAILED`（`web-push-gate.ts:106-107`）。确认。
  - `deferItem` 抛错或返回 false → 不 continue，推送照发并告警（`production-web-push.ts:485-500`）。确认。
  - 审批/Muse/未知类别在调规则前直接放行（`production-web-push.ts:454-457`、`web-push-gate.ts:75`）。确认。
- 不可信/不合规范输入：
  - `periods` 数量、`days`/`classes` 长度、时钟格式、未知键、开始等于结束、空列表均有校验（`rule-types.ts:218-286`）。确认。
  - `deferItem` 校验了 `ruleRefs` 数量、单项长度和重复（`sqlite-web-push-operations.ts:400-410`），但没有校验它一定是数组、也没有校验 ref 格式；目前唯一调用方是闸门，产生的 ref 合法。属于内部端口健壮性问题。
- 安全与租户隔离：闸门、延后更新、决策记录写入都带 `ownerId/agentId`；决策记录 id 长度 73 < 128，`reason_code` 16 < 64，`subject_ref` 来自出站表且入队时限制 ≤256。未发现跨租户路径。
- 资源耗尽：见问题 2；规则数量有 32 条上限（`production-owner-rules.ts:53`），单个规则最多 8 个时段，因此单次扫描规模有界但仍是同步长循环。
- 不可撤销/可恢复：延后本身可由改/停/删规则通过触发器清空；`deferItem` 与决策记录同一事务，写记录失败会整体回滚并照发（`sqlite-web-push-operations.ts:409-449`）。迁移是单向重建，但复制、删除、重建、插回的顺序和外键依赖正确，`foreign_key_check` 测试也覆盖。
- 规则/文档一致性：ADR 0242 第 5 条与实现的长期词基本一致，但一次性词覆盖不足（问题 1）；第 7 条“读不懂”承诺在 `type` 损坏时不成立（问题 3）；工具说明与 push 无回放不一致（问题 5）。

## 必答问题

### 1. 会不会改变模型已经见过的请求开头？

**会改变一次，但不是每轮变化。**

- 本次改了 `rule_set` 的工具定义：`type` 枚举增加了 `push_quiet_hours`，`params` 增加了 `periods/classes`，说明文字也改了。工具定义在请求最前面，因此所有老对话的第一轮请求开头会变一次。
- 按 `.claude/rules/prompt-prefix.md:41-43`，这属于第 6 条例外的“工具集合变了（工具名，或者去掉说明文字后的参数结构）”，允许换新一次；ADR 0242 也写了 Andy 已接受。除此之外，本次没有改系统提示文字、历史消息、遮盖规则。
- 换新之后，发给模型的内容仍然只在末尾追加；会变的值（当前时间、延后到几点、规则命中结果）都只在工具结果/数据库里，没有进入系统提示或工具定义。没有发现把每轮变化的值塞进请求开头的路径。

### 2. 同一段文字会不会在不同请求里变成不同字节？

**没有发现模型可见文字的非确定性变化。**

- 规则参数：`classes` 按固定常量顺序输出，`periods` 按 `JSON.stringify` 排序，`days` 去重排序，规则表达式由这些固定顺序生成（`rule-types.ts:265-289`）。
- 闸门：`ruleRefs` 用 Set 去重后排序，最多 16 条（`web-push-gate.ts:97-99`）；`deferItem` 再次排序（`sqlite-web-push-operations.ts:409`）；`defer_until` 是分钟对齐的 ISO 字符串。
- 决策记录 id 由 owner/agent/sourceKey/deferUntil 的固定数组计算，确定性；重复延后是 `ON CONFLICT DO NOTHING`。
- 规则例子、工具结果里的试算时间都由固定 facts 生成，不含当前时间。
- 没有改出口遮盖相关代码，遮盖字节不会因这次改动变化。

### 3. 有没有自动检查，反向用例会不会真的失败？

**有较多检查，但覆盖有缺口。**

已有：
- `rule-type-push-quiet-hours.unit.test.ts`：类型注册、默认类别、跨午夜边界、审批/Muse 不交给规则、非法时段/类别/超长列表等都带反向用例。
- `web-push-gate.unit.test.ts`：正常延后、到点放行、24 小时上限、夏令时、规则类别不匹配放行、坏规则放行并报错。
- `production-web-push.test.ts` 的 `[HR-4]`：真实 SQLite 下的延后/一次写入/到点发所有设备；无规则立刻发、审批不延后、决策记录写失败回滚并照发、规则读取失败照发并告警、撤销规则立即放出、延后期间新订阅设备等反向用例。
- `web-push-gate-migration.contract.test.ts`：保留三类数据、外键检查、触发器仍不可改、`web_push` 只接受 `deferred` 的反向用例。
- 规则词表：`production-memory-capture.test.ts` 覆盖了 `今晚/这次/现在/今夜/right now/从现在起`。

缺口：
- 没有测试 `明天别提醒我`、`暂时别提醒我`、`先别提醒我` 等，因此问题 1 的反向用例缺失。
- 没有集成测试走 `service-main` 的 `unreadablePushRule(row) → throw → 整类放行并告警` 链路；现有单测只测 `unreadablePushRule` 分类，集成测试里的 `read` 直接 `enforceableOwnerRule`，不会触发生产 wiring。
- 迁移契约只验证 3/8 张表的数据保留（问题 4）。
- `npm run check` 的 `check:rule-registry` 会跑 `rule-type-*`、`rule-version`、`decision-chain`，但 `web-push-gate.unit.test.ts`、`production-web-push.test.ts`、迁移契约不在那 50 步里；它们依赖更宽的 `npm test`，我没有运行核实。

### 4. 每个新值，产生处和使用处都能接受吗？

逐项核对结果：

- **决策种类 `web_push`**
  - 产生：`sqlite-web-push-operations.ts:432-445`。
  - 使用/校验：
    - `packages/application/src/ports/decision-ledger.ts:40,61` 已加入 `DECISION_KINDS`/`DECISION_OUTCOMES`。
    - 迁移 0093 的 `decision_ledger.kind` CHECK 和 `outcome='deferred'` 分支接受它。
    - `packages/gateway-contracts/src/contracts-v2.ts:1102` 的决策链枚举接受它。
    - `packages/persistence-sqlite/src/data-export/schemas.ts:198` 的导出 schema 接受它；导入 SQL 不按 kind 拒绝。
    - `daily-review.ts:45,356` 显式排除它；`sqlite-decision-ledger-operations.ts:520` 的每日回顾查询也排除。
    - `calibration/src/index.ts:274-290` 的 `calibrationGroup` 对 `web_push` 返回 null，因此不进校准分组；`CALIBRATION_SQL.decisions` 本身没过滤它，但分组汇总会丢弃，未发现计数副作用。
    - 三种语言的 `decision.chain.kind`、`weekly.check.rowsMissing` 都已加 `web_push` 分支。
  - 结论：通过。
- **规则种类 `push_quiet_hours`**
  - 产生：`rule-types.ts:331-334` 注册，规则记录写入 `rule_book_rules.parameters.type`。
  - 使用/校验：
    - `rule-version.ts:26,30` 已加入 `RULE_KINDS`/`OWNER_RULE_KINDS`，`describeRuleVersion` 能识别并生成 `quietHours`。
    - `data-export/rules.ts:58,69,165-175` 已加入 `STORED_KINDS`、标签和措辞；导入校验接受它。
    - `gateway-contracts/src/contracts-v2.ts:1126` 的规则种类枚举接受它。
    - `field-catalog.ts` 的 `push_delivery` 门和字段已加；`rule-book.ts` 的门结果已加。
    - control-center 的 `rules.type`、`decision.chain.rule` 已加分支。
  - 结论：通过。
- **`reason_code = "push_quiet_hours"`**：长度 16，满足 ≤64；没有其他枚举校验，导出 schema 使用一般字符串。通过。
- **决策记录 id `web-push-<sha256>`**：73 字符 ≤128。通过。
- **`defer_until`**：应用侧 `this.time` 校验，数据库 CHECK 要求长度 24；闸门写入的是 `toISOString()` 24 字符。通过。
- **`defer_rule_refs`**：闸门最多 16 条、每条 ≤256、去重；`deferItem` 再校验一次；数据库 CHECK 只要求合法 JSON 数组。两端都能接受。该列目前只被写、被触发器清空、被契约测试读取，没有业务读取路径。
- **`subject_ref = sourceKey`**：入队时 sourceKey ≤256，迁移和 `insertLedgerRow` 的校验都接受。通过。
- **`createdAt/expiresAt` 计算**：`expires_at` 延长到 `min(max(原值, until+1h), createdAt+48h)`，与 ADR 的 48 小时硬上限一致；ADR 也明确承认到点前过期会记为 `expired` 不再发送。

唯一没有跨端闭合的是问题 3 的 `unreadablePushRule`：它只接受 `type` 完好的损坏规则，`type` 本身损坏时会被静默忽略；以及问题 4 的迁移数据保留测试覆盖不足。
