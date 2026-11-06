# PR 260 复核结论

## 一、读代码证实的问题

### 1. 中：安装回滚仍可能在写 stderr 时被 SIGPIPE 打断，回滚不执行
- 文件:行：`scripts/operations/hermes-runner/install-runner.sh:44`、`:54`
- 问题：第 3 轮把 `INSTALL_STEP_FAILED` 移进 `restore_backup` 并放在 `set +e` 之后，只覆盖了“stderr 文件描述符被关闭（EBADF）”这一种情况。若 stderr 是读端已关闭的管道（例如 `... 2>&1 | head`），`echo ... >&2` 会收到 SIGPIPE；`set +e` 不改变 SIGPIPE 的默认终止动作，脚本会在 `restore_install_paths` 之前直接退出，回滚不执行。这正是本轮修复目标“stderr 写不出去也照样回滚”的另一条入口。
- 证据：
  ```bash
  42:   trap '' INT TERM HUP
  43:   set +e
  44:   [ -z "${1:-}" ] || echo "INSTALL_STEP_FAILED $1" >&2
  45:   echo "INSTALL_FAILED putting back ..." >&2
  46:   restore_install_paths "$BACKUP"
  ...
  54: trap 'status=$?; restore_backup "line $LINENO exit $status: $BASH_COMMAND"; exit "$status"' ERR
  55: trap 'restore_backup; exit 130' INT TERM HUP
  ```
  测试 `test/tooling/hermes-runner-scripts.test.mjs:1144-1152` 用的是 `2>&-`，只覆盖 fd 关闭。
- 建议：先执行 `restore_install_paths`/回滚，再打印错误；或在函数开头 `trap '' PIPE`，让写管道失败只返回错误而不终止；并补一个 stderr 为断管（如 `2>&1 | head -0`）的反向用例。
- 说明：SIGPIPE 终止进程是 bash/POSIX 常规行为，本次未运行验证，但代码顺序是读代码确认的。

### 2. 低：Runbook 说被信号中断也打印 `INSTALL_STEP_FAILED`，代码不会
- 文件:行：`docs/runbooks/hermes-self-hosted-runner-runbook.md:124`、`scripts/operations/hermes-runner/install-runner.sh:54-55`
- 问题：Runbook 写“任何一步失败或脚本被中断（Ctrl-C、TERM、HUP）……并先打印出错的那一步 `INSTALL_STEP_FAILED ...`，再打印 `INSTALL_FAILED`”。但信号陷阱是 `trap 'restore_backup; exit 130' INT TERM HUP`，调用 `restore_backup` 时没有参数，`[ -z "${1:-}" ] || echo ...` 不会输出 `INSTALL_STEP_FAILED`。
- 证据：
  ```bash
  44:   [ -z "${1:-}" ] || echo "INSTALL_STEP_FAILED $1" >&2
  54: trap 'status=$?; restore_backup "line $LINENO exit $status: $BASH_COMMAND"; exit "$status"' ERR
  55: trap 'restore_backup; exit 130' INT TERM HUP
  ```
- 建议：把第 124 行改成“失败路径打印 `INSTALL_STEP_FAILED`；被信号中断只打印 `INSTALL_FAILED`”，或让信号陷阱也传入中断位置。

### 3. 低：作者“旧顺序跑新测试有 6 条失败”的核对结论与代码推算不一致
- 文件:行：`test/tooling/hermes-runner-scripts.test.mjs:499`、`:553`、`:565`、`:586`、`:597`、`:606`、`:619`
- 问题：按 `a429ff0` 的旧顺序逐条推，会失败的是 7 条，不是 6 条：顺序用例 `:499`、服务未起 `:553`、未上线 `:565`、等待上线时中断 `:586`、读不到 GitHub 时报成 offline `:597`、加标签后读不到 GitHub `:606`、标签加不上 `:619`。`:576`（加标签期间中断）在旧顺序下反而能通过，因为旧脚本最终加标签时被中断，消息仍是 `on/off`。
- 证据：旧脚本在 `a429ff0:scripts/operations/hermes-runner/resume-runners.sh` 中先 `runner-resume.sh`、再等 online、最后加标签；新测试 `:499-518` 要求 `Math.max(adds) < start`，`:560`、`:572`、`:612`、`:625` 要求新的 `labels=restored`/“did not start the services, but ...” 文本。
- 建议：按最终测试集重跑一次反向核对，或把交付说明里的数字改成实际结果。此项不影响“旧顺序会被新测试发现”的结论。

## 二、推测 / 未核实

### 1. 中（推测）：恢复先加标签，但没有确认 GitHub 已把 runner 显示为 offline
- 文件:行：`scripts/operations/hermes-runner/resume-runners.sh:20-31`、`docs/runbooks/hermes-self-hosted-runner-runbook.md:146-147`、`:151`、`docs/adr/0169-pause-runners-by-removing-the-label.md:104`
- 问题：Runbook 第 146 行断言“runner 离线时标签在也不会派任务，所以先加标签没有风险”，但同一 Runbook 第 147 行说“GitHub 大约 1 分钟后才把停掉的 runner 显示为 `offline`”，第 151 行说“GitHub 不能保证常驻 runner 停机时绝对不被派任务”。代码在 `:20-23` 加标签，在 `:24-31` 只回读标签状态，从未检查 `status` 是否为 `offline`，随后 `:33` 就启动服务。若恢复紧跟在暂停之后、GitHub 仍认为 runner online，排队任务可能被派给一个实际已停止的 runner。ADR 0169:104 也承认“新顺序还没在 Hermes 上实测”。
- 证据：
  ```bash
  20: for name in $NAMES; do
  21:   has_label "$(runner_field "$TABLE" "$name" 5)" && continue
  22:   add_label "$(runner_field "$TABLE" "$name" 1)" || echo "could not add $LABEL to $name"
  23: done
  24: TABLE=$(github_runners) || TABLE=""
  25: STATES=$(label_states "$NAMES" "$TABLE")
  ```
- 建议：加标签前要求 GitHub 上两个 runner 都显示 `offline`（或至少等过暂停文档说的 1 分钟），再进入加标签；或者在 Hermes 上实测新顺序并记录，而不是把推断写进 Runbook 当作无风险。

### 2. 低（推测/未核实）：`items.json` 新加的 G18-G20 与 G17 的空缺
- 文件:行：`.agents/tasks/hermes-runner/items.json:21-23`、`.agents/tasks/hermes-runner/goal.md:96`
- 问题：本提交在 `decisions` 里加了 `G18`、`G19`、`G20`，但 `G17` 在 `goal.md:96` 存在而 `decisions` 仍没有它（基准 `a429ff0` 就已经缺）。若外部 longtask 工具要求每个 G 标题都有对应项或 ID 连续，这份清单仍然过不了校验；仓库里没找到校验器，无法确认。
- 证据：
  ```json
  20:     "G16": "durable",
  21:     "G18": "once",
  22:     "G19": "durable",
  23:     "G20": "durable"
  ```
- 建议：核对 longtask 的校验规则；如果 G17 是遗漏，本次一并补上或说明为什么不需要。

### 3. 未核实：Runbook 封存摘要
- 文件:行：`docs/runbooks/hermes-self-hosted-runner-runbook.md:5`
- 内容：`contract_sha256` 从 `f8a2a59c...` 改为 `1904baac...`，且与第 3 轮脚本改动在同一个提交 `5970479` 里。看改动顺序是对的，但仓库里没有 `runbook.py`，无法离线重算，`1904baac` 是否真的匹配当前 `scripts/operations/hermes-runner` 内容未核实。
- 建议：合并前在完整模式下跑一次 `validate_docs.py . --strict` / 重新封存。

### 4. 未核实：审查用 `usage.jsonl` 记录
- 文件:行：`.agents/reviews/pr-260/usage.jsonl`、`.agents/reviews/topic-policy-migration/usage.jsonl`
- 内容：工作区是稀疏检出，`read` 找不到这些文件；工具策略也拒绝显式 `git diff` 该路径，无法核对 `parseUsage` 要求的 `head`（40/64 位十六进制）、`mode`、`outcome`、`cost` 是否都合法。若记录不合法，`assertReviewed` 会报 `USAGE_LEDGER_INVALID`。未核实。

## 三、侧重检查（错误路径、不可信输入、安全、资源耗尽、不可撤销操作）

- 安装失败/中断/回滚路径：查了 ERR、INT/TERM/HUP 三个陷阱、`set +e`、`set -E`、备份恢复与用户删除。确认 `trap - ERR` 在最前、`set +e` 在消息输出前；发现断管仍可绕过回滚（上面问题 1）。信号路径确实会回滚，只是不打印 `INSTALL_STEP_FAILED`（问题 2）。
- 恢复失败/中断/部分成功路径：查了标签加不上、GitHub 读不到、服务起不来、一直不上线、Ctrl-C/TERM/HUP。确认 `:26-30` 在标签 off/unread 时不启动服务；`:36`、`:50` 报 `labels=restored` 与代码状态一致。部分成功的标签不会回滚，但消息已提示“本来在跑的 runner 可能已经在接任务”。
- 不可信输入：`NAMES` 来自 Hermes，`TABLE` 来自 GitHub TSV；`reconcile_runners` 在加标签前要求 Hermes/GitHub 一一对应，`runner_field` 用 awk 精确匹配名字，`add_label` 的 id 来自 GitHub。未发现新的注入点；`for name in $NAMES` 的 word splitting 仍存在，但对账会先拒绝不匹配的名字。
- 安全：`$BASH_COMMAND` 只经 `echo` 写到 stderr，没有 `eval`；这些命令里没有注册令牌或密钥。未发现新的凭据泄漏。
- 资源耗尽：新增的 `github_runners` 调用是多一次 `gh api --paginate`，无界但仍按 runner 数量；`gh api` 没有显式超时，属于既有风险，不是本改动引入。
- 不可撤销操作：安装回滚会删除新建用户/文件，因此回滚是否执行最关键（问题 1）；恢复只加/减标签和启停服务，均可逆，但“先加标签”在 GitHub 仍显示 online 时可能派错任务（推测项 1）。

## 四、必答问题

1. **会不会改变模型已经见过的请求开头？**
   不会。本 PR 的 diff 只有 `scripts/operations/hermes-runner/*`、`test/tooling/*`、`vitest.workspace.ts`、文档和审查记录，没有改动运行时提示词组装、工具定义、历史消息或出口遮盖。发给模型的内容仍应只在末尾追加。唯一可能进入“系统提示”的是 `.agents/instructions/test-and-production-hosts.md`，但它写入的是固定的 2026-11-06 说明，不是每轮变化的值；而且改文档不会改写已经在进行的会话里已发的内容。`npm run check:prompt-prefix` 的代码路径未被本 PR 触碰。依据：[prompt-prefix 规则](../../.claude/rules/prompt-prefix.md#rules)。

2. **同一段文字会不会在不同请求里变成不同字节？**
   不会影响模型请求。改动产生的运维文本带时间（备份目录 `date +%Y%m%dT%H%M%S`、恢复等待的 5 分钟 deadline）和服务/标签状态，但它们只出现在脚本 stdout/stderr，不进入模型请求。`label_states` 的输出顺序由 `$NAMES` 决定，不是无序集合；`github_runners` 的返回顺序也只影响运维显示。没有改遮盖或序列化逻辑。

3. **有没有对应的自动检查，反向用例真的会失败吗？**
   有：
   - 恢复顺序：`test/tooling/hermes-runner-scripts.test.mjs:499-518` 断言两次 `-X POST` 都早于 `runner-resume.sh`；`:606-617`、`:619-631` 断言标签失败/读不到时不启动服务；`:553-563`、`:565-574` 断言标签保留和报告。
   - 安装回滚：`:1144-1152` 用 `2>&-` 跑关闭 stderr 的回滚；`:1183` 断言 `INSTALL_STEP_FAILED line \d+ exit 1: return 1`。
   - 时限：`test/tooling/test-timeout.test.mjs:36-45` 断言 integration 30s、tooling 15s、其余无 `testTimeout`。
   反向用例按代码推会失败：旧 vitest 配置缺 tooling 15s，`:39` 必失败；`a429ff0` 的旧 install-runner 没有任何 `INSTALL_STEP_FAILED`，`:1183` 必失败；旧恢复顺序在 `:499` 必失败，另有上面“问题 3”提到的 6/7 条差异。**但断管（SIGPIPE）场景没有自动检查**，`2>&-` 测不到；macOS bash 3.2 也未在 CI 中验证（测试跑在 Linux bash 上）。以上反向用例本次没有实际运行，是按代码推断。

4. **每个改动值，使用它的地方都能接受吗？**
   - `testTimeout: 15_000`（`vitest.workspace.ts:46`）：消费者是 `test-timeout.test.mjs:39`（接受 15000）和本次同步修改的 architecture/spec/instruction/runbook 文档；`ci/policy.json` 不编码单条时限，未发现第二个拒绝它的校验。注意 ADR 0168 说测试“锁住这三个值”，但 `test-timeout.test.mjs:40-44` 对默认 5 秒只断言“没有 `testTimeout`”，没有显式断言 5000ms，措辞略强。
   - `INSTALL_STEP_FAILED $1`（`install-runner.sh:44`）：消费者是测试 `:1183` 的正则和 Runbook `:124`，格式匹配；除了信号路径的文档不一致（问题 2）。
   - `labels=restored` / 新的 `did not start ...` 文本（`resume-runners.sh:28,36,50,55`）：消费者是测试 `:503`、`:560`、`:572`、`:612`、`:625` 和 Runbook `:146`，本次已同步；未发现旧消费者仍要求 `labels=removed`。
   - `G18/G19/G20`（`items.json:21-23`）：生产者在 `goal.md`，消费者是外部 longtask 工具；仓库内没有校验器，G17 空缺是否会被拒绝未核实。
   - `contract_sha256`（`hermes-self-hosted-runner-runbook.md:5`）：生产者是封存脚本，消费者是 `validate_docs.py`；本提交同时改脚本并改哈希，方向正确，但哈希值本身未核实（无法运行封存工具）。
   - 审查记录 `usage.jsonl` 的 `head`/`round`/`mode`：消费者是 `parseUsage`，要求 40/64 位十六进制 head 和合法 mode/outcome/cost；文件因稀疏检出无法读取，未核实。
