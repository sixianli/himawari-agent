## 结论

本次改动只碰 `docs/`、`.agents/instructions`、检查脚本、测试和 `package.json`，没有触达请求组装路径，因此不影响 Himawari 发给模型的请求。作者关于“已删除文件现已不在仓库”“Hermes 手册改指封存件”“D21 锚点改对”的说法，我核对后均成立。主要问题集中在新链接检查的**覆盖面和判定准确性**：它会把若干合法的 Markdown 写法漏掉，也会在未来对缩进代码块产生误报；这些目前还没有造成失败，但和“全 docs/ 链接检查、以后保持绿色”的说法有差距。没有发现高严重度问题。

---

## 发现（按严重度）

### 1. 中 — 参考式链接完全不检查

- 文件：`scripts/check-docs-links.mjs:8`
- 问题：只匹配行内链接 `](...)`，`[文字][ref]` + `[ref]: path` 的参考式链接一个都不会被解析。仓库 `docs/` 里确实使用参考式链接（`docs/assets/others/Anthropic_SRT_AI_Agent_Integration_Guide_2026-09-07.md:1030-1055`），只是当前定义全是外部网址，所以暂时没有漏掉相对断链。
- 证据：
  ```js
  const MARKDOWN_LINK = /\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g;
  ```
  ```md
  [S01]: https://github.com/anthropics/sandbox-runtime/releases/tag/v0.0.75
  ```
  定义支持正则只匹配 `^\[[^\]]+\]:`（我另行检索过），而检查器根本没读这种语法。
- 建议：至少解析参考式定义并校验相对路径与锚点；如果决定不查，把这条限制从“请重点看”提升到正式说明里，并明确写入 `document-governance.md`，避免以后以为“全 docs/”都查了。

### 2. 中 — 缩进/引用块里的代码围栏不会被跳过，可能误报

- 文件：`scripts/check-docs-links.mjs:11`
- 问题：围栏正则要求 ``` 或 ~~~ 出现在行首（`^`，没有允许缩进），因此列表项或引用块里的围栏不会被删掉，里面的 `](...)` 会被当成真链接。`docs/` 现存两处缩进围栏：`docs/execution/specs/2026-10-26-web-push-design.md:95` 和 `docs/adr/0104-turn-material-in-last-user-message.md:64`。这次它们里面没有 Markdown 链接，所以检查仍能通过；以后往里放示例链接就会红。
- 证据：
  ```js
  const FENCE = /^(```|~~~)[\s\S]*?^\1[^\n]*$/gm;
  ```
  ```md
    ```json
    "secretReferences": [...]
    ```
  ```
- 建议：允许 0–3 个前导空格，并先去掉引用块前缀（`>`）；补一个“缩进围栏里的链接被忽略”的反向测试。

### 3. 中 — 合法的 CommonMark 目标写法会漏检或误判

- 文件：`scripts/check-docs-links.mjs:8`
- 问题：
  - `[x](<foo bar.md>)` 这种用尖括号包住带空格路径的写法：正则 `[^)\s]+` 在空格处停下，后又要求 `\)`，整条链接不会被匹配（漏报）。
  - `[x]( foo.md )`（目标两侧有空白）同样匹配不到（漏报）。
  - `[x](foo(bar).md)` 会在第一个 `)` 处截断成 `foo(bar`，产生错误目标（误报）。
  - 单引号/括号标题 `[x](path 'title')` 也不支持。
  当前 `docs/` 里没有这些写法（我检索过 `](<`、`](` 后跟空白、`](...?...`），所以没有现存失败。
- 证据：
  ```js
  const MARKDOWN_LINK = /\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g;
  ```
- 建议：换成能处理 `<...>`、平衡括号和三种标题引号的正则/解析器；或直接复用成熟的 Markdown 解析器。为每种写法加一个会失败的反向用例。

### 4. 低 — 标题 slug 与 GitHub 不完全一致

- 文件：`scripts/check-docs-links.mjs:14-20`
- 问题：slug 是直接用原始 Markdown 标题文本算的，会保留链接目标里的字母数字。例如 `docs/execution/plans/2026-09-24-isolated-tool-execution-plan.md:124`：
  ```md
  #### 旧 P0：[历史 P0 任务及身份合同](../../archive/plans/...md#p0)
  ```
  GitHub 的锚点按渲染后的文字算，检查器却会把 `../../archive/...md` 的字母也拼进 slug。另外 GitHub 对重复标题补 `-1`/`-2`、保留 emoji，而这里的正则把这些都去掉了。当前这些“带链接的标题”都有显式 `<a id="p0">` 兜底，且没有 emoji/重复标题被链接，所以没有现存误报。
- 证据：
  ```js
  .replace(/[^\p{Letter}\p{Number}\s_-]/gu, "")
  .replace(/\s/g, "-");
  ```
- 建议：改用与 GitHub 一致的 slug 实现（如 `github-slugger`），或至少从标题里先剥离 `[文字](目标)` 和行内标记，并处理重复标题后缀；补一个“标题里含链接时锚点仍匹配 GitHub”的测试。

### 5. 低 — 不限制目标必须落在仓库内，根相对/协议相对链接会被当成文件系统路径

- 文件：`scripts/check-docs-links.mjs:62-64`
- 问题：`path.resolve` 后直接 `existsSync`。`../../../../etc/passwd` 这类逃出仓库的路径若在本机存在就会“通过”，而 GitHub 上其实是坏链接；`/docs/x.md`（站点根相对）和 `//example.com/x`（协议相对）会被当成本机绝对路径，可能误报。当前 `docs/` 没有这类写法。
- 证据：
  ```js
  const destination = relative ? path.resolve(directory, relative) : path.join(root, file);
  if (!existsSync(destination)) {
  ```
- 建议：解析后校验目标仍在 `root` 内；显式把 `/` 开头和 `//` 开头当外链跳过或单独处理。

### 6. 低 — 没有测试保证 `check:docs-links` 仍然接在 `check:steps` 里

- 文件：`test/tooling/run-all-checks.test.mjs:50-74`
- 问题：现有测试只断言“每个 step 都是真实 npm script”，没有断言 `check:docs-links` 出现在 `check:steps`。把这个新步骤删掉，测试仍会全绿。作者说“接进 npm run check”，但这一步本身没有回归保护。
- 证据：
  ```js
  const names = stepNames(manifest.scripts["check:steps"]);
  expect(names).toContain("check:boundaries");
  ...
  for (const name of names) expect(manifest.scripts[name], name).toBeTypeOf("string");
  ```
- 建议：在 `run-all-checks.test.mjs` 加 `expect(names).toContain("check:docs-links")`，同时断言 `manifest.scripts["check:docs-links"]` 的完整命令。

### 7. 低 — 围栏闭合允许带信息串，可能提前结束代码块

- 文件：`scripts/check-docs-links.mjs:11`
- 问题：闭合围栏用 `^\1[^\n]*$`，所以代码块内部一行 ```js 也会被当成闭合围栏；CommonMark 里闭合围栏不能带信息串。这会让后续代码内容被当成正文，造成误报，或在极端情况下把真正的链接包进“假围栏”而漏报。
- 证据：
  ```js
  const FENCE = /^(```|~~~)[\s\S]*?^\1[^\n]*$/gm;
  ```
- 建议：闭合围栏改成 `^\1\s*$`（允许尾随空白），并与第 2 条一起加测试。

---

## 推测 / 未核实

- **未核实**：`npm run check:docs-links` 在当前 HEAD 实际退出 0。我只能读代码，不能运行 node；作者说已通过，我按此前提评估。
- **未核实**：345 条断链的数量、330 条 `.ci-output` 改写的数量是否准确。我没有逐条统计，只抽查了改写后的语义。
- **未核实**：是否存在隐藏的重复标题 slug 被 `-1` 链接使用；我检索了 `](#...-数字)`，命中的都是显式锚点风格的日期/编号，未发现 GitHub 重复标题后缀。
- **推测**：`FENCE` 对大量未闭合围栏可能是 O(n²)，但文档规模下影响很小。

---

## 侧重检查（错误路径、不可信输入、安全、资源、不可逆操作、文档与代码一致性）

- **错误路径**：文件不存在、锚点不存在分别走 `continue` 和 `push`，不会中断整轮检查；`decodeURIComponent` 用 try/catch 兜住非法百分号编码，这一点是稳的。但 `existsSync` 对权限错误也返回 false，可能把“读不到”误报成“文件缺失”；`lstatSync` 在 readdir 与 lstat 之间文件被删会直接抛错终止检查（只影响本地工具，不是安全边界）。
- **不可信输入**：链接目标会被 `decodeURIComponent` 解码后 `path.resolve`，但没有限制在仓库内（见发现 5）。检查器只打印路径，不读取目标内容（除非 `.md` 且带锚点时读取目标文件），目前没有明显的信息泄露面。
- **安全/资源耗尽**：脚本只读，递归前用 `lstatSync` 跳过符号链接，避免目录环；正则没有明显的灾难性回溯。大文件会被整份读入内存，但 `docs/` 是受控仓库内容，风险低。
- **不可逆操作**：改动本身没有删除或改写用户数据；测试只用 `mkdtempSync` 建临时目录并 `rmSync(..., { recursive: true, force: true })` 清理自己创建的目录，范围安全。
- **文档与代码一致性**：
  - 核实 `.claude/rules/document-governance.md`、`.claude/rules/owner-skills.md`、`.claude/skills/document-governance/references/sop.md`、`scripts/check-docs-governance.mjs` 确实都不在仓库里（glob 无结果），所以 ADR 0080/0101/0132/0133 的“现已不在仓库里”没有说错。
  - 核实 `docs/archive/runbooks/2026-11-07-hermes-self-hosted-runner-runbook.md` 存在，且 `#install`（第 117 行）、`#pause-and-resume`（第 134 行）锚点存在；ADR 0160/0168/0169/0170/0173 的改指可用。
  - 核实 `docs/execution/plans/2026-09-28-tool-execution-audit-plan.md` 的 D21 标题（第 462 行）与第 25 行新锚点 `#d21期限后交付测试的受控计时器` 一致；全仓库没有其他地方引用旧锚点 `#d21-...`。
  - `.agents/instructions/document-governance.md:28` 的口径“每个行内 Markdown 相对链接”与实现一致（确实只查行内），但 PR 说明里的“全 docs/ 链接检查”比实现宽；建议把“参考式/HTML/缩进围栏”明确列为不检查。
  - ADR 0133 第 26 行改写后出现嵌套括号：`（scripts/check-docs-governance.mjs（\`scripts/check-docs-governance.mjs\`，现已不在仓库里），约 1 秒）`，不是事实错误，但读起来别扭，建议顺手整理。
  - ADR 0160 等仍用“操作手册”称呼已归档文件，建议加“已归档”字样，避免读者把封存件当现行手册。

---

## 必答问题

### 1. 会不会改变模型已经见过的请求开头？

**不会。** 改动只涉及 `docs/`、`.agents/instructions/document-governance.md`、`scripts/`、`test/` 和 `package.json`，没有任何请求组装、系统提示、工具定义、历史存储或遮盖代码被修改。我在 `packages/` 和 `apps/` 中检索 `.agents/instructions` 和 `document-governance` 均无命中。也就是说，这次改动既没有在末尾追加，也没有改开头；每轮变化的值本就不存在。即使把 `.agents/instructions` 理解为开发代理的上下文，它也不是 Himawari 运行时请求历史的一部分，不适用“已发出内容只追加”的逐轮比较。依据：[prompt-prefix 规则](../../.claude/rules/prompt-prefix.md#rules)。

### 2. 会不会让同一段文字在不同请求里变成不同字节？

**不会，运行时没有变化。** 新检查器的遍历用 `readdirSync(...).sort()`，错误按固定文件顺序输出，不含时间戳、随机数或无序集合；`mkdtemp` 的随机目录只出现在测试里，且错误信息打印的是相对路径，不打印临时根。因此工具输出是确定的。就“同一段文字在不同请求里”而言，本次不涉及任何发给模型的文字生成路径。

### 3. 有没有对应的自动检查，反向用例是否真会失败？

有：`scripts/check-docs-links.mjs` + `test/tooling/docs-links.test.mjs`，并通过 `package.json:98` 接进 `check:steps`（`package.json:27`）。

反向用例的实际情况：
- 文件缺失：`docs-links.test.mjs:36-40`，去掉文件存在性检查会失败。
- 锚点缺失：`:42-46`，去掉锚点检查会失败。
- 代码块/行内代码/`docs/archive` 跳过：`:48-55`，破坏跳过逻辑会失败。
- 但**没有**覆盖参考式链接、尖括号/空格路径、平衡括号、缩进围栏、slug 与 GitHub 一致、以及“新步骤仍接在 `check:steps` 里”。所以“基本反向用例会失败”成立，“本次改动引入的所有风险都有反向用例”不成立（见发现 1、2、3、6、7）。

### 4. 每个新增/修改的值，使用它的地方都能接受吗？

逐个核对：
- **`check:docs-links`（`package.json:98`）**：被 `check:steps`（`package.json:27`）引用；`scripts/run-all-checks.mjs:32` 从 `check:steps` 拆出名字并 `npm run <name>`，能运行；`test/tooling/run-all-checks.test.mjs:73` 只要求它是字符串。**没有断言它必须出现在 `check:steps`**，这是缺口。
- **测试文件 `test/tooling/docs-links.test.mjs`**：`ci/policy.json:194` 的 tooling include 含 `test/tooling/**/*.test.mjs`，`vitest.workspace.ts:30-48` 会加载 tooling 项目，能被执行。
- **错误码 `DOCS_LINK_MISSING` / `DOCS_ANCHOR_MISSING`**：只在脚本输出、测试断言和 `document-governance.md:28` 中出现，没有别处按旧格式解析，不会有不兼容。
- **输出行 `DOCS_LINKS passed/failed checked=...`**：没有其他消费者，安全。
- **D21 锚点新值 `#d21期限后交付测试的受控计时器`**：全仓库只有 `docs/execution/plans/2026-09-28-tool-execution-audit-plan.md:25` 一处使用，且与同文件第 462 行标题一致；没有外部旧锚点残留。
- **Hermes 封存件路径与锚点**：目标文件存在，`#install`、`#pause-and-resume` 存在，链接使用方（ADR 0160/0168/0169/0170/0173）都能接受。
- **“现已不在仓库里”的四个路径**：均确认不存在，使用方（ADR 0080/0101/0132/0133）说法正确，符合事故 I-73 的教训（不只检查改动本身，还要检查清单里的值能通过接收端的校验）。

依据：[I-73](../../docs/incidents-and-gates.md#incidents)。
