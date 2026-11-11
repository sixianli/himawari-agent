## 结论

050f0a0..b8040df 的增量（#abandoned → #settled、存成功后删行失败不再抛错、两条测试、ADR/条数同步）整体逻辑与作者说法一致，没有发现高严重度问题。发现 3 个低严重度和 1 个覆盖缺口；其中「补做第 3 次失败时先删行后写记录」是既有代码，本轮没有改到，但与刚同步过的 ADR 仍有冲突。

---

## 读代码证实的问题（按严重度）

### 1. 低（偏中）：补做放弃路径仍先删行、后写记录，删行失败会吞掉「放弃」记录

- 文件:行：`apps/agent-service/src/production-memory-capture.ts:913-926`
- 问题：补做第 3 次失败的 `gaveUp` 分支先 `backlog.remove(...)`，再 `#recordFailure(..., "capture_gave_up", ...)`。如果删行抛错，函数直接冒泡，`capture_gave_up` 决策记录不会写入；这与 ADR 0222 决定 5「第 3 次仍失败就删行、记『放弃』」和决定 6「每次失败一条决策记录」不一致。该段不是本轮新增（本轮只把 `#save` 改成先记录再删行），但本轮同步 ADR 后仍然存在不一致。
- 证据：

```ts
// production-memory-capture.ts:918-925
const gaveUp = attempts >= MEMORY_CAPTURE_BACKLOG_MAX_ATTEMPTS;
if (gaveUp) await backlog.remove(entry.generationId);
await this.#recordFailure(
  plan,
  gaveUp ? "capture_gave_up" : "capture_queued",
  code,
  `backlog:${attempts}`,
);
throw error;
```

- 后果：删行一直失败时，主人看不到「这轮没记全」，队员只看到 `onFailure` 的底层错误；同时 attempts 会继续增长到 4、5……超过 ADR 写的第 3 次。删行恢复后仍会补写记录，所以不是永久丢记录。
- 建议：先写 `capture_gave_up`，再删行（或让删行失败只上报、不阻塞记录），与 `#save` 的新顺序保持一致。

### 2. 低：ADR 决定 5 的「只有……」窗口不完整，与决定 4 自相矛盾

- 文件:行：`docs/adr/0222-retry-and-queue-failed-memory-capture.md:56-57`
- 问题：决定 5 说「只有在『存成功、删队列行之前』进程恰好重启时，下一次补做才会再存一遍」。但决定 4 已写明另一种窗口：写「放弃」之后、删行之前重启，会再补做一次。实际代码中，同轮第一次模型调用失败会先入队、重试成功后若存记忆失败，`#save` 写放弃再删行；这段窗口里重启同样会让下一次补做重新问模型并可能重复写入。决定 5 只列了「存成功」一种，与决定 4 不一致。
- 证据：

```md
// docs/adr/0222...:56
...进程恰好在写放弃之后、删行之前重启，这一条会再补做一次，这个窗口只有一次数据库写入那么长，本 ADR 接受它。
// docs/adr/0222...:57
...只有在“存成功、删队列行之前”进程恰好重启时，下一次补做才会再存一遍...
```

- 建议：决定 5 改成「存成功删行前」和「写放弃删行前（同轮重试成功但存失败）」两种窗口，或引用决定 4。

### 3. 低：`vi.waitFor` + `setTimeout(0)` 不会因事件顺序偶发失败，但 1 秒默认超时在慢机器上偏紧

- 文件:行：`test/integration/production-memory-capture.test.ts:2984-2991`、`3043-3050`
- 问题：`start()` 返回的是「模型准入」而非「整轮捕获完成」（`onAdmitted` 由 `generate` 在准入时调用），所以后台 `#settle` 确实可能在 `await start()` 之后才结束，必须等。当前写法本身是确定的：`#settle` 先 `#settled.add` 再 `onFailure`，所以 `vi.waitFor` 一旦看到 `PORT_UNAVAILABLE`，`#settled` 已写入、注入的 `removeFailures` 已减到 0；等待到的错误也只可能来自注入的删行失败。`setTimeout(0)` 并不构成额外的同步保证，但也不会引入错误。风险仅在于 `vi.waitFor` 默认 1 秒在极慢 CI 上可能超时。
- 建议：给 `vi.waitFor` 显式传入更长 `timeout`，或等待一个由测试控制的可确定 promise；不需要后续轮次时可用 `stop()`。

### 4. 低：`#settled` 的「删行成功后移除」和 1000 上限没有反向用例

- 文件:行：`apps/agent-service/src/production-memory-capture.ts:869-881`；测试 `test/integration/production-memory-capture.test.ts:2956-3065`
- 问题：作者声称「去掉 #settled 的加入或读取时，这两条测试都失败」，这一点我按代码推演成立（见必答问题 3）。但 `#settle` 成功时的 `this.#settled.delete(...)` 没有任何反向用例；而且在正常流程里它几乎不可达（一旦 `#settled` 有该编号，replay 会走只删行分支，不会再调用 `#save`）。1000 上限淘汰也没有测试。
- 建议：补一个上限淘汰/成功清理的单元测试，或删掉不可达的 `delete` 分支。

---

## 推测 / 未核实

- 补做提示词里的 `existingMemories` 来自 `state.readMany`、`existingSubCategories` 来自 `book.listSubCategories`，其顺序我未核实是否由 SQL 的 `ORDER BY` 固定；如果底层返回顺序不稳定，同一状态可能序列化成不同字节。这是本 PR 早期就有的提示词构造，不是本轮增量引入的；本轮没有改 `memoryCapturePrompt`。
- `memory_capture_backlog.generation_id` 上限 256，而生成编号是 `"memory-capture:" + sourceRunId`。我没有查到 run id 的长度上限；如果 run id 超过 241 字符，入队会被 `PORT_INVALID_OPERATION` 拒绝。内部生成的 run id 通常很短，未核实这是否可达。

---

## 侧重检查

- 错误路径：`#save` 存失败 → 写 `capture_gave_up` → `#settle` → 抛原错误；`#settle` 删行失败不再抛，改为 `#settled.add` + `onFailure`；replay 的 `#settled` 分支删行失败会冒泡到 `start()` 的 `replay.catch(onFailure)`。上述路径与作者说法一致。唯一问题是补做 `gaveUp` 分支仍先删行后写记录（问题 1）。
- 不合规/不可信输入：错误码经 `captureErrorCode` 用 `^[A-Z][A-Z0-9_]{0,127}$` 过滤，记录时再截到 64；generationId 由内部 run id 拼出，不来自模型输出；DB 检查接受三个新结果值和 1..64 的 reasonCode；决策记录 id 是 `"ledger:"+40 位十六进制`（47 字符），在 1..128 内。没有把用户文本拼进标识。
- 安全：`#settled` 只存生成编号，不含内容或秘密；本轮不碰系统提示、遮盖和日志内容。
- 资源耗尽：`#settled` 上限 1000，和 `#captured` 一致；backlog 每个 run 一行，不会按轮次无限增长。删行长期失败时行会滞留、`#settled` 条目会挤占，但有界。
- 不可撤销操作：删队列行发生在提交成功或写完放弃之后；删除是幂等的，且不会删除记忆内容。本轮没有新增不可撤销动作。
- 规则/文档与代码：测试条数 19 一致（13 条集成 + 6 条迁移，`scripts/check-memory-capture-retry.mjs:13` 的 `REQUIRED = 19`，ADR 0222:95 和 casebook:278 也都是 19）。决定 3「先写放弃再删」现在与代码一致；决定 4 与 `#save`/`#settle` 基本一致；决定 5 的窗口措辞仍不完整（问题 2）。

---

## 必答问题

### 1. 会不会改变模型已经见过的请求开头？

不会（就本轮增量而言）。本轮只改 `#save`/`#settle`/`#settled` 的后台簿记和测试、ADR；没有改系统提示、工具定义、历史消息、遮盖规则，也没有改提示词构造。发给模型的内容仍由固定文字在前、JSON 数据在后的 `memoryCapturePrompt` 生成（`production-memory-capture.ts:185-201`）；同轮重试复用同一个 `plan.prompt` 和 `plan.tag`，因此两次请求逐字节相同。补做是另一次独立的后台请求，ADR 明确说它按当前记忆状态重建、不是原轮的逐字复刻，但它不是对已发出请求的改写或前缀变更。故「只在末尾追加」这一约束没有被本轮破坏。

### 2. 会不会让同一段文字在不同请求里变成不同字节？

本轮不会新增这类问题。`#settled` 是进程内集合，不参与任何序列化、遮盖或提示词生成；本轮没有新增时间字段、无序集合遍历或前后文相关的遮盖。同轮重试复用缓存的 `plan.tag`；补做的遮盖标签来自稳定的出口密钥（`packages/application/src/services/model-egress.ts:528-530`），同一段文本的遮盖字节不会因请求不同而变化。补做提示词里的记忆列表会随当前状态变化，这是 ADR 决定 5 明确接受的设计，不是本轮引入的。排序是否完全确定见上面「未核实」。

### 3. 有没有对应的自动检查，反向用例是否真的会失败？

有。`scripts/check-memory-capture-retry.mjs` 只统计带 `[P3-5]` 的测试，要求至少 19 条通过；实际是集成测试 13 条 + 迁移契约 6 条（`it.each` 三个结果值各一条）。反向用例按代码推演成立：
- 去掉 `#settled.add`：存成功/放弃后删行失败不会留下标记，下一轮 replay 会再次问模型；两条测试的 `calls.slice(2)` 会多出 `memory-capture:run-...:backlog`（或缺少预期的只删行行为），因此失败。
- 去掉 `#settled.has` 读取：同样会让 `run-after` 的 replay 再问一次模型，`calls` 断言失败。
- 但「删行成功后从 `#settled` 去掉」和 1000 上限没有反向用例（问题 4）；补做放弃路径的「删行失败仍要写放弃记录」也没有测试。

### 4. 改动产生或修改的每个值，使用它的地方都能接受吗？

逐项核对：
- `#settled` 的值是 `#plan` 生成的 `generationId = memory-capture:<sourceRunId>`（`production-memory-capture.ts:1039`），只在本类内部使用；测试里注入的 `"memory-capture:run-memory-capture"` 与 `setup()` 中 `turn(..., "run-memory-capture")` 及 `requestFor` 一致。
- `capture_retrying` / `capture_queued` / `capture_gave_up` 同时被 `DECISION_OUTCOMES.memory_candidate`（`packages/application/src/ports/decision-ledger.ts`）、迁移 0088 的 `decision_ledger` CHECK（`0088_memory_capture_backlog.sql:66-69`）、`daily-review`、`calibration`、控制中心文案接受；迁移契约测试逐值写入验证。
- `reasonCode = errorCode.slice(0, 64)` 对 DB 的 `reason_code` 1..64 检查安全；`subjectRef = generationId` 对 1..256 检查安全；决策记录 id 47 字符对 1..128 检查安全。
- `MEMORY_CAPTURE_BACKLOG_MAX_ATTEMPTS = 3` 与 ADR「第 3 次」一致；backlog 表 `last_error_code` 1..128 与 `captureErrorCode` 的上限 128 一致。
- 新测试的注入条件只对目标 `generationId` 生效，能让 `#settled` 分支被真正覆盖；未发现生产值和校验端不匹配的地方。唯一未核实的是 run id 极长时 `generationId` 超过 backlog 256 上限的边界（见「未核实」）。
