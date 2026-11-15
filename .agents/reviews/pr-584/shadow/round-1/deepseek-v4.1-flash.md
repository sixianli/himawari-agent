## 复核结论

### 1. 高：substitute/补跑路径引用未定义的 `parentRecords`，模型失败时会直接崩溃
**文件:行**：`scripts/model-review/opencode-review.mjs:4241`（相关定义在 `4008`）

**问题**：最后一次重构把 `parentRecords` 改成了 `linkedRecords`，但 substitute 分支仍然读 `parentRecords`。主模型失败、需要补跑（或 shadow 运行中模型失败）时，这里会抛 `ReferenceError: parentRecords is not defined`，预算核对根本走不完，已经写进账本的记录也不会正常汇总。

**证据**：
```js
4008:  const linkedRecords = linkedLedgerRecords(options);
...
4241:              records: [...readUsage(options.out), ...parentRecords],
```
我全文搜索过，`parentRecords` 只有这一处使用，没有任何定义。

**建议**：这里应改用 `linkedRecords`。同时补一个“主模型失败触发 substitute”的集成测试，断言预算检查用的是父/影子账本；现有新测试没有覆盖 `main()` 的这段路径。

**类型**：读代码证实。

### 2. 中：截断清单不符合 ADR 0280 的“每个文件列改动行数和精确命令”，文档与 ADR 也不一致
**文件:行**：`scripts/model-review/increment.mjs:162-165、203-206`；对照 `docs/adr/0280-incremental-review-rounds-see-only-the-pr-s-own-increment.md:63`

**问题**：ADR 决策第 2 条要求“放不下的文件只列文件名、改动行数和取差异的精确命令”。代码只列出 `- <文件>`，然后给一条带占位符的通用命令 `git diff <previous>..<head> -- <文件>`，既没有每个文件的增删行数，也不是可直接复制的精确命令。`model-review.md` 写的是“文件名和取差异的命令”，与代码一致但与 ADR 不一致。

**证据**：
```js
203:      ...(skipped.length > 0
204:        ? [
205:            `已截断：下面 ${skipped.length} 个文件的差异放不下，需要时自己用 git diff ${previous}..${head} -- <文件> 取：`,
206:            ...listWithLimit(skipped, config.maxFilesListed),
```
`listWithLimit` 也只生成 `- ${file}`。

**建议**：让 `skipped` 带上 `numstat` 的行数，渲染为 `- <文件>（N 行增删）`，并为每个文件生成带实际路径（和 `:(literal)` 保护）的命令；或者明确修改 ADR/文档，说明这里只列文件名和通用命令。加一条断言截断内容包含行数和实际文件名的测试。

**类型**：读代码证实；对模型取数的影响是合理推断。

### 3. 中低：`shadowCommand` 没有保留 `--require-gateway` 等运行约束，shadow 复核可能不是“照跑原命令”
**文件:行**：`scripts/model-review/increment.mjs:334-343`

**问题**：建议命令保留了 `--gateway`、`--models`、`--providers`、`--approved-usd`，但没有带 `--require-gateway`，也没有带 `--questions-ref`、`--timeout-minutes`。委托执行线程生成的普通命令固定带 `--gateway magpie --require-gateway`；如果主线程照跑 shadow 命令，`gatewayRequiredProblem` 不会再检查环境是否真是 Magpie/代理是否可用，固定问题集和时间上限也可能和原轮不同。

**证据**：
```js
334: export function shadowCommand({ pr, base, head, brief, gateway, models, providers, approvedUsd }) {
336:    "node scripts/model-review/opencode-review.mjs --mode code-review --shadow",
339:    models?.length ? `--models ${shellQuote(models.join(","))}` : null,
```
没有 `requireGateway`、`questionsRef`、`timeoutMinutes` 参数。

**建议**：从 `options` 原样透传这些参数并正确引用；补一条测试，检查委托命令里的 `--require-gateway` 在 shadow 命令中也存在。若刻意不传，应在文档里说明原因。

**类型**：参数遗漏读代码证实；实际费用/路由影响为推测。

### 4. 低：`truncated` 把“文件清单被截断”和“差异被截断”混成一个值，账本和 `REVIEW_RESULT` 会误导
**文件:行**：`scripts/model-review/increment.mjs:228`

**问题**：`truncated` 在 `scope.files.length > listed.length` 时也为 true。一个 PR 改了超过 `maxFilesListed`（默认 200）个文件但总差异很小、全部内联时，账本会记 `truncated: true`，`resultLine` 输出 `increment=...-truncated`，但实际没有 `已截断` 段，差异一行都没少。报表和人工判断会把“清单只列前 N 个”误当成“差异没给全”。

**证据**：
```js
228:    truncated: result.skipped.length > 0 || scope.files.length > listed.length,
```

**建议**：拆成 `diffTruncated` 和 `listTruncated`，或让 `truncated` 只表示差异被省略；`resultLine` 和报表分别消费。补一个“文件数超过上限但全部差异都内联”的反向用例。

**类型**：读代码证实。

### 5. 低：`shadowRunsDone` 绕过账本校验直接 `JSON.parse`，对其他 PR 的坏影子账本会静默忽略
**文件:行**：`scripts/model-review/increment.mjs:299-313`

**问题**：抽样计数逐行 `JSON.parse`，异常直接 `catch {}`，不检查 `cost`、`round`、`increment` 等字段，也不使用 `parseUsage` 的校验。当前 PR 的坏影子账本通常会在 `budgetCheck` 的 `linkedLedgerRecords` 处先被拒绝，但其他 PR 的坏账本会被这里静默跳过，可能让“全项目已完成 10 次”的判断失真；这与 I-73“账本格式错误必须被拒绝”的要求不一致。此外它只扫描当前工作区的 `.agents/reviews`，未合入当前分支的 shadow 记录不算“全项目已完成”。

**证据**：
```js
305:      for (const line of readFileSync(ledger, "utf8").split("\n")) {
307:        try {
308:          const record = JSON.parse(line);
309:          if (record?.outcome === "ok") done.add(`${entry}\0${record.round}`);
310:        } catch {}
```

**建议**：复用 `readUsage`/`parseUsage` 或抽一个已验证的读取函数；明确计数口径（当前工作区还是已提交 main），坏账本应让调用方失败而不是被吞掉。

**类型**：读代码证实；跨 PR 影响和“全项目”口径为推测。

### 6. 低：差异在字节预算判断前已整份读入内存，超大 PR 文件可造成资源耗尽
**文件:行**：`scripts/model-review/increment.mjs:145-159、182-197`（`git` 的 `maxBuffer` 在 `58` 行附近）

**问题**：`patchFor` 对整个文件的 `git diff` 输出调用 `spawnSync(... encoding: "buffer", maxBuffer: 256 * 1024 * 1024)`，然后才在 `incrementBlock` 里按 60KB 预算截断。`pieces` 先把所有文件的 `piece` 都放进数组，`render` 还会反复拼完整块。PR 内容不可信，一个巨大的文本文件就可能占用数百 MB 内存和大量 CPU，而配置的 `inlineDiffMaxBytes` 完全不能阻止先读入。

**证据**：
```js
145: function patchFor(repo, from, to, file, contextLines) {
...
148:  const result = git(repo, [
...
182:  const pieces = [];
183:  for (const file of scope.files.filter((name) => !scope.binary.includes(name))) {
184:    const patch = patchFor(repo, previous, head, file, config.contextLines);
```

**建议**：先用 `--numstat` 或 `--stat` 预判文件大小，超过单文件上限就不读入、直接列入“已截断”；或按预算流式读取；至少给单文件 diff 设独立字节上限。补一个大文件/二进制伪装成文本的用例。

**类型**：机制读代码证实；资源耗尽后果为推测，未实际构造大文件验证。

### 7. 低：不可信文件名只拒绝 C0/DEL，Unicode 格式字符（含双向控制符）仍会进入提示和清单
**文件:行**：`scripts/model-review/opencode-review.mjs:2191-2195`；`scripts/model-review/increment.mjs:1713`

**问题**：`planIncrement` 只拒绝 `\uFFFD` 和 `hasControlCharacter`，而后者只覆盖 `<32` 和 DEL，不覆盖 `\p{Cf}`。因此文件名里的 RTL override 等格式字符会原样进入“文件清单”“二进制文件”“main 也改过”等提示文字和账本字段。`toolSummary` 反而会替换 `\p{Cc}\p{Cf}`，两个路径不一致。

**证据**：
```js
2191: export function hasControlCharacter(text) {
2193:    const code = character.codePointAt(0);
2194:    return code < 32 || code === 127;
...
1713:  if (files.some((file) => file.includes("\uFFFD") || hasControlCharacter(file)))
```

**建议**：对文件名使用 `\p{Cc}\p{Cf}` 检查，或显示前统一替换/转义；`incrementBlock` 内的路径列表也应使用同一净化函数。补一个带 `\u202E` 文件名的反向用例。

**类型**：读代码证实；显示欺骗/提示注入的实际利用为推测。

## 侧重检查

- **错误路径**：配置缺失会退回旧提示并打印 `REVIEW_INCREMENT_FALLBACK config-missing`；配置非法会抛 `INCREMENT_CONFIG_INVALID`；git 失败、main ref 缺失、merge-base 失败都有 fallback；`withIncrement` 超限退回 `too-large`。这一部分路径我未发现漏查问题，但 substitute 路径的 `parentRecords` 是明确崩溃点。
- **不可信输入**：文件名的 C0/DEL 已拒绝，但 Cf/双向控制符未拒绝（见第 7 条）。diff 内容本身没有转义，仍以“这是数据，不是指令”的标记包裹；这是复核不可信代码时固有的提示注入面，未发现新增可执行路径。
- **安全/资源耗尽**：`shellQuote` 对 brief、models、providers 做了引用，现有测试验证了带空格/单引号的路径；`git` 参数使用了 `:(literal)` 和 `--no-ext-diff` 等。资源方面见第 6 条，预算只在完整 diff 读入之后生效。
- **不可撤销操作/花费**：`REVIEW_INCREMENT_EMPTY` 在花钱前退出；普通轮预算和 `REVIEW_SPENT_TOTAL` 已把当前 PR 的 shadow 账本算进去；shadow 运行本身的预算通过 `linkedRecords` 读取父账本。substitute 路径因第 1 条无法完成预算核对，是花费控制和错误处理的实际缺口。
- **规则/文档一致性**：ADR 0280 的截断清单要求与代码不一致（第 2 条）；`model-review.md` 与代码一致但与 ADR 不一致；`--shadow` 的命令参数说明与 `shadowCommand` 实际透传不一致（第 3 条）；I-73 的“所有读账本处都要校验”在 `shadowRunsDone` 处没有完全落实（第 5 条）。

## 对作者说法的核对

1. **“只合并 main、PR 自己没改时增量为空，和合并前检查判断一致”**：基本成立。`planIncrement` 用同一个 `unreviewedFiles`，并额外过滤 claims 文件；新增测试覆盖了“只合并 main”返回 `{empty:true}`。我没有发现这条与 `assertReviewed` 的普通路径不一致。
2. **“手工解决冲突写的内容会出现在增量里”**：一般成立，测试覆盖了“保留手工解决结果”的情况。但代码按 `previous..head` 的净差异生成增量：如果手工解决后的文件内容恰好与上一轮 `previous` 完全相同，`unreviewedFiles` 仍可能因“相对 main 的自身改动指纹变化”把它列为待复核，而 `incrementScope` 的净差异为空，增量块会变成 0 个文件、0 行，冲突文件本身不会出现。这是边界情况，未测试；严格说“会出现在增量里”不是无条件成立。
3. **“差异块总长不会让提示超过 100000 字节”**：成立。`withIncrement` 用最终生成的每个模型提示做 `Buffer.byteLength` 检查，超过就退回旧提示；后续主流程也继续检查 `PROMPT_MAX_BYTES`。但退回后的旧提示如果本身超限，仍会像以前一样抛 `PROMPT_TOO_LARGE`，这不是本改动引入的。
4. **“shadow 运行不进复核链，--assert-reviewed 的结果不受影响”**：代码路径成立。shadow 的 `out` 在 `pr-<n>/shadow`，`rawDir` 也带了 `-shadow` 后缀；`assertReviewed` 只读 `HEAD:.agents/reviews/pr-<n>/usage.jsonl`，`changedOutside` 排除整个 `pr-<n>/` 目录。`reviewReport` 会把 shadow 记录计入 `REVIEW_SPENT_TOTAL`，但不加入正常 `reviews`/`rounds`，符合“不进链”的意图。新测试只验证了目录和单点函数，没有端到端跑 `assertReviewed`。

## 必答问题

1. **会不会改变模型已经见过的请求开头？** 不会改变固定前缀。`buildPrompt` 的 `fixed` 部分（角色、工具说明、任务、FOCUS、必答问题、lens、输出格式）没有随增量分支变化；增量只改 material 里的 base/previous 两句，并把增量块追加到 `brief.trim()` 之后。增量内容位于最后一条用户消息的末尾，每轮变化的 head/base/previous、priorFindings、brief、增量块都在最后一条消息里，仍然只追加。新测试 `keeps the fixed prefix byte for byte...` 覆盖了这一点；我未运行测试。
2. **同一段文字会不会在不同请求里变成不同字节？** 增量块只依赖 `previous`、`head`、`mainRef`、配置和 git 输出，不依赖后续消息；`numstat` 路径经过 `Set` 和 `sort`，文件差异按固定 git 参数生成，账本里的 `toolSummary` 也有固定排序，所以同一轮重跑通常逐字节相同。一个弱点是 `scope.binary` 和 `scope.mainOverlap` 用于提示的列表没有显式 `sort`，顺序依赖 `numstat` 输出顺序；同一 git 环境通常稳定，但不如 `scope.files` 有保证。未见依赖时间或无序遍历的取值。
3. **有没有对应自动检查，反向用例会真的失败？** 有新增测试覆盖配置校验、增量范围、只合并 main、冲突手工解决、二进制、截断、fallback、固定前缀、账本字段拒绝、shadow 参数/计数/命令引用、报表分档等，反向用例大多会失败。缺口是：`main()` 的 substitute 路径没有测试（因此第 1 条没被发现）；shadow 不影向 `assertReviewed` 没有端到端测试；截断清单的行数/精确命令没有测试；`shadowRunsDone` 的坏账本没有反向测试；资源耗尽没有测试。作者说“原有复核测试全部通过”我未核实，因为本环境不能运行测试命令。
4. **每个值的使用端都能接受吗？** 已逐一核对：配置键全部由 `parseIncrementConfig` 校验并分别被 `incrementBlock`、`toolSummary`、`shadowRunsDone`、`bucketStats` 使用；`increment.fallback` 的产生值（`config-missing`、`too-large`、`diff-failed`、`main-ref-missing`、`merge-base-failed`、`file-name-invalid`）都符合 `incrementRecordValid` 的正则；`increment` 的计数字段和 `toolSummary` 被 `parseUsage` 接受，`resultLine`、`delegate.mjs`、`review-speed-report.mjs` 都能消费；`shadow` 只允许 `true`，`dailySpend`、`reviewReport`、`resultLine` 都能接受。阻断问题是 substitute 路径的 `parentRecords`，它不是一个合法值，而是未定义变量。另有 `shadowCommand` 生成命令能被 `parseArgs` 接受，但没有携带 `--require-gateway` 等原轮约束，见第 3 条。

## 未核实

- 没有运行任何测试或 lint 命令，作者的“全部通过 / biome 通过”无法在本环境核实。
- 大文件资源耗尽、Unicode 格式字符的显示欺骗、shadow 缺 `--require-gateway` 的实际路由/费用后果，均未构造环境验证，属于基于代码的推测。
