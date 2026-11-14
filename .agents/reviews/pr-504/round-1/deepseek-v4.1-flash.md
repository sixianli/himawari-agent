## 结论

未发现会改变是否拒绝、或改变发给模型内容的中/高严重度缺陷。改动的核心逻辑（`sameRound` 非空且 `joins(previous)` 报错时把提示换成 `use=new-round`）与现有文档一致；以下三条均为低严重度问题，集中在测试稳健性、实现方式和可达性说明。

### 1. 低：新增断言用宽松正则，未锁定原因、轮次和提交

- 文件:行：`test/tooling/opencode-review-merge-gate.test.mjs:1809`
- 问题：新用例只检查“以 `chain-already-broken` 开头、以 `use=new-round` 结尾”，中间的轮次、broken 点和具体原因都被 `.*` 吞掉；本次改动真正区分的是“原因原样保留、只换建议”，这条断言抓不到原因被意外改写。
- 证据（读代码证实）：
  ```js
  expect(f.ask(f.fixed, { records: stuck })).toMatch(
    /^REVIEW_PREVIOUS_REFUSED chain-already-broken .* use=new-round$/,
  );
  ```
  相邻用例（1806、1813）都用精确字符串：
  ```js
  expect(f.ask(f.fixed, { records: split })).toBe(
    "REVIEW_PREVIOUS_REFUSED round-previous-differs round=2 use=new-round",
  );
  ```
- 建议：改成精确断言，例如预期
  `REVIEW_PREVIOUS_REFUSED chain-already-broken round=1 ${f.fixed} findings-differ use=new-round`。
- 推测：`.*` 也不会匹配换行，但当前字符串无换行，不构成实际失败。

### 2. 低：用正则剥掉 ` use=...` 生成建议，耦合消息格式

- 文件:行：`scripts/model-review/opencode-review.mjs:1525`
- 问题：提示文本靠 `problem.replace(/ use=.*$/, ...)` 反推，假定“第一个 ` use=` 就是末尾的建议”。当前四条 `joins` 返回值都满足这个假定，但将来若在原因里加入带 ` use=` 的字段，或被错误值污染，提示会被截断。
- 证据（读代码证实）：四个返回都以 `use=` 结尾：
  ```js
  return `chain-already-broken ... use=no-previous`;
  if (!covered) return "no-accepted-round use=no-previous";
  return `head-not-after-accepted ${covered} head=${head} use=no-previous`;
  return `chain-broken previous=${given} use=--previous ${covered}`;
  ```
  新代码：
  ```js
  const advice = sameRound.length > 0 ? problem.replace(/ use=.*$/, " use=new-round") : problem;
  ```
- 建议：让 `joins` 返回结构化结果（例如 `{ reason, use }`），或给 `joins` 传一个 `sameRound` 标志，在拼字符串时就选 `use`，不要事后做正则替换。
- 读代码证实：本改动涉及的 `previous` 经 `git rev-parse` 解析为哈希，账本里 `head` 也经 `COMMIT_PATTERN` 校验（`opencode-review.mjs:2029`、`2091`），因此当前不会有人为 ` use=` 注入路径。

### 3. 低：新增用例未经过 `roundForRun`，同模型重跑时实际会先被别的错误拦住

- 文件:行：`scripts/model-review/opencode-review.mjs:2177`、`3760`、`3788`；`test/tooling/opencode-review-merge-gate.test.mjs:1809`
- 问题：新断言直接调用 `previousProblem`，而真实入口里先跑 `roundForRun`。如果同一轮已有同一模型的 `ok` 结果，`roundForRun` 会先抛 `ROUND_ALREADY_HAS_RESULT`，根本走不到这条新提示。新增用例的“同轮 deepseek 已有结果”场景在 CLI 上只在换模型重跑时可达（例如主模型失败、已有替补 `ok` 记录，再补跑主模型）。
- 证据（读代码证实）：
  ```js
  for (const model of models) {
    if (inRound.some((record) => record.model === model && record.outcome === "ok"))
      throw new Error(`ROUND_ALREADY_HAS_RESULT ${requested} ${model}`);
  }
  ```
  而 `previousProblem` 在之后才调用：
  ```js
  const round = ... roundForRun({...});
  ...
  const refused = previousProblem({...});
  ```
- 建议：补一条入口级用例，用“替补已 `ok` + 主模型失败”的账本跑 `--round`，确认能看到 `use=new-round`；或在用例名/注释里写明这是函数级契约，不等于同一模型重跑。
- 推测：作者描述的是函数级行为，未必声称同模型 CLI 可达，因此这更像测试覆盖说明问题，而不是逻辑错误。

## 侧重检查

- 错误路径（读代码证实）：`previousProblem` 的四个 `joins` 失败分支都会进入替换；`sameRound` 非空的判定在 `1513` 行之后等价于“已有结果的 `previous` 就等于本次 `--previous`”，因此新建议只覆盖“同一轮结果自身接不上链”的路径，没有误伤 `sameRound` 为空时的 `use=no-previous` / `use=--previous <提交>`（1752、1759、1777、1827 行仍有精确断言）。
- 不可信输入（读代码证实）：`--previous` 先经 `resolveCommits` 的 `git rev-parse` 变成哈希；账本记录里参与拼接的 `head` 受 `COMMIT_PATTERN` 校验，low-fix 记录也经 `lowFixChecker` 重核，替换区间不会混入自由文本。没有发现注入、路径拼接或密钥泄漏风险。
- 安全与资源（读代码证实）：改动只对一个短字符串做一次正则替换，无循环放大、无文件写入、无不可撤销操作；错误只经 `main().catch` 打到 stderr（`4047-4049`），不落账本、不进模型请求。
- 规则/文档一致性（读代码证实）：`.agents/instructions/model-review.md:64`、`docs/lessons.md:759`、`docs/incidents-and-gates.md` 的 I-98 已经写成“同轮已有结果接不上链时提示 `use=new-round`”，本次改动是在把代码对齐文档，没有新的文档不一致。
- 可达性（读代码证实 + 推测）：同模型重跑会先被 `ROUND_ALREADY_HAS_RESULT` 拦住；新提示在 CLI 上的可达路径主要是“换模型/替补后补跑”，见意见 3。

## 必答问题

1. **会不会改变模型已经见过的请求开头？** 不会。改动只在 `scripts/model-review/opencode-review.mjs:1523-1526` 修改 `previousProblem` 返回的拒绝提示，既不碰系统提示、工具定义、历史消息，也不碰遮盖；`previousProblem` 在任何模型进程启动前执行（`3788-3800`，早于 `3802` 的 `opencodeBinary`），抛错后不会发请求、不会写账本。发给模型的内容仍然只在末尾追加、每轮变化的值仍只在最后一条消息里，本次改动没有新增任何进入请求的字段。
2. **会不会让同一段文字在不同请求里变成不同字节？** 不会。新增的只是 stderr 里的建议文字；它依赖账本状态，但不进入模型请求、不进入历史、不参与遮盖。没有引入时间、随机数、无序集合或前后文相关的序列化。
3. **有没有对应的自动检查，反向用例会失败吗？** 有。新增断言在 `test/tooling/opencode-review-merge-gate.test.mjs:1809`。按旧代码（`d32a…`）同一场景输出以 `use=no-previous` 结尾，而新正则要求 `use=new-round$`，所以反向确实会失败；同时 1752、1759、1777、1827 行的精确断言会在“`sameRound` 为空时也替换”这种误改下失败。受工具限制我没有运行测试，以上是静态核对。
4. **改动产生或修改的每个值，使用端都能接受吗？** 改动新增的唯一值是字面量 `new-round`（替换后的 `use=new-round`）。全仓库检索 `new-round` / `use=` 只出现在文档、测试和本函数自身，没有任何脚本解析这个字符串做后续动作；调用方只是把返回值 `throw new Error(...)` 打到 stderr，不涉及后端校验或序列化契约。外部若有工具按 `use=` 自动执行命令，未在仓库内体现，属于未核实。
