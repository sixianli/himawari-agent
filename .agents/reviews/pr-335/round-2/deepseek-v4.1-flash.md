## 总体判断

改动方向正确，新解析比上一轮稳健，我**没有发现会让当前仓库立刻漏掉既有断链的证据**，也没有发现灾难性回溯。但有 1 个中等级别的围栏漏识别（会让围栏后面的链接被静默跳过）、1 个中等程度的测试假覆盖，以及若干低级别的边界和文档不一致。作者说明基本与代码相符，但“反向用例”“三种标题引号”这两点在测试覆盖上说得偏满。

---

## 读代码证实的发现

### 1【中】列表标记开头的围栏识别不到，会把“结束围栏”当成“开始围栏”，导致后面的链接被静默跳过

文件：`scripts/check-docs-links.mjs:14`、`:31-44`

问题：`FENCE_OPEN` 只允许围栏前是空白或 `>`：

```js
const FENCE_OPEN = /^[ \t>]*(`{3,}|~{3,})/;
```

于是下面这种合法的 CommonMark 写法（围栏紧跟在列表标记后）不会在开围栏那一行被识别：

```md
- ```
  [x](nope.md)
  ```
之后的链接 [y](also-nope.md)
```

实际执行顺序会变成：

1. `- ``` ` 不匹配 `FENCE_OPEN`，按正文保留；
2. `  [x](nope.md)` 也不匹配，作为正文被检查（多报）；
3. `  ```` ` 反而匹配 `FENCE_OPEN`，被当成开围栏：

```js
const match = FENCE_OPEN.exec(line);
if (match && !(...)) {
  open = match[1];
  kept.push("");
  continue;
}
```

4. 之后直到下一个围栏之前的全部内容都变成空行，`[y]` 等链接**完全不被检查**。

这既有误报，也会造成真正的漏报，对一个用来“拦住改坏链接”的门槛来说风险偏高。我 grep 了当前 `docs/`，暂时没有 `- ```` / `1. ```` 这种写法，所以现在还没触发，但以后写文档很容易遇到。

建议：围栏识别要识别列表容器前缀，或者更稳妥地用仓库已有的 `marked`（`package.json:108` 已依赖 `marked@18.0.5`）做词法分析，按 token 跳过代码块和代码 span；至少要让“一个未匹配的开围栏”不能在后续行被误当成开围栏。

### 2【中】“仓库外目标算断链”的反向用例并没有真正验证这条新逻辑

文件：`scripts/check-docs-links.mjs:121-123`、`test/tooling/docs-links.test.mjs:100-108`

脚本：

```js
const inside = path.relative(root, destination);
if (inside.startsWith("..") || path.isAbsolute(inside) || !existsSync(destination)) {
  errors.push(`DOCS_LINK_MISSING ${file} -> ${target}`);
```

测试：

```js
"docs/a.md": "[1](../../outside.md) [2](/docs/b.md) [3](//example.com/x)\n",
...
expect(checkDocsLinks({ root }).errors).toEqual([
  "DOCS_LINK_MISSING docs/a.md -> ../../outside.md",
]);
```

`../../outside.md` 在 fixture 里**根本不存在**，所以只要 `!existsSync(destination)` 就能产生这条错误。把 `inside.startsWith("..") || path.isAbsolute(inside) ||` 整段删掉，这个用例仍然会通过，`[2]`、`[3]` 也不受影响。这个用例实际只验证了“不存在的文件会报错”，没有验证“存在于仓库外、但确实存在的文件也算断链”。

建议：测试里在 root 外（例如 `dirname(root)` 下）真的创建一个文件，再让文档链接到它，断言仍报 `DOCS_LINK_MISSING`；否则这条新分支没有回归保护。

### 3【中低】文档对“代码块 / 符号链接不查”的描述宽于实际实现；`delivery-mode.md` 的检查清单也过期了

文件：`.agents/instructions/document-governance.md:28`、`.agents/instructions/delivery-mode.md:18`

`document-governance.md` 写：

```text
... 代码块和行内代码里的、符号链接文件不查 ...
```

实际只处理了围栏代码块和单反引号行内代码：

```js
function withoutCode(text) {
  return stripFences(text).replace(INLINE_CODE, "");
}
```

4 空格缩进代码块（CommonMark 的 indented code block）没有跳过；上面第 1 条那种“列表标记 + 围栏”的代码块也没有正确跳过。因此“代码块不查”这个说法不成立。另外“符号链接文件不查”只对**源文件**成立（`docsMarkdownFiles` 里 `lstatSync(...).isSymbolicLink()` 跳过），对**链接目标**仍会做 `existsSync`；只是锚点检查因为 `lstatSync(...).isFile()` 对符号链接为 false 而被跳过。

`delivery-mode.md:18` 仍然这样枚举 `npm run check`：

```text
`npm run check`（格式、lint、...、指令文件里的链接和路径是否都还存在（`npm run check:instruction-links`）、布局审查 ...）。它不包含文档校验
```

这次把 `check:docs-links` 加进了 `check:steps`，但这里没有同步；在新增一个 `docs/` 链接门槛后，“它不包含文档校验”至少会被误读。

建议：把 `document-governance.md` 改成“围栏代码块、行内代码”并说明缩进代码块和列表围栏的边界；同步更新 `delivery-mode.md:18` 的检查清单，或改为不再逐项枚举、只指向 `check:steps`。

### 4【低】脚注定义会被当成参考式链接定义，产生新的误报

文件：`scripts/check-docs-links.mjs:11`

```js
const REFERENCE_DEFINITION = /^[ \t>]*\[[^\]\n]+\]:[ \t]*(<[^>\n]*>|\S+)/gm;
```

GitHub 支持脚注 `[^1]`，定义写作：

```md
[^1]: 这是脚注正文
```

`[^\]\n]+` 会匹配 `^1`，于是把 `这是脚注正文` 的第一个词当作链接目标，报 `DOCS_LINK_MISSING`。当前 `docs/` 没有脚注（我 grep 过 `^[ \t>]*\[\^...\]:`），但这是新增参考式解析后才有的误报类别。

建议：排除以 `^` 开头的 label，或者改用 `marked` 的词法结果区分 footnote definition 与 link reference definition。

### 5【低】目标文件的显式锚点在行内代码里也会被当成真实锚点

文件：`scripts/check-docs-links.mjs:52-55`、`:12`

```js
function anchorsOf(text) {
  const prose = stripFences(text);
  ...
  for (const match of prose.matchAll(EXPLICIT_ANCHOR)) anchors.add(match[1]);
```

但源文件链接解析用的是 `withoutCode`（会删掉行内代码）。于是文档里如果出现：

```md
示例：`<a id="fake"></a>`
[跳到 fake](#fake)
```

`anchorsOf` 会把代码里的锚点算进去，链接检查通过；GitHub 上这个锚点并不存在。当前 `docs/` 没有这种写法（grep 过），属于潜在漏报。

建议：`anchorsOf` 也先调用 `withoutCode`，或至少先删除行内代码再收集显式锚点。

### 6【低】标题识别和 GitHub 在几个边界上不一致

文件：`scripts/check-docs-links.mjs:13`、`:18-25`、`:56-62`

```js
const HEADING = /^#{1,6}[ \t]+(.+)$/gm;
```

- CommonMark 允许 ATX 标题前有最多 3 个空格，这里不识别；引用块里的 `> ## 标题` 也不识别。若文档链接到这类标题的锚点，会误报 `DOCS_ANCHOR_MISSING`。当前 `docs/` 没有缩进标题或引用块标题（已 grep）。
- 重复后缀只按同 slug 计数：

```js
const count = seen.get(slug) ?? 0;
seen.set(slug, count + 1);
anchors.add(count === 0 ? slug : `${slug}-${count}`);
```

如果标题依次是 `Foo`、`Foo`、`Foo-1`，这里会给第三个生成 `foo-1`（与第二个冲突后集合并集吞掉），而 GitHub 的 slugger 会继续避让成 `foo-1-1`。这会造成 `#foo-1-1` 被误报缺失。当前没有这种标题组合。
- `headingSlug` 只剥行内链接、不剥行内 HTML 标签；例如标题里有 `<code>x</code>` 时，与 GitHub 的 slug 可能不同。这一条对 GitHub 的具体行为属于**推测**，我没有用 GitHub 实测。

建议：用 `marked` 取标题的 token 文本，再按 GitHub slugger 的规则生成；至少补上 1–3 空格缩进和重复后缀避让。

### 7【低】参考式定义只支持单行，支持不了 CommonMark 的续行写法

文件：`scripts/check-docs-links.mjs:11`

```js
const REFERENCE_DEFINITION = /^[ \t>]*\[[^\]\n]+\]:[ \t]*(<[^>\n]*>|\S+)/gm;
```

CommonMark 允许：

```md
[r1]:
  b.md
```

或 URL 与 title 分行。这里只匹配定义的第一行，`\S+` 拿不到下一行的目标，属于漏报。当前 `docs/` 里的参考式定义全部是单行外部 URL（26 处，全部 `https:` 被跳过），所以暂未触发。

建议：用 Markdown 解析器的 definition token，或至少支持目标在下一行的情况。

### 8【低】转义处理把“反斜杠 + 任意字符”都去掉反斜杠，比 CommonMark 宽

文件：`scripts/check-docs-links.mjs:70-73`

```js
return inner.replace(/\\(.)/g, "$1");
```

CommonMark 的反斜杠转义只对 ASCII 标点生效；`\b` 应保持为字面反斜杠加 `b`。这里会把 `a\b.md` 变成 `ab.md`，对含反斜杠的合法文件名会判错。当前仓库没有这类目标。

建议：只对 CommonMark 允许转义的标点做 unescape（`[!-/:-@[-`{-~]` 之类），其余保留反斜杠。

### 9【低】多反引号行内代码没被删除，可能把代码里的 `[...]: ...` 当成参考式定义

文件：`scripts/check-docs-links.mjs:15`、`:48-49`、`:11`

```js
const INLINE_CODE = /`[^`\n]*`/g;
```

这个正则只处理单反引号代码 span。像 `` ``[r]: gone.md`` `` 这种双反引号代码，会被拆成两个空代码 span，文本里仍留下 `[r]: gone.md`，随后被 `REFERENCE_DEFINITION` 当成真实定义而误报。旧实现也有“多反引号代码不被删除”的问题，但旧实现不检查参考式定义，所以这个误报类别是这次新增的。

建议：改用解析器；或至少实现 CommonMark 的反引号串匹配（按开闭反引号长度相等配对）。

### 10【低】测试没有真正覆盖围栏判断里的关键分支

文件：`scripts/check-docs-links.mjs:37-38`、`test/tooling/docs-links.test.mjs:58-64`

测试的“围栏样式行内代码”是：

```js
"- 项\n  ```md\n  [x](nope.md)\n  ```\n> ```\n> [y](nope.md)\n> ```\n用 ```code``` 表示 [z](nope.md)\n"
```

最后一行以 `用` 开头，`FENCE_OPEN` 的 `^[ \t>]*` 根本不会匹配，所以下面这个守卫的第二个条件从未被验证：

```js
if (match && !(match[1][0] === "`" && line.slice(match[0].length).includes("`"))) {
```

把 `!(...)` 整段删掉，这个用例结果不变。另外作者说“三种标题引号”，但测试只出现了单引号 title（`[5](d.md 'title')`）；双引号 `"title"` 和括号 `(title)` 没有用例（不过 `checked: 6` 确实保证了单引号这一种被匹配到）。

建议：加一行以 ``` ```code``` ``` 开头的用例来验证守卫；补双引号和括号 title 的 `checked`/缺失目标用例；补“列表标记 + 围栏”的用例，它正好也会暴露第 1 条问题。

---

## 推测 / 未核实

- **未核实**：我没有运行 `npm run check`，因此不能确认当前整个 `docs/` 在重写后的解析器下一定全绿。静态检索没有发现会被新解析器新暴露的本地链接（没有本地参考式定义、没有角括号/带空格/嵌套括号/根相对目标），但这是检索结论，不是运行结论。
- **未核实**：`.agents/reviews/pr-335/round-1/*` 与 `usage.jsonl` 被工具按“记录路径”拒绝读取，无法核对上一轮 judgments 的具体条目，也无法确认这些新增记录里是否有会被 `check:secrets` / gitleaks 认成密钥的文字。
- **推测**：GitHub 是否确实为引用块内的标题生成锚点、以及带行内 HTML 的标题 slug 具体如何计算，我没有用 GitHub 实测；第 6 条里这两点请按“与官方 slugger 可能不一致”对待。

---

## 侧重检查

- **错误路径**：`decodeURIComponent` 有 `try/catch` 回退；不存在的目标、目录当文件、非 `.md` 目标都有分支处理；`existsSync` 与 `lstatSync` 之间有 TOCTOU 窗口，理论上文件被删/替换会抛异常，但这是只读的 CI 检查，异常也会以非零退出（fail-closed），不构成放行风险。读取目标锚点时如果目标不可读会抛异常，同样是 fail-closed。
- **不合规范或不可信的输入**：重点查了列表标记围栏、缩进代码块、脚注、多行参考式定义、嵌套括号目标、转义标签、多反引号代码 span、缩进/引用块标题、重复标题后缀、符号链接目标。结论见上面第 1、4–9 条。
- **安全**：脚本不写文件、不执行外部命令；`inside` 检查会拒绝 `../` 越出仓库；符号链接目标虽然在词法路径上仍算“仓库内”，但锚点检查因为 `lstatSync(...).isFile()` 不跟随符号链接而跳过，没有读取仓库外文件内容；错误信息只回显链接原文，不泄露解析后的绝对路径。
- **资源耗尽**：逐条检查了正则结构，`INLINE_LINK` 的三类分支首字符互斥（`\` / 非括号空白反斜杠 / `(`），没有重叠分解；`REFERENCE_DEFINITION`、`HEADING` 都是线性量词，未发现灾难性回溯。`stripFences` 在围栏内每行新建一次 `RegExp`，是 O(行数) 的构造开销，不是无界资源消耗。
- **不可撤销的操作**：没有；测试只在 `os.tmpdir()` 建临时目录并在 `afterEach` 删除。
- **规则/文档与代码一致**：发现 `document-governance.md:28` 对“代码块/符号链接”的描述宽于实现，`delivery-mode.md:18` 的 `npm run check` 枚举未同步新增的 `check:docs-links`（第 3 条）。

---

## 必答问题

### 1. 会不会改变模型已经见过的请求开头？

**不会（就产品模型请求而言）。** 本次改动只涉及 `scripts/`、`test/`、`docs/`、`.agents/instructions/`、`package.json` 和复核记录，没有修改任何组装模型请求的代码、系统提示模板、工具定义、历史消息或出口遮盖逻辑。新增的检查只把 `DOCS_LINK_MISSING` / `DOCS_ANCHOR_MISSING` / `DOCS_LINKS ...` 写到 stderr/stdout，不会进入发给模型的内容。复核脚本读取的是 `.agents/instructions/model-review.md`（`scripts/model-review/opencode-review.mjs:2450` 的 `QUESTIONS_PATH`），本 PR 没有改它。`.agents/instructions/document-governance.md` 的文字变化只可能影响**新开的编码代理会话**，按规则第 6 条“改了提示词文字只对新对话生效”，不会改变已经冻结的会话开头；它也不是 Himawari 产品模型的系统提示。结论：仍然只在末尾追加，没有把每轮会变的值放进请求开头。

### 2. 会不会让同一段文字在不同请求里变成不同的字节？

**不会。** 这个检查器不参与任何模型请求的序列化或遮盖。它自身的输出是确定的：`docsMarkdownFiles` 用 `readdirSync(...).sort()` 排序，链接按文档顺序产生，`Set`/`Map` 只用于成员判断、不用于输出顺序；没有时间、随机数、对象遍历顺序依赖。同样的仓库内容会得到同样的错误列表和同样的 `checked` 计数。（它读取文件系统，仓库内容变了输出当然会变，但这与“同一段文字在不同请求里变成不同字节”无关。）

### 3. 有没有对应的自动检查，反向用例是否真的会失败？

**有，并且接进了门槛。** `package.json:27` 的 `check:steps` 包含 `check:docs-links`，`package.json:98` 让它先跑真实检查再跑 `test/tooling/docs-links.test.mjs`，`test/tooling/run-all-checks.test.mjs:73` 断言它出现在 `check:steps` 里，`ci/policy.json` 的 `tooling` 项目 include 覆盖 `test/tooling/**/*.test.mjs`。

反向用例的有效性分情况：

- **会失败（有效）**：缩进/引用块围栏用例（旧实现会把代码里的链接也检查）、角括号/括号/转义/带空格目标用例（靠 `checked: 6` 计数，若少匹配一个就失败）、参考式定义用例（旧实现不检查定义）、重复标题与标题内链接用例（旧实现 slug 不对）、根相对与 `//` 跳过用例。
- **不会失败（假覆盖）**：第 2 条的“仓库外目标”用例。删掉 `inside.startsWith("..")` 分支，它在干净机器上仍然通过。
- **覆盖不到**：第 1 条的“列表标记 + 围栏”会漏报；第 10 条的 `line.slice(...).includes("`")` 守卫没有用例；双引号和括号 title 没有用例；脚注、多行参考式定义、缩进代码块、多反引号代码、符号链接目标都没有用例。
- 另外，`still validates links from docs into docs/archive` 这个用例在旧实现下也能通过，它是回归保护，不是新逻辑的反向用例。

### 4. 每个新产生/修改的值，两端都能接受吗？

- **`check:docs-links` 这个配置键**：产生处是 `package.json:98`，使用处是 `check:steps`（`run-all-checks.mjs:6-12` 的 `stepNames` 只接受 `npm run <plain-name>`）、`run-all-checks.test.mjs:73` 的存在性断言和 `:74` 的“必须是字符串”断言，以及 `document-governance.md:28` 的说明。两端一致，且 `stepNames` 不会把它当成带 `&&` 的非法步骤。**缺口**：`run-all-checks.test.mjs` 只断言键存在，没有断言 `check:docs-links` 的命令内容确实指向 `docs-links.test.mjs`，命令路径写错要等真正运行这一步才会发现。
- **新增错误码/输出格式**：仍沿用 `DOCS_LINK_MISSING`、`DOCS_ANCHOR_MISSING`、`DOCS_LINKS ...`，全仓库只有这个脚本和它的测试消费（已 grep），没有别的解析器，格式兼容。
- **未同步的一端**：`delivery-mode.md:18` 的 `npm run check` 内容清单没有接受这个新步骤，属于规则文档与代码不一致（第 3 条）。
- **未核实**：新增的 `.agents/reviews/pr-335/*` 记录是否会被 `check:secrets` / gitleaks 接受，因工具拒绝读取记录路径，无法确认。
