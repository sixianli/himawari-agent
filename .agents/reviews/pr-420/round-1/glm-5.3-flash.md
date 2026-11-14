# 复核报告（fed6ae9，基准 44a0e33）

## 发现的问题（按严重度从高到低）

**1.（中低）packages/persistence-sqlite/src/data-export/schemas.ts:48 + packages/persistence-sqlite/src/data-export/schemas.ts:473（receivedAt）——导入校验没有覆盖表上的时间格式 CHECK，存在「能通过校验却在 INSERT 时失败」的输入（作者问题 3 的答案：有）**
证据（读代码证实）：
- `schemas.ts:48`：`const timestamp: JsonSchema = { type: "string", minLength: 20, maxLength: 40 };` —— 只限长度，不限形状。
- `0093_external_memory_proposals.sql:19-20`：`received_at GLOB '????-??-??T??:??:??.???Z'`、`decided_at` 同。
- 因此 `receivedAt: "2026-11-12T00:00:00Z"`（20 字符）能通过 `EXTERNAL_PROPOSAL_SCHEMA` 与 `externalProposalProblem`，却在 `import.ts:689` 的 INSERT 上触发 CHECK，抛出的是原生 SqliteError 而非带文档错误码的 `DataExportError`。事务（import.ts:373-716）会整体回滚，所以不写脏数据，但违背了「先校验、任何一项不符整份拒绝」的错误口径。
- 反向用例（`data-export-external-proposals.test.ts` 的 8 条 tamper 用例）没有覆盖时间格式。
- 其余 CHECK 我逐条核对过：枚举、长度、五条状态搭配 CHECK（0093:24-28）都有对应校验（`externalProposalProblem`、verify.ts:425-441 的三个 `unique`、manifest 计数循环 verify.ts:490-495）；`memoryId` 指向被跳过记忆时 `keptMemoryLink`（import.ts:250-251）置空、`supersededBy` 指向被跳过提议时 import.ts:706-708 置空，都不会 FK 失败。
建议：给 `timestamp` 加 pattern（或给提议 schema 用更严的时间 schema），并补一条时间格式的反向用例。

**2.（中低）packages/persistence-sqlite/src/data-export/export.ts:133-156 —— 短文字占位编号的扫描范围没算上新提议字段，重导出可能撞号，撞在 keys 上会让导出文件「导得出、导不回」（作者问题 2 的答案：替换本身是单射的，不会在同一个导出内撞；跨代重导出会）**
证据（读代码证实）：
- `export.ts:134-145`：`existingPlaceholderMax` 只扫描 `snapshot.entities, aliases, provenance, people, decisions, signals`，不含 `externalProposals`/`externalProposalKeys`。
- `export.ts:147-156`：`safeString` 对同一原文给同一编号，编号接着扫描出的最大值 +1 往后排。
- 推演：导出 v3 → 导入后，提议的 `client`/`sourceKey` 里存的是字面量 `[已扣留:9]`（import.ts:693-695 原样写入；`hasSecret("[已扣留:9]")` 为假，重导出不再遮盖）。之后该库新增一个需遮盖的短文字，编号会从六数组最大值继续排，可能落到 9——两个不同原文共用同一个占位。若两边都出现在 `keys`（client+sourceKey 组合相同），verify.ts:428-432 的 `unique("其他 agent 的固定编号")` 会拒、或 `0093:58` 的 PK 在 INSERT 失败。这也违背 manifest 自述「同一原文同一编号，不同原文不同编号」（export.ts:577）。
- 附带说明：同一客户端两个不同编号不会变成同一占位——`safeString` 按原文字符串编号，不同 sourceKey 必得不同编号；verify 的 digest 唯一性检查也和部分唯一索引 `0093:31-33`（排除 superseded）一致。
建议：把 `externalProposals`、`externalProposalKeys` 一并纳入 `existingPlaceholderMax` 的扫描。

**3.（低）apps/control-center/src/components/external-proposals.tsx:23-29 —— 「另有几条没处理成」在条目后来被替换时会算错（作者问题 1 的结论：算法与代码一致，但有一个边角）**
证据（读代码证实）：
- 算法 `left: Math.max(0, sent.count - batch.committed - batch.rejected)` 与作者说法一致。
- `sqlite-external-memory-proposal-operations.ts:390-394`：`SUM(status = 'committed')` 按当前状态求和；若该批某条保存后又被新提交替换（status→'superseded'，batch_id 保留），保存数会减 1，页面把这条显示成「没处理成」，实际它处理过又被替换了。重放（同一幂等键）算作已处理（production-mcp-memory-writer.ts:508-510）、部分失败、概况未刷新时批次找不到则整行不显示（不显示错数）、撤销后批次整体 detach 从 listBatches 消失（:443-457）——这几条我都推演过，显示正确。
建议：可接受；如要精确，`listBatches` 可把 superseded 单独计数或固定当 decided。

**4.（低）apps/control-center/src/components/external-proposals.tsx:206-216 + packages/persistence-sqlite/src/sqlite-external-memory-proposal-operations.ts:454-457 —— 对含「拒绝满 30 天、正文已删」条目的批次，撤销按钮静默不恢复这些条目**
证据（读代码证实）：`undoBatch` 把所有 rejected 成员列入 reopen（production-mcp-memory-writer.ts:487），但 `reopenBatch` 只恢复 `contentRef !== null` 的成员，其余仅 `detach`（batch_id 置空），状态仍是 rejected。批次从列表消失，用户看到「撤销」成功，但那几条永远回不到待确认。后端行为是 PR A 的，本 PR 给每一批都加了按钮。文案未承诺逐条恢复，风险低。
建议：对这种批次可禁用撤销或在文案注明；至少补一条测试记录这个语义。

**5.（低，一致性）三处重复定义 2000 上限**：`apps/control-center/src/components/external-proposals.tsx:9`（2000）、`apps/agent-service/src/production-mcp-memory-writer.ts:34`（2000）、`packages/gateway-contracts/src/contracts-v2.ts:1536`（boundedString(2000)）。目前一致；改其一不会在另两处报错（web 只会被后端拒）。建议注明来源或收敛到 contracts。

## 侧重检查（走的流程和结论）
普通流程：MCP agent `submit`（production-mcp-memory-writer.ts:162-242，本 PR 未改）→ 概况 `#externalProposals`（production-memory-control.ts:406-429，未改，字段与 contracts-v2.ts:1406-1426 一致）→ 网页记忆页渲染（新，浏览器测试覆盖列表/自称来源/敏感标签/全选/保存/单条编辑/部分失败/130 条分页/提醒页提示/空态/撤销清结果行）→ 后端 `respond`/`undoBatch`（未改）→ 数据导出导入往返（新集成测试，含 8 条反向用例、空库断言、无口令跳过、字节级往返）。
**没有测试覆盖的路径**：① respond/undo 的网络失败与 404（夹具总是成功）；② 全部失败的报错路径（`run` 的 catch）；③ 上述发现 3、4 的边角；④ 发现 2 的场景——导入后**新增数据**再重导出（现有字节级往返测试是同一数据重导出，撞不出来）；⑤ 网页测试只跑 zh-CN（en/ja 靠文案键齐全性检查与 check:layout 的多语言场景覆盖，未核实其存在）。`REQUIRED 96`（check-data-export.mjs:17）能否实际达到、以及全部测试是否真的通过：未核实（不能运行命令）。

## 必答问题逐条回答
1. **不改变。** 依据代码（读代码证实）：diff 全部落在 control-center 网页、data-export 包、测试、文档、CI 名单，没有触碰任何系统提示、工具定义或发给模型的消息构造；data-export 文件走 CLI/HTTP 导出（production-data-export.ts），不进模型请求。注：引用的规则文件 `.claude/rules/prompt-prefix.md` 在仓库里不存在（glob 无结果），规则本身未核实，但代码面结论独立成立。
2. **同一导出内稳定，跨代有一个撞号缺陷。** 遮盖 `mask`/占位在同一导出内按值单射（export.ts:147-156），快照三张表都 `ORDER BY`（snapshot.ts diff），jsonl 顺序确定；短文字占位编号依赖全库上下文是 ADR 0200 的既定行为。问题见发现 2（重导出撞号）。`exportedAt` 带时间但导出文件不发给模型。
3. **已覆盖大部分，时间格式 CHECK 未覆盖**，见发现 1；其余 CHECK/唯一索引逐条核对有对应校验，反向用例 8 条且断言「什么都没写」（测试文件 :355-392）。
4. **核对通过。** `FORMAT_VERSION v3`（schemas.ts:3）经 manifest const（:420、:426）+ verify.ts:253 使 v1/v2 整份拒绝，与 ADR 0233 先例一致；残留 "v2" 只在文档和故意的反向测试（data-export.test.ts:430）；chat-export 是另一格式（chat-schemas.ts:3），admin-cli 用 `CHAT_FORMAT_VERSION`（data-command.ts:9）不受影响。新值两端核对：`memory.external.respond/undo` 契约（contracts-v2.ts:1532-1559）↔ 前端载荷（memory.ts:252-262，reject 时 editedText=null 符合 ：1549 校验）↔ 后端（production-memory-control.ts:1061-1081）；`resultRef=batchId` 两端一致；`externalProposals` 计数键在 manifest schema 必填列表、verify 计数循环、demo-pack、import 报告四处一致；`operations-pending.json` 移出两项与网页新增调用方（memory.ts:250-262）及夹具安装（control-center-browser-server.mjs:2191-2194）相符。
5. **核对通过。** 消失条目：`picked` 按 `shown` 过滤（external-proposals.tsx:80-81），不会把已消失条目送出；忙碌时所有复选框/按钮/编辑入口都 `disabled={memory.busy...}`；撤销成功 `setSent(null)`（:216-219），且批次从 listBatches 消失后结果行自然不显示（均被浏览器测试断言）。
