## 结论概览

本轮 6 个文件的增量与作者说法基本一致：`supersededBy.text` 的 `visible` 门已恢复，`displayRuleId` 只影响展示，三语文案已改，写入约定与 `insertLedgerRow` 的实际行为对得上。未发现高危问题；下面都是低严重度/文档层面的问题。

## 问题（按严重度）

### 1.（低）`displayRuleId` 会让不同规则编号显示成同一串，并可能产生重复的 React key
- 文件：`apps/agent-service/src/production-decision-chain.ts:108`、`apps/control-center/src/components/decision-chain-drawer.tsx:225`
- 问题：去重发生在替换前（`sortedUnique(inputs.ruleIds)`），替换后不再去重。两个只差控制字符的编号会得到同一个 `ruleId`。
- 证据（读代码证实）：
  - `production-decision-chain.ts:108`：`ruleId: displayRuleId(ruleId),`
  - `decision-chain-drawer.tsx:225`：`<li key={rule.ruleId}>`
  - `production-decision-chain.ts:105` 仍是 `sortedUnique(inputs.ruleIds).map(...)`，去重用的是原编号。
- 建议：React key 用原始编号（或 `${ruleId}:${index}`），或对显示后的重复项做标记。否则一旦出现 `"a\nb"` 和 `"a b"`，界面会出现两条完全一样的规则且 key 冲突。是否真的会发生取决于写入方；目前规则编号来自固定目录，概率很低，故定为低。

### 2.（低）新用例没有验证“登记表查询和邮件计数仍用原编号”
- 文件：`test/integration/decision-chain.test.ts:659-677`
- 问题：新用例把控制字符编号写进 `ruleIds`，但 `floorHits: {}`，只断言显示值和 `state`。如果有人把 `decisionRuleDefinition` 或 `floorMailCounts` 也改成用 `displayRuleId` 后的值，这个用例仍然会通过。
- 证据（读代码证实）：
  - `test/integration/decision-chain.test.ts:665`：`floorHits: {},`
  - `test/integration/decision-chain.test.ts:677`：`expect(chain.rules.items[0]?.ruleId).toBe("rule with control");`
  - 当前实现确实用原编号：`production-decision-chain.ts:106` `decisionRuleDefinition(ruleId)`、`:111` `floorMailCounts.get(ruleId)`。
- 建议：把新用例改成 `floorHits: { "mail-1": [odd] }`，并断言 `mailCount: 1`；这样能锁住“计数用原编号”。

### 3.（低）`decision.chain.basisCut` 的“只显示了一部分”与读取出错时的实际表现不完全一致
- 文件：`apps/agent-service/src/production-decision-chain.ts:174-176`、`apps/control-center/src/i18n/resources/zh-CN.ts:1006`、`apps/control-center/src/components/decision-chain-drawer.tsx:115`
- 问题：`readBasisChain` 抛错时节点数组被置空，界面其实一条依据也不显示，而文案说“只显示了一部分”。
- 证据（读代码证实）：
  - `production-decision-chain.ts:174-176`：`} catch { bases.set(id, { nodes: [], complete: false }); }`
  - `decision-chain-drawer.tsx:115`：`{!item.basis.complete ? <small>{message("decision.chain.basisCut")}</small> : null}`
  - `zh-CN.ts:1006`：`"依据没读全（太多或读取出错），只显示了一部分"`
- 建议：改成“依据没能完整读取（太多或读取出错）”，去掉“只显示了一部分”；或区分“截断仍有部分节点”和“读取失败零节点”。另外 UI 单测只断言了中文文案（`proactive-interactions.unit.test.ts:1115`），英/日文案没有自动检查。

### 4.（信息）写入约定的“缺项怎么显示”表格与非主动提醒的 `ruleIds` 说法有歧义
- 文件：`docs/execution/specs/2026-11-09-decision-record-write-convention.md:39`、`:53`、`:62`
- 问题：第 39 行说非 proactive 的 `ruleIds` 抽屉“一律显示‘这类记录不涉及’”，但第 62 行表格又说“键存在且为空 → 这次没有”。非 proactive 经 `append` 时 `ruleIds` 永远存在（第 35 行也写明“四个键永远在”），按表格会被理解成“这次没有”。
- 证据（读代码证实）：`production-decision-chain.ts:102-115` 对非 proactive 直接返回 `rules.state = "not_applicable"`，不看 `inputs.ruleIds`。
- 建议：在“缺项怎么显示”表里补一行“这类记录不涉及优先于键存在/为空”，或注明该表只适用于 `memories` 等按 `inputFields` 判断的节。

## 侧重检查

- **错误路径**
  - 记录不存在：`production-decision-chain.ts:91-92` 抛 `PORT_NOT_FOUND`；网关集成用例 `decision-chain.test.ts:710-712` 断言 `PORT_NOT_FOUND`。结论：正常。
  - 依据链读取失败：`production-decision-chain.ts:174-176` 吞掉异常并标 `complete: false`，不会让整条链失败；但文案有小偏差（见问题 3）。
  - 记忆读取失败：`production-memory-control.ts:483` 用 `.catch(() => "")` 转成 `null`，不会抛出；结论：可控。
- **不合规范/不可信输入**
  - 控制字符规则编号：`displayRuleId`（`production-decision-chain.ts:56-62`）与 `boundedString` 的判定完全一致（`<0x20 || ===0x7f`），契约能通过；登记表和计数仍用原编号（`:106`、`:111`）。结论：正确。
  - `decisionId`：网关契约用 `machineString`（`validation.ts:49-58`，1-128、允许 `[A-Za-z0-9._:-]`），`readOne` 再校验 1-128 且用参数化 SQL（`sqlite-decision-ledger-operations.ts:311-321`）。生产 ID 形如 `proactive-decision:<uuid>`，两端兼容。结论：正确。
  - 注意 `displayRuleId` 只处理 C0/DEL，C1 控制符、U+2028/2029、双向控制符仍会保留；这与 `boundedString` 的规则一致，规则编号来源可信，故仅为低风险设计选择（推测）。
- **安全/越权**
  - `readOne` 的 SQL 带 `owner_id = ? AND agent_id = ? AND id = ?`（`sqlite-decision-ledger-operations.ts:315-318`），查询作用域来自配置而非入参；`views`/`texts` 也用 `this.#scope()`。结论：无跨 owner/agent 读取。
  - 敏感记忆正文、原话、依据节点正文均隐藏（`production-decision-chain.ts:215-240`），`supersededBy.text` 恢复 `visible` 门（`:228`），与 ADR 0193 第 3 条一致。结论：正确。
- **资源耗尽**
  - 记忆最多 100 条（`:133`），依据节点总预算 200（`:144-171`），`readBasisChain` 自身还有深度 8/节点 200 上限（`sqlite-memory-consolidation-operations.ts:19-20`）。结论：有界。
- **不可撤销操作**
  - 新路径是只读；用例 `decision-chain.test.ts:449` 断言 `f.writes` 为空。结论：无写入。
- **规则/文档/代码一致性**
  - `insertLedgerRow` 确实只落 `memoryIds`、`ruleIds`、`batchId`、`resultMemoryIds` 四键且写默认值（`sqlite-decision-ledger-operations.ts:115-120`），与非 proactive 调用方（`automatic-memory-service.ts:572`、`sqlite-memory-consolidation-operations.ts:102-105`）一致。结论：文档基本准确，仅问题 4 的表格有歧义。
  - 新操作 `decision.chain.read` 已同时出现在契约、schema 映射、`PRODUCTION_MEMORY_OPERATIONS`、网关 query 委派、浏览器 installed 列表、前端和测试中，`check:operations` 所需的“后端实现/调用方/测试”三端齐全。结论：I-73 类清单不一致未发现。

## 必答问题

1. **会不会改变模型已见过的请求开头？**
   不会。本次增量只改只读的决策链查询（`readDecisionChain`）、控制中心渲染、三语文案和写入约定文档；`readDecisionChain` 不调用模型、不写库，也没有改动 `packages/prompt-catalog` 或请求组装代码。发给模型的内容仍只在末尾追加、每轮变化的值仍应在最后一条消息里；本改动与这些位置无交集。
   依据：改动文件清单（6 个源/文档文件）中无提示词或请求组装文件；`production-decision-chain.ts` 全篇只有对 ledger/state 的读取。

2. **同一段文字会不会在不同请求里变成不同字节？**
   对同一份存储状态，不会。输出里没有“读取时刻”字段；规则按原编号排序、记忆按编号排序、依据节点按 BFS 固定顺序，集合都显式排序，控制字符替换也只取决于该编号本身。
   但 `changedSinceDecision`、记忆正文、`dataClassification`、`supersededBy` 读的是“当前状态”，记忆被修改后同一记录的返回值会变化——这是 ADR 0193 明确设计（显示现在的内容），且该数据只给界面，不进入模型请求，不影响 KV 缓存。

3. **有没有自动检查，反向用例会失败吗？**
   有。
   - 记被 `visible` 门隐藏：新用例 `decision-chain.test.ts:648-681`；去掉 `:228` 的门后，`supersededBy.text` 会变成 `payload-b`，`toMatchObject` 和 `not.toContain` 都会失败（按代码路径推断，未实际运行）。
   - 控制字符规则编号：同一用例；去掉 `displayRuleId` 后 `chainOf` 里的 `gatewayV2MessageSchema.parse` 会因 `boundedString` 拒绝控制字符而抛错（`validation.ts:81-91`），用例同样失败。
   - 文案：`proactive-interactions.unit.test.ts:1115` 已从“依据太多”改为“依据没读全”。
   - 缺口：英/日文案、`basisCut` 的“读取出错”分支、以及问题 2 所述的“计数用原编号”没有专门断言。

4. **改动产生/修改的每个值，两端都能接受吗？**
   - `rules.items[].ruleId`：产生端 `displayRuleId`（`:108`）；使用端契约 `boundedString(256)`（`contracts-v2.ts:1012` 一带）接受空格，UI 只展示/作 key；登记与计数用原编号。两端兼容，唯一隐患是问题 1 的显示去重。
   - `supersededBy.text`：产生端 `texts` 已按 `reviewMemoryVisible` 过滤并把正文裁到 2000（`production-memory-control.ts:99-107`）；使用端契约是 `nullable(boundedString(2000))`、UI 按有/无正文显示。两端兼容。
   - `decision.chain.basisCut`：键同时在 `message-ids.ts:938` 和三本资源里存在，类型/渲染端只按 key 取文案。两端兼容。
   - 操作清单项 `decision.chain.read`：契约、schema、installed 列表、后端实现、前端调用、测试齐全。两端校验一致。
   - 文档值：写入约定的“四键永远在”、proactive 额外字段、非 proactive `ruleIds` 写原因代码或空数组，均已对照代码核实；仅问题 4 的表格表述需微调。

## 未核实

- `.agents/reviews/pr-328/round-2/judgments.md` 在工作区不可见（读取返回不存在，`git show` 被策略拒绝），无法核对第 2 轮原话，只能按作者转述和代码核对。
- 未实际运行测试；上述“反向用例会失败”是从代码路径推断的结论。
