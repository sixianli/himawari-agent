# 服务器端“首页条目”读取接口——独立方案

## 一、方案依赖的前提（均为读当前 main @0d989adb 证实）

| # | 前提 | 依据（文件:行）与原话要点 |
|---|---|---|
| P1 | 设备接口 `/api/device/v1/` **只有设计文档，没有代码**。`grep api/device/v1` 只命中 docs 三个文件 | `docs/execution/specs/2026-11-11-apple-device-body-design.md:206-231`（接口表）、`docs/adr/0229-native-apple-clients-and-device-api.md:96`；代码侧零命中 |
| P2 | 网页端读取统一走 `gateway.v2` 消息，已有 `proactive.overview.read/snapshot`、`memory.overview.read/snapshot`、`approval.list`、`decision.chain.read/snapshot` | `packages/gateway-contracts/src/contracts-v2.ts:35-36,62-67,106,1259-1340` |
| P3 | 主动提醒已有完整“为什么”落库：决策记录 `inputs` 记 `ruleIds/floorHits/ruleHits/sourceIds/usedMemoryIds/memoryByMail`，且全部排序去重后写入 | `packages/application/src/services/proactive-mail-check-service.ts:1642-1673` |
| P4 | 决策链读取对每一段给“有记录/没有/没记录”三态，不会编 | `apps/agent-service/src/production-decision-chain.ts:69-80`（`sectionState`：`not_recorded`/`none`/`recorded`） |
| P5 | 审批（`ApprovalRequest`/`GovernedApprovalRequest`）没有一句人话字段，网页快照也只有机器字段 | `packages/application/src/ports/authorization.ts:168-203`；`packages/gateway-contracts/src/contracts-v2.ts:2211-2265` |
| P6 | 决策账本 `kind` 枚举里**没有审批**（CHECK 硬限制），审批产生不了决策记录行；`owner_rating` 只有 `useful/unneeded/missed`；`decision_signals` 只有 `opened/undone/replied` 且触发器禁止 UPDATE/DELETE | `packages/persistence-sqlite/src/migrations/0089_consolidation_hold.sql:21-26,43,159,170-177` |
| P7 | 待确认记忆、tidyUps（带 `undoable`）、conversationReviews（带 `undoable`）、reminders、externalProposals 在记忆总览快照里都有 | `packages/gateway-contracts/src/contracts-v2.ts:1478-1605` |
| P8 | 后台运行有 `listBackgroundRuns`（runId、threadId、runStatus、holds）；runs 表触发来源 `user_message/schedule/external_event` | `packages/application/src/ports/run-lifecycle.ts:90-106`；`packages/persistence-sqlite/src/migrations/0001_initial_product_schema.sql:133,149` |
| P9 | `AttentionPolicyService`（0-100 urgency/confidence）生产无人构造，只有测试构造 | grep `new AttentionPolicyService` 仅命中 `packages/testing`、`test/`、`apps/agent-service/test/` |
| P10 | 主动检查的每日费用上限是配置，默认 1,000,000 微（=1 美元/天），由 `strict-configuration` 解析 | `packages/platform-node/src/strict-configuration.ts:1109` |
| P11 | 提醒的“值得提醒”过滤已有确定函数 `isReminderWorthy(result, priority, floor)` | `packages/application/src/services/proactive-overview.ts:145-172` |
| P12 | 排序调用是新的后台模型调用，必须“固定内容在前、会变的在后”并登记提示词；发送内容只追加、逐字节确定的规则与反向检查已存在 | `.claude/rules/prompt-prefix.md:65-67,72-74`；业界依据（Anthropic/OpenAI/DeepSeek 缓存文档、Manus）见该文件第 6、44 行所引一手网址 |

## 二、方案

### 1. 接口形态（答问 3）：一个应用层读取服务，两个薄壳

- 核心是 `packages/application` 里新加一个**纯读取服务** `readHomeFeed(scope, now)`：并发读审批、主动提醒、记忆总览、后台运行、连接状态，聚合成带序清单，**不调用模型、不写库**（排序结果只读表，见下）。
- 网页壳：`gateway.v2` 加一对 `home.feed.read` / `home.feed.snapshot`（模式照抄 `memory.overview` 的写法，contracts-v2.ts:62-63 的先例）。
- 设备壳：在设计文档 §3 的设备接口表加一行 `GET home`（P1：设备接口还没实现，本轮只在文档表里占位，实现时直接挂读取服务）。
- 明确不做“客户端拼数据”：三端（iPhone/Watch/Mac 菜单栏）和网页都只消费这一个快照。

### 2. 每类条目的真实来源（答问 2）：有真源才显示

| 条目 | 真实来源（已证实） | 缺真源、第一版不显示的 |
|---|---|---|
| 主动提醒/拦截 | `source_insights`（open/replied，经 `isReminderWorthy` 过滤，P11）+ 敏感拦截（`sensitive.interceptions.read`，contracts-v2.ts:59） | 感知类来源（设计未实现） |
| 审批 | `approval.list` pending（P5） | — |
| 待确认记忆 | 记忆快照 `pending`（敏感待确认）、`externalProposals`、`personSuggestions`（P7） | 感知驱动的“听到的记忆”（感知未合入） |
| 替主人做好的 | `tidyUps`、`conversationReviews`（都带 `undoable/undone`，P7） | 模型口头声称“已替你做完”但无落表的动作；`imports` 算不算“做好了”待定 |
| 正在做的 | `listBackgroundRuns` 的 `running/awaiting_approval` 行（P8） | 没有 run 记录的后台活动（如感知抽取排队） |
| 出错 | Gmail `needs_reconnect`（proactive-checks.ts:137）、run `failed`、`capture_gave_up` 决策行（0089:66-68） | 无结构化记录的零散错误 |

### 3. 排序（答问 1）：判断归模型，读取归确定性

- **不用模型就能做对的部分**：每类条目在产生时已带档位——提醒 `priority`（读邮件模型给的，proactive-checks.ts:110）、审批 `finalRisk`、待确认记忆 `importance/tentative`（P7）、错误一律最高档。类内排序完全确定：档位 → `dueAt`（可空排后）→ `createdAt` → `id` 字典序。**没有任何新写死的词典或关键词**，档位都是既有模型判断的产物。
- **用模型的唯一一步**：跨类的“谁排最前”是语义判断，交给一次低价模型调用。触发条件是**待决定集合的指纹变化**（排序后的条目 id 列表哈希），由条目创建/解决路径尾部（读接口之外）异步触发并防抖；结果（顺序、所用模型、时间、basis）存表。读接口永远只查表。
- **失败/超限/未出结果**：整体退回缺省确定性序，快照带 `ordering: "model" | "fallback"`，UI 如实显示“暂按缺省排”。绝不因排序失败让接口失败。
- **费用**：一次调用输入约 1–2K token、输出几十 token（条目数封顶 50）；每天次数上限是新配置键 `homefeed.rank.daily`（建议默认 100 次/天），计入 `GET usage`/用量页，到上限即停在 fallback——与现有主动检查“到 1 美元/天即停”同一模式（P10）。
- **请求形态**（P12）：固定排序指令在前（登记进 `packages/prompt-catalog`），条目一句话+档位列中间（数组先按 id 排序，仿 inputs 的 `[...].sort()`，P3），当前时间放最后。

### 4. “等主人定的件数”（答问 4）

- 精确定义：`count` = 快照里 `kind ∈ {reminder, approval, memory_pending, error}` 且处于“待决定”状态（提醒 open、审批 pending、记忆待确认、错误未处理）的**去重条目数**；`done/running` 一律不计。
- 唯一保证一致的办法：**这个数只在服务器算一次**，作为 `home.feed.snapshot` 的一个字段随清单下发；红点、表盘、菜单栏都显示这个字段，客户端没有“再数一遍”的代码路径。设备端未实现前，Watch/菜单栏走同一网关快照。
- 可验证：单测断言 `count === items.filter(kindClass).length`；反向用例：往清单塞一条 `done` 条目，`count` 必须不变；条目被解决后 `count` 减一。

### 5. “为什么”三样（答问 5）：沿用决策链的三态，缺就不给

| 条目 | 来源 | 命中规则 | 用到的记忆 | 给不出的 |
|---|---|---|---|---|
| 提醒 | 邮件 `sourceIds` | `ruleIds/floorHits/ruleHits` | `usedMemoryIds/memoryByMail` | 全有（P3、P4）；详情直接复用 `decision.chain.read`，`not_recorded` 段显示“没记录”，不编 |
| 审批 | `runId/threadId` | `deterministicFacts` 的 code + `modelClassification.reasonCode` | **给不出**（不记） | “一句话”（P5，模型一句话的 PR 未合入，未核实最终形态）；第一版用固定模板句“请求〈actionKind〉：〈operation〉”并标注 |
| 待确认记忆 | `threadId + sourceRef` | 无（不编） | 无（不编） | 规则、记忆两行缺 |
| 做好的 | consolidation 来源 | `memory.basis.read` 是否覆盖 tidyUps **未核实** | 同左 | 未核实前不给规则/记忆行 |
| 正在做的 | run 触发来源（user_message/schedule/external_event） | — | — | 规则、记忆 |
| 出错 | 连接/run 来源 | — | — | 规则、记忆 |

### 6. 反馈 `useful` / `disturbing`（答问 6）：不改表能做到一半，我建议一次小迁移做全

- 不改表：`useful → owner_rating='useful'`、`disturbing → owner_rating='unneeded'`，走现有 `proactive.decision.rate`（contracts-v2.ts:678-681）与 `proactive.insight.respond`；`unneeded` 已计入误发统计（proactive-overview.ts:246-253），语义上“打扰=误发”成立。审批/错误/做好的条目**没有决策行（P6），反馈无处落**，第一版不给按钮。
- 我不选这条路的原因：`unneeded`（“内容没用”）和 `disturbing`（“内容也许有用，但时机打扰我”）对以后调推送节奏是两个不同信号，混记丢信息。
- 推荐：迁移 0095 把三处 `owner_rating` CHECK（0089:43、101、130）各扩一个 `'disturbing'`，沿 0089 已示范的 keep/rebuild 模式；同时把合约里 `proactiveRatingSchema` 扩同名值（**两端一起改，避免 I-73 式“只改一端”**）。metrics 的误发判断改为 `unneeded || disturbing`。
- 设备通知按钮的凭据机制（绑来源键、“接进现有的决策信号”，设计文档 486-493）尚未实现（未核实），且 `decision_signals` CHECK 不含 `useful/disturbing`——把反馈落 `owner_rating` 而不是 `decision_signals`，绕开不可变触发器（0089:170-177）。

### 7. 改表（答问 7）：迁移 0095，紧跟 0094 连续排队

1. 上述 `owner_rating` CHECK 扩 `'disturbing'`（重建 3 张表，搬数据，模式照 0089）。
2. 新表 `home_feed_rankings(owner_id, agent_id, set_hash, ranked_ids JSON, ordering, model_ref, generated_at)`，主键 (owner, agent)；只存最近一次排序，避免重启后重算并花钱。

不改旧数据（约束允许）。

### 8. 测试清单（答问 8，含反向）

- **件数**：正例 count==过滤长度；反向塞 `done` 条目 count 不变；两端（网关快照/未来设备端）同源同数。
- **排序确定性**：同输入两次生成快照 JSON 字节相同（含并列 dueAt 的 id 决胜）；反向：去掉 tie-break 用例必须失败。
- **排序调用**：集合不变重复读 100 次 ≤1 次调用（反向：每次读都调 → 失败）；空清单/全为 done+running 时不调（反向用例即“不该调时调了”）；模型返回缺条目 → 退回 fallback 且接口不崩。
- **后台调用合规**：排序提示词登记后 `check:prompt-catalog` 通过；固定在前、时间在最后（反向：把时间放中间 → 构造的检查用例失败）。
- **反馈**：`disturbing` 落 `owner_rating` 且计入误发；反向：给无决策行的审批条目反馈必须被拒（`DECISION_RECORD_NOT_FOUND`）。
- **“为什么”三态**：无规则记录的提醒不出现“规则”行（反向：出现即失败）；`not_recorded` 显示“没记录”。
- **上限**：到 `homefeed.rank.daily` 后不再调模型、仍返回 fallback 清单；用量页可见已用/上限/清零时间。
- **权限**：无设备签名/无网页会话的请求被拒（反向）。
- **锁屏**：错误/提醒条目通知标题不含敏感正文，正文走解锁后取数（沿 ADR 0089 第 5 条）。
- **回归**：`npm run check`（含 `check:prompt-prefix`、`check:prompt-catalog`）全绿——本方案不改任何已发模型内容（见必答 1）。

### 9. 费用与上限汇总

唯一新增模型调用 = 跨类排序：低价模型（DeepSeek V4.1 Flash 一档），每次 ≤2K token 输入，每天上限 100 次（配置键可见、`GET usage` 可查），到上限退回 fallback 序；与现有主动检查共享“上限让主人看得见、到了如实标停”的模式（P10、设计文档 553-589）。读取接口本身零模型调用、O(现有几个 list 查询)，4 核 8GB 单机可承受（无新常驻计算）。

## 三、考虑过但不选的做法

1. **只用确定性排序（不调模型）**：最省，但“最要紧的排最前”正是 Andy 对这个功能的定义，跨类要紧度是语义判断；且约束明文“理解意思一律交给模型”。放弃。
2. **复活 `AttentionPolicyService`**（P9）：有 0-100 打分，但它生产无人构造、输入要 `urgency/confidence` 两个新判断值，等于每条都要新模型调用；且改它等于改投递策略，超出本接口范围。放弃。
3. **每次读接口实时调模型排序**：iPhone 小组件刷新频繁，费用和延迟不可控。改为“集合变化才调、结果落表”。
4. **把排序结果写进各条目行**：要动 `source_insights` 等多张表且排序会随集合变化失效；独立小表更干净。
5. **`disturbing` 只映射到 `unneeded` 不改表**：见上，丢语义；一次 CHECK 扩值迁移成本可控（0089 已示范）。
6. **审批也建决策行（kind='approval'）**：能让审批有“为什么”决策链和反馈落点，但要重建 `decision_ledger` 且写点分散在审批创建路径；v1 先直接读 approval 快照，列为 Andy 拍板项（见下）。

## 四、风险与反例

- **模型排序不可复现**：同一集合两次调用顺序可能不同 → 反例：两次读序不同。缓解：`set_hash` 命中即读表；快照标 `ordering:"model"`，Andy 可要求改回纯确定性序（拍板项）。
- **审批条目第一版“一句话”是模板句**：若未合入的那条 PR 最终形态不同，这里要返工（未核实）。
- **`disturbing` 上线后历史统计口径**：misfire 集合从 `unneeded` 变为 `unneeded∪disturbing`，旧图表口径变化（不考虑旧数据兼容，但要写进 ADR）。
- **I-73 式单端校验**：每个新枚举值（条目 kind、rating）两端（合约 schema + SQLite CHECK + 统计代码）必须同步；门槛是新增 `check:home-feed-contract` 进 `npm run check`，反向用例：合约去掉 `disturbing` 而迁移保留 → 检查失败。这是 I-73 的直接教训（`docs/incidents-and-gates.md:112`）。
- **性能**：清单聚合要并发读 4-5 个来源；给整条链路加超时（例如 2s）与单项降级（某来源读失败 → 该类条目缺失并在快照标 `degraded`），不让一个来源拖死首页。

## 五、需要人拍板的取舍

1. 排序要不要接受“模型序 + fallback 标记”，还是只要确定性序（省掉模型调用）。
2. `disturbing` 是否值得一次 3 表重建的迁移，还是 v1 先映射 `unneeded`。
3. 审批要不要建决策行（换来决策链详情页与反馈落点）。
4. “做好的”是否包含 `imports`；审批/错误/做好的条目第一版不给“有用/打扰”按钮（与“每条能给反馈”的要求有偏差）。
5. `homefeed.rank.daily` 默认 100 次/天这个数。

## 六、证实 vs 推测

- **证实**：第一节的 P1–P12 全部为本次打开文件核对；“未核实”项：模型一句话 PR 的最终形态；`memory.basis.read` 是否覆盖 tidyUps；runs 触发来源是否有现成 port 暴露；设备通知按钮凭据机制实现；第二合约包（device 侧）是否存在（I-73 提到“两个合约包各一份”）。
- **推测**：排序调用 token 用量与 100 次/天上限的合适性（需实测后调，同设计文档 553 的做法）；单机聚合查询延迟（需压测）。

## 七、必答四问

1. **会不会改变模型已见过的请求开头？** 不会。本接口不改任何现有对话的系统提示、工具定义、历史或遮盖；唯一新模型调用是**独立的**排序后台调用，不挂任何现有对话，按规则 15“固定在前、会变在后”组装并登记提示词（`.claude/rules/prompt-prefix.md:65-67`），每轮会变的值（条目列、时间）都在它自己的最后一条用户消息里。现有防线 `npm run check:prompt-prefix`（反向用例：改写历史、系统提示带变化值必须失败，见该文件 72-74 行）照常守着。
2. **同一段文字会不会变成不同字节？** 读接口输出字节确定：fallback 序有全序 tie-break，模型序落表后按 `set_hash` 读，JSON 键序由合约 schema 固定（规则 10，同文件 51 行）；排序调用的输入列表先排序去重（P3 的既有写法）。无时间依赖字段进入任何会复用的文本；`generatedAt` 只在快照元数据里，不是发给模型的内容。遮盖不涉及（不经过出口遮盖路径）。
3. **有没有自动检查、反向用例会不会真失败？** 有：件数不变式、字节确定性、调用触发条件、`home-feed-contract` 两端一致性、反馈落点——每条都写了反向用例（第三节第 8 段），且要求“撤掉实现/破坏约束后该用例必须失败”作为验收标准（同 I-73 门槛的写法）。本方案不改已发内容，`check:prompt-prefix` 无需新用例，只需保持全绿。
4. **每个新值两端的校验都核过吗？** 新值清单：条目 `kind` 枚举（合约 schema 校验 + 三端 UI 只认枚举）；`count`（schema `integer(0)` + 服务端不变式测试）；`ordering` 标记（枚举 + UI 显示分支）；`disturbing`（合约 `proactiveRatingSchema` 与 SQLite CHECK 同步扩，统计代码同步计误发，反向拒绝无决策行的条目）；`homefeed.rank.daily`（strict-configuration 解析带范围 + `GET usage` 展示，沿 P10 模式）；`set_hash`（仅内部，不外发）；`GET home` 路径（设计文档表 + 实现时挂载与验签）。每个值都写明谁产生、谁使用、两端怎么校验、哪道检查守着——即 I-73 教训要求的格式（`docs/execution/specs/2026-11-11-apple-device-body-design.md:696` 同款）。
