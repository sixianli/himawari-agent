# 代码复核：PR #283（Muse 提醒按 Gmail 邮件编号自动配对）

## 侧重检查（我走的流程）

我走了一条最普通的使用流程，逐段看它经过的代码：

1. **Muse 发批**：HTTP POST `/api/muse-intake/v1/batch`（production-muse-intake.ts）→ Bearer 鉴权 + 限流（admit，:442-455）→ `parseMuseBatch` 白名单字段（PROACTIVE_KEYS 新增 `gmail_message_id`:50）→ `text()` 校验 GMAIL_ID_PATTERN + ≤256（:233-239）→ 非法则整条拒收（:240-262，`rejected += 1`）。
2. **入库**：`store.ingestBatch` → port 层 `itemProblem` 长度校验（sqlite-muse-intake-operations.ts:81）→ INSERT 新列 + DB CHECK（:213, 0079 SQL）→ 同自然键 DO NOTHING、按 `content_digest` 分重复/冲突（:215-278）。
3. **评价**：网页“提醒”页 → `muse.overview.read`（production-muse-intake-control.ts:77-136，快照只挑固定字段，不含新字段）→ `muse.item.rate`（:146-165）→ store.rate 读条目的 `gmail_message_id` 写进 `muse_reference_entries.paired_message_id`（:447-481）。
4. **周报/对照**：`proactive.weekly.read`（production-observation.ts:191）与 CLI `report:calibration` 都走 `summarizeMuse`，按 `paired_message_id` 精确 join `proactive_processed_messages.message_id`（calibration index.ts:344-359, 293-312）。

**覆盖情况**：1、2、3、4 的正向和主要反向（编号非法、未带编号不配对）都有测试；走查中发现未覆盖的路径见第 2 条发现。

## 结论（按严重度排列）

**1. 中低 ｜ 仓库差异·sqlite-muse-intake-operations.ts:215,266-278 ｜ 编号进入摘要后，“先到为准”策略让配对无法补改，且同一自然键重发带编号会变成冲突**
- 证据（读代码证实）：
  - `production-muse-intake.ts:276`：`gmailMessageId` 进入 `parts` → `content_digest`（:300）。
  - `sqlite-muse-intake-operations.ts:215`：`ON CONFLICT (...) DO NOTHING`；:266-278：digest 相同记 duplicate，不同记 conflict，永不更新。
  - :197-202：同 batch_seq 重发直接判 replay，条目根本不进比较。
- 问题：条目一旦入库（没有编号，或编号错），之后 Muse 即便重发带上/修正编号，要么进冲突表、要么被重放挡掉，`gmail_message_id` 永远停留为初值。这正是"配对不要人工介入"场景下最需要写对的值，却被永久冻结。这符合 ADR 0162 既有的“同一自然键、内容不同进冲突表，不覆盖”，编号参与摘要会让这类重发多记一次 conflict（而非 duplicate）。
- 建议：至少在 runbook/ADR 写明“已收条目的编号不会补更：重发带编号的条目按冲突计”；若要支持补配对，需另出方案（例如 digest 排除该字段 + 允许仅更新该列），不要在本 PR 悄悄做。
- 区分：这是既有策略的推论（读代码证实），实际触发频率取决于 Muse 是否会在新批里重发旧条目（推测，无法从本仓库证实）。

**2. 低 ｜ test/* ｜ 测试缺口（读代码证实，grep 未找到对应用例）**
- 无 >256 字符编号的 HTTP 反例（GMAIL_ID_PATTERN 与 `text(..., 256)` 双层都有，但反向样本只有含空格/分号的一个：muse-intake-http.test.ts:319）。
- 0079 的 DB CHECK（长度 1–256）没有独立迁移级用例（0073 有 `decision-ledger-migration.contract.test.ts:344-351` 那种对照，0079 没有）。
- 同自然键重发、只变编号 → 冲突”的场景无覆盖（对应发现 1）。
- scheduled 条目带 `gmail_message_id` 会被计 dropped 字段而非拒收（SCHEDULED_KEYS 无此键，production-muse-intake.ts:52-64,117）——行为正确但无用例固定。另有 `muse.item.rate` 命令层（production-muse-intake-control.ts:146-165）未测新字段，风险低（不传该字段）。
- 建议：补一个 store 级用例：同 naturalKey 二次提交、只多带 gmailMessageId，断言 conflict；迁移级用例照 0073 模式补 CHECK 反例。

**3. 低 ｜ packages/persistence-sqlite/src/sqlite-muse-intake-operations.ts:37-39,81 ｜ 端口层与 DB 层都只查长度，不查字符集（读代码证实，无现实危害）**
- 证据：`nullableText` = 长度 1–256；0079 CHECK 同样只限长度。字符集（`[A-Za-z0-9_-]`）只在 HTTP 层强制。
- 问题：若未来出现绕过 HTTP 解析的 `MuseIntakePort` 写入路径（现在只有 `ProductionMuseIntake` 一个生产者，读代码证实），任意 ≤256 文本可入库并成为周报的配对键。
- 建议：备忘即可；如加旁路写入口，把校验对齐到字符集。

**4. 低 ｜ docs/adr/0154:38 vs 0073 SQL / summarizeMuse ｜ 既有 ADR 表述与表结构不一致，本次自动写入沿用其模糊性（读代码证实）**
- 证据：ADR 0154 称 `paired_message_id` “同一邮箱内唯一”；0073 迁移（packages/persistence-sqlite/src/migrations/0073）只有长度 CHECK，无 UNIQUE；`summarizeMuse` 还专门按 museReminded 优先去重同 id 条目（calibration index.ts:293-298）。
- 问题：本次自动写入使多批 Muse 条目可能引用同一邮件编号，表层面不排斥。属旧文档问题，非本 PR 引入。
- 建议：改 ADR 提示为“语义上唯一（Gmail 邮件编号天然唯一），表上无 UNIQUE 约束”。

**5. 核实性说明 ｜ Muse 侧说法未核实**
- Himawari 侧“同值”链路已核实：`gmail-source.ts:187-189`（`messageId: message.id`，Gmail 接口 id）→ `sqlite-proactive-operations.ts:624-646`（存入 `proactive_processed_messages.message_id`）→ `calibration index.ts:358-359`（按 `message_id = ?` join）。两端对得上。
- “Muse 实测能读 1a1b53d1b88e9acc”“Muse 连接器和 Himawari 用同一接口 id”——外部系统，未核实。若 Muse 读的是另一邮箱，join 会落 `noHimawariRecord` 桶（降级安全，不会错配对——这是好设计）。

**6. 无问题确认（读代码证实）**
- 迁移 0079 只 `ALTER TABLE ... ADD COLUMN`，无 UPDATE/DELETE，append + expand 阶段，与 0073 先例同构；`LATEST_MIGRATION_SEQUENCE` 自动导出（migration-engine.ts:635-636）；测试常量 78→79 与审计脚本 79 全部同步，且审计上限有自动门槛 CI（`check:audit-schema-range`，scripts/check-audit-schema-range.mjs:16-27，I-46 已落门槛）。
- runbook、ADR 0162 第 8 条关于字段格式、“整条拒收”、评价时自动写 `paired_message_id`、“没带编号照收不配对”的表述均与代码一致。
- `rate()` 列数/参数数核对：13 列 9 参，与 run(...) 一致（sqlite-muse-intake-operations.ts:466-481）；清除评价（timingOk/contentOk 双 null）先 DELETE 后不 INSERT，“随条目删除”成立（:436,459-462 + clearAll:497-505）。

## 必答问题

1. **会不会改变模型已见过的请求开头？** 不会。全部改动在 Muse 入库端、评价端、存储、迁移、文档、测试；消费端是网关快照给网页（production-muse-intake-control.ts:121-131 只挑固定字段；production-observation.ts:199 起是 UI 快照）和 CLI 报告，无一处进入系统提示、工具定义、历史或遮盖。“只追加”规则在此不适用：没有任何内容会发给模型，故“每轮变化的值放在最后一条消息”也评估为不触发。
2. **同一段文字会不会在不同请求变成不同字节？** 不会。新值只进服务端内部存储与内部 `content_digest`；digest 的 JSON 键序由对象字面量固定顺序决定（production-muse-intake.ts:264-279），无新增无序集合。模型的请求字节与本改动零相关。要澄清：digest 会变（带编号 vs 不带编号——读代码证实），影响的是**重复/冲突判定**，不是请求缓存。
3. **改动有没有对应的自动检查？反向用例会不会真的失败？** 有（读代码证实）：HTTP 正/反例（muse-intake-http.test.ts:310-320——删掉 `GMAIL_ID_PATTERN` 后 `"not an id; drop table"` 会被接受，`accepted: 0` 断言即失败）；配对正/未配对反例（muse-intake-store.test.ts:311-338）；测试常量与审计脚本 79 同步有 I-46 门槛兜底。缺口见第 2 条发现：>256、DB CHECK、编号变更冲突、scheduled 携带该字段，均无用例（未核实到）。
4. **产生的每个值，使用方都能接受吗？** 逐一核过：`gmail_message_id`（Muse→HTTP 白名单→pattern+长度校验→ SQLite CHECK）；`MuseIntakeItemWrite/MuseIntakeItem.gmailMessageId`（接口必填，编译期强制所有构造者，唯一存储实现 SqliteMuseIntakeOperations 在 itemProblem:81 校验；读者 :323、:449 均已更新）；`paired_message_id`（写端：rate() 从已校验的入库值复制 + DB 长度 CHECK；读端：calibration 精确 join + 未命中落 `noHimawariRecord` 桶、summarizeMuse 去重容错——两端口径一致，与 0073 的“长度 1–256”语义对齐）。未发现两端校验不匹配的地方；唯一实质保留意见是发现 1（该值由“先到为准”策略冻结）。
