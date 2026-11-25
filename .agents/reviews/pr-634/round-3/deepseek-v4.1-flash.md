这一轮只查看了 `af47ef8..d38fb34d` 的增量（7 个文件），并沿着增量碰到的新值查了直接使用端。`round-1/round-2` 的判断记录被 git 拒绝读出（`REVIEW_GIT_REFUSED records-path`），所以“上一轮意见”改用 `af47ef8` 的提交说明核对：它列的第 2 轮三条低严重度文档意见，在 `docs/execution/specs/2026-11-11-apple-device-body-design.md:909,929,1095` 都已落实。作者这次列的其余说法也逐条抽查过，除下面意见外未发现与代码不符（`MAC_PRESENCE_WINDOW_SECONDS = 300`、`delivery_timing` 决策种类保留、`deliveryTiming` 退役键、`DemoScenes.swift` 去留均与说法一致）。

### 1. 中 · `thread.main` 不返回时首开永远停在骨架屏，输入框不会回来
文件: `apps/control-center/src/thread-control-center.tsx:352-374, 1822-1825`
问题: 本轮把“主对话查到之前的输入框”改成不渲染；但主对话查询只跟随卸载/依赖变化中止，没有超时。请求既不 resolve 也不 reject 时 `finally` 永远不执行，`mainLookupSettled` 永远为 `false`，`openingMain` 永远为真，首开既没有输入框也没有错误提示。查询被拒（reject）时确实会回到输入框，作者说的回退只在“失败”路径成立，覆盖不到“挂住”路径。
证据:
```ts
354:    const controller = new AbortController();
355:    client
356:      .queryThread(threadQueryMessage(configuration, "thread.main", {}), controller.signal)
...
364:      .finally(() => {
365:        if (!controller.signal.aborted) setMainLookupSettled(true);
366:      });
...
369:  const openingMain =
370:    !selectedThreadId &&
371:    !page &&
372:    !route.status &&
373:    Boolean(client && configuration) &&
374:    (!mainLookupSettled || mainThreadId !== null);
...
1822:          {openingMain ? null : (
1823:            <ChatComposer
```
旁边的主列表刷新有 `READ_DEADLINE_MILLISECONDS = 15_000` 的超时（`:566-569`），这条新查询没有同样的保护。
建议: 给这次 `thread.main` 查询加 deadline（超时即视为 settled 并回退到可输入的 composer，或至少显示可重试的失败态）；补一条“promise 一直不 settle”的测试。

### 2. 低 · `/settings` 下的会话骨架屏与写法不一致，设置页会被当成“没有页面”
文件: `apps/control-center/src/thread-control-center.tsx:254, 369-374, 376, 1754`
问题: `page` 明确把 `settings` 映射成 `null`，而 `openingMain` 用的是 `!page`；重定向守卫用的却是 `!route.page`。因此直接打开 `/settings`、尚未选会话时，主对话查询成功后 `openingMain` 仍为真，设置弹窗后面的会话区域一直显示骨架屏，直到关闭设置、`route.page` 变空才重定向。弹窗是模态的，所以用户通常看不到，但这与“其他页面不会卡在骨架屏”不完全一致，也让 `openingMain` 和重定向条件对“设置页”给出两种判断。
证据:
```ts
254:  const page: WorkPage = route.page === "settings" ? null : route.page;
...
370:    !selectedThreadId &&
371:    !page &&
372:    !route.status &&
...
376:    if (!mainThreadId || selectedThreadId || route.page || route.status) return;
...
1754:          {openingMain || (!detail && selectedThreadId && !shownOutgoing) ? (
1755:            <ThreadLoadingSkeleton scope="conversation" />
```
建议: 把 `openingMain` 也改成以 `!route.page` 为条件（或单独抽一个“是否在设置页”的判断），并让两处使用同一个条件。

### 3. 低 · 设置页“不自动跳主对话”的新守卫没有自动检查，去掉它不会有测试失败
文件: `apps/control-center/src/thread-control-center.tsx:375-384`；测试目录 `apps/control-center/test/`
问题: 本轮新增的 `route.page` 守卫是本轮两条产品行为之一，但我在 `apps/control-center/test` 里检索 `openingMain`、`mainLookupSettled`、`route.page`、`settings`，没有找到覆盖“设置页打开时不跳主对话”的用例；浏览器脚本只覆盖首次打开和发送，不打开设置页。`skip`、`openingMain` 的挂起路径也没有用例。去掉 `route.page` 守卫，现有测试仍会通过。
证据:
```ts
375:  useEffect(() => {
376:    if (!mainThreadId || selectedThreadId || route.page || route.status) return;
377:    navigate({
...
384:  }, [mainThreadId, selectedThreadId, route, navigate]);
```
现有回归只在 `apps/control-center/test/thread-interactions.unit.test.ts:1948-1964`（主对话查询失败后保留草稿）和 `:2444-2463`（首次失败、发送时再查成功），都没有设置页场景。
建议: 在 `thread-interactions.unit.test.ts` 增加：`route.page = "settings"` 且主对话查询成功时不调用 `navigate` 到主对话；把 `route.page` 换成 null 后才跳。再增加一条主对话查询永不 settle 的用例。这样把 `route.page` 守卫删掉时测试必须失败。

### 4. 低 · 假服务器 `thread.main` 返回 `thread-home`，`snapshotRef` 却写成 `thread-main`
文件: `test/e2e/fixtures/control-center-browser-server.mjs:2112-2123`
问题: 同一个响应里 `payload.thread.threadId` 是 `thread-home`，`snapshotRef` 是 `snapshot:thread-main:${main.revision}`。我在 control-center 源码里没找到把 `snapshotRef` 当身份键用的地方（未核实其他客户端），所以现在没有直接故障；但这是一个不一致的值，未来若有人用 `snapshotRef` 做缓存键/断言，会和真正的 `thread-main` 混淆。
证据:
```js
2112:  if (message.type === "thread.main") {
2113:    const main = threads.get("thread-home");
...
2116:      ...common,
2117:      type: "thread.main_snapshot",
2118:      payload: {
2119:        thread: threadSummary(main),
2120:        snapshotRef: `snapshot:thread-main:${main.revision}`,
```
建议: 改成 `snapshot:thread-main:${main.threadId}:${main.revision}`（或直接用 messageId），让 ref 里的身份与返回的 thread 一致。

### 5. 低（推测，未运行）· 共享假服务器新增 `thread-home` 后，其他打开 `/threads` 的浏览器脚本初始状态会改变
文件: `test/e2e/fixtures/control-center-browser-server.mjs:47-67, 2088-2091, 2112`；使用端如 `scripts/test-thread-loading-browser.mjs:74,184`、`scripts/check-layout-audit.mjs:298`、`scripts/test-control-center-visual-v4.mjs:184`
问题: 这个 fixture 被很多浏览器脚本复用。以前 `thread.main` 返回 404，访问 `/threads` 的脚本会停在无选中对话的状态；现在会立刻重定向到 `/threads/thread-home`，并且 `thread.list` 仍会把 `thread-home` 放进列表（过滤只发生在 `thread-sidebar.tsx:134-141`，依赖异步拿到的 `mainThreadId`）。我这次不能运行浏览器，无法确认这些脚本是否仍通过；按断言看多数只关心欢迎页/列表，风险不高，但属于增量值的未复核使用端。
建议: 要么在 fixture 里明确把主对话排除于 `thread.list`/搜索（与真实产品一致），要么在提交说明里列出并跑一遍所有复用该 fixture 的浏览器脚本（`test-thread-loading-browser`、`check-layout-audit`、`test-control-center-visual-v4` 等）。

## 侧重检查
- 错误路径：主对话查询 `reject` 时 `finally` 会置 settled，`mainThreadId` 为 null，`openingMain` 变假，composer 回来（`thread-control-center.tsx:361-366,369-374,1822`），结论成立；401 会 `onUnauthorized`，且被 abort 时不再置 settled。主对话查询“永不 settle”没有超时，见意见 1。`thread.main` 在 fixture 中找不到主对话时返回 null → 404，客户端会走 catch/finally 并回退 composer（`control-center-browser-server.mjs:2112-2114,2843-2846`）。
- 不合规范/不可信输入：新增 `/__fixture/finish-runs` 只把 `message.threadId` 当 `Map` 键，未知 id 返回 404，未做额外类型校验；这是测试假服务器，未发现进入生产路径（`control-center-browser-server.mjs:2752-2767`）。`thread.main` 查询请求体为空，不读用户输入。
- 安全/资源耗尽：`thread.main` 在每次挂载/`client`/`configuration` 变化时各发一次，卸载或依赖变化会 abort；没有累积定时器。`finish-runs` 只遍历 fixture 内的 runs，测试结束后调用。未发现不可撤销操作被新增（只改测试假数据）。
- 规则/文档一致性：`docs/execution/specs/2026-11-11-apple-device-body-design.md:965,1095` 与 `mac-placement.ts:8`、`test/tooling/mac-presence-window.test.ts` 一致；`decision_ledger` 的 `delivery_timing` 种类和结果仍保留（`packages/application/src/ports/decision-ledger.ts:43,77`），文档 `:929` 说只读/导出旧记录；`runPolicy.deliveryTiming` 在 `strict-configuration.ts:1774,1881-1888` 被接受并记为 `retiredKeys`，`service-main.ts:907-910` 写 `configuration.key_retired`。ADR 0273 仍保留历史原文，但已被 ADR 0285 取代，设计文档和 plan 已改写，未把它当成必须改的现役说明。
- 本轮额外检查了 `openingMain`/`mainLookupSettled` 的所有使用点、`thread-home`/`thread.main` 的 fixture 与脚本使用点、`计划讨论` 改名的影响、`/__fixture/finish-runs` 的唯一调用方、`.thread-attention`/`.thread-running` 样式与 `review.needsAttention`/`chat.environment.threadRunning` 三语文案；未运行任何测试或浏览器。

## 必答问题
1. **会不会改变模型已经见过的请求开头？** 本轮增量不涉及。`git diff --name-only af47ef8..d38fb34d` 只有 control-center 前端、单元测试、浏览器脚本和假服务器；没有改系统提示、工具定义、历史消息、遮盖或请求序列化。发给模型的内容仍然只在末尾追加，新增的 `mainLookupSettled`/`openingMain` 只改变浏览器渲染。全 PR 里删除的 `push.delivery-timing-question` 属于已不再调用的送达时机辅助问句，不是对话请求头；我没有逐行读 prompt 组装器，但这轮没有它的改动。
2. **同一段文字会不会在不同请求里变成不同字节？** 本轮不涉及。增量没有引入带时间的模型输入、依赖前后文的遮盖或无序集合；唯一新增的时间值是假服务器 `finish-runs` 的 `new Date().toISOString()`（`control-center-browser-server.mjs:2763`），只写测试假数据。
3. **有没有对应的自动检查，反向用例真的会失败吗？** 有覆盖也有缺口。主对话入口标记的新单元测试 `apps/control-center/test/thread-sidebar.unit.test.ts:103-125` 会因删除侧栏标记而失败；首次打开用例 `scripts/test-control-center-v4.mjs:75-92` 会因假服务器不认 `thread.main` 或仍发 `thread.create` 而失败；现有的 `qualifyStartupFocusKept`（同文件 `:151-180`）用 MutationObserver 聚焦 composer，若 composer 在主对话返回后被换掉会丢焦点并失败，这是“输入框不被换掉”的反向检查。缺口是：设置页 `route.page` 守卫、主对话查询挂起/超时都没有测试（见意见 1、3）；作者也说明本地只跑了 chromium，firefox/webkit 依赖 CI。
4. **每个新值的两端都能接受吗？** 逐项核对：`thread-home` 在假服务器主对话查询、脚本 URL/断言、`finish-runs` 三处一致；`计划讨论` 改名后唯一受影响的 `qualify-control-center-browser.mjs:506` 已同步，其他脚本没有按“主对话”找 `thread-main` 的地方；`/__fixture/finish-runs` 唯一调用方 `test-control-center-v4.mjs:127,272` 只检查 HTTP 200，响应体结构不影响它；两个 CSS 类和两条三语文案都存在。发现两处需要收尾：`thread.main` 的 `snapshotRef` 写错身份（意见 4），共享 fixture 新增 `thread-home` 会让其他 `/threads` 首开脚本走新路径（意见 5，未运行验证）。`deliveryTiming` 退役键和 `delivery_timing` 决策种类这类全 PR 的值，产生端和使用端均在代码里对上了。

**这一轮查过的范围**：`af47ef8..d38fb34d` 的 7 个文件全部 diff；`thread-control-center.tsx` 的 `mainLookupSettled`/`openingMain`/重定向/composer 渲染上下文；`thread-sidebar` 标记及 CSS/文案；`test-control-center-v4.mjs` 与 `qualify-control-center-browser.mjs` 的调用点；共享 fixture 的 `thread.home`/`thread.main`/`finish-runs` 及引用该 fixture 的脚本清单；`mac-placement.ts`、`strict-configuration.ts`、`service-main.ts`、`decision-ledger.ts`、`DemoScenes.swift`、`push-channels.test.ts` 的相关行（用于核对作者说法）。未运行任何测试/浏览器，未改动文件。
