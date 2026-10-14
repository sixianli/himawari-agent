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
- **授权与记录**：授权仍在 `ALLOW` 之后才打开文件，使用与授权时相同的 Grant `id`、`revision`、`canonicalRootId`、`hostId`；主进程路径不签发 Worker Handle、不写沙箱准备记录，结果按同一 intent 保存，工具耗时由主进程自己写 `startedAt` 和 `endedAt`。

<a id="references"></a>

## 关联文档

- [ADR 0031：分离控制平面与任务级隔离工具执行环境](0031-isolated-tool-execution.md)
- [ADR 0032：原目录、磁盘和敏感文件限制](0032-original-directory-disk-and-sensitive-file-limits.md)
- [ADR 0033：默认用进程级沙箱执行工具，容器改为可选的严格模式](0033-process-sandbox-default-and-optional-containers.md)
- [ADR 0053：授权工作目录内的操作默认不需要批准](0053-workspace-auto-approval-like-codex.md)
