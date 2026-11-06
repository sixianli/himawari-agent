现在我来查看一下 `runners.sh` 共享库，特别是 `apply_runner_controls`，因为 `install` 测试预期会包含 `INSTALL_STEP_FAILED ...: return 1`。
现在进行后续检查：合同哈希、二进制审查文档，以及零散的过时引用。
## 侧重检查（我的重点：测试覆盖、文档与代码一致性、一条普通流程走通）

走查流程：「恢复一台服务起不来的 runner」的完整路径 `resume-runners.sh`：take_lock → upload_runner_scripts → `--list` → `github_runners` 初读 → reconcile → **新：加标签并读回 → 读不上就不启动** → `runner-resume.sh` 启服务 → 等 GitHub online → 各退出分支。逐步对照 `test/tooling/hermes-runner-scripts.test.mjs` 的 macBox 假实现（hermes-ssh.sh 第 258-273 行、gh 假实现第 224-251 行）：

- 已覆盖（读代码证实）：对账不一致（520）、重名 runner（538）、服务起不来（553）、上线超时（565）、等待期被打断（586）、GitHub 读不到（597）、单个标签加失败→不启动服务（606）、正常成功顺序（499）。逐个数过假 `gh` 的调用序（初始 list n=1、加标签 POST 不计数、读回 n=2、启动后轮询 n=3+），新脚本在 8 个用例下均能按测试断言通过。
- 未覆盖（读代码证实）：`resume-runners.sh:9`（上传失败）、`:10`（`--list` 失败）、`:11`（首次 `github_runners` 失败）三个 `RUNNER_RESUME_FAILED` 分支没有任何 resume 用例触发；`:24-27`「读回 GitHub 整体失败→全部 unread→exit 1」没有直接用例（606 用例只覆盖单个 off）。macOS bash 3.2 兼容性没有自动检查（测试跑在 `/bin/bash`，hermes-runner-scripts.test.mjs:36）。
- 文档一致性：Runbook「恢复」一节、ADR 0168、测试手册 runbook 与代码逐句核对一致；**ADR 0169 第 105 行仍旧写着「恢复时先上线再加标签」**，与本 PR 改的新顺序矛盾（详见下）。两个 runbook 的 `contract_sha256` 已更新（git diff 可见），但封存哈希无法离线复算——**未核实**。
- `.agents/reviews/topic-policy-migration/` 为 git 认定的二进制文件且环境拒绝读取，内容**未核实**；按作者声明当作非本 PR 的代码对待。

---

## 发现的问题（严重度从高到低）

**中 · test/tooling/hermes-runner-scripts.test.mjs:576-584 · 作者说「旧顺序跑新测试有 6 条失败」，按代码推演只有 5 条**
证据：该「interrupted while putting labels back」用例（打断点 `interrupt-after-add-11`，第 578 行）断言 `labels: hermes-home=on hermes-home-2=off`（582 行）。旧脚本（`git show a429ff0` 证实）里打断也发生在加标签之后（先启服务、上线、再加标签），陷阱读新状态同样是 on/off——这个用例在新旧代码下都通过。逐个推演其余 7 个恢复用例，旧脚本下失败的是 499、553、565、586、597 五条。建议：实际跑一遍确认计数；4/6 之差说明作者对失败清单没逐条核对过。
（推测部分：我没有运行测试；5 条是纯代码推演。）

**中 · docs/adr/0169-pause-runners-by-removing-the-label.md:105 · 测试清单描述的顺序已过期**
证据：grep 证实该行仍为「…等到上限、恢复时先上线再加标签、锁。」，而同一文件决定第 5 条（第 67 行 diff 后）已改为「恢复先对账，再加标签，最后启服务」。运行 `resume-runners.sh` 的人若按此 ADR 的测试清单理解行为会得到相反的顺序预期。建议改成「恢复时先加标签再启服务」。

**低 · scripts/operations/hermes-runner/resume-runners.sh:9-11 · 三个早期失败分支无测试**
证据：测试文件中没有用例让 `hermes-upload.sh`、`--list`、首次 `github_runners` 失败（grep 「could not list the runners installed on Hermes」「upload of」无 resume 命中）。这三条分支正是「labels and services untouched」的安全承诺，反向用例缺失。建议各补一条。

**低 · resume 的锁和提前打断无 resume 侧测试**
证据：锁用例只存在于 pause 段（旧版 577 行附近「refuses to run while another pause or resume holds the lock」）；trap 在 resume-runners.sh:19 才设置，之前（take_lock/upload/list/reconcile 阶段）收到 TERM 会以默认信号静默退出、不打印 INCOMPLETE。属既有行为、非本 PR 引入，但新顺序让「标签已加回」窗口提前，值得留意。长 undertreated 性质：11-18 行[]>：信号在 19 行前到达则错失「labels and services untouched」提示。

**低 · 恢复超时/服务失败时 `labels=restored` 的「恢复」语义依赖 runner 离线不会被派任务这一 GitHub 侧行为（无官方文档佐证）**
证据：resume-runners.sh:28、36、50 都把标签留在 GitHub 上；ADR 0169 残余风险已如实写「没有找到官方文档」「新顺序还没在 Hermes 上实测」。若 GitHub 行为推断错误，先加标签会让离线+空闲变在线+空闲的瞬间接下原本想挡住的任务——这点作者已声明，风险已记录，仅提示复核侧确认。

---

## 作者说法逐条核对（读代码证实 / 推测分开）

- 「恢复顺序 = 对账 → 加标签并回读确认 → 启服务 → 等 online」：**证实**。resume-runners.sh:20-23（加标签）、24-31（`label_states` 若有 `=off`/`=unread` 则打 `RUNNER_RESUME_INCOMPLETE … services not started`，exit 1，服务确实没启动）、33（之后才 `hermes bash $REMOTE/runner-resume.sh`）、38-54（等 online 上限 300 秒）。
- 「加不上不启动服务；报 `labels=restored`」：**证实**。36 行 `RUNNER_RESUME_FAILED services=… labels=restored`；50 行 `labels=restored offline:$OFFLINE`；测试 553、565 用例锁定。
- 「install-runner.sh ERR 先打印 `INSTALL_STEP_FAILED line <行号> exit <码>: <命令>` 再放回备份」：**证实**。install-runner.sh:53 陷阱级联在第 44 行 `echo INSTALL_FAILED`（restore_backup 内）之前输出；`set -Eeuo pipefail`（第 2 行）保证函数内错误也触发。测试 1160 行断言 `INSTALL_STEP_FAILED line \d+ exit 1: return 1`——`return 1` 来自 runners.sh 的 `apply_runner_controls` 中 `nft -c -f … || { …; return 1; }`（runners.sh: apply_runner_controls，失败时最后执行的命令即 `return 1`），与 runbook 新增的「出错在函数里时命令可能只显示 `return 1`」一致。
- 「macOS bash 3.2 兼容」：**证实（新代码用到的构造均在 3.2 支持）**：`for name in $NAMES`、`case ' =off\ ' 样式`、`|| TABLE=""`、`$LINENO`、`$BASH_COMMAND`，无 bash 4 语法。
- 「旧脚本/旧配置跑新断言失败」：**证实 2 条（install、vitest），resume 计数为 5 不是 6（推测，未运行）**。
- 「删了 vitest.workspace.ts 原有两条注释」：**证实**（grep 到被删的 `Tooling owns synthetic Git repositories` 与 `Durable integration cases…` 注释），无测试依赖注释内容（test-timeout / environment / policy 测试读配置项，不读注释）。
- 「`.agents/reviews/topic-policy-migration/` 不属于本 PR 的代码」：无法读取（环境拒绝 + git 视为二进制），**未核实**，但按 diff 性质（记录文件）接受该说法。

---

## 必答问题

**1. 会否改变模型已见过的请求开头？** 不会。本 PR 只改了两个 shell 脚本、两个测试文件、vitest 配置和文档；没有系统提示、工具定义、历史消息或遮盖结果的任何构造改动（diff 中无此内容，scripts/ 下仅 hermes-runner 两个脚本变化）。改动不涉及「发给模型的内容只追加」规则的任何一方。

**2. 会否让同一段文字在不同请求里变成不同字节？** 不会。新增的输出都是确定字符串（`INSTALL_STEP_FAILED line…`、`labels=restored` 等）；无时间戳进入序列化、无依赖上下文的遮盖、无无序集合。唯一动态的是 `$LINENO`/`$BASH_COMMAND` 和 runner 状态，但它们只出现在本地 CLI 输出与 stderr，不进入任何发给模型的请求。

**3. 有无对应自动检查，反向用例真的会失败吗？** 有。恢复顺序与各失败消息由 `hermes-runner-scripts.test.mjs` 8 个用例锁定；时限值由 `test-timeout.test.mjs`（assert 30s/15s/缺省）锁定。反向验证：旧 install-runner.sh 无 STEP_FAILED 行→第 1160 行断言失败（代码推演证实）；旧 vitest 配置 tooling 无 testTimeout→`test-timeout.test.mjs` 断言失败（证实）；旧 resume-runners.sh 在 5 条（非作者说的 6 条）恢复用例失败（推演，未运行）。

**4. 每个产生/修改的值，使用端都能接受吗？**
- `INSTALL_STEP_FAILED line … exit …`：产生于 install-runner.sh:53；消费于测试 1160 行与 runbook 第 124 行——两端都已更新且格式一致。✓
- `labels=restored`、`; services not started`、退出码 1/2/130：产生于 resume-runners.sh:15/28/36/50；消费于测试 503/560/572/612 行、runbook「恢复」节、ADR 0169 决定第 5 条——一致；**例外：ADR 0169:105 测试清单行未跟随更新**（上面已列）。
- `testTimeout: 15_000`：产生于 vitest.workspace.ts:46；消费于 Vitest 运行时、`test-timeout.test.mjs:39` 锁值、ADR 0168 决定第 3 条、测试手册 runbook「15 秒例外」——一致。✓
- 未引入任何新的标识/清单 id/序列化格式，不存在 I-73 式「下游校验」风险面。
