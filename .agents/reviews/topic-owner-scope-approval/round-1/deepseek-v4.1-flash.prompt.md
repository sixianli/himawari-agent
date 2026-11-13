你是独立的方案设计者。
你能用的工具：read、grep、glob、websearch、webfetch，以及 git diff、git log、git show、git blame、git status 这几条 git 命令。不能修改任何文件，不能运行别的命令。可以用 websearch 搜索、用 webfetch 读网页；业界做法只认一手来源（官方文档、各大 AI 公司的工程文章、成熟开源项目的源码），每条都附网址。
下面只给了问题、目标和约束，没有给出任何人的方案；材料里如果提到某种做法，只作参考。先读代码弄清现状，再独立提出你认为最好的方案，不要假设已经有人想好了答案。
做法：先想清楚要回答哪几个问题、需要看哪些文件或资料，再直接去读这些地方；不要漫无目的地浏览代码，也不要用相同或相近的参数反复调用工具。读到的内容一旦足以下结论，就停止调用工具，写出结论；没读到的地方标「未核实」，不要为了查全而一直查下去。
列出的方案只是参考，请从问题本身出发，提出你认为更好的方案。
必答问题：
1. 这个改动会不会改变模型已经见过的请求开头？包括系统提示、工具定义、历史消息、遮盖结果。要求回答：发给模型的内容是不是仍然只在末尾追加，每轮会变的值是不是都在最后一条消息里。依据：[发给模型的内容只追加](../../.claude/rules/prompt-prefix.md#rules)。
2. 这个改动会不会让同一段文字在不同请求里变成不同的字节（例如依赖前后文的遮盖、带时间的字段、无序的集合）？
3. 改动有没有对应的自动检查，反向用例是否真的会失败？
4. 改动产生或修改的每个值（标识、字段、配置键、清单项、序列化格式），每一个使用它的地方都能接受吗？逐个找到产生它的地方和使用它的地方，核对两端的校验，只看改动本身不够。依据：[I-73](../../docs/incidents-and-gates.md#incidents)，双模型复核只看了改动，没问“清单里的 id 能通过后端校验吗”。
输出格式：先列方案依赖的前提，每个前提附来源（文件:行或网址）和原话；再写方案本身、考虑过但不选的做法及原因、风险和反例、需要人拍板的取舍。把「读代码或来源证实的」和「推测」分开写。最后逐条回答必答问题。用简体中文。

---- 本次材料 ----
仓库就是当前目录，已检出 6e33c029fbed56b8201d7924c22dafe10ead139c。
问题、目标和约束：
# 方案讨论材料：让“主人范围”的工具走权限引擎和审批

请你从问题本身出发，独立提出你认为最好的方案。下面没有列任何候选方案；如果你在代码或资料里看到现成做法，那只是参考，不要局限于它。请自己读代码核对下面每条事实，发现不对的直接指出。

## 问题

Himawari 是 Andy 的个人 AI agent。模型能调用的工具分两类：

1. 受治理的工具（读文件、写代码、联网搜索）：每次调用先组一个动作意图 `GovernedActionIntent`，交给权限引擎 `ActionPolicyService.evaluate`，结果是放行、等主人审批（运行挂起，主人点头后续跑）或拒绝。
2. “主人范围”的内置工具（建提醒 `reminder.set`、取消提醒 `reminder.cancel`、列提醒、改规则 `rule.set`、撤销规则 `rule.undo`、列规则、记忆检索、任务管理）：不组动作意图，不过权限引擎，没有审批。只检查“这个工具这一轮有没有给模型”。

苹果端设计（`docs/execution/specs/2026-11-11-apple-device-body-design.md`）要新增两个工具：`perception_read`（读设备感知到的内容：屏幕文字、网页、短信、听到的旁人说话）和 `device_action`（在设备上建日历、删日历、控制家居、打开 Mac 文件等）。设计第 7 节要求：这一轮运行里模型读过不可信来源的内容之后，再想做有后果的事（设备动作、建提醒、改规则、记忆转正），主人发起的一轮里中风险动作要改成等主人确认，后台发起的一轮一律不做、改成提议。这个要求现在接不上：这几个工具根本不经过权限引擎，权限引擎也不知道“这一轮读过不可信内容”这件事。

## 目标

- 所有会产生后果的工具调用都经过同一个出口：登记动作意图、过权限引擎、需要时走现有审批。
- 策略能认得“这一轮（或这个对话的上下文里）读过不可信内容”和“这一轮是谁发起的”这类事实。
- 机制通用：以后加新工具、新设备动作、新的不可信来源，不用再给每个工具写一段分支。漏登记的工具要被自动检查拦下。
- 不能让主人多点没必要的确认。产品愿景原话：“常规判断应由规则手册预先授权，不逐次确认”。主人现在说“明天 9 点提醒我开会”是直接建好的，这个体验不能变差。
- 审批卡片上要能说清“为什么问你”。

## 约束

- 产品愿景原则顺序：用户主权 > 边界与可逆性 > 记忆可靠性 > 主动性与效率（`docs/product-vision.md:55`）。
- 主人要的是主动又聪明的 agent，不是固定死的工作流。能力要通用，不按工具、不按场景一个个写；清单、阈值能从系统动态得到的不许写死。
- 理解主人的意思一律交给模型判断，不许用关键词表或正则。
- 产品运行成本不是约束：不要因为省钱而选折中方案，按体验最好来设计（但不得通过按 token 付费的渠道用 Claude、OpenAI 这一档的贵模型）。
- 发给模型的内容只能在末尾追加：系统提示和工具定义按对话冻结，不能因为这个改动而变（`.claude/rules/prompt-prefix.md`）。
- 审批要能等几个小时、服务重启后接着跑（ADR 0023、ADR 0204）。
- 规则是硬性设定，写进程序、必定执行、每条有回归测试（`docs/product-vision.md` 第 59 行附近；规则手册见 ADR 0209）。
- 不顾旧数据兼容。

## 已核对的事实（提交 6e33c029）

1. `apps/agent-service/src/production-runtime-tools.ts:759-794`：`preflight` 对任务管理、提醒、规则、记忆检索各有一个分支，只返回 `allowed: this.#exposed.has(invocation.runId) && this.#options.<服务> !== undefined`。`execute`（同文件 1116-1118 行）直接转给 `#recall`、`#reminder`、`#ownerRule`，它们都走 `#ownerScoped`（673 行起），里面没有动作意图也没有 `authorize`。
2. 受治理工具的写法见 `apps/agent-service/src/production-coding-workflow.ts:294-411`：组 `GovernedActionIntent`，`services.authorize(intent, ctx.signal)`，不是 `ALLOW` 就返回 `runtimeToolAuthorizationResult(permission)`。
3. `packages/application/src/services/runtime-tool-authorization.ts`：`ASK` 变成 `outcome: "awaiting_approval"`，注释写着 “Every governed tool uses the same suspension contract; no model result on ASK.”；`DENY` 变成一条失败的工具结果交还模型。
4. `apps/agent-service/src/production-file-read-services.ts:303-312`：`authorize` 先调 `searchAuthorization.authorize(intent)` 和 `workspaceAuto.authorize(intent)`，再调 `policy.evaluate`。前两个是“主人事先同意过的长期授权”：条件都满足时用 `applyOwnerPolicyAuthorization`（`apps/agent-service/src/owner-policy-authorization.ts`）替主人建一条已同意的审批和一次性授权，带长期授权的键和版本号。
5. `packages/application/src/services/action-policy-service.ts`：风险基线表 `ACTION_KIND_RISK_BASELINE`（37-50 行，新建或修改=MEDIUM，删除=HIGH，对外沟通=HIGH 等）；`computeActionRisk` 取基线、模型建议、`deterministicFacts[].minimumRisk` 里最高的；`evaluate` 的顺序是：能力登记检查、拒绝规则、已有审批、授权、只读低风险放行规则、自动复核（`automaticReview`，可选）、建待审批。`recentAuthenticationRequired: intent.finalRisk === "CRITICAL"`。`capabilityDenial` 要求 `capabilityRef` 在能力登记里有 `capability.v2` 的清单，否则 `capability_not_registered`。内置的提醒、规则工具现在没有这种清单。
6. `packages/application/src/ports/authorization.ts`：`GovernedActionIntent` 的字段是固定的（`validateGovernedActionIntent` 拒绝多出来的键）；其中 `deterministicFacts: {code, minimumRisk, source: "product"|"manifest"|"runtime"}[]`。
7. 已有一个自动复核端口 `AutomaticActionReviewPort`（`packages/application/src/ports/authorization.ts`、`packages/application/src/services/automatic-action-review.ts`、`apps/agent-service/src/production-automatic-review.ts`）：只有配置了 `runPolicy.automaticReview` 才启用，由一个模型看冻结的动作意图，结果是 approve、deny、human 或 alternative。
8. 一轮运行是谁发起的有记录：`packages/application/src/ports/run-execution-source.ts` 的 `sourceType: "user_message" | "schedule" | "external_event"`。
9. 工具结果可以带数据分级 `contentClassification`，运行时适配器收到后把这一轮的可见分级抬高（`packages/runtime-pi/src/pi-runtime-adapter.ts:1293-1306` 的 `#raiseVisible`，2236 行调用）。现在没有“内容来源可不可信”的同类标记；联网抓取的结果只在一处标了 `contentKind: "untrusted_page_markdown"`（`apps/agent-service/src/web-tool-run.ts:82`）。
10. 规则手册（ADR 0209）：规则是 CEL 表达式数据，由 `RuleJudge` 计算；现在只有两道闸门 `mail_item`、`mail_delivery`（`packages/application/src/rules/field-catalog.ts:9`）。ADR 0209 写了后续第 3 步是“动作闸门”，还没做。
11. `rule.set` 的现有决定（ADR 0209 决定 6）：主人明确说“以后一律……”的规则直接生效并给回执卡和一键撤销；模型推断出来的只作为提议。
12. `device_action`、`perception_read` 还只在设计文档里，代码里没有。设计第 12 节有一张“动作登记表”：每个设备动作登记动作类别、风险档位、要不要主人本人在场、能不能撤销。
13. 审批记录必须挂在一轮真实运行上（`packages/persistence-sqlite/src/migrations/0001_initial_product_schema.sql:183`）。
14. Pi 上的审批写法是偏离官方的已批准做法（ADR 0204）：审批写在工具 `execute` 里，存快照后结束运行，主人点头后在新会话里回放。

## 查到的一手资料（供参考，请自己再查）

- Anthropic，“How we built Claude Code auto mode”（https://anthropic.com/engineering/claude-code-auto-mode）：动作分三档，只读工具和项目目录内的文件编辑不经分类器，其余交给一个分类器；分类器“sees only user messages and the agent's tool calls”，看不到工具结果，“stripping tool results is the primary prompt-injection defense”；判断标准是“whether the action is something the user authorized”，“everything the agent chooses on its own is unauthorized until the user says otherwise”；被拦时不停下等人，把拒绝交还模型，连续 3 次或累计 20 次才交给人。
- Claude Code 权限文档（https://code.claude.com/docs/en/permissions）：只读不问，命令和改文件要问，可以选“以后不再问”。
- Meta，“Agents Rule of Two”（https://ai.meta.com/blog/practical-ai-agent-security/）：一次会话里“处理不可信输入”“能接触敏感数据”“能改状态或对外沟通”三样最多占两样；三样都要时“at a minimum requires supervision — via human-in-the-loop approval or another reliable means of validation”。
- Google DeepMind 等，CaMeL，“Defeating Prompt Injections by Design”（https://arxiv.org/abs/2503.18813）：每个值带来源和权限标记，在工具调用处按策略检查；不可信数据不能影响控制流。
- OpenAI，“Safety in building agents”（https://developers.openai.com/api/docs/guides/agent-builder-safety）：“Design workflows so untrusted data never directly drives agent behavior.”

## 请回答

1. 你的完整方案：数据怎么登记、事实怎么记录和持久化、在哪一处判断、主人看到什么、后台运行怎么办、怎样保证新工具不会漏。
2. “读过不可信内容”这件事应该按一轮运行记，还是按对话上下文记（上一轮读进来的网页还留在历史里）？哪些来源算不可信？怎样既安全又不让主人每次都点确认？
3. 你的方案和上面业界做法哪里一致、哪里不同，为什么。
4. 分几步落地，每一步的自动检查是什么，反向用例是什么。
5. 这个改动会不会改变模型已经见过的请求开头（系统提示、工具定义、历史、遮盖）？同一段文字会不会在不同请求里变成不同字节？新增的每个值，产生它和使用它的每一处都能接受吗？
