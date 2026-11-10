Pi 侧前提都已核实。现在核对方案引用的三个外部来源（P11 Claude Code、P12 Codex、P13 OpenAI Agents SDK）。
# 审核结论：硬规则接入 Himawari 方案（v1）

## 侧重检查（先列，因为下面多条由此引出）

我走的流程：**主人在网页发一句话 → 组装请求（冻结头 + 最后一条消息）→ Pi 适配器 → 模型调 `reminder_set` 失败却回答“已设好” → 回答展示**。

- 现有覆盖：提示词文字快照（`prompt-rendering-golden`）、事件映射与并行审批（`pi-runtime-adapter.compat.test.ts`）、只追加门槛（`packages/runtime-pi/test/prompt-prefix.compat.test.ts`，带反向用例）。
- 本方案新增、且没有测试归属的路径：`himawari-rules` 扩展注册、证据账本写入（`tool_result`）、`claim_requires_effect` 检查（`agent_before_settle`）、纠正消息追加、决策记录写 `ruleIds`、展示层“未验证”标记。方案 §7 只写“类型测试+内联示例+Pi 集成测试”，没有逐条点名，也没有接 `check:prompt-prefix` 和 I-05 第 0 层测试声明。
- 文档一致性：`docs/execution/specs/2026-11-09-decision-record-write-convention.md` 和 ADR 0195 都引用 `DECISION_RULE_CATALOG`，方案没列要同步改的文档。

## 证实的发现（严重度从高到低）

**1.【高】`claim_requires_effect` / `evidence_before_conclusion` 与方案自己的前提矛盾。**
问题：§3 说“只登记程序不靠模型就能判对错的类型”，但这两个类型都要先从自然语言回答里认出“说了已设好”“对某类问题下结论了”。方案没写检测手段：用关键词表，就是重蹈 F.5 金钱词表写死在代码、两处不一致的覆辙（F.1/F.5 正是本方案要根治的病）；用模型判断，违反前提 P1。
证据：`docs/agent-rulebook-inventory.md` F.2/F.5；方案 §3。
建议：第一批把这两个类型收窄成程序能完整判定的变体（例如“回答里出现‘已设好/已发送’字样且本轮无对应成功工具结果”先定义为可配置短语匹配，作为**独立类型**带自己的正反测试立项），或者承认检测是概率的、把它标成“抬升/仅告知”严格度而不是“拦下”。

**2.【高】§4 的出错处理与 Pi 实际行为不符，两处。**
(a) Pi 文档原话："Extension errors are logged, agent continues"、"`tool_call` errors block the tool (fail-safe)"（https://pi.dev/docs/latest/extensions ，Error Handling 一节）。即只有 `tool_call` 出错能机械拦下；`agent_before_settle`、`tool_result` 出错时 Pi 照样继续，方案说“包一层……默认当作违规，不放行”，但没说非 `tool_call` 事件“不放行”具体是什么动作——没有手段就不该这么写。
(b) "a blocked or aborted call skips execution and tool_result. Each of these still gets tool_execution_end with an error result"（同页 tool_call 一节）。被拦的调用**不产生 `tool_result`**，方案说“拦下写进 tool_result”落空；观察每个落定调用（含被拦的）要用 `tool_execution_end`。
建议：逐事件写明出错动作——`tool_call`：block（Pi 自带 fail-safe）；`tool_result`：账本记“未知”，`evidence`/`claim` 检查对“未知”按该规则出错策略处理；`agent_before_settle`：检查出错只能在展示层标“未验证”+写日志，做不到拦截。

**3.【中】新路径没有接进现成的只追加门槛（必答 3 的漏洞）。**
证据：`.claude/rules/prompt-prefix.md:74`——`check:prompt-prefix` 用真适配器跑多轮对话、逐字节比对、带反向用例。方案新增三处改发给模型内容的路径（规则块进最后一条消息、`agent_before_settle` 追加纠正、block reason），§7 全没提它。
建议：§7 加一条：`check:prompt-prefix` 注册新扩展，加“第 2 轮规则集变化”“违规→追加纠正→继续”用例；反向用例验证“把规则块塞进系统提示必须失败”。同时按 I-05 声明第 0 层相关测试。

**4.【中】I-73 教训只落了一半：登记册 id 的消费端有四处，方案只写了一处。**
证据：I-73（incidents-and-gates.md:112）根因原话“双模型复核只看了 diff，没问『清单里的 id 能通过后端校验吗』”。本次 `ruleIds` 的消费端：(a) 写入约定明文“规则编号必须登记在 `DECISION_RULE_CATALOG`；未登记的编号只会显示『未登记的规则』”（decision-record-write-convention.md:39,52）；(b) 渲染端 `production-decision-chain.ts:104-106` 经 `decisionRuleDefinition` 校验；(c) 存储端两套校验：`sqlite-decision-ledger-operations.ts:40-47`（1–256 字符、去重）和 `sqlite-proactive-operations.ts:594`；(d) `packages/gateway-contracts/src/contracts-v2.ts:1104` 的 `boundedString(256)`。存储端不查登记册，渲染端查——两端都要动。
建议：`check:rule-registry` 增加一项“登记册产出的每个编号能通过全部消费端校验”，并同步改写入约定文档。

**5.【中】提示词文字改为登记册生成，会触发一次已知的前缀变化，方案没提。**
证据：`prompt-prefix.md:53`——提示词目录里 ≥24 字符的固定文字豁免遮盖检查，清单“在一个构建内固定”；“以后改了提示词文字，老对话里冻结的旧文字不再在清单里……那个对话的请求开头会变一次”。§3 把 S-8、S-9 改为从登记册参数生成后，这段文字变成按外来内容检查的数据。
建议：§5/§6 写明这次一次性缓存失效，按规则 11 既有先例取得 Andy 同意。

**6.【中】迁移号 0086 可能被占。** 仓库最大迁移号是 0085，但盘点写明“其他线程正在改相关代码（规则登记册……）”（agent-rulebook-inventory.md:32）。动工时重取号。

**7.【低】C-5 设置页没有过渡方案（必答 4 漏项）。** 静默时段、重要发件人现在由设置页写入 `proactive_settings`（C-5、PG-7）；§2 说迁成登记册，没写双源并存期间谁权威、写入口怎么改——这正是 F.1 要根治的“两处各写一份”。ADR 0163 也明确把这块留给机制方案。

**8.【低】`tool_call` 挂 `evidence` 检查语义不通。** 拦下一个工具调用不能逼模型“先读线程”；缺证据该拦的是下结论（`agent_before_settle`），`tool_call` 适合 `tool_gate` 和 `limit`。§3 说“每个类型带适用的钩子”，正文却把 evidence 挂到了 `tool_call`，应给一张类型→钩子映射表。

**9.【低】纠正流程的展示没写完整。** 第一次违规时错答已流出，纠正后再答一次，用户看到“错答→纠正→对答”；方案只写了“再违规才标记”。第一次也应标记/折叠，否则“必定执行”在用户眼里不成立。

**判断正确、应保留的**：§4 “并行工具调用依次预检，所以限额要数据库原子预留”有依据——Pi 文档："sibling tool calls from the same assistant message are preflighted sequentially, then executed concurrently. `tool_call` is not guaranteed to see sibling tool results"，I-29 是同类竞态的实录。§9 不硬化 S-21/S-22/S-15/S-24 的取舍与业界一致（输出守卫只能事后检查，见 OpenAI Agents SDK 文档）。

## 推测（未核实）

- `claim`/`evidence` 若用关键词检测，必然新增写死的表，F.1/F.5 重演（取决于实现）。
- 回放 30 天、确认卡数字只在 UI/离线用，不影响请求字节（偏安全的推测）。
- P12 引用的 Codex 页面我核对过（match/not_match “inline unit tests”、加载时校验、“最严命中获胜”：`forbidden > prompt > allow`），P13 核对过（input/output guardrail 只在链首/链尾运行，hosted 工具不走 tool guardrail）；与方案转述一致。

## 前提核对总评

P1–P14 全部找到一手出处且转述准确（Pi：https://pi.dev/docs/latest/extensions、https://github.com/earendil-works/pi/blob/main/README.md "Pi does not include a built-in permission system"；Claude Code：https://code.claude.com/docs/en/permissions "PreToolUse hook decisions don't bypass permission rules"、deny>ask>allow；Codex：https://learn.chatgpt.com/docs/agent-configuration/rules；Agents SDK：https://openai.github.io/openai-agents-python/ref/agent/）。唯一实质偏差是 P6 推出的“包一层就能不放行”（发现 2）。

## 如果由我来定

1. 保留总体架构（登记册+三执行面+决策记录），但 §3 第一批只做纯程序可判定的类型：`floor`/`suppress`/`window`/`limit`/`tool_gate`；`claim_requires_effect` 拆出“短语检测器”作为独立类型单独立项，`evidence_before_conclusion` 移到 `agent_before_settle` 且第一批只做“没读过就拦回答”的窄版。
2. §4 改成类型→钩子→出错动作的三列映射表，删掉“默认不放行”的笼统话；拦下观察改用 `tool_execution_end`。
3. §7 明确：`check:prompt-prefix` 注册新扩展并加用例+反向用例、I-05 第 0 层声明、`check:rule-registry` 加“编号过全部消费端校验”一项、同步改写入约定文档。
4. §8-0 补设置页双源过渡；迁移号重取。

## 必答问题

1. **会不会改请求开头？** 不改，前提是按建议修正：规则块、block reason、纠正消息都只在末尾追加（Pi 文档确认 `agent_before_settle` 的条目“appended in list order”、`continue: true` 只补一个请求）；不用 `context`/`context_with_system`/`before_agent_start` 改历史的决定正确。例外要写明：S-8/S-9 生成化会让老对话前缀变一次（发现 5）。
2. **同一段文字会不会变字节？** 有两个必须显式处理：规则短列表要按规则编号排序、不含时间戳（规则 10）；生成文字脱离固定文字清单后的遮盖语义变化（规则 11）。回放数字只在 UI，不进请求。
3. **有自动检查吗？反向用例会失败吗？** 方案新增的 `check:rule-registry` 方向对，但没写自身的反向自检；现成的 `check:prompt-prefix` 没被接上——这是方案 §7 的真空档（发现 3、4）。
4. **每个新值两端都核了吗？** 规则编号、版本号、迁移、清单项、SKILL.md 各有消费端；方案只核了 `DECISION_RULE_CATALOG` 一端，写入约定文档、渲染端、两个存储校验、gateway 合约四端未列（发现 4、7），正是 I-73 的模式。
