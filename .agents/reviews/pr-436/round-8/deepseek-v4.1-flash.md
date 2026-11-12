## 侧重检查（先查的路径与结论）

- **不可信/不规范输入**：核对了依据载荷的字段校验（`evidenceOf`）、规则参数归一化（`parseOwnerRuleParameters`/`parseMailMatch`）、`summary` 的不可见字符校验、列表输出的 Bidi 清理、网关契约。结论：主要路径可以接受；`quote`/试算文字只去掉 `Bidi_Control`，其他不可见格式字符未处理（见问题 6）。
- **错误路径**：核对了写依据失败、`propose` 抛出/已满、拒绝、过期、整理（`#sweep`）、采纳失败回退。发现 `#sweep` 先清引用后删载荷在低磁盘时会永久留下无引用载荷（问题 1）；`expiresAt` 计算在 `drop` 保护之外（问题 2）。
- **安全**：SQL 全部参数化；所有表操作都带 `owner_id/agent_id`；提议编号有 `^rule-proposal:[0-9a-f]{32}$` 校验；`evidence_ref` 只在内部产生，未从网关输入进入；未发现越权读取/删除。`#readProposal` 读取的载荷仍受 owner/agent 作用域限制。
- **资源耗尽**：每次“仍待采纳”的重复提议都会新建并删除一个加密载荷；`#sweep` 每读一次列表最多处理 100 条；已采纳提议（含 MCP）的依据不清理。见问题 1、2、4。
- **不可撤销操作**：`reject` 不回退（设计如此），拒绝/过期后依据删除不可恢复；已采纳依据保留，撤销规则后仍可再采纳，符合材料说明。
- **规则/文档与代码一致性**：`docs/architecture-v0.1.md` 与本轮代码基本一致；两处措辞偏绝对：低磁盘删除失败时“下次读列表时删掉”不成立；>100 条积压时一次列表读不能清完。见文末。

---

## 读代码证实的问题（按严重度从高到低）

### 1. 低（资源耗尽路径，建议修）— 低磁盘时先清引用再删载荷会永久孤立载荷
**文件**：`apps/agent-service/src/production-owner-rules.ts:930-934`、`packages/persistence-sqlite/src/sqlite-durable-operations.ts:1828-1834`、`packages/persistence-sqlite/src/sqlite-worker.ts:643-653`

**问题**：`#sweep` 先 `clearEvidence` 把 `evidence_ref` 置空，再删载荷；而 SQLite 的 `deletePayload` 在删除前会先 `assertDiskHeadroom()`。当磁盘低于 `minimumFreeBytes` 时，`clearEvidence`（不检查磁盘）成功，`payload.delete` 抛错被 `.catch(() => false)` 吞掉。此时表里的引用已经没了，之后任何一次 sweep 都找不到这条载荷，删除永远无法重试。这正是“磁盘不够、最需要释放空间”的时候。

**证据**：
```ts
// production-owner-rules.ts:930
for (const { proposalId, evidenceRef } of settled) {
  const cleared = await store
    .clearEvidence({ ...scope, proposalId, evidenceRef })
    .catch(() => false);
  if (cleared) await this.#options.payloads.delete(evidenceRef as never).catch(() => false);
}
```
```ts
// sqlite-durable-operations.ts:1828
private deletePayload(input: { ownerId: string; agentId: string; ref: string }): boolean {
  this.assertDiskHeadroom();
  return (this.database.prepare("DELETE FROM payloads WHERE ref = ? AND owner_id = ? AND agent_id = ?")...
```
第 7 轮是“先删载荷，删成功才清引用”，低磁盘时不会丢引用。本轮把顺序反过来，是这个新问题的来源。

**建议**：恢复“删除成功才清引用”；或删除失败时不清引用；或让 `deletePayload` 不检查磁盘余量（删除是释放空间的操作）；并补一条注入删除失败的用例。

### 2. 低（错误路径/资源）— `expiresAt` 在 `drop` 保护之外求值，异常会漏掉刚写的载荷
**文件**：`apps/agent-service/src/production-owner-rules.ts:814-833`、`apps/agent-service/src/production-owner-rules.ts:440-449`

**问题**：先写新依据载荷（816），再构造 `store.propose({...})` 参数。`expiresAt: new Date(Date.parse(now) + this.#ttlDays() * DAY_MS).toISOString()` 属于参数求值，发生在 `.catch(...drop...)` 挂上之前；一旦 `toISOString()` 抛 `RangeError`，不会执行 `drop()`，刚写的载荷无人引用。构造器只校验 `过期天数 = 1` 的下限、没有上限，因此超大配置（约 >1 亿天，超出 Date 上限）会被接受，之后每次提议都失败并泄漏一个载荷。

**证据**：
```ts
// :814
const evidenceRef = `${proposalId}:${hash(...).slice(0, 16)}`;
const drop = () => payloads.delete(evidenceRef as never).catch(() => false);
await this.#writeText(evidenceRef, evidence);
const outcome = await store
  .propose({ ..., expiresAt: new Date(Date.parse(now) + this.#ttlDays() * DAY_MS).toISOString(), ... })
  .catch(async (error: unknown) => { await drop(); throw error; });
```
```ts
// :442
if (... !Number.isInteger(proposalTtlDays) || proposalTtlDays < 1)
  throw new RangeError("Owner rule proposal limit or lifetime is out of range");
```

**建议**：给 TTL 设合理上限（如 3650 天），并把 `expiresAt` 在写载荷之前算好；或把 `#writeText` + `propose` 放进 `try/catch/finally`，任何异常都 `drop()`。

### 3. 低（I-73 式两端校验）— 200 上限在两处独立定义，存储层反向用例已被移除
**文件**：`apps/agent-service/src/production-owner-rules.ts:55-58, 442-449`、`packages/persistence-sqlite/src/sqlite-owner-rule-proposal-operations.ts:13, 101-106`、`test/integration/production-memory-capture.test.ts:2780-2781`

**问题**：构造器用 `PENDING_PROPOSAL_CEILING = 200`，存储层用 `MAX_LISTED = 200`，两个常量各自维护。现在二者的唯一交集靠人工保持一致。第 8 轮把原来“`proposalLimit: 201` 直接调用 `create`，断言存储层报 `limit is invalid`”的用例换成了“构造器抛 `RangeError`”，所以存储层 `pendingLimit > 200` 的反向用例已不存在：如果有人只改存储层上限或只改构造器上限，测试不会失败，症状会是运行期提议创建报 `Owner rule proposal limit is invalid`。

**证据**：
```ts
// production-owner-rules.ts:445
proposalLimit > PENDING_PROPOSAL_CEILING ||
```
```ts
// sqlite-owner-rule-proposal-operations.ts:13
const MAX_LISTED = 200;
...
if (!Number.isInteger(input.pendingLimit) || input.pendingLimit < 1 || input.pendingLimit > MAX_LISTED)
  this.invalid("Owner rule proposal limit is invalid");
```
```ts
// test:2780
expect(() => context.ruleWriterWith({ proposalLimit: 201 })).toThrow(RangeError);
```

**建议**：把上限作为单一常量（或至少加一条直接调用端口 `propose({pendingLimit: 201})` 的用例），两端都覆盖。

### 4. 低（资源）— 外部 agent（`listed:false`）采纳后依据载荷永远不清理
**文件**：`apps/agent-service/src/production-owner-rules.ts:804-805`、`apps/agent-service/src/production-mcp-rule-writer.ts:70-101`、`test/integration/mcp-write.test.ts:1013-1015`

**问题**：MCP 提议把依据写在 `ref = proposalId`，没有表行；采纳只写规则/记忆，从不删除该载荷。`#sweep` 只处理表里 `rejected/expired` 的行，所以 MCP 每次采纳都永久留下一个 `rule-proposal:*` 加密载荷。表内“已采纳依据保留”是为了撤销后还能用同一张卡再采纳；MCP 没有列表/卡片，没有这个用途。现有测试反而把“采纳后仍有 1 个 `rule-proposal:` 载荷”固定下来。

**证据**：
```ts
// production-owner-rules.ts:804
if (input.listed === false) await this.#writeText(proposalId, evidence);
```
```ts
// production-mcp-rule-writer.ts:84
const active = await this.#options.rules.confirm(receipt.proposalId);
if (active.ruleId === null) throw new Error("MCP_RULE_NOT_ACTIVE");
// 之后只写 rule-decision 载荷，没有删除 proposalId 的载荷
```
**建议**：MCP `confirm` 成功后删除 `proposalId` 依据；或采纳后把引用记到可清理的位置。若认为这是有意的，请写进文档。

### 5. 低（自动检查缺口）— 没有用例能抓住“重复提议后不删旧依据”的泄漏
**文件**：`test/integration/production-memory-capture.test.ts:2516-2520`、`test/integration/production-memory-capture.test.ts:2789,2799`

**问题**：第 8 轮新增的关键行为是“仍待采纳时也换新引用，成功后删旧载荷”。但现有用例：
- 2516-2520 只断言第三次提议后 `replay` 变成 `null`（能抓住“仍沿用旧依据”），不断言载荷数；
- 2674 那组 `payloadCount` 断言之前，bidi 的旧载荷已被测试第 2782-2788 行手工 `DELETE`，所以“成功换引用后删旧载荷”是否发生，不影响 2789/2799 的数字。

也就是说，若第 839 行 `payloads.delete(existing.evidenceRef)` 被误删，现有测试仍会全绿（只是载荷泄漏）。`#sweep` 的新顺序（先 clear 再 delete）也没有注入删除失败的用例。

**证据**：
```ts
// :2516
await set({ quote: sentence, inferred: true, params: { senderDomains: ["a.example"] } }, "call-a-third");
expect((await proposalsQuery(context.control)).payload.proposals[0]?.replay).toBeNull();
```
```ts
// :2782 测试先把旧的 bidi 依据删掉，再走重提议
"DELETE FROM payloads WHERE ref IN (SELECT evidence_ref FROM owner_rule_proposals WHERE status = 'pending' AND summary = '入管局的邮件一律提醒')"
```
**建议**：补一条“同一待采纳提议连续提两次，`payloadCount()` 不增加”的用例；再补一条注入 `payloads.delete` 失败、断言引用不被清空的用例。这样才真正守住本轮改动。

### 6. 低（不可信文本/界面欺骗）— 只去掉 Bidi 控制符，其他不可见格式字符仍会进入列表
**文件**：`apps/agent-service/src/production-memory-control.ts:543-544`、`apps/agent-service/src/production-owner-rules.ts:749-750`

**问题**：`quote` 创建时只拒绝 `\p{Surrogate}`，不拒绝 `\p{Cf}`/`Zl`/`Zp`；列表输出只用 `replace(/\p{Bidi_Control}/gu, "")`，所以 U+200B（零宽空格）、U+200C/200D、U+FEFF、U+2028/2029 等仍会原样显示。`summary` 走了 `validRuleSummary`（拒绝全部 Cf/Zl/Zp），所以这里只影响原话与试算文字。这不是方向重排，但可以用于隐藏/伪造显示内容。

**证据**：
```ts
// production-memory-control.ts:543
const clip = (text: string, maximum: number) =>
  singleLine(text.replace(/\p{Bidi_Control}/gu, "")).slice(0, maximum) || null;
```
```ts
// production-owner-rules.ts:749
if (quote.length === 0 || quote.length > QUOTE_LIMIT || /\p{Surrogate}/u.test(quote))
```
**建议**：列表输出按 `summary` 同样的规则去掉全部 `\p{Cf}\p{Zl}\p{Zp}`（或与 `validRuleSummary` 共用清洗函数）；创建时对 `quote` 也拒绝这些字符。

---

## 推测 / 未核实

- **推测（并发下新引用泄漏）**：`create` 先读 `existing`，再写新引用 `N`、`propose` 覆盖表里的引用、最后删旧引用 `E`。两个并发请求若都在对方 `propose` 之前读到同一个 `existing(E)`，则各自写 `N1`/`N2`，表最终指向后写者，`N1` 或 `N2` 中落败的一个无人引用且不会被删。第 8 轮之前 `pending` 会复用 `E`，没有这个泄漏。依赖同一 owner/agent 上对同一内容的并发提议；未复现。
- **未运行测试**：本环境只允许读文件与 `git` 查询，未执行 typecheck/lint/integration。因此“反向用例会不会失败”是按断言与代码逻辑判断，不是实跑结果；作者列出的“已通过”项未核实。
- **数据导出**：未核对 `owner_rule_proposals` 不进入导出是否有检查兜底；作者明确说本轮不做，且要求不要重复，故仅记为未核实。
- **低磁盘路径**：`assertDiskHeadroom` 的触发需要磁盘低于配置的下限；问题 1 是读代码推出的必然结果，未在真实低磁盘环境复现。

---

## 必答问题

### 1. 会不会改变模型已经见过的请求开头？
**不会。**
- 本次 PR 未改 `packages/prompt-catalog`，`rule_set` 的工具描述/参数结构（`ownerRuleToolDescriptors`）在 `production-owner-rules.ts` 的 diff 中没有变化；系统提示、工具定义、历史消息都没动。
- 新增/变更的只有 `rule_set` 的**返回回执**、`memory.ruleProposals.read` 这个仅界面用的查询，以及提议表/载荷。回执和工具结果都是追加到最后的新消息。
- 每轮会变的 `replay`、`expiresAt`、新的 `evidenceRef` 只出现在回执或 UI 查询结果里，不在系统提示/工具定义/历史里。
- 依据规则 [prompt-prefix.md#rules](../../.claude/rules/prompt-prefix.md#rules)：仍然只在末尾追加；本轮没有把任何随时间变化的值塞进请求开头。

### 2. 同一段文字会不会在不同请求里变成不同字节？
**对发给模型的内容：不会。**
- 提议编号仍是内容哈希（`canonicalJson` 排序键，数组顺序由 `parseMailMatch` 归一化），同一内容稳定。
- 每轮变化的 `replay` 依赖当时的邮件数据，但它只在 `rule_set` 回执这一条新消息里，属于允许的“末尾追加”。
- **存储层**同一提议的依据字节会变（`evidenceRef` 带 `now` 与 `randomUUID`，并写入新的依据载荷），但该引用/载荷不进入模型请求，只被界面读取和采纳时使用，因此不影响请求前缀的逐字节一致性。

### 3. 有没有对应的自动检查，反向用例真的会失败吗？
有，覆盖大部分本轮行为；但有两个缺口（问题 5），且我没有实跑。
- 构造器 `proposalLimit > 200` / `proposalTtlDays = 0`：`test:2780-2781`，去掉校验就不抛 `RangeError`，会失败。
- “仍待采纳也换新依据”：`test:2516-2520`，恢复第 7 轮的复用旧依据逻辑会得到 `replay: 9`，`toBeNull()` 会失败。
- 换引用后不能指向缺失载荷：`test:2790-2799`，若把新载荷删掉/表指向旧引用会失败。
- 拒绝/过期清依据、读列表补整理：`test:2702-2705`、`test:2801-2805`、`test:2778`，去掉 sweep/settle 会失败。
- 依据字段校验、Bidi 清理、列表顺序、MCP 不进列表、来源标记等都有对应用例。
- **缺口**：没有用例断言“重复提议成功后旧依据被删”（误删删除逻辑不会红）；`#sweep` 先清后删的失败路径没有注入用例；存储层 `pendingLimit` 的 201 反向用例被构造器用例取代（问题 3）。

### 4. 每个新值/字段/配置键/序列化格式，产生端与使用端都能接受吗？
逐个核对如下（读代码证实）：
- **proposalId**：产生为 `rule-proposal:` + 32 位十六进制（`create:792-801`）；使用端：`PROPOSAL_ID_PATTERN`、DB `id` 长度 1–128、网关 `machineString`、UI key/`data-proposal`。两端一致。哈希已含 ownerId/agentId；表虽是单列 `id` 主键，但查询都带 `owner_id/agent_id`，跨 agent 不会串（`sqlite-owner-rule-proposal-operations.ts:90`）。
- **evidence_ref**：产生为 `<proposalId>:<16 位十六进制>`，长度 63；使用端：`payloads.ref`（无长度/字符限制）、迁移 `evidence_ref` 的 1–256 校验、`#readProposal`、`settledEvidence`/`clearEvidence` 的等值比较。全部接受；未对外暴露。
- **pendingLimit/limit**：产生端 1–200（构造器），使用端存储层 1–200（`MAX_LISTED`）、网关 `integer(1)`、UI。能接受，但两处 200 独立定义、缺两端联动用例（问题 3）。
- **proposalTtlDays/expiresAfterDays**：产生端整数 ≥1，使用端 `expires_at` 的 ISO 校验/GLOB、网关 `integer(1)`。正常值两端都能接受；无上限导致极端值在 `toISOString()` 抛错（问题 2）。
- **origin**：`owner_said`/`inferred`，写入端、DB CHECK、端口类型、网关枚举、UI 文案完全一致。
- **status**：`pending/accepted/rejected/expired`，写入端、DB CHECK、端口类型、`decide` 的 `from/to` 一致。
- **reject_count/refusedBefore**：写入端 `decide`/`propose`，读取端 `listProposals`、网关 `integer(0)`、UI 一致；重开保留计数符合文档。
- **依据 JSON 字段**：写入端 `create` 写 `key/type/params/summary/quote/threadId/source/trials/replay`；读取端 `evidenceOf` 逐字段校验，`trials` 过滤坏元素，`replay` 校验安全整数与布尔；`params` 不在此处校验，但 `#settle`/`#activate` 会 `parseOwnerRuleParameters`。两端可接受。
- **新操作 `memory.ruleProposals.read`**：加入 `PRODUCTION_MEMORY_OPERATIONS`、网关 schema、`useMemory` 的可用性判断与轮询，三处一致。
- **`EVIDENCE_SWEEP_BATCH=100`**：在存储层 1–200 的接受范围内。
- 结论：本轮没有发现 I-73 那种“清单里的 id 过不了后端校验”的硬不一致；只有 200 常量重复、TTL 无上限两处需要注意。

---

## 与作者说法不一致/需修正的地方

- “成功后删旧载荷，失败或已满删掉刚写的”：**基本正确，但有两个例外**——删除本身失败时旧载荷会留下（问题 1/2）；`expiresAt` 求值异常时新载荷不会被 `drop`（问题 2）。
- “每次提议（新建、重置、仍待采纳）都把依据写到新引用”：对**列表内**提议成立；`listed:false`（MCP）仍写回固定的 `proposalId`，且该载荷采纳后不清理（问题 4）。若这句话只指列表提议，请在文档里写明。
- “上限配置超过 200 时存储层拒绝写入”：代码仍成立，但第 8 轮后从生产构造路径不可达，且原有存储层反向用例已被构造器用例替换（问题 3）。
- “上限/过期天数否则服务启动时就报错”：只在调用方传入这两个选项时成立；本仓库的生产装配没有传，使用的是常量默认值；TTL 只有下限没有上限（问题 2）。
- “本容器已通过 typecheck/lint/integration…”：我无法运行测试，未核实。
- 文档“依据载荷在拒绝时或下次读列表时删掉”偏绝对：超过 `EVIDENCE_SWEEP_BATCH=100` 的积压需要多次读列表；删除失败时引用已置空、载荷反而删不掉（问题 1）。
