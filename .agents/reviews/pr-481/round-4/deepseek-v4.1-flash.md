本轮复核范围：`git diff d9609ae32..65bd5eb10` 的全部增量（`scripts/model-review/opencode-review.mjs`、`test/tooling/review-round-tools.test.mjs`、`.agents/instructions/model-review.md`），并跟到 `finishRound`、`deferredLowLines`、`reviewReport`、`parseUsage`、`resolveCommits`、`buildPrompt`、`delegate.mjs` 的 base 校验，以及 merge-gate 测试里调用 `reviewReport` 的用例。`.agents/reviews/` 下的实际账本和 round-3 判断文件被仓库的 records-path 保护挡住，无法读取，相关作者说法标「未核实」。

### 1. 低：「列不出」说明行可能出现在并非低意见未修的轮次，措辞会误导
文件:行：`scripts/model-review/opencode-review.mjs:1651-1657`

问题：新逻辑对账本里所有 `mode === "code-review"` 且 `round >= 3` 的轮次检查 `verdicts.jsonl`，只要文件不在 HEAD 就打印「列不出这一轮的低意见」。它无法区分这一轮是「只剩低意见、被 defer」还是「有中高意见但记录没提交」或「本轮模型没跑完」。例如 `--stop run-failed` 时最新一轮本来就没有 verdicts，报告仍会新开「低严重度未修」一节，说这一轮的低意见列不出。

证据（读代码证实）：
```js
1643  const rounds = [...new Set(records.filter((record) => record.mode === "code-review")
1647        .map((record) => record.round ?? 1)
1648        .filter((round) => round >= LOW_DEFER_FROM_ROUND))].sort((a, b) => a - b);
1652  if (records.some((record) => record.mode === "low-fix" && record.round === round)) continue;
1654  const text = showAt(repo, "HEAD", path);
1655  if (text === null) {
1656    lines.push(`  第 ${round} 轮 verdicts.jsonl 没有提交，列不出这一轮的低意见`);
```
这里没有任何「这一轮是否真的是 low-deferred 轮」的判断。文档 `.agents/instructions/model-review.md:64` 也写成「某一轮的 verdicts.jsonl 没有提交时」就打印，和代码一致，但和这一节标题「低严重度未修」不完全一致。

建议：把措辞改成「第 N 轮 verdicts.jsonl 没有提交，无法确认这一轮有没有未修低意见」，或只对复核链上已完成的轮次（可传入 `gate.accepted` 的轮次集合）打印；同时补一个 `--stop run-failed` 或「已提交但含中高意见的轮次」不出现该行的用例。

### 2. 低：`finishRound` 只校验 `records[0].base`，多模型轮次的其余 base 不校验也不比对
文件:行：`scripts/model-review/opencode-review.mjs:1770`、`1794`、`1803`

问题：base 校验只看第一条 ok 的 code-review 记录。多模型轮次里如果第二条记录的 `base` 缺失或不同，`--finish-round` 不会报任何问题。NEXT 命令只使用 `records[0].base`，所以当前的 shell 注入路径确实被堵住了，但「账本里这一轮的 base」这个说法没有覆盖整轮记录，记录不一致会被静默接受。

证据（读代码证实）：
```js
1770  if (!COMMIT_PATTERN.test(records[0].base ?? "")) problems.push("base-invalid");
1794  const record = records[0];
1803  ... `--base ${record.base} ... --previous ${reviewed} ...`
```
`parseUsage` 对 `head` 有 `COMMIT_PATTERN` 校验（`1950-1952`），对 `gateway` 有枚举校验（`1979-1985`），唯独 `base` 在 parseUsage 里没有校验，这是本条检查只覆盖单条记录的原因。

建议：至少遍历 `records`，要求每条的 `base` 都是提交哈希且彼此相同；这样多模型、替补、手工 `--round` 补跑的账本都能明确通过或明确拒绝。补一个多模型 + `low-fix` 记录但 base 合法的正向用例，防止将来误拒。

### 3. 低：反向用例覆盖了修复本身，但没有覆盖「不该出现」的组合
文件:行：`test/tooling/review-round-tools.test.mjs:186-223`

问题：新增的两个负向用例能证明修复生效（无效 base 会拒绝；非连续轮次不再从 3 循环到 `latest`），但没有断言「已提交 verdicts 且含中高意见的轮次不打印任何低意见行」，也没有多模型 + `low-fix` 账本的正向 base 用例。第 186 行用例只创建了 round-3 目录、完全没创建 verdicts 文件，没覆盖「工作区有但未提交」这一分支；`Date.now()` 计时断言也很弱。

证据（读代码证实）：
```js
187  const { repo } = fixture(LOW_DEFER_FROM_ROUND);   // 没有 verdicts 文件
198  records: [
199    { mode: "code-review", round: LOW_DEFER_FROM_ROUND },
200    { mode: "code-review", round: Number.MAX_SAFE_INTEGER },
213  it("... finishing refuses a ledger base that is not a commit", () => {
214    for (const bad of ["main; touch pwned", undefined]) {
215      const { repo, dir } = fixture(1, [high], { base: bad });
```
建议：补三类用例：多模型两条 code-review + 一条 low-fix 且 base 合法时 `finishRound` 不拒绝；round>=3 的 verdicts 已提交且含 `medium-high` 时 `deferredLowLines` 返回 `[]`；工作区有 verdicts 但 HEAD 没有时打印说明行。

**侧重检查**

- 错误路径：`base-invalid` 在写 `judgments.md` 之前抛出（`1770-1771` 早于 `1793`），无效 base 不会留下半成品；测试也断言 `judgments.md` 不存在。读代码证实。
- 不可信输入 / 注入：NEXT 命令里只有 `base` 是原来未校验的 shell 拼接值；`head` 由 `parseUsage` 的 `COMMIT_PATTERN` 校验（`1950-1952`），`gateway` 由 `GATEWAYS` 枚举校验（`1979-1985`），`pr` 来自命令行。`COMMIT_PATTERN` 是 40/64 位十六进制并带 `^...$`，且 `parseUsage` 的 `singleLine` 会拒绝含换行的整条记录（`1986`），头部命令注入路径已关闭。读代码证实。
- 资源耗尽：旧实现 `for (round = LOW_DEFER_FROM_ROUND; round <= latest; round++)` 在账本出现超大 `round` 时会做海量 `git show`；新实现只遍历实际去重后的轮次并排序，`Number.MAX_SAFE_INTEGER` 的用例能覆盖这个退化。读代码证实；但轮次数本身没有上限，属于账本可写者可控的既有问题，不是本增量新增。
- 规则/文档与代码一致：`model-review.md:61` 对 `base-invalid` 的描述与代码一致；`model-review.md:64` 的「没有提交就打印」与代码一致，但与「低严重度未修」的语义有上述偏差。读代码证实。
- 未核实：round-3 `judgments.md` 的「意见 1、3、4」具体内容、PR-481 实际账本里的 base/轮次取值，均因 records-path 保护无法读取。

**必答问题**

1. 不会改变请求开头。增量没有改 `buildPrompt`（`opencode-review.mjs:349-378`）；发给模型的内容仍是固定说明在前、`head/base/previous/brief` 等本轮材料追加在后。`--finish-round`/`--report` 只改线程侧输出和下一轮命令，不进入本次模型请求。逐轮变化的值仍都在最后一段材料里，符合 append-only 要求。
2. 不会。新代码唯一的集合（轮次）先去重再按数字排序（`1643-1650`），说明行是固定文字加已校验的整数轮次，没有时间、随机数或对象遍历顺序；同一输入每次字节相同。
3. 有。`test/tooling/review-round-tools.test.mjs:186-223` 覆盖「只走账本轮次 + 缺失说明」和「base 非提交哈希拒绝」；无效 base 的用例在修复前会真的失败（会生成 judgments 和带注入内容的 NEXT），超大轮次用例在旧循环下会超时/失败。不足见意见 3。
4. 逐个核对过：`base` 产生于 `opencode-review.mjs:3581`（`resolveCommits` 的 `rev-parse` 完整哈希），校验于 `1770`，使用于 `1803` 的 NEXT 和 `delegate.mjs:318` 的比对，两端都接受 40/64 位哈希；`round` 由账本产生、经 `parseUsage:1939` 校验为正安全整数，用于路径和文案；新错误码 `base-invalid` 只拼进 `FINISH_ROUND_REFUSED`，没有下游解析依赖，文档已登记。报告新说明行有对应测试匹配。未发现使用端拒收的情况。
