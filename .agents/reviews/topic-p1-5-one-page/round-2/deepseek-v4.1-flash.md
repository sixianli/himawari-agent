已按 `a21563112ade3fe3640ffde7affac2a4f4325592` 核对。先把结论说清楚：这不碰模型请求，所以必答问题 1、2 在“模型字节”层面基本不受影响；真正的问题在**数据口径、输入校验、页面接入方式和测试门槛**。

## 证实的（按严重度）

### 高

**1. “该邮件所在观察期”没有定义，按现有代码会显示错窗口的数字**
- 证据：`proactive.weekly.read` 的窗口是 `end ? ... : start ? { end: start.startDay + 7 } : now`（`apps/agent-service/src/production-observation.ts:186-192`）；前端访问器永远传 `end: null`（`apps/control-center/src/proactive.ts:159-164`）；周报页面也只调 `read()`（`apps/control-center/src/components/weekly-report.tsx:493-508`）。
- 后果：从周报 gapCases 进入时，邮件可能是任意一周；从“提醒检查记录”进入时，邮件通常是今天。按现有 `read()`，页面拿到的是“起点后第一周”或“今天所在周”，不是这封邮件的窗口。旧邮件会配上完全无关的比例。
- 改法：让 `decision.email.read` 返回这封邮件所属的 `{ start, end, endDay }`，并明确按 gapCase 的 `muse_at`（或 audit 邮件的 `processed_at`）计算；前端显式用 `proactive.weekly.read` 的 `endDay` 读取，禁止用 `end: null` 猜。

**2. “比较状态与 summarizeMuse 同名同义”目前不成立**
- 证据：`summarizeMuse` 只统计**窗口内**的 `muse_reference_entries`（`packages/calibration/src/index.ts:631-635`、`662-714`），且每封邮件只取一条：`pairEntriesByMail` 优先取 `museReminded=true` 的第一条（`packages/calibration/src/index.ts:311-323`、`325-346`）。周报的 gapCases 也只取每个 `pairedMessageId` 的第一条候选（`apps/agent-service/src/production-gap-cases.ts:49-63`）。
- 后果：方案又要读 `muse_intake_items`，但未评价的 intake item 不会出现在 `muse_reference_entries`，周报根本不数它；同封邮件多条时，周报只取一条，而详情页可能列多条。只要详情页自己实现一套“比较状态”，就会和周报数字对不上。
- 改法：在 `packages/calibration` 抽出“单封比较”纯函数，`summarizeMuse` 和 `decision.email.read` 共用；明确“窗口、取哪一条、未评价、多条、无 Himawari 记录”的规则；`muse_intake_items` 只用于显示文字，不用于统计。

**3. “这封邮件的规则/记忆/评价”很容易取成决策级的另一组值**
- 证据：决策级字段是 `decision_ledger.inputs.ruleIds` / `inputs.memoryIds` / `decision_ledger.owner_rating`（`apps/agent-service/src/production-decision-chain.ts:98-112`、`127-133`；`packages/persistence-sqlite/src/migrations/0069_decision_ledger.sql:27`）；单封字段是 `inputs.floorHits[messageId]` / `inputs.memoryByMail[messageId]` / `proactive_processed_messages.owner_rating`（`apps/agent-service/src/production-decision-chain.ts:98-101`、`127-130`；`packages/persistence-sqlite/src/sqlite-decision-ledger-operations.ts:523`、`561`）。
- 后果：周报 gapCase 的 `ownerRating` 用的是**单封** `p.owner_rating`（`sqlite-decision-ledger-operations.ts:523`）。如果详情页展示决策级 `owner_rating` 或决策级 `ruleIds`，同一封邮件在周报和详情页会显示不同的评价和规则，而且会带出其他邮件的记忆编号。
- 改法：把 per-mail 字段来源写死：结果/评价取 `proactive_processed_messages`，规则取 `floorHits[messageId]`，记忆取 `memoryByMail[messageId]`；若同时展示决策级评价，必须分别标注“这封邮件”和“这次判断”。不要返回整个决策的 `ruleIds`/`memoryIds`。

**4. Muse 文字没有处理 `text_withheld`、payload ref 和长度上限，存在隐私/契约问题**
- 证据：`muse_intake_items.text_withheld`（`packages/persistence-sqlite/src/migrations/0075_muse_intake.sql:36`）；现有周报通过 `buildGapCases` 尊重它，并在 `seal.open` 后 `clean` 到 300/500（`apps/agent-service/src/production-gap-cases.ts:64-85`、`10-11`）；`muse_intake_items.title_ref/text_ref` 是加密 payload 引用（`0075_muse_intake.sql:34-35`），不 `seal.open` 只有引用没有正文；手工条目的正文在 `muse_reference_entries.content_ref`。
- 后果：如果新查询直接读 `muse_intake_items` 并返回 title/text，会绕过 `text_withheld`，把 Muse 明确选择不展示的文字带到页面；不打开 `content_ref` 时手工条目永远“没文字”；不做长度/控制字符清理可能直接过不了严格契约。
- 改法：复用或抽出 `buildGapCases` 的打开、`withheld`、`clean` 逻辑；限制 300/500；`seal.open` 失败降级为“无文字”，不要让整页查询失败；不要返回 `decision_ledger_payloads`、`reason_ref`、`content_ref` 这类原始引用。

### 中

**5. 邮件编号出现两套互不兼容的校验（I-73 同类）**
- 证据：通用 `machineString` 是“1–128、首字符字母数字、只允许 `._:-`”（`packages/gateway-contracts/src/validation.ts:49-60`）；方案要求 `[A-Za-z0-9_-]{1,256}`；但 `proactive_processed_messages.message_id` 在数据库只约束长度 1–256（`migrations/0069_decision_ledger.sql:103`）；`proactive.overview.read` 的 `audit.items[].messageId` 仍是 `machineString`（`packages/gateway-contracts/src/contracts-v2.ts:424`）；Muse 侧用的是 `[A-Za-z0-9_-]{1,256}`（`apps/agent-service/src/production-muse-intake.ts:60`、`packages/persistence-sqlite/src/sqlite-muse-intake-operations.ts:41`）。Gmail 官方只说 `id` 是不可变标识，没有承诺字符集：[Gmail API users.messages](https://developers.google.com/gmail/api/reference/rest/v1/users.messages)。
- 后果：同一个邮件编号，在“提醒检查记录”和“gapCases”两端可能是 128 的 `machineString`，到新查询又是 256 的自定义 regex；数据库允许的 1–256 任意字符也不一定被接受。若 gapCases 的 `messageId` 也按 `machineString` 加，则超过 128 的合法数据库值永远无法从周报进入详情页。
- 改法：在 `gateway-contracts` 导出唯一的 `gmailMessageIdString`，让新查询、gapCases、audit item、`proactive.audit.respond` 统一使用；或在写入端也收紧成同一 regex。两端的测试要用同一个超长/含特殊字符值。

**6. 新查询的处理分支、安装名单和快照类型没有落到方案里**
- 证据：网关 delegate 只把 `memory.*` 和 `decision.chain.*` 交给 `memoryControl`（`apps/agent-service/src/production-approval-gateway.ts:103-120`）；新名字 `decision.email.read` 不匹配这两个前缀，会落到 `searchAuthorization.query`。安装名单也只有 `decision.chain.read`（`apps/agent-service/src/production-memory-control.ts:47-63`）。每个查询必须有自己的 snapshot 类型（`contracts-v2.ts:2109-2153`）。
- 后果：不补分支就是“后端没实现”；不补 `decision.email.snapshot`、`GATEWAY_V2_MESSAGE_TYPES`、`schemasByType`、契约夹具和 e2e 夹具，`check:operations`、契约往返测试、浏览器测试会红。
- 改法：明确后端归属（建议 `production-memory-control` 或单独 `production-decision-email-control`），显式加 dispatch 分支和安装名单，并列出所有契约/夹具/e2e 改动。

**7. 页面接入方式与现有控制中心路由不匹配**
- 证据：现有页面是 `SidePage`/`WorkPage`（`apps/control-center/src/thread-control-center.tsx:124-125`、`259`），不是任意路由；`controlCenterHref` 只序列化 `selected/cursor/status/view`（`apps/control-center/src/app/router.ts:104-120`），`parseControlCenterUrl` 也没有 `message` 参数（`router.ts:36-38`）；`readLaunchIntent` 只处理 `reminder/settings/gmail`（`apps/control-center/src/proactive.ts:308-327`）。
- 后果：裸 `?message=` 在刷新/前进后退/页面切换时可能丢失；新页面也不会自动出现在导航、`isSurfaceInstalled`、布局审计场景和 e2e 夹具里。
- 改法：二选一：a) 做成 reminders 的第三个 tab，用组件状态，不假装是独立路由；b) 把 `messageId`（和 `endDay`）加入 `ControlCenterRouteState`/`LaunchIntent`，使用统一 regex，并处理 `popstate`。

**8. 按邮件编号查 Muse 没有索引，且响应没有上限**
- 证据：`muse_reference_entries.paired_message_id` 只有长度约束（`migrations/0073_muse_reference_paired_message.sql:1-2`），没有索引；`muse_intake_items.gmail_message_id` 同样只有约束（`migrations/0079_muse_intake_gmail_message.sql:1-4`）；现有索引只有时间索引和 intake_key 唯一索引（`migrations/0069_decision_ledger.sql:149-152`）。
- 后果：按 `paired_message_id` / `gmail_message_id` 查询会全表扫描。生产行数未核实，但 Muse 每小时一批，长期会增长；详情页每次打开都扫一遍，是可控但没必要的读放大。Muse 条目数不设上限还会让响应体无界。
- 改法：加一个迁移给这两个字段建索引（这会打破“不加迁移”，但比全表扫描合理）；给 Muse 条目数、文本长度设上限并固定排序（`muse_at, id`）。如果坚持不加迁移，至少写明量级上限、慢查询告警和失败降级。

**9. 老记录的“无记录”和“这次没有”会混淆**
- 证据：迁移 0069 给老 proactive 行写的是 `inputs = '{}'`（`migrations/0069_decision_ledger.sql:58-65`）；读取端区分“键是否存在”靠 `inputFields`（`sqlite-decision-ledger-operations.ts:311-329`）；ADR 0195 和写入约定明确要求区分（`docs/execution/specs/2026-11-09-decision-record-write-convention.md:56-66`）。
- 后果：如果 `decision.email.read` 直接 `inputs.ruleIds ?? []`，老记录会显示“这次没有规则”，而不是“无记录”；`floorHits`/`memoryByMail` 里缺少这封邮件的 key 也会被误读成 0。
- 改法：按 `inputFields` / `Object.hasOwn` 判断；`floorHits`、`memoryByMail` 的 message key 单独判断，缺键显示“无记录”。

**10. 测试计划没有“反向用例真的会失败”的证据**
- 证据：方案只写“正向、查不到、他人记录、受限记忆不泄露、长编号”“前端单测”“真实浏览器正反向验收”；没有写每条反向用例在故意改坏后是否红。仓库自己的事故门槛文化要求“去掉修复后测试失败”（例如 `docs/incidents-and-gates.md:112` 的 I-73；`docs/incidents-and-gates.md:88` 的 P1-4）。
- 后果：新测试很可能只是按实现写，无法证明能拦住“漏 owner 过滤、漏 withheld、改回决策级 rating、窗口写死”的回归。
- 改法：逐条列出“故意改坏 → 哪个测试红”：去掉 owner/agent 过滤、去掉 `text_withheld`、把单封 rating 改成决策 rating、把窗口改回 `end:null`、从 gapCases 删掉 `messageId`、只改查询不改夹具/安装名单。并在交付报告里写实际失败输出。

### 低

**11. 入口没有按“已安装操作”隐藏**
- 证据：现有代码在显示功能前会检查 `configuration.installedGatewayV2Operations`（`apps/control-center/src/proactive.ts:92-99`），`isSurfaceInstalled` 也要求全部操作已安装（`apps/control-center/src/app/control-center-inventory.ts:59-72`）。
- 后果：前后端版本或配置不一致时，“查看这封邮件”链接会点进一个未安装的查询，用户只看到报错。
- 改法：周报/审计入口只在 `decision.email.read`（以及 `decision.chain.read`）已安装时显示；页面本身也走 `isSurfaceInstalled`。

**12. `gapCases.messageId` 会进入已封存的 gap case 快照**
- 证据：`buildGapCases` 的结果会被 `{ ...found, weekStart, weekEnd }` 封存（`apps/agent-service/src/production-observation.ts:331-332`）；`GapCaseSnapshot extends GapCase`（`apps/agent-service/src/production-gap-export.ts:16-19`）；`isGapCaseSnapshot` 不校验 `messageId`（`production-gap-export.ts:53-69`）。
- 后果：原始 Gmail 编号会永久写进 `gap_case_marks` 指向的 payload；当前导出不读它，但这是新的落盘值，且老快照没有这个字段。
- 改法：如果只是为了前端链接，优先只加在 `proactive.weekly.snapshot` 的输出层，不写进封存快照；如果确实要封存，更新 `isGapCaseSnapshot` 和导出版本说明。

**13. 文档、三语、布局检查未列全**
- 方案没有提新 ADR、`apps/control-center/src/i18n/message-ids.ts` 与三份 locale、`check:locale`、`check:layout` 的场景登记、`scripts/check-layout-audit.mjs` 的新页面场景、`test/e2e/fixtures/control-center-browser-server.mjs` 的新查询分支。按现有门槛，这些会直接报红。

## 推测 / 未核实

- Gmail message id 的真实字符集（是否可能含 `.`、`:`、`/`、`+` 等）未核实；仓库和 Gmail API 都没有给出可依赖的格式承诺。
- 生产 `muse_reference_entries` / `muse_intake_items` 的行数和详情页访问频率未核实，因此“索引问题会不会真的慢”是推测；但“没有索引”是证实的。
- 当前是否存在 `message_id` 超过 128 字符或含非 `[A-Za-z0-9_-]` 字符的生产 Gmail 记录，未核实。
- `test/integration/decision-chain-browser.test.ts` 具体挂在哪个 check 下，未核实。
- 新旧前端/后端是否会短暂同时在线，未核实；但代码里的 `installedGatewayV2Operations` 机制说明这个场景是被认真考虑过的。

## 侧重检查

- **错误路径**：查不到邮件、记录已清除、`decision.chain.read` 竞态（返回 decisionId 后记录被删）、Muse 无条目/多条/未评价/窗口外、`seal.open` 失败、`end` 非法。结论：方案只覆盖“查不到/他人记录”，其余没有定义；需要明确“空快照”还是 `NOT_FOUND`，以及链读取失败时复用抽屉的 `onGone` 行为。
- **不合规范/不可信输入**：URL 查询参数、空串、256 长、特殊字符、重复参数。结论：后端有 regex，但两端不一致；前端和路由没有校验；不要只依赖浏览器。
- **安全/隐私**：跨 owner/agent、受限记忆正文、`text_withheld`、原始 payload ref、Muse 文本长度。结论：受限记忆走 `decision.chain.read` 现有 `reviewMemoryVisible` 逻辑可以；Muse 的 withheld/ref 是明确缺口；不要返回原始 payload 引用或未遮盖正文。
- **资源耗尽**：无索引全表扫描、Muse 条目无上限、文本无上限、页面 5 分钟刷新可能重复查询。结论：需要索引、上限、固定排序；详情页不要跟着 `useProactive` 的 300 秒刷新无条件重查。
- **不可撤销操作**：本次没有写操作；`proactive.gapcase.mark` 不应被顺手放进详情页。结论：不会新增不可逆副作用，方案这点是好的。
- **规则/文档/代码一致**：`check:operations`、契约夹具、e2e 夹具、inventory、ADR、i18n、布局审计没有在方案里列全；这是当前最容易被“看起来做完了”掩盖的部分。

## 如果由我来定

我会这样改这份方案：

1. 详情页不做成“新顶层路由 + 裸 query”：做成 reminders 的第三个 tab，或把 `messageId` + `endDay` 正式加进 `ControlCenterRouteState`，复用现有导航和 `isSurfaceInstalled`。
2. 新查询返回**单封视角**：`messageId`、`decisionId`、`window{start,end,endDay}`、`mail{outcome, rating, rules, memoryIds, inputRecorded}`、`muse{entries selected by shared function, textWithheld, rated/unrated, title/text within limits}`、`comparisonStatus`。不返回决策级 `ruleIds`/`memoryIds`，不返回原始 refs。
3. 把“单封比较”抽到 `packages/calibration`，让 `summarizeMuse` 和新查询共用；状态枚举直接复用周报的 bucket 语义，并明确多条、未评价、窗口外的处理。
4. 统一 Gmail 编号 schema，新查询、gapCases、audit item、`proactive.audit.respond` 全部使用；增加迁移索引；坚持“不加迁移”就必须写清量级上限和降级。
5. 观察窗口由入口传：周报带 `endDay`，审计带 `processed_at` 所在窗口；页面明确显示“这是哪个观察期”，不套默认窗口。
6. 列一张 producer/consumer 矩阵：操作名、snapshot、`messageId`、状态枚举、路由、i18n；逐项更新契约夹具、e2e 夹具、inventory、layout audit、ADR 和事故门槛表。
7. 测试先写“会失败的坏实现”，再实现：跨 owner、withheld、多条、窗口边界、老 `{}`、长编号、`seal` 失败、链读取竞态；前端三语/手机；真实浏览器正反向；每条反向用例都要能在故意改坏时红。

## 必答问题

**1. 会不会改变模型已经见过的请求开头？**
不会。这个方案只新增控制中心查询/页面和 `proactive.weekly.snapshot` 的一个字段，不进入系统提示、工具定义、历史消息或遮盖结果，也不改发给模型的任何内容。发给模型的内容仍然只在末尾追加，每轮会变的值仍只在最后一条用户消息里（依据：`.claude/rules/prompt-prefix.md` 第一、二节，`#order`、`#append-only`）。唯一需要遵守的是：实现时不要把新页面的文本或新查询结果拼进任何模型调用；方案里没有这种动作。

**2. 会不会让同一段文字在不同请求里变成不同的字节？**
对模型请求：不会，因为不进入模型请求。对新查询本身：有风险。方案没有规定 Muse 条目、记忆编号的排序；`proactive.weekly.read` 还带 `generatedAt` 和依赖当前时间的 `complete`/`ratesWithheld`。这些不会影响缓存，但会让“同一详情页刷新两次”出现顺序或字段变化，也会让测试不稳定。建议固定排序（`muse_at, id` / 编号排序）、固定字段集合；如果以后对 Muse 文字做遮盖，必须使用确定性的 `redactForEgress`，不能依赖前后文。

**3. 有没有对应的自动检查，反向用例是否真的会失败？**
只有“测试意向”，还不足以称为门槛。方案列了正向/查询不到/他人记录/长编号/前端/真浏览器，但没有：`check:operations` 的具体两端、契约夹具和 e2e 夹具的更新、每条反向用例在故意改坏后失败的证明、以及这些测试挂在哪个 `npm run check` 步骤。按本仓库的 I-73 教训（`docs/incidents-and-gates.md:112`），必须补“清单/接口产生的每个值都交给使用端校验”的测试，并实际证明改坏会红。

**4. 每个新值的产生端和使用端都能接受吗？**
不能确认。逐个看：
- `decision.email.read` / 对应的 snapshot：方案只写了查询名，没写 snapshot 类型、`GATEWAY_V2_MESSAGE_TYPES`、`schemasByType`、安装名单、dispatch 分支；现有 delegate 不认 `decision.email.*`（`production-approval-gateway.ts:103-120`）。
- `gapCases[].messageId`：产生端是 `buildGapCases`/`GapCase`，使用端是周报契约、前端链接、新查询 payload；但 `audit.items[].messageId` 是 `machineString`（128），新查询方案是 256，数据库是 1–256 任意字符，三处不一致。
- `messageId` URL 参数：产生端是周报/审计链接，消费端是 router、页面、查询；router 不解析也不保留未知 query（`router.ts:36-38`、`104-120`）。
- 比较状态枚举：产生端应是 `packages/calibration`，消费端是契约、三语文案、页面；方案没有定义取值和门槛。
- 新页面/路由/i18n：inventory、`SidePage`/`WorkPage`、layout audit、e2e fixture、三份 locale 都没有在方案里列全。
- `GapCaseSnapshot`：`messageId` 会随封存快照落盘，`isGapCaseSnapshot` 还不校验它（`production-gap-export.ts:53-69`）。

所以第 4 题目前只能回答“部分可以，关键值没有闭合”，不能按方案直接开工。
