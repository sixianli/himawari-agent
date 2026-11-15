本轮只核对 `05cf43c9..2f2949ed` 的增量：`mac-placement.ts`、`production-web-push.ts`、ADR 0273、`test/integration/push-channels.test.ts`，以及 `.agents` 下的复核记录（二进制，未读）。结论：上一轮意见 1 在“接收端不超过 4 个”时确实修好了；“多目标”这一半没有真正封死，因为代码里没有任何地方强制“最多 4 个接收端”。

### 1. 中 — 4 倍余量只是按“最多 4 个接收端”写死的假设，第 5 个接收端起新通知仍会被已放置项挤出待发表

**文件:行**：`apps/agent-service/src/production-web-push.ts:46-48, 545-548`；`apps/agent-service/src/mac-placement.ts:7, 47`；`packages/persistence-sqlite/src/sqlite-web-push-operations.ts:352-364`；`packages/persistence-sqlite/src/sqlite-apple-push-operations.ts:357-367`。

**问题**：`heldCount()` 是已放置通知的条数，而待发表的行数是“通知 × 接收端”。代码用固定的 4 倍来估算每条持有通知占用的行数，但没有任何代码把每个账号的 active 订阅/alert 注册限制在 4 个。接收端到 5 个时，100 条持有项产生 500 行，批次上限却只有 `50 + 4×100 = 450`；`listDue` 按创建时间排序并 `LIMIT 450`，前 450 行全是被 `holds()` 跳过的持有项行，新通知根本进不了本轮的待发表，直到最早的持有项到期或被撤回。

**证据**：
```ts
export const MAC_PLACEMENT_LIMIT = 100;
...
if (this.#placed.size >= MAC_PLACEMENT_LIMIT) return false;
```
```ts
const batch = Math.min(
  MAX_BATCH,
  SEND_BATCH + ROWS_PER_HELD_ITEM * (this.#options.placement?.heldCount() ?? 0),
);
```
```sql
FROM web_push_outbox o
JOIN web_push_subscriptions s ON s.owner_id = o.owner_id AND s.agent_id = o.agent_id
  AND s.state = 'active'
...
LIMIT ?
```
```sql
FROM web_push_outbox o
JOIN apns_registrations r ON r.owner_id = o.owner_id AND r.agent_id = o.agent_id
  AND r.push_type = 'alert' AND r.status = 'active'
...
LIMIT ?
```
`saveSubscription` 只按 `(owner_id, agent_id, endpoint)` upsert，没有数量上限；`saveRegistration` 只按 `(device_id, push_type, activity_ref)` upsert，也没有数量上限。ADR 自己也写了“同一条通知的接收设备超过 4 个时，余量不够……这是已知限制”（`docs/adr/0273-...md:147`）。

**读代码证实的**：批量公式、100 条上限、两个 `listDue` 的“每接收端一行”语义、订阅/注册写入没有数量上限，都是代码里直接读到的。
**推测**：5 个及以上接收端时新通知会一直取不到，最长到最早一批持有项到期；该行为可复现，但本轮没有运行测试。

**建议**：不要用固定倍数猜。按通道统计“已持有项在该通道实际占用的行数”（active 订阅/alert 注册数 × 持有项），或在 `listDue` 里直接排除 `holds()` 为真的 source key，再给新通知留固定配额；如果产品确实只支持 4 个接收端，就在保存订阅/注册时显式拒绝第 5 个并测试。无论哪种，补一个“5 个 alert 注册”的反向用例，今天它应当失败。

### 2. 低 — 两个互斥通道共用同一个按全局 heldCount 计算的 batch，另一通道没有持有行时会被放大到最多 450 行

**文件:行**：`apps/agent-service/src/production-web-push.ts:545-548, 559-570, 572`；`packages/persistence-sqlite/src/sqlite-web-push-operations.ts:358-359`；`packages/persistence-sqlite/src/sqlite-apple-push-operations.ts:362`。

**问题**：同一个 `batch` 既传给 `companion.deliver`（苹果推送，只取 `channel = 'apns'` 的行），又传给 `store.listDue`（网页推送，只取 `channel IS NULL OR channel = 'web_push'` 的行）。`heldCount` 却是两个通道合起来的。若 100 条持有项都属于 apns，网页推送通道一条持有行都没有，但仍会拿到 450 的批次上限，一次可能发送最多 450 行新网页推送，而不是 `SEND_BATCH=50` 左右。反过来也成立。

**证据**：
```ts
await this.#options.companion?.deliver({ ..., deferred: gate, batch });
...
const due = await store.listDue({ ownerId, agentId, now, limit: batch });
```
两个 SQL 各自按 `channel` 过滤（见上面的 `sqlite-web-push-operations.ts:358-359`、`sqlite-apple-push-operations.ts:362`）。

**读代码证实的**：batch 是全局计算、跨通道复用；两个通道的待发表是互斥过滤的。
**推测**：这是速率/突发风险，不是投递正确性错误；本轮没有测试或生产数据证明会触发上游限流。

**建议**：按通道分别计算补偿量，或把“持有行数”按通道统计；至少给这条路径补一个测试，确认某通道没有持有行时不会把批次放大到远超 `SEND_BATCH`。

### 3. 低 — 新增测试没有覆盖“接收端超过 4 个”的边界，也没有真正验证“没有放两次”

**文件:行**：`test/integration/push-channels.test.ts:1637-1674`。

**问题**：两个新用例分别用 2 个 iPhone 和 1 个 iPhone，都在 4 倍余量之内；没有 5 个及以上 alert 注册/网页订阅的用例。第二个用例名说“none is placed twice”，但只断言 `frames` 长度和事件类型，没有断言 id 唯一；如果实现给某条通知重复投递、同时漏掉另一条，长度仍可能保持不变。此外两个用例都走 APNs（`context.register`），没有覆盖网页推送通道的多订阅场景，而两个通道的“每行”语义并不相同。

**证据**：
```ts
context.device(IPHONE, "iphone");
context.device(SECOND, "iphone");
await context.register(IPHONE, "alert");
await context.register(SECOND, "alert");
...
expect(mac.frames).toHaveLength(MAC_PLACEMENT_LIMIT);
expect(mac.frames.every((frame) => frame.event === "notification.deliver")).toBe(true);
```

**读代码证实的**：用例只注册了 1～2 个 iPhone，没有调用 `context.subscribe`。
**推测**：当前实现因为 `MacPlacement.place()` 按 id 去重，不会重复；但测试没有守住这个性质。

**建议**：增加 5 个 alert 注册的用例并断言新通知仍能到达；增加网页推送多订阅用例；把“没有放两次”改成对 `mac.frames.map(id)` 的唯一性断言。另可用断言固定 `MAC_PLACEMENT_LIMIT === 100`，避免测试跟着实现常量一起漂移。

## 侧重检查

- **错误路径**：`#place` 捕获异常后返回 false，随后退回 iPhone；`withdrawExpired` 每轮遍历最多 100 条；本轮没有新增会抛出的路径。`heldCount` 缺失时 `?? 0`，不会产生非法 limit。
- **不合规范/不可信输入**：本轮没有新增外部输入字段或配置键；`MAC_PLACEMENT_LIMIT` 和 `ROWS_PER_HELD_ITEM` 都是进程内常量，不受请求控制。
- **安全**：没有新增端点、密钥、日志或正文外泄；通知 id 仍是 `sha256(sourceKey)` 的确定性值。
- **资源耗尽**：放置表从 500 收紧到 100，是有界改进；batch 最大 450，低于两个 `listDue` 的 500 上限。仍然存在“接收端 >4 时持有行占满批次”的饥饿，以及跨通道批次放大。
- **不可撤销操作**：本轮没有新增数据库写入或删除；放置/撤回仍只在内存，重启丢失是文档写明的有意取舍。
- **规则文件、说明文档与代码一致性**：ADR 0273 的 100、4、450 与代码算术一致；但“最多 4 个接收设备”不是代码强制的事实，只是预留假设。文档下一句承认了超过 4 个的限制，所以不是文字错误，而是“已知限制”仍未变成代码约束。
- **未核实**：未运行测试、类型检查或 biome；`.agents/reviews` 是二进制文件，未读；生产上是否存在 5 个以上接收端的真实账号未核实。

## 必答问题

1. **会不会改变模型已经见过的请求开头？** 不会。增量只改推送放置/批次/测试/ADR；没有系统提示、工具定义、历史消息或遮盖逻辑的改动，也没有新增每轮会变的值。发给模型的内容仍然只在末尾追加，每轮变化的值不在系统提示或工具定义里。依据 `.agents/instructions/prompt-prefix.md` 第 2、4 条。
2. **会不会让同一段文字在不同请求里变成不同字节？** 对模型上下文不会：增量没有引入时间字段、随机数、无序集合或依赖后文的遮盖。推送侧的 `webPushTopic` 仍是确定性哈希；`batch` 只影响取多少行，不影响文本字节。放置与否会改变“发给哪台设备”，但这是投递路由，不是模型输入。
3. **有没有对应的自动检查，反向用例真的会失败吗？** 有新增的两个集成用例。按代码推算（未运行）：第一个“两个 iPhone”用例在旧的 `50 + heldCount` 公式下，三次 tick 后 Mac 只会收到 44 条，而用例期望 60，因此会失败；第二个“满 100 条上限”用例在旧上限 500、1 个接收端时会因为 500 条持有行占满批次而收到 0 条，也会失败。但它们没有覆盖第 5 个接收端，也没有覆盖网页推送多订阅，所以对“多目标”这一半的反向保障不完整（见意见 1、3）。
4. **改动产生或修改的每个值，使用端都能接受吗？** 逐个核对：`MAC_PLACEMENT_LIMIT=100` 只被 `mac-placement.ts:47` 和测试使用，两端都按整数上限接受；`batch` 取值 50～450，两个 `listDue` 都校验 1～500，接受；ADR 的 100、4、450 与代码算术一致。唯一不能接受的语义是 `ROWS_PER_HELD_ITEM=4` 隐含的“最多 4 个接收端”：订阅/注册写入端没有这个上限，`listDue` 端按实际行数出行，中间没有一处校验，正是 I-73 那类“只在改动这一端假设、另一端不认”的问题。
