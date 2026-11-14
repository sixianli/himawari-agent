### 1. 中 — 作者说 proposal“不受保护、可被不推送时段延后”，代码和已提交的文档正好相反

文件：`packages/application/src/services/web-push-gate.ts:18`、`apps/agent-service/src/production-web-push.ts:580`、`docs/execution/specs/2026-10-26-web-push-design.md:116`

问题：作者的说法与实现相反。代码把 `proposal` 放进受保护类别，推送门对它直接放行，不交给主人规则，也不会被“不推送时段”延后；c3cd 还专门加了“不可被延后”的测试。

证据（读代码）：

```ts
export const PUSH_RULE_PROTECTED_CLASSES: readonly PushClass[] = Object.freeze([
  "approval",
  "muse_outage",
  "proposal",
  "unknown",
]);
```
```ts
if (PUSH_RULE_PROTECTED_CLASSES.includes(input.pushClass)) return DELIVER;
```
```ts
if (PUSH_RULE_PROTECTED_CLASSES.includes(pushClass) || !this.#options.readPushRules) {
```

提交的说明也写“不受‘不推送时段’规则延后”（`2026-10-26-web-push-design.md:116`、`2026-11-11-apple-device-body-design.md:489`）。建议改正作者说明为“受保护、不被不推送时段延后”；若确实希望可延后，则代码、文档和上一轮新增的保护测试要一起改，并重新确认 Andy 的意图。

### 2. 低 — 上一轮第 2 条只改好了一半：网页推送说明仍写“三类来源”“Urgency 按上表”，第四类没有进表

文件：`docs/execution/specs/2026-10-26-web-push-design.md:106`、`:108`、`:110-114`、`:135`

问题：c3cd 加了“第四类是待处理的提议”的正文段和文案表行，但章节标题仍是“三类推送来源”，概述仍写“扫一遍下面三类来源”，来源表只有三行；发送规则仍写“`Urgency` 按上表”，而表里没有 proposal。上一轮指出的正式说明不一致仍然存在。

证据（读代码/文档）：

```
## 三类推送来源
推送调度器每 10 秒扫一遍下面三类来源……
| 来源 | 怎么找 | `source_key` | 有效期 | 紧急程度 |
| 记忆提醒 | …… |
| 审批 | …… |
| 一轮任务结束 | …… |
```
```
- **请求头。** `TTL` 等于距 `expires_at` 的秒数；`Urgency` 按上表；……
```

建议：标题和概述改成“四类/下面几类”，把 proposal 作为一行加进来源表（有效期、`normal`），或把“`Urgency` 按上表”改成“按上表及下面的第四类”，避免读者漏掉它。

### 3. 低（推测） — 旧的提议通知已入队但未发送时，新提议出现不会作废旧通知，之后可能收到两条

文件：`apps/agent-service/src/production-web-push.ts:431-445`、`:651-660`、`packages/persistence-sqlite/src/sqlite-web-push-operations.ts:267-276`

问题（推测，需设计确认）：每个 tick 只把“当前最新一份”提议入队，但不会清理之前已经入队、尚未发送的 proposal 行；发送时的检查只确认该提议仍在待处理列表里，不要求它是“最新一份”。因此在没有可用订阅、或发送还在重试窗口时，旧行会一直留着，新提议再入一条，等设备可用时可能两条都发出，和“只为最新一份”给人的“只发一条”印象不同。是否接受“每份提议各发一次”需要设计确认。

证据（读代码）：

```ts
const { rows: proposalRows } = await this.#readyProposals(now);
const newest = proposalRows.reduce(...);
for (const proposal of newest ? [newest] : [])
  items.push({ ... sourceKey: `proposal:${proposal.id}:${proposal.proposedAt}`, ... });
```
```sql
ON CONFLICT (owner_id, agent_id, source_key) DO NOTHING
```
```ts
if (pending.ok && !pending.rows.some(({ id, proposedAt }) =>
  id === item.sourceRef && item.sourceKey === `proposal:${id}:${proposedAt}`))
  return { expired: true };
```

建议：若目标是“只提醒最新一份”，发送时也要求该 source key 是最新待处理提议，或在入队新提议时把其它未发送的 proposal 行标为过期/抑制；若目标是“每份出现时各提醒一次”，则在文档里写清，当前“只为最新一份入队”说法容易被误读。

## 本轮范围与说法核对

本轮实际查过：c3cd589e3 的完整增量（网页/苹果设计文档、`push-channels` 测试）；为核对行为回读了 `production-web-push.ts`、`production-apple-push.ts`、`web-push-gate.ts`、`service-main.ts`、`production-proposals.ts`、`sqlite-owner-proposal-operations.ts`、`sqlite-web-push-operations.ts`、`sw.js` 与 `service-worker-feedback.test.ts`。所有新增/修改值都在这些生产端和消费端核对过。`b9ea..c4c7` 里合并进来的 main 改动（感知检索索引、数据导出、operations 检查等）不是本 PR 的推送改动，未重新审计；没有发现它们与 proposal 推送的交叉影响。

- 与代码一致的说法：来源用 `ownerProposals().listPending`、24 小时窗口、来源键 `proposal:<id>:<proposedAt>`、outbox `ON CONFLICT DO NOTHING`、通用文字不含提议内容、苹果 `passive`/无声音/无角标/无按钮、网页无角标、读取失败只上报一次且已入队的照常发送、不改表、不新增模型调用、不碰模型内容、代码无新增注释。均已对照代码确认。
- 与代码相反的说法：作者写“提案不受保护、可被不推送时段延后”，见意见 1。
- `npm run check 56 步通过`：无法执行，未核实。
- `push-channels 23 条通过`：当前 `test/integration/push-channels.test.ts` 有 29 个 `it(`，不是 23；通过与否无法运行核实。另 `npm run check` 的 `check:steps` 不包含 `test/integration/push-channels.test.ts`，该文件由 CI 的 integration 项目或单独运行覆盖。
- 文档措辞：`2026-11-11-apple-device-body-design.md:489` 写“主人定的规则里有待处理的提议时”，实际来源是 `ownerProposals().listPending()` 的待处理提议，不是规则本身；属轻微措辞不准确。

## 侧重检查

- 错误路径：`#loadProposals` 捕获异常并调用 `onFailure`，每次 tick 通过缓存只报一次；读取失败时已入队的 proposal 内容不判过期、照常发送；其它提醒/审批不受影响。读代码证实，c3cd 的用例也覆盖了抛错和“已入队仍发送”。
- 不合规范/不可信输入：提议的 `proposedAt` 只用于 24 小时过滤和来源键；无法解析的时间会被过滤掉。来源键由推送服务自己生成（`apps` 内只有 `production-web-push.ts` 生成 source key），长度远小于 outbox 的 1–256 限制。任何外部提议编号中的冒号不会破坏 `proposal:` 前缀判断。未发现注入面。
- 安全/隐私：标题和正文固定，不含提议内容；网页跳转用 `publicOrigin` 根路径；无按钮、无声音、无角标。未发现泄露提议内容的路径。
- 资源耗尽：`listPending` 每 tick 一次，`limit` 固定 200，数据库端把 limit 夹到 `MAX_LISTED=200`；`propose` 也限制 `pendingLimit <= 200`，因此一次读取能覆盖全部待处理提议。未发现无界增长。
- 不可撤销操作：本 PR 不删表、不迁移、不做批量删除或外部副作用。
- 规则文件/说明与代码一致性：发现意见 1、2；其余“提议通知”说明与实现一致。
- 未核实（推测）：浏览器/系统是否真的按 `silent: true` 静音，文档本身也标了未核实；苹果通知是否转到手表由系统设置决定，服务端无法保证。

## 必答问题

1. 不涉及。本 PR 的增量（c3cd 及 b9ea 的推送实现）只改推送通知、推送门、service worker、文档和测试，没有改系统提示、工具定义、历史消息或遮盖。发给模型的内容仍然只在末尾追加；每轮会变的值不在这个功能里。合并进来的 main 改动不属于本 PR，未在本轮重审。
2. 不涉及。proposal 标题/正文是固定文字，网页负载键顺序固定；`source_key` 里的 `proposedAt` 只影响推送去重和 `Topic`，不进入模型请求，也不会让同一段固定文字在不同请求里变成不同字节。同一份提议的来源键是确定的。
3. 有。c3cd 新增了“proposal 不被延后”“安静通知不读角标”“网页只推一条时 `Urgency=normal`”三个用例；`puts silent in the web payload for a quiet notice only` 和 service worker 的 `silent === true` 用例覆盖网页静音。按代码推断，去掉 `proposal` 保护、去掉 quiet 的 badge/urgency 分支，对应用例会失败。但这些是 integration 用例，`npm run check` 不执行它们，需要 CI 的 `tests` 项目或单独运行；我无法实际运行验证。
4. 逐个核对过：`proposal` 类别只在 `pushClassOf` 产生，消费端是 `PushGate`/`PUSH_RULE_PROTECTED_CLASSES`，`source_insights.push_class` 若写入也接受 1–128 字符；`proposal:` 来源键的消费端是 `pushClassOf`、`webPushTopic`、`#content` 和 outbox 的 1–256 长度约束，均接受；`quiet` 由 `#content` 产生，消费端是 `webPushPayload`（转成 `silent`）和苹果 `#sendAlert`/`applePushAlertPayload`，类型上都接受可选布尔；`silent` 由 `webPushPayload` 产生，`sw.js` 只在 `=== true` 时静默；`PENDING_PROPOSAL_CEILING=200` 作为 `listPending` 的 limit，存储端夹到 `MAX_LISTED=200` 并拒绝更大的值，两端一致。本 PR 没有新增配置键或迁移。c3cd 本身只改文档和测试，`webUrgencies` 只在测试内使用。
