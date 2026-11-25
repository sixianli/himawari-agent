---
status: active
document_type: lessons
supersedes: ""
superseded_by: ""
date: "2026-10-13"
covers: ""
verified_at: ""
---

# 编码代理反复犯的错误

本文只记录编码代理（Claude、Codex、opencode 等替用户写代码和跑测试的程序）同一类错误犯过两次以上的情况，以及防止再犯的明确规则。项目状态、一次性事件和以后要做的事不写在这里；以后要做的事见 Backlog。

目录：

- [演练把生产里不同的东西合成了一个](#merged-in-rehearsal)
- [从中途续做的修订版没核对跨步骤的摘要比较](#resume-digest-checks)
- [在 Hermes 上生成后续要用的文件时没设 umask 022](#hermes-umask)
- [进入冻结包目录后留下 `.claude` 目录](#claude-dir-in-packet)
- [在工作目录里封存 Runbook，把被 git 忽略的本地内容算进摘要](#seal-in-working-tree)
- [审核时直接采信代理自报的检查结果](#trust-reported-checks)
- [保存失败现场时整目录打包、重复复制输入材料](#bulky-evidence)
- [用补丁搭出来的树和要验证的提交不一致](#patch-tree-mismatch)
- [对照测量或完整测试时机器上还有别的负载或上一次实验的残留](#measurement-not-isolated)
- [文件还没写好就上传到测试主机](#upload-before-written)
- [新代码里加了代码注释](#new-code-comments)
- [操作包里写死的摘要和文件清单没跟着内容更新](#stale-packet-pins)
- [代理在一条命令里同步等待长时间运行，会话被中断](#long-blocking-wait)
- [给用户的文字没用简体中文](#reply-not-chinese)
- [在 Mac 上的 Bash 工具里写了 zsh 会展开的词](#zsh-word-expansion)
- [记录里写了还没到的时间](#future-timestamp)
- [等待后台任务时手写的“结束”或“存活”条件写错](#hand-written-wait)
- [演练脚本在每个读取位置手选数据库读法，和附属文件的实际情况对不上](#sidecar-reader-choice)
- [检查命令的结果被管道或 `!` 掩盖，失败后下一步照样执行](#masked-exit-status)
- [给 opencode 的简报没提醒本地禁止规则会拦哪些命令](#brief-denied-text)
- [代理在测试主机上的任务还没跑完就结束本轮](#turn-ended-before-done)
- [加了新的沙箱后端，共用逻辑只接在原来的一次性路径上](#backend-branch-omission)
- [按 `local.mjs` 的退出码判定第 3 层](#layer3-exit-code)
- [第 0 层漏跑直接相关的测试文件](#layer0-related-tests)
- [复制上一次操作包时留下旧文件和旧文件名](#copied-packet-stale-names)
- [上线验收只查了首页 200 没真点网页](#release-without-browser-walkthrough)
- [新建 ADR 时只看了 main，和别的线程撞了编号](#adr-number-collision)
- [记过低意见修改后，复核传错了上一轮的提交](#review-previous-after-low-fix)

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
  - 同日审核修订版 03 时发现：发布夹具用发布脚本自己的 FAILED_CONDITION 造“生产失败报告”，常量多写了 `DEPLOY_` 仍然通过。
  - 2026-10-16 第四次变更生产 S6_SIGN 以 NEW_RUNNER_INCOMPATIBLE 失败：候选 `4c705133` 有意改了 Pi 和搜索两个 runner（沙箱里执行工具的程序），生产上新 runner 与数据库登记的旧 runner 不同；生产形状演练却写死 `const oldRuntime = runtime, newRuntime = runtime`，新旧 runner 一字节不差，签署和 S8 的“runner 必须等于登记值”从没遇到过不同的情况。
  - 同日修复后的第一次演练里，S7_DB_STATUS 以 FOURTH_MAINTENANCE_ORIGINAL_AUTHORIZATION_CHANGED 失败：生产上 S0 读回和 S5 报告由旧包的读取器写出，演练却用新读取器写，两份记录的字段不同。演练这次在上生产前拦住了它。
- 第四次的根因：前三次之后的预防只是“写演练时先列出生产上不同的实体”这条要靠人想起来的规则，演练脚本里没有任何检查会在两样东西被合成一样时报错，于是新旧 runner、新旧读取器写的记录又被合成了一个。
- 硬约束（2026-10-16，G107）：
  - 生产形状演练 maintenance/verify-production-shape-chain.mjs（安装演练 run-fourth-rehearsal.sh 的 shape 阶段，冻结前必须通过）在 S7_DB_STATUS 之后、生成新快照之前改动演练运行时里 Pi runner 的字节，S8 之后再改回，用时间先后模拟生产上新旧两个运行时；新快照绑定的 runner 摘要等于登记摘要时打印 PRODUCTION_SHAPE_RUNNERS_MERGED 并失败。
  - 同一演练写出 S0 读回后，要求它的授权、能力、目录授权三层字段名与操作包里真实的生产 S0 读回 inputs/s0-db-readback.json 完全相同，否则打印 PRODUCTION_SHAPE_S0_SHAPE_NOT_PRODUCTION 并失败。期望值取自真实生产记录，不由演练自己另写。
  - 验证（Hermes `rehearsal-4c705133/hard-constraint-01/`，运行脚本 `.ci-output/production/2026-10-16-fourth-revision-01/run-shape-variant.sh`）：去掉改动 runner 的那一行重现第一种错误，以 PRODUCTION_SHAPE_RUNNERS_MERGED 失败；按新读取器的形状写 S0 重现第二种错误，以 PRODUCTION_SHAPE_S0_SHAPE_NOT_PRODUCTION 失败；正式版本通过，报告记下登记摘要 `b5f2d140…` 与新摘要 `39bb15a0…` 不同，S8 第一次在 runner 不同的情况下通过。
  - 限制：只覆盖 Pi runner 和 S0 读回这两样；搜索 runner、签署链（`cloud-seal.mjs`）、S7_SWITCH_START 仍不在形状演练里，签署链的新旧 runner 不同由夹具 `signing/verify-capability-manifest.mjs` 覆盖。下一次起草操作包时这两个检查随演练脚本复制过去；如果以后有别的“生产上不同、演练里相同”的实体，按同样方式加一个在合并时失败的检查。
- 第五次变更又发生两次（2026-10-17），都在生产 S7_CATALOG_UPGRADE：
  - 第一次停在准备脚本：生产用 `runuser` 启动真实的 `cloud-protected-prepare.mjs`，进程的 NoNewPrivs（禁止再提权的进程标志）为 0，产品的运行时保护拒绝；演练用的准备脚本替身不检查这个标志，生产和演练的进程状态被合成了一样。
  - 第二次停在升级后的核对：生产数据库里有 24 个已结束对话留下的 Pi 句柄（`status` 为 `revoked` 或 `consumed`，`revoked_at` 为空），演练数据库里一个这样的句柄也没有，维护脚本按 `revoked_at IS NULL` 计数的错误测不出来。设计修法时还发现第三样：演练几十秒跑完，生产步骤之间隔几十分钟，`capabilities` 命令“资格检查须在 5 分钟内”的限制在演练里从没触发过。
- 这两次的根因：第四次加的硬约束只检查当时列出的两样实体（Pi runner、S0 读回的字段），列清单这一步仍要靠人想到；进程标志、数据库里的历史数据和步骤间隔都不在清单上。
- 新增硬约束（同在 maintenance/verify-production-shape-chain.mjs，冻结前必须通过）：
  - 准备脚本替身开头要求 `/proc/self/status` 的四项能力集为 0、`NoNewPrivs: 1`，否则以 PREPARE_STAND_IN_NO_NEW_PRIVS_REQUIRED 失败。验证：用修订一之前的 `maintenance-common.mjs` 跑形状演练以这个错误码失败，换新文件后通过（`.ci-output/handoff/prod-fifth-evidence-c53bca70/revision-01-nnp/before/`、`after/`）。
  - 升级前数据库里必须同时有可用的、对话已结束的、已用完的 Pi 句柄，且后两种的 `revoked_at` 为空，否则以 PRODUCTION_SHAPE_HANDLES_NOT_PRODUCTION 失败；报告里记下生产的参照数（Pi 24、搜索 0）。验证：只放一个可用句柄（相当于之前的演练）时在升级前以这个错误码失败，正式版本通过（Hermes `rehearsal-c53bca70/revision-02-code/handles-variant/` 与 `shape-full/`）。
  - 续做模式在 S7_CATALOG_UPGRADE 失败后等到准备的资格检查超过 5 分钟，要求 `capabilities upgrade-plan` 报 `CAPABILITY_DEPLOYMENT_QUALIFICATION_STALE`，把“生产上步骤之间时间更长”变成演练里的一步（Hermes `revision-02-code/shape-resume/`）。
  - 限制：仍是逐项列出的检查，只覆盖这三样；生产里还可能有别的历史数据或进程状态与演练不同。下一次起草操作包时，先把生产只读诊断里看到的每类历史数据（句柄、对话、审计记录的状态分布）写进形状演练的种子数据。
- 第六次变更的包外修订工具（`.ci-output/sixth-packet-work/revision-01/`，就地替换已部分运行过的操作包的脚本）又发生三次（2026-10-22），每次都是演练现场里少了生产上第一次运行真实留下的东西：
  - G162：前提检查以 `TREE_EXTRA:acceptance/cloud/cloud-inputs.json` 拒绝，第一次 S6 往旧包里写了这个文件，手写的演练现场里没有。
  - opencode 审修复时发现：s3_copy50-result.json 在生产上属主是 999（服务账号），工具按 0 检查；演练在 `unshare -r -u`（普通账号模拟 root）下所有属主都显示为 0，测不出来。
  - G163：安装新候选失败 `REVISION_INSTALL_FAILED:EXIT:1`。安装程序用“文件已存在就报错”的方式写 `python-extract.stdout`，第一次安装留下的这个文件没被归档：工具的 INSTALL_FILES 是照安装程序手抄的，九个命名输出漏了一个；演练现场 build-rehearsal-stage.py 也是手写的文件清单，同样漏了它，所以演练通过。
- 这三次的根因：演练现场和工具里的文件清单都由人照着记忆或代码手写，没有任何检查把它们和生产上真实存在的文件或安装程序真实会写的文件对照。
- 硬约束（2026-10-22，G165）：
  - 生成修订工具和补装工具时（revision-tool/make-revision.py、install-resume/make-resume.py，每次生成都运行），revision-tool/install_outputs.py 从安装程序 install/sixth-artifact-install.mjs 的源码提取所有 `run(..., "<名字>")` 和直接写进证据根的文件名，要求 INSTALL_FILES 恰好等于每个 `<名字>.stdout`、直接写的文件和工具自己写的三个文件（`s1-install.stdout/.stderr`、`s1-result.json`），INSTALL_OPTIONAL 恰好等于每个 `<名字>.stderr`；缺一个以 `TEMPLATE_INSTALL_OUTPUTS_MISSING:<缺的文件>` 拒绝，多一个以 `TEMPLATE_INSTALL_OUTPUTS_EXTRA:<多的文件>` 拒绝（多列的名字会在安装成功之后才因找不到文件而失败）。源码里出现认不出的调用形式时以 INSTALLER_RUN_CALL_UNRECOGNIZED 等错误码拒绝；`evidence` 变量在写文件之外的用法数一旦变化（例如改用 `` `${evidence}/x.json` `` 拼路径），以 INSTALLER_EVIDENCE_USES_UNRECOGNIZED 拒绝，不会默默漏掉新写的文件。
  - 演练现场从生产只读诊断推导：rehearsal/production-shape.py 读诊断 03 的输出，按修订开始时间把证据根里的文件分成“修订前就有”和“修订新建”，再加上归档清单里从证据根移走的文件，得到“首次修订前的证据根”；build-rehearsal-stage.py 按这份清单搭建，rehearsal/check-stage.py 在演练开始前和复现失败后各比对一次（名字、类型、权限），不一致就以 `STAGE_DIFFERS_FROM_PRODUCTION:<差异>` 失败。期望值取自生产诊断，不由演练自己另写。
  - 验证（Hermes `/data/hermes/himawari/tool-audit-round2/r2-l13/install-resume-rehearsal-01/work-02/`，脚本 rehearsal/rehearse-install-resume.sh）：G163 版模板以 `TEMPLATE_INSTALL_OUTPUTS_MISSING:python-extract.stdout,python-extract.stderr` 被拒，多列一个名字的模板以 TEMPLATE_INSTALL_OUTPUTS_EXTRA 被拒，用 `` `${evidence}/...` `` 写文件的安装程序以 INSTALLER_EVIDENCE_USES_UNRECOGNIZED 被拒，补好的模板通过；去掉 `python-extract.stdout` 的现场以 `STAGE_DIFFERS_FROM_PRODUCTION:EVIDENCE:MISSING:python-extract.stdout` 被拒，按生产清单搭的现场通过；用去掉这两项的工具在按生产清单搭的现场上运行，复现了生产的 `REVISION_INSTALL_FAILED:EXIT:1`，失败后的现场与诊断 03 一致；只补做安装的工具 install-resume/resume-install.py 在这个现场上退出 0（9 次移动，安装检查通过），服务运行中、多一个残留文件、失败原因不是 `python-extract.stdout` 的 EEXIST、重复运行四种情况都被拒绝，现场不变。工具的审核由 CodeBuddy 逐行做（opencode 免费模型当时都返回 429），采纳了其中三条（名单改为恰好相等、`evidence` 用法计数、补装核对失败原因）后重跑演练。
  - 限制：比对只看名字、类型和权限，不看属主（演练里都是 0）和内容；属主仍要在审核时对照诊断逐个核对。以后再写包外工具时，把生产只读诊断的列表作为演练现场的唯一来源。
- 第六次变更第五次 S6 又发生两次（2026-10-24，R2-D29）：
  - `S6_FINALIZE_BINDINGS` 失败：`signing/finalize-binding-inputs.py` 第 99 行要求旧能力的两个摘要比较结果为 `False`，真实 S0 读回里都是 `true`。夹具用的是手写的 S0，期望值跟着写反的条件走，没有用操作包里真实的 inputs/s0-db-readback.json。
  - 只读核对后面各步时发现 `S7_CATALOG_UPGRADE` 必然失败：生产上公开搜索的运行程序摘要在新构件里没变，Pi 的变了；维护脚本要求每个能力的运行程序都变。形状演练只登记 Pi 一个能力，而 Pi 每次都变，生产上“有的变、有的不变”被合成了“全部都变”。包里的说明文件原本就写着“exa 的升级由生产 S7 逐项检查”，这个缺口是明知的。
- 这两次的根因：前面几次的硬约束都是逐项列出的实体，“同一步里不同能力的运行程序有的变有的不变”不在清单上；签署夹具也没用真实 S0。
- 新增硬约束（2026-10-24，G176，在 maintenance/verify-production-shape-chain.mjs，演练入口 run-sixth-rehearsal.sh 的形状阶段冻结前必须通过）：
  - 形状演练开头读真实 S0，把每个能力按“新构件运行程序摘要是否等于 S0 记录”分成“变”和“不变”；生产里出现演练不认识的能力时以 PRODUCTION_SHAPE_PRODUCTION_CAPABILITY_UNKNOWN 失败，本次演练的类别生产里没有时以 PRODUCTION_SHAPE_RUNNER_CLASS_NOT_IN_PRODUCTION 失败。演练入口按 `--runner-class changed` 和 `--runner-class unchanged` 各跑一遍整条 S7–S8，两遍都通过才算通过。
  - 验证（Hermes `rehearsal-87c2e3ec-r05/shape-proof/`，输出存于 `.ci-output/handoff/rev05/shape-proof-output.txt`）：用 revision-04 的维护脚本跑 `unchanged` 一遍，以 SIXTH_MAINTENANCE_PREPARED_RUNNER_UNCHANGED、SIXTH_MAINTENANCE_UPGRADE_PLAN_RUNNER_UNCHANGED 在 `S7_CATALOG_UPGRADE` 失败，与生产会遇到的错误相同；换 revision-05 的脚本后通过，报告里的生产分类是 Pi 变、公开搜索不变。
  - 生产分类还必须正好是“Pi 变、公开搜索不变”，否则以 PRODUCTION_SHAPE_PRODUCTION_RUNNER_CLASSES_CHANGED 失败。
  - 签署链第 99 行的修正在生产上做了只读预演（诊断 14，写出位置换成临时目录），发布、签署、签署读回、运行时保护都退出 0。
  - 新夹具 `signing/verify-finalize-capability-check.py`（演练入口 fixtures 阶段运行）：从 `signing/finalize-binding-inputs.py` 截出逐个能力检查的源码原样执行，输入是真实 S0；真实 S0 必须通过，标记改 `false` 或删除、运行程序摘要或运行目录不同都必须被拒绝。验证（Hermes `rehearsal-87c2e3ec-r05c/`，输出存于 `.ci-output/handoff/rev05/r05c-rehearsal-output.txt`）：新代码 17 个用例全过；revision-04 的旧代码在 `production-s0-accepted` 失败，退出码 1。审核后补了“标记为空”和“删除标记必须是具体的 `KeyError`”两类用例，最终演练（Hermes `rehearsal-87c2e3ec-r05d/`，输出存于 `.ci-output/handoff/rev05/r05d-rehearsal-output.txt`）新代码 23 个用例全过，旧代码仍在 `production-s0-accepted` 失败；演练脚本最后的 REHEARSAL_VERDICT 把“旧代码必须失败”也写成了硬判断，结果是 `PASS`。
  - 限制：分类只看运行程序摘要；夹具只截取逐个能力检查的一段，脚本其余部分仍要求 root 和生产主机名，不在演练里运行。以后起草操作包时，签署和维护的夹具一律从 inputs/s0-db-readback.json 派生期望值。
- 补充（2026-10-24，revision-06）：包外修订工具每多一次 S6，模板里就多一批要和生产现场对上的名单（S6 写进包里的文件、S6 证据文件、验收目录、资格目录、运行时保护文件、辅助脚本、临时读服务状态），以前除第一组外都靠人照诊断手抄。revision-tool/make-revision.py 现在每次生成工具时读 rehearsal/production-shape.json（rehearsal/production-shape.py 由修订前的只读诊断 20 生成），把模板里这 7 组常量逐一与它比较，任何一组不等就以 `TEMPLATE_<名单>_DIFFER(S)_FROM_PRODUCTION` 拒绝生成。验证（Hermes `revision-rehearsal-06/work/`，日志存于 `.ci-output/handoff/rev06/revision-rehearsal-06-work/`）：修订演练 rehearse-revision.sh 对新加的 6 组各删改一项，6 个反例都以对应错误码被拒，未改的模板通过，随后的修订演练 `PASS`。限制：只比较这 7 组；诊断里没列出的现场仍要在审核时对照。

[回到目录](#编码代理反复犯的错误)

<a id="resume-digest-checks"></a>

## 从中途续做的修订版没核对跨步骤的摘要比较

- 反复出现的情况：部署包出修订版、从某一步之后续做时，没有逐一检查“后面的步骤拿前面步骤的报告和当前 `bindings.json` 摘要比较”的地方。新冻结换了 `bindings.json`，这些比较必然失败。
- 为什么要紧：前面的步骤往往已经改过生产数据，不能重跑，只能再出一个修订版；而再出修订版又会换一次 `bindings.json`，可能让已经通过的步骤的报告也对不上。
- 预防规则：
  - 设计修订版之前，用 `grep` 列出包里所有比较 `bindingSha256`、`bindingsSha256`、`freezeSha256` 的地方，逐一写明比较的报告是在哪个冻结下生成的、修订后是否还成立。
  - 修订记录要写明每份旧报告对应的 `bindings` 摘要（例如 s3BindingsSha256），检查代码按修订记录比较。
  - 已有步骤在当前冻结下改过生产数据之后，优先用不改冻结包的包外工具处理后续问题，再出修订版前先确认不会让这些步骤的报告失效。
  - 演练要真实模拟“前面的步骤在旧冻结下完成 → 换成新冻结 → 后面的步骤继续”。
- 再次发生的证据：
  - 2026-10-13 修订版 02 上线后 S5 以 THIRD_MAINTENANCE_RECOVERY_BINDING_CHANGED 失败。
  - 同日 S6 失败后，第一版修复方案又是出修订版 04；核对后发现 `systemd/S7-switch-start-readback.py` 会因 S5 报告的摘要不符而失败，改成了包外工具。

[回到目录](#编码代理反复犯的错误)

<a id="hermes-umask"></a>

## 在 Hermes 上生成后续要用的文件时没设 umask 022

- 反复出现的情况：Hermes 登录账号默认的 umask（新建文件时默认去掉哪些权限位）是 `0002`，在这个设置下新建的文件和目录是同组可写；忘了先设 `umask 022`，后面要求“不可组写”的检查就会拒绝它们。
- 为什么要紧：权限会被记录进源码树摘要和材料文件，等到生产上才被拒绝时，只能另写工具在生产上收紧权限。
- 预防规则：
  - 在 Hermes 上跑测试、构建候选包、生成或采集材料（例如 materials/source-build-inputs.json）之前，一律先 `umask 022`，并在脚本里检查 `umask` 的值。
  - 冻结前检查材料里记录的文件权限，不能有同组或其他人可写的位。
- 再次发生的证据：
  - 2026-10-01 约 100 个测试因 `SANDBOX_HOST_PATH_UNSAFE` 失败，原因是测试目录同组可写（AGENTS.md 已写入 `umask 022` 规则）。
  - 2026-10-13 第三次部署 S6 以 `PUBLIC_FILE_UNSAFE` 失败：第三次候选包的构建源码记录 619 个文件全是 `664`。
  - 2026-10-15 第 29 批两次：在 Hermes 检出上用 `git apply` 重写文件后，权限变成 `664`，而源码树摘要包含权限位，安装候选包时以 `ARTIFACT_BUILD_INPUT_MISMATCH` 失败（停止文件 29a 第 5 节、29d 第 5 节；证据 `/data/hermes/himawari/tool-audit-round2/r2fix29/evidence/run-20-layer2-product-path`）。
- 第三次以后的根因：`umask 022` 只管新建的文件；SSH 会话里改写已有文件、或忘了在交互命令里设 umask，权限照样漂移，靠记住设置拦不住。
- 硬约束（2026-10-15）：`.ci-output/handoff/scripts/require-git-modes.sh <检出>` 把 git 登记的文件权限恢复成 644/755 并复查，仍不一致就以退出码 3 结束。第 3 层脚本 run-l3.sh（完整测试，同时构建候选包）和不过滤第 4 层脚本 run-l4f2.sh（安装候选包）开跑前都调用它，失败就不运行（Hermes 上的副本在 `~/himawari-tests/r2-u1/`）。验证：临时仓库里把两个文件改成 `664`/`775`，脚本输出 `GIT_MODES_OK fixed=2`，权限回到 `644`/`755`，再跑一次输出 `fixed=0`；未加约束时的失败见上面的 run-20。

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
  - 门禁 2026-10-17 的修改：原钩子把另一个 `git worktree`（例如 `.claude/worktrees/<名字>/`）根目录下属于它自己的 `.claude/.cc-writes` 也当成违规，另一个会话正在用那个工作副本时，主工作区就无法提交。现在每个已登记的工作副本只由它自己提交时检查：主工作区不再检查其他工作副本里面的内容，在工作副本里提交时检查它自己的源码目录。`git`、`find` 出错时钩子拒绝提交，不再放行。测试脚本 `.ci-output/handoff/scripts/test-pre-commit-hook.sh <钩子> <check-new-comments.py>` 在临时仓库里建三个工作副本、跑 9 个场景：新钩子 0 个失败，旧钩子 3 个，一个出错就放行的写法 2 个。
  - 门禁 2026-10-18 的修改（opencode 审核后）：钩子在任何层级都跳过名为 `.git`、`.ci-output`、`node_modules` 的目录，不只是根目录下的这几个；仓库路径里有 `[`、`]` 这类字符时，原来按路径跳过的写法会失效，现在按名字跳过就不受影响。`git worktree list` 出错时也拒绝提交。测试脚本扩充到 25 个场景，在 `sh` 和 `dash` 下都跑过：新钩子 0 个失败，10-17 的钩子 6 个。审核记录和这些输出在 `.ci-output/handoff/2026-10-17-dg-hook-review/`。
  - 这两项都只在这台 Mac 上（钩子的测试脚本也在不进 git 的 `.ci-output/` 里）；换电脑或重新克隆仓库时要重新设置。
  - 2026-10-17 起，装了新封存脚本的地方不再把被 git 忽略的 `.cc-writes` 算进 Runbook 摘要（见[在工作目录里封存 Runbook](#seal-in-working-tree)），但部署包和证据目录不是 git 跟踪的内容，上面的 `find` 检查和门禁照旧需要。

[回到目录](#编码代理反复犯的错误)

<a id="seal-in-working-tree"></a>

## 在工作目录里封存 Runbook，把被 git 忽略的本地内容算进摘要

- 反复出现的情况：Runbook（运维操作手册）的依据文件里有整个目录（例如 `apps/agent-service/src`）。2026-10-17 之前，封存脚本 `runbook.py seal` 计算摘要（把依据文件内容算成的一个 SHA-256 指纹）时，会把目录里磁盘上的所有内容都算进去，包括被 git 忽略的本地文件和空目录，例如 Claude Code 自动建的 `.claude/.cc-writes`。在 Mac 的工作目录里直接封存，记下的摘要就只在这台 Mac 上对得上；干净检出（CI 或另一台机器）上严格校验会报 `contract_sha256 does not match`。这条记录原来把原因写成 macOS 访达生成的 `.DS_Store`，这是错的：脚本从 2026-08-23 的 agent-skills 提交 `1c513e4` 起就跳过 `.DS_Store`，比下面每一次都早。
- 为什么要紧：每次都要重新查一遍是哪些 Runbook 真漂移、哪些只是本地文件造成的，还会把真正的漂移藏在这些假错误里。
- 预防规则：封存前在仓库根目录运行 `git status --short -- <依据目录>`，确认依据目录里只有要和 Runbook 一起提交的改动；未提交的修改和未被忽略的新文件都会算进摘要。复核时仍可用干净副本：`git archive HEAD | tar -x -C <新建的临时目录>`，在副本上确认 0 错误。新建临时目录失败时立即停止，不能让复制目标变成空字符串。报告校验结果时说明是在哪份代码上得到的。
- 再次发生的证据：
  - `12b4f9d` 封存的 `hermes-control-center-upgrade-runbook.md`、`install-start-stop-runbook.md` 在干净检出上从一开始就不通过。
  - 2026-10-13 opencode 在 `feff37b` 里于工作目录重新封存 4 个 Runbook，自报“降到 2 个错误”，干净检出上却从 2 个变成 4 个；Claude 在 `fae0a0d` 于干净副本上重新封存后为 0 个。
  - 2026-10-14 主工作区报 6 个 Runbook 不匹配，查明是 23 个依据目录里的 `.claude/.cc-writes` 空目录（见[进入冻结包目录后留下 `.claude` 目录](#claude-dir-in-packet)）。前两次当时没有逐个查明是哪种本地内容。
- 硬约束（2026-10-17）：agent-skills 提交 `96465ce` 让 `runbook.py` 在 git 工作目录里只算 `git ls-files --cached --others --exclude-standard` 列出的文件（已跟踪的文件，加上未跟踪且没被忽略的文件）和它们上面的目录；被忽略的文件、被忽略的目录和空目录都不算，所以工作目录和干净副本得到同一个摘要。依据路径本身被 git 忽略，或依据目录里一个列出的文件都没有，脚本直接报错。被跳过的文件仍按文件名检查，被忽略的密钥文件照样让校验失败，但不读取内容。这个脚本的 8 个新测试在临时 git 仓库里放入被忽略的文件、目录和 `.cc-writes`，确认摘要不变；改坏新代码的 6 种方式各至少被一个测试发现。2026-10-17 在本仓库主工作区实测：旧脚本在放入 `.cc-writes` 后报 6 个 Runbook 不匹配（重现了 2026-10-14 的现象），新脚本在主工作区、干净副本和放入 `.cc-writes` 的工作区上都是 0 个。这个约束只在装了新脚本的地方生效：`~/.claude/skills/document-governance/` 是复制来的文件，不是指向 agent-skills 的链接，要手动同步；`~/.codex/skills/document-governance/` 还是旧脚本。
- 硬约束的补充修复（2026-10-18）：opencode 三轮逐行审核 `96465ce`，找到几处工作目录和干净副本仍会悄悄算出不同摘要的情况，agent-skills 提交 `62b5426` 把它们都改成直接报错并说明原因：依据目录里有子模块或嵌套的 git 仓库、已跟踪的文件被换成了目录、磁盘上的文件名和 git 记录的只差大小写或 Unicode 写法、项目根目录或上层有 `.git` 但 git 无法工作。外部继承来的、会改变 git 查找仓库方式、临时配置或路径匹配方式的环境变量都不再使用。`96465ce` 还有一个回退问题：放在被外层仓库忽略的目录里的项目副本（例如 `.ci-output/` 下的干净副本）会被判成“被 git 忽略”，严格校验因此对每个 Runbook 都报错；现在这种副本按“不在 git 里”处理。指纹格式版本仍是 v1。这个技能的 64 个测试通过，故意改坏新检查的 10 种方式都被发现。2026-10-18 在当前提交的干净副本上严格校验是 0 个错误；`~/.claude/skills/document-governance/` 已同步到这个版本。

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
- 硬约束（2026-11-12 起，Andy 在 P5 记忆中心总方案设计线程选了“加”）：这一节“门槛”那一条写于它出现之前，方案里关于代码现状的说法现在有自动门槛。
  - 门槛是什么：复核脚本的 `--mode plan-claims` 让低价模型把方案或 ADR 里每一句讲代码、仓库文档现状的话列出来，逐条对着代码给“一致、不一致、找不到”，附文件、行号和代码原文，记进方案讨论记录目录。合并检查 `node scripts/model-review/opencode-review.mjs --assert-reviewed --pr <编号>` 在 PR 新增了 `docs/adr/` 下的 ADR 时，要求有对当前内容（SHA-256 一致）的记录，所有引用的文件和代码原文在 HEAD 里真实存在，每条“不一致”和“找不到”都有线程写的 `model-wrong` 判断并附代码原文，否则不通过（`claims-unchecked`、`claims-stale`、`claims-unjudged` 等）。代码在 `scripts/model-review/plan-claims.mjs`，测试在 `test/tooling/plan-claims-gate.test.mjs`，做法见[核对代码说法](../.agents/instructions/model-review.md#plan-claims)。
  - 复现：把 P5 总方案出错的那句“`maskSensitiveTexts` 输出的占位编号随前面内容变化”原样放进一份方案，这一步必须报“不一致”，没有判断时合并检查报 `claims-unjudged`；把那句改成“输出前把占位编号去掉”后通过。自动测试里的反向用例见 `test/tooling/plan-claims-gate.test.mjs` 里名字带 `[claims gate]` 的用例；用真实模型实测的结果见这件事的记录目录 `.agents/reviews/topic-plan-claims-gate/`。
  - 限制：低价模型自己也会看错、也会漏列说法；门槛保证的是“列出的每一句都被对着真实代码看过一遍，每条对不上的都有人处理过”，不保证“没有漏列”，更不保证方案一定对。它只管 PR 里新增的 ADR，放在仓库外的整合方案要先提交进分支才能核。合并前的代码复核照旧。
- 再次发生的证据：
  - 2026-10-13 opencode 在 `feff37b` 自报文档校验“从 6 个错误降到 2 个”，干净检出上实际是从 2 个变成 4 个（见上一条）。
  - 同日 R2-T1 的停止文件写 `npm run check` 通过，Claude 审核通过（`e00e641`）；第 20 批核实，`e00e641` 的 `test/integration/product-path-browser.test.ts` 按 `biome lint --error-on-warnings` 退出码为 1。
  - 同日第 20 批停止文件在它启动的 `npm test` 只跑了几分钟时写成，声称已删除该测试正在使用的输出目录，并引用了文件里不存在的“补记”一节；Claude 等测试跑完后才得到真实结果（30 分钟预算超时，另立 R2-T4）。之前一批的第 3 层（构建加完整测试 `npm test`）已用掉 1800 秒预算中的 1779 秒，当时没人注意余量。
  - 2026-10-14 R2-P1 第一段的停止文件在“失败模式和边界表”里写“路径组件 `.git`/`.env`/`.himawari-*` 拒绝”，代码里共用名单没有 `.git`，主进程路径会读出 `.git/config`；又写“根身份与 Grant 不符则拒绝，有测试覆盖”，那个测试用的假身份 `1:1` 只靠设备号不同就通过，代码实际没核对 inode。两处都是 Claude 逐行读代码时发现的，已退回返工。表格里的“实测”一列只能写真正跑过、并且确实覆盖这一行情形的用例名。
- 同类情况：方案的前提直接用了别的 Claude 的转述，没去读原文（2026-10-31 补记）。
  - 2026-10-30 至 10-31 JST，线程“让仓库规则文件被可靠读到”的方案 C 建在协调者开工说明里的一句概括上：“改界面要改设计规范、修 bug 要在案例库留痕”。线程只核对了云端线程会加载哪些文件（官方文档），没有读这两条规则的原文。[设计规范](ui-ux-design-guide.md#contents) 第 20 行写的是“交付时，把这次遇到的新问题补进不良设计，把 Andy 新批准的设计补进优秀设计”；AGENTS.md 第 54 行（Engineering Casebook 一节）只收“a notable hard problem or bug”和“an important architecture or design decision”。也就是说，并不是每次改界面、每次修 bug 都要记。线程按错的前提连续几次推荐方案 C。Andy 要例子时，线程又说提交 `ab849bf`（网页过程区新增“已写 N 行”）“漏改了设计规范”，其实这次改动按原文本来就不用记。直到 10-31 01:53 JST Andy 追问“设计规范是这么用的吗？”才发现。协调者事后确认，那句概括是协调者自己写错的。
  - 此前一次：2026-10-30 15:00 JST，Andy 否掉了另一个线程的推送方案，原因是方案里的几条没有出处（见项目记忆）。
  - 预防规则（Andy 2026-10-31 要求写进 [`.claude/rules/proposal-premises.md`](../.claude/rules/proposal-premises.md)）：每个方案开头先列出它依赖的前提，每条写出处（文件和行号，或网址）并引一句原话；没有出处的前提不能拿来往下推；举例子之前，先按原文确认这个例子确实算数；协调者把方案转给 Andy 之前先查前提清单，缺了就退回。
  - 门槛：这类错误没有脚本能自动拦，因为“前提和原文说的是不是一回事”只能靠阅读来判断。现在靠的是上面这条规则和协调者转交前的检查。按 [ADR 0107](https://github.com/sixianli/himawari-agent/blob/7d0ffcd52cbb69d4941871cf9bf08d93f3843da8/docs/adr/0107-every-incident-gets-an-automatic-gate.md)，同类错误再出现一次就是第三次，要停下来找能自动执行的拦法。
  - 第三次：2026-11-12 JST，P5 记忆中心总方案的线程整合两个模型的审核意见时，采纳了其中一条对代码行为的说法（“对外遮盖的占位编号随前面内容变化，要改成按字段各自遮”），没有自己读代码核对，就写进了交给 Andy 的方案和 [ADR 0242](https://github.com/sixianli/himawari-agent/blob/7d0ffcd52cbb69d4941871cf9bf08d93f3843da8/docs/adr/0242-external-agents-join-the-memory-hub-through-one-entry.md) 的初稿。模型引的代码行是真的（`maskSensitiveTexts` 里确实按顺序分配内部标签），但结论是错的：输出前序号被去掉了，现有测试 `packages/sensitive-capture/test/redaction.unit.test.ts` 还断言同一段文字不受同批无关内容影响。照错的说法改，遮盖反而会漏值。它在合并前被两处拦下：任务 A 的编码线程实测，和 PR 411 合并前复核的两个模型。Andy 同意方案时这条错的说法在方案里，但不在要他定的四件事里。
  - 第三次之后的处理：按 [incident-gates.md](../.claude/rules/incident-gates.md)，这类错误要上硬门槛。门槛要改复核脚本，属于编码，方案线程不能做；线程已带着具体做法问 Andy（整合后的方案交给他之前，脚本再让一个低价模型对着代码把方案里每句关于代码现状的话核一遍并记账，没核过就不让带这份方案的 ADR 的 PR 通过合并检查），等他定。
  - 同一天又出现一次：按 PR 411 第 2 轮复核修改 ADR 0242 时，复核模型说的是“`DecisionInputs` 没有读取次数这类计数字段”，线程写进 ADR 时写成了“没有计数字段”，没有自己打开文件核对；它其实有 `relatedStats` 这类数字字段。第 3 轮复核指出后已改成对着代码核过的说法。改的时候又犯了一次：只核对了外部读取这一处的决策记录编号是随机生成的，却写成所有决策记录都这样，第 4 轮复核指出后改成只说核对过的那一处。硬门槛落地之前，这类错误还会再出现。

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
- 硬约束（G107，2026-10-14）：`opencode-orchestration` skill 的 scripts/evidence-gate.sh。[oc-wait.sh](https://github.com/sixianli/himawari-agent/blob/a56903d808de68423561a52d5e4db4b0b622191b/.claude/skills/opencode-orchestration/scripts/oc-wait.sh)（opencode 批次）和 [grok-wait.sh](https://github.com/sixianli/himawari-agent/blob/a56903d808de68423561a52d5e4db4b0b622191b/.claude/skills/opencode-orchestration/scripts/grok-wait.sh)（Grok 批次）每次被叫醒都会运行它，检查本轮新增的证据，范围是交接目录，加上 `.ci-output/handoff/evidence-roots.txt` 列出的 Hermes 和云服务器证据目录。出现以下任一情况，等待脚本以退出码 3 结束，这一批不被接受：
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
- 硬约束（2026-10-15）：`.ci-output/handoff/scripts/require-quiet-host.sh hermes|cloud`。它列出测试账号下仍在运行的 `vitest`、`local.mjs`、解包、安装和 `bwrap` 进程，并记录 loadavg；只要有一个，就打印 QUIET_HOST_BUSY 并以退出码 1 结束，没有才打印 QUIET_HOST_OK。每个对照测量脚本的第一步必须调用它，退出码不是 0 就不开跑。Claude 审核时，测量证据里没有 QUIET_HOST_OK 的对照结果一律退回。验证：2026-10-15 两台主机各有测试在跑时，它对两台都以退出码 1 拒绝。
- 第四次（2026-10-15，方向反过来）：最终候选版本 `04660f2b` 的第 3 层（完整 `npm test`）运行期间，Claude 为了腾空间，在同一块固态盘上对两个旧测试副本算摘要、`du`，并删除 1.7 GB 的 `r2-l3`（11:36:19 结束）。同一时段运行的 `node-runtime-installation-permissions.test.ts` 第一个“安装完整产物”用例跑满 30 秒时限失败；它在此前 5 次第 3 层里用时 21.5–24 秒，同文件第二个同类用例这次也慢到 26.9 秒。根据时间重合推断是这次干扰造成的，没有单独复现。5772 个用例里只有这一个失败，整轮第 3 层作废重跑，损失约 30 分钟。
- 第四次的根因：上面的检查只在开跑前看一次，管不到“跑的过程中自己又在同一台机器上做重活”；什么时候能动测试主机，仍然靠记忆。
- 新增硬约束（2026-10-15）：Hermes 上的第 3 层用 `.ci-output/handoff/scripts/start-hermes-run.sh run-l3w.sh <标签>` 启动（第 4 层用 run-l4w.sh），它在 Hermes 上以 `setsid -f` 运行包装脚本，确认摘要出现后才返回。包装脚本同时启动 `.ci-output/handoff/scripts/foreign-watch.sh`：每 2 秒检查一次，找出本次运行开始后新出现的 `rm`、`du`、`find`、`sha256sum`、`tar`、`git`、`cp`、`dd`、`node`、`python3` 等进程，条件是它们既不在本次运行所在的 cgroup（Linux 内核给每次 SSH 登录分配的进程组，测试用 `setsid` 开的子进程仍留在里面），又在某个登录会话（`session-*.scope`）里。用户自己的定时服务（例如每小时运行的 `trendradar`）在 `user@1000.service` 下，不算外来进程，只记在负载日志里；负载日志另外每 10 秒记录 `/proc/pressure/io`（进程因等待磁盘而停住的时间比例）。只要发现外来进程，摘要写 `foreign-check=DISTURBED`，脚本以退出码 75 结束；没有才写 `foreign-check=clean`。归档脚本 post-l3.sh 看不到 `foreign-check=clean` 就以退出码 3 拒绝，这次运行的产物和结果不能当作候选包或证据。
- 硬约束的验证（Hermes，2026-10-15）：第一版按“进程会话号”区分，模拟运行里两种情况都判对了，但真实的第 3 层把测试框架用 `setsid` 开的 `vitest`、`tsc` 误报成外来进程（`cc-layer3-04660f2b-r2`，2868 行），因为模拟运行没有这种子进程。改成按 cgroup 判断后，模拟运行加入了测试自己用 `setsid` 开的读盘子进程：旁边不做事时判为 CLEAN；另一个 SSH 登录同时运行 5 秒的 `dd` 时判为 DISTURBED，并记下了 `dd` 和它的 `session-3599.scope`。post-l3.sh 对没有这一行的 `cc-layer3-04660f2b` 以退出码 3 拒绝。限制：2 秒以内结束的短命令可能漏掉，这类命令对测试计时的影响也小。
- 第五次（2026-10-16）：`d2f90d2e` 不过滤的第 4 层 `cc-layer4-35d6800f-full-r2` 运行期间，Claude 等 opencode 复审会话结束时用的 [oc-wait.sh](https://github.com/sixianli/himawari-agent/blob/a56903d808de68423561a52d5e4db4b0b622191b/.claude/skills/opencode-orchestration/scripts/oc-wait.sh) 自动调用证据检查脚本 [evidence-gate.sh](https://github.com/sixianli/himawari-agent/blob/a56903d808de68423561a52d5e4db4b0b622191b/.claude/skills/opencode-orchestration/scripts/evidence-gate.sh)，它登录 Hermes 运行 `python3 - --since … /data/hermes/himawari/tool-audit-round2/r2-u1/evidence`（05:10:05–05:10:17，`session-4552.scope`）。干扰检查如实记下并判为 `DISTURBED`，约 95 分钟的运行不能用于冻结。
- 第五次的根因：第四次的约束只“事后发现”干扰，不“事前阻止”；工具链里会自动登录测试主机的脚本（证据检查、上传时的摘要校验、包装脚本里的任意命令）不知道主机上正有受保护的运行，什么时候不能动主机仍然靠人记得。
- 新增硬约束（2026-10-16）：run-l3w.sh 和 run-l4w.sh 开跑时在 Hermes 上写 `~/.agent-quiet-run`（内容是包装脚本的进程号和运行标签），退出时删除；进程号仍存活时，另一次受保护运行以 QUIET_RUN_ALREADY_ACTIVE 拒绝启动。看到这个标记且进程仍在时：`.ci-output/handoff/scripts/hermes-ssh.sh` 只放行由 `cat`、`grep`、`ls`、`tail`、`head`、`wc`、`test`、`stat`、`date`、`echo` 组成且不含重定向和命令替换的命令，其余以退出码 68 和 HERMES_QUIET_RUN_ACTIVE 拒绝；`hermes-upload.sh` 同样拒绝（它的摘要校验会在 Hermes 上运行 `sha256sum`）；`opencode-orchestration` skill 的 [evidence-gate.sh](https://github.com/sixianli/himawari-agent/blob/a56903d808de68423561a52d5e4db4b0b622191b/.claude/skills/opencode-orchestration/scripts/evidence-gate.sh) 对远端证据目录打印 [EVIDENCE_REMOTE_DEFERRED](https://github.com/sixianli/himawari-agent/blob/a56903d808de68423561a52d5e4db4b0b622191b/.claude/skills/opencode-orchestration/scripts/evidence-gate.sh) 并判为失败，不启动 `python3`。只读命令的分类由 `.ci-output/handoff/scripts/test-ssh-wrappers.sh` 每次检查，证据检查的延后由 skill 的 tests/test_evidence_check.py 检查。
- 新约束的验证（Hermes，2026-10-16）：用复制的 run-l4w.sh（只把测试换成 40 秒等待）做模拟受保护运行。改前版本的证据检查在运行期间启动了 `python3`，干扰检查记下 3 行并判为 `DISTURBED`；改后版本打印 [EVIDENCE_REMOTE_DEFERRED](https://github.com/sixianli/himawari-agent/blob/a56903d808de68423561a52d5e4db4b0b622191b/.claude/skills/opencode-orchestration/scripts/evidence-gate.sh) 并以退出码 3 结束，`hermes-ssh.sh` 以退出码 68 拒绝 `du`、放行 `cat`，运行判为 `clean`，结束后标记已删除；运行期间 `hermes-upload.sh` 以退出码 68 拒绝，第二次受保护运行以 QUIET_RUN_ALREADY_ACTIVE 拒绝启动。test-ssh-wrappers.sh 对改前的 `hermes-ssh.sh` 有 7 个用例失败，对改后的全部通过。记录在 `.ci-output/handoff/quiet-run-evidence-2026-10-16/`（本地，不进 git）。skill 改动是 agent-skills 仓库的 `8214761`。
- 第六次（2026-10-23）：候选 `d2accc2e` 的第 3 层 `cc-layer3-d2accc2e-r1` 运行期间，Claude 为了提前演练第六次的归档工具，直接用 `ssh … hermes` 在 Hermes 上运行 build-rehearsal-stage.py，它用 `cp -a` 复制了整个第六版安装目录（09:08:24–09:08:46，`session-12943.scope`）。干扰检查判为 `DISTURBED`，6139 项全部通过的结果作废，重跑 `cc-layer3-d2accc2e-r2`，损失约 30 分钟。
- 第六次的根因：第五次的约束放在包装脚本 `hermes-ssh.sh`、`hermes-upload.sh` 里，但直接 `ssh` 不经过它们；项目说明 `AGENTS.md` 的 Hermes 连接一节写的正是直接 `ssh` 的命令，所以绕过包装脚本不需要任何额外动作。
- 新增硬约束（2026-10-23）：Claude Code 的命令执行前检查钩子 hermes_direct_ssh_guard.py（源文件 `.ci-output/handoff/hermes-direct-ssh-guard/`，本地，不进 git；装在 `~/.claude/hooks/`，在 `~/.claude/settings.json` 的 [PreToolUse](https://github.com/sixianli/himawari-agent/blob/a56903d808de68423561a52d5e4db4b0b622191b/.claude/skills/readable-output/hooks/hooks.json) 里对 `Bash` 注册）。命令里某一段以 `ssh`、`scp`、`sftp`、`rsync` 开头（允许前面有 `until`、`if`、`do`、`timeout <秒数>`、变量赋值等前缀），且同一段出现 `hermes`、`hermes-home` 或 `100.64.53.104` 时，拒绝执行并打印 HERMES_DIRECT_SSH_REFUSED；引号里提到这些字不算。`AGENTS.md` 改为只准用两个包装脚本。限制：只管 Claude Code 的 Bash 工具；opencode 等代理在 Hermes 上的操作仍靠包装脚本和 `.agent-quiet-run` 标记。
- 新约束的验证（Mac，2026-10-23）：test-guard.sh 的 19 项全部通过。把 09:08 造成干扰的那条命令原样交给钩子，被拒绝；同一操作改用包装脚本的写法被放行；`grep "ssh hermes"`、连别的主机的 `ssh` 被放行。钩子由用户安装后，再在 Claude Code 里实际执行一条直接 `ssh` 确认被拒绝。

[回到目录](#编码代理反复犯的错误)

<a id="upload-before-written"></a>

## 文件还没写好就上传到测试主机

- 反复出现的情况：在同一批并行执行的命令里，一边写或改本地脚本，一边用 `cat <文件> | ci-ssh.sh 'cat > <远端路径>'` 上传它。上传时本地文件还不存在或还是旧内容；`cat` 报错，但管道整体仍返回 0，测试主机上留下一个空文件或旧文件，随后跑的就是错的脚本。
- 为什么要紧：测试结果来自一个不是本次写的脚本，结论不可信，还要花一轮去查为什么“改了没生效”。
- 再次发生的证据：2026-10-14 第 24 批（R2-P1）先后三次：run-step.sh、install-dep2.sh、run-unit.sh（见停止文件 24k、24p）。
- 第三次的根因：前两次只在停止文件里写了提醒；上传的写法本身允许“本地文件不存在却成功”，所以提醒拦不住。
- 硬约束（2026-10-15）：
  - `.ci-output/cloud-test-host-2026-10-14/ci-ssh.sh` 拒绝把标准输入写进远端文件的命令（`cat >`、`tee`、`dd ... of=`），退出码 65，提示改用上传脚本。Claude、opencode、Grok 都必须经过这个包装脚本连云端测试主机，所以对所有人生效。
  - `.ci-output/cloud-test-host-2026-10-14/ci-upload.sh <本地文件> <远端路径>`：本地文件不存在就以退出码 2 结束；上传后比较两边的 SHA-256，不一致以退出码 3 结束；只允许写到 `/srv/himawari-ci/` 和 `/tmp/` 下。
  - 验证：旧包装脚本对一个尚未写出的文件执行 `cat 不存在的文件 | ci-ssh.sh 'cat > /tmp/g107-old.sh'`，退出码 0，远端留下 0 字节文件；新包装脚本对同一命令以 65 拒绝；ci-upload.sh 对不存在的文件以 2 拒绝，对真实文件输出 UPLOAD_OK 和一致的摘要。

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
  - 本地提交钩子 `.git/hooks/pre-commit` 调用 `.git/hooks/check-new-comments.py`。它读取暂存区里新增的行，用解析器找出 TypeScript/JavaScript、Python 和 shell 文件里的注释（字符串、模板字符串和正则表达式里的 `//` 不算），只要新增行里有注释就打印 NEW_CODE_COMMENTS_REJECTED 和位置，并以退出码 1 拒绝提交。工具指令（例如 `biome-ignore`、`@ts-expect-error`、文件首行的 `#!`）和只是挪了位置的原有注释不算新增。
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
  - 2026-10-16 第四次的候选从 `04660f2b` 换成 `35d6800f`：生成候选材料的工具 `.ci-output/production/fourth-freeze-tools/run-cand.sh` 已改成把“构建源码输入记录工具”放到 `fourth-source-inputs-<版本前 8 位>` 目录，它使用的模板 `capture-build-source-inputs.template.mjs` 却仍写死 `fourth-source-inputs-01`，并在运行时核对自己是否就在这个位置，于是记录步骤以 `BUILD_CAPTURE_FIXED_HERMES_ENVIRONMENT_REQUIRED` 失败。这次在 Hermes 上生成材料时就暴露了，没有进入操作包。
  - 2026-10-16 第四次的安装演练第一次真正跑到验收阶段：验收输入清单 `cloud-inputs.draft.json` 的摘要早已重算，`schema`（清单格式名）却还是 `himawari-third-cloud-acceptance-inputs.v1`，`profile`（运行场景名）还是 `cloud-third-deployment`，9 个路径还在第三次的工作目录 `/var/tmp/himawari-third-20261012/` 和发布目录 `2026-10-12-third` 下。第四次的 `finalize-cloud-inputs.py` 等脚本只接受第四次的值，生产 S6 会在这里停下。下面的一致性检查当时只比摘要，所以判为通过。
- 第三次的根因：前两次之后的预防都是“换候选包时记得核对”，由起草的人逐项想起来；操作包从上一次复制而来，旧值看起来和新值一样合理，没有任何东西在冻结或执行前机械地比较“清单写的”和“包里实际的”。
- 硬约束（2026-10-15）：
  - 操作包里的 `inputs/check-packet-consistency.py <操作包目录>`：核对验收输入清单和四份 `OWNED-SHA256SUMS` 的每一条摘要；对每个没登记的文件，只要有已登记的文件按路径或文件名引用它，就判为漏登记；从操作包材料里的候选安装包读出 `runtime-sandbox/dist/` 下的三个文件，核对 `bootstrap.mjs` 写死的摘要，并要求每个替换锚点在对应文件里恰好出现一次。任何一项不符就打印问题清单，以退出码 1 结束。
  - 生产入口 `.ci-output/production/run-fourth-step.sh` 在执行每个生产步骤（包括第一步上传）前先运行它，不通过就打印 FOURTH_PACKET_INCONSISTENT，以退出码 3 结束，不连接生产服务器。安装演练脚本 run-fourth-rehearsal.sh 的第一阶段也先运行它。下一次起草操作包时，入口脚本和检查脚本随包一起复制，检查跟着生效。
  - 验证：直接对第三次的操作包 `2026-10-12-third-deploy-packet-03` 运行，检查指出了当年导致 S6 失败的三个过期摘要和三处锚点不符，以及 `raw-copy-recovery.mjs` 漏登记；修正后的第四次操作包通过。夹具 `inputs/verify-packet-consistency.py` 在副本上重现过期探针摘要、漏登记的载入文件、过期的目录摘要、漏登记的被载入模块和改过的已登记脚本五种情况，都以退出码 1 拒绝，未改动的副本通过。在临时副本上弄坏一条摘要后运行入口脚本，以退出码 3 停下，放在 `PATH` 里的假 `ssh` 一次也没被调用。
  - 补充（2026-10-16）：run-cand.sh 生成记录工具后，先确认工具里不再残留 `fourth-source-inputs-01`，并且工具里写死的位置正好是它实际存放的位置，否则打印 CAPTURE_PATH_LEFT 或 `CAPTURE_TOOL_PATH_MISMATCH` 并以退出码 2 结束，不再运行记录步骤。验证：按 run-cand.sh 的方式只替换版本号、不替换目录名时，检查打印 CAPTURE_PATH_LEFT 并以退出码 2 结束；两处都替换后通过。
  - 补充（2026-10-16，第五次之后）：前面的检查只核对“清单记的摘要”和“文件实际内容”，没核对清单自己的身份字段是不是这一次的。`check-packet-consistency.py` 现在从验收输入清单的真实使用者 `finalize-cloud-inputs.py` 读出这一次的工作目录、发布目录、`schema` 和 `profile`，要求清单的 `schema`、`profile`、`runtime`、`sourceRoot`、`evidenceRoot` 与之相等，并且清单里其余以 `/var/tmp/` 或 `/opt/himawari/releases/` 开头的路径都在这一次的目录下，否则打印 `CLOUD_INPUT_IDENTITY_STALE` 并以退出码 1 结束；读不到这些值时打印 `CLOUD_INPUT_CONSUMER_IDENTITY_NOT_FOUND`。期望值取自使用者脚本，不由检查自己另写一份。验证：夹具 `verify-packet-consistency.py` 新增旧 `schema`、旧 `profile`、旧工作目录下的路径、旧发布目录下的 `runtime` 四种情况，加检查前四种都以退出码 0 漏过，加检查后都以退出码 1 拒绝，10 个夹具全部通过；对修正前的操作包，旧检查判通过，新检查报 11 处。
  - 限制：只能发现“被已登记文件按名字引用”的漏登记；按拼接出来的路径载入的文件发现不了。身份字段只检查验收输入清单，期望值只取 `finalize-cloud-inputs.py` 一处，`run-cloud-acceptance.sh`、`run-network-preparation.py` 等其他使用者里写死的同一组值不比对；路径只看 `/var/tmp/` 和 `/opt/himawari/releases/` 两个前缀。其他清单里的格式名（例如 `composition-source-contract.json` 的 `schema`）没有脚本校验，仍可能留着上一次的名字。
- 第六次变更第六次 S6 在 `S6_READ` 失败（2026-10-24，R2-D30），同样出在 `bootstrap.mjs`，但不是摘要过期：
  - `bootstrap.mjs` 用两处正则在作业宿主 `job-host-main.js` 的 `phase = "x";` 后面插入 `__probeStage("x");`（记录探针阶段的调用）。候选从 `5bab4de1`（2026-10-18）起有一处不带花括号的 `if (...) phase = "ready"; else stop("host_failure");`，插入后 `else` 前多了一句，改写出来的模块有语法错误，宿主一加载就以退出码 1 结束，生产报 `SERVICE_ENVIRONMENT_REAL_READ_FAILED`，临时读服务留在 failed 状态。
  - 上面的一致性检查只要求每个锚点恰好出现一次，这次全部通过；没有任何检查加载改写后的模块。最终演练 final-rehearsal.sh 也从没跑过 S6_READ 的探针。
- 这一次的根因：探针对候选源码做文本改写，检查只核对改写前的锚点，不核对改写后的结果能不能运行；演练覆盖的阶段里又没有 S6_READ。
- 硬约束（2026-10-24，G176，revision-06）：
  - 修法：两处插入改成逗号表达式 `phase = "x", __probeStage("x");`，在不带花括号的分支里仍是一句。
  - 演练入口 run-sixth-rehearsal.sh 加 `probe` 阶段，用真实的 `measurement/probe/run-service-probe.py --hermes-rehearsal` 在装好的候选上跑一次 S6_READ 的探针。最终演练 final-rehearsal.sh 要求它退出 0、`probe-run.json` 和 `read-report.json` 都通过、宿主 12 项和沙箱线程 6 项计时齐全（打印 PROBE_NEW_PASSED），否则判定 `FAIL`。
  - 同一次最终演练再用 revision-05 的旧 `bootstrap.mjs`（摘要 `418b9592…`，开头核对摘要，不符时以 OLD_BOOTSTRAP_PROOF_CHANGED 停下）跑一遍，必须以生产上的同样特征失败：`REAL_SANDBOX_READ_FAILED`、`host_failure`、`taskStarted: false`、宿主只记下载入事件、宿主退出码 1（打印 PROBE_OLD_FAILED_AS_PRODUCTION），否则也判定 `FAIL`。这证明新阶段确实跑到了宿主加载这一步，不是在更早的地方通过或失败。
  - 验证（Hermes `rehearsal-87c2e3ec-r06/`，输出存于 `.ci-output/handoff/rev05/r06-rehearsal-output.txt`）：新 `bootstrap.mjs` 通过，旧的按生产上的方式失败，`REHEARSAL_VERDICT=PASS`。
  - 限制：演练用 `--hermes-rehearsal` 在普通账号下运行，不经过生产的 `systemd-run` 和服务账号，只证明改写结果能加载并完成一次读取。以后再对候选源码做文本改写时，检查要加载改写后的结果，不能只数锚点。

[回到目录](#编码代理反复犯的错误)

<a id="long-blocking-wait"></a>

## 代理在一条命令里同步等待长时间运行，会话被中断

- 反复出现的情况：opencode 把完整测试或产品路径测试交给测试主机后，在同一条 shell 调用里循环等待它结束（例如 `for i in $(seq 1 400); do …; sleep 10; done`）。这条调用在结束前不产生任何事件，opencode 约一小时后以 `Session interrupted: inactivity` 结束会话；测试本身还在跑，但没人收尾、复制证据、写停止文件。
- 为什么要紧：一批工作卡住一个多小时，Claude 要重新续跑会话、重新交代现场；中断时若测试已结束，临时目录和证据也可能没人处理。
- 再次发生的证据：2026-10-13 两次（一次等待重试循环，一次连续两轮完整测试，见 `opencode-orchestration` skill）；2026-10-15 第 30 批（R2-T11）后台启动 `run-09-full` 后又用 400 × 10 秒的循环等待，工具超时设为 70 分钟，17:37 被中断。
- 第三次的根因：前两次之后规则写进了简报模板（“超过 40 分钟的命令后台启动，不要在一次调用里等超过 40 分钟”），第 30 批简报也照写了；代理确实后台启动了测试，却又写了一个长等待循环，文字规则拦不住。
- 硬约束（2026-10-15）：
  - 连测试主机的唯一入口都限时：`.ci-output/cloud-test-host-2026-10-14/ci-ssh.sh`（云测试账号）和新的 `.ci-output/handoff/scripts/hermes-ssh.sh`（Hermes，经 Tailscale，并核对主机名是 `hermes-home`）把每条远程命令放在 `timeout 300` 里执行，超时以退出码 124 结束并打印 CI_SSH_TIME_LIMIT 或 HERMES_SSH_TIME_LIMIT，说明改为后台启动、再用短命令查询。上限没有可调的参数。
  - 往 Hermes 传文件用 `.ci-output/handoff/scripts/hermes-upload.sh <本地文件> <远端路径>`（与 ci-upload.sh 相同：本地文件必须存在、两边 SHA-256 一致、只能写到测试目录）。
  - 本地、不提交的 `.opencode/opencode.json` 和 `.grok/config.toml` 禁止命令里出现 Hermes 的 Tailscale 地址 `100.64.53.104`、`ssh … hermes`、`scp … hermes`、`rsync … hermes`，所以 opencode 和 Grok 只能经过上面的限时入口。
  - 验证：在 opencode 里直接执行 `ssh … hermes hostname` 被拒（`permission.rejected`），执行 `hermes-ssh.sh 'hostname'` 返回 `hermes-home`；两个入口各执行一个 400 × 10 秒的循环，都在约 300 秒时以 124 结束并打印时限说明；同一入口里用 `setsid nohup` 后台启动 330 秒的任务立即返回，任务照常跑完。
- 同类再次发生（2026-10-18 23:41）：三个 opencode 会话（D-49、D-51、第 4 层 D、E 组）在测试主机上后台启动测试后，在本机一条命令里先 `sleep 100`、`sleep 240`、`sleep 260` 等，再经限时入口查结果，合计七次以上。会话没有被中断，但每次都要等到 opencode 命令时限才被切断，白等约两分钟后重来。
- 这次约束为什么没拦住：300 秒上限只加在连测试主机的入口里，管不到这些入口前面在本机执行的 `sleep`；简报里“不要在一次调用里长时间等待”仍是文字提醒。
- 硬约束（2026-10-18 23:41）：
  - 本地、不提交的 `.opencode/opencode.json`（以及 `.ci-output/worktrees/` 下各工作副本里的同名副本）加四条拒绝规则：`*sleep ???;*`、`*sleep ??? &&*`、`*sleep ???`，以及 `sleep ???` 后紧跟换行的一条。opencode 2.0.32 的规则只支持 `*`（任意多个字符）和 `?`（任意一个字符），写不出“只匹配数字”，所以规则拦的是 `sleep` 后面恰好三个字符、再跟分号、` &&`、换行或命令结尾的写法，也就是 100 到 999 秒的等待；两位数以内的 `sleep` 放行。顺带会误拦 `sleep 0.5;` 这类少见写法，被拒时改用整数秒即可。
  - `.grok/config.toml` 加了同样写法的三条规则；Grok 现在按 G112 暂停，它的通配规则是否支持 `?` 未经实测，恢复使用前要先实测。
  - 验证：按 opencode 2.0.32 规则匹配函数的原样逻辑离线检查 16 个例子，应拦的 6 个全被拦、应放行的 10 个（含 `sleep 30; ls`、`sleep 60; echo`、循环里的 `sleep 20;`）全放行。在正在运行的会话里，规则加入前 `sleep 240;`、`sleep 260;`、`sleep 200;`、`sleep 100;` 都照常执行；加入后 D-49 会话执行 `sleep 100; … ci-ssh.sh …` 以 `Permission denied` 被拒，D-51 会话执行 `sleep 28; …` 正常完成（记录在 `.ci-output/handoff/r2p2-d49/impl-01.jsonl`、`.ci-output/handoff/r2p2-d51/impl-01.jsonl`）。
  - 等长运行的做法：Hermes 用 `.ci-output/handoff/scripts/hermes-wait.sh`；云测试账号每次用一条几秒内结束的命令查结果文件，中间先做不依赖结果的事。
- 加了三位数 `sleep` 规则之后又出现三次（2026-10-19，都在纠正之后）：
  - 02:5x：把 `sleep 100` 挪进 `hermes-ssh.sh '…'` 的远程命令里；同一时段另一个会话写了 `/tmp` 下的循环脚本（100 次 `sleep 30`），在一条命令里用 `bash` 同步执行，拒绝规则看不到脚本内容。
  - 04:4x：一条本机命令 `for i in 1 … 10; do ci-ssh.sh '…'; sleep 25; done`，自设命令时限 420000 毫秒，同步等了约 7 分钟。
  - 06:1x：把 `sleep 80` 放进 `ci-ssh.sh '…'` 的远程命令里等待。
  - 另外，代理会自己设 shell 工具的时限参数（见过 1800000 毫秒），所以 opencode 默认的命令时限也靠不住。
- 这次约束为什么没拦住：拒绝规则只能按命令文字的固定写法匹配（只认 `*` 和 `?`），只能拦“`sleep` 后跟三个字符”这一种写法；同样的等待换成远程命令、脚本文件、循环或两位数 `sleep`，规则就看不到。
- 硬约束（2026-10-19）：
  - 本地、不提交的 opencode 插件 `.opencode/plugins/wait-guard/index.ts`（插件：opencode 启动会话时自动加载的一段程序，它在 `tool.execute.before` 钩子里能在工具执行前拒绝这次调用）。拒绝时的信息以 `WAIT_GUARD_REFUSED:` 开头，并写明正确做法。它拒绝：shell 工具时限设为 0 或超过 300000 毫秒；一条命令前台部分里所有 `sleep` 加起来超过 30 秒（包括 [ci-ssh.sh](https://github.com/sixianli/himawari-agent/blob/a56903d808de68423561a52d5e4db4b0b622191b/.claude/skills/opencode-orchestration/tests/test_oc_server_steer_watch.py)、`hermes-ssh.sh` 引号里的远程命令，以及 `bash -c`、`python3 -c` 的内容）；`sleep(` 后跟超过 30 的数字（例如 Python 的 `time.sleep(600)`）；含 `sleep` 的 `for`/`while`/`until` 循环；用 `bash`、`sh`、`zsh` 或路径直接运行的本机脚本中含上述写法（只放行仓库里那一份 hermes-wait.sh，按真实路径判断，别处的同名脚本照样检查）；以及每一次 `execute` 工具调用（opencode 的代码执行工具，能写忙循环长时间卡住，本项目用不到它）。用 `setsid -f` 或后台方式启动的部分不检查，因为它们不会让这次调用等待。
  - 两个连测试主机的入口 [ci-ssh.sh](https://github.com/sixianli/himawari-agent/blob/a56903d808de68423561a52d5e4db4b0b622191b/.claude/skills/opencode-orchestration/tests/test_oc_server_steer_watch.py)、`hermes-ssh.sh` 在连接之前，按同样的规则检查远程命令（`sleep` 合计超过 30 秒，或含 `sleep` 的循环），命中就以退出码 71 拒绝，打印 CI_SSH_LONG_WAIT_REFUSED 或 HERMES_SSH_LONG_WAIT_REFUSED。
  - 本地、不提交的 `.opencode/required-plugins.txt` 记下插件的 SHA-256。主检出目录和 `.ci-output/worktrees/` 下每个有 `.opencode/` 的工作副本都放一份插件和清单。启动脚本 [oc-launch.sh](https://github.com/sixianli/himawari-agent/blob/a56903d808de68423561a52d5e4db4b0b622191b/.claude/skills/opencode-orchestration/scripts/grok-launch.sh)（agent-skills `03d01a8`）在启动目录有这份清单时逐行核对：缺插件、摘要不符、格式错误或清单为空都以退出码 2 拒绝启动，所以缺了插件的工作副本开不出会话。改插件后要同步更新每一份副本和清单。
  - 验证（证据在 `.ci-output/handoff/wait-guard/`，汇总见 `.ci-output/handoff/2026-10-19-wait-guard-stop.md`）：
    - 用嵌套的 opencode 会话逐条实跑：没有插件的目录里 15 条全部照常执行；最终插件拒绝全部应拒绝的写法，放行 `sleep 3`、`grep -n "sleep\|while"`、`while read` 逐行处理、带 `for` 的 `shasum`/`wc`、`setsid -f` 后台启动和白名单脚本；新加的规则对上一版插件逐条对照，上一版放行、新版拒绝。
    - test-ssh-wrappers.sh 的新用例对改动前的入口全部失败，改动后全部通过，原有用例仍通过。
    - [oc-launch.sh](https://github.com/sixianli/himawari-agent/blob/a56903d808de68423561a52d5e4db4b0b622191b/.claude/skills/opencode-orchestration/scripts/grok-launch.sh) 的 9 条新单元测试改动前 6 条失败，改动后全部通过。
  - 插件写出来时就在写它的会话里生效，第一版当场误拦了一条只算摘要的命令：它把 `shasum` 的路径参数当成要运行的脚本去读内容。误拦会逼代理想办法绕开约束，所以“该放行的”和“该拒绝的”两组用例同样要有，每次误拦的原命令都存成证据文件（`false-positive-01.cmd.txt`），加进放行用例。

[回到目录](#编码代理反复犯的错误)

<a id="reply-not-chinese"></a>

## 给用户的文字没用简体中文

- 反复出现的情况：Claude 发给用户的文字（进度说明、汇报、结论）用了英文，多发生在长时间写英文简报、英文提交说明或读英文工具输出之后。用户的全局规则要求所有给用户的文字都用简体中文。
- 为什么要紧：用户要逐句翻译才能看懂进度和结论，容易看漏需要批准的事项；每次都要指出、再重说一遍。
- 再次发生的证据：
  - 2026-10-14 和 2026-10-16 各被指出一次（Claude 的记忆 `chinese-for-every-progress-line.md`：一次是零散短句，一次是整段汇报）。
  - 2026-10-16 本会话第三次：一句说明沙箱限制的话用了英文，原句是本节硬约束测试里的复现句。
  - 用下面的检查脚本回查本项目全部会话记录里发给用户的正文：2026-09-24 以来几乎每个会话都有英文句子，共 1701 行；上一个会话（2026-10-14 到 10-16）有 314 行。实际次数远多于被指出的三次。
- 第三次的根因：之前的预防只有全局说明、用户设置里的 `language: chinese` 和一条记忆，都要靠 Claude 在写每一句话时想起来；长时间读写英文后这些提醒不起作用，英文发出后也没有任何东西报错，所以被发现的只是用户恰好指出的几次。
- 硬约束（2026-10-16）：
  - 检查脚本 [check_chinese_reply.py](https://github.com/sixianli/himawari-agent/blob/a56903d808de68423561a52d5e4db4b0b622191b/.claude/skills/readable-output/hooks/hooks.json) 在公开仓库 agent-skills 的 `readable-output` skill 里（提交 `f2db76e`，本机路径 `~/.claude/skills/readable-output/scripts/`）。它去掉代码块、行内代码、以 `>` 开头的引用行、引号里的原文、Markdown 链接和含 `/` 的路径之后，把一段不含汉字的文字判为英文句子的条件是：至少 4 个英文词、其中至少 2 个是 `the`、`to` 这类常用虚词；或者是至少 3 个词、带 1 个虚词、以句号等结尾的句子。也可以用 `python3 <脚本> check <文件>` 检查一份草稿。
  - 用户级设置 `~/.claude/settings.json` 里挂了四个钩子（Claude Code 在固定时刻自动运行的命令），对本机所有项目的 Claude 会话生效：
    - [MessageDisplay](https://github.com/sixianli/himawari-agent/blob/a56903d808de68423561a52d5e4db4b0b622191b/.claude/skills/readable-output/hooks/hooks.json)（正文显示给用户时）运行 `record`，把显示的正文存到 `~/.claude/reply-language/<会话编号>.txt`；
    - [PostToolBatch](https://github.com/sixianli/himawari-agent/blob/a56903d808de68423561a52d5e4db4b0b622191b/.claude/skills/readable-output/hooks/hooks.json)（一批工具调用结束、下一次请求模型之前）运行 `batch`，发现英文就把原句和“先用中文重说”的要求交给 Claude，并在界面上提示用户；
    - `Stop`（Claude 准备结束这一轮时）运行 `stop`，同时检查最后一条回复，发现英文就不让这一轮结束，直到用中文重说；
    - [PreToolUse](https://github.com/sixianli/himawari-agent/blob/a56903d808de68423561a52d5e4db4b0b622191b/.claude/skills/readable-output/hooks/hooks.json) 匹配 `AskUserQuestion`（向用户提问之前）运行 `ask`，问题或选项是英文就拒绝这次提问。
  - 验证：
    - 先写 21 个单元测试并看它们失败，再实现脚本后全部通过；测试包括本次的复现句会被报出，以及中文里夹着标识符、代码块、引用行、链接时不误报。
    - 用本项目全部历史正文试跑，被报出的行几乎都是真正的英文句子；唯一一类误报是把英文文档标题当链接文字，已改为跳过链接，并补了测试。
    - 现场：设置生效后，[MessageDisplay](https://github.com/sixianli/himawari-agent/blob/a56903d808de68423561a52d5e4db4b0b622191b/.claude/skills/readable-output/hooks/hooks.json) 在工具运行前就把显示的中文正文写进了记录文件；把复现句追加进记录文件后，那一批工具调用一结束，[PostToolBatch](https://github.com/sixianli/himawari-agent/blob/a56903d808de68423561a52d5e4db4b0b622191b/.claude/skills/readable-output/hooks/hooks.json) 就把它报给了 Claude 并要求中文重说；记录里只有中文时不报。`Stop` 和 `AskUserQuestion` 两个钩子只用合成的钩子输入验证过。
  - 限制：
    - 文字显示出来就收不回；钩子保证的是每次发出英文后立刻被发现并重说，而不是事先拦住。
    - 只检查真正显示为正文的文字。Claude 写的一部分文字被记成“思考摘要”（系统自动生成的中文概括），不经过 [MessageDisplay](https://github.com/sixianli/himawari-agent/blob/a56903d808de68423561a52d5e4db4b0b622191b/.claude/skills/readable-output/hooks/hooks.json)，所以不检查。
    - 子代理（Claude 派出去做辅助工作的代理）的文字用户看不到，钩子在子代理里不检查。
    - 只对本机的 Claude Code 生效；opencode 和 Grok 不直接对用户说话，不在范围内。
    - 少于 3 个词的英文（例如单独一个 `Done.`）不报。

[回到目录](#编码代理反复犯的错误)

<a id="zsh-word-expansion"></a>

## 在 Mac 上的 Bash 工具里写了 zsh 会展开的词

- 反复出现的情况：Claude 在本机执行命令的 Bash 工具，实际由 zsh（macOS 默认的命令行外壳，规则和 bash 不同）执行。Claude 按 bash 的习惯写命令，常见两种：
  - 选项值里不加引号的通配符，例如 `grep --include=*.ts`。zsh 把整个词当成文件名通配，找不到这样的文件就报 `no matches found`，这一条命令根本不执行。
  - 以 `=` 开头的词，例如分隔线 `echo =====` 或 `[ "$a" == "$b" ]`。zsh 把 `=名字` 当成“找名为这个的命令的路径”，报 `not found`。
- 为什么要紧：命令没执行，但同一行里的其他命令照常输出，工具也不总是标为失败，所以经常只得到一部分结果，例如搜索代码时漏掉整类文件，却以为“没有匹配”。每次都要多一轮排查和重跑。
- 再次发生的证据：
  - 2026-10-16 本会话里，`--include=*.ts`、`--include=*.md`、`--include=*.sh` 报错 8 次，`echo =====` 报错 3 次；会话交接时已写明“第三次时必须加硬约束”，之后又出现一次。
  - 用下面的检查脚本回放本项目全部 9 个会话记录里的 15837 条命令：2026-09-24 到 2026-10-16 共有 288 条命令因此出错（选项通配 398 处，`=` 开头的词 75 处），几乎每天都有。
- 第三次的根因：之前的预防只有 2026-10-13 写的一条记忆（`zsh-pitfalls-in-bash-tool.md`），要靠 Claude 写每条命令时想起来；而出错时工具常常不报失败，错误信息也没有直接说是引号问题，所以每次只是绕开，没有东西拦住下一次。
- 硬约束（2026-10-16）：
  - 检查脚本 `~/.claude/hooks/zsh_word_guard.py`（本机文件，不在任何仓库里；SHA-256 为 `dba3d7cefc3af32dd457f2576441a75c1af22420ea4c857457e2d6628eec7c97`）。它按外壳的规则切分命令，跳过单引号、双引号、反斜杠转义的部分和 here-document（`<<'EOF'` 到 `EOF` 之间原样传给程序的文字），只在两种情况下报出：一个没加引号的、以 `-` 开头的选项词在 `=` 之后有 `*`、`?` 或 `[`；或者一个词以没加引号的 `=` 开头且不止一个字符（`[[ ]]` 里的 `==`、`=~` 除外）。
  - 用户级设置 `~/.claude/settings.json` 的 [PreToolUse](https://github.com/sixianli/himawari-agent/blob/a56903d808de68423561a52d5e4db4b0b622191b/.claude/skills/readable-output/hooks/hooks.json) 钩子（Claude Code 在每次运行工具之前自动执行的命令）匹配 `Bash`，运行这个脚本；发现上述词就拒绝这次命令，并把要加引号的词和改法告诉 Claude。它对本机所有项目的 Claude 会话生效。
  - 验证：
    - `python3 ~/.claude/hooks/zsh_word_guard.py selftest` 跑 22 个例子全部通过，包括本次的复现命令被拒，以及 `--include='*.ts'`、`ssh 主机 '…'` 里的远程命令、here-document 和 `git commit -m "$(cat <<'EOF' … EOF)"` 里的文字、`[[ $a == b ]]`、`ls *.md` 都放行。
    - 回放上面 15837 条历史命令：288 条真实出错的命令全部被拦，没有一条正常命令被误拦。
    - 现场：设置生效后，在 Bash 工具里执行 `echo --probe=*.zz-not-a-file` 被钩子拒绝；改成 `echo '--probe=*.zz-not-a-file'` 后正常执行。
  - 限制：
    - 不管路径里的通配没匹配到文件的情况（例如 `ls vitest.config.*`），回放里有 133 条：这类通配本来就是想匹配文件，没匹配到时报错本身就说明文件不存在，事先也无法可靠判断命令中途会不会生成文件。
    - 不管 zsh 不按空格拆分变量的情况（例如 `H="ssh -o …"; $H hostname` 报 `command not found`），这类错误会直接报错，不会悄悄少结果。
    - 只对本机的 Claude Code 生效；opencode 和 Grok 的命令由 bash 执行，没有这个问题。
  - 补充（2026-10-17）：同一个检查脚本又加了管道退出码的检查，上面的 SHA-256 是加之前的版本；当前版本见[检查命令的结果被管道或 `!` 掩盖](#masked-exit-status)。

[回到目录](#编码代理反复犯的错误)

<a id="future-timestamp"></a>

## 记录里写了还没到的时间

- 反复出现的情况：Claude 在计划、交接、方案文件或提交前的记录里写“现在”的时间时，没有先查当前时间，而是估一个整数分钟，结果往后凑成了还没到的时刻。第二轮里被发现并记下的三次：
  - 2026-10-17 约 00:20 写进 .agents/tasks/round2-tool-execution/plan.md 的两条，标为 00:40（同一内容的提交 `6587e8f` 在 00:24），更正见 plan.md 里 00:45 一条；
  - 同日约 10:21 写进 plan.md 的一条，标为 10:25，更正见 10:23 一条；
  - 同日 12:46 写下的方案草稿，标题误写成 13:00（东京时间），后来当场改回 12:46。
- 加约束时用回放又找到同日两次没人发现的：00:30 写的 `.ci-output/handoff/2026-10-17-fifth-catalog-comparison.md` 标题标为 00:40（之后已改成 00:30）；10:22 写的 `.ci-output/handoff/2026-10-17-truncated-key-claude-proposal.md` 标题标为 10:40，这个标题用来说明“Claude 的方案先于 DeepSeek 写下”，已加更正（文件修改时间 10:22:53 早于咨询说明的 10:23:16，先后关系不变）。
- 为什么要紧：计划和交接文件只能追加，写错的时间改不掉，只能再追加更正；后来的人按时间先后判断“哪份方案先写、哪次提交先发生”，例如向 DeepSeek 咨询独立方案时要证明 Claude 的方案写在对方之前，时间不对就会得出错误结论。
- 第三次的根因：前两次之后的预防只是交接说明里的一句“写时间前先运行 `TZ=Asia/Tokyo date`”，要靠 Claude 每次想起来；写记录时注意力在内容上，没有任何东西在写入那一刻检查时间。用下面的回放脚本检查本项目 9 个会话记录里的约 2 万次写入，同样的“往后凑整”在 2026-09-27 到 2026-10-17 之间约有 90 次，几乎每个会话都有，只是大多没人发现。
- 硬约束（2026-10-17）：
  - 检查脚本 `~/.claude/hooks/tokyo_timestamp_guard.py`（本机文件，不在任何仓库里；SHA-256 为 `89c762c9eb22071ce0e3102081da8ddfada1be213da7079d603a836f3084b04e`）。它在 Claude 写文件（Write、Edit、MultiEdit、NotebookEdit）或运行命令（Bash）之前，找出这次新加的时间：带今天或明天日期的 `YYYY-MM-DD HH:MM`，以及后面跟“东京”或前面有“东京时间”的 `HH:MM`。原文里已有的时间、时间段（`10:00-12:59`）、带时区的时间（`Z`、`UTC`、`+00:00`）、同一行写着别的日期的时间、同一行有“预计”“计划”“截止”“到期”“定时”“会在”等字样的计划时间、同一行有“更正”“标为”“写成”“实际写于”等字样的更正，以及代码文件（`.py`、`.ts`、`.json` 等）里的时间都不查。只要有一个时间比现在的东京时间晚 1 分钟以上，就拒绝这次写入，并告诉 Claude 先运行 `TZ=Asia/Tokyo date '+%Y-%m-%d %H:%M'` 再写。
  - 用户级设置 `~/.claude/settings.json` 的 [PreToolUse](https://github.com/sixianli/himawari-agent/blob/a56903d808de68423561a52d5e4db4b0b622191b/.claude/skills/readable-output/hooks/hooks.json) 钩子（Claude Code 在每次运行工具之前自动执行的命令）以 `Write|Edit|MultiEdit|NotebookEdit|Bash` 匹配，运行这个脚本；它对本机所有项目的 Claude 会话生效。
  - 验证：
    - `python3 ~/.claude/hooks/tokyo_timestamp_guard.py selftest` 跑 27 个例子全部通过，包括上面三次错误的复现被拒、改成真实时间后放行，以及历史时间、时间段、计划时间、更正里引用的错误时间、带时区的测试数据、代码文件、前一天深夜的时间都放行。
    - 回放：`python3 ~/.claude/hooks/tokyo_timestamp_replay.py ~/.claude/hooks/tokyo_timestamp_guard.py <本项目会话记录目录>`（SHA-256 `e250e20641d7540664b07eebb642faa3a6540b5db37f2a69408e6dea32b40c4f`）按每次写入的实际时刻重放，三次已知错误和上面另找到的两次都被拦下；其余被拦的逐条看过，都是同一种“往后凑整”，例如 22:24 把“更新：22:40”写进状态文件。仍会误拦的是同一天写的格式说明和测试样例（例如 Markdown 里举例的“2026-10-02 10:00 建立任务”），每个会话至多一两次，按提示换个写法即可。
    - 现场：设置生效后，12:57 用 Write 写入一行标为“13:17 东京”的标题，被钩子拒绝；改成 `date` 查到的 12:57 后正常写入。
  - 限制：只对本机的 Claude Code 生效。opencode 和 Grok 不写计划和交接里的时间（它们的停止文件只写日期），回放里的约 90 次也都是 Claude 写的；如果以后它们的记录也出现这种错误，按同样的规则给它们的写入加检查。钩子只能证明时间“没有晚于现在”，写成更早的错误时间（例如 12:57 误写成 12:30）它拦不住。

[回到目录](#编码代理反复犯的错误)

<a id="hand-written-wait"></a>

## 等待后台任务时手写的“结束”或“存活”条件写错

- 反复出现的情况：Claude 在 Hermes 上后台启动长任务（测试链、演练）后，每次临时手写一条轮询命令，判断“任务结束了没有”“进程还在不在”。条件写错时，等待要么从没开始、要么提前醒来、要么把已经结束的任务当成还在跑；清理命令也可能把自己杀掉。
- 为什么要紧：上线前的演练和测试链都要几分钟到一个多小时，等错了就会在错误的时刻往下走（例如以为演练还在跑而停下准备工作，或者任务早已失败却一直等），也可能在清理时误杀自己的连接，留下一半没清理的现场。
- 再次发生的证据（都在 2026-10-17，东京时间）：
  - 13:50 清理一次中止的测试链时，`pkill -f "inputs/r2t14-wf-green-chain.sh"` 把这条 SSH 调用自己也杀掉了。原因是 `hermes-ssh.sh` 在远端用 `bash -c '<整条命令>'` 和 `timeout … bash -c …` 执行命令，这两个进程的命令行里就含有同样的文字。当时在本文里没查到先例，按第一次处理。
  - 16:07 前后等第五次候选测试链时：条件先用了带 `|` 的正则，`hermes-ssh.sh` 把含 `|` 的命令当成会改东西的命令，在安静运行（整次测试期间只许只读命令的保护）期间以退出码 68 拒绝，等待根本没开始；改成 `grep -q -e 'DONE$'` 后，又被前面的 CAND_DONE 行提前满足。会话交接把它记为第二次，预防写成一句提醒：“装上等待条件前先试跑一次，确认它在未完成时返回 1”。
  - 18:23 第二次演练的等待命令里，“进程已经不在”的分支用 `pgrep -f run-fifth-rehearsal.sh` 判断。因为同样的自我匹配，它永远显示“还在”，这条分支不可能触发；那次只是因为演练正常写出了结束行，等待才结束。
  - 18:39 准备第三次演练时，开头的保护 `pgrep -f run-fifth-rehearsal.sh && exit 3` 匹配到自己，误报“演练还在跑”并退出。这一步之前 Hermes 上没有任何改动。
- 第三次的根因：
  - 每次等待的条件都是临时手写的，对不对全靠当时想得周到。
  - 第二次之后的预防只是一句要靠记住的提醒，而且只说了“完成”条件，没管“存活”条件。
  - 包装脚本多包的那一层 `bash -c` 让远端的 `pgrep -f` 和 `pkill -f` 必然匹配到自己。这一点从来没有任何检查指出来。
- 硬约束（2026-10-17）：
  - `.ci-output/handoff/scripts/hermes-ssh.sh` 和 `.ci-output/cloud-test-host-2026-10-14/ci-ssh.sh` 在连接之前检查远程命令，拒绝 `pgrep -f`、`pkill -f`，包括 `-af`、`-fl`、`--full`，以及中间夹着别的选项的写法（例如 `pgrep -u andy -f …`）。
    - 被拒时退出码 69，打印 HERMES_SSH_SELF_MATCH_REFUSED 或 CI_SSH_SELF_MATCH_REFUSED，并给出正确写法：启动时用 `setsid -f bash -c 'echo $$ > <进程号文件>; exec bash <脚本>'` 记下进程号，再用 `test -d /proc/<进程号>` 判断进程在不在。
    - Claude、opencode、Grok 连 Hermes 和云测试账号都只能经过这两个脚本，所以对三者都生效。
  - 新的等待脚本 `.ci-output/handoff/scripts/hermes-wait.sh <远端日志> '<结束行文字>' <远端进程号文件>`：
    - 用进程号判断存活；用固定字符串（`grep -F`，不是正则）判断完成。它发出的远程命令都是安静运行允许的只读命令。
    - 开始等待前先自检。日志不存在、或结束行已经出现时，退出 2；进程已经不在、日志里也没有结束行时，退出 3。
    - 之后每隔 HERMES_WAIT_INTERVAL 秒（默认 60）查一次。出现结束行时打印该行并退出 0；进程没了却没有结束行时退出 3；连续 5 次查不到时退出 4。
  - `.ci-output/handoff/scripts/test-ssh-wrappers.sh` 给每个包装脚本新增 10 条用例：5 条自我匹配写法必须被拒，5 条正常写法必须放行（例如 `pgrep -x node`、`test -d /proc/1234`）。原来那条“`pgrep -f vitest` 放行”的用例改成必须被拒。
- 验证（证据在 `.ci-output/handoff/2026-10-17-waiter-constraint/`）：
  - 本地：先用去掉新检查的两个包装脚本副本跑 test-ssh-wrappers.sh，12 条自我匹配用例（两个脚本各 6 条）全部失败，命令被原样发出，其余 35 条通过；换成新包装脚本后 47 条全部通过（`test-ssh-wrappers.before.out`、`test-ssh-wrappers.after.out`）。
  - Hermes 现场重现（`selfmatch-reproduction.out`）：用一个已经结束的假任务对比三种写法。
    - `test -d /proc/<进程号>` 显示它已经不在。
    - 旧包装脚本里的 `pgrep -f hw-job.sh` 却显示“还在”，`pgrep -af` 列出的正是包装脚本自己的 `bash -c` 和 `timeout` 进程。
    - 新包装脚本以退出码 69 拒绝同一条命令。
  - hermes-wait.sh 在 Hermes 上实测四种情况（`wait-*.out`）：
    - 日志里先有一行 `stage=inputs done rc=0`、20 秒后才写出 `stage=all done rc=0` 的假任务：没有被前一行提前满足，结束行出现后退出 0。
    - 不写结束行就结束的假任务：退出 3。
    - 结束行在开始等待前就已存在：退出 2。
    - 日志不存在：退出 2。
  - 临时目录 `/tmp/h79KJ`（约 4 KB）用完已删除（`hermes-cleanup.out`）。
- 限制：
  - 本机核实过一次：Claude 在 Mac 上的 Bash 工具里执行 `pgrep -fl 'zz-selfmatch-probe-x'` 返回 1，没有匹配到自己（`local-pgrep-probe.out`），所以本机暂不加同样的检查。
  - `ps … | grep <文字>` 也会匹配到 `bash -c` 里的同样文字，但没有拦，因为它常用来让人查看进程列表；判断存活要用进程号，不要用它。
  - 启动时没有记下进程号的任务，只能靠它的日志和结果文件判断是否结束。
  - 多次运行一直往里追加的日志（例如演练的 `rehearsal.log`），可能已经有上一次留下的同样结束行。这时等待脚本按设计退出 2，不会把旧行当成这次结束（2026-10-17 19:14 实际遇到一次，`wait-e-shared-log.out`）。改为等这次启动时新建的输出文件，例如演练的 `run-shape.out`。
  - 任务没写结束行就退出、而它的进程号又被系统分给了别的进程时，等待脚本会一直认为任务还在。这种情况只能靠人工查看日志发现（DeepSeek 审核时指出，没有实际遇到）。
- 补充（2026-10-17 晚上）：这项检查误拦了 `.ci-output/handoff/scripts/require-quiet-host.sh cloud`。它的远程查询用 `pgrep -af "vites[t]|…"`，方括号写法本来已经避开了自我匹配，却仍被以退出码 69 拒绝，所以从加检查起，云测试主机上的对照测量都无法开始（脚本以退出码 2 结束，不会误报安静）。已改成 `ps -u "$(id -u)" -o pid=,args= | grep -E "vites[t]|…" || true`，在云测试账号上实际运行输出 `QUIET_HOST_OK cloud`。
- 第四次（2026-10-18 东京时间，硬约束没拦住）：
  - 16:58 起，opencode 修复第三项的测试会话等 Hermes 空闲：每次经 `hermes-ssh.sh` 扫描 `/proc/*/cmdline`，看有没有 `vitest`、`oc-l0rr` 字样的进程。扫描命令自己就写着这些字样，而包装脚本把整条命令放进远端 `bash -c` 和 `timeout` 的命令行，所以每次都扫到自己、报“有测试在跑”。修复第四项的两轮测试 17:09:28 结束后 Hermes 已经空闲，它直到 17:19:15 换上新包装脚本后才发现空闲并启动，白等了约 10 分钟。
  - 同一天 Claude 给修复第四项写的简报推荐 `ps -u andy -o pid,args > 文件; grep …`，同样会匹配到包装脚本自己；那次会话用方括号写法（`vites[t]`）才躲开。
  - 为什么第三次的约束没拦住：它只拦 `pgrep -f`、`pkill -f` 这两种写法，没去掉“远端命令行里带着整条命令原文”这个根因。上面“限制”里已经写明 `ps … | grep` 会自我匹配但没拦，扫描 `/proc` 是又一种写法，靠列举写法拦不完。
- 硬约束（2026-10-18，去掉根因）：
  - 两个包装脚本先把远程命令做 base64 编码（把任意文字变成只含字母、数字和 `+/=` 的文字），远端执行 `bash -c 'eval "$(printf %s <编码> | base64 -d)"'`，在同一个 shell 里解码执行。远端 `bash -c`、`timeout` 和外层登录 shell 的命令行里只有编码后的文字，扫描 `/proc`、`ps … > 文件; grep`、`pgrep -f` 都不会再匹配到这次调用自己，也不会匹配到别的代理同时发出的调用。
  - 原来对 `pgrep -f`、`pkill -f` 的拒绝保留，理由改为：按命令行文字匹配会碰到提到同样文字的无关进程（看日志的 `tail`、编辑器、同一脚本的另一次运行），判断存活仍用进程号。
  - test-ssh-wrappers.sh 新增 8 条用例（每个包装脚本 4 条）：发给 ssh 的远程命令串里不能出现原命令文字；用本机替身 ssh 真正执行远程命令串，含单引号、双引号、`$HOME` 原样输出和退出码 3 的命令结果必须与直接执行相同；执行命令的 shell 用 `ps -p $$ -o args=` 看自己的命令行，里面不能有原命令文字。
- 验证（证据在 `.ci-output/handoff/2026-10-18-selfmatch-constraint/`）：
  - 本地：旧包装脚本副本（`hermes-ssh.before.sh`、`ci-ssh.before.sh`）上，新用例里“原文字不进远端命令行”和“自己的命令行里没有原文字”两类共 4 条失败，其余 63 条通过（`test-ssh-wrappers.before.out`）；新包装脚本上 67 条全部通过（`test-ssh-wrappers.after.out`）。
  - Hermes 现场（`selfmatch-reproduction.out`）：找一个不存在的进程名，旧包装脚本扫描 `/proc` 报 `running=1`、`ps` 加 `grep` 匹配 3 行；新包装脚本两种都是 0，退出码 5 原样传回。hermes-wait.sh 经新包装脚本自检正常（`wait-done-before-start.out`）。
  - 云测试账号上没有现场运行：本次会话不连接 `84.247.157.41`，[ci-ssh.sh](https://github.com/sixianli/himawari-agent/blob/a56903d808de68423561a52d5e4db4b0b622191b/.claude/skills/opencode-orchestration/tests/test_oc_server_steer_watch.py) 只用替身 ssh 验证过。
  - 按 G142 由 opencode 逐行审核（`opencode-go/deepseek-v4.1-flash#high`，两个免费模型隔 30 秒各两次限流后改用；`.ci-output/handoff/2026-10-18-selfmatch-review-stop.md`），没有阻断问题。退出码、输出、引号、`$`、多行、空命令、读标准输入和 `$0`、`$$` 在本地逐项对照与改前相同；本地检查仍对原命令文字生效。不改的发现：`tr -d '\n'` 多余但无害；命令超过约 98 KB 时 base64 后会超过 Linux 单个参数 128 KiB 的上限（改前约 128 KB），实际命令只有几 KB；替身 `timeout` 和 `hostname` 不校验参数，`timeout` 那一行这次没有改。
- 仍有的限制：`ps … | grep <文字>` 这种管道写法里，`grep` 和 `ps` 同时运行，`grep` 自己的参数带着这段文字，仍可能匹配到自己；要么先写到文件再 `grep`，要么用方括号写法，判断存活仍用进程号。

[回到目录](#编码代理反复犯的错误)

<a id="sidecar-reader-choice"></a>

## 演练脚本在每个读取位置手选数据库读法，和附属文件的实际情况对不上

- 反复出现的情况：第五次变更的形状演练脚本 maintenance/verify-production-shape-chain.mjs（在 Hermes 上照生产步骤顺序跑一遍维护程序的演练）要多次只读查看 SQLite 数据库。它有两种只读打开方式：
  - 严格读法 `openRecoveryReadonly`：带 `immutable=1`，不建任何文件；数据库旁已有 `-wal`、`-shm` 两个附属文件（SQLite 写前日志模式下的日志和共享内存文件）时直接以 FIFTH_RAW_COPY_DATABASE_SIDECAR_PRESENT 拒绝。
  - 宽松读法 s0Reader.openReadonly：普通只读连接，附属文件已在时照常读；附属文件不在时会自己建出来，关闭时因为只读、不能做检查点（把日志写回数据库），也删不掉它们。
  - 每个读取位置由写代码的人凭当时的理解挑一种。挑严格读法而附属文件已在，这次读取失败；挑宽松读法而附属文件不在，读取本身成功，却留下附属文件，让后面的严格读取失败。
- 为什么要紧：生产维护程序在服务停止期间全部用严格读法，演练要证明它们在生产现场能通过；演练自己留下或误判附属文件，会让演练在与生产无关的地方失败，几分钟的运行白跑，上线一再推迟；反过来也可能掩盖生产上真的会遇到的附属文件。
- 三次经过（都在 2026-10-17，东京时间）：
  - 18:50 那次演练：`doctor` 在 S7_DB_STATUS 和 S7_CATALOG_UPGRADE 之间运行、留下附属文件，S7_CATALOG_UPGRADE 之后的回读又用了严格读法。修法写在提交 80dd13c9 的说明里，其中已经写明“宽松读法也会留下附属文件”。
  - 21:14 第二次运行：新加的“升级后句柄回读”放在了换成宽松读法之前，用了严格读法，完整模式和续做模式都在这里失败。
  - 21:24 第三次运行：修第二次时把续做模式里“失败后句柄回读”也换成了宽松读法，它在数据库旁建出附属文件，随后续做的 S7_CATALOG_UPGRADE 在严格读法处以 FIFTH_RAW_COPY_DATABASE_SIDECAR_PRESENT 失败。第二次运行同一位置用严格读法时续做是通过的，两次之间这一段只改了这一行，据此认定原因。生产不受影响：20:36 的只读诊断显示生产数据库目录只有 `product.sqlite`，之后服务一直停着，没有程序再打开数据库。
- 第三次的根因：
  - 选哪种读法取决于数据库此刻有没有附属文件，而这个状态会被别的步骤（`doctor`、`db status`、宽松读取本身）悄悄改变；脚本却让每个读取位置自己挑。
  - 前两次的预防只是提交说明里的文字，没有任何检查在读错的那一刻报错，错误要等到后面另一个步骤才暴露。
- 硬约束（2026-10-17，在 verify-production-shape-chain.mjs 里，每次运行都执行）：
  - 删掉可以随时改写的读法变量和按调用点切换读法的辅助函数。所有读取只经过 readDatabase，它在读之前查看附属文件：没有就用严格读法，已经有了才用宽松读法；读完再核对附属文件名单和读之前完全相同，不同就以 PRODUCTION_SHAPE_READBACK_CHANGED_SIDECARS 当场失败。
  - 脚本启动时检查自己的源码：直接调用只读打开函数的地方只许出现在定义两种读法的那一行，否则以 PRODUCTION_SHAPE_DATABASE_READER_OUTSIDE_READBACK_READERS 失败，防止以后又绕过统一入口自己挑读法。这一条由 DeepSeek 在独立方案里提出（它答题前读到了 Claude 先写的方案文件，所以这次的方案不算完全独立）。
  - 生产维护代码不改：它每一步的读法是固定的，服务停止期间都用严格读法，遇到附属文件直接报错，正是生产要的保证。
- 验证（Hermes `/data/hermes/himawari/tool-audit-round2/r2-l12/rehearsal-c53bca70/revision-02-code/`，变体脚本 `.ci-output/handoff/scripts/fifth-revision-02-readers-variant.sh`；已结束运行的日志和报告复制在 `.ci-output/handoff/prod-fifth-evidence-c53bca70/revision-02-handles/hermes/`）：
  - `runtime`：把选择强制成宽松读法，重现第三次的错误。第一次读数据库（S0 回读，此时没有附属文件）就以 PRODUCTION_SHAPE_READBACK_CHANGED_SIDECARS 失败，报错显示读前没有附属文件、读后多了 `-wal`、`-shm`，在运行中证实了“宽松只读连接会自己建附属文件”（`readers-variant-runtime/`；加静态检查前的版本上同样结果，`readers-variant-runtime-before-static-check/`）。
  - `static`：照第三次出错时的写法，在“失败后句柄回读”处直接调用 s0Reader.openReadonly。脚本一加载就以 PRODUCTION_SHAPE_DATABASE_READER_OUTSIDE_READBACK_READERS 失败（`readers-variant-static/`）。
  - 不改的版本：完整模式和续做模式都走到 S8_READBACK 和 S9 回滚并通过（加静态检查前的版本 `attempt-04-before-static-check/`：完整 16 条、续做 19 条检查）。
- 限制：静态检查只认点号调用 `.openReadonly(`、`.openRecoveryReadonly(`；用别名、解构或下标调用，以及经产品函数 `common.readMaintenanceState(..., true)` 用宽松读法，它都看不出来，只能靠读后核对附属文件名单兜底（DeepSeek 审核指出）。生产维护程序本身的读法不在这两道检查内，仍靠每一步固定的严格读法。

[回到目录](#编码代理反复犯的错误)

<a id="masked-exit-status"></a>

## 检查命令的结果被管道或 `!` 掩盖，失败后下一步照样执行

- 反复出现的情况：用一条命令的成败决定下一步（用 `&&`、`||` 连接，或之后读 `$?` 这个“上一条命令的退出码”），但拿到的成败其实来自别的东西：
  - 管道的最后一段。管道（`|`）把前一个命令的输出交给后一个命令，整条管道的退出码只取最后一段。例如 `git merge --ff-only … 2>&1 | tail -2 && git push …`：合并失败了，`tail` 照样成功，`&&` 就认为整条成功。
  - `!` 取反。例如 `! grep -q -E -f <模式文件> …`：模式写错时 `grep` 以 2 报错退出，`!` 把报错当成“没找到”，检查直接放行。
- 为什么要紧：本该被挡住的推送、删除、提交会在前一步失败后照样执行，而屏幕上看起来一切正常；写进证据的“退出码”也是错的，审核时会被当成检查通过。
- 发生记录：
  - 2026-10-13：往公开仓库 agent-skills 提交前的私人信息检查用了 `!` 写法，模式文件里的 Perl 写法让 `grep -E` 报错，`!` 把报错当成通过，提交 `12296fa` 没经过真正的检查（事后复查是干净的）。之后的预防只是 Claude 记忆里的一条写法规定，而且只管这一种检查。
  - 2026-10-14：`cat <文件> | ci-ssh.sh 'cat > …'` 上传时本地文件还没写好，`cat` 报错但管道整体返回 0，测试主机上留下空文件（见[文件还没写好就上传到测试主机](#upload-before-written)；那次加的约束只管上传这一种命令）。
  - 2026-10-16：在 agent-skills 仓库根目录跑一个 skill 的测试，输出报 `Start directory is not importable`（根目录没有测试），接了 `| tail` 之后退出码却是 0，Claude 没看输出就推送了 `6b71d01`（只改文档），事后补跑。之后的预防仍是记忆里的一句提醒：“要看输出里的 `OK` 行，不要只看接了 `| tail` 之后的退出码”。
  - 2026-10-17 晚上：合并 agent-skills 的提交时写了 `git merge --ff-only 6e53b8f 2>&1 | tail -2 && git push origin main 2>&1 | tail -2 && git worktree remove …`。main 已经前进，快进合并失败，推送（没有内容可推）和删除工作副本照样执行了。提交对象还在，在新的 main 上重做成 `74d1760` 后才补回来。
  - 用下面的检查回放本项目 12 个会话记录里去重后的 18918 条命令：381 条有这种写法（过滤管道后接 `&&` 330 处、接 `||` 29 处、之后读 `$?` 68 处），其中 106 条后面接着提交、推送、删除等有后果的命令。读 `$?` 的一类里，有 2026-10-17 的严格文档校验 `validate_docs.py . --strict 2>&1 | tail -8; echo rc=$?` 和第五次操作包一致性检查 `check-packet-consistency.py … | tail -5; echo "exit=$?"`，打印出来的都是 `tail` 的退出码；2026-09-25 还有一份验收证据这样把 `exit_code=$?` 写进了文件。
- 第三次以后的根因：之前的预防是两条记忆（一条只管“私人信息检查”，一条只管 skill 测试），要靠写命令时想起来；管道这种形式没有任何东西拦。Claude 为了少看输出，习惯在命令后面接 `| tail`，而失败时截下来的几行输出里不一定看得出失败。
- 硬约束（2026-10-17）：
  - 检查脚本 `~/.claude/hooks/zsh_word_guard.py`（本机文件，不在任何仓库里；这一版的 SHA-256 为 `be6f223771620319bd2c02f0ec0327ffd5d3138ae0f83cedc7101972b4fff0e8`）新增 masked_gates。它按外壳规则切分命令，跳过引号、here-document（`<<'EOF'` 到 `EOF` 之间原样交给程序的文字）和 `"$(…)"` 里的内容，找出最后一段是过滤输出的命令的管道，例如 `tail`、`head`、`grep`（带 `-q` 的除外）、`sed`、`awk`、`cut`、`tee`、`cat`、`sort`、`uniq`、`wc`、`tr`。这样的管道后面接 `&&`、`||`（`|| true`、`|| :` 除外），或下一条命令读 `$?`，就报出。命令前面已经用 `set -o pipefail` 或 `setopt pipefail` 打开 pipefail（管道里任一段失败、整条管道就算失败的外壳选项）时不报。
  - Claude：用户级设置里已注册的 [PreToolUse](https://github.com/sixianli/himawari-agent/blob/a56903d808de68423561a52d5e4db4b0b622191b/.claude/skills/readable-output/hooks/hooks.json) 钩子（Claude Code 每次运行 Bash 工具之前自动执行的检查）同时运行这项检查，发现就拒绝这条命令，并给出改法：先把输出写进文件、单独记下退出码再看尾部；打开 pipefail；用 `${pipestatus[1]}` 取第一段的退出码；后面的命令本来不依赖前一步时改用 `;` 连接。
  - 所有代理：Claude、opencode、Grok 连 Hermes 和云测试账号只能经过 `.ci-output/handoff/scripts/hermes-ssh.sh` 和 `.ci-output/cloud-test-host-2026-10-14/ci-ssh.sh`。两个包装脚本连接之前运行 `zsh_word_guard.py gates '<远程命令>'`，有问题就打印 MASKED_STATUS_REFUSED 并以退出码 70 结束，不连接；检查脚本不存在或自己出错时同样拒绝。
  - 验证：
    - `python3 ~/.claude/hooks/zsh_word_guard.py selftest` 的 42 个例子全部通过。新增的 20 个里，本次的合并命令、`| tail -3; echo "rc=$?"`、换行后读 `$?` 等 6 种必须被拒；打开 pipefail、`grep -q`、`|| true`、`${pipestatus[1]}`、引号和 here-document 里的文字、循环里的管道等 14 种必须放行。加检查之前这些例子无法通过（检查函数还不存在）。
    - 按钩子的输入格式送入本次的合并命令，被拒绝；改成先写文件、单独记退出码的写法后放行。
    - `.ci-output/handoff/scripts/test-ssh-wrappers.sh` 新增 6 个用例（每个包装脚本 3 拒 3 放）。改包装脚本之前，3 种应拒的远程命令在两个脚本上都被直接发出（6 个失败）；改之后 59 个用例全部通过。
  - 限制：
    - opencode 和 Grok 在本机执行的命令不经过这个钩子，只有发往测试主机的命令受包装脚本检查；它们在本机得到的检查结果，仍靠 Claude 审核时自己重跑或核对。
    - 认不出的写法：子外壳 `( a | tail ) && b`、`if a | tail; then`、命令替换 `x=$(a | tail) && b`、反引号里的管道，以及名单之外的过滤命令（例如 `jq`）。
    - 回放里被拦的 381 条命令多数是只读的串联（例如 `git show … | head -60 && git status`），这类命令被拦后要改用 `;`，多一轮往返。

[回到目录](#编码代理反复犯的错误)

<a id="brief-denied-text"></a>

## 给 opencode 的简报没提醒本地禁止规则会拦哪些命令

- 反复出现的情况：本地 `.opencode/opencode.json` 的禁止规则按整条 shell 命令的文字匹配，例如含 `ci-output/production` 或云服务器地址的命令一律拒绝。这样一来，对这些目录里文件的 `ls`、`cat`、`grep` 也被拒绝。简报要提醒 opencode 改用它自己的读文件、按文件名查找和内容搜索工具，但 Claude 写简报时漏了这句提醒。
- 为什么要紧：opencode 每次要先被拒绝 4 到 6 次，才自己换成读文件工具，或要 Claude 发纠正消息，白白耗掉时间和额度。
- 发生记录（都在 2026-10-17）：第五次操作包的两次审核，以及第六次操作包（R2-L13）的方案会话，三次都是这样。opencode-orchestration skill 里早就写着这条提醒，第三次仍然漏了。
- 第三次的根因：写简报时要靠 Claude 自己想到“简报里的路径会不会被禁止规则拦”；skill 里的文字提醒没有在漏写的那一刻报错。
- 硬约束（2026-10-17，opencode-orchestration skill，agent-skills 仓库提交 `74d1760`）：[oc-launch.sh](https://github.com/sixianli/himawari-agent/blob/a56903d808de68423561a52d5e4db4b0b622191b/.claude/skills/opencode-orchestration/scripts/grok-launch.sh) 启动新会话（检查简报）和续用会话（检查回复）之前，运行 scripts/brief-denied-text.py。它读出 `.opencode/opencode.json` 里形如 `*文字*`（不含空格和其他通配符，例如路径、文件名、地址）的 bash 禁止条目，只要简报或回复里出现这段文字，就必须有一行以 `本地禁止规则：` 开头的提示点名它；缺了就打印 [BRIEF_NAMES_DENIED_TEXT](https://github.com/sixianli/himawari-agent/blob/a56903d808de68423561a52d5e4db4b0b622191b/.claude/skills/opencode-orchestration/scripts/brief-denied-text.py) 和每段文字第一次出现的行，以退出码 2 结束，什么都不启动。配置读不懂时以 [OPENCODE_CONFIG_UNREADABLE](https://github.com/sixianli/himawari-agent/blob/a56903d808de68423561a52d5e4db4b0b622191b/.claude/skills/opencode-orchestration/scripts/brief-denied-text.py) 拒绝。简报模板里已带这一行。
- 验证：skill 的 10 个新测试里，5 个应拒的情况在改动之前都没被拒（失败），改动之后全部通过；整套 91 个测试和全仓校验通过。三份真实简报（两次审核和方案会话）上重现：去掉提示行时都被拒绝。
- 限制：只认 `*文字*` 这一种形状的禁止条目；带空格或别的通配符的条目（例如 `node *`）不检查，它们在简报里出现时仍靠 skill 的文字提醒。

[回到目录](#编码代理反复犯的错误)

<a id="turn-ended-before-done"></a>

## 代理在测试主机上的任务还没跑完就结束本轮

- 反复出现的情况：opencode 在 Hermes 上后台启动一次测试后，回复“跑完我再继续”就结束了本轮（opencode 一轮结束后进程就退出，后台没有任何东西会把它叫醒）。停止文件（代理完成或卡住时写给 Claude 的交接文件）要么还没写，要么留着“本节……填写”一类的占位。
- 为什么要紧：测试结果没人看、下一步没人做，这一批工作就停在那里，直到 Claude 发现后读 Hermes 日志、写回复、手动续跑会话。夜里无人值守时，一批能白白停上几十分钟。
- 发生记录（都在 2026-10-18）：
  - 01:42，第六次操作包乙部分（`2026-10-18-r2l13-packet-b-oc-1`），最后一句是 b-02 还在跑、跑完自动继续；
  - 02:29，R2-P2 接线（`2026-10-18-r2p2-wiring-oc-1`），停止文件第 97 行和第 176 行仍是“本节……填写”的占位；
  - 03:27，R2-P2 入口集成测试（`2026-10-18-r2p2-entry-tests-oc-4`），最后一句是 et-02 跑完再继续，Hermes 上 et-02 才刚开始。
- 第三次的根因：前两次之后，Claude 在回复里写了“等待不能靠结束本轮，用 hermes-wait.sh 等”，opencode-orchestration skill 里也早有“轮询而不要结束本轮”的文字；但 opencode 正常退出（退出码 0）时，启动脚本只记录退出码，不看这一批到底做没做完。所以文字提醒没在出错的那一刻生效。
- 硬约束（2026-10-18，opencode-orchestration skill，agent-skills 仓库提交 `63ff027`）：
  - [oc-launch.sh](https://github.com/sixianli/himawari-agent/blob/a56903d808de68423561a52d5e4db4b0b622191b/.claude/skills/opencode-orchestration/scripts/grok-launch.sh) 启动新会话前运行 `scripts/stop-file.py pick <简报>`：简报必须写明恰好一个还不存在的停止文件路径（以 `stop.md` 或 `stop-数字.md` 结尾），否则打印 [STOP_FILE_UNCLEAR](https://github.com/sixianli/himawari-agent/blob/a56903d808de68423561a52d5e4db4b0b622191b/.claude/skills/opencode-orchestration/scripts/oc-launch.sh)、退出码 2，什么都不启动；续跑时停止文件已经存在则打印 [STOP_FILE_EXISTS](https://github.com/sixianli/himawari-agent/blob/a56903d808de68423561a52d5e4db4b0b622191b/.claude/skills/opencode-orchestration/scripts/oc-launch.sh) 拒绝。
  - opencode 改由 scripts/oc-run.sh 运行：退出码为 0 而停止文件不存在、为空或含占位（`待填写`、`待补充`、`TBD`、“本节……填写”）时，自动用同一会话续跑，告诉代理先等完自己的任务再写停止文件，并在 `<前缀>.err` 里记 `AUTO_RESUME <次数>`；续跑次数用完（[OC_AUTO_RESUMES](https://github.com/sixianli/himawari-agent/blob/a56903d808de68423561a52d5e4db4b0b622191b/.claude/skills/opencode-orchestration/scripts/oc-launch.sh)，默认 2）仍没写完，就留下 `<前缀>.unfinished`，[oc-watch.py](https://github.com/sixianli/himawari-agent/blob/a56903d808de68423561a52d5e4db4b0b622191b/.claude/skills/opencode-orchestration/tests/test_oc_server_steer_watch.py) 报 `EXITED ... UNFINISHED`。
  - 验证：skill 新增 9 个测试，改动前 7 个失败；改动后整套 100 个测试通过。用真实材料重现：第二次那份留着占位的停止文件被判为没写完（`finished` 退出码 1，会触发自动续跑）；本批两份新简报都只选出各自的停止文件；接线简报的停止文件已存在，按新会话启动时被拒绝。
- 限制：只能发现“停止文件没写完”这一种没做完；停止文件写完了但内容不实，仍要靠 Claude 审核（见[审核时直接采信代理自报的检查结果](#trust-reported-checks)）。

[回到目录](#编码代理反复犯的错误)

<a id="backend-branch-omission"></a>

## 加了新的沙箱后端，共用逻辑只接在原来的一次性路径上

- 反复出现的情况：R2-P2 给前台工具加了常驻 SRT 任务环境（`backendRef` 为 `srt-task-environment`，一轮对话里的工具复用同一个已启动的沙箱）。原来只有一次性 SRT（`srt`，每次调用单独起一个沙箱）。几段对所有后端都该生效的共用逻辑——判断“工具从未启动”、到期结果恢复、运行中资源显示、工作区冲突排队——只认一次性路径的证据或只接在一次性路径的入口上，常驻路径走到时要么卡住，要么抛错让 Agent 服务退出。
- 为什么要紧：Linux 上前台工具一律走常驻路径（`apps/agent-service/src/production-sandbox-services.ts:186-195`），所以这类遗漏在生产上一定会被走到；D-49 会让 Agent 服务每次重启后就绪即崩溃。
- 再次发生的证据：
  - 2026-10-18 20:05 D-43：已保留、从未绑定的常驻调用在 Run 运行期间既不释放也不交付结果，“从未启动”判定只认一次性路径的三种依据（.agents/tasks/round2-tool-execution/plan.md 当天 20:05 一条）。
  - 2026-10-18 21:14 D-48：运行中资源投影没读任务环境调用登记，常驻调用一直显示“正在准备”。
  - 2026-10-18 22:09 D-49：到期结果恢复无条件读一次性控制工件 `sandbox-control:`，常驻记录没有这个工件，抛错经调度循环让服务退出；存储层 `assertDeadlineArtifacts` 也对所有后端要求该工件。
  - 2026-10-18 22:50 D-51：工作区被另一个 Run 未确认占用时，一次性路径排队等待，常驻路径直接拒绝（第四次）。
  - 2026-10-19 05:5x D-52：Worker 的常驻和容器路径在绑定之前失败时，`run` 的 `catch` 因诊断阶段从未赋值而直接返回“结果未知”，不写诊断、不释放预约，工作区一直被本 Run 占着；一次性路径同样的失败会写诊断并按“从未启动”结束（第五次，`.ci-output/handoff/2026-10-19-r2p2-d52-diag-stop.md`）。
- 第三次的根因：每段共用逻辑写的时候只有一个后端，分支条件和证据要求是隐含的；加常驻后端时靠人逐处找调用点，没有任何东西在“某个后端没走到某段共用逻辑”时失败。测试按后端分别写，常驻路径的测试只覆盖了新写的代码，没有对共用逻辑逐项重跑。
- 硬约束（2026-10-19，随 D-51 的提交）：
  - 产品在 `packages/execution-contracts/src/execution-environment-v1.ts` 导出后端清单 `SANDBOX_EXECUTION_BACKEND_REFS`（现在是 `srt` 和 `srt-task-environment`）。
  - 集成测试 `test/integration/sqlite-sandbox-execution-v2.test.ts` 的 `[R2-P2] sandbox backend parity` 里，按后端分别跑的两行（`it.each`）直接遍历这份清单，对每个后端各跑一遍：到期结果恢复用各自的证据、另一个 Run 未确认占用工作区时得到可排队的 `WORKSPACE_OCCUPIED`、释放后准入。另有一行守卫检查测试里的后端对照表和产品清单完全一致；产品加了后端而测试没跟上时，守卫或新后端那一行会失败。
  - 验证：工作区排队那一行套在不带 D-51 产品改动的树上（运行号 `stack-parity-red-01`，Hermes），一次性后端那一行通过，常驻后端那一行在断言原因码处失败（期望 `WORKSPACE_OCCUPIED`，实际 `WORKSPACE_QUEUED`，被请求自己的排队记录挡住）；带上 D-51 后两行都通过（`stack-parity-green-03`）。证据在 Hermes `/data/hermes/himawari/tool-audit-round2/r2-p2/stack/` 下对应运行号的目录。
  - 这张表在存储层，管不到 Worker 层：D-52 那样只在 Worker 某一条路径里漏掉的共用处理，它发现不了。
  - 还没覆盖的：容器任务环境后端不在产品清单里，它的同类问题（工作区冲突不排队）记在 [BL-20261019-001](backlog/BL-20261019-001-容-器-任-务-环-境-遇-到.md)；加入清单时这些行会自动对它生效。

[回到目录](#编码代理反复犯的错误)

<a id="layer3-exit-code"></a>

## 按 `local.mjs` 的退出码判定第 3 层

- 反复出现的情况：第 3 层（构建加完整 `npm test`）在测试主机上用 `node scripts/ci/local.mjs --check test`（项目的本地 CI 入口脚本）运行。它在本地跑完构建和测试后，还要把结果发布给安全审查服务；本地连不上这个服务，发布步骤报 `SECURITY_REVIEW_HTTP_NOT_FOUND`，`local.mjs` 于是以退出码 1 结束，即使构建和测试全部通过（`scripts/ci/local.mjs` 只要 `publicationFailures` 非空就把总状态写成 `failed` 并以 1 退出）。脚本按退出码判定时，就把通过当成失败。
- 为什么要紧：第 3 层是交付批次和生产候选的放行条件。判错会让正常的候选被停下、重跑，白占测试主机半小时以上；反过来，如果为了绕开它改成“只要是 1 就算通过”，被杀掉或真失败的运行也会被当成通过。
- 发生记录：
  - 2026-10-18 19:55：第六次“第 3 层加候选包”链的第一版写成 `[ "$RC3" = 0 ] || stop "LAYER3_RC $RC3"`，把预期的 1 当失败停下（`.ci-output/handoff/2026-10-18-r2p2-chain-rereview-stop.md`）。
  - 2026-10-18：交接文件 `.ci-output/handoff/2026-10-18-claude-session-handoff.md` 第 7 节把它记为第二次；之前的预防只是交接文件和简报里的一句提醒。
  - 2026-10-19：云测试账号的 ci-lane.sh 新加 `l3` 模式，用通用的 `step` 函数运行 `local.mjs`，`step` 把原始退出码写成 `layer3=1 seconds=…`，结尾的判定只要看到非零就报 `FAILED`。
- 第三次的根因：判定规则只写在提醒里，每个新脚本都要重新想起“不能看退出码”；而按退出码判定是写脚本时最顺手的写法，复用通用的 `step` 函数时尤其看不出来。没有任何东西在脚本到达测试主机之前检查它怎么判定第 3 层。
- 硬约束（2026-10-19 写好，2026-10-21 审核通过并启用）：
  - 判定脚本 `.ci-output/handoff/scripts/layer3-verdict.py <local-summary.json> <被测提交> <要求的检查>`：读 `local.mjs` 写出的 `local-summary.json`，要求 `context.testedSha` 等于被测提交、`checks` 恰好是要求的几项（同一项出现两次判 `DUPLICATE_CHECK`）且都是 `passed`、`publicationFailures` 里只有 `SECURITY_REVIEW_HTTP_NOT_FOUND`；全部满足打印 `LAYER3_VERDICT_PASSED` 并以 0 退出，否则打印 `LAYER3_VERDICT_FAILED <原因>` 并以 1 退出。文件缺失、不是 JSON、字段缺失都判失败。
  - 云测试账号的 ci-lane.sh `l3` 分支：`local.mjs` 的退出码只接受 0 和 1，其他值写 `layer3_abnormal_exit=<退出码>` 并判失败；是 0 或 1 时用锁定的 Python（`$HIMAWARI_CI_PYTHON -I`）运行判定脚本，`layer3=` 一行记判定结果，`seconds=` 从 `local.mjs` 启动时算起。两份脚本已放到 `/srv/himawari-ci/lane/`。
  - 所有代理：往测试主机传文件只能经过 `hermes-upload.sh` 和 ci-upload.sh。两个入口在连接之前检查要上传的文件：出现 `local.mjs` 而没有出现 `layer3-verdict.py` 时打印 `*_LAYER3_VERDICT_MISSING` 并以退出码 72 结束，不连接（[代理工具 Runbook 的排障表](https://github.com/sixianli/himawari-agent/blob/208007462f99e16c5c8cd4daac2acc10fa9f5f36/docs/runbooks/agent-tooling-runbook.md#troubleshooting)）。
  - 验证：
    - `.ci-output/handoff/scripts/test-layer3-verdict.sh` 的 11 个样例全部通过（通过、`test` 失败、多一项、少一项、重复项、别的发布失败、被测提交不同、缺字段、缺文件、坏 JSON、期望提交不同）。
    - `.ci-output/handoff/scripts/test-ssh-wrappers.sh` 115 个用例全部通过；其中每个入口有 2 拒 2 放的上传用例。改动前的入口把按退出码判定的旧版 ci-lane.sh 直接发出（替身 `ssh` 被调用）；第一轮只匹配 `scripts/ci/local.mjs` 的入口把“先 `cd scripts/ci` 再 `node local.mjs`”的文件直接发出；现在的入口对两者都以 72 拒绝。
    - 真实报告：Hermes 第 3 层 `cc-layer3-882cc959-r1` 的 `local-summary.json`（`local.mjs` 退出码 1，构建和测试都通过）判为通过；云测试账号 `r2p2-l3-01` 的报告（`test` 为 `infrastructure_failed`）在本机和云上用锁定的 Python 都判为失败。证据在本地 `.ci-output/handoff/layer3-verdict/` 的 `before/`、`after/`、`before-2/`、`after-2/`、`claude-review-2/`。
  - 限制：
    - 入口检查只看文字：只在说明文字里提到 `local.mjs` 的脚本也会被拦（改文字即可）；文件里提到 `layer3-verdict.py` 却不真正用它判定时拦不住，仍靠审核。
    - 已经在测试主机上的旧脚本（例如 Hermes 上的 run-l3w.sh 和另外 7 个调用 `local.mjs` 的脚本）不受影响，下次上传时会被拦下，届时改成用判定脚本。

[回到目录](#编码代理反复犯的错误)

<a id="layer0-related-tests"></a>

## 第 0 层漏跑直接相关的测试文件

- 反复出现的情况：第 0 层（改产品代码前后跑的定向测试）的文件清单由写方案的人凭印象挑，漏掉了直接引用被改文件的测试，要等第 2 层（整个受影响的 Vitest 项目）才暴露，每次多花一整轮测试。
- 发生记录：
  - 2026-10-19 D-52（提交 `882cc959`）：改了 `apps/execution-worker/src/production-sandbox-execution-v2.ts`，漏了直接引用它的 `test/integration/sandbox-v2-container-route.test.ts`，记在 .agents/tasks/round2-tool-execution/plan.md。
  - 2026-10-22 D-54（提交 `9969a646`）：同样改了那个文件，第 0 层只跑 3 个文件；第 2 层发现 `sandbox-v2-container-route.test.ts` 整体替换 `@himawari-agent/runtime-sandbox` 的替身缺新导出的错误类，5 个用例超时（`plan.md`）。
  - 2026-10-22 D-55（提交 `51f8b927`）：改了 `packages/runtime-sandbox/src/job-host-main.ts`，第 0 层只跑了集成文件，漏了 `packages/runtime-sandbox/test/job-host-main.unit.test.ts`；第 2 层 `d55-l12-01` 发现一个旧用例在新行为下失败（`.ci-output/handoff/2026-10-22-d55-decision.md`）。
- 为什么要紧：第 2 层要构建并跑整个项目，在 Hermes 上一轮二三十分钟；漏掉的文件本来几秒就能在第 0 层发现。三次里有一次还白跑了一整轮第 1、2 层。
- 2026-10-26 补充（快速模式下又出现两次）：快速模式（[ADR 0073](https://github.com/sixianli/himawari-agent/blob/baf02ebc4f376a27aa2a8d2871cc4a897a42c7e2/docs/adr/0073-fast-delivery-mode.md)）让上面的钩子直接放行，只要求跑相关测试。加迁移 0056 的提交 `d849375` 和加迁移 0057 的提交 `bfa6162`（PR #34）都没跑写死迁移编号的 `test/integration/sqlite-run-payload-artifacts.test.ts` 和 `test/integration/sqlite-sandbox-execution-v2.test.ts`，main 上 16 个用例一直失败，直到 PR #41 的线程扩大测试时才发现。处理：这两个文件和另外两个写死迁移编号列表的测试改成从迁移清单推算期望值，加迁移不再需要改它们；Backlog [BL-20261026-008](backlog/BL-20261026-008-fast-mode-migration-tests.md) 建议把“改迁移必跑的测试文件”写进快速模式规则，规则只由 Andy 决定是否改。
- 第三次的根因：前两次之后的预防只有 `plan.md` 里的记录和交接文件里的计数，选第 0 层清单那一刻没有任何东西检查；而“哪些测试直接引用了被改文件”可以从代码机械算出。三次的提交说明正文其实都写到了漏掉的文件（第 2 层发现后补写的），所以只在说明全文里找文件名的检查三次都会放行。
- 硬约束（2026-10-22，[ADR 0066](https://github.com/sixianli/himawari-agent/blob/baf02ebc4f376a27aa2a8d2871cc4a897a42c7e2/docs/adr/0066-layer0-related-tests-declared.md)）：
  - 检查脚本 `check-layer0-tests.py`，装在仓库共享 git 目录（`git rev-parse --git-common-dir`）的 `hooks/` 下，是本机文件，不进仓库；SHA-256 为 `0b66a9ec3683226a6e5776307163815338c7cbdb2bcfbc2c7786ac0de35680e1`，来源副本在 `.ci-output/handoff/l0-guard/`。`derive` 按 ADR 0066 的规则推导直接相关的测试：相对路径引用被改文件、同包同名、被改文件的导出有增删时整体替换它所在包的测试；测试文件按 `ci/policy.json` 的测试项目判定。
  - 同目录的 `commit-msg`（SHA-256 `9613e6e6eb6098f2ba1c9222194c9c0f526d4da09ac8d06da3aab02babb8aa01`）和 `pre-push`（SHA-256 `e6f64f47d03d225185c90f1d5ca0cee3b2c44e41cdb574848d65878993264334`；2026-10-25 起仓库根目录 `DELIVERY_MODE` 为 `fast` 时两个钩子打印 DELIVERY_MODE_FAST_SKIP_LAYER0 直接放行，见 [ADR 0073](https://github.com/sixianli/himawari-agent/blob/baf02ebc4f376a27aa2a8d2871cc4a897a42c7e2/docs/adr/0073-fast-delivery-mode.md)）钩子运行它：改了 `apps/*/src/`、`packages/*/src/` 的提交，说明里必须逐行写 `Layer-0-tests: <路径>` 包含每个推导出的文件（推导为空时写 `Layer-0-tests: none`），否则拒绝提交；推送前对每个待推送提交按“父提交到该提交”再查一遍，覆盖 `--amend` 和跳过 `commit-msg` 的提交。合并提交打印 `L0_RELATED_TESTS_SKIPPED_MERGE` 后放行。所有工作树、所有代理的提交和推送都经过这两个钩子；opencode 和 Grok 的禁止规则已拒绝 `--no-verify`、改 `hooksPath` 和直接操作 `.git/hooks`。
  - 验证：自测 `.ci-output/handoff/l0-guard/selftest.sh <仓库>`（SHA-256 `d131d0db36da7539a5f7f5c968150f821bf4d704053128a27367cba2deb2151c`）78 项全部通过（2026-10-22，`selftest-04.log`），结果在 `.ci-output/handoff/l0-guard/` 下。其中：用三次当时第 0 层实际跑过的文件写成声明行，检查都拒绝并点名漏掉的文件，补上后放行；三次的真实提交说明（文件名只在正文里）都被拒；临时仓库里用真实的 `git commit` 和 `git push` 验证只改文档或测试不需要声明，缺声明、漏文件、写了不是测试的路径被拒，同一提交里改 `ci/policy.json` 排除必需测试仍被拒，`--no-verify` 跳过的提交和 `--amend` 去掉声明的提交被 `pre-push` 拦下，合并提交打印跳过。审核：opencode（DeepSeek V4.1 Flash）四轮逐行审核，记录在 `.ci-output/handoff/2026-10-22-l0-omission-oc-stop-2.md` 到 `-stop-4.md`。
- 2026-10-29 更新（[ADR 0108](https://github.com/sixianli/himawari-agent/blob/7d0ffcd52cbb69d4941871cf9bf08d93f3843da8/docs/adr/0108-layer0-check-in-repository-and-fast-mode.md)，Andy 同意）：快速模式下钩子直接放行、云端会话根本没有检查脚本，是这几次又漏掉的原因。检查脚本原样（SHA-256 `0b66a9ec…`）放进仓库 `scripts/layer0-tests/check-layer0-tests.py`，钩子放在 `scripts/git-hooks/`，`npm run check` 把 `core.hooksPath` 指过去；快速模式下也检查。复现：对快速模式下漏跑的提交 `bfa6162` 运行 `check-commit`，以 `L0_RELATED_TESTS_UNDECLARED` 拒绝并点名当时漏掉的 `test/integration/sqlite-sandbox-execution-v2.test.ts`，用时约 1.2 秒；`test/tooling/layer0-hooks.test.mjs` 用旧的“快速模式放行”钩子会失败，换新钩子通过。
  - 限制：只证明声明里包含推导出的文件，不证明它们真的跑过并通过；经包名引用又不整体替换的测试、经上层调用者到达的场景测试、按构建产物路径引用的产品路径测试找不到，仍靠写方案的人判断和第 2 层；改 `test/fixtures/` 下的辅助文件不要求引用者；钩子只在本机生效，新克隆要按[代理工具 Runbook](https://github.com/sixianli/himawari-agent/blob/208007462f99e16c5c8cd4daac2acc10fa9f5f36/docs/runbooks/agent-tooling-runbook.md#procedure) 安装。
- 2026-11-08 又一次（PR #282，I-84）：改了 `apps/agent-service/src/production-sandbox-tool-result.ts` 里给模型看的上限说明，第 0 层只跑了直接引用它的那几个文件，没跑 `apps/agent-service/test/prompt-catalog.unit.test.ts`。那条门槛扫 `apps/*/src`、`packages/*/src` 下所有字符串字面量，发现提示词标记词（`你是`、`只返回`、`只输出`、`不要编造` 等）出现在提示词目录之外就失败；新写的那句「请改成只输出需要的部分」带了 `只输出`，以 `PROMPT_OUTSIDE_CATALOG apps/agent-service/src/production-sandbox-tool-result.ts:162 只输出` 失败。它按路径扫源码、不 import 被改的文件，所以 `check-layer0-tests.py derive` 推不出它，三轮模型复核读的是改动差异也没有发现，直到合并前跑整个 `apps/agent-service/test` 才暴露。处理：那句改成「请缩小输出范围后重试」，门槛恢复通过。教训：凡是改了会发给模型或显示给用户的固定文字，第 0 层清单里必须手工加上按路径扫源码的门槛（`apps/agent-service/test/prompt-catalog.unit.test.ts`、`npm run check:glossary`），`derive` 永远找不到这一类，因为它们按路径扫源码、不 import 被改的文件。（原来这里还列了 test/tooling/safe-tool-reason-codes.test.mjs，它比对界面原因码白名单的两份拷贝；PR #312 把白名单合成一处导出之后这个文件已删除。）

[回到目录](#编码代理反复犯的错误)

<a id="copied-packet-stale-names"></a>

## 复制上一次操作包时留下旧文件和旧文件名

- 反复出现的情况：第十次上线的操作包（把新版本装到生产机所需的脚本、配置和检查的整套文件）是复制第九次的再改出来的，复制时有几处没跟着改，上线时才发现。
- 发生记录：
  - 2026-10-26 第一次尝试：`acceptance/cloud/probe-source` 里有 3 个探针源文件（上线前在生产机上试运行沙箱工具的测试程序）还是第九次的版本，S6 验收失败后自动回退。
  - 2026-10-26 冻结前复查：`systemd/S7-startup-readback.mjs` 里的 `memoryPath` 还是第九次的值，上线前发现并改成 `memory-engine-production`。
  - 2026-10-26 第四次尝试：`systemd/S7-switch-start-readback.py` 读取数据库升级后的记录时仍用第九次的文件名 s7-catalog-after51.json；第十次把数据库升到第 55 版，写出的文件叫 s7-catalog-after55.json。S7 切换启动时报 `TENTH_SWITCH_MAINTENANCE_EVIDENCE_CHANGED:s7-catalog-after51.json`，自动回退，服务停了约 17 分钟。
- 第三次的根因：前两次之后只是逐个改掉发现的文件，没有检查“后面的步骤要读的文件，前面的步骤到底会不会写出来”。`check-packet-consistency.py`（`deploy.sh` 上线前必跑的操作包自检）只核对文件哈希和引用，不核对步骤之间交接的文件名。
- 硬约束（2026-10-26）：
  - `check-packet-consistency.py` 新增 `EVIDENCE_NAME_WITHOUT_PRODUCER`：对 `systemd/S7-switch-start-readback.py` 和 `systemd/S7-startup-readback.mjs`，找出它们读取的每个 `s<数字>…json` 文件名，要求这个名字由脚本自己写出（`retain_json`），或出现在操作包里另一个脚本（`.py`、`.mjs`、`.sh`、`.sql`，不含 `fixtures`），或是 `run-maintenance.mjs` 按步骤名拼出的 `<步骤名小写>-result.json`。找不到就报错，`deploy.sh` 拒绝上线（退出码 3），`rollback.sh` 也拒绝运行。
  - 验证：放回第四次的旧文件时，检查报 `EVIDENCE_NAME_WITHOUT_PRODUCER systemd/S7-switch-start-readback.py s7-catalog-after51.json` 并以 1 退出；改成 `after55` 后这一项消失。
  - 位置：检查脚本在操作包 `.ci-output/production/2026-10-26-tenth-change-packet-01/inputs/` 里（`.ci-output/` 不进仓库）。以后复制这个操作包做第十一次时，检查会一起带过去。
  - 限制：只覆盖这两个读取脚本；从第九次复制来、名字仍然合法但内容已过时的文件（例如第一次尝试的探针源文件）这项检查发现不了，那一类靠 `check-packet-consistency.py` 已有的哈希核对和 Hermes 上的 16 项操作包检查。
- 再次发生（2026-10-26，第十二次上线第一次尝试）：
  - `systemd/S7-switch-start-readback.py` 核对原配置时还按第十一次的前提，要求原配置里读网页上限（`runPolicy.publicFetch.maximumBytes`）仍是 32768，再由它改成 102400；第十一次早已改成 102400。停服之后 S7 报 `TWELFTH_SWITCH_ORIGINAL_PUBLIC_FETCH_CHANGED`，新版本没有启动。同一份“新配置应该长什么样”的预期写了两遍：`maintenance/maintenance-common.mjs` 里的那份改了并且有测试，S7 的 Python 那份没改、也没有任何测试运行它。
  - 自动回退随后失败：`scripts/delivery-mode/rollback.py` 按数据库版本拼步骤名和恢复点报告名（S9_RAW_RESTORE56、s3_copy56-result.json），而操作包里这些步骤一直叫 `S3_COPY51`、`S9_RAW_RESTORE51`、`S9_RAW_CONTROL51`。回退脚本的测试只拿第六次（数据库第 51 版）的操作包跑过，名字恰好对上。服务停了约 15 分钟，改正回退脚本后手动回退恢复。
- 硬约束（2026-10-26，第二次）：
  - `scripts/delivery-mode/test_rollback.py` 的 `PlanTest` 要求回退计划要跑的步骤都在操作包 `steps/run-step.py` 的步骤表里，恢复点报告名等于 `deploy.sh` 实际运行的那个 S3 步骤名加 `-result.json`。拿第十二次的操作包跑，旧的 `rollback.py` 让这项测试失败（S9_RAW_RESTORE56 不在步骤表里），改成固定的包内步骤名后通过（Hermes `himawari-tests/twelfth/rbt-new.log`）。
  - 操作包新增 `systemd/verify-switch-config-fixtures.py`，twelfth-freeze-tools/run-packet-checks.sh 每次出包都跑：它从 S7 脚本里取出核对原配置的函数，用和 `maintenance/verify-fixtures.mjs` 同样形状的配置运行，要求算出的新配置与 `maintenance-common.mjs` 算出的逐字节相同，并要求 7 种旧值或缺项都被拒绝。对第一次尝试的 S7 脚本它报 `TWELFTH_SWITCH_ORIGINAL_PUBLIC_FETCH_CHANGED` 并以 1 退出，对改好的通过 9 项（Hermes `himawari-tests/twelfth/repro-old-s7.log`、`repro-new-s7.log`）。改好的函数还在生产机上只读核对过：对生产机的原配置，它算出的结果和维护脚本写出的 `s7-config-apply.json` 一致。
  - 限制：这项出包检查和 run-packet-checks.sh 都在 `.ci-output/`（不进仓库），靠复制操作包带到下一次；`deploy.sh` 不会因为没跑出包检查而拒绝上线。
- 为什么前两道硬约束还不够（2026-10-26）：两道都是“复制之后再查”，只能查出已经想到的那类旧值；它们本身也在 `.ci-output/`，靠复制带到下一次。把操作包搬进仓库时又发现一处没被任何检查发现的旧副本：包里带的 `scripts/operations/workspace-lifecycle-audit.mjs` 只认到数据库第 56 版，`main` 上的同名文件已改成认 57 版（提交 `bfa6162`），第十三次升库到 57 版时会在停服后失败。
- 硬约束（2026-10-26，第三次，[ADR 0086](adr/0086-generate-release-packets-from-parameters.md)）：
  - 操作包不再复制：仓库里的 `scripts/delivery-mode/make-packet.py` 用模板 `scripts/delivery-mode/packet-template/` 按参数生成。“第几次”、旧版本目录、原配置的模型上限和读网页上限从生产机只读读出，数据库版本和要补的迁移从生产 S0 读回和这个提交的代码推出，包里带的仓库文件副本按这个提交刷新。没填的占位、改写了要保留的表的迁移，都在出包时拒绝。
  - 出包时在 Hermes 上跑 `scripts/delivery-mode/run-packet-checks.py`（16 项，升库时 17 项），任何一项不过就不出包；结果写进操作包的 `packet-checks.json`。`deploy.sh` 先运行 `generated-packet-gate.py`，操作包里没有生成器写的 `packet-parameters.json`、或 `packet-checks.json` 没记全部通过，就以退出码 6 停下（结果 `not-generated`），生产机上什么都不动。
  - 验证：`scripts/delivery-mode/test_make_packet.py` 用第十二次的参数生成，除 21 个有意改动的文件外与第十二次冻结的操作包逐字节相同；把读网页上限换回手抄的旧值 32768 生成时，S7 的核对函数对真实形状的配置报 `TWELFTH_SWITCH_ORIGINAL_PUBLIC_FETCH_CHANGED`，按生产读出的值生成时通过。`test_deploy.py` 的三项 `[PG-1]` 用例：没有生成器记录、检查没全过或提交不符、升库却没跑升库检查，`deploy.sh` 都以 6 退出且一个上线步骤都没跑。
  - 限制：手写这两个 JSON 文件也能通过上线前检查，这道检查拦的是“忘了用生成器”，不是有意绕过；生成器还没在 Mac 上连真实生产机和 Hermes 跑过一次完整出包。

[回到目录](#编码代理反复犯的错误)

<a id="release-without-browser-walkthrough"></a>

## 上线验收只查了首页 200 没真点网页

- 反复出现的情况：新版本上线后的验收（确认新版本能用的检查）只读回了服务端的状态，例如首页返回 200、服务在运行、配置和数据库版本对，没有人在真实浏览器里像 Andy 一样发一轮对话、打开设置页。新版本里用不了的地方，都是 Andy 自己用的时候才发现。
- 发生记录（详细经过见 [工程案例集](engineering-casebook.md)）：
  - 2026-10-25，案例 9“上下文窗口配错，长回答被截断”：上线验收没有发过长回答，Andy 让 Agent 写贪吃蛇时回答只剩一个字。
  - 2026-10-25，案例 12“生产一直在跑 10 月 7 日的旧前端”：验收只测了服务端接口，没核对浏览器拿到的前端是不是新版，设置里的联网搜索开关点不动。
  - 2026-10-26，案例“搜索已经结束，却被判‘失联’，整个服务卡 5 分钟”：上线后 Andy 搜新闻时卡住 5 分钟。
  - 2026-10-26，第十一次上线（代码 `aa563155`）：验收读回首页 200 后结束。约 16 分钟后 Andy 报告：已经打开的页面在服务重启后，审批卡一直停在“正在加载权威状态”，页面显示“部分执行记录暂不可读取”，设置里“允许联网搜索”勾不上，之前给过的搜索许可也失效了。
- 为什么要紧：每一次都是生产上的新版本对 Andy 完全或部分不能用，Andy 要自己当测试员，然后再等一次修复和上线。
- 第三次的根因：前几次之后只修了各自的那个问题（更新前端目录、改上下文窗口），并在上线脚本里多读回几项服务端的值；从来没有一步要求“在浏览器里打开这个版本，按用户的用法走一遍”。`deploy.sh`（上线脚本）对这件事没有任何条件，代理只读回服务端状态就能上线。
- 硬约束（2026-10-26）：
  - `scripts/delivery-mode/deploy.sh` 在上线前检查之前先运行 `scripts/delivery-mode/browser-acceptance-gate.py`。操作包里必须有 browser-acceptance/walkthrough.json，其中的 `artifactSha256` 必须等于操作包 inputs/bindings.json 里候选安装包的 `candidate.archiveSha256`，并且 7 项检查都记为通过：首页打开并登录（`accept-homepage`）、设置里“允许联网搜索”能勾上（`accept-search-toggle`）、搜新闻有带网址的结果且过程里有“搜索网页”这一步（`accept-news-search`）、长回答从第 1 段到最后一段都显示（`accept-long-answer`）、模型跑一条统计行数的命令并在回答里看到命令真实算出的结果（`accept-run-command`，2026-10-29 因 I-10 加入）、记忆页能打开且没有报错（`accept-memory-page`）、服务重启后已经打开的页面仍能用开关和搜索（`accept-after-restart`）。缺文件、安装包对不上、任何一项没通过，`deploy.sh` 以退出码 5 停下，结果为 `no-browser-acceptance`，生产机上什么都不动。
  - 这个文件只能由产品路径测试 `test/integration/product-path-browser.test.ts` 里的“release acceptance in a real browser”写出：它在 Hermes 上把这个安装包装好，用 Chromium 打开真实页面，联网搜索走真实的 Exa 服务，测试结束时写出 `browser-acceptance.json`，再原样复制到操作包里。
  - 验证：`scripts/delivery-mode/test_deploy.py` 新增三项，缺文件、换了安装包、一项失败或缺一项时 `deploy.sh` 都以 5 退出且一个上线步骤都没跑（Hermes `news-latency/evidence/ck13/` 与 `ck16/`，`test-deploy-rc=0`）。第十一次的操作包没有这份文件，检查报 `BROWSER_ACCEPTANCE_MISSING` 并拒绝（`ck13/`，`gate-eleventh-rc=1`）。同一个网页验收对第十一次的安装包 `aa563155` 重现了 Andy 遇到的问题：前五项通过，“服务重启后已经打开的页面”这一项在设置里等了 60 秒开关仍勾不上，测试失败（`pp15-old-accept/`）；对修好的 `470b6d30` 六项全部通过（`pp15-new-accept/`，2026-10-26T10:41:56Z），第十二次操作包带着这份结果通过了检查。
  - 限制：网页验收用的是按脚本回答的模拟模型，证明不了生产上真实模型的配置和生产机的网络；生产上的读回和 Andy 的试用仍然要做。验收每次从新装的数据开始，测不出“上线前已经给过的搜索许可在新版本里失效”这类和旧数据有关的问题，这一类靠 `test/integration/public-search-authorization.test.ts` 覆盖。检查只看文件内容，手写一份同样内容的文件也能通过，所以只能复制测试写出的那份。

[回到目录](#编码代理反复犯的错误)

<a id="adr-number-collision"></a>

## 新建 ADR 时只看了 main，和别的线程撞了编号

- 反复出现的情况：几个线程同时各开一个 PR，各自按 main 上 `docs/adr/` 的最大编号加一新建 ADR（Architecture Decision Record，记录一项重要设计决定为什么这样定的文档），结果两份 ADR 用了同一个编号。文档里写“ADR 0148”时，读的人和模型分不清指的是哪一份。
- 发生记录：
  - 2026-11-01：`0148-bring-related-memories-into-gmail-checks.md`（提交 `1d90719`，12:44 UTC）和 `0148-send-every-model-request-through-one-in-process-egress.md`（提交 `64b9955`，12:50 UTC）都用 0148，先后提交，后来都进了 main。
  - 2026-11-04：还没合并的 PR #229 新建 `0156-self-hosted-runner-on-hermes.md`，PR #234 新建 `0156-srt-0-0-81-with-a-locked-seccomp-helper.md`，又撞在 0156。
- 为什么要紧：ADR 编号是全项目引用决定的唯一名字；撞号之后，引用会指错文档，按错的决定去改代码。
- 硬约束（2026-11-04）：
  - `npm run check:adr-numbers`（`scripts/check-adr-numbers.mjs`，`npm run check` 的一步）检查 `docs/adr/` 下每个 `.md` 文件的名字都是“四位编号-小写短名.md”（其他扩展名的文件不检查），并且没有两份 ADR 共用一个编号；有就报 `ADR_NUMBER_DUPLICATE` 并以 1 退出。2026-11-09 起还检查标题里的 ADR 编号等于文件名编号（`ADR_NUMBER_TITLE`），以及 `docs/`（不含 [docs/archive](https://github.com/sixianli/himawari-agent/tree/3b9da266dc1f00e4778e80597a2d524144f8fe2d/docs/archive)）里指向 ADR 文件的行内链接，文件和锚点都存在（`ADR_LINK_MISSING`、`ADR_LINK_ANCHOR_MISSING`），以及写出的 `docs/adr/…md` 路径（含 `superseded_by` 字段、`[SOURCE: …]` 标记，只认带 `docs/adr/` 前缀的写法，网址里的不算）文件都存在（`ADR_PATH_MISSING`），防改号后漏改。测试在 `test/tooling/adr-numbers.test.mjs`。
  - 验证：在改名之前的 main（`f91950b`）上，检查报 `ADR_NUMBER_DUPLICATE 0148` 并以 1 退出；把 Gmail 那份改成 `0158-bring-related-memories-into-gmail-checks.md` 后通过。两份各有 3 处入链。改 Gmail 那份而不改出口那份，是因为出口那份被 ADR 0146 文件开头的 `superseded_by` 字段引用，改它的编号要动 ADR 的生命周期字段；Gmail 那份只有正文里的普通链接。
  - 新建 ADR 前，除了看 main，还要看还没合并的 PR 新加的 `docs/adr/` 文件，取所有这些编号里最大的加一。
  - 限制：检查只能在两个撞号的 PR 先后进了同一棵树时才失败，例如后合并的那个 PR 先把 main 合并进来再跑 `npm run check`；两个 PR 各自单独跑都会通过。

[回到目录](#编码代理反复犯的错误)

<a id="review-previous-after-low-fix"></a>

## 记过低意见修改后，复核传错了上一轮的提交

- 反复出现的情况：合并前代码复核（`scripts/model-review/opencode-review.mjs --mode code-review`）的某一轮之后，线程用 `--accept-low` 把低意见的修改记进复核账本（账本是 `.agents/reviews/pr-<编号>/usage.jsonl`，每轮复核一行），再提交账本。下一轮复核时，线程把“提交账本的那个提交”当成上一轮复核到的地方传给 `--previous`，而复核链认的是 low-fix 记录里的 `head`（`--assert-reviewed` 打印的 `REVIEW_CURRENT … reviewed=` 那个提交）。账本提交不是那个 `head` 的祖先，这一轮接不上复核链（`chain-broken`），钱花了却不算数。
- 发生记录（都可以在对应分支的账本里看到）：
  - 2026-11-12：PR 436 第 6、7 轮传 `a00a7253`，该传 `f35bb782`。
  - 2026-11-13：PR 466 第 3 轮传账本提交 `19644ba2`，该传 `8f40158b`，第 3、4 轮作废，只能从分叉点整份重跑。
  - 2026-11-13：PR 460 第 3 轮传账本提交 `01debf3f`，该传 `4456a13c`，第 4 轮重跑。
- 为什么要紧：每轮复核都花 Andy 的钱，而且要到合并前检查才发现，后面接着它的轮次也一起作废。
- 硬约束（2026-11-13，[I-98](incidents-and-gates.md#incidents)）：代码复核传了 `--previous` 时，脚本开跑前用本地账本算复核链（`previousProblem`，判断逻辑和合并前检查共用 `walkChain` 和 `lowFixChecker`），接不上就以 `REVIEW_PREVIOUS_REFUSED` 退出、不花钱，并写出该传的提交。测试在 `test/tooling/opencode-review-merge-gate.test.mjs` 的 `[I-98]` 用例。
- 同一轮补跑（`--round <n>`）时，`--previous` 还必须和这一轮已有结果用的相同（这一轮已有结果本身接不上链时提示 `use=new-round`：不带 `--round`、`--previous` 新开一轮）；账本里的 low-fix 记录按合并前检查同样的规则重新核对，不合格就判链已断。

[回到目录](#编码代理反复犯的错误)
