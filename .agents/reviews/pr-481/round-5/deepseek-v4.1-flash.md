本轮查过的范围：`65bd5eb..b3519e0` 的首父提交（`33a420cfc`、`aeb5b7374`、`933323ab9`、`b3519e0`）与合并提交 `36bfd924a`；ADR 0263 全文、数据文件全文、`opencode-review.mjs` 的 `buildPrompt`/`judgeSkeleton`/`finishRound`/`deferredLowLines`/`acceptLow`/`parseArgs`、`review-models.json`、流程卡、`code-review-round.md`、`AGENTS.md` 和 `model-review.md` 的相关段落；`ccec8bd0f^` 的旧提示；`prompt-prefix.md`、`incidents-and-gates.md` 的 I-73、`check-docs-links.mjs`、`check-instruction-links.mjs`。`git diff 94a958323..36bfd924a` 只显示 PR 自己的 44 个文件，支持“合并干净”，但没有逐行复核 main 自己的 416 个文件。

## 读代码证实的

### 1. 低：ADR 说第 3 轮起不记 low-fix，但 `--accept-low` 仍接受第 3 轮及以后

文件:行：`scripts/model-review/opencode-review.mjs:1560-1602`（尤其 1565-1566、1585-1596）、`docs/adr/0263-cheaper-claude-side-of-code-review.md:59`、`.agents/instructions/model-review-card.md:42`

问题：ADR 和流程卡都写“第 3 轮起低意见不修、不记 `low-fix`、不再复核”，但 `assertReviewed` 的 `acceptLow` 分支只核对“是不是最后一轮、是否已经 low-fix、修改规模和测试”，没有核对 `acceptLow` 是否已经到 `LOW_DEFER_FROM_ROUND`。线程在第 3 轮仍可运行 `--accept-low 3`，写下一行 `mode: "low-fix"` 的记录并通过合并检查，这与 ADR 的决定相反。

证据：

```js
else if (complete.round !== acceptLow) reasons.push(`not-last-round last=${complete.round}`);
else if (complete.by === "low-fix") reasons.push(`already-low-fixed round=${acceptLow}`);
...
round: acceptLow,
...
mode: "low-fix",
```

建议：在 `acceptLow` 分支加一条 `acceptLow >= LOW_DEFER_FROM_ROUND` 的拒绝原因（例如 `low-deferred-round`），并补反向用例：第 3 轮应 `REVIEW_LOW_FIX_REFUSED`，第 2 轮仍可通过；同时把 `model-review.md` 里 `--accept-low` 那段写明这个上限。若故意允许 Andy 特批，应该在 ADR 和流程卡写明例外和记录方式，否则代码和规则不一致。

### 2. 低：ADR 0263 修订 ADR 0175，但 0175 的 `amended_by` 没有回指 0263

文件:行：`docs/adr/0263-cheaper-claude-side-of-code-review.md:7`、`docs/adr/0175-cheaper-code-review-rounds.md:8`、`docs/adr/0031-isolated-tool-execution.md:139`

问题：0263 写了 `amends: "docs/adr/0175-cheaper-code-review-rounds.md"`，但 0175 的 `amended_by` 仍只有 0259。仓库里多处 ADR 采用双向 `amends` / `amended_by`，并有多个用逗号分隔的例子；只加单向链接会让按 `amended_by` 查找“0175 被谁改过”的读者漏掉 0263，也可能触发文档严格校验的告警。

证据：

```yaml
# docs/adr/0263-cheaper-claude-side-of-code-review.md:7
amends: "docs/adr/0175-cheaper-code-review-rounds.md"

# docs/adr/0175-cheaper-code-review-rounds.md:8
amended_by: "docs/adr/0259-review-models-default-to-deepseek.md"
```

`docs/adr/0031-isolated-tool-execution.md:139` 明确写着“采用双向 `amends` / `amended_by` 元数据”。

建议：把 0175 的 `amended_by` 改成同时列出 0259 和 0263；如果 document-governance 不要求双向，也应在 0263 里说明为什么不做回指。改完重跑文档严格校验，确认没有新增错误。

### 3. 低：ADR 决定第 4 条用引号写“新提示”，但与代码不是逐字一致

文件:行：`docs/adr/0263-cheaper-claude-side-of-code-review.md:58`、`scripts/model-review/opencode-review.mjs:371`

问题：背景里的旧提示已经在第 5 轮按 `ccec8bd0f^` 改成逐字原文，但决定第 4 条引用的新提示仍是缩写/改写：少了“上一轮复核到 … 这一轮”“前几轮已经复核过”，并把“结论里写清这一轮查过哪些范围”写成“结论写清查过哪些范围”。读者会把它当成当前提示的原话；如果以后有人照这段改代码，会误以为现有提示就是这几句。

证据：

```text
# 代码第 371 行
上一轮复核到 ${previous}，这一轮先看 git diff ${previous}..${head} 的增量，复核增量和它直接影响的代码：... 增量没有碰到、行为也没被增量改变的旧代码前几轮已经复核过，不必整份重读；但证据指向旧代码时要跟下去。结论里写清这一轮查过哪些范围。

# ADR 第 58 行
提示改为“先看增量，复核增量和它直接影响的代码：... 增量没碰到、行为也没被增量改变的旧代码不必整份重读，但证据指向旧代码时要跟下去；结论写清查过哪些范围”。
```

建议：要么改成和 371 行逐字一致，要么去掉引号并写成“大意是”，与背景一节“原话”的标准区分开。既然本轮已经把旧提示按原文校正，建议同样对待新提示。

## 推测/未核实

- 作者说 round 6 共 37 句、36 句一致，第 31 句指向仓库外线程文档：`.agents/reviews/` 被本环境的 git 规则拦住（`git show` 返回 `REVIEW_GIT_REFUSED records-path`），**未核实**。
- 作者说第 4 轮 23 条引用因 `.agents/reviews/` 过不了合并检查：同样被记录路径规则拦住，**未核实**。
- `.agents/reviews/topic-review-claude-side-cost/data.md` 已删除后是否还有历史文件引用旧路径：`grep` 只覆盖当前稀疏检出（约 63%），**未核实全部历史文件**。
- `document-governance` 严格校验的 13 个错误、外部 Claude Code 文档链接、以及 ADR 里的外部网址：无法运行技能或联网，**未核实**。
- 数据文件的 180 个 PR、312 轮等数字没有重新统计；只核对了 ADR 与数据文件之间的数字一致性，**没有从原始账本复算**。
- 其他观察（不作为意见）：`docs/assets/review-cost/2026-11-13-data.txt:15` 的 `。”。` 是双句号，27–29 行多一个空行；纯排版问题。

## 侧重检查

- **错误路径**：ADR 0263 的 `docs/assets/review-cost/2026-11-13-data.txt` 链接、ADR 0175/0259、`model-review.md`、流程卡都存在；流程卡指向的 `model-review.md#code-review`、`#how-to-run`、`#gateway`、`#owner-control` 和 `docs/lessons.md#trust-reported-checks` 锚点都存在。没有发现断链。
- **不可信/不合规范输入**：`--finish-round` 会校验 `verdicts.jsonl` 的字段、原话是否在答案里、`why`、控制字符和 `base` 是否为提交哈希；`--pr`、`--repo` 等参数有校验。残余风险：控制字符检查只覆盖 `why`/`trigger`/`consequence`/`reason`，`quote` 来自模型答案，未做同样的控制字符检查；未发现它被当作代码执行，只可能影响终端显示。
- **安全**：新数据文件是静态文本，没有密钥；复核记录目录在 `prepareCopy` 里被排除；本轮没有改遮盖、鉴权或网络代码。
- **资源耗尽**：数据文件很小；`deferredLowLines` 已改成只遍历账本里记录过的轮次（不再从 3 循环到 `MAX_SAFE_INTEGER`），测试还断言耗时小于 10 秒；本轮没有新增无界循环。
- **不可撤销操作**：这是一次带内容保留的改名，旧内容已完整进入新文件；当前检出里没有发现仍指向旧路径的活引用。没有删除底层数据。
- **规则/文档/代码一致性**：上面三条就是这一轮找到的主要不一致；其余 ADR 决定与流程卡、`AGENTS.md`、`review-models.json`、`opencode-review.mjs` 的对应关系一致。

## 必答问题

1. **请求开头是否改变**：本轮增量（ADR 背景、数据文件、复核记录）不参与模型请求，系统提示、工具定义、历史、遮盖都没有变。`buildPrompt` 仍把固定部分放前面，把 `head`、`base`、`previous`、`brief` 放在后面的 material 里；每轮会变的值都在最后一条用户消息中。需要说明的是，PR 早先的 `ccec8bd0f` 把代码复核输出格式改成 `###` 标题，确实改了固定部分一次；这是一次性的提示文字变化，不是本轮新增，也不引入每轮变化值。新的 `--previous` 提示同样在 material 里，不在固定开头。
2. **同一段文字是否变成不同字节**：本轮没有新增依赖前后文的遮盖、带时间的提示字段或无序集合。数据文件是静态内容；代码侧 `deferredLowLines` 按轮次排序、`finishRound` 按 `verdicts.jsonl` 文件顺序生成 `judgments.md`，都是确定的。`usage.jsonl` 里的 `at` 时间字段不会发给模型。未发现新的不确定性。
3. **自动检查和反向用例**：流程卡锚点和参数有 `test/tooling/review-round-tools.test.mjs:250-265` 检查，指令链接有 `check:instruction-links`，ADR 的 `docs/` 链接有 `check:docs-links`。`--judge-skeleton`、`--finish-round`、`--report` 的低意见边界都有反向用例（例如 `JUDGE_SKELETON_EXISTS`、`JUDGE_SKELETON_NONE`、`FINISH_ROUND_REFUSED why-missing/quote-not-found/control-character/base-invalid`、第 3 轮前后 low 列表、缺失 `verdicts.jsonl`）。缺口是：`--accept-low` 在第 3 轮及以后没有被拒绝，也没有对应的反向测试，所以“第 3 轮起不记 low-fix”这条规则不会被测试发现。数据文件的数字也没有确定性复算测试，只有 plan-claims 的逐句核对；数字写错不会让测试失败。
4. **每个值的使用端**：
   - 新路径 `docs/assets/review-cost/2026-11-13-data.txt` 被 ADR 链接、plan-claims 的证据路径和文档读者使用；`validEvidencePath` 接受 `docs/` 路径且拒绝 `.agents/reviews/`，`blobAt` 会核对文件和行号，链接检查会核对文件存在。旧路径在当前检出里没有发现活引用，但稀疏检出不能证明全部历史文件。
   - `lowDeferFromRound` 在 `review-models.json:7` 产生，`reviewModelsProblems` 校验为不小于 2 的整数，`LOW_DEFER_FROM_ROUND`、`finishRound`、`deferredLowLines`、报告标题都从同一常量读取；测试覆盖了 `undefined`、1、字符串三种非法值。
   - `amends` 字段的产生端是 ADR 0263，消费端 ADR 0175 的 `amended_by` 没有回指，见意见 2。
   - `--accept-low` 的轮次边界消费端缺少 `LOW_DEFER_FROM_ROUND` 校验，见意见 1。
   - `--judge-skeleton`/`--finish-round` 只接受 `--pr`、`--repo`，并有参数测试；`base` 字段由 `COMMIT_PATTERN` 校验，反向用例存在。
