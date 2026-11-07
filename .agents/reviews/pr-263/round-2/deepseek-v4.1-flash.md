## 结论摘要

当前实现的主体逻辑与“第 2 轮”列出的改动一致，但我确认了两个中等问题：GLM 替补时仍收到“另一个复核者存在”的固定侧重；`--accept-low` 会把含换行的文件名写进账本，而 `parseUsage` 随后拒绝解析。另有几处文档/代码不一致和低风险错误路径。

---

## 一、读代码证实的问题（按严重度）

### 1. 中：GLM 替补时仍被告知“另一个复核者”在，可能把错误路径/安全交给不存在的复核者

- 文件:行：`scripts/model-review/opencode-review.mjs:182-183`、`:716-724`、`:2309-2314`
- 问题：`substituteFor` 只在单跑 DeepSeek、有 `--previous`、DeepSeek 重试后仍失败时返回 GLM；这时 GLM 是这一轮唯一的复核者。但 GLM 的固定侧重仍写“另一个复核者侧重别的方面”，会误导它以为错误路径、安全等已有人看。
- 证据：
  - `:183`：`"你的额外侧重：测试有没有覆盖这次改动、文档和规则与代码是否一致；…另一个复核者侧重别的方面，所以你仍要回答全部必答问题…"`
  - `:717`：`if (mode !== "code-review" || !previous || models.length !== 1) return null;`
  - `:2309-2314`：`console.log(\`REVIEW_SUBSTITUTE ...\`)` 后单独 `await runOne(substitute.model, substitutePrompt, …)`
  - 对比 DeepSeek 侧重已改成 `:181` 的“有时另有一个复核者……有时只有你一个”。
- 建议：把 GLM 侧重也改成“有时另有一个复核者……有时只有你一个”，或说明“无人替补时你负责全部侧重”。这仍是固定前缀，每轮不变；但会让 GLM 的旧对话/旧轮次前缀失效一次，需在说明里承认。

### 2. 中：low-fix 会写入含换行文件名的账本记录，随后所有检查都无法解析账本

- 文件:行：`scripts/model-review/opencode-review.mjs:987-1004`、`:1197-1208`、`:1357-1369`
- 问题：`lowFixProblems` 从 `git diff --numstat -z` 取文件名后直接放进 `files`，没有检查换行；`--accept-low` 直接 `JSON.stringify` 写入账本。但 `parseUsage` 用 `!hasLineBreak(record)` 拒绝任何字段含换行的记录。结果是：命令先打印 `REVIEW_LOW_FIX` 并以 0 退出，提交后 `--assert-reviewed` / `--report` 却因 `USAGE_LEDGER_INVALID` 无法解析整个账本。
- 证据：
  - `:1004`：`return { problems, files: changes.map((change) => change.file), errors };`
  - `:1206`：`files: check.files,`
  - `:1357`：`const singleLine = !hasLineBreak(record ?? {});`
  - `:1366-1369`：`!lowFixValid || !singleLine … throw new Error(\`USAGE_LEDGER_INVALID …\`)`
- 触发条件：修改了一个文件名含 `\n`/`\r` 的文件。项目测试里已经构造过含换行的文件名（`test/tooling/opencode-review.test.mjs:2242` 附近），所以不是纯理论输入。
- 建议：在 `lowFixProblems` 里对 `change.file` 做 `hasLineBreak` 检查并作为拒绝原因（如 `file-name-has-line-break`），或在写账本前用与 `parseUsage` 相同的校验预检；加一条反向测试，确认拒绝且不写记录。

### 3. 低：连续对同一轮 `--accept-low` 时，规模上限从“上一次 low-fix 的提交”起算，与规则文件的字面说法不一致

- 文件:行：`.agents/instructions/model-review.md:35`、`scripts/model-review/opencode-review.mjs:1119`、`:1186-1190`
- 问题：规则文件写“这一轮复核的提交之后只改了不超过 5 个文件、每个文件增删合计不超过 30 行”。代码在第二次 `--accept-low` 时，`complete` 可能是上一条 low-fix 点，`from: complete.head` 就从上次 low-fix 的提交起算，而不是从这一轮复核的提交起算。这样同一轮可以连续放行多次小改动，累计文件数/行数没有上限。
- 证据：
  - 规则：`.agents/instructions/model-review.md:35` 的“这一轮复核的提交之后只改了……”
  - `:1119`：`const complete = accepted.at(-1) ?? null;`
  - `:1186`：`else if (complete.round !== acceptLow) reasons.push(\`not-last-round last=${complete.round}\`);`
  - `:1189`：`lowFixProblems({ …, from: complete.head, to: head })`
- 说明：方案第 2 版写的是“每条低严重度修改最多 5 个文件”（`.agents/handoffs/2026-11-06-review-cost-plan-v2.md`），如果本意是“每条”，那么代码可能合理，但规则文件必须改；如果本意是“这一轮累计”，则代码这里可被绕开。两端至少不一致，且没有测试覆盖“同一轮第二次 accept-low”。
- 建议：明确策略。若按累计限制，始终以该轮复核点的 `head` 作为 `from`，或拒绝 `complete.by === "low-fix"`；若按每条限制，把规则文件改成“每条 low-fix 记录”，并加一条连续两次 `--accept-low` 的用例。

### 4. 低：`--report` 从 `HEAD` 读 verdicts，而合并前检查从 low-fix 记录自己的提交读；后续改动可让报告与已核验证据不一致，或让报告直接报错

- 文件:行：`scripts/model-review/opencode-review.mjs:1269-1274`、`:1096-1103`、`:960`
- 问题：gate 的 `lowFixProblems` 用 `to: point.head` 读 `verdicts.jsonl` 和模型答案；`reviewReport` 却固定用 `HEAD:${path}`。因为 gate 的 `changedOutside` 又允许 low-fix 之后只改记录目录（`:1085`），所以接受后修改/删除 verdicts 不会被 gate 拦住。此时报告可能显示被改过的原话、`verdict-missing`，或 `parseVerdicts` 抛错导致 `--report` 以非预期方式失败。
- 证据：
  - `:1272-1274`：`const path = \`${ledgerPath}/round-${record.round}/verdicts.jsonl\`; const text = gitStatus(["show", \`HEAD:${path}\`], repo); const verdicts = text.status === 0 ? parseVerdicts(text.stdout, path) : [];`
  - gate 侧 `:1101`：`to: point.head`；`:960`：`showAt(repo, to, verdictsPath)`
- 建议：报告也从 `record.head` 读，或者在 gate 中要求当前 `HEAD` 的 verdicts 与 `record.head` 一致；对 `parseVerdicts` 的异常做受控报错。

### 5. 低：测试改动检查可被“删除测试”或 `test/` 下的非测试文件满足

- 文件:行：`scripts/model-review/opencode-review.mjs:908-911`、`:987-1003`
- 问题：`isTestFile` 只要路径在 `test/`、`tests/`、`__tests__/` 下或后缀是 `.test`/`.spec` 就算测试文件；`lowFixProblems` 只统计 `numstat` 的增删合计，不区分新增还是删除，也不看文件内容。于是“只删除一个测试文件”或“新增 `test/README.md`”都能满足 `no-test-change` 检查，和“补测试”的本意不符。
- 证据：
  - `:910`：`/(?:^|\/)(?:test|tests|__tests__)\//.test(path) || /\.(?:test|spec)\.[cm]?[jt]sx?$/.test(path)`
  - `:990`：`const lines = match[1] === "-" ? Infinity : Number(match[1]) + Number(match[2]);`
  - `:1002`：`if (changes.length > 0 && !docsOnly && !changes.some((change) => isTestFile(change.file)))`
- 建议：至少要求某个测试文件有新增行（`match[1] > 0`），并限制到常见测试后缀/目录；加“只删除测试”“`test/README.md` + 代码改动”的反向用例。

### 6. 低：账本异常时 `assertReviewed` 可能直接抛错退出 2，而不是输出 `REVIEW_NOT_CURRENT` 并退出 5

- 文件:行：`scripts/model-review/opencode-review.mjs:1026-1028`、`:1117-1119`、`:2337-2339`
- 问题：`coveragePoints` 对任一“同一轮有多个不同 head”的覆盖记录直接 `throw REVIEW_ROUND_HEADS_DIFFER`；`assertReviewed` 没有捕获。现在它遍历所有轮次，而旧实现只在完整轮次上抛这个错，异常面扩大了。手工写坏或重复的账本会走到 `main().catch`，只打印一行并以 2 退出，不是受控的合并前拒绝。
- 证据：
  - `:1027-1028`：`if (heads.length !== 1) throw new Error(\`REVIEW_ROUND_HEADS_DIFFER ${round} ${heads.join(",")}\`);`
  - `:1117-1119`：`const points = records ? coveragePoints(records) : []; const { accepted, broken } = walkChain(...)`
- 建议：把这类异常转成 `REVIEW_NOT_CURRENT` 的 problem（或至少统一映射为退出码 5），并加坏账本用例。

---

## 二、推测/未核实

- **未核实**：作者说“测试 140 条全过；`npm run check` 和 `npm run build` 通过”。本轮只能读文件和跑允许的 git 命令，我没有执行 npm/测试，无法核实执行结果。测试文件里确实有大量正反例。
- **未核实**：PR #255 的 0.79 美元、DeepSeek 56%/GLM 58% 等数字来自账本和文档；当前检出中没有 `.agents/reviews/pr-255/`，无法复核。
- **推测（低）**：`apiErrorOf` 先对完整错误信息做 `[...raw]`、正则替换，再 `slice(0, 300)`（`:231-237`）。如果上游返回超大错误消息，会有一次不必要的内存/CPU 放大。可以先把 `raw` 截到一个合理上限再清洗。
- **推测（低）**：`apiError` 原文会写进提交到仓库的 `usage.jsonl`。若上游错误消息里意外带上凭据/令牌，会进入仓库；目前只去掉控制字符并截断，没有脱敏。是否可接受取决于上游错误消息的实际形态。

---

## 三、侧重检查

我查过的新增/改动路径：

- **错误路径**：`type:"error"` → `api-error` → 可重试判断 → 60 秒等待 → 第二次 `reviewOnce` → `retry:"retried"` → 替补；预算不足/时间不足/费用未知分别记 `no-budget`/`no-time`/`cost-unknown`。逻辑与文档大体一致。
- **不合规范/不可信输入**：空的 `retry-after`/`retry-after-ms` 已不再算可重试；重复 verdict id 已拒绝；malformed JSON 已拒绝；含换行文件名的 low-fix 路径有上面第 2 条问题。
- **安全**：`--accept-low`、`low-fix` 的 `head`/`from` 都经 `COMMIT_PATTERN` 校验；`files` 只用于比较和打印，不拼进 shell 命令。没有发现新的命令注入；`apiError` 未脱敏是推测性风险。
- **资源耗尽**：模型重试仍受每个模型 0.2 美元上限约束；替补前重新跑 `budgetCheck`。主要风险是上面推测的超大错误消息。
- **不可撤销操作**：`--accept-low` 是追加账本，不删除历史；但第 2 条会让它写出自己后续无法解析的记录，修复需要手工编辑账本。
- **规则/文档一致性**：发现 GLM 侧重措辞、`coveragePoints`/`lastCompleteRound` 说法、low-fix 规模上限措辞、ADR 第一轮措辞几处不一致。

---

## 四、必答问题

### 1. 这个改动会不会改变模型已经见过的请求开头？

**结论：在当前代码内部，同一模型的提示词仍然只在“本次材料”之后变化；会变的值都在最后一条消息里。**

- `buildPrompt` 的固定部分在 `:198-208`，由 `mode`、`model` 对应的固定侧重、`questions` 组成；`head`、`base`、`previous`、`brief` 全部放在 `:209-220` 的 `material` 里，位于 `---- 本次材料 ----` 之后。
- 重试时 `reviewModel` 用同一个 `prompt` 再调用 `reviewOnce`（`:741-755`），没有改写提示词开头。
- 追问只追加 `WRAP_UP_PROMPT`，仍是末尾追加。

**但有一个迁移性注意点**：这次把 DeepSeek 的固定侧重文字改了（`:181`）。对“这次提交之后才开始”的 PR，每轮相同；但一个 PR 如果第 1 轮在旧版本跑过、第 2 轮在新版本跑，DeepSeek 的请求开头会变，失去一次缓存命中。这不是每轮随机变化，但是“已经见过的开头”确实变了一次。建议在说明里承认这个一次性缓存失效；如果按第 1 条建议修改 GLM 侧重，也一样。

### 2. 会不会让同一段文字在不同请求里变成不同字节？

**结论：没有发现新的模型请求层面的非确定性。**

- 固定前缀没有时间、轮次、费用、随机数；`questions` 顺序由正则固定，`MODEL_LENSES` 是常量。
- `head`/`base`/`previous`/`brief` 即使变化，也只在“本次材料”之后。
- `usage.jsonl` 新增的 `at` 时间、`apiError` 文本、`retry` 等会变化，但它们不进入模型请求。
- low-fix 的 `files` 顺序来自 `git diff`，只用于账本/报告，不进入提示词。

### 3. 改动有没有对应的自动检查？反向用例是否真的会失败？

**有对应的测试，且从代码看反向断言会失败；但我没有执行测试，不能确认“140 条全过”和 npm 命令。**

已读到的覆盖点：
- 服务报错/重试：`test/tooling/opencode-review.test.mjs:460-503`、`:514-523`；空 `retry-after` 反向用例在 `:489-496`。
- 替补条件：`:533-556`，包括 `no-time`、`no-budget`、`retry` 为空、没有 `previous`、`plan-review`、GLM 自己等反向用例。
- 复核链：`:2320-2437`，包括 `previous` 跳过未复核提交、改写历史、GLM 单独不算、`--report` 单模型最后一轮。
- low-fix：`:2468-2677`，包括规模、测试改动、原话、`not-last-round`、证据不在自己提交上、`files-differ`、`findings-differ`、拒绝时退出码 5。
- 重复 id：`:3330-3333`。
- 固定前缀：`:3286-3294` 检查 DeepSeek 带不带 `--previous` 时固定部分相同。

**测试缺口**：
- 没有 GLM 替补时的提示词侧重测试（第 1 条问题）。
- 没有“low-fix 修改含换行文件名”的拒绝测试（第 2 条问题）。
- 没有“同一轮连续两次 `--accept-low`”的规模累计测试（第 3 条问题）。
- 没有“accepted 后修改/删除 verdicts，`--report` 显示什么”的测试（第 4 条问题）。

### 4. 每个新值/字段的所有使用方都能接受吗？

逐项核对结果：

- **`mode: "low-fix"`**：产生于 `:1201`；`parseUsage:1328-1331` 接受；`coveragePoints:1036-1044` 使用；`nextRound:1384`、`roundForRun:1401` 排除；`reviewReport:1270` 单列。**基本一致。**
- **`head` / `from`**：`parseUsage:1338-1344` 用 `COMMIT_PATTERN` 校验；`coveragePoints` 和 `walkChain:1061-1068` 使用；安全检查通过。**一致。**
- **`files` / `findings`**：`parseUsage:1346-1351` 要求非空字符串列表；`lowFixCheck:1105-1114` 与重算结果比较；`reviewReport:1276-1279` 打印。**但 `files` 的生产端 `lowFixProblems:1004` 没有拒绝含换行文件名，而 `parseUsage:1357-1369` 会拒绝整条记录——这是第 2 条问题。**
- **`--accept-low`**：`parseArgs:2069-2072、2008、2105-2106、2111` 接受并限制；`assertReviewed:1181-1215` 使用；`main:2149` 处理拒绝退出码。**一致。**
- **`lowFixRefused` / `accepted`**：`main:2149` 和 `reviewReport:1259-1261` 使用。**一致。**
- **`retry` / `apiError` / `retriedAfter`**：产生于 `:2269-2278`；`substituteFor:720-722` 只消费 `retry` 和 `summary.apiError`；`parseUsage` 不校验这些字段的类型，但它们不参与合并前判断（除非手工伪造账本，而账本本身就是信任边界）。**未发现新的一致性问题。**
- **`substitute` / `substituteFor`**：`coveragePoints:1018-1024` 消费；`parseUsage` 不校验类型。手工写账本可以伪造，但这和伪造普通 `outcome:"ok"` 记录是同一类信任问题，不是这次新增的绕过点。

---

## 五、作者说法逐条核对

- **“summarizeEvents 认出 type:error，outcome 记 api-error；apiErrorOf 去掉控制字符、截到 300 字；isRetryable 为 true 或带 retry-after 时算可重试。”**
  - 基本成立。但 `retry-after` 必须是**非空且可转成数字**；空值、`null`、纯空格都不算（`:239-247`）。作者原话“带 retry-after”不准确。
- **“reviewModel 在可重试的服务报错后等 60 秒再调用一次 reviewOnce；两次费用相加，第二次上限是 0.2 美元减去第一次花费；钱不到 0.07 美元或时间不够时不重试。”**
  - 成立。`retryAfterApiError:729` 的门槛是 `0.05 + 0.02 = 0.07`；第二次 `ownLimit = costLimit - startingUsd` 在 `:786`。时间门槛是等待后仍至少留 `WRAP_UP_MIN_MS * 4 = 60s`（`:730`）。
- **“substituteFor 只在 code-review、传了 --previous、只跑 DeepSeek、DeepSeek 结果是可重试的 api-error 时返回 GLM。”**
  - 成立，但还要求 `run.review.retry === "retried"`（`:720`），也就是“脚本真的重跑过”。作者第一段说法漏了这一点；第 2 轮的说法是对的。
- **“parseArgs：code-review 不传 --previous 也不传 --round 时必须两个模型；传了 --previous 不写 --models 时只跑 DeepSeek。”**
  - 成立（`:2118-2123`）。
- **“coveragePoints 从 lastCompleteRound 起，把之后 DeepSeek ok 或替补 GLM ok 的轮次、以及 low-fix 记录串成一条链。”**
  - **与当前代码不符。** `coveragePoints:1007-1047` 不再调用 `lastCompleteRound`；它遍历所有轮次生成点，再由 `walkChain:1049-1074` 按 `previous` 和“不带 previous 的双模型轮重新起头”来取舍。`lastCompleteRound:885` 现在只定义、没有任何调用，是死代码。作者的第一个说法应更新。
- **“assertReviewed 要求每一点的提交是前一点的后续，low-fix 点的 from 等于前一点的提交，并对 low-fix 点重新跑 lowFixProblems。”**
  - 成立；完整地说，带 `--previous` 的非 low-fix 点还要求 `previous` 是前一点提交的祖先或本身（`:1064-1069`）。另外 `isAncestor` 允许“同一个提交”，不是严格的后代，但同一提交不能绕过已有改动检查。
- **“lowFixProblems 核对 verdicts.jsonl 已提交、格式对、原话逐字出现、成立的 error 全是 low 且至少一条、规模上限和测试改动。”**
  - 成立。只不过它是在 `to` 提交上读证据（`:960`、`:974`），且没有处理文件名换行（第 2 条问题）。
- **“parseUsage 严格校验 low-fix 记录；nextRound、roundForRun 不把它算一轮；--report 单列。”**
  - 成立（`:1341-1351`、`:1384`、`:1401`、`:1269-1282`）。`--report` 读取位置的问题见第 4 条。
- **“测试 140 条全过；npm run check 和 npm run build 通过。”**
  - **未核实**，本轮没有执行测试或 npm。测试文件里确实有对应正反例，但不是执行结果。

另外两处文档小出入：
- `docs/adr/0174-cheaper-code-review-rounds.md:61` 写“第 1 轮只给一个模型时脚本拒绝”；实际 `parseArgs:2119-2121` 只在不传 `--previous` 且不传 `--round` 时拒绝。规则文件 `model-review.md` 已写了 `--round` 例外，ADR 这里应同步。
- `.agents/instructions/model-review.md:35` 的 low-fix 规模表述与代码按“上一次 low-fix 提交”起算不一致（第 3 条问题）。
