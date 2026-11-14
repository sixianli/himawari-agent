# PR 423 第 7 轮增量复核（d7db14892..2fc4b3f6）

## 问题（按严重度）

### 1. 中：新加的“复用”用例没有真正覆盖缓存，删掉回顾里的 SupportVerdictCache 这条用例仍会通过
- 文件:行：`test/integration/memory-conversation-review.test.ts:670-693`
- 问题（读代码证实）：这条用例想用“第一次 `runDue` 在 `SETTLE_LOST` 后重跑不再问裁判”证明缓存复用，但第一次失败点在记忆已经转正**之后**，第二次运行时记忆已不是 tentative，根本不会再产生 support check。
- 证据：
  - `#commit` 先应用记忆再结算：`production-memory-conversation-review.ts:890` `await service.processCommittedRun({...})`，之后才是 `:904` `await this.#settle(plan.review);`。
  - 测试注入的失败在 `#settle` 里（`failSettles` 只在 `afterRevision !== null` 时抛，见 `test:285-290`），此时转正已发生：`durable-memory-service.ts:118-119` `return current.status === "active" && current.attributes?.tentative === true ? this.confirm(current.id, generationId) : current;`。
  - 只有 `input.tentativeMemories` 里有的记忆才产生裁判检查：`production-memory-capture.ts:389-399`（`confirmsTentative && evidenceVerified && ...`）。第二次运行时 osaka 已非 tentative，`first.supportChecks` 为空，`#judgeSupport` 不会被调用。
  - 因此 `test:690-691` 的第二次 `runDue` 后 `prompts` 本来就还是 2；把 `#supportCache` 整个删掉，结果不变。
- 建议：让第一次失败发生在裁判之后、`processCommittedRun` 之前（例如给 `generations.request` 加一次性失败，或在 `:904` 之前注入一次性错误），使重跑时记忆仍为 tentative，才能真正断言“不再问裁判”。也可以另建一个相同文本/引用的新 episode 来验证跨 episode 复用。

### 2. 低：缓存键不含数据分类，敏感/私有场景会跨分类复用同一个裁判结论
- 文件:行：`apps/agent-service/src/production-memory-capture.ts:176-179`
- 问题（读代码证实）：`#key` 只用 `SUPPORT_JUDGE_VERSION + memoryText + quote`。本次改动的目的之一是“裁判按当天对话的分类发出”，但同一条文本/引用先在 private 下判过，之后在 sensitive 的回顾里会直接命中缓存、不再以 sensitive 分类发裁判调用。
- 证据：`production-memory-capture.ts:178` `.update(\`${SUPPORT_JUDGE_VERSION}\u0000${check.memoryText}\u0000${check.quote}\`)`；回顾侧 `production-memory-conversation-review.ts:764-768` 命中即 `continue`。
- 影响（推测）：裁判输入只有“记忆原文+引用”，且当天回顾的主输出本身已按 `plan.request`（episode 分类）发出，因此不构成新的数据泄露；但“这次敏感数据是否实际经过敏感分类的模型路由”在审计上会失真。
- 建议：除非 ADR 明确要跨分类复用，否则把 `dataClassification` 一并放进缓存键（同时改 ADR 0249 决定 2 的键说明）。当前代码与 ADR 文字是一致的，这一点不是文档不一致。

### 3. 低：缓存命中会跳过新加的“正在停止/仍持有执行权”检查
- 文件:行：`apps/agent-service/src/production-memory-conversation-review.ts:764-770`
- 问题（读代码证实）：`#supportCache.get` 在 `this.#stopping` 和 `assertActive()` 之前，缓存命中直接 `continue`。作者说法（3）“每问一条之前先查是否正在停止、是否还持有执行权”只对“实际要问”的条目成立；全命中时这两项检查被绕过。
- 证据：
  - `:764-768` 先查缓存并 `continue`；
  - `:769-770` 才是 `if (this.#stopping) throw ...; await this.#options.assertActive();`。
- 影响（推测）：写入前 `#commit` 的 `assertActive`（`:830`）和模型准入里的 `authority.assertActive()`（`production-run-composition.ts:215-218`）仍会兜底，所以不会在失去执行权后写库；但“停止后不再继续推进回顾”的语义在缓存全命中时不完整。
- 建议：把停止检查提到缓存查询之前；是否每次缓存命中都调用 `assertActive()`，看是否愿意多一次轻量检查。

### 4. 低：线上评测把裁判失败当“不确认”吞掉，且 judgeFailures 没有进入汇总/通过判定
- 文件:行：`scripts/evals/memory-conversation-review-live.eval.ts:185-195`、`:235-248`、`:279-300`
- 问题（读代码证实）：`judgeOrDefault(..., false, () => { outcome.judgeFailures += 1; })` 会把预算耗尽/网络/格式失败都变成 `false`；`score` 只看 `confirmed` 等结果，不检查 `judgeFailures`，`summary` 也没有聚合它。于是“裁判根本没跑成功”可能表现为“模型认为不支持”，在本来就没有期望确认的条目上照样 pass。
- 证据：
  - `:185-195` 失败回调只自增计数并返回 `false`；
  - `:242-247` `pass` 条件不含 `judgeFailures`；
  - `:279-300` 汇总只有 `errors`（=`outcome.error`），不含 `judgeFailures`。
- 建议：把 `judgeFailures` 计入 `score.pass` 或至少进入 `summary`；预算耗尽应作为评测中止/错误，而不是逐条吞成 `false`。

## 侧重检查

- **错误路径**：裁判失败不缓存（`settled` 只在 `judgeOrDefault` 的失败回调里置 false，`:772-788`），符合“失败的结果不复用”；`#stopping`/`AUTHORITY_LOST` 抛出后由 `runDue` 的 catch 结算并标记失败（`:527-538`），错误码 `MEMORY_CONVERSATION_REVIEW_STOPPING` 能通过 `captureErrorCode` 的格式校验（`production-memory-capture.ts:742`）。
- **不合规范/不可信输入**：裁判输入来自模型输出恢复后的 `quote` 和已存记忆 `text`，提示词把数据放在固定指令之后（符合 prompt-prefix 第 15 条）；没有新增外部输入入口。
- **安全/分类**：`plan.request` 在 `:661` 生成，`#output` 与 `#judgeSupport` 都用它；记忆和消息在 `#plan` 已按 `allowed()` 过滤，裁判输入的文本不高于当天 episode 分类（`:565-567`、`:621-629`）。跨分类缓存见问题 2。
- **资源耗尽**：`MAXIMUM_SUPPORT_CACHE = 500`，到上限整表清空（`:171-174`），内存有界；每条检查最多两次模型尝试（`judge.ts` 的 `DEFAULT_ATTEMPTS`）；评测的预算错误被吞见问题 4。
- **不可撤销操作**：确认/转正仍发生在 `processCommittedRun`，之前有 `assertActive()`（`:830`）和模型准入；缓存只复用布尔判定，不直接写库。
- **文档一致性**：ADR 0249 决定 2 的新文字与代码一致（“按当天分类发出、每问一条前查停止/执行权、进程内复用、失败不复用”）；缓存键也与 ADR 写的“规矩文本、引用、提示词版本”一致。不足是作者说法（4）里的“复用用例”实际不构成回归护栏，见问题 1。
- 未核实：受记录路径限制，未能读取 `.agents/reviews/pr-423/round-6` 的原始意见；未运行测试或 lint，以上结论均来自阅读代码与 diff。

## 必答问题

1. **会不会改变模型已经见过的请求开头？** 不会。本次只改了回顾里裁判这一条**独立辅助调用**的参数（`request` → `plan.request`，`production-memory-conversation-review.ts:747`），不碰对话请求的系统提示、工具定义或历史；会话内容仍是“只在末尾追加”，每轮会变的分类是调用元数据，没有进入提示词字节。裁判提示词是固定指令在前、本次数据（memoryText、quote）在后（`production-memory-capture.ts:187-195`）。
2. **同一段文字会不会在不同请求里变成不同字节？** 不会。裁判提示词由固定模板 + `JSON.stringify({pendingMemory, ownerQuote})` 确定性拼出；缓存键是固定版本的 SHA-256（`:176-179`）。缓存只会让后续请求**不再发**这条裁判，而不会改变已发出内容的字节。
3. **有没有对应自动检查、反向用例真的会失败？** 部分有：
   - “确实问了裁判/问了两次”的反向断言有效（`test:637-668`）；
   - 分类用例有效：把裁判改回原始 `request` 会得到 `["sensitive","private"]`，`test:689` 会失败；
   - 失去执行权用例有效：去掉 `#judgeSupport` 里的 `assertActive()` 后裁判会被问一次，`test:712` 的 `prompts` 长度会变 2，会失败；
   - **复用用例无效**，见问题 1，删掉缓存也能通过。
4. **改动产生/修改的每个值，使用端都能接受吗？** 读代码核对如下：
   - `plan.request.dataClassification`（`:661`）来源是 `episode.dataClassification`，消费端是 `generate` 的模型准入/路由（`production-run-composition.ts:215-218`、`production-model-composition.ts:530-537`），类型与语义都接受；
   - `SupportCheck.key` 由 `supportCheckKey(memoryId, quote)` 产生（`production-memory-capture.ts:393`），消费端是 `supportVerdicts.get(supportKey)`（`:405`）以及回顾 `#judgeSupport` 的 `verdicts.set(check.key, ...)`（`:789`），两端一致；
   - 新增的 `SupportVerdictCache` 键只在类内部产生和消费，不跨边界；
   - `judgeFailures`（`scripts/evals/...:51,126,192`）被序列化，但没有任何汇总/校验使用，见问题 4。
   没有新增配置键、清单项或序列化格式，因此不存在 I-73 那种“清单 id 过不了后端校验”的两端不一致。
