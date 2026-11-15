# PR 527 第 1 轮作者说明

问题：PR 520 给通用提议箱 `owner_proposals` 加了执行层，但这张表还没进数据导出和导入（`docs/architecture-v0.1.md` 提议箱一节：“清除/导出/导入这张表留给第二个 PR”）。主人导出再导入后，待采纳的提议、已执行动作的撤销原样会丢。

改动（只在 `packages/persistence-sqlite/src/data-export/` 和测试、文档）：
- `schemas.ts`：`OWNER_PROPOSAL_SCHEMA`、清单 `ownerProposals` 条数、`data/owner-proposals.jsonl`、结构文件、`ownerProposalBasisKey` / `ownerProposalExecutionKey`（密封原文的键）。
- `snapshot.ts` / `export.ts`：读全表；summary、effect、sourceRef、sourceVersion 走和别处一样的机密检查；依据（evidence_ref）和执行原样（execution_ref）是加密载荷，用 `exportedText` 导出，含机密的只在密封文件放原文。
- `verify.ts`：解析、逐行校验、编号唯一、`ownerProposalProblem`（时间格式、待采纳不能有处理时间和执行记录等）、条数和清单一致。
- `import.ts`：`owner_proposals` 加入“目标必须为空”的表；没有原文（含机密且没口令）的整条跳过并计入 `ownerProposalsWithoutOriginal`；来源对话置空；租约置空；`running`、`executed_unverified` 导入成 `unknown`；依据和执行原样重新加密写入。
- `demo-pack.ts`：补空文件和 0 条。
- 测试 `test/integration/data-export-owner-proposals.test.ts`；文档 `docs/architecture-v0.1.md`。

约束：不改表结构、不调模型、不顾旧数据兼容（导出格式版本不变，仍是 v3）；不写代码注释。

作者的说法（请核对，不要照信）：
1. 导出再导入后，除来源对话、租约和进行中的执行状态外，每个字段都一样。
2. 含机密的依据或执行原样不会进明文文件。
3. 目标库已有提议时导入失败，什么都不写。
4. 导入的提议不会在新库里被当成还在执行或被再执行一遍。

请重点核对：
1. 导出行里每个字段和 `owner_proposals` 的列一一对应，没有漏列（尤其 `thread_id`、`lease_id`、`lease_expires_at` 不导出是否合理）。
2. 导入时 `protect` 重新加密的分类、内容类型是否沿用原载荷；一个提议的依据和执行原样一个能还原、另一个不能时的处理。
3. `verify.ts` 的校验是否会放过会让 `INSERT` 违反表里 CHECK 的数据（长度、时间格式、指纹长度、版本号），导致导入到一半失败而不是在校验时就拒绝。
4. 干跑（dryRun）时计数和真正导入时是否一致。
