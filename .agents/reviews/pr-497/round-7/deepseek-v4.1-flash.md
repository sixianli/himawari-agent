这一轮查过的范围：增量 `14d4f4d3..3bce535c` 的 10 个文件（`opencode-review.mjs`、`merge-queue.mjs`、两个测试、ADR，以及本轮新增的复核记录/`usage.jsonl`）；并跟到 `assertReviewed`、`coveragePoints`、`parseUsage`、`parseVerdicts`、`lowFixProblems`、`main` 的全局错误处理、`merge-queue` 的 `reviewChecker`/`readiness`/`start`、常量所有使用端、ADR 验证段和操作说明。上一轮已复核且本轮未改变的旧代码没有整份重读。

### 1 低 ADR 后果段对“复核账本格式不对”的处置自相矛盾
文件:行 `docs/adr/0268-merge-queue-and-related-tests-on-prs.md:103`

问题：同一句先说“PR 自己的复核账本格式不对也按 5 退出，只移出这个 PR”，随后又说这一轮“不检查排在后面的 PR、也不动待测分组，不移出”。前一种说法符合代码，后一种说法只符合 `broken` 分支，二者混在一句里会让人无法判断队列到底会不会移出。

证据：
- `docs/adr/...:103`：`...；PR 自己的复核账本格式不对也按 5 退出，只移出这个 PR）时，这一轮不建候选、不检查排在后面的 PR、也不动待测分组，不移出；...`
- 代码：`scripts/ci/merge-queue.mjs:362` `broken: result.status !== 0 && result.status !== REVIEW_NOT_COVERED_EXIT`；`:539-542` `if (!review.ok) return { eject: ... }`；`:567-572` 循环里 `if (verdict.eject) await eject(...)` 后继续下一个 PR，`halt` 才返回。

建议：拆成两条：非 0/5 的异常退出 → 不建候选、不检查后面的 PR、不移动待测分组、不移出，连续 3 轮停下；账本格式不对（退出 5）→ 只移出该 PR，继续检查后面的 PR。

### 2 低 ADR 验证清单把新增用例归到了错误的测试文件
文件:行 `docs/adr/0268-merge-queue-and-related-tests-on-prs.md:111`

问题：ADR 把“PR 里的复核账本格式不对时复核脚本按‘没覆盖’退出（5）”列在 `test/tooling/merge-queue.test.mjs` 的覆盖清单里，但新增用例实际在 `test/tooling/opencode-review-merge-gate.test.mjs`；`merge-queue.test.mjs` 里没有针对坏账本的用例。

证据：
- `docs/adr/...:111`：`- \`test/tooling/merge-queue.test.mjs\`：... PR 里的复核账本格式不对时复核脚本按“没覆盖”退出（5）、...`
- `test/tooling/opencode-review-merge-gate.test.mjs:1623` 才是 `it("[ADR-0268] a malformed review ledger in the PR exits with the not-covered code, not a crash", ...)`；`test/tooling/merge-queue.test.mjs` 搜不到坏账本用例。

建议：把这一项从 merge-queue.test 那条移到单独一条，写明是 `opencode-review-merge-gate.test.mjs` 的用例；或真的在 merge-queue.test 中补一个端到端用例。

### 3 低 新增 `REVIEW_RECORD_INVALID` 未写进操作说明，`--report` 也没有同样处理
文件:行 `scripts/model-review/opencode-review.mjs:3411-3417`；`.agents/instructions/model-review.md:72`、`:135`；`.agents/instructions/model-review-card.md:63-69`

问题：`--assert-reviewed` 现在可能输出 `REVIEW_RECORD_INVALID ...` 并以 5 退出，但操作说明只把退出码 5 解释为 `REVIEW_NOT_CURRENT`，错误表也没有 `REVIEW_RECORD_INVALID` 这一行；线程按表会把“表里找不到的办法”升级给 Andy，而不是去修账本。另外 `--report` 同样调用 `assertReviewed`，坏账本时仍走全局 catch 退出 2，与 `--assert-reviewed` 的 5 不一致。

证据：
- `opencode-review.mjs:3414-3417`：`... console.log(\`REVIEW_RECORD_INVALID ${error.message}\`); process.exitCode = REVIEW_NOT_COVERED_EXIT; return;`
- `opencode-review.mjs:1838-1842` `--report` 路径直接 `parseUsage`/`assertReviewed`，`opencode-review.mjs:3729-3732` 全局 catch 仍是 `process.exitCode = 2`。
- `model-review.md:72` 只写“输出 `REVIEW_NOT_CURRENT`（退出码 5）”；`model-review-card.md:67-69` 的错误表没有 `REVIEW_RECORD_INVALID`。

建议：在 `model-review.md` 第 6 步和流程卡错误表补一行 `REVIEW_RECORD_INVALID`（含义：PR 自己提交的账本格式不对，修账本后重跑），并明确 `--report` 是否也要按同一规则处理。

### 4 低 `REVIEW_RECORD_ERRORS` 中有一项到不了 catch，另外两项没有反向用例
文件:行 `scripts/model-review/opencode-review.mjs:1445-1449`、`:1226-1230`、`:1503`；`test/tooling/opencode-review-merge-gate.test.mjs:1642`

问题：`VERDICTS_INVALID` 在 `lowFixProblems` 内已被 `parseVerdicts` 的 try/catch 吞掉并转成 `low-fix-invalid ... VERDICTS_INVALID ...` 问题串，不会从 `assertReviewed` 抛到新加的 catch；列表里保留它但没有实际效果，也没有测试。真正可能抛到 catch 的 `REVIEW_ROUND_HEADS_DIFFER` 也没有退出码 5 的反向用例。作者“捕获以这些代码开头的错误”的说法对 `VERDICTS_INVALID` 不成立。

证据：
- `opencode-review.mjs:1226-1230`：`try { verdicts = parseVerdicts(...) } catch (error) { return { problems: [error.message], ... } }`
- `opencode-review.mjs:1445-1449` 仍列出 `"VERDICTS_INVALID"`；`:1503` `coveragePoints(records)` 才可能抛 `REVIEW_ROUND_HEADS_DIFFER`。
- 唯一反向用例断言的是 `USAGE_LEDGER_INVALID`：`expect(run.stdout).toMatch(/^REVIEW_RECORD_INVALID USAGE_LEDGER_INVALID /m);`。

建议：要么删掉 `VERDICTS_INVALID`，要么让 low-fix 的 verdicts 解析错误也走 `REVIEW_RECORD_INVALID`（并确认 `--accept-unreviewed` 不应能盖过账本格式错误）；同时补一个 `REVIEW_ROUND_HEADS_DIFFER` 的 CLI 反向用例。

### 5 低（部分推测）从 CLI 模块导入常量，给合并队列引入了模块加载副作用
文件:行 `scripts/ci/merge-queue.mjs:6`、`scripts/model-review/opencode-review.mjs:98`

问题：`merge-queue.mjs` 现在导入整个 `opencode-review.mjs`，该模块顶层执行 `const reviewModels = readReviewModels();`，并连带加载 `gateway.mjs`、`plan-claims.mjs`、`spend-guard.mjs`。配置缺失或非法时，合并队列会在 import 阶段整体失败，而不是像以前那样让复核检查子进程失败后被记成 `broken`。另外，坏账本从“退出 2、连续 3 轮停队列”变成“退出 5、逐个移出 PR 并继续检查后面的 PR”；如果坏账本是 main 上校验规则变化一类共享原因造成的，可能在一轮里连续移出多个 PR（推测）。

证据：
- `merge-queue.mjs:6`：`import { REVIEW_NOT_COVERED_EXIT } from "../model-review/opencode-review.mjs";`
- `opencode-review.mjs:98`：`const reviewModels = readReviewModels();`；`:90-94` 读取/校验失败直接抛 `REVIEW_MODELS_CONFIG_INVALID`。
- `merge-queue.mjs:567-572` 每个 `eject` 后继续循环，说明坏账本会逐个移出而不是停队列。

建议：把退出码常量放到一个无副作用的小模块（或单独常量文件）里供两边导入；如果接受当前耦合，至少在 ADR 里写明队列启动依赖 `review-models.json` 有效这一前提。

## 读代码证实的

- 新常量 `REVIEW_NOT_COVERED_EXIT = 5` 和 `REVIEW_RECORD_ERRORS` 的字符串与三处 throw 前缀一致（`USAGE_LEDGER_INVALID `、`REVIEW_ROUND_HEADS_DIFFER `、`VERDICTS_INVALID `）。
- `--assert-reviewed` 的 catch 只包裹 `assertReviewed`，不属于这三个前缀的错误会重新抛出，最终由 `main().catch` 以 2 退出。
- `merge-queue.mjs` 只按数字比较退出码，不解析 `REVIEW_RECORD_INVALID` 文本；5 仍被当作“复核没覆盖”而不是 broken。
- 旧导出 `reviewNotCoveredExit` 删除后，当前仓库没有任何剩余使用端（grep 无结果）。
- 新 CLI 用例确实会让旧代码失败：旧代码没有 try/catch，坏 `usage.jsonl` 会从 `parseUsage` 抛出，由全局 catch 打印到 stderr 并以 2 退出，测试断言的 stdout 文本和 5 都不会出现。
- `merge-queue.test.mjs` 的退出码用例覆盖 1、2、3、4、130、143 为 broken，`REVIEW_NOT_COVERED_EXIT` 为非 broken；但它在旧代码上失败只是因为新导出不存在（ESM 链接错误），不是行为差异。

## 推测

- 坏账本被归类为“PR 自己的问题”后，队列会逐 PR 移出并继续；如果 `USAGE_LEDGER_INVALID` 由共享原因（例如 main 上校验规则变化使旧格式账本失效）触发，可能造成批量错移。代码本身只能证明行为，无法证明这种原因是否会发生。
- `readReviewModels()` 在 import 阶段读取配置，配置损坏时队列会直接启动失败。实际运行中 main 上通常配置有效，影响大小取决于运维对配置错误的容忍策略。

## 侧重检查

- 不可信输入：PR 可控制的 `usage.jsonl`、`verdicts.jsonl` 仍由 `parseUsage`/`parseVerdicts` 做字段和换行校验；新 catch 只把校验错误转成退出码 5，没有放宽校验。
- 错误路径：非记录类错误仍退出 2；`--report` 路径未跟随新规则（见意见 3）；`REVIEW_ROUND_HEADS_DIFFER` 会出现在 stdout 的 `REVIEW_RECORD_INVALID` 行里，但该错误串只含轮次和 40/64 位提交哈希，未见秘密泄漏。
- 资源耗尽：`REVIEW_ROUND_HEADS_DIFFER` 的 `heads.join(",")` 长度随 PR 账本记录数增长，但旧代码本来也把同一条错误打印到 stderr，本轮没有新增放大点；未发现新增循环或无界分配。
- 不可撤销操作：坏账本改为移出 PR（摘 `merge-queue`、加 `merge-queue-failed`、留言），可通过重新加标签恢复；风险主要是批量误移，见意见 5。
- 规则/文档一致性：ADR 后果段自相矛盾、验证段测试文件写错、操作说明未补新输出；见意见 1–3。提示词前缀规则未触及。

## 必答问题

1. **会不会改变模型已经见过的请求开头？** 不会。改动只涉及 `--assert-reviewed` 的异常映射、合并队列的退出码常量导入和测试/文档；`buildPrompt`、系统提示、工具定义、历史消息、遮盖逻辑都没有改动。发给模型的内容仍然只由原有逻辑在末尾追加，每轮会变的值没有新增到前面。
2. **会不会让同一段文字在不同请求里变成不同字节？** 不会。没有新增时间字段、无序集合或依赖后文的遮盖；新增的错误输出只是 stdout 文本，不进入模型请求。`REVIEW_RECORD_ERRORS` 的顺序固定，`REVIEW_NOT_COVERED_EXIT` 是常量。
3. **有没有对应的自动检查，反向用例真的会失败吗？** 有新增检查。`opencode-review-merge-gate.test.mjs:1623-1647` 的坏账本用例在旧代码上确实会失败（旧代码退出 2、stdout 无 `REVIEW_RECORD_INVALID`）。但只有 `USAGE_LEDGER_INVALID` 这一条反向用例；`REVIEW_ROUND_HEADS_DIFFER` 没有用例，`VERDICTS_INVALID` 在当前 assert 路径不可达也没有用例。`merge-queue.test.mjs` 的常量导入改动在旧代码上失败是链接期错误，不是行为反向验证。
4. **新值的产生端和使用端都接受吗？**
   - `REVIEW_NOT_COVERED_EXIT=5`：产生于 `opencode-review.mjs:1444`，使用于 `merge-queue.mjs:362` 和测试 `merge-queue.test.mjs:661`，两端都按整数比较，接受。
   - `REVIEW_RECORD_ERRORS`：产生于 `:1445-1449`，唯一下游是 `:3414` 的 `startsWith` 匹配；格式与三处 throw 一致，但 `VERDICTS_INVALID` 在 assert 路径不可达。
   - `REVIEW_RECORD_INVALID` 文本：产生于 `:3415`，被新测试正则和 ADR 引用；合并队列不解析它，只认退出码，类型/格式无不匹配。
   - 被删除的 `reviewNotCoveredExit`：无剩余使用端，删除安全。
   - 新 import 的两端能配合，但加载的是带顶层副作用和配置读取的 CLI 模块，属于耦合而非类型不匹配，见意见 5。
