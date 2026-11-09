## 侧重检查

- **错误路径**：`checkAdrNumbers` 对 `docs/adr` 不存在返回 `ADR_NUMBER_NO_DIRECTORY`，空目录返回 `ADR_NUMBER_NO_FILES`（`scripts/check-adr-numbers.mjs:117-124`）。未处理 `docs` 存在但不是目录、或子目录不可读时的 `ENOTDIR`/`EACCES`：会抛异常退出，结果仍是失败，但错误形态不是约定错误码。属鲁棒性问题，未见到实际触发条件。
- **不合规范/不可信输入**：文件名不合规由 `ADR_NUMBER_NAME` 覆盖；符号链接、悬空链接、目录型 `.md` 由 `lstat` 跳过遍历。但“按名计数”和“按普通文件读标题”用的不是同一份清单，见下面第 2 条。
- **安全**：脚本只读，不写文件、不执行外部命令；链接目标可解析到仓库外，但只是做 `lstat` 存在性检查，没有读取内容或泄露路径之外的信息，不构成安全边界问题。
- **资源耗尽**：符号链接目录不会被递归（`scripts/check-adr-numbers.mjs:60-62`），`/dev/zero` 这类字符设备不会被当作普通文件读取，循环链接不会导致无限递归。这是本轮改动正确的部分。
- **不可撤销操作**：无。`check:adr-numbers` 只读仓库，不产生修改。
- **规则文件、说明与代码一致性**：`document-governance.md:28`、`docs/lessons.md:733` 与实现的错误码和范围基本一致；但“每份 ADR 都检查标题”和“读 ADR 只认普通文件”在非普通 `.md` 条目上有缝隙；ADR 路径检查的 `superseded_by` 覆盖范围也被作者描述得比实现宽。

## 发现

### 1. 中：文本检查不看代码块和 URL，可能把文档示例当成真实 ADR 引用

- 文件:行：`scripts/check-adr-numbers.mjs:36`、`:92`、`:108-110`
- 问题：`MARKDOWN_LINK` 和 `ADR_PATH_MENTION` 直接在整份原始 Markdown 上匹配，不剔除围栏代码块、行内代码，也不排除外部 URL。文档里如果写示例 `docs/adr/0001-example.md`、或示例链接，会被当作真实引用检查；外部 URL 中恰好含 `/docs/adr/...` 同样会被拼成本地路径检查。
- 证据（亲自读到）：
  - `const ADR_PATH_MENTION = /docs\/adr\/\d{4}-[a-z0-9][a-z0-9-]*\.md/g;`（`:36`）
  - `for (const [, target] of text.matchAll(MARKDOWN_LINK))`（`:92`）
  - `for (const mention of new Set(text.match(ADR_PATH_MENTION) ?? []))`（`:108`）
- 建议：匹配前去掉 fenced code 和 inline code，或先排除带 scheme 的目标；`ADR_PATH_MENTION` 只扫描 frontmatter 和正文段落。此问题当前 main 是否触发未核实（作者称通过，我无法运行测试）；属于推测性误报风险。

### 2. 低：名称/重复检查仍把目录和符号链接算作 ADR，但标题不检查

- 文件:行：`scripts/check-adr-numbers.mjs:119`、`:125-128`
- 问题：编号检查的输入是 `readdirSync(directory)` 的全量条目；标题检查却只读取 `isRegularFile` 的条目。因此一个名为 `0001-foo.md` 的目录或符号链接会被计为 ADR、参与重号检查、甚至让 `adrs > 0` 跳过 `ADR_NUMBER_NO_FILES`，但它的标题永远不被检查。这与文档“每份 ADR 标题里的 ADR 编号等于文件名编号”和作者“读 ADR 只认普通文件”不完全一致。
- 证据（亲自读到）：
  - `const result = findAdrNumberProblems(readdirSync(directory));`（`:119`）
  - `.filter((name) => name.endsWith(".md") && isRegularFile(path.join(directory, name)))`（`:126`）
  - `const titles = names.map((name) => [name, readFileSync(...)]);`（`:128`）
- 建议：先构造统一的“普通文件 ADR 清单”，编号、重号、标题都用它；对非普通文件的 `.md` 条目显式报错，而不是让它在计数里“隐身”。

### 3. 低：符号链接反向用例没有真正覆盖“链接目标只认普通文件”

- 文件:行：`test/tooling/adr-numbers.test.mjs:125-132`、`scripts/check-adr-numbers.mjs:83-84`、`:101`
- 问题：测试只创建了指向 `/dev/zero`（字符设备）的符号链接并断言错误里不含 `0002-zero`。如果把 `isRegularFile` 的 `lstatSync` 误改成 `statSync`，`/dev/zero` 仍不是普通文件，测试依然通过；指向普通文件的软链被读取、以及“链接目标是符号链接”这两种回归都不会被抓住。作者声称“读 ADR 和链接目标只认普通文件”，但反向用例只覆盖了字符设备。
- 证据（亲自读到）：
  - `symlinkSync("/dev/zero", join(root, "docs/adr/0002-zero.md"));`（测试 `:129`）
  - `expect(errors.some((error) => error.includes("0002-zero"))).toBe(false);`（测试 `:131`）
  - `return existsSync(absolute) && lstatSync(absolute).isFile();`（脚本 `:84`）
- 建议：补两个用例：1) `docs/adr/0002-c.md` 软链到一份标题号故意错误的普通文件，断言不产生标题错误；2) 文档链接指向 `docs/adr` 里的软链，断言报 `ADR_LINK_MISSING`。

### 4. 低：`superseded_by` 的覆盖范围被描述得比实现宽

- 文件:行：`scripts/check-adr-numbers.mjs:36`、`:108-110`
- 问题：`ADR_PATH_MISSING` 只匹配字面量 `docs/adr/...` 前缀。若某份 ADR 的 `superseded`/`superseded_by` 写成裸文件名 `0080-foo.md`（YAML 合法写法），改号后不会被发现；而作者的说法“含 superseded_by 字段”容易被理解成字段值一定被检查。`docs/lessons.md:733` 也用了“含 `superseded_by` 字段”的表述。
- 证据（亲自读到）：正则要求 `docs/adr/`；我用 grep 核对当前所有非空 `superseded_by` 都以 `docs/adr/` 开头，所以**当前仓库没有实际漏报**，但这是一个可预见的未来缺口。
- 建议：单独解析 frontmatter 的 `superseded`/`superseded_by`，同时接受裸 `NNNN-短名.md`；或在文档中明确“只检查带 `docs/adr/` 前缀的写法”。

### 5. 低：标题检查可能把 frontmatter 注释或代码块里的 `#` 行当成标题

- 文件:行：`scripts/check-adr-numbers.mjs:37`、`:73`
- 问题：`TITLE = /^#\s+(.+)$/m` 取文件中第一个形如 `# ` 的行，不跳过 YAML frontmatter，也不跳过围栏代码块。若 ADR 的 frontmatter 里出现以 `#` 开头的注释，或在真正标题前放了含 `# ` 的代码块，会被误判为标题并报 `ADR_NUMBER_TITLE`。
- 证据（亲自读到）：`const TITLE = /^#\s+(.+)$/m;`（`:37`）；`const title = TITLE.exec(text)?.[1] ?? "";`（`:73`）。
- 建议：只取第一个 `---` frontmatter 块之后的内容，并在扫描标题时跳过 fenced code；或复用现成的 Markdown 解析方式。当前 ADR 未触发，属推测性边界问题。

## 「读代码证实」与「推测」分开

**读代码证实的：**
- 修复的两处链接方向正确：`docs/execution/specs/...` 到 `../../adr/...` 会解析到 `docs/adr`，目标文件存在（ADR 0004、0053）。
- 锚点规则与 `scripts/check-instruction-links.mjs` 的 `headingSlug`/`anchorsOf` 完全一致。
- `markdownFiles` 跳过 `docs/archive`，遍历结果 `sort()`；ADR 名称在 `findAdrNumberProblems` 中也 `sort()`，错误顺序确定。
- `package.json:34` 将脚本和 vitest 串在 `check:adr-numbers`；`package.json:27` 的 `check:steps` 包含它，`scripts/run-all-checks.mjs:32` 会按 `check:steps` 逐项运行。
- 错误码只被测试、CLI 输出和两处文档消费；没有后端、schema 或迁移校验依赖它们。
- 所有当前非空 `superseded_by` 值都以 `docs/adr/` 开头。

**推测或未核实的：**
- “main 上全部通过”“9/11 条测试通过”“变异检查失败”我未实际运行（当前环境是稀疏检出，且我只能读代码和跑 git 只读命令），未核实。
- 对代码块/URL 的误报、frontmatter 注释误判、`docs` 不是目录时抛异常，均为读代码后的推测，没有在真实仓库上复现。

## 必答问题

1. **会不会改变模型已经见过的请求开头？**
   不会。改动只涉及 `scripts/check-adr-numbers.mjs`、测试、`docs/lessons.md`、`.agents/instructions/document-governance.md` 和复核记录，没有触碰提示词组装、系统提示、工具定义、历史消息或遮盖代码。产品发给模型的内容仍由原运行时代码决定，本 PR 没有新增“每轮会变的值”，也没有改变“只在末尾追加、会变的值放最后一条消息”的结构。`document-governance.md` 是仓库指令文档，不是产品模型请求前缀的一部分。

2. **会不会让同一段文字在不同请求里变成不同字节？**
   不会进入模型请求。就检查脚本自身而言，输出顺序是确定的：`findAdrNumberProblems` 对名称排序（`:13`），`markdownFiles` 对目录项排序（`:57`），错误按文件顺序、链接文本顺序和 `Set` 插入顺序产生；没有时间、随机数或无序集合。同一仓库状态下重复运行应得到相同错误字节。

3. **有没有对应的自动检查，反向用例是否真的会失败？**
   有。`npm run check:adr-numbers` 会运行脚本和 `test/tooling/adr-numbers.test.mjs`（`package.json:34`），当前测试文件有 11 条。反向用例覆盖标题号错、旧文件名链接、锚点不存在、archive 不检查、`docs/adr` 裸链接、写出的路径不存在和符号链接。按代码推理，移除对应检查后这些用例会失败。但**未实际运行**，且符号链接用例偏弱（见发现 3），不能证明“软链到普通文件”和“链接目标是软链”这两种回归会被拦住。

4. **每个产生或修改的值，使用它的地方都能接受吗？**
   - 错误码 `ADR_NUMBER_TITLE`、`ADR_LINK_MISSING`、`ADR_LINK_ANCHOR_MISSING`、`ADR_PATH_MISSING`：产生于 `scripts/check-adr-numbers.mjs:77/102/106/110`；使用方只有 CLI 的 stderr（`:146-150`）、测试的字符串断言和两份文档。没有后端/schema 校验，因而不存在“清单 id 过不了后端校验”的同类问题。
   - `adrs` 计数：只进入 CLI 输出，没有其他使用方。
   - 修复的两个链接：使用方是 Markdown 渲染和新的链接检查；目标文件存在，路径深度正确。
   - 命令和测试接线：`check:adr-numbers` 已在 `check:steps` 中，`run-all-checks` 会执行；测试文件路径存在。
   - 唯一的两端不一致是文档/作者说法中的“每份 ADR”“含 superseded_by”比实现略宽，见发现 2、4。
