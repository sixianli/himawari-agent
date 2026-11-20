## 结论

方案解决的是真问题，但核心删除路径、隐藏范围和“系统授权”设计都有硬伤。按现状实施，最可能的结果是：**7 天自动删除实际删不干净，甚至根本不会物理删除；想一想内容仍会从事件、Live Activity、首页和导出露出；共享删除服务里的固定授权字符串可被外部命令利用。** 下面按严重度列证实的发现，再列推测项，最后给出我会采用的改法并逐条回答必答问题。

---

## 证实的发现（按严重度从高到低）

### 1. 高｜自动删除无法复用现有永久删除流程，A 方案删不干净

**问题**：`ThreadDeletionCoordinationService.deletePermanently` 并不物理删除，只把线程推进到 `deletion_pending`。真正物理删除是另一个离线适配器，它要求服务停止并持有 state-root 独占锁，运行时后台拿不到。

**证据**：
- `packages/application/src/services/thread-deletion-coordination-service.ts:136-147`：永久删除最终调用 `requestDeletion(... mode: "permanent")`。
- `packages/persistence-sqlite/src/sqlite-thread-operations.ts:846`：`const target = input.mode === "trash" ? "trashed" : "deletion_pending";`，只改状态；`:862-877` 只 `UPDATE threads`。
- 真正的物理删除在 `packages/persistence-sqlite/src/sqlite-governed-deletion.ts:456-606` 的 `deleteImmediately`。
- 该适配器的每个入口先取锁：`sqlite-governed-deletion.ts:666-672`，错误原文是 “Governed deletion requires stopped services and an exclusive state-root lock”。
- 运行中的服务本身持有这把锁：`packages/persistence-sqlite/src/product-state-repository.ts:281` 在 `open` 时 `acquireStateRootLock`。
- 管理 CLI 明确标了需要停服务：`apps/admin-cli/src/index.ts:717-729` 的 `stoppedServiceRequired: true`。
- 架构文档也写的是离线物理管理路径：`docs/architecture-v0.1.md:340`。

所以方案 A 的“数据会从所有相关的表里删干净”不成立；如果只调 `deletePermanently`，数据会一直停在 `deletion_pending`。另外 `requestDeletion` 开头有 `this.assertDiskHeadroom()`（`sqlite-thread-operations.ts:804`），磁盘紧张时连“删除”都会被拒绝，越积越多。

**建议**：不要复用 owner 删除流程。把 governed deletion 的 `#deleteCore`、`#threadPayloadRefs`、payload 文件删除、tombstone 逻辑抽成可在服务进程内调用的共享删除核心；或者新增一个 `thinkThreadRetention` 仓储操作，直接在当前 writer 连接里做事务删除，返回待删文件列表，失败可重试。若坚持只在停服务时物理清，就不能承诺“7 天后自动删”，应改成持久删除队列 + 下次安全维护执行。

---

### 2. 高｜`system:think-retention` 例外是权限提升，不能放在共享删除服务里

**问题**：`authorizationRef` 是客户端命令里的普通 `machineString`。如果在 `ThreadDeletionCoordinationService` 里加“字符串等于 `system:think-retention` 就跳过近期认证”的例外，任何已认证 Owner 都能在网关命令里带这个字符串，绕过近期认证。

**证据**：
- 合约：`packages/gateway-contracts/src/thread-contracts-v3.ts:238-248`，`authorizationRef` 和 `recentAuthenticationRef` 都是客户端传入的 `machineString`。
- 网关直接透传：`packages/application/src/services/product-thread-gateway-adapter.ts:860-872`。
- 服务只检查非空，再走近期认证：`thread-deletion-coordination-service.ts:92-97`、`:123-135`。
- OWASP 授权备忘单明确不要把客户端提供的数据当作授权依据：https://cheatsheetseries.owasp.org/cheatsheets/Authorization_Cheat_Sheet.html

**建议**：不要用固定字符串做系统例外。新增一个**不经过 `ProductThreadGatewayAdapter`** 的内部 retention 端口/方法，只由服务内部装配；授权依据是服务器侧的 `origin='think'` 和内部调用者，不是请求字段。审计引用由服务器生成并写进 tombstone，不接受外部输入。

---

### 3. 高｜`think_threads` 登记不是原子写入、不是幂等、没有回填

**问题**：方案在 `commands.create` 之后才登记 `think_threads`。进程在两者之间崩溃会留下“已创建但未登记”的想一想线程：它会出现在列表/导出里、会生成标题、永远不会被清理。重试同一 entry 时又会重复插入登记。已有想一想线程也没有回填方案。

**证据**：
- 建线程和放消息是两次调用：`apps/agent-service/src/production-think-runner.ts:191-197` 先 `commands.create`，`:198-214` 再 `admitOwnerMessage`；登记要插在两者之间。
- 重复运行路径使用稳定 ID：`production-think-runner.ts:138-149`；已有测试会第二次调用 `think()` 并期望 `run_already_finished`：`test/integration/think-runner.test.ts:341-351`。登记若不是 `INSERT ... ON CONFLICT DO NOTHING`，第二次会失败。
- 客户端可自己指定线程 ID：`packages/gateway-contracts/src/thread-contracts-v3.ts:130-137` 的 `thread.create` 带 `threadId: machineString`；`ThreadCommandService.create` 直接使用它：`packages/application/src/services/thread-command-service.ts:71-92`。因此**不能**用 `thread:think:` 前缀判断来源，也不能这样回填；否则 Owner 可以创建一个前缀相同的线程，之后被自动删除。
- `entry_id` 的计算方式：`production-think-inbox.ts:76-81` 用 owner/agent/kind/ref/version 做 SHA-256；线程 ID 再由 entry id 派生（`production-think-runner.ts:138-149`）。

**建议**：给 `threads` 加服务器控制的 `origin`/`kind` 列（`owner` / `think`），在建线程的同一个事务里写入。网关的 `thread.create` 永远写 `owner`，内部 `ThreadCommandService.create` 接受 `origin: "think"`。这样登记和创建原子完成，重试天然幂等。如果坚持单独建表：必须同事务、`INSERT OR IGNORE`、`thread_id` 唯一且外键级联；回填只能通过重新计算 `think_inbox` 的确定性线程 ID，不能用前缀。PR 551 是否已在生产跑过、是否已有既有想一想线程，见“未核实”。

---

### 4. 高｜隐藏范围只覆盖 list/search，事件、Apple Live Activity、首页、导出仍会露出

**问题**：方案只明确了列表、搜索和“检查对话事件”，但客户端可见面远不止这些。现有代码里至少还有 Apple Live Activity、首页 feed、Web Push 入队和聊天导出直接读线程/运行。

**证据**：
- 对话事件流返回 owner/agent 的全部事件：`packages/persistence-sqlite/src/sqlite-thread-operations.ts:1786-1835`。事件带 `threadId`、`payloadRef`；想一想线程会产生 `thread.create`、消息、归档等事件。
- Apple Live Activity 直接读运行，不读线程可见性：`packages/persistence-sqlite/src/sqlite-apple-push-operations.ts:644-665`；运行中的想一想线程会开始 Live Activity。标题兜底是“新对话”：`apps/agent-service/src/production-apple-push.ts:513-514`、`:541-596`。
- 首页 feed 的 `listUnattended` 把任何非 `user_message` 的运行中或失败运行列为 running/problem：`packages/persistence-sqlite/src/sqlite-run-lifecycle-operations.ts:940-975`；想一想运行来源是 `external_event`（`production-think-runner.ts:198-214`），因此会出现在首页；`apps/agent-service/src/production-home.ts:651-659` 会链接到该线程。
- Web Push 的 finished-runs 查询不过滤来源：`packages/persistence-sqlite/src/sqlite-web-push-operations.ts:692-723`；虽然稳定归档后 `threadTitle` 返回 null 会让推送过期（`service-main.ts:2798-2808`、`production-web-push.ts:856-860`），但想一想运行仍会被入队，归档失败或竞态时可能推出“Completed · 新对话”。
- 聊天导出选择所有 `status IN ('open','trashed')` 的线程和消息：`packages/persistence-sqlite/src/data-export/chats.ts:112-137`。想一想线程归档后状态仍是 `open`，因此任务说明和外部内容摘要在导出包里。

**建议**：定义一个统一的服务器可见性谓词（例如 `origin <> 'think'`，或单独的 `visible` 列），在所有客户端读模型和出站通道统一应用：`list`、`search`、`listGatewayEvents`、首页 `listUnattended`、Web Push `listFinishedRuns`、Apple `listActivityRuns`、数据导出，以及按 ID 的 detail/execution/fork（见第 10 条）。事件最好在写入事务里就按 `origin` 抑制，或至少在 `listGatewayEvents` SQL 里过滤并测试游标连续性。导出要明确排除，并在 manifest 的 `omitted` 里写条数和原因。

---

### 5. 中高｜B 的“硬删除”清单不完整，会漏 title 载荷和 ciphertext 文件

**问题**：方案 B 只写“对话、消息、运行、触发记录和载荷一并删掉”，但实际关联表更多；而且现有 governed deletion 自己就漏了 `threads.title_ref`，想一想线程当前是会生成标题的，直接复用会把标题载荷留成孤儿。payload 的 ciphertext 文件也不在数据库行删除里。

**证据**：
- `runs.thread_id` 和 `triggers.thread_id` 都是 `ON DELETE SET NULL`，不是级联删除：`packages/persistence-sqlite/src/migrations/0001_initial_product_schema.sql:131`、`:145`；只删 `threads` 会留下孤儿 run/trigger。
- prompt bundle 的 payload 引用是 `ON DELETE RESTRICT`：`packages/persistence-sqlite/src/migrations/0077_thread_prompt_bundles.sql:12-24`。
- `threads.title_ref` 只挂在 `threads` 上：`packages/persistence-sqlite/src/migrations/0015_thread_lifecycle_and_search.sql:1`。
- governed 的 `#threadPayloadRefs` 收集了 metadata、消息、checkpoint、summary、derivative、approval、prompt bundle、run payload（`sqlite-governed-deletion.ts:953-1001`），但**没有 `threads.title_ref`**。
- `PayloadStorePort.delete` 只删数据库行：`sqlite-durable-operations.ts:1923-1930`；ciphertext 文件需要显式 `rm`，见 `sqlite-governed-deletion.ts:1241-1275`。
- 删除文件失败后路径丢失就没有重试依据；已有先例把待删文件返回并持久化：`packages/persistence-sqlite/src/sqlite-github-history-policy.ts:51-79`。
- 恢复点里可能保留已删内容，产品要求永久删除 30 天内退出本地可恢复副本：`docs/prd-v0.2.md:264`。

**建议**：不要手写最小删除。抽取/复用 governed 的完整删除核心，至少补齐：
`threads`、`thread_messages`、`runs`、`triggers`、`turns`、`thread_command_receipts`、`thread_gateway_events`、`thread_search_projection`、`thread_title_search_projection`、`thread_fork_lineage`、`thread_checkpoint_jobs`、`thread_summaries`、`thread_derivative_candidates`、`thread_prompt_bundles`、`memory_episodes`、`owner_proposals.thread_id`（置空）、`memory_provenance`/`memory_history_events` 的来源标记、`audit_records.detail_ref`、`reliable_events`、所有相关 payload（**包括 `threads.title_ref`**）。
文件删除要有持久化的待删清单/tombstone，并与恢复点 retention 对接。测试要同时断言数据库行、payload 行、ciphertext 文件和恢复点行为，而不只是“消息和载荷不剩”。

---

### 6. 中｜清理触发点依赖“想一想”开启，20 个/次会饿死，崩溃留下的 active 线程永远不清

**问题**：方案把清理挂在“入口每次维护时”，但入口的 maintenance 只在想一想 worker 运行时调用；想一想是否启动取决于 `runPolicy.thinkInbox.worth`。关掉想一想后，旧线程永远不会过期。每轮最多 20 个、最长 idle 86400 秒，遇到大量积压会长期清不完。另外想一想运行在归档前崩溃会留下 `active` 线程，仅删“已归档”会永久留下。

**证据**：
- `ProductionThinkWorker.runOnce` 才调用 `inbox.maintain()`：`apps/agent-service/src/production-think-worker.ts:73`。
- `ThinkLoop` 只在配置了 worth 时创建：`apps/agent-service/src/production-think-composition.ts:30-35`；`service-main.ts:3340-3348` 只有 `thinkWorth` 才传 `think`；`production-http-composition.ts:1256` 才创建 loop。
- 现有 `maintain` 只处理队列过期/卡住/摘要载荷：`apps/agent-service/src/production-think-inbox.ts:250-283`。
- 想一想运行在 `finally` 里归档：`production-think-runner.ts:231-235`、`:315-347`；归档失败只写诊断，线程可能保持 active。

**建议**：单独起一个**始终运行**的 retention 调度器，不依赖 `worth`。查询条件用 `origin='think' AND status='open' AND archived_at IS NOT NULL AND archived_at <= now - retention`，按 `archived_at, id` 排序，循环清理到没有到期项或达到时间预算。对“崩溃后一直 active、但没有非终态 run”的线程，增加一个带宽限期的兜底规则并测试；不要只依赖归档成功。删除失败要保留待删标记，下轮重试。

---

### 7. 中｜`threadRetentionDays` 的两端没有接上

**问题**：方案只说加进 `THINK_SETTING_DEFINITIONS`，但新单位 `days`、配置类型、`ProductionThinkInbox` 的 limits/override 读取都没有覆盖。结果可能是：编译不过，或者 App 改了配置但清理仍读启动时的值。

**证据**：
- 单位清单没有 `days`：`packages/application/src/ports/configuration.ts:411-418`；定义目前 10 项：`:420-443`。
- `parseThinkInbox` 从 `THINK_SETTING_DEFINITIONS` 生成范围：`packages/platform-node/src/strict-configuration.ts:1391-1407`；新单位必须先在 `THINK_SETTING_UNITS` 里存在。
- `ThinkInboxConfiguration` 需要新增字段：`configuration.ts:399-409`。
- `ProductionThinkSettings` 能读出 override：`production-think-settings.ts:70-97`；但 `ProductionThinkInbox.currentLimits`/`#merge` 只认 6 个键：`production-think-inbox.ts:117-132`。清理如果走这里，`threadRetentionDays` 会被丢掉。
- 网关快照的 `unit` 是 `machineString`：`packages/gateway-contracts/src/contracts-v2.ts:846-863`，服务端不会拒绝 `days`，但 App 不一定能显示。

**建议**：同时改这四处：`THINK_SETTING_UNITS` 加 `"days"`；`ThinkInboxConfiguration` 加 `threadRetentionDays?: number`；`THINK_SETTING_DEFINITIONS` 末尾加第 11 项；`ProductionThinkInbox` 的 limits/`currentLimits` 纳入，或让 retention 服务每次直接读 `overrides()` 并回退到 `defaultValue("threadRetentionDays")`。清理时再校验一次 1–90，不要盲信存储值。测试要覆盖：配置解析、`think.settings.change` 改值后清理立即使用新值、快照返回 11 项。App 侧要确认能把 `"days"` 渲染出来。

---

### 8. 中｜`delete_after` 静态存储会与“可改配置”冲突，表设计也缺约束

**问题**：注册时算一次 `delete_after`，之后改保留天数不会影响已登记线程；这未必符合“保留天数做成可改配置”的预期。`threads.archived_at` 已经记录了完成时间，没必要再存一份派生值。

**证据**：归档时写 `archived_at`：`packages/persistence-sqlite/src/sqlite-thread-operations.ts:602-620`；方案里的 `delete_after` 由登记时计算，后续无更新路径。

**建议**：去掉 `delete_after`，用 `threads.archived_at + 当前 threadRetentionDays` 动态计算。若保留该列，必须在设置变更时批量更新，并加 ISO 时间校验、`delete_after` 索引、`thread_id` 唯一/外键。`entry_id` 目前没有明确消费者；如果只用于审计，说明两端；否则删掉，少一个要对齐的值。

---

### 9. 中｜“只多调一次起标题模型”不准确：还有其他辅助调用

**问题**：想一想运行确实不会进入 `memory capture`，但 `ProductionTitledRuntime` 在 `memoryCapture.start` 之后仍会启动 `memoryEpisodes`、`memoryConsolidation`、`memoryConversationReview`，只要运行有 `threadId`。这些可能产生额外模型调用和后台处理，方案只修标题不够。

**证据**：
- `apps/agent-service/src/production-titled-runtime.ts:49-58`：`memoryCapture.start(request).then(() => memoryPaused()).then(async (paused) => { if (paused) return; await memoryEpisodes?.start(request); ... })`。
- `memoryCapture` 本身确实只处理 `user_message`：`apps/agent-service/src/production-memory-capture.ts:1087`。
- `memoryEpisodes.start` 不检查 source：`apps/agent-service/src/production-memory-episodes.ts:42-63`；consolidation/review 同样只检查 threadId 等：`production-memory-consolidation.ts:63-86`、`production-memory-conversation-review.ts:433-459`。

**建议**：在 `ProductionTitledRuntime` 或各 start 方法里按 `origin/source` 统一跳过想一想运行的辅助调用；至少明确产品是否希望“想一想”触发记忆整理。测试断言想一想运行不产生标题、memory episode/consolidation/review 调用（如果决定跳过）。

---

### 10. 中低｜隐藏不等于不可访问；按 ID 的读取/派生仍可绕过

**问题**：方案只保证不出现在列表/搜索。`thread.detail`、执行状态、fork 等按 `threadId` 读取的路径没有 origin 检查。想一想线程 ID 是确定性的，知道来源的人可以算出来。

**证据**：
- `read`/`readDetailSnapshot` 不检查来源：`sqlite-thread-operations.ts:353-357`、`:1470-1488`。
- 网关 `thread.detail` 直接按 ID 读：`packages/application/src/services/product-thread-gateway-adapter.ts:360-395`。
- 线程 ID 派生：`production-think-runner.ts:138-149`；entry id 派生：`production-think-inbox.ts:76-81`。

**建议**：先明确边界：如果只是“UI 不展示”，就不用加；如果想一想内容必须不可读，就要在 detail/execution/fork 等读取入口统一检查 origin，内部 runner 用显式 bypass。不要用“客户端不知道 ID”当安全边界。

---

### 11. 低｜文档、表结构目录和测试计数会不一致

**问题**：现有架构文档明确写了“已归档/全部能看到、现在没有自动删除”和“10 项可改”，改完必须同步；新增表必须进 `schemaCatalog`，否则合同测试直接失败；新增导出/聊天导出用例要改 REQUIRED 计数。

**证据**：
- `docs/architecture-v0.1.md:437`：想一想线程“归档后主列表里看不到，‘已归档’和‘全部’列表里看得到，现在没有自动删除。”
- `docs/architecture-v0.1.md:438`：“10 项可改”。
- `packages/persistence-sqlite/test/migration-engine.contract.test.ts:80`：实际表必须等于 `schemaCatalog` 的表集合。
- `packages/persistence-sqlite/test/schema-contract.contract.test.ts:23-34`：目录唯一性和覆盖。
- `scripts/check-chat-export.mjs:20`：`REQUIRED = 37`；`scripts/check-data-export.mjs:19`：`REQUIRED = 141`。
- SQLite 外键级联行为可参考官方文档：https://www.sqlite.org/foreignkeys.html#fk_actions

**建议**：更新架构文档的 437/438 两段，补 ADR 说明“系统自动删除想一想线程”是 owner 确认永久删除规则的产品例外；新增表加 `schemaCatalog` 条目；新增导出/聊天导出测试后同步 REQUIRED。

---

## 推测 / 未核实

- **未核实**：PR 551 是否已经在生产跑过、是否已有既有想一想线程。如果有，必须回填；事件流里可能已经有客户端消费过的想一想游标，删除事件行会导致 `cursor_sequence` 复用或旧游标失效。
- **未核实**：App 是否把 `unit` 当枚举；新增 `"days"` 和第 11 项是否能在第 11 批线程里直接显示。
- **未核实**：Web Push 的 finished-runs 在归档前的竞态或归档失败时，是否会在真实生产产生“Completed · 新对话”；代码路径存在，实际触发概率未测。
- **未核实**：`memoryEpisodes`/`memoryConversationReview` 是否会实际处理到想一想内容。代码显示它们会启动，但想一想不写 memory capture；是否会产生 think 相关 episode 需实测。
- **未核实**：在大量想一想线程下，`list`/`search` 的 `NOT EXISTS` 过滤性能；需要基准。
- **未核实**：生产是否启用 Apple Push；启用时 Live Activity 路径确认存在，但是否会实际展示给用户取决于客户端。

---

## 侧重检查

**错误路径**
- 建线程成功、登记失败：线程永久可见且不清理（方案当前顺序）。
- 同一 entry 重试：登记重复插入失败；已有重试用例会暴露。
- 归档失败或进程在归档前崩溃：线程一直 `active`，只删 archived 会永远留下。
- 删除中途失败：已删数据库行、未删文件，路径丢失后无法重试。
- 磁盘紧张：`requestDeletion` 的 `assertDiskHeadroom` 会阻止删除。
- 清理循环关闭：`worth` 未配时整个 retention 不运行。
- 每轮 20 个 + idle 86400：大量积压清不完。
- 并发：清理与同一 entry 的重试/新建线程竞争；需要事务条件或运行状态检查。

**不合规范或不可信输入**
- 客户端可自选 `thread.create` 的 `threadId`，因此不能用 `thread:think:` 前缀做安全判断或回填。
- 客户端可传 `authorizationRef`；不能把固定字符串当系统凭据。
- `think.settings.change` 的 key/value 在应用层有范围校验，但存储层只校验 key 形状和 `>=0`；清理读取 override 时要再校验 1–90。
- `entry_id` 没有明确消费者；不要为了“以后可能用”新增一个两端不一致的值。
- `delete_after` 如果是外部/旧数据，必须校验 ISO 时间和范围。

**安全**
- 系统授权字符串可被外部命令利用（高）。
- 导出包含想一想任务说明和外部内容摘要（高）。
- 事件流、Apple Live Activity、首页 feed 会露出隐藏线程的存在/链接（中高）。
- 现有 governed deletion 漏删 `threads.title_ref` 的标题载荷；想一想当前有标题，实际会留下孤儿 payload（中高）。
- `payloadStore.delete` 不删 ciphertext 文件；只删行不等于删数据（中）。
- 恢复点可能保留已删内容 30 天；需要 tombstone/retention 对接（中）。
- 按 ID 的 detail/fork/execution 仍可读隐藏线程；若只是 UI 隐藏则不是漏洞，但必须明确（中低）。

**资源耗尽**
- 想一想每日上限最高 10000、保留 1 天时，20 个/分钟的清理速度刚够甚至不够；idle 最大 86400 时严重不足。
- `list`/`search` 对每行做 `NOT EXISTS` 子查询，量大时需索引/物化 origin。
- 删除大量线程会同时处理 payload 行和 ciphertext 文件；要有批量上限、时间预算和失败隔离。

**不可撤销**
- 自动硬删除没有回收站；一旦标记错误就是把 Owner 对话永久删掉。不能靠 ID 前缀回填；登记必须服务器控制且原子。
- 需要审计/tombstone，至少记录删了哪个线程、何时、为何、哪些目标成功/失败；失败要可重试。
- 恢复点删除边界要明确；不能只删主库。

**文档和代码一致性**
- 架构文档 437/438 必须更新。
- 新表必须进 `schemaCatalog`，否则合同测试失败。
- 导出/聊天导出 REQUIRED 计数要同步。
- 产品上这是“永久删除需要 Owner 确认”的例外，应有 ADR 记录 Andy 的决定。

---

## 如果由我来定，我会这样改这份方案

1. **不做 `think_threads` 登记表，改为 `threads.origin`**：值 `'owner' | 'think'`，默认 `'owner'`。在 `ThreadCommandService.create` 的内部输入里设置，建线程事务内写入。网关 `thread.create` 永远写 `'owner'`，`ThreadThinkRunner` 写 `'think'`。这样创建和标记原子、重试幂等、无崩溃窗口；标题生成、事件过滤、所有读模型都直接读 `threads.origin`。若 PR 551 已有生产数据，用 `think_inbox` 重新计算线程 ID 做一次性回填，绝不用前缀。
2. **统一可见性谓词**：所有客户端读模型和出站通道都过滤 `origin='think'`：`list`、`search`、`listGatewayEvents`、首页 `listUnattended`、Web Push `listFinishedRuns`、Apple `listActivityRuns`、数据导出。事件优先在建线程事务里按 origin 抑制 `reliable_events`/`thread_gateway_events` 写入；否则在 `listGatewayEvents` SQL 过滤，并补游标连续性测试。按 ID 的 detail/execution/fork 要不要拦，先明确“隐藏”是 UI 还是安全边界。
3. **保留期改为动态计算**：不存 `delete_after`，用 `threads.archived_at + 当前 threadRetentionDays`。单独的、始终运行的 retention 调度器（不依赖 `worth`），按 `archived_at, id` 取到期项，循环到没有或时间预算用完；只处理 `origin='think'`、已归档、无非终态 run 的线程；对崩溃留下的 active 线程加宽限期兜底。
4. **删除路径不要碰 owner 删除服务**：新增内部 `thinkThreadRetention` 端口/仓储操作，抽取 governed deletion 的完整删除核心和 payload 文件删除、tombstone、恢复点 retention。删除前收集所有 payload 引用（**包括 `threads.title_ref`**）和 ciphertext 文件路径；先持久化待删文件清单，再删行/删文件；失败可重试。绝不接受客户端传入的“系统授权引用”。
5. **配置两端接全**：`THINK_SETTING_UNITS` 加 `"days"`；`ThinkInboxConfiguration` 加 `threadRetentionDays`；`THINK_SETTING_DEFINITIONS` 加第 11 项（1–90，默认 7）；retention 每次读 override；`think.settings.change` 改完立即生效；测试配置解析、快照 11 项、清理使用新值。App 第 11 批线程确认能显示 `"days"`。
6. **导出**：明确不导出想一想线程及其消息/payload；manifest 的 `omitted` 记条数和原因；更新 `check:chat-export`/`check:data-export` 的 REQUIRED 和反向用例。
7. **标题与辅助调用**：`ProductionThreadTitles` 先看 `thread.origin === 'think'` 直接返回；同时评估/跳过 `memoryEpisodes`、`memoryConsolidation`、`memoryConversationReview`，至少用测试证明想一想运行不会多调标题模型。
8. **测试**：正反向都要有“去掉修复就失败”的用例。重点包括：
   - 想一想线程不出现在 list/search/export/事件/首页/Apple activity；
   - 普通线程仍出现在这些地方、仍生成标题；
   - 未登记的 `thread:think:` 前缀线程不会被删；
   - 已归档很久的 Owner 线程不会被删；
   - 运行中的想一想线程不会被删；
   - 重试同一 entry 不因重复登记失败；
   - 修改 `threadRetentionDays` 后旧线程按新值清理；
   - `worth` 未配时清理仍运行；
   - 删除后线程/消息/run/trigger/所有 payload（含 title、prompt bundle、文件）不剩；
   - 网关命令不能凭 `system:think-retention` 跳过近期认证；
   - 删除失败可重试且不丢文件路径；
   - 事件过滤后游标仍能继续、不重复、不 `PORT_NOT_FOUND`。
9. **文档**：更新 `docs/architecture-v0.1.md:437-438`，新增 ADR 记录自动删除例外，补 `schemaCatalog` 和测试计数。

---

## 逐条回答必答问题

### 1. 这个改动会不会改变模型已经见过的请求开头？发给模型的内容是不是仍然只在末尾追加，每轮会变的值是不是都在最后一条消息里？

**不会。** 这次改动没有动系统提示、工具定义、历史消息、资料块或出口遮盖的组装；它只新增数据库标记、读模型过滤、标题跳过和删除逻辑。想一想对话自己的请求仍是“固定提示 + 本轮任务说明”，任务说明在最后一条用户消息里，没有改动。去掉想一想标题调用只是少了一次辅助模型调用，不会重写任何已发请求。

依据：`.agents/instructions/prompt-prefix.md` 第 4、6、7 条（只追加、按对话冻结、工具集合尽量不变）；这与 Anthropic/OpenAI 的提示缓存做法一致：https://platform.claude.com/docs/en/build-with-claude/prompt-caching 、https://developers.openai.com/api/docs/guides/prompt-caching 。

**注意**：不要把 `threadRetentionDays`、`origin`、当前时间或删除状态写入系统提示/工具定义/运行环境块。它们只应存在于数据库和读模型。

### 2. 这个改动会不会让同一段文字在不同请求里变成不同的字节？

**不会，前提是不要把这些新值放进提示。** `delete_after`/`archived_at`/`origin`/retention 配置都只影响数据库查询和客户端展示，不参与模型请求序列化。跳过标题只会减少 payload/事件，不会改变想一想对话里已有消息的字节。搜索/列表过滤也不影响模型输入。

需要守住的是：如果以后有人把 `origin` 或 retention 加进“运行环境说明”或系统提示，就会违反“每轮会变的值只在最后一条消息里”的规则。当前不需要。

### 3. 改动有没有对应的自动检查，反向用例是否真的会失败？

**方案目前不够。** 方案只写了“正向/反向”两类，但没有指定文件、没有说明哪些反向用例在改动前会失败，也没有覆盖导出、事件、首页、Apple activity、配置 override、幂等登记、title_ref 清理和恢复点。

建议至少加入并纳入现有门槛：
- `test/integration/thread-run-lifecycle.test.ts`：list/search/events 过滤；普通线程仍可见；事件游标连续。
- `test/integration/think-runner.test.ts`：想一想归档、重试幂等、删除后所有相关行/载荷不剩；去掉 origin 判断后 Owner 线程被误删的用例必须失败。
- `test/integration/chat-export.test.ts` 和 `scripts/check-chat-export.mjs`：想一想线程/消息/payload 不导出，`omitted` 计数正确；去掉过滤后测试失败；同步 `REQUIRED`（当前 37，`scripts/check-chat-export.mjs:20`）。
- `test/integration/data-export.test.ts` 和 `scripts/check-data-export.mjs`：如果导出清单涉及线程/提议，补断言；同步 `REQUIRED`（当前 141，`scripts/check-data-export.mjs:19`）。
- `packages/persistence-sqlite/test/migration-engine.contract.test.ts` 与 `schema-contract.contract.test.ts`：新表/新列进 `schemaCatalog`；不加入会失败（`migration-engine.contract.test.ts:80`）。
- `test/integration/think-settings.test.ts`：第 11 项、范围 1–90、改值后清理立即使用新值；去掉 override 读取后测试失败。
- `test/integration/think-worker.test.ts`：`worth` 未配时 retention 仍执行；每轮处理上限与积压；失败重试。
- `test/integration/thread-deletion-coordination.test.ts`：网关命令带 `system:think-retention` 仍不能跳过近期认证；内部 retention 只能删 `origin='think'`；未登记/前缀相同的 Owner 线程不被删。
- `test/integration/production-web-push.test.ts` / `push-channels.test.ts`（Apple）：想一想运行不产生完成推送/Live Activity；去掉过滤后测试失败。
- `test/integration/production-memory-capture.test.ts` 或 `production-titled-runtime` 单测：想一想运行不触发标题和其他辅助模型调用（按产品决定）。

`npm run check:prompt-prefix` 这次不是必须新增用例（没有改请求结构），但仍应跑一遍确认没有回归。

### 4. 改动产生或修改的每个值，每一个使用它的地方都能接受吗？

**目前有几处接不上，正是 I-73 的同类问题。** 逐个列：

- `threadRetentionDays`：产生于配置/设置；使用于配置解析、设置快照、App、retention 清理。缺口：`THINK_SETTING_UNITS` 没有 `"days"`（`configuration.ts:411-418`）；`ThinkInboxConfiguration` 未加字段（`:399-409`）；`ProductionThinkInbox.currentLimits/#merge` 未纳入（`production-think-inbox.ts:117-132`）；如果清理读启动配置而不是 override，App 改了不生效。**必须两端都改并测试。**
- 新单位 `"days"`：服务端网关合约的 `unit` 是 `machineString`（`contracts-v2.ts:846-863`），能接受；App 是否按枚举处理未核实。**需要 App 第 11 批确认。**
- `origin`/`think_threads.thread_id`：产生于建线程（建议改为原子 origin）和登记；使用于 list/search/events/首页/Apple/导出/title/cleanup。缺口：方案只列了 list/search/title/events；首页 `listUnattended`、Apple `listActivityRuns`、导出 `chats.ts` 都会读线程/运行。**每个消费点都要加同一谓词。**
- `entry_id`：产生于 `think_inbox`（`production-think-inbox.ts:76-81`）；方案没有说明消费者。**如果没有明确用途就删掉；如果要用于回填，必须和 `thread_id` 两端校验。**
- `delete_after`：产生于登记；使用于 cleanup 查询。缺口：配置变更后不更新；缺时间格式/范围/索引。**建议改为由 `archived_at` 动态计算。**
- `system:think-retention`：产生于后台清理；使用于共享删除服务。缺口：这个值来自客户端可见的命令字段，任何 Owner 都能构造；**必须改成内部端口，不能作为命令字段**。
- `threads.title_ref`：产生于标题生成（`production-thread-titles.ts:112-123`）；使用于标题展示和删除时的 payload 收集。缺口：governed deletion 的 `#threadPayloadRefs` 没收集它（`sqlite-governed-deletion.ts:953-1001`）；想一想当前会生成标题，所以清理后标题载荷会成为孤儿。**删除路径必须补上。**
- 新表/新列：产生于 migration；使用于 `schemaCatalog`、migration contract、导出/备份。缺口：方案没写 `schemaCatalog` 和合同测试；新增时间戳 migration 会被自动发现（`migration-engine.ts:758-769`），但目录必须手工补。
- 导出 `omitted` 计数：产生于导出器；使用于 manifest 和测试。缺口：方案只“建议不导出”，没有决定和计数。**必须明确并测试。**

事件和推送也是 I-73 的典型：一个 `threadId` 在 list 被过滤了，但在 `listGatewayEvents`、`listUnfinishedRuns`、`listActivityRuns`、`listUnattended` 里仍被消费。只改 list 不够。
