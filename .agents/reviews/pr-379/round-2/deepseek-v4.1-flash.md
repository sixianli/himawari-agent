## 结论

改动的主路径和作者说法基本一致：默认值仍是 850，默认的去留结果不变；新增原因码能通过现有账本校验；抽取阶段的标记方式确实避免了提交时读库。但我发现一个会污染新门槛校准数据的分类记录问题，另有几处防御性和文档一致性缺口。

## 问题（读代码证实）

### 1. 中：`unchanged` 转正写入账本的分类不是实际用来查门槛的分类

文件：`packages/application/src/services/automatic-memory-service.ts:571`、`apps/agent-service/src/production-memory-capture.ts:471`

证据：

```ts
// production-memory-capture.ts:471-476
...(confirmsTentative
  ? {
      confirmsTentativeCategory:
        decision === "unchanged"
          ? (input.tentativeMemories?.get(existing)?.category ?? category)
          : category,
    }
  : {}),
```

```ts
// automatic-memory-service.ts:186-188
candidate.confirmsTentativeCategory === undefined
  ? thresholdFor(gates.autoCommit, candidate.attributes?.category ?? null)
  : thresholdFor(gates.confirmTentative, candidate.confirmsTentativeCategory))
```

但账本分类仍取候选属性里的分类：

```ts
// automatic-memory-service.ts:571
category: detail.candidate?.attributes?.category ?? null,
```

对 `unchanged` 候选，`attributes.category` 来自模型这次输出（没写就是 `other`），而门槛用的是那条既有记忆的 `confirmsTentativeCategory`。这两者可以不同，测试里甚至专门构造了这种场景：

```ts
// tentative-memory-capture.unit.test.ts:296-307
const { result, ledger } = await capture([reaffirm("preference", 800, "health")], { gates });
expect(result.committedMemoryIds).toEqual([]);
expect(ledger.map(({ reasonCode }) => reasonCode)).toEqual(["confirm_below_threshold"]);
```

这条测试只断言了原因码，没有断言账本 `category`。实际写进去的是 `preference`，而门槛是按 `health` 查的。`scripts/calibration-report/thresholds.mjs` 用账本的 `category` 做分桶（`packages/calibration/src/thresholds.ts:187`、`:440-449`），因此新门槛的按分类校准会把 `unchanged` 转正样本归到错误分类，进而给出错误建议。

建议：`candidateLedger` 对确认候选优先使用实际生效的分类，例如 `detail.candidate?.confirmsTentativeCategory ?? detail.candidate?.attributes?.category ?? null`；并补一条断言账本 `category` 的反向用例。

### 2. 低：服务端只凭 `confirmsTentativeCategory !== undefined` 判定转正，不校验候选形态

文件：`packages/application/src/services/automatic-memory-service.ts:181`

证据：

```ts
const confirmsTentative = candidate.confirmsTentativeCategory !== undefined;
```

字段是可选、可序列化的。当前唯一生产生产者 `parseMemoryCandidates` 只在 `unchanged/update/merge` 且目标是待确认记忆时设置它，所以生产路径没问题；但 `AutomaticMemoryService` 的选项是公开的，任何其他抽取实现或未来改动只要给一个 `decision: "create"` 的候选塞上这个字段，就会绕过自动存入门槛，并写 `tentative_confirmed`。建议在服务端显式校验：

```ts
candidate.confirmsTentativeCategory !== undefined &&
candidate.decision !== "create" &&
candidate.existingMemoryId !== null
```

或在类型/运行时校验入口拒绝不一致的候选。

### 3. 低：`audit` 结果仍写旧原因，和“决策记录原因码改了”不完全一致

文件：`packages/application/src/services/automatic-memory-service.ts:208`、`:230-235`

证据：

```ts
await this.audit(input, candidateOrdinal, "confidence_below_threshold", []);
...
await this.audit(
  input,
  candidateOrdinal,
  explicitlyApproved ? "explicitly_approved" : "auto_committed",
  [],
);
```

账本里新转正写 `tentative_confirmed` / `confirm_below_threshold`，但 `audit` 日志仍写 `auto_committed` / `confidence_below_threshold`。作者说的是“决策记录”即账本，所以不算行为错误；但 `apps/agent-service/src/service-main.ts:1994-2001` 会把 `audit.outcome` 写进服务诊断日志，按日志统计时看不出转正。要么接受这是有意保留，要么在文档里写清楚两套原因码的对应关系。

### 4. 低：ADR 0143 的原因数量前后矛盾

文件：`docs/adr/0143-decision-ledger-for-model-gate-decisions.md:53`

同一条里先写“丢弃共有六种原因”，末尾又写 `confirm_below_threshold`“这是第七种丢弃原因”。而且 `candidate_secret_excluded` 已被 ADR 0183 删除，当前实际原因应是六种（五种旧的 + 新的）。建议把“第七种”改成“第六种”，或改成不依赖计数的表述。

### 5. 低：自动检查覆盖不完整

文件：`packages/application/test/tentative-memory-capture.unit.test.ts:319`

正向和反向的门槛选择测试是有效的：把 `confirmTentative.defaultThreshold` 设为 0 或把分类换掉，现有断言会失败。缺口有三处：

- 没有任何测试把 `tentative_confirmed` / `confirm_below_threshold` 写进真实 SQLite 账本。我核对过 `validateLedgerWrite` 只检查原因码长度（`packages/persistence-sqlite/src/sqlite-decision-ledger-operations.ts:57`），最新表结构也仍是长度检查（`migrations/0087_rule_book_memory_link.sql:35`），所以能通过；但没有自动门槛守这一点，正符合 I-73 的教训。
- “replaying the same confirmation writes the same decision record” 用的是两次相同合成候选，不能真正证明“按抽取时快照重放不变”。
- 没有测试断言账本 `category` 等于实际查门槛的分类，所以问题 1 不会被发现。

建议补一条用真实 SQLite 写入新原因码的集成用例，并在问题 1 的修复处断言账本分类。

## 推测 / 未核实

- **“按分类可配”目前仍只是改源码常量。** `MEMORY_TENTATIVE_CONFIRM_GATE.byCategory` 是冻结的空对象，`createProductionAutomaticMemory` 不传 `gates`，生产路径始终用 `DEFAULT_CAPTURE_GATES`。如果“可配”指的是主人或部署配置可改，这条改动并没有提供运行时配置入口；如果沿用 P4-4 的“改 `thresholds.ts` 再发布”口径，则和现状一致。未找到其它配置读写路径，标为推测。
- **快照与提交之间的竞态。** 新做法按抽取时快照判定是否待确认，`DurableMemoryService.applyProposal` 提交时仍看当前库状态。若抽取后该记忆被手动确认或归档，门槛选择和最终实际动作可能不一致。窗口很短，未找到生产复现路径，标为推测。
- **跨版本重放的账本 id。** `ledgerId` 含原因码，升级后重放同一 `generationId`、`candidateOrdinal` 会生成不同 id，可能多一行账本。是否可重放取决于任务调度，未核实。
- 我没有运行测试、类型检查或任何非 `git` 命令；结论只来自读代码和阅读 diff。

## 侧重检查

- **错误路径 / 不可信输入**：`parseMemoryCandidates` 对 `existingMemoryId`、`category`、`confirmsTentative` 都有校验和默认值；`input.tentativeMemories` 取值有兜底，不会抛错。服务端对 `confirmsTentativeCategory` 的形态校验不足，见问题 2。
- **安全**：新字段不是模型直接输出，分类值经过 `CATEGORIES` 白名单；账本 `category` 仍会经过 `DECISION_CATEGORIES` 和 SQLite CHECK。未发现新增敏感信息落日志或落明文。
- **资源耗尽**：没有新增无界循环或大对象；候选数量仍受既有上限约束，只多了一个查找表。
- **不可撤销操作**：转正会把 `tentative` 置为 `false`，是状态变化，但本改动没有新增删除类操作；默认门槛不变，只有显式配置分类覆盖后才会改变转正数量。
- **规则 / 文档与代码一致性**：ADR 0179 的描述和代码一致；ADR 0143 的“七种/六种”不一致，见问题 4。`prompt-prefix` 规则要求的“模型请求只追加、开头不变”没有被本改动触碰。

## 必答问题

1. **会不会改变模型已经见过的请求开头？** 不会。会话的系统提示、工具定义、历史消息、遮盖结果都没有改。唯一相关的是记忆抽取这个后台请求，但 `memoryCapturePrompt` 只序列化 `id/text/stance`（`apps/agent-service/src/production-memory-capture.ts:182-186`），新增的 `ExistingMemoryText.category` 不会进入提示词；`confirmsTentativeCategory` 也只存在于候选对象和账本中，不会发给模型。发给模型的内容仍是固定指令在前、本次消息数据在后，没有把每轮变化的值塞进请求开头。默认门槛下记忆去留也不变，因此后续召回内容不变。
2. **会不会让同一段文字在不同请求里变成不同字节？** 对模型请求不会。新增字段不参与提示词序列化。对账本/候选持久化，`unchanged` 的 `confirmsTentativeCategory` 取决于抽取时那条记忆的分类快照，若库中分类在两次重放之间变了，同一模型输出会产生不同的候选字节和原因码；但这是决策数据，不是模型输入。另有一个本来就有的事实：账本 id 含原因码，升级后重放会产生不同 id。
3. **有没有对应的自动检查，反向用例真的会失败？** 有。`tentative-memory-capture.unit.test.ts` 覆盖了正分类覆盖、正式记忆仍走自动门槛、`unchanged` 用记忆分类而不是模型分类、默认 850 的边界和原因码。其中“正式记忆不被当成转正”“模型分类不生效”“默认原因码”这几条如果实现回退，确实会失败。缺口是：没有真实 SQLite 写入新原因码的检查，也没有账本分类正确性的反向用例；“重放”测试本身较弱。
4. **每个值的使用端都能接受吗？** 逐项核对如下：
   - `tentative_confirmed` / `confirm_below_threshold`：`validateLedgerWrite` 只检查原因码 1–64 字符（`sqlite-decision-ledger-operations.ts:57`），SQLite 最新表结构同样只检查长度（`migrations/0087_rule_book_memory_link.sql:35`），字符串长度远小于 64，能接受。
   - 账本 `outcome`：保留 `kept` / `discarded`，仍在 `DECISION_OUTCOMES.memory_candidate` 和 SQLite CHECK 允许范围内。
   - 账本 `category`：值来自 `MemoryCategory`，与 `DECISION_CATEGORIES` 和 DB CHECK 的十个分类一致；但 `unchanged` 时记录的是模型分类而不是实际生效分类，见问题 1，这是语义错误而不是校验失败。
   - `confirmsTentativeCategory`：唯一消费者是 `AutomaticMemoryService`；也会随敏感候选 JSON 持久化，读取端只做类型断言、不校验，但字段可选且不参与后续分支，能接受。
   - `MEMORY_TENTATIVE_CONFIRM_GATE.key = "memory_candidate.confirm_tentative"`：被 `THRESHOLD_GATES` 和 `scripts/calibration-report/thresholds.mjs:92` 自动消费，报告只把它当作标题键，没有额外白名单校验，能接受。
   - `ExistingMemoryText.category`：只被 `ProductionMemoryCapture` 用来构造 `tentativeMemories`，不进入提示词，能接受。
