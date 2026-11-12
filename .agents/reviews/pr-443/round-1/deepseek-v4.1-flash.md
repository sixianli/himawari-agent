## 结论

改动没有触碰模型请求组装；主要风险集中在“撤销设备 → 清除推送”这条不可撤销路径，以及并发/资源耗尽的边界。证据均来自当前检出的代码（我未执行测试，也未对真 APNs 验证）。

---

## 读代码证实的问题

### 1. 高：清除推送在撤销校验之前发出，撤销失败也会清空设备

- 文件：`packages/platform-node/src/device-api-routes.ts:929`
- 证据：

```ts
await options.push?.beforeRevoke(body.deviceId);
const device = await options.devices.revoke({ ...scope(authentication), ...body });
```

`beforeRevoke` 最终会调用 `ProductionApplePush.wipeDevice`（`device-push.ts:272-278`），而 `revoke` 才在事务里校验版本：

```ts
// packages/persistence-sqlite/src/sqlite-paired-device-operations.ts:214-215
if (input.expectedRevision !== undefined && device.revision !== input.expectedRevision)
  return this.fail("PORT_CONFLICT", "Paired device changed");
```

- 问题：只要客户端提交了过期/错误的 `expectedRevision`，清除推送已经发出，随后撤销返回 409；设备仍保持配对，但本地数据已被不可撤销地清除。
- 建议：先做只读校验（scope、revision、status），或让撤销事务先完成、拿到撤销前的登记令牌后再发清除推送；不要在校验前执行不可逆操作。

### 2. 中：其他“移除设备”入口没有清除推送，作者说法 6 只对管理接口成立

- 文件：
  - `apps/agent-service/src/production-device-control.ts:155-159`
  - `apps/agent-service/src/production-http-composition.ts:1230-1236`
  - `packages/persistence-sqlite/src/sqlite-durable-operations.ts:5039-5049`
- 证据：

```ts
case "device.revoke":
  return this.#change(
    command.payload,
    () => this.#options.devices.revoke({ ...scope, ...command.payload }),
    (device) => device.status === "revoked",
  );
```

```ts
deviceControl: new ProductionDeviceControl({
  configuration,
  devices: pairedDevices,
  deviceConfiguration: () => deviceConfiguration,
  ...
}),
```

`ProductionDeviceControl` 没有 push/wipe 依赖；`revokeProductDevice` 也只做：

```ts
disablePushForRevokedDevices(
  this.database,
  (this.database.prepare(
    "SELECT id FROM paired_devices WHERE web_device_id = ? AND status <> 'revoked'",
  ).all(input.deviceId) as { id: string }[]).map(({ id }) => id),
  input.revokedAt,
);
```

- 问题：通过 v2 `device.revoke`、网页设备/身份设备撤销等路径移除设备时，登记会停用、凭据会删除，但不会先发 `wipe_local_data`。与“设备被移除时……先给它发一条清除推送”的说法不一致。
- 建议：把“撤销前的清除”放到统一服务层，所有 revoke 入口共用；或者让 `ProductionDeviceControl` 也持有 `DevicePushPort`。

### 3. 中：同一设备多个事件流时，关闭任意一个就把“正在看”清掉

- 文件：`packages/platform-node/src/device-api-routes.ts:833-834`
- 证据：

```ts
options.push?.presence(authenticated.device.id, true);
stream.once("close", () => options.push?.presence(authenticated.device.id, false));
```

而 `holdDeviceStream` 自己按设备计数（`device-api-routes.ts:243-248`），presence 却没有计数。

- 问题：同一设备开两条流，关闭其中一条后 `visible=false`，另一条仍在看时服务器也会推送，违反“正在看就不推”。
- 建议：presence 按流 ID 或引用计数维护，只有最后一条流关闭时才置 false；测试补一条“两条流关一条仍不推”。

### 4. 中：一次性凭据消费的写事务是 deferred，不是 immediate

- 文件：`packages/persistence-sqlite/src/sqlite-apple-push-operations.ts:518`
- 证据：

```ts
return this.database.transaction((): NotificationActionTokenResult => {
```

条件更新本身是对的：

```ts
// sqlite-apple-push-operations.ts:557-561
`UPDATE notification_action_tokens SET used_at = ?
  WHERE token_hash = ? AND used_at IS NULL AND expires_at > ?`
...
if (changed !== 1) return { kind: "rejected", reason: "used" };
```

- 问题：同一数据库有多个连接/进程时，deferred 事务在读完再升级为写锁可能得到 `SQLITE_BUSY`，表现为第二次请求 500，而不是作者声称的“只有一次成功（另一次干净 410）”。仓库里其他一次性消费/认领多使用 `.immediate()` 规避这一点。
- 建议：消费路径改成 `.transaction(...).immediate()`，并补跨连接并发测试。当前单进程测试（`notification-actions.test.ts:353-365`）不能证明跨进程行为。

### 5. 低：Live Activity “开始”发送失败后不会重试

- 文件：`apps/agent-service/src/production-apple-push.ts:492-500`
- 证据：

```ts
if (
  this.#activityStarts.has(key) ||
  ...
) continue;
this.#activityStarts.add(key);
```

`add` 发生在 `#transmit` 之前，且发送结果为 `retry` 时没有删除这个 key。

- 问题：一次临时 APNs 错误会让该设备/该次运行的实时活动永远不开始，直到进程重启。
- 建议：仅在 `sent` 后加入 `#activityStarts`，或者在非成功结果时删除。

### 6. 低：APNs 负载只裁剪正文，长标题或按钮仍可能超过 4096 字节

- 文件：`apps/agent-service/src/production-apple-push.ts:111-114`
- 证据：

```ts
const full = build(input.body);
const overflow = Buffer.byteLength(full, "utf8") - PAYLOAD_BYTES;
if (overflow <= 0) return full;
return build(clip(input.body, Math.max(0, Buffer.byteLength(input.body, "utf8") - overflow - 8)));
```

`title`、`navigate`、`tag`、`actions` 都不参与裁剪；发送器在 `apple-push-sender.ts` 仍会直接返回 `too_large`。

- 问题：标题很长或按钮很多时，通知会永久记为失败而不是被缩短后送达。
- 建议：按完整负载计算并裁剪标题/按钮文案，必要时先丢弃非关键按钮。

---

## 推测 / 风险（未实测）

### 7. 中低：Live Activity 登记没有每设备/每账号上限，可能耗尽存储和列表内存

- 文件：
  - `packages/platform-node/src/device-push.ts:124-171`
  - `packages/persistence-sqlite/src/migrations/0095_apple_push.sql:28-29`
  - `apps/agent-service/src/production-apple-push.ts:470-478`
- 说明：`activityRef` 只校验格式，唯一键是 `(device_id, push_type, activity_ref)`，没有数量上限；`listRegistrations` 会载入该账号全部登记。已配对设备若被滥用或客户端有 bug，可无限插入活动登记行，导致数据库/每轮维护成本增长。
- 建议：限制每设备活动登记数量，只允许当前账号可见的运行编号，并定期清理已结束的运行登记。

---

## 作者 9 条说法逐条核对

| # | 结论 | 依据 |
|---|---|---|
| 1 | ✅ 成立 | `0095_apple_push.sql:76-115` 显式复制旧行；`apple-push-migration.contract.test.ts:60-94` 逐列比较 |
| 2 | ⚠️ 部分成立 | 条件 `UPDATE ... WHERE used_at IS NULL` 保证只一个成功；但事务是 deferred，跨进程可能 `SQLITE_BUSY`（问题 4） |
| 3 | ✅ 基本成立 | 过期/别的设备/已用/不存在均 410；审批版本/摘要变化由 gateway 抛 `ApplicationPortError` 后映射 410（`device-api-routes.ts:770-772`） |
| 4 | ✅ 成立 | `device-push.ts:198-199` 只在 `action === "approve" && ownerPresence && !confirmed` 时 403 |
| 5 | ✅ 当前成立 | 全仓库只有 `device-api-routes.ts:756` 传 `notificationAction: true`；但仍是公开导出参数，未来调用方需自行守约束 |
| 6 | ✅ 成立 | `apple-push-sender.ts:78-88`、`127-130`；50 分钟刷新、20 分钟才重签、`410`/`Unregistered` → gone、超 4096 不发 |
| 7 | ✅ 成立 | `device-push.ts:257-265` 只允许 iPhone 调用；`setCompanion` 已归属别人返回 `linked_elsewhere` → 409 |
| 8 | ✅ 成立 | 导出是白名单查询，代码中没有读取新表；`export.ts:573-577` 写了“没导出什么”；`data-export.test.ts` 有反向断言 |
| 9 | ⚠️ 代码上成立，无自动检查 | 诊断只写 `stableErrorCode`/APNs 状态码，未见令牌或凭据；但没有专门的日志/错误反向测试 |

---

## 必答问题

### 1. 改动会不会改变模型已经见过的请求开头？

不会。改动文件集中在设备接口、SQLite 持久化、APNs 发送器和配置解析；`git diff --stat` 中没有 `packages/prompt-catalog`、`runtime-pi`、请求组装或遮盖相关文件。新出现的值（推送令牌、按钮凭据、审批版本/摘要、通道名）只进入数据库和 APNs 负载，不进入系统提示、工具定义或历史。没有证据表明它破坏了“只在末尾追加、每轮变化的值放最后一条消息”的规则。

### 2. 同一段文字会不会在不同请求里变成不同字节？

对模型请求：不会。新增的 `notificationActionHash` 是确定性 `sha256`，`homeDigest` 对提醒和审批做了排序，`APPLE_PUSH_TEXT` 是固定常量，按钮顺序固定。APNs 负载里的 `timestamp`、`apns-id`、JWT `iat` 会随每次发送变化，但这些只用于推送，不属于发给模型的内容；没有修改出口遮盖。

### 3. 有没有对应的自动检查，反向用例真的会失败？

有，但覆盖不完整：

- 迁移保数据：`packages/persistence-sqlite/test/apple-push-migration.contract.test.ts` 先插入 attempt/feedback 行，应用 0095 后逐列比较；丢行会失败。
- 凭据一次性：`notification-actions.test.ts:353-365` 用两次并发请求断言 `[200, 410]` 且 `used_at` 只 1 行；若消费没有条件更新，会两条 200 而失败。但它是单进程/同连接，不覆盖问题 4 的跨进程 `BUSY`。
- 410 反例：`notification-actions.test.ts:311-351` 覆盖过期、别的设备、不存在、审批内容变化。
- 确认钥匙：`notification-actions.test.ts:240-309` 覆盖 403、凭据不作废、挑战值过期/重用。
- 手表：`notification-actions.test.ts:367-418`。
- 发送器：`apple-push-sender.test.ts` 覆盖 50 分钟刷新、20 分钟重签、gone、4096 字节。
- 导出：`data-export.test.ts` 新增反向断言，确实会因导出新表而失败。
- 缺口：说法 9（日志不含令牌/凭据/密钥）没有自动反向用例；说法 2 没有跨连接并发用例；说法 5 没有“其他入口不能设置 `notificationAction`”的运行时测试。

### 4. 每个新值的生产者和消费者能对上吗？

我核对了主要值：

- `apns_registrations.id`：`device-push.ts:164` 生成 `apn_`+22 位 base64url，`saveRegistration` 与 DB `length=26/substr='apn_'` 一致。
- 推送令牌：`APPLE_PUSH_TOKEN_PATTERN` 与 DB `length 2..512` + 全小写十六进制一致。
- `topic`/`environment`/`locale`/`push_type`：设备接口、DB CHECK、配置解析三处枚举一致。
- `notification_action_tokens.token_hash`：`notificationActionHash` 产出 64 位十六进制，DB 主键 CHECK 和读取时的 `TOKEN_HASH` 一致。
- `action`：当前生产者只产生 `approve`/`deny`，消费者按 `approve ? approved : denied` 映射；DB 故意不枚举动作名，留下一个 I-73 式隐患——以后若有人写入第三种动作，路由会静默当成 `denied`。建议消费者显式拒绝未知动作。
- `owner_presence`：`production-apple-push.ts:295-297,306-321` 产生，`device-push.ts:198` 消费，一致。
- `approval_revision`/`approval_snapshot_hash`：产生自审批记录，`device-api-routes.ts:744-746` 传给 gateway，gateway 与当前审批的 revision/摘要比较，一致。
- `companion_of`：`setCompanion` 只允许 iPhone 作为 host、watch 作为设备；`resolveActionToken` 只允许 `presenter.companionOf === 凭据设备`，与“手表可用 iPhone 凭据”一致。
- `web_push_feedback.channel`：APNs 写入 `apns`，web push 写入 `web_push`；但 `ON CONFLICT` 时不更新 `channel`，同一来源先走 APNs 后回退 web push 时会保留旧通道值。当前没有看到基于该列做安全判断，属于数据准确性问题。

---

## 未核实

- 未运行 `npm run check` / `npm run build` / 任何测试，仅阅读代码。
- 未对真 APNs 验证 push type、topic、负载格式。
- 未验证 iOS 通知扩展、确认钥匙在真机上的调用顺序。
- 未实测多进程数据库并发下的 `SQLITE_BUSY` 行为（问题 4 的失败方式是推断）。
- 未核对真实审批记录里 `recentAuthenticationRequired` 的所有生产来源，只确认了类型和当前使用点。
