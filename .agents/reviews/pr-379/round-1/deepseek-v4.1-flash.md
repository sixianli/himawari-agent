## 读代码证实的问题

### 高：转正判断依赖执行时的记忆状态，同一输入重放会得到不同结果

- 文件:行：`packages/application/src/services/automatic-memory-service.ts:186`、`packages/application/src/services/automatic-memory-service.ts:231`、`packages/application/src/services/automatic-memory-service.ts:109`；`packages/application/src/services/durable-memory-service.ts:105`
- 问题：`confirmsTentative` 在每次处理候选时实时读取状态，而第一次成功转正会立刻把 `tentative` 清掉。于是同一个 `generationId + candidateOrdinal` 重放时，第二次会走 `autoCommit` 门槛、换一个 `reasonCode`，账本 id 也因此不同，无法被 `ON CONFLICT (id) DO NOTHING` 去重；如果配置了 `confirmTentative < autoCommit`，第二次还可能把已经转正的记忆记为丢弃。
- 证据：
  - `automatic-memory-service.ts:109-111`：`return \`ledger:${bytesToHex(sha256(utf8ToBytes(key))).slice(0, 40)}\`;`，而 key 为 `${generationId}:${candidateOrdinal}:${outcome}:${reasonCode}`。
  - `automatic-memory-service.ts:186-193`：`const confirmsTentative = ... await this.options.isTentative({...})`。
  - `automatic-memory-service.ts:231-241`：第一次转正写入 `tentative_confirmed`。
  - `durable-memory-service.ts:105-118`：`unchanged` 时 `return current.status === "active" && current.attributes?.tentative === true ? this.confirm(...) : current;`，`confirm` 在 `durable-memory-service.ts:304-323` 把 `tentative: false` 持久化。
  - `test/integration/automatic-memory-golden.test.ts:355-357` 已经把“同一输入重放”当作契约测试，但只重放了 `durable-fact`，没有覆盖待确认记忆转正。
- 建议：不要把“是否待确认”和分类依赖在写入过程中实时读取；让抽取阶段把当时的 `tentative` 和分类作为候选/输入的稳定快照传进来，或者让账本 id 不依赖会变的 `reasonCode`，并在目标记忆已转正时把重复处理做成幂等空操作。补充一条“同一待确认记忆转正输入连续处理两次”的用例。

### 中：确认门槛使用模型候选的分类，而不是被确认记忆的真实分类

- 文件:行：`packages/application/src/services/automatic-memory-service.ts:196`；`packages/application/src/services/durable-memory-service.ts:105`；`apps/agent-service/src/production-memory-capture.ts:357`
- 问题：`unchanged` 候选的分类只用于查门槛，不会被写入记忆；真正被转正的记忆保留原分类。模型只要在候选里写一个覆盖值更低的分类，就能用该分类的门槛转正另一条记忆，绕过按分类设置的保护。
- 证据：
  - `automatic-memory-service.ts:196-201`：`thresholdFor(confirmsTentative ? gates.confirmTentative : gates.autoCommit, candidate.attributes?.category ?? null)`。
  - `durable-memory-service.ts:105-118`：`unchanged` 分支只确认状态，不更新 `attributes.category`。
  - `production-memory-capture.ts:357-361`：分类来自模型输出；`production-memory-capture.ts:448-449` 把它放进候选属性。
- 建议：让 `isTentative` 返回目标记录的 `status/tentative/category`，确认门槛使用数据库里已有记忆的分类；只有 `create` 才使用候选分类。补充“待确认记忆实际是 health，候选自称 preference”的反向用例。

### 中：只覆盖 `unchanged`，`update`/`merge` 转正仍走自动存入 850 门槛

- 文件:行：`packages/application/src/services/automatic-memory-service.ts:186`；`packages/application/src/services/durable-memory-service.ts:186`；`apps/agent-service/src/production-memory-capture.ts:345`
- 问题：抽取层把 `unchanged`、`update`、`merge` 都视为对同一待确认记忆的确认，仓库里的转正逻辑也会在 `update`/`merge` 时清掉 `tentative`；但这次新增的确认门槛只对 `unchanged` 生效。配置了更低的确认门槛后，同样是对待确认记忆的转正，只因模型选了 `update` 或 `merge` 就仍受 850 的自动存入限制。
- 证据：
  - `production-memory-capture.ts:345-348`：`confirmsTentative = ... (decision === "unchanged" || decision === "update" || decision === "merge")`。
  - `durable-memory-service.ts:186-191`：`...(proposal.attributes || current.attributes?.tentative ? { attributes: { ..., tentative: false } } : {})`。
  - `automatic-memory-service.ts:186-193`：新门槛判定条件只有 `candidate.decision === "unchanged"`。
- 建议：如果产品目标是“待确认记忆转正门槛”，应把三种会清掉 `tentative` 的决策都纳入；如果只允许 `unchanged`，请在 ADR 和测试里明确这是有意取舍。

### 低：默认行为并非完全一致，账本原因码和门槛归属都变了

- 文件:行：`packages/application/src/services/automatic-memory-service.ts:231`；`packages/application/test/tentative-memory-capture.unit.test.ts:292`
- 问题：默认 850 下，用户可见的“提交/丢弃”结果确实不变，但待确认记忆转正原先写 `auto_committed`，现在写 `tentative_confirmed`，并且会从自动存入门槛统计移到确认门槛统计。作者“默认行为与改前完全一致”的说法在账本层面不成立。
- 证据：
  - `automatic-memory-service.ts:236-240`：`explicitlyApproved ? "explicitly_approved" : confirmsTentative ? "tentative_confirmed" : "auto_committed"`。
  - 新增的“默认配置与原来一致”测试只断言了 `committedMemoryIds/tentativeMemoryIds` 和审计 `outcome`，没有断言账本 `reasonCode`，见 `tentative-memory-capture.unit.test.ts:292-310`。
- 建议：把作者说明改成“结果一致，账本原因码按新语义区分”；或者如果确实要逐字节保留旧账本，需要额外兼容策略。测试里明确断言默认情况下待确认转正的新账本原因码。

### 低：说明文档没有同步新增原因码和门槛

- 文件:行：`docs/adr/0143-decision-ledger-for-model-gate-decisions.md:53`、`docs/adr/0179-keep-low-confidence-memory-candidates-as-tentative.md:59`
- 问题：ADR 0143 仍写“丢弃共有六种原因”，现在多了 `confirm_below_threshold`；ADR 0179 仍说“自动存入门槛 850 和其他转正逻辑不动”，没有提新增的确认门槛和 `tentative_confirmed` 原因码。
- 证据：
  - ADR 0143 第 53 行列了六种丢弃原因，没有 `confirm_below_threshold`。
  - ADR 0179 第 59 行仍写“自动存入门槛 850 和其他转正逻辑不动”。
- 建议：更新 ADR 0143 的原因码清单，并在 ADR 0179 或新 ADR 里记录确认门槛、`tentative_confirmed`、`confirm_below_threshold` 和默认值。

## 推测

- 重放是否在生产中经常发生，我未能在仓库里确认所有调用链和重启恢复路径；但 `automatic-memory-golden.test.ts` 明确重放同一 `memoryInput`，说明这是预期支持的契约，风险不应忽略。
- 由于工具限制，我没有实际运行测试；反向用例是否真的会失败是根据测试代码与实现逻辑推断的。
- `update`/`merge` 是否应算“转正”属于需求解释；代码事实是它们确实会清掉 `tentative`。

## 侧重检查

- **错误路径**：`isTentative` 增加了一次 `state.readMany`，且没有 try/catch；读取失败会中断整个 `processCommittedRun`。候选最多 8 条（`production-memory-capture.ts:62`），资源耗尽风险低。
- **不合规范/不可信输入**：`existingMemoryId` 在抽取阶段已用 `existingIds` 校验，生产 `readMany` 也按 `ownerId/agentId` 限定；但 `unchanged` 候选的分类是不可信模型输入且未与被确认记忆核对，见上文中等风险。
- **安全**：初始 `tentative` 变正式本身是半不可逆写入；分类覆盖允许低于默认值会放大“低分转正”的风险，且当前实现允许模型用候选分类选择较低门槛。
- **资源耗尽**：每次 `unchanged` 多一次按 id 的单条查询，候选数有上界，未见明显放大。
- **不可撤销操作**：确认会清掉 `tentative` 并写历史；重复处理会产生重复账本/错误丢弃记录，见高风险项。
- **文档与代码一致性**：ADR 0143、ADR 0179 与新增原因码/门槛不一致，见低风险项。

## 必答问题

1. **会不会改变模型已经见过的请求开头？**
   不会。这个 diff 不改系统提示、工具定义、历史消息或遮盖逻辑，也不改 `memoryCapturePrompt` 的固定指令与数据顺序（`production-memory-capture.ts:169-194` 仍是“固定指令 + 末尾 JSON 数据”）。变化发生在模型输出之后的提交/丢弃决策。只有在配置了分类覆盖并因此多转正/少转正记忆时，后续后台抽取提示里的“已有记忆”数据会不同；这属于追加数据的变化，不是已发请求开头被改写。默认配置下 `byCategory` 为空、两门槛均为 850，故默认无影响。

2. **会不会让同一段文字在不同请求里变成不同的字节？**
   提示词序列化本身没有新增不确定性。但本轮新增了“依赖上一次处理结果”的 `isTentative` 判断：同一输入第一次处理写 `tentative_confirmed`，重放时目标记忆已不是 `tentative`，会改用 `autoCommit`，账本原因码和账本 id 不同；配置不同门槛时甚至可能从“转正”变成“丢弃”。这是本轮引入的、与请求重放/恢复相关的不确定性。

3. **有没有对应的自动检查，反向用例是否真的会失败？**
   有：默认值/登记表检查、按分类的自动存入覆盖、确认门槛与自动存入门槛分离、反向“正式记忆仍用自动存入门槛”、默认配置跨分类一致性，见 `packages/application/test/tentative-memory-capture.unit.test.ts:208-311`。其中 `REVERSE: reaffirming a formal memory still uses the auto-commit gate` 如果实现错误地把确认门槛应用到所有 `unchanged`，会失败。缺口是：没有覆盖同一输入重放；没有直接测试生产 `isTentative` 实现（golden 测试用的是自己的回调）；默认配置测试没有断言账本原因码。未实际运行测试。

4. **改动产生或修改的每个值，每个使用它的地方都能接受吗？**
   - `MEMORY_TENTATIVE_CONFIRM_GATE.key`：只出现在门槛登记表和报告文本，没有发现后端 ID 校验会拒绝它。
   - `tentative_confirmed`（19 字符）、`confirm_below_threshold`（23 字符）：通过 `validateLedgerWrite` 的 1–64 字符检查（`sqlite-decision-ledger-operations.ts:57`），也通过迁移 0069 的 `length(reason_code) BETWEEN 1 AND 64`；`outcome` 仍是 `kept`/`discarded`，通过 `DECISION_OUTCOMES.memory_candidate`。
   - `category`/`confidencePermille`/`inferred`：仍由 `validateLedgerWrite` 的候选校验覆盖；分类使用 `DECISION_CATEGORIES`，与门槛分类集合一致。
   - `isTentative` 的 `memoryId`：生产由抽取阶段 `existingIds` 校验，`readMany` 按 owner/agent 过滤，单次最多一个 id。
   - `CaptureGates` 的 `byCategory`：测试只验证了常量登记值，生产并没有运行时配置入口；真正配置后应额外验证分类名和整数范围。
   - 结论：数据库校验层面新原因码可以落库，I-73 式的“值被后端拒绝”问题没有发现；但确认门槛使用候选分类而不是被确认记忆分类，是上面列出的逻辑风险。
