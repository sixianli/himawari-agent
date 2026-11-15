## 查过范围

本轮只看了增量 `2e7b08e..dea9a33`，以及为核对它而必须跟下去的直接使用端：`apps/agent-service/src/mac-placement.ts`、`production-web-push.ts`（`#deliver`/`gate`/`#place`/`settled`/`clip`）、`production-apple-push.ts`（companion 的 `deliver`）、`service-main.ts` 的接线、`packages/platform-node/src/device-api-routes.ts`（`presence`/`settled`）、`device-notification-hub.ts`、`test/fixtures/device-api-harness.ts`、`test/integration/push-channels.test.ts`、`test/integration/device-notifications.test.ts`、`sqlite-web-push-operations.ts`/`sqlite-apple-push-operations.ts` 的 `enqueue`/`listDue`/`routeOutbox`/`prune`、`delivery-timing.ts`、ADR 0273 与设计文档新增行。没有整份重读与增量无关的旧代码。

## 上一轮意见核对

- 意见 1：只改好一半。`holds` 短路修掉了“第二轮重新判定/重复发给 iPhone”，但“不记账、留在待发表、继续占批次”仍在（见意见 1）。
- 意见 4：改对了（`slice(0,1)` + `recent` 按最近输入倒序），但新测试不能证明选对了 Mac（见意见 2）。
- 意见 2：未修复，只写进了 ADR 的“没做”（`docs/adr/0273-...md:149`）。作者说“有意”，与代码一致。
- 意见 3：改对了。`settled` 与 `withdrawExpired` 现在都以 `item.expiresAt` 为界（`production-web-push.ts:636`、`mac-placement.ts:66`）。
- 意见 5：改对了（Mac 判断提前到 `notifications` 之前），但没有回归测试（见意见 4）。
- 意见 8：设计文档补了两行，但本次新增的 Mac 标题/正文字节上限没登记（见意见 4）。
- 意见 9：加了 `clip`，但没测试（见意见 4）。

## 意见

### 1. 中高 — 放置到 Mac 的通知仍未记为已处理，会占满待发表批次并饿死后续通知
文件:行：`apps/agent-service/src/production-web-push.ts:541-545,564-580`、`packages/persistence-sqlite/src/sqlite-web-push-operations.ts:278-281,340-366`、`apps/agent-service/src/production-apple-push.ts:345-361`
类型：读代码证实。
问题：`holds` 只是让 gate 返回 true，随后 `continue`，没有任何 `#record`；该行仍留在 `web_push_outbox` 里。`listDue` 每轮按 `created_at` 升序取前 50 条，被放置项既不会被记成 sent/suppressed/expired，也永远排在最前面，于是每轮都占一个名额。同一通道累积到 50 条被放置项后，更新的通知根本不会进入本轮处理（Mac 和 iPhone 都收不到），直到旧项过期（提醒 6 小时、run 24 小时）。
证据：
```ts
// production-web-push.ts
543  if (this.#options.placement?.holds(webPushTopic(item.sourceKey))) return true;
564  const due = await store.listDue({ ownerId, agentId, now, limit: SEND_BATCH });
580  if (await gate(entry.item)) continue;
```
```sql
-- sqlite-web-push-operations.ts
279  ... ON CONFLICT (owner_id, agent_id, source_key) DO NOTHING
363  ORDER BY o.created_at, o.source_key, s.created_at, s.id
364  LIMIT ?
```
```ts
// production-apple-push.ts
345  const due = await store.listDue({ ...this.#scope(), now, limit: SEND_BATCH });
361  if (await input.deferred(item)) continue;
```
`routeOutbox` 把无 attempt 的行路由到 `apns` 或 `web_push`（`sqlite-apple-push-operations.ts:307-317`）；被放置项没有任何 attempt，所以一定进入其中一个通道并持续占用该通道的 50 条窗口。上一轮“会一直留在待发表里”这一半并未改好。
建议：给放置成功写一条持久状态（或 `placed_at`/`held_by` 字段），让对应通道的 `listDue` 排除它，同时保留内存 placement map 负责 withdraw；内容过期撤回可改为每轮遍历被持有的 `sourceKey` 复用 `contentOf` 检查。补一个“先放置 50+ 条、再来一条新提醒仍能送达”的用例。

### 2. 中 — “选最近有输入的那台 Mac”的新测试没有验证收件设备，选错也会通过
文件:行：`test/integration/push-channels.test.ts:1494-1508,1583-1597`
类型：读代码证实。
问题：两个 Mac 的帧都推进同一个 `frames` 数组，测试只断言总数为 1。若实现改成选 `dev_old`（甚至选错但只发一台），测试照样通过；旧的那条 `recent` 单元测试只覆盖排序，覆盖不到 `place()` 的 `slice(0,1)`。
证据：
```ts
1494  const frames: DeviceNotificationFrame[] = [];
1504    while (true) frames.push(await listening.next());
...
1596  expect(mac.frames).toHaveLength(1);
```
建议：按设备分开记录（`Map<deviceId, frames>`），断言 `dev_new` 收到 `notification.deliver`、`dev_old` 为空；并做一次“把 `slice(0,1)` 改成 `slice(-1)` 必须失败”的反向验证。

### 3. 低 — `/presence` 未接线时非 Mac 已返回 404，但没有回归用例
文件:行：`packages/platform-node/src/device-api-routes.ts:870-875`、`test/fixtures/device-api-harness.ts:631-638`、`test/integration/device-notifications.test.ts:62-72`
类型：读代码证实。
问题：改动本身正确（先判 Mac 再看 `notifications`），但测试 harness 无条件接上 `notifications`，现有 REVERSE 用例在改前改后都会通过，无法防止这里回退。
证据：
```ts
872  if (authenticated.device.kind !== "mac") options.rejectNotAllowed();
873  const notifications = options.notifications;
874  if (!notifications)
875    return options.sendJson(reply, 200, { ok: false, reason: "unavailable" });
```
```ts
631  notifications: { hub: notifications.hub, presence: notifications.presence, ...
```
建议：给 harness 加 `withoutNotifications` 选项；用例覆盖“未接线时 iPhone 得 404、Mac 得 200 `{ok:false}`”。

### 4. 低 — Mac 标题/正文上限没有测试，也没登记进设计文档的新值清单
文件:行：`apps/agent-service/src/production-web-push.ts:42-43,610-611`、`docs/execution/specs/2026-11-11-apple-device-body-design.md:766`
类型：读代码证实（Mac 客户端如何处理截断：未核实，仓库里没有客户端代码）。
问题：`clip` 是按 UTF-8 字节截断并补 `…`，逻辑本身没问题，但上一轮意见 9 的修复没有任何自动检查；同时新增的 256/2048 两个跨端约定没有进“新值清单”，而意见 8 正是要求登记本次新增值。
证据：
```ts
42  const MAC_TITLE_BYTES = 256;
43  const MAC_BODY_BYTES = 2_048;
610  title: clip(built.title, MAC_TITLE_BYTES),
611  body: clip(built.body, MAC_BODY_BYTES),
```
建议：加一个含多字节字符的超长标题/正文用例，断言字节数不超限且为合法 UTF-8；在设计文档该行补上“Mac 标题 ≤256 字节、正文 ≤2048 字节，超出以 `…` 截断”。

### 5. 低 — 重启后的重复响与收不到撤回仅文档化，未修复（作者说法属实）
文件:行：`docs/adr/0273-...-busy.md:149`、`apps/agent-service/src/service-main.ts:733-739`、`apps/agent-service/src/mac-placement.ts:25-28`
类型：读代码证实。
问题：placement 只在进程内存；重启后已放置未过期的通知会重新走 iPhone，Mac 上那条也收不到 `notification.withdraw`。ADR 已明确写成故意的取舍，因此不算与新说法不符，但上一轮意见 2 本身确实没有代码修复。
建议：若接受就保持现状；若以后要消除重复响，需要把 `{id, devices, expiresAt}` 持久化。

### 6. 低（推测）— `withdrawExpired` 与主循环用了两个时刻，到期边界可能多响一次
文件:行：`apps/agent-service/src/production-web-push.ts:360,541,567-580`、`apps/agent-service/src/service-main.ts:738`
类型：推测（时序窗口很窄）。
问题：`#run` 在行 360 取一次 `now`，中间做多轮异步查询后，`withdrawExpired` 用的是 `Date.parse(productionClock().now())` 的实时时钟。若某条的 `expiresAt` 正好落在两个时刻之间：`withdrawExpired` 先发 withdraw 并删除 placement，随后主循环用较早的 `now` 判断“还没过期”，内容仍有效，`holds` 变 false，于是又 `place` 发一次 deliver，下一轮再 withdraw。
证据：
```ts
360  const now = this.#options.now();
541  this.#options.placement?.withdrawExpired();
567  if (Date.parse(now) >= Date.parse(item.expiresAt)) { ...
```
```ts
738  nowMilliseconds: () => Date.parse(productionClock().now()),
```
建议：把 `withdrawExpired` 改成接收当前 tick 的毫秒值（`withdrawExpired(Date.parse(now))`），两处用同一个时刻。

### 7. 低 — `REMEMBER_LIMIT` 淘汰放置项时不发撤回，且可能被重复 deliver（旧代码，非本轮引入）
文件:行：`apps/agent-service/src/mac-placement.ts:39,49-52,56-62`
类型：读代码证实。
问题：超过 500 条时直接 `delete` 最旧项，不发送 `notification.withdraw`；该 `sourceKey` 若还在 outbox 且未过期，下一轮 `holds` 为 false，会重新 `notification.deliver`，造成 Mac 上重复/永不撤回。
证据：
```ts
49  if (this.#placed.size > REMEMBER_LIMIT) {
50    const oldest = this.#placed.keys().next().value;
51    if (oldest !== undefined) this.#placed.delete(oldest);
```
建议：淘汰时先 `withdraw(id)`，或改为按 `expiresAt` 清理而不是按插入顺序淘汰。

## 侧重检查

- 错误路径/不可信输入：`/presence` 先验证签名与设备，再拒非 Mac、拒额外字段、只用毫秒 ISO、把未来时间夹到服务器当前时间且 `record` 只接受更大的值；`/notifications/settled` 限制 200 个、逐项匹配 `^[A-Za-z0-9_-]{1,64}$`。结论：增量这两处没有放宽输入面。`settled` 不限制设备种类（任意已配对设备可调），只返回本 owner/agent 的 id，属旧行为，低风险。
- 安全：通知 id 是 `sha256` 后 24 字节 base64url（32 字符），不含用户可控文本；SSE 帧经 `JSON.stringify`，标题/正文里的换行会被转义，不存在注入 `id:` 行或伪事件。`notificationId` 放在 APNs 载荷顶层，不污染 `aps`。
- 资源耗尽：主要问题就是意见 1 的队头阻塞；另有无上限的 `DevicePresence` 设备数（受配对设备数约束）、500 条 placement 淘汰（意见 7）、hub 队列 200 丢最旧、`settled` 只查最近 500 条。`withdrawExpired` 每轮最多遍历 500 条，可接受。
- 不可撤销操作：本增量没有删除、撤销或外部副作用型操作；撤回只是尽力而为的 SSE 帧。
- 规则/文档与代码一致：ADR 142-149、设计文档 766 与代码大体一致。不一致两点：作者材料说“撤回只在 `contentOf` 发现 `content.expired` 时触发”，实际还新增了按 `item.expiresAt` 的 `withdrawExpired`；新值清单没有登记 Mac 标题/正文字节上限。
- 提示词前缀：本增量未触碰系统提示、工具定义、历史消息或遮盖逻辑，相关检查不适用。

## 必答问题

1. **不改变模型已经见过的请求开头。** 增量只改了推送/SSE/文档；`notificationId`、`notification.deliver/withdraw`、`macPresenceSeconds`、Mac 文本都只出现在设备推送或 SSE 里，不进入模型上下文。没有新的“每轮会变的值”被放进消息；因此“只在末尾追加”的约束不受影响。
2. **不会让同一段文字在模型请求里变成不同字节。** 本增量不涉及模型请求。推送侧：id 是确定性哈希；`DevicePresence.recent` 从依赖 Map 插入顺序改为显式按最近输入排序，反而更确定；截断对给定文本与语言是确定性的；`#formatTime` 只影响通知正文，不影响提示词。
3. **自动检查只覆盖了一部分。** 真正会失败的反向用例：两 Mac 用例能抓住“发给所有 Mac”（帧数变 2）；到期撤回用例能抓住“到期不撤回”（实际走的是 `withdrawExpired`，因为 `REMINDER_WINDOW_MS` 为 6 小时而测试推进 7 小时，且提醒仍为 scheduled）；`recent` 单元测试能抓住排序回退。抓不住的：意见 1 的重新判定/批次占用没有用例；两 Mac 用例抓不住“发给较旧的那台”（意见 2）；未接线 `/presence` 没有用例（意见 3）；Mac 文本截断没有用例（意见 4）；`settled` 与到期撤回的一致性没有对应用例。
4. **改动产生/修改的值的两端都核对过。** `place(..., expiresAtMilliseconds)`：产生端 `Date.parse(item.expiresAt)`，store 的 `assertItem` 用 `valid()` 保证是规范 ISO，唯一实现 `MacPlacement` 存下来并在 `withdrawExpired` 比较，两端一致。`holds`/`withdrawExpired`：只有 `MacPlacement` 实现，唯一消费者是 `ProductionWebPush` 的 gate 与 `#deliver`，一致。通知 id：`webPushTopic` 产出的 32 字符 base64url 能通过 `NOTIFICATION_ID`（`^[A-Za-z0-9_-]{1,64}$`），APNs 顶层 `notificationId` 有测试断言，`settled` 只回请求里的 id；I-73 所说的“清单里的 id 能否过后端校验”这一条已核对通。`macPresenceSeconds`：在 `DELIVERY_TIMING_DEFAULTS/RANGES/KEYS` 中齐全，设置读写按 key 泛化、范围 30–3600，`service-main.ts:736-737` 在调用时读 `DeliveryTimingHolder.current()`，能热更新，一致。`recent()` 排序：消费者只有 `MacPlacement` 和两个测试，均接受“最新在前”。唯一“未核实”的是 Mac 客户端是否接受 256/2048 的截断与 `…`（客户端不在本仓库）；另外新常量未进设计文档清单（意见 4）。
