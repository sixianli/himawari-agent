## 结论

这一轮增量（`9d1ff1ff..6d312905`，忽略 `.agents/reviews/`）在**功能上是对的**：新增的 `promptFileSha256` 确实是“遮盖后存档文件”的摘要，`check` 优先用它核对文件，旧记录退回 `promptSha256`；正则/账本/重跑/遮盖各路径我逐个核对过，没有发现会更宽的绕过，也没有发现会被误拒的新路径。作者的说法与代码一致。下面的问题主要是测试缺口和文档措辞，不是这次改动引入的严重缺陷。

## 读代码证实的发现（按严重度）

### 1. 中：新字段“生产端”没有任何自动检查，只有消费端用例
- 文件：`test/tooling/review-delegate.test.mjs:702`，`scripts/model-review/opencode-review.mjs:2992`、`:3019`
- 问题：新用例把 `masked = "prompt [masked]\n"` 当字面量直接用，只验证 `delegate.mjs check` 是否优先读 `promptFileSha256`；没有任何测试验证 `opencode-review.mjs` 写的文件内容与它算出的摘要一致。也就是说，测试没有证明“写进仓库的字节 == 被摘要的字节”。
- 证据：
  - 测试自造字符串：`const masked = "prompt [masked]\n";`（`review-delegate.test.mjs:704`），随后 `{ promptFileSha256: fileSha }`（`:709`）、文件内容也用同一个 `masked`（`:713`）。
  - 生产端两处：`writeFileSync(join(roundDir, promptFileName(model)), maskSecretLike(prompt));`（`opencode-review.mjs:2992`）与 `promptFileSha256: createHash("sha256").update(maskSecretLike(prompt)).digest("hex")`（`:3019`）。
  - 全仓搜索 `promptFileSha256` 只有这两处生产、`delegate.mjs:335` 一处消费、以及那条测试；没有端到端测试把生产端的文件与账本字段对起来。
- 后果：如果以后有人把生产端改成对 `maskedRecordText(prompt)`（会去掉行尾空白、统一 CR）取摘要，或误改成对未遮盖原文取摘要，`check` 会误拒所有“材料含像密钥的文字”的合法结果，而现有测试仍然全绿。
- 建议：补一条针对生产端的用例（可用 `opencode-review.test.mjs:3574` 已用的 `fakeOpenAiKey` 构造提示词），断言 `readFileSync(promptPath) === maskSecretLike(prompt)` 且 `record.promptFileSha256 === sha256(maskSecretLike(prompt))`；或者加一条从“运行复核脚本 → 生成账本 → `delegate check`”的贯通用例。

### 2. 低：回退只解决“新消费者 + 旧/新生产者”，反方向仍会误拒，文档没写清
- 文件：`scripts/model-review/delegate.mjs:335`，`.agents/instructions/model-review.md:92`
- 问题：`record.promptFileSha256 ?? record.promptSha256` 在“旧记录（无新字段）”上确实会回退，但旧记录的 `promptSha256` 是**未遮盖原文**的摘要，而存档文件是**遮盖后**的。材料里一旦有像密钥的文字，回退仍然必然对不上。文档只说“旧记录没有这个字段时退回用 `promptSha256`”，容易让人以为旧记录也能自动通过。
- 证据：`else if (sha256(prompt) !== (record.promptFileSha256 ?? record.promptSha256))`（`delegate.mjs:335`）；生产端 `promptSha256` 用 `update(prompt)` 未遮盖、`promptFileSha256` 用 `update(maskSecretLike(prompt))`（`opencode-review.mjs:3018-3019`）。文档第 92 行只写了回退。
- 影响：不是安全漏洞（会拒，不会放行），但旧记录遇到含密钥材料时排障会困惑。属于能力限制，不是新引入的错误。
- 建议：在文档第 92 行点明“旧记录里若原文含像密钥文字，回退仍会报 `prompt-hash=`，只能人工核对/重跑”；或让 `check` 在回退失败时输出可区分的标记。

### 3. 低（既有问题，因这次改了同一行文档而被带出）：“存档的文本把回车统一换成换行”对 prompt 文件不成立
- 文件：`.agents/instructions/model-review.md:92`，`scripts/model-review/opencode-review.mjs:2992`、`:2432-2434`
- 问题：答案/错误输出走 `maskedRecordText`（先 `recordText` 统一 CR），但提示词存档直接写 `maskSecretLike(prompt)`，没有 CR 归一化；而 `buildPrompt` 里 `questions` 来自 `git show` 原样内容（`opencode-review.mjs:2875`，只有 `brief` 在 `:2876` 做了 `recordText`），所以提示词理论上可能带 `\r`。
- 证据：`writeFileSync(join(roundDir, promptFileName(model)), maskSecretLike(prompt));`（`:2992`）对比 `maskedRecordText`：`return maskSecretLike(recordText(text));`（`:2432-2434`）；`const brief = recordText(readFileSync(...))`（`:2876`）而 `reviewQuestions(questionsSource(...))` 未归一化（`:2875`）。
- 影响：**不影响新字段正确性**——文件与摘要用的是同一个字符串，哈希仍然一致；只是文档这句对 prompt 文件不准确。
- 建议：要么把提示词存档也走统一的归一化并把摘要改为对归一化后的文本计算，要么把这句限定为“答案、错误输出和账本”。

### 4. 信息：`parseUsage` 不校验 `promptFileSha256` 的类型/长度
- 文件：`scripts/model-review/opencode-review.mjs:1494-1562`
- 问题：账本对 `head`/`model`/`outcome`/`mode` 等有校验，但新字段是任意 JSON 值都能通过；`null` 会触发回退，数字/对象会因 `!==` 直接判为 `prompt-hash=`。不会造成放行，但会让畸形记录以“哈希不符”而不是“账本非法”结束。
- 证据：`fieldsValid` 只检查 `["head","model","outcome"]`（`:1512-1516`），`singleLine` 只保证无换行（`:1547`）；没有对 `promptFileSha256` 做 `^[0-9a-f]{64}$` 之类的检查。
- 建议：可选地在 `parseUsage` 里要求该字段为 64 位小写十六进制；不加强也可接受（账本本就被信任）。

## 不是缺陷、但值得记录（读代码证实）
- **新字段不会被遮盖机制破坏**：`maskSecretLikeDeep` 对每个字符串单独 `maskSecretLike`（`:2436-2445`），而 64 位小写十六进制摘要不含任何规则所需的特征（`----BEGIN`、`Bearer `、`sk-`、`gh*_`、`AKIA`、`key=` 等，见 `:2398-2416`），不会被替换。`promptSha256` 同样安全。
- **`--assert-reviewed` 不读新字段**：`assertReviewed` 用 `coveragePoints`/`walkChain`，不枚举账本字段（`:1237-1291`），新增键无影响。
- **补跑比对 `roundForRun` 不误用新字段**：它只读 `record.promptSha256`（`:1609-1611`），并用 `maskSecretLike(prompts[model])` 比对磁盘文件（`:1616`）；新记录两个字段都在，所以补跑仍能通过。
- **`check` 在遮盖/不遮盖两种情况下都对**：不遮盖时 `maskSecretLike(prompt)===prompt`，`promptFileSha256===promptSha256`，优先用新字段照样匹配；遮盖时新字段匹配磁盘文件。两种情况我都对过。

## 侧重检查（错误路径/不可信输入/安全/资源/不可逆/文档一致性）
- 错误路径：`promptFileSha256` 缺失 → 回退 `promptSha256`；为 `null` → 回退；为数字/对象/空串 → 严格不等，落到 `prompt-hash=` 拒绝。提示词文件缺失 → `missing=...prompt.md`。git 出错 → `DELEGATE_GIT_FAILED`。没发现崩溃或静默放行路径。
- 不可信输入：云端线程同时控制账本和提示词文件，新字段只把“文件 vs 账本”的内部一致性检查换成了“文件 vs 遮盖后账本”，**没有比原来更宽**——改动前 `promptSha256` 也从未与任何可信的“预期提示词”交叉核对（`delegationPrompt`/`checkResult` 都没有 Mac 侧的预期哈希）。新字段可被伪造，但旧字段同样可被伪造，属同一信任模型。
- 安全/遮盖：摘要不可被 `maskSecretLike` 命中；账本仍然先遮盖字段再序列化（`:2444-2445`），新增字段不携带原文，不增加泄漏面。`generic-api-key` 等熵值盲区照旧由 CI gitleaks 兜底，未因本改动扩大。
- 资源耗尽：每行多 64 字节、每次运行多一次 SHA-256，可忽略；没有新增循环或临时文件。
- 不可逆操作：本增量无删除/覆盖外部状态的操作。
- 文档一致性：第 92、137 行关于 `promptFileSha256` 的描述与代码一致；第 105 行“提示词文件不在时用 `promptSha256`”仍成立。第 92 行“存档文本回车统一”对 prompt 文件不成立（发现 3）。第 137 行笼统写“哈希对得上 `promptFileSha256`”，未提旧记录回退，属轻微措辞不严。
- 未核实：`.agents/reviews/pr-300/round-6/*` 在当前 sparse checkout 中不存在，`git show` 访问被包装器以 `REVIEW_GIT_REFUSED records-path` 拒绝，因此我无法直接读第 6 轮的原文，只能以本次材料里的转述为准；“241 条通过 / 单独重跑通过 / 改回旧逻辑会失败”这些实测结论我无法执行测试，标为未核实；但按测试写法推断，把 `check` 改回只看 `promptSha256` 时，正向用例 `attempt(sha(masked)).status` 会是 rejected，测试会失败，这一点与作者说法一致。

## 必答问题

1. **会不会改变模型已见过的请求开头？** 不会。这个提交只改了账本字段和文档：提示词构造在 `buildPrompt`（`opencode-review.mjs:277-306`）、发送在 `reviewModel({prompt,...})`（`:3000`）、存档写入在 `:2992`，都没有变。发给模型的内容仍然只在末尾追加；新增的 `promptFileSha256` 只进 `usage.jsonl`，不进提示词，且它是确定值、不带时间。唯一带时间的 `at` 是既有字段，写在账本里，不在提示词里。

2. **同一段文字在不同请求里会不会变成不同字节？** 不会。`maskSecretLike` 每次调用都新建 `RegExp`（`:2419-2423`），无 `lastIndex` 残留，对相同输入输出相同；新字段是 SHA-256 摘要，不依赖前后文，也不涉及无序集合。提示词本身的构造未改动。

3. **有没有对应自动检查、反向用例真的会失败？** 消费端有：新用例正向用 `sha(masked)` 期望 `ok`、反向用 `sha("other\n")` 期望出现 `prompt-hash=`（`review-delegate.test.mjs:721-722`）。反向用例是有效的（若 `check` 不比对哈希或比错字段，它会失败）。但**生产端没有检查**（发现 1），这是这次改动最值得补的地方。

4. **新值每个使用它的地方都能接受吗？** 能：
   - 生产：`opencode-review.mjs:3019`，值 = `sha256(maskSecretLike(prompt))`。
   - 序列化：`ledgerLine`/`maskSecretLikeDeep`（`:2444-2445`）逐字段遮盖，64 位小写十六进制不会被任何规则命中。
   - 解析：`parseUsage`（`:1494-1562`）接受额外字段，无换行即可通过。
   - 消费：`delegate.mjs:335` 用 `promptFileSha256 ?? promptSha256`，缺失时回退；`assertReviewed` 不读它；`roundForRun` 只用 `promptSha256`，不会因新字段误拒。
   - 结论：两端校验都通；新字段没有带来比以前更宽的绕过（账本与提示词文件本来都由同一个云端线程写，旧检查同样只是内部一致性）。
