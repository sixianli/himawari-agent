# 代码复核报告：PR 335（docs 断链修复 + docs 链接检查）

## 结论摘要

改动方向正确、接线正确，作者的说法基本与代码一致；未发现高危问题。发现的主要风险是**检查脚本与 GitHub 渲染行为之间存在若干已知偏差**，目前没有触发实例，但缺少把它们钉住的反向用例。

---

## 按严重度排列的问题

### 1.【中】scripts/check-docs-links.mjs:8,20-26 — 与 GitHub 行为的偏差会造成将来的误报/漏报，且无测试钉住

**证据（亲自读到的代码）：**

- `scripts/check-docs-links.mjs:8`：`const MARKDOWN_LINK = /\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g;` —— `[^)\s]+` 遇到含转义括号的路径（`[x](a\(1\).md)`，GitHub 支持）会把目标截成 `a\(1\`，报假 `DOCS_LINK_MISSING`；遇到 `[x](<path with spaces>)`（GitHub 支持）整个链接匹配不上，直接漏查。
- `scripts/check-docs-links.mjs:17-20`：`anchorsOf` 用 `headingSlug` 收集标题 slug，`check-docs-links.mjs:73` 直接 `anchorsFor(destination).has(anchor)`。**重复标题**时 GitHub 生成 `#标题-1`、`#标题-2` 后缀，脚本只有基础 slug：将来有人合法地链到第二个重复标题，会被误报 `DOCS_ANCHOR_MISSING`。
- `scripts/check-docs-links.mjs:7`：`FENCE = /^(```|~~~)…/gm` 只剥行首围栏；我 grep 到 docs 里确实存在**缩进的围栏代码块**（`docs/execution/specs/2026-10-26-web-push-design.md:95,98`、`docs/adr/0104-turn-material-in-last-user-message.md:64,74`），其内容会被当作正文扫描；未闭合围栏同样不剥。目前这两个块里没有链接形文字，未触发，但这是长期门槛，风险留着。
- 引用式链接（`[text][ref]`）不查——治理文档和 ADR 已声明这一点，我 grep 了全 docs 没有发现 `^\[…\]: ./…` 形式的引用定义（当前无漏报实例），但**测试里也没有任何用例把这个行为钉住**。

**建议**：至少给「重复标题 `-1` 锚点」和「转义括号/尖括号路径」补上行为测试（断言当前行为，或修成与 GitHub 一致）；引用式链接可在遇到时显式跳过并计数，避免静默漏报。

### 2.【低】test/tooling/docs-links.test.mjs — 覆盖有缺口

**证据**：四个用例覆盖了「全存在通过 / 文件缺失失败（含 `.ci-output`）/ 锚点缺失失败 / 代码与 archive 跳过」，反向用例确实会失败。但没有覆盖：
- **指向 `docs/archive/` 的链接仍会被校验**（脚本 `check-docs-links.mjs:76-90` 里 `existsSync`/`anchorsFor` 对 archive 目标照样生效，只有 archive 自身的出链不扫）——本次 PR 恰好新增了 6 条指进 archive 的链接（如 `docs/adr/0169-pause-runners-by-removing-the-label.md` 改指 `../archive/runbooks/2026-11-07-…#pause-and-resume`），这个行为靠的是未测代码路径；
- `headingSlug` 没有直接单测（全角冒号、CJK、空格转连字符等规则只靠真实仓库跑通过来隐式验证）。

**建议**：补一条「链入 archive 的断链也报错」的反向用例和 `headingSlug` 的直接用例。

### 3.【低】.agents/instructions/document-governance.md:28 — 措辞与脚本细节略有出入

**证据**：新句子说查「每个行内 Markdown 相对链接的文件和锚点」，跳过「代码块和行内代码」。脚本实际还：跳过**符号链接文件**（`check-docs-links.mjs:37-38`）；检查的不只是落点在 `docs/` 内的链接，从 docs 指向 `scripts/` 等仓库其他位置的相对链接也会查（这是合理行为，但文字没提）。无实际危害。

### 4.【低，未核实项归档】作者说明中无法离线核实的数字

- 「345 条断链」「330 条 `.ci-output` 链接改写」——无法运行脚本计数，未核实；我改为等价抽查：grep 全 docs（非 archive）确认**已无任何残留的 `.ci-output` Markdown 链接**（`\]\([^)]*\.ci-output` 零命中），改写是完整的。
- `validate_docs.py --strict` 改前改后 13 条既有错误、biome format 通过——不能运行，未核实。
- 改写后的「现已不在仓库里」声明逐条核实为真：`.claude/` 目录整个不存在（glob 零命中）、`scripts/check-docs-governance.mjs` 不存在、package.json 无 `check:docs` 键——与 `docs/adr/0080`、`0133`、`0101` 改后的文字一致，**没有把还存在的东西说成已删除**。

---

## 侧重检查（我走的流程）

普通使用流程：作者改一篇 docs 文章 → 提交前跑 `npm run check` → `scripts/run-all-checks.mjs:32` 从 package.json 的 `check:steps` 解析步骤清单 → 跑到新增的 `check:docs-links` 步（`node scripts/check-docs-links.mjs && vitest … docs-links.test.mjs`）→ 脚本扫 `docs/`（跳过 archive、符号链接、代码块/行内代码）→ 有断链则逐行输出并退出 1 → run-all-checks **继续跑完剩余步骤并汇总**（该行为有测试，test/tooling/run-all-checks.test.mjs:8-25）→ `check:check-runner` 的测试要求 check:steps 里每个名字都是真实 npm 脚本（run-all-checks.test.mjs:73），`check:docs-links` 已在 scripts 里定义，满足。

路径覆盖结论：
- **有测试覆盖**：runner 机制、脚本的正反行为（合成夹具）、步骤名必须是 npm 脚本。
- **没有测试覆盖的路径**：真实 docs 全量扫描只由脚本入口执行（测试只打合成夹具，没有「当前仓库应通过」用例——这一点被同一条 npm 脚本里的 node 调用补上了，勉强算覆盖）；改写后的散文（如「现已不在仓库里」「写成行内代码」）没有任何机器校验，只能靠人核对——我抽查的 6 处均属实；上面问题 1、2 列的偏差路径无测试。
- 文档与代码一致性：治理文档新增句子里的错误码（`DOCS_LINK_MISSING`、`DOCS_ANCHOR_MISSING`）、跳过规则、`.ci-output` 写成行内代码的约定，均与脚本逐一对上。

---

## 必答问题逐条回答

**1. 会不会改变模型已经见过的请求开头？**
不会。改动只触及 docs/、`scripts/check-docs-links.mjs`、`test/tooling/docs-links.test.mjs`、package.json 和 `.agents/instructions/document-governance.md`。后者是静态指令文件，不进入产品提示词组装代码（grep `apps/` 中 `.agents/instructions` 零命中）；没有任何产品代码、工具定义、历史消息或遮盖逻辑被触碰。发给模型的内容组装路径未变，每轮变化的值仍只在最后一条消息。（依据的规则文件 `.claude/rules/prompt-prefix.md` 在本仓库不存在——`.claude/` 已整个删除，无法读到规则原文，此结论基于代码本身。）另外 `check:prompt-prefix` 这一步仍在 check:steps 中，未被此 PR 改动。

**2. 会不会让同一段文字在不同请求里变成不同字节？**
不会。所有改写都是确定性静态文字；无时间戳、无依赖前后文的遮盖、无无序集合。检查脚本自身的输出也是确定的：`docsMarkdownFiles` 用 `readdirSync(...).sort()` 遍历（check-docs-links.mjs:31），错误顺序稳定。

**3. 有没有对应的自动检查，反向用例是否真的会失败？**
有：`check:docs-links` 同时跑真实仓库扫描和工具测试，已接进 `check:steps`（package.json:27,98）。测试里的反向用例（文件缺失、锚点缺失、`.ci-output` 链接）断言了具体错误串，若脚本退化会失败。但覆盖不全（见问题 1、2）：引用式链接、重复标题 `-1`、转义括号等行为没有用例钉住。

**4. 改动产生的每个值，使用端都能接受吗？**
逐对核过：`check:docs-links` 脚本名（package.json scripts 定义 ↔ check:steps 引用 ↔ 治理文档提及）；错误码 `DOCS_LINK_MISSING`/`DOCS_ANCHOR_MISSING`（脚本输出 ↔ 治理文档描述，一致）；`checkDocsLinks` 具名导出（脚本 ↔ 测试导入，一致）；测试文件落点 `test/tooling/docs-links.test.mjs`（↔ ci/policy.json:193-194 tooling 项目的 include `test/tooling/**/*.test.mjs`，会被收集）；改指 archive 的链接目标（`docs/archive/runbooks/2026-11-07-hermes-self-hosted-runner-runbook.md` 存在，`<a id="install">` 在 117 行、`<a id="pause-and-resume">` 在 134 行）；唯一改的中文锚点 `#d21期限后交付测试的受控计时器`（↔ 标题 `## D21：期限后交付测试的受控计时器`，audit-plan 第 462 行，全角冒号被 GitHub 和脚本同样去除，slug 一致）；治理文档链到 `docs/lessons.md#adr-number-collision`（↔ lessons.md:723 的 `<a id>`，存在）。两端校验均闭合，未发现 I-73 式「生成端没问使用端」的断层。
