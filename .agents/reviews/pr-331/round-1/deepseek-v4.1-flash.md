## 读代码证实的问题

### 1. 严重度：高（阻断检查；基准提交上已存在，本次未消除）
- 文件:行：`docs/adr/0192-memory-is-visible-to-the-model.md:10`、`docs/adr/0192-delete-unimplemented-gateway-operations-and-gate-new-ones.md:10`、`scripts/check-adr-numbers.mjs:23-27`、`test/tooling/adr-numbers.test.mjs:80-82`
- 问题：本次只把 `0191-record...` 改成 `0194-record...`，但仓库里仍有两份 ADR 同时使用 `0192`。`check:adr-numbers` 按文件名前四位分组，重复即报错；测试又要求本仓库零报错，所以该门槛在当前 HEAD 会红。作者简报只核对了“0194 是否与其他 ADR 号冲突”，漏掉了仍存在的 0192 重复。
- 证据：
  - 两个标题实际存在：`# ADR 0192：存入记忆的内容必须能被模型看到（模型可见上限和运行分级分开）`、`# ADR 0192：删除没人实现、没人调用的网关操作，并加检查拦住新的空壳`。
  - `check-adr-numbers.mjs`:`const number = match[1]; byNumber.set(...)`；随后 `if (files.length > 1) errors.push(\`ADR_NUMBER_DUPLICATE ${number} ...\`)`。
  - 测试：`it("passes on this repository", () => { expect(checkAdrNumbers().errors).toEqual([]); });`
  - 基准 `db18e13` 上同样存在这两个 0192 文件，说明不是本次改名新引入的，但本次正以“消除重复编号”为目标，合并后门槛仍不会绿。
- 建议：把其中一个 0192 改号后再合并。当前 `0193` 在本树完全空闲（`grep \b0193\b` 无命中），可优先用 0193；同时更新指向它的引用。尤其 `ci/operations-removed.json:3-28` 用 `见 docs/adr/0192` 指“删除网关操作”那份，与另一份 0192 混淆，应改成明确文件名。若 0192 的重复属于另一个在途 PR，应在 PR 里写明依赖，不要留下阻断门槛。

### 2. 严重度：低
- 文件:行：`scripts/check-instruction-links.mjs:7-12`
- 问题：ADR 之间的相对链接和标题编号没有自动检查。`check-instruction-links` 只覆盖 `AGENTS.md`、`CLAUDE.md`、`.claude/rules`、`.agents/instructions`；`check-adr-numbers` 只检查文件名格式和编号重复，不看标题里的编号，也不解析 Markdown 链接。以后漏改一处链接或标题，CI 不会报红。
- 证据：`INSTRUCTION_ROOTS = Object.freeze(["AGENTS.md","CLAUDE.md",".claude/rules",".agents/instructions"])`；`check-adr-numbers.mjs` 全文只对 `readdirSync` 得到的文件名做正则和分组。
- 建议：把 `docs/adr` 纳入链接检查，或新增一个检查：ADR 内相对链接必须存在、`# ADR xxxx` 标题编号必须与文件名一致。本次人工核查没有发现漏改，但只是靠 grep，不是门槛。

> 说明：本次 diff 中 `docs/adr/0143...:42`、`:77` 和 `docs/adr/0192-delete...:101` 三处链接目标 `0194-record-the-whole-basis-chain-of-a-memory-tidy-up.md` 均存在；`grep 0191-record-the-whole-basis-chain` 全仓 0 命中，重命名文件内也没有残留 `0191` 标题。这些是正确的。

## 推测 / 未核实
- 推测：`0193` 可能被另一个尚未合并的 PR 预留；离线无法核实。若如此，选 0194 有其理由，但 0192 重复仍需另定方案。
- 未核实：没有运行 `npm run check:adr-numbers`，也没有 CI 结果；上述“会红”是按代码逻辑判定，未实际执行。
- 未核实：仓库外是否有书签/外部链接指向旧文件名，无法离线检查。

## 侧重检查
- 错误路径：链接失效是这类改名的唯一实际错误路径。旧文件名全仓 0 命中，三处新链接目标存在，未发现断链；但没有自动门槛（见问题 2）。
- 不合规范/不可信输入：纯 Markdown 改名，不接收外部输入，无校验或解析路径受影响。
- 安全：diff 仅 3 个文档文件，无凭据、无新 URL、无代码；未发现安全问题。
- 资源耗尽：无运行时路径，不涉及。
- 不可撤销操作：文件改名可由 git 历史恢复；旧路径消失可能影响外部收藏，但仓库内引用已更新。
- 规则/文档与代码一致：`.claude/rules/prompt-prefix.md:35` 引用的 `0192-memory-is-visible-to-the-model.md` 未被本次改动，仍有效；但 `check-adr-numbers` 宣称“每个 ADR 一个编号”，当前仓库实际违反（两个 0192），规则门槛与仓库状态不一致，见问题 1。

## 逐条回答必答问题

1. **会不会改变模型已见过的请求开头？不会。** `git diff --name-status db18e13..HEAD` 只有 `M docs/adr/0143...`、`M docs/adr/0192-delete...`、`R099 docs/adr/0191-record... -> docs/adr/0194-record...`；重命名相似度 99%，仅标题行变化。`apps`、`packages`、`packages/prompt-catalog` 下均未发现读取 `docs/adr` 的代码。因此系统提示、工具定义、历史消息、遮盖结果都不受影响，发给模型的内容仍然只由代码组装，本轮变化值仍只在最后一条消息里。依据 [prompt-prefix 规则第 4 条](.claude/rules/prompt-prefix.md#rules)。

2. **会不会让同一段文字在不同请求里变成不同字节？不会。** 改的是不被任何运行时读取的文档文件，不涉及 JSON 键序、集合顺序、遮盖、时间字段或序列化。

3. **有没有自动检查，反向用例真的会失败吗？**
   - 有编号检查：`check:adr-numbers` 加 `test/tooling/adr-numbers.test.mjs`。反向用例确实覆盖“两个 ADR 共用一个编号”（例中 0148）以及 CLI 退出码 1，按代码会失败。
   - 但它只查文件名编号唯一和命名格式，不查标题编号与链接；链接没有任何 docs/adr 级门槛（问题 2）。
   - 更关键的是：由于仍有两份 0192，`test/tooling/adr-numbers.test.mjs:80-82` 的“本仓库通过”会用当前树判定为失败（未实际运行，按逻辑判定）。

4. **改动产生/修改的每个值，使用方都能接受吗？**
   - 新文件名 `0194-record-the-whole-basis-chain-of-a-memory-tidy-up.md`：使用方是 `0143:42`、`0143:77`、`0192-delete:101` 三处相对链接，目标均存在（glob 命中），可接受。
   - 编号 `0194`：文件名符合 `^(\d{4})-[a-z0-9][a-z0-9-]*\.md$`，本树唯一；`grep \b0194\b` 仅命中本 ADR 与上述两处引用，无冲突。
   - 标题 `# ADR 0194`：与文件名编号一致；但没有任何检查校验这一点，只靠人工。
   - 旧文件名：全仓 0 引用，`\b0191\b` 只剩无关的 `0191-draft-pull-requests-run-fast-checks-only.md`，说明指向旧文件的链接已全部改到。
   - 但仓库整体编号唯一性这一端不过关：两个 0192 会让 `check-adr-numbers` 报 `ADR_NUMBER_DUPLICATE 0192`；`ci/operations-removed.json` 的 `docs/adr/0192` 也因此产生指向歧义。需要先处理 0192 重复再合。
