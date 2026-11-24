# 方案审核：主对话 + 子线程 + 统一收件箱（第 5 版草稿）

总体判断：方向与 Anthropic 的 always-on agents 一文一致（我核对了原文，引用的“一个收件箱、一个工人、合并连发消息、进度文件”确实存在）。但方案在“合并多件事成一条用户消息”这一点上，与现有代码的历史去重、运行来源、主人意图校验三处会直接冲突；另外推送链路、决策记录约束、子线程中途换工具集合这几处会改变请求开头或让新值过不了后端校验。以下按严重度排列。

---

## 一、证实的

### 高

**1. 合并成一条用户消息会与历史去重冲突，同一段主人原话会重复出现，外部事件又可能丢失。**
- 证据：`admitOwnerMessage` 在同一个事务里把主人消息写进 `thread_messages`（`packages/persistence-sqlite/src/sqlite-thread-operations.ts:1145-1163`），同时让 `triggers.payload_ref` 指向同一条内容（`:1092-1108`）。上下文组装只排除“当前 trigger 的 id 和 payloadRef”（`packages/application/src/services/context-formation-service.ts:191-195`）。方案让一批多条消息共用一个新 trigger、把几条原话合成一条新的最后消息；那么除被选为 trigger 的那一条外，其余主人消息仍在 `thread_messages` 里，会作为历史出现，同时又被合成进最后一条消息。反过来，如果外部事件只放进 trigger 的合成 payload、不写进 `thread_messages`，下一轮历史里就没有这件事。
- 建议：明确“批次消息”与历史的分界。要么把本批次所有 message id / payloadRef 都从历史候选中排除（要改 `context-formation-service.ts`，不是“不用拆”），要么不把主人消息提前写进历史；外部事件用独立的 `role='system'` 消息持久化，合成消息只做本轮视图。加反向用例：连发三条，模型看到的三条各出现一次。

**2. 混合批次（主人消息 + 外部事件）的运行来源是单一值，无法表达两者，会破坏 ADR 0278 的写入闸门。**
- 证据：`RunExecutionSource.sourceType` 只有 `user_message | schedule | external_event`（`packages/application/src/ports/run-execution-source.ts:25`）；`triggers.source_type` 数据库只允许这三种（`packages/persistence-sqlite/src/migrations/0001_initial_product_schema.sql:133`）。授权规则直接按 `run_source` 分支：`refuseBackgroundAfterExternalContent` 对“非 user_message + 外部内容”直接拒绝，`preauthorizeOwnerIntentConfirmed` 要求 `run_source == "user_message"`（`packages/application/src/rules/action-rules.ts:16,122,249`）。上下文形成还要求 `prompt.sourceType === trigger.sourceType`（`context-formation-service.ts:556-558`）。
- 后果：一批里既有主人消息又有外部事件时，只能选一个 `source_type`。选 `user_message`，外部内容就在“主人在场”的来源下运行，`refuseBackgroundAfterExternalContent` 不再生效；选 `external_event`，主人自己的话又拿不到应有的权限，和方案“由你的消息叫起的运行，权限没有问题”矛盾。
- 建议：不要在同一 run 里混合来源。主人消息批次和外部事件批次拆成两个 run；如果确实要合并，把 `run_source` 改成集合，并在动作事实里加显式 `context_has_external_content` + `run_has_owner_message`，任何写操作一律走 `ask_owner`。加反向用例：一批含邮件和主人消息，邮件里的写指令不得被预先放行。

**3. 合并后的 trigger payload 如果以 owner 角色落库，外部事件文字会被当成“主人亲口说过的话”，绕过 `owner_intent_confirmed`。**
- 证据：`collectOwnerWords` 只在 `source.sourceType === "user_message"` 时工作，且要求当前消息 `role === "owner"`、`contentRef === source.payloadRef`，然后读整条 payload（`apps/agent-service/src/production-owner-intent.ts:66-73`）。`ownerIntentEligible` 也要求 `sourceType === "user_message"`（`apps/agent-service/src/owner-intent-gate.ts:76,99-106`）。而 `owner_intent_confirmed` 正是 `askAfterExternalContent` 的唯一豁免（`action-rules.ts:16,122`）。
- 后果：只要合成消息以 owner 角色存进 `thread_messages`，邮件/网页里的“请设一个提醒”就会进入 `ownerWords`，让外部内容冒充主人意图。
- 建议：合成消息必须以 system/context 角色存储，或拆成 `<owner-message>` 和独立的资料段；`collectOwnerWords` 只读 `<owner-message>` 段。加反向用例：邮件正文写“帮我设提醒”，`owner_intent_confirmed` 必须为假。

**4. “你点同意后这个子线程换成上一行的权限”会在同一对话内改变工具集合，违反“系统提示和工具按对话冻结”。**
- 证据：`AGENTS.md:43`：“系统提示和工具按对话冻结”。ADR 0165 标题即“按对话冻结请求头”，ADR 0164 说明工具集合变化要换新对话。方案的权限表写“她自己想到的……只给查的工具；要动手先在主对话里问你，你点同意后这个子线程换成上一行的权限”，并且“每次运行都从数据库重新算”。如果“换权限”意味着给同一个子线程加写工具，下一次请求的工具定义就变了，KV 缓存整段失效，也违反规则。
- 建议：工具集合按对话固定（始终包含写工具），权限只由 action gate 在每次动作时判定；或权限提升时新开一个子线程/新对话。加 `npm run check:prompt-prefix` 和逐字节前缀测试。

**5. 推送链路承载不了“她主动说的话”，而且子线程完成会被自动推送。**
- 证据：`web_push_outbox.kind` 只允许 `reminder | approval | run`（`packages/persistence-sqlite/src/migrations/0058_web_push.sql:26`）；`#content` 对 `run` 只用对话标题和“已完成/失败”，不读消息正文（`apps/agent-service/src/production-web-push.ts:906-922`）；`#collect` 会自动把每个 finished run 入队（`:426-440`）。方案说“推送循环只负责送，不再负责决定”，但没有新增“主动消息”类型的内容路径，也没有把子线程 run 排除。
- 后果：她决定推一句话时，现有推送只能推“已完成 + 对话标题”；每个子线程跑完还会自动响一次，和“推不推由她定”冲突。
- 建议：新增明确的“主动消息”推送类型，内容按消息 id 读取正文；子线程完成默认静默，只有主对话汇总后才可能推；保留提醒/审批直推。加反向用例：子线程完成手机不响；她决定推时正文正确。

**6. 决策记录加新种类会被现有 CHECK/FK 拒绝，或无法表达“推没推”。**
- 证据：`decision_ledger` 有 `kind TEXT NOT NULL REFERENCES decision_ledger_kinds(kind)`（`20261114172143_proactive_source_registry.sql:23`），以及 `CHECK ((kind = 'proactive') = (scenario IS NOT NULL))`、`CHECK ((kind = 'proactive') = (verdict IS NOT NULL))`、`CHECK ((kind = 'proactive') = (outcome IS NULL))`、`FOREIGN KEY (kind, outcome) REFERENCES decision_ledger_outcomes(kind, outcome)`（同文件 `:61-64`）。`verdict` 的允许值只有 `pushed/silent/deferred/failed/capped/capped_daily/needs_owner`（`:30-38`）。
- 后果：新 kind 必须 `scenario` 和 `verdict` 为 NULL、`outcome` 非 NULL；“推没推到手机”不能写进 `verdict`（只有 `kind='proactive'` 才能用 verdict，而 `kind='proactive'` 又要求 `scenario` 非 NULL）。这正是 I-73 那类“清单里的新值过不了后端校验”。
- 建议：把“说了/没出声/推没推”编码成新的 `outcome` 值或 `inputs` 字段，同时在 `decision_ledger_kinds` 和 `decision_ledger_outcomes` 加行；用真实 SQLite 把每个新值插一遍做自动检查。

### 中

**7. “接着做”事件会被 `think_inbox` 的唯一键去重挡住。**
- 证据：唯一键是 `(owner_id, agent_id, source_kind, source_ref, source_version)`（`20261115004401_think_inbox.sql:20`），`enqueue` 先按这个键查重（`packages/persistence-sqlite/src/sqlite-think-inbox-operations.ts:178-188`）。如果“接着做”用固定 `source_ref`（子线程 id）和固定 `source_version`，第二次接着做会被判重复。
- 建议：`source_version` 用 attempt/run id，或为“接着做”单独设计去重键。加反向用例：同一子线程连续两次“接着做”都能入队。

**8. `think_inbox.finish` 只接受三种结局，方案的“结局”不在其中。**
- 证据：`finish` 只允许 `proposed | skipped | failed`（`sqlite-think-inbox-operations.ts:261`）；`SETTLED` 含 `proposed/skipped/failed/expired`（`:16`）。方案要的结局是“告诉了你、没出声、开了子线程”等，且要删掉 `expireQueued`。需要同时改 `finish`、`SETTLED`、`usage`、`recoverStalled`、`expireQueued` 和数据库。
- 建议：先写完整状态机，再逐处改；用真实数据库插入测试。

**9. 批次 trigger 的幂等键没有定义，崩溃后重组批次会产生新 trigger/新 run。**
- 证据：`triggers` 有 `UNIQUE (owner_id, agent_id, idempotency_key)`（`0001:138`），`runs.trigger_id` 唯一（`:147`）。方案说“运行失败或服务中途挂掉，这几行回到待处理”，但没有说批次幂等键怎么算。
- 建议：批次键 = 排序后的 inbox 行 id 集合的摘要；重试复用同一个 trigger，或明确“新 run 但副作用用命令幂等键挡住”。加反向用例：运行中途重启，不重复处理、不重复产生副作用。

**10. `threads.origin` 加“子线程”会波及多个消费者。**
- 证据：`thread-command-service.ts:77` 的 `origin?: "think"` 只允许 think；`production-thread-titles.ts:63` 只跳过 `origin === "think"`；ADR 0277 的 retention 只删 `origin = 'think'`（`docs/adr/0277...:47`）；`sqlite-thread-operations.ts:1893` 只列 `origin='owner'`。
- 建议：明确子线程的可见性、标题生成、保留、导出策略，逐个改并加测试；确保 retention 不删子线程、列表/导出不会意外带出或隐藏错。

**11. “六个没用的服务”说法不准确，直接删会破坏编译/测试。**
- 证据：`packages/application/src/services/autonomy-gateway-adapter.ts:27-28` 仍然 `import type { ReflectionService }` 和 `SuggestionService`；`apps/agent-service/test/fixtures/local-composition-root.ts:3` 仍然 import `AttentionPolicyService`。`DurableBackgroundWorkService` 所在的文件里还有方案要保留的 `evaluateDurableSchedule`（`durable-background-work-service.ts:172`）。
- 建议：先画引用图，连同 `autonomy-gateway-adapter`、测试 fixture 一起处理；把 `evaluateDurableSchedule` 抽出来再删服务。

**12. “时间写具体时刻”不足以保证同一段文字字节稳定；状态板/编号/排序都没定。**
- 证据：ADR 0164 明确记载“同一段文字永远遮成同样的字节，不得依赖它前面或后面的内容”与出口层按上下文遮码存在冲突（`docs/adr/0164...:124`）。方案的状态板包含“每个没结束的子线程一行、计划第几版、每条待办状态、最近一句进展”，但没有规定子线程顺序、待办顺序、事件编号的生成方式。
- 后果：同一状态在两次请求里可能因查询顺序不同而字节不同；重试时事件编号变化；外部内容与不同邻居一起遮盖时字节不同。
- 建议：状态板按 `(大事 id, 子线程创建序/id)` 固定排序；事件用全局稳定 id（inbox 行 id）；时间用固定时区和格式；把状态板渲染纳入 `check:prompt-prefix` 的逐字节测试。

**13. 压缩后把“状态板/她最近说过的话”放进开头，会把每轮会变的内容放到请求头。**
- 证据：`AGENTS.md:43`“每轮会变的内容只放在最后一条消息里”。方案 `main-context` 第 3 点说压缩时“把‘后台在办’的当前状态和她最近主动说过的话放进压缩后的开头”，而 `status board` 又每轮放在最后一条消息。
- 建议：压缩后的开头只放稳定快照和压缩摘要；会变的状态板仍只放最后一条；在 ADR 里写明压缩是唯一改头的例外。

**14. 提醒/事件失败兜底会与正常写入双写。**
- 证据：方案说“这次运行失败、超时或没给结果时，程序按原文写进主对话并按时推给你”。如果运行在超时后仍完成，或服务重启后恢复，兜底和运行各写一条，主人会看到两条提醒。`thread_messages` 没有可用来去重的业务键（`sqlite-thread-operations.ts:1145-1163` 只按自增 sequence 插入）。
- 建议：用提醒 occurrence id / inbox 行 id 生成确定的消息 id，写入前查重；兜底与正常运行共用同一个幂等写入口。加反向用例：运行超时后迟到完成，只出现一条提醒。

**15. 语音改成“外部内容”后，感知层仍按 `owner_spoken` 给高信任。**
- 证据：`packages/application/src/services/perception-extraction.ts:363-366` 把 `origin === "owner_spoken"` 的整段标成 `owner` 信任；`:766` 对 `owner_spoken` 走“可正式提交记忆”的分支。方案只改“是不是在对她说”的小判断，没有改感知记录的 `origin`。
- 后果：电视/旁人喊她的名字，虽然不再当主人消息，但抽取成记忆时仍可能按主人亲口说的高信任提交。
- 建议：语音命中名字后把感知 `origin` 改成外部来源（或增加“未经主人确认”的事实），并让记忆抽取不把 `owner_spoken` 当高信任。加反向用例：电视里的话不得产生正式记忆。

### 低

**16. 方案对 `think_inbox` 状态白名单的描述不准确。** 数据库状态列只有 `length(status) BETWEEN 1 AND 32`，没有值白名单（`20261115004401_think_inbox.sql:8`）；`finish` 的参数只认三种（`sqlite-think-inbox-operations.ts:261`），`SETTLED` 还含 `expired`（`:16`）。改的时候要区分“状态列”和“finish 入参”。

**17. `worth` 配置两端**：`strict-configuration.ts:1399` 的 `rejectUnknown(input, [...Object.keys(ranges), "worth"], field)` 和 `parseThinkWorth`（`:1410`）都要改，模板也要改。方案已在“还没核实”里提到，核对通过但没写进验收步骤。

**18. “一个工人”与“不同对话各跑各的”不矛盾。** Anthropic 原文的 “An inbox should only have one active worker at a time.” 是指避免同一 inbox 的重复消费，不是串行化所有对话。方案按对话分组并发是合理解释。

---

## 二、推测（需要核实）

- **A. 合并后的数据分类**：历史候选按 `VISIBLE_RANK` 过滤（`context-formation-service.ts:191-199`），但 trigger payload 没有看到分类校验。如果外部邮件是 sensitive/restricted，合并后可能以较低分类送进模型，或反过来把整条消息抬到受限导致主人消息也被挡。需要确认 trigger 的分类路径。
- **B. 审批暂停的运行如何从子线程恢复到主对话**：方案自己列为“没读完”。现有 `runs.status='awaiting_approval'`、`approval_requests` 和续跑路径需要逐段核对；“同意卡片出现在主对话”要改多少未核实。
- **C. 外部事件只存摘要、全文用工具打开时，工具是否重新做分类和外部标记**：否则后续写入可能用到未标记的外部内容。
- **D. 发邮件/花钱/删东西的“现有命令去重编号”是否真的覆盖外发邮件等副作用**：方案说“动作本身用现有命令的去重编号”，未核实邮件发送路径是否有幂等键。
- **E. “连续跑 N 次叫醒主对话”时子线程是否暂停**：如果不暂停，成本会继续增长，和愿景原则 8“超限即停下等待”冲突。
- **F. 3 个运行位在 4 核 8GB 上是否够**：方案自己列为未核实。
- **G. 用 `session.steer()` 插入的主人消息是否会在下一轮历史里重复**：Pi 原生历史和 `thread_messages` 两套记录如何对齐，未核实。

---

## 三、侧重检查

我按你给的侧重逐项查了这些路径：

- **错误路径**：运行失败/超时后重试、服务中途重启、批次重组、提醒兜底双写、审批暂停恢复。结论：提醒和外部事件缺少“确定消息 id + 写入查重”，存在双写风险（见中 14）；批次幂等键未定义（见中 9）。
- **不合规范或不可信的输入**：邮件/网页/语音注入。结论：方案把外部事件和主人消息合并，与 `ownerWords` 的读取条件冲突，可能让外部内容冒充主人意图（见高 2、高 3）；语音的 `owner_spoken` 信任没有同步改（见中 15）。
- **安全**：ADR 0278 的外部内容闸门、`owner_intent_confirmed`、审批卡片真实动作、语音改外部内容。结论：方向正确（语音改外部内容更安全，审批卡片按真实动作生成正确），但混合批次的 `run_source` 和 `ownerWords` 两处会削弱闸门。
- **资源耗尽**：去掉收件箱排队/每天上限、子线程不设次数上限、状态板/子线程数量无上限、单个工人。结论：方案承认与愿景原则 8 不一致并交给 Andy 决定，这是合规的；但“连续跑 N 次”只通知主对话、不暂停子线程，成本仍可能无界增长。建议加“硬成本/时间上限 → 暂停并问”，这不是次数上限。
- **不可撤销操作**：发送、花钱、删除。结论：“正在做”标记 + 命令去重方向正确，但只写在子线程一节，主对话处理外部事件时同样需要；另外“正在做但实际失败”的恢复没有定义。
- **规则文件、说明文档和代码一致性**：`AGENTS.md:43` 只追加规则、ADR 0164/0165、ADR 0277、ADR 0278、I-73 都已核对；`.agents/instructions/prompt-prefix.md` 在当前稀疏检出里不存在（未核实，只能以 `AGENTS.md` 摘要为准）；`web_push_feedback` 确实存在（`0061_web_push_feedback.sql`）；`decision_ledger.scenario` 放开为 `[a-z][a-z0-9_]*` 的说法正确（`20261114172143...:24-26`）；六个服务的“apps 下无引用”说法不准确（见中 11）。

---

## 四、核对通过的点

- Anthropic “Building always-on agents”（2026-11-13）原文确实有 “every source sends an event to an inbox, where a worker picks it up.”“An inbox should only have one active worker at a time.”“The worker should batch pending events together.”“For each ongoing task, the agent should keep a progress file”。方案引用准确。
- Anthropic 多智能体研究文章原文确实有 “Each subagent needs an objective, an output format, guidance on the tools and sources to use, and clear task boundaries.”“Currently, our lead agents execute subagents synchronously”，异步的“result coordination, state consistency, and error propagation”挑战也准确。
- Pi 的 `deliverAs: "steer"` 说明在 `docs/pi-development-guide.md:285` 确实存在。
- `web_push_feedback` 表存在（`0061_web_push_feedback.sql`），方案引用正确。
- `production-web-push.ts:28` 的 `DEFAULT_INTERVAL_MS = 10_000`、`compaction-prefix.ts:75` 的 `200_000`、配置模板的 `totalRuns: 3 / foregroundReserved: 1 / runMs: 300000` 都与方案一致。
- `production-task-proposals.ts:111` 的 `thread:proposal:${key}` 与方案前提 4 一致。

---

## 五、如果由我来定，我会怎样改这份方案

1. **先定“批次 = 一个来源”的硬约束**：主人消息批次和外部事件批次分开 run，不混合。这样 `run_source` 仍是单值，ADR 0278 的闸门不用改。若 Andy 坚持混合，就把 `run_source` 改成集合，并让所有带外部内容的写操作无条件 `ask_owner`。
2. **合并只用于同一来源的多条消息**（例如连发三条主人消息）。外部事件用独立的 `role='system'` 消息追加，绝不进入 `<owner-message>`，绝不进入 `ownerWords`。明确批次幂等键、消息 id、历史排除规则。
3. **工具集合按对话冻结，权限用 action gate 动态判定**。子线程创建时就把所有工具定义好，读/写由 gate 按出处和外部内容标记决定；权限提升不换工具，只换 gate 的判定。这样既安全又不破坏 KV 缓存。
4. **推送新增“主动消息”类型**，内容按消息 id 读取正文；子线程完成默认静默，只有主对话汇总后由她决定是否推；保留提醒/审批直推。
5. **决策记录新 kind 先过数据库约束**：用真实 SQLite 把每个新 kind/outcome 插一遍，把“推没推”放进 `outcome` 或 `inputs`，不要碰 `verdict`。
6. **子线程加硬成本/时间上限**（不是次数上限）：到限暂停并叫醒主对话问；状态板固定排序并限制条数。
7. **分步上线**：第 1 步先做“收件箱地基 + 主人消息（不合并外部）”，第 2 步子线程只读 + 计划，第 3 步权限/审批，第 4 步推送/决策记录，第 5 步外部事件/语音，第 6 步压缩评测。每步都加 `npm run check:prompt-prefix`、逐字节前缀测试、真实数据库新值插入测试。
8. **补反向用例**：连发三条不重复；邮件正文不能让 `owner_intent_confirmed` 为真；混合批次不得预授权写；子线程完成手机不响；运行超时后迟到完成只出现一条提醒；同一子线程连续两次“接着做”都能入队。

---

## 六、逐条回答必答问题

**1. 会不会改变模型已经见过的请求开头？发给模型的内容是不是仍然只在末尾追加，每轮会变的值是不是都在最后一条消息里？**

按现方案不能保证。多数新增内容（状态板、事件摘要、她的话）确实在末尾，但有四处会动到开头或历史：
- 子线程中途“换成上一行的权限”会改工具定义（高 4），直接违反“系统提示和工具按对话冻结”；
- 合并消息与历史去重冲突，会让同一段主人原话在历史里重复出现（高 1），这不是“只在末尾追加”的干净追加；
- 压缩时把状态板/她最近的话放进压缩后的开头（中 13），把每轮会变的内容放到了请求头；
- 外部事件如果以 owner 角色落库，会改变 `ownerWords` 的读取结果（高 3）。

每轮会变的值方面：方案只保证了“时间写具体时刻”，但没有保证状态板顺序、事件编号、待办顺序、最近进展的稳定性，也没有保证这些值只出现在最后一条消息。需要逐项固定排序和位置后才能回答“是”。

**2. 会不会让同一段文字在不同请求里变成不同的字节？**

会。已证实的三类：
- 状态板中子线程顺序、待办顺序、事件编号、`最近一句进展` 都没有规定稳定排序/格式（中 12）；
- egress 遮盖依赖上下文（ADR 0164 自己记载了这个冲突，`:124`），同一段外部内容与不同邻居一起出现时可能遮成不同字节；
- 重试时批次重组会改变事件编号和相邻内容（中 9）。
需要固定排序、全局稳定 id、固定时区/格式，并把状态板渲染纳入逐字节测试。

**3. 改动有没有对应的自动检查，反向用例是不是真的会失败？**

方案有不少正向/反向验收，但缺关键几类：
- 没有 `npm run check:prompt-prefix` 和逐字节前缀测试；
- 没有“合并后历史不重复”的测试；
- 没有“混合批次权限”的反向测试；
- 没有“真实数据库插入每个新值”的自动检查（只在“还没核实”末尾提了一句）；
- 没有“子线程完成不推送”和“她决定推时正文正确”的测试；
- 没有“外部内容不污染 ownerWords”的测试。
这些不补，“反向用例真的会失败”无法证明。

**4. 改动产生或修改的每个值，每一个使用它的地方都能接受吗？**

没有全部核对，而且已发现几处会被拒绝或无法表达：
- `decision_ledger` 新 kind：`scenario`/`verdict`/`outcome` 的 CHECK 和 FK（高 6）；
- `web_push_outbox.kind` 和 `#content` 只支持三种形状（高 5）；
- `think_inbox.finish` 只接受三种结局、唯一键会挡住“接着做”（中 7、中 8）；
- `triggers.source_type` 只能单值（高 2）；
- `threads.origin` 的多个消费者（中 10）；
- `strict-configuration` 的 `worth` 两端（低 17）。
方案只在“还没核实”末尾列了部分值，而且描述有误（`think_inbox` 状态白名单、六服务无引用）。需要逐个写清“谁产生、谁使用、两端怎么校验、哪道检查守着”，并加真实数据库插入测试。
