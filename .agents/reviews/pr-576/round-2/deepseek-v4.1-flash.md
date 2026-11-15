查过的范围：本轮增量 `c66af3ac..7ff6d134` 中属于 PR 576 的实际改动只有 7 个文件：`production-task-proposals.ts`、控制中心三份 i18n、`task-proposals.test.ts`、ADR 0278（其余是 main 合并带入的其他 PR 改动，未重读）。同 PR 的 `action-rules.ts`、`owner-scope-authorization.ts`、`sqlite-thread-operations.ts` 等旧代码只在证据需要时跟读。未运行测试，以下判断来自读代码。

上一轮意见核对：意见 4（控制中心三语说明）已改好；意见 5 的新提议效果句已改准，但旧待定提议未处理；意见 1 的行为没改，只是效果句和 ADR 后果写明了设备动作不放宽；意见 3 删掉了“审批卡显示事实文字”的承诺，但文字仍没有生产界面显示；意见 6 只改了一半，`amends` 仍为空，“撤销”表述仍在。

### 1. 中：反向用例的“退回待定”不是 task.run 的真实路径，ADR 的失败路径说法与代码/架构文档矛盾

- 文件：`test/integration/task-proposals.test.ts:190-193`；`apps/agent-service/src/production-proposals.ts:674-694, 804-807, 837-842`；`docs/adr/0278-tasks-the-owner-agreed-to-ask-before-writing-after-external-content.md:73, 76`；`docs/architecture-v0.1.md:435`
- 问题：作者说测试改用了“真实会出现的退回待定”，但 `task.run` 是 action 处理方，执行失败后提议状态仍是 `accepted`，不会退回 `pending`。测试直接改库造出的 `pending + exec_status=succeeded` 状态在生产里不会出现；ADR 的“开运行失败退回待定”与架构文档的“开运行失败时提议标成执行失败，同一个提议不会再开第二次”直接矛盾。
- 证据：
  - `production-task-proposals.ts:118-119`：`const handler: ProposalActionHandler = { kind: "action",`
  - `production-proposals.ts:804-807`：`if (isAction(handler)) { ... return await this.#adoptAction(row, handler, expected, responder);`
  - `production-proposals.ts:674-694`：执行失败时 `await store.moveExecution({ ... from: "running", to: "failed", ... })` 后抛出 `PROPOSAL_EXECUTION_FAILED`，没有把 `status` 从 `accepted` 改回 `pending`。
  - `production-proposals.ts:837-842` 的 `from: "accepted", to: "pending"` 只在非 action 分支里。
  - `sqlite-owner-proposal-operations.ts:356-359` 的 `claim` 把状态置为 `accepted`、`exec_status='running'`；`sqlite-owner-proposal-operations.ts:157` 对已执行的提议直接返回 `closed`，不会再打开。
  - 测试先在 `task-proposals.test.ts:156` 断言 `execution: "succeeded"`，再在 `:191` 执行 `UPDATE owner_proposals SET status = 'pending', decided_at = NULL`，留下 `pending + succeeded`。
  - ADR `:73` 写“例如开运行失败退回待定”；架构文档 `docs/architecture-v0.1.md:435` 写“开运行失败时提议标成执行失败”。
- 建议：要么在 ADR 里删掉“退回待定”，明确 `task.run` 同意后没有撤销入口、执行失败仍保持“已同意”，标记会一直保留；要么实现真实的撤销/失败退回路径，并通过存储层接口测试，而不是在测试里直接改 SQL。若保留反向用例，应测试一个代码真能产生的状态，并补一条 `accepted + exec_status=failed` 的用例。

### 2. 低：ADR 仍未记 `amends`，且“撤销”表述仍留在决定、测试和架构文档里

- 文件：`docs/adr/0278-tasks-the-owner-agreed-to-ask-before-writing-after-external-content.md:7, 46, 76`；`docs/architecture-v0.1.md:435`；`apps/agent-service/src/production-proposals.ts:449`
- 问题：作者只加了正文里的“ADR 0257 决定 3 定的”，frontmatter 仍是 `amends: ""`；决定 1 和测试说明仍写“提议被撤销”，但代码里没有把 owner proposal 写成 `withdrawn` 的路径。上一轮意见 6 没有完全改好。
- 证据：
  - ADR `:7`：`amends: ""`
  - ADR `:46`：`提议被撤销或不是“已同意”，就不带。`
  - ADR `:76`：`（同意后来源带标记，撤销后不带）。`
  - ADR `:73` 自己又写：`` `task.run` 提议没有撤销入口 ``
  - `production-proposals.ts:449` 只读取 `if (row.status === "withdrawn")`，没有写入路径；全仓库搜索也没有 `to: "withdrawn"` 的 owner proposal 写入。
  - 架构文档 `:435` 同时写“提议被撤销或不是已同意，就不带”和“它没有撤销”。
- 建议：若这份 ADR 确实部分修正 ADR 0257 决定 3，按仓库惯例把 `amends` 写成 `docs/adr/0257-consequential-tool-calls-go-through-one-authorization-exit.md`；把所有“撤销”改成“当前没有撤销入口；一旦不是已同意（目前只能靠数据变更）才不带”，并同步架构文档和测试标题。

### 3. 低：已存在的待定 task.run 提议不会更新旧效果句

- 文件：`apps/agent-service/src/production-task-proposals.ts:255-256`；`packages/persistence-sqlite/src/sqlite-owner-proposal-operations.ts:157-186`；`apps/agent-service/src/production-proposals.ts:437-439`；`apps/agent-service/src/production-proposal-control.ts:60`
- 问题：本次只改了新提议写入的效果句。旧代码已经建好、仍在待定的 `task.run` 提议，库里存的仍是旧句“任何写入也都先问你”；只有再次提议且状态仍是 `pending` 时才会刷新 `effect`。上一轮意见 5 的后半句没有处理。
- 证据：
  - 新句：`"新开一个对话……读过网页、邮件这类外部内容之后，写入也要先问你，日历、联系人、家居这类设备操作则不做"`。
  - 旧句（diff 中）：`"……读过网页、邮件这类外部内容之后，任何写入也都先问你"`。
  - `sqlite-owner-proposal-operations.ts:158-166`：只有 `existing?.status === "pending"` 才 `UPDATE owner_proposals SET ... effect = ? ...`。
  - `production-proposals.ts:437-439`：`if (outcome === "closed") { await drop(); return; }`，已接受的提议不会被刷新。
  - `production-proposal-control.ts:60`：`effect: shownText(proposal.effect, 200)`，直接显示库里存的值。
- 建议：加一次性数据迁移，或读取时对 `task.run` 的旧效果句做确定性的替换；至少写一条测试覆盖“旧待定提议显示新句”。若不做迁移，应在交付说明里写明旧提议会继续显示旧文案、到期后消失。

### 4. 低：ADR 说治理页能看到新事实，但页面只显示原始代码，不显示引用的三语文字

- 文件：`docs/adr/0278-tasks-the-owner-agreed-to-ask-before-writing-after-external-content.md:74`；`apps/control-center/src/governance-control-center.tsx:357-358`；`packages/application/src/services/policy-fact-registry.ts:75-82`
- 问题：ADR 引用了事实文字“这一轮是你同意过的一件任务”，并说“控制中心的治理页能看到”。实际上治理页渲染的是 `deterministicFactCodes` 的原始代码，`POLICY_FACT_REGISTRY` 里的三语标签只被测试读取，生产代码里没有使用。上一轮意见 3 的“事实文字没有生产界面显示”仍然成立，只是 ADR 不再承诺审批卡显示它。
- 证据：
  - `governance-control-center.tsx:357-358`：`label={message("governance.deterministicFacts")}`，`value={<Values values={snapshot.payload.intent.deterministicFactCodes} />}`。
  - `policy-fact-registry.ts:75-82` 有 `zh: "这一轮是你同意过的一件任务"` 等标签。
  - 全仓库搜索 `POLICY_FACT_REGISTRY` 只在 `packages/application/test/policy-fact-registry.unit.test.ts` 和 `test/tooling/policy-fact-codes.test.ts` 使用；生产 UI 不读标签。
  - `tool-action-registry.test.ts:677` 只断言审批 JSON 含 `run_source_owner_approved_task` 代码。
- 建议：在治理页把事实代码映射成当前语言的标签，或把 ADR 改成“治理页能看到原始事实代码 `run_source_owner_approved_task`”，不要暗示三语文字已经显示。

### 5. 低：ADR 背景和决定 3 仍把“直接拒绝→问主人”说得覆盖所有写操作，设备动作实际仍拒绝

- 文件：`docs/adr/0278-tasks-the-owner-agreed-to-ask-before-writing-after-external-content.md:30, 48, 51, 75`；`apps/control-center/src/i18n/resources/zh-CN.ts:884`（en/ja 同）；`apps/agent-service/src/production-device-action-authorization.ts:59-60`；`packages/application/src/services/device-action-registry.ts:503, 530, 566, 604, 701`
- 问题：ADR 后果 4 已经写明设备动作不放宽，代码也确实是硬拒绝；但背景和决定 3 仍说“写操作由直接拒绝改成要主人批准”“每一个都要主人批准”，对日历、联系人、家居控制这些设备动作不成立。控制中心那条规则的例外句“你同意过的任务除外，改为弹卡片问你”如果被当成一般规则读，也会误导设备动作的用户。
- 证据：
  - ADR `:30`：`写操作由“直接拒绝”改成“要主人批准”，每个有后果的动作仍要主人点一下`
  - ADR `:48`：`同意过的任务读到外部内容后，写操作由 askAfterExternalContent 接手，每一个都要主人批准`
  - ADR `:75` 才补上：`设备动作里不允许外部内容引出的那些（例如日历、联系人、家居），读过外部内容后仍直接拒绝`
  - `production-device-action-authorization.ts:59-60`：`if (!intent.untrustedOriginAllowed && intent.readUntrustedContent) return { decision: "deny", ... }`
  - `device-action-registry.ts:503, 530, 566, 604, 701`：`calendar.create`、`calendar.delete`、`calendar.update`、`contact.update`、`home.control` 都是 `untrustedOriginAllowed: false`
  - 控制中心 `zh-CN.ts:884`：`……你同意过的任务除外，改为弹卡片问你。`
- 建议：在 ADR 背景和决定 3 里加上“除设备动作里禁止由外部内容引出的那些外”，或把“写操作”限定为“非设备写操作”；控制中心规则的例外句也加上“改规则这类动作”，避免用户以为设备动作会弹卡。

## 侧重检查

- 错误路径：重点查了 `task.run` 的领取、执行、失败、重试和状态回退。`#adoptAction` 失败只改 `exec_status`，不回 `status`；`accepted→pending` 只在非 action 分支。结论见意见 1。
- 不可信输入/解析：本次没有新增外部输入解析。`taskData` 的文本长度/依据校验未变；效果句是常量；i18n 是静态资源，新增分支没有新占位符或花括号；未发现新的注入面。
- 安全：核对了 `ownerApprovedTask` 的生成和使用（`owner-scope-authorization.ts:179, 260`）、规则条件（`action-rules.ts:245-249`）和设备动作的拒绝条件。带标记的运行不会被自动标成外部内容；真实读到网页后，`calendar/contact/home.control` 因 `untrustedOriginAllowed: false` 仍直接拒绝，效果句和 ADR 后果 4 与代码一致。
- 资源耗尽/不可撤销：效果句约 86 个字符，低于 `sentence(...,200)`、数据库 `CHECK 1..200`、控制中心 `shownText(...,200)` 和网关 `boundedString(200)`；没有新增循环或大对象。`task.run` 的 `undo` 仍直接抛 `TASK_RUN_NOT_UNDOABLE`，不可撤销；ADR 后果已承认没有撤销入口，但决定/测试仍用“撤销”措辞，见意见 2。
- 规则、说明文档与代码一致性：控制中心三种语言的拒绝规则说明已补例外；规则 `revision: 2` 与 ADR 决定 3 一致；`append` 事实代码有中文/英文/日文标签，但生产 UI 只显示代码；ADR 的失败回退例子与架构文档、代码矛盾，见意见 1、4、5。

## 必答问题

1. **不会改变模型已经见过的请求开头。** 本次增量只改提议效果句、控制中心 i18n、测试和 ADR，这些都不进模型请求。任务运行发给模型的第一条消息由 `taskRunMessage` 生成（`production-task-proposals.ts:81-93`），本次未改；其中 `decidedAt`、`proposalId` 是新对话第一条消息里的值，不是同一对话前缀的变化。没有新增系统提示、工具定义、历史消息或遮盖结果。结论：发给模型的内容仍然只在末尾追加；每轮会变的值仍在最后一条消息（对本增量而言不涉及）。

2. **不会让同一段文字在不同请求里变成不同字节。** 新效果句是静态字面量；三份 i18n 是静态资源；测试 SQL 和 ADR 是静态内容；没有依赖前后文的遮盖、时间字段或无序集合。唯一的新旧差异是旧待定提议库里仍存旧效果句（数据新旧不同），不是同一段文字在不同请求里被重新遮盖或序列化。效果句进入提议指纹后只会确定性地产生一个新指纹。

3. **有部分自动检查，但反向用例没有覆盖真实生命周期。** `task-proposals.test.ts:190-193` 直接改库把 `task.run` 置成 `pending`，能证明 `readRunExecutionSource` 检查了 `status='accepted'`（若去掉该条件测试会失败），但 `task.run` 是 action 处理方，真实执行失败只把 `exec_status` 置 `failed`，`status` 仍是 `accepted`，所以这个 `pending` 状态不是生产能出现的。新效果句、三语规则说明、旧待定提议迁移都没有内容测试；`owner-rules.unit.test.ts:398-403` 只断言规则名称，不断言 `rules.builtIn.when` 的新文字。作者称已跑 `check:locale`、`check:glossary`、`tsc`，我未运行。

4. **逐个核对改动产生或修改的值：**
   - `effect`：产生于 `production-task-proposals.ts:255-256`；`ProductionProposalBox.propose` 用 `sentence(input.effect, 200)` 校验（`production-proposals.ts:381`）；DB `CHECK (length(effect) BETWEEN 1 AND 200)`（`20261114151010_owner_proposals.sql:7`）；控制中心 `shownText(proposal.effect, 200)`（`production-proposal-control.ts:60`）；网关 `effect: boundedString(200)`（`contracts-v2.ts:2435`）。新句约 86 个字符，两端都能接受。旧待定提议不刷新，见意见 3。
   - 三份 i18n 的 `rules.builtIn.when`：新增文字在 ICU `select` 分支内，没有新增占位符、花括号或 `#`；现有 `check:locale`/`check:glossary` 和 ICU 解析应能接受（未运行）。没有测试锁定文字内容。
   - 测试的 `status='pending'`：满足数据库 `CHECK ((status = 'pending') = (decided_at IS NULL))`（`20261114151010_owner_proposals.sql:24`），`pending` 也是合法状态；但“已成功执行的 task.run 退回 pending”在语义上不可达，见意见 1。
   - ADR frontmatter `amends`：仓库里没有找到校验 `amends` 的自动检查；空值能通过，但与部分修正 ADR 0257 的惯例不一致，见意见 2。
   - 新事实 `run_source_owner_approved_task`：三语标签在 `policy-fact-registry.ts:75-82`，生产消费端是动作意图和治理页的 `deterministicFactCodes`（`governance-gateway-adapter.ts:427`、`governance-control-center.tsx:357-358`）；测试断言审批 JSON 含代码（`tool-action-registry.test.ts:677`）。代码两端一致，但标签文字没有生产消费者，见意见 4。
   - 规则 `revision: 2` 与条件：`action-rules.ts:245-249` 与 ADR 决定 3 一致；`owner-scope-authorization.ts:179` 产生事实、`:260` 使用事实，两端一致。
