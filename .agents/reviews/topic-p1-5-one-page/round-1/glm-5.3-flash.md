# P1-5 方案设计：一屏看到一条决策的完整链 + 该周校准 + Muse 对照

## 一、方案依赖的前提（读代码或来源证实的）

1. **gapCases 背后的数据层已经查出 decisionId，只是被丢掉了。**`GapCandidate` 接口里有 `decisionId`（packages/application/src/ports/decision-ledger.ts:187），SQL 里 `JOIN decision_ledger d ON d.id = p.decision_id` 并选出 `d.id AS decisionId`（packages/persistence-sqlite/src/sqlite-decision-ledger-operations.ts:530、553）。原话：“decisionId: string;”（decision-ledger.ts:187）。
2. **GapCase 把它丢了，id 是哈希。**`GapCase` 接口没有 decisionId 字段；`id: gapCaseId(candidate.pairedMessageId)`，`gap_${sha256(pairedMessageId).slice(0,20)}`（apps/agent-service/src/production-gap-cases.ts:14-28、39-41、79）。
3. **合约是严格校验的，加字段必须两端同步。**`object()` 对未知字段直接报错："unknown field"（packages/gateway-contracts/src/validation.ts:163-165）；weekly 快照在服务端组装后立即 `gatewayV2MessageSchema.parse(snapshot)`（apps/agent-service/src/production-observation.ts:297）。gapCases 的字段清单在 packages/gateway-contracts/src/contracts-v2.ts:843-864。控制中心 UI 类型由该 schema 推导，前端自己不重复定义 gapCase 字段。
4. **决策链抽屉已经存在且可直接复用。**`DecisionChainDrawer({ decisionId, readChain, ... })`（apps/control-center/src/components/decision-chain-drawer.tsx:122-136）；`readChain` 在 proactive 模型上现成可用（apps/control-center/src/proactive.ts:200-208）；memory-page 已持有 `onOpenThread` 可传给抽屉（apps/control-center/src/components/memory-page.tsx:1348、proactive-reminders.tsx:660-674 是现成样板）。
5. **gapCase 行已经显示 Muse 原文、Himawari 结果/理由/记忆命中数/评价**（apps/control-center/src/components/weekly-report.tsx:1138-1175），校准数字和 Muse 分桶在同一页上方的卡片里（weekly-report.tsx:935-1085）。
6. **`decision.chain.read` 是只读、不重算、不加迁移**（ADR 0195 docs/adr/0195-show-the-whole-chain-of-one-decision-record.md：“只读已存的记录：不重算、不改发给模型的任何内容，不加迁移”）；后端按 owner/agent 作用域读，非本人记录返回 NOT_FOUND（apps/agent-service/src/production-decision-chain.ts:86-92）。
7. **gapCases 顺序确定**：`ORDER BY e.muse_at, e.id`（sqlite-decision-ledger-operations.ts:536）。
8. **已标记案例的快照是封存 JSON**：`{ ...found, weekStart, weekEnd }`（production-observation.ts:331），导出侧 `isGapCaseSnapshot` 只检查必需字段、忽略多余键（apps/agent-service/src/production-gap-export.ts:53-70）。
9. **muse.overview 的 items 不带 pairedMessageId/pairedDecisionId**（contracts-v2.ts:609-620），所以 Muse 参照页的每一行目前也没有链到决策的通路。
10. **KV 缓存规则与业界来源**：请求开头逐字节相同才命中缓存（.claude/rules/prompt-prefix.md:6，引 Anthropic https://platform.claude.com/docs/en/build-with-claude/prompt-caching 、OpenAI https://developers.openai.com/api/docs/guides/prompt-caching ）。
11. **I-73 的教训**：双模型复核只看 diff，没问“清单里的 id 能通过后端校验吗”（docs/incidents-and-gates.md:112）。

**推测（未核实）**：muse_reference_entries 表里的 `paired_decision_id` 列实际有值的比例（写入端是否常填）；`contracts.ts`（v1）不含 gapCases（grep 只在 contracts-v2.ts 命中，推测只改一份即可）。

## 二、方案

**核心判断：不需要新页面、新表、新迁移。材料里说“无法从一封 Muse 配对的邮件找到对应决策记录”，这个说法只对了一半——查询层早就把 decisionId 查出来了，是在 `buildGapCases` 组装 GapCase 时丢掉的。最小且正确的改动是把已查出的值透传到界面。**

### 改动清单

1. **服务端透传 decisionId**
   - `apps/agent-service/src/production-gap-cases.ts`：`GapCase` 接口加 `readonly decisionId: string`，`buildGapCases` 返回时带上 `candidate.decisionId`。
   - `packages/gateway-contracts/src/contracts-v2.ts:843` 的 gapCases 元素 schema 加 `decisionId: machineString`（严格校验，不加这里第 3 条前提会让 weekly.read 全挂）。
2. **UI：gapCase 行加“依据”入口**
   - `weekly-report.tsx:1138` 的每个 `<li>` 里加一个按钮（复用 `memory-link` 样式和现有文案 `decision.chain.open`，三语已有：zh “依据”/en "Basis"/ja “根拠”），点击打开 `DecisionChainDrawer`，`decisionId` 取自该行，`readChain` 取自 `proactive.readChain`（proactive.ts:200），`onOpenThread` 由 memory-page 传入（memory-page.tsx:933 的 `<WeeklyReport>` 调用点加一个 prop）。`readChain` 为 null（能力不可用）时不显示按钮，不留死链接。
   - 抽屉内部已满足“链上每一环可点开到原始记录”（decision-chain-drawer.tsx:81-104 打开来源对话；105-117 显示推断依据树）。
3. **“一页看完”的布局**：不动现有标签页结构。周报页自上而下已经是：观测 → 校准分组数字 → Muse 分桶/命中率 → 差距 → gapCases → 隐式信号；gapCases 行本身就是“这封邮件 Muse 做了什么 + Himawari 做了什么 + 归因”，加上“依据”按钮后，决策→规则→记忆→推论→评价的完整链就地弹出。链上缺环时抽屉已有“无记录”显示（decision-chain-drawer.tsx:88、113、218）。
4. **测试**
   - 集成：`test/integration/decision-chain.test.ts` 增补用例——weekly 快照里 gapCase 的 decisionId 能原样通过 `decision.chain.read` 读回同一条决策；他人/不存在的 decisionId 被拒（复用现有用例骨架）。
   - 反向用例（问题 3 的要求）：在 `test/integration/` 加一个用例，把 GapCase 的 decisionId 改成别人作用域的决策编号，断言 `decision.chain.read` 返回 NOT_FOUND、界面显示失败提示而非空链；再保留一个“gapCase 无配对决策”（理论上 JOIN 不会产生，但防回归）时按钮不出现的断言。
   - 合约反向用例：删掉 contracts-v2.ts 里的 `decisionId` 而服务端照发，`gatewayV2MessageSchema.parse` 必须失败（production-observation.ts:297 现成路径）。
   - 现有门槛不动：`npm run check:operations`（新字段属于已有操作）、浏览器验收 `decision-chain-browser.test.ts` 风格的用例可选加一个手机宽度用例。

### 考虑过但不选的做法

- **用 gapCaseId 反查决策**（把哈希存下来或建映射表）：多一张表/一次迁移，而 decisionId 本来就在 SQL 结果里，纯属浪费。ADR 0195 已确立“不加迁移、不重算”。
- **把 pairedMessageId 直接暴露给界面当标识**：邮件编号本身是敏感度更高的标识，且界面上没人消费它；decisionId 才是打开链的钥匙。
- **新做一条“邮件 → 决策”查询**：`proactive_processed_messages.message_id → decision_id` 的 JOIN 已在 readGapCandidates 里，复用即可。
- **给 muse.overview items 也加 pairedDecisionId**（Muse 参照页每行加“依据”）：数据库列存在（decision-ledger.ts:171），但快照合约、`muse.intake` 写入端和 UI 都要动，收益是 Muse 行也能点开链。**建议列为第二刀**，不在本刀里做，避免一次改动横跨三条合约（I-73 的教训正是“一次只盯一端”）。
- **做一个独立的“面试演示页”**：Andy 明确要求长期留在产品里；weekly-report 的 gapCases 区块就是产品页，改它而不是另起一次性页面。

### 风险和反例

- **严格合约漏改**：只改 GapCase 不改 contracts-v2.ts，`gatewayV2MessageSchema.parse` 在 production-observation.ts:297 直接抛错，weekly.read 全红。这正是 I-73 的模式（清单产生端改了、校验端没跟上）。反制：上面第 4 条的合约反向用例 + 一次端到端集成。
- **封存快照格式变化**：改动后新标记的 case 快照 JSON 里多一个 decisionId 字段（production-observation.ts:331）。导出校验忽略多余键（production-gap-export.ts:53-70），老快照不受影响；新快照导出体只挑固定字段（153-164），导出格式 `himawari-gap-cases.v1` 不变。低风险，但要写进 ADR。
- **受限记忆**：decision.chain.read 对受限档记忆正文已隐藏（ADR 0195 决定 3；production-decision-chain.ts:215-240），面试时若链上有受限记忆，界面显示“隐藏”状态而非正文——这是设计内的，需要提前跟 Andy 打招呼。
- **decisionId 是内部标识**：出现在控制中心 UI 和封存快照里。它不是正文、不是密钥，界面本来就显示 memoryId/ruleId 同类标识（ADR 0195 决定 3 “记忆编号……这类标识符仍然返回”），可接受。

### 需要人拍板的取舍

1. 是否同一刀里给 muse.overview 也加 pairedDecisionId（Muse 参照页行级“依据”），还是按本方案留第二刀。
2. 封存快照里是否包含 decisionId（可从 sealed JSON 里剔除以保持字节级不变；我倾向包含，简单且导出格式不变）。
3. gapCase 行按钮的文案：复用现有 `decision.chain.open`（“依据”）还是新加一条消息 id。

## 三、必答问题逐条

**1. 会不会改变模型已经见过的请求开头？** 不会。本方案的全部改动（production-gap-cases.ts 透传字段、contracts-v2.ts 合约、weekly-report.tsx UI、decision-chain-drawer 复用）都在控制中心 → agent-service 的只读查询链路上（`proactive.weekly.read`、`decision.chain.read`），不组装、不修改任何发给模型的内容——系统提示、工具定义、历史消息、遮盖全部不碰。发给模型的内容仍然只在末尾追加、每轮会变的值仍在最后一条消息里，规则第 4 条（prompt-prefix.md:35）的前提没有被触碰。依据：ADR 0195 “不重算、不改发给模型的任何内容”。

**2. 会不会让同一段文字在不同请求里变成不同字节？** 不会。界面渲染不进模型请求。服务端新增的 decisionId 是数据库单值，同一决策记录恒定；gapCases 顺序固定（`ORDER BY e.muse_at, e.id`，前提 7）；`gatewayV2MessageSchema.parse` 每次重新解析，不引入时间戳或无序集合。唯一字节层面的变化是封存快照 JSON 多一个键（风险第 2 条），那是确定性变化（同一 case 封存一次），且发生在 `proactive.gapcase.mark` 的封存文本里，不是模型请求。

**3. 有没有对应的自动检查，反向用例真的会失败吗？** 有，方案第 4 条列了三层：(a) 严格合约解析是现成的失败机制——删掉 schema 里的 decisionId，服务端照发，`parse` 在 production-observation.ts:297 抛 "unknown field"，weekly.read 立即失败（已核实 parse 实现是 strict，validation.ts:163-165）；(b) 集成反向用例：跨作用域的 decisionId 必须得到 NOT_FOUND 而不是空链（现有 decision-chain.test.ts 已有“他人记录和不存在的记录被拒”的骨架可加参数）；(c) `npm run check:operations` 继续守住“操作有后端实现、前端调用和测试”。反向用例会失败这一点，(a) 已由 validation.ts 的实现直接证实，(b) 依赖生产代码第 91-92 行 `throw new ApplicationPortError(NOT_FOUND)`（已核实）。

**4. 每个产生/修改的值，两端都核对了吗？** 逐个过：
- `decisionId`（新透传）：产生于 readGapCandidates（sqlite:553），经 GapCase（production-gap-cases.ts，本方案补字段）→ 合约 schema（contracts-v2.ts:843，本方案补字段，strict parse）→ UI（weekly-report.tsx，本方案新增按钮）→ 回到 `decision.chain.read` 的入参校验（production-decision-chain.ts:86-92，按 owner/agent 作用域 + NOT_FOUND，已核实接受）。链路闭环，两端校验都有。I-73 式自问“这个 id 能通过后端校验吗”：能，machineString 对 decision_ledger 的 id 格式（`d.id` 主键）成立；集成用例再实发一次验证。
- `gapCaseId`（不改）：仍是 pairedMessageId 的 sha256，export 侧 `isGapCaseSnapshot` 校验 id 与 mark.caseId 一致（production-gap-export.ts:147），不受影响。
- 合约 schema（改一处）：v1 contracts.ts 无 gapCases（已核实 grep 只命中 v2），无需第二份。
- 封存快照/导出（间接受影响）：isGapCaseSnapshot 忽略多余键（已核实），导出体字段固定，格式 `himawari-gap-cases.v1` 不变。
- UI 文案（复用 `decision.chain.open`）：message-ids.ts:904 与三语资源均已存在（zh-CN.ts:965、en.ts:1025、ja.ts:1025，已核实），三语约束满足。
- `readChain` 能力开关：chainAvailable 为假时按钮不渲染，不留空白或死链（本方案约定，属设计而非已核实代码）。

**未核实项汇总**：muse_reference_entries.paired_decision_id 的实际填充率；`npm run check:operations` 对已有操作新增字段的具体检查行为（按 ADR 0195 的门槛描述推断）；浏览器端到端反向用例是否需要进 `decision-chain-browser.test.ts` 还是普通集成即可（属实施时选择）。
