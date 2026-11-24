---
status: superseded
document_type: adr
decision_status: superseded
supersedes: ""
superseded_by: "docs/adr/0285-one-main-thread-subthreads-and-one-inbox.md"
amends: ""
date: "2026-11-15"
---

# ADR 0274：新知道的事都走同一个“想一想”入口，先问值不值得，再带工具想

<a id="contents"></a>

## 阅读导航

- [背景](#context)
- [前提](#premises)
- [决定](#decision)
- [业界怎么做](#industry)
- [放弃的做法](#options)
- [后果](#consequences)

<a id="context"></a>

## 背景

“主动提议下一步”的提议箱已经能存提议、让主人采纳、执行确定动作（改提醒时间、新建提醒）和开一次“去办一件事”的运行（[ADR 0272](0272-owner-proposals-join-the-data-export-format-v4.md) 之前的 PR 520、533、534）。缺的是“谁来提议”：Himawari 新知道一件事（一封邮件、一条新存下的记忆、一个提醒）时，要有一个统一的地方判断“要不要主动对主人说一句”。如果每个来源各写一套判断和提议代码，来源一多就按场景堆规则。这个决定给出一个入口：来源只往入口里写一条记录，入口负责去重、限量、判断和想。

Andy 2026-11-15 的答复（经协调者转来）：同意新增后台模型调用；第一版要带工具，需要上网就去查；这里按方案线程的建议来，复核都同意。

[返回阅读导航](#contents)

<a id="premises"></a>

## 前提

1. 提议箱已有两类处理方，动作类处理方有核对、领取、执行、读回、撤销五步：`apps/agent-service/src/production-proposals.ts` 的 `ProposalActionHandler`（接口里的 `verify`、`execute`、`readBack`、`undo`）。
2. 同意后开的运行记成 `external_event`：`apps/agent-service/src/production-task-proposals.ts` 的 `execute` 调 `admitOwnerMessage` 时传 `triggerSource: "external_event"`（PR 534）。
3. 触发表的来源只允许三种，所以不用新迁移：`packages/persistence-sqlite/src/migrations/0001_initial_product_schema.sql:133`（`CHECK (source_type IN ('user_message', 'schedule', 'external_event'))`）。
4. 来源不是主人消息的运行，读到外部内容之后，非读取、也不是管理任务的动作会被内置规则拒绝：`packages/application/src/rules/action-rules.ts:238` 的 `refuseBackgroundAfterExternalContent`；`external_event` 来源的运行一律被标成有外来内容：`apps/agent-service/src/owner-scope-authorization.ts:249`。所以由入口开出的“想一想”运行即使拿到写工具，也做不了写操作。
5. 一轮运行出工具的地方不按运行来源收窄：`apps/agent-service/src/production-runtime-tools.ts` 里给一轮运行出工具的函数先放读、编码工具，再按配置逐个追加联网搜索、读网页、记忆检索、提醒、规则、感知工具，没有读运行来源的分支。
6. 动作登记表里每个工具有动作类别：`apps/agent-service/src/production-tool-actions.ts` 的 `READ_DEFAULTS`、`codingRead` 等行带 `actionKind: "READ"`；写文件、执行命令等行的 `actionKind` 不是 `READ`（例如 `CREATE_OR_UPDATE`、`INSTALL_OR_EXECUTE_CODE`）。
7. 是非题的判断已有 Jev 的三处现成调用：`packages/platform-node/src/memory-import-duplicate-decision.ts`、`owner-intent-decision.ts`、`voice-addressee-decision.ts`，都走 `POST {gateway}/decisions`，带 `providerOptions: { gateway: { zeroDataRetention: true } }`，每道选择题返回 `choice`、`confidence` 和各选项的 `probabilities`。Andy 2026-11-14 定：是非和多选一类判断优先用 Jev。
8. 发给外部服务的文字必须先过出口遮盖：`scripts/check-egress-redaction.mjs` 里登记了每个对外发文字的文件，并要求这些文件里有 `redactForExternalText(` 调用。
9. 模型要看的提示词都登记在目录里，并有摘要登记：`packages/prompt-catalog/prompt-manifest.json`，`apps/agent-service/test/prompt-catalog.unit.test.ts` 检查每条提示词有登记、摘要对得上。
10. 规则：理解用户意思交给模型，程序只校验（[ADR 0249](0249-the-model-judges-meaning-where-word-lists-guessed-it.md)）。

[返回阅读导航](#contents)

<a id="decision"></a>

## 决定

1. **一个入口表。**表 `think_inbox`（迁移 `20261115004401_think_inbox.sql`）一行记一件来源请 Himawari 想一想的事：来源种类、来源编号、来源版本、是否来自外部内容、排队状态、原因代码、重试次数和接收日期；给后面读的短摘要放在加密载荷里，条目一结束就删载荷。表 `think_inbox_declined` 按天和原因记被关口挡掉的次数。状态只限制长度，取值由存储层校验，以后加状态不用改表。

2. **来源要先登记。**`apps/agent-service/src/production-think-inbox.ts` 的 `ThinkSourceRegistry`：来源种类、一句话说明、是否外部内容。没登记的种类直接拒收。新增来源只加一行登记，不改判断代码。

3. **关口先于任何模型调用。**同一来源同一版本只收一次，新版本照收；排队上限、每天接收上限、排队过期时间、“在想”卡住多久算卡住、最多重试次数、摘要长度都是 `runPolicy.thinkInbox` 的可选配置，越界启动就报错，默认值在 `production-think-inbox.ts`。每天按配置的时区算一天。

4. **第一次判断：值不值得再想，用 Jev。**这是是非题（选项 `worth`、`not_worth`），提示词是 `think.worth-question`（`packages/prompt-catalog/src/think.ts`）。输入只有来源说明、一句概括和是否外部内容，发出前过出口遮盖。`worth` 的概率不低于 700‰ 才去想，不高于 300‰ 判不想，中间带当作“不确定”，也不想；调用失败、解析失败、超时一律不想，记成 `failed`（原因 `worth_unavailable`）。两个门槛、超时、模型和密钥引用都是配置（`runPolicy.thinkInbox.worth`）。
   - 为什么中间带不想：宁可少提。方案参照 TypeSafe 建议的 0.7 和 0.3 门槛，和 [ADR 0271](0271-memory-import-duplicates-judged-by-the-model.md) 一致。

5. **工人一次处理一条。**`apps/agent-service/src/production-think-worker.ts` 的 `ProductionThinkWorker.runOnce`：先做维护（卡住的放回或判失败、过期的标过期、已结束条目的摘要载荷清掉），领一条，读摘要，问 Jev，值得想才交给“想一想运行”，结果记回条目（`proposed`、`skipped`、`failed`）。

6. **第二次：带工具的“想一想”运行（后续 PR）。**用已有的运行路径开一次 `external_event` 运行，只给读类工具（按动作登记表的 `actionKind` 过滤，不写工具名清单）和联网搜索，不给任何写工具；运行的产出是一条提议，走提议箱，主人点头才执行。这一步在第 2 个 PR 的后半部分做，不在这个 PR 里。

7. **两道外部内容防线。**出口遮盖（前提 8）；搜索词长度和次数上限（配置）。上线前用夹带指令的邮件评测，报告漏出次数；残留风险（一封精心构造的邮件可能诱导它把私人内容放进搜索词）已向 Andy 说明，他同意按方案做。

8. **边界。**这个决定不改系统提示和工具定义，不改授权规则；“同意的任务读到外部内容后写操作改成问主人”另出 ADR。

[返回阅读导航](#contents)

<a id="industry"></a>

## 业界怎么做

- OpenAI 的 ChatGPT Pulse：每天异步研究，早上出一组卡片；它的发布说明说主动更新后来并入“定时任务”，让用户自己说要什么。原页面这边返回 403，只读到搜索摘要，未核实原话。
- Google Gemini 的定时操作：用户先写一句话加时间。来源是搜索摘要，没逐页打开。
- Anthropic：无人值守的运行靠两层防护，“one for what Claude reads, one for what Claude does”（<https://www.anthropic.com/engineering/claude-code-auto-mode>）。

对我们的意义：建议要少而准，宁可少提；读进来的外部内容是注入入口，要和写操作隔开；第一版数量小、可看见、可关。

[返回阅读导航](#contents)

<a id="options"></a>

## 放弃的做法

- **每个来源各写一套提议代码。**来源多了就是按场景堆规则。
- **一次生成、不带工具。**Andy 要求第一版带工具、需要上网就查。
- **用词表判断“值不值得提”。**违反 ADR 0249。
- **把入口表放进数据导出。**它是临时队列，条目几天内就结束；导出再导入没有意义。

[返回阅读导航](#contents)

<a id="consequences"></a>

## 后果

- 每个入口条目多一次 Jev 调用：输入约 3 千个 token，按 ADR 0264 记的每百万输入 token 0.042 美元算，每次约 0.0001 美元。
- 带工具的运行每次估计约 0.005 到 0.01 美元（估的，没实测）；一天 50 个条目、10 个过第一次判断，约 0.1 美元，按 10 倍留余量不到 1 美元。
- 上线时生产配置要加 `runPolicy.thinkInbox.worth`（Jev 的模型引用和 Vercel 密钥引用）；没加时入口照收，但没有工人去处理。
- 上线前评测约 60 个用例，预计 0.6 美元，Andy 已同意。
- 带工具的想一想运行、同意任务的写操作审批、来源接入和旧代码清理在后续 PR 里。

[返回阅读导航](#contents)
