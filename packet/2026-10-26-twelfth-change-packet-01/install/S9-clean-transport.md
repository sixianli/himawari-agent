# S9：清理本次运输副本并保留证据

[检查与执行](#检查与执行) · [删除范围](#删除范围) · [保留与失败处理](#保留与失败处理) · [验证范围](#验证范围)

用户批准第十次冻结包后，执行者在 S6、S6 服务账号读取检查（S6_READ）、S7 和 S8 全部通过后，才可经[步骤入口](../steps/README.md)的 `S9_TRANSPORT_PREFLIGHT`、`S9_TRANSPORT_APPLY` 运行[固定清理脚本](S9-clean-transport.py)。该脚本只接受 `--preflight` 或 `--apply`，只操作 `/var/tmp/himawari-twelfth-20261026`。脚本不停止、启动或修改服务，也不触发恢复路线。

## 检查与执行

在生产主机的 root shell 中执行。永久脚本由 S1 从冻结包发布；脚本检查冻结批准引用、自身 SHA、生产主机名及 root 身份。

```bash
cd /
/usr/bin/python3 -I /opt/himawari/operations/twelfth-20261026/install/S9-clean-transport.py --preflight
```

此命令不删除文件。脚本将目录身份、每个文件的大小和分配空间、应保留文件的 SHA、阶段结果 SHA、永久启动依赖、挂载和进程检查保存在 `/var/lib/himawari/twelfth-20261026-evidence/s9-transport-plan-<本次编号>.json`。当前计划还写入 `s9-transport-preflight.json`，以便执行时独立比较。脚本终端输出只含结果和报告路径、SHA、大小。

执行者先检查计划中的 `target`、`rootIdentity`、`inventory`、`retainedBytes`、`phases`、`permanentDependencies`、`references` 和 `processSurveys`。只有固定目标、创建时同一 device/inode、所有阶段通过、永久启动和维护没有运输目录依赖、没有未知进程或消费者，且永久报告需要的证据全部安排留存时，才执行：

```bash
cd /
/usr/bin/python3 -I /opt/himawari/operations/twelfth-20261026/install/S9-clean-transport.py --apply
```

脚本重新检查全部条件。当前计划必须在 30 分钟内，且目录内容、创建凭据、冻结输入、脚本 SHA、阶段结果和永久启动依赖与刚才检查的计划完全一致。发生变化就停止，必须重新运行 `--preflight` 并检查新计划。`--apply` 自行生成的新计划不能替代已检查的当前计划。

## 删除范围

脚本核对 S1 创建凭据中的 `/var/tmp/himawari-twelfth-20261026` 身份。目标的直接成员只允许 `packet`、`input`、`validation` 和 `acceptance`。文件只能属于 root 或本次 `himawari-prod` 账号，不能有跨设备目录、未知文件类型、硬链接、指向目标外的符号链接、挂载点或进程消费者。进程检查覆盖主机可见的全部账号，不输出完整命令行或环境。

以下内容可从冻结提交、输入和记录的 SHA 重建，清理前不另存一份：

- `validation/source`、`validation/python` 和 `validation/ui-verified`。脚本同时核对源码提交等于冻结 `p5-materials.json` 的 `sourceHead`，源码没有已跟踪或未跟踪变更。
- `input` 与 `packet/materials` 中的固定源码 bundle、候选 tarball、Python tarball 和依赖 tarball。脚本先逐一核对冻结 `p5-materials.json` 的大小和 SHA。
- `acceptance/runtime-tools` 和 `acceptance/question-12-downloads` 中可重新取得的程序、库和下载内容。这里的 JSON、日志、文本、差异和报告文件仍保留。

脚本不接受任意路径参数。永久 `/opt/himawari/releases/` 下的全部安装（含第一次登记能力目录用的 `2026-10-07-first`、第三次的 `2026-10-12-third`、第四次的 `2026-10-15-fourth`、旧版本 `2026-10-26-eleventh` 和新版本 `2026-10-26-twelfth`）、新旧 operations、qualification、evidence、两个授权目录（第三次的 `/var/lib/himawari/qualification-workspace` 和当前的 `/var/lib/himawari/workspace`）、生产 state、control 文件和 S3 恢复点均不属于目标。Mac 上的冻结包与用户备用包装也不属于目标。

## 保留与失败处理

删除前，脚本将其余普通文件复制到永久 evidence 下新建的 `transport-retained-<本次编号>`。这包括完整验收报告、服务读取报告、stdout/stderr、日志、冻结包脚本和清单、安装上下文、依赖目录清单及源码输入证明。副本以 root 0600 留存，目录为 root 0700。每个副本都独立核对 SHA；`s9-transport-retained-<本次编号>.json` 记录原路径与永久路径的对应关系。

永久报告中的运输输入路径可以作为历史输入记录保留。被标记为必须保留、trace、stdout/stderr、截图、evidence 或 report 的路径必须对应已归档的文件。引用未知路径、未归档内容或显式要求保留原路径时，脚本拒绝删除。签署回执中的历史 `bindingInputs.acceptanceFiles` 由报告检查处理；正式 prepare、当前 snapshot、unit、保护配置和维护回退直接使用的文件必须全部位于永久路径。

snapshot 中唯一允许保留的运输路径是 `capabilities[].binding.value.protectedPaths` 内精确的 `/var/tmp/himawari-twelfth-20261026/input`。这个字段禁止沙箱读取该路径，不要求路径存在。脚本先独立读取 root 所有的公开安装回执，要求其 SHA 等于 S7 root 启动证明中的 `receiptSha256`，并核对 receipt schema、runtime 和 runtimeDigest；随后逐能力比较 snapshot 完整 binding 与回执已签署的 `bindings`，拒绝缺失、重复或变化。只有同一已签署 binding 中的这一项才从依赖检查中排除。相似路径、其下子路径、其他字段中的相同文本，以及配置、unit、保护文件或 helper 中的运输路径仍拒绝。

归档完成后，脚本再检查进程、挂载、永久依赖和目录身份。删除后，脚本确认目标已消失、每个永久副本 SHA 未变、服务仍是 S7 记录的同一 invocation，且 S6/S7/S8 结果文件未变。成功报告列出唯一删除路径、删除树的分配空间以及根盘前后空闲空间。归档副本占用的空间仍是保留证据，不能计为已释放空间。

任何检查失败都留下独立失败报告、现有归档和剩余运输内容。脚本不自动恢复已经删除的可重建输入，不重试，不触发 DB 或控制文件恢复。失败代码未知时仅输出 `TWELFTH_TRANSPORT_UNEXPECTED_FAILURE`，现场细节由受保护报告和原日志供执行者检查。

## 验证范围

[隔离 fixture](verify-s9-clean-transport-fixtures.py) 在 Hermes 的任务临时目录中使用真实普通文件。它检查应保留文件的归档与独立 SHA 读回、可重建输入排除、身份变化拒绝、运输依赖拒绝、进程检查结果拒绝、未保留证据引用拒绝、检查后内容变化拒绝，以及成功删除后的证据仍存在。

同一 fixture 另以完整虚构 snapshot 和独立回执 binding 输入检查精确禁读路径允许、能力顺序变化允许，以及实际读取路径、错误 schema/字段/路径、未签署项、重复能力和签署身份变化拒绝。原八项文件系统检查保留。fixture 不验证生产回执的真实签名；正式脚本通过 S7 root 启动证明中的签名核验结果和原回执 SHA 接受签署输入，并在清理前后独立读回。

准确命令为锁定的 `/usr/bin/python3 -I <本包>/install/verify-s9-clean-transport-fixtures.py`，并沿用本任务已检查的 `HIMAWARI_TEST_TEMP_ROOT`。该 fixture 不连接生产，不读取生产 state，也不证明生产 `/proc`、systemd 或全部 S1–S8 结果检查；这些条件仍由生产脚本逐项检查并留存。
