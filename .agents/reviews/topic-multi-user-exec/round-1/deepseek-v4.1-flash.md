# 结论

推荐把“换账号”从主服务里拿出去：**每个人一个 systemd socket 激活的 executor，service 用 `User=himawari-u-<person>` 运行，每个连接一个实例，实例放在该人的 slice 里；主服务只通过 `/run/himawari/exec/<person>.sock` 连接，不做 `setuid`、`sudo`、`systemd-run`、polkit，也不需要给主服务提权。** 资源硬上限由该 service/slice 的 cgroup 负责；目录按“主服务属主 + 本人组”分层；网络在沙箱 netns 之外再用 cgroup/nft 按 uid 兜底封住本机端口和 Magpie。

---

## 一、方案依赖的前提

| # | 前提 | 来源与原话 |
|---|---|---|
| P1 | 主服务没有特权，不能自己换 uid | `scripts/delivery-mode/packet-template/systemd/himawari-prod.service.draft:9,18-19`：`User=himawari-prod`、`NoNewPrivileges=yes`、`CapabilityBoundingSet=`。systemd 官方对 NNP 的定义：“ensures that the service process and all its children can never gain new privileges through execve()”（https://www.freedesktop.org/software/systemd/man/latest/systemd.exec.html） |
| P2 | 现在命令和 Worker 同 uid，取消靠杀进程组 | `packages/runtime-sandbox/src/job-host-messages.ts:22-35` 用 `fork(... detached: true ...)` 起 job-host；`packages/runtime-sandbox/src/job-host.ts:130-135` 用 `process.kill(-pid, "SIGKILL")`。跨账号时这一步会 `EPERM`。 |
| P3 | 现在没有硬配额，只有 100 ms 采样 | `packages/runtime-sandbox/src/resource-observer.ts:3-5,220-227`；`docs/runbooks/install-start-stop-runbook.md:263`：“采样不能证明硬配额”。主 unit 里没有 `MemoryMax`、`CPUQuota`、`TasksMax`（`himawari-prod.service.draft:7-31`）。 |
| P4 | `privateRoot` 不能超过 27 字节 | `docs/backlog/BL-20261002-002-生-产-privateroot-超-过-27-字-节.md:31`：“Linux 套接字路径最多 107 字节，所以 privateRoot 不能超过 **27 字节**。” |
| P5 | 生产机有 AppArmor 对非特权用户命名空间的限制 | `.agents/instructions/test-and-production-hosts.md:20`：“生产服务器（Ubuntu 24.04，带有 AppArmor 对用户命名空间的限制）”。 |
| P6 | Magpie 在本机、不校验访问密钥 | `docs/adr/0117-magpie-routes-models-through-owned-subscriptions.md:114`：“Magpie 只监听本机时不检查访问密钥……所以生产机上任何本地程序都能用 Andy 的套餐额度。” |
| P7 | 模型请求只能追加，会变的值只能在最后 | `.claude/rules/prompt-prefix.md:27-29,84-88`：“已经发给过模型的内容，不得改动、重排或删除，只能在末尾追加”“系统提示和工具定义里不得出现会变的值”。 |
| P8 | 未来是按人独立部署的方向 | `docs/backlog/BL-20261026-003-isolated-instance-per-person.md:22`：“独立 stateRoot、数据库、secrets、配置、系统服务、系统账号、端口”。本方案与它兼容，但只负责执行账号/资源这一块。 |
| P9 | 工作区授权记录存绝对路径 | `apps/agent-service/src/production-run-policy.ts:241-265`：从 `HostDirectoryGrant` 取 `displayPath`。 |
| P10 | 密钥由 Worker 从 stateRoot/secrets 读取 | `apps/execution-worker/src/production-worker-composition.ts:300`：`new SystemdProviderSecretSource(path.join(configuration.stateRoot, "secrets"))`；程序密钥注入见 `apps/execution-worker/src/program-secret-injection.ts:5-53`。 |
| P11 | 仓库已有按 uid 封本机端口的先例 | `scripts/operations/ci-runner/runners.sh:54-67` 用 `meta skuid { ... } ip daddr {...} reject` 和 `fib daddr type local tcp dport {...} reject`；`runners.sh:161-189` 在安装时用 `nft -c` 校验并读回。 |
| P12 | systemd 能按连接起实例、能按 cgroup 硬限 | systemd.socket：“If yes, a service instance is spawned for each incoming connection and only the connection socket is passed to it.”（https://www.freedesktop.org/software/systemd/man/latest/systemd.socket.html）systemd.resource-control：`MemoryMax` “If memory usage cannot be contained under the limit, out-of-memory killer is invoked inside the unit”；`CPUQuota` “how much CPU time the unit shall get at maximum”；`TasksMax` 限制任务数（https://www.freedesktop.org/software/systemd/man/latest/systemd.resource-control.html）。 |

**还依赖两个需要 Andy 确认的前提：**

- 磁盘硬上限要求文件系统支持 project quota（ext4/xfs）或接受每人一个 loopback 文件；否则“磁盘硬上限”做不到，只能监控/软限制。见下方“需要拍板”。
- 每个 executor 的 privateRoot 仍用共享短根（如 `/var/lib/himawari/j`，19 字节），每人的 job 目录按组/ACL 隔离，避免 `/var/lib/himawari/jobs/<person>` 超过 27 字节。

---

## 二、推荐方案

### 2.1 运行路径

```
Agent/Worker (himawari-prod, NNP, 空 caps)
   │  connect /run/himawari/exec/<person>.sock
   ▼
systemd socket unit (SocketUser=himawari-prod, SocketMode=0660, Accept=yes)
   │  systemd 按连接起一个实例
   ▼
himawari-exec-<person>@<n>.service
   User=himawari-u-<person>
   Group=himawari-u-<person>
   Slice=himawari-person-<person>.slice
   ExecStart=node job-host-main --transport=accepted-fd
   │
   ├─ 现有 job-host-main + SRT/bubblewrap，命令仍是 person uid
   └─ 命令进程、job-host 进程都在同一个 service cgroup 内
```

要点：

- **主服务只做 UDS 客户端**。socket 文件由 systemd 以 `himawari-prod` 属主、`0660` 创建；本人账号不是 socket 的属主/组，不能主动连进来。
- **每个连接一个 job-host 进程**，与现有“一次 fork 一个 job-host”的模型一致；`Accept=yes` 还让不同连接在独立 service 实例中，系统文档明确说这能“enable stronger security (since the various sandboxing options can be used to isolate parallel connections from each other)”。
- **每个实例都放在该人的 slice**。这样即使一个人并发 3 个命令，内存/CPU/进程数仍按人汇总，不会被“多开几个连接”绕过。
- **主服务不执行 `systemd-run`/`sudo`/polkit**，因此不需要去掉 `NoNewPrivileges=yes`，也不需要 setuid helper。

示例 unit（值全部来自配置，不写死）：

```ini
# /etc/systemd/system/himawari-exec-p01.socket
[Socket]
ListenStream=/run/himawari/exec/p01.sock
SocketMode=0660
SocketUser=himawari-prod
SocketGroup=himawari-prod
DirectoryMode=0750
Accept=yes
CollectMode=inactive-or-failed

# /etc/systemd/system/himawari-exec-p01@.service
[Service]
User=himawari-u-p01
Group=himawari-u-p01
SupplementaryGroups=
Slice=himawari-person-p01.slice
ExecStart=/opt/himawari/node/bin/node .../job-host-main.mjs --transport=accepted-fd
NoNewPrivileges=yes
CapabilityBoundingSet=
AmbientCapabilities=
ProtectSystem=strict
ProtectHome=yes
PrivateTmp=yes
PrivateDevices=yes
ProtectProc=invisible
ReadWritePaths=/var/lib/himawari/w/p01 /var/lib/himawari/j/p01
KillMode=control-group
KillSignal=SIGTERM
SendSIGKILL=yes
TimeoutStopSec=5s
WatchdogSec=10s
Restart=on-failure
RestartSec=1s
LimitNOFILE=4096
UMask=0002
```

`himawari-person-p01.slice` 放 `MemoryHigh`、`MemoryMax`、`MemorySwapMax=0`、`CPUQuota`、`TasksMax`、`IOReadBandwidthMax`、`IOWriteBandwidthMax`。所有数值由 `/etc/himawari/people/p01.json` 生成，不在代码里写常量。

### 2.2 加人、改上限不重启主服务

**加人（root 脚本，一条命令）：**

1. 读 `/etc/himawari/people/<p>.json`，校验 `personRef`、uid/gid、路径、限额、磁盘配额。
2. 备份将改动的 unit/slice/socket/目录/账号/nft 规则；设置 `trap ERR/INT/TERM`，失败按 `install-runner.sh:36-55` 的方式回滚。
3. `useradd --system --user-group --home-dir /var/lib/himawari/j/<p>/home --no-create-home --shell /usr/sbin/nologin himawari-u-<p>`；确认没有附加组、没有 sudo、没有密码。
4. 创建 `/var/lib/himawari/w/<p>`、`/var/lib/himawari/j/<p>`，属主 `himawari-prod:himawari-u-<p>`，模式 `2770`；设置默认 ACL（如需要）和磁盘 project quota。
5. 渲染 slice/socket/service，`systemd-analyze verify`，`systemctl daemon-reload`，`systemctl enable --now himawari-exec-<p>.socket`。**不重启主服务，也不启动常驻 executor**。
6. 更新 nft 规则（或使用 systemd `NFTSet=` 自动把 uid 放进集合），`nft -c` 校验后加载。
7. 读回 `systemctl show` 的 `User/Group/Slice/MemoryMax/CPUQuota/TasksMax/NoNewPrivileges`、`id`、目录 `ls -ld/getfacl`、socket 路径、`nft list`；不一致就回滚。
8. 成功打印 `INSTALL_OK`；失败打印 `INSTALL_FAILED` / `RESTORE_INCOMPLETE`。

**改上限：** 改 people JSON 后运行 `person-apply-limits.sh`。脚本写 slice drop-in，并执行 `systemctl set-property himawari-person-<p>.slice MemoryMax=... CPUQuota=... TasksMax=...`，运行中的 cgroup 立即生效；主服务和其他人的服务都不重启。降低到当前用量以下可能当场 OOM/杀进程，脚本要显式警告并让 Andy 确认。

### 2.3 目录和文件权限

| 内容 | 位置 | 属主/组 | 模式 | 谁能访问 |
|---|---|---|---|---|
| 主 state、数据库、secrets | `/var/lib/himawari/state` | `himawari-prod:himawari-prod` | 目录 `0700`，文件 `0600` | 只有主服务；执行账号不能读 |
| 每人数据库/state | `/var/lib/himawari/state/people/<p>` | `himawari-prod:himawari-prod` | `0700` | 主服务；执行账号不能读 |
| 工作区 | `/var/lib/himawari/w/<p>` | `himawari-prod:himawari-u-<p>` | `2770` + 默认 ACL | 主服务（属主）、本人（组）；其他执行账号不行 |
| 每 job 私有目录 | `/var/lib/himawari/j/<jobId>`（共享短 privateRoot） | `himawari-prod:himawari-u-<p>` | `2770` | 主服务创建/删除；本人进程读写 |
| job 控制/证据 | 私有目录下 | 同上 | 目录 `2770`，文件 `0600` | 主服务读；job-host 写；证据只作旁证 |
| 日志 | journald | root/systemd-journal | — | 不落本人可写文件；命令 stdout 仍走管道 |
| 临时文件 | 每 job 私有目录 + `PrivateTmp=yes` | 本人 | 由 unit 隔离 | 随 service 实例结束清理 |

工作区用“主服务属主 + 本人组 + setgid”的原因：主服务不需要加入新组，也不需要 chown（它没有 CAP_CHOWN）；目录归主服务，主服务能创建、重命名、删除；本人通过组写。子文件由本人创建时继承组，主服务读取需要组读或默认 ACL；把 executor 的 `UMask` 设为 `0002`，并对工作区设置默认 ACL：

```
setfacl -m  d:u:himawari-prod:rwX  /var/lib/himawari/w/<p>
setfacl -m  u:himawari-prod:rwX    /var/lib/himawari/w/<p>
```

**边界要写清：** 如果本人故意 `chmod 0600` 或改掉自己文件的 ACL，主服务可能读不到该文件。这是本人对自己数据的自伤，主服务应报“文件不可读”，不得提升权限。若要求“即使本人 chmod 也挡不住主服务读”，就必须改成由 executor 代读/代写（主服务只收发内容），这是更大的改动，见“需要拍板”。

`privateRoot` 长度：用共享根 `/var/lib/himawari/j`（19 字节），job 目录再由 policy 追加；不要用 `/var/lib/himawari/jobs/<person>`，否则很容易超过 27 字节的根预算（P4）。

### 2.4 资源硬上限

| 资源 | 机制 | 配置位置 | 超限表现 |
|---|---|---|---|
| 内存 | cgroup v2 `memory.max`，由 systemd `MemoryMax` 设置；`MemoryHigh` 做软节流；`MemorySwapMax=0` | per-person slice | 该 cgroup 内 OOM，命令退出 137/被 SIGKILL；别人的 cgroup 和主服务不受该 cgroup OOM 影响 |
| CPU | cgroup v2 `cpu.max`，由 `CPUQuota` 设置；`CPUWeight` 让主服务优先 | per-person slice | 被 CFS 限流，命令变慢；不是“采样发现后杀” |
| 进程/线程 | cgroup v2 `pids.max`，由 `TasksMax` 设置 | per-person slice | fork/线程创建失败 `EAGAIN` |
| 文件描述符 | `LimitNOFILE` | service | 打开文件失败 `EMFILE` |
| 磁盘用量 | 文件系统 project quota（ext4/xfs）或每人 loopback 文件 | 根脚本 + people JSON | 写入失败 `ENOSPC`；这是硬上限，不依赖采样 |
| 磁盘带宽 | `IOReadBandwidthMax` / `IOWriteBandwidthMax`（可选） | slice | IO 被限速，避免一个人打满盘 |
| 网络 | SRT 域名白名单 + cgroup/nft 按 uid 封本机端口 | job-host policy + nft 规则 | 非白名单域名 403/拒绝；本机端口拒绝；Magpie 不可达 |

**避免一个人的 OOM 杀别人：** 每个人在自己的 slice 里，`MemoryMax` 的 OOM killer 在“inside the unit”触发（systemd 官方原话）；再加一个父 slice `himawari-people.slice` 限制所有人合计内存，主服务单独放 `MemoryMin`/`MemoryMax`，让它有保留内存。一个人打满自己的 512 MB 只会死自己的 cgroup；不会把所有人的合计拖到整机 OOM。

**数值来源：** `/etc/himawari/people/<p>.json` 是唯一来源。根脚本用它渲染 slice；主服务读同一个文件限制 `ResourceCeiling`，并校验“app 上限 ≤ systemd 硬上限”。两边不一致就拒绝启动该人的执行，避免出现“应用以为 1 GB、systemd 实际 256 MB”的静默差异。

### 2.5 网络：封住主服务端口和 Magpie，同时保留白名单

正常沙箱内：现有 SRT 策略已经是 `denyRead: ["/"]`、`strictAllowlist: true`、`allowLocalBinding: false`（`packages/runtime-sandbox/src/policy.ts:159-191`），bwrap 使用 `--unshare-net`（`packages/runtime-sandbox/src/bwrap-read-only-tmpfs.ts:9-15`）。正常路径本来就连不到宿主 `127.0.0.1`。

但“从沙箱逃出来”后进程仍是 person uid，可能在宿主 netns。因此再加一层按 uid 的网络规则，复用仓库已有做法（P11）：

```
table inet himawari_exec {
  chain output {
    type filter hook output priority filter; policy accept;
    meta skuid { <所有执行账号 uid> } ip daddr { 10.0.0.0/8, 100.64.0.0/10, 169.254.0.0/16, 172.16.0.0/12, 192.168.0.0/16 } reject
    meta skuid { <所有执行账号 uid> } ip6 daddr { fc00::/7, fe80::/10 } reject
    meta skuid { <所有执行账号 uid> } fib daddr type local tcp dport != { <本机 egress 代理端口> } reject
  }
}
```

- `fib daddr type local` 封的是本机地址，`tcp dport != <代理端口>` 只放行该人的 egress 代理端口；Magpie 端口、Worker/Agent 的本机端口都不在放行集合里。
- 域名白名单仍由现有 `openNetworkEgress()` 校验（`packages/runtime-sandbox/src/network-egress.ts:61-79`），逃逸后即使能连代理，也只能访问白名单。
- 如果希望更强，可把 egress 代理放到独立 service/cgroup，并在 person slice 上用 systemd `IPAddressDeny=any` + `IPAddressAllow=<代理地址>`；官方文档说明这些访问列表作用于该 unit 所有 socket 的进出流量。这样即使 nft 规则漏了端口，cgroup 也挡住本机地址。
- 添加人员时用 systemd `NFTSet=user:inet:himawari_exec:allowed_uids` 自动把 uid 插入 nft 集合，减少“人加了但防火墙规则没更新”的风险；或由根脚本重新生成并 `nft -c` 校验。

### 2.6 取消、超时、崩溃后的清理

- 正常取消：Worker 通过 UDS 发 `cancel` → job-host 在同一 cgroup 内杀自己的任务组（同 uid，`process.kill` 合法）→ job-host 退出 → systemd 回收 cgroup。
- Worker 跨 uid 不能再 `kill(-pid)`：生产路径把 `job-host.ts:130-135` 的 `force()` 改成“关闭 UDS + 等 service 退出”；本地测试仍保留同 uid 的 force。
- 超时/崩溃：
  - `RuntimeMaxSec` 给每个连接一个总上限（按该人最大 run deadline + 清理余量配置）。
  - `WatchdogSec=10s`，job-host 用 `sd_notify` 发心跳；事件循环卡死时 systemd 会杀整个 cgroup。
  - `KillMode=control-group` + `SendSIGKILL=yes` + `TimeoutStopSec=5s`，保证同一个 service cgroup 内的所有后代（包括逃逸进程）被杀。
  - 内核 cgroup v2 的 `cgroup.kill` 有官方定义：“Writing ‘1’ to the file causes the cgroup and all descendant cgroups to be killed... via SIGKILL”（https://docs.kernel.org/admin-guide/cgroup-v2.html），这是比“PID 心跳”强的清理证明。
- 身份核验：`readProcessStartToken` 读 `/proc/<pid>/stat`，跨 uid 仍可读；`processGroupPresent` 的 `EPERM` 要继续当作“存在”，不能当“已消失”。但**不要**再把用户可写的 `final.json` 当作清理证明；清理证据应以 systemd unit 不活跃 + cgroup 为空（或 root 只读 verifier 的签名观察）为准。现有 runbook 已经明确“心跳仅证明连接仍在工作，不证明资源已释放”（`docs/runbooks/install-start-stop-runbook.md:265`）。
- Worker 与 service 的会话仍用现有 `sessionId`、`bootId`、`processIdentityRef`、序列号、1500 ms 观察窗（`job-host-messages.ts:38-83`）；新增 UDS 传输时保留这些字段，不能因为 transport 换了就跳过校验。

### 2.7 代码改动点（本任务只出方案，不实施）

1. **transport 抽象**：把 `forkJobHost()` 改成接口；本地开发用 `forkJobHost`（同 uid），生产用 `connectJobHostSocket(personRef)`。`job-host-main.ts` 的 `process.send/process.on("message")` 改为 transport 的 `send/onMessage`；`Accept=yes` 时用继承的连接 fd。
2. **取消路径**：`job-host.ts` 的 `force()` 对远程 transport 改为关闭连接；`process-identity.ts` 保留 `/proc` 读取，不跨 uid 杀进程。
3. **控制目录/证据 owner 校验**：`job-host-control.ts:70-77`、`job-host-launch-decision.ts:144-150`、`apps/agent-service/src/production-sandbox-control.ts:305-313,902-909` 目前要求 owner == `process.getuid()`。改成“接受该路径类别的预期属主集合”：主服务的控制目录仍是主服务 owner；executor 写的控制/证据文件接受 person uid，但主服务必须继续校验 HMAC、进程 start token，不能只信文件内容。
4. **private/control 目录创建**：`production-sandbox-execution-v2.ts:416-420,1094-1095` 创建目录时设置组/ACL；`prepareJobPolicy`（`packages/runtime-sandbox/src/job-policy.ts:22-36`）的 owner 检查同理，不能继续只接受 `process.getuid()`。
5. **workspace 文件 owner 审计**：`packages/platform-node/src/files/constrained-file-system.ts:586`、`pi-file-publication.ts:55`、`pi-output-export.ts:27`、`directory-move.ts:57` 等 51 处检查，按“路径类别”决定允许的 uid：DB/secrets 仍只允许主服务；workspace 允许主服务或该 workspace 对应 person uid；不得放宽为任意非 root。
6. **配置 schema**：在 `ProductConfiguration` 增加 `execution`（personRef、socket、limits、egress proxy port、磁盘配额）；默认值只放模板，不写死在代码。主服务启动时读 `/etc/himawari/people/*.json`，按 `mtime` 热发现新人；每个值都要有 produce/consume 两端的同一校验。
7. **根脚本**：`person-add.sh`、`person-apply-limits.sh`、`person-remove.sh`、unit/slice/socket 模板、nft 生成、读回与回滚；参考 `scripts/operations/ci-runner/install-runner.sh` 的备份/恢复/`nft -c`/`systemd-analyze verify` 结构。

---

## 三、考虑过但不选的做法

| 做法 | 信任边界 | 延迟 | 运维负担 | 失败时 | 结论 |
|---|---|---|---|---|---|
| **systemd socket 激活的每人 executor（采用）** | 主服务不换 uid，执行进程就是 person uid；systemd 负责启动/限制/回收 | 每次连接启动 Node/job-host，约百毫秒级（未实测） | 每人 1 socket + 1 template service + 1 slice；根脚本生成 | socket/service 起不来则该人执行失败，主服务和其他人不受影响 | 采用 |
| 每人一个常驻 worker | 同样 person uid | 无启动延迟 | 20 个常驻 Node，空载也占内存，8 GB 紧张 | 一个人 worker 崩溃只影响该人 | 可作为 latency 备选，不作为默认 |
| 主服务调 `systemd-run --uid=...` | 需要 root/polkit/sudo；主服务 NNP 下做不了 | 每次新 unit | 要维护权限规则、unit 名冲突、幂等 | 权限失败即无法执行；主服务一旦被利用可变成“以任意人身份起进程” | 不选 |
| polkit 规则让主服务管理系统 unit | 主服务仍是特权请求方；规则写错会扩大到任意 unit | 中 | 需要 D-Bus/polkit 规则和审计 | 规则失效则执行失败；攻击面大于 socket 激活 | 不选 |
| setuid/sudo 小帮手 | helper 本身是高价值攻击面；主服务 NNP 还阻止 sudo/setuid | 低 | 需要审计 setuid 二进制、sudoers、参数校验 | helper 漏洞等于提权；sudoers 写错可能允许任意命令 | 不选 |
| 每命令一个容器 | 容器隔离强，但 Docker/containerd daemon 是 root 面；本机没装 Docker | 中高 | 镜像、daemon、网络、存储、cgroup 全要维护 | daemon 故障会影响所有人；容器内 uid 映射仍需设计 | 不选 |
| gVisor | 用户态内核，隔离更强 | 高 | 额外 runtime、兼容性和升级成本 | 兼容性失败面大；8 GB 机器不划算 | 不选 |
| 每人一台 VM | 边界最清楚 | 高 | 成本/运维最高；Andy 明确不想多租服务器 | 单机故障面更大 | 不选 |

---

## 四、风险、反例和失败模式

1. **同 uid 的 job-host 仍可被本人 ptrace/控制。** 这不是跨人/跨主服务的边界，但意味着本人可以伪造清理证据、读取自己 job-host 内存里的自己的 provider secret。缓解：清理证明改用 systemd cgroup；provider key 按人隔离；不要依赖 Yama 一定开启（Ubuntu 默认 `ptrace_scope=1`，但生产未核实）。
2. **AppArmor + bwrap 在新 uid 下可能直接不可用。** 现有生产资格是按 `himawari-prod` 做的；换 UID 后 userns、seccomp helper、privateRoot socket 路径都要重测。这是最可能“代码看起来对、生产跑不起来”的点。
3. **`MemoryMax` 过低会让正常命令在启动 Node/bwrap 时就 OOM。** 20 人每人 256 MB 可能不够；必须实测单个 bash/Python/Node 工具的基线，再定默认值。
4. **磁盘硬上限不是纯代码问题。** ext4 默认没有开启 project quota；要 `tune2fs`/改 mount option/重启或单独文件系统/loop 文件。如果不做，只能软限制，无法满足“硬上限”。
5. **nft 规则按 uid 封本机端口，但规则生成依赖 uid 和代理端口。** 加人漏更新、改端口漏更新都会留下缺口；反向测试必须能抓住。用 `NFTSet=` 或“配置变更即重新生成 + `nft -c` + 读回”降低风险。
6. **主服务读本人文件受 ACL/umask 影响。** 本人 `chmod 0600` 后主服务读不到；这是 fail-closed，不是越权。若 Andy 不接受这种“本人能自锁”，就要改成 executor 代读。
7. **`Accept=yes` 每次连接起 Node，SRT 初始化也可能每次重来。** 延迟和资源开销需要实测；若不可接受，退回“每人常驻 worker”，但仍保留同样 slice 限制。
8. **主服务无法跨 uid 强杀。** 取消/清理的最终保证从 Worker 转移到 systemd。如果 systemd 本身异常，主服务只能报告 unknown，不能假装清理成功；这与现有“unknown 不重放”的规则一致。

---

## 五、需要 Andy 拍板的取舍

1. **磁盘硬配额怎么做：** 在现有根文件系统开 ext4 project quota（可能要维护窗口/重启），还是给 `/var/lib/himawari` 单独一块文件系统/每人 loop 文件？不拍板就只能软限制。
2. **每人资源默认值：** 建议先按“每人 512 MB、1 核、256 进程、4096 fd、磁盘 1 GiB”做模板，再按实测调整；20 人合计不能超过约 6 GB，主服务保留 1–2 GB。
3. **本人 chmod 自锁文件时主服务是否必须仍能读：** 若“必须”，就要把工作区文件读写改成 executor 代理，改动更大；若接受“报不可读”，当前方案够用。
4. **每个 person 是否在独立 Worker/DB 部署：** 本方案与两者兼容；如果共用主 Worker，需要额外做 person registry 热发现和每轮 personRef 校验。
5. **生产上是否允许 `setfacl`/`nft`/project quota 这些系统依赖：** 需要在部署脚本里检测并拒绝不满足的主机。

---

## 六、读代码/来源证实的 vs 推测的

**已证实（代码或官方文档）：**

- 主服务同 uid、NNP、空 caps，没有硬限额。
- 现在 job-host 用 fork，取消用 `kill(-pid)`；跨 uid 会 `EPERM`。
- 现在资源限制是 100 ms `ps` 采样，不是硬配额。
- `privateRoot` 有 27 字节预算；private/control 目录和若干文件检查 owner == `process.getuid()`。
- 工作区授权存绝对路径；密钥从 `stateRoot/secrets` 读；Magpie 本机无鉴权。
- systemd 的 `Accept=yes`、`MemoryMax`、`CPUQuota`、`TasksMax`、`cgroup.kill` 语义如文中引用。
- 仓库已有按 uid 封本机端口的 nft 先例。

**推测/未核实：**

- socket 激活 + Node/SRT 的实际启动延迟（未实测）。
- Ubuntu 24.04 + AppArmor 下，新 person uid 能否正常跑 bwrap/SRT（未实测）。
- 生产文件系统是否已支持/能开启 project quota（未核实）。
- 20 人 × 默认限额能否稳定放进 8 GB（未实测）。
- 本方案对现有 `job-host-control` 证据文件 owner 检查的改动是否覆盖全部 51 处（只做了 grep，未逐文件运行测试）。
- `Accept=yes` 的连接 fd 直接接到现有 job-host 消息循环，是否需要额外 framing/backpressure（未原型验证）。

---

## 七、必答问题

### 1. 会不会改变模型已经见过的请求开头？

**不会，前提是实现时遵守以下边界。**

- 这个改动只改 Worker 到 executor 的启动方式、文件权限和 cgroup，不进入 `production-run-policy.ts:82-157` 的 `run-system-instruction`、工具定义或历史。
- 模型可见的“当前执行环境”仍走现有 `runtimeEnvironmentNotice()`（`production-run-policy.ts:192-239`），它是运行环境块，不是系统提示；每轮会变的值（资源状态、是否超限、账号可用性）只能作为最后一条消息/工具结果追加。
- **不要把 uid、用户名、socket 路径、service 实例号、当前内存用量写进系统提示、工具定义或历史中间。** workspace 路径按人固定；如果确实要变，按既有机制追加新的运行环境说明，不修改旧消息。
- 发给模型的内容仍然只在末尾追加；每轮会变的值都在最后一条消息/运行环境块里。
- 验证：`npm run check:prompt-prefix` 必须继续通过；新增用例：同一对话先后使用不同 executor 配置，下一次请求仍以前一次请求开头。

### 2. 会不会让同一段文字在不同请求里变成不同字节？

**本方案不改模型输入序列化和遮盖，因此不会。** 但实现时要注意：

- 新增的 `personRef`、uid、unit 名、socket 路径只用于内部协议和文件系统，不进入模型输入。
- 如果必须把执行账号写进运行环境说明，用稳定的 `personRef`，不要用 uid（重装/重建账号会变），不要加时间戳、随机 service 实例号。
- 内部生成的 unit、nft 规则、uid 列表、端口列表必须排序；不能依赖对象遍历顺序或 `ss` 输出顺序。nft/配置摘要要固定。
- 遮盖逻辑完全不碰；不会因为“这个人是哪个账号”改变同一段文字的遮盖结果。

### 3. 有没有对应的自动检查，反向用例真的会失败？

**有，但需要分两层跑；目前未实现、未运行，标“未核实”。**

- `npm run check:exec-transport`（普通 CI 可跑）：断言生产路径不会调用 `forkJobHost` 同 uid 回退；socket 客户端握手、session/boot/序列号校验；配置/limit 两端的校验；unit/nft 渲染的稳定字节和长度预算。
- `npm run check:person-isolation`（需要 root + 真实账号，Hermes/生产）：建 A/B 两个系统账号，A 读 B 的 workspace、B 的 DB、主服务 secrets 全部应 `EACCES`；A 读自己的工作区应成功；主服务读 A 的 workspace 应成功。反向用例：把 B 目录改成 `0777`、或把测试跑回主 uid，检查必须报失败。
- `npm run check:exec-limits`（需要 systemd/cgroup，Hermes/生产）：启动一个超过 `MemoryMax` 的进程，断言只有该人的 service 被 OOM，B 和主服务仍活；`TasksMax` 超限断言 `EAGAIN`；反向用例：把 `MemoryMax` 设为 `infinity`，检查必须报失败。
- `npm run check:exec-network`（需要 root/nft，Hermes/生产）：A 连本机测试监听端口（模拟 Magpie）应被拒绝；白名单域名仍可走代理；反向用例：清掉 nft 规则后，检查必须报失败。
- `npm run check:person-rollback`（脚本测试）：在加人脚本中途注入失败，断言账号/unit/目录/nft 规则全部回滚，主服务未重启；反向用例：跳过清理，检查必须报失败。
- CI 普通账号没有 root/sudo，只能跑第一类；第二、三类必须在 Hermes 或生产上由 Andy 授权的 root 脚本跑，并保存红/绿证据。没有这些证据前，不能说“隔离已验证”。

### 4. 改动产生/修改的每个值，使用它的每一处都能接受吗？

必须逐个核对，不能只看 diff（I-73 的教训）。至少包括：

| 值 | 产生处 | 使用处 | 两端校验 |
|---|---|---|---|
| `personRef` | `/etc/himawari/people/*.json` 或 per-person 配置 | socket 路径、unit `User`/`Slice`、nft set、workspace grant、主服务 connect | 同一正则（如 `^[a-z][a-z0-9-]{0,31}$`）；只信配置，不信模型参数；路径拼接后仍是预期绝对路径 |
| uid/gid | `useradd` / `getent` | unit `User/Group`、目录属主/组、nft `meta skuid`、socket 属主 | `getent passwd/group` 读回；禁止附加组、sudo、密码；uid 不与现有账号冲突 |
| limits | people JSON | slice drop-in、主服务 `ResourceCeiling` | 正数、范围、合计预算；app 上限 ≤ systemd 硬上限；unit 读回 `systemctl show` |
| socket 路径 | 根脚本 | systemd socket unit、Worker 客户端 | 绝对路径、长度 ≤108、父目录存在、owner `himawari-prod`、mode `0660`；两端用同一配置 |
| `workspace` | grant 配置（绝对路径） | policy、unit `ReadWritePaths`、目录 ACL、主服务文件工具 | canonical path、不重叠 privateRoot、属主/组/模式正确；grant 过期/撤销后拒绝 |
| `privateRoot` | 配置 | policy 套接字预算、job 目录创建 | 绝对路径、≤27 UTF-8 字节、canonical、不重叠 workspace |
| nft uid/端口集合 | 根脚本/NFTSet | 内核 nft 规则 | `id -u` 与规则中的 uid 一致；代理端口与 job-host 实际监听一致；`nft -c` 通过并读回 |
| `NoNewPrivileges`/capabilities | unit | systemd 启动 | `systemctl show` 读回 `NoNewPrivileges=yes`、cap set 为空 |
| `KillMode`/`WatchdogSec`/`RuntimeMaxSec` | unit | systemd 清理 | 实际杀 cgroup 测试；unit 读回；崩溃/取消后 cgroup 为空 |
| DB/secrets 路径 | 配置 | 主服务读取 | 永远不在 executor 的 `ReadWritePaths`/allow 路径里；执行账号访问测试必须失败 |

特别要按 I-73 的方式做：**把生成出来的 unit、socket、nft 规则、people JSON 真正交给 systemd/nft/主服务消费一遍**，而不是只测“生成函数返回了什么”。

---

## 八、对其余业务问题的直接回答（B1–B8）

**B1 怎样真正用每人专属账号跑：** 用上面的 socket 激活 executor。主服务不换 uid，只连接由 systemd 以 person uid 启动的 job-host。`systemd-run`/polkit/sudo/setuid 都要主服务或额外特权组件，既违反 NNP 又扩大攻击面；常驻 worker 可行但 20 个 Node 在 8 GB 上不划算；容器/gVisor 对这个规模是过度设计。

**B2 目录和文件权限：** 见 2.3 表。核心是 DB/secrets 只归 `himawari-prod`；工作区/私有目录“主服务属主 + 本人组 + setgid”，主服务用属主权限，本人用组权限，其他执行账号不在组里；本人 chmod 自锁时主服务 fail-closed。

**B3 资源硬上限：** 用 per-person slice 的 `MemoryMax/MemoryHigh/MemorySwapMax/CPUQuota/TasksMax`，fd 用 `LimitNOFILE`，磁盘用 project quota，网络用 nft。数值放 people JSON，根脚本渲染 + `systemctl set-property` 热生效；改上限不需要重启主服务。超限表现见 2.4。

**B4 防止连主服务端口/Magpie：** 正常沙箱 netns 已经隔离；逃逸后用 nft `meta skuid` 封本机/私网，只放行该人的 egress 代理端口；域名白名单仍由现有代理执行。更强做法是把代理放到独立 cgroup，person slice 用 `IPAddressDeny=any` + 只允许代理地址。

**B5 取消、超时、崩溃清理：** 取消走 UDS；job-host 同 uid 杀任务组；systemd `KillMode=control-group` + `TimeoutStopSec` + `WatchdogSec` + `RuntimeMaxSec` 兜底；主服务不再跨 uid `kill(-pid)`；清理证明用 cgroup 为空/unit 不活跃，不用用户可写的 `final.json`。

**B6 测试：** 普通 CI 跑 transport/配置/unit 渲染/owner 校验的纯测试；开发容器 root 可跑真实账号的 A/B 文件隔离和 `setpriv` 取消；systemd/cgroup/nft 必须在 Hermes 或生产上跑；反向用例必须故意破坏隔离并断言失败。

**B7 失败/回滚：** 生产**不退回同账号**；缺 unit/账号/socket 时该人的执行 fail-closed，主服务继续服务其他人。根脚本在应用前校验限额、`systemd-analyze verify`、`nft -c`；失败按备份回滚并打印 `INSTALL_FAILED` / `RESTORE_INCOMPLETE`。开发/测试可以显式配置 `execution.backend=local-same-uid`，但生产配置不允许该值。

**B8 更好的思路与最该先实测的三件事：**

- 更好的组合是“socket 激活 + per-person slice + `NFTSet=` 自动同步 uid”，它把“加人”变成只加 socket/slice 和配置，不需要改主服务、不需要改全局 nft 规则。
- **最该先实测：**
  1. Ubuntu 24.04 真实主机上，`User=himawari-u-*` 的新账号能否正常跑现有 SRT/bwrap（AppArmor userns、seccomp helper、privateRoot socket 路径）。
  2. per-person slice 的 `MemoryMax`/`TasksMax`/`CPUQuota` 是否真的把 OOM 和进程数限制在该 cgroup 内，且不波及主服务和其他人。
  3. 跨 uid 取消/崩溃后，systemd 是否能把该 service cgroup 的所有后代（包括逃逸进程）杀干净；同时跑 A 读 B 的目录/DB、A 连 Magpie 的反向测试，确认不是“只在代码里隔离”。
