本轮查过的范围：`e831e31..513eaef` 增量只改了 `apps/agent-service/src/production-owner-intent.ts` 和它的单测（其余是 `.agents/reviews` 记录）。我对照增量和当前代码核了上一轮 3 条意见，并沿线索追到 `thread-control-center.tsx`、`thread-sidebar.tsx`、持久层的 `internal` 映射；迁移、删除、主对话创建等与增量无关的旧代码没有整份重读。Layer-0 测试、`npm run check`、`check:layout` 无法在本环境运行，未核实。

**上一轮意见核对**
- 意见 1（internal 触发运行时可借用旧主人消息）：已修好。`production-owner-intent.ts:73-79` 在读取触发消息后加了 `current.internal === true` 即返回 `[]`；`sqlite-thread-operations.ts:964-967` 会把库里的 `internal=1` 映射成 `true`，`listMessages` 也已 `internal = 0`（`sqlite-thread-operations.ts:1567-1569`）。新单测 `[PR631-R2-1]` 覆盖了此路径。
- 意见 2（欢迎页发送自动跳转、失败被吞）：**未修好**。增量没有触碰相关代码，见下面意见 1。
- 意见 3（初次 `thread.main` 失败静默）：**未修好**。增量没有触碰相关代码，见下面意见 2。

### 1. 中低 — 欢迎页发送后自动跳转先改选中对话，发送失败时不报错、草稿也看不到（上一轮意见 2 未修复）
文件: `apps/control-center/src/thread-control-center.tsx:1210-1244`、`365-374`
问题: 没有选中对话时发送，先在 `1216` 调 `setMainThreadId`；`365-374` 的 effect 会在 `selectedThreadId` 为 null 时自动 `navigate` 到主对话，`selectedIdRef.current` 随之变成主对话。发送随后若失败，catch 里 `1242` 的 `if (origin !== selectedIdRef.current) return;` 因 `origin` 仍是 null 而提前返回，`setError` 不会执行；`settleOutgoing` 也只把内容存回 `"new"` 草稿键（`1195-1198`），而当前界面已按主对话读取草稿，输入框里看不到。用户会停在主对话，既没发出去也没有错误。
证据（亲自读到）:
```
1216              setMainThreadId(target.threadId);
1242          if (origin !== selectedIdRef.current) return;
1243          setMutationStatus("rejected");
1244          setError(caught instanceof Error ? caught.message : "CONTROL_CENTER_REQUEST_REJECTED");
```
```
365    useEffect(() => {
366      if (!mainThreadId || selectedThreadId || page || route.status) return;
367      navigate({ ...route, objectId: mainThreadId, ... });
```
“自动跳转一定先于失败完成”属于推测（取决于 effect 与请求的时序）；`1242` 的提前返回条件是代码证实。
建议: 发送开始时记下起始会话 `const startedOn = selectedIdRef.current`，只在用户明确切到另一个会话时才抑制错误；或把 `setMainThreadId` 延后到 `performIntent` 成功之后，成功再由该分支 `navigate`。加一个测试：`thread.main` 成功、随后的 `mutate` 失败，断言显示错误且草稿仍在输入框。

### 2. 低 — 初次 `thread.main` 查询失败仍然静默，侧栏没有“主对话”入口（上一轮意见 3 未修复）
文件: `apps/control-center/src/thread-control-center.tsx:351-364`、`apps/control-center/src/components/thread-sidebar.tsx:304-330`
问题: 初次查询 `thread.main` 的 catch 只处理 401，其它失败被完全吞掉；`mainThreadId` 保持 null，侧栏 `mainThreadId ? <AppLink 主对话> : null` 不渲染入口，也不显示错误或重试。若主对话还没有消息（`messageWatermark` 为 0），它也不会出现在普通列表里，用户没有任何可见入口。
证据（亲自读到）:
```
360      .catch((caught: unknown) => {
361        if ((caught as { readonly status?: unknown } | null)?.status === 401) onUnauthorized();
362      });
```
```
304        {mainThreadId ? (
305          <AppLink
...
328            {message("chat.main")}
329          </AppLink>
330        ) : null}
```
建议: 把失败写入可见错误状态并在侧栏提供“重试”，或固定渲染一个点击时重新查询/`ensure` 的“主对话”入口，查不到时显示原因。

### 3. 低 — 新单测只在 mock 上验证 `internal`，真实仓储经 `readCommittedMessagesByIds` 送 `internal` 的路径没有端到端断言
文件: `apps/agent-service/test/production-owner-intent.unit.test.ts:32-37` 对 `packages/persistence-sqlite/src/sqlite-thread-operations.ts:1794-1800, 964-967`
问题: 新测试把 `readCommittedMessagesByIds` 与 `listMessages` 都替换成内存数组。若以后 `MESSAGE_SELECT` 漏掉 `internal`，或 `messageFromRow` 不再映射 `internal`，单测仍通过，但生产里 `current.internal` 会是 `undefined`，上一轮的漏洞会悄悄回来。
证据（亲自读到）:
```
32      readCommittedMessagesByIds: async ({ messageIds }) =>
33        messages.filter(({ id }) => messageIds.includes(id)) as never,
```
```
1796          `${MESSAGE_SELECT} WHERE ... AND message_status = 'committed' AND id IN (...)`
...
1800      const byId = new Map(rows.map((row) => [row.id, this.messageFromRow(row)]));
```
建议: 像 `test/integration/main-thread.test.ts` 那样用真实 `SqliteThreadOperations` 断言 `readCommittedMessagesByIds` 对 internal 消息返回 `internal === true`，再补一个真实仓储下的主人意图集成用例。

**侧重检查**
- 不可信/隐藏输入：internal 消息不再能作为主人授权词。已 `production-owner-intent.ts:73-79` 拒绝 internal 触发；窗口读取用 `listMessages`（`internal=0`）排除此前 internal 消息；空词时 `owner-intent-gate.ts:123-129` 返回 `no_owner_words`，`owner-scope-authorization.ts:233-243` 因此不追加 `ownerIntentConfirmed`，动作升级为需要主人确认，方向安全。
- 错误路径：意见 1、2 都是错误路径上的静默/丢失问题，仍存在。
- 不可撤销操作：本轮增量没有改删除/迁移代码，未重查。
- 资源耗尽：增量为常数级过滤，没有循环或额外请求。
- 规则/文档一致性：增量不触碰主对话上下文前缀，不违反 prompt-prefix 规则。另注意到作者“问题与目标”写“iPhone 用 thread.main 找到主对话”，但 `docs/architecture-v0.1.md` 与 Swift 生成文件明确写着 iPhone 还没调用、只声明了能力；这是叙述与代码/文档不一致，属旧材料问题，非本次增量。

**必答问题**
1. 请求开头是否改变：不涉及本增量。主对话上下文仍由 `readContextSnapshot` 组装，未改过滤/排序（`sqlite-thread-operations.ts:1685-1700` 只按 `sequence` 取，未加 `internal=0`），internal 消息按序追加在历史里；增量只改主人意图检查用的一批词，不进入主模型前缀。没有发现每轮会变的值被放进请求开头。
2. 同一段文字是否会变成不同字节：不涉及。`collectOwnerWords` 的排序是确定的（`toReversed`/`unshift`），排除 internal 也是确定性的，没有时间字段或无序集合。
3. 是否有自动检查、反向是否失败：有 `[PR631-R2-1]` 单测；按旧代码（`listMessages` 已排除 internal，但缺少 `current.internal` 检查）会返回较早的主人消息而不是 `[]`，所以该反向用例会失败。但真实仓储的 `internal` 映射没有端到端断言（意见 3），Layer-0/`npm run check` 未核实。
4. 增量产生的值使用端能否接受：增量只改变 internal 触发时 `collectOwnerWords` 返回 `[]`。使用端 `OwnerIntentGate` 接受空数组并走 `no_owner_words`（`owner-intent-gate.ts:123-129`），最终不加 `ownerIntentConfirmed`，安全；`internal` 字段产出端（`messageFromRow`）与消费端（`production-owner-intent.ts`、`production-memory-capture.ts`）校验一致。除此之外本轮没有新增标识、配置键或序列化格式。
