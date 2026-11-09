## 结论

本轮提交 `8cee2914` 只改了两个文件（ADR 重命名 + 写入约定的一处链接），**改号完整、链接都指向存在的文件、没有误改别的 ADR 引用**。没有发现高、中严重度问题。作者的说法与代码/文件基本一致。

## 发现的问题（按严重度）

### 低：文档内的 ADR 交叉链接与“标题编号”没有自动检查

- 文件:行：`scripts/check-instruction-links.mjs:7-12`、`scripts/check-adr-numbers.mjs:8`、`.agents/instructions/document-governance.md:28`
- 问题：本次改号需要维护的是 `docs/adr/0195-...md` 内部的交叉链接和 `docs/execution/specs/2026-11-09-decision-record-write-convention.md:26` 的链接，但自动检查只覆盖指令文件（`AGENTS.md`、`.claude/rules`、`.agents/instructions`）里的链接，以及 `docs/adr` 的**文件名格式和编号唯一性**；`check:docs` 已删除。若某处文档内引用漏改，或 ADR 标题里的编号与文件名不一致，CI 都不会失败。
- 证据：
  - `scripts/check-instruction-links.mjs:7-12`：`INSTRUCTION_ROOTS` 只列 `AGENTS.md`、`CLAUDE.md`、`.claude/rules`、`.agents/instructions`。
  - `scripts/check-adr-numbers.mjs:8`：`const ADR_FILE = /^(\d{4})-[a-z0-9][a-z0-9-]*\.md$/;`，第 23-27 行只报重复编号，不校验标题号。
  - `.agents/instructions/document-governance.md:28`：“仓库没有对 `docs/` 做全面校验的自动检查：`npm run check:docs` 及其脚本已删除”。
- 建议：把 `docs/adr` 与相关 spec 的链接纳入一个检查（文件存在 + 锚点存在），并在 `check:adr-numbers` 里加“标题 `# ADR NNNN` 必须等于文件名编号”的校验；反向用例覆盖“标题号错”“链接仍指向旧文件名”。本轮实际没有漏改，这只是防回归建议。

### 低（顺带发现，非本轮引入）：`inputs` 的 JSON 解析没有兜底

- 文件:行：`packages/persistence-sqlite/src/sqlite-decision-ledger-operations.ts:325`、`:138`
- 问题：`readOne` 直接 `JSON.parse(row["inputs"])`，同文件的 `entryFromRow` 也一样。若某行 `inputs` 是损坏的 JSON，`decision.chain.read` 会抛出异常而不是降级为“无记录”。这是既有写法，不是本轮改号引入的。
- 证据：`const inputFields = Object.keys(JSON.parse(row["inputs"] as string) as object).sort();`（:325）；`const inputs = JSON.parse(row["inputs"] as string) as {`（:138）。
- 建议：与本次无关，可另开低优先级修复，解析失败时按“字段未记录”处理或记录一条可诊断错误。

## 作者说法核对（读代码/文件证实）

- main 把「记忆模型可见」改为 0193：属实。`docs/adr/0193-memory-is-visible-to-the-model.md:10` 标题为“ADR 0193…”。
- main 把「记忆整理依据链」改为 0194：属实。`docs/adr/0194-record-the-whole-basis-chain-of-a-memory-tidy-up.md:10` 标题为“ADR 0194…”。
- 本 PR 原 ADR 0193 与之撞号：属实。`git show 8cee2914` 显示 `rename from docs/adr/0193-show-the-whole-chain-of-one-decision-record.md`。
- 改为 0195（文件重命名、标题、两份 ADR 链接、写入约定链接）：属实。`0195` 第 10 行标题、第 26 行链接 `0194`、第 30 行链接 `0193`、第 68 行链接 `0194`；写入约定第 26 行链接 `0195`。
- “并合入 main，没有代码改动”：本轮提交本身只改 2 个文件；`5e4d624..8cee291` 的增量除 `.agents` 外只有 `.claude/rules/prompt-prefix.md` 和 `docs/*`，确实没有代码改动。增量里的 `docs/agent-rulebook-inventory.md` 生产配置内容等是 main 合入带来的，不是本提交编写。
- 改号完整性：在可读的稀疏检出范围内，`grep` 未发现任何残留的 `0193-show-the-whole-chain`，也没有 `0192-memory-is-visible` / `0191-record-the-whole-basis` 旧路径；`docs/adr/019*.md` 中 0192/0193/0194/0195 各一份，无重复。
- 链接有效性：`0112`、`0143`、`0158`、`0185`、`0192-delete`、`0195`、写入约定、两份 spec、runbook、`.claude/rules/prompt-prefix.md#consequences` 指向的文件均存在；`0193` 里确有 `<a id="consequences"></a>`（第 72 行）。
- 没有误改别的 ADR：`ADR 0191` 只改了指向 basis-chain ADR 的两处（`0143`、`0192-delete`），未动 `0191-draft-pull-requests-run-fast-checks-only.md`；`ADR 0192` 只改指向 memory-visible ADR 的几处，未动 `0192-delete-unimplemented…`。

## 未核实 / 推测

- 仓库是稀疏检出，只有约 81% 的跟踪文件在本地，`.agents/reviews/pr-328/round-1..4` 等历史复核记录不在工作树里，未能逐字核对这些历史文件里是否出现过“ADR 0193”字样；即使有，也属于历史记录，不应改写。
- 是否存在**其他未合并 PR** 也占用了 0195，无法离线核实；按文档治理规则，新建/改号前应同时看未合并 PR（`.agents/instructions/document-governance.md:28` 的 `adr-number-collision` 教训）。
- 提交说明称 `validate_docs.py . --strict` 无新增错误，该脚本不在仓库中，无法核实。

## 侧重检查

- 错误路径：`production-decision-chain.ts:91-92` 记录不存在时抛 `DECISION_RECORD_NOT_FOUND`；`production-memory-control.ts:441-444` 缺 ledger/consolidation 时抛 `MEMORY_OPERATION_NOT_INSTALLED`。未见本轮引入的新错误路径。
- 不合规范/不可信输入：`sqlite-decision-ledger-operations.ts:311-317` 校验 `decisionId` 必须是长度 1..128 的字符串，查询按 `owner_id`/`agent_id`/`id` 限定；`production-decision-chain.ts:56-62` 把规则编号里的控制字符替换为空格。均符合预期。
- 安全：受限记忆正文在 `production-decision-chain.ts:215-242` 通过 `reviewMemoryVisible` 置空（正文、原话、取代者正文、依据节点正文），与 ADR 0195 第 30 行、写入约定第 51/66 行一致；标识符仍返回，符合 ADR 的明示。
- 资源耗尽：记忆最多 100 条（`production-decision-chain.ts:18,133`）、依据节点预算 200（`:19,144-177`）、节点文本截 500（`:20,187`），遍历有预算、无无界递归。
- 不可撤销操作：本轮只做文档重命名和链接修改，可逆；`decision.chain.read` 是只读查询，不写库、不改发给模型的内容。
- 规则/文档/代码一致性：`.claude/rules/prompt-prefix.md:35` 的 `0193#consequences`、`0195` 对 `0193`/`0194` 的引用、写入约定对 `0195` 的引用，与现存文件一致。

## 必答问题

1. **会不会改变模型已经见过的请求开头？**
   不会。本轮只改文档（ADR 重命名和链接），没有改系统提示、工具定义、历史消息、遮盖逻辑或请求组装。发给模型的内容仍然只在末尾追加；每轮会变的值是否都在最后一条消息里，本轮没有触碰。ADR 0193 里记录的一次性“老对话敏感历史出现在历史中间”是既有决定的例外，不是这次改号带来的新例外。

2. **会不会让同一段文字在不同请求里变成不同的字节？**
   不会。本轮没有改遮盖、带时间的字段、无序集合或序列化格式；ADR 编号和文档路径不进入模型请求。代码里的确定性排序（如 `production-decision-chain.ts:64-66` 的 `sortedUnique`）也不是本轮改的。

3. **有没有对应的自动检查，反向用例是否真的会失败？**
   有部分覆盖：
   - `check:adr-numbers`（`package.json:34`，`scripts/check-adr-numbers.mjs`）会拦“文件名不合格式”和“编号重复”，`test/tooling/adr-numbers.test.mjs:29-41,55-66` 的反向用例真实断言退出码为 1。
   - `check:instruction-links`（`scripts/check-instruction-links.mjs`）会拦指令文件里的链接/锚点失效，`test/tooling/instruction-links.test.mjs:36-62` 有“文件被改名”“锚点消失”“路径不存在”的反向用例。
   - **缺口**：`docs/adr` 内部的交叉链接、`docs/execution/specs` 指向 ADR 的链接、以及“ADR 标题号是否等于文件名号”都没有自动检查，反向用例也不存在。因此本次若漏改一处文档内引用，CI 不会失败。

4. **每个产生/修改的值，使用它的地方都能接受吗？**
   本轮产生/修改的值只有 ADR 编号 `0195` 和文件名 `docs/adr/0195-show-the-whole-chain-of-one-decision-record.md`，以及两处引用文本。逐处核对：
   - 标题 `# ADR 0195` 与文件名一致（`0195…md:10`）。
   - `check-adr-numbers` 的正则 `^(\d{4})-[a-z0-9][a-z0-9-]*\.md$` 接受该文件名，编号检查无重复。
   - 写入约定的链接 `../../adr/0195-show-the-whole-chain-of-one-decision-record.md` 指向存在的文件（写入约定:26）。
   - ADR 0195 对 `0194`、`0193` 的链接、以及其他文档对 `0193`/`0194` 的链接都指向存在的文件。
   - 没有任何代码、配置、清单或序列化格式消费这个 ADR 编号；不存在 I-73 那种“清单 id 通过不了后端校验”的两端不一致。本轮唯一需要两端一致的“可见性”语义，代码 `reviewMemoryVisible` 与 ADR/写入约定的表述一致。
