---
status: active
document_type: runbook
execution_risk: critical
contract_sha256: "sha256:893380eff02c948483d63730768fdcdcc2672c93c07e4725117363b6fa66ea49"
supersedes: ""
superseded_by: ""
date: "2026-10-21"
---

# 代理工具 Runbook：opencode 和 Grok 的启动、禁止清单、守卫插件和测试主机包装脚本

<!-- runbook-contract:
- docs/adr/0062-claude-writes-complex-code-opencode-routine.md
- docs/adr/0060-hard-constraint-on-third-repeat.md
-->

本手册集中记录给 opencode（本地命令行里的编程代理）和 Grok 派活时用到的本地工具：启动脚本的检查、权限配置里的禁止清单、拒绝长时间等待的守卫插件、通往 Hermes 和云服务器的包装脚本，以及它们各自的拒绝码和正确写法。分工和理由在 [ADR 0062](../adr/0062-claude-writes-complex-code-opencode-routine.md)（复杂模块由 Claude 写、重复性编码交给 opencode；它保留了 [ADR 0058](../adr/0058-agent-collaboration-and-review-roles.md) 未变的部分），模型选择在 [ADR 0061](../adr/0061-opencode-model-table.md)，为什么要做成硬拦截在 [ADR 0060](../adr/0060-hard-constraint-on-third-repeat.md)；`AGENTS.md` 只留硬边界并链接到这里。这些工具文件大多在被 git 忽略的 `.ci-output/` 和 `.opencode/` 下，是本地未提交文件。

## 阅读导航

- [适用范围](#scope)
- [权威来源](#authoritative-sources)
- [安全前提](#safety-and-preconditions)
- [目标现场只读检查](#live-state-preflight)
- [步骤](#procedure)
- [结果验证](#verification)
- [证据](#evidence)
- [回退](#rollback)
- [停止条件](#stop-conditions)
- [排障](#troubleshooting)

<a id="scope"></a>

## Scope

- 适用：Claude 在本仓库用 `opencode-orchestration` skill（`~/.claude/skills/opencode-orchestration/`，源码在兄弟仓库 `agent-skills`）启动、监视、纠正和结束 opencode 批次；opencode 和 Grok 通过本地包装脚本访问 Hermes 和云服务器的测试账号。
- 不适用：生产步骤（冻结包、用户运行的脚本、云服务器上的任何生产操作）从不委派；Grok 批次目前暂停（ADR 0061）。
- 目标：本机上的 opencode 会话，以及它们经包装脚本到达的测试主机。

<a id="authoritative-sources"></a>

## Authoritative Sources

- 分工与互审：[SOURCE: docs/adr/0062-claude-writes-complex-code-opencode-routine.md#decision]
- 重复错误的硬约束：[SOURCE: docs/adr/0060-hard-constraint-on-third-repeat.md#decision]
- 模型表和导出命令：[ADR 0061](../adr/0061-opencode-model-table.md)，表在 `.agents/opencode-models.toml`
- 各条拒绝规则的来历：[docs/lessons.md](../lessons.md) 的 `upload-before-written`、`long-blocking-wait`、`hand-written-wait`、`masked-exit-status`、`brief-denied-text`、`bulky-evidence`、`layer3-exit-code`、`layer0-related-tests` 条目
- 第 0 层清单与提交钩子：[SOURCE: docs/adr/0066-layer0-related-tests-declared.md#decision]
- 测试主机的目录和清理：[测试主机操作 Runbook](test-host-operations-runbook.md)

<a id="safety-and-preconditions"></a>

## Safety and Preconditions

- opencode 和 Grok 遵守 `AGENTS.md` 的全部规则：测试只在 Hermes 或云服务器的 `himawari-ci` 账号上跑，不在 MacBook 上；不以其他账号登录云服务器；不跑生产命令；不读密钥；提交推送规则不变。
- 本地未提交的 `.opencode/opencode.json`（经 `.git/info/exclude` 排除）是 opencode 的安全网，不是规则的替代品：
  - `bash` 块禁止命令文本里出现云服务器地址、生产步骤包装脚本、GitHub 读令牌及其目录、本地 `node`/`npm`/`npx`、强制推送、改写历史、`sudo`、Hermes 的 Tailscale 地址和直连 `hermes` 的 `ssh`、`scp`、`rsync`；`opencode` provider 保持启用，免费模型需要它（付费模型由启动脚本的白名单挡住）。
  - `external_directory` 块让读、写、编辑、搜索工具对仓库之外的路径默认拒绝，只放行 opencode 自己的 `~/.local/share/opencode/{shell,tool-output}/`、`$TMPDIR`、`/tmp`、`document-governance` 和 `long-task-planning` 两个 skill 目录、只读的 `pi-mono` 检出，最后再禁 `~/.ssh` 和钥匙串（2026-10-21 验证，探针记录在本地 `.ci-output/handoff/2026-10-21-extdir-verify/`）。它不管 shell 命令，也不解析允许目录下的符号链接，所以只是多一层，不是隔离。
  - `read` 块另外禁 `~/.ssh/**`、`*.pem`、`*.key`。
- Grok 用本地未提交的 `.grok/config.toml` 承载同样的禁止规则，仓库用 `grok --trust` 标记为可信，否则 Grok 不加载它。
- 按名字匹配的禁止规则也会拦住无害命令（例如 `ls` 一个名字命中的文件）。简报里要有一行以 `本地禁止规则：` 开头，列出会被拦的文字，并让代理改用读文件、按名查找和内容搜索工具；缺这一行时 `oc-launch.sh` 以 `BRIEF_NAMES_DENIED_TEXT` 拒绝启动。
- 第一个会改变目标的动作是启动 opencode 会话本身；日常批次由 ADR 0062 授权。生产相关的一切需要用户单独授权。

<a id="live-state-preflight"></a>

## Live-State Preflight

1. `python3 .agents/opencode-models.py check --all` 打印 `MODELS_IN_SYNC`；否则先 `export --all`。
2. `.opencode/required-plugins.txt` 列出 `.opencode/plugins/wait-guard/index.ts` 的 SHA-256；主检出和每个有 `.opencode/` 目录的 `.ci-output/worktrees/*/` 都有同一份插件和清单。启动脚本对缺失、被改或清单为空的情况分别以 `REQUIRED_PLUGIN_MISSING`、`REQUIRED_PLUGIN_CHANGED`、`REQUIRED_PLUGIN_LIST_EMPTY` 拒绝。
3. 包装脚本存在且可执行：`.ci-output/handoff/scripts/hermes-ssh.sh`、`hermes-upload.sh`、`hermes-wait.sh`、`require-quiet-host.sh`，`.ci-output/cloud-test-host-2026-10-14/ci-ssh.sh`、`ci-upload.sh`。改过包装脚本后先跑 `.ci-output/handoff/scripts/test-ssh-wrappers.sh`，它用一个只打印标记的替身 `ssh` 验证各条拒绝，不会碰真实主机。
4. 简报恰好指定一个尚未写出的停止文件（路径以 `stop.md` 或 `stop-<N>.md` 结尾）；否则 `STOP_FILE_UNCLEAR`。改代码的批次在“范围”一节挂长任务条目编号；只读批次（读代码出报告、审查文档）单独写一行 `只读任务：是`，启动脚本打印 `READ_ONLY_BRIEF` 并跳过条目检查。
5. 开新会话前查东京时间并按 ADR 0061 选模型和档位；报一行模型 ID、档位、时间、原因。

<a id="procedure"></a>

## Procedure

1. **启动。** `oc-launch.sh new <简报> <运行前缀> '<provider/model>#<档位>' <标题>`，运行前缀必须带目录（例如 `.ci-output/handoff/<日期>-<任务>-oc-<N>`），否则 `PREFIX_WITHOUT_DIRECTORY`。会话连到任务自己的服务（`oc-server.sh`，状态在 `<前缀目录>/oc-server/`，密码文件不打印不提交）。启动前脚本向这个服务实时查询模型的推理档位，打印 `LIVE_VARIANTS model=<模型> variants=<当前列表>`，档位不在列表里或低于 `.opencode/variant-floor.txt` 的下限就拒绝（[ADR 0065](../adr/0065-live-reasoning-variants.md)）。
2. **监视。** 用 `oc-watch.py <前缀> --stop-file <停止文件>` 挂监视；`CHECKPOINT:`、`QUESTION:`、`EDIT:`、`SIGNAL:`、`TOOL_ERROR:`、`STALL:` 各按 skill 的表处理。`SIGNAL: timeout` 常是代理在读含这个词的文件，先看命令再判断。
3. **纠正。** 把消息写成文件，用 `oc-steer.sh <前缀> <消息文件>` 在当前步骤后送达，或加 `--interrupt` 立即中断并带消息续跑。中断不会停掉代理在测试主机上后台启动的任务，消息里要说明怎么处理。
4. **代理连测试主机只用包装脚本。** `hermes-ssh.sh '<远程命令>'`、`ci-ssh.sh '<远程命令>'`（后者固定以 `himawari-ci` 登录）；传文件只用 `hermes-upload.sh` 或 `ci-upload.sh <本地文件> <远程路径>`，它们拒绝不存在的本地文件并比对两端 SHA-256，也拒绝运行 `local.mjs` 却不用 `layer3-verdict.py` 判定结果的脚本（退出码 72，见排障表）。每条远程命令固定 300 秒上限；命令以 base64 编码发送、在远端 shell 里解码，所以远端进程命令行不含命令文本。
5. **长任务后台启动。** 预计超过几分钟的工作写成主机上的脚本，用 `setsid -f bash -c 'echo $$ > <pid 文件>; exec bash <脚本>' > <日志> 2>&1 < /dev/null` 启动（`cd` 写在脚本里），再用 `hermes-wait.sh <日志> '<结束行文本>' <pid 文件>` 等待：它按固定文本匹配结束行并核对 PID。不要写 `cd <目录> && setsid nohup … &`，整条 `&&` 列表会被放进子 shell，它的输出仍占着 SSH 通道，调用会一直等到命令结束。
6. **检查命令的退出码。** 管道的退出码只来自最后一段；把输出写进文件，单独记下 `$?`，再显示尾部。只想知道有没有匹配时用 `grep -q`。
7. **结束。** 批次以停止文件为结束标志。读它的摘要，核实每条说法，在权限内裁决，写回复文件后用 `oc-launch.sh resume` 续跑同一会话；任务结束时 `oc-server.sh stop <前缀目录>/oc-server`。
8. **审查。** Claude 逐行审 opencode 的每个改动和它跑过的每条命令（事件流 `<前缀>.jsonl`），用 `longtask.py record --review --by claude` 记录；Claude 自己写的代码由 opencode 审，`--by opencode`。
9. **第 0 层清单和提交钩子。** 写第 0 层脚本前运行 `python3 "$(git rev-parse --git-common-dir)/hooks/check-layer0-tests.py" derive`（工作区相对 `HEAD`；`derive --staged` 看暂存区，`derive <提交>` 看某个提交），把列出的文件全部放进第 0 层，只可增加。改了 `apps/*/src/`、`packages/*/src/` 的提交，说明里每个第 0 层文件一行 `Layer-0-tests: <仓库相对路径>`，推导为空时写 `Layer-0-tests: none`。钩子装在仓库共享的 git 目录（`git rev-parse --git-common-dir` 下的 `hooks/`）：`check-layer0-tests.py`、`commit-msg`（`exec python3 "$common/hooks/check-layer0-tests.py" commit-msg "$1"`）、`pre-push`（`exec python3 "$common/hooks/check-layer0-tests.py" pre-push`），三个文件和自测的来源与 SHA-256 记在 [docs/lessons.md](../lessons.md#layer0-related-tests)；`git worktree` 建的工作树里 `.git` 是文件，脚本一律用共享 git 目录下的路径；新克隆或换机器后从 `.ci-output/handoff/l0-guard/` 复制安装，核对摘要，再跑一次自测（[ADR 0066](../adr/0066-layer0-related-tests-declared.md)）。

<a id="verification"></a>

## Verification

- 启动输出含 `started pid=… session=… model=…`；只读批次另有 `READ_ONLY_BRIEF`。
- 事件流里没有访问禁止主机或在 MacBook 上跑测试的命令；代理声称的测试确实在所述版本上跑过。
- `test-ssh-wrappers.sh` 对替身 `ssh` 全部打印 `ok`。
- `bash .ci-output/handoff/l0-guard/selftest.sh <仓库根目录>` 最后一行是 `SELFTEST passed=<数> failed=0`，退出码 0；它只用 git 和 Python，在本机跑，不是项目测试。
- 等待脚本的证据门禁（`evidence-gate.sh`，由 `oc-wait.sh` 调用）通过：本轮新增的证据里没有 `node_modules`、`.git`、含它们的压缩包或超过 50 MB 的文件，除非同目录的 `EVIDENCE-REASONS.txt` 写明 `文件名: 理由`。

<a id="evidence"></a>

## Evidence

- 每个批次的简报、停止文件、回复、事件流 `.jsonl`、纠正消息和 `.steer.log` 都留在 `.ci-output/handoff/`（本地，不提交），是审查记录。
- 不记录服务密码、密钥或含密钥的配置。
- 测试证据按[测试主机操作 Runbook 的证据规则](test-host-operations-runbook.md#evidence)保存。

<a id="rollback"></a>

## Rollback

- 停掉一个走偏的运行：先杀 `opencode run` 进程本身（`<前缀>.pid` 里是外层 shell，只杀它会留下孤儿进程），用 `ps -p <pid>` 确认，再决定是否续跑同一会话。
- 代理在测试主机上后台启动的任务要单独停：按它记录的 PID 文件处理，不按命令行文本匹配。
- 改坏了禁止清单或插件：从本地备份或最近一次通过 `test-ssh-wrappers.sh` 和 `REQUIRED_PLUGIN` 检查的副本恢复，并同步每个工作副本。

<a id="stop-conditions"></a>

## Stop Conditions

- 启动脚本以任一拒绝码退出（见排障表）。
- 事件流出现访问生产主机、以非 `himawari-ci` 账号登录云服务器、读密钥或在 MacBook 上跑测试的命令。
- 代理要求放宽检查或时限、下载新依赖、删除用户文件、做远端或生产操作：这些由用户决定。
- 同一错误第三次出现：按 ADR 0060 暂停并加硬约束。

<a id="troubleshooting"></a>

## Troubleshooting

| 现象 | 含义 | 处理 |
| --- | --- | --- |
| `MODEL_NOT_ALLOWED` | 模型不在 `.opencode/allowed-models.txt` 里（按整行比较，`-free` 不会放行付费同名模型） | 查 `.agents/opencode-models.toml`，必要时改表后 `export --all` |
| `VARIANT_UNAVAILABLE` / `MODEL_NOT_SERVED` / `VARIANT_LIST_UNAVAILABLE` | 请求的推理档位不在 opencode 服务实时列出的档位里 / 服务没列出这个模型 / 列表读不到（退出码 3） | 按拒绝信息里的当前档位列表重新选；服务异常时先 `oc-server.sh status` |
| `VARIANT_BELOW_FLOOR` / `VARIANT_FLOOR_UNKNOWN` | 档位低于 `.opencode/variant-floor.txt` 里该模型的最低档位或没带档位 / 下限本身不在实时列表里 | 选下限或更高的档位；下限过期就改表后 `export --all`（[ADR 0065](../adr/0065-live-reasoning-variants.md)） |
| `STOP_FILE_UNCLEAR` / `STOP_FILE_EXISTS` | 简报没指定恰好一个未写出的停止文件 / 续跑指定的停止文件已存在 | 改简报或换新的停止文件路径 |
| `BRIEF_NAMES_DENIED_TEXT` | 简报提到会被禁止规则拦下的文字，却没有 `本地禁止规则：` 行 | 加上这一行并说明改用读文件工具 |
| `REQUIRED_PLUGIN_MISSING` / `_CHANGED` / `_LIST_EMPTY` | 守卫插件或清单不一致 | 同步主检出和所有工作副本的插件与清单 |
| `check-brief refused the brief` | 改代码的简报没挂条目编号 | 挂条目；只读任务加 `只读任务：是` |
| 包装脚本退出 67 `*_BACKGROUND_REFUSED` | 远程命令写成 `… && setsid nohup … &` | 改为 `setsid -f`，`cd` 放进脚本 |
| 退出 69 `*_SELF_MATCH_REFUSED` | 远程命令用了 `pgrep -f` 或 `pkill -f` | 用记录的 PID 判断存活 |
| 提交时 `L0_RELATED_TESTS_UNDECLARED` | 改了产品源，提交说明没有任何 `Layer-0-tests:` 行 | 按列出的文件补跑第 0 层并逐行声明；推导为空时写 `Layer-0-tests: none` |
| 提交或推送时 `L0_RELATED_TESTS_OMITTED` | 声明行缺了推导出的文件（括号里是原因：引用、同名或整体替换的包导出有变） | 把列出的文件放进第 0 层跑过后补进声明；推送时报的是已提交的说明，用 `git commit --amend` 补（只限未推送的提交） |
| `L0_RELATED_TESTS_UNKNOWN` | 声明的路径不是 `ci/policy.json` 会收集的测试文件，或 `none` 和路径混写 | 改成仓库相对路径（可带 `./`），被排除的测试不要写进声明 |
| `L0_RELATED_TESTS_ERROR`（退出 2） | git 读不出对象、`ci/policy.json` 或 `package.json` 不可用、说明文件读不出、推送输入格式异常 | 按信息修好再提交；检查出错一律当拒绝，不要用 `--no-verify` 绕过 |
| `L0_RELATED_TESTS_SKIPPED_MERGE` | 合并提交不做这项检查（只在用户要求合并时出现） | 无需处理；合并里解决冲突改了产品源时，在说明里照常声明 |
| 退出 70 `MASKED_STATUS_REFUSED` | 输出过滤器（`tail`、`head`、无 `-q` 的 `grep`、`sed`、`tee`）结尾的管道后面跟了 `&&`、`\|\|`（`\|\| true` 除外）或 `$?`，且没设 `pipefail` | 输出写文件、单独记 `$?`、再看尾部 |
| 退出 71 `*_LONG_WAIT_REFUSED` / `WAIT_GUARD_REFUSED:` | 一条前台命令里同步等待：工具时限 0 或超过 300000 ms、`sleep` 合计超过 30 秒（含包装脚本的远程命令和 `bash -c`、`python3 -c` 正文）、`sleep(` 超过 30、含 `sleep` 的循环、含这些内容的本地脚本（只有仓库自己的 `hermes-wait.sh` 按真实路径豁免）、opencode 的 `execute` 工具；`setsid -f` 或后台启动的部分不检查 | 后台启动并用 `hermes-wait.sh` 等待 |
| 上传入口退出 72 `*_LAYER3_VERDICT_MISSING` | 要上传的文件里出现 `local.mjs`（项目的本地 CI 入口脚本），却没有出现 `layer3-verdict.py`。本地跑 `local.mjs` 时，即使构建和测试全过，发布步骤也会因连不上安全审查服务（`SECURITY_REVIEW_HTTP_NOT_FOUND`）让它以 1 退出，按退出码判定会把通过当失败 | 第 3 层的结果改由 `layer3-verdict.py <local-summary.json> <被测提交> build,test` 读报告判定；退出码只接受 0 和 1，其他值（例如被杀掉的 137）直接算失败。只在说明文字里提到 `local.mjs` 的脚本也会被拦，改掉那段文字即可 |
| 上传后远端文件为空 | 用 `cat >`、`tee`、`dd of=` 把标准输入写进远端文件 | 包装脚本已拒绝这种写法；先把文件写好再 `*-upload.sh` |
| Claude 本地命令被 `zsh_word_guard.py` 拦下 | `~/.claude/hooks/` 的 `PreToolUse` 钩子做同样的管道检查 | 按提示改写，不要换写法绕过 |
