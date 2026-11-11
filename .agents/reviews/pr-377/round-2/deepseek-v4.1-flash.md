# 侧重检查

- **错误路径**：看过第一次失败、同轮重试、补做、非重试错误、准入暂不可用、`#plan` 失效、入队失败这些路径。`#busy` 在 `#captureTurn` 的失败分支和 `#replayOne` 的 `try/finally` 中成对增删（`production-memory-capture.ts:804-809、864-896`）。但 `#replayOne` 在 `#plan` 失效时会直接删队列行（`:866-870`），不是“只有 `#attempt` 成功才删”，与作者说法不符。
- **不可信/不合规范输入**：错误码经 `captureErrorCode` 限制为 `^[A-Z][A-Z0-9_]{0,127}$`（`:684-692`），队列写入端再校验正则、时间、线程归属（`sqlite-memory-capture-backlog-operations.ts:56-88`），决策记录原因码截到 64 字符（`production-memory-capture.ts:914`），两端能对上。源轮、线程、主人/Agent 在补做时由 `#plan` 重新核对（`:924-941`）。
- **安全/隐私**：队列只存编号、错误码、时间，不存提示词和正文；数据导出未引用该表，符合 ADR。新决策结果值走数据库 CHECK、端口白名单、周报分组和网页文案，均已放行。
- **资源耗尽**：每行最多 3 次补做即删除，每轮最多补做一条；但同轮“存记忆失败”会多花一次模型调用。若大量轮次失败快于每轮一条的补做速度，队列仍可能堆积（这是上一轮的设计，不是本轮新增）。
- **不可撤销操作**：本轮把 `#commit` 纳入重试后，部分提交后的再提交可能重复 `update`/`unchanged` 的历史与 revision，并重新 `schedule` 提醒；提醒写入在冲突时会把 `status` 改回 `scheduled`、清空 `dismissed_at`（`sqlite-memory-reminder-operations.ts:98-100`），可能把主人已忽略的提醒复活。
- **规则/文档/代码一致**：ADR 第 4 条、casebook、周报和每日评价文案与代码有偏差，见下面第 2、3 条。

# 发现（按严重度）

## 1. 高（机制已证实；触发场景为推断）— 部分提交后重跑 `#attempt` 会重新抽取并重跑整个 `#commit`，写入不幂等

`apps/agent-service/src/production-memory-capture.ts:851-853`

```ts
async #attempt(plan, onAdmitted, call) {
  await this.#commit(plan, await this.#extract(plan, onAdmitted, call));
}
```

同轮重试和补做都调用它（`:837-841、871-875`）。第一次 `#commit` 若在 `generations.request` 成功后、`processCommittedRun` 中途失败，重试会重新调用模型，再用新输出重跑 `#commit`（`:1092-1140`）。我核对了写入端：

- checkpoint 请求本身按身份幂等：相同 `threadId/sourceWatermark/policyVersion` 且 `jobId/generationId/owner/agent/model/sources` 一致时直接返回已有记录（`sqlite-checkpoint-operations.ts:281-299`）。这一条作者说法成立。
- 但 `processCommittedRun` 不是幂等的。`create` 遇到同 id 时只有在 `contentRef/classification/policyVersion/confidence/sourceRefs` 全相同才返回已有记录，否则抛 `PORT_CONFLICT`（`durable-memory-service.ts:121-144`）；`update`/`merge`/`unchanged` 会再次执行并 `revision + 1`、追加历史（`:61-75、105-118、176-203`）。
- 每个候选成功写入后还会调用 `onCommitted`（`automatic-memory-service.ts:501-510`），它会重新 `reminders.schedule`（`production-memory-capture.ts:600-613`），而提醒 upsert 会撤销忽略状态（`sqlite-memory-reminder-operations.ts:98-100`）。
- 更严重的是重新抽取可能返回空或更少的候选；`#commit` 在无候选时直接返回（`:1098`），随后 `#retryTurn` 删除队列行（`:848`），于是第一次已部分写入、剩余候选被静默丢掉。

作者/ADR 只承认“存成功、删队列行之前进程恰好重启”这一窄窗口（ADR:56），但本轮新增的“保存失败后同轮重试”本身就会重跑整个提交，窗口远大于一次数据库写入。当前测试只把 `generations.request` 改成抛错（`test/integration/production-memory-capture.test.ts:2896-2924`），即 checkpoint 请求阶段失败，根本没有覆盖 `processCommittedRun` 部分成功的情况。

建议：同轮重试应保留第一次已解析出的 `parsed`，解析失败才重抽，保存失败只重试 `#commit`；并让提交按候选幂等（例如用已经确定的决策记录 id 判断该候选是否已提交，或把整个 `processCommittedRun` 放进一个事务），而不是依赖模型重新输出后再次 `applyProposal`。同时补一条“已提交候选后中途失败”的测试。

## 2. 中 — ADR/说明文档与代码不一致

- `docs/adr/0222-retry-and-queue-failed-memory-capture.md:56` 说“原轮从来没存成，所以补做不会和原轮重复。只有在‘存成功、删队列行之前’进程恰好重启时……可能多出一条近似的记忆”。如上条所述，同轮重试和补做在部分提交后都会重跑提交，重复更新/历史/提醒以及 `PORT_CONFLICT` 不只发生在那个窄窗口；“原轮从来没存成”也不成立。
- `docs/engineering-casebook.md:275` 说“补做沿用原来的生成编号，所以记忆 id 不变、不会重复写”，同样过于绝对。
- `packages/persistence-sqlite/src/schema-catalog.ts:667-671` 描述该表是“failed twice”才入队，但代码在第一次失败就 `enqueue`（`production-memory-capture.ts:830`）。

建议：要么把提交做成幂等后保留这些表述，要么把 ADR/casebook/schema-catalog 改成“部分提交后重试可能重复更新、追加历史或复活提醒，接受/不接受要写明”。

## 3. 中 — 网页文案把“存记忆失败”说成“模型调用/抽取失败”

本轮让 `PORT_CONFLICT` 等保存失败也产生 `capture_retrying/capture_queued/capture_gave_up`（`production-memory-capture.ts:837-846、876-891`），但三种语言的说明仍写“模型调用失败/抽取失败”：

- `apps/control-center/src/i18n/resources/zh-CN.ts:1255`：“这一行是抽取的模型调用失败的那几次”。
- `apps/control-center/src/i18n/resources/zh-CN.ts:962-964`：“这轮对话后抽取记忆的模型调用失败了一次……”“……仍没抽取成功”。

主人看到 `PORT_CONFLICT` 这类保存失败时，会得到错误归因。建议把文案改成“记忆捕获/保存失败”这类不限定归因的说法，或按错误码区分“模型调用失败”和“保存失败”。

## 4. 低（结构已证实，后果为推测）— `#replayOne` 的“读取最旧行 → 检查 `#busy`”不是原子领取

`apps/agent-service/src/production-memory-capture.ts:858-864`

```ts
const entry = await backlog.oldest({...});
if (!entry || this.#busy.has(entry.generationId)) return;
this.#busy.add(entry.generationId);
```

`oldest` 返回后到检查 `#busy` 之间，另一个已完成补做的运行可能删除了该行并清掉 `#busy`；本次仍会用旧 `entry` 继续补做。服务按单进程运行时，实际能否触发取决于两个异步操作的先后；我未复现。若部署期间出现两个服务进程，则完全没有跨进程领取锁，重复补做更可能发生。建议在数据库层做原子领取（例如 `UPDATE ... SET claimed_by = ... RETURNING`）或删行时使用 CAS，而不是只靠进程内集合。

## 5. 低 — 测试门禁有缺口

`scripts/check-memory-capture-retry.mjs:9-13` 的 `REQUIRED = 17` 与实际的 11 条 integration + 6 条 migration 契约测试一致；新增的三条集成测试确实是有效的反向用例（旧代码会在调用次数/队列行/补做调用上失败）。但：

- 没有覆盖第 1 条所说的 `processCommittedRun` 部分提交后重试。
- 本轮新增的周报、关联页面、calibration、daily-review 测试不在 `check:memory-capture-retry` 的文件清单里；它们是否被其他 `npm run check` 步骤执行，取决于完整测试作业，本次未运行验证。
- `#busy` 的用例依赖 50ms 等待（`test/integration/production-memory-capture.test.ts:2958-2984`），时序上偏脆弱。

我受工具限制没有运行测试，以上按测试代码和脚本静态核对。

# 作者说法核对

- “第一次尝试、同轮重试、补做都调用 `#attempt`” —— 成立（`:796-800、837-841、871-875`）。
- “存记忆失败也进入同一套重试和计次逻辑” —— 部分成立：同轮重试失败不会增加队列行的 `attempts`（只有 `#replayOne` 的 `recordAttempt` 会加），只是更新最近错误码并写 `turn:2` 决策记录；说法容易让人理解为 `attempts` 也加一。
- “`#busy` 取代 `#replaying`，补做时跳过集合里的编号” —— 成立，但不是原子领取（第 4 条）。
- “同轮第二次失败时再调一次 enqueue” —— 成立（`:843-845`，`ON CONFLICT` 只更新错误码和 `updated_at`）。
- “队列行只在 `#attempt` 成功后删除” —— 不成立：`#replayOne` 在 `#plan` 失效时也会删行（`:866-870`）。
- “周报三种语言新增评价文案” —— 成立（en/ja/zh-CN 的 `weekly.rate` 都有 `memory_capture_failed_useful/missed`）。
- “check 脚本 14 改 17” —— 成立，且与 ADR 的“11+6”一致。

# 必答问题

1. **不会改变模型已经见过的请求开头。** 本改动只动记忆捕获这一路后台调用、周报文案、文档和测试，没有改系统提示、工具定义、历史消息或会话请求的遮盖；对同一轮的重试复用同一个 `plan`（同一 `prompt`、同一 `tag`），所以发给模型的辅助请求字节不变。补做会按当前记忆状态重建提示词（对话内容布局仍是“固定指令 + 本次数据”），ADR 已明确它不是原轮的逐字复刻；但这不是会话请求的开头，也没有把每轮变化的值挪进系统提示或历史。依据的“只在末尾追加、变化值放最后一条消息”没有被本改动破坏（`.claude/rules/prompt-prefix.md` 第 4、10、15 条）。

2. **本轮新增路径没有引入“同一段文字在不同请求里字节不同”的新来源。** 同轮重试使用同一个 `plan`，遮盖标签也复用 `plan.tag ??=`（`:1064`），所以两次请求的提示词和遮盖结果相同；变化只有调用编号。补做会因“已有记忆是当前的、本轮相关记忆为空”而产生不同提示词，这是 ADR 有意接受的行为，不是本轮新增的遮盖/时间/无序集合问题。队列行和决策记录的值不进入模型提示。

3. **有自动检查，但覆盖不完整。** `check:memory-capture-retry` 固定 17 条 `[P3-5]`（11 条集成 + 6 条迁移契约），新增的“保存失败同轮重试”“补做保存失败计次并保留队列”“另一轮重试中不补做”在旧代码上分别会在调用次数、`attempts`、`backlog` 调用上失败，属于有效反向用例。缺口是：没有覆盖“部分提交后重试”这一作者特别点名的场景；本轮新增的界面/校准/每日评价测试不在这个检查脚本内。我未运行测试，以上为静态判断。

4. **逐项核对结果：**
   - `capture_retrying/capture_queued/capture_gave_up`：产生于 `#recordFailure`；端口白名单（`decision-ledger.ts:41-52`）、迁移 0088 的 CHECK、`calibrationGroup`、每日评价、关联页面标签、状态定义、gateway 的 calibration group 枚举都接受这三个值。
   - `memory_capture_failed` 组及其 `weekly.rate` 键：校准分组、gateway contract、网页 `OWN_RATE_LABELS` 与三种语言资源一致；语义说明有偏差（第 3 条）。
   - `memory_capture_backlog` 的 `generationId/sourceRunId/errorCode/createdAt/updatedAt/attempts`：写入端校验正则、ISO 时间、线程存在与 FK；读取端 `oldest` 按 `created_at, generation_id` 稳定排序，`recordAttempt` 返回次数，队列行在 3 次后删除；`generationId` 由 `sourceRunId` 派生，所以 `ON CONFLICT (generation_id)` 与唯一键 `(owner_id, agent_id, source_run_id)` 不冲突。
   - `reason_code` 截到 64、`ledger.id` 为 `ledger:` + 40 位哈希，均满足数据库长度约束；数据导出没有这张表。
   - 未核实项：部署是否严格保证只有一个服务进程（第 4 条的风险前提），以及完整 `npm run check` 是否执行了新增的界面测试。
