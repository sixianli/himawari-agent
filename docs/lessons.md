---
status: active
document_type: lessons
supersedes: ""
superseded_by: ""
date: "2026-10-13"
---

# 编码代理反复犯的错误

本文只记录编码代理（Claude、Codex、opencode 等替用户写代码和跑测试的程序）同一类错误犯过两次以上的情况，以及防止再犯的明确规则。项目状态、一次性事件和以后要做的事不写在这里；以后要做的事见 Backlog。

目录：

- [演练把生产里不同的东西合成了一个](#merged-in-rehearsal)
- [从中途续做的修订版没核对跨步骤的摘要比较](#resume-digest-checks)
- [在 Hermes 上生成后续要用的文件时没设 umask 022](#hermes-umask)
- [进入冻结包目录后留下 `.claude` 目录](#claude-dir-in-packet)
- [在工作目录里封存 Runbook，把本地 `.DS_Store` 算进摘要](#seal-in-working-tree)
- [审核时直接采信代理自报的检查结果](#trust-reported-checks)
- [保存失败现场时整目录打包、重复复制输入材料](#bulky-evidence)
- [用补丁搭出来的树和要验证的提交不一致](#patch-tree-mismatch)
- [对照测量或完整测试时机器上还有别的负载或上一次实验的残留](#measurement-not-isolated)
- [文件还没写好就上传到测试主机](#upload-before-written)
- [新代码里加了代码注释](#new-code-comments)
- [操作包里写死的摘要和文件清单没跟着内容更新](#stale-packet-pins)
- [代理在一条命令里同步等待长时间运行，会话被中断](#long-blocking-wait)

<a id="merged-in-rehearsal"></a>

## 演练把生产里不同的东西合成了一个

- 反复出现的情况：为了在 Hermes 上跑生产脚本，测试把生产路径替换成测试路径时，把生产上本来不同的两样东西换成了同一样，于是只在“两样东西不同”时才出现的缺陷测不出来。
- 为什么要紧：每次都是到生产上第一次运行那一步才暴露，每个问题从诊断、修复、审核到重新上线大约要 1.5–2 小时，而且失败会留下要处理的现场。
- 预防规则：
  - 写或审核演练时，先列出生产上有哪些不同的实体（不同发布目录里的驱动副本、不同版本的 `bindings.json`、不同的构建环境），确认演练里它们仍然不同；不能保持不同时，在任务说明里写明这个缺口，并补一个专门让它们不同的夹具。
  - 夹具里的期望值必须来自真实契约（生产报告、被检查的那段源码里的字面量、材料文件），不能取被测脚本自己的常量。
- 再次发生的证据：
  - 2026-10-13 第三次部署 S5 第一次失败：形状链把新旧两个运行时映射成同一个，没发现同一进程加载两份 `better-sqlite3` 时第二份不认 URI 文件名（见 `.ci-output/handoff/2026-10-12-third-packet-progress.md`）。
  - 同日 S5 第二次失败：形状链里 S3 和 S5 一直用同一份 `bindings.json`，没发现修订版换了 `bindings.json` 后 S5 拒绝 S3 的报告。
  - 同日审核修订版 03 时发现：发布夹具用发布脚本自己的 `FAILED_CONDITION` 造“生产失败报告”，常量多写了 `DEPLOY_` 仍然通过。

[回到目录](#编码代理反复犯的错误)

<a id="resume-digest-checks"></a>

## 从中途续做的修订版没核对跨步骤的摘要比较

- 反复出现的情况：部署包出修订版、从某一步之后续做时，没有逐一检查“后面的步骤拿前面步骤的报告和当前 `bindings.json` 摘要比较”的地方。新冻结换了 `bindings.json`，这些比较必然失败。
- 为什么要紧：前面的步骤往往已经改过生产数据，不能重跑，只能再出一个修订版；而再出修订版又会换一次 `bindings.json`，可能让已经通过的步骤的报告也对不上。
- 预防规则：
  - 设计修订版之前，用 `grep` 列出包里所有比较 `bindingSha256`、`bindingsSha256`、`freezeSha256` 的地方，逐一写明比较的报告是在哪个冻结下生成的、修订后是否还成立。
  - 修订记录要写明每份旧报告对应的 `bindings` 摘要（例如 `s3BindingsSha256`），检查代码按修订记录比较。
  - 已有步骤在当前冻结下改过生产数据之后，优先用不改冻结包的包外工具处理后续问题，再出修订版前先确认不会让这些步骤的报告失效。
  - 演练要真实模拟“前面的步骤在旧冻结下完成 → 换成新冻结 → 后面的步骤继续”。
- 再次发生的证据：
  - 2026-10-13 修订版 02 上线后 S5 以 `THIRD_MAINTENANCE_RECOVERY_BINDING_CHANGED` 失败。
  - 同日 S6 失败后，第一版修复方案又是出修订版 04；核对后发现 `systemd/S7-switch-start-readback.py` 会因 S5 报告的摘要不符而失败，改成了包外工具。

[回到目录](#编码代理反复犯的错误)

<a id="hermes-umask"></a>

## 在 Hermes 上生成后续要用的文件时没设 umask 022

- 反复出现的情况：Hermes 登录账号默认的 umask（新建文件时默认去掉哪些权限位）是 `0002`，在这个设置下新建的文件和目录是同组可写；忘了先设 `umask 022`，后面要求“不可组写”的检查就会拒绝它们。
- 为什么要紧：权限会被记录进源码树摘要和材料文件，等到生产上才被拒绝时，只能另写工具在生产上收紧权限。
- 预防规则：
  - 在 Hermes 上跑测试、构建候选包、生成或采集材料（例如 `materials/source-build-inputs.json`）之前，一律先 `umask 022`，并在脚本里检查 `umask` 的值。
  - 冻结前检查材料里记录的文件权限，不能有同组或其他人可写的位。
- 再次发生的证据：
  - 2026-10-01 约 100 个测试因 `SANDBOX_HOST_PATH_UNSAFE` 失败，原因是测试目录同组可写（AGENTS.md 已写入 `umask 022` 规则）。
  - 2026-10-13 第三次部署 S6 以 `PUBLIC_FILE_UNSAFE` 失败：第三次候选包的构建源码记录 619 个文件全是 `664`。
  - 2026-10-15 第 29 批两次：在 Hermes 检出上用 `git apply` 重写文件后，权限变成 `664`，而源码树摘要包含权限位，安装候选包时以 `ARTIFACT_BUILD_INPUT_MISMATCH` 失败（停止文件 29a 第 5 节、29d 第 5 节；证据 `/data/hermes/himawari/tool-audit-round2/r2fix29/evidence/run-20-layer2-product-path`）。
- 第三次以后的根因：`umask 022` 只管新建的文件；SSH 会话里改写已有文件、或忘了在交互命令里设 umask，权限照样漂移，靠记住设置拦不住。
- 硬约束（2026-10-15）：`.ci-output/handoff/scripts/require-git-modes.sh <检出>` 把 git 登记的文件权限恢复成 644/755 并复查，仍不一致就以退出码 3 结束。第 3 层脚本 `run-l3.sh`（完整测试，同时构建候选包）和不过滤第 4 层脚本 `run-l4f2.sh`（安装候选包）开跑前都调用它，失败就不运行（Hermes 上的副本在 `~/himawari-tests/r2-u1/`）。验证：临时仓库里把两个文件改成 `664`/`775`，脚本输出 `GIT_MODES_OK fixed=2`，权限回到 `644`/`755`，再跑一次输出 `fixed=0`；未加约束时的失败见上面的 run-20。

[回到目录](#编码代理反复犯的错误)

<a id="claude-dir-in-packet"></a>

## 进入冻结包目录后留下 `.claude` 目录

- 反复出现的情况：Claude Code 的工作目录切换到某个目录后，会在那里自动建一个空的 `.claude/.cc-writes` 目录。在 shell 命令里 `cd` 进部署包目录，就会在包里留下它。
- 为什么要紧：冻结和本地发布核对要求包里没有多余的成员，这类目录还会被复制进下一个修订版的包。
- 预防规则：不要 `cd` 进 `.ci-output/production/` 下的部署包目录，也不要 `cd` 进仓库里的源码、文档和测试目录；一律用仓库根目录出发的路径操作。冻结、复制包和上传前用 `find <包目录> -name .claude` 检查。主工作区的严格文档校验报 Runbook 摘要不匹配、同一提交在干净检出上却通过时，先用 `find . -path ./node_modules -prune -o -path ./.ci-output -prune -o -name .cc-writes -print` 找这类空目录，确认没有进程占用后用 `rmdir` 删除；不要因此重新封存 Runbook。
- 再次发生的证据：
  - 2026-10-13 先后在 packet-02、packet-03（两次）里发现并删除了这个空目录。
  - 2026-10-14 主工作区严格校验报 6 个 Runbook 的 `contract_sha256` 不匹配，同一提交 `24720138` 在干净检出上是 0 个错误。原因是更早的会话在 `packages/persistence-sqlite/src/migrations/` 等 23 个目录里留下了 `.claude/.cc-writes`，Runbook 遍历依据目录时把它们算了进去。
  - 2026-10-14 清理证据时，Claude 两次在命令开头写 `cd .ci-output/handoff/<证据目录>`，会话工作目录随之切过去，`baselines/` 和 `prod-sandbox-evidence-01a/` 里各多出一个 `.claude/.cc-writes`（当场 `rmdir`）。对证据目录同样只用从仓库根目录出发的路径；确实要换目录时写在子 shell 里，例如 `( cd <目录> && <命令> )`，命令结束后工作目录不变。
- 根因（2026-10-14 按 G106 第三次以上出现后分析）：Bash 工具会把 `cd` 后的目录保留到下一条命令，Claude Code 把它当成新的工作目录并在那里建 `.claude/.cc-writes`。前面的预防只是“记住不要 `cd`”，而写命令时习惯先 `cd`，所以一再发生。
- 硬约束（G107）：
  - 源头：本机项目设置 `.claude/settings.local.json`（不进 git）的 `env` 设 `CLAUDE_BASH_MAINTAIN_PROJECT_WORKING_DIR=1`，每条 Bash 命令结束后工作目录回到项目根目录。2026-10-14 实测：`cd docs` 后下一条命令的 `pwd` 是项目根目录，`docs` 下没有出现 `.claude`。
  - 门禁：本机 `.git/hooks/pre-commit`（主工作区和所有 `git worktree` 共用，Claude、opencode、Grok 的提交都会经过）在仓库根目录以下（不含根目录自己的 `.claude`、`.git`、`.ci-output`、`node_modules`）发现 `.cc-writes` 目录就拒绝提交并列出路径。2026-10-14 实测：干净时返回 0；在 `packages/persistence-sqlite/src/migrations/` 和工作副本 `r2p1/docs/` 里放入后返回 1；删掉后返回 0。
  - 这两项都只在这台 Mac 上；换电脑或重新克隆仓库时要重新设置。

[回到目录](#编码代理反复犯的错误)

<a id="seal-in-working-tree"></a>

## 在工作目录里封存 Runbook，把本地 `.DS_Store` 算进摘要

- 反复出现的情况：Runbook（运维操作手册）的依据文件里有整个目录（例如 `apps/agent-service/src`）。封存脚本 `runbook.py seal` 计算摘要时会把目录里所有文件都算进去，包括 macOS 访达自动生成、被 git 忽略的 `.DS_Store`。在 Mac 的工作目录里直接封存，记下的摘要就只在这台 Mac 上对得上；干净检出（CI 或另一台机器）上严格校验会报 `contract_sha256 does not match`。
- 为什么要紧：每次都要重新查一遍是哪些 Runbook 真漂移、哪些只是本地文件造成的，还会把真正的漂移藏在这些假错误里。
- 预防规则：封存和严格校验都在干净副本上做：`git archive HEAD | tar -x -C <新建的临时目录>`（或只复制 `git ls-files` 列出的文件），在副本里 `runbook.py seal <副本> <Runbook> --confirm-reconciled --apply`，把改好的 Runbook 复制回仓库，再在副本上确认 0 错误。新建临时目录失败时立即停止，不能让复制目标变成空字符串。报告校验结果时说明是在干净副本上得到的。
- 再次发生的证据：
  - `12b4f9d` 封存的 `hermes-control-center-upgrade-runbook.md`、`install-start-stop-runbook.md` 在干净检出上从一开始就不通过。
  - 2026-10-13 opencode 在 `feff37b` 里于工作目录重新封存 4 个 Runbook，自报“降到 2 个错误”，干净检出上却从 2 个变成 4 个；Claude 在 `fae0a0d` 于干净副本上重新封存后为 0 个。

[回到目录](#编码代理反复犯的错误)

<a id="trust-reported-checks"></a>

## 审核时直接采信代理自报的检查结果

- 反复出现的情况：受托写代码的代理（opencode、Codex）在停止文件（代理停下来交给审核方的书面报告）里写“检查通过”“错误降到几个”“已清理某目录”，审核的一方（Claude）照单接受，没有在被审核的那个提交上找原始日志或自己重跑一次。代理得到的结果常常来自另一份代码（未提交的工作目录、旧提交加补丁、带本地文件的目录），或者命令还没跑完就写了结论。
- 为什么要紧：错误的“通过”会跟着提交进入下一批，等到后面某次检查或生产步骤失败时才暴露，那时要回头查是哪一批引入的；审核记录也会因此写错。
- 预防规则：
  - 审核结论依赖的每一项检查结果（`npm run check` 这条提交前必跑的格式、类型和规则检查，文档严格校验、测试通过数），都要找到它在**被审核提交**上的原始日志，或在测试服务器 Hermes 上对该提交的文件自己重跑一次；只看到停止文件里的数字时，判定为“未核实”，不能写进审核记录。
  - 停止文件引用的日志、附录、证据编号必须真实存在；缺失的一律退回。
  - 写审核结论前，在测试主机上列出仍在运行的测试进程，确认停止文件描述的测试确实已经结束。
  - 看测试结果时同时看用时和预算的差距，余量很小时立即记下，不等超时才发现。
- 再次发生的证据：
  - 2026-10-13 opencode 在 `feff37b` 自报文档校验“从 6 个错误降到 2 个”，干净检出上实际是从 2 个变成 4 个（见上一条）。
  - 同日 R2-T1 的停止文件写 `npm run check` 通过，Claude 审核通过（`e00e641`）；第 20 批核实，`e00e641` 的 `test/integration/product-path-browser.test.ts` 按 `biome lint --error-on-warnings` 退出码为 1。
  - 同日第 20 批停止文件在它启动的 `npm test` 只跑了几分钟时写成，声称已删除该测试正在使用的输出目录，并引用了文件里不存在的“补记”一节；Claude 等测试跑完后才得到真实结果（30 分钟预算超时，另立 R2-T4）。之前一批的第 3 层（构建加完整测试 `npm test`）已用掉 1800 秒预算中的 1779 秒，当时没人注意余量。
  - 2026-10-14 R2-P1 第一段的停止文件在“失败模式和边界表”里写“路径组件 `.git`/`.env`/`.himawari-*` 拒绝”，代码里共用名单没有 `.git`，主进程路径会读出 `.git/config`；又写“根身份与 Grant 不符则拒绝，有测试覆盖”，那个测试用的假身份 `1:1` 只靠设备号不同就通过，代码实际没核对 inode。两处都是 Claude 逐行读代码时发现的，已退回返工。表格里的“实测”一列只能写真正跑过、并且确实覆盖这一行情形的用例名。

[回到目录](#编码代理反复犯的错误)

<a id="bulky-evidence"></a>

## 保存失败现场时整目录打包、重复复制输入材料

- 反复出现的情况：规则要求“失败现场要保留”，代理（Codex、opencode）为了省事，把整个临时目录原样打包，或者在每个批次、每份快照里各复制一份同样的输入材料，没有挑出真正需要保留的部分。打进去的大多是能按提交号或锁文件重新得到的东西：`node_modules`（npm 安装的第三方依赖）、项目源码副本、构建好的安装包。
- 为什么要紧：开发用的 Mac 和 Hermes 的根盘空间都很紧。2026-10-14 Mac 磁盘一度只剩约 100 MB，正在运行的 opencode 因此异常终止；`.ci-output/handoff/` 积累到 3.7 GiB，其中大部分是可以重建的内容。真正的失败证据（报告、日志、状态读回）反而被淹没在里面，查找困难。
- 预防规则：
  - 保存失败现场时，先单独保存报告、日志、状态读回和测试输出；临时目录里的 `node_modules`、`.git` 和与某个提交完全相同的源码副本不打包，只保留一份清单（路径、大小、SHA-256）并写明对应的提交号和锁文件，供以后重建核对。与提交不同或多出来的文件照常保留。
  - 同一份输入材料（安装包、源码 bundle、依赖压缩包）在整个任务里只存一份；其他地方写引用文件，记下 SHA-256 和那一份的位置，不再复制。
  - 内容相近的大型诊断输出（例如每种权限组合各一份的完整文件清单）只保留一份完整版，其余保存相对它的差异。
  - 写任务简报时把上面三条写进证据要求；审核停止文件时检查证据目录的大小，单个证据文件超过 50 MB 或一次运行的证据超过 100 MB 就问清楚原因。
- 再次发生的证据：
  - `prod-third-evidence-01` 里 6 个 `scratch-failure.tar.gz` 各约 262 MB，每个都是整个临时目录的打包：约 6.08 亿字节是 `node_modules`，约 1.4 亿字节是源码副本，验收用的虚构文件只有几百字节；真正的失败报告本来就单独放在压缩包旁边。
  - 同一目录的 `baselines/packet-02-before-oc-11/materials/` 和 `packet-03-before-oc-13/materials/` 各 352 MB，与 `.ci-output/production/2026-10-12-third-deploy-packet-0*/materials/` 里的同名文件 SHA-256 完全相同。
  - `prod-sandbox-evidence-01a` 里十几个约 14 MB 的 JSON，是同一个安装诊断在每种权限组合下各列一遍 3.3–3.7 万个文件的权限，内容大部分相同。
  - 2026-10-14 Claude 自己的第 3 层脚本把约 66 MB、能按提交重建的构建产物包复制进了 Hermes 的 `run-44` 证据目录；同日门禁在云服务器测试账号的 `r2e4/run-01-calibration` 里查出同样的产物包，在 Hermes 的 `third-materials-01` 里查出展开的 `node_modules`。
- 硬约束（G107，2026-10-14）：`opencode-orchestration` skill 的 `scripts/evidence-gate.sh`。`oc-wait.sh`（opencode 批次）和 `grok-wait.sh`（Grok 批次）每次被叫醒都会运行它，检查本轮新增的证据，范围是交接目录，加上 `.ci-output/handoff/evidence-roots.txt` 列出的 Hermes 和云服务器证据目录。出现以下任一情况，等待脚本以退出码 3 结束，这一批不被接受：
  - 新增 `node_modules` 或 `.git` 目录；
  - 新增含它们的压缩包；
  - 新增超过 50 MB 的文件，而同目录 `EVIDENCE-REASONS.txt` 里没有“`文件名: 理由`”；
  - 列出的证据目录连不上或不存在。

  判断“新增”用 ctime（文件在本机出现的时间），保留原时间的复制也算新增。skill 的 41 条测试覆盖了这些情况，新测试在脚本写出之前全部失败。

[回到目录](#编码代理反复犯的错误)

<a id="patch-tree-mismatch"></a>

## 用补丁搭出来的树和要验证的提交不一致

- 反复出现的情况：把要验证的改动做成补丁、在检出上 `git apply` 后再跑检查或测试，但补丁来自 `git diff HEAD -- <路径>`，**新增的未跟踪文件不在补丁里**；或者检出停在了别的提交上使补丁只应用了一部分。于是检查跑在一棵缺文件（或内容不同）的树上，问题不会被发现，却会被当成“已验证”。
- 为什么要紧：这次让一个格式错误随提交进了远端（`935a64da` 的新 `.mjs` 夹具没被 `npm run check` 看到，直到下一次检查才发现），也让一次方案补丁在错误的基线上失败。
- 预防规则：
  - 生成补丁前用 `git add -N <新文件>`（只把新文件登记进 git、不暂存内容，这样 `git diff` 会把它算进去）或先 `git add` 再 `git diff --cached`，确保新增文件在补丁里；应用后用 `git status --porcelain` 核对工作树内容与目标提交一致（含新增文件）。
  - 断言“检查跑的就是要提交的内容”：在跑检查/测试的脚本里 `git log --oneline -1` 并打印 `git status --porcelain` 的行数，异常就停下。
- 再次发生的证据：
  - 2026-10-14 第 22 批：`i1.patch` 因检出停在旧提交而 `patch does not apply`（未提交，当时修正）。
  - 同日：`r7.patch` 不含新增的 `test/fixtures/durable-phase-child.mjs`，第 1 层检查在缺该文件的树上通过；该文件的格式错误随 `935a64da` 提交，最终在 `run-62-check-both2` 才被 `biome format` 报出。

[回到目录](#编码代理反复犯的错误)

<a id="measurement-not-isolated"></a>

## 对照测量或完整测试时机器上还有别的负载或上一次实验的残留

- 反复出现的情况：用同一台机器做“改前/改后”或“负载下”的对照测量，但机器上还有脚本自己先前留下的后台循环、或者上一次实验的进程还没结束，两次测量的负载差别很大，结论不可用。
- 为什么要紧：这次两次测量各花约 25 分钟，结论都作废（一次是上一轮脚本的 `churn` 解包循环仍在跑；一次是两个 `integration` 项目同时在跑），还差点把它当成“修复无效”。
- 预防规则：
  - 启动负载或对照测量前，先列出并结束本任务的残留进程（`pgrep -u <账号> -af "<本任务脚本名>"`），确认只剩本次要跑的东西。
  - 后台脚本用 `setsid` 的同时记录自己的 PID，结束时按 PID 收尾自己的子进程（例如 `wait <PID>`、`kill <PID>`），不要用会漏掉同名子进程的宽泛 `pkill` 模式。
  - 测量把当时的系统平均负载（`loadavg`，正在运行和排队等待的进程数）、进程清单和测试临时目录的最大占用一并写进证据，便于事后判断两次是否可比。
- 再次发生的证据：
  - 2026-10-14 第 22 批：`run-46-diag-project` 与 `run-47-r7-after` 的测量期间，上一轮的 `tar` 解包循环仍在运行（PID 1979642/1979643，21 分钟），两次结论作废。
  - 同日：`run-49-r7-after` 的测量期间，`run-46` 的 `integration` 项目仍在运行，同一台机器上同时跑两个 3 进程项目。
  - 2026-10-14 第 22 批第三次：`run-66-d15-idle` 记作“空闲”对照，开跑时 `run-65` 的 `integration` 项目还在跑（脚本记下 `pgrep-before 4`、loadavg 8.4–10.8），结论作废。
- 第三次的根因：前两次之后只写了“开跑前先查残留进程”的规则，每个批次的测量脚本由代理各自现写，查不查、查到了停不停都靠记忆；第三次的脚本查到了 4 个残留进程，却照样跑完，事后才把结果作废。
- 硬约束（2026-10-15）：`.ci-output/handoff/scripts/require-quiet-host.sh hermes|cloud`。它列出测试账号下仍在运行的 `vitest`、`local.mjs`、解包、安装和 `bwrap` 进程，并记录 loadavg；只要有一个，就打印 `QUIET_HOST_BUSY` 并以退出码 1 结束，没有才打印 `QUIET_HOST_OK`。每个对照测量脚本的第一步必须调用它，退出码不是 0 就不开跑。Claude 审核时，测量证据里没有 `QUIET_HOST_OK` 的对照结果一律退回。验证：2026-10-15 两台主机各有测试在跑时，它对两台都以退出码 1 拒绝。
- 第四次（2026-10-15，方向反过来）：最终候选版本 `04660f2b` 的第 3 层（完整 `npm test`）运行期间，Claude 为了腾空间，在同一块固态盘上对两个旧测试副本算摘要、`du`，并删除 1.7 GB 的 `r2-l3`（11:36:19 结束）。同一时段运行的 `node-runtime-installation-permissions.test.ts` 第一个“安装完整产物”用例跑满 30 秒时限失败；它在此前 5 次第 3 层里用时 21.5–24 秒，同文件第二个同类用例这次也慢到 26.9 秒。根据时间重合推断是这次干扰造成的，没有单独复现。5772 个用例里只有这一个失败，整轮第 3 层作废重跑，损失约 30 分钟。
- 第四次的根因：上面的检查只在开跑前看一次，管不到“跑的过程中自己又在同一台机器上做重活”；什么时候能动测试主机，仍然靠记忆。
- 新增硬约束（2026-10-15）：Hermes 上的第 3 层用 `.ci-output/handoff/scripts/start-hermes-run.sh run-l3w.sh <标签>` 启动（第 4 层用 `run-l4w.sh`），它在 Hermes 上以 `setsid -f` 运行包装脚本，确认摘要出现后才返回。包装脚本同时启动 `.ci-output/handoff/scripts/foreign-watch.sh`：每 2 秒检查一次，找出本次运行开始后新出现的 `rm`、`du`、`find`、`sha256sum`、`tar`、`git`、`cp`、`dd`、`node`、`python3` 等进程，条件是它们既不在本次运行所在的 cgroup（Linux 内核给每次 SSH 登录分配的进程组，测试用 `setsid` 开的子进程仍留在里面），又在某个登录会话（`session-*.scope`）里。用户自己的定时服务（例如每小时运行的 `trendradar`）在 `user@1000.service` 下，不算外来进程，只记在负载日志里；负载日志另外每 10 秒记录 `/proc/pressure/io`（进程因等待磁盘而停住的时间比例）。只要发现外来进程，摘要写 `foreign-check=DISTURBED`，脚本以退出码 75 结束；没有才写 `foreign-check=clean`。归档脚本 `post-l3.sh` 看不到 `foreign-check=clean` 就以退出码 3 拒绝，这次运行的产物和结果不能当作候选包或证据。
- 硬约束的验证（Hermes，2026-10-15）：第一版按“进程会话号”区分，模拟运行里两种情况都判对了，但真实的第 3 层把测试框架用 `setsid` 开的 `vitest`、`tsc` 误报成外来进程（`cc-layer3-04660f2b-r2`，2868 行），因为模拟运行没有这种子进程。改成按 cgroup 判断后，模拟运行加入了测试自己用 `setsid` 开的读盘子进程：旁边不做事时判为 CLEAN；另一个 SSH 登录同时运行 5 秒的 `dd` 时判为 DISTURBED，并记下了 `dd` 和它的 `session-3599.scope`。`post-l3.sh` 对没有这一行的 `cc-layer3-04660f2b` 以退出码 3 拒绝。限制：2 秒以内结束的短命令可能漏掉，这类命令对测试计时的影响也小。

[回到目录](#编码代理反复犯的错误)

<a id="upload-before-written"></a>

## 文件还没写好就上传到测试主机

- 反复出现的情况：在同一批并行执行的命令里，一边写或改本地脚本，一边用 `cat <文件> | ci-ssh.sh 'cat > <远端路径>'` 上传它。上传时本地文件还不存在或还是旧内容；`cat` 报错，但管道整体仍返回 0，测试主机上留下一个空文件或旧文件，随后跑的就是错的脚本。
- 为什么要紧：测试结果来自一个不是本次写的脚本，结论不可信，还要花一轮去查为什么“改了没生效”。
- 再次发生的证据：2026-10-14 第 24 批（R2-P1）先后三次：`run-step.sh`、`install-dep2.sh`、`run-unit.sh`（见停止文件 24k、24p）。
- 第三次的根因：前两次只在停止文件里写了提醒；上传的写法本身允许“本地文件不存在却成功”，所以提醒拦不住。
- 硬约束（2026-10-15）：
  - `.ci-output/cloud-test-host-2026-10-14/ci-ssh.sh` 拒绝把标准输入写进远端文件的命令（`cat >`、`tee`、`dd ... of=`），退出码 65，提示改用上传脚本。Claude、opencode、Grok 都必须经过这个包装脚本连云端测试主机，所以对所有人生效。
  - `.ci-output/cloud-test-host-2026-10-14/ci-upload.sh <本地文件> <远端路径>`：本地文件不存在就以退出码 2 结束；上传后比较两边的 SHA-256，不一致以退出码 3 结束；只允许写到 `/srv/himawari-ci/` 和 `/tmp/` 下。
  - 验证：旧包装脚本对一个尚未写出的文件执行 `cat 不存在的文件 | ci-ssh.sh 'cat > /tmp/g107-old.sh'`，退出码 0，远端留下 0 字节文件；新包装脚本对同一命令以 65 拒绝；`ci-upload.sh` 对不存在的文件以 2 拒绝，对真实文件输出 `UPLOAD_OK` 和一致的摘要。

[回到目录](#编码代理反复犯的错误)

<a id="new-code-comments"></a>

## 新代码里加了代码注释

- 反复出现的情况：编码代理在新写的产品代码和测试里加 `/** ... */` 说明块和 `//` 行注释，用来解释意图或记录条目编号（例如 `[R2-T8]`）。用户的全局规则和项目要求是不加代码注释：意图用命名、结构和测试表达，理由写进交付说明、ADR 或规格。
- 为什么要紧：每次都要多一轮“删注释、重跑检查、重新审核”；而且删的时候会漏，漏掉的注释已经进了推送过的提交。
- 再次发生的证据：
  - 2026-10-13 第 20 批（R2-T2）：答复 `.ci-output/handoff/2026-10-13-r2t2-oc-reply-20b.md` 第 2 节要求删掉新加的注释。
  - 2026-10-14 第 24 批（R2-P1）：答复 `.ci-output/handoff/2026-10-14-r2p1-oc-reply-24m.md` 要求删掉全部新注释；删完仍漏了 3 处，随提交 `566a6b6b` 推送，审核也没发现。
  - 2026-10-15 第 22 批（R2-T8）：代理自己提交并推送的 `a8fc08a2` 新增 42 行注释。
- 第三次的根因：前两次只在答复里写“删掉注释”，这是写给某一批的提醒，下一批代理写代码时不会再看；检查靠 Claude 审核时用眼睛找，第二次就漏了 3 处；而这一批由代理自己提交推送，审核发生在推送之后，提醒和审核都来不及拦住。
- 硬约束（2026-10-15）：
  - 本地提交钩子 `.git/hooks/pre-commit` 调用 `.git/hooks/check-new-comments.py`。它读取暂存区里新增的行，用解析器找出 TypeScript/JavaScript、Python 和 shell 文件里的注释（字符串、模板字符串和正则表达式里的 `//` 不算），只要新增行里有注释就打印 `NEW_CODE_COMMENTS_REJECTED` 和位置，并以退出码 1 拒绝提交。工具指令（例如 `biome-ignore`、`@ts-expect-error`、文件首行的 `#!`）和只是挪了位置的原有注释不算新增。
  - 钩子放在仓库共用的 `.git` 目录里，主目录和 `.ci-output/worktrees/` 下的工作副本提交时都会运行，对 Claude、opencode、Grok 都生效。两个代理的本地拒绝规则禁止 `--no-verify`、`git commit -n`、改 `core.hooksPath` 和直接改 `.git/hooks`，防止绕过。
  - 也可以检查一段已有提交：`python3 .git/hooks/check-new-comments.py --range <起点>..<终点>`。
  - 验证：对 `fc05624b..a8fc08a2` 以退出码 1 拒绝并列出全部 42 行；对 `566a6b6b` 找出漏掉的 3 行；最近 80 个提交里只有这两个被标记，被标记的全是真注释。暂存一个只含 `// probe comment` 的探测文件后执行 `git commit`，钩子以退出码 1 拒绝，HEAD 不变；删掉这些注释后检查通过。

[回到目录](#编码代理反复犯的错误)

<a id="stale-packet-pins"></a>

## 操作包里写死的摘要和文件清单没跟着内容更新

- 反复出现的情况：生产操作包（一次生产部署要用的全部脚本、清单和材料，冻结后交用户批准）从上一次复制过来，或者新加了文件之后，包里“绑定某个具体候选包或某份文件内容”的值没有跟着更新。这些值包括：探针脚本 `measurement/probe/bootstrap.mjs` 里写死的作业宿主文件摘要；验收输入清单 `acceptance/cloud/cloud-inputs.draft.json` 的 `files`（云端验收前逐个核对摘要的文件表）；以及 `measurement/`、`systemd/`、`acceptance/`、`maintenance/` 四份 `OWNED-SHA256SUMS`（生产步骤运行前核对辅助脚本没被改过的摘要表）。
- 为什么要紧：安装演练不会走到每一个生产步骤，所以漏掉的值要到生产上那一步才暴露；生产上失败要停服诊断、出包外修复工具、再次审批，每次至少 1.5–2 小时。漏登记的文件更糟：生产脚本会照常载入它，却没有任何摘要核对。
- 再次发生的证据：
  - 2026-10-13 第三次部署 S6_READ 在生产上失败：`bootstrap.mjs` 写死的三个作业宿主文件摘要还是第二次候选包的值（见 `.ci-output/handoff/2026-10-12-third-packet-progress.md` 第 88 行）。
  - 2026-10-15 起草第四次操作包时，又把第三次那份过期的 `bootstrap.mjs` 原样复制了过来，冻结前人工核对时才发现。
  - 2026-10-15 冻结前核对第四次操作包：新加的 `acceptance/cloud/adapters/failure-scene.py` 会被 `run-stage-03.py` 载入，但不在验收输入清单里；四份 `OWNED-SHA256SUMS` 仍是第三次的值；`maintenance/raw-copy-recovery.mjs` 被已登记的 `run-maintenance.mjs` 载入，却从第三次起就没登记。同一天还发现测试 `test/integration/product-path-browser.test.ts` 的 `[R2-L6]` 用例写死了第一次候选包的摘要 `6cc0c9d8…`，换任何新包都失败；已改为对实际传入的安装包现场计算。
- 第三次的根因：前两次之后的预防都是“换候选包时记得核对”，由起草的人逐项想起来；操作包从上一次复制而来，旧值看起来和新值一样合理，没有任何东西在冻结或执行前机械地比较“清单写的”和“包里实际的”。
- 硬约束（2026-10-15）：
  - 操作包里的 `inputs/check-packet-consistency.py <操作包目录>`：核对验收输入清单和四份 `OWNED-SHA256SUMS` 的每一条摘要；对每个没登记的文件，只要有已登记的文件按路径或文件名引用它，就判为漏登记；从操作包材料里的候选安装包读出 `runtime-sandbox/dist/` 下的三个文件，核对 `bootstrap.mjs` 写死的摘要，并要求每个替换锚点在对应文件里恰好出现一次。任何一项不符就打印问题清单，以退出码 1 结束。
  - 生产入口 `.ci-output/production/run-fourth-step.sh` 在执行每个生产步骤（包括第一步上传）前先运行它，不通过就打印 `FOURTH_PACKET_INCONSISTENT`，以退出码 3 结束，不连接生产服务器。安装演练脚本 `run-fourth-rehearsal.sh` 的第一阶段也先运行它。下一次起草操作包时，入口脚本和检查脚本随包一起复制，检查跟着生效。
  - 验证：直接对第三次的操作包 `2026-10-12-third-deploy-packet-03` 运行，检查指出了当年导致 S6 失败的三个过期摘要和三处锚点不符，以及 `raw-copy-recovery.mjs` 漏登记；修正后的第四次操作包通过。夹具 `inputs/verify-packet-consistency.py` 在副本上重现过期探针摘要、漏登记的载入文件、过期的目录摘要、漏登记的被载入模块和改过的已登记脚本五种情况，都以退出码 1 拒绝，未改动的副本通过。在临时副本上弄坏一条摘要后运行入口脚本，以退出码 3 停下，放在 `PATH` 里的假 `ssh` 一次也没被调用。
  - 限制：只能发现“被已登记文件按名字引用”的漏登记；按拼接出来的路径载入的文件发现不了。

[回到目录](#编码代理反复犯的错误)

<a id="long-blocking-wait"></a>

## 代理在一条命令里同步等待长时间运行，会话被中断

- 反复出现的情况：opencode 把完整测试或产品路径测试交给测试主机后，在同一条 shell 调用里循环等待它结束（例如 `for i in $(seq 1 400); do …; sleep 10; done`）。这条调用在结束前不产生任何事件，opencode 约一小时后以 `Session interrupted: inactivity` 结束会话；测试本身还在跑，但没人收尾、复制证据、写停止文件。
- 为什么要紧：一批工作卡住一个多小时，Claude 要重新续跑会话、重新交代现场；中断时若测试已结束，临时目录和证据也可能没人处理。
- 再次发生的证据：2026-10-13 两次（一次等待重试循环，一次连续两轮完整测试，见 `opencode-orchestration` skill）；2026-10-15 第 30 批（R2-T11）后台启动 `run-09-full` 后又用 400 × 10 秒的循环等待，工具超时设为 70 分钟，17:37 被中断。
- 第三次的根因：前两次之后规则写进了简报模板（“超过 40 分钟的命令后台启动，不要在一次调用里等超过 40 分钟”），第 30 批简报也照写了；代理确实后台启动了测试，却又写了一个长等待循环，文字规则拦不住。
- 硬约束（2026-10-15）：
  - 连测试主机的唯一入口都限时：`.ci-output/cloud-test-host-2026-10-14/ci-ssh.sh`（云测试账号）和新的 `.ci-output/handoff/scripts/hermes-ssh.sh`（Hermes，经 Tailscale，并核对主机名是 `hermes-home`）把每条远程命令放在 `timeout 300` 里执行，超时以退出码 124 结束并打印 `CI_SSH_TIME_LIMIT` 或 `HERMES_SSH_TIME_LIMIT`，说明改为后台启动、再用短命令查询。上限没有可调的参数。
  - 往 Hermes 传文件用 `.ci-output/handoff/scripts/hermes-upload.sh <本地文件> <远端路径>`（与 `ci-upload.sh` 相同：本地文件必须存在、两边 SHA-256 一致、只能写到测试目录）。
  - 本地、不提交的 `.opencode/opencode.json` 和 `.grok/config.toml` 禁止命令里出现 Hermes 的 Tailscale 地址 `100.64.53.104`、`ssh … hermes`、`scp … hermes`、`rsync … hermes`，所以 opencode 和 Grok 只能经过上面的限时入口。
  - 验证：在 opencode 里直接执行 `ssh … hermes hostname` 被拒（`permission.rejected`），执行 `hermes-ssh.sh 'hostname'` 返回 `hermes-home`；两个入口各执行一个 400 × 10 秒的循环，都在约 300 秒时以 124 结束并打印时限说明；同一入口里用 `setsid nohup` 后台启动 330 秒的任务立即返回，任务照常跑完。

[回到目录](#编码代理反复犯的错误)
