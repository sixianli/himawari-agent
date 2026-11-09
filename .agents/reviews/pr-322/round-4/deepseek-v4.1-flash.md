## 结论（按严重度从高到低）

### 读代码证实的

**1. 中 — 清单只读本地 `origin/main`，复核运行前没有 fetch，ADR 承诺的“main 上分支点之后新登记的值也遮得到”没有保证**
- 文件:行：`scripts/model-review/opencode-review.mjs:3027`、`:2544-2547`、`docs/adr/0190-mask-registered-test-values-in-review-records.md:51`（决定 2）、`.agents/instructions/model-review.md:44`
- 问题：写记录时执行 `registerTestValuesFromRefs(options.repo, [commits.base ?? commits.head, "origin/main"])`，而 `loadRegisteredTestValues` 是 `git show <ref>:ci/rules/gitleaks.toml`，只读本地引用。文档只在第 6 步（合并前）要求 `git fetch origin main`，复核运行本身没有 fetch。本地 `origin/main` 若落后，分支点之后在 main 新登记的值不会被遮，泄漏值会随记录提交（记录不可改写），正好回到“再补一块白名单”的老问题。
- 证据：
  - `registerTestValuesFromRefs(options.repo, [commits.base ?? commits.head, "origin/main"]);`（`:3027`）
  - `const shown = gitStatus(["show", \`${ref}:ci/rules/gitleaks.toml\`], repo);`（`:2545`）
  - ADR：“`--base` 提交和 `origin/main` 两处清单的并集（这样 main 上在分支点之后新登记的值，写记录时也遮得到）”（ADR 0190:51）
- 建议：复核开始前显式 `git fetch origin main`（或在交接步骤记录并固定 `origin/main` 的提交，再让复核读该提交），并把实际采用的清单提交写进账本/日志（如 `REGISTERED_VALUES_FROM <commit>`），便于事后核对“当时用的是哪版清单”。

**2. 中/低 — 材料“已核对的事实”与当前代码矛盾**
- 文件:行：`scripts/model-review/opencode-review.mjs:2576-2580`、`:2608`、`:3007-3016`；材料“已核对的事实”第 2 条
- 问题：材料说“`secretLikeRules` 也报它，合并门因此拒绝带着这些值的新提交记录”“`--assert-reviewed` 时从 `--main-ref` 读清单”。代码不是这样：
  - `secretLikeRules` 只遍历 `RECORD_SECRET_RULES`，不含登记值；
  - `main()` 在 `--report` / `--assert-reviewed` 分支提前 `return`，注册函数根本不会执行；
  - 合并门扫描记录用的是 `secretLikeRules`（`recordSecretProblems`），因此不会报登记值。
  这是第 3 轮有意改成这样的，但“已核对的事实”这一节本身仍写着旧行为，会误导复核者以为合并门还有一道安全网。
- 证据：
  - `return RECORD_SECRET_RULES.filter(...)`（`:2576-2580`）
  - `if (options.report) { ... return; } if (options.assertReviewed) { ... return; }`（`:3007-3016`）
  - `for (const id of secretLikeRules(shown.stdout))`（`:2608`）
- 建议：修正材料这一节，或明确标注“此条已被第 3 轮更新推翻”，避免后续复核者依赖错误事实。

**3. 低 — 提取器不区分 `regexTarget`/`targetRules`，多行单元素数组也会命中，与 ADR 的排除清单不一致**
- 文件:行：`scripts/model-review/opencode-review.mjs:2534-2542`；`docs/adr/0190-...md:49`
- 问题：ADR 说“单行三单引号，`regexes` 只有一个元素”才算、并说“多行数组不会被遮、`regexTarget = "match"` 的固定开头不会被遮”。实际正则 `/^regexes\s*=\s*\[\s*\'\'\'\^([^\n]*?)\$\'\'\'\s*\]\s*$/gm` 里 `\s*`（`\s` 含换行）能跨行，所以**单元素的多行数组也会被提取**；同时它完全不检查块里的 `regexTarget`/`targetRules`，只是碰巧当前 `line`/`match` 块的值含引号、反斜杠等被字符类挡掉。另外它把未转义的 `.` 当字面量（`\.` 被还原为 `.` 后再转义成字面点），若将来白名单用 `.` 作通配，会按字面遮错。
- 证据：`for (const match of text.matchAll(/^regexes\s*=\s*\[\s*\'\'\'\^([^\n]*?)\$\'\'\'\s*\]\s*$/gm)) {`（`:2536`）
- 建议：按 `[[allowlists]]` 分块解析，要求 `regexTarget = "secret"`（必要时再限定 `targetRules`），并要求点号只以 `\.` 形式出现；或把 ADR 的“单行/多行”描述改成与实现一致。注意 `test/tooling/gitleaks-allowlist.test.mjs` 目前会拒绝多行数组块，所以这是文档与潜在行为不一致，不是当前清单的实际故障。

**4. 低 — 非密钥的精确值白名单也会被遮成 `registered-test-value`**
- 文件:行：`scripts/model-review/opencode-review.mjs:2534-2541`、`:2558-2563`
- 问题：提取条件是“长度 ≥ 12 且在允许字符集内”，不看值是不是密钥。仓库现有白名单里既有测试假令牌，也有 tmpfs 挂载参数、幂等键、UUID 这类非密钥的精确值；它们在**任何**复核记录里出现都会被替换成 `[已遮盖:registered-test-value]`，读者会误以为被遮的是密钥，且记录丢失原词。就“防止 gitleaks 误报”而言这是合理的（这些值本来就是 gitleaks 的误报候选），但表述和可读性上有误导。
- 证据：`if (literal.length >= REGISTERED_VALUE_MIN_LENGTH && /^[A-Za-z0-9_\-=.:/ ]+$/.test(literal)) values.add(literal);`（`:2538`）
- 建议：把 ADR/文档里的“测试假值”改为“已登记的精确值白名单（含个别非密钥误报）”，或在遮盖标记里体现来源（仍不要放宽扫描规则）。

**5. 低 — `--self-check-only` 也会加载清单，与“只在写记录的复核运行里读”不一致**
- 文件:行：`scripts/model-review/opencode-review.mjs:3007-3016`、`:3027`、`:3055-3057`
- 问题：`--report`/`--assert-reviewed` 提前返回，但 `--self-check-only` 会走到 `:3027` 的注册。若 `--head`/`--base` 解析到的提交里没有 `ci/rules/gitleaks.toml`，自检会以 `REGISTERED_VALUES_UNREADABLE` 失败，尽管自检不写记录。ADR 决定 2 写的是“只在写记录的复核运行里读”。
- 建议：`if (!options.selfCheckOnly) registerTestValuesFromRefs(...)`，或在文档里说明自检也会读。

**6. 低 — 自动检查有，但几处关键接线/反向用例没覆盖**
- 文件:行：`test/tooling/opencode-review.test.mjs:2706-2722`、`:4659-4756`；`scripts/model-review/opencode-review.mjs:3027`
- 问题：
  - 没有测试覆盖 `main()` 里 `[commits.base ?? commits.head, "origin/main"]` 这条接线（`registerTestValuesFromRefs` 只被单元测试直接调用），改错 refs 或删掉调用不会被发现；
  - “合并门不报登记值”的端到端测试用 `for (const args of [["--assert-reviewed"]])`，数组只有一个元素，`--report` 分支实际上没跑（虽然它复用 `assertReviewed`）；
  - ADR 提到的“文件名含无效 UTF-8 时退回全部差异”只有内容字节的用例，没有文件名用例；
  - low-fix 的“PR 和 main 都动过的文件”行数场景没有用例。
- 建议：加一个 fixture 仓库（base/origin-main 都有清单）跑一次真实写记录/补跑，覆盖 `--assert-reviewed` 与 `--report`；再补 low-fix 双触碰和文件名边界。

**7. 低 — low-fix 文档与代码在“PR 和 main 都动过的文件”上说法含糊**
- 文件:行：`.agents/instructions/model-review.md:36`；`scripts/model-review/opencode-review.mjs:1149-1156`、`:1307-1314`
- 问题：文档说“PR 和 main 都动过的文件，行数仍按两个提交之间的全部差异算，偏多不偏少”。代码先用 `unreviewedFiles` 把文件筛成“PR 自己相对 main 的改动确实变了”的集合，再对该集合用 `git diff --numstat from to`。若某文件 PR 只在复核前改过、复核后只由 main 带来变化，它会被整体排除，不按“全部差异”计数。对“复核后被计入”的文件确实会偏多，所以不是放宽门槛，但文档的字面含义与代码不一致。
- 建议：把文档改成“只有在复核后 PR 自己还改过的文件才计；计入时行数取两个提交之间的全部差异（可能偏多）”。

### 推测（未运行验证）

**8. 低 — 登记值恰好是 `[已遮盖:<规则>]` 中规则 id 的子串时，可能破坏真密钥的遮盖标记**
- 文件:行：`scripts/model-review/opencode-review.mjs:2558-2563`
- 依据：先按 `RECORD_SECRET_RULES` 替换成 `[已遮盖:github-token]` 等，再对**结果**做登记值替换。若某登记值等于 `github-token`、`credential-assignment` 这类 id 的子串，就会把真密钥标记内部再替换一次。ADR 只承诺“登记值嵌在真密钥里也遮不坏真密钥”，这一点仍成立（真密钥已消失），但标记会被破坏。现有清单没有这种值，属理论风险。
- 建议：登记值替换时跳过 `[已遮盖:...]` 片段，或用一次合并正则同时处理两类规则。

### 未核实

- 本分支已提交的复核记录里是否含有任何已登记值（本复核环境读不到 `.agents/reviews` 的内容），因此无法确认“老记录已由现有白名单覆盖”是否对本仓库全部成立。
- 无法运行测试（本会话只允许只读 git 命令），第 3 问的“反向用例会不会真的失败”是基于代码与用例阅读判断。

---

## 侧重检查

- **错误路径**：`REGISTERED_VALUES_UNREADABLE` 是 fail-closed；`git show`/`rev-parse` 失败不会被静默忽略。`--report`/`--assert-reviewed` 不加载清单，避免清单变化把老记录判红（已确认）。`unreviewedFiles` 在算不出合并基线、某个文件 diff 失败或为空、文件名含替换字符时退回全量比较（`:1307-1314`），是保守方向。
- **不合规范/不可信输入**：清单来自仓库提交而非工作区，且不读被复核的 head，方向正确；值在拼进 `RegExp` 前做了完整转义（`:2553`），不会正则注入；`git diff` 的路径用 `:(literal)` 并放在 `--` 后，文件名以 `-` 开头也不会变成选项。`--base` 没有像 `--main-ref` 那样的“不能以 `-` 开头/不能含控制字符”校验（`parseArgs` 只校验后者），但它只进入 `git rev-parse` 参数、没有 shell，最坏是失败，不是注入；这是既有行为，不是本 PR 引入。
- **安全**：先遮真密钥形状再遮登记值，登记值不会让真密钥漏出（`:2560-2563`）；未改 `ci/rules/gitleaks.toml`，没有放宽扫描规则（diff 统计确认）。
- **资源耗尽**：登记值是字面量转义后的 alternation，不存在灾难性回溯；`maxBuffer` 为 256MB。清单是受复核的文件，规模可控。
- **不可撤销操作**：记录一旦提交就不能改历史，因此第 1 条的 `origin/main` 新鲜度问题是本改动最需要补的运维保障；遗漏的遮罩只能靠白名单或改历史补救。
- **规则/文档与代码一致**：`prompt-prefix` 方面无冲突（见必答 1）。不一致点集中在 ADR 0190 决定 2 的 `origin/main` 假设、决定 1 的“单行/多行、`regexTarget`”描述、以及材料“已核对的事实”的旧行为。

---

## 必答问题

**1. 会不会改变模型已经见过的请求开头？**
不会。发给模型的是 `reviewModel({ ..., prompt })` 里的原始 `prompt`（`:3153`），`buildPrompt` 未被改动，登记值没有进入提示词内容；遮盖只发生在落盘：prompt 存档 `:3145`、答案 `:3160`、报错 `:3205`、账本 `:3196`。每轮会变的 `--base/--head` 等本来就在用户消息里，追问只在末尾追加一条消息（`reviewModel` 既有逻辑未改），仍是“只追加、变值在最后一条消息”。规则依据：`.claude/rules/prompt-prefix.md:27-36`。

**2. 会不会让同一段文字在不同请求里变成不同字节？**
- 同一次运行内：不会。`setRegisteredTestValues` 先 `Set` 去重再按“长度降序、同长按码点”排序（`:2528-2532`），`registeredValuesPattern` 每次新建正则（`:2550-2556`），只做一次替换（`:2563`）；有测试覆盖顺序无关（`:4666-4673`）、最长优先（`:4725-4736`）、真密钥先遮（`:4738-4742`）、一次替换（`:4744-4749`）。
- 跨运行：清单来源（`--base`/`origin/main`）变化时，同一文本的落盘字节可以不同。这是 ADR 0190 决定 3 明说的取舍，且只影响记录存档，不影响发给模型的字节；补跑用三种接受形式兼容（`:1709-1722`）。因此对“模型请求/历史”而言仍满足确定性和只追加。

**3. 有没有对应的自动检查，反向用例是否真的会失败？**
有：`test/tooling/opencode-review.test.mjs` 覆盖了提取形状（`:4641-4645`）、近邻不遮（`:4654-4656`）、无登记时不遮（`:4659-4664`）、顺序无关（`:4666-4673`）、读不到/缺文件（`:4675-4692`）、多提交并集与跳过不存在提交（`:4694-4723`）、重叠最长优先（`:4725-4736`）、真密钥优先（`:4738-4742`）、一次替换（`:4744-4749`）、补跑三种接受形式（`:4050-4138`）、合并门不报登记值（`:2694-2723`），以及 `delegate.mjs` 用 `promptFileSha256` 核对存档（`test/tooling/review-delegate.test.mjs:709-732`）。这些反向用例在对应行为回退时会失败（近邻、顺序、重叠、真密钥优先、补跑多一个换行都会报 `ROUND_PROMPT_MISMATCH`）。缺口见第 6 条；我未运行测试，结论来自代码/用例阅读。

**4. 新增/修改的每个值，使用方是否都能接受？**
逐个核对：
- `[已遮盖:registered-test-value]`：写入 prompt/answer/stderr 与账本；账本校验只拒绝换行/控制字符和非法 `mode`，接受该标记（`:1609-1657`）；`delegate.mjs` 只做哈希与控制字符校验（`delegate.mjs:330-336`）；合并门的 `secretLikeRules` 不会把它当真密钥。都接受。
- `promptFileSha256`：**不是本 PR 新增**，base 已有产出（`:3172`）与 `delegate.mjs:335` 消费；本 PR 新增的是 `roundForRun` 接受账本里记录的该摘要（`:1709-1719`），两边都按十六进制摘要使用，接受。
- `{ registeredValues: false }`：仅内部/测试使用。
- 清单 refs：`commits.base`/`commits.head` 都是 `rev-parse` 出来的完整提交号，`loadRegisteredTestValues` 用 `git show` 读取；不存在的提交被跳过（`:2568-2571`），存在但缺文件抛 `REGISTERED_VALUES_UNREADABLE`，使用方（`main` 顶层 catch）接受并退出 2。
- 唯一不一致：提取出来的“值”并不等于白名单正则真正匹配的集合（字符类被跳过、未转义 `.` 被当字面量、忽略 `regexTarget`），见第 3 条；当前清单不受影响，但这是后续登记新值时的隐患。
