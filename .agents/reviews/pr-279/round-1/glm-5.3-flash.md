现在我来读取被修改的 mail-check service，以验证 `asOf` 的处理、prompt 结构以及隔离存储 (isolated store) 的覆盖率。
Diff 已经完全读到了。现在我来抽查一些交叉引用：`durable-operations` 前缀顺序、常量、`deleteRun` 调用方以及规则文件。
现在我来检查 `onMasked`是如何关联的——回放过程是否会通过遮盖机制影响全局状态（Q2风险）：
复核完成。以下按严重度从高到低列出发现。

## 发现（严重度降序）

**1.（中）回放期间的遮盖事件会写入生产的 sensitive_interceptions 表，与「结果只写独立回放表」的约束不符**
- 文件：apps/agent-service/src/service-main.ts:1548-1559（`onMasked` 把 sightings 交给 `mailEgress.reportMasked`，source "mail"、purpose "mail-judgment"）
- 证据：proactive-replay-service.ts:281（`...(options.onMasked ? { onMasked: options.onMasked } : {})`）把同一个 onMasked 传进每封回放邮件的判断服务；proactive-mail-check-service.ts:542 调 `#reportMasked`；apps/agent-service/src/production-model-egress.ts:24-26 用真实 `repository.sensitiveInterceptions()` 记录。读代码证实。
- 说明：回放的模型调用是真实出口，把「这次脱口而出了被遮盖的敏感值」记进拦截台账并非不合理；但作者自述「结果只能写进独立的回放表，不能影响真实的…」，且一次性回放几千封会批量产生拦截记录（未核实拦截展示页会不会把这些当成主人的真实事件）。推测拦截页可能受影响，需产品确认。
- 建议：要么有意保留并另记 purpose 区分回放，要么回放时不传 onMasked。

**2.（中低）`deleteRun` 在生产无任何入口，「删回放释放封存文字」目前一条用户路径都没有**
- 文件：packages/application/src/ports/proactive-replays.ts:96（端口有 `deleteRun`）；grep 全仓库，`deleteRun` 只有端口声明、SQLite 适配、集成测试调用（test/integration/proactive-replay.test.ts:354）；production-proactive.ts 只有 `"proactive.replay.start"` 一个命令。
- 证据：schema-catalog.ts 的 catalog 条目写着 "removed when the owner deletes the run"，但当前用户做不到；gateway-contracts/src/contracts-v2.ts:44 只加了 start。读代码证实。
- 影响：interrupted/failed/finished 回放的 insight contentRef（0079 SQL 中 `REFERENCES payloads(ref) ON DELETE RESTRICT`）会一直占用 payloads，只能靠 clearRecords/removeSource 释放。作者已声明标注界面另开 PR，此为已知缺口，但要防止以为现在就能删。
- 建议：接删除命令或至少给运维清理路径；标注 PR 记得接 `deleteRun` 释放 refs。

**3.（低）skipped 记录的 reasonCode 与 store 校验存在脆弱耦合：skipReason 为 null 会让整次回放以 REPLAY_ERROR 失败**
- 文件：proactive-replay-service.ts:330（`reasonCode: processed.outcome === "skipped" ? (processed.skipReason ?? null) : null`）vs sqlite-proactive-replay-operations.ts:52-67（`failedOrSkipped === (result.reasonCode !== null)`，不满足则 `invalid(...)` 直接失败）。
- 证据：当前唯一的 skip 构造点是 proactive-mail-check-service.ts:507（`#skip(item, "category")`），所以现在不会触发；但假如将来加 skipReason 为空的跳过路径，recordResult 会抛错、经 start() 的 catch 整个 run 记 REPLAY_ERROR，之前已写入的结果作废。读代码证实现有安全、推测未来风险。没有任何测试钉住这个耦合。
- 建议：回放端把 null skipReason 映射成某个固定编码，或补一条「skipReason null」的反向断言。

**4.（低）history read 里 404 的消息被静默丢弃，既不记行也不记失败**
- 文件：packages/platform-node/src/gmail-source.ts:294-297（`gmailGetter` 404 返回 undefined；`if (item) items.push(item)`）。
- 证据：读代码证实。效果是 list 到、但 read 时被删/被拒的邮件从样本里无声消失，run 照常 COMPLETED。新增的 2 个 gmail 单测没有覆盖 404 的用例。
- 建议：把 404 映射为一条 `skipped`/`failed` 结果，或至少在 run 指标里加上差值（listed − judged）可见。

**5.（低）两套停止规则并存，与作者描述的粒度不完全一致**
- 文件：proactive-replay-service.ts:196-197、211-212（list/read 一次失败即整 run `finish("failed", READ_…)`）；:242-244（只有模型级失败才按连续 3 次停）。
- 证据：读代码证实。行为本身合理（源不可用≠模型失败），但「连续失败就停」的描述没写第一条，回放中途一次网络抖动就会丢掉剩余全部邮件；也没有把「失败发生在第 1800 封」这类极端情况纳入测试。建议确认是否要重试一次再停。

**6.（低，未核实）作者声称 `npm run check` 里 check:security-review 与 check:delivery-packet 在 main 上同样失败，本复核无法验证**
- 只允许读文件与有限 git 命令，不能运行 npm。测试是否真的 643 例通过同样未实跑验证；静态核对与代码一致：集成测试恰好 7 个 `it`（test/integration/proactive-replay.test.ts），gmail 单测恰好 2 个 `it`（gmail-source.unit.test.ts:209-276），迁移期望值更新见 packages/persistence-sqlite/test/migration-engine.contract.test.ts、model-budget-migration.contract.test.ts、run-checkpoint-migration.contract.test.ts 与 scripts/operations/workspace-lifecycle-audit.mjs:5。

其余核对过但无问题的点（读代码证实）：迁移 0079 的 CHECK/唯一部分索引（`one_running`）与服务层常量一致（PROACTIVE_REPLAY_MAIL_LIMIT 2000、BUDGET_LIMIT 5,000,000，0079 SQL 同值）；`proactiveReplay.` 路由在 `proactive.` 之后无前缀冲突（sqlite-durable-operations.ts:569,585-586）；`deleteProactiveReplays` 在同一事务里先收集 refs 再删 runs（级联），先于 payload 释放调用（sqlite-proactive-operations.ts:419-431,457-461），RESTRICT 顺序正确；resultRef `proactive-replay:<id>` 字符在 machineString 允许的 `._:-` 集合内（I-73 教训应用到位）；预算每封从 `spent()` 累计、封禁在判断前评估（proactive-mail-check-service.ts:533-535），无法用「单封失败不计花费」绕过。

## 侧重检查（流程 + 结论）

走的最普通流程：主人（有 proactiveControl 权限）发网关命令 `proactive.replay.start` → contracts-v2 schema 校验（2000/5,000,000 上限）→ 生产白名单与 `ProductionProactive` case（production-proactive.ts:546-557）→ `ProactiveReplayService.start` 服务层二次校验 + `startRun`（部分唯一索引实现「同一时间只允许一个回放」）→ `#execute`：解密 token → `history.list`（gmail 列表，2 段内分页去重截断）→ `markListed` → 每块 10 封 `history.read` → 每封独立 `ProactiveMailCheckService`（asOf=收到时间、隔离 store）→ 真实模型调用 + 遮盖 → 捕获 record → 释放模型 payload → `recordResult`（事务内 running 状态守卫 + 去重抛错）→ 预算/连败停止 → `finishRun` → 进程探针诊断（service-main.ts:1569-1578）。

- 无测试覆盖的路径：① production-proactive.ts:546-557 命令接线和 onReplay 诊断（唯一消费者是尚未存在的界面/诊断，仅 fixture 验证消息格式）；② service-main.ts:1567-1578 生产装配（没有任何测试用 replays/history 实例化 ProductionProactive）；③ gmail read 的 404 分支；④ `markListed`/`finishRun` 被打断（非 running）后的静默 no-op；⑤ interrupted run 残留封存文字的清理（无入口，见发现 2）。
- 有覆盖的核心：隔离与「真实账本为空」反向用例（integration:312-333）、预算停止（:296-310）、连败+单运行（:312-337）、释放（:342-380）、中断（:368-380）、清空联动（:381-396）、gmail 列表/读/失败（unit:212-276）。

结论：单封→模型→落记录的核心链路隔离可信、有反向用例；缺失主要在生产接线层和删除/展示入口。

## 必答问题

1. **会不会改变模型已见过的请求开头？** 不会。读代码证实：`asOf` 不传时 `startedAt = clock.now()`，与改动前逐字节等价（proactive-mail-check-service.ts:400-406，时长/超时走 clockAt，:1007 用 trace.clockAt）；`asOf` 唯一传入点是回放服务（:276），生产在线构造（production-proactive.ts:169）不传。回放的每封邮件是全新单轮请求，`now/today` 只出现在提示的最后一个 segment（prompt-catalog/src/mail.ts:51-60、proactive-mail-check-service.ts:266-272），工具定义与固定指令是 prompt-catalog 固定文字，不涉及会话历史改动。追加点一致。
2. **会不会让同一段文字在不同请求里变成不同的字节？** 不会（读代码证实）：遮盖函数无状态对外（maskSensitiveText 单入参，redaction.ts:516），prompt 由固定目录文字 + 按读取顺序的邮件 JSON + 末尾时间行构成，无依赖数据库返回顺序的集合进入提示（batchMemories 有显式排序且回放不传 memory）；`judgedAt`、`startedAt` 等每轮不同的值只落回放表，不进模型文本。推测：将来标注界面若把 `judgedAt` 排序展示，注意用固定排序（现 `listResults` 已按 message_id 排序）。
3. **有对应自动检查吗？反向用例会失败吗？** 有，且方向正确（读代码证实）：「回放后真实账本为空」用例（断言 listDecisions/listInsights 为空、unprocessed 原样、cursor 不变）在隔离被破坏时必然失败；迁移与 audit 都有反向用例（audit 拒绝未知 schema，workspace-lifecycle-audit.test.ts:503-517）。缺口：asOf 的「不传时逐字节等价」没有专门的自动断言（`check:prompt-prefix` 只覆盖线程多轮对话，规则文本 :74 明言），依赖既有 mail-check 套件+代码等价性；发现 3、4 的耦合无反向用例。
4. **每个新值两端的校验都接受吗？** 核对通过（读代码证实）：`proactive.replay.start` 消息在 contracts、白名单、dispatch 三处一致，fixture 已加；`proactiveReplay.*` 操作前缀路由唯一；上限常量在 contracts、服务层、SQLite 三处同值；result 字段校验与 0079 的 CHECK 一致（枚举、64 字符 reasonCode、256 字符 id、时间全 ISO）；contentRef 的 FK 与释放顺序两端一致。发现的例外：发现 2（deleteRun 无生产入口）、发现 3（skipReason↔reasonCode 的隐式耦合没有测试钉住）。
