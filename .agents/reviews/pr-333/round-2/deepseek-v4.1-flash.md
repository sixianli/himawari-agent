# 复核结论（PR 333，af1b9857 相对 80751b39 的增量）

这次改动没有高严重度问题：它只改了工具脚本、测试和文档，不触碰运行时请求组装，也没有改动后端协议。下面按严重度排，逐条附我亲自读到的代码。

---

## 1. 中——只查行内 Markdown 链接，漏掉改号后同样会静默失效的两类 ADR 引用

- 文件:行：`scripts/check-adr-numbers.mjs:33`, `:87-95`；样例 `docs/adr/0041-test-hosts-and-production-server.md:6`；`docs/lessons.md:734`
- 问题：检查只匹配 `](目标)`。仓库里大量 ADR 引用不是行内链接：
  - `frontmatter` 的 `supersedes` / `superseded_by` 字段，例如 0041：`superseded_by: "docs/adr/0057-batch-layers-one-two-for-small-defects.md"`；
  - 遍布 `docs/` 的 `[SOURCE: docs/adr/NNNN-....md]` 标记，例如 `docs/execution/specs/2026-08-26-portable-durable-web-agent-design.md:33` 的 `[SOURCE: docs/adr/0001-pi-runtime-adapter.md]`（grep 命中 100+ 条）。

  这些在 ADR 改号后都会指向旧文件名，但新检查完全看不到。作者自己的 lessons 里就写过 `superseded_by` 引用是改号必须处理的点（`docs/lessons.md:734`：“出口那份被 ADR 0146 文件开头的 `superseded_by` 字段引用，改它的编号要动 ADR 的生命周期字段”），与“防改号后漏改”的目标直接相关。
- 证据（读到的代码）：
  - `const MARKDOWN_LINK = /\]\(([^)\s]+)\)/g;`（`check-adr-numbers.mjs:33`）
  - 链接处理只遍历 `text.matchAll(MARKDOWN_LINK)`（`:87`）
  - 0041 的 frontmatter 行确实是 `superseded_by: "docs/adr/0057-....md"`。
- 补充：`check-instruction-links.mjs` 也只看 `](...)` 和反引号路径，并不覆盖 `[SOURCE: ...]`；`check-v0.2-coverage.mjs:98` 只解析“来源 Spec”，不解析 ADR 的 SOURCE。
- 建议：把 `docs/adr` 的 `supersedes`/`superseded_by` 和 `[SOURCE: docs/adr/...]` 一并纳入检查，或者在 `document-governance.md` / `lessons.md` 里明确写出“本检查不含这两类引用”的限制，避免下一批人误以为已经全覆盖。

## 2. 中——`docs/adr` 自身没有沿用第 2 轮的“跳过符号链接”，不可信输入可拖住 `npm run check`

- 文件:行：`scripts/check-adr-numbers.mjs:117-120`（读取 ADR 正文），`:100`（读链接目标正文）；对照 `:59-62` 只对 `docs` 遍历做了 `lstat`
- 问题：第 2 轮给 `markdownFiles` 加了 `lstatSync` 和 `isSymbolicLink()` 防护，但标题检查直接 `readFileSync` 读取 `docs/adr` 下所有 `*.md`，没有 `lstat().isFile()` 检查，也没有大小上限。一个恶意 PR 只要在 `docs/adr/` 放一个名为 `0195-x.md` 的符号链接指向 `/dev/zero`（或超大文件），`npm run check` 就会无限读取/耗尽内存；名字以 `.md` 结尾的目录还会让 `readFileSync` 抛 `EISDIR`（未捕获异常）。链接目标（`:100`）同样是 `readFileSync` 跟随符号链接。
- 证据（读到的代码）：
  - `const names = readdirSync(directory).filter((name) => name.endsWith(".md")).sort();`
    `const titles = names.map((name) => [name, readFileSync(path.join(directory, name), "utf8")]);`（`:117-120`）
  - 只有 `markdownFiles` 里是 `lstatSync(...).isDirectory()` / `!lstatSync(...).isSymbolicLink()`（`:59-62`）。
  - `run-all-checks.mjs:36` 用 `spawnSync(npm, ["run", name], { stdio: "inherit" })`，没有单步超时，卡住就整条 `npm run check` 卡住。
- 建议：读取前对 `docs/adr` 的每个条目做 `lstat`，只接受普通文件（或明确决定是否接受指向仓库内普通文件的符号链接），并给读入大小设上限；对链接目标同样加 `isFile` 检查。

## 3. 低——Markdown 链接正则覆盖不全，且会把代码块/行内代码里的示例当真链接 [部分为推测]

- 文件:行：`scripts/check-adr-numbers.mjs:33`, `:87`
- 问题：`/\]\(([^)\s]+)\)/g` 不认 `](path "title")`、`](<含空格的路径>)`、引用式链接 `[text][ref]`、以及含转义括号/空格的合法目标；反过来它不区分代码围栏和行内代码，文档里作为示例写的 `[x](adr/0001.md)` 也会被当链接检查。
- 证据：正则本身（`:33`）；`check-instruction-links.mjs:13` 用的是同一个简化正则。
- 现状：我在 `docs/`、`docs/adr` 里检索过 `](../adr/...`、`](/docs/adr/...)`、`](...adr/... "title")`、`](<...>)`、引用式定义以及代码中的 ADR 链接，未发现当前会触发的实例，所以这是潜在误报/漏报，而非本次会红。
- 建议：至少跳过 ``` 围栏与行内代码，并处理 title 和 `<...>` 形式；更稳妥的是用现成 Markdown 解析器取链接 token。

## 4. 低——以 `/` 开头的仓库内链接会被解析到文件系统根，产生误报 [潜在]

- 文件:行：`scripts/check-adr-numbers.mjs:90`
- 问题：`path.resolve(path.dirname(...), relative)` 把 `/docs/adr/0001-a.md` 解析为文件系统绝对路径，而 GitHub 把前导 `/` 当作仓库根。若以后有人写这种合法链接，检查会报 `ADR_LINK_MISSING`。
- 证据：`:90` 的 `path.resolve(...)`；当前 `docs/` 中没有 `](/docs/adr/...)` 或 `](/adr/...)`（检索无命中），所以暂时不触发。
- 建议：目标以 `/` 开头时改为相对仓库根解析（`path.resolve(root, "."+relative)`）。

## 5. 低——锚点规则与 GitHub 不完全一致，且与 `check-instruction-links` 的同一逻辑重复

- 文件:行：`scripts/check-adr-numbers.mjs:39-52`；对照 `scripts/check-instruction-links.mjs:34-47`
- 问题：`headingSlug` 是简化版，不处理重复标题的 `-1` 后缀、标题内含链接时的“只取链接文字”、百分号编码锚点（`#%E7%BB%93...`）。当前 ADR 里被检查的锚点都是显式 `<a id="...">` 且是 ASCII（我检索了带中文锚点的 ADR 链接，只有 `docs/archive` 里一条，被排除），所以不会触发；但规则在两个脚本里各抄一份，将来一处改动另一处不跟，就是 I-73 那类“两边校验看似一致、实际会分叉”的风险。
- 证据：两段 `headingSlug`/`anchorsOf` 逐行相同（`check-adr-numbers.mjs:39-52` 与 `check-instruction-links.mjs:34-47`）。
- 建议：抽成共享模块；若要让“锚点存在”与 GitHub 实际渲染一致，补上重复标题和 URL 解码的处理。

## 6. 低——文档描述的范围比实现窄

- 文件:行：`.agents/instructions/document-governance.md:28` 对照 `scripts/check-adr-numbers.mjs:91-95`
- 问题：文档说检查“`docs/`（不含 `docs/archive`）里指向 `docs/adr/` 下 ADR 文件的链接”，实现是按“解析后落点的父目录名叫 `adr` 且文件名符合 `ADR_FILE`”判断，所以 `docs/execution/adr/0001-x.md` 这种非 `docs/adr` 的目标也会被检查，`docs/adr` 里的裸文件名互链也在范围内。行为本身合理（作者在“第 2 轮”里也这么说明），但治理文档的措辞会让后来人误判范围。
- 证据：`document-governance.md:28` 原文；`check-adr-numbers.mjs:92` 的 `path.basename(path.dirname(destination)) !== "adr"`。
- 建议：把文档改成“落点在名为 `adr` 的目录、且文件名符合 ADR 命名规则的链接”，或把实现收紧为仅 `docs/adr`。

## 7. 低——第 2 轮新加的硬化没有自动检查，反向用例不覆盖

- 文件:行：`test/tooling/adr-numbers.test.mjs:81-115`
- 问题：现有反向用例覆盖了标题号错、旧文件名、锚点不存在、错层、archive 不检查、`docs/adr` 裸链接；但没有覆盖第 2 轮新增的行为——跳过符号链接、按文件名排序带来的确定性、以及代码块/链接 title 的误报形态。把 `lstat`/`isSymbolicLink()` 或 `.sort()` 改回去，这些测试仍会全绿。
- 证据：测试文件里没有任何 `symlinkSync` 调用；断言只针对错误数组内容（`:104-110`）。
- 建议：补三条：目录中符号链接被跳过（不读取、不报错）、两个文件名乱序时错误输出顺序固定、代码围栏里的 ADR 链接不被报错。

---

## 读代码证实的 / 推测的

**读代码或检索证实的：**
- 第 1 条的 `[SOURCE: ...]`、frontmatter 引用存在且不在新检查的匹配范围内。
- 第 2 条的 `readFileSync` 路径没有 `lstat`/`isFile`；第 2 轮的 `lstat` 只加在 `markdownFiles` 上。
- 第 3、4、5 条的正则/解析实现细节；当前仓库未出现会触发的实例（检索结果为空）。
- 第 6 条的文档与代码措辞差异。
- 第 7 条测试覆盖范围。
- `npm run check:adr-numbers` 已在 `package.json:27`（`check:steps`）和 `:34` 中接入。

**推测/未核实：**
- 指向 `/dev/zero` 的符号链接会导致无限读取/OOM 是按 Node `readFileSync` 行为推断的，未实际复现。
- 作者说的“193 份 ADR 标题全部等于文件名”“main 上全部通过”“9 条测试通过”“变异检查会失败”我**没有运行**（工具限制只允许读和 git 命令），只抽查了多份 ADR 的标题与常见显式锚点，均符合预期；完整的 193 份和测试执行结果标记为**未核实**。
- 第 3 条“代码块误报”是潜在风险，未发现当前触发。

---

## 侧重检查

- **错误路径**：`docs` 不存在、`docs/adr` 不存在、空目录由既有逻辑处理并有测试（`checkAdrNumbers:107-116`，测试 `:49-54`）。未处理的是 `docs/adr` 下的符号链接/同名目录读取错误（见第 2 条）。
- **不合规范/不可信输入**：ADR 文件名、标题号、链接目标、锚点都来自仓库内容。标题和链接的匹配是确定性的；裸链接现在也被检查（第 2 轮确实生效）。遗漏面是 `[SOURCE: ...]`、frontmatter、引用式链接（第 1、3 条）。
- **安全**：脚本只读不写，不输出文件内容，不接触秘密；`path.resolve` 可借 `..` 解析到仓库外，但要求父目录叫 `adr` 且文件名符合 ADR 规则，最多读到外部文件内容用于算锚点，影响很低。
- **资源耗尽**：遍历有排序、无环（符号链接已跳过）；但 `docs/adr` 正文读取没有大小/符号链接防护（第 2 条），且 `run-all-checks` 无单步超时，因此一个恶意 ADR 文件就能拖住整个 `npm run check`。
- **不可撤销操作**：无（check 只读）。
- **规则/文档一致性**：`document-governance.md`、`lessons.md` 与代码大体一致；范围措辞与实现有偏差（第 6 条）；新错误码 `ADR_NUMBER_TITLE`、`ADR_LINK_MISSING`、`ADR_LINK_ANCHOR_MISSING` 与代码一致。

---

## 必答问题

**1. 会不会改变模型已经见过的请求开头？**
不会。改动只涉及 `scripts/check-adr-numbers.mjs`、`test/tooling/adr-numbers.test.mjs`、两份开发文档（`.agents/instructions/document-governance.md`、`docs/lessons.md`）、两处文档断链和复核记录。没有任何运行时代码、系统提示、工具定义、历史消息、遮盖逻辑被修改；我用 grep 在 `*.ts` 中未找到读取 `document-governance.md`、`lessons.md`、`docs/incidents-and-gates.md` 的运行时代码。按 [prompt-prefix 规则](.claude/rules/prompt-prefix.md#rules) 第 4、6 条，这不会让已发请求开头变字节，也不涉及“只在末尾追加”以外的排序。**未核实**：代码复核框架自身如何把 `.agents/instructions` 注入复核代理的提示，那不属于产品模型请求。

**2. 同一段文字会不会在不同请求里变成不同字节？**
不会。这些都是离线检查：错误消息只含固定错误码和仓库相对路径/链接原文，不含时间、哈希或随机值；第 2 轮给 ADR 标题和 `docs` 遍历都加了 `.sort()`，`findAdrNumberProblems` 内部也排序（`:13`），错误输出顺序确定。锚点集合 `Set` 只用于 `.has()`，不参与序列化。没有改变任何序列化格式。

**3. 有没有对应的自动检查，反向用例真的会失败？**
有。`package.json:34` 的 `check:adr-numbers` 同时跑脚本和 `test/tooling/adr-numbers.test.mjs`，并在 `:27` 的 `check:steps` 里。反向用例覆盖：标题号与文件名不一致（测试 `:81-89`）、旧文件名链接、锚点不存在、相对路径层数错（`:91-111`）、archive 不检查（同一条的精确错误数组）、`docs/adr` 裸文件名互链（`:99-106`）。从代码看，删掉对应检查这些断言会失败。**未核实**：我没有实际运行 vitest，执行结果以作者说法为准；另外第 2 轮的符号链接跳过与排序没有反向用例（见第 7 条）。

**4. 改动产生/修改的每个值，使用方都能接受吗？**
- 新错误码 `ADR_NUMBER_TITLE`、`ADR_LINK_MISSING`、`ADR_LINK_ANCHOR_MISSING`：只出现在脚本输出、测试断言和两份文档；仓库里没有任何解析这些错误码的程序或配置清单（grep 确认），`npm run check` 只看退出码，因此两端没有格式约束冲突。
- `ADR_FILE` 正则：现在是唯一一处定义，用在文件名校验（`:15`）、标题校验（`:70`）、链接落点校验（`:93`），三处一致；原来重复的 `ADR_LINK_TARGET` 已被删除，方向正确。
- 锚点规则（`headingSlug`/`anchorsOf`）仍在 `check-adr-numbers.mjs` 与 `check-instruction-links.mjs` 各有一份，目前逐行相同，属于 I-73 式的“两边重复、将来可能分叉”风险，建议抽公共模块。
- 未覆盖的“使用方”是 frontmatter 的 `supersedes`/`superseded_by` 和 `[SOURCE: docs/adr/...]`——它们没有校验，见第 1 条。
