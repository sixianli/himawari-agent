本轮查过：`git diff c56494f8..9c054049` 的全量统计，以及 `git diff d353d10c..9c054049` 增量涉及的 14 个文件；逐段读了 `sqlite-mcp-memory-sync-operations.ts`、`validation.ts`、`contracts-v2.ts` 的 `mcpSync` 与 MCP 接入相关段、`production-memory-control.ts`、`production-mcp-sync.ts`、`mcp-project-name.ts`、`sqlite-mcp-connection-operations.ts`、两份 MCP 迁移、相关集成/契约测试、ADR 0242 和 `prompt-prefix.md`。未运行测试或 typecheck（工具限制），以下“测试会/不会失败”均为按代码路径推断。

## 上一轮意见核对

- 第 1 条（换行/制表符导致快照解析失败）：**代码已改好**。`text` / `previousText` 改为 `codePointString(..., { allowLineBreaks: true })`；但只有 helper 单测，没有从 `memory.overview.snapshot` 端到端验证，见必答问题 3。
- 第 2 条（拒绝项目漏掉已等确认的敏感笔记）：**已改好**。`applyNote` 先判 `declined`，`decideProject` 的拒绝集合加入 `awaiting_confirmation`；新增测试在旧代码上会失败。
- 第 3 条（项目/刹车待办接入名退回 connectionId）：**代码已改好，测试没真正覆盖**。SQL 已取 `c.name`，但测试里的 name 等于 id，见意见 2。
- 第 6 条（浏览器假服务器缺 `mcpSync`）：**已改好**，fixture 补了空块。
- 第 4 条（文档说被拒的关于主人的条目在列表里、可恢复）：**文档改为“不在这里”**，与当前没有 owner 条目进入 `refused` 的代码路径一致；但作者说明仍写成“只有被拒的会出现在列表里”，见意见 3。
- 第 7 条（刹车待办基数可能来自另一天）：**未改好**，见意见 1。
- 第 8 条（UTF-16 长度与码点数不一致）：**代码已改好**，快照改用按码点数计的 `codePointString`；但同样缺最大长度端到端用例。

## 意见

### 1. 中：刹车待办的“当天开始基数”仍可能取自另一天，上一轮第 7 条没有修
文件: `packages/persistence-sqlite/src/sqlite-mcp-memory-sync-operations.ts:883-886`
问题: `attention` 视图取 `mcp_sync_deletion_days` 中 `day` 最大的一行作为 `baseline`，没有按待办的创建日期或今天过滤。只要同一接入/项目后一天又产生删除日记录，已打开的待办显示基数就会跳到另一天，跨天待办还会用一个最新基数去描述多天拦下的条目。ADR 0242 第 272 行写的是“当天开始时的基数”，与实际查询不符。
证据（读代码证实的）:
```sql
COALESCE((SELECT d.baseline FROM mcp_sync_deletion_days d
  WHERE d.owner_id = a.owner_id AND d.agent_id = a.agent_id
    AND d.connection_id = a.connection_id AND d.project_id = a.project_id
  ORDER BY d.day DESC LIMIT 1), 0) AS baseline
```
推测: 无；这是 SQL 直接可证的逻辑错误，影响的是页面显示和主人对刹车松紧的判断，不直接改数据。
建议: 用 `substr(a.created_at, 1, 10)` 绑定到待办创建当天，或让快照按天返回基数；补一个跨天反向测试（先 11-15 建待办，再插入 11-16 的删除日记录，断言仍显示 11-15 的基数）。

### 2. 低：上一轮第 3 条的回归测试用“接入名 = connectionId”，旧实现也会通过
文件: `test/integration/mcp-memory-sync.test.ts:61-72`、`test/integration/mcp-memory-sync.test.ts:764-773`
问题: 测试 setup 把接入名直接设成 id，新测试又断言 `connectionName: first`。旧实现是在 `overview.entries` 里建 `connectionId -> connectionName` 映射，项目没有待处理笔记时退回 `connectionId`，同样会得到 `first`，所以这个用例不能证明修复。
证据（读代码证实的）:
```ts
await connections.create({
  ...scope,
  id,
  name: id,
```
```ts
expect(after.projects).toEqual([
  expect.objectContaining({
    connectionId: first,
    connectionName: first,
```
`git diff` 中被删掉的旧实现也是 `names.get(project.connectionId) ?? project.connectionId`。
推测: 无。
建议: 建连接时用与 id 不同的名字（例如 `id: "conn-first", name: "接入甲"`），并让该测试同时覆盖“项目没有待处理笔记”和 attention 两条路径；这样旧实现会失败。

### 3. 低：作者说明与改后文档/代码不一致；`refused` 的“关于主人”条目即使出现，页面也无法处理
文件: `docs/adr/0242-external-agents-join-the-memory-hub-through-one-entry.md:272`、`packages/persistence-sqlite/src/sqlite-mcp-memory-sync-operations.ts:818-823`、`packages/persistence-sqlite/src/sqlite-mcp-memory-sync-operations.ts:963-965`
问题: 文档改成“关于主人的条目仍走原来的待确认流程，不在这里”，作者说明仍写“只有被拒的会出现在列表里”。代码的 overview 过滤条件是 `(kind = 'project_note' OR state = ?)`（最后传入 `STATE_REFUSED`），理论上任何 `refused` 的 owner 条目都会出现在 `entries`；但 `decideNote` 只查 `kind = 'project_note'`，所以这种条目会出现却无法确认/恢复，命令返回 `MEMORY_MCP_SYNC_TARGET_NOT_FOUND`。
证据（读代码证实的）:
```sql
WHERE owner_id = ? AND agent_id = ? AND state IN (${marks})
  AND (kind = 'project_note' OR state = ?)
```
```sql
WHERE owner_id = ? AND agent_id = ? AND entry_id = ? AND kind = 'project_note'
```
目前本文件没有任何路径把 owner 条目写成 `refused`（`decideProject`/`decideNote` 都限定 `project_note`），所以这是潜在/当前不可达的条件，不是现在就会触发的主路径错误。
推测: 如果以后新增“拒绝关于主人的条目”的逻辑，或手工/迁移把 owner 条目置为 `refused`，就会出现“列表看得到、命令处理不了”。
建议: 明确语义：要么 overview 直接只取 `kind = 'project_note'`，要么让 `decideNote` 支持被拒 owner 条目的恢复；同时把作者说明改成与文档一致。

### 4. 低（需产品确认）：`projectDecide approve` 仍会把 `refused` 笔记一并复活，与文档只写“等批准的笔记”不完全一致
文件: `packages/persistence-sqlite/src/sqlite-mcp-memory-sync-operations.ts:914-945`
问题: 批准项目时查询集合包含 `STATE_REFUSED`，循环里非敏感条目直接变成 `active`。这意味着主人通过 `noteDecide refuse` 明确拒绝过的私有笔记，只要之后项目被再次批准（或者项目曾被拒绝后再批准），就会被复活。文档写的是“批准后这个项目下等批准的笔记变成已存，判为敏感的变成等确认”，没有说会恢复已拒绝的笔记。增量没有改变 approve 的这一集合（只是把第三个占位参数在 decline 时换成 `awaiting_confirmation`），但改动的正是这段查询。
证据（读代码证实的）:
```sql
AND kind = 'project_note' AND state IN (?, ?, ?)`,
...
STATE_AWAITING_APPROVAL,
STATE_REFUSED,
input.decision === "decline" ? STATE_AWAITING_CONFIRMATION : STATE_REFUSED,
```
```ts
const state =
  input.decision === "decline"
    ? STATE_REFUSED
    : row.classification === "sensitive"
      ? STATE_AWAITING_CONFIRMATION
      : STATE_ACTIVE;
```
推测: 页面是否会对已批准/已拒绝的项目再次发送 `approve` 未核实；如果 UI 只对 `pending` 显示批准按钮，实际触发面较小。
建议: 若逐条拒绝是最终决定，`approve` 不应包含 `STATE_REFUSED`，或至少要区分“因项目被拒而拒绝”和“主人逐条拒绝”；补对应测试并在文档写清。

## 侧重检查

- **错误路径**：三个新命令的目标不存在时都通过 `found` 返回 `MEMORY_MCP_SYNC_TARGET_NOT_FOUND`，现有测试覆盖了三种 not found；`attentionResolve` 第二次调用返回 not found。增量没有新增未捕获异常路径。
- **不合规范/不可信输入**：接入名有 `mcpConnectionNameSchema` 和存储层双重校验（1–64 码点、隐藏字符拒绝）；项目名走 `checkProjectName`（trim、NFC、长度、隐藏字符、凭据检测）；类别是 `MCP_SYNC_CATEGORIES` 白名单；笔记正文先 `normalizeNoteText`（CR 归一、只保留 `\n`/`\t`、其他控制字符替换为空格）。这些与新的 `codePointString` 快照校验一致，未发现新的绕过。
- **安全/不可逆操作**：增量让“拒绝项目”也会拒掉已等确认的敏感笔记，方向正确；`attentionResolve release` 仍直接删除条目且不增加当天 `auto_deleted`，符合“主人放行不计入”。未发现增量新增不可逆操作；意见 4 的“批准复活已拒绝笔记”值得产品确认。
- **资源耗尽**：`codePointString` 把单条笔记上限从“最多 60000 个 UTF-16 单元”变成“最多 60000 个码点”，最坏情况下 UTF-8 字节约翻倍；快照一次最多 200 条。写入端上限也是 60000 码点，因此不会再出现“写得进、快照解析失败”，但大快照的内存/传输量值得关注。`decideProject` 对单项目条目总量没有上限、逐条 UPDATE 的循环是 PR 588 既有设计，增量只多纳入 `awaiting_confirmation`，未把它算作本轮新错。
- **规则/文档一致性**：增量没有触碰提示词目录、模型请求组装、出口遮盖或工具定义，不涉及模型前缀规则；文档侧发现上一轮第 7 条的基数字段、以及作者说明与 ADR 0242 对“关于主人的条目是否在列表里”的表述不一致。

## 必答问题

1. **会不会改变模型已经见过的请求开头？** 不会。增量改的是 `memory.overview.snapshot` 页面快照、存储查询和测试，没有改 `packages/prompt-catalog`、模型请求组装、系统提示、工具定义、历史消息或遮盖；`mcpSync` 也没有进入 Himawari 自己的模型请求。发给模型的内容仍只在末尾追加，每轮会变的值仍在最后一条消息，这是既有实现，本次未触碰。依据 `prompt-prefix.md` 第 4 条。
2. **同一段文字会不会在不同请求里变成不同字节？** 不涉及模型请求。就快照而言，同一条已存笔记的正文在写入时已做 NFC/换行归一化，之后每次从同一 `contentRef` 读取，字节稳定；`connectionName`/`projectName` 来自固定 DB 字段，SQL 有固定排序，JSON 键顺序也固定。没有依赖前后文的遮盖或无序集合。整个快照仍会因 `generatedAt`、状态变化而不同，但这不是对同一段文字的改写。
3. **有没有对应的自动检查，反向用例会真的失败吗？** 部分有：`codePointString` 有正向 64 个表情和负向 65 个表情、换行/制表符/控制字符的 helper 单测；`decideProject decline` 的新集成测试在旧代码上会失败（旧逻辑会让敏感笔记停在 `awaiting_confirmation`）。但第 1 条没有 `memory.overview.snapshot` 端到端多行/表情用例，只有 helper 测试；第 3 条的新测试因 name 等于 id，旧实现也会通过；第 7 条没有跨天用例；第 6 条靠页面测试兜底。未运行测试，以上为代码路径推断。
4. **每个新值的使用端都能接受吗？** 逐项核对如下：
   - `codePointString`：只被 `contracts-v2.ts` 和契约单测直接使用，未从包根导出，没有其他使用端；当前使用端都按 `Schema<string>` 接受。
   - `connectionName`（项目/刹车待办视图新增字段）：生产端是 `mcp_connections.name`，存储校验 1–64 码点且拒绝隐藏字符；消费端是 `production-memory-control.ts` 和测试，快照校验 `codePointString(64)`，两端一致。
   - `projectName`：写入端 `checkProjectName` 限制 1–256 码点并拒绝隐藏字符/凭据，DB 限制 1–256；快照校验 `codePointString(256)`，一致。
   - `category`：写入端只允许 `MCP_SYNC_CATEGORIES`，DB 限制 1–32；快照校验 `codePointString(32)`，一致。
   - `text` / `previousText`：写入端上限为 `note_text_chars`，上限 60000 码点，且 `normalizeNoteText` 只保留 `\n`/`\t` 两种控制字符；快照用 `codePointString(60000, { allowLineBreaks: true })`，一致。
   - `decideProject` 新增纳入的 `awaiting_confirmation`：更新为 `refused`，该状态在快照 `state` 枚举、`McpSyncPendingEntry.state` 和 `decideNote` 中都能接受。
   - 唯一不一致的是意见 3 的潜在 `refused` owner 条目：overview 的 `OR state = 'refused'` 会让它可见，但 `noteDecide` 只查 `project_note`；当前没有路径产生这种条目，属于潜在问题。`codePointString` 未从包根导出这一点不构成错误，因为目前没有包外使用端。
