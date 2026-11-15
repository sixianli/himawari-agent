## 结论

本轮增量（437fc0f..8a6449e，按材料剔除复核记录后只有 2 个文件、24 行）没有发现中、高严重度的“会出错”问题。改动本身只是把两处“已花金额/替补预算”的账本读取从预先算好的 `linkedRecords` 换成每次重新读的 `spentRecords(options)`；单进程运行中本轮不会写 linked 账本（4217 行只写 `options.out`），所以行为基本等价，只是多了一次重读。下面只有一条低严重度测试问题，另有作者说法核对和必答问题。

### 1 【低】新增测试只锁住辅助函数的重读，锁不住两个真正的调用点，也没断言本账本被计入

文件: test/tooling/review-increment.test.mjs:492-505；scripts/model-review/opencode-review.mjs:1251-1253、4248、4294

问题: 测试把 `out/usage.jsonl` 写成空串，只验证 `spentRecords` 看到 `shadow/usage.jsonl` 后追加的 0.07。因此即使 `spentRecords` 退化成“只返回 linked 账本、完全不读本账本”，或者把 4248/4294 两处改回旧的 `[...readUsage(options.out), ...linkedRecords]`，这条测试仍然通过。测试标题“counts the shadow ledger in the next ordinary round's budget”也没有真正走到普通轮的预算调用链（508-511 的预算断言用的是手工拼的 `parent`/`linked` 数组）。

证据:
- `scripts/model-review/opencode-review.mjs:1251` `export function spentRecords(options) {` / `:1252` `return [...readUsage(options.out), ...linkedLedgerRecords(options)];`
- `scripts/model-review/opencode-review.mjs:4248` `records: spentRecords(options),`；`:4294` `const totalSpent = spentOf(spentRecords(options));`
- `test/tooling/review-increment.test.mjs:492` `writeFileSync(join(out, "usage.jsonl"), "");`
- `test/tooling/review-increment.test.mjs:500` 期望 `[0.15]`；`:505` 期望 `[0.15, 0.07]`

建议: 在 `out/usage.jsonl` 里也写一条本账本记录，断言 `spentRecords` 返回“本账本 + linked”两条且顺序固定；若要防止主流程退回旧写法，至少把两处组合逻辑抽成可测函数，或加一条能覆盖 `substituteRefusal`/最终合计数据来源的测试。测试标题改成只描述实际覆盖的辅助函数行为，避免误导。

## 作者说法核对

1. **成立。** `planIncrement` 用 `unreviewedFiles(repo, commits.previous, commits.head, ledgerPath, mainRef)` 算文件（`opencode-review.mjs:1711`），和 `assertReviewed` 用的是同一函数（`:1770`、`:1791`）；没有文件时返回 `{ empty: true }`（`:1719`），主流程打印 `REVIEW_INCREMENT_EMPTY` 并直接返回（`:4001-4004`）。只合并 main 带进来的文件会被 `ownChangePrints` 的“PR 自己相对合并基线的差异”比较过滤掉（`:1685-1692`）。

2. **成立。** `incrementScope` 对 `unreviewedFiles` 给出的文件取 `previous..head` 的 `git diff --numstat`（`increment.mjs:114`），差异块也按 `previous..head` 逐文件取 patch（`:184-195`），所以手工解决冲突写进这些文件的内容会出现在增量里；只由 main 改、PR 自己没改的文件已被前一步排除。

3. **成立。** 预算取 `Math.min(config.inlineDiffMaxBytes, PROMPT_MAX_BYTES - promptBytes - 1)`（`opencode-review.mjs:1734`），`incrementBlock` 逐文件加入并保证块本身不超过 budget（`increment.mjs:219`、`:222`），加入后还会重建提示并在超限时退回 `too-large`（`opencode-review.mjs:1748-1750`），最后统一检查 `> PROMPT_MAX_BYTES` 就抛错（`:4012-4013`，常量 100000 在 `:1695`）。补充一点：`promptBytes` 用的是 `increment:null` 时的提示，那时 `scoped=false`，材料文字和增量轮不同，所以预算只是近似值；但硬上限由 `withIncrement` 和最终检查兜住，不会真的超过 100000。

4. **基本成立，需限定。** `assertReviewed` 只读 `HEAD:${ledgerPath}/usage.jsonl`（`:1758-1759`），覆盖率点也只来自主账本（`:1445-1447`），shadow 不会获得复核信用。但 `assertReviewed` 还会调用 `recordSecretProblems`（`:1795-1801`），后者用 `git ls-tree -r ... -- ledgerPath` 递归列出账本目录下所有文件（`:3420-3428`），包括 `pr-N/shadow/**`；只是 shadow 的提示、回答和账本在写入前都用同一组 `RECORD_SECRET_RULES` 遮盖了（`:4153`、`:4171`、`:3402-3404`），正常流程不会因此新增 `record-secret-like`。所以“结果不受影响”应理解为“不进覆盖率链、正常写入流程下不影响”，手工放进去未遮盖的 shadow 文件仍可能影响 `--assert-reviewed`。

## 侧重检查

- **错误路径:** `spentRecords` 不吞异常；账本格式错误会由 `readUsage` → `parseUsage` 抛 `USAGE_LEDGER_INVALID`（`opencode-review.mjs:2292-2306`）。重读会让同样的错误可能晚一点（本轮跑完之后打印合计时）才出现，但这是原有行为，不是新增错误类型。
- **不合规范/不可信输入:** 账本内容不可信，`parseUsage` 校验 cost、mode、head、round、increment、toolSummary、shadow 等；`options.out` 由内部构造或 `--out` 解析，不是新增的路径来源。本次没有新增标识、配置键或序列化格式。
- **安全:** 账本和记录写出前会 `maskSecretLike`/`maskSecretLikeDeep`；shadow 账本也走 `ledgerLine`。本次改动只读文件，不写新文件。
- **资源耗尽:** `spentRecords` 每次调用完整读本账本和 linked 账本，末尾两次调用最多四次全文件读取；规模仍受已有 `usage.jsonl` 大小限制，没有新增循环或递归。
- **不可撤销操作:** 没有。
- **规则、说明文档和代码一致性:** `model-review.md:139` 和 `:167`、`model-review-card.md:18` 都说 `REVIEW_SPENT_TOTAL` 和之后普通轮的预算包括 `shadow/` 账本；代码里普通轮通过 `linkedLedgerRecords` 读 `out/shadow`（`opencode-review.mjs:1246-1248`），`dailySpend` 也把 `key` 和 `key/shadow` 分开算（`:1281-1297`），一致。ADR 0280 的“shadow 进单独审计目录、不进复核链”也和 `coveragePoints`/`assertReviewed` 只读主账本一致。

## 必答问题

1. **不涉及。** 本次改动只影响账本读取、替补预算判断和 `REVIEW_SPENT_TOTAL`/`REVIEW_SUBSTITUTE_SKIPPED` 这类输出；`buildPrompt`（`:364-417`）没有改，固定前缀（`:381-392`）没改，增量仍然追加在材料最后（`:412`）。最坏情况只是替补模型被跳过或运行，以及打印的已花金额不同，不会改变发给模型的开头内容。仍满足“只在末尾追加、每轮会变的值在最后一条消息里”。

2. **不涉及模型文字。** 没有新的遮盖逻辑、时间字段或无序集合进入提示；`spentRecords` 返回的是账本记录数组，`parseUsage` 按文件行顺序返回。同一份账本文件内容重复调用得到相同记录；只有外部进程同时追加账本时才会看到不同金额，这属于账务视图差异，不是同一段提示文字变成不同字节。

3. **涉及，但覆盖不完整。** 有新增测试（`review-increment.test.mjs:497-505`），反向用例“追加后仍看不到新记录”会失败，能证明辅助函数每次重读 linked 账本；但主流程两个调用点（4248、4294）是否使用新函数、以及本账本是否被计入，没有被测试锁住，详见第 1 条意见。

4. **涉及，核对后两端可接受。** 产生端是 `spentRecords`（`:1251`）；使用端是 4248 的 `substituteRefusal`（`:1740` → `budgetCheck` `:1228` → `spentOf` `:1217`）、4294 的 `spentOf`，以及测试 500/505。这些使用端只要求传入记录数组、每条记录有有限非负 `cost`（`costUnknown`/`inFlight` 另有处理）；`readUsage` → `parseUsage` 保证了这一点（`:2292-2306`），linked 账本也走同一解析器，两端没有校验口径不一致。`git grep` 没有发现 `spentRecords` 的其他使用端。没有新增标识、配置键、清单项或序列化格式。

## 本轮查过的范围

本轮核对了 437fc0f..8a6449e 中 `scripts/model-review/opencode-review.mjs` 和 `test/tooling/review-increment.test.mjs` 的全部代码差异；沿 `spentRecords` 查了 `linkedLedgerRecords`、`readUsage`、`parseUsage`、`spentOf`、`budgetCheck`、`substituteRefusal`、主流程 4016-4029/4245-4295；另按作者说法核对了 `buildPrompt`、`planIncrement`、`incrementBlock` 的字节预算、`assertReviewed`/`coveragePoints`/`recordSecretProblems`、`dailySpend` 和 `reviewReport` 对 shadow 账本的处理，以及 `docs/adr/0280...`、`.agents/instructions/model-review.md`、`model-review-card.md` 的相关说明。本轮增量中的复核记录文件按工具规则未能读取，也未纳入代码结论。上一轮（第 3 轮）材料列出的“成立的会出错意见”为空，因此没有需要逐条确认的修复项。
