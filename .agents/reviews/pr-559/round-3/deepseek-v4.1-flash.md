本轮只复核 `dea9a33b8..05cf43c95` 的增量，并沿证据追到 `listDue`、presence/settled 路由、送达时机配置和 ADR/设计说明。没运行测试；“会失败/不会失败”都是读代码判断。

### 1. 中高 — 批次只按“通知条数 + 50”补偿，满 500 条或多目标时新通知仍进不了待发表

文件：`apps/agent-service/src/production-web-push.ts:44-45,543-544,568`、`apps/agent-service/src/mac-placement.ts:7,47`、`packages/persistence-sqlite/src/sqlite-web-push-operations.ts:353-364`、`packages/persistence-sqlite/src/sqlite-apple-push-operations.ts:344-367`、`docs/adr/0273-a-decision-model-holds-push-notifications-while-the-owner-is-busy.md:147`

问题：补偿量 `batch = min(500, 50 + heldCount)` 是按“被放置的通知条数”算的，但 `listDue` 对每条通知按每个活跃订阅/注册各返回一行。已经放置的项因为 `gate` 在 `#record` 之前就 `continue`，永远没有 attempt 记录，所以每轮都排在最前面占用 `LIMIT`。

读代码证实的：

```ts
const SEND_BATCH = 50;
const MAX_BATCH = 500;
...
const batch = Math.min(MAX_BATCH, SEND_BATCH + (this.#options.placement?.heldCount() ?? 0));
...
const due = await store.listDue({ ownerId, agentId, now, limit: batch });
```

```ts
if (this.#placed.size >= REMEMBER_LIMIT) return false;   // REMEMBER_LIMIT = 500
```

```ts
if (this.#options.placement?.holds(webPushTopic(item.sourceKey))) return true;  // gate
...
if (await gate(entry.item)) continue;                  // 在 #record 之前
```

两边 `listDue` 都是 join 出多行并按 created_at 排序，被放置项 created_at 更早，先占满：

```ts
JOIN web_push_subscriptions s ... s.state = 'active'
...
ORDER BY o.created_at, o.source_key, s.created_at, s.id
LIMIT ?
```
```ts
JOIN apns_registrations r ... AND ${ELIGIBLE_ALERT_REGISTRATION}
...
ORDER BY o.created_at, o.source_key, r.created_at, r.id
LIMIT ?
```

因此：单目标时 `heldCount = 500`，`batch = 500`，500 行全是已放置项，新通知一条都取不到；有 2 个目标时，`heldCount = 50` 就有 `2×50 = 100` 行，而 `batch = 100`，新通知同样一条取不到（k 个目标时阈值约为 `50/(k−1)`）。这与 ADR 第 147 行“放置的条数多也不会挤掉新通知”“满 500 条后新通知……直接走 iPhone”直接不符：不进 `due` 就连 iPhone 也走不到，最多要等被放置项到期（run 结果最长 24 小时）才释放一个槽。新增的 pile 测试只放 60 条且只有一个 APNs 注册，碰不到这个边界。

推测/未核实：生产上是否会出现两台 iPhone 或多个 web push 订阅未核实；schema 没有禁止（`apns_registrations` 唯一键含 `device_id`，`web_push_subscriptions` 唯一键含 `endpoint`）。单目标、满 500 的一半不需要推测，是代码直接推出的。

建议：至少保证 `REMEMBER_LIMIT ≤ MAX_BATCH − SEND_BATCH`（现在 500 > 450，不成立），把 `MAX_BATCH` 提到 550 以上并同步放宽两处 `listDue` 的 500 校验；更稳妥的是让已放置项不再占用待发表队列（例如给它们记一个 `held` 状态并在 `listDue` 里排除，撤回/到期时再释放），按实际行数而不是条数补偿。补两个用例：放到 `REMEMBER_LIMIT` 后再进一条；以及两个订阅/两个 APNs 注册时的批次。

### 2. 低 — Mac 标题/正文上限的新测试只测了 `clip` 辅助函数，没锁 `#place` 的接线和 256 字节标题

文件：`test/integration/push-channels.test.ts:1637-1644`、`apps/agent-service/src/production-web-push.ts:614-615`

问题：新测试只直接调用 `clip(long, 2048)`，再用 `clip("short", 256)` 验证不截断；没有经过真正放置路径，也没有“超过 256 字节的标题被截断”的用例。`#place` 若改用错常量或不再调用 `clip`，这条测试仍然通过。

读代码证实的：

```ts
title: clip(built.title, MAC_TITLE_BYTES),
body: clip(built.body, MAC_BODY_BYTES),
```
```ts
const cut = clip(long, 2_048);
...
expect(clip("short", 256)).toBe("short");
```

建议：用真实 `MacPlacement` + 长标题/长正文的提醒跑一轮，断言 `notification.deliver.data.title/body` 的 UTF-8 字节数；标题加一条 >256 字节的用例。设计文档第 767 行已经登记这两个值，测试也应锁到产生端。

### 3. 低 — 同刻修复和满额拒绝没有能在旧实现上失败的回归用例

文件：`test/integration/push-channels.test.ts:1646-1666`、`apps/agent-service/src/mac-placement.ts:47,66-68`

问题：上一轮第 6 条（两个时刻）在代码里已改成同一 `now`，第 7 条（淘汰不撤回）已改成满额拒绝；但现有到期测试把时钟一次跳 7 小时，旧的两时刻实现同样会通过，抓不住边界回归；也没有任何用例把放置数量推到 `REMEMBER_LIMIT` 去验证“拒绝放置而不淘汰、不重复 deliver”。

读代码证实的：

```ts
it("... withdraw when the notification life ends ...", async () => {
  ...
  nowMs += 7 * 3_600_000;
```
```ts
if (this.#placed.size >= REMEMBER_LIMIT) return false;
```

建议：注入一个每次读取都递增的 `nowMilliseconds`，把通知的 `expiresAt` 卡在两次读取之间，断言只撤回一次、不重发；再放 `REMEMBER_LIMIT+1` 条（或直接构造满额状态），断言第 501 条不发给 Mac、没有重复 `notification.deliver`。

### 4. 低 — 批次放大后，已放置项每轮都先重算内容，满额时每 10 秒最多 500 次读取

文件：`apps/agent-service/src/production-web-push.ts:544,568,579-584`、`apps/agent-service/src/production-apple-push.ts:344,355-360`

问题：`holds()` 的判断在 `contentOf` 之后。批次从 50 提到最多 500 后，500 条已放置项每轮都会进入 `contentOf`，执行提醒读取、记忆读取/解密、线程标题等；而它们没有 attempt 记录，会持续出现在 `due` 里。

读代码证实的：

```ts
const content = await contentOf(item);   // web push 循环
...
if (await gate(entry.item)) continue;    // gate 里才检查 holds
```
```ts
const content = await input.content(item);  // Apple 循环
...
if (await input.deferred(item)) continue;
```

影响大小取决于实际放置条数，属于推断；但 500 条、10 秒一轮的数量级是代码直接给出的。建议对已放置项先做轻量的 `holds`/到期判断，或把内容结果按 sourceKey 跨轮缓存；需要保留“内容已失效就撤回”的检查时，可用单独的较轻量检查。

## 上一轮意见核对

- 第 1 条：常见单目标、未满 500 的情况已修好；满 500 和多订阅/多设备仍未修好，见意见 1。
- 第 4 条：设计文档已登记；测试只覆盖 `clip` 辅助函数，未覆盖接线和 256 字节标题，见意见 2。
- 第 6 条：代码已改为同一个 `now`（`withdrawExpired(Date.parse(now))`），修好了；缺少能失败的边界用例，见意见 3。
- 第 7 条：代码已把“淘汰最旧”改为“满额拒绝放置”，不会再丢撤回或重复 deliver；没有满额用例，见意见 3，且满额行为与意见 1 相互影响。

## 侧重检查

- **错误路径/不可信输入：** 读了 `packages/platform-node/src/device-api-routes.ts:870-913`。`presence` 只接受 `{lastInputAt}` 一个键、毫秒精度 ISO、`Number.isFinite`，并用 `Math.min(reported, serverTime)` 夹住未来时间；非 Mac 先 404。`settled` 只接受 `ids`、数组、≤200 条、每条 `^[A-Za-z0-9_-]{1,64}$`。未发现新的校验缺口。
- **安全：** `webPushTopic` 输出 24 字节的 base64url（32 字符），同时通过 `NOTIFICATION_ID`、Mac 事件、APNs `notificationId` 和 settled 入参校验；`production-http-composition.ts` 的 settled 包装按 `scope.ownerId/agentId` 过滤，未发现跨主人泄露。presence 只有认证 Mac 能调。
- **资源耗尽：** 批次有 500 上限，查询有界；但意见 4 的内容重算是本增量放大的。`DeviceNotificationHub` 队列上限 200、满时丢最旧帧是旧代码，本轮未改，未列入意见；慢客户端可能丢已放置通知的问题前几轮已覆盖，本轮不重报。
- **不可撤销操作：** 增量只有通知放置/撤回/对账，没有删除或覆盖类不可逆操作。
- **规则/文档一致性：** ADR 第 147 行的行为承诺与代码不符，见意见 1；设计说明第 767 行的标题/正文上限与 `#place` 的 `clip` 接线一致；`macPresenceSeconds` 的 30–3600 范围在 `delivery-timing.ts:54`、`production-delivery-timing-control.ts:85-88`、`strict-configuration.ts:1648-1653` 三处一致。
- **旧 `clip` 的极小预算：** 预算小于 3 字节时它会返回 3 字节的 `…`，但本轮调用端固定 256/2048，不构成本轮问题；`webPushPayload` 的 0 预算分支属旧代码，未核实可触发性，未列入意见。

## 必答问题

1. **不会影响模型已见过的请求开头。** 依据：本轮 diff 没有触碰提示词目录、Pi 适配器、历史组装、遮盖或工具定义；改动只在推送/设备通知和送达时机读取路径。发给模型的内容仍由原有只追加路径组装，本轮没有改它；每轮变化的值仍只在最后一条消息，本改动没有新增这类值。此项不涉及。
2. **不会让同一段文字在不同请求里变成不同字节。** 对模型请求不涉及（见第 1 条）。新增的通知标识是 `webPushTopic(sourceKey)` 的确定性哈希；标题/正文由内容和 locale 决定，没有前后文遮盖、时间字段或无序列化集合。选哪台 Mac 按 `lastInput` 排序，同一毫秒并列时依赖 Map 插入顺序，可能影响选择结果，但不改变同一段文字的字节，也不是模型请求内容。
3. **有自动检查，但只部分覆盖。** `push-channels.test.ts:1613-1635` 的 pile 用例在旧 `SEND_BATCH=50` 下会失败，能抓住“批次没加”的回归；`clip` 用例能抓住截断函数本身坏掉；`device-notifications.test.ts` 新增的未接线用例能抓住 presence 在缺 wiring 时的行为。但满 500、多订阅/多注册、同刻到期边界、满额拒绝都没有会失败的用例（见意见 1、3）；`clip` 用例也抓不住 `#place` 接线错误（见意见 2）。
4. **逐个核对了两端。** `batch` 产生于 `production-web-push.ts:544`，消费于 `production-apple-push.ts:344` 和两处 SQLite `listDue`；两处都要求 1–500 的整数，产生端 `min(500, …)` 能通过。`withdrawExpired(nowMilliseconds)`、`heldCount()` 只有 MacPlacement 实现、只有 `production-web-push` 调用，类型和数值都能对上。`clip` 新导出只被测试和 `#place` 使用，无同名导出冲突。`withoutNotifications` 只被 harness 和新增反向用例使用。`notificationId`/Mac 事件 `id`/settled `id` 三处都是 32 字符 base64url，能通过 `NOTIFICATION_ID` 和 APNs 载荷校验。`macPresenceSeconds` 的 30–3600 在设置控制、严格配置、默认值和 `service-main.ts:736-737` 的消费端一致。两端校验本身都能接受；真正的问题不是校验拒绝，而是 `batch` 的条数假设与 `listDue` 的行数展开不一致（意见 1）。
