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
仓库就是当前目录，已检出 a39b035e8d5486a45f588cf0b7b294d7e4b91dc7。
问题、目标和约束：
# 问题、目标和约束

## 问题

Himawari（本仓库，Andy 一个人用的个人 Agent）的产品愿景规定：“规则不是记忆，是硬性设定：记忆只保存一条规则的出处和修改历史；规则本身写进程序、必定执行，每条都有回归测试守着”（`docs/product-vision.md` 原则 3，第 59 行）。

现状（`docs/agent-rulebook-inventory.md`，2026-11-09 盘点）：
- 54 条约束 Agent 的规矩分散在四个地方：程序里的常量和函数（16 条，几乎都在 Gmail 主动提醒里）、写在提示词里的文字（25 条，全靠模型自觉，没有程序检查）、存成记忆的 `rule` 类条目（每轮靠模型归类、受 2000 字预算限制才可能被模型看到，生产里 3 条都已不生效）、配置和设置（8 条）。
- 同一条规则在程序和提示词里各写一份，其中 2 处已经对不上（盘点 F 节第 1 点）。
- 没有任何一条规则带“出处”字段；19 条的出处查不到（G 节，Andy 说想不起来了）。
- 除 Gmail 外，聊天里的规矩没有一条是硬的（F 节第 3 点）。
- Gmail 的静默时段、重要发件人存在 `proactive_settings`，改动直接覆盖，没有版本号和历史（F 节第 4 点）；公共机构域名后缀和金钱词表写死在代码里，主人改不了也看不到（F 节第 5 点）。

Andy 2026-11-04 对“每条有回归测试”的理解（`docs/adr/0163-owner-preferences-as-data-run-by-tested-rule-types.md` 决定第 1、2 条）：测试覆盖的是每种规则类型；他的每条具体偏好只是数据，由已经测试过的程序执行；改主意时只改数据，旧值留在历史里；只有出现全新的规则类型才加代码和测试。一次性的拒绝不变成长期规则；一句话要经过确认卡，Andy 确认后才变成长期规则。ADR 0163 把“第一批规则类型、怎么存储、程序在哪里拦截、确认卡长什么样”都留作未决，说要“按大改动流程另出方案”。

现在要出的方案：结合 Pi 1.5.0 现有的功能，Himawari 在架构上怎么把“硬规则”接进来——规则存在哪里、谁来执行、在 Agent 的哪些环节拦截、怎样保证必定执行并有测试、主人说的一句话怎样变成硬规则、出处和修改历史怎么留、模型怎样知道有这些规则。

## 目标

1. 每条被登记为“硬”的规则，必定由程序执行，不依赖模型是否照做、是否被预算挤掉。
2. 规则有出处和修改历史（谁、哪次对话、哪天立的、改过什么），任意一次因规则而发生或没发生的事能追溯到规则及其当时的版本（愿景 Jarvis Test #11）。
3. 规则手册可导出、可携带（Jarvis Test #12：导出为开放标准 SKILL.md 在 Claude Code 与 Codex 加载后仍通过）。
4. Andy 的偏好是数据，不是每条偏好写一份代码（ADR 0163）；只有新的规则类型才需要新代码和测试。
5. 尽量不增加 Andy 的人工介入（点确认、点头）；不写死，能从系统动态获取的一律动态获取。
6. 不能做成硬的规矩（只能靠模型判断的）要诚实标成“软”，界面和文档不得说成“必定执行”。

## 约束（均有来源，可自行核对）

- 只有 `packages/runtime-pi` 可以引用 `@earendil-works/pi-*` 包；模型请求都走 pi-ai（`AGENTS.md` “Pi 优先与工作区”一节）。
- 发给模型的内容只能往后追加：已经发出的系统提示、工具定义、历史不得改动、重排或删除；每轮会变的内容只放最后一条消息；系统提示和工具按对话冻结（`.claude/rules/prompt-prefix.md`，`npm run check:prompt-prefix` 是阻断检查）。
- 只有一个用户（Andy），不必为旧数据兼容花心思，做彻底（Andy 2026-11-09 定）。
- 测试不许用假替身；界面上给 Andy 看的数字和判断词要有可验证定义，功能完成要附正向和反向验收（`.claude/rules/owner-standing-rules.md`）。
- 禁用按 token 付费的贵模型；评测、实验花钱要先问（同上）。
- 产品愿景优先级：用户主权 > 边界与可逆性 > 记忆可靠性 > 主动性与效率（`AGENTS.md`）。
- 生产数据库是 SQLite；下一个迁移号是 0086，同一时间只允许一个改表结构的块在进行（项目记忆）；下一个 ADR 号可发 0201。

## 已核对的事实

Himawari 现状（读自仓库 main，提交 a39b035e）：
- Pi 接入：`packages/runtime-pi/src/pi-runtime-adapter.ts` 约第 1405–1470 行用 `DefaultResourceLoader`，`noExtensions: true`，另外注册了三个隐藏的扩展工厂（`himawari-tool-outcomes`、`himawari-system-prompt`、`himawari-provider-observer`）；`himawari-tool-outcomes` 已经在 `tool_call` 里按“工具循环保护”返回 `{ block: true, reason }`，在 `tool_result` 里读 `details.productOutcome`。
- 动作授权：`packages/application/src/services/action-policy-service.ts` 的 `ActionPolicyService.evaluate` 已经有“按能力、操作、资源前缀的 DENY 规则”（`PermissionPolicy.rules`，`ports/authorization.ts` 第 77–123 行）、`deterministicFacts`（`minimumRisk`）、授权额度预留、批准哈希校验。
- Gmail 主动提醒里的硬规则：`packages/application/src/services/proactive-rules.ts` 的 `floorHitIds`、`applyFloor`、`isReminderWorthy`、`keepOffReminderPage`，以及 `DECISION_RULE_CATALOG`（目前只登记 3 条地板规则，字段是 `origin` 和 `document`）；决策记录表 `decision_ledger` 的 `inputs.ruleIds` 引用这些规则编号（`docs/execution/specs/2026-11-09-decision-record-write-convention.md`）。
- 规则登记册：仓库里目前没有登记册的表或文档，只有上面 3 条的 `DECISION_RULE_CATALOG` 和盘点文档（盘点 G 节写“规则登记册（另一个线程在做）”，出处栏该线程定）。
- 记忆里的规则：类别 `rule`，由 `memory.capture` 提示词让模型判断产生，靠 `owner-profile-service.ts` 每轮注入“主人的要求”块，共用 2000 字预算。
- 其他已有机制：主人设置存服务器、带版本号（`docs/adr/0122-every-owner-setting-on-the-server-with-revision.md`，仅覆盖 `owner_preferences`）；确认卡/审批（敏感记忆待存要等主人点头，ADR 0179）。

Pi 1.5.0（官方仓库 github.com/earendil-works/pi，标签 v1.5.0，读自 `packages/coding-agent/docs/extensions.md` 和 `src/core/extensions/types.ts`、`packages/agent/src/types.ts`）：
- Pi 自己没有权限系统，README：“Pi does not include a built-in permission system for restricting filesystem, process, network, or credential access.”（`packages/coding-agent/docs/security.md` 也说 “it does not ask for approval before every tool call”）。
- 扩展事件：`tool_call`（可 `{block, reason, terminate}`，可原地改参数；同一条助手消息里的并行工具调用依次预检、再并发执行；`event.input` 改了不再校验）；`tool_result`（可改结果）；`before_agent_start`（可改系统提示）；`input`（用户输入进来时，可 transform 或 handled）；`context`（每次调用模型前可改消息，不含系统消息）；`context_with_system`（处理器拥有整份提示）；`before_provider_request`；`session_before_compact`；`turn_end` 与 `agent_before_settle`（“final actionable boundary: it can append session entries and request one continuation”，可追加 custom、custom_message、context_edit、compaction 条目）；`agent_settled`（只通知）。
- 出错语义（extensions.md “Error Handling”）：“Extension errors are logged, agent continues”；“`tool_call` errors block the tool (fail-safe)”；`user_bash` 出错也是拦下。
- 扩展是 TypeScript 代码，加载进程内、与 Pi 同权限；项目里的扩展要先过“项目信任”（security.md）。
- Pi 的 Agent 核心（`packages/agent`）另有 `beforeToolCall`/`afterToolCall`（可返回 block 并带 `terminate`）、`transformContext`。
- 其他包：pi-durable（实验性）、chord（插件宿主）、pi-mcp、pi-codemode（嵌套工具调用同样要过 `tool_call`/`tool_result` 处理器）。

业界一手资料（可自行再查，不限于这些）：
- Claude Code 权限与 hooks：https://code.claude.com/docs/en/permissions 、https://code.claude.com/docs/en/hooks 。规则按 deny、ask、allow 顺序评估，第一个命中的决定结果；“PreToolUse hook decisions don't bypass permission rules”；hook 沉默不等于批准；文档建议“use the permission system rather than a hook to enforce a hard allow or deny”；托管设置里的 deny 规则优先。
- Codex rules（execpolicy）：https://learn.chatgpt.com/docs/agent-configuration/rules 。Starlark 写的 `prefix_rule(pattern, decision = allow|prompt|forbidden, justification, match, not_match)`；`match`/`not_match` 是加载规则时校验的内联示例；多条命中时取最严（forbidden > prompt > allow）；`codex execpolicy check` 可测试。
- OpenAI Agents SDK guardrails：https://openai.github.io/openai-agents-python/guardrails/ 。输入守卫只管第一个 Agent，输出守卫只管最后一个；工具守卫包在函数工具前后；触发 tripwire 就抛异常停止；hosted 工具和内置执行工具不走守卫。

## 请你们做的事

读代码（本仓库）、读 Pi 官方源码和文档、上网查业界做法，然后出一套你认为最好的方案。方案要回答：规则存在哪里、规则类型怎么划分、在哪些环节拦截（Pi 的哪些钩子，Pi 管不到的环节怎么办）、怎样保证必定执行并有测试、主人的一句话怎么变成硬规则、出处和历史怎么留、模型怎样知道有这些规则、怎么分步落地、你认为的风险和我们没想到的问题。

**重要：** 上面提到的业界做法和 Pi 钩子只是参考，不要局限于这几个。请从问题本身出发，提出你认为更好的方案；对方案的任何部分，如果你认为方向本身就不对，直接说。
