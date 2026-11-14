我先看改动范围和规则文件。
## 发现的问题（按严重度）

### 1. 低 — 作者说明与最终代码不一致：不是「一次传数组」，也不与 production-real-eval 的调用形状一致

- 文件/行：`packages/application/src/services/review-prereview.ts:397-399`；`apps/agent-service/src/production-real-eval.ts:319,362-364`
- 问题：作者说「改为 `model.release([authority.inputRef, ...outputs])`，与 production-real-eval.ts 一致」。实际上最终代码是**每个 ref 单独调用一次** `model.release([ref])` 并各自 catch；`production-real-eval.ts` 是**一次调用传整个数组**。
- 证据（读代码证实）：
  ```ts
  // review-prereview.ts:397
  await Promise.all(
    [authority.inputRef, ...outputs].map((ref) => model.release([ref]).catch(() => undefined)),
  );
  ```
  ```ts
  // production-real-eval.ts:319
  const payloads: string[] = [authority.inputRef];
  // production-real-eval.ts:362-364
  await authority.release();
  // ...
  await model.release(payloads);
  ```
  对应 real-eval 单测也明确期望一次数组：`apps/agent-service/test/production-real-eval.unit.test.ts:233` 的 `expect(released[0]).toEqual(["input:call-1", "out-1", "out-2"])`。
- 影响：只是说明文字/提交说明不准确，无运行时影响。per-ref 写法实际上比 real-eval 更稳，因为 `ProtectedPiModelPayloadBoundary.release` 是顺序循环，一个 ref 抛错会中断后面的删除（`packages/runtime-pi/src/pi-model-transport.ts:96-98`）。
- 建议：更新 PR/提交说明，改成「逐个释放，单个失败不影响其它 ref」，不要声称与 real-eval 调用形状一致。

### 2. 低（既有问题，非本改动引入）— 启动校验只要求 `private`，但预复核实际可能以 `sensitive` 调用

- 文件/行：`packages/platform-node/src/strict-configuration.ts:1728-1736`；`packages/application/src/services/daily-review.ts:334-335,550-556`；`apps/agent-service/src/production-model-composition.ts:530-532`
- 问题：新增校验仍然只要求 `allowedDataClassifications` 包含 `private`。但预复核的 `DailyReviewSubject.dataClassification` 可以是 `sensitive`（`visibleClassification` 允许到 `sensitive`），随后 `model.prepare` 会因模型不接受 `sensitive` 抛 `PROACTIVE_MODEL_DISCLOSURE_DENIED`。也就是说，新校验通过不代表预复核一定能调用。
- 证据（读代码证实路径）：
  ```ts
  // daily-review.ts:334-335
  const highest = highestClassification(known[0] as DataClassification, known.slice(1));
  return isModelVisible(highest) ? highest : null;
  ```
  ```ts
  // daily-review.ts:550-556：subject 带上这个 dataClassification
  if (dataClassification === null || item.textHidden || item.text === "") return undefined;
  return { key: item.key, group, category: item.category, text: item.text, dataClassification, ... };
  ```
  ```ts
  // production-model-composition.ts:530-532
  async prepare({ invocationId, prompt, deadlineAt, dataClassification }) {
    if (!descriptor.allowedDataClassifications.includes(dataClassification))
      throw new Error("PROACTIVE_MODEL_DISCLOSURE_DENIED");
  ```
  邮件检查的召回也允许 `modelVisibleClassifications()`（含 `sensitive`）：`apps/agent-service/src/production-proactive-memory.ts:50-53`。
- 影响：如果生产把 `proactive.modelRef` 配成只允许 `private` 的模型，敏感记忆的预复核会失败并记录失败（失败是封闭的，不会把敏感内容发出去）。这是既有行为，不是本次改动造成的；生产实际配置是否只有 `private` **未核实**。
- 建议：要么在启动时要求 `sensitive`（但会改变现有配置语义），要么在预复核/记忆召回处按 `proactiveDescriptor.allowedDataClassifications` 过滤输入，并补一条「private-only 模型遇到 sensitive 预复核题」的用例。仅就本次「api 必须是 openai-completions」的目标而言，可不阻塞。

### 3. 低（测试覆盖）— 只注入了「输入 ref 释放失败」，没有注入「输出 ref 释放失败」

- 文件/行：`test/integration/review-prereview-production.test.ts:353,358-363`
- 问题：新测试确实覆盖了模型失败和输入释放失败，但没有覆盖某个输出 ref 释放失败时其余输出是否仍逐个释放。per-ref 改动是通用机制，输入和输出走同一路径，因此风险不高，但反向用例还差这一半。
- 证据（读代码证实）：
  ```ts
  // test:353
  h.releaseFails.input = true;
  // test:358
  expect([...h.released].sort()).toEqual(h.invocations.map((id) => `out-${id}`).sort());
  ```
  fake release 只对 `ref.startsWith("in-")` 抛错（测试文件中 `release` 实现）。
- 建议：增加一个 `releaseFails.output = true`（例如只让 `out-broken` 抛错），断言其它输出 ref 仍被释放；这不是阻塞项。

---

## 侧重检查

- **错误路径**：检查了 `prepare` 成功但调用失败、`model.failed`、输出读取失败、`authority.release` 失败、单个 payload 释放失败、`prepare` 内密钥句柄获取失败等路径。
  - `review-prereview.ts:395-400` 在 `finally` 中先 `authority.release` 再逐个释放 payload，均 catch；即使 `authority.release` 或某个 ref 释放失败，其余 ref 仍会尝试。
  - `production-model-composition.ts:553-555` 在句柄获取失败时会释放刚写入的 inputRef，这部分原本就正确。
  - 读代码结论：本次改动让错误路径更完整，没有发现新泄漏。
- **不可信/不合规输入**：`proactive.modelRef` 由 `safeReference` 解析（`strict-configuration.ts:1131` 附近），模型描述符由严格解析器校验；本次没有新增外部输入字段。释放用的 ref 来自内部 `writeText` 和模型事件，`payloadStore.delete` 按 owner/agent 作用域删除（`durable-adapters.ts:304-309`），没有引入跨作用域删除。
- **安全**：这次改动的重要收益就是不再把预复核提示的加密 payload 留在表里。释放发生在模型调用完成后，不会影响 `allowedDisclosureRef` 的使用；没有提前删除正在使用的 payload。
- **资源耗尽**：`Promise.all` 会同时发起每个 ref 的释放调用。生产模型输出受 `MAX_OUTPUT_BYTES = 4_096` 约束（`review-prereview.ts:42,381-387`），输出事件数量有上界，未发现实际资源耗尽风险。若未来替换成可产生大量空输出事件的 `ProactiveModelInvoker`，`outputs` 数组本身没有事件数上限（既有问题，非本次引入）。
- **不可撤销操作**：删除 payload 不可撤销，但发生在调用结束后的清理阶段，且这些 ref 对预复核不再有其它读取者；没有发现竞态。
- **规则/文档/代码一致性**：`docs/execution/specs/2026-10-29-proactive-loop-v1-gmail-design.md:299` 与 `strict-configuration.ts:1731` 的 `openai-completions` 要求一致；`production-model-composition.ts:508-513` 的运行时检查也一致。唯一的不一致是作者说明中的释放调用形状（见发现 1）。
- **未核实**：受工具限制没有运行测试；生产 `config.json` 未读；`.agents/reviews/pr-472/round-1/*` 因稀疏检出和 git 拒绝未能读取。

---

## 作者说法逐条核对

1. **「authority.release() 只吊销密钥句柄；原代码只 release(outputs)，提示 payload 留下」——正确。** 见 `production-model-composition.ts:562-564` 与基准 diff 中的旧行 `model.release(outputs)`。
   - 但「改为 `model.release([authority.inputRef, ...outputs])`，与 production-real-eval.ts 一致」**不完全正确**：最终是逐个释放；real-eval 是一次数组调用（发现 1）。
2. **「proactiveModel 对非 openai-completions 抛 PROACTIVE_MODEL_DISCLOSURE_DENIED，改为启动时也要求 openai-completions」——正确。** `production-model-composition.ts:508-513` 与 `strict-configuration.ts:1727-1736` 一致；`realEval` 也检查同一个 `api` 条件（`strict-configuration.ts:1741-1751`）。但 realEval 还要求 `sensitive`，proactive 只要求 `private`，所以「与 realEval 的校验一致」只对 `api` 这一项成立。
3. **「邮件检查有意把 inputRef 留在 trace 里由检查记录负责」——正确。** `proactive-mail-check-service.ts:1399` 把 `authority.inputRef` 放进 `trace.payloads`，`sqlite-proactive-operations.ts:783-789` 把 `modelPayloads` 写入 `decision_ledger_payloads`。
4. **「两条回归用例旧代码失败、新代码通过」——从代码推理成立，但未实际运行。** 启动配置反向用例在旧条件下会接受 specialist（旧条件只排除 embedding 且要求 private，`strict-configuration.ts` 改动前的逻辑），新条件按 `api` 拒绝；释放用例在基准代码 `model.release(outputs)` 下会在第二次断言缺少 `in-` 而失败，在 c51c 的单次数组调用下会因输入释放抛错而漏掉输出。

---

## 必答问题

1. **会不会改变模型已经见过的请求开头？不会。** 本次只改了两处：`finally` 中的 payload 释放和启动配置校验。发给模型的内容仍由原来的 `prereviewPrompt` / `proactivePrompt` 组装：`prereviewPrompt` 是固定 `REVIEW_PREREVIEW.text` 后追加 JSON（`review-prereview.ts:64-75`），没有每轮变化的时间字段；`proactivePrompt` 的当前时间仍在最后（`proactive-mail-check-service.ts:462-504`）。没有新增、重排或改写系统提示、工具定义、历史消息或遮盖结果。发模型内容仍然只在末尾追加，每轮会变的值仍在最后。
2. **会不会让同一段文字在不同请求里变成不同字节？不会。** 释放逻辑不参与任何序列化；配置校验只决定服务是否启动，不改变请求字节。`prereviewPrompt` 的 JSON 键顺序固定，`maskSensitiveText` 只依赖该条 subject 文本；`proactivePrompt` 的列表顺序和时间位置也未改。
3. **有没有对应的自动检查？有；反向用例按代码推理会失败。**
   - 新增 `[PG-12][reverse]`（`packages/platform-node/test/startup-configuration.unit.test.ts:1572-1610`）在旧校验下会通过 specialist，从而断言失败。
   - `[P4-8] releases ...`（`test/integration/review-prereview-production.test.ts:348-364`）在基准代码下第二次断言缺少 `in-` 会失败；在 c51c 的单次数组释放下，输入 ref 抛错后输出不会被记录，第一段断言也会失败。
   - 缺口：没有覆盖「某个输出 ref 释放失败」这一半（发现 3）。受工具限制未实际运行测试。
4. **改动产生/修改的每个值，使用方都能接受吗？**
   - `configuration.runPolicy.proactive.modelRef`：产生处是严格配置解析（`safeReference` + 新增 `api === "openai-completions"` + `private`，`strict-configuration.ts:1727-1736`）；使用处是 `service-main.ts:1802-1806` 从 generation 描述符中找到它，再传给 `proactiveModel`（`service-main.ts:1999,2011`），而 `production-model-composition.ts:508-513` 正是要求 `openai-completions` 且允许 `private`。两端现在一致。`realEval.modelRef` 也走同一个 `proactiveModel`，它的启动校验同样要求 `openai-completions`（`strict-configuration.ts:1741-1751`），一致。
   - 释放的 ref：产生处是 `payloadBoundary.writeText`（inputRef）和 transport 的 `payload.writeText`（outputRef）；使用处是 `payloadBoundary.release` → `payloadStore.delete(ref)`（`pi-model-transport.ts:96-98`，`durable-adapters.ts:304-309`），接受任意已存在的字符串 ref，并按 owner/agent 作用域删除。inputRef 是同一 boundary 产生的合法 ref，能通过。
   - 本次没有新增标识、配置键、清单项、表结构或序列化格式；没有改动 migration。
   - 唯一剩余的应用层差异是 `private` 与 `sensitive` 的问题（发现 2），属于既有路径，不是本次新增值无法通过校验。
