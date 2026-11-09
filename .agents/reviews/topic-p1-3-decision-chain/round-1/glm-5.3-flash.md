# P1-3 方案：决策记录的「它从哪来」完整链

## 一、方案前提（读代码或来源证实的）

1. **决策行和 inputs 已经写全（Gmail/proactive 一种）**：`proactive-mail-check-service.ts:1294-1308` 组装 `inputs`（ruleIds 去重排序、floorHits、memoryIds、usedMemoryIds、tentativeMemoryIds、memoryByMail、memoryRecall、relatedByMail、relatedStats、relatedFailedSteps 排序），经 `sqlite-proactive-operations.ts:651-655` 写进 `decision_ledger`（kind='proactive'）。原话：「`ruleIds: [...new Set(Object.values(input.floorHits).flat())].sort()`」。
2. **记忆链零件已存在**：`memory.overview.snapshot` 每条记忆带 `sourceThreadId、sourceMessageId、sourceRefs、history（含 quote 原话）、supersededBy、status、inference、tentative`（`production-memory-control.ts:387-411`）；推论链已有 `readBasisChain`（`memory-consolidation.ts:71`）和现成网关查询 `memory.basis.read` → `memory.basis.snapshot`（`production-memory-control.ts:278-320`，带 `BASIS_NODES_SHOWN` 截断和 `complete` 标志），节点里已有 `decisionRecordId`，目前没有界面使用。
3. **模型输入输出已加密存库**：迁移 0070 `decision_ledger_payloads`（`decision_id` 外键 CASCADE、`sequence`、`role`、`payload_ref`），读取端口 `readDecisionPayloads`（`proactive-checks.ts:317`），服务端解密入口 `readDecisionModelIo`（`production-proactive.ts:218-229`，经 `seal`/`model.readOutput`）。当前无界面使用。
4. **规则只有代码常量，没有登记册**：三条地板规则 id 在 `proactive-rules.ts:29-33`，出处是 ADR 0106 决定第 4 条（`docs/adr/0106:45`，原话「**地板规则。**……命中以下任一条就算命中地板：发件人在 Andy 维护的“重要发件人名单”里……」）。
5. **`ruleIds` 字段有两个语义**：Gmail 写地板规则 id；`memory_candidate` 把 `reasonCode`（如 `confidence_below_threshold`）塞进 `ruleIds`（`automatic-memory-service.ts:572`），并有测试锁住这个形状（`automatic-memory-golden.test.ts:516`）。写入校验只查 id 格式（`sqlite-decision-ledger-operations.ts:59`）。
6. **网关派发点已就位**：查询按 `query.type.startsWith("proactive.")` 自动派给 proactiveControl（`production-approval-gateway.ts:110`），UI 端按 `installedGatewayV2Operations` 做能力门（`proactive.ts:88`）。
7. **只追加规则与 I-73**：`prompt-prefix.md` 规则 4/5（原话「**已经发给过模型的内容，不得改动、重排或删除，只能在末尾追加**」）和 I-73 的教训（原话「双模型复核只看了 diff，没问『清单里的 id 能通过后端校验吗』」，`docs/incidents-and-gates.md:112`）。
8. **界面约束**：设计基线明文禁止「新增堆积内部运行信息的通用面板或页面。有特定用途的面板……在用户批准其原型并另存为新基线版本后，可以添加」（`web-design-baselines.md:9`）；记忆页抽屉模式是 `aside role="dialog" + backdrop + Escape 关闭`（`memory-page.tsx:431-453`）；「决策记录」是 glossary 第 3 条的规范名（`docs/glossary.md:37`）。

**推测（未核实）**：`memoryByMail` 等 Map 展开进 JSON 时的键序取决于邮件处理顺序，未核实是否确定；`npm run check` 里是否已有合约一致性检查脚本（只知道有 `check:prompt-prefix` 和 `check:model-ref-contract` 的先例，见 `prompt-prefix.md:74`、I-73 记录）。

---

## 二、方案本身

### 1. 数据从哪读（全部复用，不重算、不加迁移）

| 链的环节 | 来源 | 取数点 |
|---|---|---|
| 决策行、inputs、评价 | `decision_ledger`（含 owner_rating/rated_at） | 按 decisionId 单查（新增读操作） |
| 命中的规则 | `inputs.ruleIds` + `floorHits` | 规则登记册（新增，见 3） |
| 注入的记忆（原话/来源/状态/被谁取代） | `inputs.memoryIds / usedMemoryIds / tentativeMemoryIds / memoryByMail` → 记忆库单条读 + `earliestSourceMessage` + `quoteRef` 解密 | 复用 `production-memory-control.ts:340-411` 的组装路径，抽成可单查的内部方法 |
| 推论链 | `consolidation.store.readBasisChain` | 现成 |
| 模型输入输出 | `decision_ledger_payloads` → `readDecisionPayloads` → 解密 | 复用 `readDecisionModelIo` 路径 |
| Andy 的评价/信号 | 决策行 + `decision_signals`（迁移 0080） | 现成 |

注意：已被合并/删除的记忆（`deletion_pending`/`deleted_verified`）不在 overview 里（`production-memory-control.ts:369` 过滤），这类节点只给 memoryId + 状态，正文显示「无记录」。

### 2. 网关接口（两个查询，都走统一网关出口）

- **`proactive.decision.trace.read`**（payload: `{ decisionId: machineString }`）→ **`proactive.decision.trace.snapshot`**，返回自包含的链：
  ```
  decision: { id, kind, decidedAt, verdict, reasonCode, ownerRating, ratedAt }
  segments:
    rules:      { present, absentReason?, items: [{ ruleId, registered, docAnchor }] }
    memories:   { present, absentReason?, injectedCount, usedCount,
                  items: [{ memoryId, text?, status, supersededBy, tentative,
                            sourceThreadId?, sourceMessageId?, quote?, inference, used }] }
    inference:  { present, absentReason?, nodes[], complete }   // 复用 memory.basis.snapshot 节点形状
    modelIo:    { present, absentReason?, entries: [{ sequence, role }] }   // 不带正文
  ```
- **`proactive.decision.payload.read`**（payload: `{ decisionId, sequence }`）→ `{ role, text }`，按需解密单段正文。提示词含整批邮件（单封 16000 字、每批 64000 字上限，见设计规格 `2026-10-29-proactive-loop-v1-gmail-design.md:87`），一次全返会让 snapshot 过重；正文是抽屉里点开才取的第二级内容。
- 三处登记（对应 I-73 的教训，两端一起改）：contracts-v2 的 operation 联合 + snapshot schema（`contracts-v2.ts:35-64、2365-2394` 模式）；`production-proactive.ts:36-44` 的 `installedGatewayV2Operations`；control-center 的能力门（`proactive.ts:88` 模式）。schema 反向用例：非法 decisionId、未知 operation 必须被拒。
- 不改任何提示词，`packages/prompt-catalog` 无需登记。

### 3. 规则出处怎么表示：登记册 + 前缀约定

- 在 `packages/application/src/services/` 新增静态登记册（例如 `proactive-rule-registry.ts`）：`{ floor_important_sender, floor_public_domain, floor_money_words }` → 各带稳定 id、文档锚（`docs/adr/0106` 决定第 4 条）和 i18n 键。规则是代码常量，登记册也做成代码常量并纳入单测，不进数据库（避免迁移）。
- **语义切分**：约定 `inputs.ruleIds` 里只有**登记册里的规则 id**；`reasonCode` 是机器原因码。`memory_candidate` 现状（reasonCode 进 ruleIds）不改历史数据：trace 读取时按「是否在登记册」区分，不在册的显示「未登记（原因码）」。约定文档写明：新写入方不得再把 reasonCode 塞进 ruleIds，新规则 id 必须先登记。
- **自动检查**：在 `sqlite-decision-ledger-operations.ts:59` 的 append 校验处加一条「凡以 `floor_` 开头的 ruleIds 值必须在登记册里」，反向用例写一个 `floor_not_registered` 必须被拒。memory_candidate 的 `confidence_below_threshold` 不带前缀，不受影响，`automatic-memory-golden.test.ts:516` 继续通过。

### 4. 「无记录」的定义（可验证）

每个链段必渲染以下四种状态之一，不允许空白：

| 状态 | 判据（机器可判） |
|---|---|
| 有内容 | `present=true` 且 items 非空 |
| 无记录（本类型不写） | 决策 kind 按约定文档不写该字段（如 consolidation 不写 modelIo） |
| 无记录（数据缺失） | 字段约定要写但实际为空（如 memoryIds 里的记忆已被删除） |
| 已清除 | Andy 清过记录或断开 Gmail，`decision_ledger` 行已删（`sqlite-proactive-operations.ts:497`）——入口行都没了，抽屉自然打不开；payloads 单段被清理时该 sequence 显示此态 |

`absentReason` 是新增枚举值，产生端是 trace 服务，使用端只有 UI 的 i18n 映射，三语各一条，两端核对进测试。

### 5. 抽屉展示（提醒页，复用记忆页抽屉样式）

入口：`ProactiveDecisionLog` 每行（`proactive-reminders.tsx:587`）加「为什么」菜单项 → 抽屉（`aside role="dialog"` + backdrop + Escape，样式复用 `memory-drawer` 类，手机底部弹出）。内容自上而下固定五段，**只展示这条链**：

1. **这次判断**：verdict、时间、原因码、Andy 的评价（复用现有 `RatingChoices`）。
2. **命中规则**：规则名（i18n）+ 出处链接（ADR 0106 第 4 条）；`floor_important_sender` 注明「取决于你在设置里维护的重要发件人」；`floorHits` 按 messageId 列出哪封邮件命中哪条。
3. **注入的记忆**：每条显示原话（quote/正文）、来源（复用 `memory-source.ts` 的 `memorySourceState` 分类，可跳到来源对话）、当前状态（active/archived/trashed）、被谁取代（supersededBy）、是否推论（inference）。顶部数字带定义：「注入 N 条」（`inputs.memoryIds`）/「回答用到 M 条」（`usedMemoryIds`＝模型回答里引用且在注入集内的条数，判据见 `proactive-mail-check-service.ts:465、1127-1128`）。
4. **推论链**：`memory.basis.snapshot` 的节点树，`complete=false` 时显示「未完整展示」。
5. **模型调用记录**：每段 `sequence + role` 一行，点开经第二个查询取正文；正文顶部固定标注「这是发给模型时的版本，敏感信息已遮盖」——这是容易被忽略的点：Andy 看到的和模型看到的不一定逐字相同，不标注会造成误解。

所有新文案登记三语 message-ids；渲染前对 `memoryByMail`/`floorHits` 等按 key 排序，保证渲染确定。

### 6. 「决策记录写入约定」文档（进仓库，建议 `docs/decision-record-write-conventions.md`）

内容清单：六种 kind 的总表（必写/可写/不写哪些 DecisionInputs 字段）；id 语法（memoryIds 必须是真实记忆 id、ruleIds 必须已登记、sourceIds 为来源消息 id）；`ruleIds` 与 `reasonCode` 分工（新写入禁塞 reasonCode）；`memoryByMail`/`relatedByMail` 的键为 messageId；payload 写入要求（role/sequence 与 0070 表一致）；「无记录」四种状态与 `absentReason` 枚举；新 kind 接入 checklist（含「每个新字段要过 contracts 校验并在两端登记」——把 I-73 的教训写进流程）。

### 7. 测试设计

- **集成（真实 SQLite，仿 `proactive-mail-check.test.ts`）**：跑一次 Gmail 检查（ScriptedModelPort 注入结果）→ `proactive.decision.trace.read` 断言五段齐全：规则 id 与 `floorHits` 一致、记忆带 sourceMessageId 和 quote、basis 链节点含 decisionRecordId、payloads 列出 sequence/role、评价可读。
- **反向用例**：① 记忆被合并删除后链上该节点显示「无记录」；② 无 payloads 的决策行 modelIo 段显示「无记录」；③ append 一个未登记的 `floor_*` id 必须被 append 校验拒绝（且先验证该校验存在前这个用例失败）；④ contracts schema 拒非法 payload。
- **UI（真实浏览器，仿 `memory-source-browser.test.ts`）**：正向——点「为什么」抽屉五段都非空白；反向——把 inputs 里塞一个未登记 ruleId，断言显示「未登记」而非空白。
- **门**：仿 I-73 的 `check:model-ref-contract` 思路（contracts-v2 与安装列表一致性），把「contracts-v2 里每个 proactive.* operation 都出现在 installedGatewayV2Operations 且反之」做成小检查（未核实 npm run check 现有脚本清单，实施时对齐）。

---

## 三、业界做法（一手来源）

- **LangSmith 的 run/trace/feedback 模型**：每次模型调用、工具调用、检索都是一个 run（span），trace 是 run 树；「You can attach user feedback to ANY intermediate run (span) of the trace, not just the root span」（反馈可挂在链上任一环）；详情侧栏分 Trajectory/Turns/Details 三视图，反馈绑定 run id。这与本方案「决策行=根，规则/记忆/推论/模型IO=分段，评价绑根」同构。
  https://docs.langchain.com/langsmith/observability-concepts 、https://docs.langchain.com/langsmith/view-traces 、https://docs.langchain.com/langsmith/annotate-traces-inline 、https://docs.langchain.com/langsmith/run-data-format
- **OpenTelemetry GenAI 语义约定**：把检索（retrieval span）、注入记忆（`gen_ai.memory.records`、`gen_ai.memory.record.id`）、模型输入输出（`gen_ai.input.messages_ref`、`gen_ai.output.messages`）、人评（`gen_ai.evaluation.score.label/value`）都定义为带稳定属性的记录——支持「记忆注入和评价都是一等可追溯对象」的设计。
  https://github.com/open-telemetry/semantic-conventions-genai/blob/main/docs/gen-ai/gen-ai-spans.md 、https://github.com/open-telemetry/semantic-conventions-genai/blob/main/docs/registry/attributes/gen-ai.md

---

## 四、考虑过但不选的做法

1. **前端拼装（不新增查询）**：UI 拿 overview + `memory.overview` + `memory.basis.read` 自己拼。否——payloads 解密在服务端（seal），前端拿不到；三次请求；拼链逻辑漏进 UI，违反「抽屉只展示这条链」。
2. **把链预合成进 `proactive.overview.snapshot`**：每次 overview 都要解密 + 走推论链，代价大、overview 变重；链是点开才看的低频内容。否。
3. **新建 trace 表/迁移**：数据全在，纯读取重组即可；材料明说不想加迁移。否。
4. **用 decision_ledger 现有 `list()` 按时间扫**：面向校准采样（since/limit），不是按 id 单查；否。
5. **立即禁止 memory_candidate 把 reasonCode 写进 ruleIds**：会改已锁形状的测试和历史数据语义。改为读取端按登记册区分 + 文档约定新写入停用。取舍见下。

---

## 五、风险与反例

- **风险：展示「发给模型的版本」被当成原文。** 模型 IO 是遮盖后的字节（ADR 0146），必须标注（方案已含）。
- **风险：链上记忆是「当时的」还是「现在的」。** overview 给的是当前状态（可能已被取代/删除）；方案如实显示当前 status/supersededBy，被删的显示「无记录」——语义写进约定文档，避免 Andy 误以为看到决策当时的快照。
- **反例（必须失败才算做完）**：未登记 `floor_*` 写入被拒；schema 拒非法 decisionId；缺环渲染「无记录」而非空白。
- **反例风险：`inputs` JSON 键序不确定**（`memoryByMail` 来自 Map 展开）——展示端排序规避；若将来把 inputs 用于逐字节比对需另议（推测项，已标注）。

---

## 六、需要人拍板的取舍

1. modelIo 正文**按需取**（第二查询）还是一次全返回（实现更简单但 snapshot 可能上百 KB）。
2. 抽屉入口**只放提醒检查记录行**（本次范围），dailyReview 里 memory_candidate 等行是否也要能点——建议下一块再做。
3. memory_candidate 的 reasonCode-as-ruleIds：**容忍显示**还是立即禁止写入（改数据形状和两个测试）。
4. 规则登记册放 `packages/application`（我的建议）还是 `gateway-contracts`。

---

## 七、逐条回答必答问题

1. **会不会改变模型已经见过的请求开头？** 不会。本方案是纯读取端：一个网关查询、UI 抽屉、一份文档，不组装、不修改任何发给模型的请求（系统提示、工具定义、历史、遮盖全不碰），没有新的模型调用。发给模型的内容仍只追加、每轮变化值仍在最后一条消息（现状由 `check:prompt-prefix` 门守住，`prompt-prefix.md:74`）。若将来为此新增模型调用，必须走统一出口且遵守规则 15（固定在前、变化在后）。
2. **同一段文字会不会在不同请求里变成不同字节？** 不会。本方案不产生任何发给模型的字节；展示层对 Map 展开 inputs 时按 key 排序渲染，列表顺序固定（呼应规则 10）。
3. **有没有对应的自动检查，反向用例会不会真失败？** 有，且设计为先写反向用例：append 校验（未登记 floor id 被拒）、contracts schema 反向用例、UI 缺环/未登记 id 反向用例（真实浏览器）。`npm run check:prompt-prefix` 不受影响继续覆盖请求侧。
4. **每个值的产生端和使用端都核对了吗？** decisionId：产生于 `ids.next("proactive-decision")`（`proactive-mail-check-service.ts:1282`），使用端 `proactive.decision.rate` 同为 `machineString`（`contracts-v2.ts:535-538`），新查询同规则；memoryId：领域 `MemoryId`，只读展示、不回写，无校验风险；ruleIds：产生于 `FLOOR_RULE_IDS`（`proactive-rules.ts:29`），新登记册与 append 校验两端闭环，memory_candidate 的 reasonCode 不撞 `floor_` 前缀；新 operation 名：contracts-v2、installedGatewayV2Operations、UI 能力门三处同改并加一致性检查（I-73 的教训落实）；absentReason：产生端 trace 服务，使用端仅 UI i18n，两端进测试；`decision_ledger_payloads`：只读，CASCADE 清理路径（`sqlite-proactive-operations.ts:417、497`）已核对，payload 段被清时显示「已清除」。
