# PR 436 第 4 轮复核（d4bf2b74）

我核对了 `bf386aaf..d4bf2b74` 的增量（`#settle`、重置时恢复旧载荷、两条新测试、架构文档），并回溯了 `production-owner-rules.ts`、提议存储、迁移、网关契约、控制中心与 MCP 路径。

## 读代码证实的问题（按严重度）

### 1. 中：`#settle` 成了规则生效之后新增的可失败写库步骤，失败会让“确认”报错并把提议退回待采纳，随后还能“拒绝”，造成规则已生效却显示已拒绝

- 文件：`apps/agent-service/src/production-owner-rules.ts:540`（`#settle`）、`:586`、`:641`（两个出口都调用）、`:877`（`try { return await this.#activate(...) }`）、`:879-882`（catch 后 `release()`）
- 问题：`#activate` 先完成记忆和规则写入（甚至可能是 `reconfirm` 一个原有规则），最后才调用 `#settle`。`#settle` 里 `store.listPending` / `store.decide` 都可能抛错（`decide` 在 `packages/persistence-sqlite/src/sqlite-owner-rule-proposal-operations.ts:213` 调 `assertDiskHeadroom`，磁盘不足即抛）。一旦抛错，`confirm` 的 catch 会执行 `release()`，把刚认领的提议从 `accepted` 改回 `pending` 并向上抛错；但此时规则已经 active。
- 证据：

```ts
// production-owner-rules.ts:586,641
await this.#settle(parsed.type, parsed.params);
...
// :877-882
try {
  return await this.#activate(proposal, proposal.replay ?? null);
} catch (error) {
  await release();
  throw error;
}
```

- 后果：用户看到“生效失败”，提议仍留在待采纳列表；此时点“不要”会成功（`pending → rejected`），但同参数规则实际已在执行。这与“不要只标记拒绝、不写规则”的语义冲突，且是第 4 轮新增的失败窗口（此前 `#activate` 返回前没有额外的提议写库步骤）。
- 建议：规则一旦确认成功，后续结算失败不应让整个确认回滚。把 `#settle` 改成逐条 best-effort（单条失败只记录/留待下次，不抛），或在 `confirm` 里记录“规则已激活”后不再 `release`；也可把结算放到确认成功后的异步补偿。

### 2. 低：重置旧提议时“恢复原载荷”是静默 best-effort，恢复失败会永久丢掉旧依据，和文档的承诺不一致

- 文件：`apps/agent-service/src/production-owner-rules.ts:769-775`、`docs/architecture-v0.1.md:420`
- 问题：`prior` 读取失败被 `.catch(() => undefined)` 吞掉；`restore()` 里的删除和写回也都 `.catch` 吞错。如果删除/写回本身失败（例如正是磁盘不足），旧载荷已经被删、新载荷也没保留，表状态却仍是 rejected/expired/accepted，旧依据再也找不回。
- 证据：

```ts
const prior = stale ? await this.#readText(proposalId).catch(() => undefined) : undefined;
const restore = async (): Promise<void> => {
  if (!stale) return;
  await payloads.delete(proposalId as never).catch(() => false);
  if (prior !== undefined) await this.#writeText(proposalId, prior).catch(() => undefined);
};
if (stale) await payloads.delete(proposalId as never);
```

- 文档却写：“写表失败或已满时把刚写的载荷删掉（重置旧提议时则把原来的载荷写回去）”。
- 建议：不要先删旧载荷。用临时 ref 写新证据 → `propose` 指向临时 ref → 成功后再删旧 ref；或至少在写回失败时保留新载荷并报错，别静默吞掉。

### 3. 低：先删旧载荷再写新载荷留下并发读窗口

- 文件：`apps/agent-service/src/production-owner-rules.ts:775-776`
- 问题：`await payloads.delete(...)` 与 `await this.#writeText(...)` 之间，同一提议的 `evidenceRef` 指向的载荷不存在。此时并发的 `memory.ruleProposals.read` 会列出 `quote: null / trials: [] / replay: null`；并发 `confirm` 一个 `accepted` 提议会在 `#readProposal` 处抛 `RULE_NOT_FOUND`（`confirm` 只有 `claimed` 时才 release）。这个窗口在第 2 轮就存在，第 4 轮用 restore 处理失败，但没有消除窗口。
- 建议：采用“新 ref + 表内切换”或“先写临时 ref，再原子更新 evidence_ref”，避免删除后写。

### 4. 低：文档“写表失败或已满时把刚写的载荷删掉”对 pending 且载荷缺失的场景不成立

- 文件：`apps/agent-service/src/production-owner-rules.ts:770-771`、`:787-795`、`docs/architecture-v0.1.md:420`
- 问题：`restore()` 开头 `if (!stale) return;`。若已有行是 `pending` 但载荷缺失，`#writeText` 会真的写入新载荷；随后 `propose` 抛错或返回 `limit_reached` 时 `restore` 直接返回，新载荷被保留。这不是数据损坏（ref 相同、状态仍 pending），但与文档这句笼统表述不一致。
- 建议：文档改为“仅重置非待采纳提议时写回旧载荷”，或代码按文档行为处理。

### 5. 低：测试缺口（不是错误，但覆盖不完整）

- 文件：`test/integration/production-memory-capture.test.ts:2609`（settle）、`:2634`（restore-on-protect-failure）
- 已覆盖：`#settle` 的“新建规则”出口、protect 失败时恢复旧依据、并发确认/拒绝、载荷缺失时的列表。
- 未覆盖：
  - `#settle` 在 `same`（已有同参数规则、走 `reconfirm`）出口的行为；
  - stale 重置时 `propose` 抛错/返回 `limit_reached` 的恢复路径（现有 full-list 测试走的是 `existing` 不存在的新建分支，`:2487`）；
  - `#settle` 抛错后的 `confirm` 回滚路径（见问题 1）。
- 建议：补一条“已有生效规则 + 同参数待采纳提议”的 settle 测试，以及注入 `store.decide`/`listPending` 失败的确认测试。

## 推测（未完全证实）

- 问题 1 的触发条件（`store.decide`/`listPending` 抛错）在正常磁盘下很少发生；我无法运行测试或制造磁盘耗尽，因此“会不会真的发生”属于推断，但代码路径和回滚顺序是读代码确认的。
- 作者说“迁移 0095 从未合并或上线、没有持久库应用过”：`git log --all` 只显示它在 `2ad82e6f` 及之后的本次分支提交中出现，支持“未进 main”；但“没有持久库应用过”无法在仓库内核实。

## 侧重检查

- 错误路径：重点查了 `#settle` 抛错后的 `confirm` 回滚（问题 1）、重置失败的载荷恢复（问题 2）、删除后写入窗口（问题 3）。确认 `#settle` 内部对单条依据解析失败有 `catch`，但 `listPending`/`decide` 的失败没有兜底。
- 不合规范/不可信输入：`proposalId` 在 `confirm/reject` 和 SQLite 两侧都用 `rule-proposal:[0-9a-f]{32}` 校验；`target` 走网关 `machineString`。`threadId` 来自运行时上下文而非模型参数；外键失败会以端口错误冒出，但模型不能直接指定。`evidence.trials/replay` 的结构未校验（可让列表查询抛错）——这属于材料里已列为“可以更好”的“载荷结构校验”，按要求不重复。
- 安全：`confirm/reject/listPending` 都带 `ownerId+agentId` 过滤，跨 owner/agent 的提议无法被采纳或拒绝；MCP `listed:false` 提议不建表行，`reject` 返回 `RULE_NOT_FOUND` 有测试。未发现越权。
- 资源耗尽：`#settle` 每次激活会解密最多 `limit` 条待采纳载荷，默认 20，SQLite 侧 `listPending` 再钳到 200；`decide` 有磁盘余量检查。除问题 1 的磁盘失败路径外，没有新的无界循环或放大。
- 不可撤销操作：本轮没有新增删除规则/记忆的操作；`#settle` 只是把提议标成 accepted，载荷保留，“撤销后再采纳”仍可走。未发现不可逆的新增。
- 规则/文档/代码一致性：`docs/architecture-v0.1.md:420` 与代码主体一致，存在上面问题 2、4 两处措辞强于实现的地方；提示词目录、`rule_set` 工具定义未改（见下）。

## 必答问题

1. **会不会改变模型已经见过的请求开头？**
   从代码看不会。`git diff` 未触及 `packages/prompt-catalog`，`ownerRuleToolDescriptors` 的 `rule_set/rule_list/rule_undo` 定义在本轮增量里没有变化；新增的 `memory.ruleProposals.read/.snapshot` 是控制中心查询，不进入模型请求；`#settle` 只改提议表状态，不改历史消息、系统提示、工具定义或遮盖结果。`rule_set` 的返回值仍作为当轮工具结果追加，没有改写已存历史。结论：发给模型的内容仍是只在末尾追加，每轮会变的值没有加进系统提示/工具定义/历史。`check:prompt-prefix` 未运行（受限），属“未核实”，但静态检查支持该结论。

2. **会不会让同一段文字在不同请求里变成不同字节？**
   模型可见内容不会。提议编号由 `canonicalJson` + 规范化后的 params（数组已排序去重）生成，是确定的；原话、试算、回放都在提议时存进载荷，读取不重算。唯一新颖的带时间字段是控制中心快照里的 `generatedAt`（`production-memory-control.ts:573` 附近），它不在模型请求里；待采纳列表顺序固定为 `ORDER BY proposed_at, id`。`#settle` 改变的是“哪些行还是 pending”这一状态，不改变同一段文字的字节。前提是不要把该快照塞进提示词。

3. **有没有对应的自动检查，反向用例会不会真的失败？**
   有。`test/integration/production-memory-capture.test.ts:2609` 断言生效后同参数待采纳提议被清掉：去掉 `#settle` 时 `pendingCount` 会是 2 而不是 1，会失败。`:2634` 断言重写依据失败后旧 quote 仍在：去掉 restore 时旧载荷已被删、`quote` 会变 null，会失败。另有控制中心的 `REVERSE: shows no waiting-proposal section...`。覆盖缺口见上面第 5 条。测试未运行，属静态判断（未核实）。

4. **每个新产生/修改的值，两端校验都接受吗？**
   逐项核对后没有发现两端不兼容：
   - `proposalId`：`:732-741` 生成 `rule-proposal:<32hex>`（46 字符）→ SQLite 正则 `sqlite-owner-rule-proposal-operations.ts:13` + 迁移 `id CHECK length 1..128` → `confirm/reject` 正则 `:58` → 网关 `machineString`（≤128、字符集允许 `:`）→ 控制中心回传 `target: machineString`。全部接受。
   - `type`：`parseOwnerRuleParameters` 限定类型 → 迁移 `rule_type 1..64` → 快照 `slice(0,64)` + `boundedString(64)`。接受。
   - `summary`：`validRuleSummary` ≤200 且无控制符 → 迁移允许 1..400 → 快照 `slice(0,200)` + `boundedString(200)`。接受（迁移比契约宽，只是松）。
   - `quote/trials`：`clip` 经过 `singleLine` 并截断 → 契约 `nullable(boundedString(500/200))`。接受。
   - `origin/status/timestamps/reject_count`：迁移枚举、GLOB、`CHECK ((status='pending')=(decided_at IS NULL))` 与代码 `decide(to='pending')` 置 null 一致；快照用 `enumeration/timestamp/integer(0)`。接受。
   - `limit/expiresAfterDays`：默认 20/30 满足 `integer(1)`；只在测试里被改成 1/2/3，合成路径没有传更小的值。若外部把 `proposalLimit` 配成 0 会使响应违反 `integer(1)`，但当前不可达（推测，非本次改动引入的必现问题）。
   - 新动作 `reject`：`OWNER_RULE_ACTIONS`、控制中心 `OwnerRuleAction`、`production-memory-control.ts:1284` 分支、`ProductionOwnerRuleWriter.reject` 一致。
   - 新错误码：`OwnerRuleErrorCode` 增加，`production-memory-control.ts:1297-1303` 统一映射为 `NOT_FOUND`/`INVALID_OPERATION`，测试按字符串断言。
   - 新消息类型/操作：`GATEWAY_V2_MESSAGE_TYPES`、`schemasByType`、contract fixture、`PRODUCTION_MEMORY_OPERATIONS`（`production-memory-control.ts:68`）、`production-http-composition.ts:683` 与控制中心 `installedGatewayV2Operations.includes("memory.ruleProposals.read")` 对得上。
   - 新端口 `ownerRuleProposals()`：`durable-adapters.ts:1019` → `sqlite-durable-operations.ts` 的 `ownerRuleProposal.` 前缀分发 → `product-state-repository.ts` → 两处构造 `ProductionOwnerRuleWriter` 都传入。
   - 迁移 95：`migration-engine.ts` 列表、`schema-catalog.ts`、三个测试常量、`workspace-lifecycle-audit.mjs` 的 `SUPPORTED_SCHEMA_MAX` 都同步到 95。

## 结论

第 4 轮的 `#settle` 功能本身与文档目标一致，反向测试也能真正失败；主要风险是 **`#settle` 作为规则生效后的可失败步骤导致“已生效却回滚为待采纳、随后还能拒绝”**（问题 1），以及 **失败恢复静默吞错/先删后写的载荷一致性**（问题 2、3）。其余为文档措辞和测试覆盖的改进项。
