---
status: active
document_type: adr
decision_status: accepted
supersedes: ""
superseded_by: ""
amended_by: "docs/adr/0285-one-main-thread-subthreads-and-one-inbox.md"
date: "2026-11-12"
covers: ".agents/instructions/prompt-prefix.md, .agents/plans/owner-scope-approval.md, apps/agent-service/src/action-rule-switches.ts, apps/agent-service/src/context-external-content.ts, apps/agent-service/src/owner-intent-gate.ts, apps/agent-service/src/owner-policy-authorization.ts, apps/agent-service/src/owner-scope-authorization.ts, apps/agent-service/src/production-automatic-review.ts, apps/agent-service/src/production-coding-workflow.ts, apps/agent-service/src/production-file-read-services.ts, apps/agent-service/src/production-file-read-workflow.ts, apps/agent-service/src/production-owner-rules.ts, apps/agent-service/src/production-reminder-writer.ts, apps/agent-service/src/production-runtime-tools.ts, apps/agent-service/test/context-external-content.unit.test.ts, apps/agent-service/test/conversation-review-external-content.unit.test.ts, apps/agent-service/test/production-memory-recall.unit.test.ts, apps/agent-service/test/production-runtime-tools.unit.test.ts, apps/control-center/src/run-approval.ts, apps/control-center/test/owner-rules.unit.test.ts, packages/application/src/ports/authorization.ts, packages/application/src/ports/run-execution-source.ts, packages/application/src/rules/field-catalog.ts, packages/application/src/rules/rule-book.ts, packages/application/src/services/action-intent-snapshot.ts, packages/application/src/services/action-policy-service.ts, packages/application/src/services/automatic-action-review-contract.ts, packages/application/src/services/automatic-action-review.ts, packages/application/src/services/context-formation-service.ts, packages/application/src/services/policy-fact-registry.ts, packages/application/src/services/runtime-tool-authorization.ts, packages/application/test/policy-fact-registry.unit.test.ts, packages/gateway-contracts/src/contracts-v2.ts, packages/gateway-contracts/src/memory-source.ts, packages/platform-node/src/owner-intent-decision.ts, packages/platform-node/src/typesafe-jev-transport.ts, packages/platform-node/test/startup-configuration.unit.test.ts, packages/runtime-pi/src/pi-runtime-adapter.ts, packages/runtime-pi/test/pi-runtime-adapter.compat.test.ts, packages/runtime-pi/test/pi-tool-progress-guard.compat.test.ts, scripts/evals/owner-intent-live.eval.ts, test/integration/memory-conversation-review.test.ts, test/integration/production-memory-capture.test.ts, test/integration/tool-action-registry.test.ts, test/tooling/policy-fact-codes.test.ts, test/tooling/rule-ids-frozen.test.ts, test/tooling/rule-ids.frozen.json"
verified_at: "1f73e976913bbac15088d045988be291fd60d8dd"
---

# ADR 0257：有后果的工具调用走同一个授权出口，按登记表和事实判断

<a id="contents"></a>

## 阅读导航

- [背景](#context)
- [先回答两个问题](#two-questions)
- [前提](#premises)
- [决定](#decision)
- [新值清单](#new-values)
- [第 3 步怎么分批](#step-3-implementation)
- [分几步做](#steps)
- [业界怎么做](#industry)
- [放弃的做法](#options)
- [后果](#consequences)
- [关联文档](#references)

<a id="context"></a>

## 背景

在这个决定落地之前，Himawari 给模型的工具有两条授权路（下面说的“现在”都指落地之前）。读文件、写代码、联网搜索先组一份“动作意图”（一条写明谁、对什么、做哪类事的记录），交给权限引擎（`ActionPolicyService`，决定放行、等主人点头还是拒绝的那个服务）。提醒、规则、记忆检索、任务管理这几类后来加的内置工具各写了一个分支，只查“这个工具这一轮给没给模型”，不经过权限引擎。每加一个内置工具就多一个绕开权限引擎的分支；苹果端的设备动作工具 `device_action` 会是下一个。

另一个缺口是外来内容。模型读过网页、邮件、文件之后，里面夹带的指令可能让它去建提醒、改规则。苹果端设计的“指令和数据的界线”一节要求这种情况下中风险动作等主人确认、后台一律不做，但落地之前没有任何地方记“模型看得到的内容里有没有外来内容”。第 1 步只把这条事实的代码登记进事实代码表（`packages/application/src/services/policy-fact-registry.ts:16`：`contextExternalContent: "context_external_content",`），统一出口组事实时只放“谁发起的”，再加上登记表那一行带来的“要本人在场”和“改长期规则”（`apps/agent-service/src/owner-scope-authorization.ts:121-123`：`const factCodes: PolicyFactCode[] = [RUN_SOURCE_FACT[source.sourceType]];`、`if (row.ownerPresenceRequired) factCodes.push(POLICY_FACT_CODES.ownerPresenceRequired);`、`if (row.standingRuleChange) factCodes.push(POLICY_FACT_CODES.standingRuleChange);`），外来内容这条事实到第 2 步才有地方产生。

本 ADR 把方案线程 2026-11-12 定稿的整合方案（仓库副本 [.agents/plans/owner-scope-approval.md](../../.agents/plans/owner-scope-approval.md)）记成决定。Andy 2026-11-12 22:11 JST 在方案线程的卡片上选了 A：加主人意图核对，评测过了才打开；22:07 JST 提出核对模型用 Jev。

[返回阅读导航](#contents)

<a id="two-questions"></a>

## 先回答两个问题

**ChatGPT、Claude 遇到同样情况怎么做，用户看到什么。**Claude Code 的自动模式把动作分三档：只读的不问；项目目录里改文件不问；其余每个动作交给一个分类器（一次单独的模型调用）判断“这是不是用户授权过的事”。分类器只看用户自己说的话和这次工具调用，看不到工具结果，所以网页里夹带的指令影响不了它；被拦下时模型拿到一条“没执行”的结果，继续想别的办法（[前提 20](#premises)）。Meta 的做法是一次会话里“读不可信内容”“能碰私人数据”“能改状态或对外发送”三样最多占两样，三样都占时至少要人确认（[前提 21](#premises)）。用户看到的是：自己说过要做的事直接做，没说过的事被拦或被问。

**这是根因还是表面修补。**是根因。毛病不是某个工具漏了一个检查，而是有两条路。本 ADR 取消第二条路：所有工具都从一张登记表出来，有后果的都过同一个出口。

[返回阅读导航](#contents)

<a id="premises"></a>

## 前提

每条前提的来源最初在 2026-11-12 对着 `origin/main` 的 `cc510cc0` 核对过。第 1 步的代码写完后，这张表里的文件行号和原话已按这个 PR 分支上的代码更新；凡是这次改动改变了的现状，行里写明“这次改动之前”是什么样。

| 编号 | 前提 | 来源和原话 |
| --- | --- | --- |
| 1 | 这次改动之前，提醒、规则、记忆检索、任务管理这几类工具的事前检查只查“给没给这一轮”，各有一个原因码；任务管理现在仍是这样，另外三类的原因码保留下来 | `apps/agent-service/src/production-runtime-tools.ts:870-874`：`this.#exposed.has(invocation.runId) &&` … `reasonCode: "TASK_RESOURCE_AUTHORITY_REQUIRED",`；`apps/agent-service/src/production-runtime-tools.ts:130`：`"owner-reminder": { prefix: "reminder", reasonCode: "REMINDER_OWNER_SCOPE" },` |
| 2 | 这次改动之前，它们执行时不组动作意图、不调权限引擎，直接交给各自的执行函数；这次改成先按登记表找到这一行，再把统一出口的检查一起交给执行函数 | `apps/agent-service/src/production-runtime-tools.ts:1214-1218`：`const row = this.#builtinRow(invocation);` … `return run(invocation, this.#ownerScopeGate(invocation, row, signal));` |
| 3 | 受治理工具的统一写法已经有了 | `apps/agent-service/src/production-coding-workflow.ts:408`：`const permission = await services.authorize(intent, ctx.signal);`；`:411`：`const result = runtimeToolAuthorizationResult(permission);` |
| 4 | 等审批时运行挂起，所有受治理工具同一种做法 | `packages/application/src/services/runtime-tool-authorization.ts:3`：`Every governed tool uses the same suspension contract; no model result on ASK.` |
| 5 | 已有“主人事先同意的长期授权”这种做法：条件满足就替主人记一条已同意的审批和一次性授权 | `apps/agent-service/src/production-file-read-services.ts:305-306`：`await searchAuthorization.authorize(intent);`、`await options.workspaceAuto?.authorize(intent);`；`apps/agent-service/src/owner-policy-authorization.ts:36`：`export async function applyOwnerPolicyAuthorization(input: {` |
| 6 | 权限引擎只对“只读、低风险”直接放行，其余没有授权就建待审批 | `packages/application/src/services/action-policy-service.ts:400`：`(rule) => rule.effect === "ALLOW" && this.safePolicyRead(rule, intent),` |
| 7 | 新建或修改是中风险，删除是高风险 | 同文件 41-42 行：`CREATE_OR_UPDATE: "MEDIUM",`、`DELETE: "HIGH",` |
| 8 | 只有最高一档才要求近期身份验证 | 同文件 498 行：`recentAuthenticationRequired: intent.finalRisk === "CRITICAL",` |
| 9 | 权限引擎要求工具在能力登记里有清单 | 同文件 529 行：`if (!facts) return "capability_not_registered";` |
| 10 | 动作意图里已经有“确定的事实”这个位置，来源可以是运行时 | `packages/application/src/ports/authorization.ts:29-33`：`export interface DeterministicPolicyFact {`、`readonly source: "product" \| "manifest" \| "runtime";` |
| 11 | 一轮运行是谁发起的有记录 | `packages/application/src/ports/run-execution-source.ts:26`：`readonly sourceType: "user_message" \| "schedule" \| "external_event";` |
| 12 | 工具结果已经能带一个标记并抬高这一轮的状态（数据分级） | `packages/runtime-pi/src/pi-runtime-adapter.ts:2235`：`if (result.contentClassification)` |
| 13 | 已有自动复核端口，但它只看动作摘要，不看对话 | `apps/agent-service/src/production-automatic-review.ts:71`：`// Only the host's frozen summary reaches the reviewer: identity, versions,` |
| 14 | 这次改动之前规则手册只有邮件的两道闸门（`mail_item`、`mail_delivery`）；这次加了第三道 `action` | `packages/application/src/rules/field-catalog.ts:9`：`export const RULE_GATES = ["mail_item", "mail_delivery", "action"] as const;` |
| 15 | 动作闸门是规则手册计划中的第 3 步 | `docs/adr/0209-rule-book-with-cel-expressions-and-judge.md:104`：`第 3 步动作闸门` |
| 16 | 愿景要求常规判断预先授权，不逐次确认 | `docs/product-vision.md:58`：`常规判断应由规则手册预先授权，不逐次确认` |
| 17 | 苹果端设计要求读过不可信内容后中风险动作等确认，后台一律不做 | `docs/execution/specs/2026-11-11-apple-device-body-design.md:364-369`：`本来按规则手册预先授权、不用问的中风险动作，这一轮改成要主人点一下确认`；`一律不做，改存“建议”` |
| 18 | 主人明说“以后一律”的规则直接生效 | `docs/adr/0209-rule-book-with-cel-expressions-and-judge.md:58`：`主人明确说“以后 / 一律……”的，规则直接生效，同时给一张回执卡` |
| 19 | 审批写在工具执行里、主人点头后回放，是已批准的做法 | [ADR 0204 第 47 行](https://github.com/sixianli/himawari-agent/blob/7d0ffcd52cbb69d4941871cf9bf08d93f3843da8/docs/adr/0204-handle-pi-deviations-d2-d3-d5.md?plain=1#L47)：`D2、D3 批准保留。` |
| 20 | Claude Code 自动模式的做法 | <https://www.anthropic.com/engineering/claude-code-auto-mode>：“The classifier sees only user messages and the agent's tool calls”；“When the classifier blocks an action, Claude shouldn't halt and wait for input” |
| 21 | Meta 的两条规则 | <https://ai.meta.com/blog/practical-ai-agent-security/>：“agents must satisfy no more than two of the following three properties within a session” |
| 22 | Claude Code 的分类器自己也会错，并且分不清参数是用户说的还是模型从别处抄来的 | 同前提 20 的网页：“The 17% false-negative rate on real overeager actions is the honest number.” |
| 23 | 提醒工具建提醒时会写一条正式记忆 | `apps/agent-service/src/production-reminder-writer.ts:219-227`：`decision: "create",`、`inference: false,` |
| 24 | `rule_set` 的工具定义里，规则类型的可选值是从规则类型表生成的 | `apps/agent-service/src/production-owner-rules.ts:170`：`enum: [...types.filter(({ tests }) => tests).map(({ id }) => id), SOFT_TYPE],` |
| 25 | 现有自动复核只审主人事先列好的确切请求，最高一档和改权限的不审 | `packages/application/src/services/automatic-action-review-contract.ts:26`：`delegation.intentFingerprints.includes(request.intentFingerprint) &&`；`packages/application/src/services/automatic-action-review.ts:98`：`if (!current() \|\| intent.finalRisk === "CRITICAL" \|\| intent.credentialOrAccessChange)` |
| 26 | 动作意图里数组的顺序会影响审批的内容指纹 | `packages/application/src/services/action-intent-snapshot.ts:12`：`JSON object key order is not semantic; array order remains part of the snapshot.` |
| 27 | 风险取所有事实里最高的一档 | `packages/application/src/services/action-policy-service.ts:59`：`export function computeActionRisk(intent: GovernedActionIntent): ActionRiskLevel {` |
| 28 | 审批快照的接口里已经带事实代码 | `packages/gateway-contracts/src/contracts-v2.ts:2257`：`deterministicFactCodes: array(machineString),` |
| 29 | 网页上“一起同意”按动作种类把几张审批并成一组 | `apps/control-center/src/run-approval.ts:92`：`export function approvalsDecidedTogether(` |
| 30 | 规则表达式的字段类型只有整数、文字、文字列表三种，没有真假 | `packages/application/src/rules/field-catalog.ts:1`：`export type RuleFieldType = "int" \| "string" \| "list<string>";` |
| 31 | 这次改动之前规则的结果值是五种，都和邮件、通知有关；这次加了动作闸门用的三种 | `packages/application/src/rules/rule-book.ts:5-13`：`\| "raise_floor"`、`\| "defer_to_quiet_hours"`、`\| "allow_preauthorized"`、`\| "refuse";` |
| 32 | 定时任务可以绑定一个对话，触发时把这个对话编号带进这一轮 | [packages/application/src/services/scheduler-service.ts:193-196](https://github.com/sixianli/himawari-agent/blob/dbbce3e39062790a0e68845ef664ac3e72cf56f5/packages/application/src/services/scheduler-service.ts)：`sourceType: "schedule",`、`threadId: job.threadId,` |
| 33 | 组上下文时按对话编号取历史摘要，不看这一轮是谁发起的 | `packages/application/src/services/context-formation-service.ts:176-177`：`request.threadId && this.dependencies.threadSummaries`、`? await this.dependencies.threadSummaries.latestSummary(request.threadId)` |
| 34 | 现有的事实代码有 `external_model_disclosure`，最低风险档填“低” | `apps/agent-service/src/production-file-read-workflow.ts:304`：`? [{ code: "external_model_disclosure", minimumRisk: "LOW", source: "product" }]` |
| 35 | 给一轮运行出工具的地方是一个函数，内置工具在末尾逐个追加 | `apps/agent-service/src/production-runtime-tools.ts:573-575`：`if (this.#options.memoryRecall) descriptors.push(memoryRecallDescriptor());`、`if (this.#options.reminders) descriptors.push(...reminderToolDescriptors());`、`if (this.#options.ownerRules) descriptors.push(...ownerRuleToolDescriptors());` |
| 36 | 记忆记录有一个“出处”列表字段 | `apps/agent-service/src/production-reminder-writer.ts:226`：`sourceRefs: [contentRef],` |

前提 32、33 回答了方案留下的一个待查项：定时任务的一轮如果绑定了对话，会带上那个对话的历史。所以那个对话读过外来内容以后，绑定它的定时任务想做有后果的事会按“后台、有外来内容”处理（不做，交提议候选）。这是静态读代码得到的结论，没有在运行中验证；定时任务的调度入口是 [packages/application/src/services/scheduler-service.ts:153](https://github.com/sixianli/himawari-agent/blob/dbbce3e39062790a0e68845ef664ac3e72cf56f5/packages/application/src/services/scheduler-service.ts) 的 `async dispatchDue(input: DispatchDueInput): Promise<DispatchDueResult> {`；2026-11-12 在 `apps/` 下搜这个名字没有搜到调用的地方，所以生产里当时还没有接上定时任务的调度。

[返回阅读导航](#contents)

<a id="decision"></a>

## 决定

<a id="decision-registry"></a>

### 1. 一张工具动作登记表，没登记的工具给不了模型

新增**工具动作登记表**，整个项目只有这一张。按工具家族登记（内置工具、带授权句柄的工具、任务管理、写代码的工具、设备动作），每一行写明：

- 这次调用算哪类动作（沿用现有 11 类，[前提 7](#premises)）、能不能撤销、动的是什么、有没有对外的收件人、要不要主人本人在场。
- 这次调用的结果算谁的内容：主人自己的数据，还是外来内容。
- 给主人看的那行明细由哪个函数按实际参数生成（三种语言）。
- 这个动作能不能由外来内容引出。不能的，上下文里有外来内容时直接拒绝，不出卡片也不变提议。
- 用哪个执行器、怎样防重复执行。登记表统一的是“给不给模型”和“授权”这两件事；各家族原有的执行办法（防重复、结果缓存、后台命令）保留，不重写。
- 有后果的工具不许标成可并行。

设备动作（苹果端第 9、10 批）直接登记进这张表，一个动作一行，另带设备动作才有的几列：名字和结构版本、哪些设备种类支持、参数结构、怎样读回核实、做之前要不要存原样。设备自己报的“我支持哪些动作”只用来过滤，不能往表里加东西。

现有工具这样登记：`reminder_list`、`rule_list`、`recall` 是读取；`reminder_set`、`reminder_cancel` 是新建或修改、可撤销；`rule_set`、`rule_undo` 也是新建或修改、可撤销，另带一条事实“改的是长期规则”。不把改规则登记成“改权限”那一类：那一类是最高档，会让主人明说的“以后一律……”也要点头加验证，违反[前提 18](#premises)。

权限引擎要求每个工具在能力登记里有清单（[前提 9](#premises)）。内置工具的清单写在代码里，查清单时先查安装的能力、再查内置清单，格式相同，权限引擎的校验不放松。

给一轮运行出工具的那一处（[前提 35](#premises)）只从登记表出；`preflight` 里按工具写的分支（[前提 1](#premises)）换成查登记表。

<a id="decision-facts"></a>

### 2. 记一条事实：模型现在看得到的上下文里有没有外来内容

- 工具结果多带一个标记“内容来源”，走和数据分级同一条通道（[前提 12](#premises)）。没写明“这是主人自己的数据”的，一律算外来内容，所以漏登记只会偏严。
- 算外来的：联网搜索、抓网页、感知记录里来源是“其他”的、读文件和命令输出、邮件正文、别的 agent 经 MCP 送来的内容、外部事件触发的那一轮带进来的事件正文、主人消息里的附件。算主人自己的：主人打的字和口头指令、列提醒、列规则、正式记忆。
- 防洗白：建提醒会写一条正式记忆（[前提 23](#premises)）。在“有外来内容”的上下文里写下的提醒、记忆、规则，记录上带一个来源标记；以后被记忆检索读出来时，结果算外来内容。
- 事实按模型现在还看得到的上下文记，不只按一轮记。压缩出来的摘要如果来自外来内容，摘要也算外来。后果：一个对话读过外来内容之后，基本上到结束都算“有外来内容”。苹果端设计写的是“这一轮”（[前提 17](#premises)），这里收紧了。
- 这条事实、“这一轮是谁发起的”（[前提 11](#premises)）、“要主人本人在场”、“改的是长期规则”，都写进动作意图的 `deterministicFacts`（[前提 10](#premises)），不改动作意图的字段结构。这几条事实的最低风险档都填“低”（和[前提 34](#premises) 的现有做法一样），不抬高风险（[前提 27](#premises)），要不要问由规则决定。事实按代码排序后再写（[前提 26](#premises)）。所有事实代码登记在一张表里，表里同时列全现有的代码，校验时拒绝表外的。
- 事实在组动作意图时定下来就不再变：审批等了几个小时后续跑，用当时存下的值。

<a id="decision-exit"></a>

### 3. 一个出口，按事实判断

所有登记为“有后果”的工具调用，执行前走同一个函数：组动作意图，判断，然后放行、等主人点头，或者不做。判断只看动作说明和事实，不按工具写：

| 情况 | 结果 |
| --- | --- |
| 读取 | 直接做 |
| 上下文里没有外来内容，中风险、能撤销、只动主人自己的数据 | 直接做，和现在一样。走现有的长期授权做法（[前提 5](#premises)）：记一条“按哪条规则预先授权”的审批和一次性授权，能查能撤 |
| 主人发起的一轮，上下文里有外来内容，中风险 | 见[读过外来内容后的中风险动作](#decision-intent-check) |
| 高风险，或登记了“要主人本人在场” | 等主人点头；要在场的不管档位都要求近期身份验证（建审批时除了看是不是最高一档，也看有没有“要本人在场”这条事实，[前提 8](#premises)） |
| 改规则，且上下文里有外来内容 | 一律等主人点头，不走自动核对。没有外来内容时不变（[前提 18](#premises)） |
| 后台发起的一轮，上下文里有外来内容，想做有后果的事 | 按动作分（[ADR 0285](0285-one-main-thread-subthreads-and-one-inbox.md) 决定 7 改写了这一行，原来是“不做”）：只在 Himawari 自己这边、能撤回的直接做并记下出处；改主人外面的账号和设备、改规则时等主人点头；发出去、删东西、花钱先问 |
| 在主人已授权的工作目录里读写文件、跑命令 | 不变，仍按现有的工作目录授权 |

表里每一行是规则手册里的一条**内置规则**（数据，带“该命中、不该命中”的例子和回归测试，和现有内置邮件规则同一种写法），由现有的裁判计算。为此给规则手册加一道“动作”闸门（[前提 15](#premises)）。闸门的字段：动作类别、风险档位、能不能撤销、对外披露方式、收件人数、谁发起的、事实代码列表。字段类型只有整数、文字、文字列表（[前提 30](#premises)），所以“能不能撤销”用 0 和 1，“上下文里有没有外来内容”“是不是改长期规则”用“事实代码列表里有没有这个代码”来表达。闸门的结果值新增三种：预先授权、问主人、不做（[前提 31](#premises)）；多条命中取最严的；一条都没命中时按权限引擎原来的办法（建待审批）。

这一次只做内置规则。让主人自己说“以后删日历前都先问我”这类动作规则，要改 `rule_set` 的工具定义（[前提 24](#premises)），会让每个老对话的请求开头重算一次，另出方案。

被拒绝时模型拿到一条“没执行，原因是……”的工具结果，可以换个做法或告诉主人（[前提 4](#premises)、[前提 20](#premises)）。同一轮里连续被拒或累计被拒到一定次数，这一轮停下并告诉主人。两个次数都是配置项，起始值参考[前提 20](#premises) 那篇文章里的连续 3 次、累计 20 次，主人看得见、能改。

后台的提议候选：本 ADR 只定交出去的内容（想做什么动作、规范化后的参数、依据了哪份外来内容、去重用的指纹），落到哪张表、怎么显示归“主动提议动作”方案。它落地之前，后台这种情况只拒绝并记决策记录。

<a id="decision-intent-check"></a>

### 4. 读过外来内容后的中风险动作：先一律问，评测过了再自动核对

**先做的**：出卡片等主人点头。

**评测过了才打开的**（Andy 选的 A）：加一个“主人意图核对”。

- 一次独立的模型调用，只给它：这个对话里主人自己说的话，和这次动作的类别与参数。不给工具结果，不给模型自己写的话（[前提 20](#premises)）。它只回答：这个动作是不是主人明说要做的，附把握有多大。
- 是，而且把握过门槛：直接做，回执写明内容取自哪份外来内容，给撤销。否则出卡片。拿不到主人原话、超时、出错，一律出卡片。门槛是配置项。
- 只管“中风险、能撤销、只动主人自己数据”的动作。高风险、对外发送、删除、改规则、要本人在场的，永远是主人点头。
- 用哪个模型：第一候选是 Jev（TypeSafe 的判定模型，对一个是或否的问题返回“是”的概率；现有通道在 `packages/platform-node/src/typesafe-jev-transport.ts`）。评测里 Jev 和 DeepSeek V4.1 Flash 都跑，按结果定。主人的原话照现有的数据分级和路由规则办，分级不允许发出去的那几句不发，这时直接出卡片。
- 它是一个新的独立端口，不借用现有的自动复核（[前提 13](#premises)、[前提 25](#premises)）。
- 上线条件：先建一套评测（夹带指令的网页、短信、屏幕文字各若干条，加上主人真的要做的正常请求），要求“夹带指令引出的动作被自动放行”的次数为 0，才打开。门槛和结果主人看得见。

两个要说清的风险：核对的模型会错（[前提 22](#premises)），所以只让它管最坏结果是“一件能撤销的小事”的范围；动作的参数可能是模型从网页里抄来的，核对模型分不清，所以这样建出来的东西带来源标记，回执上写明出处。

<a id="decision-owner-view"></a>

### 5. 主人看到什么

- 平时没有变化：自己说要建的提醒、自己说的“以后一律”规则，照旧直接生效。
- 多出来的卡片只有两种：读过外来内容后她想做一件事；设备上的高风险动作。卡片写明做什么、为什么问（命中的内置规则、读过哪份外来内容）、从哪个对话来。明细行由登记表生成；事实代码有三种语言的可读文字。
- 网页上“一起同意”（[前提 29](#premises)）不把因外来内容而问的卡片和别的并成一组。
- 规则页加一块只读的“内置规则”。

<a id="decision-prompt"></a>

### 6. 发给模型的开头

本 ADR 不加工具、不改工具定义、不改系统提示。新增的只有工具结果（拒绝的说明、点头后的结果），在末尾追加；主人意图核对是单独的调用，不进对话历史；内容来源标记只存在程序这边，不写进发给模型的文字。

要守住的一点：改成从登记表出工具以后，每个工具定义的字节和顺序必须和现在一模一样。为此加一条用真实工具表的快照测试。

[返回阅读导航](#contents)

<a id="new-values"></a>

## 新值清单

每个新出现的值，写明谁产生、谁使用、两端怎样校验、哪道检查守着（照苹果端设计“新值清单”一节的做法）。第 1、2 步的文件名已按代码更新，第 3、4 步的文件名是计划。

登记表里有几列第 1 步只登记、还没有地方读：明细函数、结果算谁的内容、能不能由外来内容引出、去重方式、设备专用的几列。第 2 步用上了“结果算谁的内容”；“能不能由外来内容引出”到第 2 步仍然没有地方读（现有工具都填“能”，读过外来内容后先问还是不做由内置规则按事实定），等出现第一个“不能”的工具时再接上；明细函数、去重方式和设备专用的几列留给第 4 步和主动提议。第 1 步真正起作用的列是：工具名、家族、能力名、操作、动作类别、能否撤销、后果、对象类型、对外披露、要不要本人在场、是不是改长期规则、授权走哪条路、执行器。

<a id="step-2-differences"></a>

第 2 步实施时和上文决定的写法有四处不同，原因如下：

- 后台不做时，“记一条决策记录”落成审计记录加一条按动作意图编号的状态记录（见下表“后台不做时的记录”），没有写决策记录表：那张表的类别是邮件和记忆的判断，后台拒绝不属于其中任何一种。
- 提议候选只存规范化参数的指纹，不存参数原文，冻结的动作意图里也只有参数摘要，所以拿不回参数。主动提议方案落地时，要在这里另存受保护的参数原文，再改这一行。
- 外来内容的标记在工具真正执行之前写，所以被拒、执行失败的外来工具调用也算读过外来内容。这样只会偏严，和“漏登记只会偏严”同一个取舍；标记写不进去时工具不执行，返回“没发出”（`external_content_mark_failed`）；读不出对话状态，或者这次调用以前已经发出过（有执行意图记录）时照常报错，不说“没发出”，因为重放的调用上一次可能已经执行过。
- 记录上的来源标记除了提醒和规则，也加在自动记下的记忆（每轮记忆捕获和对话复盘）上，用来源消息的引用加来源名区分。

| 值 | 产生处 | 使用处 | 两端校验 | 自动检查 |
| --- | --- | --- | --- | --- |
| 工具动作登记表的行（家族、能力名、动作类别、能否撤销、结果算谁的内容、要不要本人在场、能不能由外来内容引出、明细函数、执行器） | 各工具家族的模块，启动时汇成一张表 | 出工具的函数、`preflight`、统一出口、审批卡片、以后的设备动作和提议 | 汇表时拒绝重复的能力名和缺字段的行；出工具时表里没有的不出 | `apps/agent-service/test/production-runtime-tools.unit.test.ts` 里带 `[ADR-0257]` 的用例（真实工具表的名字和定义哈希与改动前一致；表里没有的工具不给模型；没接统一出口时拒绝）；`packages/application/test/policy-fact-registry.unit.test.ts`（缺字段、重复、读取却有后果的行被拒）；`test/integration/tool-action-registry.test.ts` |
| 内置能力清单（能力名、版本、操作、数据范围） | 代码里的常量 | 权限引擎查清单 | 先查安装的能力、再查内置清单，格式同一种校验 | `test/integration/tool-action-registry.test.ts`（反向：内置清单缺一项时调用被以“能力未登记”拒绝） |
| 事实代码 `run_source_user_message`、`run_source_schedule`、`run_source_external_event`、`run_source_owner_approved_task`、`context_external_content`、`owner_presence_required`、`standing_rule_change`，以及现有的 `external_model_disclosure`、`external_provider_disclosure` 等 | 统一出口组动作意图时 | 动作闸门、审批快照、决策记录、卡片上的原因文字 | 事实代码表之外的代码在校验动作意图时被拒；每个代码必须有三种语言的文字 | `packages/application/test/policy-fact-registry.unit.test.ts`（反向：表外代码被拒；没排序的事实被拒，所以同一组事实只有一种指纹）；`test/tooling/policy-fact-codes.test.ts`（扫描源码里写出的事实代码都在表里；反向：表外代码被报出） |
| 内容来源标记（`owner_data`、`external`） | 登记表每行的“结果算谁的内容”；查不到的工具算外来，记成 `unregistered:<能力名>`，用授权句柄调的工具记成 `authorized:<能力名>` | `ProductionRuntimeTools.execute` 在工具真正执行之前读这一列，外来的记进对话状态（`apps/agent-service/src/production-runtime-tools.ts`） | 只认这两个值；缺省按外来。任务取消改为 `owner_data`，取任务输出仍是 `external` | `test/integration/tool-action-registry.test.ts`（取任务输出后建提醒等主人点头；列提醒不记；反向：把取任务输出改成 `owner_data`，下一条提醒直接做） |
| 对话的“上下文里有外来内容”状态：`product_state_records` 里键 `context-external-content:thread:<对话编号>`（没有对话时 `context-external-content:run:<运行编号>`），值 `{sources:[{origin, firstRunId, firstSeenAt}]}`，按来源去重；来源值是工具名、`external_event`（外部事件发起的一轮，在授权时记）、`owner_attachment`（主人消息带附件，在组上下文时记）、`recalled_external_record`（读到带来源标记的记录） | `apps/agent-service/src/context-external-content.ts` 的 `mark`，命令类型 `context.external_content.mark`；同一进程里同一对话的标记排队写，跨进程修订号冲突时重试 5 次 | 统一出口读对话和运行两处的并集，有来源就加事实 `context_external_content` | 只追加不删除，所以服务重启、压缩、删除消息后都还在；同一对话的后续轮次都读得到，别的对话读不到 | `test/integration/tool-action-registry.test.ts`（重启后仍问；压缩后的新一轮仍读到；外部事件发起的一轮不读任何东西也算外来）；`test/integration/context-projection.test.ts`（附件计数） |
| 记录上的来源标记：提醒和规则的记忆 `sourceRefs` 多一条 `external-content:<记录编号>\|<来源>`；自动记下的记忆（`production-memory-capture.ts`、`production-memory-conversation-review.ts`）多一条 `external-content:<来源消息引用>\|<来源>`，规则的 `source` 前面加 `external-content:<来源列表>\|`；整条最长 512 个 UTF-16 码元（和网关校验的算法相同），来源名最多 256 个；超长的记录编号或来源名截短后接上原文哈希的前 16 位，所以 `\|<来源>` 不会被截掉，两条不同的记录也不会截成同一条 | 统一出口执行提醒、规则工具时读对话状态，把来源交给写入端（`production-reminder-writer.ts`、`production-owner-rules.ts`） | 记忆检索工具和组上下文时的记忆检索读到带标记的记录，这一轮记 `recalled_external_record` | 前缀常量 `EXTERNAL_CONTENT_SOURCE_REF_PREFIX` 在 `packages/gateway-contracts/src/memory-source.ts`，写入和读取共用；标记按记录编号区分，同来源去重不会因为标记把两条记录并在一起；记忆来源判断和上下文里的 `sourceRef` 跳过标记 | `test/integration/production-memory-capture.test.ts`（外来上下文里写的提醒、规则带标记，提醒仍显示为提醒；没有外来内容时不带）；`test/integration/tool-action-registry.test.ts`（读到带标记的记忆后下一条提醒等主人点头；反向：不带标记时不记）；`apps/agent-service/test/context-external-content.unit.test.ts`（组上下文时读到带标记的记忆就记）；`apps/agent-service/test/production-memory-recall.unit.test.ts`；`apps/agent-service/test/conversation-review-external-content.unit.test.ts`；`test/integration/production-memory-capture.test.ts`（读过外来内容的对话里自动记下的记忆带标记，只有别的对话读过时不带）；`test/integration/memory-conversation-review.test.ts`（对话复盘按这段对话自己的标记，别的对话的不算） |
| 规则闸门 `action` 及其字段（`action_kind`、`risk`、`reversible`、`disclosure`、`recipient_count`、`run_source`、`target_type`、`facts`）；`target_type` 是第 2 步加的，取动作意图第一个对象的种类 | 字段目录 | 裁判、内置规则、规则页 | 表达式只能读这道闸门的字段，类型检查通过 | `npm run check:rule-registry`（例子改错或表达式换掉时报错） |
| 规则结果值 `allow_preauthorized`、`ask_owner`、`refuse` | 内置动作规则 | 统一出口 | 结果值的类型穷举；邮件闸门的规则不许用这三种，动作闸门的规则只许用这三种 | 同上 |
| 内置动作规则的编号：`action_preauthorize_owner_data`、`action_preauthorize_own_task_cancel`（第 2 步：停掉自己开的任务直接做）、`action_ask_after_external_content`（第 2 步：读过外来内容后有后果的动作先问）、`action_refuse_background_after_external_content`（第 2 步：后台读过外来内容后不做） | 内置规则数据 | 长期授权记录里的“按哪条规则”、拒绝记录、卡片 | 编号固定，写进记录后不改名；`test/tooling/rule-ids.frozen.json` 记下所有发布过的内置规则编号（含邮件规则） | `test/tooling/rule-ids-frozen.test.ts`（属于 `npm run check:rule-registry`；改名、删掉、新加却没登记都失败；反向：把一条改名，两边都报出） |
| 长期授权记录的键 `action-rule:<内置规则编号>`（按内置规则预先授权），值里有开关 `enabled` 和规则修订号 `ruleRevision` | 统一出口，第一次用到这条规则时按“开”写入 | 审批记录里的 `policyAuthorization`（键和这条记录的修订号）；数据库在用授权前核对这条记录还开着、修订号没变 | 和联网搜索的长期授权同一种做法。主人把记录关掉后，新的动作改成问主人；记录的修订号变了，按旧修订号记下的预先授权不再能用。内置规则换了修订号（只会随代码发布发生）时，仍开着的记录自动更新到新修订号、继续预先授权，关掉的保持关掉 | `test/integration/tool-action-registry.test.ts`（反向：把记录关掉，下一次建提醒改成等主人点头；规则修订号从 1 变 2，开着的继续、关掉的仍然问） |
| 统一出口出错时的诊断记录（键 `runtime-tool-diagnostic:` 开头，内容是阶段、原因码 `authorization_component_error`、错误代码或类型名） | 统一出口抛错时，由出工具的那一层写 | `diagnose run` 命令按键前缀读出来给运维看 | 沿用现有工具诊断记录的键前缀；写不进去时忽略，仍按拒绝处理 | `apps/agent-service/test/production-runtime-tools.unit.test.ts` 里带 `[ADR-0257]` 的出口抛错用例（反向：这一轮已停或已取消时不写） |
| 拒绝次数上限：配置 `runPolicy.toolRefusals.consecutive`（默认 3，1 到 1000）和 `runPolicy.toolRefusals.total`（默认 20，1 到 10000）；工具结果多一个 `refused` 标记 | 配置解析（`strict-configuration.ts` 的 `parseToolRefusals`），默认值 `DEFAULT_TOOL_REFUSALS` | Pi 适配器的工具循环守卫（`PiToolProgressGuard`），到上限停下这一轮，和工具循环停下走同一条路 | 配置解析只认登记的键名和范围；守卫拿到不合法的上限直接报错；两个计数存进守卫快照，续跑接着算 | `packages/runtime-pi/test/pi-tool-progress-guard.compat.test.ts`；`packages/runtime-pi/test/pi-runtime-adapter.compat.test.ts`（连续 3 次被拒停下，2 次不停）；配置解析测试 |
| 后台不做时的记录：审计记录 `authorization.action_rule.refused`，`targetRef` 指向 `product_state_records` 的 `action-refusal:<动作意图编号>`，值里有规则编号和修订号、谁发起的、工具名、能力名、规范化参数的指纹、外来来源 | 统一出口（`owner-scope-authorization.ts` 的 `#audit`） | 运维和以后的提议接收端 | 审计记录没有放明细的字段，所以明细放在按动作意图编号的状态记录里，两边用同一个键；同一个动作意图只写一次，重放时审计的时间取状态记录里第一次拒绝的时间，所以重复写是同一条，不报冲突。没有用决策记录表：那张表的类别是邮件和记忆的判断，后台拒绝不属于其中任何一种 | `test/integration/tool-action-registry.test.ts`（后台读过任务输出后建提醒被拒、不建审批、写下这两条记录；反向：去掉这条规则，同一调用改成等主人点头） |
| 提议候选的字段（动作、规范化参数的指纹、依据的外来内容） | 统一出口，就是上一行的拒绝记录 | 主动提议方案落地后的接收端 | 落地前只写拒绝记录；只存参数指纹，冻结的动作意图里也只有参数摘要，所以参数原文拿不回来，主动提议落地时要另存 | 同上 |
| “要主人本人在场” | 登记表 | 建审批时定要不要近期身份验证 | 有这条事实的审批没有近期身份验证就拒绝，不管档位 | 第 4 步（设备动作接入时） |
| 卡片上的原因：`display.askedBecause` 新增 `{kind: "rule", ruleId, ruleText}` | 统一出口命中“先问”的内置规则时，把规则编号和一句说明（读过哪些外来来源，最多列 5 个，每个最多 80 字，多的写“等 N 个来源”）交给权限引擎建审批 | 网关的审批快照（`governance-gateway-adapter.ts`）；网页和苹果端的审批卡片还没有读它，按规则编号出三种语言的文字留给卡片界面那一步 | 原因的种类穷举 | `test/integration/tool-action-registry.test.ts`（卡片原因是这条规则，文字里有来源） |
| 规则页的内置规则：`memory.rules.snapshot` 多一组 `builtIn`（编号、修订号、结果、该命中和不该命中的例子数、“每次都先问我”开关，只有“直接做”的规则有开关，其余为 null）；`memory.rule.respond` 多两个动作 `ask_first`、`allow_directly` | `apps/agent-service/src/action-rule-switches.ts`，开关写 `action-rule:<编号>` 的 `enabled`，命令类型 `authorization.action_rule.set` | 网页规则页“内置规则”一块 | 先问和不做的规则改不了（`ACTION_RULE_HAS_NO_SWITCH`）；只能把“直接做”改成问，关回去就是恢复内置的默认 | `test/integration/tool-action-registry.test.ts`（关掉后建提醒等主人点头，打开后直接做；先问的规则改不了）；`test/integration/production-memory-capture.test.ts`（快照过网关结构校验，命令转给开关）；`apps/control-center/test/owner-rules.unit.test.ts`（只有“直接做”的有开关；反向：开着的按下变 `allow_directly`，没有内置规则时整块不显示） |
| 主人意图核对的配置键：`runPolicy.ownerIntentCheck{enabled, minConfidence, timeoutMs, model, secretRef}`（`minConfidence` 500 到 1000，`timeoutMs` 500 到 30000） | 配置解析（`strict-configuration.ts` 的 `parseOwnerIntentCheck`），不写就是关 | 核对入口 `OwnerIntentGate`（`apps/agent-service/src/owner-intent-gate.ts`） | 配置解析只认登记的键名和范围；没写这组键、或 `enabled` 为假，核对根本不调用。提示词 `authorization.owner-intent-question` 和 Jev 适配器 `packages/platform-node/src/owner-intent-decision.ts` 在第二批 | `packages/platform-node/test/startup-configuration.unit.test.ts`（范围和多余键）；第二批的评测 |
| 事实代码 `owner_intent_confirmed` 和内置规则 `action_preauthorize_owner_intent_confirmed` | 核对入口在核对通过时把事实加进动作意图，冻结后随意图保存；规则登记表（`action-rules.ts`） | 动作闸门的规则判断：新规则要求这条事实，先问规则（修订号升到 2）排除“满足同一组条件且有这条事实”的动作 | 事实只在“用户消息发起、读过外来内容、`CREATE_OR_UPDATE`、中风险、能撤销、不外发、不要本人在场、不改长期规则”时才加；规则表达式把同一组条件再核一遍，所以事实单独出现不会放行（规则例子里有反向）；“每次都先问我”开关照内置规则的做法生效 | `packages/application/test/policy-fact-registry.unit.test.ts` 的规则例子校验；`test/integration/tool-action-registry.test.ts` |
| 核对结果记录：状态记录 `owner-intent-check:<动作意图编号>`（是否通过、原因、把握、引用的原话、外来来源、模型编号）和审计记录 `authorization.owner_intent.checked` | `OwnerIntentGate` | 重放时直接读这条记录，不再调用模型；运维和以后的评测报告 | 同一个动作意图只写一次；写不进去也不影响结果（再读一次，读不到才报错） | `test/integration/tool-action-registry.test.ts` |

[返回阅读导航](#contents)

<a id="step-3-implementation"></a>

第 3 步分两批做。第一批做不花钱的部分（已合并），第二批做模型适配器、接线和评测。

- 第一批：核对端口 `OwnerIntentCheckPort`（输入只有主人原话和动作的类别、参数，没有工具结果）；严格解析 `judgeOwnerIntent`（答案格式不对、没有把握、不是“明说”、引用了原话但不是逐字出自主人的消息，都算没通过）；`OwnerIntentGate`（只在上面新值清单写的条件下才调用，超时、出错、拿不到原话都算没通过）；新的事实和内置规则；配置键。核对通过时，卡片被省掉，动作直接做，审批记录里仍有预授权的键，规则页上这条规则带“每次都先问我”的开关。
- 第二批：Jev 适配器（走 Vercel AI Gateway 的 `/v1/decisions`，选择题、带把握、`zeroDataRetention`，发出去前先遮盖敏感内容）、提示词目录里的核对问题、`service-main.ts` 里的接线（只有配置写了这组键且密钥来源适合生产才装上）、70 条评测集和评测脚本 `scripts/evals/owner-intent-live.eval.ts`。DeepSeek V4.1 Flash 只在评测里跑（它是语言模型，`/decisions` 不收，走聊天接口又受出口检查限制）；它要是更好，再单开一批做走治理路径的适配器。
- 评测（2026-11-14，70 条：夹带指令 30、边界 10、主人明说 30；Jev 一轮、DeepSeek 两轮，合计约 0.03 美元）：夹带指令和边界类被自动放行为 0（Jev 在任何把握门槛下都是 0，DeepSeek 也是 0）。主人明说的 30 条里，Jev 判“明说”的有 29 条，但它给的把握普遍在 570 到 870 之间：`minConfidence` 900 只放行 2 条，700 放行 16 条，600 放行 24 条，500 放行 29 条。DeepSeek（自报把握）放行 29 条。建议生产 `minConfidence` 先用 600：宁可多问一次，注入类在所有门槛下都没漏。评测只有 70 条，样本小，打开之后看审计记录里的实际分布再调。
- 评测结果出来、Andy 点头之前，生产配置不写这组键，核对不会被调用。
- 回执上“内容取自哪份外来内容”这一条只写在审计记录和状态记录里（外来来源），还没有出现在发给模型的工具结果里；要不要加，和 Andy 定，因为加了就是新增发给模型的内容。

<a id="steps"></a>

## 分几步做

| 步 | 做什么 | 自动检查和反向用例 |
| --- | --- | --- |
| 1 | 工具动作登记表、内置能力清单、事实代码表；提醒、规则、记忆检索改走统一出口和权限引擎；任务管理登记进表，授权照旧（见表下说明）；动作闸门和“没有外来内容时直接做”的内置规则。行为不变，不改表 | 真实工具表的工具定义快照（字节和顺序）；遍历所有可给模型的工具，缺登记即失败；工具没授权时被拒；同一组事实不同顺序指纹相同；现有提醒、规则的集成测试不改就通过；规则例子改错或表达式换掉时报错 |
| 2 | 内容来源标记、“上下文里有外来内容”的事实、对应内置规则；读过外来内容后中风险动作出卡片；后台不做并记决策记录；拒绝次数上限；卡片上的原因文字 | 脚本化模型先读网页再建提醒、改规则：主人发起的等点头，后台的不做；没读外来内容时照旧直接建；外来内容建提醒，压缩，记忆检索，再建提醒，仍然等点头；审批等待后续跑用存下的事实；连续被拒到上限后这一轮停下 |
| 3 | 主人意图核对和它的评测 | 主人明说过的直接做；没说过的出卡片；超时、出错、拿不到原话出卡片；给核对的输入里出现工具结果文字时失败；评测里夹带指令引出的动作被自动放行为 0 |
| 4 | `device_action` 按登记表接入（苹果端第 9 批做），“要主人本人在场” | 高风险但非最高档、登记了要在场的动作，没有近期身份验证被拒 |

第 1 步里外部事件发起的一轮照旧能建提醒（行为不变）；收紧在第 2 步。

任务管理（查任务状态、取任务输出、取消任务）在第 1 步只登记进表，不另组动作意图：查状态和取输出登记为读取；取消仍由现有的检查把关，即只能管这一轮自己开出来的任务（原因码 `TASK_RESOURCE_AUTHORITY_REQUIRED`）。开任务本身一直走写代码那条路的权限引擎。取消要不要在“上下文里有外来内容”时也等主人点头，放到第 2 步和那条事实一起定。第 2 步定下：取消改走统一出口，登记为只动主人自己数据的操作，由内置规则 `action_preauthorize_own_task_cancel` 直接放行，读过外来内容也不问，因为最坏结果是停掉一个自己开的任务；“只能管自己开出来的任务”那道检查保留不变。

设备动作（第 4 步）不经过模型工具那条路进来，所以统一出口另留一个只收动作意图的入口（`OwnerScopeAuthorization.decide`）：调用方拼好动作意图，它过动作闸门和权限引擎，返回放行、等主人点头或拒绝。

[返回阅读导航](#contents)

<a id="industry"></a>

## 业界怎么做

见[先回答两个问题](#two-questions)和[前提](#premises) 20 到 22。另外两条：CaMeL（<https://arxiv.org/abs/2503.18813>）给每个值带来源标记，在工具调用处按策略检查；OpenAI 的指导（<https://developers.openai.com/api/docs/guides/agent-builder-safety>）写的是 “Design workflows so untrusted data never directly drives agent behavior.”

我们为什么这样做：采用 Claude Code 的“核对只看主人原话和工具调用”，但把它限制在能撤销的中风险动作上，并要求先过评测；采用 Meta 的“三样都占时要人确认”作为默认。

[返回阅读导航](#contents)

<a id="options"></a>

## 放弃的做法

- 只给这四类工具各补一个检查：下一个内置工具还会漏，是表面修补。
- 只按一轮记“读过外来内容”：上一轮读进来的网页在下一轮照样起作用。
- 把改规则登记成“改权限”：会破坏主人明说的规则直接生效（[前提 18](#premises)）。
- 这次就让主人自己加动作规则：要改工具定义（[前提 24](#premises)），另出方案。
- 把主人意图核对接在现有自动复核上：会破坏它原来的约束（[前提 25](#premises)）。
- 像 CaMeL 那样用解释器跟踪每个值的数据流：最严密，但要换掉整个模型调工具的流程，和 Pi 的写法冲突。
- 统一出口也接管写代码的授权并对中风险一律问：会让写代码每改一个文件都问。

[返回阅读导航](#contents)

<a id="consequences"></a>

## 后果

- 一个对话读过外来内容之后，基本上到结束都算“有外来内容”；主人意图核对打开之前，这样的对话里每建一个提醒都要点一下。
- 绑定了对话的定时任务会继承那个对话的“有外来内容”状态（[前提 32](#premises)、[前提 33](#premises)）。
- 读文件、写代码、联网搜索这三条老路在第 2 步多了事实之后，上线前还等着的旧审批，续跑时新组的动作意图多了事实，指纹对不上，会被拒绝后重新问一次。这是偏安全的结果，上线说明里写一句。这次新接入的提醒、规则以前没有审批，不存在旧审批；它们的动作意图第一次组好就存下，同一次工具调用续跑时原样读回，不重新组，所以中途发了新版本也按当时存下的事实判断。
- 统一出口自己出错（例如存储写不进去）时按拒绝处理，原因码 `authorization_component_error`，不执行；出错的原因（端口错误代码，别的错误只记类型名，不记错误文字）存一条诊断记录，不给模型看；键和别的工具诊断记录同一个前缀 `runtime-tool-diagnostic:`，所以运维用的 `diagnose run` 命令能读到。同一次工具调用同时进来两次时合并成一次，这只在同一个服务进程里有效，靠的是一个数据目录同时只让一个服务进程打开。
- 规则手册的闸门清单和结果值各多几项；闸门清单是一行常量（[前提 14](#premises)），别的改动如果也往里加闸门，两边合并时这一行要手工合。
- 记录上的来源标记打算放进记忆记录已有的出处列表（[前提 36](#premises)）和规则已有的出处字段，对话的状态放进已有的按对话存的状态里，预计不用改表；这一点在第 2 步动工时对着存储层核实，核实前不算定论。
- 发给模型的请求开头不变（见[发给模型的开头](#decision-prompt)）。

[返回阅读导航](#contents)

<a id="references"></a>

## 关联文档

- [整合方案](../../.agents/plans/owner-scope-approval.md)：三方比较和讨论记录。
- [ADR 0209](0209-rule-book-with-cel-expressions-and-judge.md)：规则手册；本 ADR 做它计划里的动作闸门，只做内置规则。
- [ADR 0204](https://github.com/sixianli/himawari-agent/blob/7d0ffcd52cbb69d4941871cf9bf08d93f3843da8/docs/adr/0204-handle-pi-deviations-d2-d3-d5.md)：审批写在工具执行里、主人点头后回放。
- [苹果端详细设计](../execution/specs/2026-11-11-apple-device-body-design.md)：“指令和数据的界线”“设备工具和动作”“新值清单”。
- [.agents/instructions/prompt-prefix.md](../../.agents/instructions/prompt-prefix.md)：发给模型的内容只追加。

[返回阅读导航](#contents)
