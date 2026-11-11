## 已读代码证实的问题

### 高：提交阶段的失败既不重试也不入队，而且队列在提交前就被删了
- 文件:行：`apps/agent-service/src/production-memory-capture.ts:797-832`、`875-876`、`1074-1123`；可重试集合在 `665-675`。
- 问题：`try/catch` 只包住 `#extract`，`#commit` 在外面；同轮重试成功和补做成功都先 `backlog.remove` 再 `#commit`。提交阶段会做 `generations.request` 和 `service.processCommittedRun`，可能抛 `PORT_CONFLICT`（`packages/application/src/services/durable-memory-service.ts:139-142`）、`assertActive` 失败、投影/写库失败等。一旦发生：队列行已删，内存没写全，不重试、不重新入队、也没有 `capture_queued/gave_up` 决策记录。
- 证据：
  ```ts
  await backlog.remove(plan.generationId);
  }
  await this.#commit(plan, parsed);
  ```
  以及
  ```ts
  await backlog.remove(entry.generationId);
  await this.#commit(plan, parsed);
  ```
  但 `SAME_TURN_RETRYABLE_CAPTURE_ERRORS` 明确含 `"PORT_CONFLICT"`。
- 建议：把 `#commit` 纳入同一失败处理；只有提交成功后才删队列（或提交与删队列同事务）；提交失败重新入队/按次数重试，并补一条“模型成功、提交抛 PORT_CONFLICT”的测试。

### 高：待补队列没有原子领取，同轮重试与补做会抢同一条
- 文件:行：`apps/agent-service/src/production-memory-capture.ts:805-819`、`835-844`；`packages/persistence-sqlite/src/sqlite-memory-capture-backlog-operations.ts:90-108`。
- 问题：第一次失败就先入队，再同轮重试；另一轮（或另一个进程）的 `#replayOne` 只排除“本轮生成编号”，没有数据库级 claim/租约。`#replaying` 只是单个实例内的 Set，挡不住“A 轮正在同轮重试、B 轮同时补做 A 那一条”，也挡不住多进程。
- 证据：
  ```ts
  const entry = await backlog.oldest({
    ownerId: request.ownerId,
    agentId: request.agentId,
    excludeGenerationId: `memory-capture:${request.runId}`,
  });
  if (!entry || this.#replaying.has(entry.generationId)) return;
  this.#replaying.add(entry.generationId);
  ```
  SQL 里 `oldest` 没有任何 `claimed_by/claimed_at`，只是普通 SELECT。
- 后果（推断，但机制已证实）：重复模型调用和重复提交；`recordAttempt` 可能被并发加两次；一个补做成功后删掉行，另一个随后写 `capture_queued`，出现“决策记录说已排队、队列里却没有”；记忆 id 是 `memory:<generation>:<ordinal>`（`:596`），若两次模型输出顺序不同，可能写出不同 id 的重复记忆。
- 证据还体现在测试里：`test/integration/production-memory-capture.test.ts:2865` 专门验证“同轮重试结束前队列行已经可见”，这正是另一轮可以捡走它的窗口。
- 建议：给 backlog 加 claim/lease（`claimed_by`、`claimed_at`、过期时间），用 `UPDATE ... RETURNING` 原子领取；同轮重试中的 generation 也要从补做候选中排除；补并发测试。

### 中：补做重建的提示词不是原轮提示词的复刻
- 文件:行：`apps/agent-service/src/production-memory-capture.ts:846`、`946-956`、`977-986`、`1022-1029`；`apps/agent-service/src/production-run-composition.ts:230-245`、`505`。
- 问题：同轮重试复用同一个 `plan`，提示词字节和遮盖标签确实不变；但补做会重新 `#plan`，`existing` 来自“当前” `listActive`，子分类/人物来自当前 book，`relevantMemoryIds` 来自内存 Map `recalled`（超过 200 条会被逐出，进程重启后为空）。因此同一条原消息的补做提示词可能和原轮不同。代码只在 `:596` 用 generation+ordinal 生成记忆 id，并不按内容生成；输出顺序不同就会得到不同 id。
- 建议：若要求补做语义稳定，至少把原轮相关记忆 id 或提示词关键输入持久化到 backlog/决策记录；或者明确接受“当前状态重建”，并在 ADR 里把记忆 id 幂等性的前提写清（同一候选序号且同一输出顺序）。

### 中低：同轮第二次失败后，队列里的 `last_error_code` 仍是第一次的错误
- 文件:行：`apps/agent-service/src/production-memory-capture.ts:805-813`、`825-828`。
- 问题：第一次失败 `enqueue` 写入 `lastErrorCode: firstCode`；同轮重试再失败时只写 `capture_queued` 决策记录，没有更新 backlog 行的 `last_error_code/updated_at`。ADR 说队列存“最近一次错误码”，实际不是。
- 证据：
  ```ts
  await backlog.enqueue({ ..., lastErrorCode: firstCode, ... });
  ...
  } catch (second) {
    const secondCode = captureErrorCode(second);
    await this.#recordFailure(plan, "capture_queued", secondCode, "turn:2");
    throw second;
  }
  ```
- 建议：第二次失败时同步更新队列的错误码/时间；`recordAttempt` 只在补做路径更新。

### 中低：决策记录 id 的键不含错误码，重复写入被静默吞掉
- 文件:行：`apps/agent-service/src/production-memory-capture.ts:694-695`、`890`；`packages/persistence-sqlite/src/sqlite-decision-ledger-operations.ts:98-106`。
- 问题：id 只由 `generationId:outcome:attempt` 决定。同一 generation、同一 outcome、同一 attempt 再次发生（例如进程重启后重跑同一轮，或同一轮被不同路径再处理）但错误码不同时，第二次 `append` 因 `ON CONFLICT (id) DO NOTHING` 被静默丢弃，不是“每次失败一条记录”。
- 建议：键里加入错误码，或先读再决定是否允许复用；若有意去重，应在文档和测试里明确“同一 attempt 只保留第一次错误”。

### 低：回收站里的对话会留下永久队列行
- 文件:行：`packages/persistence-sqlite/src/sqlite-memory-capture-backlog-operations.ts:100-104`；`test/integration/production-memory-capture.test.ts` 的回收站用例。
- 问题：`oldest` 只选 `threads.status='open' AND archived_at IS NULL`，但回收站（trashed）的队列行既不会被补做，也不会被删除，只有对话永久删除时才级联消失。长期会产生只含 id 的残留行。
- 建议：对话进入回收站/归档时删除或标记过期队列行；至少加清理任务并在文档写明保留策略。

### 低：周报网页对新分组的评价标签仍是通用文案
- 文件:行：`apps/control-center/src/components/weekly-report.tsx:424-431`；`packages/calibration/src/index.ts:79`；`apps/control-center/src/i18n/resources/en.ts:1360`。
- 问题：`memory_capture_failed` 不在 `MAIN_GROUPS` 里，网页用 `${main ? group.group : "other"}_${rating}`，于是显示 `other_useful/other_missed` 的通用文案，而不是校准包里的“没漏掉什么/漏了该记的”。新分组能显示，但文案和 ADR 的说法不完全一致。
- 建议：给 `weekly.rate` 增加 `memory_capture_failed_*` 键，或让网页按 `ratingLabel` 取文案。

## 作者说法与代码不一致的地方
- “捕获调用传 `retryToolCall:false`”：代码是 `retryToolCall: backlog === undefined`（`production-memory-capture.ts:800`）。生产里 `backlog` 总是注入，所以实际为 false；但这不是无条件 false。
- “backlog 存最近一次错误码”：同轮第二次失败不更新，见上。
- “记忆 id 幂等”：只有同一 generation、同一候选序号才幂等；候选顺序变化会产生不同 id（`:596`）。
- “补做重建提示词”：原轮的消息和“它之前的 50 条”是按 id 重建的，但记忆/子分类/人物/相关记忆是当前状态，不是原轮快照。
- “每日评价、周报校准、网页标签、三语文案同步”：每日评价和校准分组能接受新值；周报网页新分组使用通用评价标签，见上。

## 侧重检查
- 错误路径：检查了首次失败入队、同轮第二次失败、不可重试错误、补做第 1/2/3 次失败、`ADMISSION_UNAVAILABLE/MODEL_UNAVAILABLE` 不计次数、暂停跳过、对话回收站/永久删除、`#plan` 返回空时的删行。发现提交阶段失败未覆盖。
- 不合规范/不可信输入：`captureErrorCode` 只接受 `[A-Z][A-Z0-9_]{0,127}`（`production-memory-capture.ts:684-692`）；backlog 校验 generation/sourceRun 长度、错误码正则、ISO 时间、thread 归属（`sqlite-memory-capture-backlog-operations.ts:56-68`）；数据库有长度、STRICT、CHECK、UNIQUE、级联外键。基本可接受。
- 安全/隐私：backlog 只存 id、错误码、时间，不存提示词/原文；错误码正则避免把任意错误文本写进决策记录。未发现把敏感原文写进新表。
- 资源耗尽：补做最多 3 次、每轮最多一条；但回收站队列行会长期累积，且没有清理策略。
- 不可撤销操作：重复补做可能在并发下重复写记忆；提交失败时的“先删队列”窗口会直接丢记忆。
- 规则/文档/代码一致性：ADR 0222 的“先入队防丢”“写冲突重试”“最近错误码”“记忆 id 幂等”与代码有上述出入；迁移 0088 与 0087 的表结构逐段对比一致，未发现少建六张子表、索引或触发器。

## 必答问题

1. **会不会改变模型已经见过的请求开头？**
   - 对主对话：不会。改动只在记忆捕获这个辅助调用和持久化路径，没有改系统提示、工具定义、对话历史或出口遮盖。
   - 对捕获辅助调用：`memoryCapturePrompt` 仍是固定指令在前、JSON 数据在后（`production-memory-capture.ts:185-201`）；同轮重试复用同一个 `plan`，提示词字节和遮盖标签不变。补做会重建数据段，可能和原轮不同，但变化的仍只是固定指令之后的数据，不是会话请求开头。
   - 消息范围从 `thread.messageWatermark - 50` 改为 `owner.sequence - 51`（`production-memory-capture.ts:924-930`），只影响捕获辅助调用取哪 50 条上下文，不影响主对话历史。
   - 结论：主对话仍然只在末尾追加；每轮会变的值仍在最后的数据区。补做不是原轮提示词的逐字节复刻，见第 3 条问题。

2. **同一段文字会不会在不同请求里变成不同的字节？**
   - 决策记录 id 是确定性的 `sha256(generation:outcome:attempt)`，不带时间；`captureErrorCode` 也做了固定格式收敛。
   - 遮盖标签 `externalTag` 在密钥不变时对同一内容确定；同轮重试复用 `plan.tag`，这一路不会变。
   - 但补做会用当前记忆状态、当前子分类/人物，以及可能已被逐出或重启后为空的 `recalled` Map 重建提示词，所以同一条主人消息在“原轮”和“补做”两个请求里的数据段字节可能不同。这不是遮盖不确定，而是补做输入状态不同。
   - 另外 `recent` 的排序只按 tentative 和 `updatedAt`，时间相同时没有 id 兜底（既有问题，未核实是否有稳定数据库顺序）。

3. **有没有自动检查，反向用例会不会真的失败？**
   - 有：`scripts/check-memory-capture-retry.mjs`，要求至少 14 条 `[P3-5]` 测试通过，已加入 `package.json` 的 `check:steps`。
   - 反向用例包括：未知 `capture_*` 结果被数据库拒绝；不可重试错误只调用一次；回收站对话不补做；`kept/discarded/pending_approval` 不被新分组误收。
   - 但缺少：提交阶段失败后是否重新入队、两个运行并发补做同一条、真实出口层 `retryToolCall:false` 是否阻止第二次出口重试。新增的 daily-review/calibration 单测也不在 `check:memory-capture-retry` 的 `FILES` 里，是否被其他检查覆盖未核实。
   - 本次没有运行测试，只做了代码核对；“反向用例在旧代码上会失败”这一点未实际验证。

4. **每个新值的使用方都能接受吗？**
   - `capture_retrying/capture_queued/capture_gave_up`：迁移 0088 的 CHECK、`validateLedgerWrite`、`DECISION_OUTCOMES`、每日评价、校准分组、决策链（outcome 为普通字符串）、数据导出（outcome 为普通字符串）、三语网页标签都已覆盖。
   - `memory_capture_failed`：`CALIBRATION_GROUPS`、`APPLICABLE`、`GROUP_LABELS`、`RATING_LABELS`、`calibrationGroup`、gateway contracts、三语 `weekly.group/groupInfo` 都能接受；但周报网页的评价标签走通用 `other_*`，见上。
   - `memory_capture_backlog`：入参长度、错误码、时间、thread 归属校验和表结构一致；`generation_id/source_run_id/last_error_code` 的上限与迁移一致。
   - 发现的“两端不一致”：并发下决策记录可能写 `capture_queued` 但队列行已被别的补做删掉；同轮第二次失败时队列里的错误码不是最新；决策 id 键不含错误码，重复失败会被 `DO NOTHING` 吞掉。

## 推测/未核实
- 生产当前是否真的有多轮并发或单进程：代码已具备竞态窗口；实际并发配置（I-60 提到 `totalRuns` 曾为 1）未核实。
- 并发补做是否一定造成重复记忆取决于模型是否返回相同候选顺序；机制上可能，未实际复现。
- 迁移 0088 在真实生产库上的执行结果未验证；只核对了 0087 与 0088 的 SQL 以及该 PR 的契约测试。
- 新增的 daily-review/calibration 单测是否被更宽的 CI 覆盖未核实。
