# 复核结论（PR 331，1e4ade29）

## 发现的问题（按严重度从高到低）

### 1. 高 · docs/adr/0192 编号冲突仍在，编号门禁在本次提交后依然是红的
- **文件**：`docs/adr/0192-memory-is-visible-to-the-model.md:10`、`docs/adr/0192-delete-unimplemented-gateway-operations-and-gate-new-ones.md:10`
- **问题**：本 PR 的动机是“main 上 0191 重复”，但仓库里 0192 也重复了，本 PR 没有处理。`npm run check` 中的 `check:adr-numbers`（package.json:27、34）会报 `ADR_NUMBER_DUPLICATE 0192` 而失败，连带 `test/tooling/adr-numbers.test.mjs:80-82` 的「passes on this repository」用例也会失败。
- **证据（读代码证实）**：
  - `0192-memory-is-visible-to-the-model.md:10`：`# ADR 0192：存入记忆的内容必须能被模型看到（模型可见上限和运行分级分开）`
  - `0192-delete-unimplemented-gateway-operations-and-gate-new-ones.md:10`：`# ADR 0192：删除没人实现、没人调用的网关操作，并加检查拦住新的空壳`
  - `scripts/check-adr-numbers.mjs:23-27`：`if (files.length > 1) errors.push('ADR_NUMBER_DUPLICATE ...')`
  - `test/tooling/adr-numbers.test.mjs:80-82`：`it("passes on this repository", () => { expect(checkAdrNumbers().errors).toEqual([]); })`
- **建议**：把其中一份 0192 也改名（例如改成空闲的 0193），否则本次改动没有达到“让编号不冲突”的目的。

### 2. 低 · 取号 0194 跳过了 0193，与治理规则「取最大编号加一」不一致
- **文件**：`docs/adr/0194-record-the-whole-basis-chain-of-a-memory-tidy-up.md`（整个改名）
- **问题**：`.agents/instructions/document-governance.md:28` 规定新建 ADR「取所有这些编号里最大的加一」；本次改动前仓库里最大编号是 0192（两份），按规则应取 0193。改名后 0193 空缺，`git log --all -- "docs/adr/0193*"` 无任何提交用过 0193。
- **证据（读代码证实）**：`document-governance.md:28` 原文「……取所有这些编号里最大的加一（那条教训）」；glob `docs/adr/019*.md` 只有 0190、两份 0192、0194，无 0193。
- **推测**：可能是给待处理的 0192 重复预留 0193，但简报没说。`check:adr-numbers` 只查重复、不查连续，所以门禁层面不拦。建议在简报或 ADR 里说明 0193 的去向。

### 3. 信息 · 其余作者说法全部核实为真（读代码证实）
- 改动只有 3 个 markdown 文件，无任何代码、提示词、请求构造改动（`git diff --stat`：0143 两行、0192 一行、改名一处标题）。
- 「main 上 0191 重复」属实：`docs/adr/0191-draft-pull-requests-run-fast-checks-only.md:11` 标题就是 `# ADR 0191：草稿 PR 只跑快检查……`。
- 旧文件名引用无残留：全仓库 grep `0191-record-the-whole` 为 0 条；slug `record-the-whole-basis-chain` 的 3 处引用（`0143:42`、`0143:77`、`0192-delete:101`）全部已指向 0194。
- 改名后的 ADR 正文（全文 74 行已读）无残留把本 ADR 称作 0191 的文字，标题已是 `ADR 0194`（第 10 行）；`*.ts` 代码无任何 0191 引用。
- 0194 与其他 ADR 号不冲突（全 refs 只有本提交用 0194）。

## 侧重检查

走的流程：ADR 编号治理流程（新建/改名 ADR → `npm run check:adr-numbers` 门禁 → 门禁测试）。
- 自动检查存在且反向用例真实：`test/tooling/adr-numbers.test.mjs:29-41` 构造两份 0148 断言报 `ADR_NUMBER_DUPLICATE` 并点名两个文件；55-66 行验证 CLI 在重复编号时退出码 1。反向用例确实会失败。
- 文档与代码一致：`document-governance.md:28` 对脚本行为的描述（查四位编号命名格式、查重、其他扩展名不查）与 `scripts/check-adr-numbers.mjs` 一致；该条还明确「仓库没有对 docs/ 做全面校验的自动检查」，所以 docs/adr 内部互链（本次改的 3 处链接）没有自动检查——我已手工逐条核对，链接目标文件都存在。
- 测试覆盖：本次是纯改名，无需新测试；既有的「passes on this repository」用例本应守住编号唯一性，但它现在因 0192 重复而失败（见问题 1），即门禁没守住、PR 也没让门禁变绿。
- 未能走通的：完整 `npm run check` 无法运行（复核环境限制），其余 check 步骤与本次改动的关系未核实；但本次改动不触碰任何被这些检查读取的代码或清单格式之外的内容（frontmatter 格式未变）。
- 未核实：其他远端分支上是否有未合并 PR 占用 0193/0194（本仓库 `git log --all` 内未见，外部 PR 状态无法确认）。

## 必答问题逐条回答

1. **会不会改变模型已见过的请求开头？** 不会。读代码证实：diff 仅含 `docs/adr/` 下 3 个 markdown 文件（改名 + 4 行链接/标题文字），不触碰提示词目录、工具定义、历史消息或遮盖逻辑，发给模型的内容完全没有变化，「只追加」规则不适用。
2. **同一段文字会不会在不同请求里变成不同字节？** 不会。改动没有任何序列化、遮盖、时间字段或集合顺序相关内容；markdown 是纯静态文档，不进入任何请求。
3. **有没有对应的自动检查，反向用例会不会失败？** 有：`check:adr-numbers`（`scripts/check-adr-numbers.mjs`，测试 `test/tooling/adr-numbers.test.mjs`），反向用例（重复编号）确实会失败。但注意：该门禁在当前提交上仍会失败，原因是遗留的 0192 重复（问题 1）；本次改的 3 处 markdown 链接本身无自动检查，已手工核对全部有效。
4. **每个产生/修改的值，使用处都能接受吗？** 改动产生的值只有：新文件名/编号 `0194-record-the-whole-basis-chain-of-a-memory-tidy-up.md` 和标题「ADR 0194」。使用处共 3 处（`0143-decision-ledger-for-model-gate-decisions.md:42、77`、`0192-delete-...md:101`），全部已同步更新，链接目标存在；`*.ts` 代码无对该 ADR 的任何引用（grep 证实）；frontmatter 字段未变。两端核对通过，唯「0193 空缺」与治理规则的取号约定存在低严重度不一致（问题 2）。
