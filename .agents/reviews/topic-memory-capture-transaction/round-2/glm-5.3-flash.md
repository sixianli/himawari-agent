# 方案审核：每轮记忆抽取事务化

## 证实的（按严重度）

**1（高）方案推翻 ADR 0222 决定 4，却写「暂不需要 ADR 号」，且遗漏三处配套改动面**
- 证据：`docs/adr/0222-retry-and-queue-failed-memory-capture.md:56`「**写记忆失败时不重试、不排队，直接写『放弃』**……存记忆是按候选逐条写的，外面没有整体事务」；`:83-84`「放弃的做法」明确否决了「存记忆失败也重新问模型、或放进补做」和「用同一份结果再存一次」，理由正是没有事务边界。本方案用事务消掉了这个前提，结论可以反过来——但这是改一条已接受的 ADR 决策，不是实现细节。
- 配套遗漏：网页文案把 `capture_gave_up` 解释为「或者抽取出来后没能存完（可能已存下一部分）」（`apps/control-center/src/i18n/resources/zh-CN.ts:988-989`，en/ja 同键），事务化后这句话永远不再成立，三种语言要一起改并过 `check:locale`；ADR 0222 决定 4/5 里「删行失败窗口」（存成功、删行失败只删行不重问模型）随出队并入事务而消失，`test/integration/production-memory-capture.test.ts:3371`（"does not replay a turn again after its memories were saved but its row could not be removed"）整个用例失去意义。
- 建议：开 ADR 0238（supersede 0222 决定 4，写明事务化后重试为何安全），同步改三语文案，列出被删除/重写的用例。

**2（高）超时或隐式回滚后，fn 还在跑，续写会以新隐式事务落库——方案要消灭的半轮会以更隐蔽的形式回来**
- 证据：方案 1 只说「抛错或超过期限 ROLLBACK」，没有定义回滚后 fn 内后续调用的行为。`processCommittedRun`/`resolveSensitive` 没有取消机制（`packages/application/src/services/automatic-memory-service.ts:138-270` 是普通 async 循环）。better-sqlite3 文档还警告：SQLite 可能自行回滚事务（`SQLITE_FULL`/`SQLITE_BUSY`/`RAISE`），「catch 到 SQLite 错误后继续执行 SQL 可能已不在同一事务里」（https://github.com/WiseLibs/better-sqlite3/blob/master/docs/api.md，`.transaction()` Caveats 原话："if you catch an SQLite error within a transaction, you must be aware that any further SQL that you execute might not be within the same transaction"）。
- 建议：scope 置 aborted 标志，回滚/超时后范围内一切 read/write 一律拒绝抛错；worker 侧每次操作后核对 `db.inTransaction`，发现事务被隐式回滚立即中止 scope 并上报。测试补一条「超时回滚后 fn 内续写必须抛错且零落库」。

**3（中）方案写错了现状：`generations.request` 在 `#prepare`，不在 `#commit`**
- 证据：`apps/agent-service/src/production-memory-capture.ts:1155-1184`（`#prepare` 里调用 `generations.request`）；`#commit`（`:1188-1205`）不含它。方案 2「`#commit` 把 generations.request + processCommittedRun + 出队包进同一个范围」隐含一次位置搬移；方案 4「回滚后库里没有本轮任何东西」只有在搬移后才成立，不搬则生成行（pending 标记）会残留——两种都能自洽，但必须选一条写明。搬移还需确认同一 jobId（`checkpoint:memory-capture:<runId>`，`:1157`）重放时 `sqlite-checkpoint-operations.ts:297-302` 的 identity-conflict 分支不会拦（未核实）。
- 建议：优先「不搬」：该行是登记性质的 pending 标记，回滚保留无害，改动更小；把方案 4 的措辞改成「除生成登记行外零残留」。

**4（中）现有 `[P3-5]` 测试断言的正是要改掉的行为，方案的测试清单没提**
- 证据：`test/integration/production-memory-capture.test.ts:3295-3310`（断言存失败后 `capture_gave_up` 且 `backlogRows` 为空、只调了一次模型）、`:3312-3369`（重放后放弃且不再补做）。这些在 `npm run check:memory-capture-retry` 里（I-63 行，`docs/incidents-and-gates.md`），不改必红。另外按 I-05 门槛（`docs/incidents-and-gates.md:44`），提交必须声明第 0 层相关测试，方案未提。
- 建议：测试一节加「重写 [P3-5] 中 N 条 + 声明 layer-0 清单」。

**5（中）`resolveSensitive` 纳入事务，但方案测试清单没有任何针对它的用例**
- 证据：方案 2 把批准后提交包进范围（入口 `apps/agent-service/src/production-memory-control.ts:1036-1061`），测试一节 6 条全部只覆盖 capture 路径。范围内读走写连接（`payloads.get`、`approvals.read`）在这条路径上是第一次真正用到。
- 建议：补「approval 提交中 applyProposal 失败 → approvals 仍 pending、无记忆/提醒/台账残留」的反向用例，和一条「范围内 `readText` 能读到本轮刚写的载荷」的正向用例。

**6（中，推测成分：重复 id 的具体行为未核实）失败记录的确定性 id 在多次重试下会碰撞**
- 证据：`production-memory-capture.ts:955` id=`captureLedgerId(\`${generationId}:${outcome}:${attempt}\`)`，attempt 固定 `"save"`（`:873`）。改成留队重试后，同一 generation 多次存失败产出相同 id；`ledger.append` 对重复 id 是覆盖、去重还是 `PORT_CONFLICT`（未核实）决定了是丢记录还是重试循环被自己打断。
- 建议：attempt 带上第几次尝试；补一条「两次存失败留两条决策记录」的用例。另外「按现有最大次数重试」需要把存失败也计入 `backlog.recordAttempt`——目前它只在 prepare 失败路径被调（`:926-931`），方案没指出这个调用点要挪。

**7（低）ALS 标记没有类型级防护，漏标即静默脱离事务**
- 证据：所有持久端口确实收敛在单一 choke point（`packages/persistence-sqlite/src/product-state-repository.ts:196-199` 的 `readRequest`/`writeRequest`），ALS 方案可行；但对比 Prisma 的交互式事务用 `tx`/`db` 两个类型让「漏传 tx」编译报错（https://www.prisma.io/docs/orm/prisma-client/queries/transactions，"Common mistakes → Querying through db instead of tx"），ALS 是运行时约定，新端口若绕过 choke point 就静默走读通道。
- 建议：契约测试（`packages/testing` 的 conformance 套件）加一条「scope 内读必须走写连接」；范围入口对 `generate`/网络类依赖做硬断言（生产 `extract` 是纯闭包已核实：`production-memory-capture.ts:1196-1197`；但 `resolveSensitive` 在 candidates 缺失时会重走抽取，`automatic-memory-service.ts:335-343`——生产总传 candidates：`:604`，仍值得断言）。

**8（低）5 秒独占写通道的延迟面**
- 证据：I-29/I-36 已证实单写工作线程排队是生产延迟事故源（`docs/incidents-and-gates.md:67`）。一次超时 = 全服务写停 5 秒。方案有「其他写请求不被卡死」的测试，但没有可观测性配套。
- 建议：scope 时长计入 `sqlite.slow_operation`/新日志，超时次数进周报；5 秒的取值依据写进方案（Prisma 8 已不提供事务超时参数，建议靠数据库侧/自身期限限制，见上面 Prisma 文档）。

**9（低，未核实）两处待查**：(a) `qualification.crashAt` 现有取值是 `after_state|after_result|after_event|after_commit`（`sqlite-execution-context.ts:14`），能否让进程「在第一个候选写完后」即事务中途崩溃，决定崩溃反向用例能否只靠现有钩子；(b) 反向用例「第 2 个因分级不一致被现有校验拒绝」对应的具体校验点没找到，若没有现成校验，用例得改用 `PORT_CONFLICT`（现有测试的造法，`:3286-3292`）。做梦记忆 PR 395 的两处补丁本检出无法核对——未核实。

## 侧重检查

走了一条最普通流程：主人发消息 → run 提交 → `#captureTurn`（`production-memory-capture.ts:805`）→ `#plan`（读 sources/threads/state/book/payloads，`:971-1103`）→ `#prepare`（模型调用 + `generations.request`）→ `#save` → `#commit` → `processCommittedRun`（`content.store`→`payloads.get/put`+protector；`applyProposal`→`state.read`+`saveWithProjection`+投影任务；`ledger.append`；`onCommitted`→提醒/人物）→ `#settle` 出队。这条主干在 `test/integration/production-memory-capture.test.ts` 覆盖良好（含 `[MH-1]`、`[P3-5]`、`[P3-7]`）。本方案新增代码路径（scope 路由、in-scope 读走写连接、审计延迟、回滚清理）今天全部无覆盖，方案测试清单覆盖了 capture 侧，漏了 resolveSensitive 侧（第 5 条）。文档与代码一致性：`.claude/rules/prompt-prefix.md` 存在且第 74 条的 `check:prompt-prefix` 门槛与本改动无交集；ADR 0222 与方案冲突（第 1 条）。方案前提 1–6 逐条对过代码，行号全部准确，唯独方案 2 对 `generations.request` 位置的描述不准（第 3 条）。

## 必答问题

1. **不会改变模型见过的请求开头。**改动全部在模型调用返回之后：提交阶段无模型调用（`extract` 是返回已解析候选的闭包，`production-memory-capture.ts:1196-1197`；`readSourceText` 返回内存里的 `plan.message`），审计只写日志（`service-main.ts:2377-2385`）。发给模型的内容（系统提示/工具/历史/遮盖）不经过任何被改代码，仍是只追加；唯一模型可见面变化是存失败改留队重试后同一轮可能多几次后台抽取调用——那是独立的后台请求（规则第 15 条「后台调用固定在前」不受影响），补做提示词非逐字节复刻是 ADR 0222 决定 5 已文档化的既有行为。
2. **不会产生新的字节不确定性。**遮盖和请求序列化不在改动路径上；新值只有进程内端口 `UnitOfWorkPort.run`，无新持久 id；密文每次随机（`payload-protector.ts:202-203`）与时间戳随重试变化都是既有行为，只入库存、不进请求。范围内/外读写隔离由 SQLite 事务保证。
3. **有方向、有缺口。**方案列了 6 类测试且坚持真实 SQLite+worker、反向用例，方向对；缺口：现有 `[P3-5]` 用例会红需重写（第 4 条）、resolveSensitive 无用例（第 5 条）、超时后续写行为无用例（第 2 条）、失败记录 id 碰撞无用例（第 6 条）、新测试须登记进 `npm run check` 并做 layer-0 声明。
4. **逐值核对基本通过，两处不过。**`UnitOfWorkPort`：单 choke point（`product-state-repository.ts:196-199`）可拦，需契约测试兜底（第 7 条）；`capture_gave_up` 语义：产生端 `#recordFailure:873/:955`，使用端 `proactive-reminders.tsx:341,365` + 三语 i18n——文案不改就是对不上（第 1 条）；backlog 行为：产生端 `enqueue:846`，使用端 `#replayOne:899-944`——`recordAttempt` 调用点要挪（第 6 条）；memory id / ledger id / reminder id / approval id 均确定性且两端校验现状不变。

## 如果由我来定

- 选 A（事务范围），理由同作者：B 的核心逻辑双实现分叉风险真实，且 A 的 choke point 单点可控；但补上：aborted 后拒绝续写 + `db.inTransaction` 自检（第 2 条）、`generations.request` 不搬（第 3 条）、scope 时长可观测（第 8 条）。
- 失败改留队重试：同意，但以 ADR 0238 supersede 0222 决定 4 为前提，连同三语文案、`recordAttempt` 挪点、失败 id 去重一起做（第 1、6 条）。
- `resolveSensitive` 本期纳入：同意，前提是补上它的回滚与 in-scope 读用例（第 5 条）。
- 测试一节按第 4、5、6 条扩充，登记进 `npm run check`，并按 I-05 声明 layer-0 相关测试清单。
