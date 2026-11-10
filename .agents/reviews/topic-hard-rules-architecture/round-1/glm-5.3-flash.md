我先读仓库关键文件弄清现状。
我已掌握仓库现状，再核实两条业界一手来源（Claude Code 权限顺序、Codex execpolicy），然后写方案。
# 方案：Himawari 硬规则接入架构（规则手册 = 一张登记册 + 一组类型执行器）

## 一、方案依赖的前提（均读自仓库或一手来源，附原话）

**读代码/文档证实的：**

1. 愿景要求规则“写进程序、必定执行，每条都有回归测试守着”——`docs/product-vision.md:59`：“规则不是记忆，是硬性设定：记忆只保存一条规则的出处和修改历史；规则本身写进程序、必定执行，每条都有回归测试守着。”
2. ADR 0163 已定：测试按**规则类型**写，偏好是数据；硬偏好每次生效要写决策记录；一句话要过确认卡——`docs/adr/0163-...md:39-49`：“测试覆盖的是每种规则类型；我的每条具体偏好只是数据……”“一句话要经过确认卡，Andy 确认后才变成长期规则。”
3. 仓库已有四个现成的程序拦截点，不需要新建并行系统：
   - 动作授权：`packages/application/src/services/action-policy-service.ts:316-325`（`PermissionPolicy.rules` 的 DENY 按 capabilityRef/operation/resourcePrefix 命中即拒，authorization.ts:77-87 定义了规则结构）；
   - Gmail 地板规则：`packages/application/src/services/proactive-rules.ts:29-121`（`FLOOR_RULE_IDS`、`applyFloor`、`isReminderWorthy`），且已有 `DECISION_RULE_CATALOG`（44 行，字段 origin+document）；
   - 记忆门槛：盘点 H-12/H-13（敏感待确认、把握阈值）；
   - Pi `tool_call` 钩子：`packages/runtime-pi/src/pi-runtime-adapter.ts:1425-1428`，`himawari-tool-outcomes` 已在用 `{ block: true, reason }`。
4. 追加约束：`.claude/rules/prompt-prefix.md:27-35`：“固定的在前，会变的在后”“每轮都会变的内容只放在最后一条用户消息里”“已经发给过模型的内容，不得改动、重排或删除”；系统提示和工具按对话冻结（第 6 条）；`npm run check:prompt-prefix` 是阻断检查且带反向用例（第 74 行）。
5. 决策记录约定：`docs/execution/specs/2026-11-09-decision-record-write-convention.md:39,52`：“规则编号必须登记在 `DECISION_RULE_CATALOG`”“新的规则必须先登记……再写进记录；未登记的编号只会显示‘未登记的规则’”。且非 proactive 种类经 `insertLedgerRow` 目前只落 4 个键（第 35 行），扩字段要先改校验。
6. 设置带版本号的先例：ADR 0122（`docs/adr/0122-...md:65`）：“`owner.preferences.set` 必须带 `expectedRevision`……相同才写入并把版本号加一”；而 `proactive_settings` 无版本号、直接覆盖（盘点 C-5、F-4）。
7. 预算挤掉规则的现状：`owner-profile-service.ts:14` `OWNER_PROFILE_CHARACTER_BUDGET = 2000`，规则与档案共用（盘点 M-3）；生产 3 条 `rule` 记忆全部不生效（盘点 C 节）。
8. Pi 本身无权限系统、扩展错误 fail-safe：材料引用 Pi README “Pi does not include a built-in permission system…”；extensions.md “`tool_call` errors block the tool (fail-safe)”。（我未直接打开 Pi 仓库源文件核对，**未核实原文行号**，引材料。）
9. 只许 `packages/runtime-pi` 引 `@earendil-works/pi-*`（AGENTS.md，材料给定）。

**上网核实的一手来源：**

10. Claude Code：“Rules are evaluated in order: deny, then ask, then allow. The first match in that order determines the outcome”“Permission rules are enforced by Claude Code, not by the model. Instructions in your prompt or CLAUDE.md shape what Claude tries to do, but they don't change what Claude Code allows.” —— https://code.claude.com/docs/en/permissions
11. Codex rules：`prefix_rule(pattern, decision = allow|prompt|forbidden, justification, match, not_match)`；“Codex applies the most restrictive decision when more than one rule matches (`forbidden` > `prompt` > `allow`)”；`match`/`not_match` 是“inline unit tests”，加载时校验；`codex execpolicy check` 可测。—— https://learn.chatgpt.com/docs/agent-configuration/rules
12. OpenAI Agents SDK guardrails 的教训：输入/输出守卫只覆盖首尾 Agent，hosted 工具不走守卫——守卫必须放在“确定会经过的那一层”。—— https://openai.github.io/openai-agents-python/guardrails/

## 二、方案本身

### 0. 核心判断

Himawari 的问题不是“缺拦截点”，而是“缺单一权威源”。四个拦截点已经存在且各有测试；缺的是：(a) 一张带出处和版本史的登记册把它们的数据收编；(b) 一个“规则类型 → 执行器”的注册表把“必定执行”变成可门槛检查的结构性质；(c) 唯一真正的新拦截环节——聊天工具调用，且它只做便宜的确定性拒绝，**批准仍归 ActionPolicyService**（Claude Code 的教训：hook 不绕过权限系统，前提 10）。

### 1. 规则存哪里

迁移 0086 建两张表（只加表，符合“下一迁移号 0086”）：

- `rulebook_entries`：`id`（如 `rule_tool_deny_no_push`）、`type`、`status`（active/retired）、`payload`（按类型 schema 校验的 JSON）、`origin`（`{source: owner|built_in, thread_id, message_ref, verbatim_quote, decided_at, document}`）、`created_at`、`current_revision`。
- `rulebook_revisions`：append-only，`entry_id, revision, payload, changed_by, changed_at, reason`。生效值 = 最大 revision；改主意只插新行，旧值永久可查（ADR 0163 决定 2 “旧值留在历史里”）。

现有 H-1…H-16 与 C 类设置逐条**登记进册**（第一条修订即“建册导入”）：origin 用盘点已查到的 ADR/事故号；查不到的按盘点 G 节的既定处理写“无出处”。`DECISION_RULE_CATALOG` 并入登记册的目录层，decision_ledger 的校验改为读登记册（见 §6）。

`proactive_settings` 里的静默时段、重要发件人迁入登记册成为数据行；写死在代码里的 `PROACTIVE_PUBLIC_DOMAIN_SUFFIXES`、`MONEY_WORDS` 也迁为 `built_in` 数据行（主人可见可改，满足目标 5 “不写死”）。`proactive_settings` 之后只留运行参数（interval、cost cap 的配置键），或整体退役——二选一留Andy 拍板。

### 2. 规则类型怎么划分（第一批）

每个类型 = 一个 `packages/application` 里的纯函数执行器模块（模仿 `proactive-rules.ts` 的写法）+ 一份 payload schema + 正反两组测试。第一批全部对应**已存在**的执行点，所以“新类型才写代码”的成本近似为零：

| 类型 | payload 示意 | 执行点（已存在） | 对应现有规则 |
| --- | --- | --- | --- |
| `tool_deny` / `tool_ask` | capability + operation + resourcePrefix | ActionPolicyService `PermissionPolicy.rules` + Pi `tool_call` | S-16/S-17 的程序面、E 节审批 |
| `proactive_floor` | 发件人/域名/词表 | `floorHitIds`/`applyFloor` | H-1～H-5 |
| `proactive_suppress`（含静默时段） | 时段/优先级条件 | `isReminderWorthy`/`keepOffReminderPage`/`quietUntil` | H-6～H-8、H-11 |
| `budget_cap` | 每日上限 | `dailyCostMicros` 分支 | H-9 |
| `reminder_window` | 提前量/期限 | H-14 的换算函数 | H-14 |
| `memory_gate` | 阈值/分类 | H-12/H-13 分支 | H-12、H-13 |
| `guidance`（软） | 文字全文 | 注入最后一条消息 | S 系列可逐步搬入 |

一句新话若翻译不出任何已知类型，确认卡诚实显示“暂无这种规则类型，只能记住为软规则”——这本身就是目标 6 的落实。

### 3. 在哪些环节拦截

- **聊天工具调用**：新增隐藏扩展工厂 `himawari-rulebook`（只在 `packages/runtime-pi` 内，遵守 Pi 包引用约束），挂 `tool_call`，读 application 注入的**本轮已编译规则快照**（见 §4），命中 `tool_deny` 返回 `{block: true, reason}`。同消息并行工具调用会被 Pi 依次预检（材料事实），无需额外处理。执行器抛错按 Pi fail-safe 拦下（前提 8）。
- **治理性动作（写文件、联网、后台命令、花钱）**：权威裁决在 `ActionPolicyService.evaluate`——它有批准哈希、额度预留、快照校验；`tool_deny` 数据同时编译成 `PermissionPolicy.rules` 的 DENY 规则。Pi 钩子只是提前给出同样的拒绝理由，不产生批准。这条分工直接照抄 Claude Code 的结构（前提 10）。
- **Pi 管不到的环节**：Gmail 主动提醒循环、记忆捕获/整理、提醒调度、出站遮盖——都不经过 Pi 的 Agent 循环，本来就全是 application/execution 层程序代码，执行器在那里直接调用即可。OpenAI guardrails 的教训（前提 12）说明：守卫必须放在“动作确定会经过的那一层”，Himawari 的这一层就是 application 服务函数，不是模型钩子。

### 4. 怎样保证必定执行并有测试

- **单一编译入口**：每次运行开始时把登记册生效集编译成不可变快照（`CompiledRules`），本轮所有拦截点读同一份快照——对话中途不改，天然满足确定性（必答问题 1、2）。
- **每类型正反测试**：正向（命中必须拦/必须抬升）+ 反向（不命中不得拦）。反向用例要“真的会失败”：例如集成用例故意删掉 `himawari-rulebook` 工厂后断言该工具调用被放行——断言失败即门槛红。
- **新阻断门槛 `npm run check:rulebook`**（挂进 `npm run check`）：① 登记册每一行 `type` 必须有已注册执行器，`payload` 必须过该类型 schema；② 登记册 id 与决策记录目录一致（防 I-73 式“清单里的 id 过不了后端校验”）；③ proactive 消费端读的数据键与登记册导出键一致；④ 导出器产物可解析、分类过滤生效。
- **决策记录**：每次因硬规则发生/没发生都写 `decision_ledger.ruleIds`，且记录 `revision`（写成 `rule_x@3` 或独立字段，二选一由实现定）——这满足 Jarvis Test #11 的“追溯到规则及其当时的版本”。chat 拦截要落 ledger，需按 2026-11-09 约定先扩 `insertLedgerRow` 的字段白名单和校验（前提 5），再改约定文档。

### 5. 主人的一句话怎么变成硬规则

沿用 M-1 的判断入口，但把“模型判断”降级为“模型翻译”：

1. `memory.capture` 判出硬规则候选时，必须产出**结构化提案**：`{type, payload, verbatim_quote, thread_ref}`，模型只填参数，不得自行生效。
2. 服务端校验提案：schema 不过 → 确认卡显示错误和原话（诚实，不静默丢）；过 → 编译成自然语言语义预览（“以后每天 12:00–24:00 不推送提醒；命中示例：……”）。
3. **确认卡**（ADR 0163 决定 4）Andy 点头 → 写入 `rulebook_entries` revision 1 + origin。一次性的拒绝照旧不变成长期规则。
4. 改主意：规则页改 payload → 新 revision，旧值留 `rulebook_revisions`；退役只改 status，不删行。
5. 生产 3 条死 `rule` 记忆：按“Andy 不必为旧数据花心思”的约束，迁移时把仍在回收站/已删除的规则记忆不作搬迁，需要的话由 Andy 在确认卡里重说一遍。

### 6. 模型怎样知道有这些规则

- **硬规则摘要**：登记册生效集按 id 排序、确定性序列化成一小段文字（每条一行：“已禁止：向 X 发邮件（出处：你 11-02 说的‘…’）”），由 `owner-profile-service` 注入**最后一条消息**的独立块。硬规则块不与 2000 字预算竞争（规则是硬性设定，不能被挤掉——这是 M-3 缺口的直接修正）；给独立的小预算 + 确定性截断（超长按 id 截，截哪些是确定的）。
- **软规则（guidance）**：维持现状走“主人的要求”块与 2000 字预算，先到先得；是否单独预算留作待定。
- **不动系统提示、不动工具定义**。规则中途新增/修改，下一轮在最后一条消息出现——追加约束天然满足。可选的“按对话冻结的系统提示节”方案（ADR 0163 决定 3 允许）**本方案不选**：收益小、要动请求开头、还要处理换新语义，留待确有需要时另出方案。
- 顺带修盘点 F-1 的两处不一致：`mail.judgment` 里 S-8/S-9 的文字版改为由登记册数据确定性生成（改提示词目录 + 快照测试，只对新对话生效，符合 prompt-prefix 第 6 条），从此代码和提示词同源，不会再漂。

### 7. 导出（Jarvis Test #12）

导出器从登记册生成两件东西：

1. `SKILL.md`：guidance 全文 + 硬规则的自然语言陈述；每条硬规则注明“此条在 Himawari 内由程序强制，在此处仅为说明”——**不在别的系统里谎称必定执行**（目标 6）。
2. 权限映射文件：`tool_deny` → Claude Code `permissions.deny`、Codex `prefix_rule(decision="forbidden", match=…, not_match=…)`，且 match/not_match 内联示例直接取自该类型的反向测试用例——正好复用 Codex “inline unit tests” 的机制（前提 11）。导出前按数据分类过滤（原话可能含敏感内容）。
   验收：导出物在 Claude Code / Codex 实际加载后跑愿景 #1、#6 的用例。“未核实”：Claude Code 侧 deny 规则能否与 SKILL.md 同目录生效（permissions 需要 settings 文件），要试了才知道。

### 8. 分步落地

1. **建册（不改行为）**：0086 迁移 + 两表 + 目录统一 + 导入 H/C 全部条目（含“无出处”标注）+ `check:rulebook`。
2. **数据搬家**：important_senders、quiet_hours、金钱词、公共后缀进册；`proactive-rules.ts` 改读数据；修 S-8/S-9 漂移；`proactive_settings` 处置（拍板项）。反向验收：改静默时段后旧行为用例必须失败/通过各就位。
3. **第一个新硬类型 `tool_deny` 全链路**：执行器 + ActionPolicyService 编译 + `himawari-rulebook` 钩子 + 确认卡 + ledger 扩展 + 正反测试。反向验收：构造一条应被拦的工具调用，删钩子后必须真被放行。
4. **模型可见性**：硬规则摘要块（独立预算）+ prompt-catalog 同源生成。
5. **导出**：SKILL.md + 权限映射 + 双环境验收场景（进 release-walkthrough 覆盖测试）。
6. **软规则逐条归类**：S 系列逐条判“能不能有类型”，不能的诚实留软。

## 三、考虑过但不选的做法

- **把规则写进系统提示让模型自觉**（现状的推广）：违反目标 1 和愿景原则 3；生产 3 条规则记忆全灭已证明（前提 7）。
- **用 Pi `context_with_system`/`context` 钩子改写消息实现规则**：直接违反追加约束，`check:prompt-prefix` 会红。
- **引入通用策略引擎（OPA/Cedar 式）**：一个用户、七个类型，引擎的学习/维护成本远超收益；类型执行器每个都是可读纯函数，恰好符合 ADR 0163 “按类型写测试”。等类型超过十几条再评估。
- **只在 Pi 钩子里做全部拦截**：Pi 管不到主动提醒、记忆、调度三个循环；且把批准决策放进钩子会绕过授权快照/额度链路（Claude Code 明确不让 hook 绕过权限，前提 10）。
- **规则继续存记忆系统**：预算竞争 + 模型归类，就是“产品承诺确定性、实现是概率性”的病灶本身。

## 四、风险和反例

- **绕过反例**：`tool_deny` 若对 bash 只做前缀匹配，`bash -c '…'`、`xargs`、环境变量赋值都能绕（Claude Code 文档自己承认这类局限：deny 只停“第一种形式”）。对策：对 bash 类工具按“整条命令解析后逐子命令匹配”（Codex 的 tree-sitter 拆分是先例），解析不了的整条按最严处理；实在保证不了的，登记册里诚实标“此条对嵌套命令不完全硬”。
- **fail-closed 误伤**：登记册读取失败若拦掉一切，一次 DB 故障就瘫掉对话。对策：每轮开始读一次、失败沿用上一次成功快照并大声记日志（快照确定性不受影响）；但 DENY 命中后绝不放行。
- **I-73 复发**：新 `rule_id` 格式若含 ledger 校验不接受的字符，抽屉显示“未登记的规则”。对策：`check:rulebook` 用生产同款校验函数逐条过（前提 5）。
- **导出泄密**：规则原话里可能带密码。对策：导出前过 `packages/sensitive-capture` 的遮盖 + 分类过滤，作为门槛 ④ 的一部分。
- **确认卡疲劳**：目标 5 要求少点头。对策：`guidance` 类不强制确认卡（写入即可，反正不是硬）；只有会产生程序拦截的类型才出卡。这条取舍留 Andy 定。

## 五、需要人拍板的取舍

1. `proactive_settings` 是留壳（运行参数）还是整体退役。
2. 硬规则摘要块放最后一条消息（本方案）还是按对话冻结进系统提示（要动请求开头，需另出方案）。
3. `guidance` 类是否免确认卡直接生效。
4. 软规则是否脱离 2000 字共用预算。
5. ledger 里 `ruleIds@revision` 的具体编码。

## 六、证实 / 推测 / 未核实

- **证实**：以上所有引 `文件:行` 的内容均读自本仓库 a39b035e；前提 10、11 读自两个官方文档页原文；前提 12 读自 OpenAI 官方文档。
- **推测**：第一批七个类型足以覆盖盘点里的 16 条硬规则（H-10“垃圾邮件不送模型”、H-16“已回复按串算”暂归“尚无类型”，可保持代码内实现+登记，不必强行造类型）；导出映射能在两环境通过 #1/#6。
- **未核实**：Pi v1.5.0 源码原文（引材料给的引文，未开 GitHub 核对）；Claude Code 侧 permissions 文件与 SKILL.md 并存的实际加载行为；Codex rules 文档自称 "experimental"（已核实），正式程度未知。

## 七、必答问题

1. **会不会改变模型已见过的请求开头？** 不会。硬规则执行完全不进模型请求（登记册→编译快照→程序拦截）；模型可见的部分（硬规则摘要、guidance）全部走 `owner-profile-service` 的**最后一条消息**注入（owner-profile-service.ts:182 现有机制），系统提示、工具定义、历史零改动；每轮会变的值（规则生效集、本轮时间）都在最后一条消息里。规则中途新增，表现为新一轮末尾多了内容，开头不变。`check:prompt-prefix` 需补一条正向+反向用例：注入规则块后多轮逐字节比前缀、改历史规则文本必须报失败。
2. **同一段文字会不会在不同请求里变成不同字节？** 受控不会。序列化按 id 排序、键序固定；不注入时间戳；生效状态每轮重算但只在最后一条消息（允许变）；遮盖沿用现有确定性规则（prompt-prefix 第 11 条），规则文字若含主人点名的敏感值，遮法只取决于它自己及其前面的内容。
3. **有没有自动检查、反向用例会不会真失败？** 有：① 每类型执行器正反测试；② 新门槛 `check:rulebook`（类型↔执行器↔schema↔ledger 校验四方一致）；③ `decision-chain.test.ts` 扩展列出新字段；④ prompt-prefix 新用例。反向用例按 owner-standing-rules 要求设计成“删掉实现就红”：删 `himawari-rulebook` 工厂后“该拦的调用被放行”断言失败；登记册写入未注册 type 后 `check:rulebook` 失败。
4. **每个值的两端核对：**
   - `rule_id`：产生=登记册写入端；使用=ledger `ruleIds` 校验（登记册目录）、抽屉渲染、导出器、`himawari-rulebook` 快照。两端共用同一目录模块 + `check:rulebook` 逐条用生产同款校验——直接针对 I-73 的教训。
   - `type` 名：产生=确认卡/schema；使用=执行器注册表、迁移写入、UI、check:rulebook。注册表用封闭联合类型，未注册 type 在编译期就被拒。
   - `payload` schema：产生=迁移与写入端；使用=执行器编译、导出器、确认卡预览。schema 只有一份，写入和编译都引用它。
   - 迁移走的 `proactive_settings` 旧键：使用方是 `sqlite-proactive-operations.ts` 读取端和 UI 设置页——迁移 PR 必须列出全部读取点并同 PR 改完（盘点 F-4 已点名该表无历史，搬家正是修它）。
   - `mail.judgment` 同源生成的新文字：使用方是提示词快照测试（`prompt-rendering-golden`）与新对话冻结头——改文字只影响新对话，老对话冻结不变，符合 prompt-prefix 第 6 条。
