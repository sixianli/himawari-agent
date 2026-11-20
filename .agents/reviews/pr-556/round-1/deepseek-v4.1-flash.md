## 读代码证实的意见

### 1、中（已核实）：设备动作唤醒推送绕过了现有的“正在看 / 免打扰 / 推送类别开关 / 送达时机”门控

**文件:行** `packages/application/src/services/device-action-service.ts:507-509`、`apps/agent-service/src/production-apple-push.ts:256-293`、`apps/agent-service/src/production-web-push.ts:523,539-550`

**问题** `#dispatch` 只在目标设备 `delivery.connected` 为假时调用 `requestOpen`；`requestOpen` 直接列令牌并发送，完全不看是否存在别的 Himawari 页面在前台、当前是否在不推送时段、用户是否关掉了推送类别、送达时机是否应延后。网页推送/苹果推送的正常路径都有这些门控。

**证据** `device-action-service.ts:507-509`：

```ts
if (!delivery.connected(record.deviceId)) {
  await this.#options.openRequests?.requestOpen({ record, detail });
  return record;
}
```

`production-web-push.ts:523` 与 `:539-549` 显示正常路径把 `visible` 传给 companion：

```ts
const visible = this.#options.presence.anyVisible(now);
...
await this.#options.companion?.deliver({
  ...
  visible,
  ...
});
```

设计文档 `docs/execution/specs/2026-11-11-apple-device-body-design.md:468` 写明“正在看 Himawari：不弹推送，在 App 或网页里显示”，`:490` 也把“正在看的地方不推”列为苹果推送/网页推送分流前的规则。新路径只判断目标设备连接，不判断任何设备的 `presence`。

**建议** 让 `requestOpen` 接入同一套可见性/免打扰/类别门控，或至少在 `DeviceActionService` 调用前把 `visible`、push gate 和送达时机结论传进来；如果产品上确定“设备动作唤醒”是免打扰例外，应在设计文档里写明，并补上对应测试。

### 2、中（已核实）：新推送用了 `tag`，但没有写通知反馈行，客户端上报“点开/划掉”会被静默丢弃

**文件:行** `apps/agent-service/src/production-apple-push.ts:269,272-288`、`packages/platform-node/src/device-push.ts:50,212-251`、`packages/persistence-sqlite/src/sqlite-web-push-operations.ts:591-603,622-630`

**问题** 新推送的 `tag` 是 `device-action-<动作号>`，符合 `feedback` 的 tag 正则；但反馈记录依赖 `web_push_feedback` 行，而只有 `recordAttempt` 在 `sent` 时才会插入该行。`requestOpen` 既不调用 `recordAttempt`，也不写 outbox，所以客户端按 tag 上报 `opened`/`dismissed` 时，`recordReactions` 只会更新 0 行。

**证据** `production-apple-push.ts:269`：

```ts
const tag = `device-action-${record.id}`;
```

`device-push.ts:50` 接受这种 tag：

```ts
const FEEDBACK_TAG_PATTERN = /^[A-Za-z0-9_-]{1,64}$/u;
```

`sqlite-web-push-operations.ts:591-603` 只在 `recordAttempt` 结果为 `sent` 时插入反馈行；`recordReactions` 的更新语句只修改已存在的行：

```sql
UPDATE web_push_feedback SET opened_at = ... WHERE owner_id = ? AND agent_id = ? AND tag = ?
```

设计文档 `docs/execution/specs/2026-11-11-apple-device-body-design.md:510`：“`feedback` 收的是‘点开了’‘划掉了’，按通知的标签记到现有的通知反馈上，和网页推送是同一份记录。”

**建议** 为这条推送建立可关联的 `web_push_feedback` 行（复用 `recordAttempt` 或提供专用写入端口），或者明确把设备动作唤醒排除在通知反馈之外并补文档/测试，避免客户端以为反馈被接受而实际丢弃。

### 3、中低（已核实）：新增反向用例没有覆盖实际新增的过滤条件，`service-main` 的接线也没有端到端测试

**文件:行** `test/integration/push-channels.test.ts:836-889`、`apps/agent-service/src/service-main.ts:1664-1668`

**问题** 正向用例覆盖了通用文字、优先级、`interruption-level`、`kind`、`actionId` 和“无明细”；反向用例只覆盖“没有 alert 令牌”和“另一台设备的令牌”。实际新增的 `status === "active"`、`#configured`（topic/environment）过滤、`gone` 后停用令牌、`expiresAt`/`collapseId` 头、`onFailure` 吞错都没有反向用例。`service-main` 把 `requestOpen` 接到 `createProductionDeviceActions`，但测试直接调用 `context.applePush.requestOpen`，没有走 `DeviceActionService.#dispatch` 或生产组装。

**证据** 反向用例 `:873-889` 只做：

```ts
await context.applePush.requestOpen({ record });
expect(context.apns.ofType("alert")).toEqual([]);
context.device(WATCH, "watch");
await context.register(WATCH, "alert");
await context.applePush.requestOpen({ record });
expect(context.apns.ofType("alert")).toEqual([]);
```

正例 `:850-870` 没有断言 `apns-expiration`、`apns-collapse-id`、`sound`、`thread-id`、`category`、`navigate`，也没有模拟 `gone` 或 sender 抛错。

**建议** 至少补：禁用令牌不发送、未配置 topic/environment 不发送、`gone` 后令牌变 `disabled`、`expiresAt` 与 `collapseId` 头正确、sender 抛错只调用 `onFailure` 不抛出；再加一条从 `DeviceActionService` 到生产组装的用例，确认 `openRequests` 实际接到 `ProductionApplePush`。

### 4、低（已核实）：作者“发完按结果更新令牌状态”的说法比代码宽，只有 `sent`/`gone` 会更新

**文件:行** `apps/agent-service/src/production-apple-push.ts:315-338`

**问题** `#applyRegistrationOutcome` 只处理 `sent` 和 `gone`；`retry`、`rate_limited`、`rejected`、`too_large` 既不更新注册状态，也不记录失败。作者说法“发完按结果更新令牌状态（失效的停用）”容易被理解成所有结果都会更新。

**证据**：

```ts
if (result.kind === "sent")
  await this.#options.store.markRegistration({ ... status: "active" ... });
else if (result.kind === "gone")
  await this.#options.store.markRegistration({ ... status: "disabled" ... });
```

**建议** 把说法改成“只有发送成功和令牌失效时更新”；如果希望 `rejected`/`too_large` 也留下失败痕迹，应同步更新 `failureCode` 或记录诊断，而不是静默丢弃。

### 5、低（已核实）：整个令牌循环共用一个 `try`，一次存储写入异常会中断后续令牌

**文件:行** `apps/agent-service/src/production-apple-push.ts:258-292`

**问题** `try` 包住 `listRegistrations`、整个 `for` 循环和每次 `#applyRegistrationOutcome`。如果第一个令牌已经发送成功但状态写回失败，后面的令牌不会再尝试，只会调用一次 `onFailure`。

**证据**：

```ts
try {
  const registrations = ...;
  for (const registration of registrations) {
    ...
    await this.#applyRegistrationOutcome(registration, result, now);
  }
} catch (error) {
  this.#options.onFailure(error);
}
```

**建议** 把每个令牌的发送独立 `try/catch`（或 `Promise.allSettled`），保证一个令牌的存储错误不影响其余令牌；同时在 `onFailure` 中保留 `registration.id`/`deviceId` 便于排查。

## 推测

### 6、低（推测）：工具调用路径同步等待 APNs，最坏会增加约默认 10 秒的延迟；同一批多个动作也没有合并/限流

**文件:行** `packages/application/src/services/device-action-service.ts:508`、`apps/agent-service/src/production-apple-push.ts:270-289`、`packages/platform-node/src/apple-push-sender.ts:157-160`、`packages/application/src/ports/apple-push.ts:46`

**问题** `#dispatch` 在设备离线时 `await` 整个 `requestOpen`，后者逐个令牌 `await #transmit`；sender 的单次请求超时默认 `requestTimeoutSeconds = 10`。因此设备离线时，模型这次工具调用要等 APNs 返回（或超时）才继续。如果一轮里排了多个设备动作，每个动作都会各自发一条独立通知，没有按设备合并或限流。

**证据** `device-action-service.ts:508`：

```ts
await this.#options.openRequests?.requestOpen({ record, detail });
```

`apple-push-sender.ts:157-160`：

```ts
stream.setTimeout(options.requestTimeoutSeconds * 1_000, () => {
  stream.close(constants.NGHTTP2_CANCEL);
  settle({ kind: "retry", code: "APNS_TIMEOUT" });
});
```

**建议** 评估是否应该 fire-and-forget（内部仍处理错误），或把等待时间限制在远小于工具调用预算的范围内；如果多个动作排队，考虑按设备/对话合并为一条“请点开”通知。

### 7、低（推测）：`requestOpen` 自身不复核 `record.id` 和 `record.expiresAt`，完全依赖调用方/数据库不变量

**文件:行** `apps/agent-service/src/production-apple-push.ts:269,278`

**问题** `record.id` 直接进 `collapseId`，`record.expiresAt` 直接进 `Date.parse`。当前 `record` 来自 `DeviceActionService` 刚插入并校验过的行（`device-action-service.ts:379` 校验 `DEVICE_ACTION_ID_PATTERN`，过期时间来自数据库），所以暂时不可达；但 `requestOpen` 是公开方法，未来若有别的调用方传入不规范记录，会得到 `NaN` 的 `expiresAtSeconds` 或非法 collapse-id 头。

**证据**：

```ts
const tag = `device-action-${record.id}`;
...
expiresAtSeconds: Math.floor(Date.parse(record.expiresAt) / 1_000),
```

**建议** 在 `requestOpen` 开头用 `DEVICE_ACTION_ID_PATTERN` 和时间格式校验记录，或在类型/注释上明确只接受已入库记录，并补一条非法记录用例。

## 侧重检查

- **错误路径**：`#transmit` 会捕获 sender 抛错并转成 `retry`，但 `requestOpen` 不重试；`#applyRegistrationOutcome` 只处理 `sent`/`gone`；整个循环共用一个 `try`，存储异常会中断后续令牌（见意见 4、5）。`onFailure` 本身抛错时没有任何保护，会向外传播，但当前实现是同步诊断写入，风险低。
- **不合规范或不可信输入**：`record` 来自刚写入的数据库行，`id` 在插入时已按 `DEVICE_ACTION_ID_PATTERN` 校验，`expiresAt` 也由服务器生成；`requestOpen` 本身不重复校验（见意见 7）。`deviceId` 只作为 SQL 参数，没有注入风险；`tag` 是 51 个 ASCII 字符，低于 APNs collapse-id 的 64 字节上限和 feedback tag 的 64 字符上限。
- **安全与隐私**：锁屏标题/正文是固定通用文字，`himawari` 里只有 `actionId`、`tag`、`kind`、`navigate`，没有动作名、参数、事件标题；正向用例也断言了不包含“牙医复诊”和“calendar”。我没有发现这条路径泄露动作明细或密钥。
- **资源耗尽**：同一设备的 alert 令牌受唯一约束限制，通常最多一个；但每个排队动作都会单独发推送，没有按设备合并，也没有限制一轮里的动作数量（见意见 6）。`requestOpen` 顺序发送而非并发，单次最坏等待 sender 的 `requestTimeoutSeconds`。
- **不可撤销的操作**：这条推送只是叫醒 App；真正执行仍走设备 claim 和已有的授权/在场检查。没有发现它绕过授权。打开 App 后可能领取并执行已排队的不可逆动作，但那是既有队列语义，且设备端处理属于 9B，不在本 PR 范围。
- **规则/说明文档与代码一致**：锁屏通用文字与 ADR 0089 第 5 条不冲突；设计第 12 节第 2 步“连接不在时发一条苹果推送请主人点开”已实现。明确不一致的是通知反馈（设计第 11 节要求按 tag 记到现有反馈，实际没有反馈行）和推送门控（设计要求“正在看”不推，新路径只判断目标设备连接）。客户端侧 `kind`、`navigate`、`time-sensitive` 的接受情况未核实；当前 iOS entitlements 里没有 `aps-environment` 或 time-sensitive 权限，说明端到端能力还没接上。
- **未核实**：真实 APNs 对 `interruption-level: time-sensitive` 的权限/降级行为、客户端是否认识 `kind: "device_action"`、`navigate: "/"` 是否打开正确页面、设备目标是 Apple Watch 时是否应改发 companion iPhone 的令牌。

## 必答问题

1. **不会改变模型已经见过的请求开头。** 本次 diff 只改了 `production-apple-push.ts`、`service-main.ts` 和新增测试，没有改系统提示、工具定义、历史消息、遮盖逻辑或 prompt catalog。新增的值（标题/正文、动作号、过期时间、tag）只进入 APNs 的请求头和负载，不进入发给模型的内容。发给模型的内容仍然只在末尾追加，本次也没有新增每轮变化的值；原有每轮变化值的位置不受影响。依据：[`prompt-prefix.md`](.agents/instructions/prompt-prefix.md#rules) 第 4 条。

2. **不会让同一段文字在不同请求里变成不同字节。** `applePushOpenRequestPayload` 使用字面量对象和 `JSON.stringify`，键顺序固定；标题/正文只取决于 `registration.locale` 的固定三语文字，`kind`、`navigate`、`actions` 固定，`tag`/`actionId` 取决于该动作记录，`ownerPresence` 取决于记录；没有时间戳、随机数、无序集合或依赖前后文的遮盖。相同动作记录 + 相同注册信息每次生成相同负载。sender 会额外加随机 `apns-id`，但那是传输头，不属于正文/模型文本。

3. **有自动检查，但覆盖不完整。** 新加了一个正向用例和一个反向用例；正向用例验证了通用文字、优先级 10、`interruption-level` 由 `ownerPresence` 决定、`kind`、`actionId`、`actions: []`；反向用例在“没有 alert 令牌”和“只注册了另一台设备令牌”时会失败，说明 `deviceId` 过滤和“没有令牌就不发”这两条反向逻辑是真的有效的。但禁用令牌、未配置主题/环境、`gone` 后停用、过期/合并头、`onFailure` 吞错、`service-main` 的实际接线都没有反向用例；如果删掉 `status === "active"` 或 `#configured` 过滤，这两个用例仍然会通过。

4. **逐个核对产生和使用这些值的地方：**
   - `openRequests` / `requestOpen`：`DeviceActionOpenRequestPort` 声明 `{record, detail}`，`service-main` 原样传入，`ProductionApplePush.requestOpen` 只声明 `{record}`；TypeScript 结构类型允许变量多带 `detail`，当前能编译。但 `detail` 被忽略，若以后要求用它生成文案，需要同步改签名。
   - `tag` / `collapseId`：`tag` 为 `device-action-<37 位动作号>`，共 51 字符，满足 APNs collapse-id 的 64 字节上限；也满足 `DevicePushService` 的 tag 正则。但反馈落库端要求已有 `web_push_feedback` 行，本路径没有创建，见意见 2。
   - `expiresAtSeconds`：`ApplePushSendRequest` 接受整数，sender 写入 `apns-expiration`；`record.expiresAt` 由服务器生成，当前有效。`requestOpen` 自身不校验，见意见 7。
   - `kind: "device_action"`、`actionId`、`navigate: "/"`、`actions: []`、`category: "himawari.plain"`、`thread-id: "device_action"`、`interruption-level: active|time-sensitive`：服务端没有对这些字段做二次校验或拒绝；合法值本身符合 APNs 和现有 payload 形状。客户端消费者不在本 PR 范围（9B），当前仓库里也没有解析这些字段的 Swift 代码，`aps-environment`/time-sensitive entitlement 也还没有，所以端到端“客户端能接受”未核实。
   - `openTitle` / `openBody`：三个 `WebPushLocale` 都有，`satisfies Record<WebPushLocale, unknown>` 能保证不漏语言；只被 `requestOpen` 使用。
   - `onDelivery` 的 `kind: "device_action.sent"` 等：只进 `service-main` 的自由文本诊断事件，没有枚举校验，能接受。
   - 没有新增表、迁移或配置键；这一点与作者说法一致。
