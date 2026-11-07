# 复核报告（PR 279 第 6 轮，bdb10eb）

## 侧重检查（我走的使用流程）

选手定流程：主人发 `proactive.replay.start` 网关命令 → `ProductionProactive.execute`（production-proactive.ts:546-556）→ `ProactiveReplayService.start`（校验 from/to/limit/budget、`readConnection` 要求已连接、SQLite `startRun` 落 running 行，proactive-replay-service.ts:138-198）→ `#execute`：封存取 token → `history.list`（Gmail `after:/before:` 检索）→ `markListed` → 每 10 封一批 `history.read` → 逐封（先按 [from,to) 过滤，proactive-replay-service.ts:233-237）用新造的 `ProactiveMailCheckService`（隔离 store + 假 fetcher + 真 seal + 真 model，:284-320）判 → 释放模型 payload → `recordResult`（judged++、行插入）→ 收尾 `finishRun` → `onReplay` 诊断日志（service-main.ts:1569-1582）。

覆盖情况：
- 已覆盖：走通 happy path、预算停、连续 3 次失败停、仅一个 running、非法参数、删 run 释放封存文字、interruptStale、清空记录/断开邮箱删回放行并释放、[from,to) 过滤、写失败释放、cancel 停并且新 start 被拒、启动中 stop、6 小时时限；遮盖事件不上报的用例走的是「真 SQLite + 真 ProductionProactive + 网关 schema 解析」的完整链路（test/integration/proactive-replay.test.ts:504-573）。
- 未被测试覆盖（读代码证实）：`SOURCE_UNAUTHORIZED` / `READ_*` 收尾路径（假 history 永不返回这两种失败）；一批里 suspended read 全批失败对整轮的终止路径；> 10 封的 `PROACTIVE_HISTORY_READ_CHUNK` 分批；`recordResult` 返回 `!stored`（run 已被删/已结束）的静默退出分支；service-main 的生产装配（`createGmailHistoryReader` + `repository.proactiveReplays()` 真 gmail 翻页与真模型 invoker 的组合）没有任何集成测试；`onReplay` 日志仅记诊断，未测（低危）。
- 文档/规则一致性：回放无 ADR、无 docs，作者已声明推迟，schema-catalog 的说明与代码一致（“删除单个 run 尚未暴露给主人”确无生产入口）；`.claude/rules/prompt-prefix.md` 第 15 条（后台调用固定在前、变化在后）与 `proactivePrompt` 把 `now` 放尾部一致（proactive-mail-check-service.ts:271）。

## 发现的问题（按严重度）

1. **中低** — packages/application/src/services/proactive-replay-service.ts:252-258、267-274。异常停机路径不释放模型输入 payload。
   证据：正常路径 `if (record && record.modelPayloads.length > 0) await this.#options.model.release(...)`（:252-255），但 `needs_owner`（:256-259）、`capped_daily`（:260-263）、写结果失败（:267-271）与 `!stored`（:272-275）只调 `#releaseSealed`（只释放 insight/header 封存 ref，:322-330）。而真模型 invoker 的 `prepare` 把完整提示词写进了真 payload store（mail-check-service.ts:794-795，integration test 里 `prepare` 也确实写库 :195-205）。主 mail-check 服务只在 `!trace.recorded` 时兜底释放（proactive-mail-check-service.ts:443-451），回放里 record 已被假 store“记下”，trace.recorded=true，不会兜底。
   建议：这几条异常路径同样调用 `model.release(record.modelPayloads...)`；给“写结果失败”用例补断言 payload 已释放。
2. **低** — packages/platform-node/src/gmail-source.ts（`read`，diff 后 :255-270 附近）。一批内任意一封邮件 GET 抛 `GoogleRequestError` 会经 `Promise.all` 失败整批，进而 `#execute` 直接 `finish("failed", READ_MESSAGE)` 终止整轮；404 是静默丢弃，但暂时性错误也整轮失败。与 `.list/.read` 失败路径也无单测。
   建议：`Promise.allSettled` 收集，失败封按“缺邮件”处理或计连续失败，并补单测。
3. **低** — packages/application/src/services/proactive-replay-service.ts:124-127、283、app 端 :222。`cancel()` 是永久闩锁，`ProductionProactive` 若在同进程重启（stop 后再 start），新 start 永远报 `PROACTIVE_REPLAY_STOPPING`。当前 start/stop 每部署只调一次，未成实际问题；但作者说“停止请求不会被新的 start 冲掉”，实现是真的（读代码证实），只是副作用同进程不可复活（推测：仅影响未来生命周期改动）。
4. **低** — packages/persistence-sqlite/src/migrations/0079_proactive_replays.sql:19-20。`proactive_replay_runs_recent` 索引与 `PROACTIVE_REPLAY_PAGE_LIMIT`（端口 :21）在本改动内均无生产读路径（`listResults` 只被测试调用），先建索引、后用是合理预留；标注说明文档（schema-catalog）已如实写“尚未暴露”。无需行动。
5. **严重度：备注** — `interruptStale()` 在 `start()` 里 `void` 不等待（production-proactive.ts:194），失败仅进 `onFailure` 日志；未核实是否会与紧随的 tick 产生竞争（推测：无实质冲突，因唯一索引防重复 running）。

作者说法逐条核对：已改五项（遮盖不上报、写失败释放封存、停服取消不被 start 冲掉、[from,to) 过滤、deleteRun 先删行再释放、6 小时时限、schema-catalog 说明）全部读代码证实一致；“判为不成立”各项（不召回记忆——`#judge` 未传 `memory`；不按 receivedAt 排序——分页按 message_id；404 静默丢弃；asOf 流向 fetch.since/costSine 被假读取器+隔离 store 抵消；无生产发送方）也证实。无法核实：check:security-review / check:delivery-packet 在 main 上的失败（不能运行命令）。

## 必答问题

1. **不会。** 生产主链路不传 `asOf`，`startedAt = asOf ?? clockAt`（proactive-mail-check-service.ts:400-401），此时 clockAt 与改动前的 startedAt 相同，deadlineAt、durationMs（:1007）与 fetch.since（:472）逐字节等价；`CheckTrace.clockAt` 是新增内部字段，不进 prompt。回放是全新的单轮后台调用，`proactivePrompt` 把会变的 `now`/`today` 放结尾（:266-272），符合 prompt-prefix 规则第 1/15 条。
2. **不会。** 回放里进入 prompt 的时间值是目标邮件自身的 `receivedAt`（确定性，测试断言 prompts[0] 含 "2025-11-03" 且不含当前日期）；遮盖 `masked()` 只依赖文本自身；JSON 构造顺序固定（proactiveMailView），`[...new Set]` 保留插入序。各处 `clock.now()` 只落库（judgedAt、startedAt），不发模型。Gmail 检索页序不保证跨次一致（外部行为），但只影响判哪封的顺序，不影响单条请求字节（读代码证实；页序本身是推测的外部因素）。
3. **有，反向用例会真失败。** 反向性质由隔离断言承担：遮盖用例给 `onMasked` 并断言 `masked === []`（test:571-572）——若把 onMasked 重新接进回放服务（旧写法）会被触发（推测可失败，因 `#reportMasked` 会对卡号正文产生 sightings，读代码证实机制）；“账本未动”（test:296-305）、cursor 保持 "777"（test:305）同属反向守卫。缺口见侧重检查一节的未覆盖路径。
4. **每个值都核对过两端，可接受**：`proactive.replay.start`（契约 schema/消息类型 ↔ fixture ↔ 两个 operation 白名单 ↔ execute case ↔ 测试）；`resultRef "proactive-replay:{id}"`（仅测试消费）；SQLite 操作名 `proactiveReplay.*`（adapter ↔ operations switch 一一对应）；migration 79（engine ↔ 三个契约测试 ↔ 运维脚本 ↔ catalog）；导出子路径 `"./proactive-replays"` ↔ 持久层 import；schema 列约束（长度、枚举、CHECK）↔ `validResult/runId/count` 校验 ↔ 服务产值（reasonCode 全部 64 截断、outcome/skipped/failed 与 reasonCode 的成对约束两侧一致）。唯一完整路径产生的值不必后端新校验。
