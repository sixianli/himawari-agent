**结论：** 本次增量整体方向正确；作者 7 条说法中，第 1 条（重试间隔）与第 3 条（设计说明）存在“限流”分支与代码不一致，其余核对基本成立。未发现会改变模型请求开头的问题；主要风险集中在 APNs 重试资源耗尽、Live Activity 登记表清理和错误隔离。

## 读代码证实的发现（按严重度）

### 1. 中：限流被无限重试，且与本次新增设计说明矛盾

- 文件：`apps/agent-service/src/production-apple-push.ts:553-558`；`docs/execution/specs/2026-11-11-apple-device-body-design.md:491`
- 问题：`rate_limited` 分支固定 60 秒后再试，`attempts` 不会触发停止；只有 `retry` 才走 1/5/15 分钟并最终 `Infinity`。设计说明写的是“临时错误或限流时按 1 分钟、5 分钟、15 分钟的间隔再试，之后不再试”。APNs 一旦持续 429，会在该运行存活期间每 60 秒无限重试。
- 证据：

```ts
// production-apple-push.ts:550-559
const attempts = (started?.attempts ?? 0) + 1;
this.#activityStarts.set(key, {
  attempts,
  notBefore:
    result.kind === "rate_limited"
      ? at + RATE_LIMIT_DELAY_MS
      : result.kind === "retry" && attempts <= RETRY_DELAYS_MS.length
        ? at + (RETRY_DELAYS_MS[attempts - 1] ?? RATE_LIMIT_DELAY_MS)
        : Number.POSITIVE_INFINITY,
});
```

```md
// design.md:491
“开始”遇到苹果的临时错误或限流时按 1 分钟、5 分钟、15 分钟的间隔再试，之后不再试。
```

- 建议：把 `rate_limited` 纳入同一 `attempts` 调度并设上限，或在超过次数后置 `Infinity`；补一条连续 429 四次后不再发送的用例。

### 2. 中低：Live Activity 更新的失败没有退避，会按推送 tick 无限重发

- 文件：`apps/agent-service/src/production-apple-push.ts:573-614`；`apps/agent-service/src/production-web-push.ts:17`
- 问题：更新/结束循环只在 `sent` 或 `gone` 后写 `#activitySent`，`retry`/`rate_limited` 没有记录下一次可试时间。`tick` 默认 10 秒，因此 APNs 持续 5xx/429 时每个 tick 都会重发同一条 update，无上限。
- 证据：

```ts
// production-apple-push.ts:577-579
const sent = this.#activitySent.get(registration.id);
if (sent?.phase === phase) continue;
if (!terminal && sent && at - sent.at < minimum) continue;
```

```ts
// production-apple-push.ts:603-614
if (result.kind === "sent" || result.kind === "gone") {
  this.#activitySent.set(registration.id, { phase, at });
  if (terminal || result.kind === "gone") {
    this.#activitySent.delete(registration.id);
    await store.removeRegistration({ ... });
  }
}
// 没有 retry / rate_limited 的分支
```

```ts
// production-web-push.ts:17
const DEFAULT_INTERVAL_MS = 10_000;
```

- 建议：给 update/end 也记录尝试次数和 `notBefore`，失败后至少按最短间隔退避并设上限；补反向用例。

### 3. 中低：`#activityStarts` 的清理在批次满时完全跳过，可能长期增长；且没有测试

- 文件：`apps/agent-service/src/production-apple-push.ts:506-514`
- 问题：清理只在 `runs.length < ACTIVITY_BATCH` 时执行。若持续有 20 个及以上未完成运行，已结束运行的键永远不会被删除，设备已无“开始”登记的键也不会删。作者的 PR 说明也承认这两个集合“没有专门用例”。
- 证据：

```ts
// production-apple-push.ts:506-514
if (runs.length < ACTIVITY_BATCH) {
  const unfinished = new Set(runs.map(({ runId }) => runId));
  const devices = new Set(starters.map(({ deviceId }) => deviceId));
  for (const key of this.#activityStarts.keys()) {
    const separator = key.indexOf("\n");
    if (!unfinished.has(key.slice(separator + 1)) || !devices.has(key.slice(0, separator)))
      this.#activityStarts.delete(key);
  }
}
```

- 建议：把“运行已结束 / 设备已无 starter”的键清理移出批次条件，或按 `notBefore === Infinity`、运行终态单独过期；增加“批次满时仍清理”和“设备登记消失后清理”的用例。

### 4. 中低：Apple 侧失败会阻断同一次 tick 的网页推送

- 文件：`apps/agent-service/src/production-web-push.ts:439-448`
- 问题：`companion.deliver` 在网页推送 `listDue` 之前调用，且 `#deliver`/`#run` 没有局部 `try/catch`。Apple 侧 store、`#title` 或内容构建抛错时，本次 tick 的网页推送和 prune 都不会执行；`tick` 顶层只记录 `onFailure`，若错误持续，网页推送会被长期饿死。
- 证据：

```ts
// production-web-push.ts:439-448
await this.#options.companion?.deliver({
  now,
  approvals,
  badge,
  kinds,
  accountLocale,
  visible,
  content: contentOf,
});
const due = await store.listDue({ ownerId, agentId, now, limit: SEND_BATCH });
for (const entry of due) {
```

- 建议：把 `companion.deliver` 包在独立 `try/catch` 中，失败只记诊断，不阻断网页推送主路径。

### 5. 低：未知动作的拒绝逻辑正确但没有反向用例；路由的默认映射埋下未来扩展风险

- 文件：`packages/platform-node/src/device-push.ts:198-202`；`packages/platform-node/src/device-api-routes.ts:749`
- 问题：`takeAction` 在消费前检查 `NOTIFICATION_ACTIONS`，代码正确。但现有测试只有“随机不存在的 token”，没有往数据库插入 `action` 不在白名单的 token，因此这条新逻辑没有反向用例。路由删掉动作判断后使用三元表达式，设计说明又说以后动作会扩展，届时新增动作会被静默当成 `denied`。
- 证据：

```ts
// device-push.ts:198-202
if (
  read.kind === "rejected" ||
  read.token.approval === null ||
  !(NOTIFICATION_ACTIONS as readonly string[]).includes(read.token.action)
)
  throw new DevicePushError(DEVICE_PUSH_ERROR_CODES.ACTION_INVALID, 410);
```

```ts
// device-api-routes.ts:749
decision: token.action === "approve" ? "approved" : "denied",
```

- 建议：加一条直接插入 `action = 'cancel'`（能通过数据库 CHECK）的用例，断言 410 且 `used_at` 仍为 `NULL`；路由改为对 `approve`/`deny` 显式分支，未知动作不默认 `denied`。

### 6. 低：`activityLimit` 生产端有 1..64 上限，消费端只有下限

- 文件：`packages/persistence-sqlite/src/sqlite-apple-push-operations.ts:175-176`；`packages/application/src/ports/apple-push.ts` 的 `APPLE_PUSH_CONFIGURATION_BOUNDS.liveActivityRegistrationsPerDevice`
- 问题：配置解析限制 1..64，但 `saveRegistration` 只校验 `>= 1`，没有上限。当前唯一生产者是配置，所以不会立刻越界；但按 I-73 的教训，两端应对齐，否则将来新增生产者时可能传入 65+ 并被 SQL `LIMIT` 接受。
- 证据：

```ts
// sqlite-apple-push-operations.ts:175-176
!Number.isSafeInteger(input.activityLimit) ||
input.activityLimit < 1 ||
```

- 建议：在 `saveRegistration` 同时校验 `<= 64`；另外注意配置里的 `topics` 允许到 255 字符，而 `applePushTopic` 对 widgets/liveactivity 会追加 `.push-type.*`，可能超过 APNs 主题 255 字符上限，建议在配置或发送前按派生后的 topic 校验长度。

### 7. 低：`apple-push` 用途字符串两端一处用常量、一处用字面量，存在静默失配风险

- 文件：`apps/agent-service/src/service-main.ts:2391`；`packages/platform-node/src/strict-configuration.ts:1045`
- 问题：配置解析使用 `APPLE_PUSH_SECRET_PURPOSE`，启动组装却写死 `purpose === "apple-push"`。如果常量以后改名，解析会接受新用途，但 `service-main` 找不到 secret，结果是 Apple push 被静默关闭而不是启动失败。
- 证据：

```ts
// service-main.ts:2391
ref === applePushConfiguration.secretRef && purpose === "apple-push",
```

- 建议：改用并导入 `APPLE_PUSH_SECRET_PURPOSE`；配置存在但找不到对应 secret 时启动失败或至少记错误诊断。

## 推测（未运行/未复现）

- `packages/platform-node/src/apple-push-sender.ts:107` 的 `connect(origins[environment])` 没有连接超时。若 DNS/TCP 连接黑洞，`stream.setTimeout` 是否能在连接建立前生效我没有核实；建议补连接超时，避免 `maintain` 长期悬挂。
- 第 3 条内存增长的严重程度取决于是否有大量并发长运行；代码路径可证实，但未实际复现流量。
- 第 4 条的触发依赖 Apple 侧 store 抛错；控制流可证实，实际发生频率未复现。

## 侧重检查

- 不可信输入：`/push/register`、`/feedback`、`/companions`、`/approvals/respond` 均在 `DevicePushService` 中校验字段、长度、格式和允许列表；`takeAction` 在消费前拒绝未知动作；`linkCompanion` 同时校验设备种类和归属。未发现明显输入校验漏洞。
- 错误路径：APNs 410/400/413/429/5xx 分类存在；发送器内部把网络异常折成 `retry`；移除设备的 prepare/wipe 抛错会被接住。问题是限流无限重试、更新无退避、Apple 失败阻断网页推送。
- 不可撤销操作：吊销现在即使清除推送准备或发送失败也照样完成，符合“尽力送达”的设计；设备本地数据在收不到 wipe 时只能依赖下次联网收到 `DEVICE_REVOKED` 后自清。该取舍已写进设计说明，未发现回滚或重复吊销问题。
- 安全：APNs 目标主机固定为开发/正式两个域名；token、topic、environment、locale 都过校验；只存动作凭据的 SHA-256；日志只记错误码，不记密钥或 token。未发现新增泄露点。
- 资源耗尽：见发现 1、2、3。
- 文档一致性：清除推送的“移除成功后才发、被拒不发”已一致；实时活动登记上限说明与代码一致；限流重试说明与代码不一致。
- 规则文件与代码：`prompt-prefix.md`、`incidents-and-gates.md` 未被本 PR 修改；改动文件中没有提示词、工具定义、历史组装或遮盖代码。

## 作者说法核对

1. “开始重试有限流 60 秒、临时错误 1/5/15 分钟、再失败不再试”：临时错误部分成立；限流部分不成立（无限 60 秒）。**与代码/设计说明不一致。**
2. “清理不再看主人是否在看，清掉已结束运行和设备键；`#activitySent` 也删；没有专门用例”：代码相符，确实没有专门用例。
3. “设计说明两处改成移除成功后才发；补了登记上限、重试间隔”：文字已改；但重试间隔说明与限流实现不一致。
4. “`issueActionTokens` 删除带 `owner_id`、`agent_id`，走现有索引”：相符，`notification_action_tokens_source_index` 正是 `(owner_id, agent_id, source_key, device_id)`。
5. “未知动作在 `takeAction` 消费前拒绝，路由判断删了”：相符，代码确实先读后校验再消费。
6. “`revoke` 的准备和发送抛错都接住，组装层报 `onDevicePushFailed`”：相符；新增测试只验证吊销成功，未验证上报。
7. “配置测试补 0 和 65 拒绝用例”：相符。

## 必答问题

1. **会不会改变模型已经见过的请求开头？** 不会。本次 diff 不涉及系统提示、工具定义、历史消息、遮盖或模型出口代码；改动都在推送、配置、迁移、导出、设备和文档。就本次改动面而言，发给模型的内容没有被改写，“只在末尾追加”的性质不受影响。既有的请求组装器我没有逐行重审，标“未核实（与本次 diff 无关）”。
2. **同一段文字会不会在不同请求里变成不同字节？** 模型侧不会：没有改模型文本序列化。推送侧确实有随时间和随机值变化的字段（如 Live Activity 的 `timestamp`、一次性按钮凭据），这是推送协议要求，不属于模型 KV 缓存规则约束的“同一段文字”。数据库列表顺序和 `homeDigest` 的排序仍是确定的。
3. **有没有对应自动检查，反向用例真的会失败？** 有部分覆盖，但有缺口：
   - 开始重试间隔：`push-channels.test.ts:799` 覆盖了临时错误 60 秒内不重发；按旧代码（失败后不登记、每 tick 重发）该用例会失败，反向有效。
   - 限流 429、连续三次失败后停止：没有用例。
   - `#activityStarts` / `#activitySent` 清理：没有用例，既无正向也无反向。
   - 未知动作拒绝：没有用例；现有测试只覆盖“token 不存在”。
   - 吊销 prepare/wipe 失败：`notification-actions.test.ts:636` 覆盖，旧代码会抛错，反向有效；但没有断言 `onDevicePushFailed` 被调用。
   - 配置 0/65：有用例；去掉边界校验会失败。
   - 数据导出反向：有用例，插入推送凭据并断言不出现在导出文件、导入后表为空。
4. **每个新值的生产者和消费者是否互相接受？** 主要值已核对：
   - `apns_registrations.id`：生成 `apn_` + 22 字符，数据库 CHECK 长度 26、前缀 `apn_`，一致。
   - `token`/`environment`/`locale`/`topic` 基础格式、`activityRef`：`DevicePushService` 与 `saveRegistration` 两端都有校验。
   - `notification_action_tokens.action`：生产端限制在 `NOTIFICATION_ACTIONS`；消费端 `takeAction` 再查白名单；路由当前只接受 `approve`/`deny` 语义，未来扩展需改三元表达式（见发现 5）。
   - `channel`/`push_type`：`routeOutbox` 产生 `apns`，迁移和 `recordAttempt` 的 CHECK 接受；迁移测试覆盖。
   - `liveActivityRegistrationsPerDevice`：生产端 1..64，消费端只校验下限（见发现 6）。
   - `apple-push` secret 用途：当前两端字符串相同，但一处常量一处字面量（见发现 7）。

**未核实：** 我未运行 `npm run check`、`npm run build` 或任何测试；上述“旧代码会失败”为读 diff 与代码推断。
