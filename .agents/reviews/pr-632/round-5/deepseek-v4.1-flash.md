本轮复核范围：增量 `4412380..6af1d58` 只改了 `apps/agent-service/src/owner-allowances.ts` 的写入顺序和 `test/integration/tool-action-registry.test.ts` 的新增用例；我据此核对上一轮 4 条意见，并跟到 `list`/`match`/`revoke` 的使用端、范围快照契约和数据库消费前复核。上一轮意见 2 已改好；意见 1、3、4 在增量里没有对应改动，仍然成立或只在契约层面成立。

### 1. 中：首开等待 `thread.main` 仍无超时，请求挂住时输入框一直不出现
文件:行 `apps/control-center/src/thread-control-center.tsx:352-368`、`369-374`、`1822-1823`

问题：`thread.main` 查询只传了可被卸载/依赖变化触发的 `AbortController`，没有任何 deadline；`catch` 只处理 401，`finally` 只有请求 settle 后才执行。请求永久挂住时 `mainLookupSettled` 永远为 `false`，`openingMain` 永远为 `true`，于是加载骨架一直显示、`ChatComposer` 一直不渲染。

证据（读代码证实）：
```tsx
355:     client
356:       .queryThread(threadQueryMessage(configuration, "thread.main", {}), controller.signal)
...
361:       .catch((caught: unknown) => {
362:         if ((caught as { readonly status?: unknown } | null)?.status === 401) onUnauthorized();
363:       })
364:       .finally(() => {
365:         if (!controller.signal.aborted) setMainLookupSettled(true);
366:       });
```
```tsx
369:   const openingMain =
370:     !selectedThreadId &&
371:     !page &&
372:     !route.status &&
373:     Boolean(client && configuration) &&
374:     (!mainLookupSettled || mainThreadId !== null);
```
```tsx
1822:           {openingMain ? null : (
1823:             <ChatComposer
```
建议：给这次查询加 `AbortSignal.timeout`/watchdog，超时或失败也把“主对话查找已结束”置位，并显示可重试的错误；不要把输入框的可见性绑在一个可能永不结束的网络请求上。补一个“查询挂住仍能看到输入框/重试”的测试。

### 2. 低：批量同意时范围选项仍只按第一条审批计算
文件:行 `apps/control-center/src/components/run-approval-card.tsx:49`、`58-60`、`120-143`；`apps/control-center/src/run-approval.ts:95-114`、`146-157`、`167-168`

问题：卡片只用 `group[0]`（第一条审批）计算可选项，但批量分组键没有包含 `estimatedCostMicros`、`credentialOrAccessChange`、`deterministicFactCodes`、`intentId` 前缀等决定“是否能存范围”的字段。于是同一批里可能混有“只能一次”的审批和“可长期”的审批：UI 依据第一条显示范围选项，随后对每条审批分别调用 `setApprovalAllowance`，第二条会被服务端按自己的规则拒绝，造成部分保存或只显示一次而漏掉本可用的范围。

证据（读代码证实）：
```tsx
49:   const snapshot = group[0] ?? null;
...
58:   const choices: readonly ApprovalAllowFor[] =
59:     snapshot && !isSearch ? approvalAllowanceChoices(snapshot) : ["once"];
60:   const chosen = choices.includes(allowFor) ? allowFor : "once";
```
```ts
100:   const kind = (approval: RunApproval) => {
...
102:     return JSON.stringify([
103:       intent.capabilityRef,
104:       intent.capabilityVersion,
105:       intent.operation,
106:       intent.sideEffect,
107:       intent.disclosure,
108:       [...intent.recipientRefs].sort(),
109:       intent.dataClassification,
110:       approval.payload.recentAuthenticationRequired,
111:     ]);
112:   };
113:   return approvals.filter((approval) => kind(approval) === kind(first));
```
```ts
167:   if (!approvalAllowanceChoices(snapshot).includes(allowFor))
168:     throw new Error("APPROVAL_ALLOWANCE_NOT_OFFERED");
```
服务端逐条拒绝保证不会越权放行，所以不是安全问题；影响是“批量卡片给错选项、部分保存、报错信息笼统”。

建议：对整批取可选项的交集，或按“是否能存范围”拆组；若保持整批同意，UI 应在存在不可存范围的条目时禁用长期选项并说明原因。补一个“第一条不花钱、第二条花钱”的批量测试。

### 3. 低：范围标题来源允许换行/制表符，但快照 `title` 校验拒绝控制字符，仍可能让设置页整页读不到
文件:行 `apps/agent-service/src/owner-allowances.ts:222`；`packages/gateway-contracts/src/contracts-v2.ts:2653-2664`、`3415-3432`；`packages/gateway-contracts/src/validation.ts:102-119`；客户端解析在 `apps/control-center/src/gateway-client.ts:271-274`

问题：范围记录直接把审批展示标题（或操作名）截断后落库；审批展示契约允许 `\t`、`\n`、`\r`，而范围快照的 `title` 用的是 `boundedString(120)`，任何 `<0x20` 的控制字符都拒绝。一旦存入这样的标题，`memory.rules.read` 返回的整个快照会在客户端校验失败，不只是这一条范围显示不了，而是规则页/“你给过的同意”整块加载失败，因而也无法收回。

证据（读代码证实）：
```ts
222:       title: (approval.display?.displayTitle ?? intent.operation).slice(0, TITLE_LIMIT),
```
```ts
3419:       typeof input !== "string" ||
3420:       input.length === 0 ||
3421:       [...input].length > maximum ||
3422:       [...input].some((character) => {
3423:         const code = character.charCodeAt(0);
3424:         return (code < 0x20 && code !== 0x09 && code !== 0x0a && code !== 0x0d) || code === 0x7f;
3425:       })
```
```ts
2657:         title: boundedString(120),
```
```ts
109:         [...input].some((character) => {
110:           const code = character.charCodeAt(0);
111:           return code < 0x20 || code === 0x7f;
112:         })
```
推测/未核实：我查到的当前生产端 `displayTitle` 来源是设备动作的静态标题和 `production-approval-display.ts:81` 的 `null`，没有找到会实际发出换行/制表符的生产者，因此当前可达性未确认；但这是两端契约的实质不一致，不能靠“现在没人这么写”保证以后不炸。

建议：在 `owner-allowances.set` 落库前按快照同一规则清洗或拒绝控制字符，或者把范围标题的契约改成和审批展示一致；加一个“`displayTitle` 含 `\n` 时 set 后 list 仍能通过快照校验”的用例。

### 4. 低（推测，并发时序）：`set` 与 `revoke` 仍是两次独立提交，仍可能出现“已生效但索引里没有、设置里看不到”
文件:行 `apps/agent-service/src/owner-allowances.ts:230-245`、`261-278`、`280-308`、`310-328`

问题：这次修复把 `set` 改成“先写索引、再写记录”，解决了“索引写失败但记录已生效”的确定性路径；但 `set` 和 `revoke` 都跨两个独立 state key 提交，不是原子操作。若同一范围上“重新同意”和“收回”并发，存在时序：`set` 的索引步骤先完成/无操作 → `revoke` 把记录置为 disabled 并删除索引 → `set` 随后把记录重新置为 enabled。最终记录 `enabled=true`、索引里没有该 key；`match` 直接按 key 读记录仍会命中并放行，`list` 只看索引因此看不到、也无法收回。

证据（读代码证实）：
```ts
230:     await this.#index((keys) => [...keys, key]);
231:     await this.#retry(async () => {
...
239:       await this.#commit(
240:         key,
241:         record?.revision ?? null,
...
245:     });
```
```ts
265:     await this.#retry(async () => {
...
270:       await this.#commit(
271:         key,
272:         record.revision,
273:         { ...record.value, enabled: false, revokedAt: this.#clock.now() },
...
276:     });
277:     await this.#index((keys) => keys.filter((existing) => existing !== key));
```
`match` 不读索引：
```ts
319:       const key = `${KEY_PREFIX}${allowanceId(scopeKey, threadId)}`;
320:       const record = await this.#read(key);
...
322:       if (!record || !value || value.enabled !== true || value.scopeKey !== scopeKey) continue;
```
推测/未核实：这是并发时序分析，未实测；也不是本次顺序调整新引入的（旧顺序也有别的交错）。但本次声称解决“已生效却收不回”，这条路径仍未被封住。另：反向的“索引有 key、记录不存在”由 `list` 跳过，属于无害孤儿项。

建议：让 `match` 也以索引为准（索引里没有就不命中，fail-closed），或把索引与记录放进同一个原子事务/同一把按范围的锁；补一个并发 `set`/`revoke` 交错测试。若认为跨 tab 并发不在威胁模型内，至少在注释和测试里写清这个约束。

**侧重检查**

- 错误路径：核对了 `set` 的校验顺序（所有权、状态、`policyAuthorization`、花钱/密钥/本人在场/前缀、天数）、索引写失败、记录写失败、`revoke` 写失败；`list` 会过滤非字符串索引项、缺失记录、`enabled!==true` 和已过期项（`owner-allowances.ts:159-163`、`280-302`）。
- 不可信输入：索引 key 有 `typeof === "string"` 过滤；记录字段读取有类型降级；唯一发现的输入/输出校验错配是意见 3 的标题控制字符。
- 安全与不可撤销操作：服务端 `allowanceNotOffered` 在 `set` 和 `match` 两处都调用；数据库在用掉 `policyAuthorization` 前复核 `product_state_records` 的 `enabled` 和 `revision`（`packages/persistence-sqlite/src/sqlite-durable-operations.ts:2229-2240`、`2258`），正常收回路径是可靠的。
- 资源耗尽：索引是按 key 的集合，孤儿 key 只会让 `list` 每次多读一次并跳过；没有新增无界输入解析。意见 4 的并发交错是当前唯一可能让“设置列表”和“实际生效”分叉的路径。
- 规则/文档/代码一致性：`docs/execution/specs/2026-11-24-main-thread-subthreads-inbox-design.md` 与 `owner-allowances.ts` 的范围语义基本一致；作者说“上一轮 1/3/4 已修改”与增量不符，增量只修了上一轮意见 2。

**作者说法核对**

- 1 成立：`owner-allowances.ts:192-196` 要求 `status === "approved"` 且无 `policyAuthorization`。
- 2 成立：`this_task` 记录 `intent.threadId`（`208-213`）；`match` 只在没有 `context_external_content` 时加入 `null` 线程键（`315-317`）。
- 3 成立：`owner-allowances.ts:84-92` 拒绝花钱/密钥/本人在场；`run-approval.ts:146-157` 网页端同样只给 `once`。
- 4 大体成立：`actionScope` 排除 `input-digest`、对 recipients/targets 排序（`owner-allowances.ts:65-78`）；设备动作把 `device`、`device-action` 放进 targets（`production-device-action-authorization.ts:85-89`）。未逐项验证所有工具的目标字段。
- 5 成立：数据库消费前复核 `enabled` 与 `revision`（`sqlite-durable-operations.ts:2229-2240`、`2258`）。
- 6 成立：`list` 与 `match` 都以 `expiresAt <= now` 跳过（`owner-allowances.ts:291`、`324`）。
- 7 成立：`approval.allowance.set` 在 `contracts-v2.ts:27/269/3832`、`client-capabilities.ts:124`、`production-approval-gateway.ts:108`、`gateway-v2.fixture.ts:1349`、生成的 `ClientCapabilities.swift:85` 均存在；`allowances` 快照字段在 `contracts-v2.ts:2653-2664`。

**必答问题**

1. 不涉及本次增量：增量只改服务端范围记录的写入顺序和一个测试，没有改系统提示、工具定义、历史消息或遮盖结果，因此发给模型的内容没有被这个增量改变。就本增量而言，“只在末尾追加”仍然成立；全仓模型请求构造不在本轮增量范围，未整份重读。
2. 不涉及本次增量：增量没有产生模型可见的新字节或带时间的请求字段。顺带核对 `actionScope` 使用排序后的 recipients/targets、排除 `input-digest`、不含时间字段，是确定性的服务端摘要，不进入模型请求。
3. 有自动检查：新增的 `test/integration/tool-action-registry.test.ts:1691-1751` 覆盖“索引写失败时不放行、再次保存后能列出”。按代码推理，旧顺序先写记录，`match` 会命中，该用例会失败，因此是有效的反向用例（未实际运行，属于推理）。但没有覆盖意见 1 的混合批量、意见 3 的控制字符标题、意见 4 的并发交错；意见 2 的孤儿索引也只有间接覆盖。
4. 增量没有新增或修改导出的函数、配置键、字段或序列化格式；唯一的行为变化是索引 `keys` 先于范围记录写入。它的使用端 `#index`、`list`、`revoke` 都能接受该值：`list` 会跳过缺失记录，`revoke` 只按 key 删除，`match` 不读索引。上一轮遗留的 `title` 两端校验仍不一致（见意见 3），这是目前唯一“产生端与使用端规则不同”的确认点。
