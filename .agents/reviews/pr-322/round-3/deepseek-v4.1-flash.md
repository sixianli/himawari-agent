# 复核结论

改动整体方向成立：遮盖只发生在写盘阶段，请求组装没有变化；登记清单按长度降序排列后一次替换，给定清单下与登记顺序无关；合并门本轮已不再加载清单，所以不会因为清单随时间变化而把老记录判红（不会自锁）。下面按严重度列出发现。

---

## 一、按严重度排列的问题

### 中：清单解析只认一种写法，ADR/说明的“所有精确值自动生效”承诺过宽，存在漏遮

**文件：行**：`scripts/model-review/opencode-review.mjs:2469`、`docs/adr/0190-mask-registered-test-values-in-review-records.md:49`、`.agents/instructions/model-review.md:94`

**问题**：实现只匹配“单行、三单引号、数组里只有一个元素”的 `regexes = ['''^...$''']`：

```js
for (const match of text.matchAll(/^regexes\s*=\s*\[\s*\'\'\'\^([^\n]*?)\$\'\'\'\s*\]\s*$/gm)) {
  const literal = match[1].replaceAll("\\.", ".");
  if (literal.length >= REGISTERED_VALUE_MIN_LENGTH && /^[A-Za-z0-9_\-=.:/ ]+$/.test(literal))
```

而 ADR 和说明写的是“取出所有用 `^…$` 锚定的精确值白名单”“以后谁再给 Gitleaks 加了精确值白名单，复核记录自动不再带出它”。下列已存在的真实条目不会被读出：

- `ci/rules/gitleaks.toml:60`：假 GitHub 令牌写成了 `^gh[p]_…$`（字符类），被字符集过滤掉。它目前没漏，只是因为内置 `github-token` 规则恰好也能匹配它，属于“碰巧兜住”。
- `ci/rules/gitleaks.toml:28`、`:108`、`:116`：`regexTarget = "match"` 的固定整行/固定开头条目，含引号、反引号或汉字，全部被过滤。若模型原样引用第 28 行那种“文件名 + 64 位摘要”的整行，内置规则认不出，脚本不会遮，记录里就会带出它。
- 将来若把 `regexes` 写成多行数组、用双引号字符串、或一行写多个元素，解析同样会静默跳过，不会报错。

**证据**：上面的正则要求 `regexes`、`[`、`'''^` 与结尾的 `$'''` 在同一行；`/^[A-Za-z0-9_\-=.:/ ]+$/` 明确排除了 `[`、`]`、引号、反引号。

**建议**：用 TOML 解析器读 `ci/rules/gitleaks.toml`，对每个 allowlist 取 `regexes` 数组中“去掉 `^`/`$` 后是纯字面量（只允许 `\.` 转义）”的值，而不是靠行级正则猜格式；对看不懂的形状直接报错或至少留一行告警，避免“以为已经自动生效、其实静默跳过”。同时把 ADR/说明里“所有精确值自动生效”改成“符合某形状的字面量自动生效”，或补一条测试：仓库里每个 `regexTarget="secret"` 的 `^…$` 字面量都必须能被解析出来，否则测试失败。

---

### 低：过度遮盖——把非密钥的登记值和账本结构字段也遮了

**文件：行**：`scripts/model-review/opencode-review.mjs:2519-2530`，`ci/rules/gitleaks.toml:68`、`:76`、`:100`

**问题**：登记清单取自“所有精确值”，其中不全是“假值/密钥形状”，还包括 tmpfs 大小参数（第 68 行）、线程 UUID（第 76 行）、文件 SHA-256（第 100 行）。`maskSecretLikeDeep` 会把账本里的每个字符串字段都过一遍，包括 `head`、`base`、`promptSha256`、`promptFileSha256` 这些结构化字段：

```js
function maskSecretLikeDeep(value) {
  if (typeof value === "string") return maskSecretLike(value);
  ...
return `${JSON.stringify(maskSecretLikeDeep(record))}\n`;
```

目前这些登记值都是长随机串，撞上 40/64 位哈希的概率极低，但设计上最低只要求 12 个字符；将来若登记一个 12 位十六进制值，理论上可能把 `head`/摘要中的一个子串换掉，导致账本被 `USAGE_LEDGER_INVALID` 或 `delegate.mjs check` 判坏（失败关闭，不是安全洞，但会误伤）。同时，把非密钥的配置串遮成 `[已遮盖:registered-test-value]` 会让复核人读记录时失去上下文。

**建议**：登记值只用于遮自由文本字段（答案、报错、`findings`、`quote` 等），不要把 `head`、`base`、`from`、`promptSha256`、`promptFileSha256`、`model`、`outcome` 等结构化字段纳入；或者在 ADR 里明确“所有字段都遮、已知可能误伤”的取舍，并加一个反例测试（登记一个短十六进制值后账本仍可解析）。

---

### 低：全局可变清单 + 遮盖标记可能被二次命中

**文件：行**：`scripts/model-review/opencode-review.mjs:2459-2465`、`:2491-2496`

**问题**：`registeredTestValues` 是模块级 `let`，`maskSecretLike` 的输出不只取决于 `text`，还取决于此前谁调用过 `setRegisteredTestValues`。CLI 里 `--report`/`--assert-reviewed` 提前返回（`:2940-2950`），不会设置清单，所以生产路径没问题；但同一进程里混用导出函数时（测试、将来别的调用方）结果会依赖调用顺序，这与“同样输入同样字节”的目标不完全一致。

另外，`RECORD_SECRET_RULES` 先替换成 `[已遮盖:<规则 id>]`，登记值再对**替换后的字符串**做一次替换；如果某个登记值恰好是某条规则 id 的子串（例如未来登记了含 `private-key-header` 的字面量），它会再次命中标记本身，得到 `[已遮盖:[已遮盖:registered-test-value]]` 之类的畸形结果。现清单不会触发，但这是顺序替换的固有风险。

**建议**：把清单作为显式参数传入（或在一次运行内冻结），不要用全局状态；更稳的写法是对原文一次性收集“真密钥命中 + 登记值命中”，真密钥优先、同一位置取最长登记值，然后统一替换，这样既不会重扫替换文本，也不依赖调用顺序。

---

### 低：文档与代码/材料不一致

**文件：行**：`.agents/instructions/model-review.md:91`、`:94`；`docs/adr/0190-mask-registered-test-values-in-review-records.md:89`；`test/tooling/opencode-review.test.mjs:4471-4474`

**问题**：

1. `model-review.md:91` 仍只说“补跑时拿重建的提示词按同样规则遮盖后再比”，但代码现在接受三种形式（当前清单遮盖、不遮登记值、匹配账本 `promptFileSha256`），ADR `:89` 也写了三种。两处文档不一致。
2. `model-review.md:94` 说读 `--base` 和 `origin/main`；代码在 `--base` 缺失时退回 `commits.head`（`:2960`），ADR 写了这个退回，说明没写。
3. 作者材料“已核对的事实”第 2 条仍说“`secretLikeRules` 也报它，合并门因此拒绝带着这些值的新提交记录”，但第 3 轮更新和代码（`:2509-2512` 已删掉登记值检查）都说明合并门不再拒绝。材料这一条是过期说法，代码与更新一致。
4. 测试标题 `"masks the registered value in records and reports it …"` 仍说“reports it”，但断言已改成 `secretLikeRules(text)).toEqual([])`，标题应改。

**建议**：同步第 1、2 点与测试标题；把作者材料的事实条目更新为“本轮起合并门不检查登记值”。

---

### 低：测试缺口（合并门“不加载”这条没有直接覆盖）

**文件：行**：`test/tooling/opencode-review.test.mjs:2694-2712`

**问题**：新测试先手动 `registerTestValuesFromRefs(f.repo, ["origin/main"])`，再断言 `f.check().problems` 为空。它证明的是“`secretLikeRules` 不再报登记值”，但并没有覆盖“`--assert-reviewed`/`--report` 不再加载清单”这条本轮新增行为；如果将来有人把 `secretLikeRules` 改回去，同时又在 main 里加载清单，这组测试仍可能通过或失败得不够精确。另外没有测试“清单里出现看不懂的 allowlist 形状时，脚本表现为静默跳过”这一反向用例。

**建议**：加一条不手动 `setRegisteredTestValues` 的合并门用例（值只存在于 `origin/main` 的 gitleaks.toml），断言 `assertReviewed` 通过；再考虑给解析器加“未识别形状必须失败/告警”的测试。

---

### 低（流程）：提交说明缺少 `Fast-mode-checks:`

**文件：行**：`.agents/instructions/delivery-mode.md:31`；`git log e201b2ed`、`b3a0c488`、`eeb3ae8a`

**问题**：快速模式规则要求提交说明里有一行 `Fast-mode-checks:`，列出实际跑过的基本检查、主机和版本。这三个提交只有 `Layer-0-tests:`，没有 `Fast-mode-checks:`。这不是代码改动本身的缺陷，但属于规则与提交不一致。

**建议**：按规则补上该行（或说明当前流程为何不要求）。

---

## 二、读代码证实的 / 推测的

**读代码证实**：

- 遮盖只作用于写盘：`:3078` 写 `maskSecretLike(prompt)`，`:3086` 传给 `reviewModel` 的是原始 `prompt`；答案 `:3093`、报错 `:3138`、账本 `:3129` 走遮盖函数。`registerTestValuesFromRefs`（`:2960`）不改 `prompts`。
- 登记清单排序与去重：`:2461-2465`；正则转义并一次替换：`:2483-2496`。
- 合并门/`--report` 不再加载：`:2940-2950`；`secretLikeRules` 只看内置规则：`:2509-2512`。
- 补跑三种接受形式：`:1650-1652`。
- 当前 gitleaks.toml 中第 60、28、108、116 行不会被解析；第 68、76、100 行会被解析并全局遮盖。
- 三个提交的说明没有 `Fast-mode-checks:`。

**推测/未核实**：

- 现有第 60、28、108、116 行将来是否真的导致记录漏遮，取决于模型是否原样引用；目前第 60 行有内置 `github-token` 规则兜底，第 108/116 行有 `private-key-header` 兜底，第 28 行没有明显兜底（推测风险最高）。
- `.agents/reviews/pr-322/**` 的内容无法读取：工作树里没有该目录，`git show` 对 `records-path` 被沙箱拒绝（`REVIEW_GIT_REFUSED records-path`）。因此“本 PR 自带记录是否已遮盖、是否会被 gitleaks 报”**未核实**。
- 无法运行 `npm test`/`npm run check`，测试和 lint 是否实际通过**未核实**；仅按代码审阅判断新增测试的逻辑与反向用例大体成立。
- 作者材料所说“PR 321 与本 PR 不重叠”因无网络**未核实**。

---

## 三、侧重检查

- **错误路径**：`REGISTERED_VALUES_UNREADABLE`（`:2479`）在“提交存在但无文件”时抛出；不存在的 ref 在 `:2502-2503` 跳过；补跑不匹配报 `ROUND_PROMPT_MISMATCH`（`:1655`）。均失败关闭。注意 `origin/main` 不存在或未 fetch 时会静默少读一份清单，只靠 `--base` 遮，可能漏遮 main 上新增的值。
- **不合规范/不可信输入**：`--base` 先 `rev-parse` 成提交哈希（`:2383-2386`），`git show`/`rev-parse` 都通过 `spawnSync` 参数数组调用，没有 shell 注入；清单来自仓库提交而非工作区/PR 头；模型答案是不受信输入，但只作为 `replace` 的输入，正则来自受信清单并转义（`:2486`）。没发现 ReDoS 形状。
- **安全**：遮盖只替换文字、不放宽扫描规则；登记值来自 main 上经审阅的白名单。合并门不再拦登记值是本轮明确的取舍，`npm run check` 里仍含 `check:gitleaks`（`package.json` 的 `check:steps`），所以新记录若带未在白名单路径的登记值，本地仍会拦；只有路径本身已在该值的白名单里的记录不会被 gitleaks 拦，但那是已知假值。
- **资源耗尽**：每次调用重建正则，清单规模受 gitleaks.toml 文件大小约束；`git show` 用 `maxBuffer 1<<28`；正则无嵌套量词，未见灾难性回溯。
- **不可撤销操作**：已提交记录不能改写，ADR 明确“老记录不改”，本轮也没有改旧记录（`git diff --name-only` 只新增 `pr-322` 记录）；补跑通过 `keepEarlierAttempt` 改名保留旧文件而不是删除。
- **规则/文档一致性**：见“低：文档与代码/材料不一致”和“提交说明缺少 `Fast-mode-checks:`”。

---

## 四、必答问题

**1. 会不会改变模型已经见过的请求开头？是否仍然只在末尾追加、每轮会变的值都在最后一条消息里？**

不会。本次改动只影响落盘（`writeFileSync` + 遮盖）和补跑校验；发给模型的仍然是 `buildPrompt` 生成的原始 `prompt`（`:3086`），`registerTestValuesFromRefs` 不修改 `prompts`。因此请求仍按“工具定义 → 系统提示 → 历史 → 最后一条消息”的顺序，只追加不改写；登记清单是纯写盘用的外部状态，根本不进入请求。唯一需要留意的是 `.agents/instructions/model-review.md` 本身的内容变化会改变**将来**新复核的 questions 文本，但那是静态提示词更新，不是每轮变化的字段，也不影响本次改动下的 append-only 行为。

**2. 会不会让同一段文字在不同请求里变成不同的字节？**

请求层面不会：请求根本不经过登记值遮盖。写盘层面：
- 给定同一份登记清单、同一段文字，结果确定，且与登记顺序无关（`:2462` 按长度降序 + 字典序排序；`:2483-2496` 一次替换）。测试也覆盖了顺序、重叠、最长优先。
- 清单本身随 `--base`/`origin/main` 变化，因此同一段文字在不同时间写盘可能得到不同字节；这是有意设计，ADR `:89` 记载了补跑三种接受形式。
- 小边界：`maskedRecordText` 先 `recordText` 去掉行尾空白再遮盖，若某个登记值本身以空格结尾且正好在行尾，可能漏遮；目前清单没有这种值。
- 全局 `registeredTestValues` 让 `maskSecretLike` 不是纯函数（取决于进程内谁先设置），CLI 路径没问题，但属于可改进点。

**3. 有没有对应的自动检查？反向用例是否真的会失败？**

有：读取/过滤、近似值不遮、真密钥形状仍遮、顺序无关、重叠取长、先遮真密钥、一次替换不二次遮盖、从提交读取、ref 不存在跳过、缺文件抛错、合并门接受登记值、补跑两种兼容、补跑内容改动仍报错。按代码判断这些反向用例会失败（如 `${writtenBefore}\n` 报 `ROUND_PROMPT_MISMATCH`），但我无法实际运行测试，**执行结果未核实**。缺口是无法覆盖“`--assert-reviewed`/`--report` 不加载清单”和“未识别的 allowlist 形状会被静默跳过”。

**4. 每个新产生/修改的值，所有使用端都能接受吗？**

- `[已遮盖:registered-test-value]`：只出现在提示词/答案/报错/账本文本里；JSON 序列化安全（无反引号/控制字符），内置规则也不会再命中它；`quote` 只要从遮盖后的答案复制就能匹配（ADR 已写明）。
- `REGISTERED_VALUES_UNREADABLE`：只被抛出、打印、以退出码 2 结束，没有机器端解析该字符串，暂无兼容问题。
- `promptFileSha256`：新消费端是 `roundForRun`（`:1642-1652`），旧消费端是 `delegate.mjs:335`；两边都只要求“磁盘文件哈希等于账本记录”，一致。
- `secretLikeRules` 语义改变：消费端只有合并门 `recordFileProblems`（`:2541`）和测试；合并门现在接受登记值，与 ADR 一致，但这是本轮行为变化，需要确认是有意为之。
- 清单来源 `ci/rules/gitleaks.toml`：读取端 `loadRegisteredTestValues` 用 `git show`，入口 `registerTestValuesFromRefs` 先 `rev-parse`；两端对“ref 不存在”跳过、对“ref 存在但文件缺失”抛错，与 ADR 一致。
- 新导出 `setRegisteredTestValues` / `registeredTestValuesFromToml` / `loadRegisteredTestValues` / `registerTestValuesFromRefs`：只被测试和 `main` 使用，无外部契约。
