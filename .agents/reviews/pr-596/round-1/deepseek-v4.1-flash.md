**作者说法核对（先给结论）**

- “批准后等批准的笔记变已存、敏感的变等确认” —— 基本成立，但 `decideProject` 连 `refused` 的笔记也一起复活（`sqlite-mcp-memory-sync-operations.ts:910-936`）。
- “拒绝则全部被拒” —— **不成立**。已处于 `awaiting_confirmation` 的敏感笔记不在拒绝范围；而且拒绝过的项目再来敏感笔记仍会变成 `awaiting_confirmation`。
- “被拒的关于主人的条目也会出现在列表里，方便恢复” —— **不成立**。关于主人的条目只会写成 `active`，永远不会是 `refused`；即使出现，`decideNote` 也只查 `kind = 'project_note'`。
- “三个命令只认主人” —— 成立。`execute` 先调用 `assertOwner`（`production-memory-control.ts:1796,306-314`），控制面还校验认证主体与 actor 一致（`production-approval-gateway.ts:305-313`）。
- “放行的删除不计入当天自动删除条数” —— 代码成立，`resolveAttention` 只调 `deleteEntry`，没碰 `mcp_sync_deletion_days.auto_deleted`；但没有对应测试。
- “目标不存在报 `MEMORY_MCP_SYNC_TARGET_NOT_FOUND`” —— 成立（`production-memory-control.ts:854-878`）。
- “不改 Himawari 自己的模型调用” —— 静态核对成立，diff 没有改提示词目录、模型组装或自身 MCP 工具注册。
- “页面快照增加 mcpSync” —— 成立，但漏改端到端浏览器假服务器，且正文用了不接受换行的校验器。

---

### 1. 高：含换行或制表符的项目笔记会让整页 `memory.overview.snapshot` 解析失败

文件: `packages/gateway-contracts/src/contracts-v2.ts:2493`、`packages/gateway-contracts/src/validation.ts:109-112`、`apps/agent-service/src/production-mcp-sync.ts:49-51`

问题：项目笔记正文允许换行和制表符（`normalizeNoteText` 明确保留 `\n`、`\t`），但新快照字段用 `boundedString` 校验，而 `boundedString` 拒绝所有 `< 0x20` 的字符，包括换行和制表符。只要有一条待处理笔记是多行文本，整个记忆总览就会校验失败，控制中心无法打开页面。

证据（亲自读到）：
```ts
text: boundedString(MCP_SYNC_NOTE_TEXT_MAXIMUM),
previousText: nullable(boundedString(MCP_SYNC_NOTE_TEXT_MAXIMUM)),
```
```ts
[...input].some((character) => {
  const code = character.charCodeAt(0);
  return code < 0x20 || code === 0x7f;
})
```
```ts
.replace(NOTE_HIDDEN, (character) =>
  character === "\n" || character === "\t" ? character : " ",
)
```
控制中心每个响应都严格解析：`apps/control-center/src/gateway-client.ts:271-272` 的 `gatewayV2MessageSchema.parse(value)`；`object()` 还会拒绝未知字段、要求必填字段（`validation.ts:187-196`）。

建议：项目笔记正文改用允许换行/制表的独立 schema（例如只限长度、拒绝其余控制字符），并补一条含 `\n`/`\t` 的快照往返用例；`previousText` 同步处理。

### 2. 高：拒绝项目不会拒绝已等确认的敏感笔记，敏感笔记还能绕过“已拒绝”的项目

文件: `packages/persistence-sqlite/src/sqlite-mcp-memory-sync-operations.ts:910-936`、同文件 `:706-714`

问题：`decideProject` 在拒绝时只迁移 `awaiting_project_approval` 和 `refused` 两种状态，`awaiting_confirmation` 的敏感笔记原样保留，之后仍可被 `noteDecide confirm` 变成已存。更直接的是，`applyNote` 先判断敏感分级，再判断项目批准状态，因此一个已被拒绝的项目再来敏感笔记仍然进入 `awaiting_confirmation`，而不是被拒。这与“拒绝则全部被拒”“以后这个项目再来的笔记按这次的决定直接处理”不一致。

证据（亲自读到）：
```ts
WHERE ... AND kind = 'project_note' AND state IN (?, ?)
...
STATE_AWAITING_APPROVAL,
STATE_REFUSED,
```
```ts
const state =
  item.classification === "sensitive"
    ? STATE_AWAITING_CONFIRMATION
    : approval === "approved"
      ? STATE_ACTIVE
      : approval === "declined"
        ? STATE_REFUSED
        : STATE_AWAITING_APPROVAL;
```
建议：拒绝项目时把该项目的 `awaiting_confirmation` 也转成 `refused`；`applyNote` 在分级判断前先检查项目是否 `declined`。补两条反向用例：拒绝项目后敏感笔记不能确认；拒绝后新推敏感笔记落 `refused`。

### 3. 中：项目列表和刹车待办的“接入名”常常退回成 connectionId

文件: `apps/agent-service/src/production-memory-control.ts:788-789,825,832`

问题：`#mcpSyncView` 只从 `overview.entries` 建 `names` 映射，而 `projects`/`attention` 是独立查询出来的。项目批准完、没有待处理笔记时（或待办条目超出 200 条被截断、刹车条目本来就不是 `awaiting_*`/`refused`），映射为空，页面显示的“接入名”就是 `conn-...` 编号。批准项目后 `projects` 仍会返回，正是这个常见场景。

证据（亲自读到）：
```ts
const names = new Map<string, string>();
for (const row of overview.entries) names.set(row.connectionId, row.connectionName);
```
```ts
connectionName: names.get(project.connectionId) ?? project.connectionId,
...
connectionName: names.get(connectionId) ?? connectionId,
```
`projects`、`attention` 的来源查询在 `sqlite-mcp-memory-sync-operations.ts:859-888`，与 `entries` 无关。

建议：让存储层的 `McpSyncProjectView`/`McpSyncAttentionView` 直接带 `connectionName`（SQL 里 JOIN `mcp_connections`），不要在控制层用待办条目反推；并补“项目全部批准后仍显示接入名”的用例。

### 4. 中：文档说“被拒的关于主人的条目在列表里、可恢复”，代码里这条路径不存在

文件: `packages/persistence-sqlite/src/sqlite-mcp-memory-sync-operations.ts:834-835,650-680,951-953`

问题：总览的筛选条件确实为 `kind = 'project_note' OR state = 'refused'` 留了口子，但关于主人的条目在 `applyOwner` 中新增和更新都固定写 `STATE_ACTIVE`，不会进入 `refused`；即使数据库里出现这种行，`decideNote` 也只允许 `kind = 'project_note'`，无法恢复。ADR 里“被拒的关于主人的条目也在里面，方便恢复”的说法与代码不符。

证据（亲自读到）：
```ts
WHERE e.owner_id = ? AND e.agent_id = ? AND e.state IN (...)
  AND (e.kind = 'project_note' OR e.state = ?)
```
```ts
`INSERT INTO mcp_sync_entries (...) VALUES (..., 'owner', ..., STATE_ACTIVE, ...)`
...
`UPDATE mcp_sync_entries SET ... state = ?, ...` // 传 STATE_ACTIVE
```
```ts
WHERE owner_id = ? AND agent_id = ? AND entry_id = ? AND kind = 'project_note'
```
建议：要么删掉这个死分支并改文档，要么把关于主人的拒绝状态真正落进 `mcp_sync_entries` 并让 `decideNote` 支持 `kind = 'owner'`；二者选一，并加恢复用例。

### 5. 中：`decideNote` 在不适用的状态下静默返回成功，调用方会以为处理了

文件: `packages/persistence-sqlite/src/sqlite-mcp-memory-sync-operations.ts:959-981`

问题：`confirm` 只在 `awaiting_confirmation` 生效，`refuse` 只在 `awaiting_confirmation`/`active` 生效，`restore` 只在 `refused` 生效；其余组合直接返回 `{ found: true, state: 原状态 }`。例如页面若对 `awaiting_project_approval` 的笔记点“拒绝”，接口报成功但状态没变，页面刷新后这条还在，看起来像没生效。

证据（亲自读到）：
```ts
let next: string = row.state;
if (input.decision === "confirm" && row.state === STATE_AWAITING_CONFIRMATION)
  next = STATE_ACTIVE;
else if (input.decision === "refuse" &&
  (row.state === STATE_AWAITING_CONFIRMATION || row.state === STATE_ACTIVE))
  next = STATE_REFUSED;
...
return { found: true, state: next };
```
建议：不适用的状态返回冲突/非法操作错误，或把 `refuse` 扩展到 `awaiting_project_approval`；补“错误状态返回非成功”的用例。

### 6. 中：端到端浏览器假服务器没有补 `mcpSync`，现有记忆页浏览器测试会失败

文件: `test/e2e/fixtures/control-center-browser-server.mjs:1067-1090,1680-1682`

问题：`memoryOverview()` 返回的 payload 仍然只有 `externalProposals`、`pending`、`generatedAt` 等，没有新增的必填 `mcpSync`。该 payload 被当作 `memory.overview.snapshot` 返回，控制中心客户端用严格 schema 解析，`object()` 会报“missing required field”。使用 `HIMAWARI_MEMORY_FIXTURE=1` 的浏览器测试（如 `memory-source-browser.test.ts`）会因此失败。

证据（亲自读到）：
```js
externalProposals: externalSnapshot(),
pending: [],
generatedAt: now,
```
```js
return memoryFixture
  ? { ...envelope("snapshot", "memory.overview.snapshot"), payload: memoryOverview() }
```
而 `contracts-v2.ts:2482` 的 `mcpSync` 是必填对象，`validation.ts:193` 对缺失字段直接失败。

建议：在该 fixture 补 `mcpSync: { entriesTotal: 0, entries: [], projects: [], attention: [] }`，并补一个带待处理笔记的浏览器场景。

### 7. 低：刹车待办显示的“当天开始基数”可能来自另一天

文件: `packages/persistence-sqlite/src/sqlite-mcp-memory-sync-operations.ts:879-882`

问题：`attention` 没有保存发生当天的日期，总览取的是该项目最近一天的 `mcp_sync_deletion_days.baseline`。如果这条待办跨天未处理，而随后又有新的推送/删除产生新一天的记录，页面会显示新一天的基数，而不是“少了 N 条”发生当天的基数。

证据（亲自读到）：
```ts
COALESCE((SELECT d.baseline FROM mcp_sync_deletion_days d
  WHERE ... AND d.connection_id = a.connection_id AND d.project_id = a.project_id
  ORDER BY d.day DESC LIMIT 1), 0) AS baseline
```
`mcp_sync_attention` 表本身没有 `day`/`baseline` 列（`migrations/20261115124342_mcp_memory_sync.sql:99-112`）。

建议：在 `mcp_sync_attention` 创建时记录当天和当时基数，或查询时按 `created_at` 的日期取对应行；补跨天用例。

### 8. 低：长度校验用 UTF-16 长度，写入校验用码点数，表情接近上限时快照会失败

文件: `packages/gateway-contracts/src/validation.ts:102-108`、`apps/agent-service/src/mcp-project-name.ts:55-66`、`packages/persistence-sqlite/src/sqlite-mcp-connection-operations.ts:60-64`

问题：连接名、项目名、笔记正文在写入时按码点数（`[...value].length` / SQLite `length()`）限制，但新快照的 `boundedString(64/256/60000)` 用的是 JavaScript `.length`（UTF-16 码元）。同样 64 个表情在写入时合法，在快照里会变成 128 个码元而超限。这是边界问题，但一旦触发同样会让整页失败。

证据（亲自读到）：
```ts
if (typeof input !== "string" || input.length === 0 || input.length > maximum || ...)
```
```ts
const length = [...value].length;
return length >= 1 && length <= maximum;
```
建议：快照校验统一按码点数计算（或复用同一套长度工具），并对连接名、项目名、正文各补“上限个表情”的契约用例。

### 9. 低：新增自动检查缺少关键反向用例，`check:mcp-sync` 只加了透传

文件: `test/integration/mcp-memory-sync.test.ts:667-843`、`test/integration/mcp-write.test.ts:2126-2165`、`test/tooling/mcp-sync-check.test.ts`

问题：现有新用例覆盖了批准/拒绝/恢复、放行/保留和 not found，但没有覆盖：含换行/制表的快照、拒绝项目时敏感笔记、拒绝项目后新来敏感笔记、关于主人条目的拒绝恢复、非主人/外部 MCP 凭据调用三个新命令、放行后 `auto_deleted` 不增加、200 条截断边界、表情长度边界。`mcp-sync-check.test.ts` 只是把四个新存储方法接进参考存储，没有新增检查。

证据（亲自读到）：新增测试只用了无换行的笔记文本，例如 `note("n1", "项目甲的第一条笔记", "甲")`，拒绝用例也未设置敏感分类；`check:mcp-sync` 的 diff 仅为 `overview`、`decideProject`、`decideNote`、`resolveAttention` 的 `async (input) => ops.execute(...)` 透传。

建议：至少补第 1、2、4 条对应的反向用例，并在 `check:mcp-sync` 里加入“笔记正文经过快照校验”和“三个操作的作用域/状态”检查。

### 10. 低（部分推测）：`projects`/`attention` 无上限且逐行查项目名，页面可能变慢

文件: `packages/persistence-sqlite/src/sqlite-mcp-memory-sync-operations.ts:854-858,859-888`、`apps/agent-service/src/production-memory-control.ts:800-810`

问题：`entries` 有 `limit`，但 `projects` 和 `attention` 查询没有 `LIMIT`；同时每条 entry、project、attention 都调用一次 `projectName()`（N+1 查询）。外部 agent 可以持续创建新项目，项目批准表会不断增长，总览响应和查询次数会随之增长。

证据（亲自读到）：`projects` 查询只有 `ORDER BY connection_id, project_id`，`attention` 查询只有 `ORDER BY a.created_at, a.id`；`entries` 的映射里调用 `this.projectName(input, row.projectId)`。这是**推测**的性能影响，未做压测。

建议：给 `projects`/`attention` 加上限并让前端分页；用 `LEFT JOIN mcp_projects` 一次带出 `projectName`。

---

**侧重检查**

- 错误路径：检查了 `decideProject`/`decideNote`/`resolveAttention` 的 not found、非法 `now`、非法枚举、空条目；三者都按 owner/agent 作用域查询，未发现越权读写；但 `decideNote` 的“状态不适用”会静默成功（见第 5 条）。
- 不可信输入：笔记正文、项目名、连接名、稳定编号的上游校验都读过；正文明文允许换行/制表，而快照校验器不接受，是确定性故障（第 1 条）；长度边界按码点/码元不一致（第 8 条）。
- 安全/越权：三个新命令经 `ProductionMemoryControl.execute` 的 `assertOwner` 和 `production-approval-gateway` 的认证主体校验；外部 MCP 走另一条入口，不能直接发这些网关命令。快照会把敏感笔记正文解密返回，但 `memory.overview.read` 走的是活跃 owner session 的访问策略（`production-http-composition.ts:1609` 传入 `ProductionThreadGatewayAccessPolicy`），未发现新增给外部 agent 的读取路径；这一点我未运行测试验证。
- 不可撤销操作：`attentionResolve release` 会直接把当前条目标成删除/`source_deleted_at`，之后 `mcp_sync_attention` 变成 `resolved`，没有撤销入口；这是主人主动操作，但建议页面二次确认，并考虑第 7 条的跨天/版本变化问题。
- 资源耗尽：`projects`/`attention` 无上限、`projectName` N+1（第 10 条）；`entries` 最多 200 条且已受 `overview` 的 `limit` 约束。
- 规则/文档与代码一致性：ADR 0242 补注与代码有四处出入：关于主人的拒绝条目不存在（第 4 条）、“拒绝则全部被拒”未覆盖敏感笔记（第 2 条）、“接入名”可能显示编号（第 3 条）、端到端假服务器未同步（第 6 条）。
- 未核实：没有运行 `npm run check`、`check:prompt-prefix`、`check:mcp-sync` 或浏览器测试（本次只能用 read/grep/glob 和 git 只读命令），以上运行时结论均来自静态代码与现有测试结构。

---

**必答问题**

1. **不会改变模型已经见过的请求开头。** 新增的 `mcpSync` 只出现在内存页快照的 payload（`production-memory-control.ts:1410,1422`），没有改系统提示、工具定义、历史消息或遮盖；diff 也没触及 `packages/prompt-catalog`、模型组装或自身 MCP 工具注册。发给模型的内容仍只在末尾追加，新增字段不进入模型请求。`check:prompt-prefix` 的实际运行结果未核实，但静态上没有需要它报警的改动。

2. **不会让模型请求里的同一段文字变成不同字节。** 首先这些新值都不进模型请求；其次快照内部顺序固定：entries 按 `connection_id, project_id, last_synced_at DESC, entry_id`，projects 按 `connection_id, project_id`，attention 按 `created_at, id`（`sqlite-mcp-memory-sync-operations.ts:836,864,885`）。`lastSyncedAt`/`createdAt` 来自存储而非请求时刻，遮盖逻辑没有参与。唯一会随请求变化的是正常的状态/条目增减，不属于“同一段文字被重新序列化”。

3. **有自动检查，但反向用例不足以让这些问题失败。** 新增了存储层批准/拒绝/恢复/放行保留/not found 测试和一条真实 MCP 路由的页面读取测试；契约 fixture 也加了快照和三个命令。但没有换行/制表快照用例、敏感笔记拒绝用例、关于主人拒绝恢复用例、非主人调用用例、放行不计入 `auto_deleted` 用例、200 条截断用例、表情长度边界用例；`check:mcp-sync` 只加了存储方法透传。上述第 1、2、4、6 条问题现有测试都不会失败。

4. **逐个值核对结果：** `entry-`、`proj-`、`attn-`、`conn-` 加 24 位十六进制都在 `machineString` 的 128 字符/字符集范围内；`state`、`classification`、`approval` 的枚举和存储写入值一致；`lastSyncedAt`、`createdAt` 来自经过 `instant()` 校验的 ISO 时间，能通过 `timestamp`；`category` 来自固定清单且数据库限 32，能通过；`version`、`heldEntries`、`baseline` 都是非负整数。**不一致的地方**是：`connectionName` 在项目/刹车列表里可能被替换成 `connectionId`（值本身能过 schema，但语义错了，见第 3 条）；`projectName`/`connectionName`/`text`/`previousText` 的 `boundedString` 与写入端的码点长度规则不一致（第 8 条）；`text`/`previousText` 不接受换行/制表而写入端保留（第 1 条）；新增 `mcpSync` 是必填字段，但端到端假服务器没产生它（第 6 条）。另外 `MCP_SYNC_NOTE_TEXT_MAXIMUM` 只用于快照上限，实际存储上限由 `note_text_chars` 配置决定，其 ceiling 与 60,000 相同，这一点没有发现不一致。
