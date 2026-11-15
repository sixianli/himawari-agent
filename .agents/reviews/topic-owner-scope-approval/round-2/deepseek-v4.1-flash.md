结论：方向（一个出口、登记表、默认把没声明的内容当外来）是对的；但方案里有几处会直接破坏现有行为或安全边界，而且和已接受的 ADR 冲突。按现在的写法，第 1 步“不改行为”、第 6 节“工具定义一个字不改”都不成立。下面按严重度列。

## 一、证实的

### 高

**1. 把 `rule_set` / `rule_undo` 归为“改权限”会直接破坏 ADR 0209 决定 6**
- 问题：`CREDENTIAL_OR_ACCESS` 的基线是 `CRITICAL`。按方案的风险表，`CRITICAL` 一律等主人点头并要近期身份验证；但现有代码对主人明确说“以后/一律”的规则是直接生效的，ADR 0209 决定 6 和产品愿景也要求这样。
- 证据：`apps/agent-service/src/production-owner-rules.ts:637-639`（`explicit` 成立就 `#activate`）；`packages/application/src/services/action-policy-service.ts:44`（`CREDENTIAL_OR_ACCESS: "CRITICAL"`）；同文件 `:503`（只有 `CRITICAL` 才要求近期身份验证）；`docs/adr/0209-rule-book-with-cel-expressions-and-judge.md:58`；`docs/product-vision.md:58`。另外 `packages/application/src/services/automatic-action-review.ts:98` 对 `CRITICAL` 直接返回 `undefined`，所以这条也进不了“主人意图核对”。
- 建议：不要用 `CREDENTIAL_OR_ACCESS`。给“改规则”单独的动作类别或事实，按“主人明确原话的规则直接生效、外部内容引发的规则才等点头”处理；补“明确原话 / 推断 / 外部内容”三种用例。

**2. 让主人能往“动作闸门”加规则，会改变 `rule_set` 的工具定义，违反“工具定义不变”**
- 问题：`rule_set` 的 `type` 枚举是从 `RULE_TYPES` 动态生成的，`params` 结构是固定的邮件匹配字段。要支持动作规则，就必须加新的 `RULE_TYPES` 或改 `params`，两者都会改变工具定义的字节。工具定义在请求最前面，所有老对话会重建一次。
- 证据：`apps/agent-service/src/production-owner-rules.ts:170`（`enum: [...types.filter(...).map(({ id }) => id), SOFT_TYPE]`）；`packages/application/src/rules/rule-types.ts:202-213`（目前只有两个邮件类型）；`production-owner-rules.ts:163-187`（`params` 固定）；`.claude/rules/prompt-prefix.md:41-44`（工具集合或参数结构变了要换新，工具定义在请求最前面）；`packages/runtime-pi/src/pi-runtime-adapter.ts:1383-1398`（冻结定义进系统提示和工具）。
- 建议：本方案只内置动作规则，不开放主人用 `rule_set` 添加动作规则；等 ADR 0209 第 4 步的“一句话变规则”方案成熟后再加。如果一定要现在加，另出 ADR，明确接受“每个老对话重建一次”，并把 `npm run check:prompt-prefix` 和真实 descriptor 快照纳入门槛。

**3. “主人意图核对”不能直接落在现有自动复核端口上**
- 问题：现有自动复核只审“Owner 事先列在委托清单里的确切 intent”，委托清单不允许模型输出扩大；输入里没有对话文字，也没有动作参数；`prepareInput` 还固定按 `private` 分类写入。方案要给它加“主人原话 + 动作参数”，同时要审任意新 intent，这等于改掉它的两个核心安全约束。
- 证据：`packages/application/src/services/automatic-action-review-contract.ts:19-31`（`delegation.intentFingerprints.includes(request.intentFingerprint)`）；`docs/archive/plans/2026-09-16-workspace-authorization-lifecycle-plan.md:188`（“只列 Owner 明确接受的确切请求摘要 … 缺少覆盖即回到人工”）；`apps/agent-service/src/production-automatic-review.ts:71-73`（“Only the host's frozen summary reaches the reviewer … No file contents, local paths, credentials or conversation text are disclosed”）；同文件 `:81-96`（输入字段里没有参数和对话）；`:114-115`（只允许 `private`）。
- 建议：要么新建一个独立的“主人意图核对”端口，自己定义委托、分类、披露、保留和预算；要么第一版直接选 B（有外来内容就一律让主人点），把 A 放到单独 ADR 和评测之后。不要把它说成“给现有端口加一种输入”。

**4. 核对的模型仍然能被动作参数里的外来文字影响**
- 问题：方案说“外来内容里夹带的指令到不了它面前”，但它把“这次动作的具体内容（类别、参数）”给了核对模型。模型可以把网页里的句子原样抄进 `text`、`url`、`path`、`query` 等参数，核对模型看到的就是外来文字。Anthropic 自己也承认这个 provenance 缺口。
- 证据：Anthropic 原文：“If the user never named ‘job abc123,’ the classifier can't tell whether the agent pulled it from a query or fabricated it. We accept that cost for injection robustness.”（https://www.anthropic.com/engineering/claude-code-auto-mode）；OpenAI：“Use structured outputs to constrain data flow … you eliminate freeform channels that attackers can exploit”（https://developers.openai.com/api/docs/guides/agent-builder-security）。
- 建议：核对只接受封闭的动作类型和结构化字段，不接受自由文本；对 `text`、`url`、`path` 等字段做来源检查或直接排除；测试里必须放“把工具结果原文塞进动作参数”的反向用例，断言不能直接批准。

**5. 审批卡片的“标题、正文预览、为什么问你、来源”四项目前不存在**
- 问题：当前审批卡只显示 operation、sideEffect、从执行记录里按工具名匹配的 input、recipients、targets、dataClassification；没有标题、正文预览、为什么问你、来源。`deterministicFactCodes` 只在治理页以原始代码显示，没有人类可读标签。方案说“新工具不用改审批代码”不成立。
- 证据：`apps/control-center/src/components/run-approval-card.tsx:175-204`；同文件 `:144-154`（input 从 records 里按 operation 匹配）；`packages/gateway-contracts/src/contracts-v2.ts:2226-2261`（审批快照的 intent 字段里没有这四项）；`apps/control-center/src/governance-control-center.tsx:357-358`（直接显示 `deterministicFactCodes`）。
- 建议：在 gateway 合约和 UI 里增加这四项及 i18n，或者删掉“沿用现有四项”的说法，把第 5 节改成需要 UI 改动。

**6. 把“上下文有外来内容”塞进 `deterministicFacts` 会抬高 READ 的风险，可能让只读也要审批**
- 问题：`computeActionRisk` 取所有事实的 `minimumRisk` 最大值。如果新事实的 `minimumRisk` 是 `MEDIUM`，所有 READ（包括 `reminder_list`、`rule_list`、`recall`）都会变成 `MEDIUM`，`safePolicyRead` 要求 `LOW`，于是只读也会被建审批。另外 `deterministicFacts` 的数组顺序参与 `actionIntentFingerprint`，用集合/对象顺序构造会让同一语义产生不同指纹。
- 证据：`packages/application/src/services/action-policy-service.ts:58-67`（`computeActionRisk`）；同文件 `:554-569`（`safePolicyRead` 要求 `LOW`）；`packages/application/src/ports/authorization.ts:29-33`（事实必须带 `minimumRisk`）；`packages/application/src/services/action-intent-snapshot.ts:12-25`（“array order remains part of the snapshot”）。
- 建议：把“上下文有外来内容”和“发起者”做成规则闸门的字段/事实码，但不设高 `minimumRisk`（设 `LOW`），由规则闸门决定是否 ASK；或者只把事实附在有后果的 intent 上，READ 不附。构造时按 `code` 排序，并加“同一事实集合不同插入顺序得到同一指纹”的测试。

**7. `external_event` 的 payload 和附件没有默认算外来内容**
- 问题：方案第一批只列了联网搜索、抓网页、`perception_read` 的 other、读文件/命令、以后的邮件正文、MCP 内容。`external_event` 这一轮携带的事件正文本身就是外来内容；附件（PDF、图片、文本）也可能是外来内容。若没标记，表里“后台发起、上下文里没有外来内容”这一行会放行中风险动作。
- 证据：`packages/application/src/ports/run-execution-source.ts:26`（`sourceType: "user_message" | "schedule" | "external_event"`）；`apps/agent-service/src/production-uploaded-files.ts`（附件内容进入请求）。
- 建议：`sourceType === "external_event"` 默认算外来；附件除非能证明是主人自己写的，否则默认外来；补后台事件 + 附件两条反向用例。

**8. `reminder_set` 会写正式记忆，形成“外来内容 → 提醒 → 正式记忆 → 记忆检索算主人自己的”洗白路径**
- 问题：方案把正式记忆检索算主人自己的数据。但 `reminder_set` 会 `applyProposal` 创建一条 `inference: false` 的正式记忆。由外来内容生成的提醒文字，之后会作为正式记忆被 `recall` 读出来；等原始外来内容被压缩掉，事实清了，记忆还在，后续动作就不再受“有外来内容”约束。
- 证据：`apps/agent-service/src/production-reminder-writer.ts:217-252`（`decision: "create"`、`inference: false`、`category: "event"`、`sourceRefs`）；方案第 2 节“算主人自己的：记忆检索（正式记忆）”。
- 建议：给记忆加来源标记，至少标记“这条记忆是在有外来内容的对话里由提醒/规则写入的”；`recall` 返回来源，规则闸门把“回忆来源含外来内容”也算外来；补“外来内容建提醒 → 压缩 → 再 recall → 再建提醒”的用例。

**9. 没有拒绝循环的升级/资源耗尽保护**
- 问题：方案说被拒后模型可以换做法、不停下，但没有“连续拒绝多少次/总共多少次就停下交给人”的上限。被注入的模型可以无限尝试中风险动作，每次都触发核对模型调用，造成费用和资源耗尽。
- 证据：Anthropic 原文：“If a session accumulates 3 consecutive denials or 20 total, we stop the model and escalate to the human.”（https://www.anthropic.com/engineering/claude-code-auto-mode）；方案第 3 节只写了“可以换个做法或告诉主人，不停下干等”，没有上限。
- 建议：加连续/累计拒绝计数，达到阈值就停并交给主人；无 UI 的模式直接终止；核对模型每次调用的预算、超时、并发上限写进方案。

**10. 登记表只描述动作，不能替代 `execute` 里的四个执行分支**
- 问题：现有 `execute` 分支不只是权限检查，还包含任务启动、后台命令、`#ownerScoped` 的幂等/缓存、handle 校验、文件/编码工作流。方案说登记表的函数“返回这次动作的说明”，但没说它怎么带执行器。只靠说明无法删掉这些分支。
- 证据：`apps/agent-service/src/production-runtime-tools.ts:1084-1131`（`execute` 分支）、`:673-741`（`#ownerScoped` 幂等/结果缓存）、`:568-...`（`#taskStart`）、`:1159-1181`（`#executeCanonical`）。
- 建议：登记项必须同时绑定执行器、幂等键策略、结果缓存策略、可并行标记；或者明确“登记表只统一授权，执行分派保持现状”，不要承诺删掉全部分支。动态的 `authorized_<digest>`、`execution_task_start`、任务管理也要按“工具家族”登记，不能按工具名枚举。

### 中

**11. 事实代码白名单会漏掉现有代码**
- 问题：方案要加“事实代码表，校验时拒绝表外代码”。现有代码已经有 `external_model_disclosure`、`external_provider_disclosure`、`private_workspace_read` 等。白名单若只加新代码，现有 intent 会被拒绝。当前 `validateGovernedActionIntent` 只校验字段存在，不校验代码，所以这个新校验必须一次列全。
- 证据：`apps/agent-service/src/production-coding-workflow.ts:352`、`:356`；`apps/agent-service/src/production-file-read-workflow.ts:304`；`test/integration/governance-control-center.test.ts:152`；`packages/application/src/services/action-policy-service.ts:76-176`。
- 建议：白名单表同时登记已有代码、`minimumRisk` 和允许的 `source`；加“每个生产代码都在表里”的测试。

**12. 加“动作”闸门的消费者没有列全**
- 问题：不只是 `RULE_GATES` 和字段目录。还要改 `GATE_OUTCOMES`、`assertRuleShape`、`compileRuleExpression` 的环境、`RuleJudge` 的测试、规则导出、控制中心 `rules.type` 文案、决策链 `decision.chain.rule` 的 id 标签。少一处就会在运行或展示时炸。
- 证据：`packages/application/src/rules/field-catalog.ts:9`；`packages/application/src/rules/rule-book.ts:435-458`；`packages/application/src/rules/rule-expression.ts:43-45`；`packages/application/src/rules/rule-judge.ts:29-37`；`packages/application/test/rule-registry.unit.test.ts:35`；`apps/control-center/src/i18n/resources/zh-CN.ts` 的 `rules.type`、`decision.chain.rule`。
- 建议：把“动作闸门的消费者”做成清单逐项改，并加正向/反向规则用例、导出用例、页面用例。

**13. “要主人本人在场”没有进入 intent/审批的路径**
- 问题：`GovernedActionIntent` 没有这个字段，`action-policy-service` 只看到 `finalRisk`。方案说把 `:503` 改成“最高一档，或登记了要在场”，但权限服务拿不到登记表。需要把值传过去，并且让 gateway 合约、审批快照、控制中心都能接受。
- 证据：`packages/application/src/ports/authorization.ts:57-75`；`packages/application/src/services/action-policy-service.ts:503`；`packages/gateway-contracts/src/contracts-v2.ts:2220-2221`。
- 建议：用一条 `runtime` 事实（带明确代码和 `minimumRisk`）或新字段承载“要本人在场”，在 `createApproval` 时读它；同步改 gateway 合约/UI；加“HIGH + 要本人在场 → recentAuthenticationRequired”用例。

**14. “规则页能看到内置规则”目前做不到**
- 问题：`rule_list` / 规则页只列数据库里的主人规则；内置邮件规则只在决策链里出现。动作内置规则是代码数据，不在列表里。i18n 的 `rules.type` 也只有两种邮件类型。
- 证据：`apps/agent-service/src/production-owner-rules.ts` 的 `list`（只读 `rules` 表）；`apps/control-center/src/i18n/resources/zh-CN.ts` 的 `rules.title`、`rules.type`。
- 建议：增加内置规则的只读列表/接口，或明确“规则页只列主人规则，内置规则在决策链里看”；补 UI 和测试。

**15. “交给提议的那个端口”不是一个现成的端口**
- 问题：现有 `SuggestionService` 是“主动建议 → 创建 Task”的模型，`SuggestionTaskDraft` 需要 `capabilityRefs`、`goalRef` 等；苹果端设计里的“建议”表还是设计项。方案说“交给提议的那个端口”，但没有定义提醒/设备动作建议的记录、去重键、额度、过期和 UI。
- 证据：`packages/application/src/ports/proactivity.ts:12-20`、`:22-50`；`docs/execution/plans/2026-11-11-apple-device-body-plan.md:49`（建议表是第 3 步的实现项）。
- 建议：定义一个具体的“动作建议”记录/端口，或复用 `SuggestionService` 并加新 kind；写清去重键（建议用动作类别 + 规范化参数 + 目标）、每日额度、过期和“同一件事不重复提”的测试。

**16. 压缩摘要的来源语义自相矛盾**
- 问题：方案说“外来内容被压缩掉以后才清；压缩出来的摘要如果来自外来内容，摘要也算外来内容”。如果摘要算外来，那它本身又会阻止清空；摘要的摘要会无限延续。方案把“具体存在哪”留给编码线程，但语义没定。
- 证据：方案第 2 节；`.claude/rules/prompt-prefix.md:59-62`（压缩会改变历史）。
- 建议：明确两种选一：A）只要外部来源的摘要还在，就永远算外来（简单、保守，但要说清“不会自动清”）；B）给每条摘要记录它是否来自外来内容，只有所有外部来源条目（包括摘要）都被清掉才清。无论哪种，都要服务重启后还在，并加压缩/重启用例。

**17. `check:prompt-prefix` 覆盖不到真实的工具注册表**
- 问题：方案把“工具定义不变”寄托在 `npm run check:prompt-prefix`，但这个测试用的是测试自己写的假 `listAuthorized`，不是真实的 `ProductionRuntimeTools`。真实工具的字节和顺序变了，它不一定能发现。
- 证据：`packages/runtime-pi/test/prompt-prefix.compat.test.ts:189-207`、`:308-326`（假的 descriptors）；`.claude/rules/prompt-prefix.md:74`。
- 建议：新增一个用真实 `ProductionRuntimeTools.listAuthorized` 的 descriptor 字节/顺序快照，覆盖 coding、搜索、提醒、规则、任务、handle 等配置组合，纳入 `npm run check`。

**18. 反向用例里有一部分不是自动检查**
- 问题：第 1 步“去掉出口调用时，提醒不经权限引擎也能建”的用例必须失败——这是变异测试，不是普通 CI 断言。第 3 步“给核对的输入里出现工具结果文字时测试失败”只检查了精确文字，防不住“把外来文字抄进动作参数”。
- 证据：方案第 1 步、第 3 步的检查列。
- 建议：写成真正的反向用例：未登记工具不能被暴露/执行；提醒/规则没有授权时返回拒绝；动作参数里塞入注入文字不能导致核对批准；同一事实集合不同顺序指纹相同；审批恢复时用存下的事实；审批卡四项能渲染。

**19. 缺一张 I-73 式的“新值清单”**
- 问题：方案新增/修改的事实代码、动作类别、审批字段、规则闸门、内容来源标记、能力清单、建议键，没有逐个写“谁产生、谁使用、两端怎样校验、哪道检查守着”。这正是 I-73 的教训。
- 证据：`docs/incidents-and-gates.md:112`；苹果端设计第 17 节 `docs/execution/specs/2026-11-11-apple-device-body-design.md:694-707` 是现成模板。
- 建议：照第 17 节补一张表，逐项过两端校验。

## 二、推测 / 未核实

- **调度任务与线程历史共享时会被永久标记“有外来内容”**：`run-execution-source.ts:26` 允许 `threadId: null`，但没核实定时任务是否也会带同一线程的历史。如果是，上一轮网页内容会让后续所有定时任务的中风险动作都变成“提议”，直到压缩。需查定时任务的创建路径。
- **Meta “reliable means of validation” 是否接受一个概率分类器**：Meta 原文说“at a minimum requires supervision — via human-in-the-loop approval or another reliable means of validation”（https://ai.meta.com/blog/practical-ai-agent-security/）。Anthropic 自己报告真实过度主动动作的 FNR 是 17%。把“核对模型”当作“可靠校验”是一个判断，不是原文直接支持；至少应加置信度阈值和评测。
- **审批卡四项是否存在于未合并的设计**：当前检出的代码没有；如果另有设计稿，需要以代码为准补实现。
- **后台“建议”端口是否已有可复用实现**：现有 `SuggestionService` 是任务型，苹果端设计的建议表还是计划项。未核实是否已有别的端口。
- **第 4 步接 `device_action` 会改变老对话的请求开头**：苹果端设计 `docs/execution/specs/2026-11-11-apple-device-body-design.md:657` 已承认“加两个新工具，会让每个老对话重建一次请求开头”。方案第 6 节“工具定义、系统提示一个字不改”与第 4 步不一致；需要明确接受一次性重建。
- **`check:prompt-prefix` 的真实生产组合是否包含 reminders/rules**：测试里是假 descriptor；真实组合未核实。

## 三、侧重检查

- **错误路径**：`preflight` 拒绝会返回模型可见的 `policyBlockedText`（`pi-runtime-adapter.ts:2181-2191`）；`ASK` 会挂起、不返回模型结果（`:2226-2233`），符合 P4；恢复时用 `approvalMatchesIntent`/`semanticSnapshotHash` 校验（`action-policy-service.ts:331-335`）；过期在多个 await 后重查（`:308`、`:312`、`:354`）；自动复核异常只回到人工/拒绝，不会当成批准（`:463-490`）。这些是好的，方案应保留。
- **不可信输入**：工具结果、`external_event` payload、附件、MCP 记忆/规则、提醒写入的正式记忆、压缩摘要，是这次最容易被漏掉的五个入口。方案只覆盖了工具结果的一部分；`external_event`、附件、提醒记忆、摘要来源都需要补。
- **安全**：自动复核当前不把对话文字和参数给模型（`production-automatic-review.ts:71-73`、`:81-96`），并且只允许 `private`（`:114-115`）；方案要打破这个边界，必须重新做分类、披露、保留和预算。参数注入是核对模型的结构性缺口；规则变更和“要本人在场”的高风险动作不能被分类器绕过。
- **资源耗尽**：每个中风险动作一次核对模型调用，没有每日/每轮上限；被拒绝后可以无限重试；审批卡还有“允许全部”按 operation 分组（`apps/control-center/src/run-approval.ts:92-110`），可能批量批准多个目标。需要拒绝计数、核对预算、批量审批的目标校验。
- **不可撤销操作**：`DELETE`、`bash`、`CREDENTIAL_OR_ACCESS`、`PHYSICAL_SAFETY` 的基线分别是 `HIGH`/`CRITICAL`（`action-policy-service.ts:37-50`）；`bash` 在编码工作流里是 `irreversible`（`production-coding-workflow.ts:332-336`）。方案的高风险分支能覆盖，但“中等风险、可撤销”的条件必须严格按动作登记表，不能按工具名猜。
- **规则/文档/代码一致**：ADR 0209 决定 6、产品愿景第 58 行、苹果端设计第 7 节、`field-catalog.ts`、`RULE_TYPES`、审批 UI、I-73 都已核对；主要不一致是 `rule_set` 的 CRITICAL 分类、工具定义会变、审批卡四项不存在、`rules.type` 没有动作规则。

## 四、如果由我来定，我会怎样改这份方案

1. **先写“新值清单”**（照苹果端设计第 17 节），把事实代码、动作类别、规则闸门、审批字段、内容来源标记、能力清单、建议键逐个写清产生处/使用处/两端校验/自动检查。没有这张表不动工。
2. **第 1 步只做“登记表 + 统一授权出口”，不改变模型可见行为**：现有 descriptors 必须逐字节、逐顺序复现；加真实 `ProductionRuntimeTools.listAuthorized` 快照和 `check:prompt-prefix`；内置能力清单只加 `reminder.*`、`rule.*`、`memory.recall` 等，保留现有集成测试。**不要在这一步加主人可编辑的动作规则。**
3. **第 2 步做来源标记，但把范围补全**：`external_event` payload、附件、MCP 内容、提醒写入的正式记忆、压缩摘要都要有明确来源。记忆加来源位，避免“提醒洗白”。事实的 `minimumRisk` 设 `LOW`，由动作闸门判断；构造时按 code 排序。压缩语义二选一并写死。
4. **第 3 步只做内置动作规则的动作闸门**：新增 `RULE_GATES` 的 `action`、相应 outcomes、`GATE_OUTCOMES`、`assertRuleShape`、judge、导出、UI/i18n；内置规则带正反例。主人规则暂时不能写动作闸门。
5. **第 4 步先选 B（有外来内容的中风险一律让主人点）**，把 A 放到单独 ADR。若 Andy 坚持 A：新建独立核对端口，输入只含“主人原话 + 封闭动作类型 + 结构化参数”，对自由文本参数做来源检查；用现有 `confidenceThreshold`（默认 0.8）并加评测；加连续/累计拒绝上限；失败、超时、分类不满足一律出卡片。不要复用 `automatic-review` 的 exact-intent 委托。
6. **第 5 步补审批卡四项**（标题、正文预览、为什么问你、来源）和 i18n；内置规则在规则页的展示；后台建议的记录、去重、额度、过期。
7. **第 6 步接 `device_action`**，按苹果端设计承认“新工具会让老对话重建一次”，把这条写进 ADR 和 `check:prompt-prefix` 的预期，而不是宣称不改开头。
8. **`rule_set` 分类保持现状的“明确原话直接生效”**；只有外部内容引发的规则变更才 ASK。不要把规则变更塞进 `CREDENTIAL_OR_ACCESS`。

## 五、必答问题逐条回答

**1. 会不会改变模型已经见过的请求开头？包括系统提示、工具定义、历史消息、遮盖结果。发给模型的内容是不是仍然只在末尾追加，每轮会变的值是不是都在最后一条消息里？**

按方案本意是“只在末尾追加”，但按现在写出来的路径，有两处不满足：
- 加动作规则到 `rule_set` 会改 `type` 枚举或 `params`，工具定义在请求最前面，所有老对话重建一次（证据见上第 2 条）。
- 登记表如果改变 descriptors 的顺序/字节，或漏登记导致工具消失，也会改开头；`check:prompt-prefix` 用的是假 descriptor，覆盖不到。
- 第 4 步加 `device_action`/`perception_read` 也会让老对话重建一次，苹果端设计已承认。

除此之外：新事实只进 intent/审批，不进 prompt；拒绝/审批结果作为工具结果追加；主人意图核对是独立调用，不进历史；每轮会变的值（时间、本轮资料）仍应只在最后一条用户消息里。结论是“有条件满足”，条件必须写进方案：登记表逐字节复现现有 descriptors、动作规则不改 `rule_set` 定义、新事实不进系统提示/工具定义、`check:prompt-prefix` 用真实工具表并加快照。

**2. 会不会让同一段文字在不同请求里变成不同的字节（依赖前后文的遮盖、带时间的字段、无序的集合）？**

会，如果不做规范化：
- `deterministicFacts` 是数组，数组顺序参与 `actionIntentFingerprint`；用 Set/对象遍历顺序构造，同一语义会得到不同指纹。
- 审批卡片的标题/正文预览如果从实际参数生成并进入 `intentSnapshot` 或事实，就可能带时间、路径、随机 id，导致审批指纹对不上。
- 工具结果的“内容来源”标记必须执行时写一次并回放，不能每次发送时按当前上下文重算。
- 压缩摘要如果是模型生成的，来源判断必须确定；不能让“摘要算不算外来”依赖当次模型输出。

建议：事实按 `code` 排序；预览/标题/来源放在审批展示层，不进 `intentSnapshot` 或指纹；工具结果标记持久化；压缩来源规则二选一写死并加测试。

**3. 改动有没有对应的自动检查，反向用例是否真的会失败？**

不够。现有的：
- `check:prompt-prefix` 用假 descriptor，不能证明真实 `ProductionRuntimeTools` 的字节没变。
- 第 1 步“去掉出口调用时用例失败”是变异测试，不是 CI 自动断言。
- 第 3 步“输入里出现工具结果文字时测试失败”只覆盖精确文字，不覆盖“把外来文字抄进动作参数”。

需要补的自动检查：
- 真实 `ProductionRuntimeTools.listAuthorized` 的 descriptor 字节/顺序快照，覆盖所有配置组合。
- `rule_set` 工具定义快照 + prompt-prefix 门槛。
- 未登记工具不能暴露/执行；提醒/规则没有授权时拒绝。
- 同一事实集合不同插入顺序得到同一指纹。
- 审批恢复时用存下的事实，不按新上下文重算。
- 动作参数里塞入注入文字不能导致核对批准。
- 连续/累计拒绝达到阈值后停止。
- `external_event`/附件/提醒记忆的来源用例。
- 审批卡四项渲染；规则页内置规则展示。

**4. 改动产生或修改的每个值，每一个使用它的地方都能接受吗？**

需要逐项核对，当前至少这些不满足：
- **事实代码**：`computeActionRisk`、`automatic-review.prepareInput`、gateway `deterministicFactCodes`、治理页、决策链、`actionIntentFingerprint`、`validateGovernedActionIntent`。白名单必须包含现有 `external_model_disclosure`、`external_provider_disclosure`、`private_workspace_read` 等，否则现有 intent 会被拒。
- **`minimumRisk`/`source`**：`computeActionRisk` 会取最大值；设错会把 READ 抬成 MEDIUM。
- **“要本人在场”**：`GovernedActionIntent`、`GovernedApprovalRequest`、gateway 合约、控制中心目前都没有这个值；需要新字段或事实代码，并在 `createApproval` 读取。
- **内置能力的 `capabilityRef`/`capabilityVersion`/`operation`**：`CapabilityRegistryStorePort.get`、`ActionPolicyService.capabilityDenial`、`CapabilityHandleService`、gateway 都要接受；内置清单要有 `capability.v2` 形状、`healthy`、版本、operations、active lifecycle。
- **规则闸门 `"action"`**：`RULE_GATES`、`RULE_FIELD_CATALOG`、环境、`GATE_OUTCOMES`、`assertRuleShape`、`RuleJudge`、导出、UI/i18n、`rule-registry` 测试都要接受。
- **`rule_set` 类型/参数**：工具定义、`parseOwnerRuleParameters`、规则存储/历史、规则页、MCP `propose_rule` 都要接受；改枚举会改请求开头。
- **内容来源标记**：`RuntimeToolSettledResult`、`pi-runtime-adapter`、`#ownerScoped`、历史/对话状态、压缩/删除、重启恢复都要接受；现在只有 `contentClassification`，没有来源字段。
- **审批卡四项**：gateway 合约、控制中心、i18n 目前都没有；新工具不能“完全不改审批代码”。
- **后台建议键**：`SuggestionService`/苹果端建议表目前不是这个形状；去重键、额度、过期、UI 都要定义。

一句话：方案的核心方向可以保留，但上面这些“高”问题必须先修；尤其不要把 `rule_set` 归成 CRITICAL、不要把动作规则塞进现有 `rule_set` 定义、不要直接复用自动复核端口、不要在没有来源标记的记忆/事件/附件上放行中风险动作。
