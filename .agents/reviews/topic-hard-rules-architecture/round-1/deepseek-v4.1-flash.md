# Himawari 硬规则架构方案

## 先给结论

我建议不要做“把 54 条规矩都变成硬规则”，而是把规则手册拆成三层，并把“硬规则”实现成**宿主程序里的规则引擎 + 代码定义的规则类型 + 数据库里的规则数据 + 每次运行固定的规则快照**。Pi 只做最后一层工具闸门和观测，不承担主要执行责任。

一句话概括：

> **规则类型是代码，规则实例是数据；数据带正反例，快照按运行固定，执行在宿主，模型只在最后一条消息里看到规则手册。**

这样既能满足 ADR 0163 的“偏好是数据、只有新类型才写代码”，又能让“硬”有真正的程序语义，而不是把文字换个地方写。

---

# 一、方案依赖的前提

## A. 产品与 ADR

1. **规则不是记忆，是硬性设定；每条有回归测试。**
   > “规则不是记忆，是硬性设定：记忆只保存一条规则的出处和修改历史；规则本身写进程序、必定执行，每条都有回归测试守着。”
   来源：`docs/product-vision.md:59`。

2. **测试覆盖“规则类型”，不是每条偏好写一份代码。**
   > “回归测试按规则类型写，不按每条偏好写……Andy 的每条具体偏好只是数据，由已经测试过的程序执行。”
   > “只有出现全新的规则类型，才要加代码和测试。”
   来源：`docs/adr/0163-owner-preferences-as-data-run-by-tested-rule-types.md:37-45`。

3. **一句话变成长期规则要经过确认卡；一次性拒绝不变成长期规则。**
   来源：同文件 `:49`。

4. **规则要能导出为 SKILL.md，在 Claude Code 与 Codex 加载后仍通过 Jarvis #1/#6。**
   来源：`docs/product-vision.md:157`。

## B. 缓存与请求开头

5. **固定在前、变化在后；每轮会变的值只放最后一条用户消息；系统提示和工具不得出现会变的值。**
   > “固定的在前，会变的在后……每轮都会变的内容只放在最后一条用户消息里。”
   来源：`.claude/rules/prompt-prefix.md:27-28`。

6. **已经发给模型的内容只能追加，不能改、重排、删除。**
   > “已经发给过模型的内容，不得改动、重排或删除，只能在末尾追加。”
   来源：`.claude/rules/prompt-prefix.md:35`。

7. **系统提示和工具按对话冻结；改提示词文字只对新对话生效。**
   来源：`.claude/rules/prompt-prefix.md:41`；`docs/adr/0165-freeze-the-request-head-per-conversation.md:58-64`。

8. **同样的内容必须序列化成同样的字节；JSON 键顺序、列表顺序都要固定。**
   来源：`.claude/rules/prompt-prefix.md:51`。

9. **遮盖必须是确定的；已发历史不因后来的消息改变。**
   来源：`.claude/rules/prompt-prefix.md:52-54`。

## C. Pi 1.5.0 的实际能力边界

10. **Pi 没有内置权限系统，也不在每次工具调用前征求批准。**
    > “Pi does not include a built-in permission system for restricting filesystem, process, network, or credential access.”
    > “it does not ask for approval before every tool call.”
    来源：`https://github.com/earendil-works/pi/blob/v1.5.0/packages/coding-agent/docs/security.md`。

11. **`tool_call` 可以 `{ block: true, reason }`，并行工具调用先依次预检、再并发执行；`event.input` 改了不再校验；扩展抛错会拦下工具（fail-safe）。**
    来源：`https://github.com/earendil-works/pi/blob/v1.5.0/packages/coding-agent/docs/extensions.md` 的 “Tool Events / Error Handling”。

12. **`before_agent_start` 可以改系统提示，`context` 每次调用模型前可改消息，`before_provider_request` 可以替换完整请求体。**
    来源：同上 “Agent Events / Model Events”。

13. **扩展是进程内 TypeScript，与 Pi 同权限；项目扩展要先过项目信任。**
    来源：同上 “Extension Locations / Security”；`security.md`。

14. **Pi 的 Agent 核心另有 `beforeToolCall`/`afterToolCall`/`transformContext`，但这对 Himawari 的主路径不是主要拦截点。**
    来源：材料给出的 `packages/agent/src/types.ts`；本仓库实际使用的是扩展工厂，见 `packages/runtime-pi/src/pi-runtime-adapter.ts:1420-1503`。

## D. Himawari 现有实现

15. **Gmail 的硬规则目前是三段硬编码常量 + 一个 3 条的目录。**
    来源：`packages/application/src/services/proactive-rules.ts:9-12`（公共机构后缀、金钱词）、`:29-58`（`FLOOR_RULE_IDS`、`DECISION_RULE_CATALOG` 只有 3 条）、`:66-121`（地板、上不上提醒页）。
    执行和账本：`proactive-mail-check-service.ts:805-850`、`:1331-1345`。

16. **动作授权已有 DENY/ASK/ALLOW、资源前缀、额度、批准哈希。**
    来源：`packages/application/src/services/action-policy-service.ts:316-325`（DENY 规则）、`:398-417`（安全读 ALLOW）、`:419-521`（ASK/批准）；`packages/application/src/ports/authorization.ts:77-87`（`PermissionPolicyRule`）。

17. **聊天里的“主人要求”仍靠记忆：`rule` 类记忆、模型分类、2000 字预算。**
    来源：`packages/application/src/services/owner-profile-service.ts:14`、`:203-206`、`:288-307`；`docs/agent-rulebook-inventory.md:145-149`、`:202-203`。

18. **`decision_ledger` 记录 `ruleIds`，但非 `proactive` 写入只落四个键，其他字段会被丢掉。**
    来源：`packages/persistence-sqlite/src/sqlite-decision-ledger-operations.ts:117-122`；`docs/execution/specs/2026-11-09-decision-record-write-convention.md:32-35`。

19. **`proactive_settings` 改动静默覆盖，没有版本号和历史。**
    来源：`docs/agent-rulebook-inventory.md:175`、`:204`；`docs/adr/0163...:44`。

20. **盘点结论：54 条规矩分散在代码、提示词、记忆、设置；除 Gmail 外聊天规矩几乎没有硬的；同类规则代码和提示词各写一份且已对不上。**
    来源：`docs/agent-rulebook-inventory.md:52-57`、`:199-206`。

## E. 业界一手资料

21. **Claude Code：权限规则按 deny → ask → allow 顺序，第一个命中的决定；规则由 Claude Code 执行，不由模型执行。**
    > “Rules are evaluated in order: deny, then ask, then allow. The first match in that order determines the outcome.”
    > “Permission rules are enforced by Claude Code, not by the model.”
    来源：`https://code.claude.com/docs/en/permissions`。

22. **Claude Code 的技能是 `SKILL.md`，遵循 Agent Skills 开放标准；技能正文按需加载。**
    来源：`https://code.claude.com/docs/en/skills`。
    规范约束：`name` 1–64、只能小写字母/数字/连字符；`description` 1–1024；`metadata` 是字符串键值表。来源：`https://agentskills.io/specification`。

23. **Codex `.rules` 用 Starlark `prefix_rule`，带 `match`/`not_match` 内联正反例，加载时校验；多条命中取最严（forbidden > prompt > allow）；`codex execpolicy check` 可测试。**
    来源：`https://learn.chatgpt.com/docs/agent-configuration/rules`。

24. **Codex 技能也是 `SKILL.md`，必须有 `name`、`description`，从 `.agents/skills` 等位置加载，按 name+description 渐进披露。**
    来源：`https://developers.openai.com/codex/build-skills`。

25. **OpenAI Agents SDK guardrails 是输入/输出/工具层的 tripwire，但 hosted 工具和内置执行工具不走 guardrail；它适合“发现问题就停”，不是权限系统。**
    来源：`https://openai.github.io/openai-agents-python/guardrails/`。

---

# 二、方案本身

## 1. 三层规则，不要把所有东西都塞进“主人规则”

我把盘点里的 54 条分成三层，只有中间一层是 Andy 可编辑的“硬偏好”：

| 层 | 内容 | 存放 | 执行 | 可编辑 |
|---|---|---|---|---|
| **系统不变量** | 审批、遮罩、沙箱边界、文件保护、拒绝绕过、敏感记忆丢弃 | 代码 + 规则登记（只读） | 程序 | 否；只能改代码/ADR |
| **主人硬偏好** | 重要发件人、公开机构域名、金钱词、静默时段、退避、记忆写入门槛、提醒换算、动作权限 | 数据库规则实例 | 程序 | 是；生成新 revision |
| **主人软偏好** | 语气、回答长短、格式、“先读全文再判断”、对外发布注意事项 | 文本 | 模型参考 | 是；明确标“软” |

这样做的理由：如果把“禁止读取 `.git`/`.env`”“敏感记忆要审批”也做成 Andy 可在 UI 里编辑的数据，用户主权会直接压过“边界与可逆性”优先级，违反愿景的冲突序。**系统不变量可以登记、可以导出、可以审计，但不能被一条聊天规则覆盖。**

## 2. 规则存在哪里

新增迁移 **0086**，只建表，不改已有数据；一次性把现有硬编码规则播种进去。建议的表：

### `owner_rules`：每条规则的当前指针

```
owner_id, agent_id, rule_id, type, status(active|disabled|retired),
current_revision, created_at, updated_at
PRIMARY KEY(owner_id, agent_id, rule_id)
```

`rule_id` 用统一契约，例如 `mail.important-sender`、`proactive.quiet-hours`。所有产生和使用它的地方必须用同一个正则，例如 `^[a-z][a-z0-9_.-]{0,63}$`，见后面的 I-73 核对。

### `owner_rule_revisions`：只追加的版本历史

```
owner_id, agent_id, rule_id, revision,
type, type_version, effect, params_ref, display_json,
examples_match_json, examples_not_match_json,
source_kind(conversation|owner_setting|built_in|adr|incident|legacy_unknown),
source_ref, source_quote_ref, actor,
stated_at, recorded_at, confirmed_at,
supersedes_revision,
PRIMARY KEY(owner_id, agent_id, rule_id, revision)
```

- 参数和出处引文存加密 payload；`display_json` 只放能安全展示给模型/导出的短文本。
- 旧 revision 永不修改；改规则 = 插新行 + 移动 `owner_rules.current_revision`。
- `type_version` 记录执行器语义版本；代码改变执行语义时必须升版本并重跑全部示例。

### `owner_rulebook_generations`：运行固定的快照

```
owner_id, agent_id, generation(sha256), sequence,
rules_json, rule_count, created_at
```

`rules_json` 是按 `rule_id` 排序、键排序的规范 JSON，只包含 active 规则及其 revision。每次运行开始时编译一次；同一运行内不换。它解决三件事：

- 运行中 Andy 改了规则，不会一半按旧、一半按新；
- 任意一次决策可以回答“当时用的是哪一版规则手册”；
- 渲染和导出都从同一份快照来，不依赖数据库返回顺序。

### `owner_rule_evaluations`：每次决策的规则执行记录

```
id, owner_id, agent_id, generation,
decision_point, subject_ref, facts_ref,
hits_json, outcome, occurred_at,
decision_id (nullable, references decision_ledger)
```

`hits_json` 只记命中的 `rule_id@revision` 和效果；没命中的规则可以由 `generation` 里的快照推导出来。这样既能回答“为什么发生”，也能回答“为什么没发生”，又不会为每封邮件 × 每条规则写一行。

### `owner_rule_proposals`：一句话变成规则前的确认卡

```
id, owner_id, agent_id, source_thread_id, source_message_id, source_quote_ref,
type, params_ref, examples, proposed_at, status(pending|confirmed|rejected|expired),
decided_at, resulting_rule_id, resulting_revision
```

拒绝的提案也保留，这就是“一次性的拒绝不变成长期规则”的证据。

### 设置怎么办

`proactive_settings` 的静默时段、重要发件人、退避阈值不再作为独立真相。迁移时把它们播种成 `owner_rule_revisions`，然后把 `proactive_settings` 降级成只读视图或直接删除（只有一个用户，不必为旧数据兼容花心思）。以后设置页改这些值，走同一个“写新 revision”的服务。这样 F.4 的“没有版本号和历史”、F.5 的“词表写死”一起解决。

## 3. 规则类型怎么划分

规则类型 = **一个固定决策点 + 一套受限参数 + 一组固定效果 + 一个纯函数执行器**。不要做通用 DSL，不要把任意代码/正则塞进数据。

第一批建议 8 个类型：

| 类型 | 决策点 | 参数 | 效果 |
|---|---|---|---|
| `mail.triage` | 每封邮件 | 发件人/域名、主题+摘要词、分类、是否自己发的 | `raise_to_check`、`raise_to_know`、`suppress` |
| `mail.push` | 每条提醒 | 优先级、截止窗口、是否命中地板、渠道 | `push`、`page_only`、`silent` |
| `proactive.window` | 每次主动检查 | 星期、起止时间、时区 | `defer` |
| `proactive.rate` | 每次推送 | 同类阈值、忽略次数、间隔、每日费用 | `suppress`、`pause`、`cap` |
| `memory.write` | 每条记忆候选 | 分类、置信度、是否待确认 | `keep`、`tentative`、`ask`、`drop` |
| `reminder.time` | 每个提醒 | 提前分钟、只有日期的时刻、最远年限、每年顺延 | `schedule`、`reject` |
| `action.authorize` | 每个受治理动作 | capability、operation、资源前缀、接收人、分类、副作用、费用 | `deny`、`ask`、`allow` |
| `text.preference` | 渲染/回答 | 文本、作用域 | `instruct`（永远只算软） |

拆分原则：**“读不读/拦不拦/存不存”这类能由程序决定的部分放进硬类型；“判断得对不对/语气好不好”这类只能靠模型的部分标软。** 例如 H-15“退款邮件先读完整线程”可以拆成硬规则“命中退款词就读相关线程”和软规则“读完怎么判断”。

规则类型注册表在代码里，至少声明：

```
type, typeVersion, decisionPoint, enforcement(hard|soft),
parameterSchema, validate(params), evaluate(input, params),
renderModelLine(rule), renderSkill(rule), exampleSchema
```

启动时如果 active 规则引用了不存在的类型或版本，服务必须拒绝启动，**不能静默跳过**。这是“hard 不能变成事实上的 soft”的第一道保证。

## 4. 在哪些环节拦截

### 宿主决策点是主战场

| 环节 | 现在的位置 | 改成 |
|---|---|---|
| Gmail 地板/静默/推送 | `proactive-rules.ts`、`proactive-mail-check-service.ts` | 调 `RuleEngine.evaluate("mail.triage")`、`"mail.push"`、`"proactive.window"`、`"proactive.rate"` |
| 记忆写入 | `automatic-memory-service.ts` | 调 `"memory.write"`；敏感/受限/低把握不再写死 |
| 提醒换算 | `production-memory-capture.ts` | 调 `"reminder.time"` |
| 动作授权 | `ActionPolicyService.evaluate` | 从规则快照生成 `PermissionPolicy`；效果增加 `ASK`；顺序改为系统 DENY > 主人 DENY > ASK > ALLOW |
| 对外发送/发布/购买 | 现有 `ActionPolicyService` + 能力清单 | 用 `action.authorize` 的 `recipients`/`disclosure` 参数；这是第二批扩展 |
| 聊天回答风格 | 无 | 只能标软；不要假装硬 |

### Pi 钩子怎么用

- **`tool_call`：只做“最后一道 DENY 闸门”**。运行开始时把当前快照里所有 `action.authorize` 的 DENY 规则编译成内存中的只读匹配器；`tool_call` 里命中就 `{ block: true, reason: "规则 rule_id@rev 不允许：…" }`。不在这里做 ASK，不做批准，不做模型调用，不读数据库，避免慢操作和扩展异常误伤。ASＫ仍走宿主 `ActionPolicyService` 的挂起/批准流程。
- **`tool_result`：只观测和补说明**。把命中的规则编号写进 `details`，方便模型和审计看到；不在这里做权限决定。
- **`before_agent_start`：不用于规则**。它改系统提示，会破坏冻结与缓存；只保留现有的“返回冻结系统提示”用途（`pi-runtime-adapter.ts:1453-1459`）。
- **`context` / `context_with_system`：不用于规则**。它们直接改请求字节；规则手册只通过最后一条用户消息的上下文块进入。
- **`before_provider_request`：只做观测**。不做规则执行，不做字节改写。
- **`input`：不用于规则捕获**。捕获属于宿主应用层，所有接入面（网页、API、定时）都要走同一条路径，不能只依赖 Pi CLI 的输入钩子。
- **`turn_end` / `agent_before_settle`：不用于硬规则**。它们只能在回答结束后追加消息或再请求一次，不能撤销已经发生的副作用；最多用于软提醒“回答前再核对”，并明确标软。

### Pi 管不到的环节

Gmail、记忆、提醒、主动检查、动作授权都在宿主服务里，本来就不经过 Pi。**这反而是好事**：把硬规则放在宿主，Pi 只是模型运行时，换 Pi 版本或换模型都不会改变规则语义。

## 5. 怎样保证必定执行、并有测试

### 5.1 运行开始编译快照

每次运行/每次主动检查开始时：

1. 读 active 规则及当前 revision；
2. 按类型校验参数；
3. 跑每条规则携带的 `match` / `not_match` 示例；
4. 检测冲突（同一作用域相反效果）；
5. 计算 `generation = sha256(canonical JSON)`；
6. 写入/复用 `owner_rulebook_generations`；
7. 运行内所有决策都用这份快照。

任何一步失败：**hard 规则不能降级成 soft**。策略是：
- 不可逆/对外动作：拒绝执行；
- 只读/可逆动作：可以用上一次已验证快照继续，但记一条高优先级告警；
- 启动时失败：服务不启动，先修规则。

### 5.2 每条规则实例自带正反例

这是我认为最关键的设计，借鉴 Codex `match`/`not_match`，但用在所有规则类型上：

- 每条 revision 存 `examples_match` 和 `examples_not_match`，是规则类型定义的合成输入。
- 保存规则时立刻跑执行器：正例必须命中，反例必须不命中；否则拒绝保存。
- `npm run check:rulebook` 每次 CI 重跑所有 active 规则的所有示例。
- 执行器代码改了但示例失败，CI 直接红。

这样，“每条偏好都要有回归测试”不需要为每条偏好手写一个测试文件；**每条数据行自带两个可执行断言**，同时类型本身仍有人写的单元/集成测试。这正好符合 ADR 0163 的“测试覆盖类型，偏好是数据”。

### 5.3 自动检查与反向用例

新增两道阻断检查，挂进 `npm run check`：

1. **`check:rulebook`**
   - 每个 active hard 规则类型都有执行器、参数 schema、示例 schema、至少一个正向和反向示例；
   - 所有 active 规则的示例通过；
   - 编译快照两次、打乱数据库返回顺序，`generation` 和渲染字节相同；
   - 系统规则不可被主人规则覆盖；
   - soft 规则不得出现在“硬规则”渲染/导出段；
   - 删除执行器或把类型改名，检查必须失败（反向）。

2. **`check:rule-ref-contract`**（吸取 I-73）
   - 从规则注册表生成所有 `rule_id`，逐个喂给：
     - 共享 `rule-id` 校验；
     - SQLite `owner_rules` / `owner_rule_revisions` / `owner_rule_evaluations` 的 CHECK；
     - `decision_ledger.inputs.ruleIds` 的 `idList`（1–256）；
     - 网关合约 `boundedString(256)`（`packages/gateway-contracts/src/contracts-v2.ts:1028,1104`）；
     - 导出 SKILL.md 的 `metadata` 值（必须是字符串）；
     - 决策抽屉读取端。
   - 两个契约包对 `rule_id` 的规则必须一致；生成端必须只产生所有消费端都接受的 id。
   - 去掉任何一个消费端校验，这个检查失败。

3. **扩展 `check:prompt-prefix`**
   - 规则手册块只出现在最后一条用户消息；
   - 规则变化时，前面的系统提示、历史逐字节不变，只有最后一条消息变；
   - 反向：把规则手册塞进系统提示，检查失败；
   - 反向：把规则手册放在 `runtime-environment` 之后，破坏其遮盖隔离，检查失败。

4. **端到端**
   - `test/integration/production-http-composition-process.test.ts` 用真实服务、真实 SQLite、真实 HTTPS 模型桩抓原始请求体；
   - Gmail 用 `test/integration/proactive-mail-check.test.ts` 的真实流程；
   - 记忆用 `test/integration/automatic-memory-golden.test.ts`；
   - 决策链用 `test/integration/decision-chain.test.ts`；
   - 新增 `test/integration/owner-rules.test.ts` 覆盖“改规则→新 revision→旧决策仍指向旧 revision→新决策用新 revision”。

5. **导出**
   - `skills-ref validate`（Agent Skills 官方参考库）通过；
   - SKILL.md 的 `name`/`description`/`metadata` 符合规范；
   - 同一数据库导出两次字节相同，不含导出时间；
   - 在 Claude Code 和 Codex 本地实际加载，跑 Jarvis #1/#6 的验收场景。

## 6. 主人的一句话怎样变成硬规则

流程如下，尽量只点一次：

1. **入口**：Andy 在任意接入面发消息。宿主在消息落库后触发规则候选提取，不从外部内容（邮件、网页、工具结果）提取，避免注入。
2. **预筛**：先用便宜的确定性规则判断“像不像在立规矩”（`以后`、`每次`、`一直`、`不要`、`一律`、`always`、`never`），或 Andy 明确用 `/rule`。不是每条消息都调模型，控制成本。
3. **提取**：固定的规则类型目录 + 参数 schema + 当前规则快照作固定前缀，Andy 原话放最后，交给模型输出**类型化候选**。候选必须包含：
   - 类型、参数；
   - `match` / `not_match` 正反例；
   - 原话引用。
4. **确定性校验**（不靠模型）：
   - 原话引用必须是 Andy 这条消息的连续子串，否则拒绝；
   - 参数通过类型 schema；
   - 正反例通过执行器；
   - 不允许候选创建 `system.*` 规则；
   - 不允许把密码、验证码、银行卡号写进 `display_json`。
5. **确认卡**：显示“将变成哪条硬规则、作用范围、正反例、会改变最近 N 次判断中的几次、旧值是什么（改规则时）”。确认后才写 revision。
6. **确认方式**：
   - 推断出来的规则：必须点确认卡（ADR 0163）；
   - Andy 自己明确写“以后……一律……”的，可以把这句话本身当作确认，直接生成 revision 并把卡片作为回执；这是我把“一句话”和“确认”合并的办法，需要 Andy 拍板。
7. **一次性拒绝**：识别为“仅这一次”的，只写 `owner_rule_proposals` 或一次性例外，不写长期 revision。
8. **改主意**：新 revision，`supersedes_revision` 指向旧版；旧值、旧出处、旧确认时间全部保留。
9. **回放**：确认卡可以附带“用最近 30 天已记录的事实回放这条规则”，让 Andy 在确认前看到误伤/漏报，而不是确认后再发现。这个不是执行，只是用快照做 dry-run。

## 7. 出处和历史怎么留

- 每条 revision 必填：
  - `source_kind`：`conversation` / `owner_setting` / `built_in` / `adr` / `incident` / `legacy_unknown`；
  - `source_ref`：对话 id + 消息 id，或 ADR/事故编号；
  - `source_quote_ref`：加密的原话引用；
  - `actor`：`owner` / `migration` / `system`；
  - `stated_at`、`recorded_at`、`confirmed_at`。
- 盘点里 19 条查不到出处的，写 `legacy_unknown`，UI 显示“无出处”，不伪造。等 Andy 想起来再补一条 revision 的出处，不修改旧 revision。
- 任意一次提醒/沉默/动作，通过 `owner_rule_evaluations.generation` + `hits_json` + `decision_ledger` 能回到：
  - 当时命中了哪条 `rule_id@revision`；
  - 那条 revision 的原话、立规时间、确认人；
  - 当时整本规则手册的快照。
- 记忆里不再存规则正文。`rule` 类记忆要么迁移成规则 revision，要么只保留一个指向 `rule_id` 的指针；这样不会出现“规则在记忆里一份、在程序里一份”的双源。

## 8. 模型怎样知道有这些规则

模型必须知道，但**不能靠系统提示每轮变**。做法：

1. 在上下文资料里新增一个 `rulebook` 块，放在 `runtime-environment` **之前**，原因：
   - `runtime-environment` 现在靠“最后一块 + 固定结尾句”隔离验证码遮盖（`packages/runtime-pi/src/runtime-environment-block.ts:114-133`，`docs/adr/0164...:66`）；规则手册放它后面会破坏这个隔离。
   - 规则手册不是运行环境说明，不应借用它的“最近一份一直有效”语义。
2. 块内容分两段：
   - **硬规则**：只写 `rule_id@revision` + 一句话效果 + “由程序执行，你不需要检查，也不能绕过；触犯时工具会被拒绝并返回规则编号”。例如“`mail.important-sender@3`：来自 smbc.co.jp 的邮件至少标成‘请看原信’”。
   - **软规则**：原文照写，明确标题“以下只是偏好，不是必定执行”。
3. 发送时机：
   - 第一轮发；
   - 规则快照 `generation` 变了才发；
   - 内容没变不重发，和运行环境说明一样。
   这样每轮会变的值只在最后一条消息，且旧块留在历史里不会改字节。固定提示词里加一句“规则手册以最近一次附上的为准”，这是一次性系统提示改动，只对新对话生效。
4. **不要新增 `rule_query` 工具**。新增工具会改变工具定义，触发缓存换新；规则手册块已经够用。规则很多时再另出方案。
5. 当硬规则拦下动作时，工具结果必须带 `rule_id@revision` 和一句人话，模型才能向 Andy 解释，也才能把“为什么没做”写进回答。

## 9. 导出 SKILL.md

导出目录：

```
himawari-rulebook/
  SKILL.md
  references/rules.json      # 完整规则、revision、出处（可选是否含引文）
  references/history.md      # 修改历史
```

`SKILL.md`：

```
---
name: himawari-rulebook
description: Andy 的长期规则与偏好。涉及邮件重要性、提醒、记忆写入、对外动作时使用。
metadata:
  himawari_generation: "<sha256>"
  himawari_hard_count: "16"
  himawari_soft_count: "25"
---

# Andy 的规则手册
## 硬规则（只在 Himawari 内由程序执行；在其他 Agent 中只是文字）
...
## 软偏好（只是参考）
...
```

关键诚实点：**导出到 Claude Code/Codex 后，Himawari 的硬规则不再由 Himawari 程序执行。** SKILL.md 能携带的是“规则内容和偏好”，不是 Himawari 的执行器。要让它在那两个宿主里也尽量硬，可以额外生成：

- Claude Code：`settings.json` 的 `permissions.deny` / `ask` 规则，或 `PreToolUse` hook；
- Codex：`.rules` 的 `prefix_rule(pattern, decision)`。

但这些只能覆盖“命令/工具”类规则，覆盖不了 Gmail、记忆写入门槛。所以导出物必须带 `enforcement_scope: himawari | portable_instruction | portable_policy`，不得在文档里把 `portable_instruction` 说成“必定执行”。Jarvis #12 只要求 #1/#6 通过，SKILL.md 的文字版足够；但产品的宣传口径要守住第 6 条目标。

## 10. 分步落地

**第 0 步：ADR 0201 + 规格**
- 写清规则类型、数据模型、优先级、fail-closed 策略、导出边界。
- 定义 `rule-id` 共享契约和 `check:rule-ref-contract`。

**第 1 步：迁移 0086 + 注册表 + 引擎 + 快照**
- 建表，播种现有 3 条地板规则、静默时段、重要发件人、公共机构后缀、金钱词、退避、记忆门槛、提醒换算、动作权限。
- 行为保持不变：旧代码改成读快照，金测试逐字不变。
- 加每条规则的正反例、`check:rulebook`。
- 这一步不碰系统提示、不碰 Pi。

**第 2 步：Gmail 硬规则数据化**
- `proactive-rules.ts` 的常量和 `DECISION_RULE_CATALOG` 改为注册表读取。
- `proactive_settings` 改为规则视图/迁移。
- 账本写 `ruleIds` + `ruleVersions`；更新 `insertLedgerRow`、`entryFromRow`、写入约定、`decision-chain.test.ts`。
- 删除 `mail.judgment` 里与地板重复的 S-8/S-9 文字，改由规则手册块提供当前值。这是一次性提示词改动，只影响新对话。

**第 3 步：记忆、提醒、动作授权**
- `memory.write`、`reminder.time` 接规则引擎。
- `ActionPolicyService` 从规则快照构建策略，支持 `ASK` 和系统规则优先。
- 加 `tool_call` 的 DENY 早期闸门。
- 迁移 `rule` 类记忆：正文转规则 revision，记忆只留指针。

**第 4 步：一句话→规则 + 确认卡 + 规则页**
- 候选提取、原话子串校验、正反例校验、确认卡、回放。
- 规则页显示硬/软、出处、历史、下次生效、冲突。
- 软规则进入 `owner-rules` 文本块；硬规则进入 `rulebook` 块。

**第 5 步：导出与跨宿主验收**
- 生成 SKILL.md + references + 可选 Claude Code/Codex 适配物。
- `skills-ref validate`，在 Claude Code/Codex 真加载，跑 Jarvis #1/#6。
- 更新盘点文档：每条从“暂称类型”变成“rule_id + type + enforcement + test + source”。
- 删除不再使用的 `rule` 记忆类别或把它降级为候选来源。

---

# 三、考虑过但不选的做法

| 做法 | 为什么不选 |
|---|---|
| 把规则写进系统提示/CLAUDE.md | 每轮变会破坏缓存；模型可以不听；违反只追加/冻结。 |
| 把规则继续存成 `rule` 类记忆 | 正是现状的病根：模型分类、2000 字预算、可能被挤掉。 |
| 每条规定写一段代码 | 违反 ADR 0163；Andy 改主意就要改代码发版。 |
| 做一个通用 Starlark/DSL 让 Andy 写规则 | 灵活但难测试、难做类型校验、容易变成代码注入；Codex 的 Starlark 只适合命令前缀这一窄域。我们只借它的 `match`/`not_match` 思想。 |
| 全部用 Pi 钩子执行 | Pi 管不到 Gmail、记忆、提醒、授权；扩展与 Pi 同权限，错误还会拦工具；不能把安全边界建在模型运行时扩展里。 |
| 用一个小模型当“规则法官” | 不确定、要花钱、可能被提示注入；只能用于软规则或审计，不能叫硬。 |
| 一条 `rule` 大表 + JSON，不分类 | 没有类型校验、没有执行器、没有测试，最后还是一堆不可验证的数据。 |
| 自动把推断出的规则直接生效 | 违反 ADR 0163；误判会立刻变成硬约束。必须有确认卡和正反例。 |
| 只导出 SKILL.md，声称在其他宿主也“必定执行” | 不诚实。其他宿主没有 Himawari 的执行器，只能算文字；必须标 `enforcement_scope`。 |
| 只改 `decision_ledger`，不建规则执行表 | `decision_ledger` 的 kind 固定、非 proactive 只落四个键；硬塞会丢字段。需要独立的规则 revision/evaluation/generation。 |
| 规则参数直接存明文、直接进提示词 | 发件人、金额、原话可能敏感，会被遮罩成不同字节，也会泄露到导出；参数用加密 payload，展示用安全摘要。 |

---

# 四、风险与反例

1. **“有数据、没执行器” → 静默变软。** 反例：某次部署删了 `mail.triage` 执行器，active 规则还在，邮件检查照跑但不执行地板。缓解：启动编译失败即拒绝启动；`check:rulebook` 反向用例。
2. **规则数据变成编程语言。** 反例：为了覆盖长尾，允许 Andy 在参数里写任意 JS/正则。缓解：只允许类型定义的受限参数；正则只允许受限字符集和长度，或用字面词表；不允许 `system.*`。
3. **同一段文字不同字节。** 反例：渲染时遍历 `Object.keys(params)` 或数据库返回顺序；规则手册里带“最近更新于”。缓解：规范 JSON、显式排序、无时间字段、两次渲染字节比较。
4. **遮盖让规则手册字节漂移。** 反例：规则参数里有银行卡号或验证码，出口遮罩在不同上下文遮成不同结果。缓解：规则手册不展示敏感参数；参数和引文加密存放；加反向测试。
5. **历史里的旧规则手册误导模型。** 反例：Andy 改了重要发件人，旧块还在历史里。缓解：固定提示词写“以最近一次规则手册为准”；新块只追加；硬规则反正由程序执行。
6. **规则手册每轮增加 token。** 反例：50 条规则每轮都发，成本上升。缓解：只在 `generation` 变化时发；硬规则只写一行；软规则设预算，超预算明确告诉模型“有未附上的软规则”，不假装都在。
7. **确认卡变成新的负担。** 反例：Andy 每说一句都要点。缓解：只有“像立规矩”的消息才触发；明确句式把原话当确认；一次一张卡；批量合并；推断规则才必须点。
8. **模型提取出 Andy 没说过的话。** 反例：模型把“今天不想看邮件”提取成长期规则。缓解：原话必须是消息连续子串；要求类型化参数；确认卡显示原文；一次性拒绝不落长期规则。
9. **规则冲突没有裁决。** 反例：一条“重要发件人一定提醒”和一条“这个发件人永不提醒”。缓解：系统规则优先；主人规则同作用域取最新；否则 deny/suppress > ask/floor > allow，并在 UI 显示冲突，要求 Andy 拍板。
10. **审计写失败但动作已经发生。** 反例：规则命中了，`owner_rule_evaluations` 插入失败，动作照样执行，事后无法追溯。缓解：对不可逆动作，先写 evaluation intent 再执行；写失败就拒绝。对只读动作可放行但告警。这一点需要 Andy 拍板。
11. **规则类型语义改了但 typeVersion 没升。** 反例：改了执行器，旧 revision 的行为悄悄变了。缓解：类型版本 + 示例全量重跑 + 变更检查；代码评审要求升版本。
12. **导出在 Claude Code/Codex 过不了。** 未核实：SKILL.md 的 `metadata` 值必须是字符串，`name` 必须匹配目录名；Claude Code 云端线程不加载仓库技能（`docs/adr/0132...:42`），所以验收要在本地会话做。必须真加载跑 #1/#6，不能只看 golden。
13. **规则引用不存在的 capability/operation。** 反例：`action.authorize` 规则写了一个已删除的工具，规则永远不命中。缓解：写规则时校验 capability 清单；启动时对 active 规则做可达性检查；运行时再次校验 manifest。
14. **Pi `tool_call` 扩展异常。** Pi 的错误语义是“tool_call 出错就拦下工具”，可能造成过度拦截。缓解：`tool_call` 里只查内存快照、不读数据库、不调模型、不抛异常；异常时记录并让宿主授权层继续判断，而不是把整个工具永久拦死。这里需要小心：Pi 文档说 `tool_call` errors block the tool (fail-safe)，所以扩展代码必须极简。

---

# 五、需要 Andy 拍板的取舍

1. **“一句话”与“确认卡”的关系**：推断出的规则必须点确认；Andy 明确写“以后……一律……”时，是否把这句话本身当作确认，直接生效？我倾向“是”，否则每立一条规则都要再点一次，违背“尽量不增加介入”。
2. **规则手册发送频率**：只在 `generation` 变化时发，还是每轮都发？我倾向只变时发，节省 token；代价是模型可能看到历史里的旧手册，需要靠固定提示词“以最近一次为准”。
3. **审计失败时是否 fail-closed**：不可逆动作写不进规则执行记录时，拒绝执行；只读/可逆动作是否允许带告警放行？我倾向“不可逆拒绝，可逆放行并告警”。
4. **设置是否彻底并入规则**：把 `proactive_settings` 完全迁移成规则 revision，设置页变成规则页的一部分；还是保留设置表、只加 revision？我倾向彻底迁移，符合“只有一个用户，做彻底”。
5. **导出是否同时生成宿主适配物**：只出 SKILL.md，还是同时生成 Claude Code `permissions`/hooks 和 Codex `.rules`？我倾向先生成 SKILL.md + `rules.json`，第二期再加适配物，避免把“可携带”误做成“可硬执行”。
6. **哪些规则允许 Andy 编辑**：系统不变量（审批、遮罩、沙箱、敏感记忆丢弃）是否在 UI 里只读展示？我倾向只读，且系统规则优先级最高。
7. **无出处的 19 条怎么办**：标 `legacy_unknown` 继续执行，还是要求 Andy 补出处后才算硬？我倾向标“无出处”继续执行，不因为出处缺失让已有保护失效。

---

# 六、哪些是读代码/来源证实的，哪些是推测

## 已证实

- 现状 54 条分散、Gmail 外几乎全软、同类规则重复且不一致：`docs/agent-rulebook-inventory.md:52-57,199-206`。
- 现有 Gmail 地板规则只有 3 条硬编码目录：`proactive-rules.ts:29-58`。
- 动作授权已有 DENY/ASK/ALLOW 和资源前缀：`action-policy-service.ts:316-417`。
- `decision_ledger` 非 proactive 写入只落四个键：`sqlite-decision-ledger-operations.ts:117-122`。
- 记忆规则共用 2000 字预算、靠模型分类：`owner-profile-service.ts:14,203-206`。
- Pi 没有内置权限系统、`tool_call` 可 block、扩展同权限：Pi `security.md` / `extensions.md`。
- Claude Code 权限按 deny→ask→allow、由程序执行：`https://code.claude.com/docs/en/permissions`。
- Codex 规则有 `match`/`not_match` 内联测试、取最严：`https://learn.chatgpt.com/docs/agent-configuration/rules`。
- Claude Code/Codex 技能都是 SKILL.md，Agent Skills 有 name/description/metadata 约束：`https://code.claude.com/docs/en/skills`、`https://developers.openai.com/codex/build-skills`、`https://agentskills.io/specification`。

## 推测/未核实

- 规则手册块的实际 token 成本和对模型行为的影响，需要小范围生产测量；未测量。
- 54 条能否全部干净映射到 8 个类型；我预计有 10–15 条只能标软或拆成“硬读 + 软判”，需要逐条过一遍。
- Claude Code/Codex 实际加载导出 SKILL.md 后 Jarvis #1/#6 是否稳定通过；需要真机验收，未做。
- `skills-ref` 对 `metadata` 的具体校验强度、Codex 对 `agents/openai.yaml` 的依赖，未逐项实测。
- 现有生产 `proactive_settings` 迁移到规则表后，所有读取路径是否都已覆盖；需要按代码逐处核对，本文只列了主要入口。
- 规则提取模型在真实 Andy 语句上的准确率、误报率、确认卡负担；未测量。

---

# 七、逐条回答必答问题

## 问题 1：这个改动会不会改变模型已经见过的请求开头？

**按方案本身：不会。**

- 系统提示、工具定义、历史消息都不改。
- 规则手册作为新的上下文块，只出现在**最后一条用户消息**里，和现有的 `owner-rules`、`runtime-environment` 同级；旧消息不重写。
- 每轮会变的值（规则快照 `generation`、规则内容）只放在最后一条消息；规则不变时连这个块都不重发。
- 硬规则执行在宿主程序和 `tool_call` 闸门里，不进入模型请求。
- 不新增工具；如果以后要加规则查询工具，必须按工具集合变化处理，不能中途加。

**但上线本身有一次性的开头变化：**

- 如果按第 2 步删除 `mail.judgment` 里重复的地板规则文字、并在 `chat.identity` 里加一句“规则手册以最近一次为准”，这会改变系统提示/固定提示词的字节。按 `prompt-prefix` 第 4、6 条，这属于需要先出方案、Andy 同意的一次性改动；老对话因冻结继续用旧字节，新对话才用新文字。
- 也可以完全不动固定提示词，第一版只加 `rulebook` 块；这样请求开头零变化，但模型对“规则手册是权威”的理解会弱一些。我建议先不动固定提示词，等规则手册块稳定后再单独改。

**结论：** 发给模型的内容仍然只在末尾追加；每轮会变的值都在最后一条消息；已发历史不改。唯一例外是上线时对固定提示词的一次性改动，按 ADR 单独批准、只影响新对话。

## 问题 2：会不会让同一段文字在不同请求里变成不同的字节？

**设计上不会，但有三个必须守住的点：**

1. **渲染必须规范。** 规则按 `rule_id` 排序，参数 JSON 键排序，数组显式排序；不得依赖 SQLite 返回顺序、`Object.keys` 遍历顺序、`Set`/`Map` 迭代顺序；不得在规则文本里放时间、日期、相对时间、“最近更新”、随机 id。`generation` 是内容哈希，同样输入同样输出。
2. **历史存实际发出去的那条。** 规则手册块一旦发出，就按实际字节存进历史；下一轮直接用存下的消息，不重新渲染。所以以后改渲染器，旧历史字节也不会变。
3. **遮盖必须确定。** 规则手册不展示密码、验证码、银行卡号等敏感参数；参数和原话引用加密存放，展示用安全摘要。这样不会因为出口遮罩的上下文判断让同一段规则文本遮成不同结果。规则手册放在 `runtime-environment` 之前，保留后者“最后一块 + 固定结尾句”的遮盖隔离。

**结论：** 只要遵守规范渲染、无时间字段、固定排序、敏感值不进规则手册，同一段文字每次都是同样字节。反过来，如果为了省事直接 `JSON.stringify` 一个数据库对象，或把“上次修改时间”写进去，就会违反第 2 条，必须靠测试拦住。

## 问题 3：改动有没有对应的自动检查，反向用例是否真的会失败？

有，分五层：

| 检查 | 正向 | 反向（去掉修复后必须失败） |
|---|---|---|
| `check:rulebook` | 所有 active 规则示例通过；快照/渲染两次字节相同 | 删除执行器、类型改名、把 soft 标成 hard、打乱渲染顺序、示例失败，检查红 |
| `check:rule-ref-contract` | 注册表生成的每个 `rule_id` 过所有消费端 | 放宽或删除任一消费端校验，检查红；生成一个含非法字符/超长的 id，检查红 |
| `check:prompt-prefix` | 规则手册只在最后一条消息；规则变化只改最后一条 | 把规则手册放进系统提示、放在 `runtime-environment` 之后、改写历史，检查红 |
| 规则类型测试 | 每个类型有真实执行器的正/反用例 | 去掉某个效果分支，对应用例红 |
| 端到端 | 真实服务 + 真实 SQLite + 真实 Pi/回环模型桩 | 关掉规则执行、停用某条规则，对应的 PG/OM/记忆用例必须红 |

关键点：

- **不用假替身。** 规则引擎的纯函数单元测试用真实函数；Gmail/记忆/动作/链路的验收用真实 SQLite 和真实服务组合；Pi 用真实适配器和本机回环服务（现有 `prompt-prefix.compat.test.ts` 的做法）。
- **每条规则实例自带正反例**，CI 全量重跑；这比“为每条偏好写一个测试文件”轻，但反向用例是真实执行的。
- **I-73 的门槛**：`check:rule-ref-contract` 从产生端生成 id，逐个喂给消费端；不是只检查 diff。这样不会再出现“清单里的 id 过不了后端校验”。

## 问题 4：每个产生/修改的值，每个使用它的地方都能接受吗？

下面逐个核对。这里的“两端”指产生它的地方和每一个消费/校验它的地方。

| 值 | 产生处 | 使用/校验处 | 结论 |
|---|---|---|---|
| `rule_id` | 规则注册表/新建规则服务 | `owner_rules`、`owner_rule_revisions`、`owner_rule_evaluations`；`decision_ledger.inputs.ruleIds`（`sqlite-decision-ledger-operations.ts:40-47`，1–256）；`floorHits`（`sqlite-proactive-operations.ts:587-613`，每条邮件最多 16 个）；网关 `ruleId`/`ruleIds`（`contracts-v2.ts:1028,1104`，`boundedString(256)`）；UI；SKILL.md metadata（必须是字符串）；日志 | 需要统一 `rule-id` 正则（如 1–64、小写字母数字 `_.-`），并在所有消费端复用同一模块。当前网关允许 256、SQLite 允许 1–256、`DECISION_RULE_CATALOG` 只认 3 个固定 id（`proactive-rules.ts:44-58`、`packages/application/test/decision-rule-catalog.unit.test.ts:10`），三者不一致；不改就会重演 I-73。 |
| `type` / `type_version` | 代码注册表 | 执行器查找、参数校验、导出、UI | 写规则时和启动时都必须校验；未知类型/版本不得静默跳过。当前没有这个值，属于新增。 |
| `revision` | `owner_rules.current_revision`，事务内分配 | `owner_rule_revisions`、evaluation、`decision_ledger.inputs.ruleVersions`、API、导出 | 必须是正整数；旧 revision 不可改；并发写入用 `BEGIN IMMEDIATE` + 唯一键。当前 `decision_ledger` 没有版本字段，必须在 `DecisionInputs` 增加并让 `insertLedgerRow`/`entryFromRow` 真正落盘（`sqlite-decision-ledger-operations.ts:117-122` 现在只落四个键，新增字段会被丢弃）。 |
| `params_json` | 候选服务/设置页 | 执行器、导出、规则页 | 必须按类型的 schema 校验，拒绝未知字段；规范 JSON；写时和读时都校验；敏感值加密。当前没有这类数据。 |
| `effect` / `enforcement` | 类型定义 + 实例 | 引擎、UI、导出、文档 | `hard` 必须有执行器、示例、evaluation；`soft` 不得出现在硬规则段。当前 `hard/soft` 只是盘点表里的文字，没有程序约束。 |
| `source_kind` / `source_ref` / `source_quote` | 捕获/迁移 | 规则页、审计、导出 | `conversation` 的 ref 必须是消息 id；quote 必须是原话连续子串；`legacy_unknown` 允许为空。当前没有这些字段。 |
| `generation` | 快照编译 | evaluation、ledger、导出、日志 | sha256 十六进制 64 字符；内容相同必须同值；必须可从不可变 revision 重建。当前没有。 |
| `evaluation_id` | 规则执行 | `decision_ledger` 关联、抽屉 | `decision_ledger.id` 是 1–128（迁移 0069），所以 evaluation id 也要 ≤128；不要用超长拼接。 |
| `decision_id` | 账本 | evaluation 外键、抽屉 | 必须存在且同 owner/agent；删除策略要想清楚（`ON DELETE SET NULL` 还是 RESTRICT）。 |
| `ruleVersions` | 规则执行 | `DecisionInputs`、SQLite `inputs` JSON、读取端、写入约定、`decision-chain.test.ts` | **当前一定会丢**：`insertLedgerRow` 只序列化四个键，读取端也只回这四个键。必须同时改写入、读取、约定、测试，否则“追溯到当时版本”只存在于内存。 |
| `rulebook` 块 kind | `context-formation-service` | `ProductContextBlockKind`（`ports/context-projection.ts:57-64`）、`context-formation-service.ts:775-784`、`context-projection-service.ts:767`、runtime 渲染、prompt-prefix 测试 | 当前 union 没有 `rulebook`，只改产生端会在校验处被拒。必须两端同时加，并加 marker。 |
| `owner-rules` / 软规则文本 | 规则服务 | `owner-profile-service.ts`、`runtime-environment-block.ts`、UI | 现有 `owner-rules` 块是记忆规则用的；引入规则手册后要区分“硬规则块”和“软规则块”，不能让软文本混进硬段。 |
| `proactive_settings` 的键 | 设置页/迁移 | `readSettings`、`proactive-mail-check-service`、备份/导出、UI | 如果迁移成规则，所有读取 `important_senders`、`quiet_hours` 的地方都要改成读规则快照；漏一处就会双源。 |
| SKILL.md `name` / `description` / `metadata` | 导出器 | Claude Code、Codex、`skills-ref` | `name` 1–64、小写字母数字连字符、不能首尾/连续连字符；`description` 1–1024；`metadata` 值必须是字符串；目录名与 `name` 一致。导出器必须用官方规范校验，不能只靠 golden。 |
| `effect` 在 `PermissionPolicyRule` | 规则 → 动作策略 | `ActionPolicyService.evaluate`、`action-intent-snapshot`、批准/额度 | 当前 `PermissionPolicyRule.effect` 只有 `ALLOW`/`DENY`（`ports/authorization.ts:77-87`）；要加 `ASK` 就必须同时改策略合并顺序、`safePolicyRead`、grant 覆盖、测试。只加枚举不改判断，会出现“配了 ASK 但不生效”。 |
| capability/operation 引用 | 规则参数 | 能力注册表、`ActionPolicyService.capabilityDenial`、manifest | 写规则时和运行时都要校验；否则规则写了一个不存在的操作，永远不命中，却看起来是硬规则。 |

**结论：** 这个改动会产生/修改很多跨层值，不能只看规则表本身。最危险的是三类：

1. `ruleVersions` 这类新字段被 SQLite 写入端静默丢掉；
2. `rulebook` 块没有同时加到两个 envelope 校验器；
3. 规则 id 在注册表、账本、网关、SKILL.md 之间没有统一契约。

这三类都必须用 `check:rule-ref-contract` 和两端校验测试守住，正是 I-73 的教训。
