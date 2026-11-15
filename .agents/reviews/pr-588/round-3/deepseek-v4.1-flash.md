**上一轮意见核对（5953a9d..794a63b 增量）**

- 第 1 条（跳过条目的 payload 变成孤儿）：**已改好**。`push` 改为在 `finally` 中清理（`sqlite-mcp-memory-sync-operations.ts:193-199`），两个新增断言分别覆盖 `kind_changed` 和 `owner_deleted`（`mcp-memory-sync.test.ts:416-426`、`:640-646`）。
- 第 6 条（目录删除说明与 `ON DELETE RESTRICT` 不符）：**已改好**。`schema-catalog.ts:727` 已改成“正文由 restrict 引用持有，只有显式删除 payload 才会移除”，与迁移 `20261115124342_mcp_memory_sync.sql:43,65`、`0093_external_memory_proposals.sql:10` 一致。
- 第 2 条（跨请求删共享 payload）：**仍未修**，见意见 1。
- 第 3 条（payload 写入阶段失败留孤儿）：**仍未修**，见意见 2。
- 第 7 条（共享 proposal 只接替一条旧记忆）：**仍未修**，见意见 3。

### 1、中：成功路径也会删掉并发请求正要引用的内容寻址 payload，外键只在行已写入后才保护

- 文件:行：`packages/persistence-sqlite/src/sqlite-mcp-memory-sync-operations.ts:193-199`、`:233-249`；`packages/persistence-sqlite/src/migrations/20261115124342_mcp_memory_sync.sql:43,65`
- 问题：清理从 `catch` 移到 `finally` 后，正常返回也执行 `dropUnusedPayloads`。删除语句只按 `ref + owner_id + agent_id` 删除，不检查该 ref 是否正被另一个并发请求使用；`ON DELETE RESTRICT` 只能保护**已经写入** `mcp_sync_entries` / `mcp_sync_versions` / `external_memory_proposals` 的引用。两个请求同时同步同一段文字时，A 的条目被跳过、A 的清理先删掉共享 payload，B 随后插入同一 ref 会触发外键失败。上一轮第 2 条没有真正解决，且触发面从失败路径扩大到了成功路径。
- 证据：

  ```ts
  try {
    return this.pushBatch(input);
  } finally {
    this.dropUnusedPayloads(input);
  }
  ...
  this.database
    .prepare("DELETE FROM payloads WHERE ref = ? AND owner_id = ? AND agent_id = ?")
    .run(ref, input.ownerId, input.agentId);
  ```

  迁移中引用端为 `content_ref TEXT NOT NULL REFERENCES payloads(ref) ON DELETE RESTRICT`（entries 第 43 行、versions 第 65 行）。
- 建议：不要在单个请求里做跨请求的内容寻址 GC。可改为在同一写通道内按 owner/agent 串行化并重新核对所有引用表；或增加引用计数/租约，只删除确认无任何 pending 写入者占用的 payload；至少补一个两个连接并发同步同一文字、其中一条被跳过的反向用例。
- 证实/推测：删除无条件执行、无 `contentInUse` 检查是**读代码证实**；“A 清理与 B 插入交错导致 B 外键失败”是**推测**（并发交错窗口，代码没有外层串行化）。

### 2、中低：payload 写入阶段失败仍会留下孤儿，与“整批原子、库里不留半批”不一致

- 文件:行：`apps/agent-service/src/production-mcp-sync.ts:245-297`、`:430-452`
- 问题：生产层在调用 `store.push` 之前逐条调用 `#storeText` 写入 sync/proposal 正文。`Promise.all(stored)` 任何一个 reject、或第 2 条 `#storeText` 失败时，前面已经写好的 payload 不会被清理，因为此时 `push` 根本没被调用，`finally` 清理也不会发生。上一轮第 3 条仍未修。
- 证据：

  ```ts
  stored.push(this.#storeText(syncRef, parsed.text, parsed.classification));
  if (proposalRef !== null)
    stored.push(this.#storeText(proposalRef, parsed.text, parsed.classification));
  ...
  await Promise.all(stored);
  ...
  result = await this.#options.store.push({ ... });
  ```

  `#storeText` 只吞掉 `DUPLICATE`，其它错误直接抛出（`:448-450`）。
- 建议：把“写 payload + push”包在同一 try/catch 中，失败时清理由本请求新建但未被任何表引用的 ref；清理本身也要避开意见 1 的并发问题。补一个“第二条 payload 写入失败后 payload 表不增加”的用例。
- 证实/推测：写入顺序和无清理是**读代码证实**；“失败后会留下孤儿”由代码路径直接确定。

### 3、中低：共享 proposal 仍只接替一条旧记忆（上一轮第 7 / 第 1 轮第 9 条未修）

- 文件:行：`packages/persistence-sqlite/src/sqlite-mcp-memory-sync-operations.ts:136-146`；`packages/persistence-sqlite/src/sqlite-external-memory-proposal-operations.ts:151-179,230-276`；`apps/agent-service/src/production-mcp-memory-writer.ts:320-330`
- 问题：外部 proposal 按 `text_sha256` 去重，多个不同 stable id 的同步条目可能指向同一个 proposal；但 `replacedMemory` 用 `ORDER BY entry_id LIMIT 1` 只返回一个旧记忆 id，记忆写入时也只 supersede 这一个。其余共享该 proposal 的条目对应的旧记忆不会被接替，可能留下重复/过期记忆。
- 证据：

  ```ts
  SELECT replaces_memory_id FROM mcp_sync_entries
  WHERE owner_id = ? AND agent_id = ? AND proposal_id = ? AND replaces_memory_id IS NOT NULL
  ORDER BY entry_id LIMIT 1
  ...
  const replacedId = (await this.#options.replaced?.(proposal.id)) ?? null;
  ```

  去重逻辑在 `external_memory_proposal_operations.ts:151-179` 按 `text_sha256` 找到已有 proposal 后直接返回它。
- 建议：让 `replacedMemory` 返回该 proposal 关联的全部 `replaces_memory_id`，由 `applyProposal` 逐个 supersede；或取消跨 stable id 的 proposal 共享，为每个同步条目保留独立 proposal。补一个“两个 stable id 同文、各自有旧记忆”的反向用例。
- 证实/推测：`LIMIT 1` 和单值使用是**读代码证实**；“会留下未被接替的旧记忆”是由该路径直接推出的结果。

**侧重检查**

- 错误路径：`push` 的非法输入、连接非 active、待确认满、事务回滚都由 `finally` 清理；这一点有效。但成功路径的清理引入了意见 1 的跨请求删除窗口。
- 不可信输入：本轮增量未改 `checkProjectName` / `checkStableId` / `versionTag` 校验；抽查现有调用端，错误结果仍只返回 reason，不回显项目名，未发现增量带来的新绕过。
- 安全与不可撤销操作：删除仍要求 `entry === "service_token"` 且版本 tag 匹配，删除刹车逻辑未被增量改动；未发现新的越权删除路径。
- 资源耗尽：清理会阻止被跳过条目的正文继续累积（第 1 条已修）；但写入阶段失败仍会留孤儿（意见 2）。
- 说明文档与代码一致性：`schema-catalog` 的 restrict 描述已与迁移一致。作者“整批原子、库里不留半批”的说法在 payload 层仍不完全成立（意见 2）。
- 未核实（不在本轮增量范围）：同正文改分类时的升级路径、`find_memories` 查询长度上限等旧代码，本轮没有重新展开评审。

**必答问题**

1. **模型请求开头**：本轮增量不涉及。增量只改 SQLite payload 清理、目录说明和测试，没有改系统提示、工具定义、历史消息或遮盖结果，也没有改 Himawari 自己的模型调用；没有看到把每轮会变的值放进开头的新逻辑。
2. **同一文字是否会在不同请求里变成不同字节**：本轮增量不涉及。清理只删除 payload，不改写内容；sync/proposal 的 ref 由 owner、agent、classification、kind 和正文 digest 的 SHA-256 决定，同一范围同一文本仍是同一 ref。新增的时间字段只写入数据库，不进入模型内容。
3. **自动检查与反向用例**：有新增断言（`mcp-memory-sync.test.ts:416-426`、`:640-646`）。按代码推演，未修复前这两个计数断言会多出 2 个 payload，因此反向用例会失败；本轮**未运行测试**（工具限制），无法核实作者声称的 40 个用例通过。并发共享 payload 和 payload 写入阶段失败没有反向用例；`schema-catalog` 文字没有自动校验，现有契约测试只检查字段形状。
4. **增量产生或修改的值的两端校验**：增量新增/修改的实际值只有目录说明文本和清理时使用的 `contentRef` / `proposalContentRef`。这些 ref 的生成端在 `production-mcp-sync.ts:259-267`；使用端为 `mcp_sync_entries.content_ref`、`mcp_sync_versions.content_ref`、`external_memory_proposals.content_ref`，三处均为 `ON DELETE RESTRICT`，且 `payloads.ref` 是全局主键、删除按 owner/agent 过滤。两端校验没有发现不兼容；但 RESTRICT 只保护已写入的行，不能覆盖意见 1 的并发窗口。目录说明文本只被 `schema-contract.contract.test.ts` 检查为字符串，不存在使用端校验冲突。

**本轮查过的范围**：`5953a9d..794a63b` 增量涉及的 `sqlite-mcp-memory-sync-operations.ts`、`schema-catalog.ts`、`mcp-memory-sync.test.ts`；为核对引用端追到新迁移、`sqlite-external-memory-proposal-operations.ts`、`production-mcp-sync.ts`、`production-mcp-memory-writer.ts` 和 `schema-contract.contract.test.ts`。
