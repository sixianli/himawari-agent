## 范围

本轮只核对了增量 `15151e5..f1d3f64`（`508bf33f1` 回填迁移、搜索测试、CHATS.md 文字；`4bd178538` 管理迁移测试）。另顺着证据读了这些使用端：`thread_command_receipts`、`thread.create` 幂等与指纹、`think_inbox` 结构、`origin` 的各处过滤、导出清单校验、迁移冲突分析脚本、提示词冻结。未运行任何测试（工具限制），下面“会失败/不会失败”是按代码路径推断。

## 上一轮意见核对

- 第 1 条（历史想一想对话被标成 owner）：已改。迁移 `20261115045512_thread_origin.sql:3-15` 不再只按编号前缀，而是要求该线程有 `command_type='thread.create'`、且幂等键等于 `'think-thread:' || think_inbox.id` 的回执。生产端确实用 `think-thread:${entry.id}`（`production-think-runner.ts:195`），`thread_command_receipts` 的唯一键是 `(owner_id, agent_id, idempotency_key)`（`0015_thread_lifecycle_and_search.sql:33-45`），所以新增测试 `think-runner.test.ts:526-577` 的正向路径能对上。
- 第 3 条（搜索 origin 过滤没有反向用例）：已改。`think-runner.test.ts:474-497` 直接给所有消息写同一 token 的投影，再调 `threads.search`；如果删掉 `sqlite-thread-operations.ts:2031` 的 `current_thread.origin = 'owner'`，归档的想一想对话和普通对话会同时命中，断言 `[lookAlike]` 会失败。
- 第 7 条（CHATS.md 文字）：已改。`chats.ts:453` 已加入“想一想时开的不在”，测试 `chat-export.test.ts:201-203` 会锁住这句话。

## 侧重检查

- **错误路径**：`thread.create` 重放会核对语义指纹（`sqlite-thread-operations.ts:394-403`）。本轮增量没改这段，但迁移回填会让旧的、崩溃后仍在 active 的想一想线程进入重试路径，见下面第 2 条。
- **不可信输入**：客户端能自选 `threadId` 和 `idempotencyKey`（`product-thread-gateway-adapter.ts:742-747`）。迁移用的是回执键而不是“线程编号是否由 entry.id 哈希出来”，存在一个低概率残余风险，见第 3 条。
- **安全**：迁移 SQL 全是常量和表连接，没有拼接外来字符串；`GLOB 'thread:think:*'` 是字面量；导出文字是固定文案，标题仍走原来的 `plainLine/foldText`。没有发现新的注入或越权面。
- **资源耗尽**：回填的逐线程 `EXISTS` 在长期库上可能变慢，见第 1 条；`think_inbox` 行按设计永久保留，而回执表没有 `thread_id` 索引（`0015...sql:33-45` 只有 `(owner_id, agent_id, idempotency_key)` 唯一索引）。
- **不可撤销操作**：迁移只 `ADD COLUMN` 并写新列的常量 `'think'`，不删旧数据；测试里的 `DROP COLUMN` 只发生在临时测试库。没有发现新增的破坏性操作。
- **文档一致性**：`docs/architecture-v0.1.md:437` 已同步；`docs/adr/0235-chat-history-export.md` 和导出清单里还有与现状不一致的旧说法，见第 4 条。

## 意见

### 1. 中低｜回填迁移用逐线程相关的 EXISTS，长期库上可能把启动迁移拖慢

文件：`packages/persistence-sqlite/src/migrations/20261115045512_thread_origin.sql:5-15`；`packages/persistence-sqlite/src/migrations/0015_thread_lifecycle_and_search.sql:33-45`

问题：外层只处理 `id GLOB 'thread:think:*'` 的线程，但每个候选线程都要跑一次相关子查询；子查询里 `receipt.thread_id = threads.id` 没有可用索引（`thread_command_receipts` 只有主键和 `(owner_id, agent_id, idempotency_key)` 唯一索引），`think_inbox` 又只按 `(owner_id, agent_id)` 前缀可用。`think_inbox` 行按设计永久保留，回执也会一直增长，因此代价可能随历史“想”的次数累积。

证据（读代码证实）：上述两处 schema 没有 `thread_id`/`command_type` 索引；迁移的 `EXISTS` 在 `WHERE` 内反复执行。

推测（未运行、未看查询计划）：最坏情况下每个候选线程都要扫一遍回执或 inbox，长期库可能让一次性迁移变慢并长时间持写锁。建议改成先做一次连接再按主键更新，例如 `UPDATE threads SET origin='think' WHERE origin='owner' AND id IN (SELECT receipt.thread_id FROM thread_command_receipts receipt JOIN think_inbox entry ON ... WHERE receipt.command_type='thread.create')`；或在迁移期间临时建 `(owner_id, agent_id, thread_id)` 索引。当前功能刚上线，实际数据量可能很小，所以定为中低。

### 2. 低｜`thread.create` 指纹加入 `origin` 后，升级后重放旧想一想回执会冲突

文件：`packages/application/src/services/thread-command-service.ts:98-105`；`packages/persistence-sqlite/src/sqlite-thread-operations.ts:394-403`；`apps/agent-service/src/production-think-runner.ts:191-198`

问题：新代码在 `origin='think'` 时把它放进语义指纹；旧版本写下的回执里没有 `origin`。如果升级前恰有想一想条目在“建完对话、还没归档”时崩溃，升级后重试会再次 `create`，`replay` 发现指纹不同而抛 `PORT_CONFLICT`，这一条会被 `production-think-worker.ts:110-116` 记成 `think_failed`。

证据（读代码证实）：`canonical()` 会保留对象键（`thread-command-service.ts:29-38`），`replay` 对指纹不一致直接失败（`sqlite-thread-operations.ts:396-402`）。

推测（未运行）：只有“升级窗口内存在未完成的想一想条目”才会触发；影响是少想一条，不涉及主人数据泄露。建议要么不把内部字段 `origin` 纳入指纹（客户端本来不能传 `origin`），要么在 `replay` 中对“仅旧指纹缺少 origin”视为兼容。此问题来自第 1 轮改动，不是本轮增量引入。

### 3. 低｜回填仍只认回执键，测试没有覆盖“客户端键也撞上”的情况

文件：`packages/persistence-sqlite/src/migrations/20261115045512_thread_origin.sql:8-15`；`packages/application/src/services/product-thread-gateway-adapter.ts:742-747`；`test/integration/think-runner.test.ts:543-550`

问题：客户端可以自选 `threadId` 和 `idempotencyKey`。迁移只验证“线程编号以 `thread:think:` 开头”且“存在 `thread.create` 回执，其键等于 `think-thread:` 加某个 `think_inbox.id`”，没有验证线程编号是否真的由该 entry.id 按 `#ids` 的 SHA-256 规则算出来。若客户端在升级前用某个真实 `think_inbox.id` 作为键、并自选 `thread:think:` 编号，迁移会把普通对话误标成 `think`。新增测试只用了 `think-thread:not-a-think-entry`，因此只证明“键不匹配时留 owner”。

证据（读代码证实）：入口端确实把客户端提供的 `threadId`/`idempotencyKey` 传给 `create`（`product-thread-gateway-adapter.ts:742-747`）；测试的伪造键不对应任何 inbox 行（`think-runner.test.ts:548`）。

推测（未运行）：需要客户端知道内部 inbox 编号并主动使用该模式，且只影响自己的库；不是越权，产品上也说隐藏不是安全边界，所以定为低。建议若要严格执行方案里“客户端自选 think 前缀仍是 owner”，把回填放到 TypeScript 里按 `thread:think:` + `sha256(entry.id)[0:32]` 精确核对，而不是在 SQL 里用回执键代替。

### 4. 低｜导出清单仍宣称“到期自动删除”，ADR 0235 的范围说明也没跟上

文件：`packages/persistence-sqlite/src/data-export/chats.ts:502-506`；`docs/architecture-v0.1.md:437`；`docs/adr/0235-chat-history-export.md:54,91`

问题：清单里的“未导出”原因写着“不是你的对话，到期自动删除，不导出”，但同一轮文档明确说“现在还没有自动删除”（`architecture-v0.1.md:437`）。ADR 0235 仍说范围是所有进行中/已归档/回收站对话、回收站对话照常导出，而现在 `chats.ts:117,140` 会把 `origin='think'` 排除。

证据（读代码证实）：`chats.ts` 的导出查询带 `origin='owner'`，清单原因带“到期自动删除”；架构文档说还没有自动删除；ADR 仍未提 `origin`。

推测：这是文字层面的不一致，不影响代码行为；但用户导出时会看到尚未实现的承诺。建议先把清单原因改成“不导出，计划到期自动删除”，并在 ADR 0235 加一行后续修订说明或更新范围。此项都是上一轮已存在的内容，不是本轮增量新增。

## 必答问题

1. **会不会改变模型已经见过的请求开头？** 不涉及。本轮只改导出文字、迁移和测试；`origin` 也没有进入线程提示词冻结包（`sqlite-thread-prompt-bundle-operations.ts:195-210` 的 identity 是显式字段），系统提示、工具定义、历史消息都不受影响。第 1 轮让 `think` 对话不进记忆每日摘要，改变的是每轮动态资料（放在最后一条消息里），不是请求开头。依据：[prompt-prefix.md#rules](../../.agents/instructions/prompt-prefix.md#rules)。
2. **同一段文字会不会在不同请求里变成不同字节？** 本轮没有引入新的不确定性。迁移只用固定字面量和数据库行，不依赖时间、随机数或无序集合；CHATS.md 是固定文案。导出清单原本就有 `exportedAt`，但那是导出文件、不是模型请求。搜索测试用 `toSorted()`，结果稳定。
3. **有没有自动检查，反向用例会真的失败吗？** 有：迁移回填测试（`think-runner.test.ts:526-577`）、搜索 origin 反向用例（同文件 `474-497`）、CHATS.md 文案断言（`chat-export.test.ts:201-203`）、管理迁移严格比较（`sandbox-reservation-administration.test.ts:756-766`）。按代码推断（未运行）：只按前缀回填时伪造线程会变 `think`，`toEqual(["owner","think"])` 失败；删掉搜索的 `origin='owner'` 时归档的想一想线程会出现在结果里，`[lookAlike]` 失败；把 CHATS.md 改回旧文案时断言失败。缺口有两个：迁移测试是手工执行 SQL，不是走 `applyMigrations` 的端到端（沙箱测试会走引擎但没有想一想数据）；没有测试“客户端键恰好等于真实 inbox id”的情况。
4. **每个新值的使用端都能接受吗？** 基本能。迁移产生 `threads.origin='think'`，所有已知使用端只比较 `'owner'` 或 `'think'`：列表 `sqlite-thread-operations.ts:1437`、搜索 `:2031`、事件 `:1819-1824`、网页/Apple 推送、首页运行、记忆摘要、聊天导出、标题生成。CHATS.md 文字只被测试和 `verifyChatExport` 读取，`CHAT_MANIFEST_SCHEMA` 的 `omitted` 是开放数组，新增条目不会让旧包校验失败。新增 `.meta.json` 的 `alters:["threads"]` 与冲突分析脚本实际检测到的唯一变更对象一致（`scripts/migration-conflicts/analyze.mjs:224-247`）；`loadBundledMigrations` 已从 `index.ts:6` 导出。未带 `origin` 的 `INSERT INTO threads`（如 `data-export/import.ts:603`）会落到默认 `owner`，符合预期。需要注意的例外就是第 2 条的旧回执指纹和第 3 条的回填判定。
