工具调用已按本轮上限停止；以下结论只基于我已读到的代码与文档。凡是没读到的，均标「未核实」。

# 一、读代码证实的问题（按严重度从高到低）

## 1. 高：带范围词的一次性静默请求会被自动立成长期规则，不经主人确认

**文件:行**：`apps/agent-service/src/production-owner-rules.ts:96-123`、`124-181`、`405-418`、`749-751`

**问题**：第 4 轮把“长期有效”改成“静默请求词 + 反复时段词”的结构判断，但反复时段词表包含 `晚上`、`周末`、`夜里` 这类本身不带期限的词，而一次性词表没有 `下周`、`下周末`、`这个周末`、`这周`、`后天`、`这两天`、`上个周末`、`昨晚` 等范围词。于是“这个周末别提醒我”“下周三晚上别提醒我”“后天晚上别提醒我”都会命中“静默请求 + 反复时段”，被当成长期规则。

**证据（我读到的代码）**：

```ts
const RECURRING_TIME_MARKERS = [
  "夜里", ..., "晚上", ..., "周末", ...
];
const ONE_OFF_MARKERS = [
  ..., "明天", "明早", "明晚", "明日", ..., "这几天", "最近", ...
];
...
const standing =
  STANDING_MARKERS.some((marker) => containsMarker(rest, marker)) ||
  (QUIET_REQUEST_MARKERS.some((marker) => containsMarker(rest, marker)) &&
    RECURRING_TIME_MARKERS.some((marker) => containsMarker(rest, marker)));
return standing && !ONE_OFF_MARKERS.some((marker) => containsMarker(rest, marker));
```

而 `create` 里一旦 `explicit` 为真就直接激活，不再要求确认：

```ts
const explicit =
  !input.inferred && isStandingQuote(quote) && (await this.#ownerSaid(input.threadId, quote));
if (explicit) return this.#activate(proposal, replayed);
```

**建议**：
- 补范围一次性词：`下周`、`下个`、`下周末`、`这个`、`这周`、`本周`、`后天`、`这两天`、`头几天`、`昨晚`、`昨天`、`上个`、`上周`、`上周末`；英文 `next week/weekend`、`this weekend/week`、`these days`、`yesterday`、`last night/week`；日文 `来週`、`今週`、`明後日` 等。
- 更稳妥的是：`晚上`、`早上` 这类弱时段词单独出现时只生成提议，必须同时出现明确的长期词（`每天`、`每晚`、`平时`、`工作日`、`以后` 等）才自动激活。
- 增加反向用例：`这个周末别提醒我`、`下周三晚上别提醒我`、`后天晚上别提醒我` 必须为 `false`（只提议，不激活）。现有测试只覆盖到 `明天`、`暂时`、`先别`、`明天晚上`、`don't remind me tomorrow`（`test/integration/production-memory-capture.test.ts:2110-2118`）。

---

## 2. 中：`unreadablePushRule` 用“整段序列化文本是否包含类型 id”判断，既会漏报也会误报

**文件:行**：`packages/application/src/rules/rule-types.ts:422-429`、`apps/agent-service/src/service-main.ts:2385-2396`

**问题**：ADR 0242 决定 7 要求“存着的静默规则读不懂时整类放行并告警，不会悄悄当成没有这条规则”。现在的实现是搜索整个 `parameters` 文本里是否出现 `"push_quiet_hours"`：

```ts
const text = typeof row.parameters === "string" ? row.parameters : JSON.stringify(row.parameters);
return registry.some(({ id, gate }) => gate === "push_delivery" && (text ?? "").includes(id));
```

- 漏报：如果一条本来该是静默规则的记录，`type` 被改坏成 `push_quiet_hour`（少一个 s），而 `summary` 里又没有完整字符串 `push_quiet_hours`，这里返回 `false`，该规则被静默忽略，不告警，和 ADR 的保证不一致。
- 误报：任何不可执行的非静默规则，只要 `summary` 或 `phrases` 等参数文本里出现字面量 `push_quiet_hours`，就会让整个规则列表抛错；`service-main.ts` 随后让整类推送放行并每次告警：

```ts
if (unreadablePushRule(row)) throw new Error("PUSH_RULE_UNREADABLE");
```

**建议**：不要靠整段文本子串。可以在规则记录里加一个明确的“闸门/类型”标记，或至少按结构化字段判断：`row.parameters.type` 属于 `push_delivery` 类型、或以 `push_` 开头的未知类型时视为不可读；同时补两条反向测试：`type` 拼错但 `summary` 不含 id 时必须判为不可读，普通邮件规则参数里出现该字面量时不得误判。

---

## 3. 中（窄竞态）：规则刚被撤销时，正在进行的延后写入可能把推送重新扣住到 `until`

**文件:行**：`apps/agent-service/src/production-web-push.ts:461-495`、`packages/persistence-sqlite/src/migrations/0093_web_push_gate.sql:15-19`

**问题**：闸门先读规则、再异步写延后：

```ts
const rules = await this.#options.readPushRules();
decision = (this.#options.gate ?? DEFAULT_GATE).decide({ ... });
...
stored = await store.deferItem({
  ...,
  deferUntil: decision.until,
  ...
});
```

如果在这两步之间主人撤销了规则，数据库触发器会清空当时已经存在的 `defer_until`；但这条尚未来得及写入的延后是在触发器之后写入的，于是会保留一个基于旧规则的 `defer_until`，最长可达 24 小时才重新判断。ADR/测试声称“撤销规则立即放出”，这个竞态下不成立。

**证据（我读到的代码）**：

```sql
CREATE TRIGGER rule_book_rules_release_push_update AFTER UPDATE ON rule_book_rules
BEGIN
  UPDATE web_push_outbox SET defer_until = NULL, defer_rule_refs = NULL
  WHERE owner_id = NEW.owner_id AND agent_id = NEW.agent_id AND defer_until IS NOT NULL;
END;
```

**建议**：给规则写操作维护一个代次/水位（例如每主人 `rules_changed_at` 或规则 revision 集合），`deferItem` 在同一个事务里核对“读规则时的代次仍等于当前代次”才写入；或者把“规则写入”和“闸门判断+延后写入”串行化。补一个并发时序的反向测试。

---

## 4. 低：决策记录/出站表的 `ruleRefs` 只记录“此刻命中”的规则，漏掉后来把 `until` 推后的规则

**文件:行**：`packages/application/src/services/web-push-gate.ts:85-99`

**问题**：扫描从当前分钟开始逐分钟找第一个不命中的时刻，但 `ruleRefs` 只取 `hitsAt(input.now)` 的结果：

```ts
const first = hitsAt(input.now);
if (first.length === 0) return DELIVER;
...
for (let at = base + MINUTE_MS; at <= limit; at += MINUTE_MS) {
  const candidate = new Date(at).toISOString();
  if (hitsAt(candidate).length === 0) { until = candidate; break; }
}
const refs = [...new Set(first.map(({ id, revision }) => ruleRef(id, revision)))]
  .sort()
  .slice(0, 16);
```

如果规则 A 现在命中、规则 B 在几小时后命中并把 `until` 推后，决策记录的 `ruleIds` 只有 A，没有 B。行为上仍会延后到正确时刻，但“依据”不完整，和 ADR “ruleIds 写让它延后的规则”不完全一致。

**建议**：记录扫描过程中所有实际影响延后的规则，或至少在找到最终 `until` 后，把决定该时刻的规则集合写进 `ruleRefs`。

---

## 5. 低：自动检查有反向用例，但覆盖仍有缺口

**文件:行**：`packages/persistence-sqlite/test/web-push-gate-migration.contract.test.ts:76-92`、`test/integration/production-web-push.test.ts:226`、`packages/application/test/rule-type-push-quiet-hours.unit.test.ts:143-153`

**问题**：
- 迁移契约测试只断言了 `decision_ledger`、`decision_signals`、`decision_prereviews` 三张表的行数，另外五张被重建的表没有逐表验证数据保留；也没有断言 `rule_book_rules` 上的三个释放触发器仍然存在。
- 生产里真正执行“不可读静默规则 → 整类放行”的 `service-main.ts:2392-2393` 没有端到端测试。集成测试的规则读取器自己实现，只调用 `enforceableOwnerRule`，没有调用 `unreadablePushRule`：

```ts
read: async () =>
  (await repository.ownerRules().list({ ...scope, includeRetired: false })).flatMap((row) => {
    const rule = enforceableOwnerRule(row);
    return rule?.gate === "push_delivery" ? [rule] : [];
  }),
```

- 问题 1 里的范围一次性词没有任何反向测试。

**证据（我读到的代码）**：

```ts
expect(database.prepare("SELECT count(*) FROM decision_ledger").pluck().get()).toBe(1);
expect(database.prepare("SELECT count(*) FROM decision_signals").pluck().get()).toBe(1);
expect(database.prepare("SELECT count(*) FROM decision_prereviews").pluck().get()).toBe(1);
```

**建议**：迁移测试对八张表逐表插入并比对数据，断言三个释放触发器；增加一条通过真实 `readPushRules` 的端到端反向用例；补问题 1 的范围词用例。核心反向用例本身是有效的：闸门坏规则返回 `deliver+failed`、迁移拒绝 `web_push/sent`、无规则立即发、审批不延后、决策写失败回滚后照发、规则读取失败照发，这些断言都会在行为回退时失败。

---

## 6. 低（资源）：全时段静默规则会让每个 tick 做 1440 次逐分钟判断

**文件:行**：`packages/application/src/services/web-push-gate.ts:87-96`、`apps/agent-service/src/production-web-push.ts:22`、`231-234`

**问题**：规则允许覆盖全天（测试里就有 `00:00-23:59` + `23:59-00:00`），此时每次有到期推送的 tick 都会从当前分钟扫到 24 小时后，最多 1440 次 `hitsAt`。每个 tick 每类推送读取一次规则（已做同轮缓存），但每次仍会乘上规则条数；主人规则上限 32 条时约 4.6 万次表达式求值/类/tick，默认 10 秒一次。数值有界，不是正确性错误，但属于可避免的 CPU 开销。

**建议**：按规则时段直接算出下一个边界，而不是逐分钟扫描；或缓存“当前时段结束时刻”，规则或时区变化时失效。

---

# 二、推测 / 未核实

- **时区配置未核实**：闸门使用 `this.#options.timeZone ?? "UTC"`（`production-web-push.ts:465`），生产值来自 `configuration.runPolicy?.timeZone`（`service-main.ts:2382-2384`），而 `runPolicy.timeZone` 在配置类型里是可选的。仓库里的生产形态模板写了 `"timeZone": "Asia/Shanghai"`，但真实生产配置是否一定设置、是否与主人所在时区一致，未核实。若没设，静默时段会按 UTC 错位。
- **`npm run check` 只有 onnx 类型错误失败、集成测试通过**：未核实（本轮不能运行命令）。
- **`prompt-manifest.json` 的新 sha256 是否正确**：未核实（不能计算）。
- **迁移 0093 是否完整保留八张表的所有索引/触发器**：已逐段对照 0089/0091 与 0093，重建定义看起来一致（新增 `web_push` 种类与结果）；除契约测试覆盖的三张表外，其余表的数据保留只是阅读比对，未实际运行验证。
- **规则是否被注入模型请求头**：只查到 `rule_book` 通过 MCP 读取工具对外提供（`production-mcp-read.ts:963-973`），没有查到规则总结进入系统提示的路径；未穷尽核实。
- **作者说“所有老对话第一轮请求开头变一次”**：从工具参数结构变化看是成立的（见必答问题 1），但没有实际执行/记录老对话换新的证据，未核实。

---

# 三、侧重检查

我重点查了错误路径、不可信输入、资源、不可撤销操作和文档一致性，结论如下。

1. **该发的推送会不会发不出去**
   - 审批、Muse 告警、未知来源在读取规则之前就直接放行：`production-web-push.ts:453-457`。不会因为规则错误而延后审批。
   - 规则读取失败、闸门判断失败、`deferItem` 抛错都回落为“照发 + `onGateFailure`”：`production-web-push.ts:461-500`。反向集成用例覆盖了决策写入失败回滚后照发、规则库读取失败照发。
   - 未发现会让受保护类别进入延后路径的写法。

2. **延后到点后会不会重复、漏发、过期被吞、永远延后**
   - `listDue` 只在 `defer_until IS NULL OR defer_until <= now` 时取出（`sqlite-web-push-operations.ts:336`），到点后重新过闸门；同一 tick 内同一 `sourceKey` 用 `gated` 缓存，不会重复写延后或重复发。
   - 有效期延长为 `min(max(原 expiresAt, until+1h), createdAt+48h)`（`production-web-push.ts:478-484`），存在总寿命硬上限，因此不会“永远延后”；代价是入队已久且全时段静默的推送会在 48 小时内过期不再发，这一点 ADR 已明说是有意的。
   - 发现一个窄竞态：撤销规则和正在写入的延后交错时可能仍被扣住到 `until`（问题 3）。

3. **迁移 0093 会不会丢数据/触发器/外键**
   - 迁移包在事务里执行（`migration-engine.ts:981`），失败可回滚。
   - 重建顺序先保留副本、再按依赖顺序删表、按 `decision_ledger → 依赖表` 顺序重建，`decision_prereviews` 的两个不许改触发器原样重建（`0093:323-337`），`decision_signals` 的两个触发器也重建（`0093:200-207`）；外键在 `foreign_key_check` 用例里检查为 `[]`。
   - 与 0089 的定义逐段比对，除新增 `web_push` 种类/结果外一致。契约测试只覆盖三张表的行保留，其余五张表的保留属于阅读比对，未运行验证。

4. **不可信输入/安全**
   - 参数长度有限制：`periods` 1-8、`days` 1-7、`classes` 1-3、`ruleRefs` 1-16 且不许重复、时钟 HH:MM、`days` 0-6；SQL 全部参数化。
   - `classes` 的枚举不含审批/Muse/未知，闸门对这三个类别另有硬保护。
   - 未发现可注入 SQL、路径或日志的输入路径。
   - `sendTest` 绕过闸门，符合 ADR 决定 10；浏览器推送只有 `#send` 和 `sendTest` 两个发送点（`production-web-push.ts:263`、`644`），没有发现第三条绕过闸门的发送路径。

5. **资源耗尽**
   - 全时段规则会导致逐分钟 24 小时扫描（问题 6），有界但可优化。
   - 延后记录的编号由 `owner/agent/sourceKey/deferUntil` 算出，同一延后重复写只留一条，不会无限增长；出站条目受 48 小时寿命和 7 天清理限制。

6. **不可撤销操作**
   - 迁移 0093 重建八张表属于高风险操作，但被事务包裹，且先复制再删；在 P4-1 迁移合并顺序上作者已声明本轮不评，我未评。

7. **文档和代码一致性**
   - ADR 0242 决定 5/后果说“工具定义变了，老对话按 ADR 0165 重建一次”：从 `ownerRuleToolDescriptors` 的参数结构确实新增了 `type` 枚举值和 `periods/classes` 字段，属于规则文件第 6 条允许“工具集合变了（参数结构）”的换新条件，代码与文档一致。
   - 但第 4 轮本身对 `tools.ts` 只改了说明文字；纯文字改动按规则第 6 条只对新对话生效，不会自动让老对话重建。若把“第 4 轮文字改动”也说成会让老对话换新，则说法不准确。
   - ADR 0242 决定 7“读不懂的静默规则不会悄悄当成没有这条规则”与 `unreadablePushRule` 的子串启发式不完全一致（问题 2）。
   - ADR 0242 决定 6“改、停、删任何规则会清空延后，下一轮重新判断”与撤销竞态不完全一致（问题 3）。

---

# 四、必答问题

## 1. 会不会改变模型已经见过的请求开头？发给模型的内容是否仍然只在末尾追加？每轮会变的值是否都在最后一条消息里？

**回答**：
- **会改变，而且不是只在末尾追加。** 这次改动改了 `rule_set` 的工具定义：`tools.ts` 的说明文字变化，同时 `production-owner-rules.ts:240-277` 的 `type` 枚举新增了 `push_quiet_hours`，`params` 新增了 `periods`、`classes` 结构。工具定义位于请求最前面，所以：
  - 新对话从第一轮起就是新工具定义；
  - 老对话在升级后第一次运行开始时，因为工具参数结构发生变化，会触发一次按对话换新（规则文件第 6 条允许的例外），请求开头会变一次。ADR 0242 已记录，Andy 已同意。
- **单看第 4 轮的增量**：`tools.ts` 只改了说明文字（补“push_quiet_hours 没有回放，replay 为空”），没有改参数结构。纯文字改动按 `prompt-prefix.md` 第 6 条**只对新对话生效**，不会让老对话的请求开头变化；老对话要拿到这段新文字必须手动 `thread prompt rebuild`。如果作者认为第 4 轮文字改动也会自动重建老对话缓存，这个说法不对。
- **每轮会变的值**：本 PR 没有把时间、时区、`until`、推送分类等每轮变化的值放进系统提示或工具定义。闸门的 `now`、`timeZone`、`until` 只用于数据库查询和出站表；`rule_set` 工具文字是静态的。未发现新的“每轮变化值进入请求头”的路径。
- 依据：`prompt-prefix.md:28`（每轮会变的内容只放最后一条用户消息）、`:35`（已发内容只能追加，换新是例外）、`:41`（工具参数结构变化可换新，纯文字改动只对新对话生效）。

## 2. 会不会让同一段文字在不同请求里变成不同的字节？

**回答**：**在本 PR 新增的模型可见内容里，没有发现新的不确定性。**
- `ruleRefs` 先 `Set` 去重再 `.sort()`（`web-push-gate.ts:97-99`）；`classes` 按 `PUSH_QUIET_CLASSES` 固定顺序过滤，`days` 排序去重，`periods` 排序（`rule-types.ts` 的 `parsePushQuiet`）。
- 时区格式器按 `timeZone` 缓存（`proactive-rules.ts:169-186`），同一时区输出稳定。
- `until` 依赖 `now`，但只写入 `web_push_outbox`/`decision_ledger`，不进入发给模型的文字。
- 唯一的小瑕疵是 `periods` 的排序比较器在 JSON 完全相等时返回 `1` 而不是 `0`，但相同元素的序列化字节也相同，未观察到可影响模型请求的差异。
- 遮盖逻辑本 PR 未改；未发现依赖前后文的遮盖变化。

## 3. 有没有对应的自动检查？反向用例是否真的会失败？

**回答**：**有，核心反向用例是真的**，但我没有运行，只是阅读断言；以下“会失败”指行为回退时断言会失败。
- `web-push-gate.unit.test.ts`：坏规则必须 `deliver + failed`，类别不匹配必须立即发。
- `rule-type-push-quiet-hours.unit.test.ts`：非法时段、非法星期、把审批写进 `classes`、未知键、超长 `days/classes` 都必须拒绝；`unreadablePushRule` 的正反例。
- `web-push-gate-migration.contract.test.ts`：`web_push` 只接受 `deferred`，其他结果和其他种类配 `deferred` 必须被 CHECK 拒绝；重建后三张表的行和两个不可改触发器仍在。
- `production-web-push.test.ts`：无规则立即发、审批不延后、决策记录写入失败回滚后照发、规则库读取失败照发、撤销规则放出、延后期间新订阅设备、到点提醒默认不延后。
- 缺口：不可读静默规则经过生产 `readPushRules` 的端到端路径没有测试；迁移只验证三张表；问题 1 的范围一次性词没有反向用例；问题 3 的竞态没有测试。这些缺口意味着上述问题在现有测试下不会被抓住。

## 4. 改动产生或修改的每个值，使用它的地方都能接受吗？

**回答**：逐个核对如下。
- **新决策种类 `web_push`**：已加入 `DECISION_KINDS`、`DECISION_OUTCOMES`、数据库 CHECK、`gateway-contracts` 决策种类枚举、数据导出 schema、每日复盘排除、评价池排除、校准分组返回 `null`、三种语言的 `decision.chain.kind` / `weekly.check.rowsMissing`。使用方都能接受；校准不会把它分组，评价池不会列出，数据导出可往返。
- **新结果 `deferred`**：`web_push` 只允许 `deferred`，`deferItem` 写的正是 `deferred`；`readCalibrationRows` 会读到但 `calibrationGroup` 返回 `null`，`summarizeImplicit` 只统计 `proactive`，不会误算。
- **新规则种类 `push_quiet_hours`**：已加入 `RULE_KINDS`/`OWNER_RULE_KINDS`、数据导出 `STORED_KINDS`/`KIND_LABELS`、网关规则种类枚举、三种语言的规则文案、`field-catalog` 的 `push_delivery`。外部 MCP 写入仍只允许两种邮件规则（`production-mcp-rule-writer.ts:16`），这是有意的限制，不是遗漏。
- **`defer_until` / `defer_rule_refs`**：`deferItem` 校验规范 ISO 时间、`ruleRefs` 长度 1-16 且不重复；`listDue` 用同格式 ISO 字符串比较；迁移 CHECK 限制长度 24 和 JSON 数组；触发器清空两列。两端校验匹配。数据导出/导入不包含 `web_push_outbox`，所以恢复备份不会保留延后状态（出站表是瞬态数据，这是否有意未核实）。
- **决策记录编号 `web-push-${digest}`**：长度 73，符合 `decision_ledger.id` 1-128；`subject_ref` 来自 `sourceKey`（入队时限制 ≤256），符合列 CHECK。
- **`ruleRefs` 完整性**：见问题 4，只记录初始命中的规则，使用方（决策依据抽屉）会少显示规则，但不会报错。
- **数据导出文字**：`pushQuietWording` 在 `classes` 省略（使用默认两类）时输出“推送类别 ”为空（`data-export/rules.ts:172-175`），只是文案瑕疵，不影响导入校验。

---

**总体判断**：功能主路径和关键反向用例设计是扎实的，审批/告警硬保护、失败照发、事务回滚、48 小时寿命都有代码和测试支撑。最需要改的是问题 1（范围一次性词导致误立长期规则）和问题 2（不可读规则判定不可靠）；问题 3 是窄竞态，也建议在合并前处理。
