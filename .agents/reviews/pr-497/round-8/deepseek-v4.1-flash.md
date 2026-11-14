本轮范围：对比 `3bce535cf..a79f8dbc3`，读了 `scripts/model-review/exit-codes.mjs`、`scripts/model-review/opencode-review.mjs`（`REVIEW_RECORD_ERRORS`、`--assert-reviewed` 的 catch、`assertReviewed`、`claimsProblems`、`lowFixProblems`、`parseUsage`、`parseVerdicts`）、`scripts/ci/merge-queue.mjs`（`reviewChecker`、`readiness`、`start`）、`test/tooling/merge-queue.test.mjs`、`test/tooling/opencode-review-merge-gate.test.mjs`、`.agents/instructions/model-review.md`、`.agents/instructions/model-review-card.md` 和 ADR 0268。未核实：`.agents/reviews` 原文读不到（本仓库 git 拒绝 records 路径），因此下面第一条的账本哈希只能从提交时间线推断。

### 1. 中高 ADR 0268 改动没有配套的 plan-claims 记录，`--assert-reviewed` 会报 `claims-stale` 并让队列移出该 PR

文件:行：`docs/adr/0268-merge-queue-and-related-tests-on-prs.md:104`（a79f 新增）、`scripts/model-review/plan-claims.mjs:248-250`、`scripts/model-review/opencode-review.mjs:1452-1459`、`scripts/model-review/opencode-review.mjs:3440-3441`、`scripts/ci/merge-queue.mjs:345-357`。

问题：a79f 修改了本 PR 新增的 ADR 0268，但增量里没有更新 `topic-merge-queue-claims/usage.jsonl`。`--assert-reviewed` 会对新增 ADR 调 `claimsProblems`，要求存在一条 `claimsSha256` 等于当前 ADR 文件字节的 plan-claims 记录；没有就报 `claims-stale`，进入 `REVIEW_NOT_CURRENT`、以 5 退出。合并队列的检查命令不带 `--accept-unreviewed`，所以会直接把这个 PR 移出队列，作者的材料没有提到这一点。

证据（读代码证实的）：

```js
// plan-claims.mjs:248-250
const matching = own.filter((record) => record.claimsSha256 === sha);
if (matching.length === 0) {
  problems.push(own.length > 0 ? `claims-stale ${label}` : `claims-unchecked ${label}`);
```

```js
// opencode-review.mjs:3440-3441：记录里存的是 ADR 在复核提交上的摘要
claimsFile: options.claimsFile,
claimsSha256: claimsBlobSha256(options.repo, commits.head, options.claimsFile),
```

`assertReviewed` 在 `opencode-review.mjs:1452-1459` 调 `claimsProblems`，问题会进入 `problems` 并以 5 退出（`3416-3417`）；`merge-queue.mjs:345-357` 只传 `--assert-reviewed --pr --repo --main-ref`，没有覆盖参数。

推断（账本原文未核实，因 git 拒绝 `.agents/reviews`）：`git show --stat 63bb4f2ea` 显示 `topic-merge-queue-claims/usage.jsonl` 最后一次更新在第 6 轮声明核对（06bb4f2ea），而它之后 `dfc7fc7ff`、`3bce535cf`、`a79f8dbc3` 都改了 ADR 却没有再动这份账本；`git diff 7b6aad3cb..a79f8dbc3 -- docs/adr/0268-...` 也确认最终内容与最后一次声明核对时不同。只要账本里没有正好哈希最终内容的记录，就必然 `claims-stale`。plan-claims 的现有测试 `test/tooling/plan-claims-gate.test.mjs:373-377` 正是“改了 ADR 之后记录变 stale”。

建议：在合入前对 a79f 上的 ADR 0268 重跑 `--mode plan-claims --head a79f8dbc3 --claims-file docs/adr/0268-...`，提交新的记录；或者回退这次 ADR 改动。以后把“改 ADR 后必须重核声明”写进收尾清单，避免最后的文档小改把前面的声明核对作废。

### 2. 低 去掉 `VERDICTS_INVALID` 的“到不了”只有人读代码支持，没有反向用例

文件:行：`scripts/model-review/opencode-review.mjs:1227-1231`、`scripts/model-review/opencode-review.mjs:1445`、`scripts/model-review/opencode-review.mjs:3405-3414`。

问题：删掉 `VERDICTS_INVALID` 行为不变的前提是 `lowFixProblems` 始终把 `parseVerdicts` 的错误吞成 `problems`。目前确实如此，但没有测试锁定；将来若改成直接抛出，`--assert-reviewed` 会以未捕获异常退出 1，队列会把它当成“复核检查坏了”停下整个队列，而不是只移出这个 PR。

证据（读代码证实的）：`lowFixProblems` 捕获了 `parseVerdicts`：

```js
try {
  verdicts = parseVerdicts(text, verdictsPath);
} catch (error) {
  return { problems: [error.message], files: [], errors: [] };
}
```

而 `main` 的 catch 只认 `REVIEW_RECORD_ERRORS`：

```js
export const REVIEW_RECORD_ERRORS = ["USAGE_LEDGER_INVALID", "REVIEW_ROUND_HEADS_DIFFER"];
...
if (!REVIEW_RECORD_ERRORS.some((code) => error.message.startsWith(`${code} `))) throw error;
```

现有 `test/tooling/opencode-review-merge-gate.test.mjs` 只测了坏 JSON 的 usage 账本（`1623-1643`），没有测坏 `verdicts.jsonl` 在低严重度修复链上时的退出码。

建议：补一条 CLI 用例：构造带 `low-fix` 的账本、把对应 `verdicts.jsonl` 写成坏行，断言退出 5 且输出是 `low-fix-invalid ... VERDICTS_INVALID`，不是崩溃；或在 `REVIEW_RECORD_ERRORS` 旁注释这个前提。

**侧重检查**

- 错误路径：确认 `--assert-reviewed` 的 catch 只吞 `USAGE_LEDGER_INVALID` 和 `REVIEW_ROUND_HEADS_DIFFER`；其他错误（如 `GIT_FAILED`）仍会退出 1，队列按 `broken` 停下，符合设计。`REVIEW_RECORD_INVALID` 的输出长度受账本路径和 40/64 位提交哈希限制，不会无限增长。
- 不合规范/不可信输入：PR 自己的 `usage.jsonl` 是不可信输入；坏 JSON 会被 `parseUsage` 统一转成 `USAGE_LEDGER_INVALID`，不会把原始内容拼进输出。`REVIEW_RECORD_INVALID` 打印的 `error.message` 不含 PR 文件内容，没有新的日志注入面。
- 安全：`exit-codes.mjs` 无副作用、无外部输入；合并队列仍从 main 的检出运行脚本，没有因为新增模块而开始执行 PR 代码。`scripts/model-review/exit-codes.mjs` 不在 `protectedPaths` 内，但队列在合入前用的是 main 上的副本，不会让 PR 自证；合入后生效的部分由候选完整 CI 覆盖。此项未发现新增缺陷。
- 资源耗尽/不可撤销操作：增量没有新增循环、子进程或写操作；队列移出 PR 是可逆的标签/评论操作。
- 规则、文档与代码一致性：`REVIEW_RECORD_INVALID` 在 `model-review.md`、`model-review-card.md`、ADR 0268 和代码里的含义一致；`VERDICTS_INVALID` 仍保留在卡片的第 2 步说明中，和 `parseVerdicts` 仍在 `finish-round`/低修复路径使用一致。唯一的不一致是第 1 条：ADR 内容改了，但声明核对记录没跟上。

**必答问题**

1. **不会改变模型已经见过的请求开头。** 增量只改 `scripts/`、测试、`.agents/instructions` 和 ADR，没有改产品提示词组装代码。复核提示词方面，`questionsSource` 确实会读 `.agents/instructions/model-review.md`（`opencode-review.mjs:2775-2781`），但 `reviewQuestions` 只从 `<a id="checklist"></a>`（该文件第 77 行）起取前两节（`286-296`）；本次改的是第 72 行的第 6 步，在清单之外，所以“必答问题”列表和固定提示词字节不变。`buildPrompt` 仍是固定说明在前、本轮材料（`head`、`base`、`previous`、brief）在后（`350-379`），没有把每轮变化的值挪进开头。`prepareCopy` 还会对模型副本排除整个 `.agents/reviews`（`2811`），本轮新增的 round-7 记录不会进入模型材料或提示词。
2. **不会让同一段文字在不同请求里变成不同字节。** 增量没有新增时间、路径、哈希或无序集合到提示词组装；遮盖规则 `RECORD_SECRET_RULES` 未改。唯一新增的时间字段是写入 `.agents/reviews` 的账本记录（`ledgerLine` 的 `at`），那是输出且被模型副本排除。ADR 和说明文字不进入提示词（除上面那节未变的清单）。因此相同输入仍序列化成相同字节。
3. **新值的反向用例：确实会在旧代码上失败。** `opencode-review-merge-gate.test.mjs:1623-1643` 断言坏 JSON 账本输出 `REVIEW_RECORD_INVALID` 且退出 5；在 3bce 之前没有这个 try/catch，会抛出未捕获的 `USAGE_LEDGER_INVALID`、退出 1，测试失败。`merge-queue.test.mjs:661-663` 断言退出 5 不是 `broken`、1/2/3/4/130/143 是 `broken`。模块提取的反向情况也成立：把测试放回 3bce，`exit-codes.mjs` 不存在，`merge-queue.test.mjs` 的 import 会失败。唯一没有反向用例的是第 2 条里删掉的 `VERDICTS_INVALID`，因为当前行为本就不变。
4. **新值的产生端和使用端：`REVIEW_NOT_COVERED_EXIT` 和 `REVIEW_RECORD_INVALID` 两端都能接受，ADR 的摘要不能。** `REVIEW_NOT_COVERED_EXIT` 由 `exit-codes.mjs:1` 产生，`merge-queue.mjs:362`、`opencode-review.mjs:3412/3417`、`merge-queue.test.mjs:20/661` 使用；`opencode-review-merge-gate.test.mjs:1617/1643` 还硬编码断言 5，所以值被改错会被测试抓住。`delegate.mjs:517` 也写 5，但语义是“rejected”，没有导入这个常量，不冲突。`REVIEW_RECORD_INVALID` 由 `opencode-review.mjs:3411` 产生，使用端是文档和队列的人工可读输出，没有机器解析器拒绝它。`REVIEW_RECORD_ERRORS` 的两项分别与 `2005`、`1326` 抛出的前缀匹配。作者说“测试都从这里导入”略不准确：只有 `merge-queue.test.mjs` 导入常量，`opencode-review-merge-gate.test.mjs` 用字面量 5，这反而是防止常量被改错的好锚点。**ADR 本身的哈希是反例**：产生端 `opencode-review.mjs:3441` 把最终 ADR 摘要写进记录的前提是重跑 plan-claims，而当前没有匹配记录，使用端 `plan-claims.mjs:248-250` 会拒绝，详见第 1 条。
