### 1. 高：shadow 的花费没有计入后续普通复核的预算和 `REVIEW_SPENT_TOTAL`

文件：`scripts/model-review/opencode-review.mjs:3973`、`:3982`、`:4265`

问题：只有 shadow 自己运行时才会读父账本；反过来，普通复核轮完全没读 `shadow/usage.jsonl`。于是 shadow 花的钱不会进入 `budgetCheck`，打印给主线程的 `REVIEW_SPENT_TOTAL` 也不含它，PR 的 1 美元上限可以被突破。

证据（读代码证实）：
- `const parentRecords = options.shadow ? readUsage(dirname(options.out)) : [];`
- `records: [...records, ...sameFileRecords, ...parentRecords],`
- `const totalSpent = spentOf(readUsage(options.out));`
- 对照 `dailySpend` 和 `--report` 都专门加了 shadow：`:1269-1273`、`:2096-2100`、`:2150`。
- 文档写的是“花费算进这个 PR 的 1 美元和当天合计”（`.agents/instructions/model-review.md:167`）。

建议：普通轮也读 `<ledger>/shadow/usage.jsonl` 加入预算和打印总额；补充用例：父账本 0.9 美元 + shadow 0.15 美元时，下一轮应触发 `BUDGET_NEEDS_APPROVAL`。

### 2. 中：`shadowRunsDone` 数的是模型记录，不是抽样轮次

文件：`scripts/model-review/increment.mjs:298-313`

问题：每有一条 `outcome === "ok"` 的记录就加一，而一轮 shadow 复核会为每个模型各写一条记录。`--models deepseek-v4.1-flash,glm-5.3-flash` 时，`shadowFullTotal: 10` 实际只抽样 5 轮；一轮里只有一个模型成功时也会被算作完成一次抽样。

证据（读代码证实）：
```
if (record?.outcome === "ok") count += 1;
```
ADR 0280 说的是“前 10 个增量轮各补跑一次全量复核”（`docs/adr/0280-...:112`）。测试 `test/tooling/review-increment.test.mjs:363-398` 只放了一条 ok 记录，暴露不了这个问题。

建议：按 `pr` + `head` 去重计数（或写一条运行级标记），并测试双模型和部分失败两种情况。

### 3. 中：`SHADOW_FULL_SUGGESTED` 的命令没有转义 brief 路径，也漏了模型/服务方/批准额度

文件：`scripts/model-review/increment.mjs:329-330`、`scripts/model-review/opencode-review.mjs:4273`

问题：`--brief ${brief}` 直接拼进 shell 命令。brief 路径带空格、分号等字符时命令会拆坏，最坏会在主线程照跑时变成命令注入；同时命令没有带 `--models`、`--providers`、`--approved-usd`，抽样全量复核可能和增量轮用的模型集不同，或因父账本已接近 1 美元直接 `BUDGET_NEEDS_APPROVAL`。

证据（读代码证实）：
```
return `node scripts/model-review/opencode-review.mjs --mode code-review --shadow --pr ${pr} --base ${base} --head ${head} --brief ${brief}${gateway ? ` --gateway ${gateway}` : ""}`;
```

建议：对路径做 shell 转义（或改为输出 argv/JSON），并带上本次运行实际使用的模型、服务方和批准额度；补一条 brief 路径含空格的测试。

### 4. 中：合并基线算不出时没有退回，main 改动会混进“本轮增量”

文件：`scripts/model-review/increment.mjs:117-123`

问题：`mergeBase` 失败时 `basePrevious`/`baseHead` 为 `null`，`mainChanged` 被当成空数组，函数仍返回 `fallback: null`。此时 `unreviewedFiles` 因为 `ownChangePrints` 失败会退回“全部改动文件”，`previous..head` 里合并 main 带进来的内容会被当作 PR 自己的差异，和提示里“不含只是合并 main 带进来的文件”相反。

证据（读代码证实）：
```
const basePrevious = mergeBase(repo, mainRef, previous);
const baseHead = mergeBase(repo, mainRef, head);
const mainChanged =
  basePrevious && baseHead && basePrevious !== baseHead
    ? numstat(repo, basePrevious, baseHead, ...)
    : [];
```
ADR 0280 把“合并基线算不出”明确列为应退回的情况（`docs/adr/0280-...:67`），代码没有对应原因。

建议：`files` 非空且任一 merge-base 为 `null` 时返回 `{ fallback: "merge-base-failed" }`；补 shallow clone 或无关历史的用例。

### 5. 中：速度报表把退回轮也回算成增量轮分档，污染“改前/改后”对比

文件：`scripts/model-review/review-speed-report.mjs:281`、`:326`

问题：退回记录的 `increment` 是 `{ fallback: "..." }`，`increment?.lines` 是 `undefined`，因此仍会进入 `backfillIncrements`，随后被 `bucketStats` 按回算出的增量行数分档。这些轮实际仍用了旧的整段差异，却会被当成“优化后的小增量轮”，让对比表偏向好看或失真。

证据（读代码证实）：
```
if (!round.previous || round.increment?.lines !== undefined) continue;
...
const groups = roundGroups(rounds).filter((group) => group.rows.some((row) => row.previous));
```

建议：回算时跳过 `round.increment?.fallback`，或把退回轮单列一档；补 `backfillIncrements` 的真实 git 用例。

### 6. 低：增量块预算按“未加增量的提示”计算，且截断列表导致少放文件；提示总长没有测试

文件：`scripts/model-review/opencode-review.mjs:1718`、`:3944-3969`；`scripts/model-review/increment.mjs:211-219`

问题：`promptBytes` 来自 `promptsWith(null)`（旧的退回提示），但加增量后材料文字会被替换。当前两段替换文字恰好更短，所以“总长不超过 100000”成立；一旦将来改文案使 scoped 文字更长，代码不会退回，而是在 `:3968-3969` 直接抛 `PROMPT_TOO_LARGE`。另外 `used` 初始值包含“全部文件”的截断清单，之后加入文件时从不减去缩小的清单字节，可能把本来放得下的文件也标成截断。

证据（读代码证实）：
```
budget: Math.min(config.inlineDiffMaxBytes, PROMPT_MAX_BYTES - promptBytes - 1),
...
let used = Buffer.byteLength(render(kept).block);
...
if (used + size > budget) continue;
```

建议：用实际 scoped 材料长度算预算（或最终检查超限时返回 `too-large` 退回），每轮从 `render(kept)` 重新算已用字节；补接近 100000 字节的长 brief 用例。

### 7. 低：`toolSummary` 的校验两端不一致，`parseUsage` 接受控制字符而委托校验拒绝

文件：`scripts/model-review/increment.mjs:278-295`、`scripts/model-review/opencode-review.mjs:2258-2262`、`scripts/model-review/delegate.mjs:214-219`

问题：`parseUsage` 只用 `hasLineBreak` 挡 `\r\n`，所以 `topReads` 里的 `\u0007` 等控制字符能通过；`delegate.mjs` 的 `hasControlText` 用 `\p{Cc}\p{Cf}`，会拒绝同一份记录。这正是“两端校验不一致”的情形。另外 `byTool` 用普通对象，工具名正则允许 `constructor` 这类原型键；当前工具集固定（read/grep/glob/bash 等），所以这条属推测性风险。

证据（读代码证实）：
```
pair[0] 1 个字符串、pair[1] 为正整数            // toolSummaryValid，未查控制字符
...
if (typeof value === "string") return hasControlCharacter(value) || /[\p{Cc}\p{Cf}]/u.test(value);
```

建议：`toolSummaryValid` 同样拒绝 `\p{Cc}\p{Cf}`，`byTool` 改用 `Object.create(null)` 或 `Map`；补 `\u0007` 的反向用例。

### 8. 低：增量范围与 `assertReviewed` 的范围并非严格相同

文件：`scripts/model-review/opencode-review.mjs:1697` 对比 `:1740-1741`、`:1773-1776`

问题：`planIncrement` 直接调用 `unreviewedFiles`；`assertReviewed` 还额外用 `!claimsOwned.has(file)` 过滤，并要求 `main` 已合并。作者说“和合并前检查的判断一致”只在文件集合的核心算法上成立，不是完全等价。

证据（读代码证实）：
```
const unreviewed = (from, to) =>
  unreviewedFiles(repo, from, to, ledgerPath, mainRef).filter((file) => !claimsOwned.has(file));
```
影响是模型可能多查 plan-claims 的账本文件（多查而非漏查），以及 `main-not-merged` 时增量照算但合并检查会拦。

建议：把“本次该复核哪些文件”抽成共用函数，或在文档里写明增量比合并检查多看的范围。

**侧重检查**

- 错误路径：查了配置缺失/非法（`config-missing`、`INCREMENT_CONFIG_INVALID`）、`main-ref-missing`、`diff-failed`、`file-name-invalid`、`too-large`、`REVIEW_INCREMENT_EMPTY`；发现合并基线失败没有退回（第 4 条）。
- 不可信输入：文件名控制字符/U+FFFD 有拦截；diff 作为数据块追加并标注；`toolSummary` 路径会清洗控制字符；`--shadow` 的参数组合有校验；但 `SHADOW_FULL_SUGGESTED` 的 shell 拼接未转义（第 3 条）。
- 资源与花费：内联字节有上限、git `maxBuffer` 256MB；但 shadow 花费绕过 PR 预算（第 1 条），且 `shadowRunsDone`/`readUsage` 对账本文件大小没有额外上限（账本正常由脚本生成，未作为独立问题列出）。
- 不可撤销操作：没有新增删除/重写账本的操作；shadow 追加写自己的账本。
- 规则/文档与代码：`model-review.md:167` 与预算实现不一致（第 1 条）；ADR 0280:67 的合并基线退回未实现（第 4 条）；ADR 0280:68 说二进制列“路径和大小变化”，代码只列路径（`increment.mjs:172-174`），`model-review.md` 也只写路径；ADR 0280:74 要求路径固定顺序，`scope.binary`/`mainOverlap` 实际按 git numstat 顺序，未显式排序。
- 作者说法核对：第 1 条“只合并 main 时为空”基本成立，但范围不完全等于 `assertReviewed`（第 8 条）；第 2 条“手工解决冲突进入增量”由代码和用例支持；第 3 条“不超过 100000”在当前文案下成立，但没有测试兜底（第 6 条）；第 4 条“不进复核链”成立，但 shadow 文件在 ledger 路径下会被 `recordSecretProblems` 扫到，且花费未进 PR 预算（第 1 条）。

**必答问题**

1. 固定前缀没有被改：`buildPrompt` 的 `fixed` 数组未动，新内容只在 `material` 里；测试也逐字节比了“本次材料”之前的部分（`test/tooling/review-increment.test.mjs:222-235`）。增量轮替换的是材料里的两句说明，属于最后一条用户消息；`head`、`base`、`previous`、上一轮意见和增量块都在最后一条消息里。没有修改系统提示、工具定义或历史消息。答案：是，仍然只在末尾追加，每轮会变的值都在最后一条消息里。

2. 正常重跑时字节确定：git 参数固定、`LC_ALL=C`、`core.quotepath=false`、关闭 external diff/textconv/rename，文件清单按路径排序，`toolSummary` 按键和次数排序，提示里没有时间字段。`scope.binary`/`mainOverlap` 依赖 git 自己的输出顺序，没有显式排序，但同一仓库同一 git 重跑是稳定的；不同 git 配置/机器的行为未核实。结论：同一轮重跑逐字节相同有代码依据，但没有直接测试。

3. 有自动检查，且存在会失败的反向用例：配置非法、账本负数/错误类型/换行、`shadow:false`、非法的 `--shadow` 组合都会抛错并有用例断言。缺口是：没有测“完整提示 ≤100000”、`backfillIncrements`、双模型下的抽样计数、`--assert-reviewed` 不受 shadow 影响、`main()` 的 `REVIEW_INCREMENT_EMPTY` 真正退出、退回轮不进入报表分档。原有 `review-round-tools.test.mjs:235` 仍断言旧提示文字，只是因为它调用 `buildPrompt` 时没传 `increment`，走的是退回分支，并没有覆盖新的增量提示。测试未实际运行，“全部通过”未核实。

4. 逐个核对的结果：`increment`、`toolSummary`、`shadow` 由 `parseUsage` 校验，`delegate.mjs` 也走 `parseUsage`；`review-speed-report.mjs` 不校验账本但读取时对 `increment.lines` 做了类型保护，坏值大多只会变成空值。`shadow` 目录在 `dailySpend`、`reviewReport`、`rawDir` 中一致使用；`shadowRunsDone` 硬编码 `"shadow"` 而不是 `SHADOW_DIR`。发现的两端不一致是 `toolSummary` 控制字符（第 7 条）和退回轮报表口径（第 5 条）。配置键 `inlineDiffMaxBytes`、`contextLines`、`maxFilesListed`、`toolSummaryTopFiles`、`shadowFullTotal`、`reportBucketLines` 的读写都在新模块内且经过校验。仓库内其他脚本、CI、合并队列是否还有未同步的账本消费者：未核实。
