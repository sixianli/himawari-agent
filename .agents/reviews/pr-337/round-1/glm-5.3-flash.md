# PR 337（P1-5 一封邮件决策一页）复核

## 发现（按严重度从高到低）

### 1.（中）`decision.email.read` 的网关路由与安装名单变更没有任何测试覆盖

- **文件**：apps/agent-service/src/production-approval-gateway.ts:109-111、apps/agent-service/src/production-http-composition.ts:668、apps/agent-service/src/production-observation.ts:44-48
- **问题**：普通用户流程是 控制中心 → HTTP/WS 网关 → 审批网关路由 → `ProductionObservation.#emailTrace`。本次改动新加的中间两环（审批网关把 `decision.email.read` 路由到 `observationControl`；安装名单把该操作广播给前端）没有任何自动化测试走到。
- **证据**：
  - 路由是纯新增分支：`(query.type === "proactive.weekly.read" || query.type === "decision.email.read") && options.observationControl ? options.observationControl.query(query) : ...`（production-approval-gateway.ts:109-111）。
  - 全仓库引用 `decision.email.read` 的测试只有三处，都绕开了这一环：test/integration/decision-email.test.ts:265 直接 `h.observation(own).query(...)`；apps/control-center/test/weekly-report.unit.test.ts:1304 是 mock 的 `client.query`；test/e2e/fixtures/control-center-browser-server.mjs:1303 是测试自建的假后端。grep `createProductionApprovalGateway` 相关测试（test/integration/ledger-observation-service.test.ts:329-351）只发过 `proactive.observation.start` 命令，没有发过 `decision.email.read` 查询。
  - `npm run check:operations` 按 ADR 0192（docs/adr/0192…md:47）只做字面量存在性检查（后端实现、调用方、测试里引用过），不能发现路由条件写错。
- **建议**：加一条集成用例：经 `createProductionApprovalGateway` 发 `decision.email.read` 能到 `observationControl` 并返回快照；再加反向用例（`observationControl` 未装时返回 INVALID_OPERATION）。若把路由条件改回 `proactive.weekly.read` 一个名字，现有全部测试仍应全绿——这正是缺口所在。

### 2.（低）邮件页若干分支无测试：`himawariOnly`/`bothSilent` 桶、截断标记、seal 失败、LEFT JOIN 空值

- **文件**：apps/agent-service/src/production-observation.ts:326-341、352-363；packages/persistence-sqlite/src/sqlite-decision-ledger-operations.ts:531-545
- **证据**：
  - test/integration/decision-email.test.ts:300-309 只覆盖 `both`/`museOnly`/`noMuseEntry`/`noHimawariRecord`；`mailComparisonBucket` 的另两个桶 `himawariOnly`（有记录有 Muse 条目但未提醒且 Himawari 关注）和 `bothSilent` 在邮件页路径上没有用例（packages/calibration/src/index.ts:327-334）。
  - `open()` 的 `catch { return null }` 和 `text === undefined ? null`（production-observation.ts:328-334，payload 被清理或 seal 抛错时静默降级）无用例。
  - `truncated: trace.museEntries.length >= MAIL_TRACE_MUSE_LIMIT`（恰好 20 条时也为 true，属可接受的保守标记）与 UI 的 `museCut` 文案无用例。
  - `readMailTrace` 的 LEFT JOIN 在 `muse_intake_items` 无对应行时 kind/state/titleRef/textRef 全 null（sqlite-decision-ledger-operations.ts:535-539），以及 `kind === "scheduled"` 的条目，均无用例。
- **建议**：在 decision-email.test.ts 的 MAILS 清单里补这几种形态，成本很低（fixture 已具备）。

### 3.（低）Gmail 编号正则存在两份拷贝，且一条写入路径的校验弱于契约

- **文件**：packages/gateway-contracts/src/validation.ts:62-69、packages/persistence-sqlite/src/sqlite-muse-intake-operations.ts:41-44、packages/persistence-sqlite/src/sqlite-decision-ledger-operations.ts:412、packages/persistence-sqlite/src/migrations/0073_muse_reference_paired_message.sql:2
- **证据**：
  - 契约 `GMAIL_MESSAGE_ID_PATTERN` 和存储 `GMAIL_MESSAGE_ID` 是字面相同的两份正则；作者说的“等价测试”确实存在且是真的比较源码与标志（test/integration/decision-email.test.ts:353-356）。
  - 不对称点：muse intake 写入时用 pattern 校验 `gmail_message_id`（sqlite-muse-intake-operations.ts:87），但 `recordMuse` 对 `pairedMessageId` 只校验 `text(pairedMessageId, 1, 256)`——长度、不校验字符集（sqlite-decision-ledger-operations.ts:412），表约束 0073 也只有长度 CHECK。
- **评估**：当前生产路径里 `muse_reference_entries.paired_message_id` 的值全部来自 intake 校验过的 `gmail_message_id`（sqlite-muse-intake-operations.ts:292-297 直接回填、rate() 在 :510 用 `item.gmailMessageId`），`recordMuse` 传 `pairedMessageId` 的调用方只有测试（全仓 grep `.recordMuse(` 仅测试命中），所以今天两端是一致的。风险是将来有人走 `recordMuse` 写入超集字符的编号，周报快照在 production-observation.ts:305 的 schema parse 会抛错、整份周报失败，而不是降级。
- **建议**：让 persistence 侧直接 import 契约的 `GMAIL_MESSAGE_ID_PATTERN`（或反之），并在 `recordMuse` 里用同一 pattern 校验，删掉靠正则源码字符串相等的脆弱守卫。

### 4.（信息）作者说法逐条核对结果

**读代码证实的**：
- “只读、不改产品行为、不加迁移、不改发给模型的内容”——diff 文件清单里没有任何 prompt-catalog、runtime-pi、遮盖、历史存储路径的文件；新增全部是 gateway-v2 控制面契约、UI、SQL 只读操作、工具脚本、测试和文档。ADR 0197 与实现一致（20 条上限、`noHimawariRecord`/`noMuseEntry` 语义、null 显示“无记录”）。
- “扣留的 Muse 正文不返回”——production-observation.ts:336-338（`textWithheld ? null : ...`，标题和正文都扣），test/integration/decision-email.test.ts:341-347 有断言 `JSON.stringify(withheld)` 不含正文。
- “老记录返回 null 显示无记录”——`forMail` 依赖 `inputFields`（production-observation.ts:319-323），测试 :312-326 覆盖。
- “prod-read.sh gmail-decisions 只读元数据”——SQL 只选 id/count/枚举列，`LIMIT 100`，join 无正文列；测试验证 `{ readOnly: true }`、拒绝多余参数（test/tooling/prod-read.test.mjs:240-287、368-373）。文档 .agents/instructions/test-and-production-hosts.md:19 同步更新，一致。
- “周报共用 mailComparisonBucket”——calibration/src/index.ts:352 改为调用同一函数，周报与邮件页不会各说各话，证实。
- “已知失败 expensive-models 非本 PR 引起”——packages/sensitive-capture/test/secret-like.unit.test.ts:28 含 `"gpt-4o"`，该文件最后一次改动是基线之前的提交 90d3f44d（PR 334），证实。
- i18n：三个语言包各补齐同样的 22 个 `decision.email.*` id，数量一致，无缺译。

**推测/未核实**：所有测试我只读了代码，没有运行（工具受限）；ADR 里“路由参数 128 字符上限”这一依据未核实；`record-email-decision.mjs`、演示脚本和录屏文件未逐一核对。

## 侧重检查

走的流程：周报“校准周报”tab → 差距案例行“查看这封邮件”按钮（weekly-report.tsx:1278-1286，仅在 `onOpenMail` 存在即操作已安装时渲染，weekly-report.unit.test.ts 有反向用例）→ `setMailView` → MailDecisionPage（memory-page.tsx:934-944）→ `decision.email.read` 查询（proactive.ts:216-221）→ 入口 parse（packages/platform-node/src/http-gateway-server.ts:355 / packages/application/src/services/governance-gateway-adapter.ts:145）→ **审批网关路由（无测试，见发现 1）** → `#emailTrace` → `readMailTrace` + `ledger.read` + `seal.open` → `mailComparisonBucket` → 出口 parse（production-observation.ts:387）→ 页面渲染（依赖链复用 `DecisionChainBody`、`WeekGlance` 与周报同构组件）。

结论：两端的解析、SQL 读、纯函数、UI 都有正反向测试（unit + integration + 真实浏览器 + tooling）；中间的网关接线和安装广播是这条流程里唯一没有测试覆盖的代码路径，另有发现 2 列出的降级分支。文档（ADR 0197、instructions、i18n）与代码一致。

## 必答问题

1. **不会。** 本 PR 未触碰任何组装或修改发给模型内容的代码（无 prompt-catalog、runtime-pi、遮盖、历史写入的改动）；`check:prompt-prefix` 及其反向用例原样保留（未运行，推测通过）。发给模型的内容仍只追加；新增的快照数据只进控制面 websocket，不进模型请求，不存在新的每轮变化值。
2. **不会。** 新增快照里所有列表顺序固定：ruleIds/memoryIds `[...new Set(...)].sort()`（production-observation.ts:322），muse 条目 SQL `ORDER BY e.muse_at, e.id`（sqlite-decision-ledger-operations.ts:543），比较桶是纯函数；无新增带时间字段。同一数据库状态下同一段文字序列化字节确定。
3. **部分有。** 契约 fixture（gateway-v2.fixture.ts:375-409，contract.test 会遍历并 round-trip）、integration 正反向、unit `[P1-5]` 正反向、prod-read 反向（拒绝参数）都在；反向用例在代码里确实断言失败路径，但我无法运行验证“真的会失败”（未运行）。缺口：网关路由（发现 1）完全没有用例，正向反向都没有。
4. **逐值核对，均能接受，两处注意点**：
   - `decision.email.read`/`decision.email.snapshot`：契约、后端实现、审批路由、安装名单、前端调用、测试六端齐备，满足 ADR 0192 的 `check:operations` 三项要求。
   - `gmailMessageId`：入口边界 parse（http-gateway-server.ts:355）、存储端 pattern（等价测试守住）；注意两份正则拷贝和 `recordMuse` 弱校验（发现 3）。
   - `gapCases.messageId`：产生端来自 intake 校验过的 `gmail_message_id`（经 JOIN 保证），消费端回传时再过 `gmailMessageId` 校验，闭环；老导出快照不受影响（`GapCaseSnapshot extends Omit<GapCase, "messageId">`，production-gap-export.ts:16）。
   - `MAIL_TRACE_MUSE_LIMIT = 20`：SQL LIMIT、truncated 标记、三种语言文案、ADR 四处一致。
   - `readMailTrace` 端口方法：唯一 SQLite 实现和 durable adapter 均已接线（durable-adapters.ts:1033）；其他实现方若有会 typecheck 报错（未运行 typecheck，推测通过）。
   - `weekly.read(end)` 签名变化：旧调用无参默认 `null`，行为不变。
