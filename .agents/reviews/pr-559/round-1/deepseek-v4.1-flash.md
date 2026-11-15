### 1. 高 — 已放置到 Mac 的通知没有记为已处理，会一直留在待发表里

**文件:行**：`apps/agent-service/src/production-web-push.ts:539-542`、`apps/agent-service/src/production-web-push.ts:571-580`、`apps/agent-service/src/production-apple-push.ts:361`、`apps/agent-service/src/production-web-push.ts:529`

**问题**：`gate` 在 Mac 放置成功后返回 `true`，但两个调用方都直接 `continue`，既没有 `#record`，也没有 `deferItem`。`gated` 缓存又只活在这一轮 `#deliver` 里。结果是这条 outbox 记录永远保持“可发送”状态，下一轮仍会被 `listDue` 取出。

**证据（读代码证实）**：
```ts
// production-web-push.ts:539
const gate = async (item: WebPushOutboxItem): Promise<boolean> => {
  if (await this.#deferred(item, now, gated, decisions)) return true;
  return !visible && (await this.#place(item, contentOf, accountLocale));
};
// production-web-push.ts:576
if (await gate(entry.item)) continue;
// production-apple-push.ts:361
if (await input.deferred(item)) continue;
```
`gated` 在 `#deliver` 内新建（`production-web-push.ts:529`），不跨轮保存。后果都可从代码推出：
- 每轮都会重新 `contentOf` 读库；在启用送达时机且判断有结论时，`#timed` 每轮都会走到 `recordDeliveryTiming({ outcome: "delivered" })`（`production-web-push.ts:736-747`），实际每轮重复写决策记录，并按 `recheckSeconds` 反复调用判断模型。
- `listDue` 的 `LIMIT` 是 50（`production-web-push.ts:42`、`sqlite-web-push-operations.ts:363-364`，Apple 侧 `sqlite-apple-push-operations.ts:366`），旧放置项会持续占用批次名额，量大时会把新通知挤到 48 小时生命期结束。
- 服务重启后 `#placed` 清空，这些从未落过 `web-push` 尝试状态的通知会被重新当作未发送，再次发给 iPhone 或 Mac，重新制造“一处以上响”。
- `#placed` 上限 500（`mac-placement.ts:7,39-42`），超过后旧 id 被淘汰；那条记录仍在 `listDue` 里，于是会被再次当作新通知放置，形成重复投递。

**建议**：放置成功后必须持久化“已处理”，例如按每个目标写一条带明确代码的 `recordAttempt`，或增加独立的放置状态；不要只靠进程内 `#placed`。同时把 withdraw/settled 改成独立扫描近期 outbox，否则一旦记录为已处理，现有 `contentOf` 路径就不会再被调用（见第 3 条）。

### 2. 中 — 放置和撤回状态只在进程内，重启后既会重复发，也永远发不出针对旧通知的 withdraw

**文件:行**：`apps/agent-service/src/mac-placement.ts:23,38,46-52`、`apps/agent-service/src/service-main.ts:731-739`

**问题**：`#placed` 是纯内存 `Map`，`withdraw` 只查这个 Map。服务重启后 Map 和 presence 一起清空：之前已经发给 Mac 的通知仍在 outbox 里，会因为第 1 条的问题重新投递；而以后即使对应提醒被完成，`withdraw` 也找不到当初的收件设备，Mac 上那条通知永远收不到撤回。

**证据（读代码证实）**：
```ts
// mac-placement.ts:23
readonly #placed = new Map<string, readonly string[]>();
// mac-placement.ts:46
withdraw(id: string): void {
  const devices = this.#placed.get(id);
  if (!devices) return;
  this.#placed.delete(id);
  this.#options.hub.send(deviceId, { event: "notification.withdraw", data: { id } });
}
```
ADR 只写明“Mac 在场信号重启后清空”，没有覆盖“已放置但未落库”的通知和已丢失的 withdraw 目标（`docs/adr/0273-...md:148`）。

**建议**：把“哪台 Mac 收过哪个通知”持久化（可与第 1 条的放置状态合并），或在通知 outbox 上记录接收设备；撤回时从持久状态查询。若坚持只放内存，至少要在启动时让这些旧 outbox 记录不可再投递，避免重复响。

### 3. 中 — `settled` 把“推送窗口到期”当成“已办结”，`withdraw` 又只在内容过期时发，两端语义不一致

**文件:行**：`apps/agent-service/src/production-web-push.ts:628-631`、`apps/agent-service/src/production-web-push.ts:563-565`、`apps/agent-service/src/production-web-push.ts:536`、`docs/adr/0273-a-decision-model-holds-push-notifications-while-the-owner-is-busy.md:145-146`

**问题**：`settled` 只要 `now >= item.expiresAt` 就返回该 id，但 `#content` 本身认为未完成、仍然有效的提醒/任务结果/建议并不一定 expired。比如提醒的 `expiresAt = remindAt + 6h`，超过 6 小时后即使 `reminder.status` 仍是 `scheduled`，iPhone 也会被告知“已办结”并撤掉通知。反过来，正常一轮 `#deliver` 遇到 `expiresAt` 到期的记录时直接记 `expired` 并 `continue`，根本没有调用 `contentOf`，所以 Mac 收不到 withdraw，旧通知会一直留着。ADR 写的是“提醒被划掉或完成、审批已处理”才撤回、只返回确认已办结的 id。

**证据（读代码证实）**：
```ts
// production-web-push.ts:628
const expired =
  Date.parse(now) >= Date.parse(item.expiresAt) ||
  (await this.#content(item, approvals, now)).expired;
if (expired) settled.push(id);
// production-web-push.ts:563
if (Date.parse(now) >= Date.parse(item.expiresAt)) {
  await this.#record(entry, now, "expired", null);
  continue;
}
```
`withdraw` 只在 `contentOf` 里触发（`production-web-push.ts:536`），而上面这条时间到期分支不会调用 `contentOf`。

**建议**：`settled` 只依据底层事项的真实状态（`#content`/显式状态）判断是否办结，不要把“推送窗口结束”等同于“办结”；时间到期若要撤回，应在到期分支也发 withdraw，或明确由客户端按 TTL 自行清理，并把文档改成一致的说法。补反向用例：提醒未完成但超过 6 小时、任务结果超过 24 小时。

### 4. 中 — 有多台 Mac 同时在场时会把同一条通知发给所有 Mac，违背“只发给这台 Mac”

**文件:行**：`apps/agent-service/src/mac-placement.ts:32-37`、`docs/adr/0273-a-decision-model-holds-push-notifications-while-the-owner-is-busy.md:142`

**问题**：`presence.recent()` 返回所有窗口内有输入的设备，再过滤所有有事件流的设备，然后逐个 `hub.send`。只要两台 Mac 都满足条件，两台都会响；ADR 和目标写的是“只发给这台 Mac”。

**证据（读代码证实）**：
```ts
const devices = presence
  .recent(this.#options.nowMilliseconds(), this.#options.windowMilliseconds())
  .filter((deviceId) => hub.connected(deviceId));
if (devices.length === 0) return false;
for (const deviceId of devices)
  hub.send(deviceId, { event: "notification.deliver", data: notification });
```
**建议**：明确选择一台（如 `lastInputAt` 最新的一台），或在 ADR 里明确“所有满足条件的 Mac 都响”。同时补一条两台 Mac 的反向测试。

### 5. 低 — `notifications` 未接线时，非 Mac 调 `/presence` 会得到 200，而不是文档说的 404

**文件:行**：`packages/platform-node/src/device-api-routes.ts:872-875`

**问题**：代码先判断 `notifications` 是否存在，再判断设备种类。未接线时任何设备都会得到 `200 {ok:false}`，与“只有 Mac 能调，其他设备得到 404”不一致。生产 `service-main` 目前总是接线，所以影响主要是其他组合方式和文档一致性，但校验顺序仍应修正。

**证据（读代码证实）**：
```ts
const notifications = options.notifications;
if (!notifications)
  return options.sendJson(reply, 200, { ok: false, reason: "unavailable" });
if (authenticated.device.kind !== "mac") options.rejectNotAllowed();
```
**建议**：先做 `kind !== "mac"` 的 404 检查，再处理未接线；或把文档改成实际行为。

### 6. 低 — `DevicePresence.forget` 从未在撤销/解绑路径调用，设备在场记录会一直留在内存

**文件:行**：`packages/platform-node/src/device-notification-hub.ts:105-117`

**问题**：`forget` 只有单元测试调用，生产没有调用点。已撤销/解绑的 Mac 的 `lastInput` 记录不会被清理，`recent()` 也只会过滤、不删除过期项。单租户下设备数量有限，影响不大，但属于长期驻留状态。

**证据（读代码证实）**：`grep` 只找到单元测试中的 `presence.forget("a")`；`DevicePresence.recent()` 只 `filter`，不清理旧条目。
**建议**：在设备撤销/解绑路径调用 `forget`，或让 `recent()` 顺便删除已过期条目。

### 7. 低 — `settled` 没有错误处理，一次存储或审批读取失败会让对账接口 500

**文件:行**：`apps/agent-service/src/production-web-push.ts:616-633`

**问题**：`store.listRecent`、`listApprovals`、`#content` 任一抛错都会直接冒泡到设备路由，iPhone 的定期对账变成 500；而其它推送路径大多用 `onFailure` 兜底。对账失败本身不会丢数据，但会让客户端持续重试。

**证据（读代码证实）**：`settled` 方法没有任何 `try/catch`，直接 `await store.listRecent(...)`、`await this.#options.listApprovals()`。
**建议**：捕获异常并返回 `[]`（或明确的错误码），同时记录诊断；不要让对账接口因瞬时读失败 500。

### 8. 低 — 设计文档的“新值清单”没有登记本次新增的值

**文件:行**：`docs/execution/specs/2026-11-11-apple-device-body-design.md:712-716`、`docs/adr/0273-a-decision-model-holds-push-notifications-while-the-owner-is-busy.md:142-146`

**问题**：该节明确要求“每个新出现的值都写明谁产生、谁使用、两端怎样校验、哪道检查守着（I-73）”，但新增的 `notificationId`、`lastInputAt`、`serverTime`、`macPresenceSeconds`、`notification.deliver/withdraw`、`settledIds` 没有补进表里；ADR 已写，spec 未写，文档之间不一致。

**证据（读代码证实）**：spec 第 716 行的表格仍只有原有项；`grep macPresenceSeconds` 只命中 ADR、代码和测试，未命中该 spec。
**建议**：按 I-73 的格式补齐产生处、使用处、两端校验和自动检查；尤其把 `notificationId` 的产生处（`webPushTopic`）和使用处（`NOTIFICATION_ID`、APNs 顶层字段、`settled`）写清楚。

### 9. 低 — Mac 的 `notification.deliver` 没有像 Web Push / APNs 那样限制正文大小（推测）

**文件:行**：`apps/agent-service/src/production-web-push.ts:601-608`、`apps/agent-service/src/production-web-push.ts:41`、`apps/agent-service/src/production-apple-push.ts:32,126-135`

**问题（推测，未核实正文上限）**：Web Push 用 `MAX_PAYLOAD_BYTES = 3_072` 裁剪，APNs 用 4_096 裁剪，而 Mac 事件直接把 `built.title`/`built.body` 放进 hub 队列，单帧没有裁剪。若记忆/邮件正文可以很大，`DeviceNotificationHub` 的 200 条队列可能占大量内存。需要确认上游正文长度上限后才能定性。

**建议**：给 Mac 事件加与推送通道类似的大小上限，或确认正文在写入时就已受限。

---

**侧重检查**

- **错误路径/不合规范输入**：`/presence` 校验了额外字段、字符串类型、严格毫秒 ISO、`Date.parse` 有限性，并把时间夹到服务器当前时间以内；只有“夹上界”没有“夹下界”，但旧时间只会导致不满足在场窗口，不会误判。`/notifications/settled` 校验了额外字段、数组、最多 200、每项字符串和 `[A-Za-z0-9_-]{1,64}`，空数组返回空。上述两项基本合格。发现的问题是第 5 条（校验顺序）和第 7 条（无异常兜底）。
- **安全/授权**：`/presence` 和 `/notifications/settled` 都在签名认证之后，presence 还要求 `kind === "mac"`；没有发现跨设备写入或跨租户读取。`settled` 对任何已配对设备开放，不只是 iPhone，但同一 owner/agent 内只泄露“某个哈希 id 是否已过期”，风险低。
- **资源耗尽**：发现第 1 条会持续重复读库、重复写 `delivery_timing`、占用 `listDue` 批次；`SETTLED_LOOKUP_LIMIT = 500` 与 `limit` 上限 500 一致；hub 每设备队列上限 200，满了丢最旧帧（可能丢 withdraw，属于设计取舍）；第 9 条为未核实的正文大小风险。
- **不可撤销操作**：撤回本身是内存操作，重启后无法对旧通知撤回；见第 2 条。第 1 条的重复投递也会造成用户已经看过/划掉的通知再次响起。
- **规则/文档一致**：ADR 更新了第 12 项和接口说明；未同步的是 spec 的“新值清单”（第 8 条），以及 ADR “其他设备 404”与未接线时的 200 行为不一致（第 5 条）。

---

**必答 1：会不会改变模型已经见过的请求开头？**

不会。本次 diff 只涉及推送、设备 SSE、设备 API、送达时机配置和测试，没有改提示词目录、系统提示、工具定义、历史消息或出口遮盖。Mac 的 `notification.deliver/withdraw` 走设备事件流，`/presence`、`/notifications/settled` 是设备 HTTP 接口，都不进入模型请求。新增的每轮变化值（`serverTime`、`lastInputAt`）只出现在设备接口响应/请求里，不在模型请求的任何位置。因此发给模型的内容仍然只在末尾追加，每轮变化的值不在请求开头；符合 `prompt-prefix.md` 第 2、4 条。

**必答 2：会不会让同一段文字在不同请求里变成不同字节？**

对模型文本：不会，原因同上。对通知/设备载荷：通知 id 是 `sha256(sourceKey)` 的固定 base64url，同一 `sourceKey` 字节固定；`settled` 的输出顺序由 SQL `ORDER BY created_at DESC, source_key` 固定，均为请求 id 的子集；`createdAt` 来自 outbox 行，数据库 `enqueue` 是 `ON CONFLICT DO NOTHING`，同一 `sourceKey` 不会被改写。需要留意的是：`#place` 用 `accountLocale ?? "en"` 生成 title/body，如果同一通知因第 1 条被重复放置且期间账号语言变了，Mac 收到的文字可能变；这是第 1 条的副作用，不是模型开头字节问题。`serverTime` 每次不同，但只作为接口返回值。

**必答 3：有没有对应的自动检查，反向用例是否真的会失败？**

有，但覆盖不全。新增 `packages/platform-node/test/device-notification-hub.unit.test.ts` 测事件格式、队列上限、监听清理、在场窗口；`test/integration/device-notifications.test.ts` 测 presence 记录/夹时间、iPhone 调 presence 得 404、畸形时间和额外字段得 400、Mac/iPhone 事件流差异、Mac 流不计屏幕、settled 只返回给定 id、畸形 settled 请求 400；`test/integration/push-channels.test.ts` 测“有 Mac 在场+有输入只发 Mac”“无输入回退 iPhone”“无事件流回退 iPhone”“办结后 withdraw”“settled 正反用例”“APNs 顶层 notificationId”。

这些反向用例是成真的：去掉 `kind !== "mac"` 后 iPhone 的 404 用例会失败；去掉 settled 校验后 400 用例会失败；去掉 placement 后“只发 Mac”和“回退 iPhone”会失败；去掉通知流条件后 iPhone 流会出现 `notification.`。但缺少：多台 Mac 时只响一处、服务重启/`#placed` 淘汰后的重复投递、放置后仍占用 `listDue` 批次、审批办结后的 withdraw、时间到期但提醒仍未完成时的 settled/withdraw、以及 Mac 放置时网页推送是否真的被抑制。实际测试是否通过我无法运行，标记「未核实」。

**必答 4：改动产生/修改的每个值，两端都能接受吗？**

- **通知 id**：产生处 `webPushTopic()` 返回 24 字节 SHA-256 截断的 base64url（约 32 个字符，`production-web-push.ts:138-140`）；使用处 `NOTIFICATION_ID = /^[A-Za-z0-9_-]{1,64}$/` 接受；APNs 的 `notificationId` 和 `collapseId` 也是同一个 `tag`；测试覆盖。两端一致。
- **`macPresenceSeconds`**：默认值和范围在 `delivery-timing.ts:37,54`；配置解析和 App 设置读取都用 `Object.keys(DELIVERY_TIMING_DEFAULTS)`/`DELIVERY_TIMING_RANGES` 动态枚举（`strict-configuration.ts:1644-1653`、`production-delivery-timing-control.ts:53,85`），网关契约的 `key` 是 `machineString`、`value` 是 `integer(0)`（`contracts-v2.ts:577-583`），能接受新键。两端一致。
- **`lastInputAt`**：服务端要求严格毫秒 ISO 并 `Date.parse` 有限（`device-api-routes.ts:75,878-885`）；客户端是否确实按这个格式发送不在本仓库，标记「未核实」。
- **`serverTime`**：服务端 `Date.toISOString()` 输出毫秒 ISO，消费者是客户端，仓库内未核实。
- **`notification.deliver` 的 `id/kind/title/body/homeKey/createdAt`**：`homeKey` 来自 `item.threadId`，类型允许 `string | null`，与接口一致；其余字段由服务器生成、客户端消费，Swift 端格式未核实。
- **`notification.withdraw` 的 `id`**：与 deliver 的 id 同源，一致。
- **`settledIds`**：服务端只返回请求集合中的 id（`settled` 内 `wanted.has(id)` 过滤），数量不超过请求数，格式与 `NOTIFICATION_ID` 一致；客户端未核实。
- **`listRecent`**：新端口方法在 application、sqlite、durable adapter 三处齐全；SQL 对 `since` 和 `limit` 复用现有校验，`SETTLED_LOOKUP_LIMIT = 500` 正好等于 `limit` 上限 500，不会触发 `PORT_INVALID_OPERATION`。
- **APNs 顶层 `notificationId`**：只加在 `applePushAlertPayload`（`production-apple-push.ts:117`），设备动作的 `applePushOpenRequestPayload` 没有；如果客户端对所有 APNs 载荷都要求该字段，需要客户端确认，标记「未核实」。
