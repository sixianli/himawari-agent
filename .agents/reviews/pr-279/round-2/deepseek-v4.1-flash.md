# 复核结论（增量 29acb40..f1ce491）

我只读了代码，没有运行测试（受工具限制）。总体：第 1 轮五项修复在代码上都有对应改动，四个反向用例按代码推导会失败；但取消机制有一个真实的并发窗口，单条删除的“生产修复”没有生产调用方，另有一处测试覆盖不到作者声称的语义。

## 发现（按严重度）

### 中：`start()` 在确认“没有正在运行的回放”之前就清掉取消标记，可把 `stop()` 的取消冲掉
- 文件:行：`packages/application/src/services/proactive-replay-service.ts:162`（`this.#cancelled = false;`）、`:164-178`、`:229`；`apps/agent-service/src/production-proactive.ts:225`
- 问题：`start()` 先执行 `#cancelled = false`，然后才调用 `startRun()`。如果此时已有一个回放在跑（`startRun` 返回 false → 抛 `PROACTIVE_REPLAY_ALREADY_RUNNING`），这个被拒绝的 `start()` 已经把 `stop()/cancel()` 刚设置的取消标记清掉了。正在跑的回放随后在 `:229` 看不到取消，会以 `finished` 结束而不是 `interrupted`，并继续消耗预算、拖长停机。
- 证据（亲自读到）：
  - `proactive-replay-service.ts:162`：`this.#cancelled = false;`
  - `:164-178`：`const started = await replays.startRun(...)`；`if (!started) throw ... ALREADY_RUNNING`
  - `:229`：`if (this.#cancelled) return finish("interrupted", "SERVICE_STOPPING");`
  - `:122-125`：`cancel()` 只 `#cancelled = true` 并 `await this.#active`
  - `production-proactive.ts:225`：`await this.#replay?.cancel();`
- 相关（同一根因的窄窗口）：`#active` 在 `:190` 才赋值，而 `startRun` 在 `:164` 已经有 await。取消若落在 `startRun` 未完成期间，`cancel()` 会 await 到旧的/空的 `#active`，不等待这次刚起步的回放；停机时可能在没有等待它落盘的情况下继续关闭依赖。
- 建议：按 run 使用 `AbortController`/epoch，而不是实例级布尔；只在 `startRun` 成功后才清取消；把“正在 start 的 promise”也纳入 `cancel()` 的等待（例如 `#starting` + `#active`），或让 `cancel` 在 `startRun` 前后都重新检查。

### 低：新增的 `service.deleteRun` 在生产里没有调用方，声称的“生产没人释放”并未真正接通
- 文件:行：`packages/application/src/services/proactive-replay-service.ts:127-130`
- 问题：新增的服务层 `deleteRun` 会先删行再 `seal.release`，测试也直接调用它；但仓库里没有任何生产路径调用 `service.deleteRun` 或 `replays.deleteRun`。生产的清扫走的是批量路径（`removeSource`/`clearRecords` → `deleteProactiveReplays`），那里本来就会返回 refs 并由 `ProductionProactive.execute` 释放。就当前代码而言，这个“修复”是一个没有使用者的 helper，生产可观察行为没有变化。
- 证据（亲自读到）：
  - `proactive-replay-service.ts:127-130`：`const refs = await this.#options.replays.deleteRun(...); if (refs.length > 0) await this.#options.seal.release(...)`
  - `packages/persistence-sqlite/src/sqlite-proactive-operations.ts:419-425`、`:458-463`：批量删除使用 `deleteProactiveReplays`
  - `packages/persistence-sqlite/src/durable-adapters.ts:1094` 只映射 `proactiveReplay.deleteRun`；全仓 grep 的调用点只有该服务方法和 `test/integration/proactive-replay.test.ts:497`
- 建议：如果要修的是“单条删除入口”，把服务层 `deleteRun` 接到实际命令/生命周期；否则把这条从“已修”改为“预留 API”，避免把未接线的 helper 当成生产修复。

### 低：删行与释放封存文字之间的崩溃/失败窗口没有补偿，会留下孤儿密文
- 文件:行：`packages/persistence-sqlite/src/sqlite-proactive-replay-operations.ts:327-343`；`packages/application/src/services/proactive-replay-service.ts:128-129`；`packages/persistence-sqlite/src/migrations/0079_proactive_replays.sql:41`
- 问题：先删行再释放是**必要**的（`content_ref ... ON DELETE RESTRICT`，先删 payload 会被外键挡住）。但删行事务提交后、`seal.release` 执行前若进程崩溃，或 `release` 抛错，结果行已经没了，封存 payload 变成无主数据，没有重试、日志或对账。属于不可撤销操作后的残留。
- 证据（亲自读到）：
  - `sqlite-proactive-replay-operations.ts:327-343`：事务里 SELECT refs 后直接 DELETE run
  - `proactive-replay-service.ts:128-129`：DB 删除返回后才 `seal.release`
  - `0079_proactive_replays.sql:41`：`content_ref TEXT REFERENCES payloads(ref) ON DELETE RESTRICT`
- 建议：释放失败/崩溃窗口做可重试记录（outbox 或启动清扫）；至少 `catch` 并写诊断，别让调用方拿到错误但密文遗留。

### 低：范围后置过滤用字符串比较，且接口不保证 `receivedAt` 是规范 ISO；Gmail 的下界本身可能是开区间
- 文件:行：`packages/application/src/services/proactive-replay-service.ts:225-227`；`packages/platform-node/src/gmail-source.ts:198`、`:263`；`packages/persistence-sqlite/src/sqlite-proactive-replay-operations.ts:44-48`
- 问题：过滤写成 `receivedAt >= request.from && receivedAt < request.to`，按字节比较。Gmail 读取器目前用 `new Date(...).toISOString()`，所以现有路径没问题；但 `ProactiveHistoryReader` 接口没有约束 `receivedAt` 必须是规范 ISO。任何返回带偏移量（如 `+09:00`）的读取器会被错误地判为范围外/内；非规范值最终会在 `recordResult` 的 `exactTime` 校验处让整次回放失败。另外 Gmail 列表查询用 `after:floor(from/1000)`，`after:` 是严格晚于，恰好等于 `from` 的邮件可能在 list 阶段就已丢失，后置过滤救不回来，“[from, to)” 并非完全保证。
- 证据（亲自读到）：
  - `proactive-replay-service.ts:225-227`：`read.items.filter(({ receivedAt }) => receivedAt >= request.from && receivedAt < request.to)`
  - `gmail-source.ts:198`：`receivedAt: new Date(...).toISOString()`
  - `gmail-source.ts:263`：`q: \`after:${Math.floor(Date.parse(from) / 1_000)} before:${Math.ceil(Date.parse(to) / 1_000)}\``
  - `sqlite-proactive-replay-operations.ts:44-48`：`exactTime` 要求 `new Date(parsed).toISOString() === value`
- 建议：用 `Date.parse` 比较（或先把 `receivedAt` 规范化并校验）；下界改成 `after:(floor(from/1000)-1)` 或明确承认边界语义并在文档/测试里写清。
- 附带：`markListed` 在过滤前执行（`proactive-replay-service.ts:211`），`listed` 会包含范围外邮件（测试场景里 listed=3、judged=1）。若界面/日志把 `listed` 当作“范围内数量”，会误导；建议在过滤后计数或改名。

### 低：新测试没有覆盖作者声称的两个关键语义
- 文件:行：`test/integration/proactive-replay.test.ts:470-484`、`:486-499`、`:413-429`
- 问题：
  - cancel 用例只断言最终 `interrupted`，没有断言 `judged`/结果条数。即使实现把取消检查放到“全部邮件处理完”之后，这个用例也会通过，因此不能证明“在下一封前停下”。它也没有走 `ProductionProactive.stop()` 这条实际接线（`production-proactive.ts:225` 完全未被该测试覆盖），无法发现上面的取消标记被冲掉的问题。
  - deleteRun 用例只断言 payload 消失，没有断言 `readRun` 变 undefined，也没有验证“先删行再释放”的顺序/释放失败路径。
  - 范围过滤用例没有覆盖 `receivedAt === from` 边界，也没有覆盖非规范时间的输入。
- 建议：cancel 用两封以上邮件 + 可阻塞的模型，断言第一封后停、`judged` 只加一，并新增 `ProductionProactive.stop()` 用例；deleteRun 断言行不存在与顺序；范围用例加 `from` 边界和带偏移时间的读取器。

## 侧重检查

- 错误路径：`recordResult` 抛错 → `#execute` 的 `.catch` 先 `#releaseSealed` 再 rethrow（`proactive-replay-service.ts:254-259`），最终由 `start()` 的 catch 记 `REPLAY_ERROR`（`:179-189`）；读代码证实。若这个 `finishRun` 本身失败会被 `.catch(() => undefined)` 吞掉，靠下次启动的 `interruptStale` 收尾（`sqlite-proactive-replay-operations.ts:277-285`），属于可接受但无告警。
- 不合规范/不可信输入：`from/to` 必须是规范 ISO、`from<to`、`to<=now`，`mailLimit`/`budgetMicros` 有上下界（`proactive-replay-service.ts:140-155`），SQLite 再校验一遍（`sqlite-proactive-replay-operations.ts:175-200`）；网关 schema 的范围一致（`packages/gateway-contracts/src/contracts-v2.ts:608-617`）。这部分两端一致。
- 安全：删掉 `onMasked` 只删掉上报，不影响遮盖本身——`#reportMasked` 只读取并回调（`proactive-mail-check-service.ts:374-392`），真正的 `masked()` 在 `:218-250`，提示词仍然遮盖；测试 `:568` 断言原始卡号不进 prompt。生产的敏感拦截记录只经 `mailEgress.reportMasked`（`service-main.ts:1548-1559`），而 `ModelEgress` 的 `report` 只在显式 `reportMasked` 里用（`model-egress.ts:518-541`），所以该修复在代码路径上成立（测试用的是假模型，但上报并不依赖模型实现）。
- 资源耗尽：单个回放没有总墙钟上限，最坏是 `mailLimit(2000) × perCheckMs`；预算只限制模型费用，`cancel` 只在每封邮件之间检查且等待当前操作（`proactive-replay-service.ts:229`）。这是既有设计，不是本次增量新引入；但停机等待时间可被单封的长模型调用拖住，值得在 PR 说明里写明上界。
- 规则/文档一致：`proactivePrompt` 把固定指令放前、本次数据在中、随邮件变化的 `now` 放最后（`proactive-mail-check-service.ts:252-272`），符合 `prompt-prefix.md` 第 15 条；回放不使用会话历史，谈不上“只追加”。仓库内没有描述回放 `onMasked`/取消/删除语义的文档，无法核对“已在 PR 说明里写明”，标记未核实。提交信息写 `Docs: deferred`，因此文档一致性目前无新增可查对象。

## 必答问题

1. **不会改变模型已经见过的请求开头。** 增量只碰回放服务与 `ProductionProactive.stop()`；回放是独立后台调用，没有系统提示/工具/历史，也不存在“在已有会话末尾追加”的结构。删掉 `onMasked` 只去掉上报回调，不参与 `masked()`/序列化，字节不变。回放自身 `proactivePrompt` 的可变值 `now` 在最后（`proactive-mail-check-service.ts:252-272`），且 `now = item.receivedAt`（`proactive-replay-service.ts:298`）对同一封邮件恒定。结论：不涉及“每轮会变的值必须放最后一条消息”的会话场景；会话侧请求没有改动。

2. **不会让同一段文字在不同请求里变成不同字节。** 增量没有改遮盖规则、JSON 键顺序或集合顺序；`onMasked` 只读不写、不影响 `masked()` 的输出。回放对同一封邮件用固定的 `asOf` 和同一份 item，prompt 是确定的。唯一每轮变化的是结果元数据 `judgedAt = clock.now()`（`proactive-replay-service.ts:335`），它不进入模型请求。没有新增依赖前后文的遮盖或无序集合。

3. **有自动检查，反向用例按代码推导会失败；但有覆盖缺口。** `413-429` 去掉过滤会judge 3 封而失败；`431-468` 去掉释放会 `released` 为空而失败；`470-484` 去掉取消检查会变成 `finished` 而失败；`486-499` 不释放 payload 会仍能读到而失败；`501-570` 恢复传 `onMasked` 会让 `masked` 非空而失败。缺口：cancel 没有断言“下一封前”与 `judged` 数、也没有覆盖 `ProductionProactive.stop()` 接线；deleteRun 没有断言行删除与顺序；范围用例没有边界/非规范时间。测试本身未实际运行，以上为读代码推导。

4. **产生/修改的值逐项核对：**
   - `"interrupted"`：产生于 `proactive-replay-service.ts:200/229`；消费端全部接受——类型 `proactive-replays.ts:8` 含 `interrupted`；SQLite `finishRun` 用“排除 running”的校验（`sqlite-proactive-replay-operations.ts:258-272`）；迁移 CHECK 含 `interrupted` 且要求非 running 时 `reason_code` 非空（`0079_proactive_replays.sql:10,18-19`）；`onReplay` 只把它当状态字符串写日志（`service-main.ts:1569-1578`）。两端一致。
   - `"SERVICE_STOPPING"`：产生于 `:229`；`finishRun` 要求 `boundedText(reasonCode,64)` 通过，迁移 `reason_code` 非空约束通过；日志直接透传。两端一致。
   - `deleteRun` 的 refs：SQLite 返回 `result.content_ref`（`sqlite-proactive-replay-operations.ts:327-343`）；`seal.release` 接受字符串数组并逐个删 payload（`proactive-seal.ts:35-37`）。行先删，`ON DELETE RESTRICT` 不会挡住 payload 删除。`content_ref` 覆盖了 ignore 的 `headerRef`（`proactive-replay-service.ts:356` 的 `insight?.contentRef ?? processed.headerRef ?? null`），因此不会漏掉 ignore 邮件封存的抬头。两端一致。**但**没有生产调用方（见上）。
   - 过滤边界：`request.from/to` 在服务层（`:140-155`）和 SQLite `startRun`（`sqlite-proactive-replay-operations.ts:175-200`）都要求规范 ISO；`receivedAt` 生产端由 Gmail 规范化为 `toISOString()`（`gmail-source.ts:198`），但接口未强制，且比较用字节序（见低严重度发现）。
   - 新增命令清单/载荷：`proactive.replay.start` 的网关 schema 范围（1..2000、1..5_000_000）与服务层、SQLite 校验一致（`contracts-v2.ts:608-617`、`0079_proactive_replays.sql:8-9`）；`PRODUCTION_PROACTIVE_OPERATIONS` 已包含该项（基础提交，不在本次增量）。
   - 本次增量没有新增配置键或清单项；`deleteRun` 的 `runId` 在 SQLite 端还有 128 字符校验（`sqlite-proactive-replay-operations.ts:160-165`），服务端传入的是生成值，能通过。
