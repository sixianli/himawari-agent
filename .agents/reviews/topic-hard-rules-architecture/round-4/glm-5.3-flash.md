代码现状已经读得差不多了，下面查几份业界一手资料印证架构方向。
我已读完仓库相关代码与文档，并核对了业界一手资料。下面是完整方案。

---

# 用户硬规则接入 Himawari Agent：架构方案

## 一、方案依赖的前提（全部有出处）

**代码与文档证实的前提**

1. 硬规则必须是“写进程序、必定执行，每条规则类型有回归测试”，主人偏好只是数据。`docs/product-vision.md:59`：“规则不是记忆，是硬性设定：记忆只保存一条规则的出处和修改历史；规则本身写进程序、必定执行，每条都有回归测试守着。”；`docs/adr/0163-owner-preferences-as-data-run-by-tested-rule-types.md:39-49` 决定第 1–4 条：“回归测试按规则类型写，不按每条偏好写”“硬偏好：由程序执行，并写进决策记录”“软偏好：存成文字”“一句话要经过确认卡，Andy 确认后才变成长期规则”。
2. 原则裁决顺序：用户主权 > 边界与可逆性 > 记忆可靠性 > 主动性与效率。`docs/product-vision.md:55`。
3. 发给模型的内容只追加、会变的值只在最后一条消息、字节必须确定、后台调用也是固定在前会变在后。`.claude/rules/prompt-prefix.md:28`（“每轮都会变的内容只放在最后一条用户消息里”）、`:35`（第 4 条只追加）、`:51`（第 10 条“同样的内容，每次都要序列化成同样的字节”）、`:67`（第 15 条后台调用）。
4. Pi 官方的工具调用前拦截写法是 `tool_call` 事件返回 `{ block: true }`，且仓库规范已指名硬规则该走这里：`docs/pi-development-guide.md:160`：“新增的‘直接拒绝、不需要等人’的规则（例如硬规则），用这个钩子写，挂在一个隐藏的内联扩展里。”官方出处 `docs/extensions.md` 第 973 行：“Fired after `tool_execution_start`, before the tool executes. **Can block.**”。
5. 大量推送根本不经过模型：网页推送由后台循环直接产出五种来源（到点提醒、待审批、任务完成、邮件主动提醒、Muse 中断），全程无模型调用。`apps/agent-service/src/production-web-push.ts:315-389`（`#collect` 把 reminders、approvals、finished runs、proactive、muse 五类直接进 outbox）。
6. 邮件主动检查是“单次模型调用 + 判后程序套规则”，不是 Agent 循环：模型判断之后程序执行地板规则（`packages/application/src/services/proactive-mail-check-service.ts:840-851` 调 `keepOffReminderPage`/`applyFloor`）、推送窗口（`:877-882`）、降频（`:898` `#gateBackoff`）、静默（`:903-908` 对 `counts.pushed > 0` 调 `quietUntil`）。定时器在 `apps/agent-service/src/production-proactive.ts:194`。
7. 静默时段现在有两份互不相干的实现：`packages/application/src/services/proactive-rules.ts:200-230`（`quietUntil`，纯函数，支持跨天和星期几）和 `packages/application/src/services/attention-policy-service.ts:20-24,209-216`（另一份 `quietHours`，`NOTIFY` 降为 `DIGEST`）。
8. 已有动作授权是数据驱动的确定性策略：`packages/application/src/services/action-policy-service.ts:316-325`（`policy.rules` 里 effect=DENY 的规则先行拦截）、`:607-623`（每次裁决写 `trace` 决策记录）。
9. 现状问题（盘点文档证实）：同一条规则在代码和提示词两处各一份且 2 处已对不上（`docs/agent-rulebook-inventory.md` F-1）；主人定的规矩要靠模型判成 `rule` 记忆、再过 2000 字预算才能被看到（F-2）；除 Gmail 外聊天里的规矩没有一条是硬的（F-3）；`proactive_settings` 改动直接覆盖、无版本无历史（F-4）；公共机构后缀、金钱词表写死在代码里，主人改不了（F-5）。
10. 事故教训：改了一个值，必须查“每个使用它的地方能不能接受它”。I-73 的根因是“清单扩展时丢掉发送校验不接受的模型”，修复门槛是生成端逐个过两包校验、并加发布验收场景（`docs/incidents-and-gates.md:112`）。
11. 现有自动检查的形态：`npm run check:prompt-prefix` 带反向用例（改写历史用户消息、系统提示带每轮变化值等必须报失败）；`npm run check:agent-rulebook-inventory` 核对清单里的链接、锚点、测试文件名、测试编号真实存在（`.claude/rules/prompt-prefix.md:74`、`docs/agent-rulebook-inventory.md:32`）。

**业界一手来源（详见第三节）**

12. Claude Code 官方明确警告“不要靠模型自觉或文本过滤来执行硬性允许/拒绝”。原文：“Because the `if` filter is best-effort, use the permission system rather than a hook to enforce a hard allow or deny.”（https://code.claude.com/docs/en/hooks ，PreToolUse 一节）——硬规则必须落在确定性机制上。
13. OpenAI Agents SDK 的 guardrail 有“阻断式”执行模式，且工具级 guardrail “每次调用都跑”。原文：“Blocking execution guarantees that the expensive model does not start”“They are configured on the tool itself and run every time that tool is invoked.”（https://openai.github.io/openai-agents-python/guardrails/ ）。
14. OPA（CNCF 策略引擎）的核心架构是“决策与执行分离、策略是数据、程序带结构化数据来查询”。原文：“OPA decouples policy decision-making from policy enforcement. When your software needs to make policy decisions it **queries** OPA and supplies structured data (e.g., JSON) as input.”（https://www.openpolicyagent.org/docs/latest/ ）。且示例规则里就有“什么时候可以访问系统（When during the day the system can be accessed）”——静默时段正是这类规则。
15. Anthropic 工程文章区分 workflow（预定义代码路径编排）与 agent（模型自导），并明确“workflow 对定义良好的任务提供可预测性和一致性”“agent 的自主性意味着更高成本和错误复利的可能”（https://www.anthropic.com/research/building-effective-agents ）——确定性的部分应当用 workflow，不要为了“让模型参与”而把确定性判断交给模型。

**推测（未核实，落地前要确认）**

16. Pi 1.5.0 的 `tool_call` 返回 `{ block: true, reason }` 后，reason 以什么消息形态回到模型（工具结果还是别的），我没有读 Pi 源码确认，落地时要按包内 `docs/extensions.md` 原文核对。
17. 生产库 `owner_rules`（新表）的表结构、CHECK 约束、迁移路径均未存在，属本方案新增，校验细节是设计值不是实测。

---

## 二、方案总述（给主人的一段话）

把“硬规则”拆成**两半**：**规则内容是数据，规则执行是程序**。所有硬规则登记在一张统一的“规则登记册”里（一条规则一行：类型、参数、出处、状态、版本历史），想加“金额小于 100 不推送”，就是在登记册里加一行数据，不用改任何代码；只有出现全新的规则**类型**（比如以前从没有过“按金额过滤”这种类型），才写一次程序、配一套测试——这正是 ADR 0163 定下的方向。执行不靠模型自觉，而是固定在两个“关卡”上：**通知关卡**（任何要推送、上提醒页、打断主人的东西，出门前都必须过一次，静默时段、金额阈值这类规则在这里判）和**动作关卡**（Agent 循环里每次要调工具，Pi 的 `tool_call` 钩子先按登记册查一遍，命中就拦下，并把“为什么拦”作为工具结果追加给模型）。模型的角色是三件事：提取事实（比如从邮件里读出金额是多少）、在被拦时向主人解释原因（原因文字由规则类型给出，不是模型编的）、以及把主人的一句话提议成新规则（经确认卡确认后变成登记册里的一行数据）。这样规则天然可插拔（增删改都是改数据、带版本、留历史），天然覆盖所有入口（不经模型的推送路径也被通知关卡管住），而且不给每轮对话增加任何 token 负担。

## 三、业界印证

| 来源 | 原话 | 对本方案的支撑 |
|---|---|---|
| Claude Code Hooks 官方文档，https://code.claude.com/docs/en/hooks | “`PreToolUse` \| Before a tool call executes. Can block it”；“Because the `if` filter is best-effort, use the permission system rather than a hook to enforce a hard allow or deny.” | 动作关卡挂在工具执行前是官方模式；且官方明说硬性允许/拒绝不能靠模型自觉或尽力而为的过滤——这正是“模型先扫规则”方案的缺陷 |
| OpenAI Agents SDK Guardrails，https://openai.github.io/openai-agents-python/guardrails/ | “Blocking execution guarantees that the expensive model does not start”；工具 guardrail “run every time that tool is invoked” | 确定性闸门应在昂贵动作（模型调用/推送副作用）之前，且逐次调用必跑，不依赖模型的配合 |
| OPA 文档，https://www.openpolicyagent.org/docs/latest/ | “OPA decouples policy decision-making from policy enforcement… it **queries** OPA and supplies structured data (e.g., JSON) as input”；示例用例含 “When during the day the system can be accessed” | “决策与执行分离、策略是数据、输入是结构化事实”是成熟策略引擎的标准形态；静默时段属于同类规则 |
| Anthropic《Building effective agents》，https://www.anthropic.com/research/building-effective-agents | “workflows offer predictability and consistency for well-defined tasks”；“The autonomous nature of agents means higher costs, and the potential for compounding errors” | 必定执行的判断属于 workflow（预定义代码路径），不该为了“让模型参与”把它变成 agent 的概率判断 |

另外，本仓库 `docs/pi-development-guide.md:160` 已经把“直接拒绝的硬规则用 `tool_call` 钩子、挂在隐藏内联扩展”定为官方写法，方案与它一致，不构成新的偏离。

## 四、对主人设想（模型先扫规则、不调推送工具）的评价

**同意的部分**

- “所有规则集中登记、能插进 Agent 的 loop”——方向完全正确，这正是登记册的出发点。
- “规则应该在推送发生前生效，而不是事后补救”——同意，所以关卡放在推送产生之前。
- “规则要能覆盖 Agent 循环里的动作”——同意，动作关卡（`tool_call`）就在 loop 里。

**不同意的部分：把“扫规则、决定调不调工具”交给模型**

1. **不满足“必定执行”**。模型可能不扫、扫漏、读错。愿景原则 3 要求“写进程序、必定执行”；Claude Code 官方也明说硬性拒绝不能靠模型侧的尽力而为机制（前提 12）。模型扫规则本质上是把硬规则退化回软规则——正是盘点 F-2 批评的“产品承诺确定性，实现是概率性”。
2. **覆盖不了大多数推送**。五种推送来源里四种不经模型（前提 5），邮件判断是单次调用不是循环（前提 6）。模型扫规则只能管住“Agent 循环里调推送工具”这一条窄路，静默时段最重要的场景（夜里到点的提醒）反而管不住。
3. **token 与缓存代价**。每轮把规则清单注入上下文，清单一变（主人加一条规则）就是请求开头/内容的字节变化，要小心 KV 缓存；而且这些 token 每轮都花。确定性关卡是 0 token：邮件路径现在判后套地板规则就不花模型钱（前提 6），推广到所有推送路径同样免费。
4. **模型的正确角色是“被告知结果”而不是“做决定”**。规则拦下后把原因追加给模型，模型照样能对主人解释“按你定的规则，小于 100 块的支付我没提醒你”——主人设想里“模型知道规则并据此行动”的价值保留了，只是判断权收归程序。

## 五、方案本身

### 5.1 规则怎么表示（登记册：数据）

一张版本化的表（命名如 `owner_rules`），每行：

- `id`（稳定机器串，如 `rule:notify-amount-floor:payments`，生成后不变，展示和 URL 都要用它——I-73 的教训是 id 必须过所有使用端的校验，见必答问题 4）
- `ruleTypeId`（指向一种规则类型）
- `params`（该类型定义的 JSON 参数，如 `{ "currency": "JPY", "minimum": 100 }`；键序固定存储）
- `origin`（出处：主人原话、确认卡记录、ADR 号——回应盘点“没有任何一条规则带出处字段”）
- `status`（active / disabled）、版本号与修改历史（照 ADR 0122 的做法，修掉 C-5“无版本号、覆盖不留历史”的问题）

加/停/改规则 = 改数据，即插即拔。一句话变规则走 ADR 0163 第 4 条的确认卡。

### 5.2 规则怎么执行（两个关卡 + 一个共享求值核心）

**规则类型（代码）**：每种类型是一个纯函数 `evaluate(事实, 参数) → 判定`，判定为 `ALLOW / DEFER(到何时) / BLOCK(原因码+解释文字) / ADJUST`。类型在“类型注册表”里登记：参数 schema、事实 schema、测试。第一批类型直接从盘点收编：静默时段（收编 `quietUntil` 和 attention-policy 那份重复实现，修掉 F-1 类“两处对不上”）、金额下限、重要发件人、某类不提醒、每日上限。

**通知关卡（NotificationGate）**：应用层一个服务，所有“要打扰主人”的出口都必须过——网页推送循环 `#collect` 入队前、邮件判断产出 `push` 标志处、提醒、attention-policy 决策。输入是结构化事实（来源类型、金额、时间、时区、发件人），输出判定；DEFER 的合并逻辑沿用现有 `quietUntil`。**这一步 0 token，全部确定性**。

**动作关卡（ToolGate）**：Pi 隐藏内联扩展的 `tool_call` 钩子（官方写法，前提 4）。把工具调用映射成事实（能力、操作、资源、参数），查登记册求值；BLOCK 时返回原因，模型在同轮看到工具结果，可以向主人解释或换合规做法；需要人批准的规则类型返回“转审批”，接进现有 D2 审批流（主人已批准保留）。

### 5.3 模型扮演什么角色、程序扮演什么角色

- 程序：登记、求值、拦截、记录。每次 BLOCK/DEFER/ADJUST 写决策记录（沿用 `action-policy-service.ts:607-623` 的 trace 形态，带 ruleId 和 reasonCode），Andy 能从一条决策一路点到规则原文（对齐 ADR 0195 的一页一决策）。
- 模型：① 提取事实——例如邮件判断的结构化输出加一个可选 `moneyAmount` 字段（提示词改动只进冻结的判断提示词，会变的值在最后，遵守 prompt-prefix 第 15 条）；② 被拦时解释；③ 提议规则候选，等确认卡。

### 5.4 与现状的收编关系

现有 16 条程序硬规则（盘点 H-1~H-16）不要求一次搬家：先把两个关卡和登记册立起来，静默时段、金额下限两种类型先行（正好对应主人举的两个例子），其余类型按需逐个收编；`proactive_settings` 的重要发件人名单迁入登记册解决 F-4/F-5。**未核实**：`proactive_settings` 的读取方（`sqlite-proactive-operations.ts` 等）在迁移期需要双读还是一次切换，要看读取方清单后定。

## 六、三个完整走查

**例 1：金额小于 100 不推送（邮件路径）**：90 块的订阅邮件到达 → 定时器触发判断调用（前提 6）→ 模型判“要你做事”并提取 `moneyAmount: 90` → 通知关卡对 insight 求值“金额下限 100” → 90 < 100 → BLOCK，reasonCode `notify_amount_below_floor`，写决策记录（哪条规则、哪封邮件、模型原判是什么）→ 推送不产生。“要不要同时不上提醒页”是参数语义，见拍板项 1。

**例 2：同一规则（对话路径）**：主人让 Agent“付款后告诉我” → Agent 循环调用推送/通知工具 → 动作关卡（`tool_call`）按参数里的金额求值 → BLOCK，工具结果把规则原因追加给模型 → 模型答复：“这笔 90 块，按你定的‘小于 100 不提醒’的规则，我没有发推送。”模型全程没有“扫规则”，它只是被程序告知了结果。

**例 3：23:00–07:00 静默（不经模型的路径）**：一条 23:30 到期的提醒在网页推送循环里被 `#collect` 产出 → 通知关卡“静默时段”类型（事实：当前时刻、时区；参数：23:00–07:00）→ DEFER 到 07:00，合并逻辑沿用 `quietUntil` → 决策记录写 `deferred_quiet_hours`。同一时刻若 Agent 在对话里想调推送工具，动作关卡同样 DEFER 并告知模型“已排到 07:00”。这条走查证明关卡管住了模型根本没参与的推送。**顺带**：attention-policy 那份重复的 quietHours 收编为同一规则，消灭两份静默时段。

**例 4（非通知规则，证明架构的普适性）**：“修改或删除文件前先确认路径和内容”（现在只是 C-1 里的软提示）→ 收编为新规则类型“动作前确认”，动作关卡对写/删工具命中 → 返回“转审批”，复用 D2 审批流等主人点头。将来主人再立“涉及他人隐私的事不联网查”之类，同样是登记册加一行（若需要新类型才写代码）。架构与通知无关，同样成立。

## 七、考虑过但不选的做法

1. **主人的原案（模型每轮扫规则清单再决定调不调工具）**：理由见第四节，核心是“必定执行”和覆盖面两条硬伤。
2. **把规则渲染进系统提示/工具定义**：违反 prompt-prefix 第 2 条（系统提示和工具定义里不得出现会变的值——规则清单会增删），且每轮重算。不选。
3. **继续沿用 `rule` 类记忆 + 2000 字预算**：就是盘点 F-2 点名的概率性实现，且预算放不下时规则悄悄失效。硬规则不走这条路；`rule` 记忆退为“软偏好”的家。
4. **引入 Rego/OPA 这类通用策略引擎**：模式可借鉴（决策/执行分离、策略是数据），但单主人系统引一个 Go/Rego 运行时、加一层 DSL 和调试成本，收益远低于“TS 纯函数类型注册表 + JSON 参数”。不选，只借架构。
5. **每个出口各自内联判断（现状）**：已造成两份静默时段、代码/提示词两份词表对不上（前提 9），不选。

## 八、风险、代价与放弃的东西

- **风险 1（正确性）**：模型没提取出金额时金额下限规则无法判定——兜底行为需要主人拍板（放行、或降级为“请看原信”）。这是该架构最大的诚实短板：规则只能判程序拿得到的事实。
- **风险 2（双关卡漂移）**：通知关卡和动作关卡必须共用同一个求值核心，否则回到“两份静默时段”。
- **风险 3（迁移期双轨）**：收编完成前，旧规则和登记册并存，盘点文档要继续跟踪（已有 `check:agent-rulebook-inventory` 门槛可用）。
- **token 代价**：执行侧 0 新增 token。唯一新增是邮件判断输出 schema 加字段（输出几个 token，可忽略）和被拦时追加的一段原因文字（只在真的拦下时发生）。**放弃的东西**：没有每轮可见的规则清单，模型不能“预判”规则去主动省事（例如不白做一次将被拦的操作）——邮件路径里判断调用本来就在规则之前发生，这点成本与现状的地板规则相同，没有变差。
- **代价**：登记册、两个关卡、类型注册表、确认卡接线，是一次中等规模的基建（估计分 3 个 PR：登记册+存储、通知关卡收编静默时段、动作关卡接 `tool_call`）。

## 九、需要人拍板的取舍

1. “小于 100 不通知”的语义：只不推送（仍上提醒页），还是连提醒页都不上？
2. 模型没给出金额时的兜底（放行 / 降级为“请看原信”）。
3. `proactive_settings` 迁入登记册的方式（一次切换还是双读过渡）。
4. 需要“等人批准”的规则类型是否都接 D2 审批流（我建议是）。
5. 邮件判断提示词加金额字段会打破 `prompt-rendering-golden` 逐字快照，需要主人同意改快照。

## 十、必答问题逐条

**1. 会不会改变模型已经见过的请求开头？**
不会。规则本身不进系统提示、不进工具定义（5.4 明确排除）；两个关卡都是程序侧的，不触碰请求组装。模型可见的新增内容只有两处，都符合只追加：① 动作关卡 BLOCK/DEFER 时返回的工具结果（同轮新增消息，不改已有内容）；② 若将来要让模型看到规则清单，只能放最后一条用户消息（ADR 0163 第 3 条给的两个去处里，规则清单会变，只能选最后一条消息，不能选“按对话冻结”）。每轮会变的值（当前时间等）仍只在最后一条消息。**未核实**：Pi 1.5.0 把 `tool_call` 的 block reason 以何种形态回给模型（推测是工具结果），落地时按包内 `docs/extensions.md` 核对；若是“替换已有占位消息”之类形态，就要按 prompt-prefix 第八节先出方案。

**2. 会不会让同一段文字在不同请求里变成不同字节？**
不会，前提是落实三条设计约束：① 规则参数用键序固定的 JSON 存储/序列化（prompt-prefix 第 10 条）；② 求值顺序按规则 `id` 排序，不依赖数据库返回顺序（同上）；③ 依赖当前时间的判定（静默时段）其结果（DEFER 到几点）只出现在决策记录和最后一条消息里，不进入已发历史；`quietUntil` 本身已是纯函数（前提 7），同输入同输出。遮盖路径不改动，规则关卡不触碰消息内容本身。

**3. 有没有对应的自动检查、反向用例会不会真的失败？**
设计为四道：① 每种规则类型的契约测试（参数 schema 校验 + 金样例 + 反向用例：把 90 块的推送故意放行、把 23:30 的推送在静默时段发出，断言必须失败——与 `proactive-mail-check.test.ts` 现有 PG-7 同一风格）；② 把 `check:agent-rulebook-inventory` 扩展为：清单里每条 H 规则必须指向登记册支持的规则类型和真实测试编号（该门槛已会核对测试文件名/编号存在，`docs/agent-rulebook-inventory.md:32`）；③ 在 `check:prompt-prefix` 的反向用例组里加一条“把规则清单渲染进系统提示”必须报失败（现有 harness 已支持构造这类违规，前提 11）；④ 通知关卡集成测试挂在生产推送循环上（对 `#collect` 收 23:30 提醒，断言出箱被 DEFER）。反向用例“真的会失败”的机制：①④ 断言的是关卡输出，放行即断言失败；③ 复用现有逐字节比对，注入即失败。

**4. 产生的每个值、每个使用它的地方都能接受吗？**
逐个列（产生端 → 使用端 → 两端校验）：
- **规则 `id`**（登记册生成）→ 决策记录、规则页 URL、API。I-73 的教训是 id 必须过所有使用端校验：落地时要逐一把 id 格式对着决策记录展示（ADR 0195）、URL 编码、任何 `machineString` 类合约规则核一遍；id 只用 `[a-z0-9:-]` 就能避开 I-73 那类斜杠问题。**未核实**：现有决策记录合约对 reasonCode/id 的具体校验规则，实施时要先读。
- **`reasonCode`**（规则类型定义）→ 决策记录页渲染、日志。要求：新增码必须登记进展示端的码表，未登记的码按“显示原始码”兜底而不是丢弃记录（防止 I-73 式“生成端能产、消费端不认”）。
- **`moneyAmount`**（模型输出）→ 通知关卡。产生端：判断输出的 schema 校验目前严格（非法即 `MODEL_OUTPUT_INVALID`），字段必须定义为可选，旧输出不携带也不报错；使用端：关卡必须接受缺失并走拍板项 2 的兜底。两端都要有测试。
- **`ruleTypeId` + `params`**（登记册写入端）→ 两个关卡。写入端按类型 schema 校验（拒绝不认识的类型和参数——这是登记册的“发送校验”）；关卡求值前对读到的行再校验一次（防止手工改库或迁移残留绕过写入校验）。两端校验规则来自同一份 schema，避免 I-73 式“两份规则不一致”。
- **登记册行本身**（收编 `proactive_settings` 的静默时段/重要发件人后）→ 邮件检查服务、attention-policy、设置页。使用端从两处配置源改为读登记册；迁移方式（拍板项 3）决定是否需要过渡期双读；设置页要展示版本历史（对齐 ADR 0122）。**未核实**：`proactive_settings` 的全部读取方清单，实施第一步先盘点。
- **决策记录新增字段（ruleId）**→ 展示页和导出。展示端加一列，导出合约若带 schema 需同步。**未核实**：导出合约是否存在。

**“读代码或来源证实的”与“推测”的划分**：第一、三节全部为证实；第五节 5.4 的迁移细节、第九节成本估计、第十节内标注“未核实”的各点为推测或待落地确认。
