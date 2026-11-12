## 读代码证实的问题

### 1. 高 — 受限记忆的正文仍可能通过一条“同文的被替换提议”明文导出

- 位置：`packages/persistence-sqlite/src/data-export/snapshot.ts:72-86`、`packages/persistence-sqlite/src/data-export/export.ts:474-511`、`packages/persistence-sqlite/src/migrations/0093_external_memory_proposals.sql:31-33`
- 问题：这一轮的排除条件只看 `memory_id` 是否指向受限记忆。只要另一条提议不是通过 `memory_id` 指向受限记忆，即使它的正文与受限记忆完全相同，仍会原样导出。`superseded` 状态的行恰好允许与非 `superseded` 行共享同一 `text_sha256`。
- 证据：
  - `snapshot.ts:72-84`：
    ```sql
    const linkedToRestricted = `memory_id IN (SELECT id FROM memory_records
      WHERE owner_id = @ownerId AND agent_id = @agentId AND classification = 'restricted')`;
    ...
    AND (memory_id IS NULL OR NOT ${linkedToRestricted})
    ```
  - `export.ts:481-490`：
    ```ts
    const digest = str(row["text_sha256"]);
    ...
    textSha256: withheld ? null : digest,
    ```
    正文通过 `requiredText(contentRef, ...)` 导出，只有命中出口机密规则才会被扣留；受限分级本身不会触发扣留。
  - `0093_external_memory_proposals.sql:31-33`：
    ```sql
    CREATE UNIQUE INDEX external_memory_proposals_text_index
      ON external_memory_proposals(owner_id, agent_id, text_sha256)
      WHERE status <> 'superseded';
    ```
    因此 `superseded` 行可以与一条已保存到受限记忆的提议拥有相同摘要/正文。
  - `sqlite-external-memory-proposal-operations.ts:205-213` 把提议改成 `superseded` 时只改 `status/decided_at/superseded_by`，不清 `content_ref`；`sqlite-external-memory-proposal-operations.ts:477-486` 要到 30 天后才清 `superseded` 的正文。
- 构造方式（读代码可推出）：受限记忆 M 的正文为 T；存在一条已提交到 M 的提议（`memory_id` 指向 M），同时存在一条正文同为 T 的 `superseded` 提议。导出时前者被排除，后者因为 `memory_id IS NULL` 被保留并明文导出 T。
- 建议：排除时不要只按 `memory_id`，还要按正文摘要排除。至少把“被排除的受限提议的 `text_sha256` 集合”算出来，凡是 `text_sha256` 命中该集合的提议（包括 `superseded`）也排除或扣留；如果担心受限记忆正文不是来自提议，还要按同一规范化规则计算受限记忆正文摘要再匹配。补一条反向用例：一条受限记忆 + 一条同文的 `superseded` 提议，断言导出文件和封存文件都不含正文及摘要。

### 2. 低 — 反向测试没有检查封存文件

- 位置：`test/integration/data-export-external-proposals.test.ts:323-327`
- 问题：新加的“受限提议整条不导出”测试只扫描非封存文件，跳过 `SEALED_FILE`。如果将来只在封存文件的 `originals` 里写入受限正文或摘要，这条反向用例仍会通过。
- 证据：
  ```ts
  for (const [path, bytes] of files)
    if (path !== SEALED_FILE) {
      expect(decoder.decode(bytes)).not.toContain("受限的记忆正文");
      expect(decoder.decode(bytes)).not.toContain("proposal-restricted-link");
    }
  ```
  而 `exportOf` 默认带口令（`test/integration/data-export-external-proposals.test.ts:143-152`），封存文件确实存在。
- 建议：在带口令导出时同时断言封存文件解密后的 `originals` 不含被排除提议的正文和摘要；或至少断言封存文件中不存在 `externalProposal/<受限提议编号>/content` 和 `/textSha256` 键。

### 3. 低 — 受限记忆被永久删除后，关联提议的正文摘要仍会明文导出

- 位置：`packages/persistence-sqlite/src/sqlite-governed-deletion.ts:899-906`、`packages/persistence-sqlite/src/data-export/export.ts:481-490`
- 问题：受限记忆永久删除时，关联提议被改成 `rejected`，`memory_id`、`content_ref`、`batch_id` 被清空，但 `text_sha256` 保留。此后导出时 `memory_id` 已为空，新的排除条件不再命中；正文为空，摘要按“没有正文的行摘要照常写在明文层”的规则被明文导出。如果受限正文很短，摘要可被逐个试出（ADR 0246 决定 6 对短机密正文摘要的担心同样适用）。
- 证据：
  ```sql
  UPDATE external_memory_proposals SET status = 'rejected', memory_id = NULL,
    content_ref = NULL, batch_id = NULL
  WHERE id = ?
  ```
  没有清 `text_sha256`；`export.ts:490` 在 `content === null` 时仍然写 `textSha256: digest`。
- 建议：确认是否可以接受“删除后仍导出受限文本摘要”。若不接受，需要在删除受限记忆时同时处理关联提议的摘要（或用墓碑保留“这条提议曾被排除”的事实），并补测试。

## 推测 / 未核实

- 我没有运行测试，因此 `npm run check:data-export` 实际通过条数是否为 103 未核实；按文件内容数到 `data-export-external-proposals.test.ts` 共 19 条用例，与作者说法一致。
- 上述第 1 条在真实生产中的出现概率取决于是否同时存在“受限记忆正文”和“同文的 `superseded` 提议”。代码路径成立，但生产数据分布未核实。
- 受限提议的固定编号/不带编号客户端仍被 `snapshot.ts` 读入并参与 `existingPlaceholderMax` 扫描，但不会序列化到导出文件；这只会让新占位编号跳号，未发现泄漏或主键冲突。

## 侧重检查

- **错误路径 / 不可信输入**：检查了篡改后的提议行。`committed` + `memoryId: null` + `batchId` 非空能通过 `verify.ts`，导入时 `import.ts:714-720` 会清掉 `batchId`，不会触发 INSERT 约束；未发现新的“校验通过但 INSERT 失败”路径。
- **安全 / 明文泄漏**：发现第 1 条同文 `superseded` 绕过，以及第 3 条删除后摘要残留。直接通过 `memory_id` 排除的提议本身，其正文、摘要、固定编号、不带编号客户端和 `supersededBy` 都没有进入导出文件。
- **资源耗尽**：新增的 `linkedToRestricted` 子查询按 `owner_id/agent_id` 走 `memory_records` 索引前缀，再筛 `classification`，没有按提议逐行无界展开；未发现新的明显资源耗尽点。未做性能测量。
- **不可撤销操作**：导入仍只允许空目标库；受限提议不导入属于预期的数据最小化，没有新增可撤销/不可撤销的数据破坏路径。
- **规则 / 文档 vs 代码**：ADR 0246 决定 7、8、10 与本轮代码基本一致；`scripts/check-data-export.mjs:17` 的 `REQUIRED = 103` 与 ADR 一致。测试文件名带 `[P1-6]`，会被 `check-data-export.mjs` 的 `-t "\\[P1-6\\]"` 选中。第 2 条是文档要求与测试覆盖之间的缺口。

## 必答问题

1. **会不会改变模型已经见过的请求开头？**
   不会。本轮增量只改了数据导出/导入、ADR 和测试；没有改动系统提示、工具定义、历史消息、遮盖或任何组装模型请求的代码。待确认提议也不进入模型请求（ADR 0246:89）。因此不存在“请求开头变化”的问题，现有“只在末尾追加、每轮变化的值放最后一条消息”的规则不受影响。依据：[prompt-prefix.md:10](.claude/rules/prompt-prefix.md)、[prompt-prefix.md:27-29](.claude/rules/prompt-prefix.md)、[prompt-prefix.md:35](.claude/rules/prompt-prefix.md)。

2. **会不会让同一段文字在不同请求里变成不同的字节？**
   对模型请求没有影响。对数据导出而言，同一数据库快照下结果仍是确定的：SQL 有固定 `ORDER BY`，占位编号按快照内的最大编号顺序分配；唯一的时间字段是既有的 `manifest.exportedAt`。受限提议的排除取决于数据库当前的分级状态，因此同一段提议文字可能在不同时间的一次导出中存在、另一次导出中被排除，这是有意的数据最小化，不是遮盖不确定。未发现依赖后文遮盖或无序集合的新问题。

3. **有没有对应的自动检查，反向用例是否真的会失败？**
   有。`scripts/check-data-export.mjs` 包含该测试文件，`REQUIRED = 103`，ADR 也同步到 103。按代码推断：
   - 去掉 `snapshot.ts` 的受限过滤后，`test/integration/data-export-external-proposals.test.ts:323-327` 会在明文文件里读到“受限的记忆正文”，测试失败。
   - 退回旧 `batchId` 条件后，`test/...:346-352` 会读到 `batch_id = "batch-1"`，测试失败。
   - 但第 1 条的同文 `superseded` 泄漏和第 2 条的封存文件泄漏目前没有用例覆盖，相关反向用例不会失败。测试实际运行结果未核实。

4. **改动产生或修改的每个值，两端都能接受吗？**
   - `restrictedProposals: number`：只在 `snapshot.ts:74` 产生、`export.ts:579` 使用，落到 `manifest.omitted[].count`；schema 是 `nullable(integer(0))`，接受。
   - 新增的 `omitted` 文案：`export.ts:578-581` 产生，schema 为 1–512 字符文本；测试按子串查找，管理端直接打印，接受。
   - `batchId`：导出端 `export.ts:497-500` 对 `committed && memoryId === null` 置空；`verify.ts:127-132` 允许 `committed` 的 `batchId` 为空；数据库约束允许 `batch_id IS NULL`；导入端 `import.ts:714-720` 同样置空。网页“最近几批”按行内 `batch_id` 聚合，导入后自洽。
   - `memoryId`：导出端 `keepMemoryRef` 保证只保留导出记忆；`verify.ts:448-449` 检查 `memoryId` 在导出记忆里；数据库约束只允许 `committed` 指向记忆；导入端再按实际导入的记忆过滤。接受。
   - 未发现类似 I-73 的“一端产生、另一端校验拒绝”的新值。需要额外注意的是第 1 条：摘要/正文的排除集合与 `memory_id` 排除集合不一致，这是本轮的主要遗留风险。
