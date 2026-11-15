# PR 530 第 1 轮作者说明

问题：PR 527（提议箱进数据导出，格式升 v4）复核留下两条低问题。一，提议的依据或执行原样对应的加密载荷已不可读时，导出静默写成 null。二，格式升 v3→v4 没有对应的 ADR。

改动：
- `packages/persistence-sqlite/src/data-export/export.ts`：`ownerProposalText` 包住 `exportedText`，依据或执行原样的引用非空但读出为 null 时计数；计数大于 0 时清单 `omitted` 多一条“提给主人的提议里读不出来的依据或执行原样”。
- `test/integration/data-export-owner-proposals.test.ts`：新增用例；`scripts/check-data-export.mjs` 的 `REQUIRED` 从 139 提到 140。
- 新 ADR `docs/adr/0272-owner-proposals-join-the-data-export-format-v4.md`，ADR 0246 的 `amended_by` 补它；`docs/architecture-v0.1.md` 补一句。

约束：不改表、不调模型、不改导出格式本身（v4 在 PR 527 已升）；不写代码注释。

作者的说法（请核对，不要照信）：
1. 只有载荷“不可读”（存储层标记正在删除、已删除、不存在）时才计数；载荷存在但解密失败时整份导出照旧失败。
2. 没有依据、没有执行原样的提议（引用为空）不计数。
3. `omitted` 的条数是“读不出的文字项数”，一条提议两项都读不出算 2。

请重点核对：计数点是否覆盖了依据和执行原样两处；有没有别的路径让这两项静默变 null。
