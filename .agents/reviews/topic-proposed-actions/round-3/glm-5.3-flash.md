# 审核结论：线程的方案（第 1 版）

## 一、按严重度排列的问题

### 高（证实）

**1. “服务器动作在同一个数据库事务里”目前没有落点，照方案写会出中间态。**
执行一步要求“存原样、改目标（带版本条件）、提议改 succeeded、提醒改 done，要么全成要么全不成”。但现有 `ProductionReminderWriter`（apps/agent-service/src/production-reminder-writer.ts:157-333）的 `create`/`cancel` 是直接依次调 `memory.applyProposal`、`payloads.put`、`reminders.schedule/update` 三个不同 port，没有任何事务参数；仓库里的事务做法都在存储层（如 packages/persistence-sqlite/src/sqlite-memory-operations.ts:750、sqlite-thread-operations.ts:550 用 `database.transaction(...)` 包住同库多写）。方案没有说执行函数要下沉到存储层、在一个事务句柄里跑，按方案字面实现会得到“提议标 succeeded 但记忆没建/载荷没写”这类半完成状态。建议：登记表的执行函数签名定为“在给定事务内执行”，第一版 `reschedule`/`cancel`（单表 update）先行；`reminder.create` 的“记忆+载荷+提醒”要么落成存储层事务内函数，要么第一版不登记。

**2. 新命令 `proactive.proposal.respond` 的两端清单不全——正是 I-73 的教训模式。**
docs/incidents-and-gates.md:112 记载 I-73 的教训是“双模型复核只看了 diff，没问『清单里的 id 能通过后端校验吗』”。这个命令不是加一个函数就行，至少要同时改：`packages/gateway-contracts/src/contracts-v2.ts` 三处（操作清单 ：38 附近、`commandEnvelope` :671、schema 映射 ：2587）、`PRODUCTION_PROACTIVE_OPERATIONS`（apps/agent-service/src/production-proactive.ts:53-64）、安装清单 `installedGatewayV2Operations`（apps/agent-service/src/production-http-composition.ts:680-685）、`execute()` 的 switch（production-proactive.ts:611-680）、control-center 客户端（apps/control-center/src/proactive.ts）。方案第 9、11、12 节都没列这些。建议：分步第 1 步明确列出上述文件，并在第 11 节加反向用例“合约/安装清单没有这个命令时，发送必须被拒”。

### 中（证实）

**3. `decision_ledger` 加种类不止动 kind 清单。**
`0089_consolidation_hold.sql:21-26` 是 kind 白名单，但 ：57-75 还有跨列约束：`(kind='proactive') = (scenario IS NOT NULL)`、`(kind='proactive') = (verdict IS NOT NULL)`，以及“每类 kind 的 outcome 白名单”。`action_proposal` 行要能插入，必须同时给 outcome 加新值并让新种类满足跨列约束（scenario/verdict 为 NULL）。同一个重建里能做，但方案第 8 节只说了 kind 清单，漏写会直接插不进去。建议：第 10 节写明“kind 清单、outcome 白名单、跨列约束三处一起改”。

**4. 新用途 `action-proposal` 的消费端少了两处。**
方案提到了 TS 类型（packages/application/src/ports/model-usage.ts:10）和 `model_usage_observations` 的 purpose CHECK（`0091_decision_prereviews.sql:88-93`，确实要重建表，方案判断正确）。但缺：(a) 控制中心按用途显示三语标签，如 `apps/control-center/src/i18n/resources/zh-CN.ts:1455 "sensitive.purpose.action-review": "动作复核"`、message-ids.ts:1320，新用途不加标签会露原始字符串；(b) 新提议调用的固定提示词要进 prompt-catalog 并登记进 `check:egress-redaction`（package.json:56；这是项目对每个新后台调用入口的既有要求，见 docs/execution/specs/2026-11-11-apple-device-body-design.md:645）。建议：分步第 2 步补上这两项。

**5. 字节确定性有两个没写死的点。**
(a) 输入里的“用到的记忆”没有排序键。邮件检查服务自己的记忆选取有打分排序（packages/application/src/services/proactive-mail-check-service.ts:1510 `#batchMemories`），方案只说“打乱提醒和动作的读取顺序后仍相同”，记忆顺序也会改变请求字节，还改变“原话逐字核对”的比对文本；(b) 内容指纹的“规范化参数”没定义规范形式（键序、数字、Unicode），不写死的话同一提议两次算出的指纹可能不同，绑定核对会误拒。建议：记忆按编号排序写入方案；指纹输入先做 canonical JSON。另：引用原话里若含遮盖占位符（如卡号被遮），方案没写处理；感知设计已有现成规则“候选原话带占位符的直接丢”（2026-11-11-apple-device-body-design.md:399），照抄即可。

**6. “感知建议并进提议表”后，原设计文档的状态集和测试计划没有同步计划。**
`perception_suggestions` 在 docs/execution/specs/2026-11-11-apple-device-body-design.md:339 定的状态是 `open/accepted/dismissed/expired`，并有专门的测试表计划（:732 `perception-suggestions.test.ts`）。并进 `action_proposals` 后状态变成 open/executing/succeeded/…/superseded/withdrawn，文档和测试计划都要跟着改，否则文档与代码不一致。建议：分步第 4 步明确“同时改该设计文档的表定义、状态清单和测试计划”。

### 低（证实）

**7. 撤销可能把提醒恢复到已过去的时间。**`reminderSchedule` 拒绝已过去的due（ADR 0150；production-reminder-writer.ts:184-186 的 DUE_FORMAT+schedule 校验）。主人过了几天才撤销时，“按原样恢复目标”会失败。建议：撤销前检查原时间仍在将来，否则只回状态并说明。
**8. 周报指标分母漏了 `withdrawn`/`superseded`。**采纳率分母“接受+拒绝+过期没理”没算主人点完成导致的撤回，会高估。
**9. 行号小错。**`approval_requests.run_id` 的 `NOT NULL REFERENCES runs(id)` 在 `0001_initial_product_schema.sql:183`（182 是 agent_id）。判断本身对：邮件检查调用的 runId 是 `proactive:<invocationId>`（apps/agent-service/src/production-model-composition.ts:533），确实没有对应 runs 行，“不往 approval_requests 里塞”的理由成立。
**10. 方案可证实的部分都对。**已核对无误的关键判断：判断调用一批默认 8 封（proactive-mail-check-service.ts:245）；推送被静默/后退压住时 insight 照存、照上提醒页（:1075-1087 + proactive-overview.ts:145-192）；`MemoryReminderStorePort.update` 已支持带 `expectedUpdatedAt` 改 dueAt/remindAt（packages/application/src/ports/memory-reminders.ts:36-44），加 `reschedule` 可行；Gmail 只有只读授权（packages/platform-node/src/gmail-source.ts:10），“回信不登记”正确；`audit_records` 表可以承接“点头审计”（0001:287-296，action/target_ref/outcome 足够）；提醒文字检查存在（production-reminder-writer.ts:215-216 REMINDER_TEXT_REFUSED）。

### 推测（未完全核实，标出）

- “能和首页打分那次重建合成一次”——仓库里没找到“首页打分”的迁移或方案，未核实是否有那次重建可合并。
- 提议调用费用补记到当轮决策记录的先后顺序（先写 ledger 再调提议，还是提议完再写 ledger）方案没写；推测需要“提议完成后再写决策记录”，否则 cost_micros 补改要加 UPDATE 路径。
- 两个不同邮件对同一目标提醒各提一条冲突提议时的首页表现，推测可接受（接受其一后另一条在接受时核对被 superseded），但方案未写，建议明示。

## 二、侧重检查（测试覆盖与文档/代码一致性）

我走的普通流程：Gmail 授权（production-proactive.ts:414 `completeAuthorization`）→ `tick()`（:337）→ `ProactiveMailCheckService.run()` 判断调用（batch 8，purpose `mail-judgment`）→ act 结果过 `isReminderWorthy`（proactive-rules.ts:129；proactive-overview.ts:158）→ 【新】提议调用→校验→`action_proposals` → 主人打开网页提醒页（apps/control-center/src/components/proactive-reminders.tsx:237，数据来自 `proactive.overview.read`）→ 点肯定 → 【新】`proactive.proposal.respond` → `execute()`（production-proactive.ts:611）→ 事务执行 → 撤销入口。

这一条链上，方案第 11 节测试清单没覆盖、且真实会发生的路径：

1. **withdrawn 的触发端没有测试**：主人把提醒点“完成/不再提醒”走的是现有 `proactive.insight.respond`（production-proactive.ts:640-657），它和提议撤回是两个入口，需要一条“点完成后提议变 withdrawn、首页件数减少”的用例。
2. **治理删除**：主人删掉提醒挂着的那条记忆（删除流程现在认五种对象，方案未提提议怎么办）→ 提议目标消失，应标 superseded，无用例。
3. **reminder.create 的目标语义**：目标还不存在，指纹里“目标编号和版本”是什么、接受时核对什么、create 因同 key 已存在而 `replayed:true`（production-reminder-writer.ts:173-181）时提议算成功还是被取代，方案都没写。
4. **repeat=yearly 的 reschedule**：remindAt 必须由服务器用 `reminderSchedule` 重算，不能采信模型输出；方案未写时间参数的格式与时区（建议：模型输出和现状清单一致的两个本地时间串，服务器重算 remindAt）。
5. **字节测试缺记忆顺序**（见问题 5）。
6. **文档一致性**：第 9 节引用的“首页条目方案”是上一轮材料，仓库里没有对应文档，建议落成 ADR/设计文档时把“为什么不落 approval_requests”的理由（run_id 外键、状态集、避免重复条目）写进去，避免下次又被当成漏改。

## 三、如果由我来定

方向不变——登记表 + 程序校验 + 主人点头 + 版本/指纹绑定 + 按钮文字程序生成，这与业界一手来源一致：MCP 安全最佳实践要求把外来内容当数据、重要动作必须用户逐次同意（https://modelcontextprotocol.io/specification/2025-06-18/basic/security_best_practices，“MCP clients MUST implement proper consent mechanisms prior to executing”）；Anthropic 工具文档的做法是用严格 JSON Schema 校验模型输出、可用 strict 模式保证参数合法（https://platform.claude.com/docs/en/agents-and-tools/tool-use/define-tools，"Set `strict: true` … to guarantee schema-valid tool inputs"）。方案的“一次调用、不用工具循环”也符合这个做法。

我会改五处：(1) 第一版砍掉 `reminder.create`，只登记 reschedule + cancel，把事务、撤销、目标语义三个最难的地方留到有真实需求再做；(2) 把“执行函数在存储层事务内执行”写成硬要求；(3) 第 10-12 节补全两端清单（命令、kind、purpose、i18n、egress 登记）和缺的用例（withdrawn、治理删除、记忆顺序、遮盖占位符、yearly 重算）；(4) 写死记忆排序键、时间参数格式、指纹规范化 JSON；(5) 同步修订 2026-11-11 感知设计文档的建议表定义。

### 必答问题

1. **不改已见过的请求开头。**对话请求不新增工具、不改系统提示；提议是独立单轮后台调用（无历史、首轮即全量），会变的值（当前时间、日期对照表）排在最后，符合 `.claude/rules/prompt-prefix.md` 第 1、2、15 条。保留意见：该调用的字节确定性不被 `check:prompt-prefix`（只测对话多轮，package.json:57）覆盖，必须靠方案自己的集成测试，且要把记忆顺序加进去。
2. **有两处会把同一段文字变成不同字节，都能修**：记忆列表未定序；指纹规范化未定义。遮盖本身是确定的（规则第 11 条），方案“用模型实际看到的那份做逐字核对”的写法与感知设计一致，正确。
3. **有对应检查，反向用例大体真实**：第 11 节多数守卫有“去掉就失败”的反例；但清单缺上文列的 6 条路径，且未指明这些测试挂在 `npm run check` 的哪个环节（建议明确进 test/integration 并被 CI 收口，参照 I-73 的门槛做法）。
4. **逐值两端核对**：`reschedule` 可行（存储层已有 update+expectedUpdatedAt）；`proactive.proposal.respond` 消费端清单不全（问题 2）；`action_proposal` kind 需同时改 outcome 白名单和跨列约束（问题 3）；`action-proposal` purpose 缺 i18n 和 egress 登记（问题 4）；指纹需要规范化定义（问题 5）；不写 `approval_requests` 的理由经代码证实成立（问题 9）。
