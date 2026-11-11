# 复核报告：PR 369 记忆恢复到任一版本（P3-7）

## 按严重度排列的问题

**1.（中低，测试缺口）`MEMORY_VERSION_TARGET_NOT_CURRENT` 与多层链恢复没有测试覆盖**
- 文件:行：apps/agent-service/src/production-memory-control.ts:194-198、244-256
- 问题：控制层第一个校验分支（目标记忆不是 active 或已被取代时拒绝）没有任何测试触达；ADR 0217 决定 3 说可沿 `superseded_by` 链“往前任意多层”恢复，但集成测试只覆盖了一层（replaced → head）。
- 证据：全仓库搜 `MEMORY_VERSION_`，测试里只出现 `MEMORY_VERSION_ALREADY_CURRENT`（test/integration/production-memory-capture.test.ts:705）、`MEMORY_VERSION_NOT_FOUND`（:734）、`MEMORY_VERSION_CLASSIFICATION_HIGHER`（:918）。
- 建议：补一条把 `supersededBy` 链上的目标记忆作为目标的反向用例，和一条两层链的正向用例。代码本身我逐行读过，链上判断（owner/agent 检查、环防护、方向）没有发现问题，属于覆盖缺口而非缺陷。

**2.（低，部署耦合）`historyId` 成为 `memory.mutate` 所有动作的必填键，旧网页包对升级后的服务端会全线失败**
- 文件:行：packages/gateway-contracts/src/contracts-v2.ts:1434、packages/gateway-contracts/src/validation.ts:180
- 问题：`object()` 要求每个声明的键都存在（"missing required field"），且配对规则 `(action === "restore_version") !== (payload.historyId !== null)` 对缺键同样触发（`undefined !== null` 为 true）。服务端升级后，浏览器里还挂着旧 bundle 的用户发任何 memory.mutate（改、删、置顶……）都会被拒，刷新页面才恢复。
- 证据：validation.ts:179-184 `if (!Object.hasOwn(record, key)) fail(...)`；contracts-v2.ts:1455-1459 的配对抛错。
- 建议：读代码证实这是既有模式（`contentRef` 早已是必填键），此 PR 延续它；属可接受的一次性风险，但建议在发布说明里写明“升级后旧标签页需刷新”。

**3.（低，已文档化但无机制）重新加密另存的正文在保存失败时成为孤儿 payload，目前没有清理机制**
- 文件:行：apps/agent-service/src/production-memory-control.ts:235-240、docs/adr/0217-restore-memory-to-any-version.md:69
- 问题：`payloads.put(copy)` 成功后，若 `restoreVersion` 因并发 revision 冲突失败（sqlite 端 save 在事务里复查 `expectedRevision`），这份 payload 无任何表引用。ADR 承认“留到后续清理”，但我没找到对应的清理任务（`#deleteUnreferencedPayloadRows` 只在 governed deletion 时跑）。另外 `DUPLICATE` 被静默吞掉后，靠 save 端的分类一致性校验兜底（sqlite-memory-operations.ts:728-730），我确认该兜底存在且 ref 里含 revision、分类变化必然 bump revision，吞掉是安全的。
- 建议：为无引用 payload 建一个周期清理或把 ADR 的“后续”落成任务。

**4.（信息，体验）UI 会对分级高于当前记忆的历史版本显示“恢复到这一版”，点击后才被服务端拒绝**
- 文件:行：apps/control-center/src/memory-history.ts:95-100、production-memory-control.ts:217-224
- 问题：快照的历史节点不带分级字段，UI 无法预判 `MEMORY_VERSION_CLASSIFICATION_HIGHER`。拒绝逻辑本身正确且集成测试覆盖（production-memory-capture.test.ts:918），只是按钮点了才报错。
- 建议：接受现状，或在快照里带分级以便隐藏按钮（另出契约变更）。

**5.（信息）restoreVersion 不像 correct 那样把 `inference` 置 false、`confidencePermille` 置 1000**
- 文件:行：packages/application/src/services/durable-memory-service.ts:286-299（对照 :220-235）
- 问题：恢复旧版本后，记忆仍保留当前的 inference/confidence 值。与 correct 的不对称在 ADR 里没有说明。推测是有意保留（恢复只动正文和立场），影响小。

## 侧重检查

我走的普通流程：记忆页打开某条记忆详情 → 展开变化记录 → 点“恢复到这一版”→ `useMemory.restoreVersion`（apps/control-center/src/memory.ts:158-162，发 `restore_version`+`historyId`）→ 网关 v2 命令解析（contracts-v2.ts:1431-1460 配对校验）→ production-approval-gateway.ts:200-208（鉴权后转 memoryControl）→ ProductionMemoryControl.execute 的 memory.mutate 分支（production-memory-control.ts:1089-1126：owner/agent 检查 :1093、revision 检查 :1095）→ `#versionContent`（:190-242）→ `DurableMemoryService.restoreVersion`（durable-memory-service.ts:266-300：在事务外复查 revision 与状态）→ sqlite `saveWithProjection`（事务内复查 expectedRevision、payload 与记忆分级一致 :717-730、写 `restored` 历史 :825-832、实体按原 attributes 重写 :833-840、投递向量索引任务 :698）→ 投影 worker 调 provider.upsert。

结论：正向主流程三层校验（控制层/服务层/存储层）互相独立，并发 revision 冲突在存储层事务内兜底；被新测试覆盖到控制层和存储层；**没有测试覆盖的路径**是 HTTP 网关这一段（production-approval-gateway.ts:200-208 + AgentGatewayV2Service 解析/鉴权）——但这是全部既有 memory.mutate 测试的共同模式，不是本 PR 引入的缺口。另外 `check:prompt-prefix` 门不涉及此改动（无模型可见内容变化），无需新增用例。

## 作者说法核对（读代码证实）

- “historyId 用 rowid，readHistory 按 owner/agent 读取” ✓：sqlite-memory-operations.ts:929-939（JOIN memory_records 限定 owner/agent）；且迁移 0065:4 声明 `rowid INTEGER PRIMARY KEY`，值跨 VACUUM 稳定。
- “#versionContent 四条校验” ✓：production-memory-control.ts:194、200、207-214、215-224 逐条对应。
- “共用 payload 安全” ✓：sqlite-governed-deletion.ts:1105 只删无引用 payload（:1114-1143 扫全部外键表）；0065:7 `ON DELETE RESTRICT`。
- “实体表不随恢复重算（与手动修改一致）” ✓：save 总是从 `attributes.entities` 重建实体表（sqlite-memory-operations.ts:833-840），restoreVersion 不改 attributes（除 stance），与 correct 一致。
- “验收用例（三次编辑回滚第一版、历史新增 restored、正文等于快照）” ✓：production-memory-capture.test.ts:590-761 逐项断言，含投影 provider 收到旧正文（:716）。

## 必答问题

1. **不会。** 改动只触及发给网页的 `memory.overview.snapshot`（新增 `historyId` 字段）和 `memory.mutate` 命令，不碰系统提示、工具定义、历史消息、遮盖。按规则第 2 条（prompt-prefix.md:28）和 ADR 0193，进入模型请求的记忆文本是“本轮选中的记忆”，放在最后一条用户消息里；恢复只影响未来轮次**追加**的内容。快照只进网页，不进模型请求。
2. **不会。** `historyId` 是 rowid 且建表即声明为主键别名（0065:4），值稳定；`listHistory` 按 `occurred_at, rowid` 固定排序（sqlite-memory-operations.ts:921-922）；新 ref `memory-version:{memoryId}:{revision}:{historyId}` 是确定性字符串；payload 的 `createdAt` 只是存储元数据，不进任何重复序列化的内容。没有引入带时间的展示字段或无序集合。
3. **有，且反向用例会真的失败。** 契约层配对规则抛 `ContractValidationError("...historyId")`（contracts-v2.ts:1455-1459），集成测试断言两种反向（restore_version 缺 historyId、delete 带 historyId）parse 失败（test/integration/production-memory-capture.test.ts:739-761）；UI 单测断言按钮出现/消失条件与发出的命令字段（apps/control-center/test/memory-interactions.unit.test.ts:625-705）。缺口见问题 1（TARGET_NOT_CURRENT、多层链）。
4. **逐值核对通过。** `historyId`：sqlite 产 rowid ≥1，契约 `integer(1)` 匹配，UI 的合成节点用 0 并被 `historyId > 0` 挡住，跨 owner 由 readHistory 的 JOIN 挡住（越权版本号实测用例覆盖：production-memory-capture.test.ts:734）；`restore_version` 动作：契约枚举+配对、control 分支、控制中心 UI 三端一致；`DurableMemoryService.restoreVersion` 与 `readHistory` 端口：均只有一个消费方且签名匹配；`memory-version:*` ref：进 AAD 绑定、payload 表 PK 去重、save 端分类一致性校验、governed deletion 引用扫描，四端都能接受。唯一的放宽项是必填键带来的旧客户端耦合（问题 2）。
