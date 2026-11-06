# PR 260 代码复核（三轮累计，HEAD = 59704799）

## 结论摘要
三轮改动与代码一致，未发现「说法与代码不符」的硬伤；发现 1 处文档与代码不一致、若干作者已自报或我补查的测试/验证缺口。随后逐条回答必答问题。

---

## 问题清单（按严重度从高到低）

**1. 中｜docs/runbooks/hermes-self-hosted-runner-runbook.md:124｜Runbook 说被中断也会打印 `INSTALL_STEP_FAILED`，代码不会**
- 证据（读代码证实）：install-runner.sh:44 `[ -z "${1:-}" ] || echo "INSTALL_STEP_FAILED $1" >&2` —— 不传参就不打印；install-runner.sh:55 `trap 'restore_backup; exit 130' INT TERM HUP` —— 中断路径调用 `restore_backup` 时不带参数，所以 Ctrl-C/TERM/HUP 只打印 `INSTALL_FAILED`，不打印 `INSTALL_STEP_FAILED line <行号> exit <退出码>: <命令>`。而 Runbook 第 124 行写「之后任何一步失败**或脚本被中断**（Ctrl-C、TERM、HUP）……都会……并**先打印出错的那一步** `INSTALL_STEP_FAILED line <行号> exit <退出码>: <命令>`」。测试也只对退出码 1 断言这一行（hermes-runner-scripts.test.mjs:1183 的 `if (code === "1")`），对 130 无此断言，与代码一致、与文档不符。
- 建议：改 Runbook 措辞为「失败时先打印那一步；被中断时不打印（中断没有对应的步骤和退出码）」。

**2. 低｜scripts/operations/hermes-runner/install-runner.sh:54｜失败行号属于哪个文件未注明（推测，未实测）**
- 证据（读到的代码）：trap 传入 `line $LINENO exit $status: $BASH_COMMAND`；有错的一步常在 source 进来的 `runners.sh` 里（如 runners.sh:169、180 的 `… || return 1`，这正是测试里 `return 1` 的来源，hermes-runner-scripts.test.mjs:1183）。推测：`$LINENO` 在 ERR trap 里对 sourced 文件内的命令给出该文件的行号（bash 行为），报出的行号会指向 runners.sh 而不是 install-runner.sh；Runbook 只写「line <行号>」没说归属哪个文件，对照排查时可能对错文件。我没有运行脚本，无法证实。
- 建议：下次真机安装时看一眼输出，在 Runbook 一句话注明「行号可能是 runners.sh 的」。

**3. 低｜docs/runbooks/hermes-self-hosted-runner-runbook.md:5｜`contract_sha256` 复核者无法核实**
- 证据：两轮提交（57910cd、5970479）都同步改了 Runbook 与脚本并更新封存（`git show 5970479 -- docs/runbooks/...` 显示 349b1bef → 1904baac，符合 document-governance.md:56 的「同一提交重新封存」要求）。但封存值是对 `scripts/operations/hermes-runner` 内容的摘要（runbook-contract 清单，runbook:13-15），我按复核约束不能运行 `runbook.py` 计算，此值与最终脚本内容是否一致**未核实**（作者在提交说明里也称用 `runbook.py check` 通过）。这是流程性缺口：任何单靠 review 工具的复核都验不了这个值。

**4. 低｜scripts/operations/hermes-runner/resume-runners.sh:39-55｜「撤销一次没完成的暂停」路径下新顺序治不了旧病（推测+证据混合）**
- 证据：pause-runners.sh 在暂停未完成时保留标签去除、服务仍在跑（Runbook:145）；此时运行 resume-runners.sh，对账通过后 20-22 行直接加标签，runner 一直在线，因此 39-55 的等待循环立即通过、打印 `RUNNER_RESUMED` 退出码 0——**从不重启这个一直在线的服务**。若作者的推断（GitHub 只在 runner 连上时按当时标签匹配排队任务）成立，这个会话是在无标签时建立的，补加标签后排队任务仍可能不派；脚本一路显示成功。Runbook:146 末句给了手动补救（重启其中一个服务），但封面写着「labels=restored」、退出码 0，操作者会以为已经恢复。
- 建议：可以在 resume 里检测「加标签前 GitHub 上该 runner 已 online」并在报告里提示这一残余情况（现第 28 行的提示只覆盖启动失败路径），供 Andy 决定是否改。

**5. 低｜test/tooling/hermes-runner-scripts.test.mjs｜恢复脚本仍有无自动覆盖的路径**
- 读代码证实：resume-runners.sh:9/10/11 三条开头错误路径（上传失败、列表失败、GitHub 列表失败）无 resume 用例（作者已在 5970479 提交说明里列为「可以更好、未改」，属实）；我补查发现：resume 侧从不直接测锁（「refuses to run while another pause or resume holds the lock」和「releases the lock」两条都只调用 pause-runners.sh，共享的 `take_lock`/mac-runners.sh:8-14），以及 `service_states` 失败时 resume 的 `services=unknown` 分支（resume-runners.sh:28、36、50 里都有）无 resume 用例。风险低（函数与 pause 共用且 pause 覆盖了这些分支），列出来只为闭环。

**6. 信息｜vitest.workspace.ts:6,23,37｜删掉的两段注释没有另找地方保留**
- 作者在第 3 轮提交说明中已如实列出为「列给 Andy」。`integration` 30 秒与 `tooling` 15 秒的理由现在在 ADR 0168、instructions、Runbook、架构文档、质量门规格 5 处，语义没丢；仅原文件内的就地说明消失，无测试引用过这些注释（grep「Tooling owns synthetic」无结果）。

---

## 侧重检查（我走的流程与结论）
**流程：恢复一次暂停的操作全链**——入口 `resume-runners.sh`（Mac，bash 3.2 要求）→ `take_lock` → `upload_runner_scripts` → `runner-pause.sh --list` → `github_runners`+`reconcile_runners` → 加标签循环 → 回读确认（读不到即退出，不启服务）→ `runner-resume.sh`（只 start 已注册的）→ 5 分钟轮询 `online` → `RUNNER_RESUMED`。
- 已覆盖（读测试逐一核对到分支）：主链 499-518、对账不匹配 520-551、服务未起 553-563、超时未上线 565-574、打断（加标签中 576-584、等上线中 586-595）、回读 GitHub 失败不启服务 606-617、加标签失败 619-631。
- 未覆盖：见前面第 5 条（前三条开头错误路径、resume 侧锁、`services=unknown`）；这与作者自报一致，我又加了两条。
- 「旧顺序跑新测试**恰好 6 条失败**」我逐条推演核实：按首提交 90468d8 时的用例正是 6 条（顺序、服务未起、未上线、等上线中被打断、GitHub 读不到（fail-list-from 由 2 改 3 的用例）、加标签失败）；按本次 HEAD 的最终用例算则是 **7 条**（第 2 轮又新增了「回读失败不启动服务」用例）。作者说法按当时成立，不算错。
- 文档一致性：ADR 0168 决定第 3 条、ADR 0169 决定第 5 条与后果/测试清单、`.agents/instructions/test-and-production-hosts.md:14`、architecture-v0.1.md:621、docs/execution/specs/2026-09-03:151、test-host-operations-runbook.md:61——全部与 `vitest.workspace.ts` 的 30s/15s 及恢复新顺序一致（逐处读过 diff）。Runbook:146 的恢复描述与脚本逐段对上。
- bash 3.2 兼容：读了 resume-runners.sh、install-runner.sh、mac-runners.sh，未见 bash ≥4 构造（`${BASH_SOURCE[0]%/*}`、`case`、`trap - ERR` 都是 3.2 能跑的）；**未实测**（Mac 验证被用户无限期推迟，此为规则允许的未验证项）。

## 必答问题

**1. 会不会改变模型已见过的请求开头？——不会（读代码证实）。** 本 diff 的代码部分只有 shell 脚本、`vitest.workspace.ts`、测试和文档，全部走 git diff 逐行看过：没有系统提示、工具定义、历史消息或遮盖（masking）相关的任何代码被触及；`.agents/reviews/*` 与 `.agents/tasks/*` 的改动全是新增记录文件。`vitest.workspace.ts` 删注释只改 CI 配置文件本身。「发给模型的内容只追加」规则所引用的 `.claude/rules/prompt-prefix.md` 在本仓库中不存在（glob 无结果），无法在仓库内核对该规则文本——按其内容评估：本改动不产生「每轮会变的值」，因而不影响。

**2. 会不会让同一段文字在不同请求里变成不同字节？——不会（读代码证实）。** 新增值（消息字符串 resume-runners.sh:28/36/50、`testTimeout: 15_000`、`INSTALL_STEP_FAILED` 行）都不依赖前后文遮盖、不含时间戳、不引入无序集合；`restore_backup` 里的 `date +%Y%m%dT%H%M%S`（install-runner.sh:36）是基准前就有的旧代码，语义未变。本次没有任何值会进入发给模型的请求。

**3. 有没有对应自动检查、反向用例会真失败？——有，已逐条对照旧版本核实（读代码证实，未运行）。** 同一 PR 的 hermes-runner-scripts.test.mjs 用 macBox 假 `gh`/`hermes-ssh.sh` 覆盖新顺序全部新分支（含「不启动服务」新增用例 test:606-617）；test-timeout.test.mjs:36-45 锁住 30s/15s/默认三值。反向验证：用 `git show a429ff0:...` 读到三份旧工件，推演出旧 resume 脚本会让上述用例失败（6 条/首提交口径，见侧重检查）、旧 install-runner.sh 无 `INSTALL_STEP_FAILED` 导致 test:1183 断言失败、旧 vitest 配置缺 `tooling` 的 15000 使 test-timeout 失败。作者三条「旧构件跑新检查失败」的说法成立。

**4. 每个产生/使用的值两端都能接受吗？——逐一对过，除两处小问题外均成立（读代码证实）。**
- `testTimeout: 15_000`（vitest.workspace.ts:46）：生产端=vitest 运行时；检验端=test-timeout.test.mjs:39；文档端=ADR 0168/instructions/runbook/规格/架构 5 处，措辞一致（包括作者在第 2 轮改掉的「唯一例外」错误说法，“integration 原本就是 30 秒” 这层订正确实落到了全部 cited 处）。
- `INSTALL_STEP_FAILED line <行号> exit <退出码>: <命令>`（install-runner.sh:44）：检验端 test:1183（含 `return 1` 变体，与 runners.sh:169/180 的 `… || return 1` 来源对上，Runbook 也写了该例外）；文档端 Runbook:124 —— 除「中断也打印」一处过度陈述（问题 1）成立。
- resume 消息串（resume-runners.sh:28/36/50/55）：检验端 test:560/572/612/625/503 精确匹配；文档端 Runbook:146 用中文转述，语义逐条对上（`labels=restored` 在「服务没起/没上线」时如实——加标签已回读确认才会走到这两处，代码 20-31 保证）。两处小问题：问题 1（Runbook 中断措辞）、问题 4（undo-pause 路径的 truthful-inform 观感）。
- `contract_sha256`：流程上两次都按治理规则同提交重封，但值本身未核实（复核工具跑不了封存脚本，见问题 3）。
- 依据 I-73（docs/incidents-and-gates.md:112：复核不能只看 diff、要问「改出来的值能否过使用端校验」）：本 PR 的值没有「发给后端校验」的那类（无清单 id/序列化格式），使用端检查如上；未发现 I-73 型遗漏。
