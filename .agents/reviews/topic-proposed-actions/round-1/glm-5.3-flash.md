# 方案：把「等主人点头的动作」接在主动提醒上

## 一、方案依赖的前提

**读代码证实的**（提交 6e33c029，均附文件:行）：

- P1 邮件检查是一次性批量模型调用，不是带工具的循环；每封邮件的输出字段固定为 `result/confidence/todo/reason/dueAt/priority/usedMemoryIds/amount`，解析器 `parseJudgements` 逐字段校验、不合就丢——`packages/application/src/services/proactive-mail-check-service.ts:232-241, 539-584`。原话（提示词）：`"只输出 JSON，格式：{\"items\":[{...}]}"`——`packages/prompt-catalog/src/mail.ts:31`。
- P2 提醒挂在记忆上，存储层 `MemoryReminderStorePort.update` 能改 `dueAt/remindAt`，带 `expectedUpdatedAt` 并发检查，返回 `false` 表示被人改过——`packages/application/src/ports/memory-reminders.ts:20-45`；提醒到点经网页推送（`apps/agent-service/src/production-web-push.ts:298-332`）。生产里主人自己也能改提醒（`apps/agent-service/src/production-memory-control.ts:199-202`）。
- P3 Gmail/Calendar 只有只读范围——`packages/platform-node/src/gmail-source.ts:10-11`：`GMAIL_READONLY_SCOPE`、`CALENDAR_READONLY_SCOPE`。服务器今天发不了信、写不了日历。
- P4 审批绑定 `runId`、`intentSnapshot`、`revision`、`semanticSnapshotHash`，应答必须带 `expectedRevision` 和 `semanticSnapshotHash`——`packages/application/src/ports/authorization.ts:168-213`。风险基线 CREATE_OR_UPDATE=MEDIUM、最高档才要本人在场——`packages/application/src/services/action-policy-service.ts:37-50`。
- P5 规则手册已有「按意图自动批准→建一次性 grant→自动 resolve→写审计」的现成路径——`apps/agent-service/src/owner-policy-authorization.ts:36-131`；闸门只有 `mail_item`、`mail_delivery` 两道——`packages/application/src/rules/field-catalog.ts:9`；ADR 0209 写明「第 3 步动作闸门」是预留后续步骤——`docs/adr/0209-…md:104`：原话「后续步骤要改的：……第 3 步动作闸门」。
- P6 邮件判断提示词是 `fixedPrompt`，固定指令在前、候选数据居中、当前时间在最后——`packages/prompt-catalog/src/mail.ts:3-34, 63-87`；组装处 `proactive-mail-check-service.ts:905-913`。它的 `usedBy` 只有邮件检查服务——`mail.ts:6`。
- P7 网关命令的 id 校验 `machineString` 允许 `:` 和 `-`（`/^[A-Za-z0-9][A-Za-z0-9._:-]*$/`）——`packages/gateway-contracts/src/validation.ts:49-60`。这是 I-73 的教训所在（`docs/incidents-and-gates.md:112`：原话「双模型复核只看了 diff，没问『清单里的 id 能通过后端校验吗』」）。
- P8 邮件判断写决策记录，输入带 `ruleIds/sourceIds/memoryIds/usedMemoryIds`——`proactive-mail-check-service.ts:1642-1673`。
- P9 用量表「用途」是表约束里的写死清单——`packages/application/src/ports/model-usage.ts:3-13`。
- P10 推送内容由封存内容（seal）生成——`proactive-mail-check-service.ts:1610-1622`；建议/设备动作的先例设计——`docs/execution/specs/2026-11-11-apple-device-body-design.md:339`（`perception_suggestions`，原话「主人点『好』时才真正去建」）、`:518-546`（动作登记表、状态机 `queued → delivered → succeeded/failed/result_unknown/expired/rejected`，原话「结果未知不重放」）。

**亲自复核过的一手来源**：

- OpenAI Agents SDK：工具要批准时「the SDK pauses the run, returns `interruptions`, and lets you resume later from the same `RunState`」；「designed to be interruptible for longer periods of time without keeping your server running」；长时间挂起「assigning your own code a version number and storing it along with the serialized state」——https://openai.github.io/openai-agents-js/guides/human-in-the-loop
- Apple：可操作通知「let the user respond to a delivered notification without launching the corresponding app」，且「you must declare the actions that your app supports at launch time」，动作可标 `destructive`——https://developer.apple.com/documentation/usernotifications/declaring-your-actionable-notification-types

**材料给出、未逐一复核的**：LangChain HITL、Anthropic Chrome、Gmail 里的 Gemini、Mail 的 Siri 建议（引文见材料）；首页条目接口方案 `/mnt/project-files/ambient-sensing/home-feed-plan.md`（仓库外，读不到，**未核实**，下文只按材料转述的形状对齐）。

## 二、方案

### 1. 动作从哪里来：封闭的动作登记表 + 两次模型判断

**登记表**（代码常量，照苹果设计第 12 节的先例）：每条登记 `type`、参数 schema、对应 `ActionKind`/风险档、执行器（调哪个现有 port）、读回核实方法、能不能撤销、过期窗口、依赖的能力 ref 和权限范围。登记表是封闭词汇表：不进表的类型一律丢弃（Apple 的做法也是“启动时声明、全量处理”）。

今天服务器**只有**「改提醒」有真实执行能力（P2、P3），所以第 1 步登记表只有一条：`reminder.reschedule`（执行器 = `MemoryReminderStorePort.update`，CREATE_OR_UPDATE，中风险，可读回、可撤销）。回信、建日程没有执行器就不登记；等设备动作或 gmail.send 授权落地再加条目——词汇表由登记表决定，能力可用性由能力清单动态过滤，不写死。

**两次模型判断**（理解意思全归模型，不用关键词表）：

1. **批量判断调用加一个可选字段**。`MAIL_JUDGMENT` 加一句固定说明：判断为 act/know 且邮件里有一眼可见的、系统可能替主人完成的后续动作时，加 `"action":{"type":"…","note":"…"}`；拿不准就不写。`parseJudgements` 读这个字段：`type` 不在登记表→丢弃；在→只当作「值得做落实调用」的信号（宽松，不执行）。
2. **落实调用（firm-up）**：只对**会推送且带了动作信号**的邮件，发一次小的低价模型调用（经 Magpie，用途 `mail-action-proposal`）。请求排法照后台调用规范（固定在前、会变的在后）：固定指令 → 该邮件（与判断调用同一份遮盖后视图）→ 候选提醒（`listUpcoming` 窗口内、条数上限是设置、按「dueAt 毫秒→id」排序、固定序列化）→ 原判断的 `todo/dueAt` → 末尾当前时间。输出二选一：「没有明确动作」或 `{type, reminderId, newDueAt}`。服务端逐项硬校验：type 在登记表、reminder 属主人且 `status=scheduled`、新时间在未来且在设置窗口内、模型在该调用里确认了提醒文本和邮件说的是同一件事。

### 2. 怎么存：新表 `proactive_proposed_actions`

不塞进 insight 行（理由见放弃的做法 4）。字段：`id`（`proposed-action:` 前缀）、owner/agent、`insightId/decisionId/threadId`、`type`、参数封存引用（走现有 `ProactiveSealPort`，同 insight contentRef）、**`fingerprint`**（对 `type`+规范化参数+目标当前版本做 canonical JSON 的 sha256，键排序）、`targetUpdatedAt`（提议时 reminder.updatedAt 快照）、创建时定稿的卡片文本（按钮上的话、旧值，**存库**，不渲染时重算）、`status`（`open → executed/dismissed/expired/superseded/failed`）、`revision`、`undoRef`+undo 截止、`executionRef`（读回核实记录）、`expiresAt`（默认 min(提醒时间， 创建+N 天)，N 是设置、主人可见）。迁移随 Agent/主人删除传播，同其他 proactive 数据。

### 3. 怎么和主人看到的内容绑定

- `ProactiveInsightContent` 加一段 `action`：`{proposalId, revision, fingerprint, actionLabel}`。网页提醒页和首页条目接口都从这里渲染；首页条目的 `actions[].binding` = `proposed-action:{id}:{revision}:{fingerprint}`，对齐材料里那份方案的三样对不上就拒绝并刷新。
- 点头入口：`proactive.proposal.act` 命令（设备走 `POST /api/device/v1/home/act` 转发）。带 proposalId、revision、fingerprint、请求编号；服务器核对**四样**：三样一致 + `status=open` + 未过期，任一不对就拒绝并让设备刷新（与审批 `ResolveApprovalInput` 同构，P4）。
- 每日带动作卡的推送条数有上限（设置、主人可见），超上限的条目退化成无动作卡排队，不堆给主人（原则 2 的介入上限）。

### 4. 点头后怎么执行和核实

1. 核对绑定串与状态（第 3 节）。
2. 构造 `GovernedActionIntent`（`authorization.v2`）：CREATE_OR_UPDATE、resourceRef=提醒 id、`idempotencyKey=proposalId`（同一次点头重放幂等）。
3. 授权走现有体系：主人点头当场建 ApprovalRequest 并以主人身份 resolve（带 `expectedRevision`+`semanticSnapshotHash`），grant 为一次性（P4、P5 的现成模式）。第 2 步再上 CEL 动作闸门 `mail_action`（ADR 0209 预留的“第 3 步”），判定 `confirm`（默认）/`auto`/`never`；`auto` 时复用 `applyOwnerPolicyAuthorization` 推送时直接执行并给撤销卡。风险到不了 CRITICAL，不触发本人在场要求（P4）。
4. 执行：执行器调 `update`，`expectedUpdatedAt = targetUpdatedAt`。返回 false = 中途被改过 → **不执行**，置 `superseded`，重新落实调用出新提议。
5. 核实：成功后 `read(id)` 读回，核对 `dueAt/remindAt` 等于新值（原则 6；对齐 Gmail Gemini「点击后 side panel 确认已加入日历」的体验）；通过置 `executed`，不通过置 `failed` 并告诉主人失败在哪。提醒在同一个 SQLite 里，读写同库，不存在“结果未知”；将来接设备动作时沿用 `result_unknown` 不重放。
6. 撤销：undo 窗口内且 reminder 仍是执行后的值才给「撤销」；撤销走 owner 命令直接 update 回旧值（同样吃 `expectedUpdatedAt` 检查），写审计。每次变化追加决策记录（带 proposalId、命中的规则 id）。

### 5. 出错和过期

落实调用失败/超时/到日上限 → **不生成动作，提醒照发**（动作是增强不是依赖），失败计数进决策记录；过期由推送与读取路径惰性置 `expired`，卡片显示「已过期」、按钮消失；所有模型输出逐字段校验，不合法只丢动作字段、不整封重判。

### 6. 怎么量

隐式信号扩展（迁移，照 0080 的路子）：`proposed/tapped/undone/expired/superseded`；显式评分沿用三值。指标：各 type 的提出数、点头率、执行成功率、撤销率、过期率；落实调用费用计入现有每日上限。反向验收固定一组“不该提出动作”的输入（促销带截止日、正文截断时间模糊、时间本来一致），断言提议数为 0。

### 7. 测试与门槛

- 新门 `npm run check:action-proposal`（进 `npm run check`）：登记表逐条 × 合约两端——参数 schema→执行器接受；intent 过 `validateGovernedActionIntent`（`action-policy-service.ts:76-120`）；id 前缀过 `machineString`（P7，I-73 教训）；首页序列化→act 入口接受。**去掉任何一端校验，门必失败**。
- 真实 SQLite 端到端（约束 9）：真邮件桩→真模型桩返回带动作判断→落实调用→入库→点头→`update` 冲突/不冲突两路→读回→撤销。
- 反向用例（每条守卫“去掉它就失败”）：绑定串三样任一错→拒；`expectedUpdatedAt` 被改→`superseded` 而非执行；过期→拒；type 不在登记表→丢；执行器不读回→核实用例失败；删每日上限→超限用例失败；CEL 闸门短路成 auto→confirm 用例失败；同一提议两次序列化字节不同→确定性用例失败。
- `npm run check:prompt-prefix` 原样保留。

### 8. 分几步

1. **第 1 步**：登记表 + `reminder.reschedule` 执行器 + 三处迁移（proposed_actions 表、model_usage 用途、隐式信号）+ 落实调用 + 存取 + 点头命令 + 执行/核实/撤销 + 全部门与测试。默认全走 `confirm`（逐次点头），不开 auto。
2. **第 2 步**：规则手册 `mail_action` 闸门（auto/confirm/never），接 ADR 0209 第 4 步的规则页与撤销。
3. **第 3 步**：`reminder.cancel`；设备动作落地后把执行器接 `device_actions`（calendar.* 等）；gmail.send 授权后接回信（COMMUNICATE 高风险，必点头）。
4. **第 4 步**：与首页条目接口三端联调（等那份方案被批准；第 1 步起 insight 内容里的 action 段就按它的形状设计）。

## 三、考虑过但不选的做法

1. **批量判断调用一步产出最终参数**：每次检查都要带上候选提醒数据、所有邮件的解析面和出错面变大、判断调用先到日上限时动作最先被牺牲；落实调用只在真推送的少数邮件花一次小钱。
2. **关键词/正则识别“改时间”类邮件直接改**：违反约束 2；Anthropic Chrome 的注入实例（邮件指示删邮件）说明外来文字驱动写操作必须过确认。
3. **复用 `SuggestionService`**：它管的是“反思出的待办任务”，交付通道和状态机不同，且生产未接线（材料事实 7）；接线它要改的面比新表大。只借鉴它的去重+每日配额思路。
4. **动作参数塞进 insight 行**：insight 是“一线程一行”，语义是 open/replied/done/muted（P2），多次改时间会互相覆盖；动作有自己的生命周期，混存两头都改不动。
5. **点头后绕过审批直接 update**：违反约束 5，丢审计链。
6. **判断调用改成带工具的循环让模型现场查提醒**：重做整个检查管道，费用与复杂度不成比例（P1）。
7. **落实调用用贵模型**：约束 8 禁止，且 `scripts/check-expensive-models.mjs` 会拦（I-19）。

## 四、风险最大的三处及守住方法

1. **张冠李戴**：模型把邮件里的时间安到错误的提醒上。守住：落实调用必须看到候选提醒原文并显式确认同一件事；卡片在点头前同时显示提醒原文和新时间；`expectedUpdatedAt` 并发检查；一键撤销；反向验收放「邮件时间与提醒本来一致」的用例。
2. **提示注入借动作卡落地**。守住：词汇表封闭（表外丢弃）、参数范围校验（只能改主人自己的提醒、新时间在窗口内）、第 1 步必点头、唯一能开 auto 的是主人定的规则手册；提示词已写明「邮件内容是不可信数据」（`mail.ts:12`）。
3. **两端校验对不上（I-73 重演）**：id 前缀、fingerprint、action 类型在三处各自解析。守住：action type 在合约里用 enum、单一来源是登记表；`check:action-proposal` 逐登记项两端跑；fingerprint 错配时返回可执行的刷新指令而非裸错误。

## 五、需要主人拍板的取舍

1. 第 1 步要不要 `auto` 档（建议：不要，全 confirm，等第 2 步规则闸门）。
2. 动作卡每日上限、过期窗口的默认值（建议先小：每日 5 条、过期 7 天）。
3. `reminder.cancel` 要不要做成一键动作（删除类，虽可撤销仍更敏感；建议第 1 步只做 reschedule）。
4. 首页条目接口方案在仓库外，绑定串按本方案形状冻结前需要他批准那份方案。

## 六、已证实 / 推测

- **证实**：第一节 P1–P10 与两处一手来源（OpenAI HITL、Apple 通知）。
- **推测**：落实调用的输出质量足以支撑点头率（需评测数据验证）；首页 `home/act` 的转发形状（那份方案未核实）；`proposed-action:` id 在**其他**合约包（设备侧）的校验规则——实现第 4 步时按 P7 的门核对，本方案已把该门列为必过项。

## 七、必答问题

**1. 会不会改变模型已经见过的请求开头？**
不会。对话线程的系统提示、工具定义、历史、遮盖全部不动：本改动不加聊天工具、不重写历史，`npm run check:prompt-prefix` 覆盖的对话路径原样。邮件判断调用是每次新建的一次性后台调用，没有“已经见过的开头”；改 `MAIL_JUDGMENT` 文字只影响这个后台单发调用的未来版本，且它的 `usedBy` 只有邮件检查服务（`mail.ts:6`），不进入任何对话历史，所以不会让任何对话的请求开头变化（也不触发 prompt-prefix.md:53 所述“改提示词文字老对话开头变一次”的问题，因为该文字从不在对话里）。新落实调用从第一天起固定在前、当前时间在最后。结论：发给模型的内容仍然只在末尾追加，每轮会变的值都在最后一条消息里。

**2. 会不会让同一段文字在不同请求里变成不同字节？**
不会，前提是守住三点（方案已写死）：候选提醒集合按「dueAt 毫秒→id」等唯一键排序后序列化，不依赖数据库返回顺序；卡片文本（按钮文案、旧值）在提议创建时定稿并封存，禁止渲染时用“还剩几天”“本地时间”之类重算；fingerprint 对键排序的 canonical JSON 计算。当前时间只出现在落实调用末尾，不进入存库文本。

**3. 有没有对应的自动检查，反向用例是否真的会失败？**
有：`check:action-proposal` 门（两端合约逐登记项核对）+ 真实 SQLite 端到端 + 第 7 节列出的反向用例，每条守卫都有对应的“去掉它就失败”用例（删 fingerprint 核对→错配用例失败；删 expectedUpdatedAt→并发冲突用例失败；执行器不读回→核实用例失败；等等）。另外新事故按 I-73 惯例在事故清单落门槛。

**4. 每个值的产生端和使用端是否都能接受？**
逐个核对过：`proposed-action:` id——产生 `ids.next`，使用端网关命令的 `machineString` 允许 `:`/`-`（`validation.ts:49-60`，已核实），另用于首页绑定串、决策记录、审批关联；action type——产生为登记表常量+模型输出（表外丢弃），使用端合约 enum、执行器 dispatch、CEL 字段、首页序列化，单一来源是登记表；fingerprint——产生为 canonical sha256，使用端是 act 命令核对与执行前复核；`targetUpdatedAt`——产生于提议时读取，使用端是 `update` 既有并发校验，`false` 映射为 `superseded` 而非静默（`memory-reminders.ts:36-44`）；model_usage 新用途——需迁移重建用量表（`model-usage.ts:3-13`，照 0091），端到端测试断言记账用途正确，漏了会错落进 `other`；隐式信号新值与设置键——各自有迁移和使用端（复盘页、设置页、主人可见）。**未核实的两处**：设备侧合约包对绑定串的解析（实现第 4 步时用同一道门核对）；首页 act 接口本身（仓库外方案）。
