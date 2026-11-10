## 证实的

### 高

**1. 规则短列表绕过数据分类上限，可能把敏感/受限规则内容发给模型**
- 问题：方案第 5 节写“不受 2000 字预算和模型归类影响”。现有规则块并不是这样：`owner-profile-service.ts:162-180` 同时用 `maxClassification` 和 `modelVisibleCeiling()` 过滤，`#block` 还把整块分类设为所有规则的更高档（`:341-351`）。新列表若绕过，重要发件人、静默时段、规则原话等可能以 `restricted` 内容进入请求。
- 证据：`packages/application/src/services/owner-profile-service.ts:162-180,341-351`；`packages/application/src/services/model-visibility.ts:10-18`；`docs/agent-rulebook-inventory.md:148`（M-4）；[ADR 0193](docs/adr/0193-memory-is-visible-to-the-model.md#consequences)。
- 建议：每条规则和出处都带 `dataClassification`，复用 `maxMemoryClassification` 与 `modelVisibleCeiling()`；把“固定指令”和“主人参数”分开，参数走分类过滤和遮盖；用受限规则做“不得进入最后一条消息”的反向测试。

**2. `claim_requires_effect` 不是程序可判的类型，S-14/S-18 的“硬规则”承诺不成立**
- 问题：方案第 3 节说只登记“不靠模型就能判对错”的类型，但 `claim_requires_effect` 要判断回答里是否说了“已设好提醒/已发送”。S-14/S-18 本身是自由文本（`packages/prompt-catalog/src/chat.ts:18,31,32`），同义句、否定、引用、条件句都无法用纯程序可靠识别；若用模型判断，就违反“硬”的定义，还多一次模型调用和费用。
- 证据：`docs/agent-rulebook-inventory.md:120,124`；`packages/prompt-catalog/src/chat.ts:18,31-32`；方案第 3、4 节。
- 建议：二选一：(a) 把效果做成结构化声明，模型必须通过专用工具/字段报告效果，最终呈现由产品根据工具账本渲染；(b) 缩小范围，只在 `reminder_set` 等工具失败时追加宿主写的纠正，并把“不得说已设好”明确标成“工具结果硬 + 文字软”。不要把 S-14/S-18 说成纯程序硬规则。

**3. “规则编号+版本号”会打破现有决策链消费者（I-73 同类）**
- 问题：方案说决策记录写“规则编号+版本号”。现有 `production-decision-chain.ts:106` 用 `decisionRuleDefinition(ruleId)` 精确查 `DECISION_RULE_CATALOG`，而 catalog 的键是裸 id；`gateway-contracts/src/contracts-v2.ts:1028-1030` 只接受 `origin` 的 `owner_setting|built_in` 两种值、`document` 最长 64 字符。若写成 `id@v3`，UI 会显示“未登记的规则”；若把消息编号/ADR 长文本放进 `document`，网关契约会拒绝。
- 证据：`apps/agent-service/src/production-decision-chain.ts:56-62,102-115`；`packages/gateway-contracts/src/contracts-v2.ts:1024-1033,1104`；`packages/persistence-sqlite/src/sqlite-decision-ledger-operations.ts:40-63`（只查长度，不查登记册）；`docs/execution/specs/2026-11-09-decision-record-write-convention.md:39,52`。
- 建议：定义唯一的 `RuleRef`（稳定裸 id + 整数版本）和序列化函数；`ruleIds` 继续存裸 id，版本放单独字段；要新增字段必须同时改 `DecisionInputs`、`insertLedgerRow`、`ProactiveCheckInputs`、网关快照、数据导出和 UI。加“登记册每条规则都过所有消费者校验”的往返测试。

**4. 每封邮件最多 16 条 `floorHits`，规则变多后会被后端拒绝**
- 问题：方案要把 54 条规则放进登记册，一封邮件可能同时命中重要发件人、公共机构、金钱词、静默、限额、抑制等多条规则；`sqlite-proactive-operations.ts:611-612` 校验 `floorHits` 每封最多 16 个 id，超过就报 `Proactive check inputs are invalid`；`ruleIds` 总数上限 500，非 proactive 的 `decision_ledger` 上限 200（`sqlite-decision-ledger-operations.ts:29`）。
- 证据：`packages/persistence-sqlite/src/sqlite-proactive-operations.ts:41,585-623`；`packages/persistence-sqlite/src/sqlite-decision-ledger-operations.ts:29,40-47`。
- 建议：明确 `floorHits` 是“全部命中”还是“实际改变结果的规则”；后者更合适。若保留全部，先改后端上限/契约并加迁移和测试；加一条 17 条规则命中同一封邮件的生产-消费者测试。

**5. 动态规则文本放进 `mail.judgment` 系统提示，违反“会变的值只放最后一条消息”**
- 问题：方案第 5 节说 S-8/S-9 改为从登记册参数生成。S-8/S-9 现在在 `packages/prompt-catalog/src/mail.ts:20,23` 的 `fixedPrompt` 里；`prompt-prefix.md:28` 明确系统提示和工具定义里不得出现额度、重要发件人等会变的值，`:67` 要求后台调用“固定的在前、会变的在后”。把主人规则参数生成进系统提示，会让规则一改前缀就变。
- 证据：`packages/prompt-catalog/src/mail.ts:3-33`（`fixedPrompt` 与 S-8/S-9 原文）；`.claude/rules/prompt-prefix.md:28,67`。
- 建议：系统提示只保留通用的判断标准；主人特定的后缀、词表、限额、静默时段放在邮件数据段（最后一条消息）里，按稳定顺序序列化；按规则版本冻结或重建，并加一条“改规则但系统提示字节不变”的 prompt-prefix 兼容测试。

**6. 动作闸没有 ASK 规则，也不写 `decision_ledger`；方案说的“一个决策记录”不成立**
- 问题：`PermissionPolicyRule.effect` 只有 `"ALLOW" | "DENY"`（`authorization.ts:77-87`），没有“必须先批准”的 ASK 规则；`ActionPolicyService` 的 trace 是 `AuthorizationDecisionTracePort`，字段只有 `intentId/policyVersion/facts/modelRisk/finalRisk/decision/reasonCode/occurredAt`，不含 `ruleIds`（`action-policy-service.ts:242-252,607-622`），组合根注入的是 `traceStore()`，不是 `decision_ledger`。方案里的 `tool_gate`“必须先批准”和“decision_ledger.ruleIds + 版本”没有对应实现。
- 证据：`packages/application/src/ports/authorization.ts:77-87`；`packages/application/src/services/action-policy-service.ts:316-325,398-417,607-622`；`apps/agent-service/src/production-run-composition.ts:399`。
- 建议：要么给 `PermissionPolicyRule` 增加 ASK/requires-approval 效果，要么用 `deterministicFacts` 把风险抬到需要审批；把 `ruleRef` 加进授权 trace 及其存储/UI，或者明确保留两套账本并写清差异。不要在没有扩展契约前宣称统一决策记录。

**7. 被 `tool_call` 拦下的调用不会产生 `tool_result`，方案的数据路径错误**
- 问题：方案说“拦下写进 `tool_result`/决策记录”。Pi 官方文档原话：“a blocked or aborted call skips execution and `tool_result`. Each of these still gets `tool_execution_end` with an error result”。所以被拦下的调用只能从 `tool_call` 或 `tool_execution_end` 记录，不能写进 `tool_result`。
- 证据：https://pi.dev/docs/latest/extensions（Extensions → Tool Events）；`packages/runtime-pi/src/pi-runtime-adapter.ts:1425-1449`。
- 建议：在 `tool_call` 返回 block 时直接写决策记录，并用 `tool_execution_end` 统一观察所有最终调用；不要依赖 `tool_result`。

**8. `agent_before_settle` 继续请求和规则拦下工具都可能循环，现有 tool-progress 守卫看不到**
- 问题：Pi 文档原话：“Guard continuation conditions: an unconditional `continue: true` is evaluated again after the next response and can create an endless loop.” 现有 `PiToolProgressGuard` 只看 `tool_result`（`pi-runtime-adapter.ts:1429-1444`），而规则拦下的调用跳过 `tool_result`，模型可以反复调用被拦工具；`agent_before_settle` 在 continuation 后的新 run 还会再次触发。
- 证据：https://pi.dev/docs/latest/extensions（agent_before_settle、tool_result）；`packages/runtime-pi/src/pi-runtime-adapter.ts:1429-1444`。
- 建议：加 per-run latch，最多继续一次；把被拦调用计入现有进度守卫或单独计数，必要时返回 `terminate: true`；加“模型反复调用被拦工具必须停止”的集成测试；把额外模型请求纳入每日预算。

### 中

**9. 一个登记册混放硬规则和软规则，与“规则是硬性设定”冲突**
- 问题：方案第 2 节把 54 条（含 S 类软规则）都叫登记册，严格度里还有“仅告知”。软规则不是“必定执行”的硬设定，混在一起会让 `check:rule-registry` 和“生效规则都有钩子”的语义失效。
- 证据：`docs/product-vision.md:59,101,107`；`docs/agent-rulebook-inventory.md:52,92`；方案第 2、3、9 节。
- 建议：登记册只放可执行类型；软偏好留在记忆/档案，另设 `soft_preference` 视图；或者至少加 `hardness: hard|soft`，两类用不同的校验、不同的模型展示和不同的“必定执行”承诺。

**10. `DECISION_RULE_CATALOG` 不能同步“改读登记册”**
- 问题：`decisionRuleDefinition` 是同步函数（`proactive-rules.ts:60-64`），`production-decision-chain.ts:106` 同步调用；数据库读取是异步。方案第 8 步说“DECISION_RULE_CATALOG 改读登记册，不改任何行为”，但没有说明快照、缓存失效或异步化。
- 证据：`packages/application/src/services/proactive-rules.ts:44-64`；`apps/agent-service/src/production-decision-chain.ts:106`。
- 建议：启动时加载版本化规则快照，写入后刷新；或把决策链改成异步并更新调用方。明确缓存一致性和测试。

**11. `proactive_settings` 迁移没有定义，会出现双源和丢历史**
- 问题：方案第 0 步种子 54 条，第 1 步才把静默、限额迁成登记册驱动；但没有说明 `proactive_settings` 里已有的 `quiet_hours`、`important_senders` 怎么迁移、配置键 `runPolicy.proactive.*` 是否废弃、双写还是单向。`proactive_settings` 本身没有版本号（`0062_proactive_checks.sql:1-10`）。
- 证据：`packages/persistence-sqlite/src/migrations/0062_proactive_checks.sql:1-10`；`docs/agent-rulebook-inventory.md:175,178`（C-5、C-8）；ADR 0163 决定 2。
- 建议：单独迁移，把现有值按“无出处”导入并保留旧键兼容；每个重要发件人最好有子行或逐项出处；写入用 `expectedRevision` 做乐观并发；明确唯一权威源后删除旧读取路径。

**12. 规则冲突优先级没有定义**
- 问题：方案只借用 Codex 的“多条命中取最严”，但 Himawari 现有规则有具体交互：H-6 低优先级不上提醒页、H-9 到费用上限时地板仍推送、H-10 垃圾邮件不送模型、H-11 地板不降频。`suppress` 与 `floor`、`limit` 与 `floor` 谁是最终结果，方案没有定义。
- 证据：`docs/agent-rulebook-inventory.md:69-84`；`packages/application/src/services/proactive-rules.ts:87-121`。
- 建议：定义按执行面的固定流水线：垃圾邮件/敏感跳过 → floor 判定 → suppress/limit/window → 推送；每步用表格写清优先级，并加冲突用例（重要发件人的垃圾邮件、费用上限时的地板等）。

**13. 规则短列表没有上限、没有按执行面过滤**
- 问题：方案明确说短列表“不受 2000 字预算影响”，但 54 条以上规则全部塞进每轮最后一条消息会随规则增长膨胀；Gmail 规则对聊天模型多数无关，还会增加成本和干扰。
- 证据：方案第 5 节；`docs/agent-rulebook-inventory.md:52`。
- 建议：按执行面（chat/mail/action）派生子集；设独立字符上限和最少优先级；稳定排序；必要时只放规则摘要，详细参数留在工具/证据里。

**14. 规则提案的回放对 `claim_requires_effect`/聊天证据不可行，成本和隐私也没限**
- 问题：`decision_ledger` 的 inputs 主要存 id 和 `floorHits`；非 proactive 的 `insertLedgerRow` 只落 `memoryIds/ruleIds/batchId/resultMemoryIds` 四个键（`decision-record-write-convention.md:35`）。聊天里的工具证据、最终回答历史并不在决策记录里，无法用来回放“这条规则会改变几次结果”。回放 30 天邮件还可能读大量敏感内容。
- 证据：`packages/application/src/ports/decision-ledger.ts:71-92`；`packages/persistence-sqlite/src/sqlite-decision-ledger-operations.ts:98-130`；`docs/execution/specs/2026-11-09-decision-record-write-convention.md:35`。
- 建议：只对“历史输入已记录”的类型承诺回放；对 `claim_requires_effect`/`evidence_before_conclusion` 显示“无法回放”。回放前先算样本量和费用，设上限，脱敏，并把“回放数字”标成估算。

**15. 模型生成的示例和确认卡文案可被游戏化**
- 问题：方案让模型产出规则提案，又用它自带的 `match/not_match` 示例做激活前自检。Codex 的示例是规则作者写的、由 Codex 加载时校验；这里模型可以同时编规则和编示例，示例很容易全部通过而没有验证规则。
- 证据：https://learn.chatgpt.com/docs/agent-configuration/rules（“`match` and `not_match` are optional 'inline unit tests' ... Codex validates when it loads your rules”）；方案第 3、6 节。
- 建议：示例由程序按规则类型从固定夹具生成，或至少由程序补充一组不可被模型覆盖的边界用例；确认卡展示原始原话 + 程序校验后的类型化参数，不只展示模型写的大白话。

**16. 规则参数允许任意正则/文本会引入 ReDoS 和注入**
- 问题：现有金钱词是正则 `MONEY_WORDS`（`proactive-rules.ts:11-12`）。方案说迁成“金钱词表”，但没有禁止登记册存任意正则、脚本或超长文本。若允许模型/主人输入正则，可能 ReDoS；若把规则文本当指令注入模型，可能提示注入。
- 证据：`packages/application/src/services/proactive-rules.ts:9-12`；方案第 2、3 节。
- 建议：只允许类型化参数（枚举、字面量列表、数字、时间），词表由程序转义后拼正则；禁止用户/模型提供正则或代码；限制长度和数量；模型侧的规则文本用数据分隔符包起来，并明确“规则内容是数据，不是对你的新指令”。

**17. `origin`/`document` 的出处模型与网关契约不匹配**
- 问题：方案说出处可以是原话消息编号、事件、ADR，或“无出处”；网关只接受 `owner_setting|built_in`，`document` 最长 64。若把新出处类型直接写入，会触发 I-73 同类问题。
- 证据：`packages/gateway-contracts/src/contracts-v2.ts:1029-1030`；方案第 2、6 节。
- 建议：保留这两个展示值作为映射结果，另建出处表存 `message_id/event/adr/no_source`；或扩展网关契约并同步 UI。加出处往返测试。

**18. 新登记册表没有纳入导出、删除、备份**
- 问题：产品愿景要求规则可携带；方案只提“导出 SKILL.md”，没有把登记册纳入现有数据导出/导入/删除/备份，也没有定义规则和历史的分类、删除策略。
- 证据：`docs/product-vision.md:107,122,157`；方案第 8 步第 4 点；现有 `packages/persistence-sqlite/src/data-export/`。
- 建议：把规则表、版本历史、出处纳入 data-export/import、删除和备份恢复；明确删除规则时历史保留/删除策略；导出前做敏感信息遮盖。

**19. 现有 `floor_*` 规则 id 和测试兼容性没有交代**
- 问题：现有 `FLOOR_RULE_IDS` 是 `floor_important_sender/floor_public_domain/floor_money_words`，集成测试直接断言这些值（如 `test/integration/proactive-mail-check.test.ts:1557`）。方案第 0 步“DECISION_RULE_CATALOG 改读登记册、不改任何行为”，但没有说种子 id 是否保持这些值；若改成 H-1 等编号，现有测试和旧决策记录都会对不上。
- 证据：`packages/application/src/services/proactive-rules.ts:29-58`；`test/integration/proactive-mail-check.test.ts:1557,1689`；`packages/application/test/decision-rule-catalog.unit.test.ts:10`。
- 建议：前三条规则保持稳定 id；把盘点编号 H-1 作为别名/出处，不直接当运行时 id；明确旧决策记录如何映射。

## 推测 / 未核实

**20. 前提 P11 的“硬规则用权限系统不用 hook”过于绝对**
- 推测：Claude Code 也允许 `PreToolUse` hook 做 gate，只是不能绕过 deny/ask。官方原话：“PreToolUse hook decisions don't bypass permission rules.” 方案用 Pi hook 做工具闸本身不冲突，但不要把 Claude 的做法简化成“不用 hook”。
- 证据：https://code.claude.com/docs/en/permissions
- 建议：改写前提为“硬规则优先放在执行层；hook 可做 gate，但必须 fail closed，且不能覆盖更严的 deny/ask”。

**21. “ChatGPT/Claude 的个人规则只是注入文字，用户看不到不执行”未核实**
- 推测：方案自己写了“我没有另行核实它们的内部实现”。这不影响方案，但不能作为一手依据。
- 建议：删掉或标为未核实；只保留已核实的 Claude Code/Codex/OpenAI Agents SDK 行为。

**22. SKILL.md 导出不能把 `tool_gate`/`claim_requires_effect` 变成 Claude Code/Codex 的硬规则**
- 推测：导出成 SKILL.md 后，这些规则在外部 harness 里最多是文字约束，除非对方也有对应 hook/权限机制。产品愿景 #12 要求导出后 #1/#6 仍通过，但方案没有区分“可执行导出”和“仅说明导出”。
- 建议：导出时标注每条规则在外部 harness 是硬还是软；不要把 SKILL.md 说成完整执行等价。

## 侧重检查

- **错误路径**：`tool_call` 被拦下不会产生 `tool_result`（已证实）；`agent_before_settle` 处理函数抛错时 Pi 只报告并继续，方案需要自己包一层才能 fail closed；`agent_before_settle` 的 `continue: true` 可能反复触发（需要 per-run latch）；数据库不可读时“默认当作违规”会导致每个 run 都追加纠正并多请求一次，必须有熔断/预算。限额预留在工具被拦或中断时要释放，否则额度泄漏。
- **不合规范/不可信输入**：规则提案来自模型，规则内容可能被邮件/工具结果污染；确认卡必须由宿主渲染，不能由模型文字“主人已确认”；`match/not_match` 不能由模型自证；规则参数不能接受任意正则/脚本；出处消息编号必须属于当前 owner/agent。
- **安全**：规则短列表绕过分类上限是最高风险；规则参数可能含重要发件人、邮箱、原话等敏感信息，导出 SKILL.md 也会带出；新表的 API 必须做 owner/agent 作用域和认证；规则文本进入模型时要按数据而非指令处理。
- **资源耗尽**：规则无上限、无 per-surface 过滤；回放 30 天邮件/决策；`agent_before_settle` 额外模型请求；被拦工具反复调用；加载时跑所有内联示例。都要有数量/字符/费用/时间上限和熔断。
- **不可撤销操作**：`tool_gate` 只能收紧，不能产生 ALLOW；不要允许登记册规则放宽已有批准；规则激活前必须有宿主确认；规则版本历史要可回滚；删除规则/数据要有明确策略。
- **规则、文档、代码一致**：`prompt-prefix.md` 第 2/6/15 条与“S-8/S-9 从登记册生成”冲突；`decision-record-write-convention.md:39,52` 说规则编号必须登记在 `DECISION_RULE_CATALOG`，方案改成登记册后必须改这份文档；盘点文档里的 H/S/C 编号和测试名在实现后要更新；`proactive_settings` 和 `runPolicy.proactive.*` 的双源要写清。

## 如果由我来定，我会怎样改这份方案

1. **先把“硬规则登记册”和“软偏好”分开。** 登记册只收可执行类型；软偏好继续走记忆/档案，界面明确标“软：靠模型自觉”。不要把 54 条全塞进一个表。
2. **先定义契约，再写执行。** 定义 `RuleId`、`RuleVersion`、`RuleRef`、`RuleType`、`Effect`、`Surface`、`Status`、`Provenance`、`DataClassification`，一个校验器，所有产生方和消费方共用。`ruleIds` 存裸 id，版本单独存；先扩 `DecisionInputs`、`insertLedgerRow`、网关快照、导出，再写规则。
3. **规则执行拆成“纯判断 + 有状态预留”。** `evaluate` 保持纯函数；`limit`/`window` 用单独的 reserve/commit/release 端口，原子预留，失败/拦下/中断都释放。不要把限额伪装成纯函数。
4. **按执行面派生规则视图。** chat/mail/action 各自只拿相关规则；稳定排序、固定 JSON 键序、字符上限、分类过滤。最后一条消息只放“指令摘要 + 参数”，系统提示保持固定；加 prompt-prefix 兼容测试。
5. **动作闸先补 ASK 语义。** 要么给 `PermissionPolicyRule` 加 `ASK`，要么用 `deterministicFacts` 把风险抬到审批；把 `RuleRef` 写进授权 trace 和 UI；不要宣称统一 `decision_ledger`，除非真的扩展。
6. **S-14/S-18 先用结构化效果，不要用自由文本判断。** 模型通过专用工具/字段报告“设了提醒/发了消息”，产品根据工具账本渲染最终状态；如果做不到，就明确标成“工具结果硬、文字软”，不要放进第一批“硬规则”。
7. **Pi 集成按真实事件语义写。** 被拦调用用 `tool_call` + `tool_execution_end` 记录，不用 `tool_result`；把被拦调用喂给现有进度守卫；`agent_before_settle` 加 per-run latch、最多一次、预算和终止条件。
8. **回放只承诺能回放的类型。** 先算样本量/费用，脱敏，设上限；对聊天证据/效果类规则显示“无法回放”，不要编一个数字。
9. **测试先红后绿。** 除了规则反向用例，还要有：`check:rule-registry` 自身的反向用例（故意让每条检查失败）、17 条规则命中同一封邮件、受限规则不得进入请求、被拦工具没有 `tool_result`、反复调用被拦工具必须停止、限额预留释放、规则改但系统提示字节不变、登记册 id 过所有消费者。
10. **分步落地改为：** 0) 只建表/校验器/快照，不改行为；1) 三条 `floor_*` 保持原 id 迁入登记册，现有 PG/OM 测试原样通过；2) 动作闸 ASK/trace；3) 证据/效果（结构化）；4) 软偏好和 SKILL.md 导出。每一步都单独确认。

## 必答问题

**1. 这个改动会不会改变模型已经见过的请求开头？**
按现在的方案，**不能保证**。聊天侧把规则短列表放最后一条用户消息，方向是对的；`agent_before_settle` 追加纠正消息也是末尾追加。但有两处会改开头：
- 第 5 节把 S-8/S-9 从 `mail.judgment` 的 `fixedPrompt` 改成由登记册参数生成，规则一改系统提示就变，违反 `.claude/rules/prompt-prefix.md:28`；
- 如果规则列表/版本/出处没有固定排序和序列化，或者被放进系统提示、工具定义，也会改开头。
所以：**只有把会变的规则参数全部放最后一条消息/数据段，系统提示保持固定，才是只追加**；每轮会变的值必须在最后一条消息，不能进固定头。

**2. 会不会让同一段文字在不同请求里变成不同的字节？**
**会，按现方案有多个风险点**：
- 登记册查询/`Object.values` 的顺序不稳定；
- 规则版本、`updatedAt`、出处文本进入展示字符串；
- `decision_ledger.ruleIds`/`floorHits` 顺序不一致；
- 规则列表被遮盖时依赖前后文；
- 规则文本本身含时间、路径、额度等每轮会变的值。
现有代码在部分地方已经固定排序（`proactive-mail-check-service.ts:1332` 对 `ruleIds` 排序，`owner-profile-service.ts:187` 按固定比较器排序），新代码必须沿用并覆盖所有出口。建议统一 `canonicalRuleRef()` + 固定排序 + 固定 JSON 键序 + 不带时间戳。

**3. 改动有没有对应的自动检查，反向用例真的会失败吗？**
**部分有，但不够。** 方案有计划：类型测试、内联示例、`check:rule-registry`、Pi 集成测试。但缺少：
- `check:rule-registry` 自身的反向用例（故意让“无出处、类型不存在、示例失败、钩子不存在、导出不一致”分别失败）；
- 规则列表“只出现在最后一条消息、系统提示字节不变”的 prompt-prefix 测试；
- 登记册 id/版本过 `decision_ledger`、`gateway` 快照、数据导出、UI 的往返测试（I-73）；
- 受限规则不得进入请求的分类泄漏测试；
- 被拦工具没有 `tool_result`、反复调用必须停止、限额预留释放的测试；
- 17 条规则命中同一封邮件的后端校验测试。
规则的反向用例只能证明“规则不命中”，不能证明“门槛会自动拦住坏规则”。

**4. 每个值，每一个使用它的地方都能接受吗？**
**不能，至少有以下已证实的断点**：
- `id@version` 与 `production-decision-chain.ts:106` 的精确查表不兼容；`origin` 枚举和 `document` 64 字符也与登记册出处模型不兼容。
- `floorHits` 每封最多 16 条，登记册规则变多后生产者可能超过。
- `ActionPolicyService` 的 trace 没有 `ruleIds`，`PermissionPolicyRule` 没有 ASK；方案里的“必须先批准”和“统一决策记录”没有落点。
- `proactive_settings` 已有值、`runPolicy.proactive.*` 配置、旧 `floor_*` id 和旧决策记录都需要迁移/映射，方案没有逐项核对。
- 新表没有纳入数据导出/删除/备份。
所以应先做“产生方-消费方矩阵”，每个值逐个列出产生处、校验处、展示处、导出/删除处，再动手。

## 对 Andy 三个问题的建议

1. **最终回答不合规时允许多发一次模型请求吗？** 可以，但要加 per-run latch（最多一次）、费用/时间预算、失败熔断；并且只在“纠正后能验证”的规则上用。否则只显示“未验证”，不要无限重试。
2. **第一批聊天硬规则只做 S-14/S-18 够吗？** 不够，而且按现方案它们不是真正的硬规则。先把它们改成结构化效果/工具结果驱动的窄规则；如果做不到，就先不做，改做能程序判定的一类（例如“工具失败后不得再调用同一工具”或“未读到指定证据不得调用结论工具”）。
3. **对不上任何类型的话，存软偏好并明说，还是拒绝？** 建议存软偏好并明确标“软：靠模型自觉”，同时记一条“需要新类型”的待办；不要拒绝主人的话，但也不要把它放进硬规则登记册。
