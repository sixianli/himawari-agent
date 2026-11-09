## 复核发现（按严重度）

### 中：新写入约定要求保存的字段，`append` 路径实际会丢弃

- 位置：`packages/persistence-sqlite/src/sqlite-decision-ledger-operations.ts:115-120`；`docs/execution/specs/2026-11-09-decision-record-write-convention.md:38`
- 问题：写入约定要求“用到记忆的所有种类”都写 `memoryIds`、`memoryByMail`、`usedMemoryIds`、`tentativeMemoryIds`。但 `insertLedgerRow` 只序列化四项：
  ```ts
  JSON.stringify({
    memoryIds: write.inputs.memoryIds,
    ruleIds: write.inputs.ruleIds,
    batchId: write.inputs.batchId ?? null,
    resultMemoryIds: write.inputs.resultMemoryIds ?? [],
  }),
  ```
  `validateLedgerWrite`（同文件 47-93 行）也不校验其余字段。任何按新约定通过 `DecisionLedgerPort.append` 写入 `memory_candidate`、`consolidation` 等记录的调用方，都会静默丢掉这些字段；读取端随后只能显示“无记录”或 `usedByModel=false`。
- 建议：二选一——让 `insertLedgerRow` 持久化并校验全部 `DecisionInputs`（含长度/数量上限），或者把约定明确收窄为“只有 proactive 写这些字段”，并另定非 proactive 的字段。

### 中：`ruleId` 的写入校验比读取契约宽，可能让整条链读取失败

- 位置：`packages/persistence-sqlite/src/sqlite-proactive-operations.ts:590-594`；`packages/gateway-contracts/src/contracts-v2.ts:1024`
- 问题：写入端只校验 `ruleIds` 是“1-256 个字符的任意字符串”：
  ```ts
  typeof item === "string" && item.length >= 1 && item.length <= 256
  ```
  读取端却用 `machineString`：
  ```ts
  ruleId: machineString
  ```
  即 1-128 字符且必须匹配 `[A-Za-z0-9][A-Za-z0-9._:-]*`。功能上又明确支持“未登记的规则”。因此一条写入端接受的记录，只要 `ruleId` 超过 128 字符、含空格/斜杠/中文等，`decision.chain.snapshot` 就无法通过网关契约解析，整个抽屉变成“读取失败”，而不是显示“未登记的规则”。现有三个 floor 规则 id 是安全的，所以这是潜在问题，不是当前生产数据必然触发。
- 建议：写入时就用同一 `machineString` 规则校验；或在读取契约中放宽 `ruleId`（例如用 `boundedString(256)`），并补一个“未登记且含特殊字符的 ruleId”用例。

### 低-中：抽屉打开后会因无关刷新反复重读整条链

- 位置：`apps/control-center/src/proactive.ts:57,135-139,200-208`；`apps/control-center/src/components/decision-chain-drawer.tsx:150-165`
- 问题：`readChain` 每次 `useProactive` 渲染都会新建一个函数；抽屉的 effect 把它列为依赖：
  ```ts
  }, [decisionId, readChain]);
  ```
  而 `useProactive` 每 300 秒执行 `setReload(...)`，父组件重渲染后 `readChain` 引用变化，抽屉就会重新 `setLoaded({ kind: "loading" })` 并再次请求 `decision.chain.read`。整条链可能包含最多 100 条记忆的依据链读取，于是每 5 分钟重置一次界面、重复一次重查询。
- 建议：把 `readChain` 放进 ref（像现有 `close`/`gone` 那样），或用 `useCallback` 稳定引用；effect 只依赖 `decisionId`。

### 低：依据预算被“不会显示依据”的记忆消耗，且预算耗尽/读取失败时界面同时显示“无记录”和“依据太多”

- 位置：`apps/agent-service/src/production-decision-chain.ts:138-169`；`apps/control-center/src/components/decision-chain-drawer.tsx:105-115`
- 问题：服务器对每个 `shownIds` 里的记忆都调用 `readBasisChain` 并扣 `nodeBudget`，没有先判断 `item.inference`；但抽屉只对 `item.inference` 为真的记忆显示依据：
  ```ts
  {item.state === "visible" && item.inference ? (
    ...
    {!item.basis.complete ? <small>{message("decision.chain.basisCut")}</small> : null}
  ```
  当预算耗尽或 `readBasisChain` 抛错时，代码设置 `{ nodes: [], complete: false }`；抽屉于是先显示“无记录”，再显示“依据太多，只显示了一部分”，两个提示互相矛盾。`readBasisChain` 的错误也被静默吞掉：
  ```ts
  } catch {
    bases.set(id, { nodes: [], complete: false });
  }
  ```
- 建议：只为 `state === "visible" && inference` 的记忆消耗依据预算；区分“被截断”和“读取失败”，`complete=false` 且 `nodes=[]` 时不要显示“无记录”。

### 低：敏感记忆的变异检查只覆盖主记忆正文和原话

- 位置：`test/integration/decision-chain.test.ts:519-539`；`apps/agent-service/src/production-decision-chain.ts:217-233`；`docs/adr/0193-show-the-whole-chain-of-one-decision-record.md:38`
- 问题：敏感用例只造了一个敏感主记忆，断言 `text=null`、`quote=null` 和序列化里没有 `SENTINEL`。若删掉 `supersededBy` 的隐藏门（220 行）或依据节点正文的隐藏门（232 行），现有测试不会失败，因为没有敏感记忆充当 `supersededBy` 或依据节点。另外 ADR 决定 3 写“所有文字字段都不返回”，但实现对 `state="hidden"` 的记忆仍返回 `source.threadId`、`source.messageId`、`source.refs`、`importBatchId`、`supersededBy.memoryId` 等字符串字段；按任务约束只看“正文类字段”时这是合规的，但文档措辞比代码更大。
- 建议：补两个变异用例：敏感记忆被另一条可见记忆取代、推断依据节点本身是敏感记忆；同时统一 ADR 与实现的措辞（“正文类字段”还是“所有字符串字段”）。

## 读代码证实的 / 推测的

**读代码证实的：**

- 本 diff 只增加只读查询、快照契约、规则登记表、控制中心抽屉、文档和测试；没有改系统提示、工具定义、历史存储或出口遮盖代码。
- `insertLedgerRow` 只保存四项输入，`validateLedgerWrite` 不校验其余可选输入。
- `ruleIds` 写入端允许 1-256 任意字符串，读取契约限制为 `machineString`。
- `DecisionChainDrawer` 的 effect 依赖会随父组件刷新而变化的 `readChain` 函数。
- 依据预算没有按 `inference` 过滤；`readBasisChain` 异常被吞掉并导致“无记录 + 依据太多”的组合提示。
- 敏感测试只覆盖主 `text` 和 `quote`；`supersededBy.text`、依据节点正文的隐藏路径未被变异测试覆盖。
- `read` 查询按 `owner_id + agent_id` 过滤，参数化 SQL，不会读到其他主人记录（测试也覆盖）。
- 仓库里确实存在两份 `0191`：`docs/adr/0191-record-the-whole-basis-chain-of-a-memory-tidy-up.md` 和 `docs/adr/0191-draft-pull-requests-run-fast-checks-only.md`，所以 `check:adr-numbers` 很可能是红的；这不是本 PR 引入。

**推测：**

- 依据链最坏情况是 100 条记忆、每条约 200 个节点；`readBasisChain` 每个节点还有额外查询。单次抽屉读取可能在 SQLite 单工作线程上排较长队列，并与 5 分钟自动刷新叠加。实际耗时没有运行测量，属于资源消耗风险而非已证实的故障。
- `ruleId` 契约不匹配目前不会命中现有 floor 规则；是否触发取决于未来是否写入未登记或长/特殊字符的规则 id。

## 侧重检查

- **错误路径：** `NOT_FOUND` 经 `http-gateway-server` 映射为 404 和 `PORT_NOT_FOUND`，前端能关闭抽屉并提示“记录已被清除”；其他错误显示“读取失败”。但 `readBasisChain` 的局部异常被吞掉，会被误报成“依据太多”。
- **不合规范/不可信输入：** `decisionId` 在 SQL 前做了 1-128 长度检查，SQL 使用占位符；网关还有 `machineString`。但 `ruleId` 写入校验与读取契约不一致；`append` 的扩展输入不校验也不保存。
- **安全：** 查询按 owner/agent 过滤；React 渲染会转义文本，未发现 XSS。敏感正文、原话、依据节点正文和取代记忆正文都有隐藏门，但隐藏记忆的 id/refs/来源标识仍返回；按“正文类字段”约束可接受，按 ADR 的“所有文字字段”措辞则不完全一致。
- **资源耗尽：** 记忆数上限 100、依据节点全局上限 200，但每条约 200 个节点仍可能带来大量 SQLite 查询；前端 5 分钟自动刷新会重复读取。没有请求级超时/取消。
- **不可撤销操作：** 本 PR 没有新增写操作或删除操作，`decision.chain.read` 是只读的。
- **规则/文档一致性：** 写入约定与 `insertLedgerRow` 不一致；ADR 决定 3 的“所有文字字段”与实现不一致；`check:adr-numbers` 的重复 0191 是既有问题。

## 必答问题

1. **会不会改变模型已经见过的请求开头？** 不会。本 diff 没有修改系统提示、工具定义、历史消息、出口遮盖或模型请求组装；新增的是只读网关查询和控制中心界面，`DECISION_RULE_CATALOG` 也不进入模型上下文。按 [发给模型的内容只追加](../../.claude/rules/prompt-prefix.md#rules)，本改动没有引入新的头部变化，也没有新的“每轮变化值”需要放到最后一条消息。全仓提示词路径我没有逐行重审，但本次代码改动没有触及。

2. **同一段文字会不会在不同请求里变成不同字节？** 对新链读取本身，输出顺序是确定的：规则、记忆 id、`inputFields` 都用了排序/`sortedUnique`，计数用 Set，不依赖对象遍历顺序。但按 ADR 决定 3，链读取的是“现在的内容”，记忆正文、状态、`changedSinceDecision` 会随记忆变化而变化；这是设计上的跨请求差异，不是模型输入，也不属于遮盖或时间字段导致的字节漂移。模型侧文本没有新增这类值。

3. **有没有对应的自动检查，反向用例真的会失败？** 有：集成测试覆盖完整链、`not_recorded` 与 `none` 的区分、他人/不存在记录、敏感正文、非 proactive 的 `not_applicable`、100 条上限；控制中心单测覆盖抽屉状态和“读取失败/已清除”；真实浏览器测试覆盖 404、缺项和手机宽度；契约 fixture 覆盖 query/snapshot。反向用例中，敏感测试若删除主正文或原话隐藏会失败；但它没有覆盖 `supersededBy.text` 和依据节点正文的隐藏，这两个门的变异目前不会让测试变红。`ruleId` 契约兼容、`append` 丢字段、依据预算/错误提示也没有自动检查。

4. **每个产生或修改的值，两端都能接受吗？** 逐项核对如下：
   - `decision.chain.read` 与 `decision.chain.snapshot`：契约、网关分派、控制中心调用、测试 fixture 均存在；query 的 `decisionId` 由 `ids.next("...")` 产生（`前缀:UUID`，长度小于 128），能通过 `machineString` 和 SQL 的 1-128 校验。
   - `DecisionRecordRead.inputFields`：只作为键集合使用，排序后读取，不存在下游格式校验问题。
   - `ruleId`：**不匹配**。写入端允许 1-256 任意字符串，读取契约是 1-128 `machineString`；与 I-73 同类，需按两端统一校验。
   - `DECISION_RULE_CATALOG` 的 `origin`/`document`：当前值符合枚举和 `boundedString(64)`；但 `document` 的 64 字符上限没有在登记表测试中校验，未来长文档会直接让快照校验失败。
   - 记忆正文、原话、取代记忆正文：`singleLine` 截到 2000 字符，符合 `boundedString(2000)`；依据节点正文额外截到 500，符合 `boundedString(500)`。
   - `source.refs`：`#memoryViews` 已过滤到 `MEMORY_SOURCE_REF_MAX_LENGTH`（512），符合契约。
   - `status`、`kind`、`rating`、`basis.action`、`relatedRead`、`memoryRecall`：枚举值双方一致；`outcome`、`reasonCode` 在 DB 限制为 64，符合 `boundedString(64)`。
   - `mailCount`、`judged`、`related`、`total`：都是非负整数，符合 `integer(0)`。
   - `append` 的扩展输入：**不匹配**。约定要求保存的 `memoryByMail`、`usedMemoryIds`、`tentativeMemoryIds` 等，`insertLedgerRow` 不保存，读取端永远看不到。
   - 操作安装：生产组合中 `memoryControl` 同时带 `ledger` 和 `consolidation`，因此 `decision.chain.read` 的安装名单和实现是一致的；如果未来出现只有 memory 没有 ledger/consolidation 的组合，按钮会出现但请求会返回 409，需要在组合处或安装名单上区分。

**提示（非本 PR 引入）：** 已确认 `docs/adr/0191-*` 有两份文件；我没有运行 `check:adr-numbers`，但按仓库内容该检查应为红。
