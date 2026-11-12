# PR 443 第 2 轮复核

先说明：我读了增量 diff 和相关实现，未运行 `npm run check`、`npm run build` 或测试（环境不允许），作者声称的这些通过结果标为「未核实」。

## 问题（按严重度）

### 1. 中：设计说明书仍写着“移除之前先发清除推送”，与代码和计划相反
- 文件：`docs/execution/specs/2026-11-11-apple-device-body-design.md:184`、`:504`
- 问题：实现已改为“移除成功后才发”，计划文档也改了，但设计说明书两处仍写“吊销前/移除之前先发”。这是会误导后续实现和复核的文档与代码不一致，尤其涉及不可撤销的本地数据清除。
- 证据（亲读）：
  - `:184` “吊销前服务器先给它发一条“清掉本地数据”的推送”
  - `:504` “设备被移除时，它的推送令牌停用、按钮凭据删除；移除之前服务器先给它发一条“清掉本地数据”的后台推送。”
  - 代码相反：`packages/platform-node/src/paired-device-service.ts:279-285` 先 `await prepareRevoke`，再 `await store.revokeDevice`，成功后才 `await afterRevoke()`。
- 建议：把 `:184`、`:504` 改成“移除成功后才发，移除被拒不发”；顺带把 `test/integration/push-channels.test.ts:727` 的用例名“before it is revoked”改成“after it is revoked”。

### 2. 中：实时活动“开始”遇 retry/rate_limited 每 10 秒重试一次，没有退避
- 文件：`apps/agent-service/src/production-apple-push.ts:530-532`；`apps/agent-service/src/production-web-push.ts:17`、`:242-245`
- 问题：这次改成只有 retry/rate_limited 不记“已开始”，下一轮再试；但下一轮就是 `maintain` 的固定 10 秒 tick（`DEFAULT_INTERVAL_MS = 10_000`），没有像提醒推送那样的 60s/5min/15min 退避。苹果返回 `rate_limited` 时会被每 10 秒重试一次，而且每个 starter 设备 × 每个未完成运行都会各发一次，可能放大限流、白耗 APNs 请求。
- 证据（亲读）：
  ```ts
  if (result.kind !== "retry" && result.kind !== "rate_limited")
    this.#activityStarts.add(key);
  ```
  ```ts
  const DEFAULT_INTERVAL_MS = 10_000;
  ...
  this.#options.intervalMs ?? DEFAULT_INTERVAL_MS
  ```
  同时提醒推送路径有 `RETRY_DELAYS_MS = [60_000, 5*60_000, 15*60_000]`（`:27`），实时活动开始没有对应延迟。
- 建议：给每个 `(deviceId, runId)` 记一个下次可试时间，`rate_limited` 至少按 `RATE_LIMIT_DELAY_MS`（60s）退避，`retry` 也用递增延迟；或复用提醒路径的 `RETRY_DELAYS_MS`。

### 3. 低：登记上限的语义与名字/文档不一致（starter 不计入、且按 updated_at 算“最旧”）
- 文件：`packages/persistence-sqlite/src/sqlite-apple-push-operations.ts:215-225`；`test/integration/push-channels.test.ts:815-831`；`docs/execution/plans/2026-11-11-apple-device-body-plan.md:102`
- 问题：配置叫“每台设备最多保留几条实时活动登记”，但删除条件只针对 `activity_ref <> ''`，starter 登记（`activity_ref = ''`）永远保留。测试用 limit=2 得到 3 行 `["", "run-2", "run-3"]`，即实际最多是“limit 条按运行登记 + 1 条 starter”。另外“最旧的”实际按 `updated_at DESC` 保留，即最近更新者优先，而不是创建时间。
- 证据（亲读）：
  ```sql
  DELETE FROM apns_registrations
   WHERE device_id = ? AND push_type = 'liveactivity' AND activity_ref <> ''
     AND id NOT IN (
       SELECT id FROM apns_registrations
        WHERE device_id = ? AND push_type = 'liveactivity' AND activity_ref <> ''
        ORDER BY (id = ?) DESC, updated_at DESC, id DESC LIMIT ?)
  ```
  测试期望：`.toEqual(["", "run-2", "run-3"])`。
- 建议：要么把名字/文档改成“每台设备最多保留 N 条按运行的实时活动登记”，要么把 starter 一起计数；文档里把“最旧的”明确成“最久未更新的”。

### 4. 低：`#activityStarts` 的清理只在“没在看且有 starter 且未满一批”时执行，且没有自动测试
- 文件：`apps/agent-service/src/production-apple-push.ts:487`、`:534-538`
- 问题：清理被包在 `if (starters.length > 0 && !visible)` 内，且只有 `runs.length < ACTIVITY_BATCH` 才执行。当设备删掉 starter 登记、或长期有 ≥20 个未完成运行时，已结束运行对应的键不会被清掉。键还会保留已删除设备的旧键（只要对应 runId 仍在 `unfinished` 里），集合可能长期增长。
- 证据（亲读）：
  ```ts
  if (starters.length > 0 && !visible) {
    ...
    if (runs.length < ACTIVITY_BATCH) {
      const unfinished = new Set(runs.map(({ runId }) => runId));
      for (const key of this.#activityStarts)
        if (!unfinished.has(key.slice(key.indexOf("\n") + 1))) this.#activityStarts.delete(key);
    }
  }
  ```
- 说明：这是「推测」的内存增长风险；代码事实是清理条件确实受 `visible`/`starters`/批次长度三重限制。作者列的 6 条新用例里没有一条覆盖“已结束运行的键被清掉”；删掉这段清理现有用例（包括重试用例）不会失败。
- 建议：清理与 `visible`、`starters` 解耦，按每键记录的时间戳做有界淘汰；补一条“运行结束后键被清掉”的反向用例。

### 5. 低：新的按设备删除凭据语句用不到现有索引，可能全表扫
- 文件：`packages/persistence-sqlite/src/sqlite-apple-push-operations.ts:501-505`；`packages/persistence-sqlite/src/migrations/0095_apple_push.sql:53-54`
- 问题：删除条件是 `device_id = ? AND source_key = ? AND used_at IS NULL`，但索引前两列是 `owner_id, agent_id`，`source_key` 是第三列、`device_id` 是第四列，不能直接定位。每次审批通知重发都会扫一遍凭据表。
- 证据（亲读）：
  ```sql
  DELETE FROM notification_action_tokens
   WHERE device_id = ? AND source_key = ? AND used_at IS NULL
  ```
  ```sql
  CREATE INDEX notification_action_tokens_source_index
    ON notification_action_tokens(owner_id, agent_id, source_key, device_id);
  ```
- 说明：SQLite 是否退化到全表/全索引扫描是「推测」，但从索引列顺序看无法做等值 seek。
- 建议：删除条件补上 `owner_id = ? AND agent_id = ?`（这两个值 `input` 里已有），或增加 `(device_id, source_key, used_at)` 索引。

### 6. 低：`approvals/respond` 的新 410 检查不可达，且是在消费凭据之后才判断
- 文件：`packages/platform-node/src/device-api-routes.ts:725`、`:731-732`
- 问题：`NOTIFICATION_ACTIONS` 只有 `approve`/`deny`（`packages/application/src/ports/apple-push.ts:18`），`issueActionTokens` 写入时也按它校验（`sqlite-apple-push-operations.ts:492`），所以 `token.action !== "approve" && token.action !== "deny"` 走不到。若将来真的加入第三种动作，`takeAction` 会先把它标记为已用，然后这里返回 410，凭据白白消费掉。这条改动没有对应测试。
- 证据（亲读）：
  ```ts
  const token = await pushPort().takeAction({...});
  const approval = token.approval;
  if (approval === null || (token.action !== "approve" && token.action !== "deny"))
    throw new DevicePushError(DEVICE_PUSH_ERROR_CODES.ACTION_INVALID, 410);
  ```
- 建议：要么删掉这条冗余判断，要么把动作校验放进 `takeAction` 的消费事务之前（消费前拒绝），并为将来的动作显式 switch。设计说明书 `:495` 也写着动作名由代码校验、以后加动作不用改表，这里不要硬编码成只有两个。

### 7. 低：清除推送的“尽力而为”只靠组装层兜底，服务层会把发送失败变成移除失败
- 文件：`apps/agent-service/src/production-http-composition.ts:1184-1188`；`packages/platform-node/src/paired-device-service.ts:279-285`
- 问题：组装层用 `.catch(report)` 把 `prepareWipe`/`wipe` 的错误吞掉，但 `PairedDeviceService.revoke` 本身不隔离 `prepareRevoke`/`afterRevoke` 的异常。若 `onDevicePushFailed`（`report`）自己抛错（例如诊断日志写入失败），`prepareRevoke` 会在移除前失败，或 `afterRevoke` 在设备已成功移除后抛错，导致接口返回 500。
- 证据（亲读）：
  ```ts
  const report = (error: unknown) => options.onDevicePushFailed?.(error);
  const wipe = await options.webPush?.applePush?.prepareWipe(deviceId).catch(report);
  return wipe ? () => wipe().catch(report) : undefined;
  ```
  ```ts
  const afterRevoke = await this.#options.prepareRevoke?.(scope.deviceId);
  const device = await this.#options.store.revokeDevice({...});
  await afterRevoke?.();
  ```
- 说明：`onDevicePushFailed` 实际会不会抛是「推测」；代码事实是清除推送不是严格隔离的 best-effort。
- 建议：在 `PairedDeviceService.revoke` 内把 `prepareRevoke` 和 `afterRevoke` 都包一层 try/catch（或让 `report` 自己保证不抛），确保推送失败不影响移除结果。

### 8. 低：新配置键只有默认值测试，没有边界反向用例
- 文件：`packages/platform-node/test/startup-configuration.unit.test.ts:1467`、`:1476-1490`
- 问题：测试补了 `liveActivityRegistrationsPerDevice: 8` 的默认值断言，但拒绝用例里没有 `0`、`65`、`1.5` 等。虽然 `parseApplePush` 是按 `DEFAULTS`/`BOUNDS` 泛化解析的，代码上会拒绝，但这条新键没有自己的反向门槛。
- 建议：在 `:1476` 的列表里加 `{ ...base, liveActivityRegistrationsPerDevice: 0 }` 和 `{ ...base, liveActivityRegistrationsPerDevice: 65 }`。

## 侧重检查

- 不可撤销操作 / 错误路径：清除推送现在只在 `revokeDevice` 成功后执行（`paired-device-service.ts:279-285`），版本不对的 409 不会发（`test/integration/notification-actions.test.ts:401-413` 覆盖）。这修掉了上一版“移除失败也清设备”的危险行为。剩下的是上面的错误传播问题（第 7 条）。
- 不合规范/不可信输入：`push/register` 的 `pushType`/`activityRef`/`token`/`environment`/`topic`/`locale` 都在 `device-push.ts:120-161` 校验；`deviceId` 取自认证设备而非请求体；新的登记上限删除只作用于认证设备自己的 `device_id`。`approvals/respond` 的凭据格式、哈希、过期/已用/设备归属/配对手表判断都在 `sqlite-apple-push-operations.ts:535-603`。结论：没有发现跨设备/跨 owner 的越权路径。
- 资源耗尽：登记上限（第 3 条）确实把按运行的登记行数限制住了；但实时活动开始重试没有退避（第 2 条），`#activityStarts`/`#activitySent` 有长尾增长（第 4 条与下面的「推测」）。
- 安全：`issueActionTokens` 先删同设备同来源键的未用凭据，再写新凭据（`sqlite-apple-push-operations.ts:500-505`），并发的旧凭据只会失败，不会变成两套有效凭据；`consumeActionToken` 改成 `immediate` 且带 `used_at IS NULL` 条件更新，双点只有一次成功，符合设计 `:498`。
- 规则/文档一致性：计划文档已改，设计说明书 `:184`、`:504` 未改（第 1 条）；`:487` 的配置清单也没提新的每设备实时活动登记上限，`:491` 的“运行结束删掉那次的更新令牌”没有说明因上限被提前删掉的情况。

推测（未直接证实）：
- `#activitySent` 在被上限删除的非终态登记上会留下永久条目，长跑后会积累（键是 registration.id，删除登记后不会再被遍历）。
- 第 5 条的索引问题在实际数据量下是否真的明显变慢。
- 第 7 条中 `onDevicePushFailed` 实际抛错的概率。

## 必答问题

1. **会不会改变模型已经见过的请求开头？**
   不会。这个改动没有碰系统提示、工具定义、历史消息、遮盖或压缩的组装代码；新增的 `liveActivityRegistrationsPerDevice` 只进入 `ApplePushConfiguration`，供推送使用。系统提示身份的计算只哈希 `[HIMAWARI_IDENTITY, policy.systemInstruction, capabilities]`（`apps/agent-service/src/production-run-policy.ts:105-107`），`capabilities` 只取 `coding`/`fileRead`/`publicSearch`/`publicFetch`（同文件 `:70-101`），不包含 `applePush`。因此发送给模型的内容仍然只在末尾追加，本次改动也没有把任何每轮变化的值加进请求开头。结论：无影响。

2. **会不会让同一段文字在不同请求里变成不同字节？**
   对模型请求不会：没有改遮盖规则、没有改 JSON/列表排序、没有把时间或随机值放进提示。推送负载里确实有非确定值（提醒的按钮凭据是随机生成的、实时活动 `timestamp` 是当前秒），但这是推送协议本身已有的，与模型 KV 缓存无关；本次“重发时作废旧凭据”只是让同一审批第二次发送必然带不同 token，属于预期。数据库删除的排序有 `id DESC` 兜底，剪掉哪几行是确定的。结论：模型字节不受影响。

3. **有没有对应的自动检查，反向用例真的会失败吗？**
   有，且多数反向用例从代码推理会失败：
   - 移除顺序：`notification-actions.test.ts:401-413` 断言 409 时 `wiped` 为空、成功后 `wiped` 为 `[deviceId]`；若恢复“先发后移除”，409 时 `wiped` 非空会失败。
   - 两条事件流：`notification-actions.test.ts:594-628` 关闭一条后仍要求所有 presence 为 `visible=true`，最后一条关闭才出现 `false`；恢复旧的一关闭就报不在看会失败。
   - 重发作废旧凭据：`push-channels.test.ts:773-797` 要求数据库只剩第二次的两个 token；去掉删除会多出一对而失败。
   - 实时活动 503 后重试：`push-channels.test.ts:799-813` 要求总共 2 次发送；若在 retry 时就记“已开始”会只有 1 次而失败。
   - 登记上限：`push-channels.test.ts:815-831` 要求只剩 `["", "run-2", "run-3"]`；去掉删除会多出行而失败。
   - 长标题：`push-channels.test.ts:833-845` 要求 ≤4096 且标题以 `…` 结尾；去掉标题裁剪会失败。

   缺口：`#activityStarts` 的清理没有专门用例（第 4 条），新配置键没有越界用例（第 8 条），v2 `device.revoke` 的清除顺序没有直接测试（只靠共用 `PairedDeviceService` 推理），`approvals/respond` 的新 410 分支不可达也没测试。作者声称的 `npm run check`/`build`/218 条测试通过我未核实。

4. **改动产生/修改的每个值，使用它的地方都能接受吗？**
   - `liveActivityRegistrationsPerDevice`：生产端 `parseApplePush` 按 `APPLE_PUSH_CONFIGURATION_DEFAULTS`/`BOUNDS` 泛化读取（`strict-configuration.ts:1318-1325`、`:1355-1367`），默认 8、范围 1–64；消费端 `DevicePushService.register` 把它作为 `activityLimit` 传给 `saveRegistration`（`device-push.ts:169`），SQLite 端校验 `Number.isSafeInteger` 且 `>= 1`（`sqlite-apple-push-operations.ts:175-176`）。生产端能产出的值消费端全部接受；消费端更宽松（没有上限），不算不兼容。`rejectUnknown` 的允许键由 `Object.keys(DEFAULTS)` 生成，新键自动被允许。
   - `activityLimit`：只在 `saveRegistration` 内部使用，不落库、不进导出；所有调用点（`device-push.ts:162`、`test/integration/push-channels.test.ts:279`）都已带上；启动配置测试也更新了期望（`:1467`）。结论：两端一致。
   - `prepareRevoke`/`streamOpened` 等接口改动：`DevicePushPort` 只有 `DevicePushService` 一个实现，`beforeRevoke`/`presence` 已无残留引用；v2 `device.revoke`、设备管理接口都走同一个 `PairedDeviceService.revoke`（`production-device-control.ts:155-160`、`device-api-routes.ts:926-930`）。结论：调用方都能接受。
