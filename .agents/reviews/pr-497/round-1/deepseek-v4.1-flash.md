### 1、中高：完整 CI 的静态检查脚本不在保护范围，PR 可以让候选的 `npm run check` 变成空操作

- 文件:行：`scripts/ci/merge-queue.mjs:11`；`scripts/ci/run.mjs:269`；`package.json:26`；`scripts/ci/main-evidence.mjs:102-113`
- 问题：队列只把 `.github`、`ci`、`scripts/ci` 当作“改 CI 自身文件”。但候选完整 CI 的 static 作业执行的是候选树里的 `npm run check`，而 `check` 指向根目录的 `scripts/run-all-checks.mjs`；`package.json` 和这个脚本都不在保护范围。PR 可以把 `scripts/run-all-checks.mjs` 改成直接退出 0，PR 自己的 `ci/required` 和队列候选的完整 CI 都会用改过的检查脚本，仍然变绿。手动合并时 `main-evidence.pushIdentity` 也只看同样的三个目录，不会退回 full。
- 证据：
  ```js
  // scripts/ci/merge-queue.mjs:11
  export const protectedPaths = [".github", "ci", "scripts/ci"];
  ```
  ```js
  // scripts/ci/run.mjs:269
  await command("check", tools.node, [tools.npmCli, "run", "check"]);
  ```
  ```json
  // package.json:26
  "check": "node scripts/run-all-checks.mjs",
  ```
  ```js
  // scripts/ci/main-evidence.mjs:102-113
  !git(root, [
    "diff", "--name-only", event.before, event.after, "--",
    ".github", "ci", "scripts/ci",
  ]),
  ```
- 建议：把 `package.json`、`scripts/run-all-checks.mjs` 及它实际调用的检查脚本纳入队列拒收范围，或在 `main-evidence` 里同样把它们算作“CI 自身文件”；另一个方向是完整 CI 的检查编排从 main 读取，只把 PR 内容当数据。补反向测试：修改 `scripts/run-all-checks.mjs` 的 PR 必须被队列拒收或退回 full。
- 性质：读代码证实。

### 2、中高：受保护路径检查漏掉“重命名移出”，可以把 CI 文件从保护目录移走而不触发拒收

- 文件:行：`scripts/ci/merge-queue.mjs:104-107`、`:71-75`、`:468`；同类问题在 `scripts/ci/test-scope.mjs:19-26`、`:14-17`
- 问题：`changedFiles` 用 `git diff --name-only -z base...head`，Git 对重命名默认只输出新路径。`touchesProtected` 只检查新路径。PR 用 `git mv scripts/ci/main-confirm.mjs docs/main-confirm.mjs` 时，旧路径不出现，新路径不在保护前缀内，队列会放行。`scripts/ci/main-confirm.mjs`、`scripts/ci/main-evidence.mjs`、`scripts/ci/merge-queue.mjs` 等并不都会被候选 CI 使用，所以其他 job 也不一定拦得住。`test-scope` 同样会把“非源码文件重命名成源码/文档路径”只看成新路径，从而误判为相关范围而不是 full。
- 证据：
  ```js
  // scripts/ci/merge-queue.mjs:104-107
  changedFiles: (base, head) =>
    run(["diff", "--name-only", "-z", `${base}...${head}`])
      .split("\0")
      .filter(Boolean),
  ```
  ```js
  // scripts/ci/merge-queue.mjs:71-75
  export function touchesProtected(files) {
    return files.filter((file) =>
      protectedPaths.some((prefix) => file === prefix || file.startsWith(`${prefix}/`)),
    );
  }
  ```
  我用仓库里已有的重命名提交核对过 Git 行为：`git diff --name-only 5f6f07e7..67d3bd08 -- clients/apple/Sources/HimawariMac/ChecklistView.swift clients/apple/Sources/HimawariMacUI/ChecklistView.swift` 只输出新路径，旧路径没有出现。
- 建议：改成 `git diff --name-status -z --no-renames`，同时看旧路径和新路径；`touchesProtected` 和 `classifyChanges` 都用两端路径。补反向测试：把 `scripts/ci/main-confirm.mjs` 重命名到 `docs/` 必须被拒收，且 test-scope 必须判 full。
- 性质：读代码证实（Git 行为已用仓库现有提交核对；真实 PR 未构造）。

### 3、中：main 在“合并前检查”和 merge API 之间变化时，合并会先发生，队列只能事后停下

- 文件:行：`scripts/ci/merge-queue.mjs:383-405`、`:285-296`
- 问题：合并前只 `repo.fetchMain()` 一次，然后调用 GitHub merge API。合并接口的 `sha` 只锁 PR 头，不锁 main；在 `fetchMain()` 和 `merge` 之间如果有人写 main，PR 仍会合到新的 main 上，之后 `repo.fetchMain()` 发现父提交/树不一致才 `stop`。此时合并已经不可撤销，main 上出现了没有被完整 CI 一起测过的组合；如果发生在批中第二个 PR，前一个 PR 也已经留在 main 上。ADR 承认会停队列，但这确实属于“先合了再说”的残余窗口。
- 证据：
  ```js
  const current = repo.fetchMain();
  if (current !== expected) return drop(`main-moved-during-merge after ${merged.join(",")}`);
  const result = await github.merge(pr.number, pr.head);
  if (!result.merged) return drop(`merge-refused #${pr.number} status=${result.status}`);
  const after = repo.fetchMain();
  const parents = repo.parents(after);
  if (parents[0] !== expected || parents[1] !== pr.head || repo.tree(after) !== pr.tree) {
    stop(`main ${after} 和候选 ${candidate.sha} 里 #${pr.number} 合入后的树不一致`);
  ```
  ```js
  // scripts/ci/merge-queue.mjs:290
  { merge_method: "merge", sha },
  ```
- 建议：如果要求“合进 main 的树一定被完整 CI 测过”，不能只依赖锁 PR 头的 merge API。可让 main 只接受队列用 compare-and-swap 推送的、已验证的 merge commit（需要调整分支保护），或在任何 main 变化后重新跑候选 CI 再合。至少要在检测到 main 变化时避免继续整批合并，并明确这是残余风险。测试应加入“mock merge 时把 main 推进”的用例，验证不再合并后续 PR。
- 性质：读代码证实存在窗口；实际触发需要并发写 main，未实测。

### 4、中：候选 CI 的基础设施失败会被当成 PR 失败，单个 PR 会被加 `merge-queue-failed` 移出

- 文件:行：`scripts/ci/merge-queue.mjs:454-458`、`:419-430`
- 问题：只有 `run.conclusion === "cancelled"` 被特殊处理；`startup_failure`、runner 掉线、超时、GitHub 故障等都会走 `failCandidate`。候选只有一个 PR 时直接 `eject`，去掉 `merge-queue`、加 `merge-queue-failed` 并留言“完整 CI 没过”。这和交付模式里“CI 本身坏了、已确认与 PR 无关时不要怪 PR”的规则冲突，也会让无辜 PR 需要人工重新加标签。
- 证据：
  ```js
  if (run.conclusion === "cancelled") return drop("cancelled");
  const required = await github.requiredJobConclusion(run);
  if (run.conclusion === "success" && required === "success")
    return mergeCandidate(state.candidate, run, main);
  return failCandidate(state.candidate, run);
  ```
  ```js
  if (candidate.prs.length === 1) {
    await eject(candidate.prs[0].number, `它和当前 main 合在一起后完整 CI 没过：${run.url}`);
    state = { ...state, candidate: null, groups: rest };
    return;
  }
  ```
- 建议：区分“候选内容失败”和“基础设施失败”（看 `run.conclusion`、`required` job 的 conclusion/annotation、上游 job 是否 startup failure）；基础设施失败时保留候选或重试一次，不要给 PR 加 `-failed`。补 `startup_failure` / `timed_out` 的反向测试。
- 性质：读代码证实。

### 5、中低：合并队列的复核门槛读取 PR 自己提交的 `.agents/reviews` 记录，PR 可以改写/伪造这份输入

- 文件:行：`scripts/ci/merge-queue.mjs:307-329`；`scripts/model-review/opencode-review.mjs:1444-1459`；`scripts/ci/merge-queue.mjs:11`；`scripts/ci/test-scope.mjs:8`
- 问题：`reviewChecker` 在 PR 头的临时检出上运行 main 的 `opencode-review.mjs --assert-reviewed`，而 `assertReviewed` 读取 `HEAD:<PR 目录>/usage.jsonl`。这份记录在 PR 内容里，`.agents` 不在 `protectedPaths`，也被 `test-scope` 当作可忽略目录。代码没有看到对记录签名、来源或“由可信工作流产生”的校验；能写 PR 的线程可以构造看起来满足 head、链和字段的 `usage.jsonl`。我没有实际构造通过全部 checks 的伪造记录，但读取路径和信任边界是确定的。
- 证据：
  ```js
  // scripts/ci/merge-queue.mjs:312-324
  repo.withWorktree(head, (dir) => {
    const result = spawnSync(process.execPath, [
      script, "--assert-reviewed", "--pr", String(number),
      "--repo", dir, "--main-ref", repo.mergeBase(main, head),
    ], ...);
  ```
  ```js
  // scripts/model-review/opencode-review.mjs:1447
  const shown = gitStatus(["show", `HEAD:${ledgerPath}/usage.jsonl`], repo);
  ```
- 建议：不要让队列把 PR 里可写的复核记录当唯一可信证据。可由独立、有写权限的可信工作流产生复核结论 check-run/产物，并由队列读取；或对记录做签名/来源绑定。至少要在队列文档和 ADR 里明确“复核记录可被 PR 修改”这个信任前提。补测试：伪造/修改 `usage.jsonl` 的 PR 不能进队列。
- 性质：读取路径读代码证实；伪造能否通过全部校验是推测，未构造。

### 6、中低：`merge-queue-failed` 标签在仓库里没有创建步骤，`addLabel` 失败会中断整个 eject

- 文件:行：`scripts/ci/merge-queue.mjs:7-8`、`:302`、`:356-364`
- 问题：代码直接给 PR 加 `merge-queue-failed`，但仓库里没有创建这个标签的脚本、工作流或文档步骤。`eject` 先 `removeLabel(queueLabel)`，再 `addLabel(failedLabel)`，再评论；如果 GitHub 对不存在的标签返回 422（未核实），`addLabel` 会抛错，PR 已经被移出 `merge-queue`，但不会被加失败标签、不会留言，整个队列运行也会中断且状态可能没保存。
- 证据：
  ```js
  export const queueLabel = "merge-queue";
  export const failedLabel = "merge-queue-failed";
  ```
  ```js
  addLabel: (number, label) => call("POST", `/issues/${number}/labels`, { labels: [label] }),
  ```
  ```js
  const eject = async (number, reason) => {
    log(`MQ_EJECT #${number} ${reason.split("\n")[0]}`);
    await github.removeLabel(number, queueLabel);
    await github.addLabel(number, failedLabel);
    await github.comment(number, ...);
  };
  ```
- 建议：在工作流或一次性部署脚本里创建 `merge-queue` 和 `merge-queue-failed`；`addLabel` 对 422 做“创建标签后重试”或至少容忍并记录；把 eject 的副作用做成部分失败也能重试。加一个 fake GitHub 返回 422 的测试。
- 性质：代码中缺少创建步骤已证实；GitHub API 对不存在标签的返回是推测，未核实。

### 7、中低：dispatch/saveState 失败或进程中断会留下孤儿候选分支，复核子进程没有超时

- 文件:行：`scripts/ci/merge-queue.mjs:527-541`、`:561`、`:370-373`、`:313-326`
- 问题：`start` 先推候选分支、再 `dispatch` CI，最后才把 `candidate` 写进 state；`saveState` 在整个处理结束才执行。如果进程在 dispatch 成功之后、保存状态之前被杀（30 分钟 job 超时、runner 中断、API 报错），下一次运行不知道这个候选，会重新建候选并再次触发 CI，旧分支成为孤儿；`stop` 在树不一致时也只把 `candidate` 置空，不删除分支。`reviewChecker` 的 `spawnSync` 没有 timeout，一个卡住的复核可以占满整个队列 job。
- 证据：
  ```js
  const branch = `${candidatePrefix}${runTag}`;
  repo.pushBranch(built.sha, branch);
  await github.dispatch(branch, main);
  state = { ...state, candidate: { branch, sha: built.sha, base: main, ... } };
  ...
  if (JSON.stringify(state) !== original) repo.saveState(state, loaded.parent);
  ```
  ```js
  const stop = (reason) => {
    log(`MQ_STOP ${reason}`);
    state = { ...state, stopped: { reason, at: at() } };
  };
  ```
  ```js
  const result = spawnSync(process.execPath, [ script, ... ],
    { encoding: "utf8", maxBuffer: 16 * 1024 * 1024 });
  ```
- 建议：在 push/dispatch 之前先保存 `pending` 候选状态，或把“已 dispatch”作为可恢复状态；启动时扫描/清理 state 里没有的 `mq/*` 分支；`reviewChecker`、git 子命令加 timeout；`stop`/`drop` 时立即保存状态。补测试覆盖 dispatch 后崩溃、saveState 推送失败和孤儿分支清理。
- 性质：读代码证实。

### 8、低：`scope` 的消费端只排除 `"related"`，不要求 `"full"`，缺字段或未来新值会被当作可用证据

- 文件:行：`scripts/ci/main-evidence.mjs:221`；`ci/result.schema.json:406-408`；`scripts/ci/aggregate.mjs:241`
- 问题：产生端只写 `"full"` 或 `"related"`，但 `GateSummary` 的 `scope` 不是必填，消费端只断言 `summary.scope !== "related"`。因此旧 summary 缺 `scope`（为兼容可以理解）和未来新增的 `"partial"` 之类值都会通过 main 的轻量门槛。对当前代码不是可利用漏洞，但两端校验松紧不一致。
- 证据：
  ```js
  // scripts/ci/main-evidence.mjs:221
  assert(summary.scope !== "related", "MAIN_GATE_RELATED_SCOPE");
  ```
  ```json
  // ci/result.schema.json:406-408
  "scope": {
    "enum": ["full", "related"]
  }
  ```
  `GateSummary.required` 里没有 `scope`。
- 建议：消费端改成“缺省或 `"full"` 接受，其余拒绝”；新产生的 summary 要求 `scope` 必填；把 `scope` 写进 `ci/required` 作业摘要（`scripts/ci/required.mjs:46-60`），避免人只看绿色标记不知道只跑了相关测试。
- 性质：读代码证实。

### 9、低：作者说法与代码不一致：`.md`/`.agents/` 不会退回全量，重命名和“孤儿分支”说法也过度概括

- 文件:行：`scripts/ci/test-scope.mjs:8`；`test/tooling/test-scope.test.mjs:24-34`；`docs/adr/0268-merge-queue-and-related-tests-on-prs.md:62`；`.agents/instructions/delivery-mode.md:27`
- 问题：作者材料说“改了非源码文件整 PR 退回全量”，但代码明确把 `.md` 和 `.agents/` 当作可忽略，只让它们走相关范围（通常是零个 integration/e2e/pi-compat/tooling 测试）。ADR 第 62 行写的是“不是源码，也不是 `.md` 或 `.agents/` 下的记录，才全量”。另外“孤儿分支存状态”不准确：只有当前候选在状态里，push 后保存前崩溃或树不一致停下都会留下状态外的孤儿分支。`delivery-mode.md:27` 说“改了 .github、ci、scripts/ci 的 PR 不能进队列”，但受重命名漏检和第 1 条影响，这句话目前不完全成立。
- 证据：
  ```js
  // scripts/ci/test-scope.mjs:8
  const ignorable = (file) => file.startsWith(".agents/") || file.endsWith(".md");
  ```
  ```js
  // test/tooling/test-scope.test.mjs:24-33
  expect(classifyChanges([
    "packages/application/src/ports/memory-episodes.ts",
    "test/integration/example.test.ts",
    "docs/adr/0268-x.md",
    ".agents/reviews/pr-1/usage.jsonl",
  ])).toEqual({ full: false, fullFiles: [] });
  ```
- 建议：改作者说明和规则文件，明确“非源码且非 `.md`/`.agents` 才全量”，并把重命名、未保存候选的孤儿分支写进已知限制。不要在材料里写成无条件“退回全量”。
- 性质：读代码证实。

### 10、低：测试缺少几条关键反向用例，已写的反向用例从代码路径看会命中对应分支，但我没有执行测试

- 文件:行：`test/tooling/merge-queue.test.mjs:212-461`、`:575-582`；`test/tooling/test-scope.test.mjs:36-52`、`:120-159`；`test/tooling/aggregate.test.mjs:137-193`；`test/tooling/main-evidence.test.mjs:165-172`
- 问题：现有测试覆盖了合并树不一致、main 被抢先改、PR 头变化、取消、超时、找不到运行、冲突、review 失败、related 范围只在 PR/只对四个项目、main 拒绝 related 等。缺少：
  - 受保护文件重命名移出（当前代码不会拒收，测试也不会失败）；
  - main 在“预检”和 merge API 之间变化（当前测试只在候选运行阶段改 main，或事后改树）；
  - `startup_failure`/runner 丢失等基础设施失败不能当作 PR 失败；
  - `saveState` 推送失败、dispatch 成功后进程中断、孤儿 `mq/*` 分支；
  - `merge-queue-failed` 标签不存在/`addLabel` 422；
  - `scope` 缺字段或未知值被 main 接受；
  - `changedFiles` 自身失败、test-scope 的删除/重命名；
  - 工作流的持久凭据和复核子进程是否拿不到 token（现在只检查文本里没有 `pull_request_target` 和 checkout main）。
- 证据：例如工作流测试只做字符串检查：
  ```js
  // test/tooling/merge-queue.test.mjs:575-582
  expect(text).not.toContain("pull_request_target");
  expect(text).not.toMatch(/head\.sha|head_ref|head\.ref|github\.event\.workflow_run\.head/u);
  expect(text).toMatch(/ref: main/u);
  expect(text).toContain("run: node scripts/ci/merge-queue.mjs");
  ```
- 建议：按上面每条补反向测试；尤其是重命名和 main 中途变化，否则“反向用例一定会失败”的直觉在这两处不成立。
- 性质：读测试代码和被测代码证实；未实际运行测试。

## 侧重检查

- 错误路径：我核对了 merge 405/409 重试（最多 4 次后 `drop`，不会无限循环）、找不到运行 15 分钟丢弃、候选 3 小时超时取消、运行取消后重建。主要问题：main 在预检与合并之间变化后只能事后停下（第 3 条）、基础设施失败被当 PR 失败（第 4 条）、dispatch/保存状态失败留下孤儿分支（第 7 条）、标签缺失时 `eject` 可能在移除队列标签后中断（第 6 条）。
- 不可撤销操作：`github.merge` 成功后无法回滚；树不一致时队列只停，不撤销已合入的 PR。部分合并后 `removeLabel`/`comment` 抛错会让状态没保存，但下一轮看到 main 已变化会 `drop`，不会重复合并同一个 PR；代价是已关闭 PR 上可能残留 `merge-queue` 标签。
- 不可信输入：PR 只作为 git 数据参与合并；合并队列工作流检出 main、运行 main 的脚本，不执行 PR 脚本。但 `reviewChecker` 会在 PR 头的 worktree 上运行复核脚本，`.agents/reviews` 记录来自 PR，见第 5 条。PR 文件名和复核输出会被拼进评论，存在低风险的 Markdown/@mention 注入，不是合并安全漏洞。
- 安全与权限：`ci.yml` 顶层是 `contents: read`、`pull-requests: read`，候选 CI 没有写权限；`merge-queue.yml` 给了 `contents/pull-requests/issues/actions: write` 和 `checks: read`，符合 dispatch、取消、合并、标签、评论的需要。`opencode-review.mjs` 给 opencode 子进程的环境是白名单，`gitGuard` 也只保留 `PATH/HOME/LANG/TERM`，因此没有看到模型子进程直接拿到 `HIMAWARI_CI_GITHUB_TOKEN` 的路径。但 `merge-queue.yml` 的 checkout 没有 `persist-credentials: false`，写 token 会持久化到 main 检出的本地 git 配置；worktree 共享 `.git/config`。我没有构造出通过受限制 `git` 子命令或 read 工具读出它的路径，但这只是“没有发现”，不是自动检查保证的。建议至少使用单独的、仅用于 git push 的凭据，或明确设置 `persist-credentials: false` 并用受限 credential helper。
- 资源耗尽：`labeledAt` 对每个排队 PR 最多翻 10 页 timeline，`listQueued` 最多 100 个 issue，每次定时触发都可能打出大量 API 请求；`reviewChecker` 没有超时；`changedFiles` 的 64MB `maxBuffer` 和 16MB 复核输出上限会在大 PR 上抛错并中断整个队列。队列 job 只有 30 分钟，超时会留下未保存状态。
- 规则/文档一致：`.agents/instructions/delivery-mode.md:27`、`.claude/rules/owner-standing-rules.md:43` 与代码大体一致，但“改了 `.github`、`ci`、`scripts/ci` 就不能进队列”被重命名漏检破坏；受保护集合也没有覆盖 `package.json`/`scripts/run-all-checks.mjs`。作者材料里的 `.md`/`.agents` 说法与 ADR/代码相反，见第 9 条。
- 未核实：真实 GitHub API 对不存在标签、带斜杠 branch 过滤、timeline 分页的返回；真实 `vitest list --json`/`--changed` 的参数和行为（测试里是 mock）；仓库是否允许 merge commit、分支保护是否禁止队列 push；`workflow_run` 是否会在 token 触发的 workflow_dispatch 完成后再次触发；代理框架是否会在已有会话中重新读取 `.claude/rules`。

## 必答问题

**1. 会不会改变模型已经见过的请求开头？**
对 Himawari 产品发给模型的请求：不会。这个 diff 只改 CI、合并队列、结果 schema、测试和编码代理的规则/说明文档，没有改 `packages/prompt-catalog`、请求组装、历史存储、工具定义或遮盖算法；`relatedProjects`、`scope`、`merge-queue-state`、候选分支名和 PR 评论都不会进入模型请求。`docs/agent-rulebook-inventory.md:44` 也说明 `.claude/rules/` 和 `AGENTS.md` 是给编码代理的规则，不是 Himawari 运行时规则。
对编码代理会话：这次确实改了 `.claude/rules/owner-standing-rules.md` 和 `.agents/instructions/delivery-mode.md`。如果代理框架把它们注入系统提示，新会话会看到新文字；已有会话是否重新读取由外部框架决定，本仓库代码没有这个加载器，**未核实**。按 `prompt-prefix` 规则，改提示词文字只应对新对话生效；如果外部框架每轮重读这些文件，它本身就违反只追加规则，不是这次 diff 能证明的。
“发给模型的内容是否仍然只在末尾追加、每轮会变的值是否都在最后一条消息”：这不是本次 diff 的改动范围，我没有对现有请求组装做全量审计，**未核实**；但本次改动没有给模型请求增加任何会变字段。

**2. 会不会让同一段文字在不同请求里变成不同字节？**
不会（就模型请求而言）。没有新的时间、随机数、上下文相关遮盖或无序集合进入模型输入。`relatedProjects` 的顺序由 policy 项目顺序决定，`scope` 是枚举，`testScope` 只写进 CI 的 `details.json`；`state.json` 里虽然有 `createdAt`、`runId`、分支名，且 JSON 键顺序不由排序保证，但这些只存在状态分支和 CI 日志里，不发给模型。PR 评论里的运行链接和候选 SHA 也不进模型请求。

**3. 有没有对应的自动检查，反向用例真的会失败吗？**
有测试：`test/tooling/test-scope.test.mjs` 覆盖源码/非源码、非 PR 全量、`vitest list` 参数和失败退回全量；`test/tooling/aggregate.test.mjs:137-193` 覆盖 related 只在 PR、只对四个项目、零计数只在声明 related 时接受；`test/tooling/main-evidence.test.mjs:165-172` 覆盖 main 拒绝 `scope: related`；`test/tooling/merge-queue.test.mjs:212-461` 覆盖合并顺序、树不一致、失败二分、冲突、main 被抢先改、PR 变化、取消/超时、找不到运行、完整模式、草稿/fork；`:575-582` 覆盖工作流文本检查。
从代码路径看，这些已写的反向用例会命中对应分支；我受工具限制没有实际运行测试。缺口是：重命名移出保护目录、main 在预检和 merge API 之间变化、基础设施失败、`saveState`/dispatch 失败、标签不存在、`scope` 缺字段/未知值、`changedFiles` 失败、删除/重命名对 test-scope 的影响都没有用例；其中前两项按当前代码**不会失败**，因为代码里没有对应行为。详见第 10 条。

**4. 每个新值/修改值，产生它的地方和使用它的地方都接受吗？**
- `relatedProjects`：产生于 `run.mjs:218`，schema 在 `ci/result.schema.json:247-255`，使用于 `aggregate.mjs:100-112`；两端都接受，且 aggregate 会拒绝非 PR、非四个项目、不在该 check projects 里的值。
- `scope`：产生于 `aggregate.mjs:241`，schema 在 `ci/result.schema.json:406-408`，使用于 `main-evidence.mjs:221`；产生端只写 `full/related`，但消费端只排除 `related`、不要求 `full`，两端松紧不一致（第 8 条）。
- `zeroCounts`：产生于 `test-scope.mjs:86`，使用于 `run.mjs:224-227`、`test.mjs:61-64`、`aggregate.mjs:109-112,128`；当前所有产生端都用同一个函数，键顺序一致。aggregate 用 `JSON.stringify` 逐字比较，若未来另一处产生相同计数但键顺序不同会被误判为“有测试”，这是脆弱的但偏安全。
- `testScope` 详情：产生于 `run.mjs:217`，只写 `details.json`，没有 schema 或消费端校验；不影响 gate。
- `protectedPaths`：产生于 `merge-queue.mjs:11`，使用于 `touchesProtected`/`readiness`；rename 和“CI 实际用到的脚本不在集合里”导致两端不一致（第 1、2 条）。
- `relatedEligibleProjects`：产生于 `test-scope.mjs:6`，同时被 `planTestScope` 和 `aggregate` 使用；两端一致。
- `base_sha`：产生于 `merge-queue.mjs:529`，消费端是 `ci.yml` 的 `workflow_dispatch.inputs.base_sha`；名称和 required 都匹配，Dispatch 的参数链是对的。
- `candidate.branch`：产生于 `:527`，使用于 `findRun`、`dispatch`、`deleteBranch`、state；`validateState` 只检查 `mq/` 前缀，未校验完整 ref 合法性，但生产值由数字 run ID/attempt 生成，实际安全。
- `merge-queue`/`merge-queue-failed` 标签：产生于 `:7-8`，使用于 GitHub Labels API；代码和文档都没有创建标签的步骤（第 6 条）。
- `state.json`：产生于 `saveState`，使用于 `loadState`/`validateState`；类型校验有，但 `createdAt` 是否可解析、`runId` 是否真实存在、分支 ref 是否合法没有校验，损坏状态可能让队列卡住或等待不存在的运行。

## 未核实事项

- 真实 GitHub API 对不存在的标签、带斜杠 branch 过滤、timeline 分页的返回；`workflow_run` 是否会在 GITHUB_TOKEN 触发的 workflow_dispatch CI 完成后再次触发。
- 真实 Vitest 是否支持代码里用的 `list --filesOnly --json=... --changed`；测试里是 mock。
- 仓库是否允许 merge commit、分支保护是否允许队列 push/删除 `mq/*`、`merge-queue-state` 分支是否被保护。
- 编码代理框架是否会在已有会话中重新读取 `.claude/rules`，以及是否把 `merge-queue` 工作流的写 token 留在 runner 工作区。
- 我没有运行任何测试或真实合并流程；所有“会失败/会通过”的判断都是读代码得出的。
