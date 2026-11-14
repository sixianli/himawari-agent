本轮只审 `f95ed4b..11a6ca4` 的增量，并沿增量指向的旧代码核对了消费端。未运行测试（工具限制）。上一轮原始记录文件被工具拒绝读取，以下按你提供的摘要核对。

### 1. 中 — 读取上限提到 200 后，积压时会一次入队最多 200 条同文、互不合并的提议通知

文件：`apps/agent-service/src/service-main.ts:2839-2844`、`apps/agent-service/src/production-web-push.ts:35,131-133,430-440`

问题：`limit: 200` 会在一个 tick 内把最多 200 个待处理提议全部入队；每条 `sourceKey` 都含 `proposal.id:proposedAt`，`webPushTopic` 和 APNs 的 `collapseId` 也由它生成，因此每条通知的 tag/collapse-id 都不同，推送服务和 iOS 无法把它们合并成一条。`SEND_BATCH` 只有 50，所以会分几个 tick 连续发出最多 200 条“有一条建议等你看”。默认 `pendingLimit` 是 20，但配置允许到 200，所以这是可达路径。

证据：

```ts
// service-main.ts:2839-2843
await pushRepository.ownerProposals().listPending({
  ownerId: configuration.ownerId,
  agentId: configuration.agentId,
  now,
  limit: 200,
})
// production-web-push.ts:434
sourceKey: `proposal:${proposal.id}:${proposal.proposedAt}`,
// production-web-push.ts:131-132
return createHash("sha256").update(sourceKey).digest().subarray(0, 24).toString("base64url");
// production-web-push.ts:35
const SEND_BATCH = 50;
```

建议：读取 200 条可以保留，但发送端应聚合或限量。例如同一窗口只发一条“有 N 条建议等你看”，或给所有提议共用可替换的 tag 并另外保存每条提议的反馈映射；至少应对单轮/单窗口的提议通知条数设上限。

### 2. 低 — 24 小时窗口的“反向用例”实际测不到窗口过滤被删掉

文件：`test/integration/push-channels.test.ts:994-1003`、`apps/agent-service/src/production-web-push.ts:439,536-538`

问题：测试用 `proposedAt = T0 - 90_000 秒`（超过 24 小时）断言不发通知。但入队时 `expiresAt` 也是 `proposedAt + 24h`，即使删掉 `#readyProposals` 里的 24 小时过滤，这个 item 也会在 `#deliver` 的过期分支被记为 `expired`，通知仍然不会发出。该测试不能区分“窗口过滤存在”和“窗口过滤被删除”。

证据：

```ts
// production-web-push.ts:439
expiresAt: new Date(Date.parse(proposal.proposedAt) + PROPOSAL_WINDOW_MS).toISOString(),
// production-web-push.ts:536-538
if (Date.parse(now) >= Date.parse(item.expiresAt)) {
  await this.#record(entry, now, "expired", null);
  continue;
}
// push-channels.test.ts:994-1003
const proposals = [{ id: "old", proposedAt: at(T0, -90_000) }];
...
expect(context.apns.ofType("alert")).toEqual([]);
```

建议：反向用例应直接断言该提议没有被写进 outbox、或断言 `store.enqueue` 收到的 `items` 不含它；只断言“没有 alert”不足以覆盖窗口过滤。

### 3. 低 — 仍保留一条永远成立的断言，去重和网页通道端到端仍未断言

文件：`test/integration/push-channels.test.ts:975-992`

问题：上轮 ds-6 提到的问题没有完全改掉。测试仍保留 `expect(context.awaiting.calls).toBeGreaterThanOrEqual(0)`；这个断言对任何实现都成立。测试调用两次 tick 后只解构 `const [alert]`，没有断言 `toHaveLength(1)`，所以没有验证“同一份提议只发一次”。虽然订阅了网页设备，但没有断言 `context.webRequests` 或网页 payload 的 `silent`。

证据：

```ts
await context.subscribe("laptop");
...
await context.push.tick();
await context.push.tick();
const [alert] = context.apns.ofType("alert");
...
expect(context.awaiting.calls).toBeGreaterThanOrEqual(0);
```

建议：两次 tick 后断言 `ofType("alert")` 长度为 1；对网页通道断言 `webRequests` 条数并解密/检查 payload 的 `silent === true`；把永远成立的断言换成具体期望（例如提议通知不读取角标计数，或角标为 0）。

### 4. 低 — 200 是重复的魔法数，没有和 `PENDING_PROPOSAL_CEILING` / `MAX_LISTED` 绑定

文件：`apps/agent-service/src/service-main.ts:2843`、`apps/agent-service/src/production-proposals.ts:17`、`packages/persistence-sqlite/src/sqlite-owner-proposal-operations.ts:13`

问题：三个地方各自硬编码 200，目前恰好一致，但不是同一来源。以后任何一处调整都会出现“读取上限”和“写入上限”不一致，重新引入 ds-3。

证据：

```ts
// production-proposals.ts:17
const PENDING_PROPOSAL_CEILING = 200;
// sqlite-owner-proposal-operations.ts:13
const MAX_LISTED = 200;
// service-main.ts:2843
limit: 200,
```

建议：导出一个共享常量（例如 `PENDING_PROPOSAL_CEILING`），并让 SQLite 的 `MAX_LISTED` 与配置校验共用它；至少由 `service-main` 从同一常量取值。

### 5. 低 — 提议通知仍不受“不推送时段”约束，`silent` 只在支持该非标准选项的浏览器上有效

文件：`docs/execution/specs/2026-11-11-apple-device-body-design.md:489`、`docs/execution/plans/2026-11-11-apple-device-body-plan.md:163`、`apps/control-center/public/sw.js:20`、`packages/application/src/services/web-push-gate.ts:18-22`、`packages/application/src/rules/rule-types.ts:292-293`

问题：ds-1 的“文档承诺延后、代码做不到”已经通过改文档解决，代码与文档现在一致：`PUSH_QUIET_CLASSES` 不含 `proposal`，规则表达式也带 `push_class in [...]`，所以提议不会被延后。但残余风险仍在：在午夜收到提议时，网页端依赖 `silent`，而不支持该选项的浏览器仍可能发声/震动；`silent` 只在自有 Service Worker 的这一条路径上生效。

证据：

```ts
// rule-types.ts:292-293
return `push_class in ${celStringList(parameters.classes)} && (${quietHoursExpression(parameters.periods)})`;
// web-push-gate.ts:18-22
export const PUSH_RULE_PROTECTED_CLASSES: readonly PushClass[] = Object.freeze([
  "approval",
  "muse_outage",
  "unknown",
]);
// sw.js:20
silent: notification.silent === true,
```

建议：如果目标是“夜间绝不打扰”，应在服务端对提议通知也应用静默时段（或至少在未确认浏览器支持 `silent` 时默认延后），而不是只依赖网页侧的 `silent`。若维持现状，保留文档中“浏览器是否真静音未核实”的说明即可。

### 6. 低（推测）— `listReady` 同步抛错会绕过 `ok:false` 路径，导致整轮通知中断

文件：`apps/agent-service/src/production-web-push.ts:465-484`

问题：`#readyProposals` 用 `.then(onFulfilled, onRejected)` 处理拒绝。如果某个 `ProposalPushSource` 实现是同步抛错（接口只约定返回 Promise，不禁止同步抛），`source.listReady(now)` 会在创建 `result` 之前抛出，缓存不会建立，异常直接冲出 `#collect`，当前 tick 的 `#deliver` 完全不执行。当前生产实现是 `async` 函数，所以不会触发。

证据：

```ts
const result: Promise<ProposalRead> = source
  ? source.listReady(now).then(
      (rows) => ({ ok: true as const, rows: ... }),
      (error: unknown) => { this.#options.onFailure(error); return { ok: false as const, rows: [] }; },
    )
  : Promise.resolve({ ok: true as const, rows: [] });
```

建议：用 `Promise.resolve().then(() => source.listReady(now))` 包一层，或显式 `try/catch`，把同步抛错也归入 `ok:false`；这样“提议读取失败不影响其他通知”的保证不依赖实现细节。

### 7. 低（推测）— 缓存以 `now` 为键；两个 tick 共用同一 `now` 时，一次读取失败不会重试

文件：`apps/agent-service/src/production-web-push.ts:463-482`

问题：缓存只在 `this.#proposalRead?.now === now` 时失效。生产时钟是毫秒级、默认 10 秒一轮，实际上不会重复；但如果时钟冻结、回拨，或测试/嵌入环境传入固定 `now`，一次瞬时读取失败会一直复用失败结果，新提议在该时间段内不会被发现。

证据：

```ts
#proposalRead: { readonly now: string; readonly result: Promise<ProposalRead> } | undefined;
...
if (this.#proposalRead?.now === now) return this.#proposalRead.result;
...
this.#proposalRead = { now, result };
```

建议：按“本轮 tick”而不是按 `now` 失效（例如在 `#run` 开头清空），或使用递增的 tick 序号作为键。这样既保留“每 tick 只读一次”，也避免固定时钟下的永久缓存。

**上一轮意见逐条核对**

- ds-1：已按范围解决。文档改为“提议通知不受不推送时段延后”，与 `PUSH_QUIET_CLASSES` / 规则表达式一致；但功能本身仍未延后，若原需求要求延后，则仍未实现。
- ds-2：已修好。读取失败返回 `ok:false`，`#content` 只在 `pending.ok` 为真时判断过期；入队后读取失败仍会发送。缓存使同一 tick 只上报一次。残余风险是“读取失败时无法确认提议是否已被撤销/接受，仍会发出通知”。
- ds-3：已修好。`limit: 200` 能被 SQLite 的 `MAX_LISTED=200` 接受，也覆盖配置允许的最大 `pendingLimit=200`；但有重复魔法数问题（见意见 4）。
- ds-4：已修好。网页 payload 加 `silent`，Service Worker 以 `notification.silent === true` 传给 `showNotification`，测试覆盖 true/false/字符串三种值；浏览器和系统是否真静音未核实。
- ds-5：已修好。`#proposalRead` 让同一 tick 只查一次，`#content` 复用结果。
- ds-6：部分修好。补了网页 payload、Service Worker、读取失败、入队后失败发送的用例；但仍有永远成立的断言，未见去重断言，且 24 小时反向用例不能测出过滤被删（见意见 2、3）。

**侧重检查**

- 错误路径：读取失败已从“永久 expired”改为“保留已入队并发送”，且失败每 tick 只上报一次；同步抛错是未覆盖的边界（意见 6）。
- 不可信/不合规输入：提议 id 由 SQLite 的正则约束为 `类型:32位十六进制`，`proposedAt` 是 ISO 时间；长度远小于 outbox 的 256 字节上限，`assertItem` 能接受。非法 `proposedAt` 会在 `Date.parse` 比较中为 `NaN` 而被过滤，不会发出。
- 安全：提议通知文字固定、不含提议摘要，`navigate` 指向配置的 `publicOrigin`，没有把提议内容或敏感字段放进 payload。
- 资源：同一 tick 只做一次 `listPending` 写事务，比上轮改善；但 200 条提议会形成通知突发（意见 1），且每 10 秒一次读取即使没有提议也会查库。
- 不可撤销操作：本增量没有删除、撤销、批量改写用户数据的操作；发送失败按既有重试/记录路径处理。
- 文档一致性：新的 spec/plan 与 `PUSH_QUIET_CLASSES`、`push_class in [...]` 规则一致；未发现“文档说会延后、代码不会”的矛盾。旧的 `docs/execution/specs/2026-10-26-web-push-design.md:144-156` payload 示例未列出 `silent`，但那是示例而非穷举，不构成直接矛盾。

**必答问题**

1. 不改变模型已见过的请求开头。本轮改动只涉及推送投递、Service Worker、文档和测试，没有碰系统提示、工具定义、历史消息或遮盖；也没有修改发给模型的工具说明。未来扩展静默规则类型会改工具说明，但不在本次 diff 中。因此“只在末尾追加、每轮变化的值只在最后一条消息”这一约束不受影响。
2. 不会让同一段文字在不同请求里变成不同字节。新增的 `silent` 是确定性布尔值；提议的 `sourceKey`/tag 由 `proposal.id:proposedAt` 决定，同一提议稳定；待处理列表按 `proposed_at, id` 固定排序；没有依赖前后文的遮盖、带当前时间的字段或无序集合进入通知内容。
3. 有自动检查，但覆盖不完整。新增的 APNs 静音提议、超过 24 小时不发送、提议源抛错不影响其他通知、入队后读取失败仍发送、网页 payload `silent`、Service Worker `silent` 用例都有反向意义；但 24 小时过滤的反向用例实际测不到过滤（意见 2），去重没有断言，仍有一条永远成立的断言（意见 3），失败次数断言允许 2 次，不能证明“每 tick 只报一次”。测试是否实际通过、是否 56 步/25 条/98 条，未核实。
4. 增量的值逐个核对了使用端，未发现 I-73 式的不匹配：
   - `limit: 200` → `OwnerProposalStorePort.listPending` → SQLite 将上限夹到 `MAX_LISTED=200`，配置校验也允许 1..200，能接受；但存在重复常量问题。
   - `silent: true` → 只被 `apps/control-center/public/sw.js:20` 读取，判断 `=== true`，类型和字段位置一致；测试也覆盖 `"true"` 字符串不会被误判。
   - `quiet` → 同时用于 `webPushPayload`（转成 `silent`）和 APNs（`passive`、无声音/角标），两端都能接受。
   - `ProposalRead.ok/rows` → 只在 `#collect`/`#content` 内部使用，语义一致。
   - `proposal:${id}:${proposedAt}` → outbox `assertItem` 接受 `kind: "reminder"`、长度合规；`pushClassOf` 返回 `proposal`，规则类型校验又把 `proposal` 排除在可配置类别外，和“文档说不延后”一致。
   - 文档更新后的“不延后”说法与代码一致。

**本轮查过的范围**

增量文件：`apps/agent-service/src/production-web-push.ts`、`apps/agent-service/src/service-main.ts`、`apps/control-center/public/sw.js`、`docs/execution/{specs,plans}/2026-11-11-apple-device-body-*`、`test/integration/push-channels.test.ts`、`test/integration/service-worker-feedback.test.ts`。沿线索追查：`packages/application/src/ports/owner-proposals.ts`、`packages/persistence-sqlite/src/sqlite-owner-proposal-operations.ts`、`packages/platform-node/src/strict-configuration.ts`、`apps/agent-service/src/production-proposals.ts`、`packages/application/src/services/web-push-gate.ts`、`packages/application/src/rules/rule-types.ts`、`test/integration/web-push-sender.test.ts`、`docs/execution/specs/2026-10-26-web-push-design.md`。

未核实：测试是否真的通过及具体条数；浏览器/iOS 是否支持 `showNotification` 的 `silent`；旧 Service Worker 缓存未更新时的实际行为；上一轮原始记录文件（`git show` 被工具拒绝，只能按摘要核对）。
