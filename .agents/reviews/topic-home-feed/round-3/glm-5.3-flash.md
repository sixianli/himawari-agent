我先核对仓库状态和两条硬规则的原文，再逐条对照方案里引用的代码。
核对主动洞察、审批投递状态和运行读取的现状。
# 审核结论（先看必要的代码与一手来源，够了即停）

核对基线：main `0d989adb5`。以下所有代码引用都打开核对过；仓库外的 `/mnt/project-files/ambient-sensing/pending-doc-edits.md` 读不到，标「未核实」。

---

## 证实的（按严重度从高到低）

**1.〔高〕「不改表」与「用量用途 `home-rank`」直接矛盾，用量会写不进去。**
证据：`packages/application/src/ports/model-usage.ts:3-13`，`MODEL_USAGE_PURPOSES` 是封闭枚举（chat…review-prereview、other）；`packages/persistence-sqlite/src/migrations/0091_decision_prereviews.sql:88-93`，`model_usage_observations.purpose` 有数据库级 `CHECK (purpose IN (...))`，`home-rank` 不在其中。`modelUsagePurpose()`（model-usage.ts:59-63）会把陌生值静默折叠成 `other`，但即便写 `other`，「每天最多 N 次」就无法按用途从表里数出来。这是 I-73 同型错误：只看了改动本身，没问「新值能过消费端的校验吗」。上一个加用途的先例（`review-prereview`）是同步改枚举**并**用迁移 0091 重建表加 CHECK 的（ADR 0237 第 71 行：「费用计入模型用量表，用途记为 `review-prereview`」）。
建议：方案里明确加一条迁移（0092 起，排队号连续），重建用量表把 `home-rank` 加进 CHECK，同时改 `MODEL_USAGE_PURPOSES`；用量页/上限显示处逐一列出消费端。反向用例：插入 `purpose='home-rank'` 的用量行，迁移前必须失败。

**2.〔高〕`POST home/act` 丢掉了审批的乐观并发绑定——这正是方案自己在挑战点 5 里问、但正文没回答的事。**
证据：`packages/gateway-contracts/src/contracts-v2.ts:192-202`，`approval.respond` 必须带 `approvalRequestId` + `expectedRevision: integer(1)` + `semanticSnapshotHash: machineString`；`packages/application/src/ports/authorization.ts:177-183,205-209`（`ApprovalRequest.revision`、`semanticSnapshotHash`、`ResolveApprovalInput.expectedRevision`）。方案的 act 只有 `{itemId, actionId, requestId}`。若服务器在 act 时现读最新 revision/hash，主人可能批准一份他已经看不到变化的意图（`semanticSnapshotHash` 存在的意义就是「批准的是看到的这份」）；若都不传，就绕过并发控制。
建议：home 条目里内嵌底层 id + 读取那一刻的 `expectedRevision`/`semanticSnapshotHash`（审批类），act 原样回传；不匹配返回冲突码，客户端刷新条目重试。记忆类动作同理绑定各自 id（`changeId`/`reviewId`/`reminderId`/`insightId`，contracts-v2.ts:1606-1620、1721-1742 已核实存在）。

**3.〔高〕件数定义自相矛盾：设计说红点只数三类，方案的表把「出错要主人处理」标成「等主人定＝是」。**
证据：方案材料里 Andy 的原话（红点只数提醒、审批、待确认的记忆）；方案的条目表第 7 行「出错要主人处理……等主人定：是」；方案的件数定义「`awaitingCount` = 条目里 `awaitsOwner = true` 的个数」。两个定义相遇，出错条目（Gmail 掉线、规则待复核、后台运行失败）会全部进红点，和设计冲突；而 `connection.status = needs_reconnect`（proactive-checks.ts:137）是持续状态，红点会长期顶着不消。
建议：二选一并写进方案：出错类 `awaitsOwner=false`（红点不含，首页单独一节）；或改设计并让 Andy 确认。无论哪种，加反向用例「只有出错条目时件数＝预期值」。

**4.〔中高〕把 `queued_no_ui` 审批排除，红点恰恰漏掉「等主人决定却无处显示」的那批。**
证据：`packages/application/src/services/action-policy-service.ts:506`（`deliveryState: options.uiAvailable ? "deliverable" : "queued_no_ui"`）、`automatic-memory-service.ts:435`（记忆确认同样有 deliveryState）、迁移 0012。iPhone 首页存在的意义之一就是「网页没开时也有地方显示」；把 queued_no_ui 滤掉等于这批审批在新渠道里仍然不可见、件数也不涨。方案只对审批过滤了 deliveryState，待确认记忆没过滤，同一概念两处标准不一致。
建议：queued_no_ui 的审批**要**进首页和件数（它们正是最需要新出口的）；或明确说不进的理由并写反向用例锁住行为。记忆确认的 deliveryState 同步对齐。

**5.〔中高〕设备接口整层不存在于 main，「加一项 GET home」建立在一个还没实现的层上，方案没有声明这个前置依赖。**
证据：在 `apps/agent-service/src` 搜 `api/device`、`device/v1`、`device_signature` 均无命中；设备接口表只存在于设计文档 `docs/execution/specs/2026-11-11-apple-device-body-design.md:208-229`（表是规格，不是代码）。
建议：同一份 home 快照先经现有 gateway.v2 暴露给网页（网页本来就该有「要处理」页，且集成测试可以立即在真实 SQLite 上落地）；设备层合入后 `GET home` 同源接上。方案里写明依赖顺序，避免「接口写完了才发现签名层没有」。

**6.〔中〕「为什么直接复用决策链」对审批和待确认记忆不成立。**
证据：决策链快照按 `decisionId` 取（contracts-v2.ts:1259-1278），而 `decision_ledger.kind` 枚举没有审批类（0089_consolidation_hold.sql:21-25）——审批根本没有决策记录行（方案自己也承认）。审批的 `policyAuthorization` 只是 `{key, revision}`（authorization.ts:175），填不进决策链 rules 段的结构（`ruleId/kind/wording/tests`，contracts-v2.ts:1280-1328）。所以审批、待确认记忆的「为什么」是新拼装，不是复用。
建议：方案改口「邮件提醒复用决策链；审批/记忆类新拼装，字段逐个写校验」；或者走 ADR 0237 的思路给审批补决策记录（那是另一个决定，要单独出）。

**7.〔中〕排序提示的字节确定性没有定义清楚。**
证据：规则 `.claude/rules/prompt-prefix.md` 第 10 条（同样的内容每次序列化成同样的字节）、第 11 条（遮盖只取决于它自己和它前面的内容）、第 54 行（同一次请求里排在后面的消息也遮）——这意味着：候选集合里两条条目含同一个秘密时，遮盖结果取决于它们在提示里的先后；方案没写候选在提示里按什么排序，也没写「等了多久/剩余时间」这类连续变化的时间字段是否进「候选集合摘要」（不量化会每轮都算成集合变化，排序调用打满当日上限，永久退到 fallback；全量化又会让摘要漏掉真实变化）。
建议：发送前按 itemId 全序排列；摘要只含稳定字段（id、种类、状态、dueAt、floorRaised、priority），时间差按分钟量化；「把上一次顺序放进提示」只允许作为数据放在请求尾部。

**8.〔中〕自动检查清单少了两道门，而这两道门是有反向用例、真会拦的。**
证据：方案测试一节只提 `check:prompt-prefix` 不变。但仓库现有：`check:prompt-catalog` 按路径扫源码、提示词式字面量出现在目录外即失败（lessons.md:675 记录过 `PROMPT_OUTSIDE_CATALOG` 真实拦截）；`check:egress-redaction` 要求「出口模块之外不得直接调用遮盖函数，也不得有未登记的模型或嵌入请求出口」（engineering-casebook.md:5191）。新排序调用两道都会碰到。
建议：方案的验证清单补上这两项，并写明「排序提示登记进 `packages/prompt-catalog`，调用出口登记进 egress 清单」。

**9.〔中〕排序结果只放内存，与方案自认的风险 2 相互矛盾。**
证据：方案风险 2「同一集合多次调用顺序抖动。靠集合摘要缓存和把上一次顺序放进提示解决，未验证」——重启后内存清空，「上一次顺序」消失，同一集合会产出不同字节、可能不同顺序。项目里已有现成先例：ADR 0237 把每次预评连失败都落表（`decision_prereviews`，迁移 0091，带 promptId 摘要、费用、触发器禁 UPDATE），「尝试次数和费用都从表里数，重启不会重置」（ADR 0237 决定 3）。
建议：排序结果落一张小表（键＝候选集合摘要），重启后顺序不变、当天不重复调用，还为以后「主人先处理了哪件」留了校准数据。这也顺带解决失败退避重启清零的问题。

**10.〔低中〕`disturbing → unneeded` 映射可行但语义有损，且「打扰」类信号写不进 decision_signals。**
证据：`owner_rating` CHECK 只有 `useful/unneeded/missed`（0089:43）——映射不改表成立；但 `decision_signals.signal` CHECK 只有 `opened/undone/replied`（0080:6），通知层的「关掉/忽略」进不了信号表。`unneeded` 在每天打分里的含义是「不该提醒」，「disturbing」是「提醒了但时机/方式打扰」——ADR 0237 的一致率校准直接消费 owner_rating 语义，混用会教坏校准。
建议：短期映射可接受，但在响应和文档写明映射关系；「要不要第四个评价值」这个问题连同第 3、4 条的件数口径一起交给 Andy 定（方案已这么做，肯定）。

**11.〔低〕排序模型的选择与业界先例：业界主流是「每条打分＋固定层级」，不是跨类 listwise 重排；小模型 listwise 未经证实。**
证据：Apple Intelligence 的通知优先级是专用微调模型给每条通知打分/排序，系统再按优先级排栈（https://machinelearning.apple.com/research/introducing-apple-foundation-models ："fine-tuned for user experiences such as … prioritizing and summarizing notifications"；https://support.apple.com/guide/iphone/summarize-notifications-reduce-interruptions-iph1fbe7d2b9/ios ："Your iPhone can determine which notifications have priority over others. Priority notifications appear at the top of the stack"）。学术侧，listwise LLM 排序在 175B 级 InstructGPT 上「significantly worse than fine-tuned baseline rankers」，只有 GPT-4 量级才追平（https://arxiv.org/abs/2306.17563 原话见检索引文）。
建议：方案里的「硬规则进最高档、模型只做档内排序」实际上已经是 Apple 式结构，值得肯定；但把「模型能不能排好档」当成一个要验证的假设而不是默认成立——照 ADR 0237 的模式先小规模量一致率，过门槛再开，默认关闭、可配置（这也符合项目「上限让主人看得见」的约束）。

**12.〔低〕「正在做的」一句话取对话标题成立但有空洞期。**
证据：`listBackgroundRuns` 生产实现存在（`packages/persistence-sqlite/src/durable-adapters.ts:175`）；run→thread→标题，而标题是异步生成的（model-usage purpose `thread-title`）。新触发的后台运行可能还没有标题。方案的 `sentenceBasis` 已覆盖，可接受；反向用例「无标题的后台运行」补进测试清单。

---

## 推测（无代码证据，按逻辑推断）

- 13.〔推测〕到期抬升的公式跨类不齐：审批的抬升基准是 `expiresAt`（有明确的“总时长”），而 `insight.dueAt` 可空（proactive-checks.ts:109）、记忆提醒是 `remind_at`。「剩余/总时长」对没有到期时间的条目怎么算没写，可能出现除零或负值。
- 14.〔推测〕`revision`（候选集合摘要）若在实现时把「等了多久」这类字段算进摘要，会与第 7 条的时间量化问题耦合，`home_changed` 事件可能高频触发。
- 15.〔推测〕「出错类只能『打开对话』不能重试」——方案自述；我没有逐一验证每类错误的可执行动作，只核对了主要 respond/undo 命令存在于 contracts-v2.ts:2571-2663。

## 未核实

- `/mnt/project-files/ambient-sensing/pending-doc-edits.md` 最后一节（仓库外路径，读不到）；「perception_records」「感知记录」均未合入 main（grep 未见），方案「整块省略」的前提我认为成立，但补充材料本身未核实。
- 待确认记忆的「来源给原对话/原消息」：`memory_approval_requests` 是否存原始出处编号，未读。
- `rule_review → needs_review` 的条目在现有读取里如何呈现，未读。

---

## 侧重检查

**流程一：主人打开 iPhone「今天」页。**
路径：设备签名 `GET /api/device/v1/home` →（签名层：**main 不存在**，见第 5 条）→ home 组装层（**新代码**）→ 六个来源读取：`readProactiveOverview`（有集成测试 `test/integration/proactive-production.test.ts`、`proactive-mail-check.test.ts`，但「过期/不可投递条目掉出」这类反向是网页口径，home 层要按新口径重做）→ `listApprovals`（deliveryState 过滤点，见第 4 条）→ `memory.overview` 各段 → `listBackgroundRuns`（durable-adapters.ts:175，已实现）→ 排序缓存/兜底 → 序列化。**没有测试覆盖的路径**：home 组装层全部分支（方案已列出测试计划，包含各来源一正一反，方向对）；条件请求（revision）与重启后的 revision 稳定性（方案没列）；「件数＝items 里 awaitsOwner 个数」不变式在出错类、queued_no_ui 两种口径下的取值（见第 3、4 条）。

**流程二：主人在首页点「同意」一个审批。**
路径：`POST home/act` → 分发到 `approval.respond`（要 `expectedRevision`+`semanticSnapshotHash`，见第 2 条）→ 高风险时 `approvals/challenge` 取挑战值 → 确认密钥签名（设计文档 495-497 行，动作按登记表要求「要主人本人在场」，与方案「照常走挑战值」一致）。**没有测试覆盖的路径**：act 携带的版本与当前 revision 不一致的冲突分支；审批在展示与点击之间过期（`expiresAt` 到点掉出）后点按钮；挑战值流程经 home 入口的端到端（现有测试只覆盖网页 gateway 入口）。这三条方案的测试清单都没列。

**文档一致性**：方案引用的设计文档行号（接口表 198-229、`disturbing` 508）核对属实；「未合入 main 的两个 PR（工具一句话、感知）」与代码现状一致（grep 无对应实现）。

---

## 如果由我来定，我会这样改这份方案

1. **第一版砍掉跨类模型排序，先上确定性分层**：规则命中（`floorRaised`）→ 最高档；档内按「等主人定 > 期限近 > 邮件模型的 `priority` > 时间新 > itemId」全序排。零模型调用、零费用上限、字节确定、天然满足「最要紧的排最前」的第一版诉求。`rankBasis:"structural"`。模型 listwise 排序作为第二步，照 ADR 0237 的模式做一致率评测、默认关闭、过门槛才开——Apple 的先例（每条打分＋固定层级）和 RankGPT 的结论（小模型 listwise 显著差）都支持这个顺序。
2. **补迁移**：一张小表存排序结果（键＝集合摘要，仿 `decision_prereviews`），同一迁移顺带把 `home-rank` 加进用量表 CHECK 和 `MODEL_USAGE_PURPOSES`。方案「不改表」的说法作废。
3. **审批 act 绑定 `expectedRevision`+`semanticSnapshotHash`**，内嵌在条目里、原样回传；各记忆动作绑定各自 id。冲突返回明确错误码。
4. **件数口径先请 Andy 拍板三件事**：出错类算不算红点、queued_no_ui 审批算不算显不显示、`disturbing` 要不要第四个评价值。定完写反向用例锁住。
5. **home 快照先走 gateway.v2 给网页**，设备层合入后同源接上，写明依赖顺序。
6. **验证清单补全**：`check:prompt-catalog`、`check:egress-redaction`、提示词目录登记、用量 purpose 迁移的反向用例、stale-act 冲突、重启后 revision/顺序稳定、无标题后台运行。

## 必答问题逐条回答

**1. 会不会改变模型已经见过的请求开头？**
不会。本次改动不给对话加任何内容：不加工具、不改系统提示、历史不动；首页是纯服务端读取，不进模型上下文。唯一新的模型调用是排序后台调用——它是独立请求，不与父对话共用前缀，按 `.claude/rules/prompt-prefix.md` 第 15 条「固定指令在前、数据在后、当前时间最后」组装即可，规则 16（沿用父对话开头）只适用于摘要/压缩这类要读整段对话的调用，排序不属于。前提：提示词进目录（`check:prompt-catalog` 守）、出口登记（`check:egress-redaction` 守）。「把上一次顺序放进提示」只能是数据、只能放尾部。结论：满足「只追加」，条件如上，且两道门都有反向用例（lessons.md:675、engineering-casebook.md:5191）。

**2. 会不会让同一段文字在不同请求里变成不同字节？**
有三处风险，方案都没写死：① 候选在排序提示里的顺序未定义——两条条目含同一秘密时，遮盖字节取决于先后（规则第 54 行），必须发送前按 itemId 全序排列；② 「等了多久/剩余时间」是连续变量，进缓存摘要就每轮都变、不进就显示陈旧——需量化（如按分钟取整）并写明哪些字段进摘要；③ `GET home` 响应由多个无序查询拼成，序列化顺序必须固定（规则第 10 条），兜底比较器要有 itemId 平级决断以保证全序。遮盖本身是确定性的（密钥不变、前文不变则字节相同），这一点沿用现有出口即可。

**3. 有没有对应的自动检查，反向用例会不会真失败？**
部分有、部分缺。已有的：`check:prompt-prefix`（对对话循环逐字节比前缀，带反向用例：改写历史、系统提示带变化值、关冻结，都会失败）——但**它不覆盖新增的后台调用**；真正守新调用的是 `check:prompt-catalog`（路径扫描，PROMPT_OUTSIDE_CATALOG 有真实拦截记录）和 `check:egress-redaction`（未登记出口失败）。缺的：件数不变式及其在出错类/queued_no_ui 口径下的反向用例（方案列了不变式，但口径没定，用例无从写）；stale-act 冲突；用量 `home-rank` 迁移前插入必须失败；同集合不重复调模型；重启后 revision 与顺序稳定。方案的反向用例设计（模型漏/重/编编号、全空、超时仍全量返回）是好的，保留。

**4. 每个新值的两端校验都核过吗？**
逐个说：`home-rank`——生产端枚举（model-usage.ts:3）+ 消费端数据库 CHECK（0091:88），**当前两头都不收，必须迁移**（证实，第 1 条）。`itemId→命令参数`——消费端各命令 schema 有严格校验（approval.respond 要 revision+hash，contracts-v2.ts:192-202；记忆类要 changeId/reviewId/reminderId/insightId），方案必须在条目里携带并在 act 回传，否则过不了或语义丢失（证实，第 2 条）。`revision`——生产者是 home 层，消费者是设备条件请求，字段构成未定义，须从稳定字段计算（推测+规则第 10 条，第 7 条）。`home_changed` 事件类型——设备事件流整层不存在于 main（证实，第 5 条）。`awaitsOwner`——生产者 home 层，消费者是红点/Watch/菜单栏/APNs 角标「同一个函数」，但与设计文档的红点定义冲突（证实，第 3 条）。`rankBasis`/`sentenceBasis`——纯展示字段，应在响应 schema 里枚举防拼错。`useful/disturbing`——映射端 `owner_rating` CHECK 收（0089:43），`decision_signals` 不收「打扰」语义（0080:6）（证实，第 10 条）。
