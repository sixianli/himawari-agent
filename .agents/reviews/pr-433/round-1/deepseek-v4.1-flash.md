## 结论摘要

总体方向没问题：两个操作确实只读、没有新表/迁移，也不碰模型请求开头。但完整性（`incomplete`）在两条真实失败路径上会说“完整”，`workspace.folders.read` 有一个 I-73 式的“生产者能写、契约不接受”的字段，以及截断逻辑会悄悄少列目录。下面按严重度排列。

---

## 一、问题清单（按严重度）

### 1. 【证实】严重度：中｜崩溃恢复窗口会把“未登记的文件”当成完整
**文件:行**：`apps/agent-service/src/production-coding-workflow.ts:583-632`

**问题**：`workspace-changes` 一旦存在，`recordThreadArtifacts` 整段不再执行；`droppedArtifacts` 保持 `false`。若上次在“保存 workspace-changes 之后、登记 thread_artifacts 之前”崩溃，这次恢复既不会补登记，也不会写 `incomplete`（只要保存的记录 `complete === true`）。于是 `workspace.changes.read` 少列文件但仍返回 `incomplete: false`，直接违反“记录可能不全时必须说出来”。

**证据**：
```ts
let changes = (await ctx.load("workspace-changes")) ...
let droppedArtifacts = false;
if (!changes) {
  ...
  droppedArtifacts = await recordThreadArtifacts(...);
}
if (droppedArtifacts || (changes as { readonly complete?: boolean }).complete !== true)
  await services.workspaceChangeMarks?.markIncomplete({...});
```
`ctx.save/load` 是持久 trace（`production-runtime-tools.ts:1270-1287`），所以该窗口真实存在。作者的说法“登记被丢弃这个原因的标记可能漏写”是准确的，但这仍然违反本 PR 的核心目标。

**建议**：在保存 `workspace-changes` 前后额外落一个“artifacts-recorded”持久标记；恢复时发现标记缺失，要么重跑登记（登记键已含 `toolCallId+path`，可做成幂等），要么至少补写 `incomplete`。并加一条模拟“保存后崩溃”的恢复测试。

---

### 2. 【证实】严重度：中｜`folders[].expiresAt` 是 I-73 式跨端不一致：生产端只校验可解析，契约要求规范 UTC
**文件:行**：`apps/admin-cli/src/workspace-command.ts:51-55`；`packages/gateway-contracts/src/validation.ts:115-124`；`packages/gateway-contracts/src/contracts-v2.ts:2139`；`apps/agent-service/src/production-workspace-changes-control.ts:54-64`

**问题**：授权目录的生产者只要求 `Number.isFinite(Date.parse(expiresAt))`，因此 `--expires-at 2027-01-01` 或带时区偏移的写法都能写进存储；但新的 `workspaceFoldersSnapshotSchema` 用 `timestamp`，要求 `new Date(input).toISOString() === input`。`#folders` 只做 `Date.parse` 过滤，然后原样返回 `expiresAt`。只要存在一条这类授权目录，整个 `workspace.folders.read` 响应就过不了契约（客户端 `gatewayV2MessageSchema.parse` 会拒绝，HTTP 测试也这样解析），整个接口不可用，而不只是过滤掉这一条。

**证据**：
```ts
// producer
!Number.isFinite(Date.parse(expiresAt))
// consumer
const parsed = new Date(input);
if (Number.isNaN(parsed.valueOf()) || parsed.toISOString() !== input) fail(...)
// control
Date.parse(grant.expiresAt) > Date.parse(now) ? [{ ..., expiresAt: grant.expiresAt }] : []
```

**建议**：在授权目录写入端统一要求规范 RFC3339（毫秒、Z）；同时在 `#folders` 输出前用同一 `timestamp` 规则校验/规范化，并对坏记录降级跳过而不是整车失败。按 I-73 的教训补一条“生产者生成的值必须过消费者校验”的自动检查。

---

### 3. 【证实】严重度：中｜删除登记失败不会写 `incomplete`
**文件:行**：`apps/agent-service/src/production-thread-artifacts.ts:201-217`；`apps/agent-service/src/production-coding-workflow.ts:615-624`

**问题**：作者说“改动记录失败”会写不完整标记，但删除路径的 `markDeleted` 失败被 `catch` 吞掉，只写一条 warn，既不抛错也没有 `onIncomplete`。结果是文件已删，`thread_artifacts` 仍显示 `changed`，而 `workspace.changes.read` 返回 `incomplete: false`。这是“记录可能不全”的真实路径，却没被说出来。

**证据**：
```ts
try {
  await this.#store.markDeleted({...});
} catch (error) {
  this.#warn({ event: "thread.artifact.mark_deleted_failed", ... });
}
```
调用处 `await services.threadArtifacts?.recordDeleted({...})` 也没有任何返回值/标记。

**建议**：给 `recordDeleted` 增加 `onIncomplete`（或返回 `{complete}`），失败时与 `record` 一样写标记；补一个 `markDeleted` 抛错的用例。

---

### 4. 【证实】严重度：中｜撤销/过期的配置授权目录仍能读出改动列表
**文件:行**：`apps/agent-service/src/production-workspace-changes-control.ts:88-91,113`

**问题**：`grantMatched` 只比较 `runPolicy.coding.grantId === grantId`，不检查授权目录是否撤销/过期；`displayPath` 用的 `configuredWorkspaceRoot` 会检查撤销/过期，所以会出现 `grantMatched: true`、`displayPath: null`，但 `fileCount/items` 仍然返回。`workspace.folders.read` 又明确隐藏撤销/过期目录，两个接口语义不一致；撤销后仍能按已知 grantId 读到改动历史。

**证据**：
```ts
const matched = runPolicy?.coding?.grantId === grantId;
const page = matched ? await this.#options.changes.changedFiles({...}) : {...};
...
displayPath: matched ? await this.#options.displayPath() : null,
```

**建议**：明确语义。若撤销后不应再暴露改动历史，`matched` 应同时要求存在有效授权目录（复用 `configuredWorkspaceRoot` 的校验）；若历史允许保留，至少在契约里加“授权目录是否有效”的字段，避免 `grantMatched:true + displayPath:null` 的歧义，并补撤销后查询的用例。

---

### 5. 【证实】严重度：中低｜`folders.read` 先切 200 条再过滤，会漏掉后面的有效目录，且无法翻页
**文件:行**：`apps/agent-service/src/production-workspace-changes-control.ts:44-48,76`

**问题**：先 `listState(prefix, 201)`，再 `records.slice(0, 200)`，最后才过滤撤销/过期。若前 200 条里有很多失效记录，而第 201 条才是有效目录，这条有效目录会被丢掉；`truncated` 只表示“原始记录超过 200”，但契约里没有 cursor，界面无法再取。结果是“明明还有有效目录，却只显示一部分，且拿不到剩下的”。

**证据**：
```ts
const records = await this.#options.listState(HOST_DIRECTORY_GRANT_STATE_PREFIX, LIMIT + 1);
const folders = records.slice(0, WORKSPACE_FOLDER_LIST_LIMIT).flatMap((record) => {
  ... filter revoked/expired ...
});
truncated: records.length > WORKSPACE_FOLDER_LIST_LIMIT,
```

**建议**：先过滤再切 200；`truncated` 按有效目录数计算。若有效目录可能超过 200，给契约加 cursor 或提高上限并在 `truncated` 时允许继续取。补一条“有效目录排在 200 条之后”的用例。

---

### 6. 【证实】严重度：中｜标记写失败会把已执行的工具调用变成错误，可能诱发重试
**文件:行**：`apps/agent-service/src/production-coding-workflow.ts:626-632,649-664`；`apps/agent-service/src/production-workspace-change-marks.ts:74-79`

**问题**：bash/write/edit 已经执行成功并有副作用后，`markIncomplete` 抛错会让整个工具调用 reject。作者明确说这是有意的（“不当作完整”），但对 `rm`、`mv`、`git reset` 这类非幂等命令，模型看到“失败”后可能重试，造成二次执行。另外两个键是两次独立事务：对话级写入成功、目录级失败时，带 `threadId` 的查询会显示不完整，不带 `threadId` 的目录级查询却显示完整。

**证据**：
```ts
await write(workspaceIncompleteThreadKey(...), value, `thread:${identity}`);
await write(workspaceIncompleteFolderKey(...), value, `folder:${identity}`);
```

**建议**：把“标记失败”与“工具执行结果”分开：仍返回已执行结果，但在结果里标明记录不完整/不可重试；或先写目录级（保守）再写对话级，并把两次写做成可重试。至少不要让模型把“已执行成功但标记失败”理解为可以安全重试。

---

### 7. 【证实】严重度：低中｜并发写同一个目录级标记会 `PORT_CONFLICT` 并抛错
**文件:行**：`apps/agent-service/src/production-workspace-change-marks.ts:40-62,74-79`；`packages/persistence-sqlite/src/sqlite-worker.ts:785-802`

**问题**：`write` 先 `readScopedState` 再以 `expectedRevision` 提交。对话级键按 thread 隔离，但目录级键 `workspace-ledger-incomplete:<grant>` 被同一 agent 的所有线程共享。两个线程同时标记时，后提交者会拿到 revision 冲突，导致工具调用抛错（同第 6 条，但这是并发触发）。

**证据**：
```ts
const existing = await repository.readScopedState(ownerId, agentId, key);
const input = { key, expectedRevision: existing ? existing.revision : null, value };
```
`commitStateAndEvents` 在 revision 不匹配时直接 `PORT_CONFLICT`。

**建议**：对 `PORT_CONFLICT` 做有限重试（重新读取 revision），或改成“只保证键存在”的幂等写法；补并发用例。

---

### 8. 【证实】严重度：低｜不完整标记键用冒号拼接，ID 本身允许冒号，存在键碰撞
**文件:行**：`apps/agent-service/src/production-workspace-change-marks.ts:11-17`；`packages/domain/src/identifiers.ts:39`；`packages/application/src/services/durable-host-workspace-state-adapter.ts:237-243`

**问题**：`workspaceIncompleteFolderKey("a:b")` 得到 `workspace-ledger-incomplete:a:b`，与 `workspaceIncompleteThreadKey("a","b")` 完全相同。`grantId` 和 `threadId` 的字符规则都允许 `:`，所以另一授权目录的目录级标记会让某个线程查询误报 `incomplete:true`（保守方向，但仍错误）。

**证据**：
```ts
return `workspace-ledger-incomplete:${grantId}`;
return `workspace-ledger-incomplete:${grantId}:${threadId}`;
```
```ts
const MACHINE_IDENTIFIER_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
```

**建议**：用不含歧义的编码（长度前缀、JSON、或把 `:` 转义），或对两个 id 做哈希后再拼；补一条带冒号 ID 的用例。

---

### 9. 【证实】严重度：低｜`folders.read` 遇到损坏的 `value.id` 会让整个查询抛错
**文件:行**：`apps/agent-service/src/production-workspace-changes-control.ts:50-51`；`packages/application/src/services/durable-host-workspace-state-adapter.ts:237-243`

**问题**：`typeof grant.id === "string"` 之后直接 `hostDirectoryGrantStateKey(grant.id)`；若该值里的 id 含不合法字符，`key()` 会抛 `ApplicationPortError`，整个 `workspace.folders.read` 失败，而不是跳过这一条坏记录。

**证据**：
```ts
typeof grant.id === "string" &&
record.key === hostDirectoryGrantStateKey(grant.id) &&
```
`hostDirectoryGrantStateKey` 内部对 id 做正则校验并在不匹配时 throw。

**建议**：先用同一正则校验 `grant.id` 再调用 key 构造，或对单条记录 try/catch 后跳过并告警。

---

### 10. 【证实】严重度：低中｜`changedFiles` 查询在大表上会做无 path 索引的相关子查询
**文件:行**：`packages/persistence-sqlite/src/sqlite-thread-artifact-operations.ts:306-330`；`packages/persistence-sqlite/src/migrations/0064_uploaded_thread_files.sql:34-35`

**问题**：`count(DISTINCT path)` 加外层每行一个 `b.path = a.path` 的相关子查询，但现有索引只有 `(owner_id, agent_id, thread_id, created_at, id)` 和 `(owner_id, agent_id, created_at, id)`，没有 `path`。长期运行的 agent 的 `thread_artifacts` 会很大，这个只读接口可能变成 O(n²) 的全量扫描；接口没有频率限制。约束说“不改表”，所以这不是随手能修的，但应在方案里明确代价。

**证据**：
```sql
(SELECT count(*) FROM thread_artifacts v
 WHERE v.owner_id = a.owner_id AND v.agent_id = a.agent_id
   AND v.path = a.path AND v.source != 'upload' ...) AS versions
```
```sql
CREATE INDEX thread_artifacts_thread_index ON thread_artifacts(owner_id, agent_id, thread_id, created_at, id);
CREATE INDEX thread_artifacts_recent_index ON thread_artifacts(owner_id, agent_id, created_at, id);
```

**建议**：要么接受并加上查询超时/限流，要么另出迁移加 `(owner_id, agent_id, path, created_at)` 索引，或维护一份按 path 去重的读模型。不要把它当成“反正只读”就忽略。

---

### 11. 【证实】严重度：低｜文档与代码不一致
**文件:行**：`docs/architecture-v0.1.md:554,556`；`docs/runbooks/install-start-stop-runbook.md:371`

**问题**：
- 架构文档第 554 行仍写“当前正式 Gateway v2 只安装 `approval.list/detail/respond`”，第 556 行又说已安装 `workspace.*`，同页自相矛盾。
- 运行手册仍写“当前正式部署只开放对话、审批和依赖健康检查，其他 13 个页面应显示未启用”，但现在多了两个已安装的只读操作。

**证据**：
```md
当前正式 Gateway v2 只安装 `approval.list/detail/respond` ...
只读查询 `workspace.folders.read` 和 `workspace.changes.read` 已在正式 Gateway v2 安装。
```
```md
当前正式部署只开放对话、审批和依赖健康检查，其他 13 个页面应显示“未启用”
```

**建议**：更新这两处，把“已安装但无调用方页面”和“页面未启用”分开表述；避免验收时把“有操作但没页面”误判为未安装。

---

### 12. 【证实】严重度：低｜契约测试的 `apply_patch` 与存储枚举不一致
**文件:行**：`packages/gateway-contracts/test/workspace-changes.contract.test.ts:33-36`；`packages/persistence-sqlite/src/migrations/0064_uploaded_thread_files.sql:8`

**问题**：契约层允许任意 `machineString` 作为 `source`，测试还专门用 `apply_patch` 声称“接受尚不存在的改文件工具”；但 `thread_artifacts.source` 的 CHECK 只允许 `write/edit/bash/upload`。未来真加入 `apply_patch` 时，`register` 会失败，而新代码会把这种失败标成 `incomplete`。测试会给“前向兼容”错误信心。

**证据**：
```ts
expect(gatewayV2MessageSchema.parse(snapshot({ source: "apply_patch" })).type).toBe(...)
```
```sql
source TEXT NOT NULL CHECK (source IN ('write', 'edit', 'bash', 'upload')),
```

**建议**：要么在契约里说明“存储层仍枚举、扩源需迁移”，要么把测试改成只验证“契约不按工具名写死”而不暗示存储已支持；扩源时同步迁移。

---

## 二、侧重检查（错误路径、不可信输入、安全、资源、不可逆、文档）
- **错误路径**：已核对 `ledger.record` 失败、`record` 单文件失败、`recordDeleted` 失败、`markIncomplete` 失败、恢复窗口、并发 revision 冲突、损坏授权记录。发现第 1、3、6、7、9 条。
- **不可信输入**：`grantId/threadId/afterPath/prefix` 都走参数化查询或仅做等值比较，没有 SQL 注入；`afterPath` 有契约长度限制；`prefix` 是内部常量。`threadId`/`path`/`source` 来自存储时与契约校验存在潜在缝隙（第 2、12 条；path 控制字符风险见“未核实”）。
- **安全/授权**：`ProductionThreadGatewayAccessPolicy` 校验 owner、agent、活跃 session（`production-http-composition.ts:431-453`），未发现跨 agent 读取；`workspace.changes.read` 不按真实 grant 过滤（thread_artifacts 无 grant 列），但当前生产只配置一个写代码 grant，作者已说明；撤销后仍可读见第 4 条。
- **资源耗尽**：`folders` 上限 200、`listScopedState` 上限 500、`changes` limit 上限 200；但 `changedFiles` 的 `count(DISTINCT)` + 相关子查询无 path 索引，见第 10 条。
- **不可逆操作**：本次两个接口都只读；新增的是持久状态标记（不会自动清除），不会删除文件。标记写失败会抛出（第 6 条）是唯一可能影响执行语义的地方。
- **规则/文档一致性**：`prompt-prefix` 规则未被触碰；文档见第 11 条；`ci/operations-pending.json` 的两项按 `scripts/check-operations.mjs` 逻辑能通过（后端字面量存在、测试存在、缺“调用方”且有理由）。

---

## 三、必答问题

**1. 会不会改变模型已经见过的请求开头？**
不会。改动没有碰系统提示、工具定义、历史或遮盖；模型可见的路径仍是 `production-coding-workflow.ts:634-639` 的
```ts
modelContent: executed.modelContent
  ? `${executed.modelContent}\n\n${changes.summary}`
  : changes.summary,
```
`changes.summary` 的生成未改。新增的 `generatedAt`、`incomplete` 标记都不进入模型请求。仍满足“只在末尾追加”；每轮会变的值没有进入开头。唯一模型可见的语义变化是第 6 条的错误路径：标记失败时把已执行成功的结果变成错误（追加的工具结果，不是请求开头）。

**2. 会不会让同一段文字在不同请求里变成不同字节？**
对模型请求：不会新增非确定性；没有依赖前后文的遮盖，也没有把无序集合放进 prompt。对这两个新接口：`generatedAt` 每次用 `clock.now()`（`production-workspace-changes-control.ts:77,129`），所以响应本身不是逐字节稳定的；但这是网关响应，不是模型输入。排序是确定的：目录 `ORDER BY key`、文件 `ORDER BY a.path`、`skippedDirectories` 来自固定字面量 Set 的插入顺序。测试 `[WC-1]` 的“同样字节”只在固定时钟下成立，不能证明生产响应逐字节稳定。

**3. 有没有自动检查，反向用例真的会失败吗？**
有检查：真实 SQLite 集成测试、契约测试、`[WC-7]`、HTTP 入口两条查询，以及 `check-operations`。真正有效的反向用例：`[WC-8]` 的未知 `state`、`versions:0`、未知 `recording`、负 `fileCount`（`enumeration/integer` 实现确实会抛）；`[WC-7]` 的 `markIncomplete` 抛错确实会 reject；`[WC-4]` 的“标记永不清除”。但：
- `[WC-6]` 的“超过 50 个候选”反向用例事实上测不到上限分支：`readFile` 永远抛错（`test/integration/sqlite-workspace-changes.test.ts:423-425`），51 个候选每个都会因 `unreadable` 触发 `onIncomplete`，所以 `expect(incomplete).toBeGreaterThan(1)` 即使上限分支失效也会通过。
- 没有测试覆盖：`expiresAt` 非规范值的生产者→契约链路（I-73 类）、`recordDeleted` 失败、崩溃恢复窗口、200 条截断/过滤顺序、撤销配置 grant 后的 `changes.read`、并发标记冲突。
结论：有检查，但不够，且上述 `[WC-6]` 反向用例不会真正抓住回归。

**4. 每个新值两端都能接受吗？**
大部分能对上：
- `workspace.changes.read`/`workspace.folders.read`/两个 snapshot 类型：`GATEWAY_V2_MESSAGE_TYPES`、`schemasByType`、`PRODUCTION_WORKSPACE_CHANGES_OPERATIONS`、HTTP 安装清单、`ci/operations-pending.json` 一致。
- `CHANGED_FILE_LIST_LIMIT=200` 与请求 `integer(1,200)`、控制层 limit 一致；`listScopedState` 调用 201，低于 500 上限；`(owner_id, agent_id, key)` 唯一索引存在（`migrations/0003...:8`）。
- `recording` 的 `direct/copy`、`state` 的 `changed/deleted`、`versions >= 1`、`fileCount >= 0` 都一致。
- `workspaceIncompleteFolderKey/ThreadKey` 的生产者和消费者是同两个函数，但存在第 8 条的键碰撞。
- **不一致**：`expiresAt`（第 2 条）；`thread_artifacts.source`（第 12 条）；`path`/`threadId` 的存储校验弱于契约（存储只查长度/枚举，契约要求无控制字符/machine string）。这些正是 I-73 的“清单里的 id 能不能过后端/契约校验”问题。

---

## 四、未核实/未运行
- 未运行任何测试、lint 或 `check-operations`（本环境只允许 git 命令）；上述检查结论是按代码和测试逻辑阅读得出。
- 未核实生产数据库里是否已经存在非规范 `expiresAt` 的授权目录（第 2 条的影响面）。
- 未核实所有前端/脚本消费者是否都用 `gatewayV2MessageSchema` 校验响应；至少 `apps/control-center/src/gateway-client.ts:269` 会 parse，HTTP 测试也会 parse。
- 文件路径含控制字符导致 `path: boundedString(1024)` 拒绝的极端情况未核实（`thread_artifacts.path` 只约束长度，写入通常经过 `resolveHostFileReadPath`，但 oversized 路径可能绕过读文件校验）。
