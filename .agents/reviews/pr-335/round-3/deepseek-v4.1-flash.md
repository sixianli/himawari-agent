## 复核结论（按严重度）

### 1. 中｜`scripts/check-docs-links.mjs:59-63`、`scripts/check-adr-numbers.mjs:41-54`、`package.json:27`
**问题：同一个锚点值现在由两套算法各自校验，规则不一致。**
`check:steps` 里同时有 `check:adr-numbers` 和 `check:docs-links`，两者都会检查“从 `docs/` 指向 `docs/adr/*.md#锚点`”的链接，但两套 `anchorsOf` 不同：
- `check-docs-links` 用 marked 令牌、去链接文本、去 HTML 标签、按 GitHub 避让重复标题；
- `check-adr-numbers` 仍是原始正则，**不去代码围栏、不去标题里的链接、不处理重复标题**（`HEADING = /^#{1,6}\s+(.+)$/gm`，`headingSlug` 不替换 `[...](...)`）。

证据（亲自读到）：
```js
// check-docs-links.mjs:41-52
walkTokens(lex(text), (token) => {
  if (token.type === "html") ... anchors.add(match[1]);
  if (token.type !== "heading") return;
  const base = headingSlug(token.text);   // 去 HEADING_LINK、HTML_TAG，重复标题加 -1、-2
  ...
});
// check-adr-numbers.mjs:49-53
function anchorsOf(text) {
  for (const match of text.matchAll(EXPLICIT_ANCHOR)) anchors.add(match[1]);
  for (const match of text.matchAll(HEADING)) anchors.add(headingSlug(match[1])); // 不去链接、不去围栏、不避让
}
```
后果：一个本来就合法的 ADR 链接可能被 `check:adr-numbers` 判失败（例如目标是重复标题生成的 `#foo-1`，或标题里含 Markdown 链接），而 `check-docs-links` 认为存在；反过来，围栏代码里的 `# ...` 行会被 `check-adr-numbers` 当成锚点，让断链在那边通过而 `check-docs-links` 报错。这正是 I-73 的“同一个值被两个消费者用不同规则校验”。当前 docs 是否已经触发未核实（我没有运行 `npm run check`），但规则上已经不一致。

**建议：** 抽出唯一的 `anchorsOf`/GitHub slugger 实现，供 `check-docs-links`、`check-adr-numbers`、`check-instruction-links` 共用；或删掉 ADR 检查里重复的锚点校验，交给 `check-docs-links`。补一条“ADR 重复标题 `#foo-1`”和“ADR 标题含链接”的交叉用例。

---

### 2. 中｜`test/tooling/docs-links.test.mjs:58-67`、`scripts/check-docs-links.mjs:24-31`
**问题：表格单元格、列表项、引用块这些“会含链接的容器”没有正向反向用例，作者声称的处理没有被测试守住。**
现有唯一相关用例只证明“这些容器里的**代码块**链接会被忽略”；如果 `walkTokens` 根本不递归 `items`/`tokens`，或者删掉 table 分支，这些断言仍然通过（因为“漏报”和“正确忽略”结果相同）。证据是代码里专门有：
```js
if (token.tokens) walkTokens(token.tokens, visit);
if (token.items) walkTokens(token.items, visit);
if (token.type === "table")
  for (const cell of [...token.header, ...token.rows.flat()]) walkTokens(cell.tokens, visit);
```
但测试文件里没有任何“表格单元格/列表项/引用块里有一个**真实坏链**应报错”的用例。

**建议：** 增加 fixtures：
- 表格 header 和 body 单元格各一个 `[x](gone.md)`；
- 列表项（含嵌套列表）里的坏链；
- 引用块里的坏链；
- 表格单元格里的图片坏链。
这样删掉任一容器遍历分支时测试会红。

---

### 3. 低-中｜`scripts/check-docs-links.mjs:62`、`.agents/instructions/document-governance.md:28`
**问题：参考式定义分支可能是死代码，文档却写“参考式定义都查”。**
代码依赖 `token.type === "def"`：
```js
if (token.type === "def" && !token.tag.startsWith("^")) targets.add(token.href);
```
而测试里所有相对参考式定义（`[r1]: b.md`、`[r2]: gone.md`）都被正文 `[甲][r1]` 引用，最终由解析后的 `link` 令牌命中；**没有任何“只定义、不被引用”的相对定义反向用例**。根据 marked 的公开实现，块级解析会把 def 收进 `tokens.links` 而不放进返回的 token 数组（本仓库未安装 `node_modules`，无法直接读 marked 18 源码，此点标为**推测/未核实**）。如果属实，该分支永远走不到，未引用的相对定义不会被检查，而 `document-governance.md:28` 写的“参考式定义都查”与实际不符。

**建议：** 二选一：删掉该分支并把文档改成“被引用的参考式链接”；或用 `lexer.tokens.links` 显式遍历所有定义并补一条“未被引用的 `[r]: gone.md` 应报错”的反向用例。先把 marked 的行为在测试里钉住。

---

### 4. 低｜`scripts/check-docs-links.mjs:60`
**问题：用 `raw.startsWith("[^")` 判断脚注，会跳过合法的普通链接。**
```js
if ((token.type === "link" || token.type === "image") && !token.raw.startsWith("[^"))
```
`[^caret](gone.md)`、`[^note][ref]` 这类链接文本以 `^` 开头的正常链接会被当成脚注直接跳过，形成漏报。

**建议：** 按语义判断：只跳过标签确实以 `^` 开头且能在参考定义表里对应脚注的链接；或把脚注定义和脚注引用单独识别，不要用 raw 前缀。

---

### 5. 低｜`scripts/check-docs-links.mjs:11,16`
**问题：`HEADING_LINK` 正则处理不了链接文本里的嵌套方括号或 URL 里的 `)`。**
```js
const HEADING_LINK = /\[([^\]]*)\]\([^)]*\)/g;
```
`## [a [b] c](x.md)`、`## [x](a(b).md)` 这类标题算出的 slug 会与 GitHub 不同，可能误报或漏报锚点。当前 `docs/` 里标题内的链接都是简单文本/带 `#fragment` 的路径（我 grep 到的 8 处），所以**当前没有实际触发**，属边界问题。

**建议：** 用 marked 已解析的 heading 子令牌取纯文本（遇到 `link` 令牌用其 `text`），不要再用正则重解析标题。

---

### 6. 低｜`scripts/check-docs-links.mjs:113`
**问题：`inside.startsWith("..")` 会把仓库内以 `..` 开头的合法路径判成仓库外。**
```js
const inside = path.relative(root, destination);
if (inside.startsWith("..") || path.isAbsolute(inside) || !existsSync(destination))
```
仓库内文件/目录名为 `..cache.md`、`..data/x.md` 时，`path.relative` 得到 `..cache.md`，被当成越界。建议改成 `inside === ".." || inside.startsWith(".." + path.sep)`。

---

## 侧重检查

- **路径穿越 / 仓库外落点：** 亲自核对了 `../../outside.md`、`/docs/b.md`、`//example.com/x`、`%2e%2e` 经 `decodeURIComponent` 后再 `path.relative` 的路径。`decode` 有 try/catch（81-87），`inside` 检查在 `existsSync` 之前（112-115）；`path.join(root, "/...")` 仍是仓库相对，未发现能读到仓库外文件或执行任意读的路径。**结论：可接受。**
- **符号链接：** 源文件通过 `lstatSync(...).isSymbolicLink()` 跳过（74）；目标锚点读取前用 `lstatSync(destination).isFile()`（117），不会顺着符号链接读仓库外文件。代价是指向符号链接 `.md` 的锚点不校验（静默通过），属轻微漏报。**结论：安全，但漏检一处未记录在文档。**
- **不合规范/不可信输入：** 无效百分号编码被 catch 吞掉；marked 解析畸形 Markdown 未发现会抛出的路径；NUL/超长路径由 `existsSync` 返回 false 处理。**结论：未发现崩溃点。**
- **资源耗尽 / 不可撤销操作：** 脚本只读，不写文件、不联网、不启动子进程；递归扫描 `docs/` 且跳过符号链接目录，不会无限递归；锚点结果有缓存。**结论：无不可撤销操作，资源开销与 docs 体量线性。**
- **规则/文档与代码一致：** `check:docs-links` 已在 `package.json:27` 的 `check:steps` 和 `package.json:98` 注册，`run-all-checks` 的 `stepNames` 正则可接受该名字，`run-all-checks.test.mjs:73` 有断言；ADR 0133 去掉 `scripts/check-docs-governance.mjs` 链接也正确（该文件 glob 确认不存在，否则新检查会报 `DOCS_LINK_MISSING`）。**唯一明确不一致是上面第 3 条的“参考式定义都查”。**

---

## 必答问题

**1. 会不会改变模型已经见过的请求开头？**
不会。改动只涉及 `scripts/check-docs-links.mjs`、测试、`package.json` 和 `.agents/instructions/*`/ADR 文档；`grep` 确认没有任何 prompt 组装、历史存储、遮盖代码引用这些文件/脚本。发给模型的内容仍然只在末尾追加，每轮变化的值也不在这条链路上。需要说明：`.agents/instructions/delivery-mode.md`、`document-governance.md` 是代理会话会读的指令文本，改了它们会影响**新会话**读到的说明；按规则第 6 条这只对新对话生效，已有会话的冻结系统提示不会被改写。**未核实：** 我没有运行 prompt-prefix 门槛，但读代码未发现请求组装路径被触及。

**2. 会不会让同一段文字在不同请求里变成不同字节？**
不会。这个检查器不是模型请求的一部分；其自身输出也是确定的：文件按 `readdirSync(...).sort()` 遍历，`Set`/`Map` 用插入顺序，没有时间、随机数、对象无序遍历。错误列表顺序确定。

**3. 有没有自动检查，反向用例真会失败？**
有：`check:docs-links` 已接入 `npm run check`，测试文件有 12 个用例；角括号/转义/标题、重复标题加链接、脚注、仓库外路径、archive 锚点这些反向用例，删掉对应保护后确实会红。**但覆盖不完整：** 表格单元格/列表项/引用块里的**真实坏链**没有被测试（删掉 `items`/table 分支仍绿）；重复标题的“已存在 `foo-1`”避让分支、HTML 标签剥离、未被引用的参考式定义都没有用例。

**4. 改动产生/修改的每个值，所有消费者都能接受吗？**
- `check:docs-links` 脚本名：`package.json:98` 产生，`check:steps:27`、`stepNames`、`run-all-checks.test.mjs:73` 消费，均接受；脚本/test/`marked` 依赖都存在。✅
- `DOCS_LINK_MISSING`、`DOCS_ANCHOR_MISSING`：脚本 114/119 产生，测试与文档消费，一致。✅
- `docs/_archive`、符号链接、`<a id>`、代码块等行为：与 `document-governance.md:28` 基本一致，**只有“参考式定义都查”这一点无法由现有测试证明**（问题 3）。
- **锚点值**：新增的 `docs-links` 与既有 `check:adr-numbers` 同时消费 ADR 锚点，但校验规则不同（问题 1），这正是 I-73 要求的“两端校验都要核对”，目前两端不一致。❌

**未核实：** 我没有实际运行 `npm run check`/`check:docs-links`（工具只允许读和 git），所以“当前 docs 全绿”只能从代码推断，不能确认。
