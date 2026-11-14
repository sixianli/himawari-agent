**结论范围**：本轮核对了 `f2482cc4..37d6776b` 中与苹果推送相关的增量：`e55368942`（第 3 轮修复）、`c3f1150a1`（迁移改名）、`28f2cc4b2`（合入 PR 414 推送门）、`8bccf4141`、`9cb087175`、`33fa7a8d6`、`37d6776b7` 及其冲突结果中的 `production-apple-push.ts`、`production-web-push.ts`、`service-main.ts`、`production-http-composition.ts`、`apple-push.ts`、`sqlite-apple-push-operations.ts`、`sqlite-paired-device-operations.ts`、`sqlite-durable-operations.ts`、`migration-engine.ts`、苹果迁移、`device-push.ts`、`device-api-routes.ts`、`strict-configuration.ts`、相关测试和设计/计划文档。合并进来的 main 大体量代码（感知、用量上限等）只追到与推送接线、迁移顺序、撤销顺序、导出清单相关的点，没有整份重读。

### 1（中低）改掉已存在的迁移编号，会让应用过旧编号的库被 migration engine 拒绝启动
文件：`packages/persistence-sqlite/src/migrations/20261114154943_apple_push.sql`、`packages/persistence-sqlite/src/migration-engine.ts:981`

问题：`c3f1150a1` 把迁移从 `20261114151049_apple_push` 改名为 `20261114154943_apple_push`。迁移引擎按 `migration_id` 识别已应用迁移；已应用旧编号的库在新代码里找不到该 id，会直接报“未知迁移”，不会进入正常升级。

证据（读代码证实）：

```ts
// migration-engine.ts:981
const definition = definitions.get(record.id);
if (!definition) {
  throw new SqliteMigrationError(
    SQLITE_MIGRATION_ERROR_CODES.UNKNOWN_APPLIED_MIGRATION,
    `Database contains unknown migration ${record.sequence}`,
```

```ts
// migration-engine.ts:1106
const appliedIds = new Set(ledger.map((record) => record.id));
const pending = migrations.filter((migration) => !appliedIds.has(migration.id));
```

推测/条件成立：旧编号是这条分支自己引入的（`8aeba5f58` 的 `0095_apple_push.sql`，后来改成时间戳），PR 尚未合并，所以**生产大概没有应用过旧编号**；但作者在 `c3f1150a1` 的提交说明里写“production applies it after”，同时说明“A fresh database applied it before…”，这句话本身没有排除某些测试/预发库已按旧编号应用过。是否真存在这种库：**未核实**。如果存在，升级会因 `UNKNOWN_APPLIED_MIGRATION` 失败（可用性事故）。

建议：确认所有持久库的 `schema_migration_ledger.migration_id` 中不存在 `20261114151049`；若有，保留旧 id 并另加一条修正迁移，或在部署步骤中显式做一次受审计的 ledger 修复。不要在没有数据库清单的情况下直接改名。另建议给“迁移顺序/编号”本身加检查（现有 `apple-push-migration.contract.test.ts` 是按 `name` 找迁移，见下条）。

### 2（低）新增的“未知动作被拒”用例守不住本轮改的那行映射
文件：`packages/platform-node/src/device-api-routes.ts:1011`、`packages/platform-node/src/device-push.ts:198`

问题：本轮把路由里的三目表达式改成 `decisions[token.action]`，但新用例实际是在更早的 `DevicePushService.takeAction` 就被拒绝；把路由改回旧写法，用例仍然通过，因此它不是一个针对该改动的反向用例。

证据（读代码证实）：

```ts
// device-api-routes.ts:1011
const decisions = { approve: "approved", deny: "denied" } as const;
...
// device-api-routes.ts:1028
decision: decisions[token.action],
```

```ts
// device-push.ts:198
if (
  read.kind === "rejected" ||
  read.token.approval === null ||
  !(NOTIFICATION_ACTIONS as readonly string[]).includes(read.token.action)
)
  throw new DevicePushError(DEVICE_PUSH_ERROR_CODES.ACTION_INVALID, 410);
```

`test/integration/notification-actions.test.ts` 把库里的 action 改成 `'cancel'` 后请求 `approvals/respond`，在 `takeAction` 的上面这段就已返回 410，根本到不了 `decisions[token.action]`。

建议：要么把这行当作纯类型收窄并说明它没有独立行为，不必声称有反向测试；要么补一个直接经过路由层、能区分 `decisions` 映射的用例（例如用假 push port 直接返回带未知 action 的 token，断言路由拒绝而不是默认成 `denied`）。当前实现本身是安全的（未知动作不会变成“不同意”），问题在测试没有覆盖它。

### 3（低）实时活动“已开始”清理只处理前 500 条，且每 tick 最多做 500 次单行查询
文件：`apps/agent-service/src/production-apple-push.ts:513`、`packages/persistence-sqlite/src/sqlite-apple-push-operations.ts:665`

问题：`#activityStarts` 的清理从“整批 list 结果”改成“按记住的 key 回查运行状态”，但只取 `[...keys()].slice(0, ACTIVITY_READ_BATCH)`。如果同时有超过 500 条记录，前 500 条又都对应未结束的运行，那么第 501 条之后的记录永远不会被检查/删除；运行结束后也不会清理，map 会在长 uptime 中持续增长。同时 `readActivityRuns` 是逐 id 预处理语句循环，最多 500 次查询/tick。

证据（读代码证实）：

```ts
// production-apple-push.ts:33
const ACTIVITY_READ_BATCH = 500;
...
// production-apple-push.ts:513
const remembered = [...this.#activityStarts.keys()].slice(0, ACTIVITY_READ_BATCH);
const unfinished = new Set(
  (await store.readActivityRuns({
    ...this.#scope(),
    runIds: [...new Set(remembered.map((key) => key.slice(key.indexOf("\n") + 1)))],
  }))...
);
for (const key of remembered) { ... this.#activityStarts.delete(key); }
```

```ts
// sqlite-apple-push-operations.ts:665
private readActivityRuns(input: Input<"readActivityRuns">) {
  if (input.runIds.length > 500) this.fail(...);
  const read = this.database.prepare(`SELECT ... FROM runs WHERE ... id = ? ...`);
  return [...new Set(input.runIds)].flatMap((runId) => { ... read.get(...) ... });
}
```

证据（读代码证实）：`readActivityRuns` 的上限是 500，所以不会因超过 500 直接报错；但超过 500 的 `#activityStarts` 条目不会被 `remembered` 覆盖。

建议：改为一次查询取回所有待检查 run（按 owner/agent 和 run id 集合，或按状态分批游标），并让清理覆盖全部 key；或者在插入 `#activityStarts` 时就按设备/注册上限做容量约束，避免无界增长。这不影响第 3 轮已修复的“限流有上限”，属于资源侧的低风险问题。

### 4（低）存储层登记上限与主题长度后缀边界没有直接自动检查
文件：`packages/persistence-sqlite/src/sqlite-apple-push-operations.ts:176`、`packages/platform-node/test/startup-configuration.unit.test.ts:1546`

问题：本轮把存储层的 `activityLimit` 校验改成与配置同一组上下限，把主题上限压到 232（再加后缀不超过 255），但测试只覆盖了配置解析层，存储层和后缀拼接没有直接用例。

证据（读代码证实）：

```ts
// sqlite-apple-push-operations.ts:176
!Number.isSafeInteger(input.activityLimit) ||
input.activityLimit <
  APPLE_PUSH_CONFIGURATION_BOUNDS.liveActivityRegistrationsPerDevice.minimum ||
input.activityLimit >
  APPLE_PUSH_CONFIGURATION_BOUNDS.liveActivityRegistrationsPerDevice.maximum ||
```

```ts
// startup-configuration.unit.test.ts:1546
{ ...base, topics: [`w${"a".repeat(232)}`] },   // 233 字符，被拒
...
// startup-configuration.unit.test.ts:1554
{ ...base, liveActivityRegistrationsPerDevice: 65 },
```

我查到 `push-channels.test.ts` 只用了合法的 `liveActivityRegistrationsPerDevice: 8` 和 `2`；`apple-push-sender.test.ts` 只验证了普通 topic 和 `.push-type.*` 拼接，没有 232/233 边界用例。也就是说，如果把存储层校验退回 `< 1`，或者把后缀拼接改成超 255，现有测试未必会红。

建议：加一个直接调用 `applePush.saveRegistration`、传入 `activityLimit: 65` 的反向用例；再加 `applePushTopic("a"*232, "liveactivity")` 等于 255、233 字符被配置拒绝的边界用例。

**读代码证实的**：
- 第 3 轮 ds-1 已修：`production-apple-push.ts:564-572` 限流/临时错误都走 `RETRY_DELAYS_MS`，`attempts > 3` 时 `notBefore = Infinity`；`619-632` 更新/结束同样有 3 次重试上限；设计文档 `2026-11-11-apple-device-body-design.md` 已改成 start/update/end 都是 1/5/15 分钟并不再试。
- ds-4 已修：`production-web-push.ts:468-479` 对 `companion.deliver` 加了 `.catch(this.#options.onFailure)`，苹果侧抛错后继续执行后面的 web push `listDue` 循环。
- 推送门接线已生效：`production-apple-push.ts:277` `if (await input.deferred(item)) continue;`；`sqlite-apple-push-operations.ts:361-364` 的 `listDue` 已加 `o.defer_until IS NULL OR o.defer_until <= ?`；新增的“延后不发”和“放行即发”用例在 `push-channels.test.ts`。
- 主题 232 与后缀：`apple-push-sender.ts:26-33` 对 widgets 加 18 字符、liveactivity 加 23 字符；`232 + 23 = 255`，与 `APPLE_PUSH_TOPIC_PATTERN` 一致；迁移表 `topic` 约束允许 1..255。
- `APPLE_PUSH_CONFIGURATION_BOUNDS` 在配置解析（`strict-configuration.ts:1447-1448`）和存储层（`sqlite-apple-push-operations.ts:176-180`）两端都是 1..64；`device-push.ts:170` 直接传配置值。
- `APPLE_PUSH_SECRET_PURPOSE = "apple-push"`（`strict-configuration.ts:1081`）被 `service-main.ts:2642` 和配置校验 `strict-configuration.ts:2063` 使用，值一致。
- 当前迁移文件名 `20261114154943_apple_push` 晚于推送门 `20261114151105_web_push_gate`，且 `loadBundledMigrations` 按 id 排序（`migration-engine.ts:1353-1365`），全新库顺序已符合作者说明。
- 撤销设备顺序：`sqlite-paired-device-operations.ts:294-297` 先 `disablePushForRevokedDevices`，再删 `device_upload_grants`；`sqlite-durable-operations.ts:5115-5137` 同样先停推送、再删上传凭据。
- 导出清单：`data-export/export.ts` 已加“苹果推送令牌和通知按钮凭据不导出”；PR 的反向导出用例写入 `apns_registrations`/`notification_action_tokens` 后断言任何导出文件都不含这些值，导入后两表为空。
- `awaitingCount` 是 `ProductionWebPushOptions` 的必填项，6 个 `new ProductionWebPush(` 调用点都补了（`service-main.ts:2705` 及测试）。
- 客户端能力清单里 8 个 v2 id 在合并后仍在 `client-capabilities.ts` 和 `contracts-v2.ts` 中，生成的 Swift 表也有对应项。

**推测/未核实**：
- 是否有环境应用过旧迁移编号 `20261114151049`：未核实。
- 作者列出的 `npm run check` 55 步、`check:migration-conflicts`、各测试通过：本轮不能运行测试/构建，未核实；只核对了断言逻辑。
- 真机/真 APNs 行为：作者只说本机假 APNs 测过，代码如此；真实 APNs 的 255 字节主题上限、429/503 分类仍未真机核实。
- 合入的 main 大体量改动（感知、用量上限、home 等）是否与苹果推送存在更深交互：仅核对了推送、迁移、撤销、导出相关点，其余未核实。

**必答问题**

1. **会不会改变模型已经见过的请求开头？** 不涉及。这个 PR 的改动集中在苹果推送投递、凭据、设备路由、配置、迁移和导出；没有改 `packages/prompt-catalog`、系统提示、工具定义、历史消息、遮盖规则或冻结逻辑。按 `prompt-prefix.md` 的“只追加”规则，本次没有新增每轮会变的值到请求头，也没有改历史序列化。需要说明：`f2482..37d` 的合并范围里包含 main 对提示词目录的改动，但那是合并进来的 main 变更，不是这个苹果推送 PR 自身的行为；我没有把它当作本 PR 的改动逐条复核。结论：就本 PR 而言，发给模型的内容仍只在末尾追加，每轮会变的值仍应在最后一条消息里。

2. **同一段文字会不会在不同请求里变成不同字节？** 不涉及模型请求。PR 没有改模型请求的 JSON 键序、工具顺序、记忆顺序或遮盖算法。推送侧确实有随轮次变化的值（实时活动的 `timestamp`/`stale-date`、`badge` 角标、`awaitingCount`），但它们只进 APNs/Web Push 载荷，不进模型请求；`defer_rule_refs` 在 main 的存储层里做了排序，也不是模型内容。数据导出格式仍是 v3，未变。结论：没有发现本 PR 造成“同一段模型文字在不同请求里字节不同”。

3. **有没有对应的自动检查，反向用例是否真的会失败？** 有，但覆盖不齐：
   - 实时活动“开始”连续 429 恰好 4 次：`push-channels.test.ts` 新用例。按代码推理，若把限流仍当无限 60 秒重试，传输次数会超过 4，用例会失败。
   - 实时活动“更新”连续 503 恰好 4 次：同上，若去掉更新/结束的重试上限，会超过 4，用例会失败。
   - 苹果侧抛错时网页推送仍送出：新用例断言 `webRequests` 有一条并上报错误；若去掉 `.catch`，`tick` 在 companion 处 reject，网页推送循环不会执行，用例会失败。
   - 推送门延后不发：新用例在 gate 返回 defer 时断言两 tick 都没有 alert；若从苹果 `deliver` 去掉 `if (await input.deferred(item)) continue;`，第一 tick 就会发，用例会失败。放行即发的反向/正向对照用例存在，但它本身不能守住删除 defer 行（gate 放行时行为相同）。
   - 未知通知动作被拒且凭据不作废：用例会通过，但**去掉本轮改的 `decisions` 映射也不会失败**（见意见 2），因为 `DevicePushService.takeAction` 已先拒绝。
   - 存储层 `activityLimit` 上限、主题 232+后缀=255 的边界：**没有找到直接用例**（见意见 4）。
   - 迁移改名：`apple-push-migration.contract.test.ts` 按 `name === "apple_push"` 找迁移，改名后仍通过，不能守住编号变更；迁移顺序是否与生产一致也没有直接断言（`check:migration-conflicts` 未实际运行，未核实）。
   - 以上测试均未实际执行，只核对了断言与代码路径。

4. **每个产生/修改的值，两端是否都能接受？** 逐个核对结果：
   - `APPLE_PUSH_TOPIC_PATTERN`（最大 232）：配置解析、设备登记、SQLite 写入都用同一个正则；发送器加 `.push-type.widgets`（18）或 `.push-type.liveactivity`（23），232+23=255，符合 APNs 255 上限；DB 列允许 1..255。接受。
   - `APPLE_PUSH_CONFIGURATION_BOUNDS.liveActivityRegistrationsPerDevice`（1..64）：配置解析和 `saveRegistration` 两端一致；`device-push.ts` 直接传配置值。接受。
   - `APPLE_PUSH_SECRET_PURPOSE`（`"apple-push"`）：定义、配置校验、启动查找三处值一致。接受。
   - `decisions` 映射（`approve→approved`、`deny→denied`）：`takeAction` 先按 `NOTIFICATION_ACTIONS` 拒绝未知动作，已知动作都在映射里。接受，但测试没有覆盖这行（见意见 2）。
   - `deferUntil` 字段：`WebPushOutboxItem` 上是可选的，web push 和 Apple 的 `listDue` 都产出了它；`#deferred` 实际用的是 `createdAt/expiresAt`，没有依赖这个新字段。接受。
   - `badge` 由 `number` 改成 `() => Promise<number | undefined>` / 载荷里可选：`ProductionWebPush` 的两个调用处（Apple alert、web push）和 `applePushAlertPayload` 都按可选值处理。接受。
   - `awaitingCount`：所有 `ProductionWebPush` 构造点都补了；失败时 `#awaiting` 捕获并返回 `undefined`。接受。
   - `ACTIVITY_READ_BATCH = 500`：与 `readActivityRuns` 的 500 上限一致，不会因传入超限直接报错；但清理覆盖问题见意见 3。
   - 迁移 id：`2026...154943` 能被按 id 排序的加载器接受；风险在于已应用旧 id 的库，见意见 1。
   - 客户端能力 8 个 v2 id：合并后同时存在于 TS 清单、`contracts-v2.ts` schema 注册表和生成的 Swift 表。接受。

**侧重检查**
- 错误路径：检查了 `#transmit` 的异常转 `retry`、`#applyRegistrationOutcome` 对 `sent/gone` 的处理、`#updateActivities` 对 `retry/rate_limited/rejected/too_large/gone` 的分支，以及 `ProductionWebPush` 对 companion 抛错的捕获。未发现新的未捕获路径会阻断同一 tick 的网页推送；`maintain` 的异常仍在 web push 之后抛出，但 `tick()` 自身会 `.catch(onFailure)`，不会阻断后续 tick（读代码证实）。
- 不合规范/不可信输入：设备推送登记校验了 pushType/activityRef/token 模式/environment/topic 白名单/locale；主题长度已收紧到 232；通知动作 token 只存哈希，未知动作在 `takeAction` 拒绝且不消费；撤销设备会先停推送、删动作凭据，再删上传凭据。未发现本轮引入的输入校验缺口。
- 安全：一次性动作凭据的消费在 SQLite 里用 `UPDATE ... WHERE used_at IS NULL` 原子完成；需要主人在场的审批要求确认签名；撤销删除凭据。未发现新问题。
- 资源耗尽：实时活动重试已有次数上限；`#activityStarts` 的 500 条清理窗口和逐 id 查询是低风险遗留问题（意见 3）；`#activitySent`/`#activityRetries` 按注册清理，规模受注册数约束。
- 不可撤销操作：迁移改名是“不可逆”的部署操作，风险见意见 1；设备撤销顺序已核对正确。
- 规则/文档一致性：设计文档关于 start/update/end 重试和“苹果侧出错不影响网页推送”的表述与代码一致；计划文档关于“移除成功后才发清除推送”与 `PairedDeviceService.revoke` 的 `prepareRevoke → store.revokeDevice → afterRevoke` 顺序一致。
