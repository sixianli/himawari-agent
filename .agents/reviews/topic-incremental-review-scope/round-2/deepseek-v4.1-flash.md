已核对 `buildPrompt`、`prepareCopy`、`ownChangePrints`/`unreviewedFiles`、`parseUsage`/`ledgerLine`、`delegate.mjs`、`review-speed-report.mjs` 及相关测试。方向（只看增量、固定前缀）和 ADR 0270 一致，但增量口径和账本消费端有硬伤，按原样实施有漏检和合并门误判风险。

## 证实的

### 1. 高：`--first-parent --no-merges` 会漏掉合并 main 时的手工解决冲突，可能让合并门放行没看过的改动

**问题**：`--no-merges` 直接丢掉合并提交，`--first-parent` 只沿第一父提交走。PR 合入 main 时如果在冲突解决里改了代码，这些改动只存在于合并提交，按方案算出的“本轮自己的增量”是空的。模型看到“没有增量”，账本仍可记 `ok`；`--assert-reviewed` 比较的是文件自己的改动指纹，会认为当前提交已复核，门就过了。

**证据**：
- Git 官方：`--no-merges` “Do not print commits with more than one parent. This is exactly the same as `--max-parents=1`.”；`--first-parent` “follow only the first parent commit upon seeing a merge commit.” https://git-scm.com/docs/git-log#Documentation/git-log.txt---no-merges 、 https://git-scm.com/docs/git-log#Documentation/git-log.txt---first-parent
- 仓库规则明确把冲突解决算作 PR 自己的改动：`.agents/instructions/model-review.md:74`：“冲突手工解决、合并时顺手改的内容会让这个文件的比较结果变，仍报 `unreviewed <文件>`”。
- 现有合并门用的正是“每个提交相对自己与 main 的合并基线的 diff 指纹”：`scripts/model-review/opencode-review.mjs:1604-1649`。
- 方案原文：“git log --first-parent --no-merges previous..head，去掉 .agents/reviews/ 下的复核记录”。

**建议**：不要用“有没有合并提交”来决定增量。复用 `ownChangePrints`：分别算 `previous` 和 `head` 相对各自 `merge-base(origin/main, 提交)` 的 PR 自有 patch，只把指纹变化的文件纳入本轮；然后对这些文件取 `previous..head` 的净 diff。这样既排除纯 main 文件，又保留冲突解决。必须加反向用例：合入 main 并手工解决冲突后，增量里必须有那段 hunk；删掉它测试必须失败。

### 2. 高：增量算法没有定义清楚，`git log` 不是 diff，逐提交 `git show` 不是净增量

**问题**：方案说“据提交得到本轮改动的文件和差异”，但没有说最终给模型的是哪一种：
- `git diff previous..head` 是两点 diff，会把合进来的 main 改动也算进去；
- 逐提交 `git show` 看到的是中间状态，不是 `previous` 到 `head` 的净结果，后面提交可能已经改掉或重写前面的代码；
- `--first-parent` 也会丢掉 PR 自己合并进来的非 main 分支，以及这些分支上的提交；
- 文件同时被 main 和 PR 改过时，按提交列表取文件仍可能把 main 的改动带进 prompt。

**证据**：
- Git 官方：`git diff <commit>..<commit>` “synonymous to the earlier form ... for viewing the changes between two arbitrary <commit>”；`A...B` 才是 “starting at a common ancestor”。 https://git-scm.com/docs/git-diff
- GitHub 官方：“A two-dot comparison ... focuses on the base branch”；“Because the three-dot comparison uses the merge base, it focuses on what a pull request introduces.” https://docs.github.com/en/pull-requests/collaborating-with-pull-requests/proposing-changes-to-your-work-with-pull-requests/about-comparing-branches-in-pull-requests
- 现有实现已经有一套稳定做法：`ownChangePrints` 用 `-U0 --binary --no-renames --no-textconv --no-ext-diff`，并去掉 `@@`/`index` 行后比较指纹，见 `scripts/model-review/opencode-review.mjs:1614-1637`。

**建议**：明确写成“净增量”：先用 PR 自有 patch 指纹选出文件，再对这些文件做一次 `git diff previous..head -- <文件>`；提交哈希只作为来源说明，不作为逐提交审查单位。对“main 也改过同一文件”的情况加标注，而不是把 main 的改动静默混进去或静默删掉。测试至少覆盖：纯 main 文件被排除、PR+main 同文件被保留、PR 合并进来的功能分支被保留、干净合入 main 时增量为空、冲突解决被保留。

### 3. 中高：diff 上限和现有 100000 字节的 `PROMPT_TOO_LARGE` 没有对齐，且可能先读入超大 diff

**问题**：方案说“差异不超过配置上限就全文放进材料”，但 `buildPrompt` 之后仍有硬限制：`if (Buffer.byteLength(prompt) > 100000) throw new Error("PROMPT_TOO_LARGE")`（`scripts/model-review/opencode-review.mjs:3833-3834`）。diff 上限如果设得接近 100KB，加上 brief、上一轮意见、固定前缀就会直接报错。反过来，方案没有说先生成 diff 再判断大小，还是先估大小；如果先 `git diff` 全量读进内存，lockfile、生成文件或大 PR 会先消耗内存/时间。兜底“让模型逐个 git show”也没有提交数、每提交输出大小的上限。

**证据**：`scripts/model-review/opencode-review.mjs:3833-3834`；`spawnSync("git", ...)` 的 `maxBuffer: 1 << 28` 见 `:1585`、`:3102`；方案第 1、3 条。

**建议**：先用 `git diff --numstat`/`--stat` 估算，再决定是否取全文；总预算按 `100000 - 固定前缀 - brief - priorFindings` 计算，diff 上限不能单独配置。超限时给“每文件 stat + 截断到 N 字节的 patch + 明确截断标记”，不要只给提交号让模型无界 `git show`；限制提交数、文件数、单次 `git show` 大小。补 `PROMPT_TOO_LARGE` 前后边界测试。

### 4. 中：新增配置键没有校验，和“配置启动时校验”的规则不一致

**问题**：方案要把字节上限、比例、扩展名白名单、工具摘要数量上限放进配置，但 `reviewModelsProblems` 只校验 `allowed`、`default`、`substitutes`、`lowDeferFromRound`（`scripts/model-review/opencode-review.mjs:61-87`），`readReviewModels` 也不拒绝未知键（`:89-99`）。如果新键放 `review-models.json`，负数、NaN、字符串、超大值都会静默通过；如果另放一个文件，更没有任何校验。规则文件却写明配置会校验（`.agents/instructions/model-review.md:4`）。另外，配置若不在脚本目录，`selfCheckCacheKey` 只扫脚本目录的 `.mjs`/`.json`（`:2793-2796`），改上限不会让自检缓存失效。

**建议**：新键要么放进 `review-models.json` 并在 `reviewModelsProblems` 加边界校验（正整数、上限、必填、未知键策略），要么单独文件配独立校验器并以 `REVIEW_CONFIG_INVALID` 失败关闭；补无效值测试；确保配置进入自检缓存键。

### 5. 中：账本新字段没有逐个核对消费端，直接踩 I-73

**问题**：方案新增 `本轮自己的增量行数`、`原始 previous..head 行数`、`是否混进合并 main`、`是否退回全量及原因`、`工具调用摘要`。但：
- `parseUsage` 对未知字段不校验类型，只检查 `hasLineBreak`（只认 `\r`/`\n`），见 `:2087-2091`、`:2180-2194`；文件路径里的制表符、ESC、bidi 控制字符能进账本。
- `delegate.mjs` 对新增记录的所有字段拒绝 `Cc`/`Cf`（`scripts/model-review/delegate.mjs:214-218`、`:298`），所以带制表符的“读得最多的文件”会让委托核对直接 `DELEGATION_CONTROL_CHARACTER`。
- `review-speed-report.mjs` 完全不认识这些字段，而且“增量轮”仍只看 `row.previous`（`:115-120`、`:251`）；新增的“按自己的增量行数分档”没有实现，旧账本也没有这些字段。
- `--report` 不会打印新增的退回原因；“是否退回全量”只留在账本里，Andy 看不到。

这正是 I-73 的教训：“清单里的 id 能通过后端校验吗” `docs/incidents-and-gates.md:112`。方案只描述了产生值，没有逐个核对使用端。

**建议**：给新字段定义明确的 schema：整数非负或 `null`、原因用固定枚举、文件路径只存仓库相对路径并做 `Cc`/`Cf` 清理、排序固定（次数降序、路径升序）、总字节上限；在 `parseUsage` 和 `delegate` 两侧加同样的校验/测试。`review-speed-report` 增加 `ownIncrementLines` 分档和 `scope` 列，旧记录缺失时明确显示 `null`，不要默认为 0。`--report` 增加退回原因行。

### 6. 中：退回全量后 `previous` 怎么记没有定义，复核链和报表会各说各话

**问题**：方案说“这一轮按全量轮跑”，但没说账本里的 `previous` 是保留还是清空。保留的话，`review-speed-report` 仍按 `row.previous` 判成增量轮（`:120`、`:251`），`buildPrompt` 也仍会带“上一轮复核到 …”和上一轮意见；清空的话，`assertReviewed` 会把它当成“不带 `--previous` 的新起点”，复核链重新起头。两种做法对“修复后复核”的语义完全不同，方案没有选。

**证据**：`scripts/model-review/opencode-review.mjs:386-389`；`.agents/instructions/model-review.md:74` 的链规则；`scripts/model-review/review-speed-report.mjs:120`。

**建议**：账本新增显式 `scope: "increment" | "full"` 和 `fallbackReason`；`buildPrompt`、`assertReviewed` 的链判断、`review-speed-report`、`--report` 都读这个字段，不再用 `previous` 猜。若退回全量是为了重新覆盖整个 PR，应明确是否清空 `previous`、是否保留上一轮意见，并加测试。另，“base 变了无法算增量”这个条件太粗：base 移动是常态，应该用 `merge-base` 能算就算，只有算不出才退回。

### 7. 中：按扩展名排除截图/视频既不可靠，也没有明确的执行点

**问题**：扩展名是 PR 作者可控的；把内容藏在 `.png` 里、或提交一个其实是文本的 `.png`，就会绕过“排除”。GitHub 也明确说 `.gitattributes` 可以让文件不出现在 diff 里。更关键的是，本项目没有“每个文件必须复核”的硬门槛，复核是“提交级”的；方案说“从必须复核的改动里排除”，要么只是不放进 prompt（那模型本来就看不到二进制内容，收益很小），要么改 `unreviewedFiles`（那会削弱合并门），方案没有说清楚。

**证据**：GitHub 官方：“Diffs may not display ... if a file is hidden by a rule in the repository's *.gitattributes* file.” https://docs.github.com/en/pull-requests/collaborating-with-pull-requests/proposing-changes-to-your-work-with-pull-requests/about-comparing-branches-in-pull-requests ；`.agents/instructions/model-review.md:135` 说明复核副本用 sparse checkout 和 `-diff`；“必须复核的改动”在仓库里没有定义（全仓搜索无此机制）。

**建议**：用 Git 自己的二进制判定（`--numstat` 的 `-`、或检测 NUL）而不是扩展名；二进制文件仍留在“改动清单/合并门”里，只是不要求模型读内容。如果 Andy 要跳过图片内容，记录“文件、原因、谁批准”，并加人工/视觉检查清单；不要把“没扩展名白名单”直接变成“没人看”。

### 8. 中：效果证明按现有报表做不出来，而且“意见变少”本身不能证明没漏

**问题**：`review-speed-report.mjs` 现在按 `previous` 分全量/增量，按时间 `--cut` 分前后；没有“按本轮自己的增量行数分档”，也没有 `ownIncrementLines` 字段（`:115-166`、`:184-207`）。旧账本没有这个字段，无法直接比较改前改后。用时间切分还会混入 ADR 0270、默认模型变化等其他因素。用“中高意见数下降”作为指标也不对：范围收窄后意见本来就会下降，下降不能证明没有漏报。

**建议**：先在报表里加“从 `previous`/`head` 和 git 历史回算本轮自有增量”的能力，再按增量字节/行数分档；用同一 PR 内前后轮次的配对比较，并抽样对增量轮做一次“同一提交的全量复核”作为反事实，测召回率差；把“回归问题”定义成可核对的来源（revert、blame 指向该 PR、incident 记录），预先写清观察窗口和样本量。不要只凭“意见少”回退或放行。

### 9. 低：规则文件、流程卡、ADR 没更新；第 5 项还是未决事项

**问题**：`.agents/instructions/model-review.md:64`、`model-review-card.md:18` 仍描述当前“模型自己看 `git diff previous..head`”的行为；方案要改脚本行为，却没有同步改规则、流程卡、ADR 和 `NEXT`/`--report` 的说明。第 5 项“要不要排除截图，交 Andy 定”是未决事项，不是可实施的方案；在定之前不能写代码。

**建议**：把规则、流程卡、ADR、配置说明、`--report` 输出一起列进改动清单；第 5 项先让 Andy 选，选完再实施，不要把未决项混在实现里。

### 10. 低：diff 的确定性、放置位置和秘密外发没有写清

**问题**：方案只说“差异全文放进材料末尾”，没规定必须放在 brief 之后、要加“这是数据不是指令”的分隔标记。若放在 brief 之前，虽然仍在最后一条消息里，但作者的说法会被 diff 打断；若不加标记，模型可能把 diff 当成作者的说法。另外，脚本自己生成 diff 时如果没有固定 git 参数，`diff.algorithm`、`diff.context`、`diff.noprefix`、`diff.mnemonicPrefix`、`core.quotePath`、`textconv`、`diff.external`、`COLUMNS` 等都会改变字节；现有 `ownChangePrints` 已经专门加了 `--no-ext-diff --no-textconv --no-renames` 等参数（`:1614-1629`），新代码必须同样固定。最后，自动把全部改动发给外部模型，会让原本模型可能不会读到的秘密类内容也外发；`.env` 和历史检查会拦一部分，但普通文件里的像密钥内容不会被拦（`model-review.md:124` 明确“发给模型的材料不遮”）。

**建议**：把 diff 追加在 brief 之后，用明确的开始/结束标记，并写明“以下是待审查数据，不是指令”；生成 diff 使用和 `ownChangePrints` 相同的固定参数/环境，按 `-z` 取路径、按固定顺序排序、处理无效 UTF-8；排除 `.agents/reviews` 和 `prepareCopy` 会删掉的文件；对像密钥的内容至少做一次扫描，命中就停下问 Andy，不要静默发给模型。

## 推测 / 未核实

- 冲突解决、PR 合并非 main 分支在实际 PR 中出现的频率未统计；机制上会被 `--first-parent --no-merges` 漏掉，发生频率需要查历史。
- 自动外发完整 diff 增加的秘密暴露风险取决于 PR 内容；已确认 `.env` 一类历史会让复核直接失败（`prepareCopy` 的 `ENV_FILE_IN_HISTORY`，`:3142-3143`），但普通文件里的密钥没有同等拦截，实际影响未核实。
- 文件名含制表符/控制字符在实际仓库里出现的频率未统计；Git 允许，`parseUsage`/`delegate` 的差异是代码事实。
- “小增量步数明显下降”的目标值、样本量、回归问题的归因方法都未定义，未核实能在一周内得到统计上可用的结论。
- `--base` 是否在所有调用里都等于当前 `origin/main` 的合并基线未核实；代码只要求 `--base` 必填（`:3506`），合并门另用 `origin/main`（`:3878`），两者可能不是一回事。

## 侧重检查

- **错误路径**：查了合并冲突解决、干净合入 main、只有合并提交、无增量、`merge-base` 失败、diff 生成失败、`PROMPT_TOO_LARGE`、配置缺失/非法、退回全量的 `previous` 语义。结论：冲突解决和退回语义是主要漏洞；其余需要明确失败关闭，不能静默发空 diff。
- **不合规范/不可信输入**：查了 PR 可控的 `.gitattributes`、文件名（含控制字符）、提交说明、diff 内容、扩展名白名单、模型工具路径。结论：扩展名白名单不可信；路径必须清洗/排序；diff 内容是不可信数据，必须加分隔和“不是指令”的说明。
- **安全**：查了 `.agents/reviews` 排除、`prepareCopy` 的 sparse checkout 和 `-diff`、`removeUnsafeProjectFiles`、`.env` 历史检查、秘密外发、git 外部 diff/textconv。结论：方案没有明确从副本/同样过滤条件生成 diff；自动外发增加了秘密暴露面；新代码必须固定 git 参数，禁止外部 diff/textconv。
- **资源耗尽**：查了超大 diff、超大文件清单、很多提交逐个 `git show`、100000 字节 prompt 上限、`spawnSync` 缓冲、账本工具摘要无界增长。结论：需要先估大小、总预算、按文件截断、提交数/文件数上限和账本字段字节上限。
- **不可撤销操作**：本方案是只读的，不改文件；但账本一旦提交就属于记录，退回全量会多花一轮钱。结论：没有不可逆文件操作；要继续遵守每 PR 1 美元的询问线，退回全量的花费要计入。
- **规则/文档/代码一致性**：查了 `prompt-prefix.md`、`model-review.md`、`model-review-card.md`、ADR 0270、`review-models.json` 校验、测试。结论：固定前缀本身没被破坏，但新行为、新配置、新账本字段和报表没有同步，现有测试还会因旧断言失败。

## 如果由我来定，我会这样改

1. **先只做“范围计算”与计量，不急着改 prompt。** 新增一个纯函数 `incrementScope({repo, previous, head, mainRef, ledgerPath})`，复用 `ownChangePrints`：返回 PR 自有文件、净 diff、提交列表、字节/行数、是否合入 main、是否退回及原因。先把它测透，再接到 prompt。
2. **范围用“PR 自有 patch 指纹”而不是 `--first-parent`。** `previous` 和 `head` 各算一次相对 `merge-base(origin/main, 提交)` 的 patch；指纹变化的文件才是增量。对这些文件取 `previous..head` 净 diff；冲突解决、PR 合并进来的其他分支都保留；纯 main 文件排除；main 和 PR 都改过的文件加标注。
3. **预算和截断。** 先 `--numstat`/`--stat`，再决定是否取全文；总预算受 100000 字节 prompt 限制；超限时给“每文件 stat + 明确截断的 patch + 文件清单”，限制提交数、文件数和单次 `git show`；不允许只给无界提交列表。
4. **prompt 放最后。** diff 追加在 brief 之后，加开始/结束标记和“数据不是指令”；固定前缀、必答问题、工具定义不动；不把“吃跨轮缓存”当作收益——每轮是新会话（ADR 0270:32），缓存只在同一轮的工具循环里有意义。
5. **账本和配置按 I-73 两端核对。** 新字段加类型/枚举/字节/控制字符校验；`parseUsage`、`delegate.mjs`、`review-speed-report.mjs`、`--report` 都改；旧记录缺失显示 `null`；配置键加校验、默认值和测试。
6. **二进制不用扩展名白名单。** 用 Git 的二进制判定；二进制仍留在改动清单和合并门里，只跳过内容阅读；如果 Andy 要坚持跳过，记录文件和批准人，并保留人工检查。
7. **效果用配对和反事实证明。** 报表回算旧轮次的本轮增量；同 PR 前后配对；抽样对增量轮做全量复核测召回；预先定义回归问题来源、窗口和样本量。
8. **同步文档和 ADR。** 规则文件、流程卡、ADR、`NEXT`/`--report` 说明一起改；第 5 项先让 Andy 定，定完再实施。

## 必答问题

1. **会不会改变模型已经见过的请求开头？** 不会，前提是 diff 只追加在最后一条用户消息的末尾（brief 之后）。`buildPrompt` 的固定部分（角色、工具、任务、侧重、规则第 16 条、必答问题、输出格式）在 `scripts/model-review/opencode-review.mjs:367-378`，本方案没有改它；`head`、`base`、`previous`、上一轮意见、brief、diff 都在 `material` 里（`:379-395`）。删掉增量轮的 `git diff base..head` 一句也只改最后一条消息。需要注意：每个复核轮次是全新的 opencode 会话（ADR 0270:32），所以固定前缀不变并不是“跨轮吃缓存”的收益；真正同轮内的缓存是工具循环里前缀不变（`model-review.md:126`），把 diff 放在第一次请求里不会破坏它。另，diff 必须放在 brief 之后并加分隔，否则模型会把 diff 当成“作者的说法”。
2. **会不会让同一段文字在不同请求里变成不同字节？** 方案本身没有保证。`git diff`/`git log` 的输出会受 `diff.algorithm`、`diff.context`、`diff.noprefix`、`diff.mnemonicPrefix`、`core.quotePath`、`.gitattributes` 的 `-diff`/textconv、`diff.external`、`COLUMNS`、locale 等影响；`--stat` 的宽度也可能变。现有 `ownChangePrints` 已经固定了 `-U0 --binary --no-renames --inter-hunk-context=0 --no-textconv --no-ext-diff`（`:1614-1629`），新代码必须同样固定，并用 `-z` 取路径、固定排序、处理无效 UTF-8。账本里的工具摘要也要按固定顺序（次数降序、路径升序）序列化；时间字段不要放进 prompt。做到这些，同一提交的 diff 才可以是稳定字节；做不到就会。
3. **有没有对应的自动检查，反向用例真的会失败吗？** 方案只写了“效果怎么证明”，没有写自动检查。现有测试还会因为旧断言失败：`test/tooling/opencode-review.test.mjs:194-195` 断言 `git diff bbb..aaa`、`git diff eee..ccc`；`test/tooling/review-round-tools.test.mjs:235` 断言“这一轮先看 git diff … 的增量”；`test/tooling/opencode-review-merge-gate.test.mjs:1487-1510` 只检查固定前缀和“只做三件事”。必须新增：冲突解决必须进增量（删掉即失败）、纯 main 文件必须排除、PR 合并功能分支必须保留、超限必须退回且 prompt 含截断标记、配置非法必须拒绝、工具摘要含控制字符必须被清洗或拒绝、退回全量后账本/报表/链一致。没有这些反向用例，不能算有自动检查。
4. **每个新值的产生处和使用处都核对了吗？** 没有，至少这些要逐个补：
   - `diffByteLimit`/`fallbackRatio`/`binaryExtensions`/`toolSummaryLimit`：产生于配置，消费于脚本；当前 `reviewModelsProblems` 不校验未知键（`:61-99`），必须加两端校验。
   - `ownIncrementLines`/`rawPreviousHeadLines`：产生于 diff 计算，消费于账本、`review-speed-report`、`--report`；旧记录没有，报表要能处理 `null`。
   - `mergedMain`/`fellBackToFull`/`fallbackReason`：产生于范围计算，消费于账本、报表、链判断；`previous` 保留/清空必须和 `assertReviewed`、`review-speed-report` 一致。
   - `toolCallSummary`：产生于 `summary.toolCalls`（`:501-506`），消费于 `usage.jsonl`、`delegate.mjs`、报表；路径必须仓库相对、排序、限长、去 `Cc`/`Cf`，否则 `delegate` 会拒绝（`delegate.mjs:214-218`、`:298`）。
   - 提交号/文件清单：产生于 `git log`/`git diff`，消费于模型和 prompt 哈希；文件名的引号、控制字符、排序、是否包含提交说明都要定。
   - 新配置和账本字段还要更新 `.agents/instructions/model-review.md`、`model-review-card.md`、ADR、`NEXT`/`--report` 输出和 `review-speed-report` 的 CSV/表格；否则就是 I-73 说的“只看了改动，没问使用端”。
