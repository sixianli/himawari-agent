# 复核报告：PR 430（受限记忆删除连带删提议 / 导出比较算原话 / 过期条目移出批次）

## 结论概览

改动与作者说法基本一致，我逐条对照了代码，没有发现会破坏数据或泄漏受限内容的问题。以下按严重度列出发现，均为低severity及以下；没有「读代码证实」的高危问题。

## 发现的问题（按严重度从高到低）

**1. 低 ｜ docs/adr/0253-external-proposals-follow-restricted-deletion-and-expiry.md:43、47 ｜ ADR 前提引用的行号与实际代码不符**
- 证据（读代码证实）：前提 1 说旧代码的 `UPDATE external_memory_proposals SET status = 'rejected'...` 在 `sqlite-governed-deletion.ts:900-902`；用 `git show 0d989adb:...sqlite-governed-deletion.ts` 和 diff hunk `@@ -889,17 +895,28 @@` 推算，被删的三行实际在旧文件 891–893 行。前提 5 说 `detach.run` 在「同文件 455 行」，现行文件 `sqlite-external-memory-proposal-operations.ts:457` 才是这一行（operations.ts 本次只改了 492 行一处，旧行号相同）。
- 建议：修正行号，或改成引用符号（函数名 `#deleteCore` 的 memory 分支）避免漂移。

**2. 低 ｜ packages/persistence-sqlite/src/data-export/export.ts:638-643 ｜ manifest 的 omitted 条目文字没有反映「原话」也参与比较**
- 证据（读代码证实）：`what: "保存进受限（restricted）记忆的其他 agent 提议，以及正文和它相同的提议"`、reason `"正文和受限记忆的文字相同，或已保存进受限记忆；..."`。本次改动后排除范围还包括和受限记忆历史版本**原话**（`quote_ref`，snapshot.ts:83-87）同文的提议，但这条标签和理由都没提「原话」。测试（data-export-external-proposals.test.ts:364-366、400-403）只匹配 `what.includes("受限（restricted）记忆的其他 agent 提议")`，不校验措辞完整性，所以不会失败。
- 建议：把「或与历史版本原话相同」写进 `what`/`reason`，让导入方能理解为什么一条和记忆正文不同、只和原话相同的提议被略去。

**3. 低 ｜ packages/persistence-sqlite/src/sqlite-external-memory-proposal-operations.ts:492 ｜ 旧行为留下的「正文已清但 batch_id 保留」的行没有任何清理路径**
- 证据（读代码证实）：全仓库只有两处把 `content_ref` 置 NULL（governed-deletion.ts:917-919、operations.ts:492），后者现在同时清 batch_id。在本次修复**之前**运行过 `dropDiscardedText` 的数据库里，会存在 `content_ref IS NULL AND batch_id IS NOT NULL` 的 rejected 行；修复后的 `dropDiscardedText` 的 WHERE 条件（operations.ts:484-485，`content_ref IS NOT NULL`）不会再选中它们，也没有迁移清理。这些行会让 `listBatches`（operations.ts:384-398，`WHERE batch_id IS NOT NULL`）继续列出一个其实恢复不了的批次——正是本次要修的现象，只是永远留着。
- 作者说「P5-3 尚未上线，生产库没有旧行」——这一点**未核实**（代码库里看不出 P5-3 的上线状态）。即使有旧行，后果也只是网页显示一条撤不动的批次，无数据损坏。
- 建议：在 ADR 里写明这个判断的依据；或加一条开机时的一次性清理（`content_ref IS NULL AND batch_id IS NOT NULL AND status='rejected'` → 置空 batch_id），成本很低。

**4. 信息 ｜ 测试覆盖的小缺口（读代码证实缺口存在，非缺陷）**
- `superseded_by` 的 `ON DELETE SET NULL`（migrations/0093_external_memory_proposals.sql:23）是删除受限记忆时依赖的级联之一，但新的删除测试（sqlite-governed-deletion.test.ts:593-677）没有插入 `superseded_by` 指向被删提议的行，也没断言 keys 表级联（只断言了 unkeyed）。导出端第二条反向测试（data-export-external-proposals.test.ts:425-449）验证了 `supersededBy` 置 null 和 keys/unkeyed 不导出，间接覆盖了语义。
- 混合批次（一批里 committed 条目还能恢复、rejected 条目已过期被移出）下 `listBatches` 的 `rejected` 计数减少、网页「不要 Y 条」变少，没有专门测试；mcp-write.test.ts:1567-1591 只测了整批全是 rejected 的情况。
- 建议：补一个插入 keys 行 + superseded_by 行的删除断言；混合批次用例可选。

**5. 信息（推测，未穷尽核查）｜ export.ts:161-183 ｜ 占位编号复用被排除提议的编号**
- 排除受限提议后，`existingPlaceholderMax` 扫描不再包含它们的 `source_key` 占位，新遮盖文本可能复用小号（第二条反向测试明确断言 `[已扣留:1]`，是故意的）。我核了导入端：import.ts:61、119-127 用 `originals` 按 JSON 指针键逐项还原，编号只在单个导出文件内有意义，未见跨导入冲突。判断无实际问题，但属于推测。

**6. 信息 ｜ 作者说法逐条核对结果**
- 说法 1（受限删除连带删同文提议、级联、payload 进清理列表；非受限仍 rejected 留摘要）：**证实**。sqlite-governed-deletion.ts:896-924（digest 子查询 + `DELETE FROM external_memory_proposals` + `payloadRefs.push`）；级联见 0093 迁移 57、65、23 行；非受限分支 917-919 保留 `text_sha256`。
- 说法 2（导出比较加 quote_ref）：**证实**。snapshot.ts:83-87 的 UNION；compound SELECT 输出列名取最左分支的 `content_ref`，`ORDER BY content_ref`（88 行）在 SQLite 下有效。
- 说法 3（判断挪到扫描前、扫描只看导出的提议及其 keys/unkeyed）：**证实**。export.ts:115-130 先过滤，161-183 扫描用 `exportedProposals` 和按 `exportedProposalIds` 过滤的 keys/unkeyed；531-571 行构建 proposal 行只针对 `exportedProposals`，`supersededBy` 也改成按 `exportedProposalIds` 判定（562 行）。
- 说法 4（dropDiscardedText 同清 batch_id）：**证实**。operations.ts:492。
- 说法 5（测试分布）：**证实**（diff 里正是 2+1+1）。
- 说法「去掉源码改动后 4 条测试失败」：**推断成立但未实际运行**（工具受限）。逐条推演：基线代码下导出 counts 会是 6 而非 5 且明文含「主人原话」；第二条会含 "Hidden"/"proposal-restricted" 且编号是 10 而非 1；删除测试的 `group_concat` 会多出两条 rejected 行；mcp-write 的 `listBatches` 非空、`undoBatch` 返回 `[]` 而非 `undefined`。
- 「P5-3 未上线、生产库无旧行」：**未核实**。
- PR 420 复核的原始五条意见本身无法查证，但五条改动一一对应且都已落实。

## 侧重检查

我走的最普通流程：**其他 agent 经 MCP 提议 → 主人拒绝（批次）→ 30 天后清正文 → 同文再提议被挡 → 撤销批次**。

- 入口 `production-mcp-memory-writer.ts` propose → `operations.submit`（operations.ts:133-302，校验 digest/上限、写 payload 和提议行）——有既有测试。
- `writer.respond` → `operations.decide`（operations.ts:337-371，rejected + batch_id）——有测试。
- 30 天：`listPending` 每次先跑 `#dropExpiredDiscardedText`（writer 429 行 → operations.ts:477-505，现在同时清 batch_id）——mcp-write.test.ts:1567-1591 覆盖，包括再提议仍 DECLINED（1587，靠 `text_sha256` seen 检查，operations.ts:149-155，rejected ≠ superseded）。
- 撤销：`undoBatch`（writer 451-488）对空批次返回 undefined → `production-memory-control.ts:1124-1125` 映射为 `MEMORY_EXTERNAL_BATCH_NOT_FOUND`——网关层的「未知批次」用例已有（mcp-write.test.ts:1435-1437），「批次存在但全部过期」的网关级用例没有，但走的是同一条已测的 undefined 分支。
- **这条链上本次改动经过的每一段都有测试覆盖。**
- 受限记忆删除链（`deleteImmediately` → `#deleteCore` memory 分支 → 级联 + payload 清理）：新测试覆盖主路径；`superseded_by`/keys 级联缺直接断言（见发现 4）。
- 导出链：两条反向测试覆盖原话比较和编号/keys/unkeyed；已存在的「解不开密文计数」（310-380）与新 UNION 兼容（坏的是 content_ref，quote payload 独立，计数不变）。

## 必答问题逐条回答

1. **不会改变模型已见过的请求开头。**（读代码证实）本次改动只在 `packages/persistence-sqlite` 的删除/导出/提议操作和测试里，没有触碰任何组装模型请求的代码（系统提示、工具定义、历史、遮盖都不涉及）。「发给模型的内容只追加」规则（.claude/rules/prompt-prefix.md:33-36）的前提——改动会进入请求——在这里不成立；ADR 0253 的后果一节「不改发给模型的内容」与代码一致。
2. **不会。**（读代码证实）导出是唯一新增的字节产出：所有新逻辑的输入来自固定 `ORDER BY` 的快照查询（snapshot.ts），`restrictedDigests` 的 Set 只做成员判断与插入顺序无关，`exportedProposals` 过滤保持原有排序，不引入时间或依赖前后文的遮盖（遮盖函数本身未改）。`dropDiscardedText` 清 batch_id 不产生请求字节。占位编号的确定性与改动前一致（同一导出内确定）。
3. **有对应的自动检查，且按推演反向用例在基线代码上确实会失败**（4 条，见发现 6 的逐条推演；未实际运行测试）。注意：文档一致性没有自动检查——ADR 0133 已把 docs 检查从 `npm run check` 移除（0241 的 amended_by 可证），所以发现 1、2 这类文档问题只有靠人查。
4. **逐值核对通过。**产生方/使用方：(a) `classification`（governed-deletion.ts:856-857）仅在该函数内使用；(b) DELETE/UPDATE 分支（914-920）的使用方 `submit` 的 seen 检查、`listPending`、导出快照、`reopenBatch`、`dropDiscardedText`——行为变化（同文可重新提议）已在 ADR 后果明示并测试；(c) `batch_id = NULL`（operations.ts:492）的使用方 `listBatches`（批次消失，即目的）、`listBatch`/`undoBatch`（undefined → NOT_FOUND，production-memory-control.ts:1124 已处理且有网关级测试的形状）；(d) `restrictedMemoryTexts` 加 quote_ref 的使用方只有 export.ts:92、116 和 snapshot 的 refs 收集（grep 证实无其他消费方），副作用是 `unreadableRestricted` 的计数范围扩大到原话 payload，与 omitted 条目语义相符；(e) ADR front matter 的 `amends`/`amended_by` 与仓库既有惯例一致（43 处 `amends:`、23 处 `amended_by:`）。
