# 复核结论（1d6691cc，对比 92dfb36a）

## 发现（按严重度）

### 1. 中：删除 `visible` 门后，敏感记忆的“取代者正文”会返回，与 ADR 0193 明文冲突，且无测试覆盖

- 文件:行：`apps/agent-service/src/production-decision-chain.ts:217-221`；`docs/adr/0193-show-the-whole-chain-of-one-decision-record.md:38`；`test/integration/decision-chain.test.ts:594-619`
- 问题：第 1 轮代码是 `text: visible ? texts.get(item.supersededBy)?.text : null`，本轮改成无条件返回：
  ```ts
  supersededBy: item.supersededBy
    ? {
        memoryId: item.supersededBy,
        text: texts.get(item.supersededBy)?.text || null,
      }
    : null,
  ```
  但同一提交把 ADR 决定 3 写成：“敏感记忆……的正文类字段（记忆正文、原话、**取代它的记忆的正文**、推断依据节点的正文）都不返回”。按这句话，当前记忆敏感时，取代它的记忆的正文本应被隐藏；新代码只按“被取代记忆自身是否敏感”过滤，当前记忆敏感时仍会显示目标正文。这是作者摘要里没有提到的行为变化。
- 证据（亲自读到）：
  - `production-decision-chain.ts:210-220`：`state: visible ? "visible" : "hidden"`、`text: visible ? item.text : null`，唯独 `supersededBy.text` 不再看 `visible`。
  - ADR 第 38 行原文如上。
  - 新用例 `decision-chain.test.ts:594-619` 的场景是 `memory-a`（可见）被 `memory-sensitive`（敏感）取代，断言 `text: null`。这正是 `texts` 本来就会过滤的情况，旧代码同样返回 `null`，所以该用例不是 `line 220` 的回归用例。
- 建议：先定策略二选一。若 ADR 语义成立，恢复 `visible ? ... : null`；若确实只想按目标自身分类决定是否显示，把 ADR 改成“被取代记忆的正文按该记忆自己的可见性规则处理”，并补一个“当前记忆敏感、取代它的记忆可见”的用例（同时纳入变异检查，确认改回旧逻辑会让用例失败）。
- 判定：代码与文档矛盾、行为变化未在摘要中说明——**读代码证实**；“这对产品隐私预期的实际影响”是否可接受——**推测**，需产品确认。

### 2. 低：`ruleId` 放宽到 `boundedString(256)` 仍未覆盖控制字符，怪异编号仍可能让整条读取失败

- 文件:行：`packages/gateway-contracts/src/contracts-v2.ts:1024`、`packages/gateway-contracts/src/validation.ts:78-95`、`packages/persistence-sqlite/src/sqlite-proactive-operations.ts:587-594`
- 问题：写端 `proactive` 的 `ids()` 只检查“字符串、长度 1..256、去重”，允许 `\n`、`\t` 等控制字符；读端契约 `boundedString` 明确拒绝 `code < 0x20 || code === 0x7f`。因此存进一条带换行的 ruleId 时，`decision.chain.read` 返回的快照仍会解析失败，抽屉显示读取失败，和“怪编号不再让整条读取失败”的目标不一致。
- 证据：
  ```ts
  // sqlite-proactive-operations.ts:587-591
  const ids = (value: unknown, max: number) =>
    Array.isArray(value) && value.length <= max &&
    value.every((item) => typeof item === "string" && item.length >= 1 && item.length <= 256) &&
    new Set(value).size === value.length;
  ```
  ```ts
  // validation.ts:81-90
  typeof input !== "string" || input.length === 0 || input.length > maximum ||
  [...input].some((character) => {
    const code = character.charCodeAt(0);
    return code < 0x20 || code === 0x7f;
  })
  ```
  新用例 `decision-chain.test.ts:630-646` 只用了空格和普通字符，未覆盖控制字符。
- 建议：读取时对 ruleId 做与 `singleLine` 相同的控制字符净化，或写端 `ids()` 同步收紧；补控制字符和 256 边界用例。另外 `machineString` 改为 `boundedString` 后允许任意 Unicode，UI 用 ICU `select` 渲染（`zh-CN.ts:979-982`）不会执行，但 bidi 控制符仍可能造成显示伪造，可作为低风险一并处理。
- 判定：两端校验不一致——**读代码证实**；实际生产可达性——**推测**（当前 `FLOOR_RULE_IDS` 是常量，但 `proactive().record` 入口与历史数据可写入任意 ≤256 字符串）。

### 3. 低：写入约定文字与实际写入行为仍有几处不精确

- 文件:行：`docs/execution/specs/2026-11-09-decision-record-write-convention.md:34,39,42`；`packages/application/src/services/automatic-memory-service.ts:534,572`；`packages/application/src/services/context-formation-service.ts:345`；`packages/persistence-sqlite/src/sqlite-proactive-operations.ts:665-684`；`packages/persistence-sqlite/src/sqlite-decision-ledger-operations.ts:115-120`
- 问题：
  1. 文档说“其他种类现在写的是原因代码”，并非全部：`memory_candidate` 保留类写 `ruleIds: []`（automatic-memory-service.ts:534），`context_truncation` 也写 `ruleIds: []`（context-formation-service.ts:345），只有 discard 分支写 `[reasonCode]`（:572）。
  2. 文档说 proactive“落盘完整字段”，但实际键（sqlite-proactive-operations.ts:665-684）包括 `memoryInjected`、`relatedStats`、`relatedFailedSteps`，表格没有列出；`batchId`/`resultMemoryIds` 反而是另一条路径才有。
  3. `insertLedgerRow` 总是写入 `batchId`/`resultMemoryIds`（即使调用方未提供，见 :118-119），所以文档第 53 行“字段没有这回事就不写这个键”对 append 路径并不成立，`inputFields` 永远是四个键。
- 建议：把 `ruleIds` 一行改成“有些种类写原因代码，有些写空数组；抽屉对非 proactive 一律显示‘这类记录不涉及’”，并补全/删掉未列的 proactive 字段，或明确“本表只列抽屉会读的字段”。核心结论（两条路径、四个键）与 `insertLedgerRow` 一致，**读代码证实**。
- 严重度：低。

### 4. 低：依据读取失败与“被截断”被合并，界面把错误说成“依据太多”

- 文件:行：`apps/agent-service/src/production-decision-chain.ts:166-167`；`apps/control-center/src/components/decision-chain-drawer.tsx:112-115`；`apps/control-center/src/i18n/resources/zh-CN.ts:1006`
- 问题：`readBasisChain` 抛错时后端把 `complete` 设为 `false`，本轮抽屉改造后 `complete === false` 只显示“依据太多，只显示了一部分”。读取失败会被描述成截断。
- 建议：为错误单独加一个状态（例如 `basisError`），或至少让文案兼容“无法读取完整依据”。当前无测试覆盖该错误路径。
- 判定：代码路径**读代码证实**；“文案误导程度”为**推测**，属 UX 取舍。

## 侧重检查

- 错误路径：未知记录、他人记录分别返回 `PORT_NOT_FOUND`（`sqlite-decision-ledger-operations.ts:311-324` 按 `owner_id/agent_id/id` 查询，测试 `decision-chain.test.ts:514-536` 覆盖）；依据读取异常见发现 4；未安装 memoryControl 时走 `MEMORY_OPERATION_NOT_INSTALLED`（`production-memory-control.ts:438-443`）。
- 不合规范/不可信输入：`decisionId` 契约是 `machineString`（contracts-v2.ts:1003），持久层再查 1..128（ledger:311-317）；`ruleId` 现在接受任意 ≤256 字符串，控制字符缺口见发现 2。UI 渲染走 react-intl（`i18n/runtime.tsx:89-92`）与 React 文本节点，不会把 ruleId 当模板或 HTML 执行。
- 安全/隐私：敏感记忆正文、原话、依据节点正文分别由 `visible`/`texts` 过滤（`production-memory-control.ts:463-489`、`production-decision-chain.ts:211,226,232`），本轮新增测试验证了敏感目标与敏感依据节点；当前记忆敏感但取代者可见时的正文策略见发现 1。查询作用域固定取配置，不取请求里的 scope。
- 资源耗尽：记忆最多 100（`:127-128`）、依据节点合计 200（`:136-162`）；`secondaryIds` 最多约 300，`texts` 一次批量读；未见本轮引入无界循环。
- 不可撤销操作：本轮只读，无写库；集成测试用 `writes` 断言读取期间无写操作（`decision-chain.test.ts` 中 `expect(f.writes).toEqual([])`）。
- 文档/规则一致性：ADR 与代码冲突见发现 1，写入约定细节见发现 3。`.claude/rules/prompt-prefix.md` 在当前检出中不存在，其原文**未核实**。

## 必答问题

1. **不会改变模型已经见过的请求开头。** 本轮改动只涉及只读查询 `decision.chain.read` 的后端实现、gateway 契约、控制中心 UI、文档和测试（对照 `git diff --name-only 92dfb36a..1d6691cc`），没有任何 prompt 构建、工具定义、历史消息或遮盖逻辑的文件；`docs/adr/0193...md:37` 也明确“不重算、不改发给模型的任何内容”。本次改动根本不进入模型请求，因此也就不存在“只在末尾追加”或“每轮变化值必须放最后一条消息”的破坏。整体提示词实现本次未逐行审计（**未核实**），但本轮改动不触及它。
2. **不会引入“同一段文字在不同请求里变成不同字节”。** 读端对 `memoryIds`、`ruleIds` 使用 `sortedUnique` 固定排序（`production-decision-chain.ts:56-58,96-104`），`secondaryIds` 排序后才取文本（`:170`）；`floorHits` 只做计数求和，与对象键枚举顺序无关。新增的 `supersededBy.text` 只取决于被取代记忆的当前存储内容，不依赖请求上下文。唯一前提是 `readBasisChain` 自身的顺序固定（ADR 第 5 条要求），本轮未改。
3. **有自动检查，但覆盖不均。**
   - “刷新不重读”用例（`proactive-interactions.unit.test.ts:1087-1099`）会失败于旧代码：`readChain` 每次渲染新建（`apps/control-center/src/proactive.ts:200-208`），旧 effect 依赖它就会重跑。
   - “截断不写无记录”用例（`:1101-1122`）会失败于旧 UI 逻辑。
   - “怪规则编号”用例（`decision-chain.test.ts:630-646`）会失败于旧的 `machineString` 契约。
   - “真实网关读取”用例（`:648-676`）在第 1 轮已走通路由，属于补充覆盖，不能防本轮回归。
   - 关键缺口：敏感取代/依据用例（`:594-623`）在旧代码下也通过（当前记忆 `memory-a` 可见，旧 `visible ?` 为真，目标文本本来就由 `texts` 判敏感返回 `null`），因此它不是 `line 220` 的回归用例；被删掉的 `visible` 门没有反向用例。也未覆盖 ruleId 控制字符和 256 边界。
4. **逐个值核对两端校验：**
   - `ruleId`：产生于 `production-decision-chain.ts:96-104`（来自 `inputs.ruleIds`）；写端 proactive 校验为“字符串 1..256、去重、不去控制字符”（`sqlite-proactive-operations.ts:587-594`），非 proactive 为 `idList`/`text(1,256)`（`sqlite-decision-ledger-operations.ts:34-45,60-61`）；消费端契约为 `boundedString(256)`（`contracts-v2.ts:1024`，拒绝控制字符），UI 走 ICU select 文本渲染（`decision-chain-drawer.tsx:225-229`）。长度两端一致，**字符集不一致**，即发现 2。
   - `supersededBy.text`：产生于 `texts` 回调，已按 `reviewMemoryVisible` 过滤并单行化、截到 2000（`production-memory-control.ts:463-489,99-107`）；消费契约 `nullable(boundedString(2000))`（contracts-v2.ts:1053-1055）可接受；长度/字符集两端一致，**语义策略**见发现 1。
   - `scope`：产生于 `production-memory-control.ts:187-190`，消费于 `DecisionLedgerPort.read`（`packages/application/src/ports/decision-ledger.ts:213-215`），两端都是 `OwnerId`/`AgentId`；去掉 `as never` 后类型自洽，运行时 SQL 仍按 owner/agent 过滤（`sqlite-decision-ledger-operations.ts:318-324`）。
   - 写入约定中的键：`insertLedgerRow` 实际只序列化 `memoryIds/ruleIds/batchId/resultMemoryIds`（`:115-120`），proactive 路径写 `memoryIds` 到 `relatedFailedSteps` 并补默认值（`sqlite-proactive-operations.ts:665-684`），主体与文档一致，细节偏差见发现 3。
   - 各节状态：读取端用 `inputFields`（`readOne` 返回 JSON 键，`:325`）区分“键不存在/键为空”，proactive 行键齐全、非 proactive 行固定四键，与文档“无记录/这次没有”的读法一致。
