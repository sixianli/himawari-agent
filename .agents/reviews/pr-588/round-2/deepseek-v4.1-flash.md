**本轮范围**：只核对了增量 `e49a41b..5953a9d` 改到的 4 个文件（`production-mcp-sync.ts`、`schema-catalog.ts`、`sqlite-mcp-memory-sync-operations.ts`、`test/integration/mcp-memory-sync.test.ts`），并沿证据读了它们直接依赖的迁移 SQL、`payloads` 建表、`externalMemoryProposal.submit`、`mcp-project-name.ts`、`production-mcp-read.ts`、`production-mcp-memory-writer.ts`、迁移引擎契约测试和提示词清单测试。没有运行测试，并发时序未实测。

### 1、中：逐条跳过的条目（kind_changed、owner_deleted）会留下无人引用的 payload

类型：读代码证实。

文件:行：`apps/agent-service/src/production-mcp-sync.ts:268-270`；`packages/persistence-sqlite/src/sqlite-mcp-memory-sync-operations.ts:226-229、550、676、552-561、193-200`。

问题：`sync_memories` 在调用存储层之前就为每个已解析条目写入正文 payload。增量把 kind 变化改成返回 `null`、由 `flatMap` 丢掉该条，但只在 `pushBatch` 抛错时才执行 `dropUnusedPayloads`。因此 kind 变化（以及旧代码里的 `owner_deleted` 分支）正常返回时，`syncRef`/`proposalContentRef` 已经写进 `payloads`，却没有任何表引用它们，且没有清理路径。

证据：

```ts
stored.push(this.#storeText(syncRef, parsed.text, parsed.classification));
if (proposalRef !== null)
  stored.push(this.#storeText(proposalRef, parsed.text, parsed.classification));
```

```ts
const items = input.items.flatMap((item) => {
  const applied = this.applyItem(input, item);
  return applied === null ? [] : [applied];
});
```

```ts
if (existing !== undefined && existing.kind !== "owner") return null;
```

```ts
private push(input: McpSyncPushInput): McpSyncPushResult {
  try { return this.pushBatch(input); }
  catch (error) { this.dropUnusedPayloads(input); throw error; }
}
```

测试 `mcp-memory-sync.test.ts:644-646` 还专门演示了 `owner_deleted` 时正文会变化（`"改过的内容"`），这条同样会留下新 payload；但测试只断言返回状态，没有数 payload。

建议：返回 `null`/`owner_deleted` 前，对未被任何表引用的 `item.contentRef` 和 `item.proposalContentRef` 做删除；或者把 payload 落盘推迟到存储层确定该条会被引用之后再写。补一条断言：kind 变化、owner_deleted 之后 `payloads` 计数不增加。

### 2、中：失败清理会跨请求删掉内容寻址共享的 payload，并发时可能让本应成功的请求失败

类型：推测（按代码时序推理，未实测并发）。

文件:行：`apps/agent-service/src/production-mcp-sync.ts:259-267、435-436`；`packages/persistence-sqlite/src/sqlite-mcp-memory-sync-operations.ts:234-250`；`packages/persistence-sqlite/src/migrations/20261115124342_mcp_memory_sync.sql:43`。

问题：`syncRef`/`proposalRef` 只由 owner、agent、分类、kind、正文摘要决定，不含 connection 或请求编号，所以不同请求、不同连接对同一段正文会共用同一个 ref。`#storeText` 发现已存在就直接返回；一个请求失败时 `dropUnusedPayloads` 按 ref 直接删除，不区分这个 payload 是否是别的并发请求刚写入、尚未提交引用的。

时序：A 写入 payload X 但尚未执行 `store.push` 事务；B 的批次失败，`dropUnusedPayloads` 删除 X（此时没有任何外键引用，删除成功）；A 的事务随后 `INSERT ... content_ref = X`，触发 `REFERENCES payloads(ref) ON DELETE RESTRICT` 失败，A 整批失败。不会丢已提交数据（有外键 RESTRICT 挡着），但会让本应成功的同步失败。

证据：

```ts
const syncRef = `${MCP_SYNC_CONTENT_PREFIX}${sha256(
  `${scope.ownerId}\u0000${scope.agentId}\u0000${parsed.classification}\u0000${parsed.kind}\u0000${digest}`,
)}`;
```

```ts
const existing = await this.#options.payloads.get(contentRef);
if (existing) return;
```

```ts
.prepare("DELETE FROM payloads WHERE ref = ? AND owner_id = ? AND agent_id = ?")
.run(ref, input.ownerId, input.agentId);
```

建议：清理只删"本次请求新写入且仍未被引用"的 ref（记录本次写入前的存在状态），或在存储层事务内加一道"引用后再清"的判定；不要对共享的内容寻址 ref 无条件删除。

### 3、中低：payload 写入阶段失败仍会留下孤儿，和"整批原子、库里不留半批"不符

类型：读代码证实的路径，触发概率未核实。

文件:行：`apps/agent-service/src/production-mcp-sync.ts:245、268-270、297-321`。

问题：`stored` 里的 promise 在 `await Promise.all(stored)` 阶段就可能失败（`protector.protect` 或 `payloads.put` 抛错）。这个失败发生在 `store.push` 之前，`store.push` 的 try/catch 包不到它，`dropUnusedPayloads` 也不会执行；已成功写入的其他 payload 就留在库里。ADR 0242 的补注写的是"中途任何一步失败就整批回滚……库里不留半批"（`docs/adr/0242-...md:262` 一带），实现只保证了数据库事务内那部分。

证据：

```ts
await Promise.all(stored);
const now = this.#options.clock.now();
...
try {
  result = await this.#options.store.push({...});
} catch (error) { ... }
```

建议：把 `#storeText`/`Promise.all` 也纳入清理范围；失败时删除本次新写入且未被引用的 ref。补一条 protect/put 抛错后 payload 计数不增加的用例。

### 4、低：作者说"只删服务令牌接入写入的条目"，代码只检查发起请求的进门方式

类型：读代码证实（说法与代码不一致；代码本身符合 ADR 0242 决定 6）。

文件:行：`packages/persistence-sqlite/src/sqlite-mcp-memory-sync-operations.ts:346-348`；`packages/persistence-sqlite/src/migrations/20261115124342_mcp_memory_sync.sql:27-53`。

问题：`applyDeletes` 只判断 `input.entry !== "service_token"`，也就是"谁在发起删除"；它没有、也无法判断"被删条目当初是谁写入的"——`mcp_sync_entries` 没有记录写入进门方式的列。因此服务令牌可以删除同一接入下由 OAuth 模型写入的 owner 条目。ADR 0242 决定 6 写的确实是"按进门的方式区分"（发起方），所以这是作者说明比代码/ADR 更宽，不是实现偏离 ADR。需要把作者说明改成"删除只能由服务令牌发起的请求执行"，或在表里记录条目来源后再收紧。

证据：

```ts
private applyDeletes(input: McpSyncPushInput): McpSyncDeleteResult[] {
  if (input.entry !== "service_token")
    return input.deletes.map(({ index }) => ({ index, status: "not_accepted" as const }));
```

建议：修正作者说明/ADR 摘要；如果产品上确实要求"只删助手写入的条目"，需要新增来源列并在删除时校验，不能只看发起方。

### 5、低：新增 kind_changed 测试的同项目分支实际命中的是 duplicate_in_request

类型：读代码证实。

文件:行：`test/integration/mcp-memory-sync.test.ts:416-428`；`apps/agent-service/src/production-mcp-sync.ts:252-256`。

问题：`note("z", ..., "项目甲")` 和 `owner("z", ..., { project: "项目甲" })` 的 `(项目名, 稳定编号)` 完全相同，生产端在进入存储层前就把第二条判成 `duplicate_in_request`；测试只断言 `"invalid"`，所以并没有覆盖 `note → owner` 的 kind 变化分支。另外这条测试也没有检查 kind_changed 之后的 payload 清理（见意见 1）。

证据：

```ts
const key = JSON.stringify([parsed.projectName, parsed.stableId]);
if (seen.has(key)) {
  invalidEntries.set(index, { index, status: "invalid", reason: "duplicate_in_request" });
```

```ts
note("z", "项目甲的笔记", "项目甲"),
owner("z", "同编号别的种类", { project: "项目甲" }),
...
expect(sameProject.entries.map((entry) => entry.status)).toEqual([
  "awaiting_project_approval",
  "invalid",
]);
```

建议：让两条用不同项目（保持稳定编号相同但项目不同则不会命中同一存储键，kind 变化检测也就不会触发——要测 note→owner 应先用同一 project 存下 note，再发 owner），并断言 `reason` 和 payload 计数。

### 6、低：schemaCatalog 说"正文随条目一起删除"，与迁移的 ON DELETE RESTRICT 不符

类型：读代码证实。

文件:行：`packages/persistence-sqlite/src/schema-catalog.ts:723-728`；`packages/persistence-sqlite/src/migrations/20261115124342_mcp_memory_sync.sql:43、65`。

问题：`mcp_sync_entries` 的 catalog 描述写 `"the text payload is removed with the row"`，但迁移里 `content_ref TEXT NOT NULL REFERENCES payloads(ref) ON DELETE RESTRICT`，没有反向级联或触发器；删条目行不会删 payload，反而必须先删/解绑 payload 才能删条目。这条文档描述会误导删除实现和审计。

证据：

```ts
"cascade with its connection or with Owner or Agent deletion; the text payload is removed with the row",
```

```sql
content_ref TEXT NOT NULL REFERENCES payloads(ref) ON DELETE RESTRICT,
```

建议：改成"删除条目受 payload 引用约束；正文由单独的 payload 清理/删除流程移除"，或补上实际清理逻辑。现有 schema 测试只校验 `encryption` 枚举，不会发现这类描述错误。

### 7、低：上一轮第 9 条（共享 proposal 只接替一条旧记忆）仍未修

类型：读代码证实（场景可构造）。

文件:行：`packages/persistence-sqlite/src/sqlite-mcp-memory-sync-operations.ts:136-146、578-592`；`packages/persistence-sqlite/src/sqlite-external-memory-proposal-operations.ts:151-157`；`apps/agent-service/src/production-mcp-memory-writer.ts:320-330`。

问题：`submit` 按 `text_sha256` 去重，同一批里不同稳定编号但正文相同的两条 owner 条目会共用同一个 `external_memory_proposals.id`；两条 `mcp_sync_entries` 可以各自带不同的 `replaces_memory_id`。`replacedMemory` 用 `ORDER BY entry_id LIMIT 1` 只返回一条，主人确认这个 proposal 时 `applyProposal` 只把一条旧记忆标为被接替，其余旧记忆继续 active。增量没有触碰这段。

证据：

```ts
.prepare(
  `SELECT replaces_memory_id FROM mcp_sync_entries
   WHERE owner_id = ? AND agent_id = ? AND proposal_id = ? AND replaces_memory_id IS NOT NULL
   ORDER BY entry_id LIMIT 1`,
)
```

```ts
const replacedId = (await this.#options.replaced?.(proposal.id)) ?? null;
```

建议：让 `replacedMemory` 返回该 proposal 下所有 `replaces_memory_id`，或对共享同一 proposal 的条目限制只能有一个接替目标；加一条"两条同文不同编号、各自有旧记忆"的确认用例。

---

**上一轮意见核对**

- 第 1 条（schemaCatalog 缺表）：已改好。迁移里的 9 张表与 catalog 新增的 9 条逐名匹配，`migration-engine.contract.test.ts:75-80` 会把 `sqlite_master` 与 catalog 做 `toEqual`，缺一条或名字写错都会失败。
- 第 2 条（payload 业务事务外、失败留孤儿）：只改好了"`store.push` 抛错"这一半。`#storeText`/`Promise.all` 失败、以及逐条跳过（意见 1）仍会留孤儿；并发共享 ref 还有意见 2 的风险。
- 第 5 条（改 kind 整批失败）：代码行为已改成逐条 `invalid kind_changed`，但留下意见 1 的 payload 孤儿，测试也有意见 5 的覆盖缺口。
- 第 6 条（无项目的 project_note 被接收）：已改好。`production-mcp-sync.ts:384-385` 在存储前拒绝 `project.value === null`；`mcp-project-name.ts:72-74` 对 undefined/null/纯空白返回 `value: null`；新测试断言两条都不入库、不产生批准记录。
- 第 9 条（共享 proposal 只接替一条旧记忆）：未改，见意见 7。

**侧重检查（错误路径、不可信输入、安全、资源、不可逆操作、文档一致性）**

- 不可信输入：项目名在写入和 `find_memories` 两处都过 `checkProjectName`（NFC、首尾空白、不可见字符、凭据/查询串/`#`），拒绝信息只给类别，不回显名字；`findProjectNotes` 返回 `MEMORY_RECALL_INPUT_INVALID` 时也不回显。`checkStableId` 只做长度/不可见字符校验，不要求 `machineString`，与服务端另生成编号的设计一致（有 `check:mcp-sync` 用例）。
- 安全/越权：删除只对服务令牌发起方生效；条目按 owner+agent+connection+project+stableId 查找，不能跨接入删；项目笔记读取按读取上限和连接撤销状态过滤。意见 4 是"作者说法比实现宽"，不是直接越权漏洞。
- 不可逆操作：删除只改状态/记 `source_deleted_at`，不物理删记忆；删除刹车按天累计且有测试。未发现增量引入新的不可逆删除。
- 资源耗尽：批量条数、正文长度、请求体都有上限；但意见 1、3 的孤儿 payload 是持续增长面，没有后台清理。
- 文档/说明一致性：意见 6（catalog 删除描述）、意见 4（作者删除范围说明）两处不一致；ADR 0242 与代码在删除按进门方式区分这一点上是一致的，错的是作者摘要的措辞。

**必答问题**

1. **会不会改变模型已经见过的请求开头？** Himawari 自己发给模型的请求：不会。增量改的都是对外 MCP 的工具描述、工具结果固定文字和存储逻辑；我核对了 `MCP_TOOL_SYNC_MEMORIES`、`MCP_TOOL_FIND_MEMORIES`、`MCP_SYNC_MEMORIES_*`、`MCP_FIND_PROJECT_NOTES_LABEL` 的导入处，只有 `production-mcp-read.ts`（对外 MCP 服务）使用，没有进入 Himawari 的系统提示或工具定义；ADR 0242 也写明"Himawari 自己发给模型的请求不变"。每轮变化的 `now`、`day` 只用于服务端存储和统计，不写进任何提示词或工具定义。对外部 agent 来说，工具清单确实会变一次（新增 `sync_memories`、`find_memories` 描述变化），这是外部客户端请求开头的变化，ADR 已明确接受；Himawari 不组装外部 agent 的请求，无法把新工具放进"最后一条消息"。
2. **同一段文字会不会在不同请求里变成不同字节？** Himawari 自己的请求：不涉及，没有新增每轮变化值。`sync_memories` 的结果按提交顺序输出，`MCP_SYNC_CATEGORIES` 是固定顺序，`projectNotes` 按 `last_synced_at DESC, entry_id` 排序，JSON 序列化结构固定。唯一需要留意的是外部 MCP 读路径：`#call` 对整次 `find_memories` 输出统一调用 `maskForExternalRead`（`production-mcp-read.ts:1487`），所以同一条项目笔记在"同响应里另一条笔记点名了密码/验证码"时可能被遮成不同内容；这是 ADR 0242 决定的整批遮盖行为，不是本次增量引入，也不影响 Himawari 自己的请求开头（此项为推测性观察，未构造用例验证）。
3. **有没有对应的自动检查，反向用例真的会失败？** 有，但不完整。schemaCatalog：`migration-engine.contract.test.ts` 的表集合 `toEqual` 同时覆盖"少登记"和"多登记"，但本轮没有新增专门的反向用例。payload 回滚：新增用例在失败后比较 `payloads` 计数，去掉清理会失败；但没有覆盖 `#storeText` 失败、逐条跳过（kind_changed/owner_deleted）和并发共享 ref。kind_changed：新增用例在去掉逐条跳过后会整批拒绝而失败；但 note→owner 分支被 duplicate 检测命中（意见 5），且没有 payload 计数断言。project_note 无项目：新用例会让"把无项目 note 写进 proj-none"的实现失败，覆盖有效。replacedMemory：没有测试（意见 7）。
4. **增量产生或修改的值，每个使用端都能接受吗？** 逐个核对过：9 个 catalog 表名与迁移 SQL 完全一致（9/9），迁移引擎测试按 `sqlite_master` 比对；`detail: "empty"` 属于 `McpSyncTextRefusal` 联合类型，`McpSyncEntryOutput.detail` 接受；`kind_changed` 属于既有 `McpSyncInvalidReason` 和计数映射；`push` 返回的 `items` 现在允许少于输入条数，唯一直接使用端是 `production-mcp-sync.ts:323-341` 的按 index `Map`，缺失项已被映射为 `kind_changed`，能接受（但 `McpSyncPushResult` 的接口注释没有写明这一点，建议补上）；`dropUnusedPayloads` 用的 `payloads.ref/owner_id/agent_id` 与实际建表一致。不匹配的是 catalog 的删除描述（意见 6）和作者对删除来源范围的说明（意见 4）。
