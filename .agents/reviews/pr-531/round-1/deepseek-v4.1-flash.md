## 复核结论

### 1. 高 — 新增的 `proposal` 推送类别没有接进“不推送时段”规则路径，文档承诺的“可被延后”实际做不到

文件: `packages/application/src/services/web-push-gate.ts:7-22`、`packages/application/src/rules/rule-types.ts:47,270-279`、`apps/agent-service/src/production-owner-rules.ts:331-336`、`packages/application/src/rules/field-catalog.ts:87-93`、`docs/execution/specs/2026-11-11-apple-device-body-design.md:489`

问题: `proposal` 已加入 `PUSH_CLASSES`，也不在 `PUSH_RULE_PROTECTED_CLASSES` 里，`PushGate` 本身可以处理它；但主人/模型能创建的 `push_quiet_hours` 规则只接受 `PUSH_QUIET_CLASSES` 里的三个类别，`parsePushQuiet` 会拒绝 `proposal`，工具 schema 的 enum 和字段说明也都没有它。因此正常路径下没有任何规则能匹配 `push_class == "proposal"`，提议推送永远不会被不推送时段延后，和文档“推送门可以按主人定的不推送时段延后它”不一致。

证据（读代码证实）:
```ts
// web-push-gate.ts:7-22
export const PUSH_CLASSES = [..., "proposal", ...];
export const PUSH_RULE_PROTECTED_CLASSES = Object.freeze(["approval","muse_outage","unknown"]);
// web-push-gate.ts:36
if (input.sourceKey.startsWith("proposal:")) return "proposal";
```
```ts
// rule-types.ts:47,270-279
export const PUSH_QUIET_CLASSES = ["scheduled_reminder", "run_result", "mail_reminder"] as const;
...
!rawClasses.every((item) => (PUSH_QUIET_CLASSES as readonly unknown[]).includes(item))
  invalid(`classes 只能从 ${PUSH_QUIET_CLASSES.join("、")} 里选`);
```
```ts
// production-owner-rules.ts:331-336
classes: { type: "array", items: { type: "string", enum: [...PUSH_QUIET_CLASSES] }, ... }
```
```md
文档:489  它属于提醒这一类的开关，推送门可以按主人定的不推送时段延后它。
```
建议: 二选一，并同步测试。若要支持延后：把 `proposal` 加进 `PUSH_QUIET_CLASSES`，同时改 `parsePushQuiet` 的数量上限、`production-owner-rules` 的 enum、`field-catalog` 说明和 `packages/prompt-catalog/src/tools.ts` 的规则说明，并补一条 `pushClassOf`/`PushGate` 测试。注意这会让工具定义/提示词文字变化，属于模型可见内容变化，必须按 `prompt-prefix.md` 的冻结/换新规则处理，不能顺手改。若不支持：删掉文档里的延后承诺，明确提议推送不走不推送时段。

### 2. 高 — 读取提议失败会把已入队的提议永久记成 `expired`，且失败会重复上报

文件: `apps/agent-service/src/production-web-push.ts:457-469,518-523,630-638`、`packages/persistence-sqlite/src/sqlite-web-push-operations.ts:271-276,336-341`

问题: `#content` 会再次调用 `#readyProposals` 判断提议是否仍待处理；`#readyProposals` 把任何读取异常吞掉并返回空数组，于是 `#content` 把“读取失败”误当成“提议已不存在”，返回 `{expired:true}`，`#deliver` 随后把该条 outbox 记成 `expired`。outbox 入队是 `ON CONFLICT DO NOTHING`，`listDue` 又只接受 `attempt.status = 'pending'`，所以之后不会重新入队、也不会再发——一次瞬时读库失败就永久丢掉这条提议通知。此外 `#collect` 调一次、`#content` 每条提议再调一次，`onFailure` 会被重复调用，和“上报一次”的说法不符。

证据（读代码证实）:
```ts
// production-web-push.ts:457-469
try {
  return (await this.#options.proposals.listReady(now)).filter(...);
} catch (error) {
  this.#options.onFailure(error);
  return [];
}
```
```ts
// production-web-push.ts:630-638
const pending = await this.#readyProposals(now);
if (!pending.some(({id, proposedAt}) => ...)) return { expired: true };
```
```ts
// sqlite-web-push-operations.ts:271-276
INSERT INTO web_push_outbox (...) VALUES (...)
ON CONFLICT (owner_id, agent_id, source_key) DO NOTHING
// :339-340
AND (a.status IS NULL OR (a.status = 'pending' AND ...))
```
建议: 把“读取失败”和“提议不再待处理”分开：读取失败时应保留条目等下一轮重试，不写 `expired`；可以在本轮缓存一次 `listReady` 结果传进 `#content`，失败时让条目保持 pending 或可重试状态。补一条反向用例：先让提议入队，下一轮 `listReady` 抛错，断言不会记成 `expired`、恢复后仍能送达。失败上报也应每个 tick 只报一次。

### 3. 中 — 硬编码 `limit: 20` 与可配置的待处理提议上限不一致，超过 20 条的提议可能一直收不到通知

文件: `apps/agent-service/src/service-main.ts:2836-2845`、`apps/agent-service/src/production-proposals.ts:15,285-289`、`packages/persistence-sqlite/src/sqlite-owner-proposal-operations.ts:274-280`、`apps/agent-service/src/production-web-push.ts:424-434,457-464`

问题: 提议的待处理上限是可配置的（默认 20，最大到 200），但新的推送来源把 `limit` 写死成 20。`listPending` 按 `proposed_at, id` 升序取前 20 条；如果配置允许超过 20 条，第 21 条以后永远不会进入推送来源。更糟的是 24 小时过滤发生在取 20 条之后：若最老的 20 条都已超过 24 小时，它们会占满结果并被过滤掉，仍在 24 小时窗口内的较新提议根本看不到。

证据（读代码证实）:
```ts
// service-main.ts:2839-2844
await pushRepository.ownerProposals().listPending({
  ownerId: ..., agentId: ..., now, limit: 20,
})
```
```ts
// production-proposals.ts:15,285-289
export const PENDING_PROPOSAL_LIMIT = 20;
...
return (this.#options.configuration.runPolicy?.ownerProposals?.pendingLimit ?? PENDING_PROPOSAL_LIMIT);
```
```ts
// sqlite-owner-proposal-operations.ts:274-280
SELECT ... FROM owner_proposals
WHERE ... AND status = 'pending'
ORDER BY proposed_at, id LIMIT ?
```
建议: 用配置的 `pendingLimit`（或 `PENDING_PROPOSAL_CEILING`）作为上限，并在 SQL 里先按时间窗口过滤，或分页取够。补一条“配置上限大于 20、存在 20 条过期提议和一条新提议”的用例。

### 4. 中 — 网页推送仍会响/震，文档把可改的自有负载说成“标准格式没有静音字段”

文件: `apps/agent-service/src/production-web-push.ts:145-157,630-648`、`apps/control-center/public/sw.js:16-23`、`docs/execution/plans/2026-11-11-apple-device-body-plan.md:163`

问题: `quiet` 只对苹果 payload 生效；`webPushPayload` 没有输出任何静音字段，`sw.js` 调 `showNotification` 时也没有传 `silent`，所以网页通道仍是普通提醒（可能响/震）。作者材料只声称“网页推送无角标”，代码确实做到了；但 Andy 的总要求是“不响不震”，网页这条没有实现。文档把原因写成“网页推送的标准格式里没有‘静音’字段”，但这个 payload 是本项目自定义的 `web_push: 8030`，且浏览器 `NotificationOptions` 本身有 `silent`（各浏览器支持情况需核实），所以这更像未做，而不是无法做。

证据（读代码证实）:
```ts
// production-web-push.ts:148-156
web_push: 8030,
notification: {
  title, body, navigate, lang, tag,
  ...(notification.badge > 0 ? { app_badge: String(notification.badge) } : {}),
}
```
```js
// public/sw.js:16-23
self.registration.showNotification(notification.title, {
  body: ..., lang: ..., tag: ..., icon: ..., badge: ..., data: ...
});
```
建议: 如果网页也必须不响：在 payload 增加例如 `silent: true`，`sw.js` 传给 `showNotification`，并对不支持 `silent` 的浏览器说明退化为普通提醒。若不打算做，文档应明确写“网页通道仍会响/震”，不要把它归因于标准不支持。浏览器兼容性属于未核实项。

### 5. 低 — 每个 tick 对每条已入队提议重复查询并开写事务

文件: `apps/agent-service/src/production-web-push.ts:457-469,529-534,630-638`、`packages/persistence-sqlite/src/sqlite-owner-proposal-operations.ts:272-273`

问题: `#content` 对每条 due 提议都调用一次 `#readyProposals`，而 `listPending` 内部每次都会开事务并执行 `expire` 的 UPDATE。`#deliver` 又是在判断 `deferred` 之前取内容，所以即使提议正被不推送时段延后，每个 tick 仍会为每条提议重复查询。20 条待处理提议时，每 10 秒约 20 次额外写事务；如果读取每次都失败，还会每条重复 `onFailure`。这不致命，但属于可避免的资源消耗和重复失败面。

证据（读代码证实）:
```ts
// production-web-push.ts:529-534
const content = await contentOf(item);
...
if (await this.#deferred(entry.item, ...)) continue;
```
```ts
// sqlite-owner-proposal-operations.ts:272-273
return this.database.transaction(() => {
  this.expire(input.ownerId, input.agentId, input.now);
```
建议: 每个 tick 只取一次待处理提议集合，传给 `#content`/`#deferred`；延后中的条目不必每轮重新验证。读取失败按 finding 2 的方式每 tick 只报一次。

### 6. 低 — 新增测试有一条永远成立的断言，且没覆盖网页通道、去重和“入队后读取失败”

文件: `test/integration/push-channels.test.ts:974-991,993-1024`

问题: 正向用例里 `expect(context.awaiting.calls).toBeGreaterThanOrEqual(0)` 永远为真；虽然 `subscribe("laptop")` 建了网页订阅，但没有断言网页请求数、网页 payload 里有没有 `app_badge`、有没有静音；也没有验证同一提议跨两个 tick 只发一次，以及“提议已入队后读取失败”这条错误路径。反向用例本身能抓到“去掉 24 小时过滤”和“去掉 try/catch”，但“旧提议不发送”在完全没有 proposal 实现时也会通过，必须和正向用例一起看。

证据（读代码证实）:
```ts
expect(context.awaiting.calls).toBeGreaterThanOrEqual(0);
```
```ts
await context.subscribe("laptop");
...
const [alert] = context.apns.ofType("alert");
```
建议: 改成有意义的断言（例如苹果侧不读角标计数，或明确说明苹果仍会读）；补网页请求和 payload 断言；加“同一提议跑两个 tick 仍只有一条”“提议已入队后 `listReady` 抛错不丢通知”“`pushClassOf` 对 `proposal:` 返回 proposal”的用例。

**读代码证实与推测的区分**

读代码证实：上述所有文件:行引用、`ON CONFLICT DO NOTHING`、`listDue` 的 pending 过滤、规则类别校验、硬编码 `limit: 20`、网页 payload 不含静音字段、测试断言内容。

未核实/推测：
- `npm run check` 56 步、push-channels 23 条通过：未运行，无法核实；23 条测试数量本身与文件中的 `it(` 数量一致。
- 浏览器 `NotificationOptions.silent` 的实际支持范围：未核实。
- 苹果手表是否镜像通知由系统设置决定：未核实，文档也这样写明。
- 是否存在通过导入手工规则表达式绕过 `PUSH_QUIET_CLASSES`、直接写 `push_class == "proposal"` 的路径：未核实。

**侧重检查**

- 错误路径：查了 `#readyProposals` 的 catch、`#content` 的 expired 分支、outbox 去重和 `listDue` 的 `attempt.status` 过滤，确认瞬时读取失败会永久丢通知（finding 2）。
- 不合规范/不可信输入：查了 `proposalId` 的 `PROPOSAL_ID` 正则（最长 65 字符）与 outbox `sourceKey`/`sourceRef` 256 字符上限，当前长度安全；`proposedAt` 非法值会被 `Date.parse` 过滤为不发送，未来时间会被当作未超过 24 小时。
- 安全：提议通知正文是固定通用文字，`navigate` 是站点根路径，`tag` 是来源键的 SHA-256 截断，不暴露提议编号或内容；未发现新增日志泄露提议正文。
- 资源耗尽：确认每个 tick 会对每条已入队提议重复开查询/写事务（finding 5），以及 `limit: 20` 的截断问题（finding 3）。
- 不可撤销操作：本次没有删除或覆盖数据的操作；但 `listPending` 会顺带把过期提议改成 `expired`（既有行为），而推送失败被记成 `expired` 后不可恢复（finding 2）。
- 规则/文档/代码一致性：发现“可被不推送时段延后”与规则类别校验不一致（finding 1），网页“静音”说明与代码/协议能力不一致（finding 4），“读取失败上报一次”与重复调用不一致（finding 2）。

**必答问题**

1. 不会。改动只在推送采集、出队和 APNs/Web Push payload 路径上，没有系统提示、工具定义、历史消息、遮盖或压缩的改动；diff 没有新增模型调用。因此模型看到的内容仍只在末尾追加，新的变化值（`now`、`proposedAt`）只进入推送出队/网络请求，不进入模型请求。注意：若按 finding 1 的修法把 `proposal` 加进规则类别，会改工具定义和提示词文字，那属于模型可见前缀变化，必须另按 `prompt-prefix.md` 的冻结/换新规则处理。

2. 不会造成“同一段文字在不同请求里变成不同字节”。提议标题/正文按语言是固定字符串；`sourceKey = proposal:<id>:<proposedAt>` 由数据库稳定值组成，`tag` 是它的确定性 SHA-256 截断；苹果 badge 被抑制，网页 badge 为 0。`createdAt: now` 每轮会变，但它不在模型请求里，且去重键不包含它。不同收件人语言不同会产生不同字节，这是既有的按语言行为，不是由前后文决定的遮盖/无序集合问题。

3. 只有部分自动检查。新增了正向用例、超过 24 小时不发送的反向用例、来源抛错不影响其他推送的反向用例；后两者在对应逻辑被删掉时确实会失败。但缺少：提议类别的 `pushClassOf`/不推送时段延后测试、同一提议只入队一次的测试、网页通道无角标的测试、已入队后读取失败的重试/不丢失测试。正向用例还有永远成立的断言，不能作为有效检查。

4. 不能对所有使用点回答“能接受”。逐项核对：
   - `proposal` 推送类别：`PUSH_CLASSES`、`PushGate` 接受；`PUSH_QUIET_CLASSES`、`parsePushQuiet`、`production-owner-rules` 的 enum、`field-catalog` 不接受 → finding 1。
   - `ProposalPushSource { id, proposedAt }`：与 `ownerProposals.listPending` 返回的 `proposalId/proposedAt` 类型一致，service-main 映射正确。
   - `sourceKey = proposal:<id>:<proposedAt>`：outbox 的 256 字符上限可接受（id 最长约 65，键最长约 99），`pushClassOf`、`#content`、topic/tag 都能处理。
   - `kind: "reminder"`：outbox 校验接受；苹果返回空 actions，网页也按 reminder 处理。
   - `quiet` 字段：`WebPushNotification` 和 `PushContent` 类型接受；苹果消费；网页 payload 完全忽略 → finding 4。
   - 三个语言的 `proposal`/`proposalBody`：`WebPushLocale` 三种语言都补齐。
   - `limit: 20`：和可配置的 `pendingLimit`（最大 200）不一致 → finding 3。
   - 24 小时窗口常量：采集过滤和 `expiresAt` 都使用同一个 `PROPOSAL_WINDOW_MS`，一致；但它与不推送时段延长的 `expiresAt` 可能冲突，且 #content 又按 `proposedAt` 重新检查，延后超过 24 小时的提议最终会被判过期，这一点在当前“不能延后”的现实下不会触发。
