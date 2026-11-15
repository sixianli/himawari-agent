## 复核结论

未发现阻断性问题。改动本身（计数、清单项、测试、ADR）方向正确；主要问题集中在测试覆盖和文档/导入端的语义衔接。

### 1. 低 | 反向用例标题写“依据或执行原样”，实际只覆盖依据，未覆盖执行原样和“两项都读不出=2”

- 文件: `test/integration/data-export-owner-proposals.test.ts:294-307`；`packages/persistence-sqlite/src/data-export/export.ts:713-714`
- 问题: 代码确实把 `basis` 和 `execution` 都包进了 `ownerProposalText`，但新增用例只把 `payload-owner-proposal-basis-%` 改成 `deleted_verified`，没有任何 execution 载荷被标成不可读；作者说法 3 的“一条提议两项都读不出算 2”也没有用例。
- 证据: 用例 SQL 是 `WHERE ref LIKE 'payload-owner-proposal-basis-%' AND ref = (SELECT MIN(ref) ...)`，随后只断言 `expect(entry?.count).toBe(1)`。若以后有人只把 `execution` 那一行改回 `executionRef === null ? null : exportedText(...)`，这条用例仍会通过。
- 建议: 增加三种情况：只丢 execution、只丢 basis、同一提议两项都丢（断言 2）；同时断言导出的 JSONL 里对应字段确为 `null`，而不只是清单有条目。

### 2. 低 | `omitted` 原因只写“不能撤销”，漏了依据丢失会让动作提议无法采纳/执行；导入端把 `null` 当成“没有依据”

- 文件: `packages/persistence-sqlite/src/data-export/export.ts:854-860`；`apps/agent-service/src/production-proposals.ts:616-617,823-827`；`packages/persistence-sqlite/src/data-export/import.ts:362-389`；`packages/persistence-sqlite/src/data-export/verify.ts:148-168`
- 问题: basis 读不出时导出写 `null`，导入后 `owner_proposals.evidence_ref` 也是 `NULL`，导入报告不增加 `ownerProposalsWithoutOriginal`。之后采纳/执行读不到 basis，会直接报 `PROPOSAL_NOT_FOUND`。当前清单原因只说明“撤销用的原样丢了不能撤销”，没有说明依据丢失同样会让待采纳的动作提议变得不可操作。
- 证据:
  - `exportedText` 返回 `null` 后，导入侧 `proposal.basis === null ? null : original(...)`，不会进入 `ownerProposalsWithout` 分支（`import.ts:362-375`），随后 `INSERT ... evidence_ref` 写入 `plan.basisRef`（`import.ts:866-889`）。
  - `production-proposals.ts:616-617`：`const basis = await this.#readBasis(row.evidenceRef); if (!basis) throw new ProposalError("PROPOSAL_NOT_FOUND");`；`823-827` 的 adopt 路径同样如此。
  - `verify.ts:148-168` 的 `ownerProposalProblem` 没有要求 action 类提议必须有 basis，所以这种状态能通过导入校验。
- 建议: 在 `omitted` 的原因里同时写明“依据丢了会导致提议不能采纳/执行；执行原样丢了不能撤销”；如果希望导入端也可见，可在导入报告里区分“读不出的依据/执行原样”条数，而不是只在导出清单里出现。

### 3. 低 | “格式因此升到 v4”把 v4 归因于本次“读不出写空”的改动；本 PR 实际没改 `FORMAT_VERSION`，基线已是 v4

- 文件: `docs/architecture-v0.1.md:433`；`docs/adr/0272-owner-proposals-join-the-data-export-format-v4.md:36`；`packages/persistence-sqlite/src/data-export/schemas.ts:5`
- 问题: 本 PR 的代码改动只有 export 计数和文档，没有改格式常量。`git diff a87954e..dab825d -- packages/persistence-sqlite/src/data-export/schemas.ts` 为空，说明 v4 在 PR 527 基线提交里已经是现状；架构句写在“读不出写空”之后，容易被理解成是这次处理触发了 v4。
- 证据: `schemas.ts:5`：`export const FORMAT_VERSION = "himawari.data-export.v4" as const;`；本次 diff 没有 schemas/migration 改动。
- 建议: 改成类似“提议箱进入导出时已在 PR 527 把格式升到 v4；ADR 0272 补记该决定，本次只补读不出原文的可见性”，避免把两件事混在一起。

## 侧重检查

- 错误路径（读代码证实）: 非受限引用解密失败会抛错，整份导出失败（`export.ts:121` 的 `texts.set(ref, await read())` 没有 catch）；只有存储层标记为不可用（`deletion_pending`、`deleted_verified`、行不存在、非 `sqlite_blob`、`ciphertext` 为 null）才会走 `exportedText` 返回 `null` 并被计数（`snapshot.ts:353-361`）。作者说法 1 对“解密失败整份失败”基本成立。
- 其他路径让两项变 null（读代码证实）: 导出里 `basis`/`execution` 只有 `ownerProposalText` 一个产生点，没有第二处会写这两个字段；计数点覆盖两处调用。
- 其他路径（推测/未核实）:
  - 若生产使用了 `HybridPayloadStore` 的文件存储（`ciphertext-file-store.ts:236-243` 的 `storage.kind = "ciphertext_file"`），而导出快照只认 `sqlite_blob`，这类载荷会被当作“不可读”写 null 并计数，尽管存储层其实可能读得出来。本 checkout 里没找到生产接线，未核实是否会落到 owner proposal 的 basis/execution。
  - 若同一 payload ref 同时是受限记忆的 `content_ref`/`quote_ref` 和某条 owner proposal 的 `evidence_ref`，受限路径的 `read().catch(() => null)`（`export.ts:123-124`）会吞掉解密失败并计入，而不是整份失败。正常写入的 ref 形态不同，未找到可达路径，标为推测。
- 不合规范或不可信输入（读代码证实）: 新增清单项经过 `MANIFEST_SCHEMA` 的 `what: text(1,512)`、`count: nullable(integer(0))`、`reason: text(1,512)`，长度和类型都满足；`admin-cli` 原样透传 `manifest.omitted`，`production-data-export.ts:339` 只按 `SHORT_TEXT_OMISSION_LABEL` 查找，不会因新标签出错。
- 安全（读代码证实）: 读不出时只写 `null` 和计数，不写明文；含机密载荷仍走原有遮盖/封存路径，没有新增泄漏面。
- 资源耗尽（读代码证实）: 计数在既有的 payload 遍历和 owner proposal 映射内完成，没有新增循环或按用户输入放大的结构。
- 不可撤销/写操作（读代码证实）: 改动只在导出读取路径和测试/文档，没有新增写库、删除或模型调用。
- 规则/文档一致性（读代码证实）: ADR 文件名、标题编号、`amends`/`amended_by` 目标路径互相存在；架构文档链接目标存在。未运行 `check-adr-numbers`、`check-docs-links`、`check-data-export`，属于未核实。
- 未核实: `.agents/reviews/pr-530/briefs/brief-round1.md` 在当前稀疏检出中读不到；未运行测试，作者“140 条通过”只能按 diff 推断。

## 必答问题

1. **不会改变模型已经见过的请求开头。** 改动只在 `packages/persistence-sqlite/src/data-export/export.ts`、数据导出测试和文档里；`buildPortableExport` 的使用方是管理 CLI、服务的导出作业和测试，没有进入提示词组装、历史消息或遮盖流程。因此本次改动不影响“发给模型的内容只追加”，也没有把每轮会变的值放进系统提示或工具定义。导出清单里的 `exportedAt` 等会变的值本来就在导出文件里，不进入模型请求。

2. **不会让同一段文字在不同请求里变成不同字节。** 新增的 `omitted` 条目文本是固定的，`count` 只由当前库状态决定；没有新增时间字段、HashMap 遍历或依赖后续内容的遮盖。同一个库快照重复导出，清单项和顺序是确定的。

3. **有自动检查，反向用例会失败，但覆盖不全。** 去掉本次实现后，清单里不会有“读不出来”这一项，`entry?.count` 为 `undefined`，`toBe(1)` 会失败；`REQUIRED` 从 139 提到 140，且该文件已在 `FILES` 列表里，新增用例标题含 `[P1-6]`，按 diff 应被计入。问题是用例只覆盖 basis，不覆盖 execution 和“两项都读不出=2”；另外我未运行测试，运行时是否 140 条全部通过未核实。

4. **逐个核对产生处和使用处：没有发现清单项/序列化格式被另一端拒绝，但发现语义衔接问题。**
   - 新增 `omitted` 的 `what`/`count`/`reason`: 由 `export.ts:854-860` 产生，经 `MANIFEST_SCHEMA` 校验（`schemas.ts:696-703`），再由 `admin-cli` 透传、`production-data-export.ts:339` 按固定标签查找。新标签不在任何固定白名单里，使用端都能接受。
   - `basis`/`execution` 的 `null`: 导出端 `ownerProposalText` 产生（`export.ts:680-686,713-714`），结构校验用 `OWNER_PROPOSAL_SCHEMA` 的 `nullableText`（`schemas.ts:274-275`），导入端 `import.ts:362-389` 接受 null 并写入 `evidence_ref = NULL`。两端在类型/校验上都接受，但导入端把 null 理解为“没有依据”，没有保留“原本有依据但读不出”的含义；这正是第 2 条意见。
   - ADR/文档值: ADR 0272 文件名编号、标题编号、`amends` 目标、ADR 0246 的 `amended_by` 目标、架构文档链接目标都存在；`REQUIRED` 的 +1 与新增带标签测试对应。
   - 结论: 清单项和 schema 两端没有拒绝问题；需要补的是 basis 丢失后的行为说明、导入语义以及测试覆盖面。
