## 侧重检查（先查这些路径）

- **错误路径**：账号/套接字/配置缺项、网关崩溃或挂死、Worker 断开、`nft -f` 失败、`set-property` 失败、磁盘缩容、`remove` 中途失败、Andy 迁移。结论：方案只写了“失败回滚”和“命令执行暂时不可用”，没有定义分阶段错误语义，也没有覆盖“命令可能已经跑过”的情形。
- **不合规范/不可信输入**：`slot`、名册、root 应用器的请求文件、Worker 发来的 `JobHostRequest`、job-host.v2 消息、nft 的 uid/端口、`exec.json` 的数值、systemd 单元名。结论：`slot` 没有字符集、长度、uid 映射和不可变性约束；root 应用器的输入边界没有落到代码级。
- **安全**：systemd socket 权限、控制目录/证据文件的所有者、HMAC 证据在同一个 uid 下是否可信、标准输入里的密钥、nft 只封“已知端口”、`/tmp`/`$HOME` 绕过磁盘配额、root 应用器提权面。结论：socket 默认权限和密钥仍在执行账号内是最高风险；控制目录跨账号是功能性硬阻塞。
- **资源耗尽**：内存、CPU、进程数、文件描述符、磁盘空间、inode、loop 设备、并发数、输出缓冲。结论：`LimitNOFILE` 放错层级；父 slice 没有 CPU/Tasks 总闸；并发上限被推给块 4；磁盘按目录的配额不能封住 `/tmp`、`$HOME`、`/var/tmp`、`/dev/shm`。
- **不可撤销操作**：`userdel`/`rm -rf`、缩容磁盘、删 nft 表、删 systemd 单元、迁移授权里的绝对路径。结论：`remove` 没有 drain、卸载、墓碑、uid 不复用和数据导出策略；缩容磁盘没有禁止。
- **规则/文档一致性**：`prompt-prefix.md` 的只追加和字节确定、I-73、ADR 编号、引用的行号。结论：模型前缀方向大体成立，但“新错误文案”没有自动检查；ADR 0234 在当前提交不存在；A3/A11 的引用不准确。

## 证实的

- 生产单元确实没有资源上限：`scripts/delivery-mode/packet-template/systemd/himawari-prod.service.draft:9-20` 只有 `User=himawari-prod`、`NoNewPrivileges=yes`、`CapabilityBoundingSet=`，没有 `MemoryMax`/`CPUQuota`/`TasksMax`。
- `forkJobHost` 的真实位置是 `packages/runtime-sandbox/src/job-host-messages.ts:22`，不是方案写的 `:17`；`:28-34` 设置 `HOME`/`TMPDIR`，`:34` 用 IPC。
- `killGroup` 的跨账号吞错成立：`packages/runtime-sandbox/src/job-host.ts:130-135`。
- 控制目录的所有者检查成立：`packages/runtime-sandbox/src/job-host-control.ts:70-77`；Worker 侧还有 `apps/agent-service/src/production-sandbox-control.ts:301-313`、`:902-909`。
- `privateRoot` 的 27 字节预算成立：`docs/backlog/BL-20261002-002-生-产-privateroot-超-过-27-字-节.md:31`，当前生产值是 `/var/lib/himawari/jobs`（`scripts/delivery-mode/packet-template/inputs/bindings.draft.json:88`）。
- 出口代理确实监听 `127.0.0.1`、端口 `0`：`packages/runtime-sandbox/src/network-egress.ts:35`。
- `sandbox-host-verifier` 除了所有者，还拒绝 group-writable 目录：`packages/platform-node/src/capabilities/sandbox-host-verifier.ts:159` 的 `(info.mode & 0o022) !== 0`。
- 现有产品要求“恰好一个 sandbox host binding”：`apps/agent-service/src/production-sandbox-services.ts:183-190` 的 `hostIds.size !== 1`。
- `LimitNOFILE` 不是 slice 的资源控制项：systemd.resource-control 的适用范围是 service/slice/scope/socket/mount/swap，而 systemd.exec 的适用范围是 service/socket/mount/swap；`LimitNOFILE` 是进程 rlimit，应在 service 单元。
- systemd socket 默认权限是 0666：官方文档 “SocketMode= ... Defaults to 0666.”，`SocketUser=`/`SocketGroup=` 未设置时属于 root。
- `MemoryMax` 在 cgroup 内触发 OOM：官方文档 “If memory usage cannot be contained under the limit, out-of-memory killer is invoked inside the unit.”
- `NoNewPrivileges` 只作用于该单元及其子进程，且对 `systemd-run`、`at`、`crontab` 这类外部请求无效：官方文档明确写了这一点。
- 当前仓库最高 ADR 是 0227，`docs/adr/0234-*` 不存在（`glob docs/adr/02*.md` 只到 0227）。
- `check:prompt-prefix` 只跑 `packages/runtime-pi/test/prompt-prefix.compat.test.ts`：`scripts/check-prompt-prefix.mjs:9-11`。
- 模型可见的沙箱失败文案里会带资源数值：`apps/agent-service/src/production-sandbox-tool-result.ts:153-174`；后台命令会把 `errorCode` 插进提示：`apps/agent-service/src/production-background-commands.ts:469-475`。

## 推测/未核实

- 新账号 `hx-<slot>` 下 bwrap + AppArmor 能否运行：方案自己也列为未实测。
- ext4/xfs 的 project quota 是否在目标文件系统可用、执行账号能否改 project ID 逃出配额：未核实。
- 父 slice 的 OOM 是否真的只杀“本人”的进程：按 cgroup v2 语义，父 cgroup 达上限时可在父 cgroup 内任选进程杀，可能波及别人；需实测。
- `meta skuid` 在用户命名空间映射后的匹配行为：需在生产内核上实测。
- `systemctl set-property` 降低 `TasksMax`/`CPUQuota` 是否“当场杀进程”：`MemoryMax` 会触发回收/OOM，但 `TasksMax`/`CPUQuota` 的语义不同，方案把三者混为一谈。
- 网关和 job-host 的实际内存基线、socket 激活启动延迟、loop 设备数量上限：方案自己也标了未实测。

## 发现（按严重度从高到低）

### 1. [严重][证实] 每人网关的 systemd socket 没有指定权限，默认 0666，任何执行账号都能连别人的网关
- **问题**：方案只说“一个 socket 单元 + 一个服务单元（`Accept=no`）”，没有写 `SocketMode`、`SocketUser`、`SocketGroup`、父目录权限，也没有应用层对端凭证校验。systemd socket 默认 `SocketMode=0666`，系统实例下默认属于 root。执行账号 A 可以直接连接 B 的网关套接字，向 B 的网关发 `JobHostRequest`，让网关以 `hx-B` 身份起 job-host，读取/修改 B 的工作区和私有目录。这是跨用户执行，不是“逃逸后只拿到自己账号”。
- **证据**：systemd.socket 官方文档 “SocketMode= ... Defaults to 0666.”；`SocketUser=`/`SocketGroup=` 未设置时由 root 拥有。方案 item 1 没有这些字段。
- **建议**：`/run/himawari` 由 root 拥有、0750；socket 用 `SocketUser=himawari-prod`、`SocketGroup=himawari-prod`、`SocketMode=0600`；网关 accept 后用 `SO_PEERCRED` 校验对端 uid 必须是主服务 uid；加一条测试：执行账号 connect 别人的 socket 必须 `EACCES`。如果网关要同一 UID 下多任务，也不能靠“同 uid”做认证。

### 2. [严重/高][证实] 控制目录和证据文件的创建者/读取者与现有代码直接冲突，方案没有给出可用的跨账号协议
- **问题**：方案说“控制目录和证据文件由执行账号建、网关内部使用，Worker 经套接字拿证据字节”。但现有代码是 Worker（主服务）创建控制目录并拿 device/inode：
  - `apps/execution-worker/src/production-sandbox-execution-v2.ts:416-420` 由 Worker `mkdir(controlDirectory)`；`:473-480` 生成 token 并 `lstat`；`:493-499` 在 `prepare` 之前 `claimJobHostLaunch` 需要 device/inode。
  - `apps/agent-service/src/production-sandbox-control.ts:902-909` 的 `registerPreparation` 要求 `metadata.uid === process.getuid()`（主服务），`:301-313` 的 `readPreparationControl` 也一样。
  - `packages/runtime-sandbox/src/job-host-control.ts:70-77` 的 `validateJobHostControlBinding` 要求控制目录 uid 等于 job-host 当前 uid（执行账号）。
  - `packages/runtime-sandbox/src/job-host-control.ts:144-188` 的 `readJobHostFinalEvidence`/`readJobHostStartEvidence` 是**直接读文件**，不是套接字；`:75` 还要求目录 0700。
  - `packages/runtime-sandbox/src/job-host-launch-decision.ts:38-55` 的 `validateContext` 调用同一个绑定校验，`:144-150` 要求 launch-decision 文件属主等于 Worker 当前 uid。

  如果控制目录改成执行账号 0700，主服务无法进入、无法 `queryJobHostControl`（`production-sandbox-control.ts:366-392`、`:948` 直接连 `control.sock`），也无法读 0600 的 `final.json`。方案说的“经套接字拿证据”在现有 API 里没有对应通道；`readJobHostFinalEvidence`/`readJobHostStartEvidence` 只有文件版本。`claimJobHostLaunch` 又要求 Worker 在 `prepare` 之前知道 device/inode，而目录要由网关创建，顺序必须改。这是功能性硬阻塞，不是“逐处放宽所有者检查”能解决的。
- **建议**：把控制目录的创建、token、`started.json`/`final.json`、`launch-decision.json` 全部收进网关；Worker 不再直接读文件，新增明确的 `prepare`/`inspect`/`stop`/`evidence` 套接字 RPC，返回签名后的证据字节；`registerPreparation` 改成登记“不透明句柄 + 网关身份”，不再 `lstat` 执行账号目录；`claimJobHostLaunch` 要么移到网关，要么明确“网关先创建目录并返回 device/inode”的两阶段协议。每一条都要有跨账号测试。

### 3. [高][证实] `privateRoot` 用 2770 + 执行账号属主，会直接撞上现有 `checkedPath` 的 owner/mode 检查；每人的 binding 又和“恰好一个 hostId”冲突
- **问题**：
  - `packages/platform-node/src/capabilities/sandbox-host-verifier.ts:146-163` 的 `checkedPath` 要求 `(info.mode & 0o022) === 0`，且 `info.uid` 必须是当前进程或 root。方案里 `<根>/<slot>` 属主是执行账号、组 `himawari-people`、2770；**group-writable 直接失败**，不是只放宽 uid 就能过。
  - `:242-266` 会检查 `binding.privateRoot` 和 `binding.roots`；`binding.roots` 是授权的工作区根。如果工作区迁到 `<根>/<slot>/work` 且属主是执行账号，这里同样失败；如果保留原来的项目路径、属主是主服务，执行账号又写不进去（方案明确不让执行账号进 `himawari-people` 组）。
  - `apps/agent-service/src/production-sandbox-services.ts:183-190` 要求所有 sandbox binding 的 `hostId` 唯一；`scripts/delivery-mode/packet-template/inputs/bindings.draft.json:88` 只有一个 `privateRoot: /var/lib/himawari/jobs`。如果每个 slot 一个 binding，启动直接 `SANDBOX_HOST_BINDING_AMBIGUOUS`；如果仍用一个 binding，方案里的“每人 privateRoot = /var/lib/himawari/j/<slot>”就不是 binding 里的值，`assertSandboxPrivateRoot` 只校验 binding 的 `privateRoot`，派生的 `<slot>` 长度没有校验。
  - 布局自相矛盾：方案说每人目录里有 `work/` 和 `private/`，又说私有根形如 `/var/lib/himawari/j/<slot>`。如果私有根是 `<slot>/private`，长度 `/var/lib/himawari/j/`（20）+ 6 + `/private`（8）= **34 字节**，超过 A7 的 27；如果私有根是 `<slot>`，`private/` 是多余且与任务目录命名冲突。
  - `packages/platform-node/src/capabilities/sandbox-host-verifier.ts:373` 还硬编码 `privateRoot/workspace-copies`；`apps/agent-service/src/production-workspace-copies.ts:142` 也用它。改 `privateRoot` 会改变工作区副本、旧副本查找、备份路径。
- **建议**：明确 `privateRoot = <公共根>/<slot>`（26 字节），`work/` 作为兄弟目录，不再有 `private/` 子目录；对 `privateRoot` 不要用 2770，改成 2750（主服务只读/执行）或用 POSIX ACL 给主服务读写而保持 mode 0750；`workspace-copies` 放到主服务拥有的独立目录，或明确它的属主/权限；所有 `checkedPath` 调用按“路径类别”传期望 owner/mode，而不是全局放宽；如果要每 slot 一个 host binding，先改 `hostIds.size !== 1` 和 `hostId` 选择逻辑，并加派生 `privateRoot` 的 27 字节校验测试。

### 4. [高][证实] 资源上限的层级和总量不对：`LimitNOFILE` 放错、父 slice 没有 CPU/Tasks 总闸、并发上限被推给块 4
- **问题**：
  - 方案写“每人一个 slice，`MemoryMax`、`MemoryHigh`、`MemorySwapMax=0`、`CPUQuota`、`TasksMax`、`LimitNOFILE`”。`LimitNOFILE` 是 `systemd.exec` 的进程 rlimit，不是 cgroup/slice 属性；slice 不执行进程，写在这里不会生效。
  - 只给父 slice 设 `MemoryMax`，没有父 `CPUQuota`/`CPUWeight`/`TasksMax`/`IOWeight`。6-7 个人每人 `CPUQuota=100%` 就能占满 4 核，主服务 CPU 被饿死；fork bomb 也能耗尽全机 pids。
  - 方案自己说“单人上限之和可以大于父 slice 的 `MemoryMax`”，但又要求“OOM 不波及主服务和别人”。父 cgroup 达到 `MemoryMax` 时，OOM 会在父 cgroup 内任选进程，可能杀掉另一个人的 job-host。`MemoryHigh` 只能节流，不能保证不 OOM。
  - 全机并发 6-7 的排队被推给“块 4 定数字”；如果块 4 没落地，父 slice 就是唯一总闸，跨用户 OOM 风险成立。
- **建议**：`LimitNOFILE` 放 service 单元；每用户 slice 设 `MemoryMax`/`MemoryHigh`/`MemorySwapMax`/`CPUQuota`/`TasksMax`/`IOWeight`；父 slice 设 `MemoryHigh` + `MemoryMax` + `CPUQuota` + `TasksMax`；主服务 slice 设 `MemoryMin`、较高 `CPUWeight`、`oom_score_adj`；并发准入必须在本改动内落地，或明确接受“父 cgroup OOM 可能波及其他用户”并用 `MemoryOOMGroup`/per-user cgroup 让本人整个 cgroup 一起死。加 OOM、TasksMax、CPU 饱和的实测和反向用例。

### 5. [高][证实/部分推测] “磁盘硬上限”不是硬上限：稀疏镜像、按目录的 quota、`/tmp`/`$HOME`/`/var/tmp` 都能绕过
- **问题**：
  - 方案说“固定大小的稀疏磁盘镜像”。稀疏文件不预留空间；底层文件系统满时，镜像内部还有空闲块也会写失败，反而把主服务数据库/日志拖进 ENOSPC。这不是“硬上限”，只是“上限的假象”。
  - “project quota”按项目 ID，不按 uid；如果执行账号能改自己的 project ID，或能写 `/tmp`、`$HOME`、`/var/tmp`、`/dev/shm` 等不在 per-user 目录下的路径，配额就绕过了。`forkJobHost` 只改 `HOME`/`TMPDIR`（`job-host-messages.ts:28-34`），并不限制绝对路径写入；网关进程本身也以 `hx-<slot>` 运行，systemd 默认 `HOME` 可能是 `/home/hx-<slot>`，`useradd` 如果不加 `-M` 会创建 home。
  - 只算“所有在用账号的磁盘上限之和 < 可用磁盘”是开通时的一次性检查；数据库、日志、向量索引还会增长，之后仍可能 ENOSPC。
  - 只限制块数不限制 inode：几个零字节文件就能耗尽宿主 inode；kernel quota 文档明确支持空间和 inode 两类限制，方案只提“大小”。
  - loop 镜像还涉及挂载选项、fsck、备份、卸载顺序、loop 设备数量；方案把“挂载数量不可接受”当成决策点，没有处理。
- **建议**：优先用独立卷/文件系统 + 按 uid 或 project 的块和 inode 配额；如果必须用 loop 镜像，`fallocate` 预留、`mount -o nosuid,nodev,noexec`、限制 loop 数量、开机 fsck、纳入备份；网关 service 用 `ProtectSystem=strict`、`ReadWritePaths=<slot>`、`ProtectHome=yes`、`PrivateTmp=yes`（并限制 tmpfs 大小），把 `/tmp`、`$HOME`、`/var/tmp`、`/dev/shm` 也关进配额；为数据库/日志预留空间并监控；`remove` 前先卸载；不要再用“稀疏镜像就是硬上限”的说法。

### 6. [高][推测] root 小应用器是新的高权限通道，方案的校验边界不足以支撑它
- **问题**：主服务被攻破后可以写任意请求文件；应用器只校验“slot 已开通、数值在 root 的上下限内”，但：
  - “已开通”由谁定义？如果来自主服务数据库/名册，攻破主服务就能新增 slot；必须是 root 拥有的 `/etc/himawari/...` 或 `getent passwd` 的固定映射。
  - 请求文件的属主、模式、原子写、`O_NOFOLLOW`、大小上限、路径穿越、并发/重放都没有定义；systemd path 单元触发 root 进程，存在 symlink/TOCTOU 和触发风暴。
  - `systemd set-property` 与“写 drop-in”双写可能冲突；`set-property` 失败但 drop-in 已写、或反过来，都会留下“磁盘上已改、运行时没改”的半状态。
  - 降低 `MemoryMax` 会杀进程，降低磁盘配额可能造成数据损坏/丢失；方案只对内存说“管理页提示”，对磁盘没有禁止缩容。
  - 主服务被攻破后可以反复调低别人的额度，形成对任意用户命令执行的 DoS；上下限再窄也挡不住“可用性攻击”。
  - 开通工具的顺序“daemon-reload → 启用 socket → 生成 nft → 失败回滚”留下一个窗口：账号已经能执行，但 nft 还没生效，逃逸后可访问本机端口。
- **建议**：root 维护 `slot → uid/account/unit` 的权威账本（不在主服务 DB）；请求文件严格 schema + 原子 rename + fsync + `O_NOFOLLOW` + 属主/模式/大小校验；应用器只接受“增加”自动应用，降低额度和缩容磁盘必须 root/人工显式确认；磁盘只允许增长；只保留一种持久化机制（drop-in + `daemon-reload`，或 `set-property --runtime`，不要双写）；失败要按用户事务回滚；写审计日志并限速；nft 必须先于 socket 启用，`nft -f` 后读回；加 symlink、部分写、越界值、未知 slot 的反向测试。

### 7. [高][证实/推测] `slot` 是不可信标识，却没有字符集、uid 映射、不可变性和服务端绑定
- **问题**：`slot` 会同时用于 `useradd` 账号名、目录名、systemd slice/service 名、socket 路径、nft 的 `skuid`、`JobHostRequest`、管理页、root 应用器请求、备份/日志。方案只说“6 位”，没有：
  - 字符集：允许 `-`、`.`、大写、前导数字会破坏 systemd 单元名/账号名规则；`../` 可做路径穿越。
  - `useradd` 的 uid 分配和复用：删除后重建可能拿到同一 uid，旧文件归新用户；旧 nft 规则也可能还指向旧 uid。
  - `slot` 是否由线程所有者服务端派生，还是可以来自模型/工具参数；如果后者，就是跨用户执行/IDOR。
  - `slot` 改名/迁移时旧账号、旧目录、旧 socket、旧 nft、旧授权怎么处理。
- **证据**：`systemd.exec` 对 `User=` 名称的规则是 `a-z A-Z 0-9 _ -`，首字符不能是数字或 `-`，最长 31；现有 `production-sandbox-services.ts` 只用 `hostId`，没有 `slot` 的 schema。
- **建议**：`slot` 用 `^[a-z][a-z0-9]{5}$`；root 账本里固定 `slot → uid → account`，使用保留 UID 段并禁止复用；服务端从已认证的线程所有者派生，绝不从工具参数/名册文本直接取；所有消费点（账号、路径、单元、socket、nft、请求）做同一个校验；`remove` 时墓碑化 slot，重建必须换新 slot 或显式迁移；加路径穿越、前导 `-`、大写、碰撞、删除重建的测试。

### 8. [高][证实] 密钥仍然进入执行账号，换账号并没有解决“沙箱里能拿到密钥”
- **问题**：`apps/execution-worker/src/program-secret-injection.ts:53` 把密钥拼进 JSON；`apps/execution-worker/src/production-sandbox-execution-v2.ts:423-431` 在 Worker 里注入，`:512` 作为 `stdinBase64` 放进 `JobHostRequest`；新方案让网关接收整个 `JobHostRequest`，所以网关（`hx-<slot>`）和 job-host 内存里都有明文密钥。Anthropic 的一手文章明确说 claude.ai 的边界是“credentials never enter the sandbox”；如果某个 secret 是全局共享的（例如同一个 Git token），逃逸后拿到的就是全局凭据，换账号只改变了“主服务数据库/密钥”的风险，没有解决这一条。
- **建议**：把密钥注入移到出口代理/凭据代理，任务只拿短期、按人、按任务的 scoped token；如果做不到，至少保证每个 secret 只授予该用户，禁止全局 token，并明确记录“密钥仍在执行账号内”的残余风险；测试 A 的逃逸进程读不到 B 的 secret，secret 不出现在 argv/日志/错误文案。

### 9. [中高][证实] `forkJobHost` 抽象不足以覆盖现有 `ChildProcess` 语义，取消兜底和证据链都会断
- **问题**：现有 `prepareSandboxJobHost` 依赖 `child.pid`、`child.connected`、`child.send`、`child.on("message")`、`child.once("exit"/"error"/"close")`、`child.stderr`，以及 `process.kill(-pid)`：`packages/runtime-sandbox/src/job-host.ts:93`、`:130-138`、`:150-163`、`:246-260`、`:396-449`、`:469-479`；`job-host-session.ts:86`、`:118-123`、`:305-406`、`:411-452` 也一样。远程网关如果只实现“转发消息”，`force()` 仍然会在 Worker 侧 `process.kill(-child.pid)`（跨账号失败）或对 socket 无效；`authenticateJobHostEnvelope` 还要求 `message.processId === child.pid`（`job-host-messages.ts:50-51`），Worker 无法预知远端 job-host 的 pid。网关挂死时，Worker 的定时器没有跨账号杀进程的能力；方案明确不引入 polkit，也只在比较表里提到 watchdog 但没采纳。
- **建议**：定义真正的 `JobHostTransport` 接口（start/send/receive/close/cancel/inspect/evidence），本地和网关各实现一份，不要让远端实现伪装成 `ChildProcess`；取消/强杀走网关 RPC；网关显式发送 final 消息，socket 断开不能直接当 job-host 退出；用 `WatchdogSec=`/`RuntimeMaxSec=` 或独立 watchdog 处理网关挂死；限制单条消息和总输出大小；测试网关崩溃、挂死、Worker 断开、重复 prepare、sequence 乱序。

### 10. [中][证实] nft 只封“已知端口”，比 A10 的先例弱，且没有处理 DNS/动态代理端口/uid 变化
- **问题**：方案说“拒绝本机 Magpie 端口和主服务端口（端口来自配置）”，并因为出口代理随机端口而“不能整段封回环”。但 A10 的 `runners.sh:54-67` + `:80-86` 是**封掉所有本机监听端口（除 53）**；方案只封配置里的几个端口，逃逸账号仍可连其他本机服务（未列入配置的端口、其他用户/其他组件的代理、metrics、调试端口）。另外：
  - 出口代理是随机端口，静态规则无法只放行它；方案没有给出“允许 DNS + 允许代理端口范围/专用回环地址”的写法。
  - `meta skuid` 用 `id -u`，如果账号删除重建或 uid 变化，旧规则可能指向旧 uid，新账号没有规则（fail-open）。
  - `nft -c` 只校验语法，`nft -f` 失败时如果先 `delete table` 会 fail-open；方案没有明确“先构建新表、失败保留旧表”。
- **建议**：按 A10 封掉所有本机端口，只显式放行 53 和一个预留的出口代理端口段（或专用 `127.0.0.<slot>` 回环地址）；用 systemd `NFTSet=user:inet:...` 或每次 apply 从 root 账本重新生成 uid 集合；先 `nft -c`，再在事务中替换，失败保留旧规则；nft 生效前不要启用 socket；测试连 Magpie、主服务端口、其他用户代理、DNS 的正反向用例。

### 11. [中][证实] 自动检查没有形成阻断门槛；最关键的跨账号/真实资源测试在 CI 被跳过
- **问题**：方案把“真实账号测试（开发容器有 root 能跑，普通 CI 跳过）”和“必须在测试机跑”的项列在清单里，但没有：
  - 新增一个像 `check:*` 的命名门槛并加入 `npm run check`（`package.json:27` 的 `check:steps` 是一长串显式命令）。
  - 让“生产配置只能是 per-person”的检查在启动和 CI 都失败；只写“有检查”不够。
  - 为新的固定错误文案、`slot`/路径/uid 不进入模型可见文本、错误只追加不改写，加 `[I-66]` 风格的测试；`check:prompt-prefix` 目前只跑一个文件（`scripts/check-prompt-prefix.mjs:9-11`）。
  - 把测试机证据作为发布门槛（例如 `check:untested-claims` / `check:delivery-*` 那种证据文件），否则“没跑之前不说隔离已验证”只是口头约定。
  - 反向用例覆盖：A 连 B 的 gateway socket、A 读 B 的 control/evidence、A 写 `/tmp` 超出磁盘配额、nft 删除后 fail-open、root 应用器收到 symlink/部分写/未知 slot。
- **建议**：加 `check:multi-user-exec` 到 `check:steps`；纯测试覆盖计划生成、缺项拒绝、数值越界、slot 校验、nft uid/端口、协议；root/特权测试单独跑并有证据文件；发布门拒绝 `execution.accounts.mode=per-person` 直到 socket、cgroup、nft、bwrap、跨账号读、磁盘证据齐全；加 prompt-prefix 新错误路径用例。

### 12. [中][证实] 迁移和删除是不可逆操作，方案只写了 Andy 的路径更新
- **问题**：把 Andy 和所有人从 `/var/lib/himawari/jobs` 迁到 `/var/lib/himawari/j/<slot>`，会改变：
  - `binding.privateRoot`、`binding.roots`、`directoryGrant.canonicalPath`、授权里的绝对路径、`workspace-copies`（`production-workspace-copies.ts:142`）、旧控制目录/证据、备份/恢复路径（`bindings.draft.json:82-95`）。
  - 方案只说“迁 Andy 的数据时更新授权里的绝对路径”，没有 drain、快照、dry-run、回滚、旧 `workspace-copies` 处理、进行中任务处理。
  - `remove` 没有写：先停 socket/service、杀 cgroup、卸载 loop、墓碑、数据导出/保留、`userdel` 失败处理、`rm -rf` 的 symlink 竞争、uid 不复用。现有先例 `runners.sh:141-155` 是 `pkill` + `userdel` + `rm -rf`，直接照抄会把用户控制路径交给 root 删除。
- **建议**：单独写迁移 runbook：维护窗口、停服务、快照、dry-run、逐人迁移、授权/绑定/路径更新、旧副本清理、回滚；`remove` 先 drain + 停单元 + 杀 cgroup + 卸载 + rename 到 tombstone + 安全删除 + 导出选项；root 账本保留 uid 墓碑，禁止复用；备份/恢复文档同步更新。

### 13. [中][证实] “命令执行暂时不可用”没有区分阶段，可能把“已经跑过”的失败说成“不可用”
- **问题**：方案 item 7 说账号/socket/配置缺项让命令失败，用户看到“命令执行暂时不可用”；item 9 说错误文案固定、只在工具结果末尾。但现有沙箱错误的文案是按阶段和副作用区分的：`production-runtime-tools.ts:2200-2222`、`production-sandbox-tool-result.ts:153-178` 会明确说“未启动/可能已修改工作区/没有重新执行”。如果网关在任务启动后崩溃，统一的“暂时不可用”会误导模型以为没有副作用。
- **建议**：按阶段固定三段文案：未派发/已确认未启动/已启动但结果未知（可能已修改工作区）；复用现有文案语义，不要新造模糊文案；新错误码加入固定映射，不要把原始错误、slot、账号、路径、uid、额度数字拼进 `modelContent`；加 `[I-66]` 测试，验证新错误只作为新的工具结果追加，且不改变已有历史字节。

### 14. [低/中][证实] 文档和引用不一致：ADR 0234 不存在、A3 行号错、A11 的说法前后矛盾
- **问题**：
  - 方案多处把“ADR 0234 第 2、4、8 条”当作硬性依据，但当前提交没有 `docs/adr/0234-*`，最高是 0227；`check:adr-numbers`/`docs-links` 将来会拦住引用。要么先把 ADR 0234 写出来，要么改成实际存在的 ADR。
  - A3 的 `job-host-messages.ts:17` 是 `JOB_HOST_RESULT_REASONS`，`forkJobHost` 在 `:22`。
  - 前提 A11 说“51 处（23 个文件，未逐处读）”，方案 item 3 又说“51 处逐处读”；两句话矛盾。实际 grep 还包含测试和 `info.uid !== 0` 的变体，且漏掉了 `sandbox-host-verifier.ts:159` 的 mode 检查。
  - “JupyterHub 由启动器给每个用户起独立账号或容器并限资源”不完全准确：JupyterHub 官方技术概览说默认 spawner 在系统用户名下起服务，另一种是容器；资源限制不是默认自带的。Anthropic 的 gVisor/凭据不进入沙箱有一手文章，但方案没有引用，且没有吸收“凭据不进沙箱”的结论。
- **建议**：补 ADR 0234 或改引用；修正 A3 行号；把 51 处检查列成“文件:行 + 路径类别 + 期望 owner/mode”，不要只写数量；引用 Anthropic `https://www.anthropic.com/engineering/how-we-contain-claude` 和 JupyterHub `https://jupyterhub.readthedocs.io/en/stable/reference/technical-overview.html`，并准确描述“默认账号/容器可配，资源限制需额外做”。

## 如果由我定，我会怎样改这份方案

1. **先做 spike，再写全量方案**：在测试机上用两个真实账号验证 bwrap/AppArmor、cgroup 隔离、nft、socket 激活、控制目录跨账号、27 字节私有根。任何一项失败，先停，不进入实现。
2. **把“隔离边界”从“每人一个 Linux 账号”改成“每人一个受限 systemd 服务 + 一次性/每任务沙箱”**：账号只是外层；网关 service 必须有 `NoNewPrivileges=yes`、`CapabilityBoundingSet=`、`ProtectSystem=strict`、`ReadWritePaths=<slot>`、`ProtectHome=yes`、`PrivateTmp=yes`、`RestrictSUIDSGID=yes`，并限制 `/tmp`/`$HOME`/`/var/tmp`/`/dev/shm`。
3. **socket 安全第一**：`SocketMode=0600`、`SocketUser/Group=himawari-prod`、父目录 root 0750、`SO_PEERCRED`、每 slot 路由、最大帧大小、`TriggerLimit`；网关只接受主服务，不接受执行账号。
4. **重做控制/证据协议**：控制目录、token、`started/final/launch-decision` 全部在网关；Worker 只拿不透明句柄和签名证据；删掉 Worker 对执行账号目录的 `lstat`/直接文件读；两阶段 prepare 解决 device/inode 顺序。
5. **不要用假 `ChildProcess`**：定义 `JobHostTransport`，本地 fork 和远端网关各实现；取消/强杀走网关 RPC；网关加 watchdog；所有消息按 job-host.v2 校验和限流。
6. **资源上限按层级重写**：每用户 slice（Memory/CPU/Tasks/IO）+ 父 slice 总闸 + 主服务 `MemoryMin`/`CPUWeight` + 服务级 `LimitNOFILE` + 全局并发准入；并发上限在本改动内落地，不要推给未完成的块 4。
7. **磁盘按 uid/独立卷做块 + inode 配额**；loop 镜像必须预分配、`nosuid,nodev,noexec`、fsck、备份、卸载顺序；`/tmp`、`$HOME` 等写路径由 systemd 沙箱关住；不要再用“稀疏镜像就是硬上限”。
8. **`slot` 做成 root 账本里的不可变标识**：`^[a-z][a-z0-9]{5}$`、保留 UID、禁止复用、服务端从认证用户派生；`remove` 墓碑化；所有消费点统一校验。
9. **root 应用器只做“受限增加”**：降低额度/缩容磁盘必须 root/人工确认；请求文件严格 schema/原子写/`O_NOFOLLOW`/属主模式；nft 先于 socket；单写机制 + 事务回滚 + 审计限速。
10. **密钥不进入执行账号**：注入移到出口/凭据代理，按人按任务短期 scoped token；否则明确残余风险。
11. **测试和发布门**：加 `check:multi-user-exec` 到 `check:steps`；纯测试 + root 特权测试 + 证据文件；反向用例覆盖 socket、跨账号读、nft、配额、root 应用器、prompt-prefix 新错误路径；生产 `per-person` 模式没有证据不允许启用。
12. **迁移单独出 runbook**：drain、快照、dry-run、逐人迁移、授权/绑定/路径更新、旧副本处理、回滚；`remove` 先停后删、卸载、导出、墓碑、uid 不复用。

## 必答问题

1. **会不会改变模型已经见过的请求开头？**
   **不会，前提是方案按 item 9 执行**：改动是服务端账号、目录、socket、nft、cgroup，不碰系统提示、工具定义、历史消息和遮盖规则；新错误文案只作为**新的工具结果**追加在末尾。依据 `prompt-prefix.md:35-36`（已发内容只能末尾追加）和 `production-runtime-tools.ts:2145-2222`（失败文案是新的 tool result）。但有两个必须守住的条件：不要把 `slot`、账号名、uid、绝对路径、限额数字写进系统提示/工具定义；不要把新文案加进 `packages/prompt-catalog` 的固定文字清单（会改变 `prompt-prefix.md:51-54` 的遮盖行为）。方案目前没有这两条检查，需要补。

2. **同一段文字会不会在不同请求里变成不同字节？**
   **当前方案有风险，需要约束**。新路径本身不引入时间/无序集合，但已有代码里 `sandboxCeilingExceededMessage` 会把每次的 `maxCpuTimeMs`/`maxMemoryBytes`/`maxOutputBytes` 拼进文案（`production-sandbox-tool-result.ts:153-174`），`production-background-commands.ts:469-475` 会把 `errorCode` 插进提示；如果新的 per-user 限额、slot、路径、uid 进入这些位置，同一事件在不同请求里就会产生不同字节。已发历史不会被改写，但新的工具结果会不同。建议把所有新错误码映射到固定字面量，禁止拼接账号/路径/uid/时间/额度；用测试逐条断言。

3. **有没有对应的自动检查，反向用例真的会失败吗？**
   **不够**。方案列了纯测试和真实账号测试，但没有命名门槛、没有加入 `check:steps`，真实账号测试在普通 CI 跳过；`check:prompt-prefix` 只覆盖一个文件（`scripts/check-prompt-prefix.mjs:9-11`），不覆盖新的沙箱错误路径；没有测试“A 连 B 的 gateway socket”“控制/证据跨账号”“磁盘配额绕过”“root 应用器 symlink/部分写”“生产配置 same-user 必须失败”。需要新增 `check:multi-user-exec`、root 特权测试和发布证据门；每个反向用例要实际跑出失败再修复，不能只写“检查必须失败”。

4. **每个新值的使用方都能接受吗？**
   **不能，至少这几处现有消费者会直接拒绝或误用**：
   - `control.directory`：`production-sandbox-control.ts:902-909`、`job-host-control.ts:70-77`、`job-host-launch-decision.ts:48` 的所有者/模式检查；`readJobHostFinalEvidence` 直接读 0600 文件；`queryJobHostControl` 直接连 0700 目录里的 socket。
   - `privateRoot`：`sandbox-host-verifier.ts:159` 拒绝 2770 的 group-writable；`:160` 要求 owner 是当前/root；`production-sandbox-services.ts:183-190` 要求唯一 `hostId`；`production-workspace-copies.ts:142` 依赖 `privateRoot/workspace-copies`。
   - `LimitNOFILE`：放 slice 不生效（systemd.exec 的适用范围不含 slice）。
   - socket：systemd 默认 `SocketMode=0666`，任何执行账号可连。
   - `slot`：没有字符集/uid 映射/不可变性，可能路径穿越、账号名非法、uid 复用。
   - nft：`meta skuid` 依赖固定 uid，账号重建后可能失效。
   - `exec.json`：没有定义单位（bytes/百分比/整数）和上下限，`MemoryMax`/`CPUQuota`/`TasksMax` 的合法值不同。
   这正是 I-73 的同类问题：只看了新值，没有逐个问“清单里的 id 能通过后端校验吗”（`docs/incidents-and-gates.md:112`）。按当前方案直接实施，会在控制目录、私有根、`hostId`、socket 权限、`LimitNOFILE` 这几处先失败；需要先建立“值 → 生产者 → 所有消费者 → 校验”的清单，再改代码。
