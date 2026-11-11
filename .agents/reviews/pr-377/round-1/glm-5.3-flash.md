# 复核报告：PR 377 记忆捕获失败重试补做（d6691be 对比 cb9c281）

## 发现的问题（按严重度从高到低）

### 1.【中】补做成功后“先删队列行、后提交”留下静默丢记忆的窗口
- 文件：`apps/agent-service/src/production-memory-capture.ts:830-832`、`:872-874`（读代码证实）
- 问题：同轮重试成功和补做成功两条路径都是 `await backlog.remove(...)` 之后才 `await this.#commit(plan, parsed)`。如果进程在 remove 与 commit 之间重启，或 `#commit` 抛错（`assertActive`、`generations.request`、`processCommittedRun` 任一步失败），队列行已经没了，这一轮抽取成功的候选永远不会落库，也不会再有补做，且没有任何决策记录（不同于 `capture_gave_up`，那是有记录的放弃）。
- 证据：`#captureTurn` 成功分支 `await backlog.remove(plan.generationId);` 紧接 `await this.#commit(plan, parsed);`；`#replayOne` 同样 `remove` 在 `#commit` 之前。ADR 0222 第 3 条只写了“先写后试，是为了进程在重试途中重启时这一轮不丢”，没有承认成功路径上反方向的丢失窗口。
- 建议：把顺序换成先 `#commit` 再 `remove`（记忆 id 和决策记录 id 都是确定性的，理论上可幂等重放），或在 commit 失败时把行留在队列里并补一条 `capture_queued` 记录。

### 2.【中】周报评分按钮文案与 ADR/校准包不一致，回落到通用文案
- 文件：`apps/control-center/src/components/weekly-report.tsx:45-51`、`:431`；`apps/control-center/src/i18n/resources/zh-CN.ts` weekly.rate（读代码证实）
- 问题：ADR 0222 决定 6 和校准包都声称新分组的评分选项是“没漏掉什么”/“漏了该记的”（`packages/calibration/src/index.ts` 的 `ratingLabel` 确实如此，但只用于校准文本报告）。网页周报的评分标签走 `message("weekly.rate", { k: `${main ? group.group : "other"}_${rating}` })`，而 `memory_capture_failed` 不在 `MAIN_GROUPS` 里，`weekly.rate` 的 ICU select 里也没有 `memory_capture_failed_useful/missed` 键，于是回落到 `other` 分支，实际显示“做对了”/“该做没做”。作者说“三语文案同步”——分组标签同步了，评分文案没同步。
- 建议：在三种语言的 `weekly.rate` select 里补 `memory_capture_failed_useful`、`memory_capture_failed_missed` 键，或把该组加入 MAIN_GROUPS。

### 3.【低】队列行 `last_error_code` 停留在第一次错误，第二次失败不更新
- 文件：`apps/agent-service/src/production-memory-capture.ts:805-813`、`packages/persistence-sqlite/src/sqlite-memory-capture-backlog-operations.ts:69-84`（读代码证实）
- 问题：enqueue 在第一次失败后立即执行（upsert 只更新 `last_error_code`/`updated_at`，不更新 `attempts`）。第二次（重试）失败只写决策记录，队列行里留的还是第一个错误码。集成测试自己证实了这一点：第二轮失败是 `AI_GATEWAY_REQUEST_TIMEOUT`，行里却是 `AI_GATEWAY_PROVIDER_UNAVAILABLE`（`test/integration/production-memory-capture.test.ts` “queues a turn that fails twice” 用例）。只影响诊断准确性。
- 建议：重试失败写 `capture_queued turn:2` 时顺带更新队列行的 `last_error_code`。

### 4.【低】数据导出/导入不含 `memory_capture_backlog`
- 文件：`packages/persistence-sqlite/src/data-export/snapshot.ts`、`import.ts`（读代码证实：导出查询和导入表清单里都没有该表）
- 问题：导出再导入后，正在排队等待补做的轮次全部静默消失，这些记忆永远不会再补。另外导出格式里 decision_ledger 的 `outcome` 是自由文本（`schemas.ts:205` `nullable(text(1,64))`），新格式导出若导入到旧版本（schema 87，CHECK 只认三个旧值）会在 CHECK 处失败——前向兼容问题，推测旧版本导入本来就会被 schema 版本栅栏挡住，未核实。
- 建议：至少在 ADR/文档里写明导出不含待补队列；或把该表纳入导出。

### 5.【低】补做重建的提示词里“相关记忆”永远为空
- 文件：`apps/agent-service/src/production-memory-capture.ts:946-949`；`apps/agent-service/src/production-run-composition.ts:505`（读代码证实）
- 问题：`relevantMemoryIds` 在生产里是 `recalled.get(runId) ?? []`——按本轮运行 id 查召回表。补做时传的是 `sourceRunId`（旧轮），旧轮早已不在本轮的召回表里，所以补做提示词的 relevant 记忆恒为空，与原轮提示词必然不同（这本身是新请求，不违反规则，但 ADR 只说“用当前记忆状态重建提示词”，没提这一处保真度损失）。生成编号不变、`memoryIdFor` 是 `memory:${generation}:${ordinal}`（`:596`），记忆 id 幂等成立，不会重复写。
- 建议：可接受；如在意保真度可在补做时重算相关记忆。

### 6.【信息·推测】`#replaying` 去重只在单进程内有效
- 文件：`production-memory-capture.ts:721`、`:843-844`
- 事件循环内 check-then-add 之间无 await，同进程两个并发轮不会重复补做同一条（读代码证实）。若部署形态出现两个服务进程共享同一 SQLite 库（本项目目前按单写者设计，未核实是否可能），两个进程可能同时取到同一最旧条目并发提交。`recordAttempt` 用 `RETURNING attempts` 计数会各加一次。推测风险，取决于部署形态。

## 作者说法逐条核对结果

| 说法 | 结论 |
|---|---|
| #captureTurn 先 enqueue 再判错误码；重试集合/`capture_retrying`/`capture_queued`/调用编号 | 与代码一致（`:802-832`）。补充：重试失败的 `capture_queued turn:2` 记录后仍把错误抛给 onFailure（共两次 onFailure） |
| #replayOne 在本轮捕获准入后串行、排除本轮 generation、只取 open 未归档、暂停跳过、3 次放弃、两个错误码不计次数 | 一致（`:835-877`、`oldest()` 的 JOIN 过滤、`REPLAY_NOT_ATTEMPTED_ERRORS`） |
| 决策记录 id = sha256(gen:outcome:attempt) 前 40 位 | 一致（`captureLedgerId`，`ledger:`+40hex，长 47 ≤ 128）；key 含 outcome+attempt，同 gen 各路径不会撞；即便撞，`INSERT ... ON CONFLICT (id) DO NOTHING`（`sqlite-decision-ledger-operations.ts:101-106`）静默去重不报错 |
| 捕获传 `retryToolCall:false`，出口层不再重复重试，其他辅助调用不变 | 一致（`production-model-composition.ts:634-644`、`service-main.ts:1981-1985`） |
| 迁移 0088 完整复制 0087 重建（六张子表、触发器、索引、数据），STRICT/CHECK 一致 | 一致。逐段对比两文件：0088 即 0087 的重建段逐字复制，仅 outcome CHECK 增加三个值；全部索引和 `decision_signals_no_delete/no_update` 触发器齐全，七张 `_keep` 表数据回填，STRICT 相同。0087 建的 `memory_rule_needs_review*` 触发器挂在 memory_records 上，0088 不动它们，无丢失。契约测试比对重建前后七表行+索引+触发器完全一致，并有“未知 outcome 被拒”的反向用例 |
| 重试用同一 plan、提示词字节和遮盖标签不变 | 一致。`plan.prompt` 构建一次复用，`plan.tag ??=` 缓存；集成测试断言 `prompts[1] === prompts[0]` |
| 生成编号不变、记忆 id 幂等 | 一致（`generationId = memory-capture:${sourceRunId}`，`memoryIdFor = memory:${generation}:${ordinal}`） |
| 每日评价/周报分组/网页标签/三语文案同步 | 大体一致；例外见问题 2（周报评分按钮文案） |
| 已知取舍：运行结束后重试拿不到准入按排队处理 | 一致。`MEMORY_CAPTURE_ADMISSION_UNAVAILABLE` 不在 `SAME_TURN_RETRYABLE_CAPTURE_ERRORS` 里，首次即排队；重试阶段拿到准入失败也走 `capture_queued turn:2` |

## 必答问题

**1. 会不会改变模型已经见过的请求开头？** 不会（读代码证实）。主对话请求的组装（系统提示、工具、历史）完全没动；diff 只在辅助调用链上传 `call` 参数和注入 `backlog`。捕获是独立的后台一次性调用，不构成“已发内容的开头”；其提示词是固定指令（提示词目录 `MEMORY_CAPTURE.text`，本次未改）+ 末尾 JSON 数据，重试复用同一字符串和同一遮盖标签，逐字节相同。会变的值都在这一次调用的 JSON 尾部。

**2. 同一段文字会不会在不同请求里变成不同字节？** 不会（读代码证实）。重试逐字节相同（测试断言）。捕获提示词的输入排序全部确定：`existing` 经 `confirmedFirstByRecency` 排序，`subCategories` 来自 `ORDER BY category, count DESC, sub_category` 的查询，`people` 再按 `updatedAt` 排序，无当前时间字段进提示词（只有固定的 `owner.committedAt`）。补做重建的提示词与原轮不同（当前记忆状态+相关记忆为空），但那是新的逻辑请求，不属于“同一段文字变字节”。

**3. 有没有自动检查、反向用例会不会真失败？** 有（读代码证实）。`scripts/check-memory-capture-retry.mjs` 已加入 `check:steps`，要求 ≥14 条 `[P3-5]` 通过（集成 8 条+迁移契约 6 条，数目对得上）。反向用例真实：未知 outcome `capture_lost` 被数据库 CHECK 拒（契约测试断言抛错）；`AI_GATEWAY_OUTPUT_TRUNCATED` 不重试直接排队；3 次补做失败后删行记 `capture_gave_up`；daily-review 若把失败当“已执行”或当有记忆可读，测试断言 `acted:false`、`reads===0` 会失败。

**4. 每个新值的所有使用者都能接受吗？** 逐个核对：三个 outcome 值——写端 `#recordFailure`、0088 CHECK、`daily-review`（`isMemoryCaptureFailure` 三处）、`calibration`（新分组）、`contracts-v2`（`calibrationGroupSchema`）、网页每日评价标签，全部接受；没有发现把未知 outcome 当“待批准”的地方（网页 `reviewTag` 的 fallback 是 `pendingMemory`，但三个新值已显式拦截，不会落到 fallback）。`memory_capture_backlog` 表——schema-catalog、迁移引擎、`workspace-lifecycle-audit` 的 `SUPPORTED_SCHEMA_MAX=88` 均已同步；导出不含（问题 4）。`ledger:`+40hex 的 id 与 `automatic-memory-service.ts:527` 的既有 id 同构、键形状不同不会撞，长度合规。唯一遗留是周报评分文案（问题 2）。

## 侧重检查

走的流程：主人发消息 → 运行结束 → `ProductionMemoryCapture.start()`（`#pending`/`#captured` 按 runId 去重）→ `#captureTurn` → `#plan`（读 run source、解密原文、按 id 读回 owner 消息并校验 role/contentRef、取其前 50 条、拉相关+最近记忆、子分类、people）→ `#extract`（assertActive → externalTag → 准入 → generateText → placeholderTable → parseMemoryCandidates）→ 失败路径 enqueue/记录/重试 → `#commit`（审计 → checkpoint job → `AutomaticMemoryService.processCommittedRun` → 确定性记忆 id 落库）→ 下一轮 `#replayOne` 补做 → 每日评价/周报/网页展示。竞态检查：同轮重试与补做串行（`captureAdmitted` 之后再跑 replay）、同进程并发轮靠 `#replaying` 去重、进程重启靠“先入队后重试”兜底——均读代码证实。

**没有测试覆盖的路径**：① 组装层接线——`production-run-composition.ts:517` 的 `backlog: repository.memoryCaptureBacklog()` 和 `service-main.ts:1981-1985` 的 `call` 透传没有专门测试（所有 `[P3-5]` 集成测试都是 `new ProductionMemoryCapture(optionsOf(context))` 直接构造，绕过了 composition；未核实其他既有集成测试是否碰巧覆盖）。② 出口层 `retryToolCall === false` 分支只有默认正向重试的旧测试（`production-model-composition.unit.test.ts:1336`），没有“传 false 时不重试”的反向用例——集成测试只断言了参数值，没在真实出口层执行该分支。③ `#commit` 中途失败（checkpoint 已请求、processCommittedRun 失败）无测试，与问题 1 相关。④ 数据导出/导入与 backlog 表的交互无测试（问题 4）。
