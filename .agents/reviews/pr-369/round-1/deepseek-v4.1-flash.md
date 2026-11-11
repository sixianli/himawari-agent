## 结论概览

未发现高危问题。分级降级、跨 owner 越权和并发 revision 这三条主路径，代码本身守住了；主要问题集中在 **historyId 作为对外标识的稳定性**、**失败路径的孤儿 payload**，以及几处两端校验/测试覆盖不一致。

下面先写读代码证实的问题，再写推测，最后逐条回答必答问题。

---

## 发现（读代码证实）

### 1. 中：historyId 用 rowid，导出/导入后会换号，且 rowid 可能被复用

- **文件:行**：`packages/persistence-sqlite/src/sqlite-memory-operations.ts:75-79`、`:933-943`；`packages/persistence-sqlite/src/data-export/snapshot.ts:65-68`；`packages/persistence-sqlite/src/data-export/import.ts:326-329`
- **问题**：`historyId` 直接取 `memory_history_events.rowid`，但数据导出没有带出 rowid，导入时也不写入 rowid。结果是同一段历史在导出/导入后 historyId 会变化；另外表没有 `AUTOINCREMENT`，历史行随记忆物理删除后 rowid 也可能被后续插入复用。控制中心把 historyId 当作不透明版本号发回服务端，服务端只校验 owner/agent 和链关系，无法发现“这个号已经指向另一条历史”。
- **证据**：
  - 服务端按 rowid 取历史：
    ```ts
    `SELECT h.rowid AS id, ... FROM memory_history_events h ...`
    ...
    `... WHERE m.owner_id = ? AND m.agent_id = ? AND h.rowid = ?`
    ```
  - 导出字段里没有 id：
    ```ts
    `SELECT memory_id, kind, content_ref, stance, quote_ref, source_deleted, occurred_at
     FROM memory_history_events ...`
    ```
  - 导入也不写 rowid：
    ```ts
    `INSERT INTO memory_history_events (memory_id, kind, content_ref, stance, quote_ref, source_thread_id, source_deleted, occurred_at)
     VALUES (?, ?, ?, ?, ?, NULL, ?, ?)`
    ```
- **建议**：如果 historyId 要跨客户端/快照边界使用，换成稳定的不透明事件 id（新增列或导出/导入时显式保留 id），或在命令里同时带 `memoryId + occurredAt + kind` 等服务端可复核的定位信息；至少要在导入后有机制让旧快照失效。若生产是一人一实例、且导入后立即刷新控制中心，风险可降为低。

### 2. 低：低分级版本复制失败时留下孤儿 payload，ADR 说的“后续清理”在代码里没有对应机制

- **文件:行**：`apps/agent-service/src/production-memory-control.ts:226-241`、`:1116-1125`；`packages/application/src/services/durable-memory-service.ts:273-299`；`docs/adr/0217-restore-memory-to-any-version.md:69`
- **问题**：低分级版本需要另存时，`#versionContent` 先 `protect + put`，之后才调用 `restoreVersion`。`restoreVersion` 仍可能因 revision 冲突或目标状态变化失败；失败后这份新 payload 不会被任何记录或历史引用。ADR 说“留到后续清理”，但仓库里未找到清理这类 `memory-version:` 孤儿引用的代码；`#deleteUnreferencedPayloadRows` 只处理删除对象列出的引用，不会主动发现无主 payload。
- **证据**：
  ```ts
  const copy = await this.options.protector.protect({ ... ref: `memory-version:...` ... });
  try { await this.options.payloads.put(copy); } catch (error) { ... }
  return { contentRef: copy.ref, stance: event.stance };
  ```
  ```ts
  const restored = await this.#versionContent(current, historyId);
  const saved = await this.options.memory.restoreVersion({ ... });
  ```
  `restoreVersion` 在保存前还会重新检查：
  ```ts
  if (current.revision !== input.expectedRevision) throw ...CONFLICT...
  if (current.status !== "active" || attributes.supersededBy !== null) throw ...INVALID_OPERATION...
  ```
- **建议**：记录本次是否真正插入了 copy，`restoreVersion` 失败时删掉本次新建且未被引用的 payload；或把复制放进保存事务/先做 revision 复核再复制。至少修正 ADR 第 69 行的“后续清理”表述，说明当前没有自动清理。

### 3. 低：网页用 singleLine 后的文本判断是否显示按钮，服务端用原始文本判断是否“与当前相同”

- **文件:行**：`apps/agent-service/src/production-memory-control.ts:418-423`、`:462-465`、`:207-209`；`apps/control-center/src/memory-history.ts:95-100`
- **问题**：快照历史文本和当前文本都经过 `singleLine`（去控制字符、trim、截断 2000）；网页用这份规范化文本比较 `entry.node.text !== head.text`。服务端 `MEMORY_VERSION_ALREADY_CURRENT` 用的是原始正文比较。两者在正文含首尾空白、控制字符或超过 2000 字符时可能不一致：网页可能不显示“恢复到这一版”，而服务端其实允许恢复。
- **证据**：
  ```ts
  const read = this.readText(ref).then(singleLine).catch(() => "");
  ...
  text: eventText,
  ...
  const text = await this.readText(event.contentRef);
  ...
  text === (await this.readText(current.contentRef)) && event.stance === ...
  ```
  ```ts
  entry.node.text !== head.text || entry.node.stance !== head.stance
  ```
- **建议**：让服务端快照额外返回一个“与当前内容是否相同”的判定，或网页/服务端统一使用同一种规范化规则；最省事的是服务端不把规范化文本用于版本相同性判断，而是快照里直接带布尔值。

### 4. 低：链归属校验与保存不在同一事务，存在链变化的 TOCTOU 窗口

- **文件:行**：`apps/agent-service/src/production-memory-control.ts:199-201`、`:244-256`；`packages/application/src/services/durable-memory-service.ts:273-299`
- **问题**：`#versionContent` 先通过 `#replacedInto` 逐条读记录确认来源事件属于当前链，随后 `restoreVersion` 只重新校验目标记忆的 revision/status，没有再确认来源事件仍在链上。若并发发生对中间旧记忆的 `restore`（会把它的 `supersededBy` 清空），理论上可能在检查之后、保存之前让来源记忆脱离链，恢复出“不再属于这条链”的版本。
- **证据**：
  ```ts
  const event = await this.options.state.readHistory({ ...this.#scope(), id: historyId });
  if (!event || !(await this.#replacedInto(event.memoryId, current.id))) throw ...
  ```
  `#replacedInto` 是一条条 `read(next)` 的普通读取；`restoreVersion` 只检查目标记忆的 revision 和状态。
- **建议**：把“重新读目标 + 验证来源链 + 保存”放进同一个 SQLite 事务，或在 `restoreVersion` 的保存事务里再验证来源事件仍可沿 `supersededBy` 到达目标；并发测试补一条“恢复过程中旧记忆被换回”的用例。

### 5. 低（部署兼容）：快照和命令都新增了必填 historyId，版本仍是 gateway.v2

- **文件:行**：`packages/gateway-contracts/src/contracts-v2.ts:1168-1178`、`:1438`、`:1455-1460`；`packages/gateway-contracts/src/validation.ts:174-181`；`apps/control-center/src/gateway-client.ts:269`
- **问题**：`object` 会拒绝未知字段和缺失必填字段。新控制中心解析旧服务端快照会因缺 `historyId` 失败；旧控制中心解析新服务端快照会因多出 `historyId` 失败。`memory.mutate` 的其他动作也被要求必须带 `historyId: null`。仓库内的控制中心已同步更新，但任何外部/旧客户端或滚动发布期间的版本错配都会直接报契约错误。
- **证据**：
  ```ts
  historyId: integer(1),
  ...
  historyId: nullable(integer(1)),
  ...
  if ((payload.action === "restore_version") !== (payload.historyId !== null)) { ... }
  ```
  ```ts
  if (!Object.hasOwn(record, key)) fail(`${path}.${key}`, "missing required field");
  ...
  if (!expectedKeySet.has(key)) fail(`${path}.${key}`, "unknown field");
  ```
- **建议**：确认控制中心和服务端总是同版本发布；否则考虑把新字段做成兼容读取（客户端为缺省字段补 null/0），或提升契约版本/做能力协商。

---

## 推测（未证实）

- **跨租户活动量泄露**：rowid 是整个表全局递增的。如果同一个 SQLite 数据库承载多个 owner，某个 owner 看到自己的 historyId 有缺口，可以粗略推断其他 owner 产生了多少历史事件。若生产是“一人一实例”，这一点不成立；仓库里没有足够的部署信息来证实。
- **孤儿 payload 可被反复制造**：有权调用恢复的 owner 通过并发/冲突请求可反复触发低分级复制失败，逐渐占用磁盘；有 `assertDiskHeadroom` 作为最后防线，但不会自动回收。
- **链 TOCTOU 的实际可触发概率**：需要并发调用旧记忆的 `restore` 恰好与 `restore_version` 交错；权限上仍是同一 owner，影响更像“恢复错版本/来源”，不是越权。

---

## 侧重检查

- **越权（别的记忆 / 别的 owner）**：`readHistory` 的 SQL 同时按 `m.owner_id`、`m.agent_id` 过滤；`#replacedInto` 逐条读记录时也校验 owner/agent；事件必须属于当前记忆或沿 `supersededBy` 到达当前记忆。集成测试里用另一条同 owner 的记忆验证了 `MEMORY_VERSION_NOT_FOUND`。未发现跨 owner 读取路径。跨 owner 测试缺失，但代码边界成立。
- **分级降级**：`#versionContent` 分级相同复用、较低按当前分级 `protect`、较高拒绝；`sqlite-memory-operations.ts:728-730` 的保存强校验“payload 分级必须等于记忆分级”。未发现降级路径。
- **并发版本号**：控制层先校验一次 `expectedRevision`，`DurableMemoryService.restoreVersion` 再读一次并校验，`save` 事务里还会校验 `expectedRevision !== current.revision`，两个并发恢复不会都成功。问题是失败方可能留下孤儿 payload（见发现 2）。
- **契约对 historyId 的校验**：快照要求 `integer(1)`；命令要求 `nullable(integer(1))` 且与 `restore_version` 异或；`readHistory` 再检查 `Number.isSafeInteger` 且 `>= 1`。生产端/消费端都能接住；`historyId: 0` 只在网页合成的历史节点里出现，且被 `historyId > 0` 排除，不会发回服务端。
- **网页按钮出现条件**：`headCurrent && !restorable && historyId > 0 && kind !== "reaffirmed" && 文本或立场不同`。服务端也要求目标 active 且未被取代，并拒绝文本、立场都相同的版本；大方向一致，但规范化文本差异见发现 3。
- **错误路径 / 不可信输入 / 资源**：SQL 全是参数绑定；负数、非安全整数、非数字 historyId 在 `readHistory` 层被拒绝；`#replacedInto` 有 `seen` 防环。资源方面主要是孤儿 payload 和长链逐条读取；后者是 owner 自己可造的数据，风险低。
- **不可撤销操作**：恢复只追加新 revision 和新历史，不改旧历史；再次恢复其他版本即可回退。共享 payload 的删除逻辑也有 FK 扫描和 `ON DELETE RESTRICT` 兜底，删除一条记忆不会误删仍被另一条引用的正文。
- **规则/文档与代码一致性**：ADR 关于“不改表结构”“只改正文/立场”“同分级复用/低分级另存/高分级拒绝”“删除只清未引用正文”与代码一致；唯一明显不一致是 ADR 第 69 行“留到后续清理”，仓库里没有对应清理实现。另：题面引用的 `.claude/rules/prompt-prefix.md` 在当前检出的仓库里不存在（glob 未找到），我无法读到规则全文，只能按题面引用的规则和运行时代码核对，这一点标“未核实”。

---

## 必答问题

### 1. 这个改动会不会改变模型已经见过的请求开头？发往模型的内容是否仍然只在末尾追加？

**不会因本改动改变。** 本 diff 没有改系统提示、工具定义或提示词目录；新增的 `historyId` 只进入 `memory.overview.snapshot`（控制中心）和 `memory.mutate` 网关命令，不进入模型请求。运行时里记忆/画像块是本轮新的 `<himawari-context>`，拼在本轮 `<owner-message>` 前面并作为新消息追加（`packages/runtime-pi/src/pi-runtime-adapter.ts:623-641`），不是回写历史前缀。恢复操作改变的是记忆库存，后续回忆/画像只影响之后新追加的上下文块；已发出的历史消息、系统提示和工具定义不变。

严格说，如果恢复的是一条被钉住/进入 owner-profile 的记忆，之后新运行的画像上下文块内容会变化；这与现有“编辑/纠正”记忆完全相同，不是本改动新增的字段或新的提示词拼接方式。

### 2. 会不会让同一段文字在不同请求里变成不同字节？

**不会让同一段文字在模型请求里变成不同字节。** `historyId` 不进入模型请求；没有新增依赖前后文的遮盖、时间字段或无序列化集合。恢复副本的 ref 由 `memoryId + revision + historyId` 确定；加密随机数只影响存储密文，不进入模型。需要注意：`historyId` 本身在控制面不是全局稳定标识——跨导出/导入会变、极端情况下 rowid 会复用（见发现 1）；这影响的是控制中心传回的版本号，不是模型看到的文字字节。`memory.overview.snapshot` 原有的 `generatedAt` 等每轮变化字段是既有行为，本改动没有新增这类模型输入。

### 3. 有没有对应的自动检查？反向用例是否真的会失败？

**有。** 新增的检查包括：
- `test/integration/production-memory-capture.test.ts:630`：三次编辑后恢复到第一版，断言正文、revision、历史新增 `restored`、payload 复用、投影内容；同一用例还断言 `ALREADY_CURRENT`、旧 revision、外部记忆 `NOT_FOUND`、契约的 historyId 双向约束、失败后历史不变。
- `test/integration/production-memory-capture.test.ts:769`：被取代旧记忆的版本恢复到当前记忆。
- `test/integration/production-memory-capture.test.ts:856`：低分级版本按当前分级重新加密。
- `test/integration/production-memory-capture.test.ts:890`：高分级版本拒绝。
- `apps/control-center/test/memory-interactions.unit.test.ts:624`：按钮出现条件与发出的命令 payload。
- `apps/control-center/test/memory-interactions.unit.test.ts:691`：目标非 active/已取代时不显示版本恢复。

从断言看，这些反向用例在实现被改坏时确实会失败（例如不复制分级会触发保存的“分级必须一致”，不拒绝高分级会无法命中 `toThrow`，契约异或删掉会解析不报错）。**但我没有运行测试（只读复核），所以“实际执行会失败”这一点未核实。**

覆盖缺口：
- 服务端没有自动测试 `MEMORY_VERSION_TARGET_NOT_CURRENT`（只有网页单测间接覆盖 archived/trashed）。
- 没有跨 owner 的 historyId 测试。
- 没有导出/导入后 historyId 变化的测试。
- 没有保存失败留下孤儿 payload 的测试。
- 没有链 TOCTOU 的并发测试。

### 4. 每个新增/修改的值，产生它的地方和使用它的地方能否互相对应？

- **historyId 的产生**：`sqlite-memory-operations.ts:75-79` 用 `h.rowid AS id`；`listHistory`/`readHistory` 返回给 `MemoryHistoryEvent.id`。
- **控制中心快照**：`production-memory-control.ts:465` 把它放进 `historyId`；`contracts-v2.ts:1170` 要求整数 `>=1`。实际 rowid 是整数，能通过。
- **网页使用**：`memory-history.ts:83`、`:95-100` 读取并用于 `versionRestorable`；`historyId: 0` 的本地合成节点被 `historyId > 0` 排除，不会发回服务端。
- **命令生产**：`apps/control-center/src/memory.ts:161-168` 发 `restore_version` + historyId；其他动作统一发 `historyId: null`（`memory.ts:122-128`、`:152-158`）。
- **契约消费**：`contracts-v2.ts:1438` 要求 `nullable(integer(1))`，`:1455-1460` 要求只在 `restore_version` 时非 null；缺失字段会被 `validation.ts:180` 拒绝，非安全整数会被 `integer()` 拒绝。
- **服务端消费**：`production-memory-control.ts:1090` 解出 historyId；`#versionContent` 通过 `readHistory({ ownerId, agentId, id })` 读取，`sqlite-memory-operations.ts:938` 再检查 `Number.isSafeInteger` 且 `>=1`；随后 `#replacedInto` 校验链。
- **其他实现者**：`ProductMemoryStatePort.readHistory` 目前只有 SQLite 实现；`MemoryHistoryEvent.id` 没有其他实现者，不会漏改。
- **其他 memory.mutate 生产者**：生产代码只有控制中心的 `memory.ts`，已更新。测试里若直接用 `control.execute({...} as never)` 构造旧 payload（例如 `production-memory-capture.test.ts:410`、`:1966`），会绕过契约、不带 historyId；这是测试写法，不是生产路径，但也说明契约收紧后外部/旧客户端必须同步升级。
- **快照兼容**：新字段是必填，旧客户端/旧服务端混跑会失败（见发现 5）。

结论：在仓库内生产路径上，两端对 historyId 的类型、范围和存在条件是对齐的；未对齐的是 **rowid 作为标识的跨导出/导入稳定性**，以及 **测试辅助代码绕过契约** 这两类边界。
