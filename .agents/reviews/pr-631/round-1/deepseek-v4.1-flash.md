## 复核结论

**作者说法核对（先说结论）**
- 说法 1、2、4、5、6 与代码基本一致：`claimMain` 在 `immediate` 事务里先读后插（`sqlite-thread-operations.ts:822-846`），`update` 非 active 与 `requestDeletion` 都调用 `assertNotMain`（`:613`、`:896`），批量删除的条件与重核在同一连接（`sqlite-governed-deletion.ts:483-544`），`ThreadDeletionRetry` 的 50 条/批终止条件与代码一致（`production-thread-deletion-retry.ts:30-45`），网页确实移除了新对话/分支入口。
- 说法 3 部分不成立：`readContextSnapshot` 确实不过滤 internal（`sqlite-thread-operations.ts:1687-1689`），但**记忆抽取并不是只用 `listMessages` 读**，见问题 1；数据导出只过滤了消息列表，计数没过滤，见问题 10。
- 说法 7 不成立：浏览器资格脚本仍在点已删除的“分出新对话”，见问题 2。

### 1. 高 — `internal` 消息会被记忆抽取写进主人可见的记忆，作者“记忆抽取只用 listMessages”的说法不成立
- 文件:行：`apps/agent-service/src/production-memory-capture.ts:1087-1097`、`packages/persistence-sqlite/src/sqlite-thread-operations.ts:1203-1206`、`:1794-1799`
- 问题：记忆抽取先按 `sourceType === "user_message"` 取这次运行的来源消息文本，再用 `readCommittedMessagesByIds` 取当前 owner 消息；后者不过滤 `internal`。而 internal 消息正是以 `role='owner'` 写入、默认 `triggerSource` 就是 `user_message`。因此 internal 消息内容会被写进记忆，而记忆是主人可见、会导出的。
- 证据：
  - `production-memory-capture.ts:1087` `if (!source || source.sourceType !== "user_message" || source.threadId !== threadId) return;`
  - `:1089-1097` `const message = await this.#readText(source.payloadRef, ownerId, agentId); ... readCommittedMessagesByIds(...messageIds: [source.sourceId...]) ... if (!owner || owner.role !== "owner" || owner.contentRef !== source.payloadRef) return;`（没有 `owner.internal` 检查）
  - `sqlite-thread-operations.ts:1203-1206` 插入 `role='owner'` 并写 `internal`；`:1796-1798` 的 `readCommittedMessagesByIds` 没有 `internal = 0`。
  - `test/integration/main-thread.test.ts:281-293` 的 internal 消息没有传 `triggerSource`，即默认 `user_message`，会走上面的路径。
- 建议：记忆抽取读取当前消息时显式拒绝 `internal`（或让 `readCommittedMessagesByIds` 对“主人话语”用途过滤 internal）；补一条集成测试：internal 消息的 run 结束后，记忆里查不到它的内容。证据性质：读代码证实；是否会真的在线上触发取决于是否有 internal 消息产生 run（当前接口允许，且测试就是这种用法）。

### 2. 高 — 浏览器资格脚本仍在点“分出新对话”，改动后该 CI 浏览器检查会失败
- 文件:行：`scripts/qualify-control-center-browser.mjs:555-556`、`:1060`，`scripts/ci/browser.mjs:87-100`
- 问题：本 PR 删除了回答下的分支按钮，但 `qualify-control-center-browser.mjs` 仍用 `getByRole("button", { name: "分出新对话" })` 点击并等待 `thread-fork`，journey 列表也仍列 `thread-fork`。`scripts/ci/browser.mjs` 明确会执行该脚本，因此 CI 的 browser 检查会超时失败，说法 7“全部通过”不可信。
- 证据：
  - `scripts/qualify-control-center-browser.mjs:555-556` `await page.getByRole("button", { name: "分出新对话", exact: true }).first().click(); await page.waitForURL(/\/threads\/thread-fork%3A|\/threads\/thread-fork:/);`
  - `:1060` `"thread-fork",`
  - `apps/control-center/src/components/answer-footer.tsx` 中 `onFork` 按钮已删除；全仓库源码里已没有“分出新对话”按钮。
- 建议：把该脚本改成“主对话”流程，并断言不存在分支按钮；或删除 `thread-fork` journey。证据性质：读代码证实（按钮已删、脚本仍点）；未实跑浏览器。

### 3. 中 — 没有选中对话时发送仍会新建普通对话，破坏“只有一个主对话”
- 文件:行：`apps/control-center/src/thread-control-center.tsx:1208-1239`、`:1251-1261`；`apps/control-center/test/thread-interactions.unit.test.ts:1948-1963`
- 问题：`submitDraft` 在 `origin` 为空时仍调用 `thread.create` 创建一个随机 id 的新对话。正常加载时，从页面打开到 `thread.main` 返回、自动跳转完成之间，用户就能发送；`thread.main` 失败（非 401）时该状态会一直存在。新建的对话不是主对话，会出现在侧栏列表里，违背“App 和网页只有一个主对话”。
- 证据：
  - `thread-control-center.tsx:1208-1215` `if (!origin) { ... commandType: "thread.create", threadId: existing?.threadId ?? \`thread:${crypto.randomUUID()}\` ... }`
  - `:1221-1228` 真的发出 `thread.create`；`:1260` 成功后导航到新对话。
  - `thread-interactions.unit.test.ts:1948-1963` 这个用例明确期望“main 未知时创建失败保留草稿”，即把这条新建路径当作期望行为。
- 建议：主对话未知时不要创建普通对话；要么禁用发送并重试 `thread.main`，要么让服务端只允许/自动登记主对话。把该测试改成“main 未知时不发送、重试主对话”。证据性质：读代码证实。

### 4. 中 — 会话轮次/记忆水位按全部消息取 `max(sequence)`，internal 会让索引反复重算、重复嵌入
- 文件:行：`packages/persistence-sqlite/src/sqlite-conversation-turn-operations.ts:309-324`、`packages/persistence-sqlite/src/sqlite-memory-operations.ts:1697-1710`、`packages/memory-engine/src/conversation-turns.ts:176-182`
- 问题：水位查询取所有 `thread_messages` 的最大 sequence（含 internal），但 `listMessages` 不返回 internal。只要最后一条是 internal，`indexedThrough` 永远小于 `lastSequence`；`indexDue` 又因为 `first.sequence === watermark.indexedFrom` 不跳过最后一轮，于是每次触发都重新索引、重新嵌入同一轮。记忆片段侧也会每次被返回但读不到消息。
- 证据：
  - `sqlite-conversation-turn-operations.ts:314-316` `FROM thread_messages WHERE ... GROUP BY thread_id`（无 `internal = 0`）
  - `sqlite-memory-operations.ts:1702-1705` 同样取全部消息的 `max(sequence)`
  - `conversation-turns.ts:181` `if (last.sequence <= watermark.indexedThrough && first.sequence !== watermark.indexedFrom) continue;`
- 建议：水位与索引使用同一可见性口径（加 `AND internal = 0`，或让 `listMessages` 返回 internal 但单独标记）；补一条“最后一条是 internal 时不重复索引”的测试。证据性质：读代码证实；“持续多久”取决于 internal 之后是否有可见消息，若将来 assistant 回复也标 internal，就会永久循环（推测）。

### 5. 中 — 搜索投影把 internal 消息也写入索引
- 文件:行：`packages/persistence-sqlite/src/sqlite-thread-operations.ts:1947-1953`
- 问题：`pendingSearchProjection` 的消息分支只按 `origin='owner'`、`status='open'` 筛选，没有 `internal = 0`。主对话正好是 owner/open，internal 文本会被分词写进 `thread_search_projection`。虽然搜索结果只返回对话摘要，不直接显示片段，但隐藏内容会影响“搜得到哪条对话”，且与“界面上不显示 internal”不一致。
- 证据：`:1949-1953` `FROM thread_messages m JOIN threads t ... WHERE ... t.origin='owner' ...`（没有 internal 过滤）。
- 建议：投影查询加 `m.internal = 0`，并补一条“只在 internal 里出现的词搜不到/不会让对话命中”的反向测试。证据性质：读代码证实。

### 6. 中 — 主对话创建失败被吞掉，网页又没有新建入口也无重试，可能导致无法开始对话
- 文件:行：`apps/agent-service/src/production-http-composition.ts:1312-1321`、`:1911`、`:1927`；`apps/control-center/src/thread-control-center.tsx:351-364`
- 问题：`ensureMainThread()` 失败只写诊断、不阻止启动；页面侧 `thread.main` 查询只处理 401，其他错误静默，且不会重试。此时侧栏不渲染主对话链接（`thread-sidebar.tsx:304` 要求 `mainThreadId`），也没有“新建对话”按钮，用户只能触发问题 3 的普通新建路径，等于主对话功能不可用。
- 证据：
  - `production-http-composition.ts:1312-1321` `mainThread.ensure().then(() => undefined, (error) => options.threadDeletionDiagnostic?.({...}))`
  - `thread-control-center.tsx:360-362` 只处理 `status === 401`，其余 `.catch` 不设置任何错误/重试状态。
- 建议：主对话创建失败应让启动失败或持续重试并暴露可诊断状态；页面侧保存失败状态并提供重试；不要用“新建普通对话”兜底。证据性质：读代码证实错误路径。

### 7. 中 — `internal` 只能标主人侧消息，assistant 回复和现有 background notice 仍对主人可见，“往来”只隐藏了一半
- 文件:行：`packages/persistence-sqlite/src/sqlite-thread-operations.ts:1203-1206`、`:1304-1310`、`:1073-1089`
- 问题：`admitOwnerMessage` 可以写 `internal=1`，但 `commitAssistantMessage` 的 INSERT 没有 `internal` 列，默认 0；`admitBackgroundNoticeInTransaction` 写入的 system 消息也没有 internal。因此她和后台子线程的“回复”以及现有的后台通知仍然会出现在对话详情里。文档说 internal 是“她和后台之间的往来”，但这套代码只能隐藏一个方向。
- 证据：
  - `:1206` 主人消息 INSERT 列表含 `internal`；`:1306-1310` assistant INSERT 列表不含 `internal`；`:1073-1089` system background notice 也不含。
- 建议：给 `CommitAssistantMessageInput` / background notice 增加 `internal`，或在文档中明确本 PR 只支持主人侧；补“internal 消息引发的回答也不可见”的测试。证据性质：读代码证实；是否由后续 PR 补上未核实。

### 8. 中低 — 启动时无上限批量删除 legacy 对话，且没有走逐对象删除的状态锁
- 文件:行：`apps/agent-service/src/production-thread-deletion-retry.ts:30-45`；`packages/persistence-sqlite/src/sqlite-governed-deletion.ts:483-524`、`:465-481`
- 问题：`runOnce` 的 for 循环会一直删到某一批不满 50，启动时对历史全量对话执行，没有每轮上限；`deleteLegacyThreads` 直接调 `#deleteOpen`，不像 `#deleteLocked` 那样先取状态锁。大量历史对话下可能长时间占用事件循环/数据库，并与手动的受控删除并发。
- 证据：
  - `production-thread-deletion-retry.ts:32-37` `for (;;) { ... if (batch.length < BATCH || verified === 0) break; }`
  - `sqlite-governed-deletion.ts:492-501` 直接 `#deleteOpen(database, ...)`；对比 `:470-474` 的 `const lock = await this.#lock();`
- 建议：给单次运行设总上限或分批让出事件循环；批量删除也使用同一把状态锁。证据性质：读代码证实结构；实际耗时取决于历史数据量（推测）。

### 9. 中低 — 文档称 iPhone 也用 `thread.main`，但 Apple 端仍会新建对话、从未调用它
- 文件:行：`docs/architecture-v0.1.md:439`；`clients/apple/Sources/HimawariChat/ChatView.swift:142-162`；`clients/apple/Sources/HimawariChat/ChatStore.swift:264-275`
- 问题：新增文档写“网页和 iPhone 都用它找到主对话”，但 Swift 客户端提交时仍在 `newThread` 创建新对话，全仓 Swift 只有生成的能力清单提到 `thread.main`，没有调用。材料里“iPhone 用 thread.main 找到主对话”在本提交也未实现。
- 证据：`ChatView.swift:155` `let created = try await store.newThread(requestId: createRequestId)`；`ChatStore.swift:264-267` `newThread` 调 `api.createThread`；`Generated/ClientCapabilities.swift:231` 只有能力声明。
- 建议：要么把文档改成“网页已用、iPhone 待后续 PR”，要么在本 PR 或后续 PR 明确实现并验收 Apple 端。证据性质：读代码证实；是否属于后续 PR 范围未核实。

### 10. 低 — 数据导出只过滤消息列表，受限消息计数仍包含 internal；该过滤无自动测试
- 文件:行：`packages/persistence-sqlite/src/data-export/chats.ts:128-142`
- 问题：`messages` 查询加了 `internal = 0`，但 `restrictedMessages` 计数没有，导致“多少条受限消息被省略”把 internal 也算进去；另外没有测试验证 internal 不会出现在导出中，去掉 `internal = 0` 也不会失败。
- 证据：`:128-133` 计数没有 internal；`:137-138` 列表有 `AND classification != 'restricted' AND internal = 0`。
- 建议：计数一致加 `internal = 0`；补一条导出包含 internal 的测试。证据性质：读代码证实。

### 11. 低 — `thread.main` 每次加载都读主对话的完整 detail（含全部 run）
- 文件:行：`packages/application/src/services/product-thread-gateway-adapter.ts:314-319`；`packages/persistence-sqlite/src/sqlite-thread-operations.ts:1530-1545`、`:1809-1826`
- 问题：主对话永不轮换、run 会一直累积，而 `thread.main` 只需对话摘要，却调用 `queries.detail(... limit 1)`，后者还会 `listRuns` 取该主对话全部运行和后台命令。随着主对话变长，每次页面加载的开销持续增大。
- 证据：`product-thread-gateway-adapter.ts:315` `const detail = await this.#dependencies.queries.detail(ownerId, agentId, threadId, 0, 1);`；`sqlite-thread-operations.ts:1814-1826` 的 `listRuns` 无 limit。
- 建议：给端口加只读主对话摘要的方法，不复用完整 detail。证据性质：读代码证实；影响大小取决于运行数量（推测）。

**侧重检查**

- **不可信输入/安全**：重点查了 internal 消息被哪些“主人话语”路径读取。`production-owner-intent.ts:66-90` 虽然用 `readCommittedMessagesByIds` 取当前消息，但最终词表来自 `listMessages`（已过滤 internal），所以 owner-intent 没有把 internal 当主人原话；真正的问题是记忆抽取（问题 1）和 `readCommittedMessagesByIds` 本身没有 visible 约束。另注意 internal 消息以 `role='owner'` 存入，模型会把它当主人发言，若将来子线程内容包含外部不可信文本，存在提示注入面（推测，取决于后续生产者）。
- **错误路径**：查了主对话创建失败、`thread.main` 非 401 失败、网页无重试/无入口（问题 6）；查了删除失败时 `deleteLegacyThreads` 抛错会跳过本轮的补删，只等下一次小时级重试（`production-thread-deletion-retry.ts:55-70`）。
- **资源耗尽**：查了启动时无上限批量删除（问题 8）、internal 导致的重复索引/嵌入（问题 4）、`thread.main` 每次列全部 run（问题 11）。
- **不可撤销操作**：迁移无条件 `UPDATE threads SET origin='legacy'`（`20261124212416_main_thread.sql:11`），随后启动时自动批量删除；没有人工确认，删除是否可恢复依赖既有 governed deletion/备份流程，未核实。主对话本身有 `assertNotMain` 和 FK `ON DELETE RESTRICT` 双重保护（`sqlite-thread-operations.ts:849-858`、迁移文件）。
- **规则/文档一致性**：`docs/architecture-v0.1.md:439` 与 Swift/记忆抽取代码不一致（问题 1、9）；`scripts/qualify-control-center-browser.mjs` 与已删 UI 不一致（问题 2）；作者说法 3、7 与代码不一致（问题 1、2、10）。
- **新值两端校验**：`main_threads` 的 PK/UNIQUE/FK 与 `claimMain` 的 active+owner 校验匹配；`internal` 的 CHECK 与插入值匹配；`thread.main`/`thread.main_snapshot` 在契约、能力表、adapter、UI 之间齐全。未核实：owner/agent 级联删除与 `main_threads.thread_id` 的 `ON DELETE RESTRICT` 在 SQLite 级联顺序下是否会互相阻塞。

**必答问题**

**1. 会不会改变模型已经见过的请求开头？**
现有对话不会被改：迁移只加列（默认 0）和改 `threads.origin`，没有改 `thread_messages` 内容；`readContextSnapshot` 的查询顺序、`sequence` 排序都没变（`sqlite-thread-operations.ts:1685-1700`）。主对话是新对话，从空历史开始；internal 消息在产生时按 sequence 追加，之后才出现在后续运行的历史里，没有插到已发内容前面。因此“发给模型的内容只在末尾追加、每轮会变的值不放进前面”这一条成立。注意：本 PR 的 internal 测试并没有证明 internal 会出现在模型上下文里（见问题 3/测试缺口），但它也没有破坏前缀。依据与代码一致。

**2. 同一段文字会不会在不同请求里变成不同字节？**
本 PR 没有引入依赖前后文的遮盖、时间戳进提示或无序集合。`internal` 是每条消息固定的布尔值；`main_threads.created_at`、`thread.main_snapshot.generatedAt` 都不会进模型提示。`readContextSnapshot` 对 internal 的包含规则是确定的（同一 run、同一 sequence 范围每次都一样）。所以不会因本改动产生新的逐请求字节差异。搜索索引/记忆水位的问题（问题 4、5）影响的是可见性和重复计算，不是发给模型的字节。

**3. 有没有对应的自动检查？反向用例真的会失败吗？**
有一些，但不足以支撑作者的关键说法：
- 会失败的反向用例：迁移测试（`main-thread-migration.contract.test.ts`）能抓住不标 legacy、internal 默认值/CHECK 改变；`main-thread.test.ts` 能抓住 `listMessages`/detail 不过滤 internal、`claimMain` 不保留首个登记、主对话可归档/回收；`production-thread-titles.unit.test.ts` 能抓住主对话被自动起标题；`production-thread-deletion-retry.unit.test.ts` 覆盖批循环。
- 不会失败的关键缺口：
  - “internal 在模型上下文里”没有被验证，`main-thread.test.ts:318-319` 反而断言 internal 不在该 run 的 context（因为它是该 run 自己的触发消息，本来就被排除）；把 `readContextSnapshot` 改成过滤 internal，这条仍通过。
  - 记忆抽取读取 internal（问题 1）没有测试；数据导出 internal 过滤（问题 10）没有测试；搜索投影（问题 5）和会话/记忆水位（问题 4）没有测试。
  - `claimMain` 的“并发只登记一个”只在同一进程通过 `ensure()` 合并验证，没有两个数据库连接/进程的并发测试。
  - 批量删除只测了无运行/无任务的 legacy 对话；“有未结束运行或 active 定时任务就不删”“main_threads 指向的不删”没有反向用例。
  - 主对话永久删除只测了 `trash`，没测 `deletePermanently`。
  - 侧栏“主对话不在列表重复”的用例用的是 `messageWatermark: 0` 的主对话（`thread-sidebar.unit.test.ts:95`），即使删掉 `thread.threadId !== mainThreadId` 过滤它也不会出现，因此这条断言证明不了重复过滤。
  - 浏览器资格脚本会直接失败（问题 2），所以“全部通过”与实际自动检查不一致。

**4. 每个新值/字段/键/清单项，产生方和使用方两端都能接受吗？**
- `internal`（列 + `ProductThreadMessage.internal`）：产生方 `admitOwnerMessage`（`sqlite-thread-operations.ts:1203-1219`）。接受方分三类：
  - 正确过滤：`listMessages`、`readDetailSnapshot`（复用 listMessages）、数据导出消息列表、搜索的线程摘要。
  - 故意包含：`readContextSnapshot`、`readNativeHistory`。
  - **不能接受**：`readCommittedMessagesByIds`（`sqlite-thread-operations.ts:1794-1799`）以及依赖它的记忆抽取（问题 1）；搜索投影消息源（问题 5）；会话轮次/记忆片段水位（问题 4）。另外 assistant 提交和 background notice 无法产生 internal（问题 7）。
- `main_threads`：产生方 `claimMain`；消费方 `readMain`、`ProductionMainThread`、标题跳过、批量删除排除、FK RESTRICT、schema catalog。两端基本一致；`claimMain` 的“已有就返回”与 PK(owner,agent)/UNIQUE(thread) 一致。未核实 owner/agent 级联删除与 RESTRICT 的顺序。
- `thread.main` / `thread.main_snapshot`：契约 schema、消息类型清单、客户端能力表、Swift 生成能力、网页查询类型、gateway adapter 都齐全；但 iPhone 只加了能力声明，没有调用（问题 9）。网页查询失败只处理 401（问题 6）。
- `origin='legacy'`：对话列表、导出、搜索、记忆水位都只认 `origin='owner'`，旧对话会立即从这些视图消失；但 web push / run 完成查询只排除 `origin='think'`（`sqlite-web-push-operations.ts:733-734`、`sqlite-run-lifecycle-operations.ts:958`），在删除完成前，legacy 对话的运行仍可能触发推送。低风险但属于“新值的使用方没逐一适配”。
- `MAIN_THREAD_KEY` / `MAIN_THREAD_RECEIPT_REF`：作为固定幂等键和 payload/result ref，`thread.create` 会按幂等键重放并返回同一个确定性 thread id（`thread-command-service.ts:80-107`），两端校验能接受；没有发现冲突校验问题。
