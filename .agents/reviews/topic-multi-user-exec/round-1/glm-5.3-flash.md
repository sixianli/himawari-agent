代码和内部文档已读得差不多了，下面补几条一手外部来源（systemd 手册、Ubuntu 官方对用户命名空间的限制说明）。
# 方案：每用户一个 socket 激活的 systemd 执行服务 + 专属 slice 限额 + 内核级回环封锁

## 〇、先说结论

不让主服务碰换账号这件事，把「换账号」整体交给 systemd（PID 1，本来就有这个特权）：每个受邀的人一个系统账号，配套一对 socket 激活的单元（`himawari-exec@<user>.socket` + `himawari-exec@<user>.service`）。Worker 不再 `fork` job-host，而是连 `/run/himawari/exec/<user>.sock`，systemd 按需把服务以该人账号拉起来，job-host 协议（job-host.v2）原样跑在这条连接上。资源硬上限放在每用户专属 slice 上（cgroup，内核强制）；主服务保持 `NoNewPrivileges`、空 capability 不动。加人 = Andy 以 root 跑一条 `himawari-add-person <名字>`（建账号、建目录、enable 一个 socket 实例、渲染限额 drop-in、灌 nft 集合），全程不重启主服务。

---

## 一、读代码证实的现状（本方案依赖的事实）

- 主服务以 `himawari-prod`（uid 999）运行，`NoNewPrivileges=yes`、`CapabilityBoundingSet=` 空、无任何 `MemoryMax/CPUQuota/TasksMax`（`scripts/delivery-mode/packet-template/systemd/himawari-prod.service.draft:9-19`）。
- 命令的实际 uid 就是 Worker 的 uid：Worker 用 `forkJobHost`（`packages/runtime-sandbox/src/job-host-messages.ts:22-36`，`child_process.fork`，`detached: true`，IPC 通道）起 job-host，job-host 再用 SRT/bwrap 包命令（`packages/runtime-sandbox/src/job-host-main.ts:558-582`）。
- 跨账号强杀今天就会静默失败：`killGroup` 里 `process.kill(-pid, "SIGKILL")` 的 `EPERM` 被 `catch {}` 吞掉（`packages/runtime-sandbox/src/job-host.ts:130-135`）。这解释了为什么「取消靠杀进程组」不能直接搬到跨账号场景。
- 取消与监督已有协议层机制：`send({ type: "cancel" })` + 心跳 250ms + 信封校验（sessionId/processId/序号/bootId/processIdentityRef，`job-host.ts:142-217`、`job-host-messages.ts:38-83`），进程身份用 `/proc/<pid>/stat` 的 start token（`packages/runtime-sandbox/src/process-identity.ts:30-41`），`processGroupPresent` 对 `EPERM` 返回 `true`（`process-identity.ts:53-63`）。
- 控制文件由 Worker 写、job-host 读，读取端要求「文件 owner 必须等于当前 uid」：`job-host-launch-decision.ts:148`、`job-host-control.ts:75`；同类 `getuid` 校验全仓 38 处（grep 结果），含 `constrained-file-system.ts:586`、`pi-file-publication.ts:55`、`pi-output-export.ts:27`、`directory-move.ts:57`、`state-root-layout.ts:113/291/424`、`production-sandbox-control.ts:311/907`、`host-secret-source.ts:126/140`。**一旦文件 owner 变成执行账号，这些检查都会拒绝。**
- 沙箱策略：`denyRead: ["/", ...protectedPaths]`，只放行工作区、私有目录、只读工具链；网络严格域名白名单；unix socket 只允许私有目录内的（`policy.ts:150-191`，`SRT_POLICY_SOCKET_INVALID` 强制 socket 路径在 privateDirectory 内）。私有目录由 Worker 建删（`production-sandbox-execution-v2.ts:1094` 附近、`production-srt-task-environment-backend.ts:289` 附近，材料核实）。密钥由 Worker 每次拼进 stdin JSON（`program-secret-injection.ts`），不落盘。
- 运行手册明确「采样不能证明硬配额、所有短命后代都被计入或整个进程树已退出」（`docs/runbooks/install-start-stop-runbook.md:263`）。
- Magpie 只监听本机且不检查访问密钥：「生产机上任何本地程序都能用 Andy 的套餐额度」（`docs/adr/0117-magpie-routes-models-through-owned-subscriptions.md:114`）。
- 生产机 4 CPU / 约 8 GB（`docs/adr/0145-...md:41`）；Ubuntu 24.04 的 AppArmor 限制非特权用户命名空间，Hermes 的结论不能代表生产机（`.agents/instructions/test-and-production-hosts.md:20`）。
- 发给模型的内容只追加、有现成阻断检查 `npm run check:prompt-prefix` 且带反向用例（`.claude/rules/prompt-prefix.md:35,74`）。
- I-73 的教训：产生方和使用方的校验要两端都核对（`docs/incidents-and-gates.md:112`：「双模型复核只看了 diff，没问『清单里的 id 能通过后端校验吗』」）。

## 二、业界一手来源（本方案用到的机制）

- **socket 激活**：`.socket` 单元 + `ListenStream=`（AF_UNIX 路径）、`SocketUser=/SocketGroup=`（指定 socket 文件属主）、`SocketMode=`、`Accept=no`（一条服务处理所有连接）（systemd.socket(5)，https://manpages.debian.org/trixie/systemd/systemd.socket.5.en.html）。
- **cgroup 硬限**：`MemoryMax=`（超限在 cgroup 内触发 OOM killer，"out-of-memory killer is invoked inside the unit"）、`MemoryHigh=`（官方建议首选，"recommended to use MemoryHigh= as the main control mechanism and use MemoryMax= as the last line of defense"）、`CPUQuota=`（"the executed processes will never get more than 20% CPU time"）、`TasksMax=`（pids 控制器）、drop-in 目录（文档原例：`/etc/systemd/system/user-1000.slice.d/*.conf` 只影响 user 1000）、`NFTSet=`（source type `"user"` 对应 nft 的 `"meta skuid"`，unit 实现时自动把 uid 灌入 nft set）（systemd.resource-control(5)，https://manpages.debian.org/trixie/systemd/systemd.resource-control.5.en.html）。
- **NoNewPrivileges 挡死 setuid/sudo**：`no_new_privs` 置位后 "the setuid and setgid bits will no longer change the uid or gid; file capabilities will not add to the permitted set"，且该位跨 fork/execve 继承（内核文档，https://docs.kernel.org/userspace-api/no_new_privs.html）。主服务已有 `NoNewPrivileges=yes`，其 fork/spawn 出的一切进程都带该位——所以 Worker 直接调 sudo/setuid 助手在内核层就被拒绝。
- **Ubuntu 24.04 用户命名空间限制**：23.10/24.04 起 "Unprivileged user namespaces … must be explicitly allowed by their AppArmor profile"（Ubuntu 官方文档 https://documentation.ubuntu.com/security/security-features/privilege-restriction/apparmor/ ；详解 https://discourse.ubuntu.com/t/understanding-apparmor-user-namespace-restriction/58007 ）；Ubuntu 的 apparmor 包随附 `bwrap-userns-restrict` profile（`d/apparmor.install - install new profiles … bwrap-userns-restrict`，https://lists.ubuntu.com/archives/noble-changes/2024-August/040973.html）。

---

## 三、方案本身

### 3.1 执行通道：每用户一个 socket 激活的执行服务

单元（随部署包发布，模板渲染）：

```
# himawari-exec@.socket
[Socket]
ListenStream=/run/himawari/exec/%i.sock
SocketUser=himawari-prod
SocketGroup=himawari-prod
SocketMode=0600
RemoveOnStop=yes
Accept=no

# himawari-exec@.service
[Service]
User=%i
Group=%i
Slice=himawari-exec-%i.slice
ExecStart=node job-host-server.mjs
NoNewPrivileges=yes
PrivateTmp=yes
KillMode=control-group
LimitNOFILE=…（来自限额配置）
```

- Worker 把 `forkJobHost` 换成 `connectJobHost(socketPath)`：连上后走**现有 job-host.v2 协议**（prepare/start/cancel/heartbeat/output/result 全部复用），信封里的 `processId` 用 job-host 子进程的 pid，对端身份用 `SO_PEERCRED` 核验（Worker 验对端 uid 是该人执行账号；执行服务验对端 uid 是 himawari-prod），比现在「fork 出来的 IPC 通道天然可信」多一步显式校验，比文件 uid 校验更强。
- 执行服务收到连接后 fork 一个 job-host 子进程（同人同 uid），`detached` + 自己成进程组，**杀子进程组现在合法**（同 uid），现有 `killGroup` 语义保留。
- 执行服务常驻由 socket 激活按需拉起（Accept=no，systemd 把监听 fd 交给它），没任务时 systemd 可在空闲后退出（`TimeoutStopSec`/手动策略），不占常驻内存。
- 加人：Andy root 跑一条 provisioning 命令：`useradd` 系统账号（nologin，uid 从配置的预留段取，如 3100 起；himawari-prod 是 999，别撞系统段）→ 建 workspace/private 根目录与 ACL → `systemctl daemon-reload` → `systemctl enable --now himawari-exec@<user>.socket` → 渲染限额 drop-in → nft 集合注册（见 3.4）。全部幂等、可重复跑。**主服务零重启。**

### 3.2 目录与文件权限

| 对象 | 属主/权限 | 访问方式 |
|---|---|---|
| state root（数据库、secrets/、作业账本） | `himawari-prod` 0700/0600，**不变** | 执行账号在 DAC 层就进不来；沙箱策略 `denyRead "/"+protectedPaths` 是第二层 |
| 每人 workspace `<root>/<user>` | owner=执行账号，**default ACL** `u:himawari-prod:rwX` + setgid 组 | 双向可读写；default ACL 使新建文件同时给双方权限（POSIX 规则：父目录有 default ACL 时 umask 不参与，见 acl(5)，https://man7.org/linux/man-pages/man5/acl.5.html——此行为列入开发容器实测项） |
| 每任务私有目录 | Worker 建（owner=himawari-prod），建时加 ACL `u:<exec-user>:rwX` + default ACL | job-host（该人 uid）写、Worker 删（Worker 是父目录 owner，unlink 不看文件 owner）；崩溃残留由 Worker 现有 unknown-作业清理路径删 |
| 日志 | journald（adm 组才可读） | 执行账号读不了别人的日志 |
| /tmp | 命令的 TMPDIR 已指私有目录（`job-host-messages.ts:31`）；执行服务再叠 `PrivateTmp=yes` | 即使逃出沙箱，拿到的 /tmp 也是 systemd 给该服务单独挂的 |

- Worker 读沙箱产物：靠 default ACL（`pi-file-publication`、`pi-output-export`、`directory-move` 等 38 处 `getuid` 检查需要从「uid 必须等于我」放宽为「uid ∈ {我, root, 该人的执行账号}，且路径在该人的工作区/私有目录授权范围内」——逐个文件过，见第六节风险 2）。
- 控制目录与 launch evidence（`job-host-launch-decision.ts:148`、`job-host-control.ts:75`）：**不落盘给执行账号读**。改为经执行 socket 传输字节（HMAC/签名校验逻辑不变），文件仍由 Worker 独占；执行端的文件 uid 校验替换为 socket 对端 uid 校验。避免把控制目录 ACL 开给 20 个账号。
- 工作区授权记录存绝对路径（`production-run-policy.ts:241-264`）——新人的 workspace 是新 grant，按人建，与「按人组装服务」线程的分工在此处对齐（接口上只要求：grant 里带 person 名，本任务负责把名字解析成账号和 socket 路径）。

### 3.3 资源硬上限（内核 cgroup，非采样）

- 每人一个 slice：`himawari-exec-<user>.slice`，drop-in `/etc/systemd/system/himawari-exec-<user>.slice.d/limits.conf`，内容由 provisioning 脚本从 **`/etc/himawari/quotas.json`**（root 拥有）渲染：
  - `MemoryHigh=`（首选节流）、`MemoryMax=`（硬顶，cgroup 内 OOM）、`OOMPolicy=kill`（OOM 只杀这个 cgroup 内的进程，不波及他人和主服务）、`CPUQuota=`、`TasksMax=`、`LimitNOFILE=`。
- 生效：脚本写 drop-in 后 `systemctl daemon-reload` + `systemctl set-property himawari-exec-<user>.slice ...`，**立即生效，不需要停服，不需要重启 Himawari**；需要 root 的一次性脚本运行（Andy 已接受自己跑 root 部署脚本）。代码与单元模板里**不出现任何具体数字**。
- Worker 不读 quotas.json：它不需要值——超限时内核直接动手。用户看到的行为：内存超限 → 命令进程被 SIGKILL，job-host 上报现有 `resource_limit`/异常退出（`JOB_HOST_RESULT_REASONS` 已含该码）；进程数超限 → spawn 报错；CPU 超限 → 只是变慢（CPUQuota 是限速不是杀进程，需在文档里写明预期）；磁盘超限 → `ENOSPC`。
- 主服务自我保护：部署包模板给 `himawari-prod.service` 加 `MemoryMin=`/`OOMScoreAdjust=-500`（上线包一并渲染，防全局 OOM 先杀主服务）。
- 磁盘：**硬配额只有文件系统项目配额（XFS/ext4 project quota）一种**，运维重；先做软限（Worker 准入时对 workspace 计量、超目录配额拒绝新任务，沿用「观察 + 准入拒绝」模式），硬配额列为拍板项（见第五节）。

### 3.4 网络：执行账号连不到 Magpie 和内部端口

- **nftables 一条规则**：`skuid @hmx-exec-users + 目的 127.0.0.0/8 → reject`。uid 集合由 systemd 自动维护：单元里写 `NFTSet=user:inet:filter:hmx-exec-users`（systemd.resource-control(5) 明文支持，source `"user"` 对应 `"meta skuid"`），加人即自动入集，脚本不手工同步防火墙。unix socket（执行 socket、内部通道）本来就有 0600 文件权限挡着，不需要防火墙。
- 沙箱内正常联网不受影响的前提：**命令到出口代理这段不能走 TCP 回环**。runbook 提到 Linux 的「SOCKS 桥」和私有目录内 socket 路径预算（`install-start-stop-runbook.md:261,263`），policy.ts 也只允许 privateDirectory 内的 unix socket——暗示 SRT 出口代理走 UDS。**若代理实际监听 TCP 回环，nft 规则会把命令→代理一起拒掉**；这是必须实测的第一批项（见风险 1）。若确为 TCP，则改法：代理 socket 移到 privateDirectory 内 UDS（各任务隔离，顺带消除跨 job 代理劫持面）。
- 治本项（超出本任务，列出供拍板）：Magpie 检查访问密钥（ADR 0117:114 已写「Himawari 仍带网关密钥，以后对外监听时照样生效」）。

### 3.5 取消、超时、崩溃清理

- 正常路径：Worker 发 `cancel`（协议已有）→ job-host（同 uid）杀任务进程组 → 上报 `taskTreeCleanup`。跨账号的 `kill(-pid)` EPERM 吞掉问题就此消失。
- 兜底：Worker 拿到一张**窄 polkit 授权**（`.conf` 规则只放行 himawari-prod 对 `himawari-exec@*.service/.socket` 及对应 slice 的 `stop/kill`），失控时 `systemctl stop himawari-exec@<user>` 由 systemd 杀光该 cgroup（KillMode=control-group）。注意 polkit 规则必须限定单元名模式，否则 Worker 等于有了全机 systemctl 权。
- 身份核验：start token 读 `/proc/<pid>/stat`——Ubuntu 默认 hidepid=0 时跨 uid 可读（**未核实**生产 /proc 挂载参数；若 hidepid=1 则此机制失效，需改为经执行 socket 由执行端自报+对端 pidfd 核验）。`pidfd_open` 跨 uid 可用，但 `pidfd_send_signal` 仍做 uid 权限检查——所以信号一律走 socket/polkit，pidfd 只用于「还活着吗」。
- 执行服务崩溃：systemd 拆整个 cgroup → 残留私有目录由 Worker 现有清理路径处理（Worker 是父目录 owner，能删）。Worker 崩溃重启：执行服务侧连接断开 → job-host 按现有心跳超时自杀。

### 3.6 测试与门槛

- **开发容器（有 root、setpriv、无 systemd）能真测的**：账号/权限矩阵。`check:account-isolation`：root 建两个测试账号，用 setpriv 以 A 账号读 B 的数据库/工作区/私目录 → 断言 EACCES；正向对照（B 读自己的、himawari-prod 读两边）保证断言非恒真；**反向用例**：夹具故意把 ACL 放宽成组外可读，断言 provisioning 的自检和测试**必须失败**。ACL/umask 行为、SO_PEERCRED 校验、evidence 走 socket、协议适配也在这里测（纯用户态）。
- **CI runner（无 root/sudo）**：以上测试用 root 守卫跳过（仓库先例：`test/tooling/shared-node-runtime.test.ts:16` 的 `asRoot`）。
- **Hermes（有 systemd）**：socket 激活、单元素额、polkit 窄规则、systemd 侧冒烟；按 `recoveryDescribe` 的 opt-in 先例挂条件执行。
- **只能生产实测**：AppArmor 约束下的 bwrap（新账号）、nft skuid 规则真效果、OOMPolicy 行为。Hermes（22.04）结论不算数（`test-and-production-hosts.md:20`）。
- 配置一致性门槛（I-73 式两端核对）：一个 contract 测试同时断言——单元模板里的 `NFTSet` 集合名 = nft 规则文件里的集合名；polkit 规则里的单元模式 = 代码里的单元名常量；socket 路径长度 ≤ 预算（先例：`job-host-control.ts:78` 的 100 字节校验）；quotas.json 缺失/非法值（0、负、超物理内存）→ provisioning 拒绝执行（fail-closed）。

### 3.7 失败与回滚

- **fail-closed，不退回同 uid**。Worker 启动及每次派发前对目标用户的 socket 做健康检查（连接 + SO_PEERCRED 验 uid）：账号不存在、socket 不在、uid 不对 → 该用户的执行工具一律拒绝（错误码如 `EXEC_ACCOUNT_UNAVAILABLE`），聊天主功能照常。绝不静默退回 himawari-prod 同 uid 执行——那等于把刚建好的隔离悄悄拆掉。
- 限额设错（如 MemoryMax 过小）：表现为该用户命令被 OOM，Worker 上报 resource_limit；Andy 用 `systemctl set-property` 即时改。不自动回退。
- 回滚旧版本代码：旧代码不知道执行账号的存在，`forkJobHost` 以 himawari-prod 跑——工作区 ACL 保留了 himawari-prod 权限，**旧代码照常能跑**；执行账号、单元、nft 集合残留无害。这条是设计约束：**所有新 ACL 都只加宽给他awari-prod，绝不收窄**。

---

## 四、考虑过但不选的做法

| 办法 | 不选原因 |
|---|---|
| sudo / setuid 小帮手（Worker 直接调） | 内核层被挡死：Worker 带 `NoNewPrivileges` 且跨 execve 继承（docs.kernel.org/no_new_privs），setuid 位不再生效。要解锁就得去掉主服务的 NNP——削弱现役硬化，得不偿失 |
| Worker + polkit + `systemd-run` 每任务建 transient 单元 | 可行，但每个任务一次 D-Bus 往返 + transient 单元创建（百毫秒级）；polkit 默认 action 面太大，要 JS 规则按单元名收窄；比 socket 激活多一层故障面，延迟也更差 |
| 每人一个常驻 worker（开机即跑） | 20 人 × Node 常驻内存，8 GB 机器吃紧；socket 激活按需起、空闲可退，零闲置成本 |
| `user@.service` + linger + `systemctl --user` | 把执行通道挂到登录会话体系：要为每人 enable-linger；用户管理器是 Delegate= 的，清理/日志/监督跨两层 systemd；系统级 socket 激活一条路走完，更简单 |
| 容器 / gVisor | 8 GB/4 CPU 单机开销大、多一套镜像与生命周期运维；SRT/bwrap 域名白名单出口代理要在新隔离层里重做；违背「不多花钱、不多机」 |
| 让主服务保留 CAP_SETUID 以便自己 setuid | 空 capability 集合是现役防线；为一个功能给主服务常驻提权，信任边界全面倒退 |

## 五、风险与反例（风险最大、最该先实测的三件事）

1. **bwrap 在新账号下是否照常工作（生产实测）**。Ubuntu 24.04 AppArmor 限制非特权 userns；今天 himawari-prod（uid 999）能跑 bwrap，说明 sysctl 或 `bwrap-userns-restrict` profile 在生产上已成立，且该机制按二进制/profile 生效、理论上与 uid 无关——但「理论上」不算数，换账号后必须真跑。反例：bwrap 报 `EPERM`/AppArmor DENIED，所有新账号命令全挂（fail-closed，聊天可用）。
2. **38 处 `getuid` 校验的适配面**。工作区/私目录文件 owner 变成执行账号后，任何一处没放宽，该用户相应功能（发布、导出、目录搬移、evidence 读取）就拒绝服务；放宽过头则是隔离漏洞。反例：`directory-move.ts:57` 把一个 alice 产生的工作区文件判为「owner 不对」→ 迁移失败。需要逐文件清单化（每个文件：路径在谁的授权范围内 → 允许的 uid 集合），并靠 3.6 的矩阵测试兜底。
3. **出口代理的监听形式 × nft 回环封锁**。若 SRT 代理监听 TCP 回环而 job-host 是 alice 的 uid，封锁规则会把命令自己的联网拒掉；若代理可被同机其他 uid 连到，则存在跨用户代理劫持。实测两件事：代理绑定形式（UDS 与否）、并发 job 的代理隔离。

次级风险：`/proc` hidepid 未知影响 start token 核验；default-ACL 与 umask 的交互；polkit 规则写宽等于交出 systemctl；nft 规则在生产重载时短暂丢放行（用 systemd NFTSet 自动维护集合可把窗口降到最小）。

## 六、需要人拍板的取舍

- **磁盘硬配额**：上 ext4/XFS project quota（root 维护、真硬）还是先用 Worker 软限 + 拒绝超量任务（推荐先软后硬）。
- **Andy 自己是否也开专属账号**：建议开（全员同构，20 人里没有特例），但意味着 Andy 现有以 himawari-prod 跑的任务要迁一次。
- **polkit 窄授权是否引入**：不给的话，兜底强杀只能靠执行端自杀 + systemd 对 socket 断开后的超时回收，失控清理能力弱一档。
- **错误文案与「每人额度」要不要出现在给模型的运行环境说明里**：本方案默认不出现在系统提示/工具定义，只在当轮末尾追加（若产品上要展示）。
- **Magpie 加访问密钥**：超出本任务范围，但它是比 nft 更治本的堵法，建议另开线程。

---

## 七、必答问题逐条回答

**1. 会不会改变模型已经见过的请求开头？——不会，且本设计以「不改」为硬约束。**
发给模型的内容（工具定义、系统提示、历史、遮盖结果）一个字节都不动；改动全部发生在 Worker 与执行端之间（`forkJobHost` → socket 连接），模型可见的只有作为工具结果**追加在末尾**的错误/输出文本。每轮会变的值（超限错误、资源观察）天然只出现在最后一条消息；本方案不新增任何进系统提示/工具定义的字段。依据：`.claude/rules/prompt-prefix.md:35`（「已经发给过模型的内容，不得改动、重排或删除，只能在末尾追加」）。若实施中有人想把账号名或额度写进系统提示——按规则 28 那是禁止的，只能放最后一轮（`.claude/rules/prompt-prefix.md:28`）。现有门槛 `check:prompt-prefix` 含反向用例（改写历史、系统提示带每轮变化的值必须报失败，`prompt-prefix.md:74`）继续有效，本任务不触碰它覆盖的面。

**2. 会不会让同一段文字在不同请求里变成不同字节？——设计上不会，有两个要守住的点。**
新引入的值（账号名、socket 路径、错误码）都是配置渲染的固定字符串，不依赖无序集合、不带时间。要守住的点：(a) 若错误文案里出现任何动态列表（如「当前可用的人」），必须排序后渲染，否则违反规则 10（「列表的顺序都要固定」）；(b) 遮盖规则不动——本方案不改遮盖输入，同一段文字的遮盖字节不变（规则 11 的前提「遮盖密钥不变、前面的历史不变」依旧成立）。【证实：方案不触碰遮盖与历史存储路径；推测：错误文案尚未定稿，定稿时要求走 prompt-catalog 固定文字（≥24 字符清单机制），并给 `check:prompt-prefix` 补一条含新错误码的用例。】

**3. 有没有对应的自动检查，反向用例会不会真失败？——现状没有（这是新功能），方案自带三道，反向用例按「先破坏、再断言必须报失败」构造。**
(a) `check:account-isolation`（开发容器 root 跑，CI 跳过）：A 读 B 的数据库/工作区必须 EACCES，正向对照保证非恒真；反向用例是夹具故意放宽 ACL，断言自检报错——不报错就是测试有洞。(b) 配置一致性 contract 测试（nft 集合名、polkit 单元模式、socket 路径预算、quotas.json 非法值拒绝），先例是 I-73 的 `check:model-ref-contract`（两端校验一致 + 不合格 id 不得被提供）。(c) `check:prompt-prefix` 继续覆盖问题 1/2。诚实地说：cgroup 硬限本身的「真硬」只能在生产实测（开发容器无 systemd），自动检查只能证明 DAC/ACL/协议层，这一段是「未核实」区。

**4. 产生的每个值，两端都核对了吗？**

| 值 | 产生方 | 使用方 | 两端校验 |
|---|---|---|---|
| 账号名 `hmx-<名>` | provisioning `useradd` | systemd `User=%i`、socket 路径、ACL、Worker 配置 | systemd 校验用户名合法性；**名字须限长**（socket 路径预算先例 `job-host-control.ts:78`）；Worker 配置读取时按模式校验，不合格拒绝入配置（I-73 的教训：清单里的 id 要过使用端校验） |
| 执行 socket `/run/himawari/exec/<user>.sock` | socket 单元（systemd 建） | Worker connect、provisioning enable | Worker 连接后 SO_PEERCRED 验对端 uid=该人执行账号；执行端验对端 uid=himawari-prod |
| `himawari-exec-<user>.slice` 及 drop-in | provisioning 脚本渲染 | systemd、Worker 的 polkit 兜底调用 | daemon-reload 失败即 provisioning 失败；polkit 模式与代码常量由 contract 测试对齐 |
| `quotas.json` 键值 | Andy 维护、脚本消费 | drop-in 渲染 + `set-property` | 脚本 schema 校验（0/负/超物理内存拒绝）；缺失即拒绝执行（fail-closed），不写默认值 |
| ACL 条目（default ACL） | provisioning + Worker 建任务目录时 | 内核、Worker 读、job-host 写 | 矩阵测试 + 放宽反例；回滚安全约束：他awari-prod 永远在授权集内 |
| nft 集合 `hmx-exec-users` | systemd `NFTSet=` 自动灌 uid | nft 规则文件 | 集合名两端由同一模板渲染 + contract 测试；`nft -c` 语法检查开发容器可跑 |
| job-host.v2 新增字段（对端 uid、evidence 经 socket 传输） | 执行端 | Worker `authenticateJobHostEnvelope` | 同包类型 + 单测；旧字段语义不变，不触碰模型可见内容 |

**结论**：本方案里唯一会触碰「发给模型的内容」的机会是错误文案与运行环境说明，均已按 append-only 约束设计；最大的实施风险集中在 bwrap×新账号、38 处 uid 校验、出口代理×回环封锁这三件必须上生产实测的事上。
