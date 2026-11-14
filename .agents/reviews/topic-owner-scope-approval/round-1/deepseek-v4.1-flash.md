## 0. 结论先说

建议把这件事做成**三件互相独立的机制**，而不是给提醒、规则、设备各写一段分支：

1. **动作清单**：每个工具/能力在代码里登记一条 `capability.v2` 清单、风险类别、副作用、是否可逆、结果来源可信度。执行端对清单之外的能力一律拒绝。
2. **上下文可信度**：工具结果带“来源可信度”元数据，按**当前模型可见上下文**计算“这一轮/这个对话里是否读过不可信内容”，并把结果冻结进动作意图的确定性事实里。它不进入提示词。
3. **唯一动作入口**：所有工具（包括只读）都经过同一个动作入口；有后果的动作由规则手册的动作闸门先做常规预授权，再交给现有 `ActionPolicyService`，需要时走现有 durable 审批。后台运行在“读过不可信内容 + 有后果”时只生成提议，不生成挂起审批。

这样，干净会话里的“明天 9 点提醒我开会”仍然直接建；读过网页后再建提醒会问一次；后台读到网页后想建提醒只留下提议。

---

## 1. 方案依赖的前提（读代码/来源证实）

| # | 前提 | 来源与原话 |
|---|---|---|
| P1 | 模型请求只能末尾追加；每轮变化的值只能放最后一条用户消息 | `.claude/rules/prompt-prefix.md:27-28`：“固定的在前，会变的在后”“每轮都会变的内容只放在最后一条用户消息里”；`:35`：“已经发给过模型的内容，不得改动、重排或删除，只能在末尾追加” |
| P2 | 系统提示和工具定义按对话冻结 | `.claude/rules/prompt-prefix.md:41`：“系统提示和工具按对话冻结” |
| P3 | 常规判断应由规则手册预先授权，不逐次确认 | `docs/product-vision.md:58`：“常规判断应由规则手册预先授权，不逐次确认” |
| P4 | 规则是硬性设定，必须有回归测试 | `docs/product-vision.md:59`：“规则本身写进程序、必定执行，每条都有回归测试守着” |
| P5 | 受治理工具现在的统一写法是：组 `GovernedActionIntent` → `authorize` → 非 ALLOW 统一返回 | `apps/agent-service/src/production-coding-workflow.ts:294-411`；`packages/application/src/services/runtime-tool-authorization.ts:3`：“Every governed tool uses the same suspension contract; no model result on ASK.” |
| P6 | “主人范围”的提醒、规则、记忆工具现在不过权限引擎 | `apps/agent-service/src/production-runtime-tools.ts:759-794`（preflight 只查 `#exposed` 和服务是否存在）；`:1116-1118` 直接转给 `#recall/#reminder/#ownerRule`；`:673-741` 的 `#ownerScoped` 没有动作意图和 `authorize` |
| P7 | 权限引擎要求能力已登记，且版本、操作、数据范围匹配 | `packages/application/src/services/action-policy-service.ts:531-544`：“capability_not_registered”“capability_version_mismatch”“operation_not_declared”；能力清单结构见 `packages/application/src/ports/capabilities.ts:117-139` |
| P8 | 已有“主人事先同意过的长期授权”模式：条件满足时替主人建一条已同意的一次性审批和授权 | `apps/agent-service/src/production-file-read-services.ts:303-312`；`apps/agent-service/src/owner-policy-authorization.ts:36-73`。但长期 Grant 只允许安全只读：`packages/application/src/services/grant-service.ts:71-81` |
| P9 | 一轮是谁发起的有持久记录，取值只有三种 | `packages/application/src/ports/run-execution-source.ts:26`：“sourceType: "user_message" \| "schedule" \| "external_event"”；数据库约束见 `packages/persistence-sqlite/src/migrations/0001_initial_product_schema.sql:133` |
| P10 | 现在的数据分级不是“来源可信度”；联网结果只在一处标了不可信网页 | `packages/runtime-pi/src/pi-runtime-adapter.ts:2235-2236` 只做 `#raiseVisible`；`apps/agent-service/src/web-tool-run.ts:82`：“contentKind: "untrusted_page_markdown"” |
| P11 | 规则手册目前只有邮件闸门，动作闸门还没做 | `packages/application/src/rules/field-catalog.ts:9`：“RULE_GATES = ["mail_item", "mail_delivery"]”；`docs/adr/0209-rule-book-with-cel-expressions-and-judge.md:104`：“第 3 步动作闸门” |
| P12 | 设备设计已经要求“读过其他来源后”拦截有后果动作，并有设备动作登记表 | `docs/execution/specs/2026-11-11-apple-device-body-design.md:364-371`、`:518-532`、`:739` |
| P13 | Pi 的工具批次里只要有一个 sequential 工具，整批按顺序执行；并行批次全是非 sequential | `packages/runtime-pi/src/pi-tool-batch-continuation.ts:74-82`：“every ... executionMode !== "sequential"”；`:120-122` 用 `waitingIndex` 校验已完成结果数 |
| P14 | 审批快照已经暴露 `deterministicFactCodes`，所以“为什么问你”可以先复用现有合同 | `packages/gateway-contracts/src/contracts-v2.ts:2257`：“deterministicFactCodes: array(machineString)”；`packages/application/src/services/governance-gateway-adapter.ts:400` |
| P15 | I-73 的教训是：双模型复核只看了改动，没核对清单里的值能否通过后端校验 | `docs/incidents-and-gates.md:112`：“双模型复核只看了 diff，没问「清单里的 id 能通过后端校验吗」” |
| P16 | 现有审批可以持久等待、重启后恢复 | `docs/adr/0023-durable-hitl-execution.md:18-20`：“审批等待不以存活进程、浏览器连接或内存 Promise 为前提” |

---

## 2. 完整方案（提议）

### 2.1 数据怎么登记：一个动作清单，而不是每个工具一段代码

新增 `ProductActionCatalog`，每条登记：

- `capabilityRef`、`capabilityVersion`、`operations`
- `capability.v2` 清单：来源类型、`dataClassifications`、健康状态、运行时类型
- `actionKind`、`sideEffect`、`reversible`
- `consequence: boolean`（只读且有副作用的区分）
- `resultProvenance`：这个工具的结果是 `trusted`、`untrusted`，还是按结果/参数动态判断
- `sourceKind`：网页、短信、屏幕、旁人说话、外部 MCP、下载文件、模型派生等
- 在规则手册动作闸门中的默认规则/例子

设备动作和感知读取不另写分支：`device_action` 的具体动作由设备设计里的“动作登记表”提供类别、风险、是否要本人在场；`perception_read` 按每条记录的 `owner_spoken/other` 动态给可信度。新增设备动作只加登记行，不改执行代码。

内置工具的能力清单建议放在**代码里的清单**，由组合型 `CapabilityAuthorizationFactsPort` 先查数据库里的安装型能力、再查内置清单。这样不用把提醒/规则伪造成需要部署快照和资格认证的可安装能力；两边仍用同一个 `capability.v2` 合同，`ActionPolicyService.capabilityDenial` 的校验不用放松。

### 2.2 事实怎么记录、怎么持久化

在 `GovernedActionIntent.deterministicFacts` 中增加**由动作入口统一追加**的事实，工具本身不用自己拼：

- 恰好一条 `run_source_user_message` / `run_source_schedule` / `run_source_external_event`（`source: "runtime"`，`minimumRisk: "LOW"`）
- 若当前模型可见上下文含不可信内容：`untrusted_content_in_context`
- 每个来源：`untrusted_source_web`、`untrusted_source_message`、`untrusted_source_screen` 等

事实代码登记在 `POLICY_FACT_CATALOG` 里，`validateGovernedActionIntent` 拒绝清单外的代码，并要求 source 类事实恰好一条、排序去重。这样事实是类型化数据，不是散落在各工具里的字符串。

**可信度不放进模型文本**。工具结果增加一个非模型可见的 `contentProvenance` 字段（`RuntimeToolSettledResult`），由运行时适配器在 `tool_result` 捕获时写进产品侧投影，不写进 Pi 的原生消息字节。上下文投影按当前可见的历史、工具结果和派生回答计算可信度：

- `owner_direct`：主人打字/口头指令、主人在界面上编辑的内容 → 可信
- `owner_internal`：提醒列表、规则列表、确定性产品状态 → 可信
- `external_untrusted`：网页、搜索摘要、邮件/短信正文、屏幕文字、剪贴板、旁人说话、外部 MCP、下载文件 → 不可信
- `derived`：模型对上述内容的总结、派生回答 → 取输入的最低可信度

持久化方式：在 runtime projection 旁存来源/可信度（新表或现有投影记录的扩展字段），不在 Pi 原生历史里加字节。模型在后续轮次仍能看到那段文字，所以**可信度按当前模型可见上下文算，而不是只按当前 run 算**；一段网页被压缩掉且没有派生副本留下时，标记才会消失；如果压缩摘要来自不可信内容，摘要本身继承不可信。

审批可能等几个小时，所以**动作意图里的事实一旦生成就冻结**，恢复时读冻结值，不重新按当前上下文算；否则上下文变了会导致审批哈希不匹配。现有 `actionIntentFingerprint` 会把新增事实纳入哈希（`packages/application/src/services/action-intent-snapshot.ts:28-39`）。

### 2.3 在哪一处判断

新增一个应用服务层/组合层的 `ActionAdmissionGate`，所有工具的 `execute` 都先经过它：

1. 查动作清单；没有登记 → 失败关闭，不调用任何执行器。
2. 从持久化的 run source 和 context trust 追加事实，得到冻结后的意图。
3. 调 `OwnerActionAuthorization`（规则手册动作闸门）：只对“常规、可逆、中风险”的动作按规则预授权，调用现有 `applyOwnerPolicyAuthorization` 建一次性授权。**读过不可信内容且不是低风险时，这里不再预授权。**
4. 调 `ActionPolicyService.evaluate`。策略引擎额外做两条硬规则：
   - `run_source != user_message && untrusted && consequence` → `DENY("untrusted_context_background_action")`，不建挂起审批；
   - `run_source == user_message && untrusted && consequence && finalRisk != LOW` → 不走 `automaticReview`，没有已有授权就 `ASK`。
5. 结果不是 ALLOW 时，统一返回现有 `runtimeToolAuthorizationResult`；ASK 继续走现有 durable 挂起/恢复。

这样“登记意图、过权限引擎、审批”只有一个出口；工具内部不再各自决定要不要问。`production-coding-workflow` 现有的 `authorize` 改为调用这个入口，`#ownerScoped` 和 `reminder/rule/memory` 改为先组意图再进这个入口。

### 2.4 主人看到什么

- **干净会话的常规动作**：和现在一样，直接执行，不出现确认卡。由规则手册动作闸门或等价的内置常规规则预授权。
- **读过不可信内容后的用户发起动作**：普通审批卡，增加一行“为什么问你”：从 `deterministicFactCodes` 里识别 `untrusted_content_in_context`/`untrusted_source_*`，显示“这一轮读过网页/短信/屏幕等外部内容，所以这次需要你确认”。不需要改审批合同的 schema，现有快照已经带事实代码；只在运行审批卡里补这一行和 i18n。
- **后台发起且读过不可信内容**：不产生挂起审批。生成一条**提议卡**：动作、目标、为什么（后台运行 + 读过外部内容）、“执行一次 / 忽略”。接受时用冻结的意图建一次性授权并启动新的用户发起运行；拒绝/过期写决策记录。同一意图指纹去重，避免后台反复刷提议。
- **审批等待/重启**：沿用 ADR 0023；事实冻结在审批快照里，恢复后仍按同一事实和同一授权执行一次。

### 2.5 怎样保证新工具不会漏

三层：

1. **运行时失败关闭**：`listAuthorized` 返回的每个 descriptor、`preflight`/`execute`收到的每个 capabilityRef 都必须能在动作清单找到；找不到直接错误，不落到默认分支。
2. **构建检查**：新增 `npm run check:action-catalog`，用覆盖所有配置组合的测试矩阵调用 `listAuthorized`，收集全部 capabilityRef（含 handle-bound、coding、web、task、device 动态操作），要求每个都有清单、可信度、结果来源、风险类别和审批理由映射；同时校验内置 `capability.v2` 清单能被权限引擎接受。
3. **反向测试**：故意从清单删一条、改一个能力版本、只改生产端不改变消费端、加一个未登记的 descriptor，检查或运行时必须失败。

---

## 3. “读过不可信内容”按一轮还是按对话上下文记

**建议按“当前模型可见上下文”记，而不是只按 run 记，也不是永久按 thread 记。**

理由：

- 上一轮网页还在历史里，模型下一轮仍会看到它；只按 run 记会漏掉跨轮注入。
- 永久按 thread 记会让读过一次网页的对话以后每次建提醒都问，违背“不要多点没必要的确认”。
- 正确做法是：每个内容条目带可信度，上下文投影计算“当前可见条目里有没有不可信来源”；压缩摘要继承最低可信度。这样网页还在就仍拦截，网页和派生摘要都离开上下文后才恢复干净。

来源可信度登记建议：

- **不可信**：网页/搜索、邮件和短信正文、屏幕文字、剪贴板、旁人说话、外部 MCP/远程 API、未知来源的下载文件、任何模型从上述内容生成的总结。
- **可信**：主人直接输入、主人在 UI 里的编辑、确定性产品状态（提醒/规则列表）、明确由主人编写且未被外部内容污染的记录。
- **需要 Andy 拍板**：本地工作区文件和主人上传的附件默认算可信还是不可信。建议默认“主人控制的本地文件可信；带 HTML/网页/下载来源标记的文件不可信”，但这会让“下载了 PDF 再改”的场景仍受保护。

避免过度确认的配套：

- 低风险动作在读过不可信内容后仍直接做；
- 同一动作的重复调用复用同一次授权，不重复问；
- 上下文里不可信内容真正消失后自动恢复；
- 可选的“可信来源清单”由主人显式设置（默认空），但界面要说明信任一个域名/目录的风险。

---

## 4. 和业界做法的一致与不同

**一致**

- Anthropic Claude Code auto mode：动作分档、只读/项目内编辑免分类器、分类器只看用户消息和工具调用、剥离工具结果作为主要注入防线。我们的对应做法是“动作清单 + 主机侧事实 + 策略引擎”，不把安全判断交给看完工具结果的模型。原文：“The classifier sees only user messages and the agent's tool calls; we strip out Claude's own messages and tool outputs”“stripping tool results is the primary prompt-injection defense”（https://anthropic.com/engineering/claude-code-auto-mode）。
- Claude Code permissions：只读不问、命令和改文件要问、可以“以后不再问”。我们保留只读自动放行、常规中风险由规则手册预授权、精确的同一动作授权复用（https://code.claude.com/docs/en/permissions）。
- Meta Agents Rule of Two：一个会话里“处理不可信输入 / 访问敏感数据 / 改状态或对外沟通”最多占两样；三样都要时至少需要人监督。我们的“不可信上下文 + 有后果动作 → 用户发起则确认、后台则只提议”就是这条规则的落地。原文：“must satisfy no more than two ... If an agent requires all three ... at a minimum requires supervision — via human-in-the-loop approval or another reliable means of validation”（https://ai.meta.com/blog/practical-ai-agent-security/）。
- CaMeL：给内容带来源/能力标记，在工具调用处按策略检查，不可信数据不能影响控制流。我们用上下文级可信度 + 动作意图事实，方向一致（https://arxiv.org/abs/2503.18813）。
- OpenAI：不要让不可信数据直接驱动 agent 行为；用结构化输出和确认限制数据流。原文：“Design workflows so untrusted data never directly drives agent behavior”（https://developers.openai.com/api/docs/guides/agent-builder-safety）。

**不同**

- 我们不把“是否授权”交给一个看 transcript 的分类器，而是交给确定性策略引擎和规则手册。模型只能提出动作，不能批准自己。
- Anthropic 的 auto mode 被拦后先不打断人，把拒绝交还模型，连续 3 次/累计 20 次才升级；本产品要求中风险动作直接等主人确认，且后台一律不执行。这是“用户主权 > 效率”的取舍。
- CaMeL 做逐值能力传播；我们先做“内容/上下文级可信度 + 动作事实”，粒度更粗但实现和审批 UX 更可控。逐值传播作为后续增强，不承诺这一次做到。
- 我们的审批是 durable 的，可等几小时、重启恢复；Claude Code 的交互式权限不是这个模型。

---

## 5. 分几步落地、每步检查与反向用例

| 步骤 | 内容 | 自动检查 | 反向用例（去掉守卫必须失败） |
|---|---|---|---|
| 1 | 动作清单 + 内置 `capability.v2` 清单 + 组合能力查询 | `check:action-catalog`；能力清单合同测试；`listAuthorized` 覆盖矩阵 | 删一条清单 → 工具暴露失败；改版本不同步 → `capability_version_mismatch`；加未登记 descriptor → 检查失败 |
| 2 | 规则手册动作闸门（ADR 0209 第 3 步最小版）+ 现有 owner 预授权复用 | 动作规则例子命中/不命中；干净会话 `reminder.set` 直接 ALLOW；规则删除后变 ASK | 删掉规则 → 提醒开始要确认；把不可信判断从 owner 授权里去掉 → 注入内容后的提醒直接执行，测试失败 |
| 3 | 内容可信度 + 上下文可信度 + 事实冻结/持久化 | 网页结果后下一轮/同一轮后续工具看到事实；压缩后清理；摘要继承；重启/审批恢复后事实不变 | 不标网页结果 → 注入测试能建提醒；把上下文可信度改成只看当前 run → 跨轮注入测试失败；重算而不是冻结 → 重启恢复哈希不匹配 |
| 4 | 所有 owner 工具、设备动作、感知读取接入唯一入口；后台提议 | owner 工具无 taint 直接执行；user+taint 中风险 ASK 且无副作用；background+taint 不建提醒/动作，只建提议；接受提议后执行一次 | 去掉 `#ownerScoped` 前的入口检查 → 注入后直接建提醒；去掉后台拒绝 → 后台建出提醒；提议接受后重复执行 → 去重测试失败 |
| 5 | 审批卡理由 + i18n + 决策记录 | 快照里 `untrusted_content_in_context` 能渲染成中文理由；未知代码有兜底 | 删掉理由映射 → UI 测试失败；把不可信事实从快照移除 → 审批卡不再说明原因，测试失败 |
| 6 | 上线走查 | `npm run check:prompt-prefix`、动作清单检查、审批/恢复集成测试 | 把信任事实塞进系统提示或历史中间 → `[I-66]` 结构检查必须失败；新增 `[I-66]` 用例要同步改 `scripts/check-prompt-prefix.mjs` 的 `REQUIRED` 数量，否则新用例等于没进门槛 |

注意：第 2 步的规则手册动作闸门是**必要的**。当前没有动作闸门，直接把提醒/规则接进 `ActionPolicyService` 会让干净会话里的“明天 9 点提醒我开会”从直接建变成每次问，违反目标。若 Andy 不想现在做完整动作闸门，退路是用动作清单里的“常规可预授权”数据做一条临时预授权；但它不如规则手册符合愿景，应明确记为临时方案。

---

## 6. 风险、反例、需要 Andy 拍板的取舍

**风险与反例**

- **漏标来源**：新工具返回外部文字但没登记 `resultProvenance`。用清单必填 + 未知来源按不可信 + 运行时失败关闭兜底。
- **跨轮/压缩漏判**：只按 run 记会漏；摘要不继承会漏。方案要求按当前可见上下文并让摘要继承最低可信度。
- **审批恢复后事实漂移**：恢复时重算可信度会让 `approvalMatchesIntent` 因哈希不同而拒绝。必须冻结事实并作为意图一部分持久化。
- **审批疲劳**：读过一次网页后同对话多次中风险动作会多次问。用低风险放行、精确授权复用、上下文真正清理后恢复、可选可信来源清单缓解；不能为了少点确认把中风险自动放行。
- **规则手册与 ADR 0209 决定 6 的冲突**：主人明确说“以后一律……”本来直接生效；若这一轮读过不可信内容，建议仍然问一次。需要 Andy 确认这是对决定 6 的安全覆盖，而不是改决定 6。
- **自动复核**：现有 `automaticReview` 只看到冻结意图，理论上可用来减少确认；但读过不可信内容时建议禁用，避免把“是否该问主人”交给模型。
- **设备动作清单不可信**：设备上报“支持哪些动作”只能用于展示/过滤，服务端必须以动作登记表为准；否则设备可扩大自己的能力。
- **并行工具**：已核实 Pi 的批次只要含 sequential 工具就整批顺序执行；但仍建议在动作清单检查里禁止“有后果动作”标 `parallel`，防止未来 Pi 行为变化。

**需要拍板**

1. 不可信范围：网页/邮件/短信/屏幕/旁人说话默认不可信；本地工作区文件和主人附件是否默认可信？
2. 是否现在做 ADR 0209 第 3 步动作闸门，还是先用动作清单的临时常规预授权？
3. 读过不可信内容后，`rule.set` 的主人明说规则是否也问一次？
4. 审批等待期间如果上下文变化，是否接受“继续按冻结事实审批”（建议接受）？
5. 部署时旧版本留下的 pending 审批是否直接放弃（建议：上线前清空/拒绝，因为意图合同新增了事实，旧快照会哈希不匹配）。

---

## 7. 必答问题逐条

### 7.1 会不会改变模型已经见过的请求开头？

**这个权限改动本身不会。** 前提是：

- 不往系统提示、工具定义里加任何信任/来源/审批理由文字；这些值只存在产品数据库、动作意图和审批 UI 里。
- 历史消息不改写、不重排、不删除；工具结果和审批失败结果仍然只追加在当前工具调用之后，处于请求末尾。
- 每轮会变的值（run source、可信度、来源清单、审批理由）不进入请求头；如果模型需要看到“动作被拒/被改为提议”，只以当前工具结果的形式追加在末尾。
- 遮盖逻辑不读可信度，不因这个改动改变遮盖结果。

**会变的一次**是 Apple 设计里新增 `device_action`、`perception_read` 和那批固定提示词；那是已批准设计的一次性重建（`docs/execution/specs/2026-11-11-apple-device-body-design.md:119`、`:657`），不是这个权限改动带来的第二次变化。实现时必须把两个工具和全部新提示词文字放在同一版本上线，之后不要再加。

验证：`npm run check:prompt-prefix` 必须通过；新增 `[I-66]` 用例检查“感知/外部内容只出现在末尾工具结果，不进入系统提示、工具定义或更早消息”，并同步修改 `scripts/check-prompt-prefix.mjs` 的 `REQUIRED`。

### 7.2 同一段文字会不会在不同请求里变成不同字节？

**模型可见的文字不会。** 可信度、来源、run source、审批理由都是主机侧元数据，不参与消息序列化。网页工具返回的 `markdown`、`contentKind`、`notice` 等文本保持原样。

需要保证确定性的地方：

- 来源列表和事实代码必须按固定顺序排序去重；`deterministicFacts` 按 `code` 排序，再按 `minimumRisk/source` 排序。
- 不把时间、随机数、数据库返回顺序放进意图事实或审批理由。
- 意图指纹会因可信度不同而不同，这是**授权语义不同**，不是模型文本不同；同一段工具输出、同一上下文、同一动作产生同一字节的意图。
- 遮盖规则不依赖可信度，因此同一段历史在相同密钥和相同前缀下仍遮出相同字节。

### 7.3 有没有自动检查，反向用例真的会失败吗？

有，见第 5 节。关键的“去掉守卫必须失败”至少包括：

- 去掉 `#ownerScoped`/`ActionAdmissionGate` 的入口检查：注入网页后建提醒/删日程成功 → 测试失败。
- 去掉 `untrusted_content_in_context` 事实：同一条注入路径直接执行 → 测试失败。
- 去掉后台 `DENY`：后台从网页读到的指令建出提醒 → 测试失败。
- 去掉动作清单项：工具暴露或执行被默认放行 → 检查/测试失败。
- 去掉能力清单或版本不匹配：策略仍返回 ALLOW → 测试失败。
- 把可信度写进系统提示或历史中间：`[I-66]` 结构检查失败。
- 恢复时重算而不是冻结事实：重启后审批哈希不匹配 → 测试失败（这实际上是期望的失败关闭）。

### 7.4 每个新值的产生端和使用端都能接受吗？

| 新值 | 产生处 | 使用处 | 两端校验/检查 |
|---|---|---|---|
| `run_source_user_message/schedule/external_event` 事实代码 | `ActionAdmissionGate`，读取 `RunExecutionSource` | `ActionPolicyService`、`OwnerActionAuthorization`、审批快照 | 触发器表已有 CHECK；`POLICY_FACT_CATALOG` + `validateGovernedActionIntent` 要求恰好一条；三种值各一条测试 |
| `untrusted_content_in_context` | 上下文可信度投影 → 动作入口 | 策略硬规则、owner 预授权、运行审批卡 | 事项目录校验；策略测试；UI 理由映射测试；未知代码仍显示兜底 |
| `untrusted_source_*` 来源代码 | 内容可信度登记表 + 工具结果来源 | 上下文可信度、审批理由、决策记录 | 来源登记表校验；未知来源按不可信；排序去重；网关 `machineString` 接受；UI i18n 覆盖 |
| 工具结果 `contentProvenance` | 动作清单/执行器 | runtime projection、上下文可信度 | 只读工具也必须有来源声明；未知/缺失按不可信；模型文本不含该字段 |
| 内置工具的 `capabilityRef/version/operations/ manifest` | 动作清单/内置清单 | 意图、`ActionPolicyService.capabilityDenial`、`listAuthorized` | 清单合同测试 + `check:action-catalog`；版本/操作不匹配必须 DENY |
| 动作清单的 `actionKind/sideEffect/reversible/consequence` | 动作清单 | 意图构造、风险计算、后台提议判断 | 清单校验 + 风险计算测试；新工具无条目直接失败 |
| 后台提议状态 `open/accepted/dismissed/expired` 和理由码 | 后台动作入口 | 提议存储、UI、决策记录 | 状态转换测试；数据库 CHECK/写入校验；未登记状态拒绝 |
| 审批理由（复用 `deterministicFactCodes`） | 冻结的动作意图 | 审批快照、运行审批卡、治理页 | 现有网关合同已接受 `array(machineString)`；UI 对已知代码有文案、未知代码兜底；快照往返测试 |
| 持久化的内容可信度记录 | 工具执行/投影捕获 | 上下文可信度计算、删除/压缩 | 表结构目录测试；迁移契约测试；压缩/删除测试；导出范围需明确（建议随运行记录导出或明确不导出） |

I-73 的教训在这里的具体落法是：**不能只测“动作入口产生了事实代码”，还要测 `validateGovernedActionIntent` 接受它、审批快照合同接受它、UI 渲染它、策略消费它、恢复路径仍能匹配它。** 任一端没有测试，就等于只做了一半。

---

## 8. 已证实 / 推测分开

**已由代码或一手资料证实**

- 现有的 owner 工具确实绕过权限引擎（P6）。
- 受治理工具的统一写法、挂起合同、审批哈希包含完整意图（P5、P8、P14）。
- 能力登记、风险表、自动复核、run source、审批持久化、Pi 顺序批次行为的现状（P7、P9、P13、P16）。
- 规则手册目前没有动作闸门（P11）。
- 业界一手来源的引文见第 4 节。

**仍是推测或需要实现确认**

- 具体用“投影旁的可信度侧表”还是“扩展 runtime history 元数据”；方向可行，但落点要在实施计划里核对现有投影/压缩/删除路径。
- 本地工作区文件和主人附件默认可信/不可信的最终策略，需要 Andy 定。
- 规则手册动作闸门的字段目录和默认规则需要按 ADR 0209 的 CEL 白名单实现，当前不存在。
- 后台提议的接受流程能否完全复用现有 `SuggestionService`/审批服务，需要看准备实施时的存储合同；本文只确定“提议不是挂起审批”这一边界。
- 生产上旧 pending 审批在新意图合同下的兼容情况：按“不顾旧数据兼容”应失败关闭，但上线操作需要安排清空或等其结束。
