## 证实的发现（按严重度）

### 1. 高：PR 的 `ci/required` 从“全量”改成“相关测试”，但下游仍把它当全量；现有 CI 汇总器还会直接拒绝 `--changed`
- **问题**：方案把 PR 上的 tests 改成 `vitest run --changed`，但 `ci/required` 这个名字、`main-evidence.mjs` 和 `aggregate.mjs` 的语义仍是“完整测试”。一旦这个部分测试的 `ci/required` 被 `main.yml` 的轻量确认当成 main 的证据，没跑全量的提交会被当成已完整验收。另一方面，`scripts/ci/test.mjs` 要求实际运行的测试文件集合与 policy 的 include/exclude 完全一致，`aggregate.mjs` 要求五个项目都有非零计数，`--changed` 只要某个项目没有相关测试就会失败。
- **证据**：
  - `scripts/ci/test.mjs:104-115`：`expectedFiles` 与 `actualFiles` 必须完全相等，否则 `CI_TEST_FILE_SET_MISMATCH`；`:131-138` 计数有失败或跳过就返回 1。
  - `scripts/ci/aggregate.mjs:108-120`：项目集合必须等于 policy，且每个项目 `files/executed` 大于 0；`:174-178` 缺报告即失败。
  - `scripts/ci/main-evidence.mjs:143-157` 找任意成功的 `pull_request` CI 运行；`:219-233` 只核对 gate summary 的状态和成员，不核对测试范围或计数，无法区分“全量”和“相关”。
  - `.agents/instructions/delivery-mode.md:27` 仍写“PR 最新提交上的 `ci/required` 必须是成功”；ADR 0267 第 57-58 行明确“PR 上照跑全部测试”。
  - `.agents/instructions/model-review.md:79` 的 I-73 教训正是“只看改动，不问清单里的 id 能通过后端校验吗”。
- **建议**：不要让部分测试继续叫 `ci/required`。新增 `ci/pr-related`（或给 `Context`/`GateSummary` 增加 `scope: full|related`），让 `main-evidence.verifyGate` 和 `aggregate.mjs` 明确拒绝 `related` 作为 main 证据；同时给 `test.mjs`/`aggregate.mjs` 增加显式的 related 模式，并补“无相关测试”“动态 import/子进程漏测”“部分 gate 不能被 main 接受”的失败用例。

### 2. 高：候选 CI 执行的是 PR 改过的 CI 脚本，队列却把它当作可信的全量验收
- **问题**：候选 CI 是 `workflow_dispatch` 在 `mq/<n>` 上跑 `ci.yml`。`ci.yml` 检出候选树后执行的是候选树里的 `scripts/ci/*.mjs`。PR 可以改 `scripts/ci/run.mjs`、`test.mjs`、`aggregate.mjs`、`check-policy.mjs`，甚至改 `.github/workflows/ci.yml`，让候选 CI 自己变绿。方案说的“只执行 main 上的脚本”只适用于队列处理器，不适用于候选 CI 本身。
- **证据**：
  - `.github/workflows/ci.yml:14-18` 的 `workflow_dispatch`；`:55`、`:98`、`:146`、`:267`、`:308`、`:351` 都是运行检出树里的 `scripts/ci/*.mjs`。
  - `scripts/ci/context.mjs:127-129` 只把 policy 的读取基线固定到 `base_sha`；`run.mjs`、`test.mjs`、`aggregate.mjs` 仍是候选树里的代码。
  - `scripts/ci/main-evidence.mjs:102-113` 已有 `MAIN_VALIDATION_CHANGED`：main 合并前后只要动了 `.github`、`ci`、`scripts/ci` 就不走轻量确认。这说明项目已经知道这类风险，但方案没有给候选 CI 加等价保护。
  - `docs/execution/specs/2026-09-03-github-ci-quality-gates-design.md:276`：“不使用 `pull_request_target` 执行 PR 代码，不通过有写权限的 `workflow_run` 接收并执行不可信产物。”
  - GitHub 文档：`workflow_dispatch` 可对任意分支/标签触发（https://docs.github.com/en/actions/reference/workflows-and-actions/events-that-trigger-workflows#workflow_dispatch ：“Once a workflow has run at least once, you can dispatch it against any branch or tag via the GitHub API or GitHub CLI.”）。即使 workflow YAML 固定从 main 读，`scripts/ci/**` 仍然来自候选检出树。
- **建议**：候选 CI 必须用 main 的 CI harness 跑候选树。最直接的做法：在 main 上加一个可复用工作流/工作流输入 `candidate_sha`，检出该 SHA 为数据，但执行 main 上的 `scripts/ci/**` 和 main 上的 policy；或者拒绝任何改动 `.github/`、`ci/`、`scripts/ci/` 的候选，强制走人工合并 + main 完整确认。再加一条反向测试：候选改 `ci.yml` 或 `scripts/ci/run.mjs` 必须被队列拒绝。

### 3. 高：合并接口的 `sha` 只锁 PR 头，不锁 main 基线；合完才发现树不一致时，未测提交已经进了 main
- **问题**：方案用合并接口的 `sha` 锁定 PR 头，但 GitHub 的该参数只保证 PR head 没变，不保证 main 没被别的路径推进。候选 CI 跑完后、真正合并前，如果 main 被抢先改，队列仍会先合入，再“合完核对树”，此时未测的树已经在 main 上，属于不可撤销操作。
- **证据**：
  - GitHub REST “Merge a pull request” 对 `sha` 的定义：“SHA that pull request head must match to allow merge.”（https://docs.github.com/en/rest/pulls/pulls#merge-a-pull-request）
  - 方案原文：“合完核对 main 的树和候选的树逐字节相同；不同就停队列、在 PR 上评论。”
  - `docs/execution/specs/2026-09-03-github-ci-quality-gates-design.md:306` 还写了完整模式规则要求“分支保持最新”（`strict_required_status_checks_policy: true`）；`scripts/delivery-mode/github-ruleset.sh:28-32` 也确认 full 模式启用 strict。批里第二个 PR 在第一个合入后就不满足“最新”了。
- **建议**：每次调用合并接口前重新读取 `refs/heads/main`，要求它等于候选记录里的 main；不相等就丢弃候选重建。逐个 PR 合并，每次合并后核对“本地预计算的中间树”与 main 新树；不一致立即停并走回滚预案。可考虑用 `merge-async` 或仓库级 concurrency lock 缩小窗口。full 模式下要么逐 PR 更新分支并重跑 `ci/required`，要么明确本方案仅适用于 fast 模式并更新规则集说明。

### 4. 中高：`pull_request_target` + 写权限 + `workflow_run` + 自托管 runner + 公开仓库/fork，和项目现有安全规范冲突
- **问题**：方案用 `pull_request_target` 加标签触发、`workflow_run` 读结果，队列处理器有 `contents: write`、`pull-requests: write`、`actions: write`。虽然处理器不直接 checkout PR 代码，但候选 CI 会在自托管 runner 上执行 PR 代码；仓库是公开的，fork PR 是正常贡献入口。GitHub 明确警告自托管 runner 几乎不应用于公开仓库，且 `pull_request_target`/`workflow_run` 与不可信代码 checkout 组合可能被接管仓库。
- **证据**：
  - `docs/execution/specs/2026-09-03-github-ci-quality-gates-design.md:268` 把公开 fork PR 当正常入口；`:276` 明确不用 `pull_request_target` 执行 PR 代码、不用有写权限的 `workflow_run` 接收并执行不可信产物。
  - `docs/runbooks/ci-vps-runner-runbook.md:38`：`ci-vps-1/2/3`、`ci-vps-gate` 是自托管 runner。
  - GitHub 安全文档：“Avoid using the `pull_request_target` and `workflow_run` workflow triggers with untrusted pull requests or code content.”；“Self-hosted runners should almost never be used for public repositories.”（https://docs.github.com/en/actions/reference/security/secure-use）
  - 方案没有写 fork PR 的准入限制。
- **建议**：队列只接受 `head.repo.full_name == github.repository` 的 PR；fork PR 走人工审批 + 隔离/临时 runner。队列工作流绝不 checkout `pull_request.head.sha`/`head.ref`，只按数字 PR 号 fetch `refs/pull/<n>/head` 且不执行。加一条自检/测试，确认队列工作流没有任何步骤 checkout 或执行候选树。若必须用 `pull_request_target`，在 ADR 里明确记录例外并更新 spec。

### 5. 中高：`--assert-reviewed` 在队列里按设计跑不起来
- **问题**：`--assert-reviewed` 从 `HEAD` 读账本，并要求 `origin/main` 是 HEAD 的祖先。队列如果只 checkout main，读不到 PR 账本；如果 checkout PR head，而 PR 分支落后于当前 main（批里前面的 PR 合入后必然落后），会报 `main-not-merged`。方案没有说明用哪个提交跑这一步。
- **证据**：
  - `scripts/model-review/opencode-review.mjs:1440-1443`：`const head = git(["rev-parse", "HEAD"])`，账本从 `HEAD:<ledgerPath>/usage.jsonl` 读。
  - `:1507-1511` 比较复核点和 HEAD；`:1520-1523` 要求 `origin/main` 已合入 HEAD，否则 `main-not-merged`。
  - `.agents/instructions/model-review.md:68` 要求 `origin/main` 已合进分支后才跑 `--assert-reviewed`。
- **建议**：对每个 PR 建一个临时 ref：把当前 main 干净合入 PR head（冲突则拒绝），在这个检出上跑 main 上的 `--assert-reviewed --pr <n> --main-ref <main>`；如果合并引入了冲突解决改动，按未复核处理。或者把复核时的 main 基线记下来，用 `--main-ref <那个 SHA>`，并要求它是当前 main 的祖先。补一条“复核时 main 较旧、main 已推进”的正反用例。

### 6. 中高：二分算法不完整，批次内交互失败没有出路，状态存在提交说明里不可靠
- **问题**：批次失败后“下一批只取前一半”只能覆盖“故障在前半”的情况；如果前半通过、故障在后半，方案没有说明怎么继续。更麻烦的是“每个 PR 单独都过，但组合失败”的交互失败，二分永远无法隔离，可能反复踢错 PR 或死循环。把批次和失败信息写在候选提交说明里，也没有机器可校验的 schema，分支删除/重建后状态会丢。
- **证据**：方案第 3 节第 3 条；GitHub 自带 merge queue 的失败处理是“失败的 PR 退出队列，重建临时分支，把其余 PR 重新组合验证”（https://docs.github.com/en/repositories/configuring-branches-and-merges-in-your-repository/configuring-pull-request-merges/managing-a-merge-queue#failing-ci），不是只试前一半。
- **建议**：把队列状态做成带 schema 的 JSON（放在专用 `mq/state` 分支、PR 评论或 GitHub issue comment 均可），记录批次、已测子集、失败子集、当前阶段、截止时间。二分要能分别验证前半和后半；两半都过而组合失败时，明确“通知 Andy/整批退回”或“逐个单 PR 重测”，并设最大尝试次数/时间预算，避免无限重跑。

### 7. 中：标签触发/撤销语义不完整
- **问题**：
  - `pull_request_target` 的 `labeled` 触发没有按 `github.event.label.name` 过滤；队列自己加 `merge-queue-failed` 也会再触发一次。
  - 线程如果用 Actions 的 `GITHUB_TOKEN` 加标签，GitHub 不会因此启动新工作流（`workflow_dispatch`/`repository_dispatch` 例外），队列可能只能等 10 分钟一次 schedule。
  - 移除 `merge-queue` 标签不会取消已在队列里的合并；Andy 撤回授权后，队列仍可能在合并前不复查标签而完成合并。
- **证据**：GitHub 触发文档：“Conversely, the following workflow uses `GITHUB_TOKEN` to add a label to an issue. It will not trigger any workflows that run when a label is added.”（https://docs.github.com/en/actions/how-tos/write-workflows/choose-when-workflows-run/trigger-a-workflow）；方案第 3 节触发条件只写 `pull_request_target` 的 labeled，没有过滤标签名，也没有处理 `unlabeled`。
- **建议**：触发条件加 `if: github.event.label.name == 'merge-queue'`；处理 `unlabeled` 作为撤销；合并每个 PR 前重新读取 PR 状态和标签，标签不在就跳过/停队列。标签用 PAT 或 GitHub App token 添加，或接受 schedule 延迟并在文档里写明。

### 8. 中：`mq/<序号>` 可复用、`workflow_run` 没按 run/commit 绑定，“加标签的时间”也不是 labels API 提供的值
- **问题**：`mq/1` 这类固定序号会在不同批次重复使用，旧的 `workflow_run`/旧分支可能被当成新候选；`workflow_run` 事件还会收到 PR CI、main CI 等无关运行，方案没有说怎么过滤。按“加标签的时间”排序也不可靠：PR 的 `labels` 数组没有时间字段，时间在 timeline 的 `labeled` 事件里。
- **证据**：方案第 3 节“状态全部从 GitHub 读（标签、`mq/*` 分支、候选运行结果）”；GitHub REST 的 labels 数组不返回 label 添加时间，timeline 事件才有 `created_at`（https://docs.github.com/en/rest/issues/timeline#list-timeline-events-for-an-issue）。
- **建议**：分支名带唯一 nonce/run id，不复用；候选状态记录 `candidate_sha`、`run_id`、`run_attempt`、`head_branch`、`workflow_path`，读 `workflow_run` 时逐项核对；排序用 timeline 的 `labeled` 事件时间，或直接在队列状态里记录入队序号。

### 9. 中：新增工作流没有进入现有 CI 校验；规则/设计文档仍写“不包含 merge queue”“不用 `pull_request_target`”
- **问题**：方案只改 `delivery-mode.md`、`owner-standing-rules.md` 和新增 ADR，但 `static` 作业的 actionlint 只检查 `ci.yml`、`quality.yml`、`main.yml`，`check:ci-policy` 也只校验这三个工作流；新增的 `merge-queue.yml` 不会被检查。设计文档还明确写“当前个人公开仓库方案不包含 merge queue”，并禁止 `pull_request_target` 执行 PR 代码。规则和实现会互相矛盾。
- **证据**：
  - `.github/workflows/ci.yml:255-260` 的 actionlint 只列三个文件。
  - `docs/execution/specs/2026-09-03-github-ci-quality-gates-design.md:310`：“当前个人公开仓库方案不包含 merge queue。”；`:276` 禁止 `pull_request_target` 执行 PR 代码。
  - `docs/architecture-v0.1.md:639` 仍按旧 CI 结构描述；`scripts/ci/check-policy.mjs` 的 workflow 校验也没有 `merge-queue.yml`。
  - `.agents/instructions/model-review.md:70` 说“合并由线程执行，这条检查拦不住线程不跑它”，队列是第一个能真正拦住的机会，但方案没有把它接进必过检查。
- **建议**：把 `merge-queue.yml` 加入 actionlint 和 `check:ci-policy`；更新 spec/architecture/runbooks；明确修改或新增 ADR 取代“不包含 merge queue”的结论；把 `--assert-reviewed` 和候选全量 CI 接成规则集/必过 check，避免线程绕过队列直接合并。

### 10. 中：目标和设计不一致；PR 仍跑重型作业，tooling 703 秒仍在关键路径，队列处理器还占 gate runner
- **问题**：方案说“完整 CI 的次数从每个 PR 一次降到每批一次”，但 PR 阶段仍跑 policy、static、build、security、tooling、browser；候选又完整跑一遍。真正减少的只有 tests 作业，build/browser/tooling/security/static 反而多跑一遍。`tooling` 是单独作业（703 秒），PR 要等它才能让 `ci/required` 变绿。队列处理器还跑在 `ci-vps-gate` 上，会和 PR/候选的 `ci/required` 抢同一个 gate runner。
- **证据**：`ci/policy.json:110` tests 项目、`:113-129` tooling 独立作业、`:147-162` required 依赖；`.agents/evidence/ci-test-timing-2026-11-13.md:7` tooling 703 秒；`docs/runbooks/ci-vps-runner-runbook.md:38` gate runner 只有一个；方案“后续一步（本方案不做）：PR 阶段去掉 browser”。
- **建议**：把目标改成“降低 tests 作业的重复”，不要宣称“完整 CI 每批一次”。如果目标是缩短推送到可排队时间，优先让 tooling/browser 也按改动条件触发或只在候选跑；队列处理器改到独立 runner/托管 runner，不要把 gate runner 当通用执行器。

### 11. 中：几个前提和实现细节与仓库现状不符
- **问题**：
  - 仓库当前没有 `forceRerunTriggers`，方案却写“扩成……”，需要先新增并验证。
  - 前提 8 引用的“Works with static imports … but not the dynamic ones”在 Vitest 文档里属于 `vitest related` 小节，不是 `--changed` 小节；`--changed` 的官方说明只说“Run tests that are affected by the changed files”。
  - PR 事件下 `CI_BASE` 是空的：`ci.yml:40` 是 `${{ inputs.base_sha || '' }}`，不能用它做 `--changed` 的基线；应使用 `github.event.pull_request.base.sha` 或 `context.baseSha`。
  - `vitest.workspace.ts:19` 设了 `passWithNoTests: false`，`--changed` 选中 0 个测试时会失败；而 `aggregate.mjs` 又要求每个项目有计数，两个约束会互相打架。
- **证据**：`vitest.workspace.ts:16-96` 没有 `forceRerunTriggers`；`ci.yml:40`；`scripts/ci/context.mjs:97-108`；Vitest `--changed` 文档（https://vitest.dev/config/changed）和 `vitest related` 文档（https://vitest.dev/guide/cli#vitest-related）；`vitest.workspace.ts:19`。
- **建议**：先补 `forceRerunTriggers` 并写测试；用 PR base SHA 作为基线；明确“某个项目没有相关测试”是跳过、跑全量还是允许 0 计数，并同步改 `aggregate.mjs`；把前提 8 的来源改到正确小节。

## 推测 / 未核实
- **未核实**：线上 ruleset 是否仍与 `scripts/delivery-mode/github-ruleset.sh` 一致；fast 模式是否真的只有 deletion/non-fast-forward，需要 `gh api repos/.../rulesets/22256403` 回读。
- **未核实**：`pull-requests: write` 是否足够给 PR 加标签，还是需要 `issues: write`；建议用一次试运行确认。
- **未核实**：逐个 `git merge --no-ff` 生成的候选树，是否在所有 rename/文件模式/冲突场景下都与 GitHub 合并接口逐个合并后的最终树逐字节相同；需要构造夹具验证，不能只靠“通常相同”。
- **未核实**：`ci-arm`/`ci-vps` 的容量能否同时承受 PR 作业和每批候选全量 CI；需要用实际队列长度和 runner 占用测量。
- **未核实**：方案里“63 个测试文件启动子进程”的计数；这是线程 grep 结果，不是仓库里的可复核证据。
- **未核实**：`vitest --changed` 对动态 import 和子进程测试的漏测范围是否和方案描述完全一致；官方文档暗示 `--changed` 依赖 import 图，但需要用本仓库的 fixtures 实测，不能只靠引用。

## 侧重检查
我按“错误路径、不可信输入、安全、资源耗尽、不可撤销操作、规则/文档一致性”检查了这些路径：

- **错误路径**：`workflow_dispatch` 失败、合并接口 405/409/422、分支删除失败、runner 离线、候选超时、旧 `workflow_run` 被误认、重复标签、PR 关闭/合并/转草稿/移标签/force-push/base 改变、空队列、单 PR 批、批次交互失败、`--changed` 零测试、动态 import/子进程漏测、`--assert-reviewed` 的 `main-not-merged`。结论：大部分没有在方案里定义处理方式，尤其“候选卡住”和“交互失败”会直接阻塞队列。
- **不可信输入**：PR 分支名、PR 标题/正文、标签、`mq/*` 分支名、候选提交说明、`workflow_run` 字段、候选树里的 CI 脚本。结论：`mq/*` 和提交说明是可写的状态来源，方案没有 schema/绑定；如果 shell 里直接拼分支名或标题，存在注入面（GitHub 的安全文档要求用中间环境变量，https://docs.github.com/en/actions/reference/security/secure-use#good-practices-for-mitigating-script-injection-attacks）。
- **安全**：`pull_request_target`/`workflow_run` 的写权限、自托管 runner 持久化、公开仓库 fork、候选执行 PR 改过的 CI 脚本、fast 模式不强制 `ci/required` 导致线程可绕过队列。结论：最严重的是候选执行 PR 改过的 CI harness（发现 2），其次是触发器/runner（发现 4）。
- **资源耗尽**：每批 5 个 PR 的完整 CI、PR 自己的 build/browser/tooling、队列处理器占 `ci-vps-gate`、候选卡住无限期、`mq/*` 分支和旧运行堆积、二分多次全量重跑、GitHub API 限流。结论：方案没有总时限/预算/清理策略。
- **不可撤销操作**：合并 main、删 `mq/*` 分支、加/删标签、树不一致后停队列。结论：合并前的检查不足，发现 3 是最主要的问题。
- **规则/文档一致性**：核对了 `.claude/rules/prompt-prefix.md`、`.claude/rules/owner-standing-rules.md:43`、`.agents/instructions/delivery-mode.md:27`、`.agents/instructions/model-review.md:68/70/79`、`docs/execution/specs/2026-09-03-github-ci-quality-gates-design.md:268/276/306/310`、`docs/architecture-v0.1.md:639`、`ci.yml` 的 actionlint 列表、`ci/policy.json`、`check-policy.mjs`、`github-ruleset.sh`。结论：方案只改两条规则，和 spec/architecture/CI 校验有至少三处矛盾，且没有把队列接进必过检查。

## 结论
方案的方向是对的：把“PR 全量”拆成“PR 快检 + 候选全量”能减少重复 tests，但它目前把两个不同范围的检查都叫 `ci/required`，又没有隔离候选 CI 的执行代码来源，且把“合完再核对树”当作安全网。以现在的写法，最可能的结果是：PR 快检因为 `test.mjs`/`aggregate.mjs` 的契约直接红；或者候选 CI 被 PR 改过的脚本放行；或者批里后续 PR 被 full 模式的 strict up-to-date 卡住。建议先修 gate 语义和候选 trusted harness，再实施队列。

## 如果由我来定，我会这样改
1. **先拆 gate 语义**：保留 `ci/required` 只表示全量；新增 `ci/pr-related`（或 `scope` 字段）表示 PR 相关测试。`aggregate`/`main-evidence` 明确拒绝 `related` 作为 main 证据；`test.mjs` 增加显式 related 模式，允许项目零相关测试，但只在 related scope 下。
2. **候选 CI 用 main 的 harness**：在 main 上加可复用工作流，输入 `candidate_sha`，检出候选树但执行 main 的 `scripts/ci/**` 和 `ci/policy.json`；或者拒绝任何改动 `.github/`、`ci/`、`scripts/ci/` 的候选，强制人工合并 + main 确认。加反向测试。
3. **合并前先锁基线**：每次合并前读 main head，必须等于候选记录的 base；逐个 PR 合并，每次核对预计算的中间树；不一致就停并走回滚预案。full 模式下逐 PR 更新分支/重跑，或明确只支持 fast 模式。
4. **队列做成显式状态机**：唯一 `mq/<run-id>/<nonce>` 分支；JSON 状态（批次、已测子集、阶段、截止时间、candidate_sha、run_id/attempt）；标签触发按名字过滤并处理 `unlabeled`；合并前重查 PR 状态、标签和 head；加总时限、清理和卡死恢复。
5. **二分补完整**：前后半都测；交互失败走“整批退回/逐个重测/问 Andy”，并设最大尝试次数；不要只把状态写进提交说明。
6. **补文档和门槛**：更新 spec/architecture/runbooks 和 `check:ci-policy`/actionlint；把 `merge-queue.yml` 纳入校验；按 incident-gates 为每个新门槛写“修前失败、修后通过”的反向证据。

## 必答问题
1. **会不会改变模型已经见过的请求开头？** 不会。这个方案只改 CI/合并流程、规则文件和文档，不碰 `packages/runtime-pi`、提示词组装、工具定义、历史或出口遮盖。产品的请求仍然只在末尾追加，每轮会变的值仍只在最后一条消息里；依据 `.claude/rules/prompt-prefix.md:27-29、34-36`。如果把这些规则文件也算作“线程的系统提示”，那只是新会话看到一次新文字；`prompt-prefix.md:43` 明确“改了提示词文字，只对新对话生效”，不影响已有对话的缓存。
2. **会不会让同一段文字在不同请求里变成不同字节？** 对产品模型请求不会。对队列本身，有确定性隐患：按“加标签时间”排序没有稳定来源；`mq/<序号>` 复用会让同名分支指向不同提交；提交说明不是规范化状态。建议用固定的 tree SHA + 带 schema 的 JSON 状态，候选比较用 tree 而不是 commit SHA。
3. **有没有对应的自动检查，反向用例真的会失败吗？** 不够。方案只列了队列脚本的单测，没有覆盖：部分 gate 不能被 `main-evidence` 接受、候选改 CI harness 必须被拒、`workflow_run` 绑定、标签过滤/撤销、候选卡死、交互失败、`--assert-reviewed` 在 main 推进后仍/不再通过、`--changed` 零测试和动态/子进程漏测。按 `.claude/rules/incident-gates.md:14-16`，每条门槛都要证明“修前失败、修后通过”，方案目前只是说“测试覆盖”。
4. **每个值产生处和使用处都核对了吗？** 没有全部对上。已发现的具体断点：
   - `ci/required` 的“全量”语义被改成“相关”，但 `main-evidence.mjs:143-157、219-233` 和 `aggregate.mjs:108-120` 仍按全量消费；`test.mjs:104-115` 会拒绝部分文件集。
   - `merge-queue` / `merge-queue-failed` 标签：触发端没有按标签名过滤，加 `merge-queue-failed` 会再次触发；移除 `merge-queue` 不会被消费为撤销。
   - `mq/<n>`：生产端可复用，消费端（`workflow_dispatch` ref、`workflow_run`）没有绑定 run/commit。
   - `base_sha`：消费端 `context.mjs:127-129` 要求完整 40 位 SHA；PR 事件下现有 `CI_BASE` 为空。
   - `REVIEW_CURRENT`：消费端要求 `HEAD` 是 PR head 且 `origin/main` 已合入（`opencode-review.mjs:1440-1443、1520-1523`），队列“只跑 main 脚本”的检出方式无法同时满足。
   - 候选运行结果：没有规定必须核对 `event=workflow_dispatch`、`head_sha`、`head_branch`、`path`，旧运行可能被误用。
   - 主树/候选树：应使用 40 位 tree SHA 并绑定候选 CI 的 `testedSha`，方案只说“逐字节相同”，没有给出两端如何记录和校验。
   - 新增 `merge-queue.yml`：没有进入 `ci.yml:255-260` 的 actionlint 和 `check:ci-policy`，属于“新值只在一边认”。
