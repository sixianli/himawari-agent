# PR 436 第 10 轮复核（ba4cb513 对比 162c431a）

先说结论：第 10 轮要改的 12 条基本都落到了代码里，我没有找到会破坏规则路径或重复执行不可撤销动作的新缺陷。下面按严重度列出我发现的问题；其中 1、2 条不是本轮新引入，但本轮把截断改成 UTF-16 后影响更明显，仍建议处理。

## 读代码证实的

### 1. 中：`effect`（“采纳后会发生什么”）存 400、界面/契约只给 200
- 文件:行：`apps/agent-service/src/production-proposals.ts:134`、`apps/agent-service/src/production-proposal-control.ts:55`、`packages/gateway-contracts/src/contracts-v2.ts:1669`
- 问题：入箱允许 `effect` 最长 400 个 UTF-16 单元，但网关快照和契约只保留 200。`effect` 是主人判断“要不要让它去做”的关键说明，采纳又可能不可撤销；主人可能只看到前 200 个字符就点了采纳。
- 证据：
  ```ts
  const SENTENCE_LENGTH = 400;               // production-proposals.ts:134
  !sentence(input.effect, SENTENCE_LENGTH)   // :292
  effect: shownText(proposal.effect, 200),   // production-proposal-control.ts:55
  effect: boundedString(200),                // contracts-v2.ts:1669
  ```
- 建议：把 `effect` 的入箱上限也收到 200，或让契约/快照支持全文并在 App 里展开显示；至少不要出现“存得下、看不到”的差距。

### 2. 低：列表显示的 `type` 与实际分派用的 `type` 可能不是同一个值
- 文件:行：`apps/agent-service/src/production-proposals.ts:136-143,493`、`apps/agent-service/src/production-proposal-control.ts:53`
- 问题：`sentence` 只要求“去掉控制符后非空”，不要求显示值等于原值。含 Bidi 控制符的 `type` 能入箱；列表显示时 `shownText` 会删掉控制符，而 `adoptable` 和 `adopt` 分派用的是原始 `row.type`。于是主人看到的类型名可能对应不到实际处理方（或反之）。
- 证据：
  ```ts
  function sentence(...) {
    return typeof value === "string" && ... && shownText(value, maximum).length > 0;
  }
  ...
  adoptable: this.#handlers.has(row.type),        // 用原始 type
  type: shownText(proposal.type, 64),             // 显示去控制符后的 type
  ```
- 建议：入箱时要求 `shownText(type, 64) === type`（type 本来就不该含控制符），或统一用规范化后的 type 存储和分派。当前只有内部可信调用方创建通用提议，风险低。

### 3. 低：并发提议同一编号时可能留下孤儿依据载荷
- 文件:行：`apps/agent-service/src/production-proposals.ts:295,337-338`
- 问题：`existing` 在事务外读取，成功后只删除 `existing.evidenceRef`。两个并发提议同一 `proposalId` 时，后写者会覆盖前写者的 `evidence_ref`，前写者刚写的载荷可能没有任何表行引用，也不会被删除（只占存储，不影响正确性）。
- 证据：
  ```ts
  const existing = await store.read({ ...scope, proposalId, now });   // 事务外
  ...
  if (existing?.evidenceRef && existing.evidenceRef !== evidenceRef)
    await payloads.delete(existing.evidenceRef as never).catch(() => false);
  ```
- 建议：让存储层的 `propose` 在同一事务里返回被替换的旧 `evidenceRef`，由箱删除它；或写表后按当前行的 ref 再删一次。第 8 轮已存在，非本轮新增。

### 4. 低：`list`/`settle` 受配置上限截断，调低上限后多出的待采纳提议看不到
- 文件:行：`apps/agent-service/src/production-proposals.ts:431-433,480`、`packages/persistence-sqlite/src/sqlite-owner-proposal-operations.ts:221-237`
- 问题：`listPending` 用 `LIMIT this.limit` 取列表，但 `pendingCount` 是 `COUNT(*)`。如果运行中把 `pendingLimit` 调低到低于已有 pending 数（重启后生效），快照会显示 `pendingCount > proposals.length`，多出的提议无法在列表里看到、采纳或被 `settle`。
- 证据：
  ```ts
  .listPending({ ...scope, now, limit: this.limit })   // production-proposals.ts:432,480
  const limit = Math.min(Math.max(1, Math.trunc(input.limit)), MAX_LISTED);  // store:221
  ... ORDER BY proposed_at, id LIMIT ?                 // store:228
  ```
- 建议：把“新提议上限”和“列表读取上限”解耦：列表按固定最大值分页或全量读取，只有 `propose` 使用 `pendingLimit`。第 9 轮已存在。

### 5. 低（一致性）：`clearEvidence` 没有磁盘余量检查
- 文件:行：`packages/persistence-sqlite/src/sqlite-owner-proposal-operations.ts:314-325`
- 问题：同文件的 `propose`/`decide` 都先 `assertDiskHeadroom()`，`clearEvidence` 没有。它本身是清理引用、不增长数据，影响很小，但和同层写操作不一致。
- 证据：
  ```ts
  private clearEvidence(...) {
    return this.database.prepare(`UPDATE owner_proposals SET evidence_ref = NULL ...`).run(...).changes > 0;
  }
  ```
- 建议：加上检查，或注释说明清理路径刻意不加。

## 推测 / 未核实

- **迁移 0095 原地改主键的既有库风险**：`migration-engine.ts:799-803` 会校验 SQL 文件 digest，`:876` 会校验 ledger 与定义 digest 一致。若某个开发/持久库曾应用过第 3 轮的单列主键 0095，本轮改成 `(owner_id, agent_id, id)` 会导致启动报 “Migration 95 SQL no longer matches its digest”。作者称“从未应用到任何持久库”，我无法从代码验证。建议在合并前确认所有环境，或改为新增迁移。
- **复合主键跨 agent 隔离没有专门测试**：代码里 store 的 `fetch`/`decide`/`clearEvidence` 都带 `owner_id`/`agent_id`，看起来正确；但测试辅助 `shownVersion` 用 `WHERE id = ?` 单列查（测试代码，非生产）。建议补一条两个 agent 同 id 的存储测试。
- **`release` 两次失败停在 accepted 没有专门用例**：代码 `back().catch(() => back().catch(() => undefined))` 与文档一致，但我没找到“handler 失败且两次 release 都失败”的测试。
- **`settle` 带版本号+指纹的并发竞争没有专门用例**：代码 `expected: { version: row.version, fingerprint: row.fingerprint }` 正确，但没有测试覆盖“列列表后、settle 前被重新提议”的场景。

## 侧重检查

- **错误路径**：`adopt` 认领 pending→accepted 后，读依据失败或处理方失败会 `release()` 退回 pending，退回失败重试一次，仍失败停在 accepted（`production-proposals.ts:375-391`）；`reject` 首次 `decide` 失败会重读、必要时再试一次（`:415-424`）；`settle`/`sweep` 全部 `catch` 吞掉，不影响规则生效（`:431-454,457-470`）。结论：规则生效和采纳结果不会被清理/结算失败拖垮，和文档一致。
- **不可信输入**：`proposal.respond` 契约要求 `proposalId: machineString`、`expectedVersion: integer(1)`、`fingerprint: machineString`、`action` 枚举（`contracts-v2.ts:1697-1705`）；`execute` 再校验 actor=owner 且 scope 匹配（`production-proposal-control.ts:94-99`）；箱里再校验 `PROPOSAL_ID_PATTERN`（`production-proposals.ts:288-294`）。发现的缺口是第 2 条的 type 显示/分派不一致。
- **不可撤销操作**：`repeatable` 只给了规则处理方（`production-owner-rules.ts:461-462`），非 repeatable 处理方二次采纳报 `PROPOSAL_ACCEPTED`（`production-proposals.ts:374`），能防止重复执行发消息/花钱类动作。认可。
- **资源耗尽**：上限 1–200、过期 1–3650 在 `strict-configuration.ts` 和箱构造函数两处都校验；`propose` 先写新载荷，失败或已满删掉，成功后删旧；`#sweep` 批量 100。发现第 3、4 条的低风险。
- **规则/文档一致性**：`docs/architecture-v0.1.md` 关于“指纹含来源标记”“已采纳再采纳只对 repeatable 重执行”“退回失败重试一次停在已采纳”“已采纳保留依据”“去控制符后非空”与代码一致；作者第 10 轮 12 条说法逐条对照代码均成立（含第 8 条对 `payloads.delete(...).then(() => true)` 的反驳）。
- **规则路径重构是否退化**：`#activate` 两个出口都调用 `#settle`；`confirm` 对表行走 `box.adopt`、对旧载荷走 `#readProposal`；MCP 用 `listed:false` 仍走旧载荷并在 `accept` 里当场 `confirm`（`production-mcp-rule-writer.ts:80-85`）。未发现退化。

## 必答问题

1. **会不会改变模型已经见过的请求开头？** 不会。本轮 diff 未触及 `packages/prompt-catalog`、系统提示、工具描述或历史组装；`ownerRuleToolDescriptors` 未改，只给 handler 加了 `repeatable`。新增的是网关查询/命令、SQLite 表、加密载荷。发给模型的内容仍然只在末尾追加（`rule_set` 的返回是本轮工具结果）。每轮会变的值（`generatedAt`、回放数字、载荷引用）都在网关快照/工具结果里，不在系统提示或工具定义里。注：当已有同参数生效规则时，`rule_set` 返回 active 回执而不是 proposed，这是工具结果内容变化，但仍是追加，不改写已发历史。

2. **会不会让同一段文字在不同请求里变成不同字节？** 不会（对模型请求而言）。指纹用 `canonicalJson`（对象键排序）+ 显式数组顺序，`origin` 已纳入；`evidenceRef` 用随机 UUID，但只作内部载荷引用，不进指纹、不进模型请求。提案列表不发给模型。未发现依赖前后文的遮盖或无序列化。

3. **有没有自动检查，反向用例是否真会失败？** 有。`test/integration/production-memory-capture.test.ts`（真实 SQLite）覆盖：非 repeatable 二次采纳报 `PROPOSAL_ACCEPTED`、`PROPOSAL_INVALID`（控制符/超长/坏编号）、200 个 emoji 按 UTF-16 截成 100、同内容重提不升版本、旧版本/错指纹 `PROPOSAL_CHANGED`、无处理方 `PROPOSAL_TYPE_NOT_ADOPTABLE`、未知动作。这些用例在对应代码被回退时会失败。缺口见“推测/未核实”：`settle` 版本指纹竞争、`release` 两次失败、跨 agent 复合主键、迁移 digest 既有库场景。

4. **每个产生的值，使用它的地方都能接受吗？** 逐项核对：
   - `proposalId`（`^[a-z][a-z0-9-]{0,31}:[0-9a-f]{32}$`，最长 66）→ 存储层 `PROPOSAL_ID`、契约 `machineString`（≤128）都接受。
   - `evidenceRef`（`proposalId + ":" + 16 hex`，最长 83）→ `payloads.ref` 无长度限制、`payloads` 表 `ref TEXT PRIMARY KEY` 无长度限制，接受。
   - `type`/`summary`/`effect`：JS 侧按 UTF-16 限 64/400/400，SQLite `length()` 按码点计数，UTF-16 长度 ≥ 码点，安全；`shownText` 输出按 UTF-16 截断，正好满足契约 `boundedString` 的 `input.length` 判断。
   - `origin` 三值 → store `ORIGINS` 与契约 `PROPOSAL_ORIGINS` 一致；`status` 四值 → store `STATUSES` 与表 CHECK 一致；`version` ≥1；`fingerprint` 64 hex → store 正则与契约 `machineString` 接受；`source_version` 依赖 `source_ref`、`thread_id` 走外键，均一致。
   - 配置键 `runPolicy.ownerProposals.pendingLimit/expiresAfterDays` → `strict-configuration.ts` 与箱构造函数都校验 1–200/1–3650，一致。
   - 发现的接受差异只有第 1 条（`effect` 存 400/显示 200）和第 2 条（`type` 显示去控制符、分派用原值）。
