### 1. 中：单文件 `git diff` 失败被当成“放不下”，不会退回全量复核
文件：`scripts/model-review/increment.mjs:184-196`、`increment.mjs:199-207`、`increment.mjs:222-228`

问题：`patchFor` 失败（git 出错、`maxBuffer` 超限、main 对照段取不到）时返回 `null`，`incrementBlock` 只是把该文件放进 `skipped`，并统一渲染成“已截断：放不下”。只有最终整块超过预算才返回 `null` 触发 `REVIEW_INCREMENT_FALLBACK too-large`。这会使“git 出错”变成“文件太大”，既不符合“算不出范围时不能静默少查”，也不符合 `model-review.md` 写的“git 出错 → `REVIEW_INCREMENT_FALLBACK`”。

证据：
```js
const patch = patchFor(repo, previous, head, file, config.contextLines);
let piece = patch === null ? null : patch.trimEnd();
...
piece = main === null ? null : `${piece}\n---- main ...`;
...
`已截断：下面 ${skipped.length} 个文件的差异放不下，需要时自己用 git diff ${previous}..${head} -- <文件> 取：`
...
if (Buffer.byteLength(result.block) > budget) return null;
```
建议：把“预算放不下”和“取差异失败”分开；任一 `patchFor` 返回 `null` 时让 `incrementBlock` 失败，由 `planIncrement` 返回 `REVIEW_INCREMENT_FALLBACK diff-failed`（或新增更具体的原因），不要伪装成截断。

### 2. 中：增量块在预算前就把所有文件的完整差异读进内存，存在资源耗尽和二次方耗时
文件：`scripts/model-review/increment.mjs:182-221`

问题：`pieces` 先对所有非二进制文件逐个执行 `patchFor` 并把完整 `piece` 字符串留在数组里，之后才按预算逐个尝试；大 PR（很多文件或单个超大文件）会在 60KB 的 `inlineDiffMaxBytes` 之外占用与整个 `previous..head` 差异等量的内存。随后每次 `render(kept)` 都重新拼接并计算整块字节数，文件多时是 O(n²)。这是本次新引入的路径，原来模型按需读取，不会一次性加载全部差异。

证据：
```js
for (const file of scope.files.filter(...)) {
  const patch = patchFor(repo, previous, head, file, config.contextLines);
  ...
  pieces.push({ file, piece });
}
...
for (const { file, piece } of pieces) {
  ...
  const tried = render(kept);
  if (Buffer.byteLength(tried.block) > budget) kept.delete(file);
  else result = tried;
}
```
建议：按文件懒加载，累计字节数达到预算就停止继续取差异；给单文件和总差异字节数设上限，超限时按 `REVIEW_INCREMENT_FALLBACK` 或明确的截断处理；渲染时维护增量长度而不是每次重算整块。

### 3. 低中：main 也改过的文件，main 对照段过大会把 PR 自己的小差异整份丢掉
文件：`scripts/model-review/increment.mjs:186-194`

问题：`piece` 把“PR 差异”和“main 自己的改动”拼成一个不可分割的单位参与预算。若 main 那段很大，即使 PR 只改了一行，整个 `piece` 也放不下，结果模型完全看不到这个文件的 PR 差异，只看到“已截断”。这与 ADR 0280“只看 PR 自己的增量”的目的相反。

证据：
```js
piece = main === null
  ? null
  : `${piece}\n---- main 自己对 ${file} 的改动（...）----\n${main.trimEnd()}`;
...
if (Buffer.byteLength(tried.block) > budget) kept.delete(file);
```
建议：分别计量 PR 差异和 main 对照段；放不下时优先保留 PR 差异，main 对照段单独截断或省略并注明；两者都不放不下才把该文件列入截断清单。

### 4. 低中：固定前缀实际被改了，与本次材料“固定前缀一字不改”的约束冲突
文件：`scripts/model-review/opencode-review.mjs:180-181`、`opencode-review.mjs:387-395`

问题：`TOOL_USAGE_SENTENCE` 被无条件加进 `fixed`，所有模式的系统提示开头都变了。ADR 0280 和 `.agents/instructions/model-review.md` 明确写了这次允许改一次，但本次材料的约束写的是“固定前缀和必答问题一字不改”。两者不能同时成立，应该统一说法：要么承认这是一次经 ADR 批准的前缀变更，要么不要加这句话。

证据：
```js
export const TOOL_USAGE_SENTENCE =
  "bash 每次只能跑一条上面列出的 git 命令，不能用 cd、管道、&&、重定向，...";
...
const fixed = [
  text.role,
  `你能用的工具：...`,
  TOOL_USAGE_SENTENCE,
  text.task,
```
建议：在本次材料/约束里写清“固定前缀本次按 ADR 0280 变更一次”；代码侧可保留，但不要让“一字不改”和实现同时存在。已证实的只是代码会改变前缀；对已有复核请求的缓存影响是推测（下一次请求开头会失配一次）。

### 5. 低：所谓“fallback 保持原文字”的测试是自比较，改变 fallback 文字也不会失败；实际 fallback 文字也已变了
文件：`test/tooling/review-increment.test.mjs:315-319`、`scripts/model-review/opencode-review.mjs:413-414`

问题：`old` 和被测值都是新代码生成的，且 `increment: null` 与不传 `increment` 都是假值，两条断言只验证“函数是确定性的”，不能验证 fallback 与改动前逐字相同。实际 fallback 句子已加入 `grep 工具` 和 `${SCOPE_SENTENCE}`，不再是改动前的原文。

证据：
```js
const old = buildPrompt({ ...base, previous: "eee" });
expect(buildPrompt({ ...base, previous: "eee", increment: null })).toBe(old);
expect(old).toContain("这一轮先看 git diff eee..ccc 的增量");
```
```js
previous && !scoped
  ? `上一轮复核到 ${previous}，这一轮先看 git diff ${previous}..${head} 的增量，...用 grep 工具找。${SCOPE_SENTENCE}...`
```
建议：把改动前的 fallback 提示固定成测试常量或在测试里逐字对照；如果只想保证“范围仍按 previous..head”，就把测试名和作者说法改成这个口径。

### 6. 低：没传 `--pr-brief` 时，建议的抽样全量复核会用本轮材料
文件：`scripts/model-review/opencode-review.mjs:4344`、`increment.mjs:334-344`

问题：`SHADOW_FULL_SUGGESTED` 用 `brief: options.prBrief ?? options.brief`，在增量轮没传 `--pr-brief` 时会退回本轮材料，生成一条“全量”shadow 命令，但材料只覆盖本轮。ADR 要求抽样全量复核用第 1 轮材料；文档也要求主线程传 `--pr-brief`，脚本却不强制、不提示。

证据：
```js
`SHADOW_FULL_SUGGESTED ${shadowCommand({ ..., brief: options.prBrief ?? options.brief, ... })}`
...
`--pr ${pr} --base ${base} --head ${head} --brief ${shellQuote(brief)}`
```
建议：增量轮生成 shadow 命令时，如果 `--pr-brief` 缺失就不要建议 shadow，或打印明确警告；或者直接把 `--pr-brief` 设为增量轮的必填参数。

### 7. 低：截断清单没有 ADR 要求的“每个文件改动行数”和精确命令，二进制文件也没有大小变化
文件：`scripts/model-review/increment.mjs:174-179`、`increment.mjs:203-207`

问题：ADR 0280 决定 2 要求放不下的文件列出“文件名、改动行数和取差异的精确命令”，决定 6 要求二进制文件列出“路径和大小变化”。实现只列文件名和一条带 `<文件>` 占位符的通用命令，二进制只列路径。

证据：
```js
`模型看不了内容的二进制文件（只核对路径...）：${scope.binary.join("、")}`
...
`已截断：下面 ${skipped.length} 个文件的差异放不下，需要时自己用 git diff ${previous}..${head} -- <文件> 取：`
```
建议：为每个截断文件输出其增删行数和完整可执行命令；二进制文件补上大小变化（`--numstat` 的 `-` 无法给大小，可用 `--stat` 或 `--summary` 补充）。

### 8. 低：速度报表回算旧轮次和新增量账本口径不完全一致
文件：`scripts/model-review/review-speed-report.mjs:281-305`

问题：`backfillIncrements` 直接用 `unreviewedFiles` + `incrementScope`，没有 `planIncrement` 的 `skip`（排除本 PR 新增 ADR 对应的 `plan-claims` 记录），也没有提示预算/文件名/配置的 fallback 判断。旧轮次可能把本应排除的 ADR 文件算进行数，或在新代码会 fallback 的情况下仍回算出数字，导致“优化前/优化后”分档口径不完全相同。

证据：
```js
const files = unreviewedFiles(repo, round.previous, round.head, `${REVIEWS_DIR}/pr-${round.pr}`, mainRef);
const scope = files.length === 0 ? { fallback: null, lines: 0 } : incrementScope({...});
lines = scope.fallback ? null : scope.lines;
```
建议：回算也走 `planIncrement` 的同一套文件过滤和 fallback 判定，或至少把 `skip` 和预算参数传进去；在报表说明里写清回算与账本口径的差异。

### 9. 低：文件名只挡 C0/DEL 和 U+FFFD，未挡 Cf（如双向控制符）
文件：`scripts/model-review/opencode-review.mjs:1740`、`opencode-review.mjs:2223-2227`

问题：`planIncrement` 用 `hasControlCharacter` 检查文件名，它只拒绝码点小于 32 和 127；`toolSummary` 已经拦了 `\p{Cc}\p{Cf}`，文件名路径却没有。带双向控制符的文件名可以改变提示里文件清单的显示顺序，至少是展示层欺骗；对模型是否会产生实际错误是推测，未做利用验证。

证据：
```js
if (files.some((file) => file.includes("\uFFFD") || hasControlCharacter(file)))
  return fallback("file-name-invalid");
...
export function hasControlCharacter(text) {
  return [...text].some((character) => {
    const code = character.codePointAt(0);
    return code < 32 || code === 127;
  });
}
```
建议：文件名同时拒绝 `\p{Cf}`（或统一转义成可见字节）再放进提示。

**侧重检查**
- 错误路径：查了配置缺失/非法、`origin/main` 缺失、merge-base 失败、`numstat`/`git diff` 失败、提示超 100000 字节、`REVIEW_BRIEF_REUSED`、`--shadow` 与 `--previous/--round/--self-check-only` 组合。结论：配置、主基线、超限都有 fallback；单文件 `git diff` 失败是漏网路径（见第 1 条）。
- 不可信输入：查了文件名控制字符、diff 里的伪造开始/结束标记、`toolSummary` 工具名和路径、账本 `increment`/`toolSummary`/`shadow` 字段。结论：账本格式基本按 I-73 拒绝；伪造标记没有特殊隔离，但模型本来就能读到仓库内容；文件名 Cf 未挡（见第 9 条）。
- 安全：增量差异从原始仓库对象库读取，而模型工作副本会删掉 `opencode.json`/`.opencode`/secret env 文件。对 `.env` 有 `envFilesInHistory` 在发送前中止；对 `opencode.json` 等，模型本来也能 `git show`，因此未发现新的读取能力，但确实是“自动把可能被清理的文件内容送进提示”，属于残留风险。生成 shadow 命令时 `brief/models/providers` 已 shell 转义，`pr/base/head` 是数字或解析后的哈希，未发现命令注入。
- 资源耗尽：见第 2 条；单文件 `maxBuffer` 256MB，整个增量块会累计所有文件差异。
- 不可撤销操作：本次改动只读 git、写复核账本和 `shadow/`，没有删除或改写历史；`REVIEW_INCREMENT_EMPTY` 在模型自检和花钱之前退出。
- 规则/文档一致性：固定前缀（第 4 条）、fallback 原文（第 5 条）、截断清单（第 7 条）不一致；`--pr-brief` 的建议命令行为（第 6 条）与文档期望不一致。

**必答问题**

1. 会改变已经发给模型的内容开头吗？
   在新实现内部，复核每轮是一次独立请求，没有历史消息；固定部分在各增量轮之间保持一致，`base/previous/priorFindings/brief/increment` 全部放在材料（最后一段）里，增量块追加在材料末尾，仍符合“只在末尾追加、每轮会变的值放在最后一条消息里”。但这次改动本身把 `TOOL_USAGE_SENTENCE` 加进了固定前缀，所以相对改动前的请求，所有复核请求的开头都会变一次（ADR 0280 和文档承认这一点）；此后各轮开头不再因本轮数据变化。已证实的是代码会改变前缀；“会失去一次缓存”是规则推导。

2. 同一段文字会不会在不同请求里变成不同字节？
   未发现新增的不确定性：增量块里没有时间字段，`git` 固定了 `LC_ALL=C`、`--no-color --no-ext-diff --no-textconv --no-renames`，文件按排序后的路径处理，`toolSummary` 的工具名和 `topReads` 都显式排序。`scope.binary`/`scope.mainOverlap` 的顺序来自 git 输出而非显式 JS 排序，但同一提交下 git 输出确定。遮盖仍是原有的确定性规则，增量块没有引入依赖后文的新遮盖。

3. 有没有自动检查，反向用例真的会失败吗？
   有：`test/tooling/review-increment.test.mjs` 覆盖配置校验、真实 git 增量、只合并 main 为空、冲突手写内容、二进制、截断、主基线缺失、合并基线失败、账本字段、shadow、报表分档等。反向用例中配置、账本、shadow 参数、主基线等确实会失败。但三点不足：一是 fallback“保持原文”的测试是自比较，改文字也不会失败（第 5 条）；二是没有“单文件 `git diff` 失败应退回全量复核”的反向用例（第 1 条）；三是没有直接验证 shadow 记录不会进入 `--assert-reviewed` 的用例。测试是否全部通过我无法运行确认，未核实。

4. 改动产生/修改的值，使用端都能接受吗？
   基本能：`increment` 的 fallback 原因都能通过 `incrementRecordValid` 的 `[a-z-]{1,40}` 校验；`increment.files/lines/rawLines/inlineBytes/truncated` 被 `resultLine`、`review-speed-report`、`--report` 按同一含义消费；`toolSummary` 由 `toolSummary` 产生、`parseUsage` 校验、账本保存；`shadow` 只在 shadow 记录里产生，`parseUsage` 只接受 `true`，`reviewReport` 和花费统计能读，`assertReviewed` 只读父账本所以不受影响；`briefSha256` 产生后被 `reusedBriefRecord` 消费；配置键都有读取处，`SHADOW_DIR` 在 `parseArgs`、`rawDir`、`dailySpend`、`linkedLedgerRecords`、`reviewReport` 一致使用。已发现的口径问题有三处：建议的 shadow 命令在缺 `--pr-brief` 时用本轮材料（第 6 条）；截断清单和二进制清单缺少 ADR 要求的字段（第 7 条）；报表回算没有复用 `planIncrement` 的过滤/退回判断（第 8 条）。
