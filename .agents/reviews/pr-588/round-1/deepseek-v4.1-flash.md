我先看改动范围和仓库约定。
## 侧重检查

- **错误路径**：检查了 `sync` 的空批次、超条数、待确认满、数据库异常，以及 `find_memories` 带非法/未知项目名、项目名不带 project 的路径。发现 `MCP_SYNC_FULL` 的映射可用，但 payload 写入在事务之外（见意见 2），以及已有条目改 kind 会让整批失败（意见 5）。
- **不合规范或不可信输入**：检查了稳定编号、项目名、正文、类别、`versionTag`、kind、project 缺失。项目名的查询串/令牌检查有绕过（意见 4）；`project_note` 缺 project 被接受但之后搜不到（意见 6）。
- **安全**：检查了机器密钥扫描、项目名存储与回显、删除来源校验、跨接入项目合并。正文有 `scanMachineSecrets`（`production-mcp-sync.ts:396`），项目名没有；`find_memories` 的读取结果会经过 `maskForExternalRead`，但项目名本身仍明文落库。删除只看“这次请求从哪进来”，没有记录条目当初从哪进来（意见 3）。
- **资源耗尽**：批次条数和正文长度有上限；项目笔记搜索每次最多取 100 条并逐条解密（`production-mcp-sync.ts:140,182`），有上限但可被反复调用；真正的问题是失败批次留下的 payload（意见 2）。
- **不可撤销操作**：删除会把条目置 `deleted` 或写 `source_deleted_at`，并把待确认提议改成 `superseded`；有刹车和“少了 N 条”的 attention 记录。未发现删除/项目笔记写入写决策账本；这是设计取舍，未核实是否另有要求。
- **规则/文档一致性**：ADR 0242 与代码大体一致，但“整批回滚、库里不留半批”“只删服务令牌接入写入的条目”“项目笔记要填 project”“敏感笔记逐条确认”都与当前代码有出入（意见 2、3、6、8）。新表没有进 `schema-catalog.ts`（意见 1）。`check:prompt-prefix` 管不到 MCP 侧，ADR 也这样写。

## 意见

### 1、高：新增的 9 张表没有登记进 schemaCatalog，迁移目录一致性测试会失败

文件：`packages/persistence-sqlite/src/migrations/20261115124342_mcp_memory_sync.sql:1-129`、`packages/persistence-sqlite/src/schema-catalog.ts:694-707`、`packages/persistence-sqlite/test/migration-engine.contract.test.ts:80`

问题：迁移新建了 `mcp_projects`、`mcp_project_names`、`mcp_sync_entries`、`mcp_sync_versions`、`mcp_project_approvals`、`mcp_sync_deletion_days`、`mcp_sync_attention`、`mcp_sync_attention_entries`、`mcp_sync_limits` 九张表，但 `schemaCatalog` 里没有对应条目。仓库现有测试要求数据库表和目录完全相等：

证据：
```ts
// migration-engine.contract.test.ts:80
expect(tables).toEqual(schemaCatalog.map(({ table }) => table).sort());
```
`schema-catalog.ts` 在 `mcp_connections`、`mcp_connection_usage_daily` 之后直接进入 `memory_checkup_items`，没有上述九张表。规范文档也写明“新表全部登记进表结构目录（`schema-catalog.ts`）”。

建议：给九张表各补 `entry(...)`（产品端口、生命周期、加密分类、删除关系），再跑 `migration-engine.contract.test.ts`。同时确认数据导出是否要包含这些表；当前 `data-export/snapshot.ts` 和 `import.ts` 也没有它们。

### 2、高：payload 在同步事务之外写入，批次失败会留下孤儿内容，和“整批原子”的说法不符

文件：`apps/agent-service/src/production-mcp-sync.ts:259-270, 297-320, 428-450`

问题：`sync` 在调用 `store.push`（唯一的事务入口）之前，就把每个条目的正文写进了 payload 存储；`store.push` 失败（例如待确认满、条目 kind 冲突、数据库错误）只回滚 `mcp_sync_*` 表，不会回滚 payload。作者说“整批原子”“失败整批回滚、库里不留半批”，代码做不到。

证据：
```ts
// production-mcp-sync.ts:268-270
stored.push(this.#storeText(syncRef, parsed.text, parsed.classification));
if (proposalRef !== null)
  stored.push(this.#storeText(proposalRef, parsed.text, parsed.classification));
...
// :297
await Promise.all(stored);
...
// :303
result = await this.#options.store.push({ ... });
```
`#storeText` 直接调用 `payloads.put`（`:436-445`），没有事务。对比现有提议流程在满额时会 `dropPayload`：
```ts
// sqlite-external-memory-proposal-operations.ts:170
if (!this.contentInUse(input.contentRef)) this.dropPayload(input.contentRef, input);
```
同步路径没有对应清理。集成测试“rolls the whole batch back”只数了 `mcp_sync_entries` / `mcp_sync_versions`，没有数 payload。

建议：要么把 payload 写入纳入同一个数据库事务；要么在 `store.push` 失败时按本次产生的 ref 逐个清理，且只在确认没有其他引用时删除。补一条“失败后 payload 数量不变”的反向测试。

### 3、中：删除只检查“本次请求是服务令牌”，没有记录/校验目标条目当初是否由服务令牌写入

文件：`packages/persistence-sqlite/src/sqlite-mcp-memory-sync-operations.ts:316-318`、`packages/persistence-sqlite/src/migrations/20261115124342_mcp_memory_sync.sql:27-53`

问题：作者说“删除只能由助手带版本标记发起且只删服务令牌接入写入的条目”。代码只做了前半句：
```ts
if (input.entry !== "service_token")
  return input.deletes.map(({ index }) => ({ index, status: "not_accepted" as const }));
```
但 `mcp_sync_entries` 没有记录“这条是用 oauth 还是 service_token 写的”，只有 `connection_id`。因此服务令牌一旦接入，就能删除同一接入此前通过 OAuth 写入的条目，无法兑现“只删服务令牌写入的条目”。

目前服务令牌入口还没接（ADR 也这么写），所以现在不可触发；但这正好是 I-73 那类“产生端和使用端没对齐”的问题。建议：
- 在 `mcp_sync_entries` 增加写入方式列（如 `written_entry TEXT CHECK (written_entry IN ('oauth','service_token'))`），删除时同时校验 `input.entry === 'service_token'` 和目标行的写入方式；
- 或者把作者说法改成“删除只接受服务令牌进门的请求”，与 ADR 保持一致。

### 4、中：项目名只按“像 URL”检查凭据，`?token=` 这类查询串和不带 scheme 的路径能通过，且没有机器密钥扫描

文件：`apps/agent-service/src/mcp-project-name.ts:39-66`、`apps/agent-service/src/mcp-project-name.ts:75-82`、`test/integration/mcp-memory-sync.test.ts:208-238`、`packages/prompt-catalog/src/tools.ts:388`

问题：`projectNameHasCredential` 只在 `new URL` 成功、或字符串含 `://` / `//` 且含 `@ ? #` 时才检查；`主机/路径?token=1`、`notes?api_key=secret` 这类不带 scheme 的字符串直接放行。测试的“接受”列表明确包含：
```ts
"主机/路径?token=1",
```
而工具描述写的是“不要带登录名、令牌或查询参数，带了这一条会被拒”（`tools.ts:388`）。项目名会明文写入 `mcp_projects.display_name` / `mcp_project_names.name`，还会通过 `find_memories` 的 `project` 字段回给外部 agent，因此这是能持久化并回显的凭据路径。`scanMachineSecrets` 只扫正文，没有扫项目名。

建议：项目名统一拒绝 `?`、`#`、`@`、`:` 等 URL 凭据分隔符，或至少对非 URL 形状的名字也跑 `scanMachineSecrets`；同时把测试里的 `主机/路径?token=1` 从“接受”改成“拒绝”，并补一条 `?token=` 的反向用例。

### 5、中：同一个稳定编号改 kind 会让整批失败，而不是只把这一条标为 invalid

文件：`packages/persistence-sqlite/src/sqlite-mcp-memory-sync-operations.ts:518-520, 644-646`、`apps/agent-service/src/production-mcp-sync.ts:329-339`

问题：`#parseEntry` 无法知道已有条目的 kind；到 `applyOwner` / `applyNote` 发现 kind 不一致时，调用 `this.invalid()`，它通过 `fail(...)` 直接抛错，整个 `store.push` 事务回滚。`ProductionMcpSync` 随后只能返回泛化的 `MCP_SYNC_MEMORIES_FAILED`，同一批其他合格条目也不会保存。这和 ADR“每条的稳定编号、项目名、正文、类别各自校验，不合格的只在这一条的结果里写原因，不影响同一批的其他条目”不一致。

证据：
```ts
// sqlite-mcp-memory-sync-operations.ts:520
if (existing !== undefined && existing.kind !== "owner") return this.invalid();
...
// :646
if (existing !== undefined && existing.kind !== "project_note") return this.invalid();
```
`production-mcp-sync.ts:336-339` 里“没拿到结果就返回 `kind_changed`”的分支因此永远不会走到。

建议：在事务内查到 existing 后，把 kind 冲突转成 `{index, status:"invalid", reason:"kind_changed"}`，不要抛整批错误；或者明确把 kind 当作批次级身份冲突写进工具说明，并补测试。

### 6、中：`project_note` 不带 project 会被接受并写进 `proj-none`，但 find_memories 永远搜不到

文件：`apps/agent-service/src/production-mcp-sync.ts:382-405`、`packages/persistence-sqlite/src/sqlite-mcp-memory-sync-operations.ts:249`、`packages/persistence-sqlite/src/sqlite-mcp-memory-sync-operations.ts:148-191`

问题：工具描述说“project（项目名，项目笔记要填）”，但 `#parseEntry` 只在 project 非法时拒绝，缺省或空字符串返回 `null`；随后 `projectFor` 把 `null` 映射成保留项目 `proj-none`。`projectNotes` 查询需要 `mcp_project_names` 里有对应名称并 join `mcp_projects`，`proj-none` 没有名称行，因此这类笔记写入后既不能通过 `find_memories(project=...)` 找到，也不会出现在任何项目搜索结果里。

证据：
```ts
// production-mcp-sync.ts:382
const project = checkProjectName(entry["project"], limits.project_name_chars);
...
// :398
projectName: project.value,
// sqlite-mcp-memory-sync-operations.ts:249
if (name === null) return MCP_SYNC_RESERVED_PROJECT_ID;
```
集成测试还专门把 `note("a:b", "...", undefined)` 作为可接受输入。

建议：`kind === "project_note"` 时要求 project 非空并返回 `project_invalid`；如果确实要支持无项目笔记，需要让 `proj-none` 也能被某个明确的查询入口读到，并在工具说明里写清楚。

### 7、中：【推测】主人批准项目后，内容未变的旧笔记仍停在 `awaiting_project_approval`

文件：`packages/persistence-sqlite/src/sqlite-mcp-memory-sync-operations.ts:650-691`

问题：`applyNote` 在正文没变时，`keep` 优先保留 `existing.state`：
```ts
const keep =
  existing.state === STATE_DELETED || existing.state === STATE_REFUSED
    ? state
    : existing.state;
const revived = existing.state === STATE_DELETED || existing.sourceDeletedAt !== null;
const settled = revived ? state : keep;
```
因此 `existing.state === "awaiting_project_approval"` 时，即使 `mcp_project_approvals` 已变成 `approved`，重复推送同一正文仍保留 `awaiting_project_approval`，只有正文变化或条目被删后重推才会重新计算 `state`。本 PR 还没有批准写入口，所以当前不会触发；一旦后续页面接上批准，这就是“批准了但笔记还不出现”的 bug。

建议：正文未变时也把当前 `approval` 结果纳入 `settled` 计算（至少对 `awaiting_project_approval` 生效），并加“批准后重发同一正文应变成 active”的用例。

### 8、中：【推测/设计缺口】敏感项目笔记没有逐条确认的存储或读取路径，写入后永远读不到

文件：`packages/persistence-sqlite/src/sqlite-mcp-memory-sync-operations.ts:650-657, 176`、`packages/persistence-sqlite/src/migrations/20261115124342_mcp_memory_sync.sql:27-53`

问题：敏感项目笔记一律进入 `STATE_AWAITING_CONFIRMATION`，而 `projectNotes` 只查 `state = 'active'`：
```ts
const state = item.classification === "sensitive"
  ? STATE_AWAITING_CONFIRMATION
  : approval === "approved" ? STATE_ACTIVE : ...;
...
AND e.kind = 'project_note' AND e.state = ?
```
本 PR 的迁移没有“项目笔记逐条确认”表，也没有任何代码把 `awaiting_confirmation` 改成 `active`。ADR 说“涉及健康、财务等敏感内容的仍要主人逐条确认”，但当前只有写入、没有确认路径。作者说待确认页属于后续 C2/C3，所以这可能是有意留到后续；但需要确认后续是否新建表，否则这些正文会永久不可读。

建议：明确本 PR 的范围并在 ADR 写清“敏感项目笔记在后续 PR 前不可读”；后续补确认表/状态迁移，并补端到端用例。

### 9、低：【推测/边界】同一个待确认提议被多个条目共享时，`replacedMemory` 只取一条，可能只接替一条旧记忆

文件：`packages/persistence-sqlite/src/sqlite-mcp-memory-sync-operations.ts:136-146, 563-566`

问题：`external_memory_proposals` 按 `(owner, agent, text_sha256)` 去重，不同接入/项目的多条 owner 条目可以有同一个 `proposal_id`。每条目可能写入不同的 `replaces_memory_id`；确认时 `replacedMemory`：
```sql
SELECT replaces_memory_id FROM mcp_sync_entries
WHERE ... AND proposal_id = ? AND replaces_memory_id IS NOT NULL
ORDER BY entry_id LIMIT 1
```
只返回其中一条。`ProductionMcpMemoryWriter` 因此只 `supersedes` 一条旧记忆，其他旧记忆仍是 active。这个场景需要“多条目共享同一正文且各自有旧记忆”才会出现，属于边界。

建议：如果需要多对一接替，返回全部 `replaces_memory_id`；或者把 proposal 去重粒度改成“接入 + 稳定编号/项目”，避免共享提议。

### 10、低：项目笔记搜索结果的 `updatedAt` 和排序随 `last_synced_at` 变化，重复查询字节不稳定

文件：`packages/persistence-sqlite/src/sqlite-mcp-memory-sync-operations.ts:165-180`、`apps/agent-service/src/production-mcp-sync.ts:216`、`packages/persistence-sqlite/src/sqlite-mcp-memory-sync-operations.ts:679`

问题：搜索结果按 `e.last_synced_at DESC, e.entry_id` 排序，并返回 `updatedAt: note.lastSyncedAt`。同步同一正文的“未变”分支也会更新 `last_synced_at`（`:679`），所以同一个查询在重复同步后返回的 JSON 字节会变（包括顺序）。它只出现在本轮追加的工具结果里，不改变已发前缀；但如果要求“同一段文字/同一查询每次字节相同”，这里不满足。

建议：如果要严格确定性，返回稳定排序（例如 `entry_id`）并去掉 `updatedAt`，或把“本次同步时间”只放在单独的最新结果里，不要参与搜索结果的排序和序列化。

### 11、低：新表的 `state` / `status` 只校验长度，没有枚举约束，拼错会静默隐藏数据

文件：`packages/persistence-sqlite/src/migrations/20261115124342_mcp_memory_sync.sql:44, 80, 109`

问题：`mcp_sync_entries.state`、`mcp_project_approvals.status`、`mcp_sync_attention.status` 都是：
```sql
state TEXT NOT NULL CHECK (length(state) BETWEEN 1 AND 32),
status TEXT NOT NULL CHECK (length(status) BETWEEN 1 AND 16),
```
而读取端用精确字符串比较（`state = 'active'`）。一旦代码笔误或未来新增状态时写错，数据会静默不可见，不会在写入时被数据库拒绝。现有 `mcp_connections.status` 用的是 `CHECK (status IN (...))`，风格不一致。

建议：把已知状态写进 `CHECK IN (...)`；后续新增状态时走迁移，这样 I-73 那类“产生端和使用端不一致”能在数据库层暴露。

## 必答问题

**1. 这个改动会不会改变模型已经见过的请求开头？发给模型的内容是不是仍然只在末尾追加，每轮会变的值是不是都在最后一条消息里？**

- 对 **Himawari 自己发给模型的请求**：不会。新的 `MCP_TOOL_SYNC_MEMORIES`、`MCP_FIND_PROJECT_NOTES_LABEL`、结果说明都只在 `apps/agent-service/src/production-mcp-read.ts` 对外 MCP 服务里使用；全仓库没有把它们放进 Himawari 自己的系统提示或工具定义（`MCP_TOOL_FIND_MEMORIES` 的 `usedBy` 也只有 `production-mcp-read.ts`）。系统提示、工具定义、历史消息、遮盖规则都没有新增每轮变化的值。
- 对 **外部 MCP 客户端**：会变一次。`mcp.find-memories` 的工具描述被改写，工具清单里新增了 `sync_memories`；这是外部 agent 那一侧的工具定义变化，不是追加，首个使用新版本的请求前缀会失效一次。ADR 0242 已写明“外部 agent 那边工具清单会变一次”，不属于 Himawari 的请求前缀。
- **末尾追加**：`sync_memories` 的逐条结果、`find_memories(project=...)` 的项目笔记结果都是工具结果，出现在本轮末尾；`updatedAt` 这类会变的值只在工具结果里，不在系统提示或工具定义里。
- 结论：按 `.agents/instructions/prompt-prefix.md` 的规则 4，Himawari 自己的请求仍然只追加；唯一不“只追加”的是外部客户端工具定义，这是 ADR 允许的一次性变化。**未核实**实际 `npm run check:prompt-prefix` 运行结果，只按代码路径核对。

**2. 会不会让同一段文字在不同请求里变成不同的字节？**

- 正文和版本标记：不会。`normalizeNoteText` 是确定性的 NFC、CRLF→LF、隐藏字符替换；`normalizeProposalText` 也是确定性的；`sha256` 只依赖规范化后的正文。项目名经过 NFC + trim，同一输入得到同一字符串。没有依赖前后文的遮盖逻辑。
- `syncRef` / `proposalContentRef` 的哈希还包含 owner、agent、classification、kind；同一段正文如果换 kind 或分级，会得到不同 ref，这是设计上区分存储，不是随机差异。
- 例外：项目笔记搜索结果的 `updatedAt` 来自 `last_synced_at`，排序也按 `last_synced_at`；未变内容重发也会刷新它，因此同一查询在不同时间会得到不同字节。它只在本轮工具结果（末尾）里，不改变已经发出去的前缀；但严格按“同一查询字节相同”看，不满足（见意见 10）。

**3. 改动有没有对应的自动检查，反向用例是否真的会失败？**

有对应检查，但覆盖不均：
- `npm run check:mcp-sync`（`test/tooling/mcp-sync-check.test.ts`）：检查五份类别清单一致、表的类别 CHECK、稳定编号从推送到存储和读取、生成编号通过 `machineString`。类别“多一个/少一个/重复”有明确反向断言；长编号、隐藏字符也有断言。这个检查已加入 `check:steps`。
- `test/integration/mcp-memory-sync.test.ts`：覆盖待确认、版本、项目隔离、项目名凭据、类别、密钥拒收、批次回滚、OAuth 删除拒绝、版本不匹配、刹车、跨接入隔离、owner_deleted、计数。很多是“如果行为改掉会失败”的断言，但**没有实际运行**，未核实。
- `test/integration/mcp-write.test.ts` 加了真实 MCP 路由的 `sync_memories` 用例，检查计数、批次过大、项目批准前搜不到、批准后搜到、敏感分级。
- **反向用例缺口**：没有“kind 改变应只让这一条 invalid”的用例；没有“服务令牌不能删 OAuth 写入条目”的用例（因为服务令牌入口未接）；没有 payload 失败后不残留的用例；没有批准后重发同一正文能激活的用例；没有敏感项目笔记确认路径；没有 `replaces_memory_id` 到 `supersedes` 的端到端用例。`check:mcp-sync` 只覆盖类别和编号，不覆盖上述逻辑。`mcp-write.test.ts` 中批准是直接 SQL `UPDATE`，不是产品批准路径，因此“批准两端”没有被自动检查真正覆盖。
- 另外，意见 1 的 `migration-engine.contract.test.ts` 目前按代码会失败；如果 CI 跑了这个 contract test，这就是现成的红灯。

**4. 每个新产生的值，产生它的地方和使用它的地方都能接受吗？**

逐项核对结果：

- **`proj-` 项目编号 / `proj-none`**：产生于 `sqlite-mcp-memory-sync-operations.ts:258-269`；`mcp_projects.id` 和 `mcp_sync_entries.project_id` 的 CHECK 都接受 `proj-` + 24 位十六进制和 `proj-none`；`test/tooling/mcp-sync-check.test.ts` 用 `machineString` 验证通过。**通过**。`attn-` attention 编号没有 `machineString` 用例，只按代码看长度/字符集通过，**未核实测试**。
- **`entry-` 编号**：产生于 `randomId("entry-")`，DB `entry_id` CHECK 接受；`machineString` 测试覆盖；`mcp_sync_versions` / attention 外键接受。**通过**。
- **`sync-<32 位十六进制>` 提议编号**：`sync-` + 32 = 37 字符，小于 `PROPOSAL_ID_MAXIMUM = 40`；`external_memory_proposals.id` 只校验 1–128 字符，**通过**。后续 `memory:mcp:sync-...` 我按 `machineString` 规则手工核对为合法（长度 47，字符集允许），但没有端到端测试确认“sync 条目被主人确认后真的能落成 Memory”，**未核实**。
- **`versionTag`**：产生于 `sha256(normalizedText)`，64 位小写十六进制；删除端 `VERSION_TAG = /^[0-9a-f]{64}$/` 接受；DB `text_sha256` 只校验长度 64，不校验十六进制（弱于产生端）。**通过但数据库校验偏弱**。
- **`entry` / `deletes` 的各种 status**：`MCP_SYNC_ITEM_STATUSES` / `MCP_SYNC_DELETE_STATUSES` 覆盖代码会返回的值；`ENTRY_COUNTER` / `DELETE_COUNTER` 也覆盖；`MCP_USAGE_COUNTERS` 已加入新计数，`sqlite-mcp-connection-operations.ts:320` 会接受。**通过**。但 `packages/calibration/src/mcp-connections.ts` 只把 `sync_memories` 的 `calls` 汇总进 `memoryPushes`，逐项 `entries_*` / `deletes_*` 没有页面读取路径；不影响正确性，只是本 PR 还不显示明细。
- **上限 `MCP_SYNC_LIMIT_NAMES` / 默认值 / 上限值**：`limits()` 读取 `mcp_sync_limits` 并按 `MCP_SYNC_LIMIT_CEILINGS` 截断，名字不认识就忽略；`mcp_sync_limits` 只要求 name 长度 1–64、value ≥ 0。**通过**。但本 PR 没有写 `mcp_sync_limits` 的产品入口，页面在后续 PR。
- **项目批准状态**：代码会插入 `pending`，`applyNote` 读取 `approved` / `declined`；但本 PR 没有产生 `approved` / `declined` 的产品路径，测试是直接 SQL 改状态。**两端未闭环**，见意见 7、8。
- **项目名**：DB `display_name` / `name` 都是 1–256，代码也按 256 校验；NFC 和 trim 有测试。**长度/编码通过**；**凭据检查不完整**（意见 4）。
- **正文内容 ref**：`memory-content:mcp-sync:<sha256>` 和 `memory-content:mcp-proposal:<sha256>` 被 `payloads.ref` 接受（测试通过）；但失败批次没有清理（意见 2）。
- **新表本身**：迁移产生九张表，`schemaCatalog` / 数据导出没有接受它们（意见 1）。这是本 PR 最明确的“产生端有、使用端没接”。

**未核实**：没有实际运行任何测试；没有验证 `npm run check:prompt-catalog` 的新哈希；没有验证 `npm run migration:new` 的生成结果与手写迁移完全一致；没有验证项目笔记数据导出是否在本 PR 范围。
