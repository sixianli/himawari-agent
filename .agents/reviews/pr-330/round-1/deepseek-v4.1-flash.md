## 结论（按严重度）

### 1. 高 — 改动后 `check:adr-numbers` 在本仓库仍然失败，PR 目标未达成
- 位置：`docs/adr/0191-draft-pull-requests-run-fast-checks-only.md:11`、`docs/adr/0191-record-the-whole-basis-chain-of-a-memory-tidy-up.md:10`、`test/tooling/adr-numbers.test.mjs:80-82`
- 问题：仓库仍同时存在两份 0191。`check:adr-numbers` 会读整个 `docs/adr` 目录，发现 0191 重复就报错；测试里还有一条“本仓库必须零错误”的用例。也就是说，本次把 0192 改成 0193 后，这个检查仍然红着，PR 想解决的“check:adr-numbers 报重复”并没有变成通过。
- 证据（亲自读到）：
  - `scripts/check-adr-numbers.mjs:23-27`：
    ```js
    for (const [number, files] of byNumber)
      if (files.length > 1)
        errors.push(
          `ADR_NUMBER_DUPLICATE ${number} 被 ${files.length} 份 ADR 同时使用：...`,
    ```
  - `test/tooling/adr-numbers.test.mjs:80-82`：
    ```js
    it("passes on this repository", () => {
      expect(checkAdrNumbers().errors).toEqual([]);
    });
    ```
  - 两份 0191 文件都在 HEAD 工作树中存在，且 `git show db18e13c:docs/adr/0191-record-the-whole-basis-chain-of-a-memory-tidy-up.md` 和 `git show db18e13c:docs/adr/0191-draft-pull-requests-run-fast-checks-only.md` 都成功，证明 0191 重复在基准 db18e13c 就已存在，确实不是本改动引入。
- 建议：作者“0191 重复不是本改动引入”的说法属实；但要么在本 PR 或紧随的 PR 里把 0191 也改成不重复，要么在 PR 描述里明确“本 PR 只消除 0192 重复，check 仍因既有 0191 失败”，不要让人误以为门禁已绿。合并前应以真实的 `npm run check:adr-numbers` 结果为准。

### 2. 中 — 没有任何自动检查校验“标题里的 ADR 编号”和“文件名编号”一致
- 位置：`scripts/check-adr-numbers.mjs:8-27`、`docs/adr/0193-memory-is-visible-to-the-model.md:10`
- 问题：这次确实把标题改成了 `ADR 0193`，但检查脚本只看文件名，不读文件内容。反向用例（文件名 0193、标题仍写 0192）不会有任何检查失败，`check:instruction-links` 也只会因为链接目标文件存在而通过。
- 证据：
  - `scripts/check-adr-numbers.mjs:8` 只用文件名正则：`const ADR_FILE = /^(\d{4})-[a-z0-9][a-z0-9-]*\.md$/;`
  - 第 13-22 行仅对 `name` 做匹配和按编号分组，没有 `readFile`，没有标题校验。
- 建议：在 `check-adr-numbers.mjs` 里读取每个 ADR 的首个 `# ADR NNNN` 标题，断言与文件名前缀一致，并加一条反向用例。否则“标题号同步改”只靠人工，不是门禁。

### 3. 中 — `docs/` 下的 ADR 链接不在任何链接检查范围内，漏改不会被发现
- 位置：`scripts/check-instruction-links.mjs:7-12`、`docs/adr/0112-memory-page-carried-memories-and-topic-browsing.md:67`、`docs/adr/0158-bring-related-memories-into-gmail-checks.md:36`、`docs/adr/0185-mark-passwords-and-keys-sensitive-instead-of-dropping-them.md:61`
- 问题：`check:instruction-links` 只扫描 `AGENTS.md`、`CLAUDE.md`、`.claude/rules`、`.agents/instructions`。所以只有 `.claude/rules/prompt-prefix.md:35` 的那条链接被自动校验；0112/0158/0185、两份 spec、runbook 里的链接都不会被检查。若这些链接漏改，CI 不会红。
- 证据：
  ```js
  export const INSTRUCTION_ROOTS = Object.freeze([
    "AGENTS.md",
    "CLAUDE.md",
    ".claude/rules",
    ".agents/instructions",
  ]);
  ```
  以及第 52-70 行只遍历 `instructionFiles(root)`。
- 建议：为 `docs/**/*.md` 增加一个通用的相对链接/锚点检查，或用 `check:instruction-links` 的同一逻辑扩展到 `docs/adr`、`docs/execution/specs`、`docs/runbooks`。本次已人工核对这些链接都能解析，但缺门禁。

### 4. 低 — 删除旧文件名可能破坏仓库外引用（推测）
- 位置：`docs/adr/0192-memory-is-visible-to-the-model.md`（b825a0fe 删除）
- 问题：仓库内已无 `0192-memory` 引用，但 0192-memory 在基准 db18e13c 中已存在，若它已随 PR 324 出现在 main 或对外发布，外部书签/文档指向旧路径会 404。
- 证据/说明：`git show b825a0fe` 删除的文件内容与当前 `docs/adr/0193-memory-is-visible-to-the-model.md` 逐行相同，仅标题行 `0192` vs `0193`，因此没有丢内容；仓库内链接也已全部指向 0193。外部引用情况本次无法核实，属推测。
- 建议：如需保守，可在旧路径保留一份极小的转发/说明文件（含新链接），或确认该 ADR 尚未对外发布。

### 5. 信息 — “指向另一份 0192 的链接没被误改”是空真
- 位置：`docs/adr/0192-delete-unimplemented-gateway-operations-and-gate-new-ones.md:10`
- 说明：仓库里根本不存在指向 `0192-delete-unimplemented...` 的链接（grep 无结果），所以“没被误改”成立但不是有效验证点；同时也说明这份 0192 目前没有内部引用。

---

## 读代码证实的

- 改动仅涉及 8 个文档文件，没有代码、测试、配置、序列化格式改动（`git diff db18e13c..b825a0fe`）。
- 0192→0193 的重命名只有标题行变化（similarity 99%，diff 只显示标题行）；b825a0fe 删除的 0192 副本与 0193 内容一致，仅标题号不同，未丢失决定内容。
- 全仓库搜索 `0192-memory-is-visible` 无结果，残留链接为 0。
- 所有指向 0193 的链接都指向存在的文件；`.claude/rules/prompt-prefix.md` 的 `#consequences` 锚点在 `docs/adr/0193-memory-is-visible-to-the-model.md:72` 存在。
- `docs/adr/0192-delete-unimplemented-gateway-operations-and-gate-new-ones.md` 未被改动。
- 两份 0191 在基准 db18e13c 都已存在，重复不是本改动引入；但 HEAD 上 `check:adr-numbers` 仍会因此失败。
- `check-adr-numbers` 只校验文件名格式和编号唯一性，不校验标题；`check-instruction-links` 不覆盖 `docs/adr`。

## 推测（未核实）

- 0193 是否仍被远端尚未合并的其它 PR 占用：未核实，只能确认本地树中 0193 为空。
- 旧路径 0192-memory 是否有仓库外引用：未核实。
- 该 PR 合并进 main 后，main 上 0191 重复是否会被另一 PR 同时修掉：未核实。

---

## 侧重检查（错误路径、输入、安全、资源、不可逆、规则一致性）

- 不合规范/不可信输入：`ADR_FILE` 正则会拒绝非“四位编号-小写短名.md”的文件；0193 文件名合法。标题未纳入校验（见问题 2）。
- 错误路径：重复编号、空目录、缺目录都有明确错误码和退出码，本次未改这些路径。真正的错误路径是“0191 重复导致整条检查失败”，已在问题 1 说明。
- 安全：改动是文档改名/删副本，决定内容逐字未变；敏感记忆可见性的安全语义由 ADR 0193 原样保留，重编号不改变任何运行时行为。没有发现凭据或敏感值泄露。
- 资源耗尽：纯文档改动，无运行时资源路径，不适用。
- 不可逆操作：删除文件在 git 历史中可恢复，且内容已在 0193 保留；仓库内无残留引用。唯一潜在不可逆影响是外部旧链接（推测，见问题 4）。
- 规则/说明与代码一致性：`.claude/rules/prompt-prefix.md:35` 已指向 0193 且锚点有效；ADR 0193 内对规则文件第 4 条的描述与规则文件一致；没有发现规则文本和代码/ADR 的矛盾。

---

## 必答问题

1. **会不会改变模型已经见过的请求开头？**
   不会。本次是纯文档改动，没有动系统提示、工具定义、历史消息、遮盖逻辑或请求组装代码。发给模型的内容仍然只在末尾追加；每轮会变的值仍只在最后一条消息里（本次没有触碰这条路径）。唯一改到 `.claude/rules/prompt-prefix.md` 的是开发者规则文本里的一处 ADR 编号链接，不是产品发给模型的系统提示/历史；而且它是静态文本、每次渲染相同。ADR 0193 里记录的一次性“老对话首轮前缀变化”是既有决定的内容，重编号不会额外触发。基于 diff 范围判断请求字节不变；请求组装全链路未逐行复读的部分标“未核实”。

2. **同一段文字会不会在不同请求里变成不同的字节？**
   不会。改动是静态 Markdown 文本，不含依赖前后文的遮盖、时间字段或无序集合；重命名后同一内容的字节是确定的。

3. **有没有对应的自动检查，反向用例真的会失败？**
   有 `check:adr-numbers`，其测试包含“两份 ADR 同号必须报错”的反向用例，逻辑上确实会失败。但两点不足：
   - 本仓库的 “passes on this repository” 用例当前因 0191 重复而失败，无法作为本次修复是绿的证据；
   - 没有检查标题编号与文件名一致；也没有检查 `docs/adr` 内的链接。若标题漏改或 docs 链接漏改，现有检查不会失败。
   建议补齐标题一致性检查和 docs 链接检查，并先让 0191 重复消失。

4. **每个改动产生的值，使用它的地方都能接受吗？**
   本次产生的值是新编号 `0193` 和新文件名 `0193-memory-is-visible-to-the-model.md`。
   - 生成处：文件名与标题（`docs/adr/0193-memory-is-visible-to-the-model.md:10`）。
   - 使用处 1：`check-adr-numbers` 只校验文件名，0193 合法且本地无第二个 0193，接受。
   - 使用处 2：7 处链接（`.claude/rules/prompt-prefix.md:35`、0112:67、0158:36、0185:61、control-center spec:215、memory-engine spec:112、runbook:469）都指向存在的 0193 文件，锚点 `#consequences` 存在，接受。
   - 使用处 3：`check-instruction-links` 只覆盖 `.claude/rules` 那一处，能解析，接受。
   - 另一份 0192（网关操作）保持不变，仍占用 0192，因此 0193 不冲突。
   - 没有任何消费方校验“标题里的编号”，所以标题若写错不会被两端校验发现。
   结论：现有所有消费方都接受 0193；缺口在于没有消费方校验标题号，且整体门禁仍被 0191 拖红。
