你是独立的方案审核者。
你能用的工具：read、grep、glob、websearch、webfetch，以及 git diff、git log、git show、git blame、git status 这几条 git 命令。不能修改任何文件，不能运行别的命令。可以用 websearch 搜索、用 webfetch 读网页；业界做法只认一手来源（官方文档、各大 AI 公司的工程文章、成熟开源项目的源码），每条都附网址。
下面是一份还没动手实施的方案。逐条对照代码和一手来源核对：有没有漏掉的场景、判断错的地方、和业界成熟做法不一致的地方。方案作者的说法可能有错。
做法：先想清楚要回答哪几个问题、需要看哪些文件或资料，再直接去读这些地方；不要漫无目的地浏览代码，也不要用相同或相近的参数反复调用工具。读到的内容一旦足以下结论，就停止调用工具，写出结论；没读到的地方标「未核实」，不要为了查全而一直查下去。
列出的方案只是参考，请从问题本身出发，提出你认为更好的方案。
必答问题：
1. 这个改动会不会改变模型已经见过的请求开头？包括系统提示、工具定义、历史消息、遮盖结果。要求回答：发给模型的内容是不是仍然只在末尾追加，每轮会变的值是不是都在最后一条消息里。依据：[发给模型的内容只追加](../../.claude/rules/prompt-prefix.md#rules)。
2. 这个改动会不会让同一段文字在不同请求里变成不同的字节（例如依赖前后文的遮盖、带时间的字段、无序的集合）？
3. 改动有没有对应的自动检查，反向用例是否真的会失败？
4. 改动产生或修改的每个值（标识、字段、配置键、清单项、序列化格式），每一个使用它的地方都能接受吗？逐个找到产生它的地方和使用它的地方，核对两端的校验，只看改动本身不够。依据：[I-73](../../docs/incidents-and-gates.md#incidents)，双模型复核只看了改动，没问“清单里的 id 能通过后端校验吗”。
你的额外侧重：测试有没有覆盖这次改动、文档和规则与代码是否一致；挑一条最普通的使用流程，从入口走到结束，标出经过的、没有测试覆盖的代码路径。有时另有一个复核者侧重别的方面，有时只有你一个，所以你都要回答全部必答问题、报告你发现的任何问题；侧重只决定你先查什么。在结论之前单独写一节「侧重检查」，列出你走过的流程和结论。
输出格式：按严重度从高到低排列，每条写：严重度、问题、证据（文件:行引用的代码，或网址和原话）、你建议怎么改。把「证实的」和「推测」分开写。最后写：如果由你来定，你会怎样改这份方案，并逐条回答必答问题。用简体中文。

---- 本次材料 ----
仓库就是当前目录，已检出 2997b499a8b26037ff7545cfd5aefaee3b4e7be7。
待审核的方案：
# 多人 2：每人专属执行账号和硬上限——整合方案（v2）

> 只出方案，没有改代码。线程自己的独立方案 `plan-thread.md`；DeepSeek 和 GLM 各自独立出的方案在仓库 `.agents/reviews/topic-multi-user-exec/round-1/`（费用 0.154 美元）。三份在最核心的做法上一致，下面标明采纳和分歧。

## 阅读导航

- [前提和来源](#premises)
- [方案](#plan)
- [三方比较](#compare)
- [要 Andy 拍板的事](#decisions)
- [上线前必须在测试机实测的清单](#measure)
- [要块 1 和块 4 对齐的接口](#interfaces)

<a id="premises"></a>
## 前提和来源

| # | 前提 | 来源 | 原话 |
|---|---|---|---|
| A1 | 主服务账号无特权 | `scripts/delivery-mode/packet-template/systemd/himawari-prod.service.draft` | `User=himawari-prod`、`NoNewPrivileges=yes`、`CapabilityBoundingSet=` |
| A2 | 单元没有资源上限 | 同上 | 没有 `MemoryMax`、`CPUQuota`、`TasksMax` |
| A3 | 命令的 job-host 由 Worker 用 `fork` 起，只有三处入口 | `packages/runtime-sandbox/src/job-host-messages.ts:17`；`job-host.ts:93`；`job-host-session.ts:86` | `export function forkJobHost(request: JobHostRequest): ChildProcess` |
| A4 | Worker 杀进程组，跨账号会被拒且错误被吞掉 | `packages/runtime-sandbox/src/job-host.ts:130-135` | `process.kill(-pid, "SIGKILL")` 外面是 `catch {}` |
| A5 | 命令要用的密钥由 Worker 每次拼进标准输入 | `apps/execution-worker/src/program-secret-injection.ts:50-53` | `return Buffer.from(JSON.stringify({ ...rest, secrets: values }))` |
| A6 | 控制目录要求所有者等于当前账号，且 job-host 在里面开 `control.sock` | `packages/runtime-sandbox/src/job-host-control.ts:70-90` | `metadata.uid !== process.getuid()` |
| A7 | 每个任务的私有根不能超过 27 字节（SRT 套接字路径预算） | `docs/backlog/BL-20261002-002-*.md:31` | “所以 `privateRoot` 不能超过 **27 字节**” |
| A8 | 出口代理在 job-host 里监听本机 TCP | `packages/runtime-sandbox/src/network-egress.ts:35,184` | `host: "127.0.0.1"` |
| A9 | 沙箱 `--unshare-net`，正常路径本来连不到宿主回环 | `packages/runtime-sandbox/src/bwrap-read-only-tmpfs.ts:12` | `"--unshare-net"` |
| A10 | 按 uid 封本机端口、`nft -c` 校验、失败回滚的现成先例 | `scripts/operations/ci-runner/runners.sh:54-67` | `meta skuid { $1 } fib daddr type local tcp dport { $2 } reject` |
| A11 | “所有者必须是当前账号”类检查共 51 处（23 个文件，未逐处读） | `grep -rn "getuid\|\.uid" apps/*/src packages/*/src` | — |
| A12 | 运行手册承认只有采样 | `docs/runbooks/install-start-stop-runbook.md:263` | “采样不能证明硬配额” |
| A13 | 生产机规格；AppArmor 限制用户命名空间 | `docs/adr/0145-*.md:41`；`.agents/instructions/test-and-production-hosts.md:20` | “4 个 CPU、约 8 GB 内存”；“带有 AppArmor 对用户命名空间的限制” |
| A14 | Magpie 本机不查 key | `docs/adr/0117-*.md:114` | “Magpie 只监听本机时不检查访问密钥” |
| A15 | 主服务有 `NoNewPrivileges`，sudo/setuid 小帮手被内核挡死 | https://docs.kernel.org/userspace-api/no_new_privs.html | “the setuid and setgid bits will no longer change the uid or gid”（GLM 引用，我没逐字核对） |
| A16 | systemd 的 socket 激活、`MemoryMax` 在单元内触发 OOM、`NFTSet=` | https://www.freedesktop.org/software/systemd/man/latest/systemd.resource-control.html | “out-of-memory killer is invoked inside the unit”（DeepSeek 引用，我没逐字核对） |

未核实（方案不从它们出发推理，列在[实测清单](#measure)）：新账号下 bwrap 能不能用；`/proc` 是否 hidepid；文件系统是否支持目录配额；socket 激活的启动延迟；一个人那份的内存基线。

## 对标和根因

1. claude.ai 用 gVisor，每个会话一个沙箱，不是“每人一个 Linux 用户”；JupyterHub 由启动器给每个用户起独立账号或容器并限资源。我们单机单账号，取同类中最轻的一档。
2. 根因：现在命令和数据库、密钥是同一个 uid（A3），沙箱逃逸后拿到的就是主服务账号。换账号改的是“逃逸后能拿到什么”，不是加一层补丁。

<a id="plan"></a>
## 方案

1. **换账号交给 systemd**。每人一个账号 `hx-<slot>`，一个 socket 单元 + 一个服务单元（`Accept=no`，一个人一个网关进程，空闲退出）。主服务只连套接字，不提权（A15）。网关是新的小程序：收 Worker 的 `JobHostRequest`，在自己账号下调用现有 `forkJobHost`，把 job-host.v2 消息转发回套接字。`forkJobHost` 抽成接口：本机 fork（开发、Mac、测试）和远端网关（生产）。
2. **取消和清理**：Worker 发 `cancel`，网关在同账号下杀进程组（A4 的跨账号问题消失）；Worker 断开网关就杀光自己的子进程；网关崩溃由 `KillMode=control-group` 清光整个 cgroup。不引入 polkit。
3. **目录和权限（不依赖 ACL）**：
   - 系统组 `himawari-people`，只有主服务账号是成员；执行账号都不是成员。
   - 每人目录 `<根>/<slot>/`，属主 `hx-<slot>`、组 `himawari-people`、2770，里面 `work/`（工作区）和 `private/`（任务私有）。主服务靠组访问，其他执行账号既非属主也不在组里。数据库和密钥留在 0700 的主服务目录，执行账号进不去。
   - 根路径要满足 A7（私有根 ≤27 字节），所以 slot 用 6 位，私有根形如 `/var/lib/himawari/j/<slot>`。
   - 控制目录和证据文件（A6）：执行账号建、网关内部使用，Worker 经套接字拿证据字节，不再进别人账号的目录。
   - 51 处所有者检查（A11）逐处读，按“路径类别”放宽到“主服务、root，或这个人的执行账号”，数据库和密钥路径不放宽。
4. **硬上限（与 ADR 0234 第 4、8 条对齐）**：每人一个 slice，`MemoryMax`、`MemoryHigh`、`MemorySwapMax=0`、`CPUQuota`、`TasksMax`、`LimitNOFILE`，另设所有人合计的父 slice，主服务设内存保底。数值只出现在 root 所有的 `/etc/himawari/exec.json`（默认加按人覆盖），缺项时开通工具拒绝；代码和模板里没有数字，有自动检查。**磁盘也是硬上限**（ADR 0234 第 4 条：做不到就不给别人开通）：开通工具按顺序选用文件系统的 project quota（ext4/xfs，需要挂载选项）；不支持就给这个人建一个固定大小的稀疏磁盘镜像（ext4，回环挂载在他的目录上），大小就是上限；两种都做不到，工具拒绝开通非 Andy 的账号。所有在用账号的磁盘上限之和必须小于可用磁盘并留余量，开通时检查。
   **上限在管理页配置**（ADR 0234 第 8 条精神，coordinator 转述 Andy 的要求）：名册里存每人的上限（内存、CPU、进程数、磁盘），Andy 在管理页改。主服务把变更写成一个请求文件；一个 root 的小应用器（systemd path 单元触发）读它，**只做三件事**：校验、写该人的 drop-in、`systemctl set-property`（磁盘变大时扩镜像或改项目配额）。校验：slot 必须是已开通的、数值必须在 root 所有的 `/etc/himawari/exec-ceilings.json` 给出的上下限内（上下限由 Andy 在服务器上定，主服务改不了）。这是新增的一条提权通道，边界就是这个校验。降低到当前用量以下会当场杀进程，管理页要先提示。命令行 `apply` 保留作为同一应用器的手动入口。
5. **网络**：独立的 nft 表，对所有执行账号 uid 拒绝私网段和云元数据地址，拒绝连本机的 Magpie 端口和主服务端口（端口来自配置）。出口代理在本机随机端口（A8），所以不能整段封回环；正常命令在 `--unshare-net` 里（A9），这层只管逃逸后的情形。方法复用 A10。
6. **开通工具**（root，Andy 或部署时运行，`add`/`apply`/`remove`/`status`）：校验配置 → 备份 → `useradd`（无登录、无附加组）→ 建目录 → 渲染并 `systemd-analyze verify` 单元 → `daemon-reload` → 启用 socket → 生成 nft 并 `nft -c` → 读回 → 失败按备份回滚。每步可重试。结构学 `scripts/operations/ci-runner/`。
7. **失败时拒绝，不退回同账号**：账号、socket、配置缺项都让该人的命令执行失败（用户看到“命令执行暂时不可用”），聊天照常。生产配置里 `execution.accounts.mode` 只能是 `per-person`，开发/测试才允许 `same-user`，有检查。
8. **Andy 自己也用专属账号**，二十个人里没有特例。
9. **不改发给模型的内容**：错误文案走固定文字，只出现在工具结果末尾；`npm run check:prompt-prefix` 不受影响。

### 测试
- 纯测试（CI 普通账号能跑）：开通计划的生成、配置缺项拒绝、仓库里不出现写死的额度数字（反向：加一个数字，检查必须失败）、nft 规则里的端口等于配置、`forkJobHost` 抽象的协议用例。
- 真实账号测试（开发容器有 root 能跑，普通 CI 跳过）：建两个账号，A 读 B 的工作区、读数据库路径、用 A 的账号直接起进程去读，全部被拒；主服务账号能读写 A 的工作区；反向：把 B 的目录放宽，测试必须失败。
- 必须在测试机跑、容器里测不了：socket 激活、cgroup 是否真限住、nft 真生效、bwrap 在新账号下能否运行。这几项没跑之前，不说“隔离已验证”。

<a id="compare"></a>
## 三方比较

| 项 | 线程 | DeepSeek | GLM | 取舍 |
|---|---|---|---|---|
| 换账号方式 | socket 激活每人网关 | 同，`Accept=yes` 每连接一个实例 | 同，`Accept=no` | 采纳；用 `Accept=no`，一个人一个网关，避免每次起 Node 和 SRT 初始化 |
| 目录权限 | 属主执行账号、组 `himawari-people` | 属主主服务、组本人 + ACL | 属主执行账号 + default ACL | 采纳组方案：不依赖 ACL（文件系统是否支持未核实），而且新人不需要重启主服务；缺点同样是本人 `chmod 0600` 会把主服务锁在外面，主服务报“不可读”，不提权 |
| 私有根 27 字节 | 漏了 | 发现 | 没提 | 采纳 DeepSeek，slot 取 6 位 |
| 控制目录跨账号 | 漏了 | 提到要改所有者检查 | 提出证据走套接字 | 采纳 GLM：控制目录由网关内部处理，证据经套接字传 |
| 取消兜底 | 网关自杀 + cgroup | 同，加 watchdog | 加窄 polkit | 不要 polkit，扩大提权面；先用 cgroup 兜底 |
| nft | 拒绝本机特定端口 | 只放行代理端口 | 整段封回环 | 两个模型的写法都假设代理端口固定，但代理是随机端口（A8），所以采用“封已知端口 + 私网”，不整段封回环 |
| NFTSet 自动灌 uid | 没想到 | 提 | 提 | 先由开通工具显式生成，读回对比；systemd 版本核实后再考虑 |
| 磁盘硬配额 | 实测后定 | 提拍板 | 先软限制 | ADR 0234 第 4 条要求硬上限：project quota，不行就固定大小镜像，都不行不开通 |
| gVisor、容器、每人一台虚拟机 | 独立实测 | 不选 | 不选 | 同，不进这一步 |

<a id="decisions"></a>
## 要 Andy 拍板的事

1. **磁盘硬上限**（ADR 0234 要求）：先看测试机文件系统支不支持 project quota，不支持就用“每人一个固定大小的磁盘镜像”。没有决策点，除非镜像方案的挂载数量不可接受。
2. **管理页改上限、root 小应用器校验后应用**（新增一条受限提权通道，上下限由 Andy 在服务器上定）。建议同意。
3. **Andy 自己的命令也迁到专属账号**（一次性）。建议同意。

<a id="measure"></a>
## 上线前必须在测试机实测的清单

1. 新账号下现有沙箱（bwrap + AppArmor）能不能跑，在生产同版本系统上。
2. cgroup 限额真的把 OOM、进程数限在这个人自己的 cgroup，不波及主服务和别人。
3. 取消、崩溃后，systemd 把该人的 cgroup 清干净。
4. A 读 B 的目录和数据库被拒；A 连 Magpie 被拒。
5. `/proc` 是否 hidepid（影响进程身份核验）；socket 激活的启动延迟；一个人常驻内存基线（定默认值和“最多几个人”）。

<a id="interfaces"></a>
## 要块 1 和块 4 对齐的接口

1. 块 1：名册里每个人有 6 位 `slot`；块 2 用它派生账号名、目录和套接字；Worker 的请求要带 `slot`；工作区根固定在 `<根>/<slot>/work`；迁 Andy 的数据时更新授权里的绝对路径。
2. 块 1：名册只存“执行上限档位名或覆盖值”，值本身来自 `exec.json`，块 1 不解释。
3. 块 4：执行账号连不到 Magpie 的 nft 规则由块 2 的开通工具生成，块 4 不再单独做这一条，只做程序内的按人用量。

<a id="memory"></a>
## 按生产机实测算内存（来源：`/mnt/project-files/multi-user-measure/result.md`，2026-11-11 21:09 JST）

实测：可用内存 6.4 GB，没有 swap；主进程 473 MB、执行进程 161 MB、守护进程 49 MB，一整套约 680 MB；向量模型上线后再占约 1.1 GB（还没算进实测）。

- **一个网关多大**：它是一个只转发消息的 Node 进程。守护进程也是一个 Node 进程，实测 49 MB，所以我按约 50 MB 估（这是类比，没有实测网关本身）。网关起来后每个任务还有一个 job-host（Node，加沙箱），我按 75 MB 猜（**没有实测**，要在测试机测）。
- **预算**：6.4 GB 可用 − 1.1 GB 向量模型 − 1.0 GB 留底 − 20 人在主进程里的增量约 1.0 GB（实测报告说这个增量是猜的）≈ **3.3 GB 给所有人的命令执行**。
- **20 个人都注册，放得下**：网关空闲会自己退出，不占内存，所以注册人数不受内存限制，限制的是“同时在执行命令的人数”。
- **同时在执行命令的人数**：每个正在执行的人固定开销约 125 MB（网关 + job-host）。
  - 同时 7 人：开销约 0.9 GB，剩约 2.4 GB 给命令本身，平均每人约 340 MB。
  - 同时 20 人：开销约 2.5 GB，只剩约 0.8 GB，平均每人约 40 MB，实际不可用。
  - 所以**必须有全机同时执行的人数上限**（ADR 0234 第 2 条的并发数，块 4 定数字），按这个算大约 6 到 7 个同时执行。它排队，不是拒绝。
- **怎么保证主服务不被挤死**：所有人的 slice 放在一个父 slice 下，父 slice 的 `MemoryMax` 设成上面那个 3.3 GB 量级（数值来自配置，由测量定）；单人上限之和可以大于它，因为单人上限是封顶不是预留，父 slice 才是总闸。主服务另设 `MemoryMin` 和较低的 OOM 打分。
- **网关空闲自动退出**：会。socket 激活的服务不会被 systemd 自动停，所以网关自己实现空闲计时：没有任务且超过空闲时间（配置项）就退出；套接字由 systemd 一直监听，下一个连接来了再拉起。延迟约一次 Node 启动（没测）。
- 必须在测试机补测的两个数：job-host 加沙箱的内存基线；网关本身常驻内存。
