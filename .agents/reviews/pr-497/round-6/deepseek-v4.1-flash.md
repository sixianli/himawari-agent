本轮复核范围：`ffee6434c`（`837431a..14d4f4d` 的实际代码增量：`merge-queue.mjs` 7 行、测试 15 行、ADR 1 行）；合入 `6cbf37b0b` 的其余差异是 PR 491；我用 `git diff ffee6434c..14d4f4d -- scripts/ci/merge-queue.mjs test/tooling/merge-queue.test.mjs docs/adr/0268-merge-queue-and-related-tests-on-prs.md` 确认这三个本 PR 文件没有被合并改写。跟查了 `reviewChecker` 的调用端、`opencode-review.mjs` 的退出码、`reviewBroken` 状态校验和 tooling 测试归属；没有重读 PR 491 的迁移实现。

### 1. [中] PR 自己提交的复核账本格式错误会以退出码 2 让整个合并队列停下，而不是只移出该 PR
- 文件:行：`scripts/ci/merge-queue.mjs:362`、`:527-536`；`scripts/model-review/opencode-review.mjs:1447-1448`、`:2001-2002`、`:3713-3716`。
- 问题：`--assert-reviewed` 会读取 PR 头提交里的 `.agents/reviews/<key>/usage.jsonl`。任何一行不合规，`parseUsage` 直接抛 `USAGE_LEDGER_INVALID`；`assertReviewed` 没有接住，`main().catch` 把它变成退出码 2。新逻辑把 2 归为 `broken`，于是这一轮 `halt`，连续 3 轮就 `stop` 整个队列。上一轮 `837431a` 的同一行是 `broken: result.status === null`，退出码 2 会落到 `!review.ok` 的 `eject` 分支，只移出这个 PR。账本是 PR 自己可提交的文件，一次格式错误（不必是恶意）就能阻断所有人的合入。
- 证据：
  ```js
  // scripts/ci/merge-queue.mjs:362
  broken: result.status !== 0 && result.status !== reviewNotCoveredExit,
  // scripts/ci/merge-queue.mjs:530-536
  const reviewBroken = state.reviewBroken + 1;
  state = { ...state, reviewBroken };
  if (reviewBroken >= undecidedLimit)
    stop(`复核检查连续 ${reviewBroken} 轮没有正常退出...`);
  return { halt: true };
  // scripts/model-review/opencode-review.mjs:1447-1448
  const shown = gitStatus(["show", `HEAD:${ledgerPath}/usage.jsonl`], repo);
  const records = shown.status === 0 ? parseUsage(shown.stdout, `HEAD:${ledgerPath}`) : null;
  // scripts/model-review/opencode-review.mjs:2001-2002
  throw new Error(`USAGE_LEDGER_INVALID ${path}:${number}`);
  // scripts/model-review/opencode-review.mjs:3713-3716
  main().catch((error) => {
    console.error(error.message);
    process.exitCode = 2;
  });
  ```
- 建议：把可归因于 PR 数据的校验错误（`USAGE_LEDGER_INVALID`、`REVIEW_ROUND_HEADS_DIFFER` 等）在 `opencode-review --assert-reviewed` 里转成退出码 5（或新的专用码），让 merge-queue 走 `eject`；退出码 2 只留给真正的未捕获/基础设施异常。补一条用例：PR 账本放一行非法记录，期望该 PR 被移出、队列继续检查后面的 PR，而不是 `reviewBroken + 1`。

### 2. [低] 反向用例只覆盖 1/2/5，没有覆盖真实会出现的 3/4/130/143；5 的断言在旧代码上不会失败
- 文件:行：`test/tooling/merge-queue.test.mjs:645-662`；`scripts/model-review/opencode-review.mjs:601-603`、`:3519`、`:3670`、`:3688`、`:3700`。
- 问题：`opencode-review.mjs` 超时收到 SIGTERM 时由信号处理器以 143 结束（SIGINT 为 130），不是用例里的 `status === null`；另有自检失败 3、模型未跑完 4。新实现是“任何非 0 非 5 都算 broken”，方向正确，但测试只验证了 1、2、5，没有验证 143/130/3/4。若以后有人把实现改成只认 `null` 或只认 1/2，现有用例仍可能通过，真实超时会被误移出。另外 `verdictFor(5)` 在旧代码上本来就返回 `broken: false`，不是反向用例；旧代码上真正会失败的是 1 和 2 的断言。
- 证据：
  ```js
  // test/tooling/merge-queue.test.mjs:647-662
  const stuck = reviewChecker({ repo: env.repo, script: slow, timeout: 300 })(1, head, main);
  expect(stuck).toMatchObject({ ok: false, broken: true });
  ...
  expect(verdictFor(5)).toMatchObject({ ok: false, broken: false });
  expect(verdictFor(2)).toMatchObject({ ok: false, broken: true });
  expect(verdictFor(1)).toMatchObject({ ok: false, broken: true });
  // scripts/model-review/opencode-review.mjs:601-603
  const code = signal === "SIGINT" ? 130 : 143;
  ```
- 建议：补 `verdictFor(143)`、`verdictFor(130)`、`verdictFor(3)`、`verdictFor(4)`，或用带真实 SIGTERM 处理器的夹具覆盖 143。同步更新 ADR 的验证清单。

### 3. [低] 退出码 5 在生产端和消费端各自硬编码，现有测试用假脚本直接写 5，跨端契约没有自动核对
- 文件:行：`scripts/ci/merge-queue.mjs:18`、`:362`；`scripts/model-review/opencode-review.mjs:3406`；`test/tooling/merge-queue.test.mjs:660`。
- 问题：两端目前数值一致，但 `5` 分别写死在复核脚本和合并队列里，测试也只是让假脚本 `process.exitCode = 5`，没有跑真实的 `opencode-review --assert-reviewed` 覆盖路径。如果复核脚本以后把“没覆盖”改成别的码，或新增一种未覆盖码，merge-queue 会把它当 `broken`、停队列而不是移出，且现有测试不会失败。这就是 I-73 那类“产生端和使用端各自校验”的风险。
- 证据：
  ```js
  // scripts/ci/merge-queue.mjs:18
  export const reviewNotCoveredExit = 5;
  // scripts/model-review/opencode-review.mjs:3406
  process.exitCode = 5;
  // test/tooling/merge-queue.test.mjs:660
  expect(verdictFor(5)).toMatchObject({ ok: false, broken: false });
  ```
- 建议：把退出码定义放到共享模块，或加一条跨端用例：用真实的 `opencode-review --assert-reviewed` 跑一个未复核的 PR，断言它返回 5，再把该结果喂给 merge-queue 的判定。至少让测试直接引用生产端常量，而不是只写数字。

### 4. [低] ADR 验证清单仍只写“复核检查被杀”，没有同步新的“非 0 非 5”触发条件
- 文件:行：`docs/adr/0268-merge-queue-and-related-tests-on-prs.md:103`、`:111`。
- 问题：ADR 第 103 行已补上“退出码既不是 0 也不是 5”，但验证清单第 111 行仍写“复核检查被杀时这一轮不建候选且连续 3 轮就停下”，没有提到新增的退出码条件。它不构成矛盾，但会让读者以为只覆盖超时/信号；作者材料也只提了 5 和 2，漏了 3、4、130、143。
- 证据：
  ```md
  // docs/adr/0268-merge-queue-and-related-tests-on-prs.md:111
  ...复核检查被杀时这一轮不建候选且连续 3 轮就停下...
  ```
- 建议：把第 111 行改成“复核检查没有正常退出（含非 0 非 5 的退出码）时……”，并列出新测试覆盖的退出码。

**读代码证实的**
- 本轮代码增量确实只有 `ffee6434c` 的 `merge-queue.mjs` 7 行、测试 15 行和 ADR 1 行；合入 `6cbf37b0b` 没有改写这三个文件。
- `reviewChecker` 用 `--assert-reviewed` 运行 `opencode-review.mjs`；该模式在 `opencode-review.mjs:3402-3407` 读完复核记录后直接 `return`，发生在网关/模型初始化之前，所以这条路径不向模型发请求。
- `opencode-review.mjs` 实际使用 0（成功）、5（复核问题）、2（未捕获异常，`:3716`）、3（自检失败，`:3519`）、4（模型未跑完/claims 解析失败，`:3670`、`:3688`、`:3700`）、130/143（SIGINT/SIGTERM，`:601-603`）。作者说的 5 和 2 属实，但不完整。
- 上一轮代码是 `broken: result.status === null`；新的 1/2 断言在旧代码上确实会失败；5 的断言在旧代码上本来就会通过。
- `reviewBroken` 在 `merge-queue.mjs:530-531` 递增、`:532` 达阈值停止、`:538` 正常退出清零，`validateState` 在 `:55-58` 接受非负整数，`resume` 在 `:613` 清零；这些消费端都能接受新行为。
- `test/tooling/merge-queue.test.mjs` 属于 `ci/policy.json:213-214` 的 tooling project，有自动检查。
- ADR 第 103 行的文字与代码一致；第 111 行确实没同步。

**推测**
- 一个 PR 能否实际触发第 1 条，取决于谁能推提交、拿到 `merge-queue` 标签并让 `ci/required` 通过；项目前提是 PR 由本项目线程写，所以恶意的可能性较低，但误写坏账本同样会触发，而旧行为能把故障隔离在该 PR。
- 第 3 条的“持续漂移”是维护风险，不是当前行为错误；两端今天都是 5。
- 合并进来的 `AGENTS.md` / `.agents/instructions/migrations.md` 是否进入某个客户端（而非 Himawari 运行时）的系统提示，我未核实；即使进入，已发起的对话按 ADR 0165 使用冻结的系统提示，本 PR 的代码也没有改提示词组装。

**侧重检查**
- 错误路径：逐条核对了 0/2/3/4/5/130/143 的归类；发现 2（以及 PR 数据触发的 2）被归为基础设施故障，见第 1 条；3/4/130/143 没有反向用例，见第 2 条。
- 不合规范或不可信输入：PR 可提交的 `.agents/reviews/.../usage.jsonl` 会被 `parseUsage` 校验并抛错，这是第 1 条的直接入口；未发现这次改动新增其他执行 PR 代码的路径。
- 安全：`reviewChecker` 运行的是 main 检出的 `opencode-review.mjs`，不是 PR 里的脚本；`spawnSync` 不经 shell；没有新增秘密读取或日志输出。新增的可用性风险就是第 1 条的“停止整个队列”。
- 资源耗尽：`reviewTimeoutMs`、`maxBuffer` 没有变；review 检查按 PR 串行；`reviewBroken` 到 3 就停止，不会无限重跑。但一个持续触发退出码 2 的 PR 在人工 `resume` 后会再次停队列。
- 不可撤销操作：本增量没有新增删除、合并或写生产数据的操作；`eject`/`halt` 都只是改标签和状态，可人工恢复。
- 规则/文档一致性：ADR 第 103 行与代码一致；第 111 行过期；`prompt-prefix.md` 的只追加要求不适用于这条 CI 路径，因为该路径不构造模型请求。

**必答问题**
1. 不会改变模型已经见过的请求开头。改动只决定合并队列是否建候选；`reviewChecker` 调用的 `--assert-reviewed` 模式在 `opencode-review.mjs:3402-3407` 直接返回，不发模型请求，也没有改系统提示、工具定义、历史消息或遮盖代码。合入的 PR 491 没有改 `packages/prompt-catalog` 等提示词组装文件。因此“只在末尾追加”和“每轮会变的值都在最后一条消息里”没有被这条改动触碰；现有对话的系统提示仍按冻结规则不变。
2. 不会让同一段文字在不同请求里变成不同字节，因为这条路径不产生模型请求。新增的 `reviewNotCoveredExit`、`broken`、`reviewBroken` 只用于 CI 控制流；状态里的 `stopped.at` 是时间戳，只写入状态分支和日志，不进入模型请求。PR 491 的时间戳迁移编号也在迁移层，未发现进入模型请求。
3. 有自动检查：`test/tooling/merge-queue.test.mjs` 在 tooling project 中运行。反向用例方面，退出码 2 和 1 的断言在上一轮代码上会失败；退出码 5 的断言在旧代码上本来就会通过，属于回归保护，不是反向用例。缺口是 3/4/130/143 和“PR 账本坏掉导致退出码 2”没有用例，见第 1、2 条。
4. 逐个核对了值：`reviewNotCoveredExit = 5` 产生于 `merge-queue.mjs:18`，只被 `:362` 消费，数值上接受；`broken` 产生于 `:362`，只被 `:527` 消费，接受布尔值；`reviewBroken` 在 `:530-531` 产生，被 `:532`、`:538`、`validateState` 和 `resume` 消费，接受非负整数；`stopped.reason` 被状态校验和摘要消费。两端目前都接受，但 5 是两边各自硬编码、测试用假脚本，跨端契约没有自动核对；3/4/130/143 的消费端接受，语义变更没有全部测试，见第 2、3 条。
