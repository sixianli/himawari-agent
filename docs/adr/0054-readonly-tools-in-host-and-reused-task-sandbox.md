---
status: active
document_type: adr
decision_status: accepted
supersedes: ""
superseded_by: ""
amends: "docs/adr/0031-isolated-tool-execution.md, docs/adr/0033-process-sandbox-default-and-optional-containers.md"
amended_by: "docs/adr/0072-linux-pid-namespace-sweep-counts-as-release-confirmed.md, docs/adr/0085-remove-per-turn-system-gaps.md"
date: "2026-10-13"
covers: "apps/agent-service/src/production-coding-workflow.ts, apps/agent-service/src/production-record-failure.ts, apps/agent-service/src/production-run-composition.ts, apps/agent-service/src/production-task-environments.ts, apps/execution-worker/src/production-sandbox-execution-v2.ts, apps/execution-worker/src/production-srt-task-environment-backend.ts, packages/application/src/ports/sandbox-execution-journal.ts, packages/application/src/services/thread-execution-resources.ts, packages/persistence-sqlite/src/sqlite-worker.ts, packages/platform-node/src/files/pi-host-publication.ts, packages/platform-node/src/files/sandboxed-coding-operations.ts, packages/runtime-pi/src/governed-host-operations.ts, packages/runtime-pi/src/host-read-only-executor.ts, packages/runtime-pi/src/model-output-budget.ts, packages/runtime-pi/src/sandboxed-coding-executor.ts"
verified_at: "1f73e976913bbac15088d045988be291fd60d8dd"
---

# ADR 0054：只读文件工具在主进程执行，命令和写入复用任务沙箱

<a id="contents"></a>

## 阅读导航

- [背景](#context)
- [决定](#decision)
- [与 ADR 0031、0033 的关系](#amendments)
- [比较过的方案](#options)
- [后果](#consequences)
- [后续实现记录（2026-10-14）](#implementation-record)
- [2026-10-15 补充：超过配置上限改为截断并说明](#model-output-limit)
- [2026-10-16 补充：命令失败时把输出结尾交给模型](#failed-command-output)
- [2026-10-18 补充：同一轮复用沙箱的第一步（常驻任务宿主）](#resident-job-host)
- [2026-10-18 补充：同一轮复用沙箱的第二步（沙箱内常驻 runner）](#resident-runner)
- [2026-10-18 补充：第 4 层发现的缺口](#resident-fixes)
- [2026-10-19 补充：复用路径 bind 前失败不再静默](#resident-bind-prefailure)
- [2026-10-21 补充：重启后任务环境停止未确认时下一轮再试](#resident-stop-retry)
- [2026-10-22 补充：常驻路径准备失败带上宿主诊断](#resident-preparation-diagnostic)
- [2026-10-22 补充：常驻命令到期限时稳定记成期限超时](#resident-deadline-settlement)
- [2026-10-22 补充：服务关闭打断的资源核查在下次启动后再做一次](#interrupted-recovery-retry)
- [2026-10-25 补充：Run 开始时预热常驻会话，审批前后复用同一环境](#resident-prewarm)
- [2026-10-26 补充：两个常驻会话同时启动，等待就绪时不占环境锁](#parallel-session-start)
- [关联文档](#references)

<a id="context"></a>

## 背景

2026-10-13 第三次生产部署后的真实聊天里，读一个不存在的文件也要 7–14 秒（运行记录 `run:9a2d2c24-e4fa-4069-baae-f73058f3845d`）。原因是现在每一次工具调用都新建一个沙箱（用操作系统机制限制程序能访问的文件和网络的隔离环境），并在里面重新加载整个编码工具程序；之前的生产诊断量到，仅加载这一步就占约 4.6 秒 CPU（`.ci-output/production/2026-10-13-third-s6-diagnostic-22/`、`-24/`）。

[ADR 0031](0031-isolated-tool-execution.md) 要求只读工具也进入隔离环境（“工具标注为 read-only 也不能证明其实现无额外 I/O”），并且已经决定同一任务的多次工具调用共享任务环境、不为每次调用新建环境，但现有实现仍是每次调用新建。

主流做法：Claude Code 的沙箱只包住 shell 命令，读文件、搜索这类文件工具直接在主程序里执行（[Claude Code 沙箱文档](https://code.claude.com/docs/en/sandboxing)）；Codex 用操作系统自带的沙箱机制限制每条命令（[Codex 审批与安全文档](https://learn.chatgpt.com/docs/agent-approvals-security)）。

用户的决定（长任务目标 G89，原话“同意”），回复的是 Claude 的建议：只读操作由可信主进程直接执行并严格检查路径；执行命令、写文件继续放在沙箱里，并改为同一轮对话复用一个已启动的沙箱。

<a id="decision"></a>

## 决定

1. **只读文件工具在可信主进程执行。** `read`（读文件）、`ls`（列目录）、`find`（按名字找文件）、`grep`（按内容搜索）不再进入沙箱，由 Himawari 的可信进程直接执行。条件：
   - 复用 Pi 工具实现（`@earendil-works/pi-coding-agent` 的 `read`、`ls`、`find`、`grep` 及其可替换的 `ReadOperations`、`LsOperations`、`FindOperations`、`GrepOperations` 接口），Himawari 只提供带路径检查的文件操作，不另写一套工具协议。
   - 每次访问都按授权目录检查路径：解析后的真实路径必须在授权目录之内，不能通过 `..`、符号链接（指向别处的快捷文件）或硬链接跑出授权目录；检查和打开之间不能留下可被替换的空隙。
   - 只读工具只能读，不得写文件、不得改文件属性、不得启动未经核对的外部程序。Pi 的 `grep` 和 `find` 默认会启动外部程序 `rg`（ripgrep）和 `fd`，并可能自动下载；在主进程执行时必须改为不启动外部程序的实现，或只启动随安装包固定版本、已核对摘要的程序，并且不跟随符号链接、不自动下载。做不到这些条件的工具继续在沙箱里执行。
   - 文件大小、输出长度、敏感文件等现有限制不变，见 [ADR 0032](0032-original-directory-disk-and-sensitive-file-limits.md)。
2. **命令和写入仍在沙箱里，同一轮复用一个沙箱。** `bash`、`write`、`edit` 等可能修改文件、启动进程或联网的工具继续在任务级隔离环境执行；同一轮对话（一个 Run）的多次调用复用同一个已启动的沙箱，不再每次新建。复用只在同一所有者、同一任务、同一冻结授权范围和期限内成立，不合并不同授权扩大权限；一轮结束或授权变化时停止并释放沙箱，释放证明规则不变。

<a id="amendments"></a>

## 与 ADR 0031、0033 的关系

| 原决定 | 修正内容 | 本文决定 |
| --- | --- | --- |
| [ADR 0031](0031-isolated-tool-execution.md)：只读工具也必须在独立隔离执行环境执行 | 只读文件工具改在可信主进程执行 | 满足[决定](#decision)第 1 点条件的 `read`、`ls`、`find`、`grep` 不进沙箱；不满足条件的继续进沙箱 |
| [ADR 0031](0031-isolated-tool-execution.md)：同一任务多次调用共享任务环境 | 不修正，补充落实方式 | 以一轮对话为复用范围实现共享 |
| [ADR 0033](0033-process-sandbox-default-and-optional-containers.md)：默认用进程级沙箱执行工具 | 默认沙箱只覆盖会修改、执行或联网的工具 | 只读文件工具不再经过进程级沙箱 |

<a id="options"></a>

## 比较过的方案

| 方案 | 好处 | 代价 | 结论 |
| --- | --- | --- | --- |
| 维持现状：每次调用新建沙箱 | 隔离最强 | 每次 7–14 秒，读几个文件就要一分钟 | 不采用 |
| 所有工具都在沙箱里，但同一轮复用沙箱、缓存模块加载 | 保留 ADR 0031 的只读隔离 | 第一次调用仍要几秒；复用和缓存的正确性要单独证明 | 只用于命令和写入 |
| 只读工具在主进程执行并严格检查路径，命令和写入复用沙箱 | 与 Claude Code 一致，只读操作预计降到毫秒级；隔离留给真正有副作用的工具 | 路径检查必须做对，主进程要承担读取不可信文件内容的风险 | 采用 |

<a id="consequences"></a>

## 后果

- 好处：读文件、列目录、搜索不再等沙箱启动；预计从秒级降到毫秒级，实际速度在实现后实测记录。
- 代价：路径检查成为只读工具的安全边界，必须覆盖 `..`、符号链接、硬链接、检查与打开之间被替换等情况，并有自动测试证明。
- 后续工作：
  - 实现只读工具主进程执行与路径检查，见长任务条目 R2-P1。
  - 实现同一轮复用沙箱，见长任务条目 R2-P2。
  - 更新沙箱执行相关的架构、规格和 Runbook，写清哪些工具不进沙箱。

<a id="implementation-record"></a>

## 后续实现记录（2026-10-14）

本记录不改动上面的决定，只写下[决定](#decision)第 1 点落地时的具体做法与已知差异。

- **平台**：Linux 上四个工具（`read`、`ls`、`find`、`grep`）在 Agent Service 主进程执行。打开不经 Node 的路径字符串 `open`：每一级目录先以 `open(授权根, O_RDONLY | O_DIRECTORY | O_NOFOLLOW)` 打开并核对设备号与 inode，之后逐级 `open("/proc/self/fd/<父目录描述符>/<名称>", O_RDONLY | O_DIRECTORY | O_NOFOLLOW)` 并 `fstat` 复核设备号；最后一级先 `lstat` 再以 `O_RDONLY | O_NOFOLLOW | O_NONBLOCK` 打开、`fstat` 复核 inode 与 `nlink`，读前读后各核对一次。进程第一次使用前用 `statfs("/proc/self/fd").type === 0x9fa0` 确认是 procfs，否则返回 `HOST_READ_PROC_UNAVAILABLE`，不改走别的路径。
- **平台差异**：Mac 没有 procfs，`read`、`ls`、`find`、`grep` 在 Mac 上继续进现有沙箱；Mac 行为仍记为未验证。写入和命令在所有平台都仍走沙箱。
- **敏感名单**：`read` 按同一份名单拒绝（大小写不敏感）：`.env`、`.npmrc`、`.pypirc`、`.netrc`、`.ssh`、`.aws`、`.himawari-trash`、`.himawari-recovery`、前缀 `.env.` / `id_rsa` / `id_ed25519`、后缀 `.pem` / `.key`、路径 `.docker/config.json`。名单和判断只保留一份，放在 `@himawari-agent/execution-contracts`，同时供沙箱挂载遮挡与主进程只读打开使用；`ls`、`find` 照常列出名称但不读内容，`grep` 跳过这些文件与目录。
- **`grep`、`find` 实现**：不启动 `rg`、`fd`。`find` 复用 Pi 的定义并注入自定义 `glob`；`grep` 因 Pi 的 `execute` 无条件启动 `rg` 而由 Himawari 进程内实现，输出行格式、`truncateHead`/`truncateLine` 截断、`ignoreCase`、`literal`、`glob`、`context`、`limit` 均与 Pi 相同。`rg` 专有的行内标志（如 `(?i)`）与 POSIX 字符类（如 `[[:alpha:]]`）明确拒绝，错误码 `GREP_PATTERN_UNSUPPORTED`。
- **gitignore 差异**（已知、不作为缺陷）：进程内遍历读取每层的 `.gitignore`、`.ignore`、`.fdignore` 并按所在目录加前缀，始终跳过 `node_modules`、`.git`，包含隐藏文件；但不读 `.git/info/exclude` 和全局排除文件，也不在嵌套仓库边界停止。
- **`grep` 跳过无法读取文件的差异**（已知）：进程内 `grep` 对超过读取上限或不是 UTF-8 的文件无法搜索，此时在结果末尾用同一 notice 格式说明 `N 个文件因过大或无法读取未搜索`（没有匹配时也写）；`rg` 会搜索这些文件。二进制文件（含 NUL）按 `rg` 默认跳过，不计入该数量。
- **事件循环让步**：`find` 的遍历和 `grep` 的逐文件搜索在每处理一个条目或文件后 `await` 一次 `setImmediate` 并检查 `signal`。云端对本仓库源码检出（约 800 个 `.ts` 文件、跳过 `node_modules`）实测：让步前一次 `grep` 连续占用主进程约 12.7 秒（`perf_hooks.monitorEventLoopDelay` 期间没有采样，说明事件循环没有让出）；让步后最大事件循环延迟 47 毫秒、p99 28.4 毫秒、p50 10.4 毫秒，`grep` 2.2 秒、`find` 0.9 秒。
- **限制不变**：进内存读取上限 16 MiB，模型可见正文沿用 Pi 的 2000 行 / 50 KiB 截断，序列化结果仍受调用自身的 `maxOutputBytes` 与机器秘密扫描约束。
- **结果派发标记（2026-10-15 更正）**：主进程执行完 `read`、`ls`、`find`、`grep` 后保存的结果一律标为 `accepted`（已执行），成功和失败（例如文件不存在）都一样；只有在执行之前就被拒绝的才标 `not_sent`，包括路径越界 `CODING_PATH_OUTSIDE_SCOPE`、目标为目录 `CODING_PATH_IS_DIRECTORY` 和权限拒绝（`apps/agent-service/src/production-coding-workflow.ts`）。页面投影仍保留“成功却标为未派发”这一矛盾组合为“结果未确认”的防线，但主进程不再产生这种组合；已执行的主进程工具行照结果显示“已完成”或“失败”，不再显示“结果未确认”，也不再给出“在原资源核验为已释放之前不要再次写”的提示。缺陷编号 R2-P1。
- **授权与记录**：授权仍在 `ALLOW` 之后才打开文件，使用与授权时相同的 Grant `id`、`revision`、`canonicalRootId`、`hostId`；主进程路径不签发 Worker Handle、不写沙箱准备记录，结果按同一 intent 保存，工具耗时由主进程自己写 `startedAt` 和 `endedAt`。

<a id="model-output-limit"></a>

## 2026-10-15 补充：超过配置上限改为截断并说明

条目 R2-T9 只修正[决定](#decision)第 1 点落地时“序列化结果超过调用自身的 `maxOutputBytes` 就整次失败”的收口方式，不改动上面的决定、上限来源、协议或持久数据形状。

- `read`、`ls`、`find`、`grep` 仍受配置 `runPolicy.coding.maximumBytes` 约束。超过时不再返回 `PI_RESULT_OUTPUT_LIMIT`，而是复用 Pi 的 `truncateHead`/`truncateTail`/`formatSize` 把交给模型的正文截断到上限内并加 Pi 的说明；`read` 保留 Pi 的 `Use offset=... to continue.` 续读提示（`packages/runtime-pi/src/host-read-only-executor.ts`、`packages/runtime-pi/src/model-output-budget.ts`）。只有正文清空仍装不下（信封本身超限）时才沿用 `PI_RESULT_OUTPUT_LIMIT`。
- `bash` 等沙箱前台结果同理（`packages/platform-node/src/files/pi-host-publication.ts`）；`details.fullOutputPath` 指向的完整输出文件在装不进剩余预算时不再导出，`fullOutput` 置为 `null`，正文改为说明“完整输出超过上限，未保留”。
- 机器秘密扫描仍在截断之前对整份结果执行；受保护候选结果文件（写/编辑准备结果，`production-file-preparation.ts`）与 `save_copy`/`move_directory` 的校验证据保持“超过即拒绝”。
- 命令运行中被结束的门槛不是 48 KiB：沙箱对命令标准输出和标准错误的结束门槛是 `maxOutputBytes × 64`（`COMMAND_OUTPUT_CEILING_MULTIPLIER`，生产 49152 × 64 = 3 MiB，`packages/platform-node/src/files/sandboxed-coding-operations.ts`，两个 runner 各自按 `maxOutputBytes` 推导）。低于它的输出不再中途结束命令，由 Pi 自己截到 2000 行 / 50 KiB 后交给模型；结果信封上限仍是 `maxOutputBytes`。超过它的命令仍以 `PI_COMMAND_OUTPUT_LIMIT` 结束，把保留的结尾交给模型属于 [BL-20261015-001](../backlog/BL-20261015-001-bash-非-零-退-出-时-把-输.md) 的范围。
- 本补充取代[实现记录](#implementation-record)“限制不变”一句里“序列化结果仍受调用自身的 `maxOutputBytes` 约束”的旧收口含义。前台 Bash 的背景输出说明仍计入整份结果上限（[ADR 0040](0040-background-output-closed-after-bash-returns.md#decision) 不变）。

实现理由（原来写在代码注释里，按“不加代码注释”的规则移到这里）：

- **只给 `read` 传字节预算，`ls`/`find`/`grep` 保持 Pi 默认。** `read` 由 Himawari 自己调用 Pi 的 `truncateHead`，传预算后由 Pi 生成原生 `Use offset=... to continue.` 续读提示；`grep` 的机密扫描目前只在结果交付处做，若把预算压进 `grep` 的结果截断，会让被截掉的部分不再被扫描，因此 `grep` 保持 Pi 的 50 KiB 默认、由信封收紧收口。`ls`/`find` 走 Pi 工具工厂，无法传预算。
- **正文预算用二分查找，按整份信封的 UTF-8 字节数判断。** 信封的固定部分（`schemaVersion`、`tool`、`source`、截断元数据和说明）会占一部分预算，且 JSON 转义会让换行、引号和控制字符变长，正文字节数不等于信封字节数；因此每次候选都用完整 `JSON.stringify` 的结果测量，二分查找最多 32 步，结果有界且确定。搜索上界取最小正文长度减一，保证搜索区间内每一段正文都被截断，使其大小随预算单调，二分成立。
- **`details.truncation` 去掉 `content`。** Pi 的 `TruncationResult` 第一个字段就是截断后的正文，而信封的 `content` 已经携带同一段正文；不去重会让正文在信封里出现两次，二分查找只能找到约一半的预算。去重的 `truncationMetadata` 放在 `runtime-pi`，`production-host-read.ts` 复用它；`platform-node` 按 Workspace Contract 不能依赖 `runtime-pi`，那一处保留结构相同的本地写法，类型用结构相同的 `PiHostResultOutputFitter`（`platform-node` 也不得 import `@earendil-works/pi-*`）。
- **`PI_RESULT_OUTPUT_ENVELOPE_RESERVE`（2048 字节）** 只是给调用方第一次截断用的保守余量；信封最终仍由 `fitPiResultOutput` 精确测量并按需再截一次，所以这个常量只影响第一次截断的松紧，不影响上限是否成立。
- **预备写入路径把截断函数和可复制的发布输入分开传。** `publishPreparedPiOperation`（`packages/platform-node/src/files/pi-host-publication.ts`）在入口把截断函数 `fitOutput` 从发布输入里拆出来，单独传给 `formatForegroundPiResult`；交给文件发布、目录移动与工作副本三个发布日志（它们各自 `structuredClone` 输入）的仍是不含函数的可复制输入。`write`、`edit` 的准备结果因此不再把函数带进 `structuredClone` 而整次失败，`fitOutput` 的默认值 `exactFitOutput` 保持不变。

<a id="failed-command-output"></a>

## 2026-10-16 补充：命令失败时把输出结尾交给模型

条目 R2-T14（用户 G109 第 6 项）落实了[上一段补充](#model-output-limit)留给 [BL-20261015-001](../backlog/BL-20261015-001-bash-非-零-退-出-时-把-输.md) 的部分，不改动上面的决定、上限或结束命令的门槛。完整规则写在 [SRT 统一执行设计的“输出、资源与可观察性”一节](https://github.com/sixianli/himawari-agent/blob/208007462f99e16c5c8cd4daac2acc10fa9f5f36/docs/execution/specs/2026-09-07-srt-unified-execution-design.md#8-输出资源与可观察性)，实现位置见同一文档的 [R5 实现说明](https://github.com/sixianli/himawari-agent/blob/208007462f99e16c5c8cd4daac2acc10fa9f5f36/docs/execution/specs/2026-09-07-srt-unified-execution-design.md#r5-实现说明2026-09-09)。

- 前台 `bash` 以非零状态结束、超时，或输出超过命令输出上限（`maxOutputBytes × 64`）被结束时，模型看到 Pi 保留的输出结尾和一句结束说明。超时在 `packages/runtime-pi/src/governed-host-operations.ts` 换成 Pi 认识的 `timeout:<秒>`，由 Pi 自己写“Command timed out after N seconds”；同一处也把取消换成 Pi 认识的 `aborted`，但前台 runner 目前不把取消信号传给 Pi，产品路径上走不到这一步；授权到期改用单独的 `PI_COMMAND_GRANT_EXPIRED`，不再被说成超时。超过命令输出上限时 Pi 原样抛出错误、不写说明，`packages/runtime-pi/src/sandboxed-coding-executor.ts` 取 Pi 抛错前最后一次 `onUpdate` 给出的结尾，后面由产品加一句说明命令因输出过多被结束。
- 这些结果照常经过机器秘密扫描和 `maxOutputBytes` 截断。前台 `bash` 的结果命中机器秘密时不再整次失败，而是交出一份不含正文、不含命令参数的结果，只说明输出因含疑似密钥未交出，并保留命令真实的退出码；`write`/`edit` 见下面关于合同版本 1 的一条；其他工具命中仍整次失败。
- 私钥片段也算命中（2026-10-17，用户 G127）。共用规则 `scanMachineSecrets` 只认从开头行（`-----BEGIN … PRIVATE KEY-----`）到结尾行完整的一段私钥；Pi 只保留输出结尾时会丢掉开头行，命令本身也可能只打印一部分（例如 `head -5`），剩下的结尾行或开头行加正文就看不出来。把工具输出交给模型的五处改用 `containsToolOutputSecret`（`packages/sensitive-capture/src/machine-secrets.ts`）检查工具产生的那部分输出：原规则命中，或者出现任何一行私钥开头行或结尾行，都算命中。五处是前台结果的 `content` 和 `details`（`pi-host-publication.ts`）、完整输出文件（`pi-output-export.ts`）、后台输出流（`pi-coding-main.ts`）、主机 `read`/`ls`/`find`/`grep` 结果的 `content` 和 `details`（`production-host-read.ts`；主机 `grep` 读文件时不整份扫描，带上下文行就能只露出开头行加几行正文），以及 `write`/`edit` 准备阶段生成的预备结果（`production-file-preparation.ts`；`edit` 的差异片段带上下文行，同样可能只露出开头行加几行正文）。整个结果信封，包括模型自己给的参数（命令原文、搜索词、写入内容），仍只用原规则检查：参数是模型写出来的，原样回给它不会多泄露什么，按新规则查参数反而会让“搜一搜仓库里有没有私钥”这类命令被拦。合同版本 3 在准备阶段先查，是因为它的发布阶段先把文件写进去才整理结果，到发布阶段才拦就会出现“文件已改、模型却收到失败”。生产用的合同版本 1 没有准备阶段，见下面关于合同版本 1 的一条。完整输出文件命中时，`bash` 同样交出上面的提醒，不再让 runner 以 `PI_RUNNER_EXECUTION_FAILED` 整次失败。
- 合同版本 1（`pi-coding-tool/1`，生产绑定的版本）的 `write`/`edit`（2026-10-17，G127 范围内）：Pi 在沙箱里直接改文件，改完才整理结果。结果命中私钥片段或机器秘密时不再整次失败，而是交出一份不含正文和 `details`、保留调用参数和写入证明的结果，只放一句固定说明：文件已修改并通过核实、文件没有被修改，或文件可能已被修改。调用参数要保留，因为主机按参数核对写入证明；参数本身含机器秘密（例如写入内容里有一段完整私钥）时仍整次失败，参数里的秘密留在对话中这一半仍记在 [BL-20261017-001](../backlog/BL-20261017-001-写-入-内-容-含-完-整-私.md)。同一次还查明：版本 1 的 `write`/`edit` 只要失败（包括最常见的 `edit` 原文找不到），效果就停在“未知”，结果不交给模型，恢复流程拿同一条模型输出反复重放到运行截止时间；第四次上线的版本也是这样。现在 runner 用约束文件平台的 `onCommitStarting` 回调记下有没有开始改目标文件，还没开始就在结果里写 `writeNotStarted: true`（它只说明目标文件没被改，新建文件时缺失的父目录在回调前已建好，失败后可能留下空目录）；Worker 和 Agent 核对它属于本次调用后记原因码 `FILE_WRITE_NOT_STARTED`，把 Pi 的原始错误交给模型。不能证明没改的失败记 `SANDBOX_WRITE_EFFECT_UNVERIFIED`，和工具超过期限一样按有界失败处理（[ADR 0035](0035-tool-deadline-continues-run.md)）：效果仍是未知，模型收到一次固定说明，不重放。比较过三种做法：写入前拒绝含私钥标记的内容（会让已批准的“写一份讲解 PEM 格式的文档”场景失败，没有采用）；主机重新读目标文件、和执行前的版本比较（版本 1 的执行范围里没有执行前的文件版本，做不到）；由 runner 报告“还没开始改”（采用；和现有的写入证明一样，是 runner 给证据、主机核对它属于本次调用）。细节见 [SRT 统一执行设计的 R5 实现说明](https://github.com/sixianli/himawari-agent/blob/208007462f99e16c5c8cd4daac2acc10fa9f5f36/docs/execution/specs/2026-09-07-srt-unified-execution-design.md#r5-实现说明2026-09-09)。
- 共用规则本身不变：读整份文件的路径看到的是完整私钥，原规则已能拦住；记忆、检查点、线程标题、配置和模型请求处理的是对话文字，提到标记行不等于泄露，放宽会误拦整轮对话；脱敏函数只换掉一行标记会把正文留在原处。代价是工具输出里单独出现的标记行也会被拦，例如 `grep` 或 `read` 到一份讲解 PEM 格式的文档，或者在这样的文档里改动标记行附近几行（`edit` 的差异片段会带上那一行；生产上文件照常修改，模型只收到“文件已修改并通过核实”的固定说明，看不到差异）；写入这样的文档本身不受影响。仍识别不了的情形：只有正文、没有任何标记行的片段（例如 `sed -n 2,20p` 取中段）；标记行自己被截成半行（Pi 只在最后一行单独超过 50KB 时保留这一行的结尾部分，截断点正好落在标记里、后面还跟着将近 50KB 内容才会发生；普通私钥只有一两 KB，实际很难遇到）；私钥类型仍只认无类型、`RSA`、`EC`、`OPENSSH` 四种，`DSA`、`ENCRYPTED PRIVATE KEY` 和 PGP 私钥块不在规则内。
- 工具结论仍是失败，错误码仍是 `SANDBOX_COMMAND_EFFECT_UNVERIFIED`。Agent 交给模型之前先核对 runner 写出的结果，再在最前面加 `effectNotice` 提醒命令可能已改动工作区；核对不通过时仍只给原来的固定说明。
- 后台和服务模式没有改，记在 [BL-20261016-003](../backlog/BL-20261016-003-后-台-和-服-务-模-式-的.md)。

<a id="resident-job-host"></a>

## 2026-10-18 补充：同一轮复用沙箱的第一步（常驻任务宿主）

本段落实[决定](#decision)第 2 点的第一步（长任务条目 R2-P2 的第一次提交），不改动决定本身。第二步“沙箱里的 runner 也常驻、不再每条命令重新加载 Pi”见[第二步补充](#resident-runner)，它取代本段的两条。

- **适用范围**：Linux、部署了沙箱、没有配置容器任务环境（可选的严格模式，见 [ADR 0033](0033-process-sandbox-default-and-optional-containers.md)）时，前台 `bash` 和合同版本 1（`pi-coding-tool/1`，生产绑定的版本）的 `write`、`edit` 复用同一轮对话（Run）里已经启动的任务宿主（Job Host，Worker 在沙箱外为每个沙箱启动的看管进程，负责准备沙箱运行时、出口代理和主机守护，再启动并看管命令）。后台命令、服务模式、合同版本 2–5 和 Mac 照旧每次调用新建沙箱。
- **一轮最多两个常驻会话**：命令会话服务 `bash`，文件写入会话服务 `write`、`edit`。两者的沙箱策略不同（`bash` 不能写 `.himawari-recovery`，`write`、`edit` 可以），所以不共用一个沙箱。同一轮内的调用依次执行。
- **共享什么、不共享什么**：沙箱运行时（`@anthropic-ai/sandbox-runtime`）初始化、出口代理和主机守护每个会话只做一次。每条命令仍新起一个 `bwrap`（Linux 上建立隔离命名空间的程序），有自己的命名空间；一条命令留下的后台进程（例如 `setsid nohup … &`）随这条命令的命名空间一起结束，下一条命令看不到它。
- **每条命令的结算**：只有命令进程已退出、输出管道已关闭、进程组已消失、清理已完成、命名空间已释放这五条都成立，会话才继续接下一条命令；任何一条不成立，本条调用的效果记为“未知”，整个环境停掉，不再复用；这条调用一直占着工作区，直到核查清楚，在那之前同一轮里后面的调用被拒绝，也不启动新的 Job Host（既有规则，见 R2-P2 计划 2026-10-18 04:33 一条）。
- **什么时候换新环境**：Agent 为每轮算一个复用键（同一授权、同一租约、同一模型和运行时摘要等，完整列表见[隔离工具执行设计的“SRT 常驻任务宿主的现状”](https://github.com/sixianli/himawari-agent/blob/208007462f99e16c5c8cd4daac2acc10fa9f5f36/docs/execution/specs/2026-09-24-isolated-tool-execution-design.md#srt-resident-job-host)），键变了或环境期限到了就先停旧环境再建新环境；授权撤销和到期都走这一条。Worker 重启后不复用旧环境：环境记录里带着 Worker 本次启动的实例号，新实例按记录的进程号和启动时间确认旧进程都已消失后，给出释放证明。
- **释放证明与数据库迁移**：常驻环境的释放证明是“进程组已消失”（`process_group_gone`），不是容器后端用的“已核实停止”。迁移 0051（`0051_srt_task_environment_release.sql`）把释放记录表允许的证明种类加上这一项，数据库结构版本从 50 升到 51；存储层只对后端名为 `srt-task-environment` 的环境接受这种证明。因此包含本步的上线是一次带数据库迁移的变更。
- **与容器任务环境互斥**：存储层按“每轮一个主环境”保存，不区分后端；同时开两种环境会让一种后端拿到另一种后端的环境。现在只在没有配置容器任务环境时启用常驻宿主，协调器在拿到的环境后端名与自己不同时报 `EXECUTION_BINDING_CHANGED`。
- **执行模式不变**：只有配置了容器任务环境时 Agent 才报告严格模式；常驻宿主不改变这一点。

<a id="resident-runner"></a>

## 2026-10-18 补充：同一轮复用沙箱的第二步（沙箱内常驻 runner）

本段是 R2-P2 的第二次提交，落实[决定](#decision)第 2 点的其余部分。它取代[第一步](#resident-job-host)里“共享什么、不共享什么”和“每条命令的结算”两条，其余各条不变。

- **一个会话一个 `bwrap`**：会话准备时，Job Host 只启动一次 `bwrap`，里面运行已安装的 Pi 编码程序（`pi-coding-main`，带 `--resident` 参数），它先把 Pi 加载好，再报告“准备好了”。之后同一会话的每条命令，Job Host 往它的标准输入写一行请求，它在同一个沙箱里执行，把输出和退出码按行写回。所以从第二条命令起不再重新启动沙箱、也不再重新加载 Pi。
- **命令之间清掉留下的进程**：会话准备好后，Job Host 在沙箱外读主机的 `/proc`，记下 `bwrap` 下面那时已有的全部进程（进程号和启动时间），当作这个会话的基础进程（runner 本身和沙箱运行时的网络转发进程）。每条命令结束后，Job Host 把不在这份名单里的进程逐个强制结束；每次强制结束前重新读一遍这个进程的启动时间和父进程，不一致就不动它；连续两次扫描都没有多余进程才算清理完。已经退出、只等父进程回收的僵尸进程（状态 `Z`）和正在被系统移除的进程（状态 `X`）算作已经不在：它们不再运行代码，强制结束对它们也不起作用；反过来，基础进程变成僵尸就算少了。这和释放证明里“僵尸仍算成员”的规则用途不同：释放证明要证明整个进程组已经完全消失，这里只要保证下一条命令开始前没有还在运行的残留。因此一条命令用 `setsid nohup … &` 留下的后台进程，下一条命令照样看不到。
- **每条命令的结算**：runner 已回报这条命令的结果、多余进程已清理完、基础进程一个不少且身份没变，这三条都成立，会话才接下一条；报告里的命名空间状态是“常驻完好”（`resident_intact`，取代第一步的“已释放” `released`）。任何一条不成立（runner 中途退出、写回的内容不合格式、基础进程少了或换了），本条调用的效果记为“未知”，整个环境停掉，不再复用；这条调用一直占着工作区，直到核查清楚，在那之前同一轮里后面的调用被拒绝，也不启动新的 Job Host（既有规则，见 R2-P2 计划 2026-10-18 04:33 一条）。
- **被 Job Host 结束的命令不带退出码**：命令因截止、输出超限、资源超限或取消被 Job Host 结束时，runner 仍会照常回报一个退出码，但那只是 runner 看到子进程被杀的结果，不是命令自己的退出。所以只有结束原因是“自己退出”（`exited`）时，报告才带退出码；其余原因一律不带，Worker 按结束原因给出截止、输出超限或“未知”的结果。这几种结果的效果都记为“未知”，所以这条调用照样一直占着工作区，同一轮后面的调用被拒绝，直到核查清楚；Job Host 留住会话只是不必为这条命令停掉沙箱，不解除这条既有规则。这和每次新建沙箱时的规则一致。Worker 收到结束原因不是 `exited` 却带着退出码的报告，按格式不合关闭会话。
- **资源和进程号**：资源用量仍在沙箱外按 `bwrap` 的进程树统计，每条命令开始时记一次 CPU 基线，只算这条命令新增的部分。内存不减基线：内存上限管的是整个沙箱此刻实际占用的内存，常驻 runner 的内存也算在内，和每次新建沙箱时 runner 同在沙箱里一样；CPU 是累计时间，才需要减去之前的部分。每条命令报告的进程号就是常驻 `bwrap` 的进程号；Worker 收到的“准备好了”消息带着这个进程号，命令报告的进程号与它不同时会话失败。环境记录同时保存常驻 `bwrap` 的进程号和启动时间，停止证明要确认它也已消失。
- **沙箱运行时的清理**：沙箱运行时原来每条命令结束都做一次清理，现在改为会话结束时做一次。
- **仍然每次新建沙箱的情况**：后台命令、服务模式、合同版本 2–5 和 Mac，与第一步相同。

<a id="resident-fixes"></a>

## 2026-10-18 补充：第 4 层发现的缺口

R2-P2 前两次提交后，第 4 层（Hermes 上的真实产品路径测试）发现了下面的缺口，各自单独提交修复，不改动[决定](#decision)。

- **Agent 重启后遗留的任务环境由巡检收回**：任务环境（常驻 SRT 环境或容器环境）活得比单次调用长。Agent 崩溃或重启时，正在用的环境可能既没停也没有释放回执；而 Run 结束投递和工具结果恢复都要求这个 Run 的每个任务环境都已释放（`RUN_RESOURCES_RELEASED_SQL`），于是这个 Run 永远停在 `running` 或 `reconciling_external_result`。现在资源恢复每轮在原有预约回收之后，再找出这样的环境逐个停掉：环境未释放，所属 Run 没有未过期的执行租约，且 Run 之后不会再被认领去执行，即 Run 处在 `reconciling_external_result`、`completed`、`failed`、`cancelled`，或仍是 `running` 但检查点已经记为完成（只差完成投递）。停止原因按 Run 状态给出：取消为 `run_cancelled`，完成、失败或检查点已算完为 `run_finished`，其余（对账中且检查点未算完）为 `supervision_lost`。其余状态（`accepted`、`building_context`、未算完的 `running`、`awaiting_approval`）的环境不动：这些 Run 之后还会被认领执行，认领时协调器会复用旧环境，或在 Worker 实例变了时先停旧环境再换新环境；巡检去停它们会和认领抢同一个环境。已结束（完成、失败、取消）且还有未释放预约的 Run 也不动：它的环境由预约回收负责停（见 R2-D6），那条路停止失败后有意暂停、等人工重试。对账中或只差完成投递的 Run 即使有未释放预约也照停：预约回收对没结束的 Run 不停环境，只在环境释放后才释放预约，环境没释放时按可重试的原因退避再试，所以巡检停掉环境后，预约随后由预约回收释放。停止已有停止意图的环境时沿用原意图和原因；Worker 暂时连不上（`EXECUTION_STOP_UNCONFIRMED`）或写入冲突时下一轮再试，其他错误在这一页都试过之后报出。
- **取环境时把未确认的停止接着做完**：环境的停止意图已经写下、但后端停止或停止证明没有确认时，环境停在 `stop_requested`。一个还会继续执行的 Run（例如调用结果未知时观察流程请求停止环境，而停止没有确认）之后每次取环境都直接报 `EXECUTION_STOP_UNCONFIRMED`，即使后端已经恢复也不会再试，直到 Run 结束。现在取环境遇到 `stop_requested` 时，先按原来的停止意图再停一次（意图编号、停止原因和要停掉的资源都不变）：停止确认后，按原意图的原因换新环境；原意图是 Run 已结束或已取消时照旧报 `EXECUTION_BINDING_CHANGED`，不换新环境；后端仍然没有恢复时照旧报 `EXECUTION_STOP_UNCONFIRMED`，也不新建环境。已结束的 Run 在预约这一步就被拒绝，走不到这里，所以不影响 R2-D6 那条“停止失败后暂停、等人工重试”的路线。
- **常驻环境和容器环境里的调用结果也能补救**：调用结果没能交回 Agent（Worker 写回失败、服务重启等）时，原来的流式补救和丢失结果补救只认一次性 SRT（`backendRef` 为 `srt`），常驻 SRT 和容器任务环境里的调用结果永远停在“未知”，页面一直显示“结果未确认”。现在两条补救路也接受任务环境里的前台调用，前提是这条调用所在的整个任务环境已经停止并有释放回执（依据不能是“创建请求还没发出就停了”），并且环境记录里有这条调用。整个环境停止证明环境里的命令都已结束、之后不会再写工作区，这一条代替一次性 SRT 用的“原签名退出记录”。存储层在写入补救结果时也自己按同样三条核对环境记录、释放回执和调用记录，不只依赖 Agent 侧的判断。存储层的认领条件同步放宽到 `facts.environment.kind` 为 `container` 的记录，这个条件本来就要求该 Run 的所有任务环境都已释放。其余条件不变：拼回原输出仍要求完整的结束分块；记成 `SANDBOX_TOOL_RESULT_LOST` 仍要求原执行权威已被取代；两条路都不重新执行工具。这个证明说明不了命令是否开始过：调用在绑定环境时就登记进环境记录，所以 Worker 在绑定之后、发出命令之前中断的调用也会记成 `SANDBOX_TOOL_RESULT_LOST`，固定说明里“工具已运行并结束”这半句在这种情况下不准确；后半句（可能已经有效果，重做前先确认）仍然成立，所以不另作区分。环境记录和调用记录对不上时（环境读不到或绑定字段不一致），补救照原有做法报错拒绝，不当成“不能补救”悄悄跳过。
- **载荷通道的请求体上限按载荷上限算出**：Worker 和 Agent 之间的载荷通道（Payload UDS，本机 Unix 套接字上的受保护数据通道）把载荷按 base64 编码（每 3 字节变 4 个字符），再加上请求编号、令牌、内容类型等外层字段，放进一个请求体。原来请求体上限固定为 65536 字节，载荷上限是 49152 字节，一份接近上限的载荷编码后再加外层字段就超了，Worker 写回结果时报 `PAYLOAD_UDS_BODY_TOO_LARGE`。一次性 SRT 上同样会超，只是流式补救用运行时存下的输出分块把原输出拼了回来，所以以前的测试照样通过；常驻环境原来没有这条补救，问题才露出来。现在载荷通道的请求体上限由 `payloadBrokerV1BodyBytes` 算出：载荷上限按 base64 编码后的长度，加 2048 字节外层预留，默认 67584 字节。服务端和客户端构造时都检查请求体上限装得下最大载荷，装不下就拒绝启动。准入通道和执行通道不传载荷，上限仍是 65536 字节。Worker 组合的 `maximumBodyBytes` 选项因此只再约束准入通道，载荷通道总用算出的上限。2048 字节预留按带载荷正文的两种消息（`payload.output.write` 和 `payload.input.read.result`）里最长的外层字段算，还剩约 0.5 KiB；其他载荷通道消息（例如带输出分块的 `payload.sandbox.execution`）原来就要装进 65536 字节，新上限更大，不受影响。
- **停在绑定之前的调用答“工具未启动”**：在常驻 SRT 环境或容器环境里，一次调用可能在 Agent 重启时停在“已预约、还没绑定”：启动恢复给这条预约打上停止标记（`reservation_stopped_at`），之后绑定（`bindAndStart`）永远被拒绝，命令从没交给环境。原来预约回收只认“环境已释放”的证明（`task_environment_released`），而 Run 还会继续执行时环境不会被停，于是预约一直占着工作区，这次调用也一直拿不到结果，Run 卡住。一次性 SRT 在同样情况下会给模型 `SANDBOX_TOOL_NOT_STARTED`，所以这是常驻路径带来的退步（第 4 层 D-43）。现在，环境还没释放、且 Run 没有结束（不是 `completed`、`failed`、`cancelled`）时，预约回收给出新依据 `task_environment_bind_fenced`，意思是“绑定已被停止标记挡住”。存储层接受前自己核对：计划后端不是 `srt`，执行记录仍是 `reserved`、`started_at` 为空、`reservation_stopped_at` 等于证明里的停止时间、后端与计划一致；只在接受的那一刻再查一次 Run 没有结束。读旧回执时不查 Run 状态，否则 Run 结束后已接受的回执会读不出来，Run 结束时的资源释放（`stopRun` 要读这些预约）就会卡住。环境不停，同一轮后面的调用继续用它。接受后预约占用释放，这次调用按“从未启动”给模型 `SANDBOX_TOOL_NOT_STARTED`，Run 继续，不重放这次调用。两处“从未启动”判断（TypeScript 的 `isSandboxReservationNeverStarted` 和 SQL 的 `SANDBOX_RESERVATION_NEVER_STARTED_SQL`）对非 `srt` 后端同时接受 `task_environment_released` 和新依据：这两个判断只用在仍是 `reserved` 的记录上，而释放回执要求预约已有停止标记，带停止标记的预约不能再绑定，所以命令确实没交给过环境。已结束的 Run 仍要求环境先释放，R2-D6 和 [BL-20260929-004](https://github.com/sixianli/himawari-agent/blob/208007462f99e16c5c8cd4daac2acc10fa9f5f36/docs/backlog/BL-20260929-004-agent-重-启-后-停-止-终-态.md) 的“停止失败后保持占用、等人工重试”不变。新依据不要求环境记录存在：Run 的第一次调用可能在环境创建之前就中断，这时环境记录还没有，`task_environment_released` 给不出，只有新依据能放掉这条预约。Run 已进入 `reconciling_external_result` 时，预约虽然先放掉，工具结果恢复仍要等巡检在执行租约过期后停掉环境（本节第一条），之后照常收尾。
- **任务环境里正在运行的命令显示为“正在执行”**（缺陷 D-48）：任务环境（常驻 SRT 环境和容器环境）的绑定记录按设计停在 `initializing`，一次性 SRT 靠 `controlled` 观测判断“正在执行”的分支够不到它，所以命令运行期间页面一直显示“正在准备”。现在对话页投影对已绑定、`initializing`、还没有结果、且环境是容器任务环境的记录，改用三样持久事实判断：这条调用已经登记进环境（`execution_environment_calls` 里的 `invocation_id` 与本调用一致，`execution_job_id`、环境代次和停止标记与环境事实一致）；环境存活且未过期（`state` 为 `ready` 或 `running`，环境期限晚于当前时间）；这个 Run 的执行租约有效（`run_execution_leases` 已由调度器续期，未释放且未过期）。三样都成立显示“正在执行”（`RESOURCE_EXECUTION_OBSERVED`），最近观测时间取调用登记时间。找不到匹配的调用、环境代次或 Job 或停止标记对不上、环境已停止或已释放或未知、环境期限已过，显示“结果未确认”（`RESOURCE_STATE_UNCONFIRMED`）；调用登记和环境都在，只是执行租约没有、已释放或已过期，同样显示“结果未确认”，原因码用 `RESOURCE_OBSERVATION_EXPIRED`，与一次性路径的观测过期同义。命令已经结束、结果还在写回的这一小段时间不算结束：只要执行租约还有效就继续显示“正在执行”，直到结果写回走既有的已释放分支，避免正常结束时页面闪一下“结果未确认”。界限：Agent 死掉但 Run 还活着时，持久事实只能靠执行租约过期来发现，所以租约过期之前仍显示“正在执行”，也不会超过计划的执行期限（Run 变终态时投影强制“结果未确认”）；不要承诺能立即发现 Agent 死亡。一次性 SRT（环境类型为 `local`）的 `initializing` 不受影响，仍显示“正在准备”。契约来源是 `packages/application/src/ports/sandbox-execution-journal.ts` 与 `packages/application/src/services/thread-execution-resources.ts`。
- **常驻记录的到期结果恢复用自己的释放证据**：工具到原期限被终止后，Agent 的到期结果恢复原来无条件读取一次性 SRT 的 `sandbox-control:` 工件；常驻 SRT 记录从不登记这个工件，于是抛 `SANDBOX_CONTROL_BINDING_UNAVAILABLE`。这条错误经运行/资源循环变成整服务“失去权威”并退出，重启后又遇到同一条记录，服务反复崩溃（第 4 层 D-49）。现在按后端分派：一次性 `srt` 才要求 `sandbox-control:` 工件；任务环境（常驻 SRT 与容器）要求它自己的证据——结束块 `sandbox-stream-end:`，加上“整个环境已停止并有释放回执（依据不是 `create_not_dispatched`）、环境记录里有这条调用”，与本节“常驻环境和容器环境里的调用结果也能补救”用的是同一套证据。存储层 `assertDeadlineArtifacts` 同样按后端分派，常驻记录不再因缺控制工件被拒（`PORT_NOT_AUTHORITATIVE`），一次性 `srt` 的行为逐字不变。后端判断只在一处定义（`sandboxBackendKind`：`srt` 是一次性，其余是任务环境），Agent 与存储层都用它。
- **单条记录的恢复失败不再拖垮整个服务**：运行循环与资源恢复原来把任何一条记录处理中的拒绝都升级为整服务退出。现在只有明确列出、已确认只影响这一条记录的错误码才留在该记录上——沙箱执行记录的流分块、结果恢复、对账、控制与任务环境证据错误（清单见 `apps/agent-service/src/production-record-failure.ts`），执行中的 Run 记 `RUN_EXECUTION_FAILED_WITHOUT_RESULT`，工具结果恢复记 `TOOL_RESULT_RECOVERY_FAILED`，对账记 `RUN_RECONCILIATION_FAILED`，资源恢复写在该记录已有的恢复状态里。其余一律仍让服务退出：控制权丢失 `AGENT_AUTHORITY_LOST`、`PORT_NOT_AUTHORITATIVE`（租约或栅栏已失效）、一般的 `PORT_CONFLICT`（并发修订冲突，下一轮重试）、任何带 `sqliteCode` 的数据库错误（含 `SQLITE_BUSY`/`SQLITE_FULL` 被转成的 `PORT_CONFLICT`，见 `packages/persistence-sqlite/src/sqlite-worker.ts:969-975`），以及未列入清单的未知错误；写隔离本身失败也按全局错误退出，不留“既没隔离也没退出”的状态。调度循环的 `runtime.failed` 诊断补上出错阶段。重试频率由既有机制限制：运行循环经 `quarantine` 把该 Run 移出候选谓词，资源巡检沿用原有保留重试策略（哪些原因码重试、1/2/4/8/16/30 秒退避或不再重排）。用户只会看到那一条 Run 停在“结果未确认”，其余对话照常可用。
- **常驻环境被释放时补写“未知”工具结果**：用户停止一条正在运行的常驻命令、或巡检/到期释放它时，Agent 先把环境释放；Worker 之后想写结果会被“已释放”挡住，执行记录的 `facts.result` 永远为 `null`，页面一直显示“结果未确认”（第 4 层 D-50）。一次性 SRT 和容器路径在同样情况下会写下 `result.kind` 为 `unknown`、`reasonCode` 为 `SANDBOX_EXIT_UNKNOWN` 的确定结果。现在所有释放路径都经过同一个结算点（`SandboxExecutionReconciliationService` 的 `onReleased` 钩子，用户停止、Run 结束、巡检释放、载荷通道的 Worker 停止都走它）：已绑定（`started_at` 非空）、`foreground`、任务环境后端、结果仍为空的调用，在环境释放确认后补写同一对值；未绑定的调用仍按“从未启动”走 `SANDBOX_TOOL_NOT_STARTED`，已有确定结果的调用不覆盖。写入用“迟到操作证据”通道（`recordOperation`），只写结果与效果、不改资源观察；并发时确定结果优先，重复结算幂等。
- **其他 Run 的未确认占用排队，同一轮后面的调用仍被拒绝**：常驻前台的 `bash`、`write`、`edit` 与一次性 SRT 共用同一条工作区排队准入（`sandbox_admission_queue`）。原来常驻路径在准备阶段（`prepare`）就获取本 Run 的任务环境，工作区冲突在排队循环之前抛出，于是既不写队列也不等待重试；现在把这一步挪到入队之后、由排队循环驱动（`worker-delegation-service` 的可选 `acquireEnvironment`，只有 `srt-task-environment` 后端会用它），并把请求自己的作业标识交给环境的公平检查，请求不会再被自己刚写的排队记录挡住。冲突来自**其他 Run** 的未确认占用时写队列、等待释放后准入；冲突来自**本 Run** 自己的占用时立刻拒绝（`WORKSPACE_OCCUPIED_BY_RUN`），交给队列等待没有意义，也不新建 Job Host，这与[第一步](#resident-job-host)和[第二步](#resident-runner)写的“同一轮里后面的调用被拒绝”是同一条规则。排队期间不持有任务环境，只有队列记录；到期限、取消或授权变化时按[工作区授权与执行状态协同设计](https://github.com/sixianli/himawari-agent/blob/208007462f99e16c5c8cd4daac2acc10fa9f5f36/docs/execution/specs/2026-09-16-workspace-authorization-lifecycle-design.md#workspace-fair-queue)的第 5.5 节和第 4.2 节处理，不自动延期。

<a id="resident-bind-prefailure"></a>

## 2026-10-19 补充：复用路径 bind 前失败不再静默

D-52：同一轮里的第二次调用，在常驻和容器两条复用路径上如果在外层环境绑定提交之前失败（宿主绑定、范围校验、环境瞬态不可用、会话准备等），Worker 原来的写法既不写绑定也不写诊断，调用方只拿到“结果未知”，而这条预约一直占着工作区，同一轮后面的调用被一直挡住。本段只修正这个静默失败，不改动[决定](#decision)、[常驻任务宿主](#resident-job-host)和[常驻 runner](#resident-runner)的复用规则。

- **让失败可见**：`runInSrtEnvironment` 和 `runInEnvironment` 在宿主绑定准备之前把诊断阶段记为 `prepare`，在 `bind` RPC 之前记为 `bind`，在绑定成功之后记为 `execute`；`run` 的错误分支据此走一次性路径已有的诊断通道（`preparation_diagnostic`），不再静默返回空结果。诊断形状与原因码沿用既有约定，不新增协议。绑定之后的失败因此记为执行阶段（`SANDBOX_EXECUTION_FAILED`），不会被误报成绑定失败。
- **判为从未启动并立即释放**：Worker 返回后，Agent 读回的 admission 仍是 `reserved`、计划为前台任务环境、Run 仍在进行时，立即按[第 4 层发现的缺口](#resident-fixes)已有的路径停止该预约，并用 `task_environment_bind_fenced` 释放，随后交付一次固定失败 `SANDBOX_TOOL_NOT_STARTED`（“工具未启动：准备阶段失败，已确认清理完成。”）。**不停止环境**：命令从未交给环境，环境保持存活正是常驻环境两次调用之间的常态，别的 Run 仍由环境租约挡住。
- **只对 bind 之前成立**：绑定已经提交，或失败发生在绑定之后的调用，仍按既有规则记为“效果未知”，保留工作区占用直到核查清楚，环境照旧停掉；不自动恢复、`read()` 对预约事实的拒绝，以及同一 Run 占用时后续调用排队等待的规则都不变。

<a id="resident-stop-retry"></a>

## 2026-10-21 补充：重启后任务环境停止未确认时下一轮再试

D-53：候选 `882cc959` 的第 4 层里，`[R2-L6] retains unknown occupancy across real service restart until trusted release` 失败。常驻 SRT 环境里一条已绑定（bound）的调用，在服务成对重启后由资源恢复核对，动作是停止。新的 Worker 实例只能确认上一个实例留下的进程已经消失（见[第一步](#resident-job-host)），不会主动结束它们；旧的常驻任务宿主（Job Host）要等 Worker 心跳超时才自己退出，所以第一次核对时进程还在，停止没有确认，任务环境协调器报 `EXECUTION_STOP_UNCONFIRMED`。核对服务原来把这个错误归入兜底原因 `SANDBOX_RECONCILIATION_UNCONFIRMED`，而已绑定记录在兜底原因下不再排期，于是旧进程随后退出了也没人再核对，Run 一直停在 `reconciling_external_result`，工作区一直被占。这与[第 4 层发现的缺口](#resident-fixes)第一条“Worker 暂时连不上（`EXECUTION_STOP_UNCONFIRMED`）时下一轮再试”不一致。

- **单独的原因码**：核对服务把消息为 `EXECUTION_STOP_UNCONFIRMED` 的错误（任务环境协调器的停止，以及预约回收里 `stopRun` 没能释放环境）记为 `SANDBOX_TASK_ENVIRONMENT_STOP_UNCONFIRMED`，不再落到兜底原因。
- **任务环境的已绑定记录按退避重试**：资源恢复调度对已绑定记录，在动作为停止、状态未解决、原因是上面的新码、且计划后端属于任务环境（`sandboxBackendKind` 判为 `task_environment`）时重新排期，沿用预约回收的 1、2、4、8、16、30 秒退避。预约阶段的可重试原因也加入新码。
- **不变的部分**：一次性 SRT 的已绑定记录停止未确认后仍暂停、等人工重试（R2-D6、[BL-20260929-004](https://github.com/sixianli/himawari-agent/blob/208007462f99e16c5c8cd4daac2acc10fa9f5f36/docs/backlog/BL-20260929-004-agent-重-启-后-停-止-终-态.md)）；任何后端遇到兜底原因 `SANDBOX_RECONCILIATION_UNCONFIRMED` 都仍然暂停，不会对未知错误无限重试；执行权威、栅栏、恢复修订号的检查和超时都不变。
- **界限**：旧的 Job Host 被冻结或卡死时，重试会一直按 30 秒间隔进行，工作区保持占用，直到旧进程消失或管理员处置，与“核查清楚之前一直占着”的既有规则一致。是否主动结束上一个 Worker 实例留下的进程，没有在本缺陷里决定，记在 [BL-20261021-008](../backlog/BL-20261021-008-重-启-后-上-一-个-worker-实.md)。

<a id="resident-preparation-diagnostic"></a>

## 2026-10-22 补充：常驻路径准备失败带上宿主诊断

D-54：常驻 SRT 环境的会话在准备阶段失败（例如沙箱 SDK 初始化遇到 `EIO`）时，Job Host 已经发出诊断，Worker 侧的会话客户端也存下了，但只放进会话结果；常驻入口不经过一次性路径的宿主对象，[D-52 补充](#resident-bind-prefailure)里那条“走一次性路径已有的诊断通道”于是只交出了 `hostStage: null`、`systemCode: "UNKNOWN"`，服务日志的 `sandbox.preparation.failed` 也没有宿主字段，管理员看不到真实原因。一次性路径同样的失败给出 `hostStage: "sdk_initialize"`、`systemCode: "EIO"`。

- **诊断随“没准备好”的错误一起交出**：会话客户端在 Job Host 没有报告就绪就退出时，用带诊断的 `JobHostPreparationError` 拒绝就绪等待（消息仍是 `JOB_HOST_NOT_READY`），诊断与随后放进会话结果的是同一份。常驻后端原样抛出这个错误，不另外等会话结果，所以不会在环境锁里多等。
- **Worker 多认一个诊断来源**：准备诊断先取一次性路径宿主结果里的诊断；没有时再取这个错误带的诊断；两者都没有时照旧是 `hostStage: null`、`systemCode` 取错误自身的 `code` 或 `UNKNOWN`。
- **不变的部分**：诊断形状、原因码、协议和私密内容过滤都不变，常驻路径交出的内容与一次性路径同一份宿主诊断；D-52 的“bind 之前失败按从未启动释放、环境保留”不变；容器任务环境不经过 Job Host，照旧没有宿主字段。

<a id="resident-deadline-settlement"></a>

## 2026-10-22 补充：常驻命令到期限时稳定记成期限超时

D-55：候选 `9969a646` 的第 4 层里，`[R2-S3] terminates a running tool at its original deadline with authenticated cleanup: worker` 记成 `SANDBOX_EXIT_UNKNOWN`，这一轮停在 `reconciling_external_result`；上一候选同一用例通过。常驻环境的期限等于这次调用的工具期限，期限那一刻，Job Host 进程和 Worker 侧会话的会话期限计时器，与命令自己的期限计时器同时到期。会话期限先到时，Job Host 先杀常驻进程组，再结算命令，结算无法证明常驻完好，命令只能是未结算，Worker 记成结果未知；只有命令期限计时器先到时，命令才以 `deadline` 结算。这个竞争在 D-53、D-54 之前就存在。

- **会话停止时先结算正在运行的命令**：Job Host 在会话模式下因期限或取消停止、而有命令正在运行时，先按命令自己的结束流程以同一原因结束这条命令（会话仍处在运行阶段，常驻 runner 送回的结果帧照常接收），命令结算后再停会话和常驻进程组。期限那一刻 Job Host 自己的会话期限计时器和 Worker 发来的 `cancel` 会先后各调用一次停止，延后期内再收到期限或取消停止只记下最先的原因，不打断延后。命令没有及时退出时仍立即停止全部进程：等待上限是清理时限，Worker 发起的停止还受心跳看门狗限制（Worker 取消后不再发心跳，Job Host 1.5 秒收不到就按宿主故障停止），以先到者为准；这时命令报告未结算，会话的最终原因仍是最初的期限或取消：延后期内任何后到的宿主故障（命令清理兜底、心跳看门狗、runner 退出）都不改变最初原因，与改动前“先到的会话停止原因优先”相同。停止原因是宿主故障时立即停止，不延后。原来会话停止一开始就进入停止阶段并杀常驻进程组，之后到达的结果帧被当作无效帧拒收，命令只能是未结算。
- **不变的部分**：未结算的命令报告仍记成结果未知并保留占用、等核查，不因原因是 `deadline` 就当作已确认清理；Worker 的取消和期限归因、期限、清理时限和运行时长上限都不变；一次性 SRT 路径不变。期限时刻其他可能的竞争（运行时长上限、沙箱内权限确认在期限后被拒）记在 [BL-20261022-002](../backlog/BL-20261022-002-运-行-时-长-上-限-与-工.md)。

<a id="interrupted-recovery-retry"></a>

## 2026-10-22 补充：服务关闭打断的资源核查在下次启动后再做一次

D-56：候选 `51f8b927` 的完整第 4 层里，`[R2-T11][R2-S2] keeps an offline Worker result pending until paired service restart settles LOST` 在服务成对重启后 90 秒内一直停在 `reconciling_external_result`，资源没有释放，后面 7 个用例因发送按钮一直不可用连带失败；同一候选单独重跑这个用例通过，上一候选的完整第 4 层也通过。两次的差别在重启前一刻：通过时这条常驻命令的执行记录已经是 `lost`（第一次资源核查已经结束，原因是 [D-53](#resident-stop-retry) 的 `SANDBOX_TASK_ENVIRONMENT_STOP_UNCONFIRMED`，重启后按退避重试）；失败时还是 `initializing`，说明第一次核查还没写下结论，测试就停了服务。服务关闭会中止资源恢复循环，进行中的核查以 `SANDBOX_RECONCILIATION_INTERRUPTED` 结束、恢复状态记成 `unresolved`。下次启动时，启动恢复不改动 `unresolved` 状态，资源恢复调度对 `bound` 记录又只在原因属于“初始原因”（如 `SANDBOX_PREVIOUS_BOOT_UNKNOWN`）或 D-53 的停止未确认时重新排定，于是这条记录再也没有人核查。中断原因对 `reserved` 记录本来就可以重试，`bound` 记录漏了。服务日志随测试临时目录删除了，失败那次的恢复原因码没有直接读回，所以“那次正是被中断”是由读回和代码推断的；“中断后再无人核查”这条链条本身由新增的集成测试复现。

- **被中断等于没有结论**：资源恢复调度把 `SANDBOX_RECONCILIATION_INTERRUPTED` 和 `SANDBOX_PREVIOUS_BOOT_UNKNOWN` 一样当作初始原因：`bound` 记录（任何后端）的上一次核查以它结束时，下一次扫描立即重新排定一次，动作仍按 Run 状态决定。这个原因只在资源恢复循环被中止时产生：服务正常关闭，或派发循环失败（`#failClosed`，随后也会触发服务关闭）；循环被中止后本次运行不再扫描，所以实际效果是下次启动后再核查一次，不会在同一次运行里反复重试。数据库里记下的原因保持原样，不改写成 `SANDBOX_PREVIOUS_BOOT_UNKNOWN`。
- **不变的部分**：再次核查的结果按原有规则处理：停止未确认时按 D-53 退避重试；兜底原因 `SANDBOX_RECONCILIATION_UNCONFIRMED`、身份、证据、权限错误仍暂停；整个核查到期 `SANDBOX_RECONCILIATION_TIMED_OUT` 对 `bound` 记录仍暂停，是否放宽和是否给重试设总时长上限一起记在 [BL-20261021-008](../backlog/BL-20261021-008-重-启-后-上-一-个-worker-实.md)。工作区占用在拿到释放证明前一直保持，不重放原工具。D-55 与本缺陷无关：Worker 被杀时命令已经结算，Job Host 处在空闲阶段，不经过 D-55 的延后分支。
- **方案比较**：DeepSeek V4.1 Flash 的独立诊断（`.ci-output/handoff/2026-10-22-l4-s19-diagnosis-oc-stop.md`）给出同一条链条，建议启动恢复把这类原因改写成 `SANDBOX_PREVIOUS_BOOT_UNKNOWN`，或让任务环境的 `bound` 记录复用预约阶段的整组可重试原因；采用它的诊断，修法改为在做排期决定的地方承认中断原因，原因记录保持真实，范围只到已证实的中断原因。

<a id="resident-prewarm"></a>

## 2026-10-25 补充：Run 开始时预热常驻会话，审批前后复用同一环境

2026-10-24 真实使用复盘第 2 项（[BL-20261024-006](https://github.com/sixianli/himawari-agent/blob/7d0ffcd52cbb69d4941871cf9bf08d93f3843da8/docs/backlog/BL-20261024-006-first-tool-call-cold-start.md)）：Hermes 上连跑 10 个新 Run，第一次工具调用中位数 3.3 秒，其中约 3.07 秒是新开常驻会话；同一 Run 里后面的调用也常常重新建环境，每次又是约 3 秒。所有者 2026-10-25 在计时报告里选定：不改安全设计，Run 开始就预热（方案 1），缩短沙箱里 Node 程序的启动（方案 3，runner 打包，已在上一次提交完成），并修好同一 Run 内的复用。本段只记录方案 1 和复用修复，不改动[决定](#decision)。

- **同一 Run 重新认领租约不再换环境**：Run 等待审批时释放执行租约，审批后重新认领，新租约的编号（`executionLeaseId`）和修订号（`expectedLeaseRevision`）都会变。原来复用键包含整份租约，于是每次审批后键都变，旧环境按“revocation”停掉、新环境重新冷启动，这就是同一 Run 里“也常常重新建环境”的原因。现在复用键里的执行权限只取不随重新认领变化的部分：权威租约编号和围栏令牌、部署编号、权威代次、围栏令牌和消费者编号（`apps/agent-service/src/production-task-environments.ts` 的 `srtEnvironmentPolicyDigest`）。这些任何一项变了（例如 Agent 换代或失去权威），仍先停旧环境再建新环境；授权的编号、版本、操作、根目录、授权记录和期限，允许域名，线程，模型，运行时、runner 摘要和资格记录也照旧在键里。每次调用仍按当前租约做完整的准入和授权检查，复用的只是沙箱进程，不是授权。
- **Run 开始时预热**（2026-10-26 起由 [ADR 0085](0085-remove-per-turn-system-gaps.md#decision) 取代，不再每轮预热）：Agent 每次派发 Run（包括审批后的续跑）时，在调用模型之前、不等待结果地发起一次预热（`apps/agent-service/src/production-run-composition.ts` 调用 `production-sandbox-services.ts` 的 `prewarmEnvironment`）。只在下面几条都成立时才预热：配置了编码路由；Linux 上启用了 SRT 常驻环境；Run 有执行期限；路由启用的工具里有前台、无网络、目标来自授权（`grant_targets`）、走 SRT 的 `bash` 或合同版本 1 的 `write`/`edit`；路由指定的目录授权存在、属于本机、未撤销、未过期，且包含这个工具声明的目录操作。预热用和真实调用相同的输入算复用键（授权取路由的授权，允许域名为空，环境期限取 Run 期限和授权期限中较早的一个）。这个 Run 还没有环境时，预热获取本轮主环境；已有一个就绪、未到期、复用键相同的环境时，直接用它；其他情况（环境已停止或已释放、复用键变了、已到期）预热什么都不做，换环境仍留给真实调用按原规则处理，预热从不停止或替换已有环境。拿到环境后给 Worker 发新的环境操作 `prewarm`。
- **Worker 预热的会话与真实调用一致**：Worker 收到 `prewarm` 后按安装绑定先启动命令会话、再启动文件写入会话，两个会话都启动完（或失败）才答复“已接受”（`apps/execution-worker/src/production-sandbox-execution-v2.ts` 的 `prewarmSrtEnvironment`）。会话请求由真实调用共用的同一段代码生成：作业编号、私有目录、可写与否（按工具声明的目录操作）、只读工具链、受保护路径（命令会话另外保护 `.himawari-recovery`）、允许域名（空）、runner 参数都相同，所以真实调用到达时策略摘要一致，直接用已经就绪的会话；不一致时按既有规则以 `SRT_POLICY_CHANGED` 停掉环境，不会带着不同策略继续。网络工具（`grant_targets` 网络）、后台和服务模式、其他后端不预热。预热只启动空闲的 runner，不执行任何模型或用户给出的命令；会话的沙箱范围就是这个工具调用本来会得到的范围。
- **真实调用先等预热结束**：同一个 Run 的预热还没结束时，真实调用获取环境前先等它，最多等 10 秒（`PREWARM_WAIT_MS`），再按原规则获取环境。这样预热失败时，真实调用看到的是已标记失败的环境，按原规则停掉它、换一个新环境，而不是排在失败的会话启动后面一起失败。
- **失败不影响 Run**：预热的每一步失败都只写诊断，不改变 Run：Agent 写 `sandbox.srt_prewarm.requested` 或 `sandbox.srt_prewarm.failed`，Worker 写 `sandbox.srt_prewarm.finished`（列出启动了哪些会话）或 `sandbox.srt_prewarm.failed`（带原因码）。会话没启动成功时，环境按既有规则记为失败，下一次真实调用获取环境时检查发现不能复用，停掉旧环境、新建环境，退回原来的冷启动。Run 结束时预热出的环境和其他任务环境一样由 `stopRun` 停止和释放。审批后续跑时的预热，复用键不变，环境和会话都已存在，Worker 不再启动新会话。服务重启后续跑的 Run，Agent 的权威代次变了，复用键随之变化，预热不做任何事，原来的结果恢复流程不受影响。
- **代价**：启用编码路由的每个 Run 都会多启动最多两个空闲 runner，即使这一轮没有用工具；它们在 Run 结束时停止。环境一建立就登记工作区租约（`execution_environment_leases`），所以工作区从 Run 开始就归这个 Run，而不是从第一次工具调用开始：两个 Run 同时进行时，另一个 Run 对同一目录的调用要排队到这个 Run 结束，即使这个 Run 一直没有用工具。原来只要两个 Run 都用了工具，也是同样的排队，预热把这段时间提前到了 Run 开始。工作区已被别的 Run 占用时，预热在获取环境这一步就被拒绝，只记一条预热失败，不排队、不占用。部署时 Agent 和 Worker 必须一起更新：旧 Worker 不认识 `prewarm`，会以请求无效拒绝，Agent 只记一条预热失败。
- **验证**：单元测试覆盖复用键（重新认领租约不变；权威代次、权威租约、围栏令牌、部署、授权版本、授权期限变化都会换环境）和 Worker 预热（会话请求与真实调用一致、不该预热的工具不预热、失败只记日志、未知根目录和其他后端被拒绝）。真实 SRT 的集成测试 `[R2-P2] prewarms the resident runner at Run start so the first bash call reuses it, and never replaces an existing environment` 断言预热后第一次 bash 只启动过一个会话、常驻 runner 是同一个进程、环境未轮换，续跑时再次预热不启动新会话，复用键变了的预热不建新环境，并打印第一次调用耗时；它只在装有运行时的 Linux 上运行（Hermes 第 3–4 层）。

- **第一次 Hermes 结果与修正**：第一版（提交 0da0b596）在 Hermes 第 0–3 层通过。第 4 层的计时：前 10 个新 Run 的第一次工具调用中位数 470.5 毫秒、最大 708 毫秒，上一版是 3298 毫秒和 3466 毫秒；全部 102 个 Run 的中位数 313.5 毫秒。但第 4 层浏览器路径有 14 个用例失败，原因有三。第一，服务重启后续跑的 Run 也会预热，第一版对复用键已变的旧环境照常获取，按“failure”停掉旧环境、新建一个，测试数到这个 Run 有两个环境（9 个 Run 发生过这种换代）。第二，预热同时启动命令会话和文件写入会话，按“一个 Run 只有一个常驻 runner”写的断言数到两个；重启探针 `[R2-L6]` 也按所有会话数常驻进程，数到 2 后报“原 Run 被重放”。第三，故障注入用例 `[prod-sandbox-D3]` 注入的准备失败落在了预热的会话上，真实调用随后换环境成功执行，页面上没有出现预期的“工具未启动”。修正：预热不再替换已有环境（见上文“Run 开始时预热”），真实调用先等预热结束；浏览器测试的断言和 `[R2-L6]` 探针都改为只数命令会话的 runner；D3 在 Linux 上注入两次准备失败，第一次落在预热上，第二次落在真实调用上，验证的仍是真实调用的准备失败。

<a id="parallel-session-start"></a>

## 2026-10-26 补充：两个常驻会话同时启动，等待就绪时不占环境锁

2026-10-25 生产上一次“查新闻”请求用了 48.2 秒，排查时看生产日志：每次 Run 开始的预热约 10.5 秒，因为 Worker 先启动命令会话（约 5 秒），等它完全就绪后才启动文件写入会话（约 3.5 秒）。原因有两层：预热循环一个接一个地启动两个会话；Worker 的常驻后端（`apps/execution-worker/src/production-srt-task-environment-backend.ts`）给每个环境加了一把锁（同一时刻只允许一个操作读写这个环境的记录），启动会话时从写记录一直到会话报告“准备好了”（`session.ready`）都拿着这把锁。所以即使改成同时启动，第二个会话也要排在第一个后面；真实的 `bash` 调用如果在预热期间到达，也要等文件写入会话启动完。

Andy 2026-10-26 的要求（原话）：

> 沙箱的开启策略和复用策略必须重新设计，现在太慢了

他在方案文档里同意了按对话复用沙箱的整体方案，本段只记录其中不改数据库的第一步，按对话复用和去掉每轮预热另行记录。

- **等待就绪时不拿锁**：启动会话时，写会话记录、启动宿主进程、记下进程号和启动时间这几步仍在锁里做，和原来一样；之后释放锁，再等会话报告“准备好了”。就绪后重新拿锁，确认环境没有被停止、没有标记失败、这个会话仍是当前会话，再记下常驻 `bwrap` 的进程号和启动时间。环境在等待期间被停止或标记失败时，这次启动答 `SRT_ENVIRONMENT_UNAVAILABLE`，不把会话交出去。就绪失败时照旧关掉会话、把环境记为 `SRT_SESSION_START_FAILED`，并原样抛出宿主的诊断。
- **同一种会话只启动一次**：一种会话（命令会话或文件写入会话）正在启动时，另一个要用它的调用（例如预热还没结束时到达的真实调用）不再启动第二个，而是等这次启动结束，再按原规则重新检查：启动成功就拿到同一个会话；失败时环境已记为失败，按原规则答“环境不可用”。
- **预热同时启动两个会话**：Worker 预热时同时发起命令会话和文件写入会话的启动，两个都结束（或其中一个失败）后再答复；`sandbox.srt_prewarm.finished` 里的会话顺序不变。
- **不变的部分**：停止、停止证明、会话记录的格式、复用键、预热条件、“预热从不替换已有环境”和真实调用最多等预热 10 秒的规则都不变。停止仍在锁里做；它在会话等待就绪期间也能执行，会关掉正在启动的会话。
- **预期效果**：生产预热从约 10.5 秒降到约两个会话中较慢的一个（约 5 秒，机器有 4 个 CPU）；预热期间到达的 `bash` 调用不再等文件写入会话。实际耗时在上线后按 `sandbox.srt_session.timing` 和 `sandbox.srt_prewarm.finished` 日志实测。
- **验证**：单元测试 `[NL-10]` 覆盖：命令会话还在等就绪时文件写入会话能启动完；同一种会话并发获取只启动一个宿主进程并拿到同一个会话；就绪失败时环境记为失败、等待的调用都失败；等待就绪期间环境被停止时不交出会话；预热同时发起两个会话的启动。

<a id="references"></a>

## 关联文档

- [ADR 0031：分离控制平面与任务级隔离工具执行环境](0031-isolated-tool-execution.md)
- [ADR 0032：原目录、磁盘和敏感文件限制](0032-original-directory-disk-and-sensitive-file-limits.md)
- [ADR 0033：默认用进程级沙箱执行工具，容器改为可选的严格模式](0033-process-sandbox-default-and-optional-containers.md)
- [ADR 0053：授权工作目录内的操作默认不需要批准](0053-workspace-auto-approval-like-codex.md)
