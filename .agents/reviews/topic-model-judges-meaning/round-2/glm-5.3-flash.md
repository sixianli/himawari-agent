现在我来基于原始来源核实这两个外部声明（P9）。
# 线程方案 v1 审核报告（独立复核，侧重：测试覆盖、文档/规则一致性、普通流程走查）

## 侧重检查

我走了三条最普通的使用流程：

**流程 A：网页导入记忆文件（方案②）**
入口 `apps/control-center/src/components/memory-page.tsx`（浏览器）→ `parseMemoryText`/`guessCategory`（`apps/control-center/src/memory-import.ts:29-49`，在浏览器里跑）→ `memory.import.commit`（`apps/control-center/src/memory.ts:224-238`）→ 合约校验 `packages/gateway-contracts/src/contracts-v2.ts:1506-1527`。**结论：分类今天 100% 发生在浏览器；服务端分类是一条全新路径，现在没有任何测试覆盖它（它还不存在），且合约的 `category: enumeration(MEMORY_CATEGORY_NAMES)`（contracts-v2.ts:1481、1509）不收“自动”或 null。** 手动添加同理：`AddForm`（memory-page.tsx:2208-2217）在浏览器里算 category 和 sensitive，发 `memory.create`（合约 contracts-v2.ts:1477-1485，同样只收枚举）。

**流程 B：待确认规矩的确认（方案④）**
主人消息 → `MEMORY_CAPTURE` 模型调用 → `parseMemoryCandidates`（`apps/agent-service/src/production-memory-capture.ts:259`，**同步纯函数**）→ `confirmsTentative` 判定（:358-369，`quoteRelatesToMemory` 在 :171-177）。测试只有 `apps/agent-service/test/production-memory-evidence.unit.test.ts:201-205` 覆盖词表函数本身。**结论：插一次裁判模型调用必须把 capture 解析流程改成两段异步；词表函数的测试整体作废，新裁判没有对应测试。**

**流程 C：recall 工具查记忆（方案①）**
模型调 `recall` → `argumentsOf` 校验（production-memory-recall.ts:92-119）→ 显式 from/to 优先、否则 `parseTimeScope` 兜底（:159-184）→ 搜索。`parseTimeScope` 不只这一处用：`packages/memory-engine/src/hybrid-memory-provider.ts:166`（无 scope 时的兜底，consolidation 搜索经 `service-main.ts:2606-2612` 走这里）、`test/integration/memory-evaluation.test.ts:505`、`memory-episodes.test.ts:318`（两个评测装置）。**结论：方案只写了对话路径和“自动召回”，漏了这 3 处使用者；删包级函数会直接编译失败或让评测装置失真。**

**文档一致性抽查**：`docs/agent-rulebook-inventory.md:72`（H-3）、`docs/adr/0209` §4、`docs/adr/0147` §5 都把 `floor_money_words` 写成硬规则词表，配套 `rule-book-legacy-equivalence.unit.test.ts:31` 和 `rule-ref` 版本测试。方案对这条标“待 Andy 定”，态度对，但没列改动时要同步的文档和测试。P1 引用的 `/mnt/project-files/project-health-check/intent-keywords.md` 不在仓库里——**未核实**。

---

## 按严重度排列的问题

### 高

**H-1【证实】② 的“自动”哨兵过不了现有合约校验——I-73 同款事故的复刻条件。**
证据：`contracts-v2.ts:1481` `category: enumeration(MEMORY_CATEGORY_NAMES)`、`:1509`（import.commit）、`:1486-1493`（category.set）全部只收十个枚举值，没有 null/“auto”。I-73 的教训原文（`docs/incidents-and-gates.md:112`）：“双模型复核只看了 diff，没问『清单里的 id 能通过后端校验吗』”。方案②说“下拉仍可手改、默认自动、保存时服务端分类”，但没说 `memory.create` 的 payload 里发送什么值。
建议：要么客户端在下拉未选时发送前先解析（保留现合约），要么扩合约允许 `category: null` 并在服务端解析后落枚举；两种都要写明产生端（前端）和使用端（合约+服务端 memory control）两端的校验，并加一条“发送值必过合约”的测试门槛。

**H-2【证实】整份方案没有写任何自动检查和门槛，反向用例全部是人工演示场景。**
证据：方案里五处“证明/反向”都是“要花钱先问”“两个用例”这类手工验收；而仓库的既有做法是每个改动落门槛：新提示词必须进 prompt-catalog（`docs/lessons.md:671`，PR #282 因提示词文字在目录外被 `check:prompt-catalog` 拦下）、新模型出口必须登记 `check:egress-redaction`（`docs/adr/0167` §72）、改产品源码要 Layer-0 声明（`.agents/instructions/test-trigger-timing.md:8`）、提示前缀有 `check:prompt-prefix`（`.claude/rules/prompt-prefix.md:74`）。
建议：方案每项补一列“门槛”：① TOOL_RECALL 文字改动 → prompt-catalog 门槛 + `time-scope` 相关 3 处测试改写 + Layer-0 声明；② → contracts 测试 + 新增“分类失败→敏感不勾选”的单测反向用例；④⑤⑥ → 解析函数的单测反向用例 + egress-redaction 登记 + Layer-0 声明。反向用例必须写成“改动前的代码跑它会失败”的断言，不是演示脚本。

**H-3【证实】⑥ 单号抽取丢了现正则提供的两条程序保证，且成本上限插入点会破。**
证据：现 `extractReferenceIds`（`packages/platform-node/src/gmail-related.ts:15-31`）保证 (a) 值域 `[A-Z0-9-]{8,39}`（:25），(b) 前面有 order/invoice/注文/予約 等上下文关键词（:15）。模型抽取 + 逐字核对只保证 (a′) 值在原文出现——**不保证字符集**：值里可以带引号、空格或 Gmail 操作符，直接拼进 `search(\`"${reference}" -in:trash -in:spam\`)`（:161）会破坏甚至注入查询；**不保证上下文**：电话号码、日期逐字出现在原文也会被当成“单号”去搜，方案写的反向用例（电话/日期不当单号）只靠提示词，没有程序核对，无法做成确定性反向用例。另外 `#related` 在 `spentToday >= dailyCostMicros` 时整个跳过（`packages/application/src/services/proactive-mail-check-service.ts:847-859`），方案说抽取“在取相关邮件前”做、又只说“沿用现有成本上限”——若插在门槛之外，超限时照样花钱；抽取费用也没说要计入 `costMicros`（:863 之后判断批次的估算用）。
建议：模型输出改为 `{value, contextQuote}` 对，程序核对两件事：value 逐字出现**且** contextQuote 逐字出现（把“上下文”变成可程序核对的确定性断言），再加字符集/长度白名单后再进搜索串；抽取放在与 `#related` 同一个每日上限门槛内，费用计入 `costMicros` 并纳入 `perCheckMs` 的 AbortSignal。

### 中

**M-1【证实】① 漏了 `parseTimeScope` 的另外 3 处使用者和 MCP 入口。**
证据：`hybrid-memory-provider.ts:166`（consolidation 无 scope 兜底）、`test/integration/memory-evaluation.test.ts:505`、`memory-episodes.test.ts:318`。另外 `recallOutsideRun`（production-memory-recall.ts:144-149）服务 MCP `find_memories`（`service-main.ts:2249`，ADR 0219/0242）——外部 agent 不填 from/to 时同样失去时间过滤，方案只提“对话路径”和“自动召回”。
建议：方案明确列出全部 4 处使用点及各自去向；MCP `find_memories` 的工具说明（`packages/prompt-catalog/src/tools.ts:312` 已写“问到具体时间时填 from、to”）要同步加强，并接受外部 agent 不填时的退化，写进说明。

**M-2【证实，且被①放大】recall 的 from/to 只校验格式不校历法。**
证据：`production-memory-recall.ts:24` `DATE = /^\d{4}-\d{2}-\d{2}$/` 能放过 `"2026-13-45"`；随后 `startOfDay`（:65-90）里 `Date.parse("2026-13-45T00:00:00.000Z")` 得 NaN，`Intl.DateTimeFormat.formatToParts(new Date(NaN))` 抛 RangeError；`from > to` 也不校验。这是现存 bug，但①把“模型自填”变成唯一来源、删掉了正则兜底（正则里反而有 month≤12 之类的校验，time-scope.ts:185、211、225），触发面变大。
建议：补日历有效性（Date.parse 回读比对）和 from≤to 校验，配反向用例；这正好满足必答问题 3 的“反向用例真的会失败”。

**M-3【证实】② 的字段定义错位：capture 提示词里的 `topic` 不是导入用的 `subCategory`。**
证据：`packages/prompt-catalog/src/memory.ts:16`——MEMORY_CAPTURE 的 `topic` 是**敏感主题七选一枚举**（health/finance/beliefs/intimacy/third_party/location/legal/other，`contracts-v2.ts:1013-1022`），只对 sensitive 记忆填；导入/手动添加链路用的是 `subCategory`（`memoryLabelSchema`，2-6 字小类，contracts-v2.ts:1482）。方案说“输出 category、classification、topic，沿用抽取提示词里同一套定义”，照抄会把 topic 枚举塞进 subCategory 字段。
建议：服务端分类输出定义为 `category + sensitive 布尔 + subCategory`，校验照搬 `parseMemoryCandidates` 的现成写法：枚举外落 `other`（production-memory-capture.ts:370-374）、subCategory 走 known 集 + 长度上限（:282-294）、`classificationWithIdentifiers` 只升不降。

**M-4【证实，判断】⑤ 把确定性防泄露换成裁判模型，不属于 Andy 原则的适用范围，且反向用例无法确定性失败。**
证据：Andy 原则管“理解用户意思”（P1 原话），而 `leaksAnswer`（`packages/application/src/services/real-memory-eval.ts:158-168`）是**评测出题防污染**的机械检查，方案自己的 P5 也承认它不是打分。业界评测防污染的一手做法是确定性重叠检查（n-gram/数字重叠），GPT-4 报告与各大基准的 contamination check 均如此；把它换成裁判模型会：(a) 删掉 10 条已验证的确定性用例（`real-memory-eval.unit.test.ts:127-145`，“下午三点↔15:00”等）；(b) 裁判漏判 = 评测题泄露 = 分数虚高，且无声；(c) “无关问题→通过”的反向用例依赖活模型，不是确定性测试。LongMemEval 一手结论（https://arxiv.org/abs/2410.10813 §5.4、附录 E.4）也警告弱模型做时间类判断不可靠。
建议：⑤ 整条撤回，保留 `chineseNumber/PART_OF_DAY/dateTokens`；若确要补“换说法泄露”，把裁判作为**叠加层**而非替代，失败默认=拒绝出题，并说明该用例只能用录制/桩做回归，不能当确定性反向门。

**M-5【证实，补充告诫】P9 引用 LongMemEval 时漏了它对“低价模型”的直接反证。**
证据：原文 §5.4/表 4 与附录 E.4：时间范围抽取用 Llama-3.1-8B 时，**没有时间指称的问题也会被抽出一个范围**，把召回做得比不抽还差（表 4：0.624/0.384 对 baseline 0.639/0.421）；“effectiveness … depends on using a strong LLM”。方案②⑥都打算用“DeepSeek flash 一类低价模型”，①虽然删了后台猜时间（方向与论文一致：让对话中的强模型自填），但②⑥的输出质量同样吃模型强度。
建议：②⑥的模型选型写明“需较强模型”，并把这一点和失败安全默认一起作为验收项。

### 低

**L-1【证实】“共用封装”引用错文件。** `production-model-composition.ts` 是模型清单/描述符组合（`resolveConfiguredModelDescriptorSet` 等，:273、:309），不是辅助文本调用路径；side-call 现成范式在 memory capture、mail check、real-eval 里。照方案去找会找不到可复用的东西。

**L-2【证实】① 改 TOOL_RECALL 文字还有一个方案没提的副作用：**提示词文字改动会改变固定文字清单，老对话里冻结的旧文字退出清单、改按外来内容遮盖，那个对话的请求开头可能变一次（`.claude/rules/prompt-prefix.md:53` 自己写明了这一点）。属于已知、已被规则接受的代价，但方案应写明，避免上线时当成事故。

**L-3【推测】② 的确定性/顺序问题：**批量分类的输出列表必须按输入顺序固定（防无序集合，规则 §10）；同一文件重复导入时分类结果可能不同（非确定性），与文本去重并存会产生“同文不同类”的重复项——影响小，但值得写明。

**L-4【未核实】**P1 的 Andy 原话和 `intent-keywords.md`（/mnt 路径不在仓库）；⑥ 中候选邮件 `item.body` 在抽取点的遮盖状态（`#reportMasked` 在扫未遮盖正文，`proactive-mail-check-service.ts:602-627`，故“脱敏后输入”需要额外做一次遮盖，方案没写谁来做）。

**证实的方案前提**：P2（tools.ts:36 确已写 from/to/includeHistory 用法；recall.ts:160-184 显式参数优先）、P3、P4（`quoteRelatesToMemory` 全仓仅 confirmsTentative 一处生产使用）、P5（打分确为裁判模型+确定性 fast path）、P6（#related 在判断批次之前）、P7（:574 amount、dailyCostMicros 门槛在 :848/:915）、P8 均属实；P9 两条来源属实（网址见上）。

---

## 如果由我来定，我会怎样改这份方案

1. **②照做，但先改合约**：服务端批量分类（较强模型，非 flash 级），输出 `category + sensitive + subCategory`，校验照搬 `parseMemoryCandidates`；`memory.create`/`import.commit` 的 payload 增加可空 category 或客户端先解析，两端校验写进方案；门槛=contracts 测试 + 失败→敏感不勾选的单测 + egress-redaction 登记。
2. **④照做**：独立裁判 + 逐字核对保留，失败=不确认；capture 解析拆两段；旧词表测试换成对裁判解析函数的确定性反向用例（桩输出）。
3. **⑥照做，但加程序性约束**：`{value, contextQuote}` 双逐字核对 + 字符集白名单 + 与 #related 同门槛计费 + 截断输入；失败=无单号。
4. **⑤撤回**：保留 `leaksAnswer` 全部确定性层；它不是意图判断，不在 Andy 原则范围内。
5. **①收窄后做**：删 4 处 `parseTimeScope` 使用（含 hybrid 兜底与两个评测装置）、MCP 说明同步、补 from/to 历法校验、最后做并先跑真实评测——顺序方案已写对。
6. **每项补“门槛”一列**，反向用例一律写成改动前必失败的自动化断言。

## 必答问题逐条回答

1. **会不会改变模型已见过的请求开头？** 对话路径上只有①动请求头（TOOL_RECALL 文字属工具定义，在请求最前），按规则 6“改提示词文字只对新对话生效”处理即合规，方案已写明；但需补记 L-2（固定文字清单变化可能让个别老对话遮盖结果变一次，属规则已接受的一次性前缀变化）。②④⑤⑥都是独立后台调用，不进对话请求，只要按规则 15 组装（固定指令在前、数据居中、当前时间在最后）即可。recall 的 window、相关邮件这类每轮会变的值都只出现在当轮追加的工具结果/最后消息里——**结论：只要①限新对话、其余走后台调用，发给模型的内容仍只在末尾追加，合规**。
2. **同一段文字会不会变成不同字节？** 会变的值（裁判结论、分类结果、单号列表）都是一次性入库或当轮追加的决策，不再回写请求历史，不违反规则 11 的遮盖确定性。需要注意两点：批量输出的列表顺序必须固定（L-3）；遮盖相关的新输入（⑥的脱敏正文）必须用与遮盖历史相同的确定性规则。**结论：无违规风险，但方案未写顺序固定这一条。**
3. **有没有对应的自动检查、反向用例会不会真失败？** 方案目前一项门槛都没写（H-2）。按上述建议补齐后：①②④⑥的反向用例都可以做成确定性断言（含 M-2 的历法反向用例）；⑤若按我的建议保留确定性层则天然成立，若改成裁判则**做不到**确定性反向失败——这是⑤不该做的一个独立理由。
4. **每个新值的两端校验核对了吗？** 逐个：`"自动"`哨兵——产生于前端下拉，使用端合约 `enumeration(MEMORY_CATEGORY_NAMES)` **会拒绝**（H-1，必须先改）；②的 category/subCategory/classification——服务端必须复用 parseMemoryCandidates 的枚举兜底与只升不降规则（M-3）；⑥的单号——使用端是 Gmail 搜索串和 `mentions()`，现正则的字符集/上下文保证会丢失，须程序补齐（H-3）；①的 from/to——现只有格式正则，无历法/序校验（M-2）；④的 confirms、⑤的拒绝标志——单点 gate、失败默认安全，两端无其他消费方，可接受。**结论：方案只看了改动本身，恰是 I-73 的教训所在；上面五项都需补两端核对。**
