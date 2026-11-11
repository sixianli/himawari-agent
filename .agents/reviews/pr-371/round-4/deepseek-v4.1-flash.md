## 读代码证实的问题

### 1. 高：一个以上矛盾对时，后面的矛盾对会被“低置信/未使用/来源不可查”队列抢走
- 文件：`packages/application/src/services/memory-checkup.ts:122-145`
- 问题：四类队列是轮流的，而 `seen` 是全局的。第 2 个及以后的矛盾对，要等到后面的轮次才轮到；但它的新条往往也满足 `low_confidence`（待确认的新条本来置信度就低），会在更早一轮被其他队列取走。等轮到该矛盾对时，`ids.some(seen.has)` 命中，整对跳过，于是这对不以 `conflict` 出现，甚至两条分别以“低置信”等身份出现。
- 证据：
  - `memory-checkup.ts:130-141`：每轮每个队列只取一条；`if (ids.some((id) => seen.has(id))) continue;` 只要一条出现过就整对丢弃。
  - `memory-checkup.ts:83-102`：`conflict` 之外的三类都按单条记忆生成候选，不排除属于矛盾对的记忆。
- 建议：先把所有矛盾对的 `memoryId`/`relatedMemoryId` 预占，或在轮转前完整处理 `conflict` 队列；并补一个“两个矛盾对、第二个新条同时低置信”的反向用例。

### 2. 中：周清单生成后不再校验，P3-8 撤销 hold 后旧冲突仍可被删除/合并
- 文件：`packages/application/src/services/memory-checkup.ts:187-188`、`packages/application/src/services/memory-checkup.ts:240-261`
- 问题：周清单一经生成，`week()` 直接返回存量行；`act()` 只检查两条仍在用（`#live`），不检查新条是否仍待确认、hold 是否仍有效。若同一周内 P3-8 撤销了 hold（新条转正），或新条在别处被确认，清单一仍显示为 `conflict`，仍提供“删掉新的 / 用新的替换旧的”，可按已不存在的冲突归档或删除记忆。
- 证据：
  - `memory-checkup.ts:187-188`：`const existing = await store.listWeek(...); if (existing.length > 0) return existing;`
  - `memory-checkup.ts:240-241`：`const subject = await this.#live(item.memoryId); const tentative = ...`，但后续 `delete`/`merge` 分支不再使用 `tentative` 做前置拒绝。
  - ADR `docs/adr/0218-weekly-memory-checkup-in-daily-rating.md:64` 声称“新条已不是待确认的……撤销过的也在此列”，这只在生成清单时成立。
- 建议：对已生成清单里的 `conflict` 项，在处理时重新确认“新条仍 tentative 且该 hold 仍有效”；或把失效项标记为不可操作/不再显示。补“先生成本周清单，再确认/撤销新条，再操作”的用例。

### 3. 中：`listHeldPairs` 返回历史 hold（含已撤销），可能把旧配对当成当前冲突
- 文件：`packages/persistence-sqlite/src/sqlite-memory-consolidation-operations.ts:273-276`、`packages/application/src/services/memory-checkup.ts:83-88`
- 问题：查询只过滤 `action = 'hold'`，没有 `undone_at IS NULL`，也不比对当前版本。体检侧只靠“新条仍 tentative + 两条在用”过滤。撤销 hold 后新条转正，旧对暂时被排除；若以后该新条因另一条旧记忆再次进 hold，`listHeldPairs` 会同时返回旧对和新对，`seen` 先到先得，可能拿到已撤销的旧对，把新条和无关的旧条配在一起。
- 证据：`...WHERE owner_id = ? AND agent_id = ? AND action = 'hold' AND related_memory_id IS NOT NULL ORDER BY id`；`memory-checkup.ts:85-86` 仅检查 `tentative === true && byId.has(relatedMemoryId)`。
- 建议：给体检单独提供“当前有效的 hold”查询（`undone_at IS NULL`，必要时按 memory 取最新一条），不要直接复用面向整理去重语义的 `listHeldPairs`；补“撤销后再与另一条旧记忆 hold”的用例。

### 4. 中：体检生成失败时，hold 决策记录被整组隐藏
- 文件：`apps/agent-service/src/production-proactive.ts:339-348`、`packages/application/src/services/daily-review.ts:296`
- 问题：`week()` 失败时 catch 返回 `[]`，随后仍以 `checkup: []` 调用 `readDailyReview`；而 `readDailyReview` 只要 `checkup !== undefined` 就丢弃所有 `hold` 整理记录。结果是生成失败期间冲突对既不在体检组、也不在“整理记忆”组，页面完全看不到。同理，周名额已满而未入选的 hold 对也不会在任何组出现。
- 证据：`production-proactive.ts:345-348` 返回 `[]`；`daily-review.ts:296` `if (options.checkup !== undefined && entry.kind === "consolidation" && entry.outcome === "hold") continue;`。
- 建议：失败时传 `undefined` 而不是 `[]`，或只抑制“确实被体检清单覆盖”的 hold；补 `failWeek` 且账本里存在 hold 记录的用例。

### 5. 低：ADR 说“两个错误一起报出”，代码丢掉了原始错误
- 文件：`packages/application/src/services/memory-checkup.ts:292-300`、`packages/application/src/services/memory-checkup.ts:167-172`
- 问题：改记忆失败、退回也失败时，`refuse("conflict", "MEMORY_CHECKUP_RESTORE_FAILED")` 新建错误，未携带原始 `error`，也不是聚合错误。ADR `0218:53` 写的“两个错误一起报出”与代码不一致。
- 建议：把原始错误作为 `cause`/聚合信息保留，或修正 ADR 措辞。

### 6. 低：迁移 CHECK 没有约束 `kept_memory_id` 只出现在 merge
- 文件：`packages/persistence-sqlite/src/migrations/0090_memory_checkup.sql:9-18`、`packages/persistence-sqlite/src/sqlite-memory-checkup-operations.ts:193-205`
- 问题：`action='confirm'/'delete'` 时数据库也接受非空 `kept_memory_id`；`recordAction` 也不校验两者关系，只靠应用层 `act` 正确传值。作者问的“recordAction 清空 undone_at、recordUndo 清空其余列”本身一致，但 CHECK 与写入语义没有完全对齐。
- 建议：增加 `CHECK (kept_memory_id IS NULL OR action = 'merge')`（不要强制 merge 必须非空，因为 `ON DELETE SET NULL` 会在被保留记忆删除时置空），并补反向用例。

### 7. 低：体检操作后 P3-8 的 hold 撤销会因版本号变化被永久拒绝
- 文件：`packages/memory-engine/src/consolidation.ts:434-439`、`packages/application/src/services/memory-checkup.ts:316-320`、`345-350`
- 问题：P3-8 撤销要求 `memory.revision === change.afterRevision`。体检的 confirm/delete/merge 以及体检自己的 undo 都会推进 revision；即使体检撤销把 `tentative` 恢复成 true，P3-8 的 hold 撤销仍会报 `MEMORY_CHANGED_AFTER_CONSOLIDATION`。不会破坏数据，但“体检撤销后 hold 还能原样撤销”并不成立。
- 建议：在 ADR/界面上写明该限制；如需恢复，撤销逻辑改为比较语义状态（tentative/related 对）而不是只看 revision。

## 推测/未核实
- 上述第 1、3 条的实际触发频率取决于同一周矛盾对数量和待确认记忆的置信度分布；机制由代码确定，但我没有运行真实数据验证。
- 我没有运行测试（只允许读与 git），所以“反向用例是否真的会失败”只能按断言内容判断，见必答问题 3。
- 数据导出不包含 `memory_checkup_items` 与 ADR 一致；是否有测试强制所有表都进入导出，我未继续核实。
- DST 时区下 `checkupWeekStart` 的边界未做实际验证。

## 侧重检查
- **错误路径**：检查了先占行后改记忆、改记忆失败回滚、回滚再失败、进程崩溃后的撤销、重复点击并发占行。占行 CAS 与撤销恢复总体正确；发现第 5 条“原始错误丢失”。
- **不可信输入**：`proactive.review.checkup` 的 `key/action/keep` 经过 gateway 合约校验，`parseReviewKey` 限定前缀，存储读写都带 owner/agent scope；`keep` 只能选该对中的一条。SQL 均参数化。未发现注入或越权路径。
- **不可撤销操作**：删除走回收站、合并走 archived + `before_state`，撤销逻辑区分“仍处于本次处理后状态”再恢复；未发现直接不可恢复的破坏。但第 2、3 条会给出过时/错误的冲突语境，可能导致用户据错误信息执行合并或删除。
- **资源耗尽**：周生成会扫描全部在用记忆并批量查来源（每线程每 200 个 ref 一批），不是无界单次查询；失败返回空组。每个非法 checkup 命令仍会触发一次完整 review，成本有上限但偏重。
- **规则/文档一致性**：`prompt-prefix.md` 不涉及本次改动；ADR 0218 与代码有两处不一致：第 5 条“两个错误一起报出”，以及第 2/3 条涉及的“撤销过的也在此列”。配置键 `reviewMemoryUnusedDays` 在类型、严格解析、默认值、快照和网页均已贯通。
- **隐私**：不可见分类的记忆在体检里返回 `hidden: true`、正文为空，未泄露正文；但 `memoryId` 仍会出现在快照中，与现有记忆页做法一致。

## 必答问题

1. **会不会改变模型已见过的请求开头？**
   不会。本次 diff 没有改 `packages/prompt-catalog`、提示词清单或任何模型请求组装；体检只影响 SQLite、gateway 快照和每日打分页面。查到的 `readDailyReview` 唯一生产调用方是 `ProductionProactive` 的页面快照，不进入发给模型的内容。因此仍然只在末尾追加、系统提示/工具/历史不变；本轮变化值也没有被塞进系统提示或历史。

2. **同一段文字会不会在不同请求里变成不同字节？**
   对模型请求不涉及。对页面/快照数据，周清单生成后存库并固定，排序分别为 `listWeek ORDER BY rowid`、`listHeldPairs ORDER BY id`，其余排序都有 id 作为决胜；`createdAt/handledAt` 是存下来的时间，不在每次请求重算。未发现遮盖或集合顺序导致同数据不同字节。`generatedAt` 本来就会随请求变化，但不在模型请求里。

3. **有没有自动检查，反向用例真会失败吗？**
   有：迁移契约测试、`daily-review` 的 UTF-16 截断用例、真实 SQLite 的 worker/direct 集成测试、gateway 合约拒绝用例、control-center 交互用例。迁移的重复周/周内同记忆、reason 非法、action 与 before 不配对、配对记忆删除置空等反向断言，去掉对应 CHECK 后确实会失败。
   但我发现的四条关键反向路径没有覆盖：多个矛盾对互相抢位、周清单生成后 hold 失效、`listHeldPairs` 含已撤销 hold、`week()` 失败时 hold 被隐藏。因此这些行为目前没有失败的门槛。

4. **每个新值/字段/清单项，生产端和消费端都能接受吗？**
   - `reason`/`action`：迁移 CHECK、application 类型、gateway 枚举、网页标签一致。
   - `memoryId`/`relatedMemoryId`/`keptMemoryId`：`MemoryId` 与 gateway `machineString` 都限制为 1–128 位 `[A-Za-z0-9._:-]`，体检 item id 为 `memory-checkup:<uuid>`，能通过校验。
   - `checkup` 字段：ledger/mail 生产端都显式给 `null`，体检项给对象；快照合约、fixture、浏览器 fixture、control-center 测试均已补齐。
   - `memoryUnusedDays`：配置接口、严格解析白名单/默认值/范围、停服快照、fixture、网页显示均已打通。
   - 新操作 `proactive.review.checkup`：消息类型表、schema 表、`PRODUCTION_PROACTIVE_OPERATIONS`、e2e 固定服务和前端操作清单都已加入。
   - 迁移登记：`0090`、`migration-engine`、`schema-catalog`、迁移序号上限测试、`SUPPORTED_SCHEMA_MAX=90` 一致。
   - 已知缺口：迁移没有约束 `kept_memory_id` 与 `action` 的关系（第 6 条）；`EXTERNAL_PROPOSAL_MEMORY_PREFIX` 现在在 gateway-contracts、`production-mcp-memory-writer.ts`、运维脚本各有一份，现有测试只交叉核对后两者与 gateway，writer 的副本未纳入同一检查。
