本轮查过：`git diff b3519e0cb..779ef1b` 的增量、PR 侧提交 `6f2152627`/`73d2070`、合并提交 `779ef1b` 的两个父提交与合并结果；重点核对了 `test/tooling/opencode-review.test.mjs`、`test/tooling/opencode-review.fixtures.mjs`、`scripts/model-review/`，并对照了 `.claude/rules/prompt-prefix.md`、`.agents/instructions/model-review.md`、`model-review-card.md` 及相关测试。**未运行测试**。

总体结论：没有发现阻塞问题。合并没有冲突残留，PR 的 `scripts/model-review/` 代码相对 `b3519e0cb` 逐字节未变，main 新用例与 `lowDeferFromRound` 用例可以同时成立。

### 1. 低：作者说合并后只差 import 顺序，但合并还带入了 main 的新用例
文件: test/tooling/opencode-review.test.mjs:84、test/tooling/opencode-review.test.mjs:1990
问题: 作者称“合并后这个文件里本 PR 的改动和合并前相比只差 import 的先后顺序”。代码显示，相对 `b3519e0cb`，合并结果还多了 main 的 `firstChangedMessage` import 和整个 `append-only failure message` 用例块；本 PR 自己的 `lowDeferFromRound` 改动确实逐字未变。
证据:
```js
84:   firstChangedMessage,
...
1990: describe("append-only failure message", () => {
```
`git diff b3519e0cb..779ef1b -- test/tooling/opencode-review.test.mjs` 只显示这两处新增；而 `517: lowDeferFromRound: 3` 与 `549-551` 的三个反向用例在合并前后相同。
建议: 把说法改成“本 PR 的 lowDeferFromRound 改动未变；合并额外带入了 main 的 import 和新用例”，避免把 main 的用例误算成 import 顺序变化。这只是描述问题，不影响行为。

## 侧重检查

- **不可信输入 / 错误路径：`readGatewayRests`**（`scripts/model-review/gateway.mjs:574`）：ENOENT 返回空、坏 JSON 返回 `bad-json`、非对象返回 `not-a-map`、EISDIR 返回 `EISDIR`；控制字符、ANSI、双向控制符被替换，按 Unicode 码点截断到 80；输出排序。读代码与 `test/tooling/review-gateway.test.mjs:1360-1387` 一致。
- **错误路径：`gatewayTiming`**（`gateway.mjs:542`）：空/`null` 返回 `null`；非 2xx、缺 session 的行不参与缓存命中统计；`effort === "low"` 的标题请求被排除；负值归零。读代码与测试一致。
- **不可撤销操作 / 覆盖：`judgeSkeleton`、`finishRound`**（`opencode-review.mjs:1711`、`:1744`）：`judgeSkeleton` 发现 `verdicts.jsonl` 已存在时以 `JUDGE_SKELETON_EXISTS` 拒绝，不覆盖；`finishRound` 先校验再写 `judgments.md`。
- **注入 / 路径：`finishRound` 的 base 校验**：`COMMIT_PATTERN` 只接受 40/64 位十六进制，`main; touch pwned` 会被 `FINISH_ROUND_REFUSED base-invalid` 拒绝；测试 `review-round-tools.test.mjs:213-223` 覆盖。
- **控制字符：`finishRound`**：对 `why`、`trigger`、`consequence`、`reason` 检查控制字符；测试 `:137-150` 用 ESC 反向验证。
- **参数入口：`parseArgs`**（`opencode-review.mjs:3104` 附近）：`--judge-skeleton`/`--finish-round` 只允许 `--pr`、`--repo`，`--pr` 必须是正整数；测试 `review-round-tools.test.mjs:240-246` 覆盖多余参数和缺 `--pr`。
- **配置键一致性：`lowDeferFromRound`**：产生处 `scripts/model-review/review-models.json:7` 为 `3`；校验处 `opencode-review.mjs:81` 要求安全整数且 `>= 2`；使用处 `:1648`、`:1805`、`:1881` 都按整数比较；测试 `opencode-review.test.mjs:517`、`:549-551` 覆盖 `undefined`、`1`、`"3"`。
- **文档与代码一致**：`.agents/instructions/model-review.md:61`、`:64`、`:197` 与 `model-review-card.md:33`、`:38`、`:42` 对 `--judge-skeleton`、`--finish-round`、`lowDeferFromRound`、`REVIEW_TIMING`、`GATEWAY_REST` 的描述与代码一致；`delegate.mjs:165` 也已要求转述新增两行。
- **合并残留**：全仓库 grep 未发现 `<<<<<<<`/`=======`/`>>>>>>>`，也没有 `*.orig`/`*.rej`。两个父提交与合并结果的差异正好是各自一侧的改动：相对 `73d2070` 是 main 的改动，相对 `61984fb` 是 PR 的改动；两边都改过的只有 `test/tooling/opencode-review.test.mjs`，合并结果是两边的并集。

## 读代码证实的

- `git diff b3519e0cb..779ef1b -- scripts/model-review` 为空，PR 的 `scripts/model-review/` 代码没有变化。
- PR 侧增量提交 `6f2152627`、`73d2070` 只改 `.agents/reviews/pr-481/`。
- 合并后 `test/tooling/opencode-review.test.mjs` 同时包含：
  - main 的 `firstChangedMessage` import 与 `append-only failure message` 用例（`:84`、`:1990-2015`）；
  - 本 PR 的 `lowDeferFromRound: 3`（`:517`）和三个反向用例（`:549-551`）。
- `reviewModelsProblems` 现在要求 `lowDeferFromRound`，而合并后的 `valid` 对象已带上 `3`；`review-models.json` 也带 `3`，因此 main 新用例和本 PR 用例不会互相拆台。
- main 新用例的期望 `first difference at character 5026` 与 `firstChangedMessage` 的 `JSON.stringify` 前缀长度一致（前缀 26 字符 + 5000 个 `x`）。

## 推测 / 未核实

- **未运行测试**：以上“测试会通过/反向用例会失败”的结论来自读代码和测试断言，没有实际执行 `vitest`。
- **未检查二进制复核记录内容**：`.agents/reviews/pr-481/round-5/*` 被 git 当二进制处理，只确认了增量范围，没有逐字核对其中是否含敏感信息；脚本自身的 `recordSecretProblems` 会在 `--assert-reviewed` 时检查。
- 没有发现需要报告的其它错误路径、资源耗尽或安全问题；以上第 1 条只是作者说法与代码的不精确对应，不是代码缺陷。

## 必答问题

1. **不会改变模型已经见过的请求开头。** 本轮增量只改测试、测试夹具和复核记录，没有改生产提示词、工具定义、历史或遮盖。PR 之前的提示词文字改动是静态字符串，每轮的 `head`/`base`/`previous`/`brief` 仍放在 `buildPrompt` 的末尾材料段，工具循环和收尾仍是追加消息；没有把每轮变化的值放进系统提示或工具定义。依据规则第 2、4 条，仍然满足“只在末尾追加、会变的值在最后一条消息里”。
2. **不会让同一段文字在不同请求里变成不同字节。** 新增输出中，`readGatewayRests` 明确排序并做确定性清洗；`gatewayTiming`、`deferredLowLines`、`finishRound` 都按输入顺序或轮次排序处理。`selfCheckMs`、`runMs`、`gatewayTiming` 会随运行变化，但它们只进账本和控制台，不进入发给模型的内容；`--report` 也不含这些行。
3. **有对应的自动检查，反向用例在代码上确实会触发失败。** 相关测试在 `test/tooling/opencode-review.test.mjs`（`lowDeferFromRound` 的 `undefined`/`1`/`"3"`）、`test/tooling/review-round-tools.test.mjs`（`FINISH_ROUND_REFUSED`、`JUDGE_SKELETON_EXISTS`、`JUDGE_SKELETON_NONE`、未提交 verdicts、base-invalid、多余参数）、`test/tooling/review-gateway.test.mjs`（失败请求/缺 session、坏 JSON/非 map/EISDIR、控制字符清洗）。我读代码核对了断言与实现，未实际运行。
4. **改动产生或修改的值，两端校验能对上。**
   - `lowDeferFromRound`：产生处 `review-models.json:7` 为 `3`；校验处 `opencode-review.mjs:81` 要求安全整数且 `>=2`；使用处 `:1648`、`:1805`、`:1881` 都按整数比较，测试覆盖非法值。
   - 账本新字段 `selfCheckMs`、`runMs`、`gatewayTiming`：产生处 `opencode-review.mjs:3593-3595`；`parseUsage` 不拒绝未知字段，`ledgerLine` 的遮盖对数字无影响，`timingLine` 用 `Number.isFinite` 兜底，旧记录没有这些字段也能打印 `-`。
   - `REVIEW_TIMING`、`GATEWAY_REST`：产生处 `opencode-review.mjs:3212`、`:3661`；使用端是 `delegate.mjs:165` 的汇报要求，没有会拒绝这两行的解析器；`--report` 不含它们，与文档一致。
   - `verdicts.jsonl` 草稿的 `valid:null`/`class:null`：`judgeSkeleton` 产生后不能直接通过 `parseVerdicts`，必须先人工填写；这是设计上的强制步骤，`finishRound` 和测试都按这个约定处理。未发现两端校验不一致。
