我先看两个 diff 的范围和增量。
## 上轮意见核对（范围：`bd8a6237..e831e31b` 的 18 个文件；增量没碰的旧代码只在证据指向时跟读）

- 1（记忆抽取写入 internal）：**已改好**。`production-memory-capture.ts:1097-1103` 增加了 `owner.internal === true` 的提前返回；新增 `[PR631-1]` 用 `markInternal` 让来源消息带 internal，去掉该守卫时 `prompts` 会非空、记忆会被写出，反向用例会失败。文档也补了“记忆抽取也不从它抽记忆”。
- 2（浏览器脚本点“分出新对话”）：**已改好**。`scripts/qualify-control-center-browser.mjs:555` 改为断言按钮不存在，清单标签改为 `thread-fork-absent`；`answer-footer.tsx` 已无该按钮。该检查不在 `npm run check` 里，实际运行未核实。
- 3（无选中对话发送仍新建）：**已改好**。`thread-control-center.tsx:1208-1217` 改为查 `thread.main`，不再 `thread.create`；两个 `[PR631-3]` 用例覆盖失败和成功路径。
- 4（水位含 internal 导致重复索引/嵌入）：**已改好**。`sqlite-conversation-turn-operations.ts:316` 和 `sqlite-memory-operations.ts:1705` 都加了 `internal = 0`；新增 `[PR631-4][PR631-5]` 验证水位停在非 internal 消息。实际索引/嵌入读取本来就走 `listMessages`，也会过滤。
- 5（搜索投影写入 internal）：**已改好**。`sqlite-thread-operations.ts:1952` 加了 `m.internal=0`，同一测试覆盖。
- 6（主对话创建失败被吞）：**部分改好**。发送路径会重查 `thread.main` 并显示错误；但初次自动查询失败仍只处理 401（见下面第 3 条）。
- 9（iPhone 文档与代码不一致）：**已改好**。`docs/architecture-v0.1.md:439` 明确写 iPhone 还没调用 `thread.main`，`clients/apple` 里确实只有生成的能力声明。
- 10（导出计数含 internal）：**已改好**。`data-export/chats.ts:130` 和消息查询都排除 internal，新增 `[PR631-10]` 同时检查不导出、不计数。

---

### 1. 中低（潜在）— 内部消息触发运行时，主人意图门不检查 `internal`，可能拿旧的主人消息为这次动作背书
文件：`apps/agent-service/src/production-owner-intent.ts:67-90`、`apps/agent-service/src/owner-intent-gate.ts:75-85,123-129`

问题：`internal: true` 是通过 `admitOwnerMessage` 写成 `role = 'owner'` 并会启动 `sourceType = 'user_message'` 的运行（`test/integration/main-thread.test.ts:281-309` 已证明）。记忆抽取已加守卫，但 `collectOwnerWords` 没有检查当前消息的 `internal`：

```ts
67: const [current] = await threads.readCommittedMessagesByIds({ ... });
73: if (!current || current.role !== "owner" || current.contentRef !== source.payloadRef) return [];
74: const window = await threads.listMessages(...);
82: .filter((message) => message.role === "owner" && ... )
```

因为 `listMessages` 已过滤 internal，当前 internal 消息本身不会进 `words`，但窗口里的旧主人消息会进；而 `ownerIntentEligible` 只要求 `sourceType === "user_message"` 且 `externalSources.length > 0`（`owner-intent-gate.ts:76-77`）。结果是：一封邮件/子线程送来的 internal 事件触发的运行，在读过外来内容后，可能仅凭更早的主人消息被判成“主人明说过”，从而免掉审批。这跟“主人意图用 `listMessages` 读、internal 不参与”的说法不一致，也跟本轮只给记忆抽取加守卫的做法不一致。

这是潜在问题：本 PR 里生产代码还没有任何地方传 `internal: true`（只在测试里），要等后续收件箱/子线程 PR 才会真正可达。

建议：`collectOwnerWords` 在 `current.internal === true` 时直接返回 `[]`（失败关闭），并加反向用例：internal 触发 + 更早的主人消息，主人意图门必须返回未确认。文档里“主人意图用 `listMessages` 读”的说法也要改成实际读法。

---

### 2. 低 — 欢迎页发送时先 `setMainThreadId`，自动跳转会在发送结束前改选中对话，失败原因被吞
文件：`apps/control-center/src/thread-control-center.tsx:1208-1244`、`365-374`、`1148-1152`

问题：欢迎页发送查到主对话后立即 `setMainThreadId(target.threadId)`：

```ts
1210: const snapshot = await client.queryThread(threadQueryMessage(configuration, "thread.main", {}));
1216: setMainThreadId(target.threadId);
```

这会触发自动导航：

```ts
365: useEffect(() => {
366:   if (!mainThreadId || selectedThreadId || page || route.status) return;
367:   navigate({ ...route, objectId: mainThreadId, ... });
```

而 `submitDraft` 和 `performIntent` 的 catch 都用发送开始时的 `origin`（此时是 `null`）和最新的 `selectedIdRef.current` 比：

```ts
1240: } catch (caught) {
1241:   settleOutgoing(null);
1242:   if (origin !== selectedIdRef.current) return;
1243:   setMutationStatus("rejected");
1244:   setError(...)
```

```ts
1148: } catch (caught) {
1149:   if (origin !== selectedIdRef.current) return;
```

如果主对话查询成功而随后的发送失败/被拒，自动导航已经把选中对话改成主对话，两个 catch 都静默返回：用户能看到主对话里的失败气泡（`unresolvedSubmission` 仍在），但看不到具体错误原因，成功分支最后把剩余草稿搬到主对话、再导航的那段也会因为 `selectedIdRef.current === origin` 不成立而跳过。内容没丢，但错误提示和草稿切换不符合其它发送路径的行为。

这是增量引入的：0df 的欢迎页创建路径不会在发送途中有一次 `setMainThreadId`。我没有实际跑浏览器，只按代码路径确认。

建议：发送期间不要触发自动导航（例如给自动导航加 `!submissionLock.current`），或者以查到的主对话 id 作为这次发送的 `origin`，把 `setMainThreadId` 放到发送结果之后。补一个用例：初次 `thread.main` 失败、发送时成功、随后 `mutateThread` 拒绝，断言错误可见、草稿仍在输入框或主对话草稿里。

---

### 3. 低 — 初次 `thread.main` 查询失败仍然静默，侧栏没有“主对话”入口也没有可见错误
文件：`apps/control-center/src/thread-control-center.tsx:351-364`、`components/thread-sidebar.tsx:304`

问题：启动时自动查询只处理 401：

```ts
354: client
355:   .queryThread(threadQueryMessage(configuration, "thread.main", {}), controller.signal)
...
360: .catch((caught: unknown) => {
361:   if ((caught as { readonly status?: unknown } | null)?.status === 401) onUnauthorized();
362: });
```

非 401 失败被吞掉，`mainThreadId` 保持 `null`；侧栏的“主对话”链接是 `mainThreadId ? ... : null`（`thread-sidebar.tsx:304`），于是既没有主对话链接也没有错误提示，只能等用户再发一条消息触发发送路径里的重试。上轮意见 6 说“创建失败被吞掉、网页又没有新建入口也无重试”，现在发送路径算一种重试，但初次失败仍然静默。

建议：对非 401 的初次查询失败显示可重试错误或退避重试，至少让用户知道主对话暂时没找到。

---

### 4. 低 — `threads.origin` 新增值 `legacy` 没进入 `ProductThread` 类型，应用层把旧对话当普通 owner 对话
文件：`packages/domain/src/thread.ts:39,59,74`、`packages/persistence-sqlite/src/sqlite-thread-operations.ts:357`、`packages/persistence-sqlite/src/migrations/20261124212416_main_thread.sql:11`

问题：迁移写入新值：

```sql
11: UPDATE threads SET origin = 'legacy';
```

但域类型只允许 `think`：

```ts
39: readonly origin?: "think";
74: ...(input.origin === "think" ? { origin: "think" as const } : {}),
```

读取时：

```ts
357: ...(row.origin === "think" ? { origin: "think" as const } : {}),
```

所以任何走 `thread.read` 的 legacy 对话在应用层都变成 `origin === undefined`，和普通 owner 对话无法区分。列表、搜索、导出、删除重试都用 SQL 直接过滤 `origin`，这些地方接受 `legacy`；但 `readDetailSnapshot`（`sqlite-thread-operations.ts:1533-1534`）仍会按 id 返回 legacy 对话，标题服务只跳过 `think` 和主对话（`production-thread-titles.ts:61-68`）。在 `ThreadDeletionRetry` 删掉旧对话之前，直接打开旧 URL 仍能读到它，应用层代码也无法按 origin 区分。实际会不会被起标题/重命名/fork 我没跑，属于按代码推断。

建议：把 `legacy` 显式加入 `ProductThread` 的 origin 类型并在 `fromThreadRow` 保留，或明确决定 `readDetailSnapshot`/rename/fork 对 legacy 的行为并补测试；至少不要让新值在类型层被悄悄抹平成 owner。

---

## 侧重检查

- **错误路径**：欢迎页 `thread.main` 失败、发送失败、发送被拒、初次自动查询失败、主对话创建失败：见第 2、3 条；记忆抽取 internal 守卫已验证；主人意图 internal 缺口见第 1 条。
- **不可信输入**：`internal` 只能由 `AdmitOwnerMessageInput.internal?: true` 产生，写入 0/1 并受数据库 `CHECK (internal IN (0,1))` 约束；`main_threads` 的 `claimMain` 校验目标对话 active 且 origin owner。internal 消息仍进入模型上下文（设计如此），记忆/搜索/水位/导出/详情已过滤。
- **安全**：记忆抽取不会再把 internal 变成记忆；主人意图门是残留缺口（潜在）；推送回复选择 `sqlite-web-push-operations.ts:722` 和记忆来源 `findOwnerMessages`（`sqlite-memory-book-operations.ts:574`）都没有 `internal` 过滤，但前者文档明确留给后续推送 PR，后者只返回 messageId、详情接口又过滤 internal，没找到直接泄露文本的路径。
- **资源耗尽**：批量删除仍是 `ThreadDeletionRetry` 每批 50、`deleteLegacyThreads` 上限 500；新增 `internal = 0` 只是等值过滤，没有引入无界扫描或新循环。`main_threads` 的 `thread_id` 用 `ON DELETE RESTRICT`、`owner_id` 用 `ON DELETE CASCADE`，如果以后支持删除 owner，SQLite 级联删除 threads 时可能被 RESTRICT 挡住——这是推测，没有找到生产删除 owner 的入口，未核实。
- **不可撤销操作**：迁移把所有旧对话标 `legacy`；`deleteLegacyThreads` 在同一连接里再核“非主对话、无未结束运行、无 active 定时任务”（`sqlite-governed-deletion.ts:533-541`），满足后才删，逻辑与作者说法一致。旧对话被删除本身是 Andy 已接受的不可逆动作。
- **规则/文档一致性**：`docs/architecture-v0.1.md:439` 与代码基本一致（iPhone 未接、internal 排除范围、主对话保护）；作者“主人意图只用 listMessages”的说法与 `production-owner-intent.ts:67` 不符（第 1 条）。`prompt-prefix` 规则要求的“只追加、每轮变化放最后一条”没有被本次增量改动。

## 必答问题

1. **会不会改变模型已经见过的请求开头？** 不涉及。增量只改了数据库读取过滤、记忆抽取守卫、导出计数和网页入口，没有改 `readContextSnapshot`、系统提示、工具定义、历史顺序或遮盖。internal 消息是以递增 `sequence` 追加的历史行，模型上下文查询本身不按 internal 过滤；主对话是新建对话，没有旧请求前缀。结论：仍然只在末尾追加，每轮会变的值没有新增到请求头。（一个细节：`main-thread.test.ts:261-320` 这个旧测试名说“在模型上下文里”，但它断言的 `context.messages` 不含当轮来源消息，因为来源消息由运行请求单独放在最后；这不能证明历史中间 internal 消息可见，但行为上没有破坏只追加。）
2. **同一段文字会不会在不同请求里变成不同字节？** 不会。增量没有新增时间字段、随机值或依赖后续内容的遮盖；新增的 SQL 过滤基于稳定的 `internal` 列，水位和列表都有确定排序（`ORDER BY`）。`thread.main` 快照里的 `generatedAt` 不进入模型请求。
3. **有没有对应的自动检查，反向用例会失败吗？** 有：`[PR631-1]`（记忆）、`[PR631-4][PR631-5]`（搜索/水位）、`[PR631-10]`（导出）、两个 `[PR631-3]`（欢迎页发送）、浏览器资格脚本的“分出新对话不存在”断言。按代码推导，去掉对应修复后这些断言都会失败（记忆会写、投影会多出 internal、计数会变 1、发送会出现 `thread.create`、浏览器会找不到按钮）。缺口：主人意图没有 internal 反向用例；第 2 条的“发送失败 + 中途自动跳转”没有测试；初次 `thread.main` 失败没有测试；浏览器断言不在 `npm run check` 内，实际运行未核实；`npm run check` 全部通过我无法运行，标未核实。
4. **新值两端都接得住吗？** 逐个核对：
   - `internal`：产生端是 `AdmitOwnerMessageInput.internal?: true` → SQLite 写 0/1，数据库 CHECK 接受；使用端 `listMessages`、`readDetailSnapshot`、导出、搜索投影、会话轮次水位、日总结水位、记忆抽取守卫都按 0/1 处理，正确。**残留**：`production-owner-intent.ts` 的当前消息没有检查 internal（第 1 条）；推送选择没有过滤，但文档明确留到后续推送 PR。
   - `main_threads`：产生端 `claimMain` 要求 active + origin owner，数据库对 `(owner_id, agent_id)` 主键和 `thread_id` 唯一约束接受；使用端 `readMain`（标题、main_thread 确保、`thread.main`）、`deleteLegacyThreads`（排除主对话）、`assertNotMain`（归档/回收站/删除）都能接受。
   - `thread.main` / `thread.main_snapshot`：网页生产请求由 `ProductThreadGatewayAdapter` 处理，契约和客户端能力表都登记了；Apple 端只有生成的 `ClientCapabilities.swift`，没有调用，和文档一致。
   - `origin = 'legacy'`：SQL 使用端都接受，`ProductThread.origin` 类型不接受并在读取时丢弃（第 4 条）。
   - `main_threads` 的 `ON DELETE RESTRICT` 与 owner 级联删除的潜在冲突属于推测，未找到生产入口，未核实。
