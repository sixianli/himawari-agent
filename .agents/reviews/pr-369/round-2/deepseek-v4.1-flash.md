# PR 369 第 2 轮复核

先说明核对范围：已阅读 `91a24877..b3a39a44` 的增量、相关生产代码、契约、客户端、测试与 ADR。仓库里 `.agents/reviews/pr-369/round-1/*` 无法读取（工具拒绝该路径，sparse checkout 也没有这些文件），所以第 1 轮原始判定**未核实**；下面只按代码核对该轮修改本身。未运行测试或 typecheck（本轮只允许读代码和 git 查询）。

## 发现（按严重度）

### 1. 中：失败清理的“并发时会被外键挡住”高估了实际保证，且没有对应测试

`apps/agent-service/src/production-memory-control.ts:1121-1136`

```ts
} catch (error) {
  if (restored.copied)
    await this.options.payloads.delete(restored.contentRef).catch(() => false);
  throw error;
}
```

`docs/adr/0217-restore-memory-to-any-version.md:69` 写的是：

> 它若已被同时进行的另一次恢复用上，删除会被外键挡住，保持原样。

这只有在该并发恢复**已经提交**引用之后才成立。复制的 ref 是确定的（`production-memory-control.ts:233`：`memory-version:${current.id}:${current.revision}:${historyId}`）。并发时另一方会在 `payloads.put` 命中 `DUPLICATE` 并得到 `copied: false`（`production-memory-control.ts:239-245`），此后到它调用 `restoreVersion` 提交之间，第一个请求仍可能把 payload 删掉；第二个请求随后会因为 `memory_records`/`memory_history_events` 对 payload 的外键失败而整体回滚。结果不是悬空引用（事务保证不会写入），但那一次本来要成功的恢复会误失败。ADR 的说法比代码实际保证更强。

现有测试只把 `restoreVersion` 改成永远抛错后检查 payload 被删（`test/integration/production-memory-capture.test.ts:905-927`），没有覆盖 `DUPLICATE` 分支，也没有覆盖“引用已提交/尚未提交”的两种时序。

建议：把清理改成有条件删除（例如在同一条 SQL 里确认 `memory_records` 和 `memory_history_events` 都没有引用，或把“创建副本 + 恢复”纳入同一事务），至少补 `DUPLICATE` 分支测试；同时把 ADR 改成“若另一恢复已提交引用则删除失败；若尚未提交，另一恢复可能随之失败，可重试”。

### 2. 低：`historyId` 直接用 `rowid`，导出/导入或恢复备份后会重新编号

- `packages/persistence-sqlite/src/sqlite-memory-operations.ts:75`：`SELECT h.rowid AS id ...`
- ADR `docs/adr/0217-restore-memory-to-any-version.md:34`：用 `rowid` 作版本编号。
- `packages/persistence-sqlite/src/data-export/import.ts:327` 导入时只插入
  `INSERT INTO memory_history_events (memory_id, kind, content_ref, stance, quote_ref, source_thread_id, source_deleted, occurred_at)`，没有保留 `rowid`。

因此同一段历史在不同数据库副本里会得到不同的 `historyId`。如果用户在导入/恢复备份前打开的页面还留着旧快照，或队列里还留着旧命令，之后点“恢复到这一版”可能命中另一个历史事件。这里的影响是**推测**：需要“旧快照/旧命令跨越导入”这个条件；但 rowid 被重新分配本身是代码事实。

建议：若允许跨导入的长时间引用，改用稳定列；否则至少在导入/恢复后强制刷新页面，并在 ADR 里说明 `historyId` 只在当前数据库生命周期内有效。

### 3. 低：祖先记忆的状态与 `reaffirmed` 的规则，网页和服务端不一致

`apps/control-center/src/memory-history.ts:95-100`

```ts
versionRestorable:
  headCurrent &&
  !restorable &&
  entry.node.historyId > 0 &&
  entry.node.kind !== "reaffirmed" &&
  (entry.node.text !== head.text || entry.node.stance !== head.stance),
```

- 网页对祖先记录只看 `headCurrent`，不要求 `entry.record.status === "active"`；而 `restorable`（整条“换回这个说法”）要求祖先 `status === "active"`（`memory-history.ts:77-80`）。
- 服务端 `#replacedInto` 只沿 `supersededBy` 走，不看中间记录状态（`production-memory-control.ts:249-261`）。

所以归档/回收站中的祖先，其非最后版本仍可能显示“恢复到这一版”，服务端也会接受；而它的最后一句不会显示“换回这个说法”。另外网页排除了 `reaffirmed`，服务端没有排除，API 仍可恢复一个重复确认事件。是否允许从已删除/归档的祖先恢复内容，ADR 没有写清。

建议：明确策略后两端一起收紧（例如服务端拒绝非 active/非 `deletion_pending` 之外的祖先、统一排除 `reaffirmed`），并补反向测试。

### 4. 低：清理吞掉所有删除错误；`DUPLICATE` 分支可能留下孤儿 payload

`production-memory-control.ts:1132-1135` 的 `.catch(() => false)` 会吞掉外键以外的失败（磁盘余量不足、文件删除失败等），ADR 说“当场删掉”实际只是尽力而为。`DUPLICATE` 分支 `copied: false` 也不会清理此前失败尝试留下的同一个确定性 ref 的孤儿 payload（`production-memory-control.ts:239-245`）。不会损坏数据，但可能积累存储或留下 ciphertext 文件。

建议：至少记录清理失败指标；必要时增加按 `memory-version:` 前缀的孤儿清扫。

### 5. 低：ADR 的“不涉及发给模型的内容”不精确

`docs/adr/0217-restore-memory-to-any-version.md:70` 写“不涉及发给模型的内容”。实际恢复后的记忆正文会通过现有的记忆召回/档案块进入后续轮次的追加内容（`apps/agent-service/src/production-memory-recall.ts:223-236` 会把 `memory` 正文放进 `rendered`），只是不会改变系统提示、工具定义或已发出的历史前缀。按 `prompt-prefix` 规则这不违规，但文档表述容易让人误以为恢复对模型完全不可见。

建议：改成“不改变请求头部/提示词目录；恢复后的正文只按现有方式在后续轮次追加出现”。

### 6. 低：`memory.mutate` 的 `historyId` 变成必填是破坏性的网关变化

`packages/gateway-contracts/src/contracts-v2.ts:1438` 为 `historyId: nullable(integer(1))`，而对象校验要求字段必须存在（`packages/gateway-contracts/src/validation.ts:180` 对缺失字段报 `missing required field`）。旧客户端或旧集成如果不带 `historyId`，所有 `memory.mutate` 都会被拒。ADR:50 已承认为代价，所以这是已知取舍；这里只提醒发布顺序：服务端和网页必须一起上线，不能让新服务端先接旧页面。

## 读代码证实与推测的边界

**已读代码证实：**

- `historyId` 由 SQLite `rowid` 产生，`readHistory` 有 `Number.isSafeInteger(id) && id >= 1` 防护（`sqlite-memory-operations.ts:933-943`）。
- 查询按 `owner_id/agent_id` 过滤（`sqlite-memory-operations.ts:939-941`），`#replacedInto` 每一步也校验 owner/agent（`production-memory-control.ts:255-258`）。
- 分级比较、复制到当前级别、恢复后 `inference=false`、`confidencePermille=1000` 都在代码里（`production-memory-control.ts:219-246`、`packages/application/src/services/durable-memory-service.ts:286-301`）。
- 契约两端 `integer(1)` 一致；新增集成测试用 `gatewayV2MessageSchema.parse` 同时校验概览快照和命令（`test/integration/production-memory-capture.test.ts:586-626`），I-73 关注的“概览产生的 id 能否通过后端校验”已覆盖。
- i18n 三个语言文件和 message id 都加了。
- `MemoryHistoryEvent.id` 只在 SQLite 适配器构造，未发现其他实现遗漏。

**推测/未核实：**

- 并发清理误失败的时序（代码事实支持，实际概率未测）。
- 跨导入的旧 `historyId` 命中错误版本（rowid 重排是事实，危害需要旧页面/旧命令跨导入）。
- 归档/回收站祖先是否应禁止恢复（策略未在 ADR 明确）。
- 第 1 轮记录内容及其“低/不修”理由（工具拒绝读取）。
- 测试是否实际通过、全仓 typecheck 是否通过（未运行）。

## 侧重检查

- **不可信输入**：`historyId` 非整数、≤0、超大值由 schema 和 `readHistory` 双重拒绝；SQL 使用绑定参数，没有拼接注入。未发现问题。
- **越权/跨租户**：`readHistory` 和链遍历都限制 `owner/agent`；不能读其他主人/代理的事件。未发现问题。
- **错误路径**：目标不是当前记忆、版本不在链上、索引不存在、正文缺失、分级更高都有明确错误；`restoreVersion` 的 revision 冲突在保存事务内再次检查。未发现问题。
- **资源耗尽**：链长度没有上限，`#replacedInto` 每次读一条记录，最坏是 O(祖先数) 次数据库读；由主人主动触发，风险低，但值得知道。复制正文在大文本/低分级版本上会增加存储；清理有上面的竞态和吞错。
- **不可撤销操作**：恢复是追加新版本、旧历史不删，可以再恢复；失败清理只动这次新建的副本。没有发现会删旧历史的路径。
- **规则/文档一致性**：`prompt-prefix` 不受影响（见问题 1 的回答）；ADR 的并发清理保证、“不涉及发给模型的内容”和 UI/服务端对 `reaffirmed`/祖先状态的差异需要修正或确认。

## 必答问题

**1. 会不会改变模型已经见过的请求开头？**

不会。改动只涉及记忆页快照、`memory.mutate` 命令、SQLite 历史读取和记忆记录；`historyId` 不出现在系统提示、工具定义或模型消息里。恢复改变的是记忆正文，按现有实现会进入后续轮次的 memory/profile 块或 `recall` 工具结果，属于追加内容，不是请求开头；本 diff 没有改提示词组装代码。唯一相关但非模型输入的是运行详情页用当前记忆正文回显过去轮次（`thread-execution-projection.ts:710-751`），那是网页展示，不改变已发请求字节。因此“只在末尾追加、每轮变化值在最后一条消息/当前轮”仍然成立。

**2. 会不会让同一段文字在不同请求里变成不同字节？**

模型可见内容不会。`singleLine` 是确定性的（控制字符转空格、去首尾、截前 2000），历史排序仍是 `occurred_at, rowid`，`historyId` 在同一数据库内稳定；复制 payload 的加密随机性只影响存储密文，不影响送模型的明文。需要注意的是 `historyId` 是 `rowid`，跨导出/导入会变（问题 2），但它本身不进模型请求。

**3. 有没有对应自动检查，反向用例真的会失败吗？**

有。按旧代码（`91a24877`）核对：

- “只差空白的版本被拒”：旧代码是 `text === ...` 直接比较，会把带尾空格的版本当成不同版本继续恢复，新测试会失败，反向有效。
- “复制失败清理”：旧代码没有删除逻辑，测试里 `context.plaintext(...)` 会是已定义，反向有效。
- `inference=false/confidencePermille=1000`：旧 `restoreVersion` 没有这两行（增量 diff 显示本轮才加），旧代码会保留原值，测试会失败，反向有效。
- “两层替换链”“恢复到被取代记忆被拒”：属于回归覆盖；这些行为在第 1 轮代码里已存在，不是本轮修复的反向用例。

缺口：没有测试 `DUPLICATE`/外键挡删除的并发分支，也没有测试“已引用的 payload 不会被清理”；ADR:69 的说法目前没有自动检查支撑。另未运行测试，不能确认全绿。

**4. 新值逐个核对两端**

- `historyId`：概览由 `event.id`（SQLite rowid，≥1）产生，概览 schema 为 `integer(1)`；客户端按钮只在 `historyId > 0` 时发送；命令 schema 为 `nullable(integer(1))`，服务端 `readHistory` 再校验安全整数且 ≥1。端到端测试用 gateway schema 双向解析，能接受。**通过**。
- `restore_version`：契约枚举、服务端分支、客户端发送三处一致；`contentRef` 必须 null、`historyId` 对非该动作必须 null，两个反向断言都在集成测试里。**通过**。
- 复制 payload ref `memory-version:${id}:${revision}:${historyId}`：`protect`/`put`/失败 `delete` 使用同一个 ref，格式与其他 `memory-version`/`memory-content` 前缀一致。**通过**（并发语义见问题 1）。
- `MemoryHistoryEvent.id` / `readHistory` 端口：SQLite 的 `listHistory`、`readHistory` 都通过同一个 `memoryHistorySelect` 产出 `id`；生产适配器已转发；未发现其他实现遗漏。**通过**。
- `MemoryHistoryNode.historyId` / `versionRestorable`：概览节点带 id，客户端回退节点用 0 且不会显示按钮；i18n 三语齐全。**通过**。
- 文档/清单：ADR 与代码大部分一致，但并发清理、模型可见性、`reaffirmed`/祖先状态三处存在上述不一致。

第 1 轮“低/不修”的理由因记录不可读无法核实；仅从本轮代码看，前三条修复方向正确，但清理的并发保证和对应测试还不足以支撑 ADR 的措辞。
