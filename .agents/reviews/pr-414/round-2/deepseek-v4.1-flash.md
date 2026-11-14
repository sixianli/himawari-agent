（工具已按指示停止，以下结论只基于已读代码；我没有运行测试，凡“通过/失败”均标未核实。）

# 结论

没有发现高危问题。闸门与延后的主路径、事务、迁移重建、新种类在新旧消费者之间的对接基本正确；主要问题集中在**一句话立规则的误判**、**提示词自相矛盾**、**损坏规则静默失效不告警**，以及几处小资源/文档不一致。

## 一、读代码证实的问题（按严重度）

### 1. 中：常见一次性说法会被当成长期规则，可能不经确认就生效
- 文件:行：`apps/agent-service/src/production-owner-rules.ts:79-92`、`:94-127`、`:341-360`、`:691-693`
- 问题：新增的 `别提醒我/别通知我/别打扰我/don't remind me/do not disturb me/通知しないで` 等是命令句，本身不表示“长期”；而 `ONE_OFF_MARKERS` 只覆盖“今天/今晚/这次/这封/刚才/tonight/this time”等，没有“现在、正在、一会儿、今夜、今晩、now、right now”等。按 `containsMarker` + `isStandingQuote` 的实现，“现在别提醒我”“今夜は通知しないで”“do not disturb me now”“我在开会别打扰我”都会返回 `true`；`create` 里 `explicit = !inferred && isStandingQuote(quote) && ownerSaid(...)`，一旦模型给出合法 `periods` 就会直接激活，不需要主人再确认。
- 证据：
  - `STANDING_MARKERS` 含 `"别提醒我", "不要提醒我", "别通知我", ..., "don't remind me", "do not disturb me"`（`production-owner-rules.ts:79-92`）
  - `ONE_OFF_MARKERS` 只有 `"这封","这次","今晚","今天","刚才",...,"tonight","this time"`（同文件 `94-127`），没有“现在/今夜/今晩/now”
  - `isStandingQuote` 只要某分句“有 STANDING_MARKER 且无 ONE_OFF_MARKER”即为真（同文件 `348-360`）
  - `explicit` 为真时走 `#activate`（同文件 `691-693`）
- 建议：给 `ONE_OFF_MARKERS` 补“现在/正在/一会儿/等会儿/待会儿/先/今夜/今晩/now/right now/for now/in a meeting/开会中”等；更稳的做法是对 `push_quiet_hours` 要求引文里出现明确的时段表达，否则一律只生成 `proposed`，必须主人点头。

### 2. 中：`rule_set` 工具说明与新的“别提醒我”判定自相矛盾
- 文件:行：`packages/prompt-catalog/src/tools.ts:231`；配套代码 `apps/agent-service/src/production-owner-rules.ts:348-360`、`:369-379`、`:691-693`
- 问题：同一段工具说明里，前句仍要求“quote … 要包含‘以后’‘一律’‘必须’这类表示一直有效的字样”，后句却用 `push_quiet_hours` 的例子“夜里别提醒我”，而这句话不含上述任何字样。模型若照前句把“以后”塞进 quote，`quotesWholeClauses`/`#ownerSaid` 会认为不是主人原话的完整分句，`explicit` 变假，只能生成提议；若严格照抄“夜里别提醒我”，又违背前句。结果是“一句话立规则”可能时好时坏。
- 证据：
  - `quote ... 要包含“以后”“一律”“必须”这类表示一直有效的字样；`（`tools.ts:231` 同一条字符串）
  - `push_quiet_hours 是静默时段里指定类别的推送先不发、等时段结束再发（例如“夜里别提醒我”）；`（同一字符串）
  - `quotesWholeClauses` 要求和主人原话的分句逐字一致（`production-owner-rules.ts:369-379`）
- 建议：把“要包含‘以后/一律/必须’”改成“要包含表示长期有效的字样，例如‘以后/一律/必须’，或明确的无期限要求（如‘夜里别提醒我’）”，并与 `STANDING_MARKERS` 保持一致。

### 3. 中：已存的 push 规则解析失败时会被静默丢掉，不触发 `onGateFailure`
- 文件:行：`apps/agent-service/src/service-main.ts:2384-2394`；`packages/application/src/rules/rule-types.ts:420-430`；`apps/agent-service/src/production-web-push.ts:458-470`
- 问题：ADR 0242 第 7 条承诺“判断器或规则读取出错，推送照发，并报一次告警”。但 `readPushRules` 用 `flatMap` 调 `enforceableOwnerRule`，后者把 `RuleTypeError` 吞掉返回 `undefined`，于是“规则存在但读不懂”会被当作“没有这条规则”，闸门直接放行，`onGateFailure` 根本不会调用。用户以为夜里静默已生效，实际不会延后，也没有告警。ADR 的原文与代码不一致。
- 证据：
  - `).flatMap((row) => { const rule = enforceableOwnerRule(row); return rule?.gate === "push_delivery" ? [rule] : []; })`（`service-main.ts:2391-2394`）
  - `export function enforceableOwnerRule(...) { if (row.status === "retired") return undefined; try { return ownerRuleRecord(row, registry); } catch (error) { if (error instanceof RuleTypeError) return undefined; throw error; } }`（`rule-types.ts:420-430`）
  - `#deferred` 里只有 `readPushRules()` 抛异常或 `decide` 抛异常才会进入 `failed`（`production-web-push.ts:459-470`）
- 建议：在 `readPushRules` 这一层区分“没有规则”和“有规则但读不懂”；对读不懂的 `push_delivery` 规则抛出（或显式回报），让 `#deferred` 走 `DELIVER_FAILED` 并告警。

### 4. 低：`onGateFailure` 不是“报一次”，而是每个来源键一次
- 文件:行：`apps/agent-service/src/production-web-push.ts:473-476`、`:485-499`
- 问题：一次闸门读取/判断失败会被该类所有 `sourceKey` 各报一次（一 tick 最多 50 条）；`deferItem` 失败同理每个来源键各报一次。ADR 写的是“报一次告警”，实际是每来源一次。对一台设备多订阅的情况 `gated` 已去重，但仍会按推送条目放大。
- 证据：`if (decision.action === "deliver") { if (decision.failed) this.#options.onGateFailure?.({ sourceKey: item.sourceKey }); ... }`；`catch { this.#options.onGateFailure?.({ sourceKey: item.sourceKey }); }`
- 建议：按“本轮 + pushClass（或失败原因）”去重后再告警，或明确文档说“每个推送来源一条”。

### 5. 低：默认类别不含 `scheduled_reminder`，与“夜里别提醒我”的直觉不符
- 文件:行：`packages/application/src/rules/rule-types.ts:46-49`；ADR `docs/adr/0242-hard-rules-step4-unified-push-gate.md:52`；工具说明 `packages/prompt-catalog/src/tools.ts:231`
- 问题：主人说“夜里别提醒我”，默认只延后任务结果和邮件提醒；主人自己定的到点提醒会照常响，除非模型额外加上主人没点名的 `scheduled_reminder`。代码与 ADR/工具说明一致，不算实现错误，但很容易造成“我说了别提醒，夜里还是响了”的用户体验问题。
- 证据：`PUSH_QUIET_DEFAULT_CLASSES = ["mail_reminder", "run_result"]`；ADR 第 52 条“默认管任务完成或失败、邮件提醒；主人明说‘包括我自己定的提醒’才含到点提醒”。
- 建议：如产品预期是“夜里别提醒我”覆盖到点提醒，请改默认并在工具说明里写清；否则至少在确认提示里明确“你自己的到点提醒仍会响”。

### 6. 低：服务端没有给 `days`/`classes` 数组设长度上限，闸门逐分钟扫描也偏重
- 文件:行：`packages/application/src/rules/rule-types.ts:223-286`；`packages/application/src/services/web-push-gate.ts:84-91`
- 问题：`parsePushQuiet` 检查了 `periods` 1..8，但每个 `days` 数组和原始 `classes` 数组没有长度上限（只有工具 JSON Schema 的 `maxItems`）。绕过工具 schema 的直接调用或异常模型输出可以传入很长的数组，`new Set(days).sort()` 会做无谓的工作。另外 `PushGate.decide` 最多按分钟扫描 1440 次，每次对全部规则跑 CEL；每个新到期的同类别推送都会触发一次完整扫描。
- 证据：`days.every((day) => Number.isInteger(day) && day >= 0 && day <= 6)` 只做逐项校验，没有 `days.length` 上限；`for (let at = base + MINUTE_MS; at <= limit; at += MINUTE_MS)` 内每次调 `hitsAt`。
- 建议：在解析层补 `days` 长度上限（≤7）和 `classes` 长度上限（≤3），并优先用时段边界直接算静默结束时刻，避免逐分钟扫描。

### 7. 低：ADR 关于多实例与“每次延后一条记录”的说法与实现不完全一致
- 文件:行：`docs/adr/0242-hard-rules-step4-unified-push-gate.md:90`；`packages/persistence-sqlite/src/sqlite-web-push-operations.ts:412-414`、`:433`、`sqlite-decision-ledger-operations.ts:133`
- 问题：ADR 说“两个实例同时判断同一条推送时可能各写一条延后记录”。但决策记录 id 由 `(owner, agent, sourceKey, deferUntil)` 的 SHA-256 决定，且 `insertLedgerRow` 是 `ON CONFLICT (id) DO NOTHING`；两个实例即使在不同分钟算出的 `until` 通常也相同，因此只会有一条记录。反过来，`ON CONFLICT DO NOTHING` 也意味着“写不进就整体回滚”并不是所有写入失败情形都成立（id 冲突时静默跳过，事务照常提交）。
- 证据：`digest = sha256(JSON.stringify([ownerId, agentId, sourceKey, deferUntil]))`；`INSERT INTO decision_ledger (...) VALUES (...) ON CONFLICT (id) DO NOTHING`。
- 建议：修正 ADR 的描述；若希望 id 冲突也视为失败并回滚，需要把 `DO NOTHING` 改成显式检查，或说明 id 冲突等价于“这条延后已有记录”。

### 8. 低：设计文档只更新了“记忆提醒”的有效期，任务结果未同步
- 文件:行：`docs/execution/specs/2026-10-26-web-push-design.md:109`（表格后续行）
- 问题：延后延长有效期适用于所有可延后的类别（含 `run_result` / `mail_reminder`），但设计文档只给“记忆提醒”那一行加了说明，任务结束那一行仍写“24 小时”。ADR 是总说明，但设计表本身会误导后续维护者。
- 建议：在任务结果/邮件提醒行补同样的“延后时延长、总寿命 48 小时”说明，或统一指向 ADR 0242。

## 二、推测 / 未核实

- 作者说“`npm run check` 只有已有的 onnx typecheck 失败”“集成测试、迁移契约测试、规则类型和闸门单测都通过”。我**没有运行任何命令**，这些**全部未核实**；工具已停用。
- 第 1 条误判的实际危害取决于模型是否真的会在这些一次性语境下调用 `rule_set` 并自行给出合法 `periods`。代码层面“会被判为长期规则”是确定的；是否真会激活取决于模型行为，属推测。
- “两个实例同时发会导致重复推送”是单实例假设下的既有风险，ADR 第 90 行已声明只跑一个实例；未核实生产部署是否严格单实例。
- 生产 `readPushRules` 的实际接线（`pushRepository.ownerRules().list` 返回的 `StoredOwnerRule` 与 `enforceableOwnerRule` 的兼容、`pushRepository` 初始化顺序）只做了静态阅读，未运行验证。

# 侧重检查（错误路径、不可信输入、安全、资源、不可逆操作、文档一致性）

- **错误路径**：
  - `readPushRules` 抛异常、`decide` 抛异常 → 放行并告警（代码正确，`production-web-push.ts:459-470`）。
  - `deferItem` 抛异常 → 事务回滚、放行、告警（`production-web-push.ts:485-499`；集成测试有反向用例）。
  - 规则存在但解析失败 → **静默丢弃且不告警**（见问题 3，是本次发现的主要错误路径缺口）。
  - 延后到期前内容失效（提醒被删/改时间、邮件洞察失效）→ 记 `expired`，不发；符合现有内容校验逻辑。
  - 延后超过总寿命 → 到期记 `expired` 不发送；ADR 有意为之。
- **不可信/不合规范输入**：
  - `deferItem` 校验 `now/deferUntil/expiresAt` 为规范 ISO、refs 1..16 且不重复、长度 ≤256（`sqlite-web-push-operations.ts:400-410`）。
  - 闸门产生 refs 时 `ruleRef` 最长 250、`slice(0,16)`，与端口 1..16/≤256 两端匹配。
  - `parsePushQuiet` 校验对象键、periods 1..8、days 整数 0..6、HH:MM、start≠end、classes 枚举；`days` 长度未在服务端封顶（见问题 6）。
  - 没有任何新字段把外部输入拼进 CEL 表达式：表达式由校验后的 `classes` 和 `periods` 生成，未发现注入面。
- **安全**：
  - 决策记录 `subjectRef` 是来源键（`reminder:<id>:<time>`、`run:<id>`、`proactive:<id>`），`memoryIds` 为空，不含正文；`reasonCode` 固定 `push_quiet_hours`。未发现把敏感内容写进账本。
  - `onGateFailure` 只带 `sourceKey`，不含正文。
  - `sendTest` 绕过闸门，符合“主人自己点的立刻收到”。
  - 审批、Muse 告警、`unknown` 由代码直接放行：`PUSH_RULE_PROTECTED_CLASSES` 与 `pushClassOf` 双重保证；反向单测覆盖。
- **资源耗尽**：
  - `PushGate.decide` 逐分钟扫描最多 1440 次 × 规则数，每个新到期类别一次；有上限但偏重（见问题 6）。
  - 每次延后写一条 `decision_ledger`；同一来源键同一 `until` 因复合 id 只留一条；规则频繁变动会清空延后并重新判断，但写库量受推送条目数约束。
  - `deferItem` 用 `BEGIN IMMEDIATE`，冲突时会阻塞；失败按设计放行。
- **不可逆操作**：
  - 本改动没有删除/覆盖用户数据的不可逆路径；迁移 0093 先 `CREATE TABLE ..._keep AS SELECT *` 再删除重建。撤销规则会清空延后并立即放行，符合预期。
- **规则/文档/代码一致性**：
  - 一致：闸门位置（逻辑在 `#deferred`，由 `#deliver` 调用）、审批/Muse/unknown 放行、`defer_until`/`defer_rule_refs`、24h/1h/48h、同事务、daily-review 与校准排除、`sendTest` 不走闸门、迁移三个触发器、`SUPPORTED_SCHEMA_MAX=93`。
  - 不一致：ADR 第 7 条“规则读取出错也告警”与损坏规则被 `enforceableOwnerRule` 静默吞掉（问题 3）；ADR 第 53 条“今晚/这次/这封之类只算提议”与实际缺“现在/今夜/今晩/now”等一次性词（问题 1）；工具说明内部自相矛盾（问题 2）；ADR 第 90 行多实例记录条数（问题 7）；设计文档任务结果行未同步（问题 8）。
  - 另外，校准报表的 `THRESHOLD_SQL.kindCounts` 会把 `web_push` 计入“未登记门槛的决策类别”，与 `rule_review` 等现有项一样只是报表噪声，不破坏功能；`calibrationGroup` 返回 `null`，确实不进校准分组。

# 逐条回答必答问题

### 1. 会不会改变模型已经见过的请求开头？是否仍然只在末尾追加？
**会改变一次，但不是每轮变化。**
- 本次确实改了 `rule_set` 的**参数结构**（新增 `params.periods`、`params.classes`，并在 `type` 枚举里加了 `push_quiet_hours`），见 `apps/agent-service/src/production-owner-rules.ts:183-228`、`packages/prompt-catalog/src/tools.ts:231`、`prompt-manifest.json`。
- 冻结逻辑会检测到结构变化并换新一次：`thread-prompt-bundle-service.ts:152-157` 的 `toolSchemaChanged` 比较 `schemaStructure`（会保留 `properties`/`enum`/`required`，只去掉 `title/description/examples/$comment`），`#current` 在 `196-207` 把 `origin` 置为 `tool_schema_changed` 并重建；`promptBundleChange` 也按工具名/模型/推理强度/语言判断（`89-93`）。因此老对话下一次运行会整体换新一次开头，之后同一对话内继续沿用冻结字节。
- 这属于 [prompt-prefix.md 第 6 条](../../.claude/rules/prompt-prefix.md#stable)允许的“工具集合/参数结构变了就换新”，且 ADR 0242 第 40 行记录了 Andy 同意、`#traceInvalidated` 会写 `prompt.bundle.invalidated`。**所以严格说不是“只在末尾追加”**：老对话有一次前缀变化；新对话从头就是新前缀。除这次换新外，改动没有把时间、日期、版本号等每轮变化的值放进系统提示或工具定义；新增的会变值（延后时刻、规则引用、决策记录 id）都在数据库/账本里，不进入模型请求。
- `rule_set` 工具**结果**（试算例子）用的是规则自身的固定星期/时刻，不依赖当前时间；没有新增“每轮变化的值”进入最后一条消息之外的位置。
- 未核实：生产实际重建是否在预期轮次发生、是否留下 trace（我没跑服务）。

### 2. 同一段文字会不会在不同请求里变成不同字节？
**就本改动新增/修改的模型可见内容而言，没有发现新的不确定性。**
- 规则参数归一化：`parsePushQuiet` 对 `days` 去重排序、对 `periods` 按 `JSON.stringify` 排序、`classes` 按固定的 `PUSH_QUIET_CLASSES` 顺序过滤（`rule-types.ts:223-286`）。
- 闸门写账本：`ruleRefs` 先 `Set` 去重再 `sort()` 再 `slice(0,16)`（`web-push-gate.ts:92-95`），`deferItem` 再次 `sort()`（`sqlite-web-push-operations.ts:411`）；账本 id 是确定性的 SHA-256（`:412-414`）。
- 试算例子顺序由固定数组和已排序 periods 决定，不依赖对象遍历/数据库返回顺序。
- 没有新增出口遮盖逻辑，遮法不变；新增的 `push_quiet_hours` 只在服务端参与判断，不改变已发历史。
- 既有风险不算本改动引入：`rule_list` 按 `updated_at DESC, rule_id` 排序，可能随规则修改改变顺序；这不是本 PR 新增的模型输入。
- 未核实：迁移/导出里 `JSON.stringify` 的键顺序在极端旧数据下是否稳定；我只检查了本改动生成的路径。

### 3. 有没有对应的自动检查？反向用例是否真的会失败？
**有，覆盖面较好，但有几处缺口；测试是否通过未核实（我未运行）。**
- 已读到的反向/边界用例：
  - `packages/application/test/web-push-gate.unit.test.ts`：无匹配类别不延后、坏规则放行并 `failed:true`、受保护类别即使规则点名也放行、跨午夜/DST、24 小时上限。
  - `packages/application/test/rule-type-push-quiet-hours.unit.test.ts`：无 periods/start=end/坏时间/坏星期/`approval` 类别/未知键均拒绝；默认类别；跨午夜边界；审批/Muse/unknown 永不进规则。
  - `packages/persistence-sqlite/test/web-push-gate-migration.contract.test.ts`：重建后账本/信号/预评各保留一条、`foreign_key_check` 为空、两个不可改触发器仍在；`web_push` 只接受 `deferred`，其他 outcome 抛 CHECK。
  - `test/integration/production-web-push.test.ts`：无规则立即发、审批不延后、写账本失败时回滚且推送照发并告警、撤销规则立即放出、延后期间新订阅设备、规则读取失败照发并告警、同一轮同类只判断一次、到点提醒仅在点名时延后。
  - `packages/application/test/rule-version.unit.test.ts`：push 规则展示 periods；不可读 periods 标 `unavailable`。
  - `test/integration/data-export-rules.test.ts`：push 规则导出/导入往返。
- 缺口：
  - 没有“已存在但解析失败”的 push 规则的用例（问题 3），因此该静默失效不会被测试抓到。
  - 没有“现在别提醒我 / 今夜は通知しないで / do not disturb me now”这类一次性说法的反向用例（问题 1）；现有反向只覆盖“今晚/这次/提醒我”。
  - 没有“规则变更清空延后后、又延后到同一时刻”的重复 id / 账本陈旧用例（问题 7）。
  - 没有对 `onGateFailure` 调用次数的断言（问题 4）。
- 反向用例是否“真的会失败”：从代码路径看，坏规则、审批/Muse 点数、迁移 outcome CHECK、账本写入被 BEFORE INSERT 触发器阻断导致事务回滚，这些反向用例都作用在真实分支上，不是空转；但**未运行，不能确认全部通过**。

### 4. 新值逐个核对产生端与使用端
- `web_push`（决策种类）：
  - 产生：`sqlite-web-push-operations.ts:433-446`（`kind:"web_push"`、`outcome:"deferred"`、`reasonCode:"push_quiet_hours"`、`subjectRef:sourceKey`、`inputs.ruleIds`）。
  - 校验/接受：迁移 0093 `decision_ledger` CHECK（`kind IN (...) 'web_push'`、`(kind='web_push' AND outcome='deferred')`，`0093_web_push_gate.sql:49-104`）；`DECISION_KINDS`/`DECISION_OUTCOMES`（`ports/decision-ledger.ts:32-62`）；`insertLedgerRow` 的 `id` 1..128、`reason_code` 1..64、`subject_ref` 1..256、`inputs` 校验（`sqlite-decision-ledger-operations.ts:33-78`、`:120-168`）。
  - 下游接受：网关 `contracts-v2.ts:1102-1103`；数据导出 `data-export/schemas.ts:190-199`；每日打分排除（`daily-review.ts:45`、`:356`）；复核池排除（`sqlite-decision-ledger-operations.ts:520`）；校准 `calibrationGroup` 返回 `null`（`calibration/index.ts:288-290`）；控制中心三种语言都有 `web_push` 文案。
  - 结论：两端校验都能接受；未发现拒绝路径。
- `push_quiet_hours`（规则种类）：
  - 产生：`RULE_TYPES` 注册（`rule-types.ts:326-331`）、`STANDING_MARKERS` 触发 `rule_set`。
  - 接受：`RULE_KINDS`/`OWNER_RULE_KINDS`（`rule-version.ts:18-34`）、`ruleType`/`ownerRuleRecord` 解析、`field-catalog` 的 `push_delivery`、工具参数枚举（`production-owner-rules.ts:183-228`）、网关规则种类枚举（`contracts-v2.ts:1126-1127`）、数据导出 `STORED_KINDS`/标签/文案（`data-export/rules.ts:55-70`、`:198-211`）、控制中心 `rules.type`/`decision.chain.rule` 文案。
  - 结论：都能接受；`MCP` 外部提议仍只允许两种邮件规则（`production-mcp-rule-writer.ts:16`），这是有意的。
- `ruleId@revision`：
  - 产生：`web-push-gate.ts:92-95`，最多 16 条、每条 ≤250（`ruleRef` 限制 240+@+9）。
  - 接受：`deferItem` 要求 1..16、每条 1..256、无重复（`sqlite-web-push-operations.ts:404-410`）；`parseRuleRef` 能解析 `id@rev`（`rule-ref.ts:6-17`）；`readRuleVersions` 用历史表按 `revision` 查得到（`sqlite-decision-ledger-operations.ts:437-475`），而 `rule_book_history` 在 `create`/`setStatus` 时写入（`sqlite-owner-rule-operations.ts:104-115`、`:162`、`:193`）。
  - 注意：同一来源键、同一 `until` 的再次延后因 `ON CONFLICT DO NOTHING` 不会更新旧账本里的 `ruleIds`，可能显示旧修订号；属低危陈旧展示，不影响发送决策。
- `defer_until` / `defer_rule_refs`：
  - 产生/校验：迁移 CHECK `length=24`、`json_valid + json_type='array'`（`0093:1-5`）；`deferItem` 写规范 ISO 和排序后的 JSON 数组。
  - 使用：`listDue` 用字符串比较 `defer_until IS NULL OR defer_until <= ?`（`sqlite-web-push-operations.ts:335-338`），规范 UTC ISO 的字典序等于时间序；`enqueue` 是 `ON CONFLICT DO NOTHING`，不会每轮把延后清掉（`:271-289`）。
- `onGateFailure` 的 `sourceKey`：
  - 产生：来源键在 `#collect` 构造，长度 1..256，由 outbox CHECK 保证；不含正文。诊断写入 `web-push.gate-failed`（`service-main.ts:2395-2401`）。可接受。
- 迁移 0093：
  - `decision_ledger` 和七张依赖表按 0089/0091 的定义重建；`decision_prereviews` 先复制再删除，最后原样放回并重建两个不许改触发器（`0093:261-337`）。
  - 我核对了 0090/0091/0092：0090 只建 `memory_checkup_items`，0091 建 `decision_prereviews`/重建 `model_usage_observations`，0092 只建 `real_eval_*`，都没有改这八张表的列或触发器；因此 0093 按 0089 结构重建不会丢掉 0090–0092 的变更。
  - `INSERT ... SELECT` 的列清单与旧表一致；`foreign_key_check` 有契约测试；未发现丢数据或丢触发器。子表数据（`proactive_processed_messages`、`source_insights`、`muse_reference_entries`、`proactive_push_backoff`）在合约测试里没有实际插行验证，但定义与 0089 完全相同，**静态核对未发现丢数据**。
  - `rule_book_rules` 上的三个清空延后触发器存在，且只清 `defer_until/defer_rule_refs`；`AFTER INSERT/UPDATE/DELETE` 的 owner/agent 分别取 `NEW`/`OLD`，正确。

**总体建议按优先级**：先修问题 1（一次性误判）和问题 3（损坏规则静默失效），再修问题 2（工具说明自相矛盾）；其余是文档/告警次数/资源上限的整理项。
