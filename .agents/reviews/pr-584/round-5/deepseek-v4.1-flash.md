## 结论

本轮增量只有 `docs/adr/0280-...md` 的 3 行删除、3 行新增（`8a6449e..db8b286`，已用 `git diff` 核对），没有代码改动。未发现中高严重度问题；下面两条都是低严重度的“说法与代码范围不一致”，不影响增量轮的实际行为。

### 1. 低 — ADR 说“这段原文只在退回原做法时使用”，但第一轮全量复核也会出现这句

文件:行：`docs/adr/0280-incremental-review-rounds-see-only-the-pr-s-own-increment.md:30`；代码 `scripts/model-review/opencode-review.mjs:377`、`:396`

问题：新写法把范围说宽了。代码里 `const scoped = Boolean(previous && increment);`，第一轮没有 `previous` 时 `scoped` 为假，`base && !scoped` 成立，于是“对比基准是 ${base}，先运行 git diff ${base}..${head} 看改动。”照常出现在首轮全量复核里。这不是“算不出增量、退回原做法”，而是正常首轮。严格按字面读，“这段原文只在……”不成立；限定在“增量轮内部”才成立。

证据：
```js
377:   const scoped = Boolean(previous && increment);
396:     base && !scoped ? `对比基准是 ${base}，先运行 git diff ${base}..${head} 看改动。` : null,
```
`test/tooling/review-increment.test.mjs:295` 的 `full = buildPrompt(base)`（无 `previous`）会走到这一行；同文件 `:303` 只断言增量轮不再包含 `git diff ddd..ccc`，反证首轮仍包含。

建议：改成“在增量轮里，这段原文只在算不出增量、退回原做法时使用；第一轮全量复核仍使用它”，或把“这段原文”明确限定为“增量轮的这段原文”。

### 2. 低 — “--assert-reviewed 的结果不受 shadow 影响”说得过满

文件:行：`scripts/model-review/opencode-review.mjs:1758`、`:1795-1801`、`:3420-3428`；shadow 目录 `:3641-3643`

问题：`assertReviewed` 的轮次和覆盖判断确实只读顶层 `usage.jsonl`（`:1758`），shadow 记录不会进入复核链。但它随后调用的 `recordSecretProblems` 用 `git ls-tree -r --name-only HEAD -- <ledgerPath>` 递归列出整个账本目录，包括 `pr-N/shadow/` 下的文件，并交给 `recordFileProblems` 扫 secret-like 内容。因此 shadow 记录里的内容仍可能让 `--assert-reviewed` 增加 `record-secret-like` 问题；“结果不受影响”只对复核链和覆盖判断成立，对完整结果不成立。

证据：
```js
1758:   const shown = gitStatus(["show", `HEAD:${ledgerPath}/usage.jsonl`], repo);
1796:     ...recordSecretProblems({
3414:     for (const id of secretLikeRules(shown.stdout))
3415:       problems.push(`record-secret-like ${printable(file)} ${id}`);
3421:   const listed = gitStatus(["ls-tree", "-r", "-z", "--name-only", "HEAD", "--", ledgerPath], repo);
```
读代码证实：shadow 文件在递归扫描范围内。推测：只有 shadow 记录实际含 secret-like 文本时，结果才会真的多出问题；日常记录的字段通常不会触发，所以严重度低。

建议：把说法改成“不影响复核链和覆盖判断；shadow 记录仍会参与账本 secret 扫描”。如果确实要完全隔离，再单独评估是否把 shadow 从 secret 扫描中排除（不建议轻易排除，那会削弱“已提交记录不含敏感信息”的检查）。

## 作者说法核对

1. **成立。** `planIncrement` 和 `assertReviewed` 共用 `unreviewedFiles`：`opencode-review.mjs:1711`、`:1770`；`files.length === 0` 时 `planIncrement` 返回 `{ empty: true }`（`:1719`）。测试 `review-increment.test.mjs:156-165` 覆盖“只合并 main”的情形。
2. **成立。** `incrementScope` 的文件来自 `unreviewedFiles`，差异用 `patchFor(previous, head, file)` 取净差异（`increment.mjs:144-160`、`:184`），所以手工解决冲突写入的内容会出现在 `previous..head` 里；测试 `:168-186` 明确覆盖。
3. **成立。** 预算按 `PROMPT_MAX_BYTES - promptBytes - 1` 计算（`opencode-review.mjs:1734`），`incrementBlock` 逐文件整份加入并受预算约束（`increment.mjs:213-229`）；`withIncrement` 在最终提示仍超限时退回无增量提示（`:1745-1751`），主流程再兜底检查（`:4012-4013`）。测试 `:201-215`、`:276-287` 覆盖。注意：预算用的是不带增量的提示长度，若增量版材料头部文字更长，会因 `withIncrement` 提前退回，但不会让提示超过上限。
4. **基本成立，见意见 2。** shadow 写自己的目录（`:3641-3643`）、记录带 `shadow: true`（`:4200`），`--assert-reviewed` 不读 shadow 账本做轮次判断；测试 `:416-435` 覆盖目录和参数限制。但完整结果仍会被递归 secret 扫描看到，见意见 2。

## 侧重检查

- **错误路径：** 核对了 `REVIEW_INCREMENT_EMPTY`、`REVIEW_INCREMENT_FALLBACK` 的各原因（`config-missing`、`main-ref-missing`、`merge-base-failed`、`diff-failed`、`file-name-invalid`、`too-large`），失败时 `block` 为 `null`，不会把半截增量交给模型。
- **不合规范或不可信输入：** 配置校验拒绝未知键、类型错误、越界、非递增分档（`increment.mjs:38-61`）；账本字段拒绝负数、非整数、换行、控制字符和 `shadow: false`（`opencode-review.mjs:2288-2305`、`increment.mjs:260-297`）；文件名含替换字符或控制字符时退回（`opencode-review.mjs:1717`）。
- **安全：** 本轮只改文档，未引入新的秘密或新输出渠道。确认 `assertReviewed` 的 secret 扫描范围覆盖 shadow 目录，这一点与作者说法 4 的措辞有出入（意见 2）。
- **资源耗尽：** 核对了提示字节上限、`inlineDiffMaxBytes` 上限 90000、`maxFilesListed` 上限 2000、`toolSummaryTopFiles` 上限 50 和 git 256MB `maxBuffer`。增量块会先为所有文件取完整 patch 再截断，超大 PR 的内存/耗时本轮未展开核对；该代码不在本轮增量内，不计入本轮意见。
- **不可撤销操作：** 复核脚本只追加账本、shadow 写独立目录；本轮文档改动不涉及。
- **规则/文档/代码一致：** 三条改动引用都能在代码中找到对应原文；`PROMPT_MAX_BYTES = 100000` 与 `PROMPT_TOO_LARGE` 检查（`:1695`、`:4013`）一致；`model-review.md:165` 也明确首轮仍让模型自己看 diff，与意见 1 的表述范围问题相呼应。

## 必答问题

1. **不涉及代码。** 本轮只改 ADR 文档；文档的改动只会作为“本轮增量”差异出现在提示末尾。核对了 `buildPrompt`：固定前缀在 `opencode-review.mjs:381-392`，增量块在 `:412` 追加在 `brief` 之后，确实仍是“只在末尾追加”；每轮变化的提交号、文件数、行数都在增量段（最后一条消息）里。
2. **不涉及。** 文档内容静态，不会让同一段文字在不同请求里变成不同字节。顺带核对增量生成：文件按路径排序（`increment.mjs:113`、`:133`），git 参数固定、`LC_ALL=C`（`:68-69`），过滤 `index` 行（`:158`），测试 `:152` 断言同一轮重跑差异块逐字节相同；没有时间字段或无序集合进入提示。
3. **不涉及文档改动本身。** 本轮没有针对 ADR 文案的自动检查，这是文档类改动的正常情况，但也意味着引用字句可能随代码漂移。功能行为有测试：配置反向用例（`review-increment.test.mjs:107-122`）、非法账本字段（`:346-360`）、超限退回（`:276-287`）。需要注意，`:309-314` 名为“keeps the old wording exactly”，实际只是当前代码内 `with/without increment` 对比，没有断言旧提示里的“不必整份重读”；若该句被删，ADR 第 90 行的说法不会触发测试失败。
4. **不涉及新产生的标识、配置键或序列化格式。** 本轮唯一引用的值是 `PROMPT_MAX_BYTES`；它在 `opencode-review.mjs:1734`、`:1741`、`:1748`、`:4013` 的使用端都按“提示字节上限”解释，两端校验一致。配置键本轮未改；`review-increment.json` 与 `parseIncrementConfig` 的键和范围一致。

## 本轮查过的范围

查了 `8a6449e..db8b286` 的本 PR 自有差异（确认只有该 ADR 的 3 删 3 增），并对照读了 `buildPrompt`、`planIncrement`、`incrementScope`、`incrementBlock`、`incrementRecordValid`、`toolSummaryValid`、`assertReviewed`、`recordSecretProblems`、shadow 参数与账本路径，以及 `test/tooling/review-increment.test.mjs`、`scripts/model-review/review-increment.json`、`.agents/instructions/prompt-prefix.md`、`.agents/instructions/model-review.md:165`。没有运行测试（本轮工具只允许读文件和只读 git 命令），测试结论来自阅读测试代码；未重新审计整个 PR 的早期实现。
