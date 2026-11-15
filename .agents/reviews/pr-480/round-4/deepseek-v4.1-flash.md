## 复核范围

- 查看了 `eee148ab3..108e8c603`（PR 480 自身的净改动，`opencode-review.mjs` 只有 147 行变化）和 `6482fbf..108e8c603`（按要求看的增量，其中大量是 main 合入的 `deferredLowLines`、`judgeSkeleton`、`finishRound`、timing 等，不是本 PR 的 `previousProblem`）。
- 重点读了 `scripts/model-review/opencode-review.mjs` 的 `lowFixChecker`、`previousProblem`、`walkChain`、`assertReviewed`、`main`、`resolveCommits`，以及 `test/tooling/opencode-review-merge-gate.test.mjs` 的 `[I-98]` 用例、`.agents/instructions/model-review.md`、`docs/lessons.md`、`docs/incidents-and-gates.md`、`scripts/check-incident-gates.mjs`。
- `.agents/reviews/pr-480/*` 里的模型答案和账本未能读取：仓库的 git 钩子以 `REVIEW_GIT_REFUSED records-path` 拒绝了这些路径。这部分未核实。

## 意见

### 1｜中｜`--previous` 解析失败时被静默当成“没传”，开跑前检查会放行全量复核并花钱

- 文件：`scripts/model-review/opencode-review.mjs:2850`、`:1416`、`:3560`
- 问题：`resolveCommits` 对解析不到的 ref 返回 `undefined`，与“用户没有传 `--previous`”无法区分；`previousProblem` 看到 falsy 就直接放行。于是拼错或写了一个不存在的哈希时，不会以 `REVIEW_PREVIOUS_REFUSED` 拒绝，而是按“没有 previous”整份复核并花钱，账本还会记下 `previous: null`（`:3676`），丢掉原本想接的链。这正好是 I-98 想防的“白花复核费用”，只是输入从“存在但接不上”换成了“解析不到”。
- 证据：
  ```js
  const resolveOne = (ref) =>
    ref ? git(["rev-parse", "--verify", "--quiet", `${ref}^{commit}`], repo) : undefined;
  return { head: resolveOne(head), base: resolveOne(base), previous: resolveOne(previous) };
  ```
  ```js
  const joins = (given) => {
    if (!given) return null;
  ```
  ```js
  previous: commits.previous ?? null,
  ```
- 建议：在 `parseArgs` 或 `resolveCommits` 保留“传了但解析失败”的状态，用 `COMMIT_PATTERN`/显式错误拒绝，例如 `REVIEW_PREVIOUS_REFUSED ... use=no-previous`；至少不要静默退化成全量复核。补一条 `--previous not-a-hash` 的入口测试。
- 证实：`resolveOne` 确实把非法 ref 变成 `undefined`，`previousProblem` 确实把 `undefined` 当没传。
- 推测：按 `main()` 后续流程会继续构建提示词、进入复核并产生费用；未实际运行。

### 2｜低｜同轮记录本身的 `previous` 接不上链时，不会提示 `use=new-round`

- 文件：`scripts/model-review/opencode-review.mjs:1445`、`:1425`；文档：`.agents/instructions/model-review.md:62`
- 问题：`use=new-round` 只在“用户这次传的 `previous` 与同轮已有结果不同”时给出。如果用户传的正是同轮记录里的那个 `previous`，会跳过 `round-previous-differs` 分支，走普通 `joins(previous)`；该 `previous` 已接不上链时，返回的是 `chain-already-broken ... use=no-previous` 或 `chain-broken ... use=--previous <covered>`，而不是 `new-round`。文档说“这一轮已有结果接不上复核链就提示 `new-round`”，在这种情况下并不成立，用户按 `use=` 仍用同一 `--round` 重试会再被拒一次。
- 证据：
  ```js
  if (sameRound.length > 0 && sameRound.some((recorded) => recorded !== (previous ?? null))) {
    const [recorded] = sameRound;
    const use = sameRound.length > 1 || joins(recorded) ? "new-round" : ...;
    return `REVIEW_PREVIOUS_REFUSED round-previous-differs round=${round} use=${use}`;
  }
  const problem = joins(previous);
  return problem ? `REVIEW_PREVIOUS_REFUSED ${problem}` : null;
  ```
  ```js
  if (broken && broken.point !== next)
    return `chain-already-broken round=${broken.point.round} ${broken.point.head} ${broken.problems.join(",")} use=no-previous`;
  ```
  现有测试只覆盖了 `f.ask(undefined, { records: stuck })`，没有覆盖 `f.ask(f.fixed, { records: stuck })`（`test/tooling/opencode-review-merge-gate.test.mjs:1681-1685`）。
- 建议：当 `sameRound` 已包含 `(previous ?? null)` 且 `joins(previous)` 失败时，也把 `use=new-round` 加进提示；同时补上“传同轮记录的那个 previous 但其本身接不上链”的断言。
- 证实：代码路径如上；测试确实缺少这一分支。
- 推测：实际输出需要运行才能逐字确认；按 `walkChain` 和 `joins` 的代码推断为 `chain-already-broken ... use=no-previous`。

### 3｜低｜“惰性 skip 只算一次、所有 low-fix 点同一份清单”没有自动检查

- 文件：`scripts/model-review/opencode-review.mjs:3542-3555`；测试：`test/tooling/opencode-review-merge-gate.test.mjs:1708-1760`
- 问题：实现本身是正确的（`??=` 只算一次，`head` 固定为 `commits.head`，多个 low-fix 点拿到的都是同一个 Set），但现有入口用例只覆盖“工作区账本里有一个不合格 low-fix”的情况，没有断言调用次数，也没有放两个 low-fix 点比较清单。把 `skip()` 改成每个文件/每个点重新计算仍然会通过现有测试，作者声称的“只算一次”缺少反向用例支撑。
- 证据：
  ```js
  let claimsOwned;
  const skip = () => {
    claimsOwned ??= new Set(
      claimsProblems({
        repo: options.repo,
        head: commits.head,
        ...
      }).files,
    );
    return claimsOwned;
  };
  ```
- 建议：给 `claimsProblems` 做可注入包装或用 spy 计数；或构造两个 low-fix 点的账本，断言两次核对使用的是同一个/同一份清单。
- 证实：代码确实做了 memoization；测试文件里没有针对这点的计数或 spy。
- 推测：无（这里是测试缺口，不是运行结果推测）。

### 4｜低｜作者给的复核基线与提交历史不一致，描述的三项改动已在 `6482fbf` 之前

- 文件/提交：`scripts/model-review/opencode-review.mjs:1415`；提交 `db81144f3`、`674eafb43`、`18bd39f19`、`6482fbf`
- 问题：作者说“第 3 轮只看 `aef6e5cc..HEAD` 的增量”，但按任务给的上一轮 `6482fbf`，`git log --oneline --ancestry-path aef6e5cc..6482fbf` 显示 `db81144f3`（`previousProblem`/`ROUND_PREVIOUS_REFUSED`）、`674eafb43`（惰性 skip）、`18bd39f19`（`use=new-round` 文档和 split 测试）都在 `6482fbf` 之前；`git diff 6482fbf..HEAD -- scripts/model-review/opencode-review.mjs` 不再包含 `previousProblem`/`joins`/惰性 skip 这些逻辑。本 PR 的净改动其实是 `eee148ab3..HEAD`。如果本轮以 `6482fbf` 为基线，作者描述的三项改动属于上一轮已复核内容，本轮新增的主要是 main 合并和记录。
- 证据：上述 `git log --ancestry-path` 输出，以及 `git diff --stat eee148ab3..HEAD` 只涉及 `opencode-review.mjs`、`model-review.md`、`incidents-and-gates.md` 和测试；`git diff 6482fbf..HEAD` 中 `opencode-review.mjs` 的 `previousProblem` 没有变化。
- 建议：更正复核基线和轮次表述，明确本轮是看 `6482fbf..HEAD` 还是 PR 净改动 `eee148ab3..HEAD`，避免重复复核上一轮内容或把 main 合并误当成本 PR 改动。
- 证实：提交历史和 diff 均来自 `git log`/`git diff` 实际输出。
- 推测：无。

## 侧重检查

- 错误路径和不可信输入：查了 `--previous` 的解析、同轮 `previous` 比较、坏账本、`REVIEW_ROUND_HEADS_DIFFER`。发现意见 1（非法 ref 静默放行）和意见 2（同轮提示不完整）；坏账本会在开跑前抛错，未发现花钱路径。
- 费用/资源耗尽：`previousProblem` 在 `opencodeBinary()`、建副本和起模型之前执行；`lowFixCheck` 只在 `walkChain` 真正走到 low-fix 点时调用，`claimsProblems` 只在此时惰性计算且 memoize。代码路径上符合“不真重核 low-fix 就不算清单、只算一次”。
- 安全：新错误串里的文件名/编号走 `printable`，没有新增把模型输出、密钥写进模型请求的路径；`--previous` 的 git ref 拼接沿用既有 `resolveCommits`，不是本次新引入。
- 不可逆操作：开跑前检查只读账本和 git 对象；`low-fix`/`override` 的账本写入仍在 `assertReviewed` 里，未提前执行。
- 规则与文档一致性：`I-98` 行在 `docs/incidents-and-gates.md:134`，`check-incident-gates.mjs` 要求的编号、日期、次数（3）、状态（已落门槛）和门槛路径（`scripts/model-review/opencode-review.mjs`、`test/tooling/opencode-review-merge-gate.test.mjs`）都能通过代码校验；`model-review.md` 和 `lessons.md` 的 `use=` 说明基本一致，但意见 2 那个分支的措辞过于绝对。
- 请求开头/缓存：本 PR 没有改 `packages/prompt-catalog`、工具定义、历史消息或产品请求组装；复核脚本的 opencode 会话只在同一次运行的收尾阶段复用 `--session`（`opencode-review.mjs:835-842`、`:1061-1111`），不同复核轮次是独立调用，不涉及“已发内容只追加”的问题。

## 必答问题

1. **会不会改变模型已经见过的请求开头？** 不会。这个 PR 的净改动只在复核脚本、复核说明、事故清单和测试；没有动产品系统提示、工具定义、历史消息、遮盖结果或输出序列化。`buildPrompt` 本身不在 `eee148ab3..HEAD` 的改动里。复核脚本每轮是独立的 opencode 调用，不是同一会话里改写前缀；改 `model-review.md` 只影响新的复核提示，不涉及产品对话已发内容。每轮会变的 `--previous` 等值仍在复核用的用户提示里，不在系统提示或工具定义里。
2. **会不会让同一段文字在不同请求里变成不同字节？** 不会。新增的 `use=` 字符串只出现在 stderr/测试断言里；`sameList` 对数组排序后比较，`Set` 只用于判断；惰性 `skip` 固定在 `commits.head` 上计算，同一进程内所有 low-fix 点拿到同一份 Set。没有新增时间字段、随机值或依赖遍历顺序的模型输入。账本里的 `at` 时间戳是原有格式。
3. **有没有对应的自动检查，反向用例会失败吗？** 有 5 条 `[I-98]` 用例加一条脚本入口用例。按断言推导：去掉 `previousProblem` 判断，函数用例失败；只去掉 `main()` 调用，入口用例会跑到自检而不是以退出码 2 停下并失败；把 low-fix 重核换成直接信任，工作区不合格 low-fix 的入口断言失败；去掉同轮 `previous` 比较或 `sameRound.length > 1` 条件，对应的 `round-previous-differs` 断言失败。我没有运行测试（工具只允许读文件和 git 命令），实际执行结果**未核实**；另外“惰性 skip 只算一次”没有专门的反向用例，见意见 3。
4. **每个产生/修改的值，使用端都能接受吗？** 逐项核对：
   - `use=new-round`、`use=no-previous`、`use=--previous <hash>`：只被 `model-review.md`、`lessons.md`、`incidents-and-gates.md` 和测试精确匹配使用，没有其他脚本解析；测试字符串与代码一致。
   - `previousProblem`、`lowFixChecker` 新导出：`main()` 和测试导入，参数签名一致；`lowFixChecker` 的 `skip` 两处调用都是 `Set`（`assertReviewed` 传 `claimsOwned`，`main` 传 `skip()`）。
   - `I-98` 清单项：`check-incident-gates.mjs` 的编号、日期、次数、状态、门槛路径检查都能通过；`docs/lessons.md` 和测试名引用它，没有其他解析端。
   - 账本 `previous` 字段：由 `commits.previous ?? null` 写入，`assertReviewed`/`previousProblem` 读取；非法 ref 会在写入前退化成 `null`，见意见 1。
   - 退出码：`previousProblem` 抛错走 `main().catch` 的退出码 2，和 I-98 文档一致；`--assert-reviewed` 的 5 是另一条路径，没有混用。
