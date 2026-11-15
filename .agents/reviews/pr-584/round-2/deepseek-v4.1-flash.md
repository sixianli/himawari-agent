### 1. 高：替补模型分支引用了已删除的 `parentRecords`，一旦触发就会整轮抛 ReferenceError

文件：`scripts/model-review/opencode-review.mjs:4008`、`scripts/model-review/opencode-review.mjs:4241`

问题：本轮把原来的 `const parentRecords = ...` 换成了 `const linkedRecords = linkedLedgerRecords(options)`，但替补模型分支还在用 `parentRecords`。全仓库 grep 只有 4241 这一处引用，没有任何定义。触发条件并不罕见：单模型代码复核遇到可重试的 `api-error` 且 `substituteFor` 返回替补时，这个数组字面量会先求值 `...parentRecords`，直接 ReferenceError，脚本以未捕获错误退出（exit 2），第一笔钱已经花了，却不会打印 `REVIEW_SUBSTITUTE`，也不会写替补记录。

证据（亲自读到）：

```js
// opencode-review.mjs:4007-4008
const records = options.selfCheckOnly ? [] : readUsage(options.out);
const linkedRecords = linkedLedgerRecords(options);
...
// opencode-review.mjs:4236-4244
const refused =
  Buffer.byteLength(substitutePrompt) > 100000
    ? "PROMPT_TOO_LARGE"
    : budgetCheck({
        mode: options.mode,
        records: [...readUsage(options.out), ...parentRecords],
        models: [substitute.model],
        approvedUsd: options.approvedUsd,
      });
```

建议：把 `parentRecords` 改成 `linkedRecords`（或在这里重新调用 `linkedLedgerRecords(options)`）；同时把这里硬编码的 `100000` 改成 `PROMPT_MAX_BYTES`。补一条经过 main 流程的替补预算测试，造出父账本或 shadow 账本，确认不会抛 ReferenceError，且预算按预期合并。
性质：读代码证实；未实际运行触发，但这是 ESM 中未声明变量的必然行为。

### 2. 中：`shadow/` 记录会被 `delegate.mjs check` 当作 `unexpected-file` 拒绝

文件：`scripts/model-review/delegate.mjs:32`、`scripts/model-review/delegate.mjs:343-359`

问题：影子全量复核把记录写在 `.agents/reviews/pr-N/shadow/` 下，`model-review-card.md` 还要求“跑完把 `shadow/` 目录随复核记录一起提交”。但 `delegate.mjs check` 只允许 `round-<预期轮>/<模型>.md`、`.prompt.md`、`.stderr.txt` 这类文件；`shadow/usage.jsonl` 和 `shadow/round-N/*` 的 relative path 不匹配 `ROUND_FILE_PATTERN`，会进入 `unexpected-file=`，最终 `DELEGATION_RECORD_MISMATCH`。ADR 0280 的决定第 8 条明确要求同步改 `delegate.mjs`，本轮没有改，也没有对应测试。

证据（亲自读到）：

```js
// delegate.mjs:32
export const ROUND_FILE_PATTERN = /^round-(\d+)\/[a-z0-9][a-z0-9.-]*\.(?:md|stderr\.txt)$/;
// delegate.mjs:343-359
const roundFiles = changes.filter((change) => change.path !== ledgerPath);
for (const change of roundFiles) {
  const relative = change.path.slice(recordsDir.length);
  const match = ROUND_FILE_PATTERN.exec(relative);
  ...
  if (!match || Number(match[1]) !== expectedRound || !ofAddedModel)
    problems.push(`unexpected-file=${JSON.stringify(change.path)}`);
}
```

`shadow/usage.jsonl` 的 relative path 是 `shadow/usage.jsonl`，匹配不到 `^round-(\\d+)/`。
建议：在 `delegate.mjs` 中显式允许影子目录（`shadow/usage.jsonl`、`shadow/round-N/*`），并按和主账本相同的模型/轮次/哈希规则校验；补一条带影子记录的委托测试。若决定影子记录不随委托流程提交，则改文档和卡片，并让 `delegate` 明确忽略它。
性质：读代码证实的跨模块使用端不匹配；只在委托复核流程中触发，未实际运行。

### 3. 低：文档说所有 `plan-claims` 核对记录都不算，代码只排除本 PR 新增 ADR 对应的记录

文件：`.agents/instructions/model-review.md:165`；`scripts/model-review/plan-claims.mjs:294-307`、`scripts/model-review/plan-claims.mjs:384`、`scripts/model-review/plan-claims.mjs:419`

问题：新文档写“只是合并 main 带进来的文件和 `plan-claims` 的核对记录不算，和合并前检查一样”。但 `claimsProblems` 在 `addedAdrs` 为空时直接返回 `files: []`；而 `addedAdrs` 只取相对 `--main-ref` **新增**（`--diff-filter=A`）的 ADR。也就是说，只有“本 PR 新增 ADR 对应的 plan-claims 记录”会被排除；修改已有 ADR、或存在其他 ADR 的 plan-claims 记录时，这些记录仍会进入增量。后半句“和合并前检查一样”是成立的，但前半句的范围被写大了。

证据（亲自读到）：

```js
// plan-claims.mjs:294-307
export function addedAdrs(repo, head, mainRef) {
  const base = git(repo, ["merge-base", mainRef, head]);
  if (base.status !== 0) return [];
  const diff = git(repo, [
    "diff", "-z", "--no-renames", "--name-only", "--diff-filter=A",
    base.stdout.trim(), head, "--", "docs/adr",
  ]);
  ...
}
// plan-claims.mjs:384
if (adrs.length === 0) return { problems, files };
```

测试 `test/tooling/review-increment.test.mjs:253` 也只是手工传入 `skip: () => new Set([".agents/reviews/claims-x/usage.jsonl"])`，没有验证真实的 `claimsProblems` 输出。
建议：把文档改成“与本 PR 新增 ADR 对应的 plan-claims 核对记录不算”，或者如果确实要一律排除，就改 `claimsSkip` 并把合并检查也改成同一口径；测试改用真实 `claimsProblems` 场景。
性质：读代码证实的文档精度问题，实际不改变合并门行为。

### 4. 低：上一轮第 6 条只修了一半：预算仍按“未加增量的提示”算，超长时整轮放弃增量

文件：`scripts/model-review/opencode-review.mjs:1730`、`scripts/model-review/opencode-review.mjs:1736-1741`

问题：`planIncrement` 的块预算仍是 `PROMPT_MAX_BYTES - promptBytes - 1`，而 `promptBytes` 是 `increment === null` 时的提示长度。增量轮会把 `对比基准是 ... 先运行 git diff ...` 换成更长的段落，并在材料末尾追加大量文字；实际 scoped 提示比 `promptBytes` 长。`withIncrement` 发现超过 100000 字节时不是缩小差异块，而是把整个 `planned` 退回 `{fallback: "too-large"}`，于是这一轮按全量方式复核。安全，但会让本来可以放下的增量块白白丢掉，上一轮第 6 条的预算问题没有真正修到根上。

证据（亲自读到）：

```js
// opencode-review.mjs:1730
budget: Math.min(config.inlineDiffMaxBytes, PROMPT_MAX_BYTES - promptBytes - 1),
// opencode-review.mjs:1736-1741
export function withIncrement({ planned, prompts, promptsWith }) {
  if (!planned?.block) return { planned, prompts };
  const scoped = promptsWith(planned.block);
  if (Object.values(scoped).some((prompt) => Buffer.byteLength(prompt) > PROMPT_MAX_BYTES))
    return { planned: { record: { fallback: "too-large" }, block: null }, prompts };
  return { planned, prompts: scoped };
}
```

另外，`incrementBlock` 的贪心循环只向后加、不重试之前跳过的文件；虽然新测试覆盖了“截断列表变短后所有文件都放得下”的情况，但没有覆盖“先跳过 A、后来保留 B 后 A 又能放下”的顺序相关场景。
建议：用实际 scoped 提示的固定开销计算预算，或在超限时从块中移除文件并重渲染，而不是直接退回全量；加一条 main 级别的“长 brief + 长增量”提示长度测试。
性质：读代码证实；影响是浪费增量轮，不会让提示超限。

### 5. 低：`incrementBlock` 的新循环对每个文件重渲染全部候选，文件数很多时是 O(n²)（推测）

文件：`scripts/model-review/increment.mjs:198-221`

问题：新算法对 `pieces` 里的每个文件都调用 `render(kept)`；`render` 每次都会 `pieces.filter(...)` 并重新拼接整个 block。`pieces` 包含 `scope.files` 的全部非二进制文件，`maxFilesListed` 只限制“文件清单”和“已截断列表”的展示数量，不限制 `pieces` 的数量。相比旧实现的“先按字节累加、最后渲染”，这里在文件很多时会出现大量重复扫描和字符串构造。大 PR（数千到数万文件）可能在截断前消耗明显 CPU/内存；这是推测，未运行测量。

证据（亲自读到）：

```js
// increment.mjs:213-221
const kept = new Set();
let result = render(kept);
for (const { file, piece } of pieces) {
  if (piece === null) continue;
  kept.add(file);
  const tried = render(kept);
  if (Buffer.byteLength(tried.block) > budget) kept.delete(file);
  else result = tried;
}
```

以及 `render` 里的 `pieces.filter((item) => !kept.has(item.file))`。
建议：按 `maxFilesListed`（或单独的候选上限）限制参与循环的文件数，或改为增量维护 block 长度；补一个大量文件/大量截断的耗时测试。
性质：推测；从代码结构可确认是 O(n²)，实际耗时未测量。

### 6. 低：文件名检查只挡 C0/DEL，不挡 C1 和 Cf；本轮收紧的 `toolSummary` 校验却挡 Cc/Cf

文件：`scripts/model-review/opencode-review.mjs:1713`、`scripts/model-review/opencode-review.mjs:2191-2196`；`scripts/model-review/increment.mjs:245-248`、`scripts/model-review/increment.mjs:291-292`

问题：`planIncrement` 对文件名只检查 `\uFFFD` 和 `hasControlCharacter`，而 `hasControlCharacter` 只覆盖 `<32` 与 `127`，不覆盖 U+0080–U+009F（Cc）和 U+202E 等 Cf 格式字符。这样的文件名会原样进入增量块的清单、二进制清单、main overlap 清单和 diff 头。与此同时，本轮新的 `toolSummary` 生产端会把 `[\p{Cc}\p{Cf}]` 换成 `?`，校验端也拒绝 Cf，两条输入路径的严格程度不一致。风险较低（主要是显示/提示注入），但属于不可信输入校验的缺口。

证据（亲自读到）：

```js
// opencode-review.mjs:1713
if (files.some((file) => file.includes("\uFFFD") || hasControlCharacter(file)))
  return fallback("file-name-invalid");
// opencode-review.mjs:2191-2196
export function hasControlCharacter(text) {
  return [...text].some((character) => {
    const code = character.codePointAt(0);
    return code < 32 || code === 127;
  });
}
// increment.mjs:245-248
.replace(/[\p{Cc}\p{Cf}]/gu, "?")
// increment.mjs:291-292
typeof pair[0] === "string" &&
!/[\p{Cc}\p{Cf}]/u.test(pair[0])
```

建议：文件名校验改用 `[\p{Cc}\p{Cf}]`，或在把文件名写入提示前做转义；与 `toolSummary` 的口径保持一致。
性质：读代码证实校验范围不一致；具体利用风险未验证。

**侧重检查**

- 错误路径：检查了 `REVIEW_INCREMENT_EMPTY`、`config-missing`、`main-ref-missing`、`merge-base-failed`、`diff-failed`、`file-name-invalid`、`too-large` 的全部分支，以及 `withIncrement` 的 `PROMPT_TOO_LARGE` 回退。`REVIEW_INCREMENT_EMPTY` 的退出路径没有花钱，也没有写账本，和文档的“直接收尾”一致；替补路径发现第 1 条崩溃。
- 不可信输入/安全：检查了 `parseIncrementConfig`、`parseUsage` 对 `increment`/`toolSummary`/`shadow` 的校验、`shadowCommand` 的 shell 转义、git 路径的 `:(literal)` 与 `--` 防注入、文件名控制字符检查。`shellQuote` 对空格、引号、分号的处理有测试；`gateway`、`pr`、`base`、`head` 都受各自校验，未发现命令注入。文件名校验存在第 6 条的 Cf/C1 缺口。
- 资源耗尽：`shadowRunsDone`/`readUsage` 是同步全量读取，但没有新的破坏性操作；`incrementBlock` 的 O(n²) 见第 5 条。`--shadow` 只写记录，不删除或覆盖已有账本。
- 文档与代码一致性：核对了 `model-review.md:165` 的新说法、`model-review-card.md` 的 shadow 提交说明、ADR 0280 对 `delegate.mjs` 同步的要求，以及 `review-speed-report` 对 fallback 轮的处理。发现第 2、3 条不一致。
- 本轮查过的范围：`93bc9685..52a8ee43` 的 5 个文件，以及直接使用端 `plan-claims.mjs`、`delegate.mjs`、`review-speed-report.mjs`、`review-increment.json`、`model-review-card.md`；另外查了相关测试和 prompt-prefix / checklist 段落。
- 未核实：环境只允许 read/grep/glob 和 git 只读命令，未运行 `vitest` 或任何脚本，因此“原有复核测试全部通过”未实际确认；第 5 条的耗时也未测量。

**作者说法核对**

- “只合并 main、PR 自己没改时增量为空，和合并前检查一致”：成立。两者都用 `unreviewedFiles`，并且本轮给 `planIncrement` 补了 `claimsProblems` 的 skip；测试 `review-increment.test.mjs:146` 覆盖了空增量。
- “手工解决冲突写的内容会出现在增量里”：成立。`unreviewedFiles` 按相对合并基线的 diff 比较，测试 `review-increment.test.mjs:158` 覆盖了手写冲突内容。
- “差异块总长不会让提示超过 100000 字节”：基本成立。`withIncrement` 会丢弃超限的块并退回原做法；但这是整轮放弃，不是缩小块，见第 4 条。若未加增量的提示本身已超限，main 随后以 `PROMPT_TOO_LARGE` 停下，不会发送。
- “shadow 运行不进复核链，`--assert-reviewed` 不受影响”：成立。影子记录在 `pr-N/shadow/usage.jsonl`，`assertReviewed` 只读 `pr-N/usage.jsonl`，`unreviewedFiles` 也排除整个 `pr-N/` 目录。
- “测试全部通过”：未核实。静态看新增测试没有覆盖 main 的替补路径，也没有覆盖 `delegate.mjs` 对 shadow 目录的处理；第 1 条的 ReferenceError 不会被现有测试发现。

**必答问题**

1. **涉及。** 没有改变固定前缀：`buildPrompt` 的 `fixed` 部分（角色、工具、任务、必答问题、输出格式）没有变；本轮改的 `model-review.md` 第 165 行在 `<a id="checklist"></a>` 段落之外，`reviewQuestions` 仍只取 checklist 的四条问题，而且问题通常从 `--questions-ref` 或 base 提交读取。增量轮只是在材料里替换了一句“对比基准”说明，并把差异块追加到材料末尾（`buildPrompt` 的最后一个元素）。发给模型的内容仍然是一次新的用户消息，没有改写已发过的系统提示、工具定义、历史或已发出的消息；每轮变化的 head/base/previous/差异/上一轮意见都在材料里，差异块在最后。测试 `review-increment.test.mjs:284` 也断言了 fixed 前缀逐字节相同。
2. **涉及（主要新增账本序列化，不涉及提示里的遮盖）。** 提示侧新增的差异块没有时间字段、随机值或依赖后文的遮盖；`incrementScope` 固定使用 `--no-color --no-ext-diff --no-textconv --no-renames`、`LC_ALL=C`，文件列表排序，测试 `review-increment.test.mjs:142` 断言同一提交的块逐字节相同。账本侧 `toolSummary` 的 `byTool` 和 `topReads` 都做了固定排序，`shadow` 是固定 `true`，`increment` 数字来自 git。唯一残留是 `scope.binary`/`scope.mainOverlap` 的顺序来自未显式排序的 git diff 输出；在当前固定 git 参数下应稳定，但若要求“不依赖集合/数据库顺序”，这两处还可以再显式排序。未发现依赖前后文的遮盖；`maskSecretLike` 本轮没有改。
3. **涉及。** 新增测试覆盖了：配置校验、合并基线退回、二进制、截断、claims skip、`withIncrement` 超限、账本字段、`toolSummary` 控制字符、影子计数、影子预算、命令转义、回填 fallback。反向用例大多真的会失败：例如把第 4 条的 `increment !== undefined` 改回旧条件，`review-increment.test.mjs:560` 会失败；把 `toolSummaryValid` 的 Cc/Cf 检查去掉，345/346 行会失败；把 `shadowRunsDone` 改回按记录计数，455/469 行会失败；把 `shellQuote` 去掉，501 行的命令测试会失败。但存在三处覆盖缺口：第一，第 1 条的 `parentRecords` 崩溃没有任何经过 main 的测试，现有测试只直接调用 `linkedLedgerRecords`/`budgetCheck`；第二，claims skip 测试用手工 `Set` 而不是真实 `claimsProblems`；第三，没有测试 `delegate.mjs` 遇到 `shadow/` 记录的行为，也没有 main 级别的最终提示长度测试。测试未实际运行。
4. **涉及。** 逐个值核对结果：`SHADOW_DIR` 从 `opencode-review.mjs` 移到 `increment.mjs` 并重新导出，`dailySpend`、`rawDir`、`parseArgs`、`reviewReport`、`shadowRunsDone` 使用的都是同一个 `"shadow"` 字符串，能接受。`increment` 字段由 `incrementRecord` 产生，`incrementRecordValid` 接受成功形态和 fallback 形态；`parseUsage`、`resultLine`、`review-speed-report`（含新增的 fallback 跳过）都能处理。`toolSummary` 由 `toolSummary` 产生，生产端只产生符合 `TOOL_NAME` 的键并替换 Cc/Cf，`toolSummaryValid` 的新限制不会拒绝正常输出。`shadow` 只由影子运行写成 `true`，`parseUsage` 接受 `undefined`/`true`，`--report` 和 `dailySpend` 会把它算进去，复核链不读它。`shadowCommand` 的输出由人/主线程执行，不是脚本解析；`brief`、`models`、`providers` 都做了 shell 转义，`gateway`/`pr`/`base`/`head` 受各自校验。配置键 `inlineDiffMaxBytes`、`contextLines`、`maxFilesListed`、`toolSummaryTopFiles`、`shadowFullTotal`、`reportBucketLines` 都经过 `parseIncrementConfig` 校验，使用端按同名读取。**不能接受的一处**是第 1 条的 `parentRecords`：它已经不再定义，却仍在替补预算里被使用；另一处跨模块问题是第 2 条，`delegate.mjs` 不接受 `shadow/` 目录的序列化格式。
