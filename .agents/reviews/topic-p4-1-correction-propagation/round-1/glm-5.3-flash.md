我先读关键文件来核实材料里的事实，再独立设计方案。
# P4-1 记忆纠正传播 — 独立方案

## 一、方案依赖的前提（读代码或来源证实的）

**P1 依据链只记录在整理变更上，且只有 reflect 真正“推出”新记忆。**
`docs/adr/0194-record-the-whole-basis-chain-of-a-memory-tidy-up.md:39-41`：“迁移 0084 新建 `memory_consolidation_change_basis`……按记忆编号建索引，供以后‘改一条记忆，由它推出的记忆跟着重审’反查”；材料事实 1 与 `packages/memory-engine/src/consolidation.ts:547-627`（`#reflect` 建新记忆，`basisMemoryIds` 记全部基础记忆）一致；merge/supersede/archive/hold 只修改已有记忆（`consolidation.ts:372-401`）。0084 里 `memory_consolidation_change_basis` 在 `memory_id` 上有索引（`0084_memory_consolidation_basis.sql:9-10`）。

**P2 读链接口只往上游走，没有反查。**
`packages/persistence-sqlite/src/sqlite-memory-consolidation-operations.ts:302-354`：`readBasisChain` 从一条记忆沿它自己的改动往 basis 走（“沿它最近一次未撤销的整理改动，一层层往依据里走”，ADR 0194:41）。反查下游目前不存在。

**P3 规则→记忆的对应只有一条直接边，规则来源记忆全部是 rule_set 直接写的主人原话，不是整理产物。**
`0087_rule_book_memory_link.sql:247`（`source_memory_id`）；`apps/agent-service/src/production-owner-rules.ts:414-458`（`#writeMemory` 用 `applyProposal` 直接建 `memory:rule:<key>`，不产生整理改动、不经整理）。因此“由记忆派生的硬规则”只能是“规则的来源记忆被改”，即 0087 触发器已覆盖的那一跳；**不存在**“上游记忆→推出记忆→规则”的间接边。

**P4 现有触发器只在“规则类记忆本身”被改时标 `needs_review`，且 `needs_review` 照常执行。**
`0087_rule_book_memory_link.sql:301-361`（条件：content_ref 变 / superseded_by 变 / 状态离开有效 / 分类不再是 rule；只命中 `status='active'` 的规则）；`packages/application/src/rules/rule-book.ts:14-16`：`ruleIsEnforced` 对 `active` 和 `needs_review` 都返回 true。

**P5 “会执行规则”的地方一共两处 SQL/代码，加一处可执行性判断。**
`rule-book.ts:14-16`（裁判）；`packages/persistence-sqlite/src/sqlite-proactive-operations.ts:242`（读设置的 SQL `status IN ('active','needs_review')`）；`packages/application/src/rules/rule-types.ts:300-310`（`enforceableOwnerRule` 只排除 `retired`）。另有列表过滤 `sqlite-owner-rule-operations.ts:88`。

**P6 规则状态、决策记录结果值都是数据库 CHECK 约束，改它们要重建表；决策记录类型 `rule_review` 现在只允许 `needs_review`。**
`0087:245,271`（`status IN ('active','needs_review','retired')`）；`0087:64-72`（`rule_review AND outcome='needs_review'`）；`packages/application/src/ports/decision-ledger.ts:57`（`rule_review: ["needs_review"]`）；ADR 0211 前提 5 引 SQLite 官方文档：改检查约束须新建表复制改名。

**P7 SQLite 触发器里不能用 WITH/递归 CTE。**
SQLite 官方文档（https://www.sqlite.org/lang_with.html ，"Limitations And Caveats"）："The WITH clause cannot be used within a CREATE TRIGGER." 所以“改一条记忆 → 传递闭包标下游”**不能**在一个触发器里用递归 CTE 直接算。

**P8 整理写入有唯一汇聚点，且记忆、变更、依据、决策记录同事务。**
`sqlite-memory-consolidation-operations.ts:36-112`（`insertConsolidationWrite` 在一个事务里写变更行 + 依据行 + 决策记录），ADR 0194 决定 2。要加任何派生边表，都应加在这里。

**P9 后台模型调用有统一出口，且“固定的在前、会变的在后”。**
`apps/agent-service/src/production-run-composition.ts:555-592`（`auxiliaryMemoryGeneration`：准入 + 预算走统一入口）；`packages/memory-engine/src/consolidation.ts:125-141`（`consolidationPrompt`：固定指令 → 数据 → 格式说明，无时间戳）；`.claude/rules/prompt-prefix.md:67`：“后台调用也是固定的在前、会变的在后”；`:35`（已发内容只追加）。

**P10 规则参数在入库前被规范化（折叠、去重、排序），比较可以做到逐字节确定。**
`packages/application/src/rules/rule-types.ts:71-87`（`entries`：foldText、去重、`sort()`）、`:109-115`（再次去重排序）；`parseOwnerRuleParameters:257-274` 统一口径。`production-owner-rules.ts:328-331` 的 `sameRule` 就是用规范化后 `JSON.stringify` 比较。

**P11 整理后台任务的节流与挂载模式。**
`apps/agent-service/src/production-memory-consolidation.ts:8`（`RETRY_AFTER_MS = 3_600_000`，每小时最多尝试一次）、`:63-86`（对话运行开始时 `start()`）；在 `production-run-composition.ts:540-549` 组装。

**P12 新提示词必须进目录且有黄金样例检查。**
`package.json:57`（`check:prompt-catalog` 跑 `prompt-catalog.unit.test.ts`、`prompt-wording.unit.test.ts` 等进 `npm run check`）；现有提示词形如 `packages/prompt-catalog/src/tools.ts:225-232`（`fixedPrompt` 带 id/purpose/usedBy/layer/text）。

**P13 决策记录有固定端口和类型清单。**
`decision-ledger.ts:30-58`、`:100-129`（`DecisionInputs` 是开放的可选字段对象，库约束只要求 JSON object，`0087:37`）。

**P14 记忆历史表的事件种类是约束死的。**
`0065_memory_history.sql:6`：`kind IN ('created','updated','reaffirmed','edited','restored')`；`memory_records.status` 也是约束死的（`0001_initial_product_schema.sql:398`）。

**P15 规则类记忆的正文是“原话＋说明”两行。**
`production-owner-rules.ts:522`（`text: \`${proposal.quote}\n${parsed.summary}\``）。重译应只用第一行原话——原话才是“立规则时主人说的话”。

## 二、方案

### 2.1 数据怎么存（迁移 0090，本任务独占改表窗口）

**0090 一张迁移做四件事**（沿用 0087 的重建手法；ADR 0211 前提 5）：

1. **新表 `memory_derivation_closure`（物化的派生闭包）**：`(owner_id, agent_id, ancestor_memory_id, descendant_memory_id, change_id)`，主键 `(ancestor, descendant, change_id)`，`change_id` 外键到 `memory_consolidation_changes(id) ON DELETE CASCADE`。每个 reflect 改动落库时，把“全部传递边”一次性算好写进去（见 2.3）。放闭包而不是每次现算，正是为了绕开 P7（触发器里不能递归）。
2. **新表 `memory_review_pending`（记忆待重审标记）**：`(owner_id, agent_id, memory_id, source_memory_id, reason, marked_at, cleared_at)`，部分唯一索引 `(memory_id) WHERE cleared_at IS NULL`。不动 `memory_records.status`（P14），正文一个字不改（目标约束）。
3. **重建 `rule_book_rules` / `rule_book_history`**：状态加 `'suspended'`（重检不通过 → 挂起不执行）；`rule_book_rules` 加 `recheck_attempts INTEGER NOT NULL DEFAULT 0`、`recheck_after TEXT`（退避）。这两个列不进 history，0087 的历史触发器按列名显式复制，需在新迁移里原样重建。
4. **重建 `decision_ledger` 及七张子表**：`rule_review` 的 outcome 放宽为 `IN ('needs_review','recheck_unchanged','recheck_suspended','recheck_removed','recheck_failed')`。inputs 是自由 JSON（P13），建议参数放 `inputs.ruleSuggestion`，不用改表结构。

### 2.2 何时标记（上游改动的那一刻，触发器内同事务）

在 0090 里加两个触发器，条件**逐字复用** 0087 的 `memory_rule_needs_review` 条件（content_ref 变 / superseded_by 变 / 状态离开有效 / 分类变，删除触发器同理）：

- `memory_derived_needs_review`：把 `memory_derivation_closure` 里 `ancestor = OLD/NEW.id` 的每个 `descendant`（join `memory_consolidation_changes` 且 `undone_at IS NULL`）`INSERT OR IGNORE` 进 `memory_review_pending`，时间取 `NEW.updated_at`（删除触发器取 `now`，与 0087 同款处理）。
- 上游被治理删除时 `closure` 行级联消失，所以删除触发器必须是 `BEFORE DELETE`（0087 已是这个顺序）。
- 自愈：另一对触发器在“该记忆自身 content_ref 被改”时把它的 open 行 `cleared_at` 置上（主人改了下游记忆 = 重审完成）。恢复/撤销整理不自动清除，由主人处置。

### 2.3 怎么往下游找（闭包只在写入时维护一次）

`insertConsolidationWrite`（P8）里，当 `action='reflect'` 时追加闭包写入（同事务，不满足就整笔失败，延续 ADR 0194 决定 4 的取向）：

- 直边：每条 basis → 新记忆 id。
- 传递边：`INSERT OR IGNORE ... SELECT 传递端点` —— 对每个 basis B，取 closure 中所有 `descendant = B` 的 `ancestor`（含 B 自身），连到新记忆。全程 `INSERT...SELECT` + JOIN，**不用 WITH**（P7），闭包只增不改，维护是平凡的。
- merge/supersede/archive/hold **不产生闭包边**：它们不“推出”内容（P1）；被合并归档的记忆本来就不是当前版本，标它重审只会制造噪音。supersede 的取代关系已存在 `attributes.supersededBy`，页面本来就显示“已被取代”，不再重标。
- 迁移回填：按 `created_at` 升序重放既有 reflect 改动建闭包（同 0084 按 created_at 回填的思路）。
- 已撤销的 reflect：闭包边保留（`change_id` 在边上），传播时只 join `undone_at IS NULL` 过滤**直边**；经撤销中转的传递边**仍然传播**（宁可多标，方向安全；被撤销的 reflect 记忆本身已归档，UI 过滤掉）。

### 2.4 规则重检怎么跑、何时跑

主人已定“重译”方式，落地如下：

- **新增提示词** `rule.recheck`（`packages/prompt-catalog/src/background.ts`，`fixedPrompt`，layer `background`）：指令段固定，内容为“把下面这条主人原话重新译成规则参数，规则类型有……，输出 JSON {type, params, summary}；原话不再表达一条一直有效的要求时输出 {type:\"soft\"}”——即复用 `TOOL_RULE_SET`（tools.ts:231）里关于类型和参数的同一套说明，满足“用和立规则时同样的说明”。
- **输入只放原话**：来源记忆正文第一行（P15），作为变的数据放在指令之后；**不放时间戳**（后台单发调用不需要，少一个每次都变的值，符合 prompt-prefix 第 15 条）。
- **统一出口**：新服务 `RuleRecheckService`，经 `auxiliaryMemoryGeneration`（P9）以 purpose `rule-recheck` 走准入和预算；模型固定 DeepSeek V4.1 Flash 一档（花钱约束）。
- **何时跑**：沿用 P11 的挂载点——对话运行开始时和整理并排触发一个 `ProductionRuleRecheck` 扫描（每小时节流）；另外在邮件检查读取规则手册之前顺手跑一次同一扫描（重检结果直接影响下一次邮件判断，等对话开始可能隔太久）。⚠️ 邮件检查的组合点我未核实（见“推测”），需要实施时确认挂载位置。
- **比较与处置**（全部程序侧，模型输出先过 `parseOwnerRuleParameters` 再比较，P10）：
  - `type`+`params` 与现参数相同 → `setStatus('active', reason='recheck_unchanged')`（`sqlite-owner-rule-operations.ts:171-174` 现在只认 active/retired 和两种 reason，要放开）；
  - type 或 params 变了 → `status='suspended'`，写 `rule_review`/`recheck_suspended` 决策记录，`inputs.ruleSuggestion = {type, params, summary}`（待确认列表的建议值来源）；
  - 模型回 “soft”（原话不再是一直有效的要求）或来源记忆已不是 active 的 rule 类 → `status='suspended'`，`recheck_removed`，等主人确认（目标约束：“改成‘不用了’就挂起等主人确认”）；
  - 模型调用失败 / 输出解析失败 → **保持 `needs_review`（照常执行）**，`recheck_attempts+1`、`recheck_after` 指数退避，只进待确认列表；上限后停止重试，留给主人。
  - `suspended` 不被 `ruleIsEnforced`（rule-book.ts:14）、设置 SQL（proactive-operations.ts:242）、`enforceableOwnerRule`（rule-types.ts:304）放行——三处都要改（P5，这是 I-73 教训的核心：生产端和消费端成对改）。

### 2.5 挂起与恢复

- 挂起 = `status='suspended'`，修订号 +1，写 history（`change_reason='recheck_changed'/'recheck_removed'`），决策记录同事务（沿用 0087 触发器的三段式写法，但重检由服务写、不走触发器——触发器里做不了模型调用）。
- 恢复路径两条：① 重检判定未变 → 自动 `active`；② 主人在待确认列表点“按建议生效” → 扩展 `memory.rule.respond` 加 action `apply_suggestion`：`parseOwnerRuleParameters` 重新校验建议参数 → 新增端口方法 `updateParameters`（写 parameters + `setStatus('active', 'owner_confirmed')`，同事务写 history）；主人点“不用了” → 走现有 `undo`（retired）。`reconfirm` 现有语义（原样重存不算重审）保留。

### 2.6 待确认列表

- 扩展 `memory.overview.snapshot` 加 `review` 段：`pendingMemories`（来自 `memory_review_pending`，带上游正文与下游正文对照，按 `marked_at, memory_id` 排序——顺序确定性是 prompt-prefix 第 10 条的纪律，页面同理）和 `suspendedRules`（来自 `rule_book_rules` join 决策记录里的 `ruleSuggestion`）。
- 不加聊天工具、不改系统提示（避免工具集合变化引发老对话换新，prompt-prefix 第 6/7 条；主人从记忆页操作，符合“用户不会写代码、尽量不人工介入”——待确认列表本身就是唯一必要的人工介入点）。

### 2.7 决策记录

规则侧每次动作一条 `rule_review`：标待重审（已有，0087 触发器）、重检未变（`recheck_unchanged`）、挂起（`recheck_suspended`，inputs 带 ruleSuggestion）、判移除（`recheck_removed`）、失败（`recheck_failed`，无建议）。记忆侧不新增记录类型（目标只要求规则侧留记录；`memory_review_pending` 的标记/清除本身有表可查）。

### 2.8 测试怎么证明“做到什么算完”（全部进 `npm run check`，带反向用例）

放在新脚本 `check:rule-propagation`（或并入 `check:rule-registry`）+ `test/integration/`：

1. **三层链**：A --reflect--> B --reflect--> C，改 A ⇒ `memory_review_pending` 同时有 B、C；merge 归档的 D 不在列。
2. **无关不受影响**：同一次整理里另一条无关联记忆 E 不被标。
3. **规则挂起**：改规则来源记忆原话（例：把“isa.go.jp 相关邮件必须通知”改成“出入国在留管理庁……”）⇒ 触发器标 `needs_review` → 扫描调用（桩模型返回新 params）⇒ `suspended`、决策记录带建议、邮件检查读不到这条规则（`proactive-operations` 路径断言）；反向用例：把 `enforceableOwnerRule`/`ruleIsEnforced` 对 `suspended` 的排除删掉 ⇒ 用例失败。
4. **自动恢复**：桩返回原参数 ⇒ 回 `active`；反向：把比较改成永远不等 ⇒ 恢复用例失败。
5. **失败路径**：桩 503 ⇒ 仍是 `needs_review` 且 `ruleIsEnforced` 为真、列表有它；退避后重试。
6. **触发器完整**：直接 `UPDATE memory_records`/`DELETE`（绕过服务层，模拟治理删除）⇒ 传播仍发生；反向：删掉触发器 ⇒ 失败。
7. **闭包一致性**：`insertConsolidationWrite` 事务里去掉闭包写入 ⇒ 整链用例失败（对应 ADR 0194 的门槛风格）。
8. **提示词登记**：新 `rule.recheck` 不在目录 ⇒ `check:prompt-catalog` 失败（现有门槛，P12）。

## 三、考虑过但不选的做法

- **触发器里用递归 CTE 算下游**：SQLite 明文禁止（P7），否。
- **在 `DurableMemoryService`/网关命令层挂钩传播**：写入口不止一个，治理删除、撤销整理直接改表（ADR 0211 前提 3、放弃的做法原话“治理删除和撤销整理绕过这个服务直接改表，会漏”）。标记必须在触发器里；只有**重检**（需要模型）放服务层，重检漏掉的由周期扫描兜底。
- **给 `memory_records` 加 `needs_review` 状态**：要重建最核心的表，且 `tentative` 已被 hold 占用语义；独立小表可级联、可清除、不牵动所有读路径。
- **沿 readBasisChain 反向逐层查询（每层一次 SELECT）**：应用层循环传播不能保证和改记忆同事务，且每层一次查询在触发器里做不了（P7 同因）。
- **“检查参数是否还出现在正文里”**：主人已因误挂起否决（参数是扩写变体，如 isa.go.jp）。
- **重检时给模型看整条记忆（原话+summary）**：summary 是立规则时的扩写，会让“重译原话”变成“抄 summary”，比不出真变化；只给第一行原话。
- **重检结果直接改规则参数自动生效**：违背主人定下的“类型或参数变了就挂起，主人点头后按新参数生效”。
- **挂起复用 `retired`**：retired 是主人主动撤销的终态，混用会让撤销语义和自动挂起分不清，也丢掉“待确认列表里区分‘等确认’和‘已撤销’”。

## 四、风险与反例

- **重译模型不稳定**：同一原话两次译出不同 params（evals 里 DeepSeek 15/15，GLM 14/15，ADR 0213:100）——后果是把“其实没变”挂起等主人，方向安全但会烦人；反例：主人只改了错别字，规则被挂起。缓解：比较前走同一规范化（P10）；仍是主要噪音来源，需要主人拍板接受度。
- **只重译原话丢上下文**：主人后来又说“再加一条 xxx”改的是行为不是原话，重译不会反映——这是本方案的边界：重检只回答“这条原话现在译成什么规则”，不追踪后续口头修改；这类情况最终由主人重立规则覆盖（rule_set 同参数已存在时会走 reconfirm）。
- **闭包膨胀**：reflect 每天 ≤3 条（`MAXIMUM_INSIGHTS`），边数上限可控；但 `closure` 无限增长，永不清理——反例：几年后回填/重建变慢。可在后续清理方案（prompt-prefix 第 14 条同类）里处理，本次不做但要写明。
- **传播过宽**：撤销中转 reflect 后仍向更下游传播（2.3 的决定），会标到“严格说已不算派生”的记忆；宁可多标符合“记忆可靠性 > 主动性”排序。
- **挂载点遗漏**：若邮件检查路径实际不经过 `production-run-composition`，扫描只在对话开始时跑，重检可能滞后数天（规则照常执行，无害但拖）。⚠️ 未核实，实施第一步先确认。
- **迁移规模**：0090 一次重建 9 张表（0087 先例），不可逆；回退靠快照（ADR 0211:89 已写明先例）。

## 五、需要人拍板的取舍

1. **`suspended` 作为新状态**（我的推荐）vs 挂起期间也照常执行、只在列表里显示——前者更符合主人本次定下的“不通过的挂起（不执行）”，但推翻了 ADR 0211 决定 2 “待重审的规则照常执行”的一半语义，要写 ADR 修订。
2. **merge/supersede/hold 不传播**（只沿 reflect 推导传播）——如果主人想要“被合并的记忆在保留方被改后也重审”，传播面会大很多。
3. **撤销中转仍向下游传播**（宁多勿漏）vs 严格按未撤销链。
4. **重检只在对话开始 + 邮件检查前扫** vs 加一个独立定时器（更及时，多一处常驻逻辑）。

## 六、「读代码证实的」与「推测」分开

**证实**：第一节 P1–P15 全部（文件:行已附）；`auxiliaryMemoryGeneration` 的预算账户复用 `thread-title`（production-run-composition.ts:571）；`setStatus` 现拒绝非 active/retired 与非 owner 理由（sqlite-owner-rule-operations.ts:171-174）；来源记忆正文两行结构（production-owner-rules.ts:522）。

**推测 / 未核实**：邮件检查是否经过 `production-run-composition`（决定 2.4 扫描挂载点）；后台辅助调用是否套用出口遮盖（我按“与整理同路径、同样处理”设计，未读 memoryCaptureOptions.generate 的实现）；control-center 里 `suspended` 状态的 i18n 和 `check:locale` 的具体要求；`memory.correct` 内部是否总写 `memory_history_events`（不影响本方案，清除触发器只看 content_ref）。

## 七、必答问题逐条

**1. 会不会改变模型已经见过的请求开头？** 不会。对话路径零改动：不加工具、不改系统提示和历史，待重审标记只存在于数据库和网页。唯一的新模型调用 `rule.recheck` 是一次性后台单发调用（与整理、标题同类，P9），它的“请求开头”就是自己的固定指令段，每次调用独立构造：固定指令在前、原话数据在后、无时间戳，不存在跨轮复用和改写已发内容的问题；“每轮会变的值都在最后一条消息里”退化为“整次调用的可变部分只有那一段数据”。依据：`.claude/rules/prompt-prefix.md:27-29`（固定在前会变在后）、`:35`（只追加）、`:67`（后台调用固定前变后）。

**2. 会不会让同一段文字变成不同字节？** 不会。请求里嵌入的规则参数经 `parseOwnerRuleParameters` 规范化（去重、排序、全半角折叠，rule-types.ts:71-116），JSON 以固定键序构造；记忆正文按 payload 原样字节读取；不带任何时间字段；比较在程序侧对规范化结构做，不依赖模型输出的原始字节。遮盖侧：本方案不新增会话内容、不改遮盖规则（若辅助调用确认不走遮盖，则连这个依赖也不存在——见“未核实”）。

**3. 有没有自动检查、反向用例真会失败？** 有，见 2.8：8 组用例进 `npm run check`，每组写明删掉哪段实现会让它失败（触发器、闭包写入、三处 `suspended` 执行排除、规范化比较、提示词登记各对应一个反向用例）。提示词登记由现有 `check:prompt-catalog` 把守（package.json:57）。

**4. 每个新值的两端核对**：
- `suspended`：产生（重检服务、迁移约束）↔ 消费（`ruleIsEnforced` rule-book.ts:14、设置 SQL proactive-operations.ts:242、`enforceableOwnerRule` rule-types.ts:304、列表 SQL sqlite-owner-rule-operations.ts:88、history 触发器与状态检查 0087:271、`memory.rules.read` 与 control-center 显示、`reconfirm`/`undo` 状态机）——至少 6 处消费端必须同批改，这正是 I-73（docs/incidents-and-gates.md:112：“清单里的 id 能通过后端校验吗”）的教训。
- `rule_review` 新 outcome：产生（重检服务写入）↔ 消费（DB CHECK 0087:64-72、`DECISION_OUTCOMES` decision-ledger.ts:57、校准/导出枚举、决策抽屉 UI）。
- `memory_derivation_closure` / `memory_review_pending`：产生（`insertConsolidationWrite` 同事务 + 触发器）↔ 消费（传播触发器、`memory.overview.snapshot` 的 review 段、网页契约 `gateway-contracts`）。
- 建议 `ruleSuggestion`（inputs JSON）：产生（重检）↔ 消费（`apply_suggestion` 命令、决策抽屉），应用前必须重新过 `writableRuleType` + `parseOwnerRuleParameters` + 上限 16384 校验（与 rule_set 同一关卡，不能因为来自数据库就免检）。
- 新提示词 `rule.recheck`：产生（目录登记）↔ 消费（重检服务、usedBy、黄金样例）。
- 迁移 0090：产生（重建表）↔ 消费（0087 全部触发器与历史只追加触发器需在新表上原样重建，迁移号连续且本任务独占改表窗口）。
