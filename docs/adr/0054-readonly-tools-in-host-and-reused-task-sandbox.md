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

<a id="references"></a>

## 关联文档

- [ADR 0031：分离控制平面与任务级隔离工具执行环境](0031-isolated-tool-execution.md)
- [ADR 0032：原目录、磁盘和敏感文件限制](0032-original-directory-disk-and-sensitive-file-limits.md)
- [ADR 0033：默认用进程级沙箱执行工具，容器改为可选的严格模式](0033-process-sandbox-default-and-optional-containers.md)
- [ADR 0053：授权工作目录内的操作默认不需要批准](0053-workspace-auto-approval-like-codex.md)
