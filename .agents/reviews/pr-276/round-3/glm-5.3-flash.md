# 复核报告：PR #276（案例 85，d4bf9a2a）

## 侧重检查（先写的流程和结论）

我按两条流程走了全文：

**流程 A（文档引用流，即“读者从案例 85 追到代码”）**：目录（engineering-casebook.md:112）→ 案例 85 正文（5334–5413）→ 案例 81 的后续段（5188）→ 事故表 I-78 行（docs/incidents-and-gates.md:116）→ 规则第 11 条（.claude/rules/prompt-prefix.md:53）→ 实现代码（packages/prompt-catalog/src/entry.ts:59 的 24 字符门槛、packages/sensitive-capture/src/redaction.ts:172–256、packages/prompt-catalog/src/trusted.ts）。结论：四处口径一致（填充 34 个 U+FDD0–FDEF + U+FFFE/U+FFFF、退回条件、空跑、点名值不遮、24 字符下限），这段链路里没有找到和代码矛盾的句子。**无覆盖的路径**：案例正文引用的 `.agents/reviews/...` 路径文件和花费数字——工作区是稀疏检出（git status 报告 95% 文件在场），这些文件不在检出内，且本环境对 `.agents/reviews` 下的 git 读取一律返回 REVIEW_GIT_REFUSED，我也没有找到任何自动检查负责校验 docs 里指向 `.agents/` 的路径或案例数字的正确性（scripts/check-*.mjs 里只有 glossary、markdown-tables、incident-gates 等格式类检查；check:instruction-links 只管指令文件）。

**流程 B（门检流）**：`npm run check:prompt-catalog`（package.json:52）→ apps/agent-service/test/trusted-prompt-egress.unit.test.ts（node-services + unit 两个项目会同时匹配该文件，见 ci/policy.json:195–196 与 vitest.workspace.ts:77–86）→ trusted-text.unit.test.ts（13 个 `[I-78]` 用例，含 `falls back to checking everything when a rule would run into trusted text`，第 69 行）→ sensitive-interceptions（I-78 事故表也点名）。结论：反向用例方向在代码层面核实成立（详情见必答问题 3），但 12/22 的具体数字只存在于提交说明，没有原始输出文件。

以下发现全部核对过代码；未核实项在末尾单独列。

---

## 发现（按严重度从高到低；本次没有发现高、中严重度问题）

**1. 低 · docs/engineering-casebook.md:5397 —— “在两个测试项目里各跑一次”对门检本身不成立，容易让读者用错误的口径复现**
证据：package.json:52 `check:prompt-catalog` 跑该文件时带 `--project node-services`，只跑一遍（11 用例）；能凑出 22 次的是不带 `--project` 的跑法，此时 unit（ci/policy.json:196 `"apps/**/*.unit.test.ts"`）和 node-services（vitest.workspace.ts:81）两个项目都匹配该文件。读代码证实的部分是这两个项目定义；提交里那次重跑到底带没带过滤，只能从输出“22”反推，属**推测**。建议把句子写成“门检只跑 node-services 一遍；重做时按不带项目过滤的跑法，两遍共 22 次”。

**2. 低 · docs/engineering-casebook.md:5355 —— “全部 34 个候选字符被占用时退回整段检查”没有专门测试用例**
证据：实现确在 redaction.ts:214–219（`TRUSTED_FILLERS.find((c) => !input.includes(c) && !known.some((v) => v.includes(c)))`，找不到就 `redactUntrusted` 整段检查），规则第 11 条也写了；但 trusted-text.unit.test.ts 只有“挑一个输入没有的填充字符”（第 56 行）和“点名值不会跨固定文字匹配”（第 104 行）两个相邻用例，没有“输入加点名值把 34 个全占满”的用例。建议补一个反向用例。

**3. 低 · docs/engineering-casebook.md:5340 —— 占位符写法不一致**
正文引述“被改成了‘confidence 是 0 到 [验证码] 的整数’”，而事故表（incidents-and-gates.md:116）和提交 5870f36 都写 `[验证码#…] 的整数`。同一占位符两种写法，面试引用时可能被追问。建议统一成带 `#` 后缀的写法。

**4. 低 · docs/engineering-casebook.md:5340 —— “‘写一个小游戏’各有一条”等细节仅与事故表互证**
与 I-78 行逐字一致（ skeptical 检查过），无问题，列在这里是为了说明这条链的两端都是转述而非日志原文；不要求改动。

## 推测（我无法直接核实的）

- 案例里引用的 `.agents/reviews/topic-trusted-prompt-egress/...`、`.agents/reviews/pr-268/` 等文件内容与路径：稀疏检出缺 + 环境拒绝读取，**未核实**（包括 0.3471 / 0.5596 两个花费数字、“四个后台调用”与 GLM 提案文件的对得上与否）。
- 两条业界引文“本次打开过”：需要上网，**未核实**；只能确认文档按图例标注了 ✅。
- 12 次失败 / 22 次通过的重跑输出：测试用例与清单默认来源核实过（方向性成立），具体数字**未核实**（不能运行测试）。
- 来出 Andy 的截图按要求没进仓库，diff 里确实没有新增图片或资产。

---

## 必答问题逐条回答

**1. 会不会改变模型已经见过的请求开头？—— 不会。** 本次改动只触两个位置：docs/engineering-casebook.md 和 .agents/reviews/pr-276/（git diff --stat 证据：12 个文件全部在这两个目录），没有改 packages/prompt-catalog、runtime-pi、工具定义、历史或遮盖代码。我 grep 过 `engineering-casebook` 在 *.ts 里没有命中，改动不会进入运行时提示组装；“每轮会变的值都在最后一条消息里”这个问题对本次没有输入（没有可变值被引入请求结构）。顺带确认了作者按规则把案例 81 的后续写成“追加注明日期的段、不改写结论”（5188–5190），与 `.agents/instructions/engineering-casebook.md` 第 11 条一致。

**2. 会不会让同一段文字在不同请求里变成不同字节？—— 不会。** 遮盖/序列化运行时代码未动，本次不引入新输入。案例新写的“退回整段检查时那一次请求开头不同、缓存未命中一次”（5386）是对既有行为（redaction.ts:218–219，退回走 `redactUntrusted`，导致信任段里也出占位符）的如实记录，属 PR #268 已合并的行为，方向是多遮；它只在极端构造（34 个候选字符被一次请求占满）下出现，不构成“同一段文字。
”常态化变字节的风险。

**3. 有没有自动检查、反向用例会不会真失败？—— 有，方向核实成立，具体失败数未核。** `check:prompt-catalog`（package.json:52）在 `npm run check` 里；反向用例 trusted-prompt-egress.unit.test.ts:99–107 自带 `trusted: []` 自包含；其余用例经 `createProductionModelEgress`（test:35–42）用生产默认清单，按代码路径把默认清单清空时，“发送整理记忆指令原样不变”“目录每个条目原样发出”等用例会失败——“把清单撤掉，这个测试会失败”（5357）成立。文档侧该提交说明称 check:glossary、check:markdown-tables 通过，与之对应的检查脚本存在（scripts/check-glossary.mjs、scripts/check-markdown-tables.mjs），我未复跑。

**4. 每个产生/修改的值，两端都经得起吗？—— 仓库内可核的都通过，两个引用点未核实。** 逐个核对：目录第 85 项锚点 `#case-trusted-prompt-text` ↔ 正文 `<a id>`（112 / 5334）✓；岗位能力对照表"Agent 安全"行只加了链接，列数未破（check:markdown-tables 管表格格式）✓；案例 81 → 85 链接 ✓；事故链接 `incidents-and-gates.md#incidents`，I-78 行存在（116）✓；规则引用“第 11 条”，内容与行 53 逐点一致 ✓；测试名 `[I-78] never changes the trusted text...` 在 trusted-text.unit.test.ts:20 存在 ✓；性能数字 7.4/7.8/75 段、“10 个用例失败”“恢复后 18 个通过”逐字来自提交 5870f36 说明 ✓；"PR #268 第三个提交"= 当前提交 d4bf9a2a（git log 三笔相符）✓。未核实：`.agents/reviews/` 下被引用的文件路径与花费数字（见末尾三段）。
