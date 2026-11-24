## 本轮查过的范围

- 本轮以增量 `9664e0d..aeacadd` 为主：4 个文档文件（0230、0244、0257、0285、规格），以及 `.agents/reviews/pr-612/round-1/` 下的复核记录（未逐字读）。
- 对照代码读了：`rule-types.ts`、`web-push-gate.ts`、`production-web-push.ts`、`sqlite-web-push-operations.ts`、`ports/web-push.ts`、控制台 `web-push.ts`、`production-owner-rules.ts`、`action-rules.ts`、`context-external-content.ts`、`owner-scope-authorization.ts`、`production-task-proposals.ts`、`context-formation-service.ts`、迁移 `0001/0053/0058/0071/20261115004401`、`schema-catalog.ts`、`migration-engine.ts`、迁移契约测试、`check-prompt-prefix.mjs`、`prompt-prefix.md`、`zh-CN/en/ja` 三份文案、`rule-ids.frozen.json` 及其测试。
- 上一轮 16 条逐条对照增量：13、14、15、16 的字面修正已落实；5、6、7、9、11、12 的主体文字已补；1、2、3、4 的说明大幅补全；8 仍只是“记下来待定”。下面只报增量新引入或仍未闭合的问题。

---

### 1. 中：规格说“外部内容标记按一次运行记”，与代码实际按对话记不符

文件：`docs/execution/specs/2026-11-24-main-thread-subthreads-inbox-design.md:410-413`

问题：规格称“现在的标记按一次运行记……现在按运行记的做法不够，要改成子线程级别也记一份”。但代码在运行有对话时，键就是对话级的；后续轮次已经读得到。真正缺的是“新开的子线程继承父对话的标记”，不是“再记一份子线程级”。

证据（读代码证实）：
- `apps/agent-service/src/context-external-content.ts:101-105`：`externalContentKey` 在 `scope.threadId` 存在时返回 `...thread:${scope.threadId}`，不是按 run 编号。
- 同文件 `:161-169` 的 `#scopes` 第一项是 `{ threadId, runId }`；`mark` 在 `:193-196` 取 `const [scope] = await this.#scopes(runId)`，所以写入的是 `thread:<对话编号>`。
- `docs/adr/0257-...:…`（本轮 `git show` 读到的新值清单）明写：键 `context-external-content:thread:<对话编号>`，“同一对话的后续轮次都读得到，别的对话读不到”。

建议：把这段改成“标记已按对话记（没有对话时按运行记）；要补的是开子线程时把父对话的标记复制到新子线程”，并给“邮件叫起的子线程后续每次运行仍带标记”加反向测试。若确实要改 ADR 0257 决定 2，还应把决定 2 一并列入 `amends`，不能只列决定 3。

---

### 2. 中：把“她的话”加进安静时段类别会改 `rule_set` 工具定义，且漏了硬编码的 `maxItems: 3`

文件：`docs/execution/specs/2026-11-24-main-thread-subthreads-inbox-design.md:340`；`apps/agent-service/src/production-owner-rules.ts:331-336`；`packages/application/src/rules/rule-types.ts:47`

问题：`PUSH_QUIET_CLASSES` 同时是 `rule_set` 工具里 `classes` 的枚举来源，并且 `maxItems` 写死为 3。只把“她的话”加进 `PUSH_QUIET_CLASSES`、不改 `maxItems`，模型永远选不全四类；而枚举一变，所有对话冻结的 `rule_set` 工具定义就变了，与规格“工具不变，变的是规则”冲突（属于 `prompt-prefix.md` 第 6 条的换新条件）。

证据（读代码证实）：
- `production-owner-rules.ts:333`：`items: { type: "string", enum: [...PUSH_QUIET_CLASSES] },`
- 同文件 `:335`：`maxItems: 3,`
- `rule-types.ts:47`：`export const PUSH_QUIET_CLASSES = ["scheduled_reminder", "run_result", "mail_reminder"] as const;`

建议：把 `maxItems` 改成从 `PUSH_QUIET_CLASSES.length` 派生（或改为 4），并在分步上线里写明这一次会让所有对话的 `rule_set` 工具定义换新一次、需要重建记录。更好的做法是“她的话”不进 `PUSH_QUIET_CLASSES` 的模型可选项，而是由程序固定把它并入安静时段判断，避免改工具定义。

---

### 3. 中：收件箱和子线程的背压仍没有解决，只是写进了“还没核实”

文件：`docs/execution/specs/2026-11-24-main-thread-subthreads-inbox-design.md:599`（另见 `:147`、`:255`）

问题：上一轮第 8 条指出删掉排队上限、每日上限和子线程数量上限后没有替代背压。增量只加了一句“一次运行最多带几件还没定，编码第 1 步前问 Andy”，并没有定下任何上限或溢出策略；外部来源（例如几百封垃圾邮件）仍可把收件箱、上下文和工人时间撑爆。

证据（读代码/文档证实）：
- 规格 `:255`：“收件箱现有的排队上限、每天上限、排久了自动作废（`expired`）都去掉”。
- 规格 `:147`：“开几个没有上限，由她判断”。
- 规格 `:599`：“还没定……编码第 1 步前要定……要不要设，问 Andy”。

建议：在编码前定一个硬上限或溢出策略：一次运行最多合并 N 件、其余留到下一次；同一来源的准入上限；子线程并发上限。并加反向测试：一次灌入数百个外部事件，收件箱不丢事、单次运行上下文有界。不要只把问题留给“编码前问”。

---

### 4. 中：新增“她的话”推送种类漏列了类型联合、控制台种类表和账号开关的硬编码列

文件：`docs/execution/specs/2026-11-24-main-thread-subthreads-inbox-design.md:340`；`packages/application/src/ports/web-push.ts:5`；`apps/control-center/src/web-push.ts:6`；`packages/persistence-sqlite/src/sqlite-web-push-operations.ts:167-218`；`packages/persistence-sqlite/src/migrations/0058_web_push.sql:26`

问题：规格列出了 `PUSH_CLASSES`/`pushClassOf`、安静时段两套清单、`WEB_PUSH_KINDS`、写入校验、账号开关和数据库 `CHECK`，但没有列出 `WebPushKind` 联合类型、控制台自己的 `WEB_PUSH_KINDS`，以及账号开关代码里写死的三列。漏掉任一处，新种类要么编译不过，要么写入被拒，要么设置页看不到开关。另外，`web_push_outbox.kind` 的 `CHECK` 在 SQLite 里不能原地改，必须重建表（`web_push_attempts` 还外键指向它），规格只写“和数据库 `CHECK`”没有写这个代价。

证据（读代码证实）：
- `packages/application/src/ports/web-push.ts:5`：`export type WebPushKind = "reminder" | "approval" | "run";`
- `apps/control-center/src/web-push.ts:6`：`export const WEB_PUSH_KINDS = ["reminder", "approval", "run"] as const;`
- `sqlite-web-push-operations.ts:170-176` 只 SELECT 三列，`:185` 写死 `["notify_reminder", "notify_approval", "notify_run"]`，`:205-217` 只处理三个 kind。
- `0058_web_push.sql:26`：`kind TEXT NOT NULL CHECK (kind IN ('reminder', 'approval', 'run')),`

建议：把这些使用端和重建表写进新值清单；或者更省事：不新增 outbox `kind`，继续用 `kind = "reminder"`，只加一个新的 `source_key` 前缀和新的 `PushClass`，这样可避开 `WebPushKind`、账号开关列和 `CHECK` 重建，只需改分类与安静时段清单。

---

### 5. 低：迁移段落只提删 `think_inbox_queue`，删 `day` 列前还必须删 `think_inbox_day`

文件：`docs/execution/specs/2026-11-24-main-thread-subthreads-inbox-design.md:239`、`:243`；`packages/persistence-sqlite/src/migrations/20261115004401_think_inbox.sql:13,19-20`

问题：表格行写了“索引 `think_inbox_day` 和 `day` 一列 | 删”，但增量新增的迁移段落只说“先删掉旧索引 `think_inbox_queue`、再按新名建 `inbox_events_queue`”。SQLite 的 `ALTER TABLE ... DROP COLUMN` 在该列被索引引用时会失败，所以必须在删 `day` 之前显式删 `think_inbox_day`。

证据（读代码证实）：
- `20261115004401_think_inbox.sql:13`：`day TEXT NOT NULL CHECK (day GLOB '????-??-??'),`
- 同文件 `:20`：`CREATE INDEX think_inbox_day ON think_inbox (owner_id, agent_id, day, status);`

建议：把迁移段落改成“先删 `think_inbox_queue` 和 `think_inbox_day`，再删 `day` 列，然后改名并建 `inbox_events_queue`”，并在迁移契约测试里加一条索引名检查。

---

### 6. 低：作者说明漏了 ADR 0257 被 amend

文件：`docs/adr/0285-one-main-thread-subthreads-and-one-inbox.md:7`、`:61`；`docs/adr/0257-consequential-tool-calls-go-through-one-authorization-exit.md:7`

问题：本次材料说 ADR 0285“取代……修改 0230、0244”，但增量和当前 ADR 还修改了 0257（`amends` 与 `amended_by` 都加了）。作者的说法与仓库不一致。

证据（读代码证实）：
- `0285:7` 的 `amends` 已含 `...0257...`。
- `0257:7` 已有 `amended_by: ".../0285..."`。
- `0285:61` 正文也写了 0257 决定 3。

建议：更新 PR 说明，把 0257 列进去。

---

### 7. 低：把冻结规则改成“不再命中”没有说明同步它的例子和 `check:rule-registry`

文件：`docs/execution/specs/2026-11-24-main-thread-subthreads-inbox-design.md:405`；`packages/application/src/rules/action-rules.ts:244-254`；`test/tooling/rule-ids-frozen.test.ts:40-46`

问题：冻结编号必须保留，但如果把 `action_refuse_background_after_external_content` 的表达式改成永不命中，它现有的“该命中”例子就会让 `check:rule-registry` 失败；同时控制台仍会显示一条“不做”却永不生效的规则。规格只说“编号留着，规则改成不再命中”和改文案，没说要改例子、测试和这条规则在界面上的语义。

证据（读代码证实）：
- `action-rules.ts:248-250` 的表达式与 `outcome: "refuse"`。
- 同文件 `:255` 起的 `examples` 含 `example(true, ...)`。
- `rule-ids-frozen.test.ts:40-46` 只守编号，不守表达式；表达式改了要靠规则注册检查的例子。

建议：明确新表达式和新的“该命中/不该命中”例子，并加反向测试“后台读过外来内容后写操作现在弹卡片、不再被拒”；同时决定这条规则在设置页是隐藏还是标注为“已停用”。

---

### 8. 低：失败运行重试的修复没有对应的反向测试

文件：`docs/execution/specs/2026-11-24-main-thread-subthreads-inbox-design.md:270`（验收在 `:480-488`、`:490-509`）

问题：增量把“失败后用回同一 trigger”改成了“去重编号带上失败运行的编号，建新 trigger 和新运行”，方向对，但验收里没有一条“运行失败后重新取出同一批收件箱行，确实建了新 trigger、没有撞 `runs.trigger_id` 唯一约束、也没有重复运行”的反向用例。现有测试只覆盖“网络重发”和“服务中途重启”，不覆盖失败重试。

证据（读代码证实）：
- `0001_initial_product_schema.sql:147`：`trigger_id TEXT NOT NULL UNIQUE REFERENCES triggers(id) ON DELETE RESTRICT,`
- 规格 `:270` 已写明新做法，但第 2 步验收只写“同一条消息因网络重发两次，只回一次；运行到一半重启服务，消息不丢、不回两次”。

建议：加一条测试：让一次运行失败，重新投递同一批收件箱行，断言生成新 trigger/新运行、每行只被处理一次；再断言旧 trigger 没有被复用。

---

### 9. 低（推测）：已有 `push_quiet_hours` 规则若显式写了 `classes`，不会自动管到“她的话”

文件：`packages/application/src/rules/rule-types.ts:270-282`；规格 `:340`

问题：规格说“她的话”默认受安静时段管。默认值只在规则参数没写 `classes` 时生效；已有规则如果显式存了三个类别，加进 `PUSH_QUIET_DEFAULT_CLASSES` 不会改变它们，旧规则夜里仍可能推“她的话”。

证据（读代码证实）：`rule-types.ts:270-271`：`const rawClasses = record["classes"]; let classes = PUSH_QUIET_DEFAULT_CLASSES;`，只有 `rawClasses === undefined` 时才用默认。

建议：明确是否迁移已有规则，或在规格里写清“只对没写 `classes` 的规则和新规则默认生效”，并加一条测试。

---

## 侧重检查

- 错误路径：失败运行重试与 `runs.trigger_id UNIQUE`（第 8 条）；推送闸门 `unknown` 绕过安静时段（增量已正确描述，`production-web-push.ts:660-663`、`web-push-gate.ts:18-23` 核对一致）；迁移删列/改索引顺序（第 5 条）。
- 不合规范/不可信输入：外部事件和感知内容进主对话（增量“感知事件不带感知内容”与 `prompt-prefix.md:30,76` 一致，已核对）；来源编号/版本到 256 字符的拼接（增量已给出摘要方案，`0058:25`、`20261115004401:6-7` 核对一致）。
- 安全：外部内容标记是否随子线程走（第 1 条，实际已按对话记，缺的是继承）；同意卡片回答与 `external_event` 来源（增量已说明“你的”一类、标记保留，方向正确）；后台运行改成“问”后冻结规则编号与文案（第 7 条）。
- 资源耗尽：收件箱无排队/每日上限、子线程无数量上限（第 3 条，仍未闭合）；一次运行合并件数未定。
- 不可撤销操作：删除旧对话导致 `memory_records.source_thread_id` 置空、`memory_episodes` 级联删（`0001:401`、`0053:9` 核对一致）；推送 `CHECK` 改动要重建 `web_push_outbox`（第 4 条）。
- 规则/文档/代码一致：ADR 0285 的 `amends`/`amended_by` 双向已补（0230、0244、0257 都核对到）；`zh-CN/en/ja` 三份“不做”文案确实存在（`zh-CN.ts:882,884`、`en.ts:934,936`、`ja.ts:940,942`）；`check-prompt-prefix.mjs:8-11` 的 `[I-66]`、`REQUIRED` 核对一致。

---

## 必答问题

1. **请求开头会不会变。** 本轮增量只改文档，不改代码，所以不会直接改变任何已发出的请求。设计本身：外来事件、状态板、时间、编号都放在最后一条消息，感知内容只作为 `perception_read` 工具结果追加，和 `prompt-prefix.md:30` 一致。但有两处要盯：一是第 2 条，把“她的话”加进 `PUSH_QUIET_CLASSES` 会改 `rule_set` 工具定义，属于一次性的请求开头换新；二是旧设计里“每条消息各存一条、发给模型时合成最后一条用户消息”如果没有把合成后的那条存成历史，下一轮历史就会和上一轮实际发出的最后一条不同，违反 `prompt-prefix.md` 第 5 条“存实际发出去的那一条”。后者不是本轮增量新引入的，但增量没有把它闭合，建议编码前补明确。

2. **同一段文字会不会变成不同字节。** 增量新增的“按属于哪件大事、开的先后、子线程编号排”和固定时刻格式，方向正确；`source_key` 用截断加 SHA-256 摘要也是确定的。没有引入新的非确定来源。但摘要输入必须固定顺序和分隔符（来源种类、来源编号、版本三者的顺序要写死），否则同一件事可能算出不同字节；规格只说了“照 `context-external-content.ts:50-52` 的做法”，建议把输入格式写清。

3. **有没有自动检查、反向用例会不会真失败。** 增量补了 `[I-66]` 状态板逐字测试和 `REQUIRED` 递增（`check-prompt-prefix.mjs:8-11` 核对一致）、`[iOS-5]` 感知内容反向用例、推送安静时段与真实数据库插入测试、邮件叫起运行写日历弹卡片的反向用例。仍缺：失败运行重试的反向测试（第 8 条）；状态板乱序/换时间格式必须失败的反向用例；`rule_set` 四类 `maxItems` 的 schema 测试；迁移后 `think_inbox_day` 已删、索引名正确的契约检查（现有契约测试只比表名，`migration-engine.contract.test.ts:80`）。

4. **每个新值两端是否都接受。** 逐个核对：
   - `inbox_events` / `inbox_events_queue`：`schema-catalog.ts:800,814` 与 `migration-engine.contract.test.ts:80` 方向对；但 `day` 列的索引删除顺序要补（第 5 条）。
   - “她的话”推送类别/种类：`PUSH_CLASSES`、`pushClassOf`、`PUSH_QUIET_CLASSES`、`WEB_PUSH_KINDS`、`web_push_outbox.kind` CHECK 方向对；漏了 `WebPushKind` 联合、控制台 `WEB_PUSH_KINDS`、账号开关三列硬编码和 CHECK 重建（第 4 条），以及 `maxItems: 3`（第 2 条）。
   - `source_key` 256 字符：`0058:25` 与收件箱 `source_ref`/`source_version` 上限核对一致，摘要方案可行；需要写死输入顺序。
   - 外部内容标记：代码已是 `thread:<对话编号>`（`context-external-content.ts:101-105`、ADR 0257 新值清单），规格“按一次运行记”的说法错（第 1 条）。
   - 冻结规则编号：`rule-ids.frozen.json` 含 `action_refuse_background_after_external_content`，`rule-ids-frozen.test.ts` 只守编号；表达式/例子要同步（第 7 条）。
   - `runs.trigger_id` UNIQUE：`0001:147` 核对一致；重试设计方向对，缺测试（第 8 条）。
   - `memory_records.source_thread_id`、`memory_episodes.thread_id`：`0001:401`、`0053:9` 核对一致。
   - `triggers.source_type`：`0001:133` 只允许 `user_message/schedule/external_event`，设计用 `schedule` 合法。
