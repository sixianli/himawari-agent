# 复核结论（`57910cd`，基线 `a429ff0`）

## 发现的问题

### 1. 中（错误路径，推测）——ERR 诊断失败会跳过安装回滚
**位置**：`scripts/operations/hermes-runner/install-runner.sh:53`

**问题**：新的 ERR trap 把 `echo` 放在 `restore_backup` 前面，且没有失败保护。`install-runner.sh` 在 root 下改用户、systemd、sudoers、nftables；如果 stderr 写不进去（磁盘满、重定向到已关闭的管道等），在 `set -Eeuo pipefail` 下，trap 里的 `echo` 失败可能让脚本在调用 `restore_backup` 前退出，留下半安装状态。

**证据**：
```bash
53: trap 'status=$?; echo "INSTALL_STEP_FAILED line $LINENO exit $status: $BASH_COMMAND" >&2; restore_backup; exit "$status"' ERR
...
43:   set +e
44:   echo "INSTALL_FAILED putting back units, firewall rules, sudo rules, scripts and new accounts from $BACKUP" >&2
45:   restore_install_paths "$BACKUP"
```
读代码证实：诊断在前，回滚在后，`echo` 没有 `|| true` 之类的保护。
推测：stderr 写失败时回滚可能被跳过；我没有实际复现。

**建议**：把回滚做成不会被诊断输出阻断的路径，例如先保存 `status`、`LINENO`、`BASH_COMMAND`，先执行 `restore_backup`（或至少在 `echo` 后加 `|| true`），再用 `printf ... >&2 || true` 输出诊断。增加一个“stderr 不可写时仍执行回滚”的测试。

---

### 2. 中低（错误路径）——预启动失败时只报告“did not start”，不提醒已在运行的服务可能接任务
**位置**：`scripts/operations/hermes-runner/resume-runners.sh:20-31`、`:36`

**问题**：新顺序先加标签，再回读；标签回读失败时在启动服务之前退出，消息只说 `did not start the services`。如果这是“撤销一次没完成的暂停”（Runbook 明确承认服务可能本来就在跑），或者某个服务在暂停失败后仍在运行，那么已经被加回标签的运行中 runner 可能立即接排队任务；脚本这条错误路径没有像服务启动失败路径那样提醒。

**证据**：
```bash
20: for name in $NAMES; do
21:   has_label "$(runner_field "$TABLE" "$name" 5)" && continue
22:   add_label "$(runner_field "$TABLE" "$name" 1)" || echo "could not add $LABEL to $name"
...
28:     echo "RUNNER_RESUME_INCOMPLETE services=$(service_states) labels: $STATES; did not start the services, run resume-runners.sh again"
...
36: [ "$STATUS" = 0 ] || { echo "RUNNER_RESUME_FAILED services=$(service_states) labels=restored; an active runner may already take queued jobs, run resume-runners.sh again"; exit 1; }
```
Runbook 已经写了“已经启动并带着标签的 runner……可能已经开始接排队任务”（`docs/runbooks/hermes-self-hosted-runner-runbook.md:146`），但脚本的预启动失败消息没有这条提醒。

**建议**：在加标签前读取一次 `service_states`；若发现有服务处于 active，在预启动失败消息里也明确写出“已在运行的 runner 可能已经开始接排队任务”。或者更保守地，只对确认已停止的服务加标签。补一个“服务 active + 标签回读失败”的测试。

---

### 3. 低（报告准确性）——`RUNNER_RESUMED labels=restored` 在 5 分钟等待后没有再次核对标签
**位置**：`scripts/operations/hermes-runner/resume-runners.sh:24-31`、`:38-55`

**问题**：`labels=restored` 的依据是启动服务之前的回读；之后最多等待 300 秒。如果这期间标签被其他 Mac、GitHub UI 或重新注册改变，脚本仍会打印 `labels=restored`。

**证据**：
```bash
24: TABLE=$(github_runners) || TABLE=""
25: STATES=$(label_states "$NAMES" "$TABLE")
26: case " $STATES " in
27:   *=off\ * | *=unread\ *)
28:     echo "... labels: $STATES; did not start the services..."
...
38: DEADLINE=$(($(date +%s) + 300))
...
53:   sleep "$POLL"
54: done
55: echo "RUNNER_RESUMED labels=restored runners=$(echo $NAMES)"
```
读代码证实：最后成功消息之前没有再次读取标签。影响取决于外部是否会在等待期间改标签，属于推断。

**建议**：等待 online 后再读一次 `github_runners` / `label_states`，只有全部为 `on` 才打印 `RUNNER_RESUMED labels=restored`；否则打印实际状态并以非零退出。

---

### 4. 低（文档一致性）——“唯一的例外”与 `integration` 已有 30 秒矛盾
**位置**：`.agents/instructions/test-and-production-hosts.md:14`、`docs/runbooks/test-host-operations-runbook.md:61`

**问题**：两处都写“唯一的例外是 `tooling` 15 秒”，但同一 PR 的 ADR 和配置都明确 `integration` 仍是 30 秒。

**证据**：
```text
.agents/instructions/test-and-production-hosts.md:14:
不要放宽测试时限（唯一的例外：`tooling` 项目的单条测试时限是 15 秒，...）

docs/runbooks/test-host-operations-runbook.md:61:
不放宽测试时限（唯一的例外是 `tooling` 项目的单条测试时限 15 秒，...）

docs/adr/0168-longer-ci-job-limits-on-hermes.md:69:
...其他项目仍用 Vitest 默认 5 秒，`integration` 仍是 30 秒...
```
读代码/文档证实。

**建议**：改成“本次唯一的放宽是 `tooling` 15 秒；`integration` 仍为 30 秒”，或明确“相对默认 5 秒的例外”。

---

### 5. 低（清单 ID，未核实）——`items.json` 新增 G18–G20，但仍缺 G17
**位置**：`.agents/tasks/hermes-runner/items.json:20-23`、`.agents/tasks/hermes-runner/goal.md:96`

**问题**：`goal.md` 有 G17，但 `items.json` 的 `decisions` 从 G16 直接跳到 G18；本 PR 又新增了 G18–G20。仓库里没有找到校验该清单的外部规则，无法确认 G18–G20 的值类型是否能通过 long-task 后端；同时 G17 的缺失不是本 PR 引入，但会继续存在。

**证据**：
```json
20:     "G16": "durable",
21:     "G18": "once",
22:     "G19": "durable",
23:     "G20": "durable"
```
```text
goal.md:96: ## G17 2026-11-05 用户原话
```
`grep` 未在仓库内找到读取 `decisions` 的校验器，标记“未核实”。

**建议**：合并前用 `longtask.py` 的真实校验跑一遍；若规则要求 `decisions` 覆盖 `goal.md` 的每个 G，补上 G17；否则在清单说明中写清为什么 G17 不参与分类。

---

## 侧重检查

- **错误路径**：查了 `resume-runners.sh` 的对账失败、标签回读失败、服务启动失败、等待超时、Ctrl-C/TERM/HUP；查了 `install-runner.sh` 的 ERR trap、`restore_backup`、`set -e` 与 trap 的交互。发现上面的 #1、#2、#3。
- **不合规范或不可信的输入**：runner 名称来自 Hermes `runner-pause.sh --list`，runner id/标签来自 `gh api`；新代码用 `awk` 按名称取字段，`add_label` 的 id 放进带引号的 URL，没有新增 `eval` 或命令拼接。`$NAMES` 未引用的 word splitting 是既有模式，不是本 PR 新引入。未发现新的注入路径。
- **安全**：`install-runner.sh` 新打印 `$BASH_COMMAND`；该脚本不处理注册令牌，`register-runner.sh` 才处理，因此未发现令牌泄漏新路径。但 `$BASH_COMMAND` 会把命令原文写进日志，属于需要保持“该脚本不含秘密”的前提；目前代码满足。
- **资源耗尽**：resume 的加标签循环按 runner 数有界；等待循环最多 300 秒；没有新增无界循环。install 的诊断输出本身不受资源限制，这与 #1 的磁盘满场景相关。
- **不可撤销操作**：resume 的加标签可逆，启动服务可能立即让排队任务开始跑；Runbook 已说明。install 的回滚是真正的安全关键路径，#1 是本次重点关注的问题。
- **结论**：没有发现新的高风险安全漏洞或资源耗尽缺陷；主要风险集中在 install 回滚错误路径和 resume 的错误/报告准确性。

---

## 必答问题

### 1. 会不会改变模型已经见过的请求开头？是否仍然只在末尾追加？
**不会（按本仓库代码）。** 本次改动是 shell 脚本、Vitest 配置/测试、文档和任务记录；没有修改 `packages/runtime-pi` 的请求组装、遮盖或历史存储代码。`scripts/model-review/opencode-review.mjs` 只把 `.agents/reviews/*.prompt.md` 当输出保存（`opencode-review.mjs:1779`、`:1846`），不是请求模板。

`.agents/instructions/test-and-production-hosts.md` 是仓库里的指令文档；如果某个外部 agent harness 每轮重新读取它作为系统提示，新会话的前缀会变化。但这不涉及本仓库的请求组装代码，也不会改写已经写入历史的消息；外部 harness 的加载方式未核实。没有发现每轮变化的值被放到系统提示或历史前面。

### 2. 同一段文字会不会在不同请求里变成不同字节？
**不会影响模型输入。** 改动没有加入时间、随机数、依赖前后文的遮盖或无序集合到模型提示中。新增的 shell 输出里有动态内容（`$LINENO`、`$BASH_COMMAND`、服务/标签状态），但只进入运维 stdout/stderr，不进入模型请求。`contract_sha256` 是固定值。

### 3. 有没有自动检查？反向用例真的会失败吗？
有：

- tooling 15 秒：`test/tooling/test-timeout.test.mjs:36-45` 断言 `integration=30_000`、`tooling=15_000`、其他项目没有 `testTimeout`。换回旧 `vitest.workspace.ts` 时 `tooling` 没有该值，第 39 行会失败。
- install 诊断：`test/tooling/hermes-runner-scripts.test.mjs:1173` 断言 `INSTALL_STEP_FAILED line \d+ exit 1: return 1`。旧 trap 没有这行，会失败。
- resume 顺序/报告：`test/tooling/hermes-runner-scripts.test.mjs:499-518`、`553-563`、`565-574`、`586-595`、`597-604`、`606-617`、`619-631`。按代码推演，换回旧脚本后这些用例会失败。

未实际运行（受工具限制），以上反向结论来自代码推演。另有两个覆盖缺口：没有测试“等待 online 后标签被改掉时最终报告是否仍然正确”；文档/`contract_sha256` 只有外部 `validate_docs.py --strict` 校验，我未运行。

### 4. 每个新值/修改值的生产者和消费者是否对得上？
逐个核对：

- **`tooling` 的 `15_000`**：生产于 `vitest.workspace.ts:46`；消费者是 `test/tooling/test-timeout.test.mjs:39`，`test/tooling/test-timeout-entry.test.mjs` 只复制并加载配置、不假设该值不存在；`ci/policy.json` 只有任务级 `timeoutMinutes`，没有逐项目时限校验。两端一致。
- **`INSTALL_STEP_FAILED` 格式**：生产于 `install-runner.sh:53`；消费者是测试 `hermes-runner-scripts.test.mjs:1173` 和 Runbook `:124`，格式匹配。
- **`did not start the services` / `labels=restored` / `an active runner may already take queued jobs`**：生产于 `resume-runners.sh:28,36,50,55`；消费者是测试 `:560,572,582,593,612,625` 和 Runbook `:146`，字符串匹配。但 #3 指出的“最终成功消息没有重新核对标签”是消费者（运维人员）会接受的错误事实。
- **`contract_sha256: f8a2...`**：生产于 Runbook 封存流程；消费者是 `validate_docs.py --strict`（见 `.agents/instructions/document-governance.md:29,56`）。作者提交说明称 `runbook.py check` 通过；我没有运行，标记未核实。
- **`items.json` 的 G18–G20**：生产于 `goal.md`/`items.json`；消费者是仓库外的 long-task 工具。仓库内没有 schema 或校验器；G17 仍缺失。未核实后端是否接受。

---

## 作者说法核对

- “标签加不上时不启动服务”：**代码成立**。`resume-runners.sh:20-31` 在启动前检查 `off/unread` 并退出。
- “服务起不来、没上线时如实报告 `labels=restored`”：**代码成立**（`resume-runners.sh:36,50`）。但 #3 指出最终成功报告没有等待后复查。
- “旧安装脚本跑新断言失败”：**成立**（旧 trap 无 `INSTALL_STEP_FAILED`）。
- “旧 vitest 配置跑新 test-timeout 断言失败”：**成立**（旧配置没有 tooling 的 `testTimeout`）。
- “旧顺序的 resume 脚本跑新测试有 6 条失败”：**需要区分时点**。第 2 轮新增“回读失败不启动”之前测得 6 条；当前 HEAD 的测试集按代码推演是 7 条（新增用例也会在旧脚本上失败）。作者提交说明没有记录加完新用例后重跑全套旧脚本。
- “新顺序还没在 Hermes 上实测”：ADR 0169 自己也这样写；我未在 Hermes 上运行，未核实 GitHub 是否真的在 runner 连接时匹配标签。

## 未核实项

- 未运行任何测试、lint、typecheck 或文档校验。
- 未在 Hermes/Mac 上运行 `resume-runners.sh`、`install-runner.sh`。
- 未重新计算 Runbook 的 `contract_sha256`。
- 未找到仓库外的 long-task 校验器，无法确认 `items.json` 的 G18–G20（以及缺失的 G17）能否通过后端。
