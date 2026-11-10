## 结论

方案方向（把对外动作收口到一个执行入口）是对的，但当前版本不能直接实施：`tool_call` 的 ASK/DEFER 与 D2/D3 的审批机制冲突；规则依赖模型填的参数，且“缺失即放行”“规则加载失败不生效”都是 fail-open；非模型出口清单不完整；决策记录和契约消费端没有接。下面按严重度列。

## 已证实的问题

### P0-1 `tool_call` 里做“先问我”和“延后”，与“审批保留在 execute”直接冲突

**问题**：方案 3a 说模型发起的调用在 Pi `tool_call` 里调 `rules.decide`，`先问我` 交给现有审批路径，`延后` 由程序排队重放；P5 又说审批保留在工具 `execute` 里。两者不能同时成立：`tool_call` 一旦 `block`，工具的 `execute` 根本不会运行，D2 的审批和 D3 的续跑也就不会发生；如果 `tool_call` 不 block，`rules.decide` 的 ASK 就没有执行。

**证据**：
- `docs/pi-development-guide.md:159`：“这个钩子只能当场决定或当场等。要等人批准几个小时、服务中途可能重启的情况，官方没有可靠写法，见偏离 D2。”
- `docs/pi-development-guide.md:161`：“顺序：`tool_call` 先于工具的 `execute` 运行。”
- `packages/runtime-pi/src/pi-runtime-adapter.ts:2037-2050`：`execute` 里先调 `tools.preflight`，不允许就返回 blocked；`:2084-2090` 才在 `execute` 里处理 `awaiting_approval` 并挂起。
- `docs/adr/0204-*.md:47-49`：D2/D3 批准保留的理由正是审批要等几小时、要跨重启；D5 的插消息/续跑另出方案。

**建议**：把职责拆开，不要让 `tool_call` 承担 ASK/DEFER。
- `tool_call` 只做“直接拒绝”的快速失败（P3 原文也只授权“直接拒绝、不需要等人”的规则）。
- ASK 放在 `execute`/`preflight` 的权威入口里，复用 `ActionPolicyService` 的 approval、quota、expiry、`uiAvailable` 逻辑；规则引擎只向它提供一个“只能收紧、不能放宽”的事实。
- 如果坚持由 `tool_call` 处理 ASK，就必须新增一套 durable 的 tool_call 级挂起/恢复协议，并把 D2/D3 的偏离表、ADR、测试一起改；这不是当前方案能顺手带上的。

### P0-2 “金额缺失 → 放行”和“规则加载失败不生效”都是 fail-open

**问题**：方案 3.2 明确写“金额缺失 → 放行”，并把规则依赖模型填的 `amount/category/sender` 列为风险，但没有给出解法。更严重的是 3.1 写“加载时跑 match/not_match 例子，不过不生效”：一条拒绝规则校验失败就静默消失，动作反而被放行。这违反产品原则和 Pi 官方对 gate 的要求。

**证据**：
- `docs/product-vision.md:58`：“不确定意图、权限或记忆可靠性时，默认更保守。”
- `packages/application/src/services/action-policy-service.ts:169-174`：代码明确拒绝“模型提供的风险降低确定性风险下限”（`Model-provided risk cannot lower the deterministic risk floor`）。方案却让模型填的金额决定硬规则，方向相反。
- Pi 官方文档 `https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/extensions.md`：“gate handlers should fail closed when their safety decision cannot be made.”
- 方案 3.1 原文：“不过不生效。”

**建议**：
- 规则使用的金额、类别、发件人等，必须来自服务端可信事实（已落库的 intent、邮件解析结果、分类器、授权记录），不能直接信模型参数；模型参数只能作为“候选值”，与权威值不一致时拒绝或先问。
- 缺失、类型不对、NaN/Infinity、负数、货币单位不明，一律 DENY 或 ASK，不写“缺失 → 放行”。
- 规则加载失败、注册表不可用、`decide` 抛错、时钟/数据库失败，一律 fail-closed：相关工具不可用或启动失败，不能静默跳过规则。
- 金额用整数最小货币单位，并显式带币种；不要用浮点比较。

### P1-3 非模型出口清单不完整，“executeTool 唯一入口”目前不存在

**问题**：方案 3b 只列了“提醒到期、审批通知、运行完成通知”，但 `ProductionWebPush.#collect` 还产出 `proactive:`（邮件主动提醒）和 `muse-channel:`（Muse 通道中断）；`sendTest` 也是直接调用发送端口。仓库里也没有一个统一的 `executeTool(name, params, initiator)` 入口，现有工具是不同类、不同方法签名（`ProductionReminderTools.run`、`ProductionWebPush`、`ProductionMemoryRecall` 等），要做成“唯一真正的闸”需要新建注册表和网关。

**证据**：
- `apps/agent-service/src/production-web-push.ts:358-379`：`proactive` 和 `museOutages` 也进入推送队列。
- `apps/agent-service/src/production-web-push.ts:251-267`：`sendTest` 直接调 `sender.send`。
- `apps/agent-service/src/production-web-push-control.ts:119`：控制面调用 `push.sendTest`。
- `apps/agent-service/src/production-web-push.ts:560-608`：发送失败有重试，重试也是出口。
- `apps/agent-service/src/production-runtime-tools.ts:391-554` 和 `apps/agent-service/src/production-reminder-writer.ts:333-399`：工具是描述符 + 不同实现，没有统一的 `executeTool`。

**建议**：
- 在 application 层建一个 `OutboundActionGateway`（或 `ToolExecutionGateway`），统一做：参数校验、可信事实解析、`rules.decide`、`ActionPolicyService`、审批、幂等、执行、决策记录。
- 把 `sendTest`、`proactive`、`muse-channel`、重试、审批通知、运行通知全部列进清单并逐一迁移；不要只改 `#deliver`。
- 明确系统关键通知（审批待办、失败、健康告警）的 floor：不能被静默时段或“少推送”规则延后到审批过期。

### P1-4 决策记录没有接；新的 outcome/kind 不能通过现有契约

**问题**：ADR 0163 要求“每次因为某条硬偏好而提醒或不提醒，这次判断写进决策记录”；ADR 0143 的 `decision_ledger` 只有 6 种 kind，非 proactive 的 outcome 是固定枚举，没有 `allow/deny/defer/ask`，也没有 “tool_gate” 这种 kind。方案只说了给模型一句话，没有说规则 id、修订号、结果写到哪里、怎么读、怎么导出、怎么评分。

**证据**：
- `docs/adr/0163-*.md:40`：“每次因为某条硬偏好而提醒或不提醒，这次判断写进决策记录。”
- `docs/adr/0143-*.md:37-39`：kind/outcome 的固定约束；`:39` “规则编号目前只用于被规则丢弃的候选（写丢弃原因），规则手册落地后再接。”
- `packages/application/src/ports/decision-ledger.ts:29-50`：`DECISION_KINDS` / `DECISION_OUTCOMES` 没有 tool gate 结果。
- `packages/persistence-sqlite/src/migrations/0069_decision_ledger.sql:5-19,48-55`：SQL CHECK 会拒绝新 outcome；`reason_code` 只有 1–64 字符（`packages/persistence-sqlite/src/sqlite-decision-ledger-operations.ts:57`）。
- I-73 的教训：`docs/incidents-and-gates.md` 第 112 行“双模型复核只看了 diff，没问‘清单里的 id 能通过后端校验吗’”。

**建议**：
- 新增 `tool_gate` kind（或明确复用 proactive 并新增 verdict），outcome 定义为 `allow/deny/defer/ask`；迁移、`DECISION_KINDS`、`DECISION_OUTCOMES`、SQLite CHECK、校准、UI、导出、清空逻辑一起改。
- 规则 id、修订号写 `inputs.ruleIds`，完整理由写加密 `reasonRef`；`reason_code` 用稳定的短码（如 `rule_denied`），不要塞自由文本。
- 加一个 I-73 式契约测试：注册表产生的每个规则 id、每个 outcome 必须通过 decision ledger、Gateway 契约、UI/导出三层校验；去掉任何一层的修复，测试必须失败。

### P1-5 “规则词汇 = 工具参数”覆盖不了现有硬规则

**问题**：方案的规则结构只能表达“工具参数里的值 + 当前时间/时区/发起方”。但仓库里已有的硬规则还包括每日费用上限、连续忽略降频、静默时段、敏感分类、记忆写入门槛等；这些需要历史计数、累计费用、数据分类、审批状态，单靠工具参数表达不了。方案却宣称“全系统只有一个检查函数”，容易让人误以为可以替换现有硬规则。

**证据**：
- `docs/agent-rulebook-inventory.md:76-83`：H-8 静默时段、H-9 每日费用上限、H-11 连续忽略降频、H-12 敏感记忆审批、H-13 置信度门槛。
- `packages/application/src/services/proactive-rules.ts:200-229`：`quietUntil` 依赖时区、跨午夜、星期、历史时间；不是工具参数。
- 方案第三节原则：“硬规则只描述‘哪个工具、参数里哪个值、满足什么条件、结果是什么’。”

**建议**：
- 把范围说清楚：这个引擎只承载“新的、简单的、按工具参数判断的规则”；现有 Gmail floor、记忆门槛、审批、沙箱、出口遮盖继续做强制后置检查，规则引擎只能在其上收紧，不能替代。
- 如果确实要统一，先扩展 `facts`：加入服务端可信的 `dataClassification`、`costSpentToday`、`pushCountInWindow`、`backoffState`、`approvalStatus`、`sourceProvenance`，并定义它们的来源、刷新时机和失败语义。

### P2-6 直接 import / 调用发送端口的自动检查，既会误报也会漏报

**问题**：方案 3c 说“工具实现之外的代码直接 import / 调用发送类端口就让 `npm run check` 失败”。但 `production-web-push.ts` 只是 `import type { WebPushSenderPort }`，真正的发送是 `this.#options.sender.send`（注入依赖），静态 import 检查要么把类型导入误报，要么抓不到属性调用；组合根 `service-main.ts` 又必须 import 并构造 sender，不能一刀切禁止。

**证据**：
- `apps/agent-service/src/production-web-push.ts:12`：`import type { WebPushSenderPort }`。
- `apps/agent-service/src/production-web-push.ts:157`：`readonly sender: WebPushSenderPort`；`:252,571`：`this.#options.sender.send(...)`。
- `apps/agent-service/src/service-main.ts:43,1743`：组合根 import 并 `createWebPushSender`。
- `apps/agent-service/src/production-web-push-control.ts:119`：通过 `push.sendTest` 间接发送。

**建议**：
- 用依赖图/ESLint 限制“除组合根和 gateway 外不得 import 发送实现”，同时用运行时集成测试覆盖所有发送路径，而不是只扫 import。
- 更强的做法：不导出 `WebPushSenderPort` 给业务层，只导出 `OutboundActionGateway`；sender 作为 gateway 内部实现，组合根只注入 gateway。
- 必须有反向用例：在测试夹具里直接调用 sender / 直接 import 发送模块，检查必须失败；动态 `import()`、re-export 也要覆盖。

### P2-7 请求开头与字节确定性：方案没有给出足够约束

**问题**：新增推送工具、或给现有工具加 `category/amount/sender` 参数，会改工具定义，按 ADR 0165 会让已有对话换新一次；这一点方案在“待审风险”里提到，但没有写换新的触发点、记录方式和只在新运行开始时判断。规则列表放“最后一条用户消息”也有歧义：如果是改写已经发过的最后一条消息，就违反 append-only；如果是追加，必须说明存的是实际发出去的那一条。

**证据**：
- `.claude/rules/prompt-prefix.md:35`：“存历史时存实际发出去的那一条。”
- `.claude/rules/prompt-prefix.md:41-44`：系统提示和工具按对话冻结；工具集合或参数结构变化换新一次。
- `docs/adr/0165-*.md:66-69`：“同名工具的参数结构变了也换新。”
- `.claude/rules/prompt-prefix.md:51-54`：遮盖必须确定，且可能依赖前面的内容。
- `packages/prompt-catalog/src/trusted.ts:10-14`：只有 prompt catalog 里的固定文字享受 trusted 豁免；动态生成的规则列表不在其中，可能被出口遮盖按上下文改动。

**建议**：
- 明确“规则列表”是追加一条新的用户/自定义消息，还是只拼在当前轮最后一条用户消息上；无论哪种，都要保证下一轮历史里存的是实际发出去的字节，且不回写旧消息。
- 规则列表只由稳定规则数据生成：固定排序、固定键序、固定 tie-break；不含当前时间、相对时间、未排序集合。
- 动态规则文字要么走 trusted 豁免（但不能包含秘密/敏感数字），要么确保出口遮盖不会因上下文改变同一段文字；否则同一段规则文字在不同请求里会变成不同字节。
- 推送工具最好只加一次，或者做成一个稳定的通用对外动作工具；以后新增规则事实不要再改工具 schema。

### P2-8 延后队列的资源、幂等和不可逆操作没有设计

**问题**：方案承认“延后要程序排队重放，重放时参数和上下文可能过期”，但没有定义队列上限、去重、过期、取消、幂等键和“重放是否重新审批”。如果延后的是发邮件、外部写、付款这类不可逆动作，几小时后自动执行原参数是危险的；模型重试还会生成多条。

**证据**：
- `apps/agent-service/src/production-web-push.ts:24,397-428,560-608`：现有推送有重试延迟、sourceKey、outbox 去重和过期；方案没有说明延后队列如何复用这些机制。
- 方案“待审的风险”第一条原文：“延后：tool_call 只能当场 block，延后要程序排队重放，重放时参数和上下文可能过期。”

**建议**：
- 延后不是“重放原工具调用”，而是落一条 durable `PendingAction`：不可变 intent、幂等键、来源、规则 id、过期时间、最大重试次数、队列上限。
- 到点后重新走完整网关：当前规则、ActionPolicyService、审批、预算、过期检查；不可逆动作重新让主人确认，不能静默执行。
- 同一 intent 指纹去重；模型重试只更新/复用同一条；超过上限拒绝并记决策记录。

### P2-9 规则登记册本身的存储、加密、分类、导出/删除没有设计

**问题**：规则可能包含金额、收件人、时间、个人条件等敏感信息。方案只说“登记册沿用 v2”，没有说存在哪、是否加密、数据分类、谁能读、如何导出/删除、修订历史如何审计。`rules.decide` 的签名也没有 `ownerId/agentId/threadId`，无法保证规则按主人/代理/对话隔离。

**证据**：
- `docs/adr/0163-*.md:44`：“参照 ADR 0122 对账户设置的做法：存在服务器上、带版本号。”
- 产品愿景 `docs/product-vision.md:107`：规则要“拿得走、测得了、说得清”。
- 方案原则：“全系统只有一个检查函数 `rules.decide(工具名, 参数, 环境事实)`。”

**建议**：
- 规则登记册按 owner/agent 作用域存储，带修订号、只追加历史、加密、数据分类、导出/删除和审计。
- `rules.decide` 的入参加上 `ownerId`、`agentId`、`threadId`（或 scope 对象）；规则集合在运行开始时 pin 住，运行中途不换，避免同一轮前后判断不一致。
- 给模型的规则列表和拒绝理由也要过数据分类上限；不要把敏感规则原文直接塞进 tool result。

### P3-10 自动检查不足，反向用例没有证明“去掉保护会失败”

**问题**：方案只有“每条规则自带 match/not_match 例子，加载时跑”和 import 门槛；这些不是实现的反向用例。规则作者可以写出错误例子；边界例子由程序补，但比较符、时区/DST、货币、Unicode、缺失值、类型强转、`in` 集合顺序都没有覆盖。也没有测试证明 `tool_call` 的 DENY 真的跳过 `execute`、ASK 真的创建审批、系统路径真的都走 gateway。

**证据**：
- 方案 3.1 原文：“每条自带 match / not_match 例子，加载时跑，不过不生效；程序按比较符自动补边界例子。”
- I-73 的门槛做法：`docs/incidents-and-gates.md` 第 112 行要求“清单生成出的每个引用都要过两个包的校验……去掉修复后 3 条失败”。

**建议**：
- 列清楚测试文件和用例名：`check:prompt-prefix` 增加规则列表/新工具场景；`check:tool-gate` 覆盖比较符、缺失值、失败关闭、幂等、延后、ASK；`check:rule-contract` 覆盖 rule id/outcome 到 ledger/gateway/UI。
- 每条关键保护都要有“去掉这段保护，测试必须失败”的 mutation 验证；规则自带的例子不能替代类型级测试。
- 用现有的 `quietUntil` 处理时区/跨午夜；金额用最小货币单位整数；字符串比较定义大小写、Unicode 归一化和大小写敏感性。

## 推测 / 未核实

- **未核实 v1/v2 方案原文**：`.agents/reviews/topic-hard-rules-architecture/` 在当前 sparse checkout 中读不到（glob 无文件），所以“沿用 v2”的登记册细节没有核对。
- **未核实 Pi `block.reason` 是否真的进入模型可见的工具结果**：官方文档只写 `{ block: true, reason?: string }`，并说 blocked call 会有 error result；但 `reason` 的最终呈现需要在锁定的 1.5.0 源码/测试里确认。方案“reason 给模型”目前是依据不足的。
- **未核实 Gmail 发送出口**：仓库只找到 Gmail 读取/主动检查，没有找到 Gmail 发送端口；方案里的“发邮件”可能是未来场景。若现在没有发送出口，这条例子不能作为已验证前提。
- **未核实 1.5.0 与 main 的差异**：我用的是 main 的 Pi 文档；`ctx.executeTool` 和 tool_call 的行为在锁定 1.5.0 上需按 `pi-development-guide.md` 的方法再对一遍。

## 侧重检查

- **错误路径/不可信输入**：查了工具参数入口 `production-runtime-tools.ts:729-793`、`production-reminder-writer.ts:346-399`，以及 Pi 官方“invalid arguments skip tool_call”。结论：参数缺失、类型错、模型撒谎、未知工具必须 fail-closed；方案当前是 fail-open。
- **安全**：查了 `ActionPolicyService` 的风险下限（`action-policy-service.ts:169-174`）、WebPush 对 sensitive/restricted 提醒的隐藏（`production-web-push.ts:486-490`）、审批挂起路径（`pi-runtime-adapter.ts:2037-2090`）。结论：新规则层只能是附加收紧，不能替代现有安全不变量；ASK 不能放在会阻断 execute 的 `tool_call` 里。
- **资源耗尽**：查了推送重试/outbox（`production-web-push.ts:24,397-428,560-608`）和延后方案。结论：延后队列必须有上限、TTL、去重、最大重试；否则模型重试可堆积。
- **不可撤销操作**：查了发送、提醒写记忆、外部写操作的现有路径。结论：延后重放不可逆动作必须重新审批；不能把“几小时后自动执行原参数”当作普通队列。
- **规则/文档/代码一致**：查了 `product-vision.md:58-59`、ADR 0163/0143/0165/0204、`pi-development-guide.md`、`agent-rulebook-inventory.md`。结论：方案漏了决策记录、现有硬规则、系统关键通知，且 P7/P8 的描述不完整（P7 是模型调用，不是出口；P8 还包括 proactive 和 muse）。

## 如果由我来定，我会怎样改

1. **缩小宣称范围**：这个引擎只做“新的、简单的、基于可信事实的对外动作硬规则”；现有 Gmail floor、记忆门槛、审批、沙箱、出口遮盖保留为强制后置检查，规则引擎只能收紧。
2. **建一个 application 层 `OutboundActionGateway`**：所有模型和系统发起的对外动作都走它；统一做参数校验、可信事实解析、`rules.decide`、`ActionPolicyService`、审批、幂等、执行、决策记录。Pi 的 `tool_call` 只做 DENY 快速失败，不作为 ASK/DEFER 的权威路径。
3. **规则事实服务端化**：金额、币种、类别、发件人、数据分类、历史计数、预算来自服务端记录；模型参数只当候选。缺失/非法/规则不可用一律 DENY/ASK。
4. **ASK 放回 execute/preflight**：用现有 `ActionPolicyService` 的 approval/quota/expiry/UI 逻辑；规则 ASK 作为只能提高严格度的确定性事实。这样不会和 D2/D3 冲突。
5. **DEFER 用 durable PendingAction**：幂等键、TTL、上限、去重、重新过完整网关；不可逆动作重新确认；系统通知则重排 outbox，不新建工具调用。
6. **登记册按 owner/agent 作用域、加密、带修订、只追加、可导出/删除**；运行开始 pin 住规则集合，中途不换。
7. **工具 schema 稳定**：推送类动作最好只加一次，或用一个稳定的通用对外动作工具；规则列表只追加新消息，固定排序/键序，不含当前时间，动态文字处理出口遮盖。
8. **补测试和 ADR**：`check:prompt-prefix`、`check:tool-gate`、`check:rule-contract`；反向/mutation 用例；新增 ADR，更新 `pi-development-guide.md` 的偏离表（D2/D3 与 tool_call 的关系）和 `agent-rulebook-inventory.md`。

## 必答问题

**1. 会不会改变模型已经见过的请求开头？是不是仍然只在末尾追加，每轮会变的值是不是都在最后一条消息里？**

会。新增推送工具或修改现有工具参数结构，会改变请求最前面的工具定义，按 [ADR 0165](docs/adr/0165-freeze-the-request-head-per-conversation.md#decision) 第 2 条和 [prompt-prefix](.claude/rules/prompt-prefix.md#stable) 第 6、7 条，已有对话要换新一次，并且只在运行开始时判断、留记录。系统提示和历史不应改；规则列表必须作为新消息追加，不能回写已经发过的最后一条用户消息；每轮变化的当前时间等只能放在最后一条消息。方案目前只说“放最后一条用户消息”，没有写“存实际发出去的那一条”（[prompt-prefix](.claude/rules/prompt-prefix.md#append-only) 第 5 条），所以还不能保证只在末尾追加。按现在写法：工具变化会改开头一次；规则列表如果实现成追加则合规，如果实现成改写最后一条已发消息则不合规。

**2. 会不会让同一段文字在不同请求里变成不同的字节？**

会，至少有四个风险：规则列表从对象/集合派生时顺序不稳定；多条规则同 severity 时 tie-break 未定义；动态规则文字不在 `packages/prompt-catalog` 的 trusted 清单里，出口遮盖可能随前文秘密不同而改字节（[prompt-prefix](.claude/rules/prompt-prefix.md#deterministic) 第 10、11 条）；延后理由如果带相对时间，每次请求都会变。必须固定 JSON 键序/数组序/tie-break，规则集合按运行 pin 住，规则文字要么 trusted 且不含敏感数字，要么保证遮盖确定，规则列表不含当前时间。否则同一段文字确实可能每次不同。

**3. 有没有对应的自动检查，反向用例是否真的会失败？**

不够。方案只有“规则自带 match/not_match 例子”和 import 门槛；前者是规则作者自带的样例，不是实现的反向测试，后者抓不到注入的 sender，也会误报 type-only import。缺少：`tool_call` DENY 是否真的跳过 execute、ASK 是否真的创建且只创建一个审批、系统路径（sendTest/proactive/muse/审批/运行通知/重试）是否都走网关、延后重放是否幂等/过期/重新审批、规则 id/outcome 是否能通过 ledger/gateway/UI。每条关键保护都要有“去掉它，测试必须失败”的 mutation 证明，不能只靠正向样例。

**4. 每个新值（标识、字段、配置键、清单项、序列化格式）的每个使用方都能接受吗？**

不能。规则 id、修订号、outcome 至少要过三组消费端：`decision_ledger` 的 kind/outcome/reason_code 约束（`packages/persistence-sqlite/src/migrations/0069_decision_ledger.sql:5-19,48-55`、`sqlite-decision-ledger-operations.ts:49-63`）；Gateway 契约里的 `machineString`（`packages/gateway-contracts/src/validation.ts:49-60`，I-73 的 `/` 事故就是前车之鉴）；UI/导出/校准对 kind/outcome 的读取。方案只检查了“给模型的一句话”，没有把产生规则 id/outcome 的地方和这些消费端连起来。按 I-73 的要求，必须有一个契约测试遍历登记册产生的每个 id、每个 outcome，并证明去掉修复后会失败。
