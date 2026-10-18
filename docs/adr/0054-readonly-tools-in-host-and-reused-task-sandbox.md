---
status: active
document_type: adr
decision_status: accepted
supersedes: ""
superseded_by: ""
amends: "docs/adr/0031-isolated-tool-execution.md, docs/adr/0033-process-sandbox-default-and-optional-containers.md"
date: "2026-10-13"
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

条目 R2-T14（用户 G109 第 6 项）落实了[上一段补充](#model-output-limit)留给 [BL-20261015-001](../backlog/BL-20261015-001-bash-非-零-退-出-时-把-输.md) 的部分，不改动上面的决定、上限或结束命令的门槛。完整规则写在 [SRT 统一执行设计的“输出、资源与可观察性”一节](../execution/specs/2026-09-07-srt-unified-execution-design.md#8-输出资源与可观察性)，实现位置见同一文档的 [R5 实现说明](../execution/specs/2026-09-07-srt-unified-execution-design.md#r5-实现说明2026-09-09)。

- 前台 `bash` 以非零状态结束、超时，或输出超过命令输出上限（`maxOutputBytes × 64`）被结束时，模型看到 Pi 保留的输出结尾和一句结束说明。超时在 `packages/runtime-pi/src/governed-host-operations.ts` 换成 Pi 认识的 `timeout:<秒>`，由 Pi 自己写“Command timed out after N seconds”；同一处也把取消换成 Pi 认识的 `aborted`，但前台 runner 目前不把取消信号传给 Pi，产品路径上走不到这一步；授权到期改用单独的 `PI_COMMAND_GRANT_EXPIRED`，不再被说成超时。超过命令输出上限时 Pi 原样抛出错误、不写说明，`packages/runtime-pi/src/sandboxed-coding-executor.ts` 取 Pi 抛错前最后一次 `onUpdate` 给出的结尾，后面由产品加一句说明命令因输出过多被结束。
- 这些结果照常经过机器秘密扫描和 `maxOutputBytes` 截断。前台 `bash` 的结果命中机器秘密时不再整次失败，而是交出一份不含正文、不含命令参数的结果，只说明输出因含疑似密钥未交出，并保留命令真实的退出码；`write`/`edit` 见下面关于合同版本 1 的一条；其他工具命中仍整次失败。
- 私钥片段也算命中（2026-10-17，用户 G127）。共用规则 `scanMachineSecrets` 只认从开头行（`-----BEGIN … PRIVATE KEY-----`）到结尾行完整的一段私钥；Pi 只保留输出结尾时会丢掉开头行，命令本身也可能只打印一部分（例如 `head -5`），剩下的结尾行或开头行加正文就看不出来。把工具输出交给模型的五处改用 `containsToolOutputSecret`（`packages/application/src/services/machine-secret-exclusion.ts`）检查工具产生的那部分输出：原规则命中，或者出现任何一行私钥开头行或结尾行，都算命中。五处是前台结果的 `content` 和 `details`（`pi-host-publication.ts`）、完整输出文件（`pi-output-export.ts`）、后台输出流（`pi-coding-main.ts`）、主机 `read`/`ls`/`find`/`grep` 结果的 `content` 和 `details`（`production-host-read.ts`；主机 `grep` 读文件时不整份扫描，带上下文行就能只露出开头行加几行正文），以及 `write`/`edit` 准备阶段生成的预备结果（`production-file-preparation.ts`；`edit` 的差异片段带上下文行，同样可能只露出开头行加几行正文）。整个结果信封，包括模型自己给的参数（命令原文、搜索词、写入内容），仍只用原规则检查：参数是模型写出来的，原样回给它不会多泄露什么，按新规则查参数反而会让“搜一搜仓库里有没有私钥”这类命令被拦。合同版本 3 在准备阶段先查，是因为它的发布阶段先把文件写进去才整理结果，到发布阶段才拦就会出现“文件已改、模型却收到失败”。生产用的合同版本 1 没有准备阶段，见下面关于合同版本 1 的一条。完整输出文件命中时，`bash` 同样交出上面的提醒，不再让 runner 以 `PI_RUNNER_EXECUTION_FAILED` 整次失败。
- 合同版本 1（`pi-coding-tool/1`，生产绑定的版本）的 `write`/`edit`（2026-10-17，G127 范围内）：Pi 在沙箱里直接改文件，改完才整理结果。结果命中私钥片段或机器秘密时不再整次失败，而是交出一份不含正文和 `details`、保留调用参数和写入证明的结果，只放一句固定说明：文件已修改并通过核实、文件没有被修改，或文件可能已被修改。调用参数要保留，因为主机按参数核对写入证明；参数本身含机器秘密（例如写入内容里有一段完整私钥）时仍整次失败，参数里的秘密留在对话中这一半仍记在 [BL-20261017-001](../backlog/BL-20261017-001-写-入-内-容-含-完-整-私.md)。同一次还查明：版本 1 的 `write`/`edit` 只要失败（包括最常见的 `edit` 原文找不到），效果就停在“未知”，结果不交给模型，恢复流程拿同一条模型输出反复重放到运行截止时间；第四次上线的版本也是这样。现在 runner 用约束文件平台的 `onCommitStarting` 回调记下有没有开始改目标文件，还没开始就在结果里写 `writeNotStarted: true`（它只说明目标文件没被改，新建文件时缺失的父目录在回调前已建好，失败后可能留下空目录）；Worker 和 Agent 核对它属于本次调用后记原因码 `FILE_WRITE_NOT_STARTED`，把 Pi 的原始错误交给模型。不能证明没改的失败记 `SANDBOX_WRITE_EFFECT_UNVERIFIED`，和工具超过期限一样按有界失败处理（[ADR 0035](0035-tool-deadline-continues-run.md)）：效果仍是未知，模型收到一次固定说明，不重放。比较过三种做法：写入前拒绝含私钥标记的内容（会让已批准的“写一份讲解 PEM 格式的文档”场景失败，没有采用）；主机重新读目标文件、和执行前的版本比较（版本 1 的执行范围里没有执行前的文件版本，做不到）；由 runner 报告“还没开始改”（采用；和现有的写入证明一样，是 runner 给证据、主机核对它属于本次调用）。细节见 [SRT 统一执行设计的 R5 实现说明](../execution/specs/2026-09-07-srt-unified-execution-design.md#r5-实现说明2026-09-09)。
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
- **什么时候换新环境**：Agent 为每轮算一个复用键（同一授权、同一租约、同一模型和运行时摘要等，完整列表见[隔离工具执行设计的“SRT 常驻任务宿主的现状”](../execution/specs/2026-09-24-isolated-tool-execution-design.md#srt-resident-job-host)），键变了或环境期限到了就先停旧环境再建新环境；授权撤销和到期都走这一条。Worker 重启后不复用旧环境：环境记录里带着 Worker 本次启动的实例号，新实例按记录的进程号和启动时间确认旧进程都已消失后，给出释放证明。
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

<a id="references"></a>

## 关联文档

- [ADR 0031：分离控制平面与任务级隔离工具执行环境](0031-isolated-tool-execution.md)
- [ADR 0032：原目录、磁盘和敏感文件限制](0032-original-directory-disk-and-sensitive-file-limits.md)
- [ADR 0033：默认用进程级沙箱执行工具，容器改为可选的严格模式](0033-process-sandbox-default-and-optional-containers.md)
- [ADR 0053：授权工作目录内的操作默认不需要批准](0053-workspace-auto-approval-like-codex.md)
