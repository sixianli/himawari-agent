## 本轮查过范围

- 增量：`git diff 2e2f8ac2d..d9609ae32`，逐项看了 `scripts/model-review/opencode-review.mjs`、`review-models.json`、`test/tooling/review-round-tools.test.mjs`、`test/tooling/opencode-review.test.mjs`、流程卡、`model-review.md`、`AGENTS.md`、ADR 0263。
- 跟进读取：`parseUsage`、`parseVerdicts`、`coveragePoints`、`walkChain`、`assertReviewed`、`buildPrompt`、`reviewReport`，以及 `finishRound`/`judgeSkeleton`/`deferredLowLines` 的调用端。
- 增量没有改 `gateway.mjs`、`delegate.mjs`，也没有改 `assertReviewed`/`walkChain`；我确认了“合并检查规则没改”这一点。旧代码只在证据指向时读，没有整份重读。
- 未运行测试（工具限制只能跑 git），反向用例的实际执行结果未核实。

---

### 1. 高：`--finish-round` 把账本里的 `base` 原样拼进要执行的 shell 命令，存在命令注入

文件:行：`scripts/model-review/opencode-review.mjs:1791`、`scripts/model-review/opencode-review.mjs:1932-1940`、`.agents/instructions/model-review-card.md:20,40`

问题：`NEXT fix-and-rereview` 直接插入 `record.base`，但 `parseUsage` 对 code-review 记录只要求 `head`、`model`、`outcome` 是字符串，`head` 才校验 40/64 位十六进制，`base` 没有任何格式校验。账本文件在 PR 分支里，PR 作者可以修改；流程卡又要求主线程“照抄 NEXT 命令”、子代理“按 NEXT 做”，因此恶意或误写的 `base` 会变成 shell 命令的一部分。

证据（读代码证实）：

```js
`NEXT fix-and-rereview node scripts/model-review/opencode-review.mjs --mode code-review --base ${record.base} ...`
```

```js
const fieldsValid =
  !MODES.includes(record?.mode) ||
  ["head", "model", "outcome"].every(
    (field) => typeof record[field] === "string" && record[field] !== "",
  );
const headValid =
  record?.mode === undefined ||
  record.mode === "override" ||
  COMMIT_PATTERN.test(record.head);
```

流程卡第 20 行写“之后照抄上一个子代理交回的 NEXT 命令”，第 40 行写“把打印的命令和新提交交回主线程”。

推测：具体利用需要恶意 PR 同时提交账本、答案和 `verdicts.jsonl`，并让 `--finish-round` 输出 `fix-and-rereview`；我没有实际执行验证。但 `base` 未校验、未转义是读代码确认的。

建议：对 code-review 记录的 `base`、`previous` 也用 `COMMIT_PATTERN` 校验；或者在生成 `NEXT` 时做 shell 安全引用，并拒绝含空白、`;`、`$`、反引号等字符的值。补一条以恶意 `base` 为输入的负向测试。

---

### 2. 中高：多模型轮次的 NEXT 丢掉 `--models`，下一轮静默退回默认单模型

文件:行：`scripts/model-review/opencode-review.mjs:1669-1672`、`scripts/model-review/opencode-review.mjs:1788-1791`、`scripts/model-review/opencode-review.mjs:1307-1313`

问题：`latestReviewRound` 只取 `outcome === "ok"` 的记录；`finishRound` 生成的下一轮命令只带 `--base`、`--previous`、`--pr`、`--brief` 和可选的 `--gateway`，没有带原轮的 `--models`，也没有带 `--providers`。Andy 指定两个模型时，一旦本轮出现中高问题，下一轮就会按默认模型（当前只有 DeepSeek）重跑，另一个模型被静默丢掉；如果本轮本来有一个模型失败，`finishRound` 仍可能在只剩部分 ok 记录时生成判断和 NEXT。

证据（读代码证实）：

```js
const own = records.filter((record) => (record.round ?? 1) === round);
const ok = own.filter((record) => record.outcome === "ok");
if (ok.length === 0) throw new Error(`ROUND_NOT_OK round-${round}`);
```

```js
`NEXT fix-and-rereview node scripts/model-review/opencode-review.mjs --mode code-review --base ${record.base} --head <修改后的提交> --previous ${reviewed} --pr ${pr} --brief <材料文件>${gateway}`
```

而 `coveragePoints` 在请求的模型不完整时会回退到默认模型：

```js
const needed = complete(requested)
  ? requested
  : complete(DEFAULT_REVIEW_MODELS)
    ? DEFAULT_REVIEW_MODELS
    : [];
```

因此丢掉第二个模型后，后续 `--assert-reviewed` 仍可能按默认模型判为完整，不会自动发现覆盖面变小。

推测：多模型只在 Andy 特别指定时使用，属于正常使用路径而非恶意输入；未实际跑多模型流程。

建议：从本轮记录还原 `requested` 模型（直接记录取 `record.model`，替补记录取 `record.substituteFor`），下一轮命令带上 `--models`；`--providers` 也应一并保留或明确说明只对单轮生效。若本轮有请求模型没有 ok 记录，`--finish-round` 应拒绝或明确标出“本轮不完整”，不要直接给出 `done`/`fix-and-rereview`。补多模型 NEXT 的测试。

---

### 3. 中：`deferredLowLines` 按最大轮次逐个整数循环，轮次异常大时可拖死 `--report`

文件:行：`scripts/model-review/opencode-review.mjs:1641-1647`、`scripts/model-review/opencode-review.mjs:1820`、`scripts/model-review/opencode-review.mjs:1926-1927`、`scripts/model-review/opencode-review.mjs:3071-3074`

问题：`deferredLowLines` 从 `LOW_DEFER_FROM_ROUND` 到 `latest` 每次都执行一次循环，循环体内调用 `showAt`，也就是每次启动一个 `git show`。`latest` 来自账本里所有 code-review 记录的 `round` 最大值，而 `parseUsage` 只要求 `round` 是大于 0 的安全整数，没有上限；`--round` 参数同样接受任意安全整数。账本在 PR 里可由作者提交，手工误传一个很大的 `--round` 也能触发。结果是 `--report` 会启动极多次 git 子进程，实际不可完成。

证据（读代码证实）：

```js
for (let round = LOW_DEFER_FROM_ROUND; round <= latest; round += 1) {
  ...
  const text = showAt(repo, "HEAD", path);
```

```js
const latest = Math.max(0, ...rounds);
```

```js
const roundValid =
  record?.round === undefined || (Number.isSafeInteger(record.round) && record.round > 0);
```

```js
options.round = Number(take());
if (!Number.isSafeInteger(options.round) || options.round <= 0) throw new Error("ARG_INVALID --round");
```

推测：恶意账本或误操作都可能触发；我没有实际构造超大轮次运行。

建议：不要遍历 `3..latest`，改为遍历本轮实际存在的轮次集合（从 `records` 中的 `round` 去重排序，或读磁盘上的 `round-*` 目录），并只处理到最新实际轮次；同时给 `round` 加上合理上限或连续性要求。补一个超大 `round` 的负向测试。

---

### 4. 中：`deferredLowLines` 会把非最后一轮、后来已修的低意见继续列为“未修”，且与 `model-review.md` 说法矛盾

文件:行：`scripts/model-review/opencode-review.mjs:1643-1651`、`scripts/model-review/opencode-review.mjs:1856`、`.agents/instructions/model-review.md:64`、`docs/adr/0263-cheaper-claude-side-of-code-review.md:59`

问题：代码从第 `LOW_DEFER_FROM_ROUND` 轮一直列到最新轮，**每一轮**只要“成立的会出错全是低”且没有同轮 `low-fix` 记录就列出。但 `model-review.md` 写的是“列出最后一轮的这些意见”，ADR 0263 写的是“每一轮”。另外代码只认同轮的 `low-fix` 记录，无法知道后续轮次或后续修改是否已经把这些低意见修掉；因此可能把已修的低意见继续列在“低严重度未修”里。更糟的是，某轮 `verdicts.jsonl` 在 HEAD 中缺失时 `if (text === null) continue;` 会静默跳过，报告不会提示这一轮没有被列出。

证据（读代码证实）：

```js
for (let round = LOW_DEFER_FROM_ROUND; round <= latest; round += 1) {
  if (records.some((record) => record.mode === "low-fix" && record.round === round)) continue;
  const path = `${ledgerPath}/round-${round}/verdicts.jsonl`;
  const text = showAt(repo, "HEAD", path);
  if (text === null) continue;
```

`model-review.md:64`：“`--report` 在“低严重度未修（第 3 轮起只列不修）”一节列出**最后一轮**的这些意见”。

`docs/adr/0263...:59`：“列出第 3 轮起**每一轮**只剩低意见、又没记 `low-fix` 的那些意见”。

推测：后续轮次顺手修掉旧低意见、但没有写同轮 `low-fix` 记录时，报告会误报为未修；具体 PR 是否会出现取决于后续轮次和修改内容，我没有实例。

建议：先统一语义。如果按 `model-review.md` 只列最后一轮，代码应过滤到链上最后/最新可接受轮次；如果按 ADR 列每一轮，应更新 `model-review.md`，并在报告中标注“可能随后续修改失效”，或在后续提交可读时重新核对。对缺失的 `verdicts.jsonl` 不要静默跳过，至少打印一行“本轮无法列出”的警告。补“第 3 轮报告后第 4 轮修掉”或“多轮连续低意见”的测试。

---

### 5. 低：`--judge-skeleton` 分节只认 `##` 且按标题子串匹配，可能多收答案或少跳意见

文件:行：`scripts/model-review/opencode-review.mjs:1639`、`scripts/model-review/opencode-review.mjs:1675-1686`

问题：跳过逻辑只把以 `##` 开头的行当作分节；`# 结论` 这种一级标题不会重置 `skipped`，其后的 `###` 会被当成意见。反过来，任何 `##` 标题只要包含“结论/总结/summary/conclusion/必答/侧重”就会被整节跳过，例如 `## 结论与后续建议` 里的真实意见会被漏掉。模型也可能用 `## 逐条回答` 来回答必答问题，这个标题不匹配，后面的 `###` 答案会被收进草稿。

证据（读代码证实）：

```js
const SKELETON_SKIPPED_SECTIONS = /必答|侧重|结论|总结|summary|conclusion/i;

for (const line of answer.split("\n")) {
  const section = /^##\s+(.*)$/.exec(line);
  if (section) {
    skipped = SKELETON_SKIPPED_SECTIONS.test(section[1]);
    continue;
  }
  if (!skipped && /^###\s+\S/.test(line)) findings.push(line);
}
```

推测：实际多收/漏收取决于模型怎样写标题；输出格式已经要求意见以外的内容不用三级标题，所以风险主要在模型不完全遵守格式时。

建议：按固定标题名精确分节，支持 `#`/`##`/`###`，或者要求模型用明确的分隔标记；至少把 `逐条回答`、`回答` 纳入跳过词，并补 `# 结论`、`## 逐条回答`、`## 结论与建议` 的测试。

---

### 6. 低：`--finish-round` 的控制字符校验只覆盖部分自由文本，`quote` 等仍会原样写进 `judgments.md`

文件:行：`scripts/model-review/opencode-review.mjs:1750-1757`、`scripts/model-review/opencode-review.mjs:1777`、`scripts/model-review/opencode-review.mjs:1881-1891`

问题：文档说“自由文本无控制字符”，但代码只检查 `why`、`trigger`、`consequence`、`reason`。`quote`、`modelSeverity`、`id` 没有检查；其中 `quote` 是模型答案里的一整行，可能带 ANSI ESC，随后被原样写进 `judgments.md`。另外 `hasControlCharacter` 只检查 C0（<32）和 DEL，不检查 C1（U+0080–U+009F）和 Unicode 格式字符（Cf，如双向覆盖符），与 `gateway.mjs` 里使用 `\p{Cc}\p{Cf}` 的做法不一致。

证据（读代码证实）：

```js
if (
  ["why", "trigger", "consequence", "reason"].some(
    (field) =>
      verdict[field] !== undefined &&
      (typeof verdict[field] !== "string" || hasControlCharacter(verdict[field])),
  )
)
  problems.push(`control-character ${printable(verdict.id)}`);
```

```js
return `- ${verdict.id}（${verdict.model.split("/").pop()}）${VERDICT_LABEL(verdict)}：${verdict.quote}${basis ? `。${basis}` : ""}`;
```

```js
export function hasControlCharacter(text) {
  return [...text].some((character) => {
    const code = character.codePointAt(0);
    return code < 32 || code === 127;
  });
}
```

推测：利用后果主要是终端转义序列、双向文字误导阅读者；`judgments.md` 只供人或代理阅读，不会被执行，所以不是命令注入级别。

建议：对 `id`、`quote`、`modelSeverity` 等所有会进入 `judgments.md` 的字符串统一检查 C0/DEL，最好连同 `\p{Cc}\p{Cf}`；写文件时也做一次转义或拒绝。补 ESC/双向字符出现在 `quote`、`modelSeverity` 的负向测试。

---

### 7. 低：文档说第 3 轮起不记 `low-fix`，但 `--accept-low` 不检查 `lowDeferFromRound`

文件:行：`scripts/model-review/opencode-review.mjs:1560-1566`、`.agents/instructions/model-review.md:64`、`docs/adr/0263-cheaper-claude-side-of-code-review.md:59`

问题：ADR 和说明都写“第 3 轮起不修、不记 `low-fix`”，但 `assertReviewed` 的 `--accept-low` 只检查“这一轮是最后一轮”“本轮错误全是低”“改动规模”等，没有检查 `acceptLow >= LOW_DEFER_FROM_ROUND`。第 3 轮仍然可以执行 `--accept-low 3` 并写入 `low-fix`，规则只靠 `NEXT` 提示，脚本不拦。

证据（读代码证实）：

```js
if (problems.length === 0) reasons.push("nothing-unreviewed");
else if (!problems.every((problem) => problem.startsWith("unreviewed ")))
  reasons.push("only-unreviewed-files");
else if (complete.round !== acceptLow) reasons.push(`not-last-round last=${complete.round}`);
else if (complete.by === "low-fix") reasons.push(`already-low-fixed round=${acceptLow}`);
```

这里没有 `acceptLow` 与 `LOW_DEFER_FROM_ROUND` 的比较。

推测：如果线程确实修了低意见，写记录本身不算错误，所以严重度低；但这是文档规则与脚本执行端的不一致。

建议：要么在 `--accept-low` 里加入 `acceptLow >= LOW_DEFER_FROM_ROUND` 的拒绝原因，要么在文档中明确“第 3 轮起只是不再自动建议 `--accept-low`，手工仍可使用”。补对应测试。

---

## 侧重检查

- **不可信输入/安全**：检查了 `base` 进入 NEXT（发现命令注入风险，见第 1 条）、`quote`/控制字符（第 6 条）、`pr`/`round`/`model` 的路径拼接。`--pr` 是正整数，`round` 是正安全整数，`judgeSkeleton` 的答案文件名取 `model.split("/").pop()`，未发现路径穿越；`judgeSkeleton` 拒绝覆盖 `verdicts.jsonl`，没有不可撤销覆盖。
- **错误路径**：`--finish-round` 只取 ok 记录，不检查本轮是否所有请求模型完成（第 2 条）；`deferredLowLines` 对缺失 verdicts 静默跳过（第 4 条）；缺失答案文件会直接抛 ENOENT，没有友好错误，但不会写错文件。
- **资源耗尽**：`deferredLowLines` 的 `3..latest` 循环和每次 `git show`，加上 `round` 无上限（第 3 条）。
- **不可逆操作**：`--judge-skeleton` 拒绝覆盖已有 `verdicts.jsonl`；`--finish-round` 会覆盖已有 `judgments.md`，但后者由前者和 `verdicts.jsonl` 派生，风险低，未单列。
- **规则/文档一致**：`model-review.md:64` 的“最后一轮”与 ADR 0263:59/代码的“每一轮”不一致（第 4 条）；`--accept-low` 与“第 3 轮起不记 low-fix”不一致（第 7 条）。流程卡、AGENTS.md 的其余描述和代码基本一致；流程卡的锚点和 `--` 选项有测试核对存在性。

## 必答问题

1. **会不会改变模型已经见过的请求开头？**
   新增的 `--judge-skeleton`、`--finish-round` 和 `deferredLowLines` 完全不发模型请求，不影响系统提示、工具定义、历史或遮盖。唯一改到模型输入的是 code-review 的固定输出格式句（`opencode-review.mjs:304`），它位于 `buildPrompt` 的 `fixed` 段（`:354-365`），也就是新请求用户消息的开头、材料之前，**不是末尾追加**。代码复核每轮是新 opencode 会话（首调不传 `--session`），所以不会改写已发出的历史；但部署后第一批 code-review 请求（包括同一个 PR 的下一轮）的前缀会与旧版本不同，造成一次性缓存未命中；部署后各轮之间该固定句仍逐字节相同。每轮会变的 `head`、`base`、`previous` 都在 `material` 尾部（`:366-378`），没有进入固定段。结论：同一会话内的只追加规则未被破坏，但这确实是一次已批准的固定提示词变更，而不是“对请求开头无影响”。
2. **会不会让同一段文字在不同请求里变成不同字节？**
   不会由这次改动直接造成。新命令只写本地文件，输出顺序固定：`deferredLowLines` 按轮次升序、`verdicts.jsonl` 按文件行序、`models` 按账本记录顺序；没有加入时间、随机数或无序集合遍历。`judgments.md`/NEXT 不发给模型。`lowDeferFromRound` 也是固定配置值。
3. **有没有自动检查，反向用例真的会失败吗？**
   有：`test/tooling/review-round-tools.test.mjs` 覆盖了 skeleton 提取与分节跳过、`JUDGE_SKELETON_EXISTS`/`JUDGE_SKELETON_NONE`、finish 的原话/`why`/控制字符拒绝、NEXT 分支、参数混用拒绝、deferred 的轮次边界和 `low-fix` 跳过；流程卡测试核对锚点和选项存在。断言是 `throw`，按代码逻辑会失败。**但我没有运行测试，实际运行结果未核实。** 缺口是多模型 NEXT、后续轮次已修的低意见、`quote`/`modelSeverity` 控制字符、超大 `round`、缺失 `verdicts.jsonl` 都没有反向用例。
4. **改动产生或修改的每个值，使用它的地方都能接受吗？**
   - `lowDeferFromRound`：`reviewModelsProblems` 校验为安全整数且 `>=2`（`:81-82`），导出后在 `finishRound`、`deferredLowLines`、报告标题使用；类型和含义一致。但 `--accept-low` 没有使用它（第 7 条），且允许配置成 2 时，AGENTS.md 里“第 1、2 轮照样修改”就不再成立。
   - `--judge-skeleton`/`--finish-round`：`parseArgs` 只允许 `--pr`、`--repo`，`--pr` 校验正整数，混入 `--stop`、`--report`、`--mode` 等会报 `ARG_NOT_FOR_SUBCOMMAND`；这一点有测试，且代码与说明一致。
   - `verdicts` 字段：`judgeSkeleton` 写 `valid:null`、`class:null` 的草稿，`parseVerdicts` 在未填好时以 `VERDICTS_INVALID` 拒绝；`finishRound` 再核对原话、`why`、部分控制字符，前后校验基本衔接。
   - `NEXT` 里的 `--previous`：用的是 `record.head`（本轮复核提交，`COMMIT_PATTERN` 校验过），不是账本提交；低轮次/带 `low-fix` 时 `latestReviewRound` 只筛 `code-review` 且忽略 `low-fix`，这部分是正确的。
   - `NEXT` 里的 `--base`：产生于账本（`:3569`），使用于 shell 命令（`:1791`），但 `parseUsage` 没有校验 `base`（第 1 条）；`--gateway` 有 `GATEWAYS` 校验，`--pr` 有整数校验，`--head` 有提交格式校验。
   - 报告里的 deferred 行：`id`/`quote`/`trigger`/`consequence` 用 `printable` 转义，模型短名来自允许清单；但语义上的“是否已修”没有校验（第 4 条）。
   - 作者说“新命令只读写最新一轮目录”基本成立；`latestReviewRound` 还读 PR 根下的 `usage.jsonl`，但没有越出 PR 目录。
   - “合并检查规则没有改”经增量 diff 确认为真；“第 1、2 轮低意见照旧 `--accept-low`”在默认配置 3 下为真，但脚本没有禁止对第 3 轮使用 `--accept-low`。
