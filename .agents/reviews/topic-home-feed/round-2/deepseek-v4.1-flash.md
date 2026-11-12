# 方案审核：服务器端“首页条目”读取接口

## 一、证实的（按严重度从高到低）

### 高

**1. `home-rank` 这个用途过不了模型用量表的 CHECK，和“不改表”直接矛盾。**
- 证据：`packages/persistence-sqlite/src/migrations/0068_model_usage_observations.sql:6-11` 的 `purpose` 只允许 `chat/thread-title/memory-capture/memory-episode/memory-consolidation/mail-judgment/action-review/other`；`packages/application/src/ports/model-usage.ts:3-13` 同样没有 `home-rank`。项目自己加 `review-prereview` 时是重建了整张表：`migrations/0091_decision_prereviews.sql:79-117`。而方案写“用途 `home-rank`”又说“不改表”。
- 建议：二选一——(a) 先用 `other`，但报表无法区分；(b) 按 0091 的先例排队一个迁移（当前最大是 0094，下一个 0095）重建 `model_usage_observations`，同步 `MODEL_USAGE_PURPOSES`、导出/报表、契约测试。另需回答：后台排序调用没有 `runId`/`invocationId` 时，`run_id`、`invocation_id` 填什么。这正是 I-73 那一类“产生的新值只有一端认”。

**2. `home/act` 只回传 `itemId + actionId`，会丢掉审批的版本号、内容指纹和近期认证绑定。**
- 证据：`packages/application/src/ports/authorization.ts:205-213` 的 `ResolveApprovalInput` 必须带 `expectedRevision` 和 `semanticSnapshotHash`；`packages/application/src/services/action-policy-service.ts:503` 规定 `recentAuthenticationRequired`，设计文档 `docs/execution/specs/2026-11-11-apple-device-body-design.md:495-497` 要求高风险审批必须用确认密钥签名、主人看到内容后再确认。方案只写“照常走挑战值”，但接口参数里没有版本、指纹、挑战值或近期认证引用。
- 风险：客户端可以先读到一个审批，等审批内容变了再提交；服务器若从当前状态补齐版本/指纹，就绕过了乐观并发检查；若服务器自己判断“照常走挑战值”，也可能把近期认证绕过。
- 建议：不要让客户端只传裸 `itemId/actionId`。要么响应里带 `{approvalId, revision, semanticSnapshotHash}`，客户端原样回传；要么服务器签发一个绑定这些值（以及 `deviceId/ownerId/agentId/expiresAt/nonce`）的动作令牌。服务器必须重新读审批，核对版本、指纹、状态、设备、主人，`recentAuthenticationRequired` 为真时必须校验 `recentAuthenticationRef`。反向测试：改内容后提交、旧版本提交、换设备提交、无挑战值提交、重复提交，全部拒绝。

**3. 过滤掉 `deliveryState = queued_no_ui` 的审批，会把审批永久藏起来。**
- 证据：`action-policy-service.ts:506` 在创建时按 `options.uiAvailable` 写一次 `deliveryState`，`:518` 写 `approval_queued_no_ui`；搜索 `delivery_state` 没有发现之后更新它的代码。`queued_no_ui` 表示“建审批时没有 UI”，不是“永远不可投递”。
- 后果：后台运行在没有 UI 时创建的审批，即使主人后来打开 iPhone，也永远不会出现在首页，件数也不数它，红点不亮，运行可能一直卡着。
- 建议：不要按 `deliveryState` 永久过滤。要么在设备上线/读取首页时把 `queued_no_ui` 视为可投递并展示，要么新增“设备可投递”的判定；如果确实要排除，必须有后台任务在 UI 可用时更新 `deliveryState`，并加“后台创建的审批在设备连上后出现、件数加一”的测试。

**4. 方案把“设备接口表”当成现有代码，但设备接口在 main 根本还没实现。**
- 证据：`docs/execution/plans/2026-11-11-apple-device-body-plan.md:47` 把“设备配对、验签、设备接口骨架”列为第 1 批，`:72-74` 说这些是第 1 批要新建/修改的；当前迁移最大是 0094，仓库里没有 `devices`/`device_pairing_codes`/`device_request_nonces` 迁移，也没有 `/api/device/v1/` 路由实现。方案引用的 `docs/execution/specs/...:198-229` 是设计文档，不是已实现接口。
- 后果：`GET /api/device/v1/home`、设备签名、nonce 去重、事件流 `home_changed` 全都没有可依赖的基础；方案按“现有接口加一项”来估工作量和测试，会严重低估，也无法给出真实集成测试。
- 建议：把首页接口明确排到第 1 批设备 API 之后（并依赖第 3/5/7 批里对应的来源），或者明确它是第 1 批的一部分。方案里要写“依赖第 1 批的设备身份/验签/事件流/测试客户端”，并更新详细设计和批次计划。当前不能把“设备接口表”写成“已核对的事实（对着 main 的代码）”。

**5. 件数与 `items`、`limit`、100 条硬上限自相矛盾，且和现有 APNs 角标不是同一个数。**
- 证据：方案要求“`awaitingCount` 用完整候选集、不受返回页数限制；响应里 `items` 必须包含全部 `awaitsOwner`，硬上限 100，超了写 `truncated`”，但接口又有 `limit=`；`awaitingCount > limit` 或 `awaitingCount > 100` 时，`件数 == items 里 awaitsOwner 的个数` 必然不成立。现有 web push 角标是 `reminders.length + approvals.length`（`apps/agent-service/src/production-web-push.ts:293-306`），只数到期记忆提醒和全部 pending 审批，不数主动提醒/待确认记忆，也不排除过期审批；方案说“APNs 角标都调同一个函数”，但没有列出改这个文件的动作。
- 建议：件数必须是独立的查询/函数，和分页解耦。要么首页始终返回全部 `awaitsOwner`，非 `awaitsOwner` 才分页；要么另给 `GET home/count`（或响应里单独字段）并在所有消费端使用。明确 >100 时的行为（是截断并让角标继续显示真实数，还是角标封顶 99+），并改 `production-web-push.ts` 使用同一函数。测试要覆盖 150 条 awaitsOwner、`limit=10`、两者一致。

**6. “到点的记忆提醒”没有过期窗口，会永久计入件数。**
- 证据：现有 web push 对记忆提醒只取 `now - remindAt <= 6 小时`（`production-web-push.ts:304`，常量在 `:19`）；`memory_reminders` 状态只有 `scheduled/dismissed/cancelled`（`packages/application/src/ports/memory-reminders.ts:14`），没有“done”。方案写“状态 scheduled 且 `remind_at` 已到”，没有下界，设备离线错过的一年前的 scheduled 提醒会一直出现在首页、一直计数。
- 建议：使用和 web push 相同的窗口（或明确定义的过期/自动 dismiss 规则），并在 `awaitingCount` 里排除超过窗口的；测试“昨天到点但未处理的提醒不再计数/不再出现”。

**7. 排序结果只在内存、`revision` 只由候选集合摘要，重启或重排后同一个 `revision` 会对应不同内容。**
- 证据：方案写“结果按候选集合摘要缓存在内存”“读取时只做到期抬升”，又说 `revision` 支持条件请求。`docs/adr/0237-model-pre-rates-waiting-decisions.md:49-51` 的先例是：每次调用单独落表，尝试次数和费用从表里数，重启不重置。HTTP 对 ETag 的定义是一手标准：RFC 9110 §8.8.3，“A strong validator is representation metadata that changes value whenever a change occurs to the representation data that would be observable in the content of a 200 (OK) response to GET”（https://www.rfc-editor.org/rfc/rfc9110.html#section-8.8.3）。候选集合不变、模型顺序变了、或到期抬升让顺序变了，200 的内容就变了，但 `revision` 不变，违反这个定义。
- 后果：重启后内存清空，同一 `revision` 先返回模型顺序、后返回兜底顺序；客户端用 `If-None-Match` 会拿到 304，永远看不到新顺序；`home_changed` 带同一个 `revision`，客户端可能去重掉。
- 建议：把三个版本分开：`candidateDigest`（内容集合）、`rankVersion`（模型/提示词/兜底版本）、`presentationRevision`（最终顺序+抬升结果）。ETag 必须覆盖最终表示，或对时间相关顺序不使用 304。排序结果要落表（新表，迁移排队），至少存 `candidateDigest + model/prompt version + per-item score/order + producedAt + cost`，重启后仍可读；同时能拿“主人先处理了哪件”做校准。

**8. 待确认记忆的“规则段”和外来提议的“来源段”会编造记录。**
- 证据：决策链只为 `proactive` 和 `rule_review` 返回规则（`apps/agent-service/src/production-decision-chain.ts:98`，`:115-154`）；`memory_candidate` 的规则段是 `not_applicable`（`:154`）。`memory_approval_requests` 只有 `policy_version`、`classification`、`source_classification`（`migrations/0012_sensitive_memory_approvals.sql:9,14,15`），没有“命中的规则”。`external_memory_proposals` 只有 `client`、`source_key`、`subject_ref`，没有原对话（`migrations/0093_external_memory_proposals.sql:5-19`）。
- 后果：方案说“待确认记忆：规则给敏感分级策略”“来源给原对话/原消息”，对 `memory_candidate` 和外来提议都无记录可给，最后只能编或静默空；这违反“哪一项没有就不给，不能编”。
- 建议：对 `memory_candidate` 只给“策略版本/分级”并明确标注这是策略版本，不是命中规则；对外来提议只给 `client + source_key`，不要伪造成对话。`not_recorded` 和 `none` 要区分：前者是“我们没记”，后者是“确实没有”，不要都省略成一行没有。

**9. 新值没有按 I-73 做“产生处/使用处/两端校验”的清单。**
- 证据：设计文档明确要求每个新值写清谁产生、谁使用、两端怎样校验、哪道检查守着（`docs/execution/specs/...:696`），并在 `:698-744` 给了表格先例。方案新增了 `itemId`、`actionId`、`revision`、`rankBasis`、`awaitsOwner`、`sentenceBasis`、`home_changed`、`home-rank`、`perception`、`upcoming`、`disturbing` 映射等，但没有对应的新值表，也没有“清单里的 id 能通过发送/后端校验”的测试。
- 建议：补一张和设计文档同格式的新值表；每个值至少有一个契约/SQL/事件枚举测试。`home_changed` 要进设备事件类型清单；`rankBasis`/`sentenceBasis` 要进响应 schema 的 enumeration；`itemId` 要带类型前缀（`approval:`、`proactive:`、`memory_request:`、`external_proposal:`、`tidy:`、`review:`、`run:`、`reminder:`、`error:`），避免不同来源 id 撞车，`home/act` 按前缀分发并校验。

**10. 新模型调用的费用、每日上限、出口登记都不符合硬规则。**
- 证据：`.claude/rules/prompt-prefix.md:67`（第 15 条）要求后台调用固定在前、数据在后；设计文档 `:645-657` 要求新后台调用登记进 `check:egress-redaction`，并说明分级和排序键。方案写“每天最多 N 次（配置，默认待定）”，没有默认值、没有每次大概多少钱、没有到上限的行为；`check:prompt-prefix` 只跑 `prompt-prefix.compat.test.ts` 里的 `[I-66]` 用例（`scripts/check-prompt-prefix.mjs:8-11`），不覆盖新的后台调用，也不覆盖“提示词目录固定文字清单变化导致老对话遮盖变化”的风险。
- 建议：给出具体默认值（例如每天 50 次，仿 ADR 0237:51 的 `dailyLimit: 50`）、每次 token 上限和按当前低价模型配置算出的费用；用持久化的表数尝试次数和费用，失败 24 小时内不重试；到上限时保留上一次已落表的排序并标 `rankBasis: "stale"`（或 `fallback`），不阻塞首页。新提示词同时登记 `packages/prompt-catalog`、`prompt-manifest.json`、`check:egress-redaction`；测试“去掉 egress 登记就失败”。

**11. 敏感/受限分级的来源没有定义，存在把主人正文发给模型的隐私缺口。**
- 证据：`ProactiveInsight` 没有数据分级字段（`packages/application/src/ports/proactive-checks.ts:101-117`）；`ProactiveSealPort.seal` 接受 `dataClassification`（`:439-447`），但 `open` 只返回文本，不返回分级。设计文档 `:656` 要求每种类型有默认分级并沿用现有路由。方案只说“敏感和受限的条目只发占位”，没有说每条条目怎样判定“敏感/受限”。
- 建议：为每个来源定义分级来源（审批用 `intent.dataClassification`；记忆用 `dataClassification`；邮件用 payload 的分级元数据或检查记录；运行/对话继承 thread 的分级）。分级为 `restricted` 的不要发给模型，连占位也只在明确允许时发；用抓包测试证明模型请求里没有原文。设备展示也要区分 App/Watch/Mac 菜单栏/小组件：小组件和锁屏可见面只给件数或标题级，不能因为 `GET home` 是签名接口就把正文给到锁屏可见的组件。

### 中

**12. “正在做的”用 `listBackgroundRuns` 实现不了。**
- 证据：`packages/application/src/ports/run-lifecycle.ts:90-97` 的 `BackgroundRunRecord` 没有触发来源；`packages/persistence-sqlite/src/sqlite-run-lifecycle-operations.ts:892-905` 只查 `run_background_holds` 里未释放的 hold，并且只返回有 hold 的运行；`packages/domain/src/run-state.ts:18-26` 的 `Run` 只有 `triggerId`，触发来源在 `triggers` 表。方案写“runs 非终态且触发来源是 schedule/external_event，加 `listBackgroundRuns`”，现有代码没有这个读取。
- 建议：新增一个查询/端口：`runs` 非终态 join `triggers` 取 `source_type in ('schedule','external_event')`，再 join `run_background_holds` 取 hold 信息；或者先只展示 `listBackgroundRuns` 的后台 hold 并标注“后台任务”，不要把它说成完整的“正在做的”。测试要覆盖 `user_message` 触发不出现、`schedule`/`external_event` 出现、无 hold 的运行也出现（如果设计要求包含）。

**13. `disturbing -> unneeded` 会把“打扰”混成“不需要”，污染校准。**
- 证据：`owner_rating` 只有 `useful/unneeded/missed`（`migrations/0089_consolidation_hold.sql:43`）；`packages/calibration/src/index.ts:430-433` 把 `attention && ownerRating === "unneeded"` 判成 `shouldNot`；`apps/agent-service/src/production-gap-cases.ts:63` 的 `isGapCase` 也直接吃 `ownerRating`。设计文档 `:493` 写的是“有用/打扰接进现有的决策信号”，而 `decision_signals.signal` 只有 `opened/undone/replied`（`migrations/0080_decision_signals.sql:6`），不是 `owner_rating`。
- 后果：主人点“打扰到我了”会在校准里变成“这条不该提醒/不需要”，和“不需要”混在一起；以后无法区分“内容没用”和“时机打扰”。
- 建议：不要让 `disturbing` 覆盖 `owner_rating`。单独一张 `home_feedback` 表（按 `itemType + itemId + deviceId + action` 去重）或给 `decision_signals` 增加 `disturbing` 值（要迁移），并明确校准是否使用、怎么使用。若坚持映射，必须改所有消费 `unneeded` 的地方，并在 UI/周报里说明语义。

**14. `home_changed` 没有产生者和发射时机。**
- 证据：设计文档设备事件流目前只列“对话事件、要设备做的动作、配置变化、用量变化”（`:213`），没有首页变化；方案说“加一种 `home_changed` 事件”，但没说谁在审批状态变化、提醒 mute/done、记忆确认、运行状态变化、Gmail 连接变化、规则复核时发。设备接口本身也还没实现。
- 建议：定义事件产生点（最好走现有 outbox/事件流），带 `candidateDigest` 和 `presentationRevision`；在设备事件类型清单/契约里登记。测试每类来源变化都会发一次，且同一变化不重复发。

**15. 客户端延迟 6 秒再提交审批，不是“撤销”，对不可逆操作有误导和丢失风险。**
- 证据：设计文档 `:495-497` 要求高风险审批主人看到内容再确认；方案说“审批和拒绝没有服务器撤销，设计里的 6 秒‘撤销’由客户端延迟 6 秒再提交实现”。客户端延迟期间 App 可能被系统挂起/杀掉，或网络断开；用户看到“撤销”以为已撤回，实际可能从未提交或已提交。
- 建议：不要把它叫“撤销”。如果确实需要宽限期，做服务器端的延迟执行 + 持久定时器 + 取消接口，UI 明确写“6 秒后执行”；如果做不到，就不要给审批做 6 秒撤销，只做明确的二次确认。对已完成的整理/回看/导入批次，才用服务器端 undo。

**16. `limit`、`locale`、`itemId`、`actionId`、`requestId` 的不可信输入校验没有写。**
- 证据：设计文档 `:235` 要求设备接口参数按固定结构校验、多余字段拒绝；方案只写 `GET home?locale=…&limit=…` 和 `POST home/act {itemId, actionId, requestId}`。没有说 `locale` 只允许三种语言、`limit` 范围、`itemId` 格式/类型前缀、`actionId` 必须是该条目允许的动作、`requestId` 存哪里做幂等。
- 建议：逐一写校验：`locale` 白名单；`limit` 1..100（或明确允许 0）；`itemId` 必须以登记的类型前缀开头且属于当前 owner/agent；`actionId` 必须在该条目的 `allowedActions` 里；`requestId` 用设备去重表存第一次结果，重复请求返回第一次结果。测试：未知 locale、负数/超大 limit、伪造 itemId、跨 owner/agent、action 不属于该条目、重复 requestId。

**17. “为什么”的状态写错，且省略 `not_recorded` 会丢失信息。**
- 证据：`packages/gateway-contracts/src/contracts-v2.ts:1252-1257` 有四态 `recorded/none/not_recorded/not_applicable`，`inputs` 是 `recorded/not_recorded`（`:1279`）；方案写“三段沿用现有的‘有记录/没有/没记录’三种状态”，然后说“只返回有记录的段，其余整段省略”。`none`（确实没有）和 `not_recorded`（没记下来）被合并成“没有”，用户/排查无法区分。
- 建议：保留四态；至少对 `not_recorded` 显示“没有记录”，对 `none` 显示“没有这一项”，或者返回一个明确的 `state` 字段给客户端决定。不要把“没记录”伪装成“没有”。

**18. 撤销项和条目来源表不一致（导入/外来提议）。**
- 证据：方案表格“替主人做好的”只列 `tidyUps`、`conversationReviews`，但撤销段又列“整理、做梦回看、导入、外来提议”；`memory.import.undo`、`memory.external.undo` 是批次级命令（`contracts-v2.ts:71-86,1607-1611,1709,1738`），不是单条条目。外来提议当前是待决项，不是“做好的”。
- 建议：统一：`tidyUps`/`conversationReviews`/`imports` 作为“做好的”条目，`undo` 用各自 id；`externalProposals` 作为“待确认”条目，不要给“做好的”撤销；批次级撤销要在 UI 上说明“撤销整批”。

**19. `perception` / `upcoming` 补充来自仓库外文件，当前 main 没有。**
- 证据：方案引用 `/mnt/project-files/ambient-sensing/pending-doc-edits.md`，不在仓库；设计文档也说感知/暂停还没合入。`memory.overview` 的 `upcoming` 在 main 有（`contracts-v2.ts:1513-1522`），但“感知记录条数/暂停/恢复时间”没有。
- 建议：把 `perception` 块作为独立后续批次，等感知表/接口合入后再加；“今天写入条数”必须复用“感知到的”页同一个查询并加测试。当前方案里写“整块省略”是对的，但不要把它算进本次实现和验收。

### 低

**20. 审批的一句话用对话标题 + 固定模板，需处理标题为空/敏感/多语言。**
- 证据：方案说依赖未合入的“工具调用一句话”PR，合入前用“对话标题加固定模板的动作名”。对话标题是模型生成/可能为空，也可能含敏感内容。
- 建议：`sentenceBasis` 用明确枚举（`model`/`template`/`none`），模板登记进提示词目录并支持三种语言；标题为空时用操作名，不编造；如果把标题发给排序模型，按分级处理。

**21. `policyAuthorization` 不是所有审批都有，类型需要运行时收窄。**
- 证据：`ApprovalRequest` 的 `intentSnapshot` 是基础 `ActionIntent`（`authorization.ts:182`），`policyAuthorization` 和 `deterministicFacts` 只在 `GovernedApprovalRequest`/`GovernedActionIntent`（`:57-75,175`）；`listApprovals` 的端口返回基础 `ApprovalRequest`（`:276-280`），SQLite 里是 `record_json`（`sqlite-durable-operations.ts:1958-1971`）。
- 建议：读取时校验/收窄，非治理审批不要假装有规则段；测试基础审批和治理审批两种。

**22. “件数”是否算“出错要主人处理”与设计定义不一致。**
- 证据：方案表格把 Gmail `needs_reconnect`、`rule_review` `needs_review`、后台运行 failed 标成“等主人定 = 是”，但材料里的设计定义只数“提醒、审批、待确认的记忆”。这两者不是同一类“决定”。
- 建议：把 `awaitsOwner`（需要做决定）和 `needsAttention`（需要处理/查看）分开；件数按设计只数前者，出错类可以显示但不计数，或者由 Andy 明确改定义。规则 `needs_review` 和 Gmail 重连是否需要“决定”要写清。

**23. `check:prompt-prefix` 不会覆盖新后台调用和固定文字清单变化。**
- 证据：`scripts/check-prompt-prefix.mjs:8-11` 只跑带 `[I-66]` 的测试；规则第 11 条（`.claude/rules/prompt-prefix.md:51-54`）和设计文档 `:657` 说明提示词目录里不少于 24 字符的固定文字会进入遮盖清单，清单变化可能让老对话的遮盖结果变一次。
- 建议：新提示词要跑 `check:prompt-catalog`、更新 `prompt-manifest.json`/golden；核对固定文字清单是否变化；如果变化，要么控制在 24 字符以下，要么把这次一次性变化写进 ADR 并请 Andy 同意。

---

## 二、推测/未核实

- **“工具调用的一句话和图标由模型给”的 PR 最终形态未核实**：方案自己也说未合入，审批的一句话来源不确定。
- **`perception`/暂停/恢复时间/今天条数**：来自仓库外 pending 文档，当前 main 没有，无法核对查询和时区定义。
- **`listApprovals` 的 `record_json` 是否所有记录都含 `finalRisk`/`policyAuthorization`**：端口类型不保证，需要运行时抽样或契约测试确认。
- **`ueued_no_ui` 是否会在未来批次被更新**：当前搜索没有更新代码，但可能计划中的设备批次会改；需要设计线程确认。
- **DeepSeek V4.1 Flash 的实际单价**：方案没有给，需从当前模型配置/账单读取，不能写死。
- **排序模型在真实候选集上的稳定性和费用**：方案自认“未验证”，需要小规模实测。

---

## 三、侧重检查

- **错误路径**：模型超时、返回漏编号/重复编号/编造编号/全空，方案有兜底且“不丢条目”，这一点是好的；但重启后缓存丢失、同一 `revision` 对应不同顺序、`home_changed` 没发射、模型调用失败退避只靠内存，这些没有闭环。至少要有“重启后仍能给出同一顺序或明确 fallback”的测试。
- **不合规范/不可信输入**：`locale`、`limit`、`itemId`、`actionId`、`requestId` 都没有写校验；`itemId` 没有类型前缀，跨来源 id 可能撞车；`actionId` 由客户端控制，服务器必须按条目允许动作白名单校验，不能直接分发。
- **安全**：`home/act` 丢审批版本/指纹/近期认证是最严重的安全问题；敏感/受限分级来源未定义，存在把正文发给模型的缺口；设备展示面（Watch/小组件/锁屏）没有区分，可能把敏感正文显示在锁屏可见组件；设备签名/重放/幂等测试依赖尚未实现的设备 API。
- **资源耗尽**：候选集、模型输入、内存缓存、DB 查询都没有明确上限；`readProactiveOverview` 的 `listInsights` 没有 limit（`proactive-overview.ts:145`），`listApprovals` 读全部（`sqlite-durable-operations.ts:1958-1971`）。单机 4 核 8GB 下，`GET home` 被频繁调用或候选集很大时会放大。需要 LRU 按条数/字节、模型输入条数上限、查询上限、每设备请求限速。
- **不可撤销操作**：审批的“客户端延迟 6 秒撤销”不是可持久撤销；App 挂起/断网会丢失；不要把它当撤销。整理/回看/导入/外来提议有服务器 undo，但批次级 vs 单条要分清。
- **规则/文档/代码一致**：设备接口表是设计不是代码；“决策链三种状态”实际四态；“`home-rank` 用途”与模型用量表 CHECK 冲突；`deliveryState` 语义被误用；`disturbing` 只存在于设计文档，方案却把它映射到现有 `owner_rating`；`memory_candidate` 没有规则段；批次计划和迁移队列没有在方案里引用。

---

## 四、如果由我来定，我会怎样改这份方案

1. **先排依赖，不假装设备 API 已存在。** 把首页接口放到设备 API 第 1 批之后，明确依赖设备身份/验签/事件流/测试客户端；同步更新详细设计和 `2026-11-11-apple-device-body-plan.md`，改表按队列取号（当前下一个是 0095）。
2. **先做确定性的条目清单，不先上 listwise 模型。** 六类来源先统一成 `HomeItem`（类型前缀 id、`source`、`awaitsOwner`、`dueAt/requestedAt/expiresAt`、`reversible`、`allowedActions`、`dataClassification`、`sentenceBasis`、`why`）。排序先用“主人硬规则 > 到期抬升 > 现有 priority/finalRisk > 等待时间”的确定性比较，阈值和权重做成主人看得见的设置。模型只做“单条缺失语义字段的点评估”（例如没有 priority 的邮件），结果按条目落表、带 prompt/model 版本；不做全局 listwise。这样可测试、可解释、重启稳定，也符合“理解意思交给模型”但不把排序稳定性押在模型上。
3. **排序结果落表，ETag 覆盖最终表示。** 新表存 `candidateDigest + rankVersion + per-item score/order + producedAt + cost`；`candidateDigest` 只用于判断要不要重排，`presentationRevision` 覆盖最终顺序（含到期抬升）。同一逻辑集合在重启后要么可重现，要么明确返回 `rankBasis: "fallback"`；不要让同一个 ETag 对应两种顺序。
4. **件数独立算，所有端同源。** 单独 `awaitingCount` 查询/函数；修复 `queued_no_ui`、超过 6 小时的记忆提醒、过期审批；`production-web-push.ts` 的角标改用它；首页分页不影响件数；测试 150 条和 `limit=10`。
5. **动作走同一套校验，不裸分发。** `home/act` 用服务器签发的动作令牌，或要求客户端回传审批的 `expectedRevision`/`semanticSnapshotHash`；强制 `recentAuthenticationRequired` 的挑战；`requestId` 落去重表；`actionId` 按条目白名单校验；测试 stale/replay/跨设备/越权/绕过近期认证。不要给审批做假撤销。
6. **“为什么”只给真记录。** 复用决策链的四态；`memory_candidate` 只给策略版本/分级，不叫“规则”；外来提议给 `client + source_key`；`not_recorded` 和 `none` 分开。
7. **反馈单独存，不覆盖主人评分。** 用 `home_feedback` 表（或给 `decision_signals` 加新信号值，需迁移），按 `itemType+itemId+deviceId+action` 去重；`disturbing` 不写 `owner_rating`，校准要不要用另定。
8. **模型调用按硬规则补齐。** 提示词进目录、进 egress 检查、更新 manifest/golden；给默认每日次数、token 上限、价格估算、持久化用量和退避；到上限保留旧排序并标注；候选集只把前 N 条发给模型，其余走确定性兜底。
9. **测试补齐反向用例。** 设备签名/重放/过期；审批版本/指纹/近期认证；动作类型/越权/重复 requestId；件数与分页/100 上限；`queued_no_ui`；过期记忆提醒；重启/ETag；缓存淘汰；模型输入不含敏感原文；`home_changed` 每类变化；`disturbing` 不污染校准；去掉守卫时每条反向用例必须真的失败。

---

## 五、逐条回答必答问题

**1. 会不会改变模型已经见过的请求开头？**
不会改变已有对话的请求开头，前提是：排序是独立后台调用，不进系统提示/工具定义/历史；不新增或删除模型工具（这次只加设备 HTTP 接口，不加 `device_action` 工具）；会变的值（当前时间、“等了多久”、上一次顺序、到期抬升）只放在新后台调用的最后一段。**但有一个间接风险**：新增 `packages/prompt-catalog` 的文字会进入“固定文字清单”，清单变化可能让老对话的出口遮盖结果变一次（`.claude/rules/prompt-prefix.md:51-54`、设计文档 `:657`）。`check:prompt-prefix` 不覆盖这一点，必须核对清单/更新 manifest 和 golden，或把新增文字控制在 24 字符以下，或把这次一次性变化写进 ADR 请 Andy 同意。结论：不发进对话就不改开头；新提示词对老对话遮盖的影响需要单独确认，不能只说“`check:prompt-prefix` 不变”。

**2. 会不会让同一段文字在不同请求里变成不同字节？**
当前方案会。排序模型的输入包含“等了多久”、上次顺序和当前时间；同一逻辑候选集每次字节不同。候选集合摘要如果包含这些动态字段，缓存永远不命中；如果不包含，又不能代表最终顺序。数据库返回顺序也没有规定固定排序键。还有 `revision` 只覆盖候选集合、不覆盖模型顺序和到期抬升，同一 `revision` 会对应不同响应字节，违反 RFC 9110 §8.8.3 对强验证器的定义。改法：候选列表按唯一键排序（类型+id），动态值放最后，`candidateDigest` 排除时间，`presentationRevision` 覆盖最终响应；对时间相关顺序不要用 304，或让 ETag 覆盖完整表示。

**3. 有没有对应的自动检查，反向用例真的会失败？**
不够。现有 `check:prompt-prefix` 只覆盖对话请求；新后台调用需要 `check:egress-redaction` 登记、`check:prompt-catalog`/`prompt-manifest.json` 更新。方案列了排序的漏编号/重复/编造/超时和件数同源测试，但缺少：I-73 新值两端校验、设备签名/重放/过期、审批版本/指纹/近期认证、动作白名单/越权/重复 requestId、`limit`/100 边界、`queued_no_ui`、过期记忆提醒、重启/ETag、缓存淘汰、模型请求不含敏感原文、`home_changed` 发射、`disturbing` 不污染校准。每条反向用例要写明“去掉哪个守卫、期望哪条测试失败”，否则不算门槛。

**4. 每个产生或修改的值，所有使用它的地方都能接受吗？**
不能，已发现的具体断点：
- `home-rank` 被 `model_usage_observations` 的 CHECK 拒绝（0068:6-11）；`run_id`/`invocation_id` 也是必填。
- `revision` 被当作 ETag 使用，但只由候选集合摘要产生，不能代表最终顺序。
- `itemId` 没有类型前缀和两端校验；`actionId` 由客户端控制，没有按条目白名单校验；`requestId` 没有去重存储。
- `awaitingCount` 与 `items`/`limit`/100 上限矛盾；现有 `production-web-push.ts:306` 的角标没有改成同一个函数。
- `sentenceBasis`/`rankBasis`/`home_changed` 没有进响应/事件 schema 的枚举。
- `disturbing` 不在 `owner_rating`/`decision_signals` 里，映射到 `unneeded` 会改变校准语义。
- `perception`/`upcoming` 中 `perception` 在 main 不存在；`upcoming` 有契约但“今天条数”的查询未核实。
- 审批的 `policyAuthorization` 只有部分记录有，端口类型不保证；待确认记忆的“规则”没有记录。
