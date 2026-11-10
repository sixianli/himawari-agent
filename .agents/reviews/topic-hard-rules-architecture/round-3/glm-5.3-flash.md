我先看仓库结构和方案引用的关键文件，再逐条核对。
核对 Pi 官方文档中 tool_call 钩子的原话和语义：
# 审核结论：线程方案 v3（硬规则接入 Himawari）

## 先说核对结果总览

方案引用的前提 P1–P9 我逐条对了原文：P1（`docs/product-vision.md:59`“规则本身写进程序、必定执行，每条都有回归测试守着”）、P2（`docs/adr/0163`，决定 1、2 确为“测试按规则类型写、硬偏好是数据”）、P3、P4（`docs/pi-development-guide.md:156–161`，且与 Pi 官方文档逐字一致，见下）、P5（`docs/adr/0204` 决定 1“D2、D3 批准保留”）、P6（`proactive-mail-check-service.ts:1073` 的 `#judge` 确为 `model.prepare` 单次调用）、P7（`production-proactive.ts:194` `setInterval(... tick())`）都属实。P8 **不完整**（见问题 6）。`.agents/reviews/topic-hard-rules-architecture/`（v1/v2 轮次记录）在本检出里不存在——按 `.agents/instructions/model-review.md:104` 复核副本会用 sparse checkout 隐藏 `.agents/reviews/`，所以标「未核实」，不算作者捏造。

Pi 官方文档核对（https://github.com/earendil-works/pi/tree/main/packages/coding-agent/docs/extensions.md，tool_call 节）：原话 "Fired after `tool_execution_start`, before the tool executes. **Can block.**"、"Mutations to `event.input` affect the actual tool execution"、"No re-validation is performed after your mutation" 均与方案一致。另有两个方案没引用的官方事实后面用到：① "**An unknown tool or invalid arguments skip `tool_call`**"；② 并行模式下 "tool_call is not guaranteed to see sibling tool results from that same assistant message"；③ Handler Composition 一节："**gate handlers should fail closed** when their safety decision cannot be made"。

---

## 问题清单（按严重度从高到低）

### 1.【高·证实】延后队列没有持久化、去重和参数重校验，会造成重复执行或丢动作

**证据**：方案三.3.a“延后 → block 并由程序把这次调用按原参数排进延后队列，到点再执行”；五.风险第 1 条只承认“参数和上下文可能过期”，没提下面三个机制问题：

- **模型会重试**：模型收到 `{block:true, reason}` 后同一轮或下一轮很可能重发同一调用，每次都再排进队列 → 到点重复执行。仓库里现有的推送出站（outbox）全部靠 `sourceKey` 幂等去重：`apps/agent-service/src/production-web-push.ts:326`（`reminder:${id}:${remindAt}`）、`:336`（`approval:${id}`）、`:351`（`run:${runId}:${status}`）。延后队列没有等价机制。
- **服务重启**：审批为什么留在 execute 里（D2），理由就是“要等几小时、服务可能重启”（ADR 0204 前提 6、ADR 0023）。延后同样可能等几小时，方案没说队列存哪——不落 SQLite 就违反同一原则。
- **参数重校验**：Pi 官方明确 tool_call 改后 "No re-validation is performed"，且 "invalid arguments skip tool_call"。延后队列存的是“原参数”，到点执行时若不再过一次工具 schema 校验，等于绕过了 Pi 的入参校验层。

**建议**：延后改成复用现有 SQLite outbox 模式（像 `store.enqueue` + `sourceKey`），`sourceKey = 工具名 + 参数摘要`，重启后恢复；重放时先过参数 schema 校验再 decide；同一 sourceKey 只保留一条，模型重试合并。

### 2.【高·证实】3c 门槛（禁止直调发送端口）抓不住真实绕过路径，且没有反向用例；“加载失败不生效”是 fail-open

**证据**：方案三.3.c“工具实现之外的代码直接 import / 调用发送类端口……就让 npm run check 失败”。

- `npm run check` 的边界检查先例是 `scripts/check-boundaries.mjs`（I-55，事故清单第 92 行），它查的是**工作区 import**；但真正的发送路径大多在**同一个模块内部**：`production-web-push.ts` 的 `#collect`/`#deliver`（:287–420）、`proactive-mail-check-service.ts` 的 `quietUntil` 排队（:905、:1286–1288）、`attention-policy-service.ts:213` 的 `reasonCode: "quiet_hours"`。这些不 import 任何“发送端口”，门槛一个都拦不住。
- 规则“每条自带 match/not_match 例子，加载时跑，**不过不生效**”是 fail-open：一条拒绝型规则加载失败 = 静默放行。Pi 官方对 gate 类处理者的要求相反："gate handlers should **fail closed** when their safety decision cannot be made"（官方 extensions.md Handler Composition 节）。
- 按仓库自己的惯例（I-16、I-32 等每道门槛都带“改回旧写法必须失败”的反向夹具，见 `.claude/rules/incident-gates.md:15`“门槛是指自己会运行、失败时会拦下的检查”），方案对 3c 和例子检查都没有写反向用例，也没有写这两道检查加进 `npm run check` 的哪一步。

**建议**：3c 之外补一道**行为反向集成测试**作为真正的门槛：登记一条“全部拒绝”规则，逐个驱动全部发送来源（提醒、审批、运行完成、proactive 推送、muse 渠道、邮件判断产物），断言一条都不发；再登记“全部放行”断言都发。加载失败的拒绝型规则必须拒绝服务或明确告警并计入决策记录，不允许静默失效。

### 3.【高·证实】规则词汇（amount/category）在现有数据里根本不存在，方案漏掉了产生这些值的前置改动——正是 I-73 的模式

**证据**：方案三.2“工具的参数结构要显式带上规则会用到的值（例如推送工具带 category、amount、sender）”。但：

- 邮件判断的模型输出 schema 只有 `result/priority/summary` 等（`proactive-mail-check-service.ts:480–493`，priority 只取 `high|medium|low`），全服务没有 `amount` 字段（grep 证实）。
- 也就是说“金额小于 100 不推送”这类规则要能跑，必须先改 `#judge` 的输出 schema、加字段校验、迁移决策存储——方案完全没写这个改动，也没写“模型输出的金额能过规则比较器的校验吗”。
- 这和 I-73（事故清单第 112 行）同型：**产生端新造的值，没有核对消费端（这里反过来：消费端规则比较器）的校验**。I-73 的教训原话：“双模型复核只看了 diff，没问『清单里的 id 能通过后端校验吗』”。

**建议**：方案必须增加一节“规则词汇的来源与校验链”：每个 fact 由谁产生（模型输出/程序事实）、用什么 schema 校验、非法值时规则按什么默认结果处理（方案三.2 只写了“参数缺失”，没写“参数非法”）。第一批规则词汇建议只收**程序已知的事实**（kind、sender 域名、当前时间、发起方），不收模型自由填写的数值。

### 4.【中·证实】“全系统只有一个检查函数”与仓库里已有的三套确定性规则冲突，方案没有交代接管关系

**证据**：方案二“全系统只有一个检查函数 `rules.decide`”。但现状：

- `packages/application/src/services/proactive-rules.ts`：地板规则（`FLOOR_RULE_IDS`，:29–33）、静默时段 `quietUntil`（:200）、降频 backoff（`proactive-mail-check-service.ts:1004–1037` 的 `#applyBackoff`）；
- `packages/application/src/services/attention-policy-service.ts:20–118`：另一套独立的 quietHours 实现；
- `proactive_settings.important_senders`（ADR 0163 第 2 条明说它“既没有版本号，改动时也会直接覆盖旧值”）。

如果登记册上线而这三套照旧，就存在两三个“规则系统”，同一动作可能被两处分别延后/拒绝，“唯一闸”不成立；A16-3 也正是把“静默时段补版本号和历史”列为待办。

**建议**：方案写明：登记册第一批接管哪些现有规则（至少静默时段，正好是 ADR 0163 点名的例子），哪些保留为系统不变量（floor、backoff 属于校准机制，Andy 自己在 v2.2 附录第 10 条说它们是“确定性的地板规则”），以及过渡期两套并存时的合并顺序。

### 5.【中·证实】与 D2 的双重判断没有答案，且“ActionPolicyService 加 ASK 效果”表述错误

**证据**：方案三.3.a“先问我 → 交给现有审批路径（P5，**ActionPolicyService 加 ASK 效果**）”。`ASK` 早已存在：`packages/application/src/services/action-policy-service.ts:249`（`decision: "ALLOW" | "ASK" | "DENY"`）、`:517/:521/:591`。要做的不是“加 ASK”，而是把 `rules.decide` 的结果接入 `evaluate` 的哪个位置——而方案五.风险第 2 条自己提出“tool_call 先于 execute 运行……会不会重复判断或顺序冲突”，正文没有给出答案：同一次调用 decide 在 tool_call 跑一次、在 execute 的 preflight 里再跑一次，两次之间登记册变了听谁的？延后/拒绝在第一次已经决定，第二次还跑吗？

**建议**：写明单次语义：tool_call 的 decide 结果作为该次调用的**终审**记入决策记录；execute 里的 D2 preflight 照旧独立运行（它是权限不是规则），但规则层不再二次评估；执行入口（系统发起）才补跑 decide。

### 6.【中·证实】P8 不完整：发送来源实际有五类，方案只列三类；且“审批推送可被规则拒绝”与系统不变量冲突

**证据**：P8 说来源是“到期提醒、待审批、已完成的运行”。实际 `production-web-push.ts` 的 `#collect` 还有：`:358–368` proactive（邮件判断产出的推送，kind 记为 reminder）、`:369–379` muse-channel 渠道中断通知。后果：

- 方案四说“邮件主动检查……只要它最后通过推送工具的执行入口发出，规则就生效”——但邮件推送现在走的是 `proactive.listReady` → `#collect` 入队 → `#deliver` 发送，且入队前已经过 `quietUntil` 延后和 backoff 抑制（`proactive-mail-check-service.ts:1286–1288`）。说“只改末端”掩盖了中途这两道既有延后逻辑。
- 更重要的漏洞：approval 类推送如果也能被主人规则“拒绝”，规则就等于能吞掉审批通知本身——§七说“系统不变量（审批、出口遮盖、沙箱）……聊天规则不能放宽它们”，但只防了“放宽”，没防“变严到失灵”。

**建议**：P8 修正为五类来源并逐一列出去闸方式；登记册显式维护一份**规则不可触碰清单**（approval 通知、出口遮盖、沙箱），`rules.decide` 对这些目标只允许放行或延后，不允许拒绝。

### 7.【低·证实】若干引用与小问题

- 三.3.c 列的“Gmail 发送”端口不存在——当前 Gmail 只读（ADR 0106，`docs/execution/specs/2026-10-29-proactive-loop-v1-gmail-design.md:282`）。门槛清单写了不存在的端口。
- 规则里的 `tool` 名必须与 `RuntimeToolDescriptor.name` 一致（`packages/runtime-pi/src/pi-runtime-adapter.ts:2238`，未知工具抛 `PI_UNKNOWN_TOOL`）；登记册加载时应校验工具名存在于当前工具清单，方案没写。
- 方案三.5“规则没变不重发”含糊：规则短列表放在最后一条用户消息里时，每轮本来就是新消息，“重发”与否只影响 token 不影响缓存；但如果“规则没变就不放进本轮消息”导致列表忽有忽无，要确认这是有意的。另外派生列表文字来自主人原话（§六“原话是消息连续子串”），它**不是** prompt-catalog 固定文字（I-78 的 trusted 清单），出口遮盖会当外来内容检查；规则参数里若出现主人点名的密码/验证码，会被遮掉，规则对模型不可读——方案没写与出口遮盖（ADR 0146/0148）的交互。属推测但机制上必然发生。

---

## 侧重检查

**我走的普通流程**（主人立一条规则 → 规则生效 → 拦下一次推送）：

1. 主人在网页说“金额小于 100 不要推送” → §六：模型翻译成规则数据 → 程序校验原话子串 → 确认卡 → 登记册追加。**整条路径方案没安排任何测试**（schema 校验、原话子串校验、确认卡 UI 都无覆盖计划）。
2. 登记册派生短列表 → 下一轮进最后一条用户消息 `<himawari-context>`。有既存检查可用：`npm run check:prompt-prefix`（`.claude/rules/prompt-prefix.md:74`）及其反向用例——但方案没点名要把“规则列表”纳入这条检查的夹具。
3. 模型调用推送工具 → tool_call 钩子 → `rules.decide` → 拒绝/延后/先问我。钩子本身不改请求，不违反第 4 条；guide:161 要求“第一次在 tool_call 里改参数的改动要补测试”——本方案不改参数只 block，可豁免，但 block 分支的行为测试方案没写。
4. 延后队列 → 到点 executeTool 重放。**无测试、无持久化设计**（问题 1）。
5. 系统发起的推送 → executeTool 入口 → decide。**无反向集成检查**（问题 2），且五类来源中有两类方案根本没列（问题 6）。

**测试覆盖结论**：方案全文只有两道检查（规则例子加载、3c import 门槛），没有一道反向用例，没有写进 `npm run check` 的哪一步——按本仓库标准（每个事故落门槛、ADR 0107、`.claude/rules/incident-gates.md`）这不算落了门槛。

**文档一致性**：除 P8 不完整和“加 ASK”表述错误外，其余引用属实；方案没有列Pi 官方文档里对它不利的两句（invalid arguments skip tool_call；gate 应 fail closed）。

---

## 如果由我来定，我会这样改这份方案

1. **把唯一闸从“工具执行入口”下移到“出站端口实现”**：`WebPushSenderPort` 等出站端口的实现（`packages/platform-node/src/web-push-sender.ts`）在发送前调 `rules.decide`，拒绝/延后/先问都在这一层落库（决策记录 + outbox）。这样五类来源天然全过闸，**不需要把邮件判断、记忆捕获、web-push 全部重构为 executeTool**；模型路径的 tool_call 钩子保留为“提前拦截、给模型反馈”的优化层而非安全层。3c 的 import 门槛正好和这个结构配套：“不得绕过端口直接发送”。
2. **延后复用现有 outbox/quietUntil 机制**（SQLite、sourceKey 幂等、重启恢复），不新建队列；重放前重过参数 schema 校验和 decide。
3. **第一批规则词汇只收程序事实**（kind、发件人域、时间、发起方），金额等模型填的值等它的产生端 schema 和校验链设计好再收。
4. **写明与三套既有确定性规则的接管/共存关系**，并给出规则不可触碰清单（审批通知、遮盖、沙箱）。
5. **补门槛清单**：全来源拒绝/放行反向集成测试、加载失败 fail-closed、登记册工具名校验、`check:prompt-prefix` 夹具纳入规则列表，各写明进 `npm run check` 的哪一步。

## 必答问题逐条回答

1. **会不会改变已见过的请求开头？** 设计意图上不会：tool_call 钩子不发请求；规则短列表放最后一条用户消息（会变的值在最后一条，符合第一节第 2 条）；延后重放不经模型。两个保留项：新增推送工具会使工具集合变化、按第 6/7 条换新一次并留记录（方案已自认）；规则列表要纳入 `check:prompt-prefix` 夹具验证“只追加”且排序固定。结论：**不违反，但方案没有把既有自动检查接进来**。
2. **同一段文字会不会变字节？** 规则列表“按工具分组、排序固定、不含时间”满足第 10 条；decide 用的时间/时区只进程序不发模型。未覆盖点：列表含主人原话/参数时会过出口遮盖，遮盖结果依值而定（仍是确定性的，不违反第 11 条），但可能把规则参数遮得不可读——需写明。**结论：基本满足，遮盖交互未写。**
3. **有没有对应的自动检查、反向用例会不会真的失败？** 现方案只有例子加载和 3c 两道，**都没有反向用例，3c 抓不住模块内直调**；必须补“全来源拒绝/放行”行为测试和门槛反向夹具，否则按本仓库定义不算门槛。**结论：不够。**
4. **每个值的两端核对了吗？** 没有核对到位：`amount/category` 无产生端（需新 schema + 校验链，I-73 同型）；`ASK` 已存在、方案表述错、decide 与 D2 preflight 的双重判断无答案；规则 `tool` 名对 `RuntimeToolDescriptor.name` 无校验；延后队列的 sourceKey/持久化无设计；3c 引用了不存在的“Gmail 发送”端口；P8 漏了两类来源。**结论：Q4 是这份方案最薄弱的一问。**

未核实：`.agents/reviews/topic-hard-rules-architecture/` 的 v1/v2 轮次记录（本检出按规则隐藏了该目录）；生产配置 `/etc/himawari/config.json` 的实际规则相关设置。
