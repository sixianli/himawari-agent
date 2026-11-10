# 一、方案依赖的前提

| # | 前提 | 来源 | 原话 / 依据 |
|---|---|---|---|
| P1 | 规则是硬性设定，不是记忆；规则本身写进程序、必定执行，测试按规则类型写 | `docs/product-vision.md:59` | “规则不是记忆，是硬性设定：记忆只保存一条规则的出处和修改历史；规则本身写进程序、必定执行，每条都有回归测试守着。” |
| P2 | 主人的具体偏好是数据，由测试过的规则类型执行；只有全新规则类型才加代码和测试 | `docs/adr/0163-owner-preferences-as-data-run-by-tested-rule-types.md:37,39,45` | “测试覆盖的是每种规则类型；我的每条具体偏好只是数据，由已经测试过的程序执行。” / “回归测试按规则类型写，不按每条偏好写。” / “只有出现全新的规则类型，才要加代码和测试。” |
| P3 | 硬偏好由程序执行，并写进决策记录 | `docs/adr/0163-...:40` | “硬偏好：由程序执行，并写进决策记录。” |
| P4 | 一句话变长期规则必须经主人确认；一次性拒绝不变成长期规则 | `docs/adr/0163-...:49` | “一句话要经过确认卡，Andy 确认后才变成长期规则。一次性的拒绝不变成长期规则。” |
| P5 | 原则冲突时按“用户主权 > 边界与可逆性 > 记忆可靠性 > 主动性与效率”裁决 | `docs/product-vision.md:55` | “原则冲突时，按序优先：用户主权 > 边界与可逆性 > 记忆可靠性 > 主动性与效率。” |
| P6 | 发给模型的内容只能末尾追加；系统提示和工具按对话冻结；每轮会变的值只放最后一条消息 | `.claude/rules/prompt-prefix.md:27-28,35,41` | “固定的在前，会变的在后。” / “每轮都会变的内容只放在最后一条用户消息里。” / “已经发给过模型的内容，不得改动、重排或删除，只能在末尾追加。” / “系统提示和工具按对话冻结。” |
| P7 | Pi 官方 `tool_call` 可以拦截；新增“直接拒绝、不需要等人”的硬规则用隐藏内联扩展写；只有 `packages/runtime-pi` 能导入 Pi 包 | `docs/pi-development-guide.md:30,143,160`；Pi 官方 `extensions.md` | “只能在 `packages/runtime-pi` 中导入 `@earendil-works/pi-*` 包。” / “Fired after `tool_execution_start`, before the tool executes. **Can block.**” / “新增的‘直接拒绝、不需要等人’的规则（例如硬规则），用这个钩子写，挂在一个隐藏的内联扩展里。” |
| P8 | 现有审批要等几小时、跨重启，已批准保留在工具 `execute` 里，不强行改成 `tool_call` 等待 | `docs/pi-development-guide.md:349` | D2 行：“权限判断和等审批写在工具的 `execute` 里……Andy 2026-11-10 批准保留。” |
| P9 | 邮件主动检查是单次模型调用，不是 Agent 循环 | `packages/application/src/services/proactive-mail-check-service.ts:1073`（`#judge`）；`apps/agent-service/src/production-proactive.ts:194` | 生产入口用 `setInterval(() => void this.tick(), ...)` 触发；`#judge` 里直接 `model.model.invoke(...)`，没有 Pi 会话循环。 |
| P10 | 浏览器推送由一个后台循环产出，来源包括提醒、待审批、任务完成、邮件主动提醒、Muse 通道中断，都不经模型 | `apps/agent-service/src/production-web-push.ts:315-379` | `#collect` 依次收集 `reminders`、`approvals`、`finished-runs`、`proactive`、`muse-channel`，然后 `store.enqueue`。 |
| P11 | 现有硬规则散在多处，真正“必定执行”的主人规矩几乎只有 Gmail 主动提醒；聊天里的规矩大多是软的 | `docs/agent-rulebook-inventory.md:52-53,202-203` | “一共盘出 54 条……真正‘必定执行’的主人规矩只有 Gmail 系统主动提醒那一块。聊天里的规矩几乎都是软的。” / “产品承诺确定性，实现是概率性。” |
| P12 | 现有规则值已经进入跨包契约，新增或修改必须同时通过生产端和消费端校验 | `packages/gateway-contracts/src/contracts-v2.ts:1028-1030,1104`；`packages/persistence-sqlite/src/sqlite-proactive-operations.ts:585-623`；`packages/persistence-sqlite/src/sqlite-decision-ledger-operations.ts:40-63` | 网关用 `ruleId: boundedString(256)`、`origin: owner_setting \| built_in`、`document: boundedString(64)`、`ruleIds: array(boundedString(256))`；SQLite 要求 `ruleIds` 每项 1-256 字符且不重复。 |
| P13 | 本提交没有规则登记册实现；盘点文档提到另一个线程在做，状态未核实 | `docs/agent-rulebook-inventory.md:32` | “其他线程正在改相关代码（规则登记册、清理空壳操作），所以行号会漂移……” |

---

# 二、方案本身

## 1. 先用主人能听懂的话说一遍

把硬规则从“散落在各个功能里的 if”改成 **“一本规则手册 + 一个裁判 + 两个闸门”**。

- **规则手册**：每条规则是一行数据。它写清楚：是什么类型（静默时段、金额门槛、发布审批……）、参数是什么、开还是关、优先级、出处（哪句话、哪天、哪个对话）、改过几次。
- **裁判**：每种规则类型对应一段经过测试的程序。它只回答一个问题：“现在这件事，按这些规则，应该放行、拒绝、问主人、延后、合并，还是不推？”
- **两个闸门**：所有事情必须经过的地方。
  - **动作闸门**：工具真正执行前。
  - **通知闸门**：所有推送进入发送队列前。
- **模型**：负责理解邮件、判断值不值得提醒、从邮件里提取“金额 90 元”这类事实；被拦下时向主人解释“因为哪条规则没做”。它不负责“记得遵守规则”，也不能绕过闸门。
- **程序**：负责最终裁决、执行、延后调度、幂等和审计。

加一条同类规则，只改数据；只有出现全新规则类型，才写代码和测试。这样规则不会写到每个功能里，也不会依赖模型当天心情。

## 2. 规则怎么表示

建议新增一个 **Rulebook（规则手册）**，而不是继续把规则塞进记忆或提示词。

一条规则至少包含：

```text
id            稳定标识，例如 rule:notification.quiet_hours:<uuid>
type          规则类型，来自代码里的类型目录
revision      版本号，每次修改加一
enabled       开关
priority      优先级
scope         ownerId / agentId / 全局
params        类型化参数，JSON 存储，写入时按类型 schema 校验
origin        出处：owner_setting / built_in，原话、对话/消息引用、日期、文档
createdAt
updatedAt
```

关键点：

- **规则是数据，不是自由文本。** 主人说“小于 100 块不推送”，落成 `notification.amount_threshold` 类型的一行参数，而不是一段发给模型的自然语言。
- **规则类型是代码。** 每个类型有：参数 schema、纯函数 `evaluate(rule, event, context)`、测试、说明文字。类型目录在编译期固定，不在运行时 `eval` 任意代码。
- **出处和修改历史单独存。** 每次修改生成新 `revision`，旧值保留。记忆系统最多保存“指向这条规则的引用和原话”，不保存可执行规则本身。这对应 P1、P2、P3。
- **规则不放进系统提示。** 系统提示按对话冻结；规则会变，放进去会破坏缓存。规则只在裁判里用，模型需要时通过“被拒绝的原因”或只读查询看到。

## 3. 在哪里生效：两个闸门，而不是到处写

### 闸门 A：动作闸门（工具调用前）

所有工具调用已经有两个天然入口：

- Pi 的 `tool_call` 钩子：官方写法，可以直接 `{ block: true, reason }`（P7）。
- Himawari 现有的 `RuntimeToolPort.preflight`：在工具 `execute` 里、真正执行前调用（`packages/runtime-pi/src/pi-runtime-adapter.ts:2030`；`apps/agent-service/src/production-runtime-tools.ts:729`）。

建议：

- **直接拒绝、不需要等人的规则**：放在隐藏的 `tool_call` 内联扩展里，按 P7 的官方写法，调用同一个裁判；`DENY` 直接 block。
- **需要主人批准的规则**：仍走现有 `preflight` + 审批续跑（P8），裁判返回 `ASK`，由现有 durable approval 流程处理，不把“等几小时”塞进 `tool_call`。
- 两个入口调用同一个裁判，裁判是纯函数、幂等；按 `toolCallId` 缓存结果，避免重复计算。
- 现有的 `ActionPolicyService`（能力、风险、ALLOW/ASK/DENY）继续作为底层安全层。顺序是：**能力/风险层先判；主人规则只能进一步收紧（DENY/ASK），不能放宽底层 DENY。** 这符合“边界与可逆性”优先于“主动性与效率”。

这样，“X 发帖必须逐条批准”“付款超过 500 必须审批”“删除必须可恢复”都不需要写进每个工具，只在规则手册里加一行，闸门统一执行。

### 闸门 B：通知闸门（所有推送入队前）

这是本方案和主人设想最不一样、但最关键的一点：**Himawari 现在的推送不是模型调用一个“推送工具”产生的，而是后台循环从多个来源收集的**（P10）。所以只在模型循环里拦“推送工具”不够，提醒、审批、任务完成、Muse 中断仍然会绕过。

建议：

- 所有通知来源先产出 **`NotificationCandidate`**：来源、内容引用、紧急度、候选渠道、事实（金额、币种、时间、收件人等）、过期时间。
- 统一交给 **通知闸门**：
  - `allow`：现在入队；
  - `defer`：设置 `readyAt`，到点再发；
  - `digest`：并入摘要，稍后合并成一条；
  - `suppress`：不入推送队列，但保留提醒页记录；
  - `ask`：对需要主人决定的通知，走审批/确认，而不是直接推。
- `ProductionWebPush.#collect` 是现成的单一入口（`production-web-push.ts:315`），把闸门放在它 `store.enqueue` 之前，就能一次覆盖提醒、审批、任务完成、邮件主动提醒、Muse。
- 现有 `proactive-rules.ts:200` 的 `quietUntil` 只是“邮件主动提醒”一个来源的静默实现；`attention-policy-service.ts:71` 还有另一份 `isQuietHours`，但仓库里只在测试/夹具构造，生产入口没找到（未核实仓库外是否使用）。通知闸门应该把这两份合并成一种规则类型，而不是再写第三份。

### 其他边界

不是所有规则都适合塞进这两个闸门。现有已经做对的安全边界继续保留：

- 出口遮盖、文件沙箱、数据分级、能力句柄、审批哈希校验，继续由现有程序执行。
- 规则手册可以“引用”这些边界（例如 `action.deny` 类型映射到文件边界），但不要用规则引擎重新实现一遍遮盖或沙箱。
- 记忆写入门槛（敏感/受限）、提醒时间换算这类已有硬规则，可以以后逐步迁成规则类型；不要一次全搬。

## 4. 裁判怎么裁决

裁判输入：

```text
event:
  kind: "tool.call" | "notification.candidate" | "memory.write" | ...
  subject / action / resource
  facts: 类型化事实（金额、币种、时间、时区、来源、收件人……）
  now / timeZone
ruleSnapshot: 当前启用的规则集合 + 版本号
```

裁判输出：

```text
effect: "allow" | "deny" | "ask" | "defer" | "digest" | "suppress"
reasonCode
matched: 所有命中的规则 id + revision + 各自效果
winnerRuleId
obligations: deferUntil / digestKey / approval 要求
ruleSetVersion
decidedAt
```

裁决规则建议：

- **默认更保守的效果优先**：`deny > ask > defer/digest > allow`；通知渠道里 `suppress/defer > digest > allow`。
- **同效果按 priority 高到低，再按规则 id 排序**，保证确定性。
- **所有命中规则都记录**，不只记录最终赢家。这样主人问“为什么没推/为什么被拦”，能答出命中了哪条规则、版本、参数、事实。
- **内置安全规则不可被主人规则覆盖**；主人规则可以加例外，但例外本身也是一条有出处、有版本的规则。
- **失败策略按事件类型分开**：动作类 fail closed（裁判不可用就拒绝/询问）；通知类默认 fail open（裁判不可用就照常发，避免漏掉付款提醒），但静默时段这类“少打扰”规则可以选择 fail quiet。这个取舍需要主人拍板。

## 5. 怎么插拔

- **加一条同类规则**：在规则手册插入一行，或打开 UI 开关。不改代码、不改提示词、不重启服务。
- **改一条规则**：新增 revision，保留旧值；下一次裁判用新 revision。正在延后的通知在释放时检查 rule set version，变了就重新裁决并记录。
- **停一条规则**：`enabled=false`；不删除历史。需要“彻底删除”时保留墓碑记录，审计仍可查。
- **加一种全新规则类型**：写一个类型模块（schema + 纯函数 + 测试 + 说明），注册进类型目录，然后才能创建该类型的规则。这是唯一需要写代码的情况，符合 ADR 0163。
- **导出/携带**：规则手册可以导出成人类可读的 SKILL.md（愿景 Jarvis Test #12），但导出物是“说明书”，真正执行仍以规则手册和裁判为准。

## 6. 模型扮演什么角色

模型做三件事：

1. **提议规则**：从对话里听出“以后金额小于 100 不推送”，生成一个 **待确认的规则候选**（类型、参数、出处原话），交给确认卡。主人确认后才写入规则手册。模型不能直接写生效规则（P4）。
2. **提取事实**：判断邮件值不值得提醒，提取金额、币种、截止时间等结构化事实。事实要带来源和置信度（`provenance`、`confidence`），因为“金额”不是天然可靠的程序字段。
3. **解释和改道**：被闸门拦下时，模型收到结构化的 `reasonCode`、命中规则 id、出处，能向主人解释“因为金额小于 100 的规则没推”；也能提出替代方案，但不能绕过闸门重试同一动作。

模型**不**做最终裁决，**不**需要每轮扫全部规则，**不**把规则写进系统提示。

## 7. 程序扮演什么角色

- 保存规则手册和修改历史；
- 按类型执行裁判；
- 在动作闸门和通知闸门强制执行；
- 计算静默时段结束时间、合并延后通知、做幂等和过期检查；
- 写决策记录：事件、命中规则 id + revision、事实、效果、原因、时间；
- 在裁判不可用时按事件类型执行 fail-open / fail-closed；
- 给 UI 提供“为什么推/为什么没推”的追溯。

## 8. 和现有代码怎么落地（分阶段）

1. **规则手册 + 裁判骨架**：新增 `rulebook` 存储、类型目录、纯函数裁判、决策记录；先不改变行为。
2. **通知闸门**：接入 `ProductionWebPush.#collect`；把 `proactive-rules.quietUntil` 和 `attention-policy-service.isQuietHours` 合并成 `notification.quiet_hours` 类型；把邮件主动提醒的 `push` 判断改成“产出候选”，由闸门决定。
3. **动作闸门**：在 `RuntimeToolPort.preflight` 和隐藏 `tool_call` 扩展里调用裁判；先接 `action.require_approval` / `action.deny` 两种类型，映射到现有审批和拒绝结果。
4. **逐步迁移旧规则**：Gmail 地板规则（H-1 到 H-3）仍留在邮件判断层；推送资格 H-7、降频 H-11、提醒时间 H-14、记忆门槛 H-12/H-13 可以按类型逐个迁，迁一个删一个旧实现，避免双份。
5. **UI / 契约 / 导出**：规则列表、开关、参数编辑、出处、历史、试运行、导出；同步更新 gateway contracts、SQLite 校验、控制中心测试。

---

# 三、对主人设想的同意与不同意

## 同意的部分

- **规则应该集中注册，不应该散落在每个功能里。** 完全同意。
- **规则应该在 Pi 的 loop 附近生效，模型应该知道自己被什么拦了。** 同意“在工具边界生效”和“给模型解释”，但不同意“由模型来守规则”。
- **规则应该是程序，不是提示词里的建议。** 同意。
- **以后规则会很多，不能每加一条就改一遍所有功能。** 同意，所以用“类型代码 + 规则数据”。

## 不同意的部分

1. **“模型先扫一遍规则，然后决定不调推送工具”不是硬规则。**
   模型可能忘、可能误读、可能被邮件里的注入内容带偏；只要它“决定调”，规则就没被执行。产品愿景要求“写进程序、必定执行”，所以最终裁决必须在程序里，不能把模型的自律当成执行。

2. **“每轮扫全部规则”既贵又没必要。**
   规则是数据，裁判只挑与当前事件类型相关的规则。模型不需要看到全部规则；它只需要在动作被拦时看到原因，或者按需查询一条规则。

3. **Himawari 现在的推送不是模型调一个“推送工具”。**
   邮件主动提醒是单次模型调用（P9），网页推送是后台循环从提醒、审批、任务完成、邮件、Muse 收集的（P10）。就算模型不调“推送工具”，这些来源仍会推。所以必须有**通知闸门**，不能只在模型循环里拦。

4. **“金额小于 100”里的“金额”不是天然可靠的程序事实。**
   当前邮件判断输出没有金额字段（`parseJudgements` 只解析 `result/confidence/todo/reason/dueAt/priority/usedMemoryIds`）。模型可以提取金额，但提取可能错、可能缺失。硬规则只能保证“给定金额事实后如何裁决”，不能保证“金额事实一定对”。所以要把“事实提取”和“规则裁决”分开：事实带来源和置信度，缺失/低置信时规则类型要定义默认行为（例如仍然通知，避免漏付款）。

5. **把规则摘要塞进系统提示或每轮消息，会带来缓存和 token 代价。**
   系统提示和工具定义按对话冻结；规则会变，放进去会破坏缓存。放最后一条消息虽然只追加，但规则多时每轮都要付 token。硬规则不需要模型看到全部规则，所以第一版不建议这样做。

---

# 四、业界一手资料印证

1. **Pi 官方扩展文档**：`tool_call` 可以在工具执行前拦截。
   - 网址：<https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/extensions.md>
   - 原话：“Fired after `tool_execution_start`, before the tool executes. **Can block.**”
   - 原话：“Return values from `tool_call` control blocking via `{ block: true, reason?: string, terminate?: boolean }`”
   - 对应本方案：动作闸门用 `tool_call` 做直接拒绝，符合 P7。

2. **Open Policy Agent：Agent Tool Calling**：harness 是执行点，策略引擎是决策点。
   - 网址：<https://www.openpolicyagent.org/docs/agent-tool-calling>
   - 原话：“The harness is the Policy Enforcement Point (PEP), which enforces decisions. Before the harness runs a tool call, the harness asks OPA, the Policy Decision Point (PDP), for a decision.”
   - 原话：“If result has reasons, the harness must not run the tool calls.”
   - 对应本方案：裁判（PDP）和执行闸门（PEP）分离；模型不是执行点。

3. **OPA Philosophy：策略与软件解耦，数据驱动、无需重新部署**。
   - 网址：<https://www.openpolicyagent.org/docs/latest/philosophy/>
   - 原话：“Today policy is often a hard-coded feature of the software service it actually governs. Open Policy Agent lets you decouple policy from that software service...”
   - 原话：“Software services should allow policies to be specified declaratively, updated at any time without recompiling or redeploying, and enforced automatically...”
   - 对应本方案：规则是数据，裁判是代码；加规则不改功能代码。

4. **Cedar：策略是声明式规则，裁决结果带“决定理由”**。
   - 网址：<https://docs.cedarpolicy.com/overview/terminology.html>
   - 原话：“A policy is a statement that declares which principals are explicitly permitted, or explicitly forbidden, to perform an action on a resource.”
   - 原话：“It ultimately produces an authorization response that consists of the decision (Allow or Deny), and the list of determining policies that are the reasons for that decision.”
   - 对应本方案：每次裁决记录命中规则 id 和 revision，支撑“决策可解释”。

5. **OpenAI Agents SDK：工具级 guardrail 在工具执行前后运行，可以跳过调用**。
   - 网址：<https://openai.github.io/openai-agents-python/guardrails/>
   - 原话：“Tool guardrails wrap `FunctionTool` instances and let you validate or block calls to those tools before and after execution. They are configured on the tool itself and run every time that tool is invoked.”
   - 原话：“Input tool guardrails run before the tool executes and can skip the call...”
   - 对应本方案：动作闸门挂在工具边界，而不是散落在业务代码里。

6. **Claude Agent SDK：权限在工具调用时由程序检查，deny 规则连 bypass 模式也拦得住**。
   - 网址：<https://docs.claude.com/en/api/agent-sdk/permissions>
   - 原话：“When Claude requests a tool, Claude Code checks the call at these steps. Each step can decide the call...”
   - 原话：“The call is denied this way even in `bypassPermissions` mode and when a hook returned `allow`.”
   - 对应本方案：规则不能依赖模型配合；程序层的拒绝要能压过模型/hook 的放行。

7. **Prometheus Alertmanager：静默时段是通知路由上的数据化时间区间**。
   - 网址：<https://prometheus.io/docs/alerting/latest/configuration/>
   - 原话：“A `time_interval` specifies a named interval of time that may be referenced in the routing tree to mute/activate particular routes for particular times of the day.”
   - 原话：“When a route is muted it will not send any notifications, but otherwise acts normally...”
   - 对应本方案：静默时段不是每个通知生产者的 if，而是通知闸门上的一条规则数据。

---

# 五、三个例子走完整流程

## 例子 1：金额小于 100 不推送

**规则数据**

```text
type: notification.amount_threshold
params: { currency: "CNY", amountMinor: 10000, comparator: "lt", channel: "push", onUnknown: "notify" }
effect: suppress
origin: { kind: "owner_setting", quote: "所有涉及金钱的通知，金额小于 100 块就不通知我", at: "..." }
```

**流程**

1. 主人在对话里说这句话。模型生成**待确认规则候选**，确认卡展示类型、参数、作用范围、出处原话。主人确认后，规则手册写入 revision 1。
2. 一封订阅邮件到达。邮件判断服务 `#judge` 返回 `result: "act"`，并新增结构化事实 `amount: { valueMinor: 9000, currency: "CNY", confidence: "high", provenance: "model" }`。当前代码没有这个字段，需要新增。
3. 邮件判断服务不再自己决定 `push`，而是产出 `NotificationCandidate`：来源邮件、insight、金额事实、紧急度、渠道 `push`。
4. 通知闸门加载 `notification.candidate` 类型规则；金额规则命中：9000 < 10000 → `suppress`，原因 `amount_below_threshold`，命中规则 id + revision。
5. 闸门写决策记录；不进入推送队列。提醒页是否还显示这条，由另一条规则或现有行为决定。主人说的是“不通知”，不是“不记录”，所以默认保留提醒页记录。
6. 如果金额正好 10000：`lt` 不成立 → 不抑制，按其他规则/默认放行。测试必须覆盖这个边界。
7. 如果金额缺失或置信度低：按 `onUnknown: "notify"` 放行，避免漏掉付款。这个默认值需要主人拍板。
8. 如果币种不是 CNY：规则不适用，按其他规则处理。

**必须有的测试**

- 9000 → 不推送；
- 10000 → 推送（边界）；
- 10001 → 推送；
- 金额缺失 → 推送；
- 币种不匹配 → 推送；
- 规则禁用 → 同一封邮件必须推送（正向对照）；
- 把闸门调用去掉 → “9000 不推送”测试必须失败；
- 只断言“没有推送”不够，必须同时断言决策记录里的 `ruleId`、`revision`、`reasonCode`，否则可能因为候选根本没产生而假通过。

## 例子 2：23:00–07:00 静默

**规则数据**

```text
type: notification.quiet_hours
params: {
  timeZone: "Asia/Tokyo",
  windows: [{ days: [0,1,2,3,4,5,6], start: "23:00", end: "07:00" }],
  onQuiet: "defer",
  digest: true
}
effect: defer
origin: { kind: "owner_setting", quote: "23:00 到 07:00 不要推送", at: "..." }
```

**流程**

1. 主人设置规则；确认卡显示时区、星期、起止时间、延后策略。规则写入手册。
2. 23:30 产生一个通知候选（提醒、邮件或任务完成都行）。通知闸门计算：当前在静默窗口内，`deferUntil = 次日 07:00`（按 `Asia/Tokyo` 计算；如果连续多个窗口，像现有 `quietUntil` 一样循环到不再处于静默）。
3. 候选进入 outbox，`readyAt = 07:00`；决策记录写明命中规则、窗口、计算出的 `deferUntil`。
4. 07:00 outbox 唤醒：先检查候选是否过期；再检查 rule set version 是否变化。没变就发送；变了就重新裁决并记录新决策。多个延后候选可以合并成一条摘要，避免 07:00 同时弹十条。
5. 审批类通知：如果规则配置了 `exceptions: ["approval.critical"]`，关键审批可以绕过静默；普通审批是否延后，需要主人拍板。不能默认把所有审批都延后，否则可能阻塞重要工作。
6. 现有邮件主动提醒的 `quietUntil` 被通知闸门取代；提醒、审批、任务完成、Muse 也第一次真正受同一条静默规则约束。

**必须有的测试**

- 22:59 → 立即发送；
- 23:00 → 延后到 07:00；
- 06:59 → 延后到 07:00；
- 07:00 → 发送；
- 时区/DST 边界（即使生产用日本时区，也要测通用逻辑）；
- 静默期间规则被禁用 → 释放时重新裁决并发送；
- 静默期间候选过期 → 不发送；
- 规则禁用时同一候选必须发送（正向对照）；
- 把闸门调用去掉 → 静默测试必须失败。

## 例子 3：和通知无关的规则——对外发布必须逐条批准

**规则数据**

```text
type: action.require_approval
params: { actionKind: "PUBLICATION", capabilityRefs: ["x.post"] }
effect: ask
origin: { kind: "owner_setting", quote: "X 发帖每天推进，但每一条都必须先经我批准", at: "..." }
```

**流程**

1. 主人确认规则；规则手册写入。
2. 模型调用 `x_post` 工具。Pi 的 `tool_call` 或现有 `preflight` 调用裁判，事件是 `tool.call`，带 `capabilityRef`、`actionKind`、参数、目标。
3. 裁判命中规则，返回 `ask`。动作闸门把它映射到现有 durable approval 流程：工具不执行，生成审批请求，模型收到“等待主人批准”的结果并可以向主人解释。
4. 主人批准后，现有审批续跑流程继续执行工具；主人拒绝则工具不执行，没有副作用。决策记录写明命中规则、效果、原因。
5. 如果底层能力/风险层已经 `DENY`（例如能力未注册、风险不可接受），底层先赢，主人规则不能放宽。
6. 如果规则禁用，按原有动作策略执行；如果原策略允许，工具直接执行（正向对照）。

**必须有的测试**

- 规则禁用 → 工具执行（前提是原策略允许）；
- 规则启用 → `ASK`，工具不执行；
- 批准 → 执行；拒绝 → 不执行；
- 底层能力 `DENY` → 即使主人规则是 `ALLOW` 也不能执行；
- 规则里的 `capabilityRef` 不存在 → 写入时或启动时校验失败；
- 绕过动作闸门 → 测试必须失败。

---

# 六、考虑过但不选的做法及原因

## 1. 把规则写进系统提示，让模型自觉遵守

**不选。** 规则会变，系统提示按对话冻结，写进去会破坏缓存；而且模型自觉不是“必定执行”。这直接违反 P1、P6。

## 2. 把规则摘要放进每轮最后一条消息

**不作为硬规则的主路径。** 只追加、不破坏前缀，技术上可以；但规则多时每轮都付 token，而且模型仍可能忽略。它可以用于软偏好或“让模型知道规则存在”，但不能替代程序裁决。

## 3. 模型先调用 `rules_list` 工具扫全部规则，再决定是否调推送工具

**不选。** 这是主人设想的直译，但有两个问题：第一，模型仍可能不扫、扫错或扫了不照做；第二，Himawari 的推送大部分不是模型工具调用产生的（P9、P10），扫了也拦不住后台推送。可以保留一个**只读的规则解释工具**作为可选的透明性功能，但裁决必须在闸门。

## 4. 直接引入 OPA/Rego 或 Cedar 作为运行时策略引擎

**暂不选。** 它们的架构思想（PDP/PEP、策略与执行分离、裁决带理由）非常值得借鉴，但 Himawari 只有主人一个用户，规则类型目前是可枚举的。引入完整策略语言会增加：第二套语言和工具链、运行时依赖、调试成本、权限/安全面。先用“类型化规则模块”实现同样的架构；如果以后规则复杂到需要用户自定义逻辑，再评估 OPA/Cedar。

## 5. 继续在每个功能里写 if，只把重复代码抽成工具函数

**不选。** 这只能减少重复，不能解决“新规则要改很多地方”和“规则没有统一出处/测试/审计”的问题。规则仍然散落，仍然容易两处不一致（盘点已经发现 4 处硬+软重复，其中 2 处对不上，见 `docs/agent-rulebook-inventory.md:201`）。

## 6. 把所有规则都塞进现有 `ActionPolicyService`

**不选。** `ActionPolicyService` 是动作授权/风险引擎，生产里 `policy.rules` 甚至是空数组（`apps/agent-service/src/production-file-read-services.ts:69`）。它适合底层能力/风险判断，不适合通知静默、金额门槛、摘要合并这类“注意力”规则。两者应该分层：底层安全层 + 主人规则层，最终拒绝优先。

## 7. 把所有通知都改成“模型决定是否调推送工具”

**不选。** 这会让提醒、审批、任务完成、Muse 都经过模型，成本和延迟大幅上升，而且模型仍可能漏掉。通知闸门在后台循环里做确定性判断，更便宜、更可靠。

---

# 七、风险、代价、反例

## 1. Token 费用变化

- **硬规则走闸门、不进提示词**：每轮新增 token 约为 0；只有被拒绝时追加一条工具结果，通常几十到一百多 token。
- **可选的 `rules_list` 只读工具**：工具定义在请求最前面，会增加每个请求的固定输入 token（估计几百 token，具体取决于描述长度；这是推测，需要按实际 tokenizer 测）。而且新增工具会改变工具集合，按 P6 会触发一次按对话换新/重建。第一版不建议加。
- **把规则摘要放最后一条消息**：规则越多越贵。例如 50 条规则、每条 50 token，就是每轮 2500 token 的尾部输入；虽然不破坏前缀缓存，但每轮都按新 token 付费。不建议用于硬规则。
- **决策记录**：只增加数据库写入，不增加模型 token。

## 2. 延迟和复杂度

- 裁判是纯函数 + 一次规则快照读取，正常情况下毫秒级；可以按 run 缓存规则快照。
- 静默延后会**故意**增加通知延迟；这是产品行为，不是故障。
- 新增规则手册、类型目录、UI、迁移、契约测试，初期工作量不小；但之后加规则是数据操作。

## 3. 反例和失败模式

- **金额提取错误**：邮件写“90 元”但模型提取成 900，规则会误判。缓解：金额事实带 `provenance`/`confidence`；低置信或缺失时按 `onUnknown` 处理；在决策记录里保存原始片段；对金额规则做 eval 集。
- **规则冲突**：静默规则说延后，金额规则说抑制，紧急规则说立即发。必须定义优先级和“更保守效果优先”，并记录所有命中规则；否则主人无法解释。
- **规则写错**：例如把 100 写成 10000。需要 UI 预览、试运行、决策记录、快速禁用；不能只靠测试。
- **闸门故障**：动作闸门故障应 fail closed（拒绝/询问）；通知闸门故障建议 fail open（照常发，避免漏付款），但这会让静默规则失效。需要主人拍板。
- **延后期间规则变了**：释放时重新裁决可能从“发送”变成“继续延后”。要记录新决策和 rule set version，避免主人以为系统丢了通知。
- **审批被静默**：如果静默规则无差别作用于审批，可能把需要主人决定的事拖到早上。必须给审批/关键告警留例外，或让主人明确选择。
- **I-73 类契约错配**：规则 id、类型、origin、document 长度、reasonCode 可能在一个包里合法、在另一个包里被拒。必须做“生产端→所有消费端”的契约测试，不能只看 diff。

## 4. 放弃了什么

- **放弃了“模型读懂自然语言规则并自行遵守”的幻想。** 需要判断的规则（“这封邮件真的紧急吗”）仍是软偏好或模型分类；只有可计算的事实才能做硬规则。
- **放弃了“所有规则都写在提示词里、模型一眼看全”的简单模型。** 主人看规则用 UI/导出；模型只在需要时看拒绝原因或按需查询。
- **暂时放弃了通用策略 DSL。** 新规则类型仍需开发者写代码和测试；这是为了确定性和可审计性。
- **放弃了“一次迁移所有旧规则”。** 旧规则会分批迁，迁移期可能双跑；必须用测试确保不重复执行、不互相矛盾。

---

# 八、需要人拍板的取舍

1. **静默时段是否作用于审批和关键告警？** 建议默认给 `approval.critical` 等例外，普通审批可延后；需要主人定。
2. **“金额小于 100 不推送”是只不推送，还是也不进提醒页？** 建议只抑制推送，保留提醒页记录；如果主人要“完全不记录”，再加一条独立规则类型。
3. **金额缺失或置信度低时怎么办？** 建议默认仍然通知（避免漏付款），而不是静默；需要主人确认。
4. **闸门故障时通知是 fail open 还是 fail closed？** 建议通知 fail open、动作 fail closed；需要主人确认。
5. **是否给模型一个只读的规则查询工具？** 建议第一版不加，靠拒绝原因和 UI 解释；如果主人希望模型能主动查，再加，并接受一次工具集合换新和固定 token 成本。
6. **旧规则迁移顺序**：先静默+金额，还是先把 Gmail 地板/推送资格/降频一起迁？建议先做通知闸门和这两个例子，验证后再迁其他。
7. **规则出处和原话是否要加密存储？** 原话可能含金额、发件人等敏感信息；建议按现有敏感数据策略处理，需要主人定。
8. **是否允许主人从对话直接创建全新规则类型？** 建议不允许；新类型必须开发者写代码和测试，主人只能创建已注册类型的规则。
9. **静默结束后的合并策略**：多条延后通知合成一条摘要，还是逐条发？建议合并，避免早上刷屏。
10. **是否引入 OPA/Cedar**：建议现在不引入，先用类型化模块；如果以后规则复杂到需要用户自定义逻辑，再评估。

---

# 九、哪些是读代码/来源证实的，哪些是推测

## 已证实（读代码或官方来源）

- 规则是硬性设定、测试按类型写、一句话要确认：`docs/product-vision.md:59`、ADR 0163 决定 1/2/4。
- 提示词只能追加、系统提示和工具按对话冻结：`.claude/rules/prompt-prefix.md:27-28,35,41`。
- Pi `tool_call` 可以拦截，直接拒绝规则应放隐藏内联扩展；只有 `packages/runtime-pi` 能导入 Pi：`docs/pi-development-guide.md:30,143,160`。
- 现有审批等几小时、跨重启，已批准保留在工具 `execute`：`docs/pi-development-guide.md:349`。
- 邮件主动检查是单次模型调用，不是 Agent 循环：`proactive-mail-check-service.ts:1073`、`production-proactive.ts:194`。
- 网页推送由后台循环从多个来源收集，不经模型：`production-web-push.ts:315-379`。
- 现有静默规则有两份：`proactive-rules.ts:200` 和 `attention-policy-service.ts:71`；后者在仓库里只被测试/夹具构造，生产入口没找到。
- 现有动作策略在生产里 `rules: []`：`production-file-read-services.ts:69`。
- 现有 `ruleIds`、`origin`、`document` 的消费端校验：`contracts-v2.ts:1028-1030,1104`；`sqlite-proactive-operations.ts:585-623`；`sqlite-decision-ledger-operations.ts:40-63`。
- 当前邮件判断输出没有金额字段：`parseJudgements` 只解析 `result/confidence/todo/reason/dueAt/priority/usedMemoryIds`（`proactive-mail-check-service.ts:460-498`）。
- 业界来源的原话见第四节，均来自官方文档/官方项目文档。

## 推测或未核实

- Pi 把 `{ block: true, reason }` 的 reason 以什么形式放进模型历史：官方文档说 blocked call 跳过 `tool_result`、仍产生 `tool_execution_end` 错误结果，但没有明说 reason 是否作为 tool result 进入下一轮请求。**未核实**；落地第一步要用真实 Pi 适配器测试锁住。
- `AttentionPolicyService` 是否在仓库外被生产调用：仓库内只看到测试/夹具。**未核实仓库外**。
- 是否有仓库外进程直接调用 `WebPushSenderPort` 绕过 `ProductionWebPush`：仓库内没找到。**未核实仓库外**。
- 可选 `rules_list` 工具的具体 token 成本：取决于工具描述长度和 tokenizer，**推测**为几百 token。
- 模型从邮件提取金额的准确率：没有现成 eval，**未核实**；需要建数据集验证。
- 盘点文档提到“规则登记册”另一个线程在做，本提交没有代码；其设计和进度**未核实**，需要避免重复开发。

---

# 十、逐条回答必答问题

## 必答问题 1：这个改动会不会改变模型已经见过的请求开头？

**按本方案，不会改变系统提示、工具定义、历史消息和遮盖结果。发给模型的内容仍然只在末尾追加，每轮会变的值不会进入请求开头。**

具体：

- 规则手册、规则 revision、决策记录、当前时间、时区、金额事实都在模型请求之外；裁判在工具执行前/通知入队前运行。
- 模型看到的唯一新增内容，是工具被拒绝/询问时追加的 tool result（或 Pi `tool_call` 的 block 结果）。这是末尾追加，不改写历史。
- 系统提示和工具定义不变；规则增删改不会触发按对话换新，因为规则不是提示词的一部分。
- 如果第一版不加新的 `rules_list` 工具，工具集合完全不变。**如果以后要加只读规则查询工具，工具定义会变一次**，按 P6 会触发一次按对话换新/重建；这需要单独 ADR、明确代价，并加测试。
- 如果要把规则摘要给模型看，只能放最后一条用户消息（末尾追加），不能放系统提示/工具定义；但本方案不建议对硬规则这样做。
- 遮盖结果不受影响：规则引擎不参与出口遮盖，也不改写历史里的遮盖文本。
- 历史仍然存实际发出去的那一条；被拒绝的 tool result 按原样存，不在存之前换版本。

依据：`.claude/rules/prompt-prefix.md:27-28,35,41`。

## 必答问题 2：会不会让同一段文字在不同请求里变成不同的字节？

**不会，前提是规则不进入提示词文本，且裁决结果按确定格式序列化。**

- 规则引擎不碰遮盖；出口遮盖仍是确定性的，同一段历史、同一密钥、同一规则下遮出的字节相同。
- 规则裁决可以因时间、金额事实不同而不同，但这是“新决策”，不是“改写旧文字”。旧消息的字节不变。
- 如果要把裁决结果渲染给模型，必须：
  - 规则按 id/priority 固定排序；
  - JSON 键顺序固定，列表顺序固定；
  - 金额用整数最小单位（分）或固定十进制格式，币种用 ISO 代码；
  - 时间用 RFC3339，且只在必要时出现；
  - 不使用 `Set`/`Map` 遍历顺序、数据库返回顺序或随机 id；
  - 同一 `toolCallId` 重放返回同一结果，不重新生成不同文本。
- 静默时段本身依赖“当前时间”，所以同一候选在 22:59 和 23:01 会得到不同裁决；但这是不同事件/不同时间的决策，不是同一段历史文字被改成不同字节。如果把这个时间写进模型消息，它是一条新消息/新 tool result，只追加在末尾。
- 延后释放时如果规则版本变了，会重新裁决并记录新决策；这不会改旧消息，只会产生新决策记录。

## 必答问题 3：改动有没有对应的自动检查，反向用例是否真的会失败？

**目前没有实现，所以现在没有；下面是必须加的检查。关键是每个反向用例都要有“只改规则开关”的正向对照，并且实际做一次 mutation 验证。**

必须加的检查：

1. **规则类型单元测试**：边界值、缺失事实、币种不匹配、时区/DST、跨午夜、规则禁用、冲突、优先级、确定性。
2. **规则手册契约测试**：每个类型必须有 schema；参数写入时校验；未知类型/未知字段拒绝；`origin`、`revision`、`enabled`、`priority` 合法；导出/导入 round-trip。
3. **通知闸门集成测试**：金额 9000 不推送、10000 推送、缺失推送；静默 23:00 延后、07:00 发送；规则禁用时同一候选必须推送。
4. **动作闸门集成测试**：发布规则启用 → `ASK`、工具不执行；批准 → 执行；拒绝 → 不执行；规则禁用 → 按原策略执行；底层 `DENY` 不被主人规则放宽。
5. **决策记录测试**：每次裁决记录命中规则 id + revision + reasonCode + 事实；同一事件重放得到同一裁决；去掉规则 id 记录 → 测试失败。
6. **I-73 式跨边界契约测试**：枚举规则类型目录里的每个类型/每个字段，分别喂给规则手册、gateway contracts、SQLite、控制中心、导出；任何一端拒绝就失败。尤其检查 `origin` 枚举、`document` 长度、`ruleIds` 长度和去重、`reasonCode` 长度。
7. **缓存检查**：`npm run check:prompt-prefix` 必须继续通过；新增反向用例：把规则摘要写进系统提示 → 检查必须失败；规则增删改不得改变系统提示/工具定义。
8. **Mutation 验证**：临时把闸门调用去掉，跑“金额 9000 不推送”“静默 23:30 延后”“发布规则 ASK”三条测试，必须失败；把规则开关关掉，同一测试必须变成推送/执行。这个失败要记录在 PR/ADR 里，证明反向用例真的会失败，而不是因为候选没产生而假通过。
9. **测试断言要带原因**：不能只断言“没有推送”，还要断言 `reasonCode`、命中规则 id、revision；否则测试可能因为错误原因通过。

现有 `check:prompt-prefix` 已经有反向用例（改写历史、系统提示带每轮变化的值、关掉冻结、请求中间出现 system 消息，检查必须失败，见 `.claude/rules/prompt-prefix.md:74`），新改动应该沿用这个模式。

## 必答问题 4：改动产生或修改的每个值，每一个使用它的地方都能接受吗？

下面逐个列生产端和消费端，按 I-73 的教训核对两端，而不是只看改动本身。

| 值 | 生产端 | 消费端 / 校验 | 风险与要求 |
|---|---|---|---|
| `rule.id` | 规则手册创建 | gateway `ruleId: boundedString(256)`（`contracts-v2.ts:1028`）；SQLite `ruleIds` 每项 1-256、去重（`sqlite-proactive-operations.ts:587-594`）；decision ledger `idList` 1-256（`sqlite-decision-ledger-operations.ts:40-46`） | 定义统一 `ruleIdString`：非空、≤256、无控制字符、唯一。不要用 `machineString`（它限制更严），否则含 `/`、`:` 的 id 会被拒。加契约测试枚举所有类型生成的 id。 |
| `rule.type` | 规则手册 / UI | 裁判类型目录；UI；导出；gateway（如果暴露） | 必须是编译期目录里的值；写入时拒绝未知类型；启动时校验已存规则的类型都存在。 |
| `rule.revision` | 规则手册每次修改 | 决策记录；延后释放时的版本比较；导出；gateway（如果暴露） | 正整数、单调递增；序列化格式固定；如果进入 gateway，新增字段必须同时改契约、控制中心和测试。 |
| `rule.origin` | 规则手册 / 确认卡 | gateway `origin` 目前只接受 `owner_setting \| built_in`（`contracts-v2.ts:1029`）；决策链快照；UI | 如果要新增 `imported`、`migrated`、`owner_confirmed` 等值，现有网关会拒绝。要么只用现有两个值，要么同时扩展枚举 + 控制中心 + 测试。这是最像 I-73 的坑。 |
| `rule.document` | 规则出处 | gateway `document: boundedString(64)`（`contracts-v2.ts:1030`） | 如果存完整 ADR 路径或长原话，会超过 64。要么限制在 64 内，要么扩展契约。加长度测试。 |
| `rule.params` | UI / 确认卡 / 导入 | 类型 schema；SQLite JSON；导出；裁判 | 每个类型单独 schema：金额整数最小单位、币种 ISO、时区 IANA、时间 `HH:MM`、星期 0-6 去重排序、`onUnknown` 枚举。写入和读取都校验；加 round-trip 测试。 |
| `rule.enabled` / `priority` | UI / 规则手册 | 裁判；UI；导出 | 布尔；priority 整数范围；排序稳定；加边界测试。 |
| `decision.ruleIds` | 通知闸门 / 动作闸门 | 决策记录 `inputs.ruleIds`；`ProactiveCheckInputs.ruleIds`；gateway `ruleIds: array(boundedString(256))`（`contracts-v2.ts:1104`）；UI | 排序、去重、长度限制。注意：现有 `ProactiveCheckInputs.ruleIds` 现在装的是 Gmail 地板规则 id（`proactive-mail-check-service.ts:1332`）；新规则如果也塞进这个字段，语义会混。建议新增 `ruleDecisions` 字段，或明确区分 `floorRuleIds` 和 `policyRuleIds`，并同步所有消费端。 |
| `decision.reasonCode` | 规则类型 / 闸门 | SQLite `reasonCode` 1-64；gateway `boundedString(64)`；UI | 限制 ≤64，固定大写蛇形；加测试。 |
| `notification.amount` / `currency` | 邮件判断 / 提取器 | 通知闸门；决策记录；outbox；UI | 金额用整数最小单位，币种 ISO 4217；缺失/低置信要显式表示；加解析和边界测试。 |
| `notification.sourceKey` / `readyAt` / `expiresAt` | 通知来源 / 闸门 | outbox 去重；web push `#deliver`；SQLite；通知记录 | `sourceKey` 确定性、≤长度限制；`readyAt`/`expiresAt` 用 RFC3339；延后释放时重新检查过期；加去重和过期测试。 |
| `ruleSetVersion` | 规则手册 | 闸门；决策记录；延后释放；导出 | 单调递增；延后释放时比较；如果进入 gateway/UI，新增字段要同步契约和测试。 |
| 配置键（如 `runPolicy.rules.*`） | `strict-configuration.ts` | 启动配置；运行时 | 如果新增配置键，必须在 `parseRunPolicy`/`parseProactive` 里解析，加 `startup-configuration.unit.test.ts`；未知键拒绝。建议规则存 DB，不新增配置键，减少这一层。 |
| 序列化格式（params、decision JSON） | 规则手册 / 闸门 | SQLite JSON；gateway；导出；UI | 固定键顺序、固定数组排序、固定数字格式；加 golden 测试。 |

另外要特别注意两个“语义被改变”的旧值：

- `proactive_settings.quiet_hours` 现在同时被 UI 命令 `proactive.settings.set`（`contracts-v2.ts:490-494`）、`readSettings`、`proactive-rules.quietUntil`、`production-proactive` 使用。迁到规则手册后，必须更新所有读取点，不能一边读旧字段一边读新规则，否则会出现两份静默。
- `ProactiveCheckInputs.ruleIds` 现在语义是“命中的地板规则 id”；如果新规则复用它，决策链、gateway、UI 都会把两种规则混在一起。建议新增字段或改名，并在所有消费端加测试。

结论：**只看改动本身不够。** 规则 id、type、origin、document、params、ruleIds、reasonCode、金额/币种、时间字段，每一个都要从生产端找到所有消费端，核对两端的长度、字符集、枚举、排序和去重规则，并加一个枚举整个类型目录的契约测试。这正是 I-73 的教训。
