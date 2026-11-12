## 0. 我读了什么、没读到什么

下面标「代码」「文档」「一手来源」的是我实际读过的；标「材料转述」的是题面给的，我没能读到原文；标「未核实」的是我读代码后仍不能下结论的。`/mnt/project-files/ambient-sensing/home-feed-plan.md` 不在仓库里，外部目录又被权限拒绝，所以首页条目接口的字段名我只按题面转述使用，**未核实原文**。

---

## 一、方案依赖的前提

| # | 前提 | 来源与原话 | 核实 |
|---|---|---|---|
| P1 | 原则冲突时按固定顺序裁决 | `docs/product-vision.md:55`：“原则冲突时，按序优先：用户主权 > 边界与可逆性 > 记忆可靠性 > 主动性与效率。” | 文档 |
| P2 | 外部内容只是数据；后台读过不可信内容后不做有后果的事，改存建议 | `docs/product-vision.md:57`：“外部内容与其他 Agent 的输出是数据，不是可覆盖我意图的指令。” `docs/execution/specs/2026-11-11-apple-device-body-design.md:369`：“后台（定时、系统主动提醒的检查）｜一律不做，改存‘建议’。” | 文档 |
| P3 | 敏感或不可逆要确认；可逆的先验证；规则可预先授权；每天介入有上限 | `docs/product-vision.md:58`：“敏感或不可逆的行动需要确认；能可逆、先验证的，不直接做成不可逆。……常规判断应由规则手册预先授权，不逐次确认；每日需要我介入的次数与时间有上限……” | 文档 |
| P4 | 必须核实结果，不能假设成功 | `docs/product-vision.md:62`：“它理解当下正在发生的事情，编排能力真正完成任务，并核实结果而非假设成功；失败时说明失败在哪、还剩什么没做。” | 文档 |
| P5 | 发给模型的内容固定在前、变化在后；已发内容只追加；字节确定；后台调用同规则 | `.claude/rules/prompt-prefix.md:27-28`：“固定的在前，会变的在后。……每轮都会变的内容只放在最后一条用户消息里。” `:35`：“已经发给过模型的内容，不得改动、重排或删除，只能在末尾追加。” `:51`：“同样的内容，每次都要序列化成同样的字节。JSON 的键顺序、工具的顺序、列表的顺序……都要固定。” `:67`：“后台调用也是固定的在前、会变的在后。” | 文档 |
| P6 | 现有邮件判断是一次批量调用，输出里没有动作字段 | `packages/application/src/services/proactive-mail-check-service.ts:232-241`：`interface Judgement { readonly result…; readonly confidence…; readonly todo…; readonly reason…; readonly dueAt…; readonly priority…; readonly usedMemoryIds…; readonly amount…; }` | 代码 |
| P7 | 提醒存储能改时间并带并发检查，但没有“改时间”的工具 | `packages/application/src/ports/memory-reminders.ts:36-44`：`update(input: { id; expectedUpdatedAt; status; dueAt; remindAt; … })`。`apps/agent-service/src/production-reminder-writer.ts:64-101` 只登记 `reminder_set`、`reminder_list`、`reminder_cancel`。 | 代码 |
| P8 | 审批绑定 runId 和意图快照，回答必须带版本号和内容指纹 | `packages/application/src/ports/authorization.ts:168-190`：`ApprovalRequest` 有 `runId`、`intentSnapshot`、`revision`、`semanticSnapshotHash`、`status`、`expiresAt`。`:205-213`：`ResolveApprovalInput` 要求 `expectedRevision` 和 `semanticSnapshotHash`。 | 代码 |
| P9 | 动作风险基线、审批创建和最高档的近期认证 | `packages/application/src/services/action-policy-service.ts:37-50`：`CREATE_OR_UPDATE: "MEDIUM"`、`COMMUNICATE: "HIGH"`、`DELETE: "HIGH"`、`PURCHASE_OR_FUNDS: "CRITICAL"` 等。`:493-511` 创建 `ApprovalRequest`；`:503`：`recentAuthenticationRequired: intent.finalRisk === "CRITICAL"`。 | 代码 |
| P10 | 规则手册现在只有两道闸门，动作闸门还没做 | `packages/application/src/rules/field-catalog.ts:9`：`export const RULE_GATES = ["mail_item", "mail_delivery"] as const;`。`docs/adr/0209-rule-book-with-cel-expressions-and-judge.md:104`：“第 3 步动作闸门……还没做”。 | 代码/文档 |
| P11 | 设备设计里已经有“建议”和“动作登记/结果未知不重放” | `docs/execution/specs/2026-11-11-apple-device-body-design.md:339`：“表 `perception_suggestions`：由‘其他’来源产生的、等主人点头的提醒或日程。……主人点‘好’时才真正去建。” `:536-547`：`device_actions` 状态 `queued → delivered → succeeded / failed / result_unknown / expired / rejected`，“回报没到……记 `result_unknown`，不自动重做”。 | 文档 |
| P12 | 首页条目的动作要有名称、绑定串、撤销和 why | 题面转述的 `/mnt/project-files/ambient-sensing/home-feed-plan.md`：每条有 `key`、`kind`、`awaitsOwner`、`sentence`、`actions`（动作名、肯定/否定、要不要本人在场、绑定串）、`undo`、`why`；“审批的绑定串里是审批编号、版本号、内容指纹，三样对不上就拒绝并让设备刷新”。 | 材料转述，未核实原文 |
| P13 | 业界做法：暂停等待、按原参数执行、人看到的是具体调用；高风险先问；恶意邮件能在无确认时改变行为 | OpenAI Agents SDK HITL：<https://openai.github.io/openai-agents-js/guides/human-in-the-loop>：“When a tool call requires approval, the SDK pauses the run, returns `interruptions`, and lets you resume later from the same `RunState`.”；“assigning your own code a version number and storing it along with the serialized state”。LangChain HITL：<https://docs.langchain.com/oss/python/langchain/human-in-the-loop>：“Execute the tool with the original arguments as proposed by the agent.”；“The `tool_call_id`, `name`, and `args` fields identify the call under review.” Apple 可操作通知：<https://developer.apple.com/documentation/usernotifications/declaring-your-actionable-notification-types>：“Actionable notifications let the user respond to a delivered notification without launching the corresponding app.”；“Because your app must handle all actions, you must declare the actions that your app supports at launch time.” Google Gemini in Gmail：<https://workspaceupdates.googleblog.com/2025/03/add-events-to-google-calendar-using-gemini-in-gmail.html>：“an ‘Add to calendar’ button will appear. Upon clicking this option, the side panel in Gmail will open to confirm…”。Anthropic Claude for Chrome：<https://claude.com/blog/claude-for-chrome>：“Claude asks users before taking high-risk actions like publishing, purchasing, or sharing personal data.”；“a malicious email claiming that, for security reasons, emails needed to be deleted. When processing the inbox, Claude followed these instructions to delete the user’s emails without confirmation.” | 一手来源 |
| P14 | 决策账本和模型用途是表约束，新增值要迁移 | `packages/persistence-sqlite/src/migrations/0089_consolidation_hold.sql:21-25`：`kind TEXT NOT NULL CHECK (kind IN (...))`；同文件 `:30-33` 的 `verdict` 约束。`packages/application/src/ports/model-usage.ts:3-13`：`MODEL_USAGE_PURPOSES` 是固定数组，题面事实 11 说加新用途要重建表。 | 代码 |

---

## 二、方案

### 1. 一句话

**把“动作”做成一个独立于提醒内容的、不可变的“已准备好的动作”对象：模型只从系统动态给出的动作目录里提名，服务器校验后冻结成带来源版本、目标版本、意图指纹和显示指纹的提案；主人点的是这版提案，服务器执行的也只能是这版提案，执行后读回核实，能撤销的才给撤销。**

不把动作塞进 `source_insights`，也不让模型直接产生工具调用。

### 2. 动作从哪里来

流程是两段，不在原来的邮件判断里加字段：

1. **原有判断不动。** `ProactiveMailCheckService` 仍然只产出 `Judgement`，不新增 `action` 字段。这样现有邮件判断的固定提示、输出契约、评测和请求字节都不变。
2. **新的动作规划调用。** 只对最终结果是 `act`、`confidence=sure`、并且会出现在提醒页的条目，发起一次独立的批量后台调用 `mail.action-plan`。它不是工具循环，仍然是一次批量模型调用。
3. **模型看到的动作目录是动态生成的。** 目录来自“已登记的可准备动作适配器”加现有能力清单（capability manifest），不是提示词里写死的“改提醒/回信/建日程”。每个动作登记：`capabilityRef`、`version`、`operation`、参数结构、风险档、是否可逆、是否要本人在场、读回办法、能否撤销、允许从哪些来源发起。第一期只登记服务器今天真能执行和核实的提醒动作（新增 `reminder.reschedule` 适配器；`reminder.create` 可复用现有 writer），回信和日历只有在 Gmail 写权限/日历写能力出现后才登记。**提示词里永远不列具体动作名**。
4. **模型看到的上下文。** 同一批邮件的遮盖后视图（和现有判断用同一套遮盖、同一正文上限）、同一批已注入记忆、以及一份**有界、排序后的目标快照**（例如未来的提醒：`ref`、`label`、`dueAt`，按 `(dueAt, ref)` 排序）。目标版本由服务器在快照里持有，**模型不输出版本号**；模型只输出它选中的 `targetRef`，服务器从自己发出去的那份快照里取版本。这样模型无法伪造版本。
5. **模型输出**（严格 JSON，最多一个动作/邮件）：
   ```json
   {"actions":[{
     "mailId":"...",
     "capabilityRef":"...",
     "operation":"...",
     "targetRef":"...",
     "arguments":{...},
     "evidence":{"messageId":"...","quote":"..."},
     "reason":"...",
     "usedMemoryIds":["..."]
   }]}
   ```
   `quote` 必须能在模型实际看到的遮盖后邮件里逐字找到；找不到就丢。没有明确动作、目标不唯一、目标不在快照里、参数不合法、证据对不上，一律不提出。
6. **服务器校验后才成为提案。** 校验：能力已登记且版本一致；参数过该动作的参数结构；目标在当前快照里；证据是遮盖后文本的子串；来源条目仍是 `act/sure`；没有超过每封/每次/每天上限；规则闸门没有拒绝。校验通过后冻结成 `prepared_action`。

> 这样“理解”仍然全部由模型做，服务器只做结构、证据、目标、权限和上限校验；没有关键词表、正则或写死词典。

### 3. 数据怎么存

新增一张通用表 `prepared_actions`（不是一个动作一张表），建议字段：

| 字段 | 作用 |
|---|---|
| `id` | `prepared-action:` 开头的标识，服务器生成 |
| `owner_id`, `agent_id` | 作用域 |
| `origin` | 来源类型，例如 `mail_insight`；只用长度校验，合法值由代码登记表在写入处校验，避免以后加来源要重建表 |
| `source_ref`, `source_version` | 来源条目 id；来源版本 = 对 `source_insights` 的 `id + content_ref + updated_at + last_message_id + result` 做规范化哈希 |
| `parent_decision_id` | 产生它的邮件判断决策记录 |
| `capability_ref`, `capability_version`, `operation` | 动作身份；必须和登记表及能力清单一致 |
| `intent_ref`, `semantic_snapshot_hash` | 密封的规范化动作意图；哈希用现有 `actionIntentFingerprint` 一类规范化函数 |
| `preview_ref`, `preview_version`, `display_hash` | 密封的精确显示内容（从同一份规范化参数渲染）和显示指纹 |
| `target_ref`, `target_expected_version` | 目标及其版本（例如提醒的 `updatedAt`） |
| `risk_level`, `requires_owner_presence` | 来自动作登记表 + 现有风险计算 |
| `status` | `ready`（可直接执行）/ `awaiting_owner`（等点击）/ `executing` / `succeeded` / `failed` / `result_unknown` / `expired` / `declined` / `superseded` |
| `idempotency_key` | 唯一，执行去重 |
| `expires_at` | 过期时间 |
| `execution_ref`, `readback_ref` | 执行结果引用和读回证据（密封） |
| `undo_ref`, `undo_status` | 撤销所需的前一状态和撤销状态 |
| `revision`, `created_at`, `updated_at` | 版本和审计 |

不把动作塞进 `source_insights` 的原因：`source_insights` 是“每个邮件线程一行”的提醒内容，修改它就会改变主人看到的内容；动作有独立的审批、执行、核实、撤销生命周期，还有多个版本。混在一行里会直接破坏“显示和实际一致”和追加式版本绑定。

**状态机**：

```
ready / awaiting_owner
   ├─ 主人点肯定 → executing → succeeded → (可选) undone
   │                         ├→ failed
   │                         └→ result_unknown → 读回核实 → succeeded / failed
   ├─ 主人点否定 → declined
   ├─ 过期 / 来源或目标变了 → expired / superseded
   └─ 新邮件使提醒更新 → 旧提案 superseded
```

### 4. 主人看到什么、怎么绑定

首页条目接口里，提醒条目仍然由 `source_insights` 产生；动作从 `prepared_actions` 里取当前有效的一条（默认每封最多一条，上限是设置项）。条目形如：

- `key`：`proactive-insight:<insightId>`
- `sentence`：现有 `summary/reason`
- `actions`：
  - 肯定动作：动作名 = `capabilityRef`（例如 `reminder.reschedule`），预览由服务器从**同一份规范化参数**渲染，例如“把「出门提醒」改到 09:40（Asia/Tokyo）”，并附原时间；
  - 否定动作：“不改”，只把提案标成 `declined`，提醒本身不动；
  - 原有“完成”“不再提醒”继续保留。
- `undo`：只有执行成功且登记表声明“可真正撤销”时才给，且绑定执行后的版本。
- `why`：看到的（邮件）、你的规则（`mail_item` + `action_proposal` 的规则 id）、用到的记忆（`usedMemoryIds`）；动作本身另给“目标 + 新值 + 证据原话”。

**绑定串**建议：

```
v1.<proposalId>.<revision>.<intentHash>.<displayHash>
```

设备只回传条目编号、动作名、绑定串、请求编号；**不回传参数**。服务器按 `proposalId` 取出冻结的行，重新计算 `intentHash` 和 `displayHash`，并核对：

- `revision` 一致；
- `source_version` 仍等于当前 `source_insights` 的版本；
- `target_expected_version` 仍等于目标当前版本；
- 提案仍在有效期内、状态允许；
- 规则与权限重新判过后仍允许。

任何一项对不上就拒绝，并让设备刷新。这样即使界面显示的是旧版，也不会执行新参数；即使设备被篡改，也不能通过请求体换参数。

### 5. 主人点头后怎么执行、怎么核实

`/api/device/v1/home/act` 收到点击后，按种类转成一个新的现有命令（例如 `proactive.insight.action`），服务器：

1. **认证**：现有设备签名/主人身份；请求编号进入现有网关幂等记录，同一请求编号重放返回上次结果。
2. **校验绑定**：见上。
3. **权限和审批**：把冻结的意图送进现有 `ActionPolicyService`。
   - 返回 `ALLOW`：直接执行；
   - 返回 `ASK`：因为主人已经看到了这版动作并点了它，点击本身就是同意。服务器用现有 `GrantService` 生成一次性授权，并调用现有 `ApprovalService.respond` 以 `expectedRevision` + `semanticSnapshotHash` 立即记录这次同意；审批编号、版本、指纹写进执行记录。
   - 返回 `DENY`：不执行，返回规则/能力/策略原因。
   - 需要主人在场的动作：`home/act` 必须带近期认证凭据；没有就拒绝。
4. **单次领取**：在 SQLite 事务里把 `ready/awaiting_owner` 原子改成 `executing`（带 `revision`、状态条件）。两个设备同时点，只有一个能领取；另一个返回“已在执行”或上次结果。
5. **执行**：只使用冻结行里的规范化参数，调用动作适配器。例如 `reminder.reschedule` 调 `MemoryReminderStorePort.update({ id, expectedUpdatedAt: target_expected_version, status: "scheduled", dueAt, remindAt, ... })`。
6. **读回核实**：
   - 提醒改时间：重新 `read(id)`，要求 `status=scheduled`、`dueAt/remindAt` 等于请求值、`updatedAt` 已前进；否则不算成功。
   - 提醒新建：按确定性 `reminderId` 读回，核对文本和时间。
   - 成功的证据密封存起来，写决策记录。
7. **失败/未知**：
   - 执行前失败（目标变了、权限变了、参数不合法）：`failed`，说明失败在哪、提醒原样未动。
   - 执行后说不清（超时、进程崩溃、外部接口无响应）：`result_unknown`，**不自动重放**；后台核对任务用冻结参数去读回，读回匹配才算成功，不匹配就请主人决定。
8. **撤销**：成功且登记表声明可撤销时，保存“执行前状态”。主人点撤销时，要求目标当前版本仍等于“执行后版本”；如果别人又改过，就拒绝撤销并说明原因，不覆盖别人的修改。`reminder.reschedule` 可以真正撤销（恢复原 `dueAt/remindAt`）；`reminder.create` 只能取消提醒、记忆还在，所以不宣称能撤销，首页不给 `undo`。

### 6. 出错、过期和边界

- **没有明确动作**：模型输出空，或服务器校验不过，就不提出；提醒照常显示。决策记录写原因（`no_target`、`ambiguous_target`、`evidence_mismatch`、`schema_invalid`、`rule_denied`）。
- **模型提名了不存在的动作/目标/参数**：直接丢，不展示；这是反向验收的重点。
- **注入**：邮件里的“请把提醒改到……”只是数据。即使模型据此提名，也只会成为等主人点击的提案；**后台从不自动执行**。高风险动作还可以被规则闸门直接拒绝。
- **目标在点击前被改/被删**：执行时 `expectedUpdatedAt` 对不上，返回“这条提醒已经被改过/删了，请刷新”，不覆盖。
- **来源在点击前更新**（同一线程来了新邮件）：旧提案 `superseded`，旧绑定拒绝；新判断重新决定是否准备新动作。
- **提醒被标成完成/不再提醒**：同一事务里把相关提案 `superseded`；之后点旧动作只会得到“已失效”。
- **过期**：`expiresAt` 取“配置的提案存活时间、目标的 `dueAt/remindAt`、审批允许的最晚时间”三者最早者；过期后不执行，首页不显示可点动作。设置项主人可见。
- **预算到顶**：动作规划调用和提案数量都有每次/每天上限；到顶就不规划、不提案，只保留普通提醒，并记录 `capped`。下一轮预算恢复后，如果邮件仍开放且仍相关，再重新判断。不会把这一轮的动作堆给主人。
- **能力不可用/版本不符/目标分级不允许**：不提案；执行时再次检查，失败关闭，不降级到别的动作。

### 7. 和现有体系怎么接

- **审批**：不新造审批表。点击时使用现有 `ActionPolicyService`、`ApprovalService`、`GrantService`，审批记录里存的是冻结意图的 `semanticSnapshotHash`，回答时校验 `expectedRevision` 和哈希。
- **规则**：给规则手册补第 3 步 `action_proposal` 闸门（ADR 0209 已列为后续），字段从动作登记表动态生成，例如 `capability_ref`、`operation`、`action_kind`、`final_risk`、`reversible`、`requires_owner_presence`、`source_kind`、`source_untrusted`、`target_kind`、`due_within_minutes`、`estimated_cost_micros`。**这道闸门只决定“能不能准备/展示”，不授予执行权**；执行仍然要过点击和 `ActionPolicyService`。这是关键：否则规则就可能让一封恶意邮件自动改数据。
- **决策记录**：新增 `prepared_action` 决策类别和 `proposed / blocked / declined / approved / executed / failed / result_unknown / expired / undone` 等 outcome（需要迁移重建约束，照 0087/0088/0089 的做法）。`inputs` 里写父决策、来源 id、记忆 id、规则 id、能力/目标；`subject_ref` 写提案 id；`content_ref` 写冻结的显示/意图。邮件检查原有的 `ruleIds/sourceIds/memoryIds/usedMemoryIds` 继续保留。
- **模型用途**：新增 `mail-action-plan` 用途，需要重建 `model_usage` 表的约束（题面事实 11）。成本归到父邮件检查决策里，避免 `costSince` 双算；提案行可另存 `plan_cost_micros` 供审计，但不再计入日上限。
- **首页条目接口**：新增 `proactive.insight.action` 命令，由 `home/act` 按种类转发；设备只传绑定串，不传参数。三类苹果设备和网页都读同一份服务器数据、同一个绑定函数。
- **runId 的坑（题面 I-73 同类）**：`approval_requests.run_id` 有 `REFERENCES runs(id)`（`0001_initial_product_schema.sql:183`），而主动邮件检查的模型调用用的是 `proactive:<invocationId>`（`production-model-composition.ts:533`），**未必有对应的 runs/triggers 行**。所以不能在提案时直接插一个 `ApprovalRequest` 假装有 run。本方案把审批放到点击时创建，并在同一个请求里用现有 run 准入路径建一个真实的后台 run 容器；实现前必须用真实 SQLite 验证插入成功，不能只测解析。**具体 run/trigger 创建路径我未核实到实现级。**
- **需要主人在场的高风险动作**：现有代码只有 `finalRisk === "CRITICAL"` 才要求近期认证（`action-policy-service.ts:503`）。如果登记表要给某个 `HIGH` 动作单独要求本人在场，不能靠把它硬升成 `CRITICAL`；应给 `GovernedActionIntent` 增加一个来自登记表的确定性事实，并把审批创建条件改成“`finalRisk === CRITICAL` 或该事实为真”，同时加反向测试。第一期只有 MEDIUM 的提醒改时间，不涉及这一点。

### 8. 怎么量它做得好不好

每个数字给出定义，全部从 `prepared_actions` + `decision_ledger` 算，不用估计值：

- **提案率**：出现了准备的 `act` 提醒中，至少有一条有效提案的比例；分母写清楚是否排除被规则拒绝/预算到顶的。
- **接受率**：点击肯定 /（肯定 + 否定 + 过期）；被新邮件取代的不算，单独列。
- **执行成功率**：`succeeded / (succeeded + failed + result_unknown)`。
- **核实一致率**：读回与请求一致 / 执行尝试次数。
- **撤销率**：撤销次数 / 成功次数；再列“撤销时发现目标已被别人改过”的次数。
- **误扰率**：执行后主人评 `unneeded` 或撤销 / 成功次数；样本量一起显示。
- **过期/失效原因分布**：目标变了、来源更新、时间到了、规则变了，各多少。
- **成本**：动作规划调用次数、费用、每次/每天上限；与邮件判断分开显示。
- **没提出动作的样本**：每周人工/模型复核一部分 `act` 但没有提案的条目，记录“确实不需要”或“漏了”；不用关键词自动判定。

这些数字进现有主动提醒周报，样本量不足时不显示百分比，只显示次数。

### 9. 分几步做

1. **第 1 步：存储、版本、执行器，不接模型。** 迁移 `prepared_actions`、决策账本新类别、模型用途；规范化快照/双指纹；`reminder.reschedule`（以及可选的 `reminder.create`）适配器的执行、读回、撤销；真实 SQLite 集成测试；功能开关默认关。
2. **第 2 步：动作规划调用。** 新固定提示 `mail.action-plan` + 动态目录/目标/记忆的数据段；严格解析和证据/目标校验；每次/每天上限；规则 `action_proposal` 闸门；反向验收集；提示字节确定性测试。仍不上面向主人的首页动作。
3. **第 3 步：首页条目和一次点击。** 条目加 `actions`、`binding`、`undo`；`home/act` → `proactive.insight.action`；点击时审批/授权、幂等、单次领取；来源更新/完成/不再提醒时失效；契约往返测试。
4. **第 4 步：核实、对账和度量。** 每个适配器读回；`result_unknown` 对账任务；周报/用量页；设置项（数量、TTL、上下文上限、成本）可见；显式反馈接入。
5. **第 5 步：扩动作类型。** 等 Gmail 写权限/日历写能力/设备动作存在后，逐个登记回信、建日程等；每个都补风险档、本人到场、读回、撤销。规划提示和首页协议不再改。

---

## 三、考虑过但不选的做法

1. **把动作字段直接加进现有 `Judgement`，一次调用同时判断和准备动作。** 不选：会改动已经调好的邮件判断契约和固定提示；把“重不重要”和“做什么”耦合，输出变长、失败模式变多；动作规划的成本和上限无法单独控制。分开调用保住现有请求字节和评测。
2. **让模型直接输出工具调用/任意命令。** 不选：外部邮件是不可信内容，模型可能被注入；任意参数没有闭集校验；显示和实际容易不一致。必须由服务器从动态动作目录里校验后冻结。
3. **把动作塞进 `source_insights` 加几列。** 不选：提醒是一线程一行，动作有独立生命周期、审批、执行、读回、撤销；改这一行会改变主人看到的内容，破坏版本绑定。
4. **只把提案塞进 `ApprovalRequest.intentSnapshot`，不建新表。** 不选：审批生命周期表达不了 `executing/succeeded/failed/result_unknown/undone`、读回证据、来源版本、目标版本和首页显示；会混淆“建议”和“审批”。
5. **直接复用未接线的 `SuggestionService` / `AttentionPolicyService`。** 不选：它们没有生产接线，只创建一个普通任务，没有审批、执行、读回、撤销、首页绑定。可以借用它的去重键、每日配额、过期和 CAS 思路，但不能把动作执行塞进去。
6. **直接复用设备设计的 `perception_suggestions`。** 暂不选：它是设备感知来源的、尚未实现的表，字段围绕“建提醒/建日程”；邮件动作需要精确参数、审批绑定、执行器、读回和撤销。以后可以把 `perception_suggestions` 作为同一个 `prepared_actions` 的来源适配器统一，但那是需要主人拍板的合并，不是现在偷偷造两套。
7. **自动执行低风险/可逆动作，或让规则预先授权后直接执行。** 不选：邮件是外部内容，主动检查是后台；设备设计明确写“后台读过不可信内容后一律不做，改存建议”（`apple spec:369`）。规则最多决定“准不准准备”，不能决定“直接执行”。
8. **点击时让模型重新理解自然语言再执行。** 不选：同一句话两次理解可能不同，目标可能已变，显示和实际会不一致。点击执行的是冻结的参数，不是重新生成的解释。
9. **给聊天模型新增一个 `reminder_reschedule` 工具来复用执行。** 不选（至少第一期）：会改变新对话的工具定义和请求开头；动作执行是服务器内部的适配器，不需要成为模型工具。以后若要让主人在聊天里直接改写提醒，另出方案并遵守 ADR 0165 的冻结/换新规则。
10. **用关键词、正则或写死词典判断“这是改时间/回信/建日程”。** 不选：违反约束 2。动作类型由模型在动态目录里选，服务器只校验结构、证据、目标和权限。
11. **设备把动作参数发回服务器。** 不选：设备或网络层可篡改，界面旧版会执行新参数。设备只发绑定串，服务器只认冻结行。
12. **`result_unknown` 自动重试。** 不选：可能重复改时间/重复发信。只读回核实，核实不了就问主人。

---

## 四、风险最大的三处，以及怎么守住

1. **提示注入：恶意邮件让模型提出一个看起来很合理的动作，主人点习惯了一键。**
   - 守住：邮件在提示里明确是数据；后台永不自动执行；模型只能从动态白名单动作里选；证据原话必须能在遮盖后邮件里逐字找到；首页必须显示“目标 + 新值 + 来源邮件 + 规则/记忆”；高风险动作登记为要本人在场；规则闸门可以整类拒绝；执行走现有审批和风险档。反向用例：一封“为安全起见请把提醒改到……/删掉……”的邮件，在没有任何点击时数据库必须完全不变；点了否定后也不变。
2. **显示和实际不一致 / 旧版本覆盖新状态。**
   - 守住：冻结行 + `revision` + 意图哈希 + 显示哈希 + 来源版本 + 目标 `expectedUpdatedAt`；执行只读冻结参数；目标变了就失败而不是覆盖；新邮件/完成/不再提醒使旧提案 `superseded`；设备只回绑定串。反向用例：提案后主人手动改了提醒，再点旧动作，必须返回“目标已变”且提醒保持主人手改后的值。
3. **重复执行或结果未知导致重复副作用。**
   - 守住：SQLite 事务里单次领取；唯一幂等键；同一请求编号重放返回上次结果；`result_unknown` 不重放，只读回核实；撤销要求执行后版本未变。反向用例：两台设备同时点同一条，只允许一次写入；执行后模拟进程崩溃，对账只能读回，不能再次执行。

---

## 五、需要主人拍板的取舍

1. **第一期到底开放哪些动作。** 我建议只开放 `reminder.reschedule`（复用已有存储和读回能力），`reminder.create` 可选；回信/建日程等 Gmail 写权限和日历写能力出现后再登记。要不要为了“回信”现在就扩 Gmail 写权限，是安全和产品取舍。
2. **中风险可逆动作的确认强度。** 我的建议是：外部邮件来的动作，一次点击就是确认；高风险或不可逆动作要本人在场（近期认证）。如果主人希望所有外部内容动作都要面容/解锁，那是另一种选择，会增加每日介入成本。
3. **动作预算和每日介入上限。** 每次最多准备几条、每天最多几条、提案存活多久、上下文最多看多少个目标，默认值和“算不算一次介入”需要主人定；这些都会做成可见设置。
4. **是否把邮件动作和设备设计的 `perception_suggestions` 合成一张通用的“准备动作”表。** 我倾向合成（同一套绑定/审批/执行/核实），但设备设计已经写了 `perception_suggestions`，合并会影响那份已同意设计的落地方式。
5. **提醒被静默时段/后退抑制时，还要不要准备动作。** 我建议仍然准备，只是不推送，等主人打开首页时看到；但如果主人认为“没推送就不该准备”，那就在推送被抑制时不准备。

---

## 六、逐条回答必答问题

### 1. 这个改动会不会改变模型已经见过的请求开头？发给模型的内容是不是仍然只在末尾追加，每轮会变的值是不是都在最后一条消息里？

**不会改变已经见过的对话请求开头。**

- **系统提示**：现有聊天系统提示不动；现有邮件判断的固定提示也不动（不往 `Judgement` 加字段）。新增的 `mail.action-plan` 是**新的后台调用**，没有任何旧对话见过它的开头，也不存在“追加到旧历史”的问题。
- **工具定义**：聊天工具定义不动。我们**不**新增 `reminder_reschedule` 这类聊天工具；动作目录是动作规划提示里的**数据段**，不是工具定义。因此不会因为工具集合变化触发 ADR 0165 的换新。
- **历史消息**：不动任何对话历史；动作规划调用不读对话历史，也不往任何对话里追加消息。
- **遮盖结果**：动作规划复用现有邮件判断的遮盖规则和同一正文上限；遮盖是确定的，不依赖后面的内容。证据原话按模型实际看到的遮盖后文本核对，不会把原始秘密写进新提示。
- **“只追加”**：对现有会话，仍然是只在末尾追加；这个改动完全不碰会话历史。对动作规划这个后台调用，排法是“固定指令 → 本次的遮盖后邮件/动态动作目录/排序后的目标/记忆 → 最后的 `now`/时区/今天”。**每轮会变的值只出现在数据段末尾和最后的 `now` 里，不进入固定指令。**
- 如果以后把动作字段并进现有邮件判断，那个后台调用的固定开头会变一次；本方案明确不做，避免这个代价。依据：`prompt-prefix.md:27-28、35、51、67`。

### 2. 这个改动会不会让同一段文字在不同请求里变成不同的字节？

**不会因为我们的改动而变；可能有意的差异只有“当前时间”和当次目标状态，且都在动态数据段/末尾。**

控制点：

- JSON 键顺序固定；动作目录按 `(capabilityRef, operation)` 排序；目标按 `(dueAt, ref)` 排序；记忆按 id 排序；来源邮件按现有固定顺序。不依赖数据库返回顺序或对象遍历顺序。
- 时间统一用规范 ISO，不在提示里做本地化格式化；`now`、时区、今天只在最后。
- 动作目录的 `version/description/参数结构` 在同一次部署内固定；能力升级就换版本，这是有意变更，不是同一内容的随机字节。
- 遮盖确定：同一段文本 + 同一遮盖密钥 → 同一结果；不依赖后面的消息。动作规划是独立调用，不存在“后面的消息改变前面遮盖”的问题。
- 主人看到的动作预览**在提案创建时生成并密封**，之后不重新渲染；绑定里带 `display_hash`。同一份冻结参数每次得到同一份显示和同一份哈希。
- 反向测试：同一输入、打乱数据库行顺序和对象键顺序，两次构建的提示必须逐字节相同；只有把 `now` 改掉时，只允许末尾不同。删掉排序或换成本地化格式，测试必须失败。

### 3. 改动有没有对应的自动检查，反向用例是否真的会失败？

有。分四层：

- **现有门槛**：`npm run check:prompt-prefix` 继续跑；新增动作规划提示的字节确定性测试（同上）。`npm run check:expensive-models` 保证不引入贵模型。若新增模型引用，`check:model-ref-contract` 保证清单里的引用能过后端校验（I-73 的教训）。
- **真实 SQLite 集成测试**：提案创建、首页绑定、点击、审批/授权、执行、读回、撤销、过期、并发点击、进程崩溃后的对账，全部走真实 SQLite，不用假替身。
- **反向验收（不该提出/不该执行的输入）**：
  - 促销邮件、`ignore`/`check`、`act` 但 `unsure`、没有明确目标、目标不唯一、目标不在快照、证据原话对不上、参数不合法、能力未登记、规则拒绝、预算到顶：断言**没有提案**，数据库不变。
  - 注入邮件：不点击时数据库完全不变；点“不改”后也不变。
  - 新旧版本：提案后来了同线程新邮件、主人先手动改了提醒、提醒被完成/不再提醒、提案过期、审批哈希/版本不对：点击必须被拒绝，目标保持原值。
  - 重复执行：两个设备同时点，只允许一次写入；同一请求编号重放返回上次结果，不再执行。
  - 结果未知：执行后模拟崩溃，对账只能读回，不能再次执行。
  - 撤销冲突：执行后目标又被别人改过，撤销必须拒绝，不覆盖。
- **“去掉守卫就失败”**：每个守卫都配一条在守卫缺失时必红的用例。例如：
  - 删掉 `expectedRevision/semanticSnapshotHash` 比对 → 旧绑定测试会执行（失败）；
  - 删掉目标 `expectedUpdatedAt` 检查 → 目标被改后仍覆盖（失败）；
  - 删掉单次领取/幂等键 → 双击测试出现两次写入（失败）；
  - 删掉证据子串检查 → 模型幻觉目标也生成提案（失败）；
  - 删掉来源版本检查 → 新邮件后旧动作仍执行（失败）；
  - 删掉“预览从规范化参数渲染” → 显示/执行不一致测试（失败）；
  - 删掉排序 → 提示字节确定性测试（失败）；
  - 删掉 `mail-action-plan` 的用途迁移 → 用量插入失败（失败）。
  实现前先在旧代码/去掉守卫的版本上跑这些用例，确认红；PR 里写明哪条用例、删掉哪一处会红。

### 4. 改动产生或修改的每个值，每一个使用它的地方都能接受吗？

下面把新值逐个列出来，并说明产生端和使用端的校验。**I-73 的教训是：不能只测“生成出来的清单/解析”，要把生产端真实生成的值交给消费端校验一遍。** 因此第 2 步和第 3 步都要有“契约往返”测试：用登记表里每个动作真实生成的 `action name`、`binding`、`id`，分别过首页契约、`/home/act` 解析和实际执行器，而不是只测解析函数。

| 值 | 产生处 | 使用处 | 两端校验 / 反向用例 |
|---|---|---|---|
| `prepared_actions.id` | 服务器 id 生成器 | 首页 `key`/绑定、`/home/act`、决策 `subject_ref`、审计 | DB 长度 1-128；网关 `machineString` 字符集；用共享的 `preparedActionIdString`；往返测试；非法字符两边都拒绝 |
| `source_insights.id` / 条目 `key` | 邮件检查写入 | 首页条目、提案 `source_ref` | DB 长度/唯一约束；首页契约字符串；同一条目在三端读到同一个 id |
| `source_version` | 提案创建时对 `source_insights` 规范化哈希 | 首页过滤、点击拒绝 | 两端都从当前行重算；新邮件后旧绑定测试必须失败 |
| `capability_ref`、`capability_version`、`operation` | 动作登记表 + 能力清单 | 规划提示目录、解析器、`ActionPolicyService`、执行器、CEL 字段、DB | 创建时：登记表存在、版本/操作匹配、能力健康；点击时：再查一次；未知/版本不符拒绝；每个登记值跑一遍“提示解析 + 执行器 + 首页契约” |
| 规范化 `arguments` | 动作适配器 `normalize` | 执行器、预览渲染、意图快照 | 适配器参数结构校验；执行器只读冻结参数；预览和执行用同一份参数；显示/执行不一致测试 |
| `target_ref`、`target_expected_version` | 目标快照 + 适配器 | `reminders.update` 的 `id` 和 `expectedUpdatedAt` | 目标必须在服务器发出去的快照里；版本必须等于当前；目标被改测试 |
| `semantic_snapshot_hash` | `actionIntentFingerprint` 一类规范化函数 | `ApprovalService`、执行器 | 两边都重算并比对；64 位十六进制；旧版本/被改意图测试 |
| `display_hash` | 预览渲染器 | 首页绑定、点击 | 从密封预览 + 预览版本重算；显示被改测试 |
| `binding` | 首页绑定函数 | `/home/act` 解析器 | 共享字符集/长度/分段格式；每个动作真实绑定往返；畸形绑定两边都拒绝 |
| `revision` | 提案状态机 | 绑定、审批 `expectedRevision`、CAS | 整数 >=1；点击时严格相等；旧 revision 测试 |
| `status` | 提案状态机 | 首页过滤、点击、过期、对账、度量 | 固定状态枚举；DB CHECK；非法转移测试 |
| `expires_at` | 配置 + 目标时间 | 首页、点击、审批 | 规范 ISO；过去时间拒绝；过期测试 |
| `idempotency_key` | 提案 id（+ 执行尝试） | 提醒写入/执行器、网关幂等 | 唯一约束；双击/重放测试 |
| `execution_ref`、`readback_ref` | 执行器/读回 | 首页结果、决策记录、撤销、对账 | 密封存储；成功必须有读回；无读回不得标成功 |
| `undo_ref`、`undo_status` | 执行成功时保存的执行前状态 | 首页 `undo`、撤销命令 | 只在登记表声明可撤销时产生；撤销时目标版本必须等于执行后版本；冲突测试 |
| 设置键（动作数量/TTL/上下文/成本） | 服务器设置模式 | 服务、设置 API、网页/设备、测试 | 生产端和消费端同一份范围校验；坏值两边都拒绝；默认值可见；I-16 式跨端同步测试 |
| 模型用途 `mail-action-plan` | 动作规划调用 | `model_usage` 表约束、用量报告 | 迁移后插入成功；旧代码/旧约束下必须失败；报告按用途能查 |
| 决策类别 `prepared_action` 及 outcome | 提案/执行服务 | `decision_ledger` 约束、周报、首页 `why` | 迁移后插入/查询成功；非法 kind/outcome 被 DB 拒绝；去掉迁移测试失败 |
| 规则闸门 `action_proposal` 及字段 | `field-catalog` / 动作登记表 | CEL 编译/裁判、规则页、回放 | 每个字段都有值；未知字段被拒绝；回放使用同一套字段；字段清单往返测试 |
| 首页动作名 | 动作登记表 | 首页契约、`home/act` 分发 | 真实生成的动作名必须过两个包的字符串校验；未知动作名拒绝 |
| 请求编号 | 设备 | 网关幂等/回执 | 同一编号重放返回同一结果；不同编号但同一提案已成功不重复执行 |
| `origin` | 来源适配器 | 写入校验、查询过滤 | 代码登记表校验；非法来源被拒绝；以后加来源不需要改 DB 约束 |
| `data_classification` | 提醒/邮件来源 | 能力 manifest 的 `dataClassifications`、动作策略 | 能力未声明该分级就拒绝；敏感/受限不准备或走更保守路径 |

其中最容易犯 I-73 类错误的是 `capability_ref`、`binding`、设置键、模型用途和决策类别这五个：它们分别会被数据库约束、网关契约、设置解析器、用量表和决策账本消费。方案要求**用生产端真实生成的值逐个跑消费端**，而不是只测“清单解析”和“界面展示”。

---

**最需要强调的一句**：这个方案的核心不是“让模型多说一个动作字段”，而是把模型提名的动作变成**服务器冻结、主人按版本点头、服务器执行并读回核实**的对象；模型可以提错，但错的动作不能被悄悄执行，旧版本也不能覆盖新状态。
