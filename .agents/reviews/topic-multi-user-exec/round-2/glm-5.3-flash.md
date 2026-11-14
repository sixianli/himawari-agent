# 审核结论：多人执行账号整合方案（v2）

先说侧重检查的做法和总体：我按「一条普通命令的完整生命周期」从入口走到结束，并逐条核对了方案引用的前提。**方案引用的仓库内前提 A1–A5、A7–A10、A12–A14 我全部逐处核实为真**（见各项标注）；**A11（51 处检查）方案自己承认未逐处读，我未核实**；**A15/A16（内核 NoNewPrivileges、systemd OOM 行为）为外部引文，我未逐字核对**。但方案有两个引用是**证实有误**的，另有多个消费端被漏掉。按严重度排列如下。

---

## 高严重度

### H1.「agent-service 也是控制目录/证据的消费端」被方案整个漏掉，现状代码会直接坏
- **证实。** 方案第 3 条只写「Worker 经套接字拿证据字节，不再进别人账号的目录」，但控制套接字和证据文件的消费端不止 Worker：
  - `apps/agent-service/src/production-sandbox-control.ts:366,389` 调 `queryJobHostControl`（页面上的停止/巡检），`:392,807` 调 `readJobHostFinalEvidence`，`:430` 调 `readJobHostStartEvidence`（崩溃检测），`:448` 经 `readProcessStartToken`（`packages/runtime-sandbox/src/process-identity.ts:33` 读 `/proc/<pid>/stat`）核对进程身份。
  - `packages/runtime-sandbox/src/job-host-control.ts:75` 的校验是 `(typeof process.getuid === "function" && metadata.uid !== process.getuid())`，`:74` 还要求 `(metadata.mode & 0o077) !== 0` 即 0700。控制目录改成执行账号属主后，主服务账号调用这些函数**必然**抛 `JOB_HOST_CONTROL_DIRECTORY_INVALID`——停止按钮、巡检、崩溃恢复全部失效。
- **建议：** 接口一节必须补「块 3（agent-service 控制通道）」：`inspect/stop`、启动证据、终结证据都改为经网关套接字代理（或由网关把签名证据字节经套接字交回主服务），并把「网关拒绝非本人 uid 的控制请求」写进反向用例。

### H2. 网关套接字没有任何准入设计：本机任何能连上套接字的进程都能以 `hx-<slot>` 身份执行命令
- **证实（设计缺失）。** 今天三处 `forkJobHost` 入口都在进程内（`job-host-messages.ts:22`、`job-host.ts:93`、`job-host-session.ts:86`，已核对），没有网络边界；改成「收 Worker 的 `JobHostRequest`」的套接字服务后，`JobHostRequest` 里带着 `stdinBase64`（**含注入的密钥**，A5：`apps/execution-worker/src/program-secret-injection.ts:53`；经 `production-sandbox-execution-v2.ts:504-512` 打进请求），收到请求就等于能在该人的工作区里跑命令。方案没写：套接字文件的属主/模式（systemd 有现成的 `SocketMode=`、`SocketUser=`、`SocketGroup=`，见 https://www.freedesktop.org/software/systemd/man/latest/systemd.socket.html ）和网关内 `SO_PEERCRED` 对端 uid 校验。
- **建议：** 套接字 `SocketMode=0660`、属主 root:主服务组；网关 accept 后用 `SO_PEERCRED` 校验对端 uid 等于主服务账号，不符直接断开；给「非主服务账号连接必须被拒」写自动反向用例。同时明说：密钥从今天起会流经网关进程内存——逃逸者与网关同 uid（能读 `/proc/<gateway>/mem`），这个信任域变化要写进方案的风险节。

### H3. 预热环境和「网关空闲自动退出」直接冲突，内存预算的前提因此不成立
- **证实。** 预热环境要活 60 分钟：ADR 0139 写明「预热环境从预热那一刻起活 60 分钟（宿主上限）」（`docs/adr/0139-prewarmed-environment-outlives-background-commands.md:78`），预热代码在 `apps/execution-worker/src/production-sandbox-execution-v2.ts:1324-1394`，走的是 `forkJobHost` 同一入口。而 systemd 的行为是：「If set to `control-group`, **all remaining processes in the control group of this unit will be killed on unit stop**」（https://www.freedesktop.org/software/systemd/man/latest/systemd.kill.html ，我逐字核对）。socket 激活服务主进程退出即视为停止单元，同 cgroup 里的预热 job-host 会被一起杀掉。
- 连带后果：方案的内存账「20 个人都注册放得下，限制的是同时在执行命令的人数」建立在「网关空闲就退出、不占内存」上；实际是一个人只要 60 分钟内用过命令，就有一个 job-host 常驻 + 网关不能退，同时在线人数 ≈ 常驻进程数，预算要重算。
- **建议：** 网关不能实现「空闲自杀」；改为「无预热、无任务才退」，或预热改由常驻的单人网关托管，内存账按「最近 N 分钟活跃人数」重算，并把这条列入测试机实测。

### H4. 方案的硬性要求出处 ADR 0234 在仓库里不存在
- **证实。** `docs/adr/` 全目录到 0227 为止（我列过全部文件名），全仓库按 `.md` 搜「0234」零命中。方案至少四处把「ADR 0234 第 4、8 条」当硬约束（磁盘硬上限、管理页改上限、全机并发数、单人上限之和），「要 Andy 拍板的事」和「接口对齐」整节都架在这份不存在的文档上。要么是未提交的草稿，要么引用错了——无论哪种，审核者无法核对「做不到就不给别人开通」是不是真要求。
- **建议：** 先把 0234 的原文落进仓库或改引真实文档；在它落地前，方案里凡写「ADR 0234 要求」的地方降级为「建议」。

### H5.「`forkJobHost` 抽成接口」严重低估：`ChildProcess` 契约承载着监督认证和诊断，跨套接字转发会破坏它
- **证实。** `prepareSandboxJobHost`（Worker 里）对返回的 `ChildProcess` 的依赖不只是「起进程」：
  - `job-host.ts:254` 用 `processId: child.pid` 做信封认证（`authenticateJobHostEnvelope` 要求 `message["processId"] === expected.processId`，`job-host-messages.ts:51`）；跨套接字后 Worker 手里没有真实 pid，整条身份校验（`:474-476` 的 `JOB_HOST_IDENTITY_CHANGED`、证据里的 `processId`）要重新设计；
  - `:241-245` 读 `child.stderr` 做诊断尾部；`:139,392,150` 依赖 `exit/error/connected`；`:133` `killGroup` 用负 pid 发信号——Worker 侧这些在远端化后全部变成对网关的 RPC 语义。
- 方案一句「网关转发回套接字」没有覆盖：双向中继（心跳、输出块、authority_check/authority_result 的低延迟往返）、远端 pid 的传递、stderr 尾、断线语义。
- **建议：** 把抽象定义为显式协议（握手时网关回报 job-host 真实 pid、bootId；`send/on` 双向中继；`connected` 映射为套接字状态），并按 `job-host.ts` 现有的逐字段校验风格给协议写双向用例；方案要明确认证锚点从「同进程 fork 信任」换成什么。

---

## 中严重度

### M1. per-person `privateRoot` 没有贯通到现有绑定/校验链
- **证实（缺失）。** `privateRoot` 不是随手传的字符串，而是能力绑定合同的一部分（`packages/execution-contracts/src/sandbox-host-binding-v1.ts:83`），由 `packages/platform-node/src/capabilities/capability-deployment.ts:1070` 做 27 字节预算检查；Worker 从 `binding.privateRoot` 派生私有目录和控制目录（`production-sandbox-execution-v2.ts:391,416-420`）；agent-service 还反向校验控制目录必须落在 `binding.privateRoot` 内（`production-sandbox-control.ts:880`）。方案只写了根路径长什么样（26 字节 ≤ 27，我核算成立），没写「每个一人的根怎么进绑定、27 字节检查在哪一层按人跑」。
- **建议：** 接口一节补：绑定按 slot 参数化或按人渲染，`CAPABILITY_DEPLOYMENT_INVALID_VALUE` 预算检查的输入变成每人根，测试覆盖「第 20 个人目录超长被拒」。

### M2. 第 9 条「不改发给模型的内容」不准确：per-person 工作区会改「工作目录」行
- **证实。** 工作区路径是模型可见的：`packages/prompt-catalog/src/chat.ts:176` `- 工作目录：{workspaceRoot}`，进 `runtimeEnvironmentNotice`（`apps/agent-service/src/production-run-policy.ts:204-216,83-89`），值来自目录授权的 `displayPath`（`production-run-policy.ts:241-265`）。迁移 Andy 的授权路径、给 20 个人各发新路径，都会让这段说明变化。
- **规则上仍合规**：该说明只在内容变化时重发、且位于最后一条用户消息（`.claude/rules/prompt-prefix.md`：「运行环境说明只在变化时发」），所以**只追加不被破坏**——但方案宣称的「不改发给模型的内容」应改为「只在末尾追加的新说明里变化」，并把 slot **一次性分配、永不复用**写成硬规则（slot 变了 = 路径变了 = 对话中途说明变化 + 授权失效）。
- **建议：** 第 9 条改写；接口一节加「slot 不可变」；上线说明里预告 Andy 现有对话的一次性缓存失效。

### M3. 控制令牌的生产者归属没写，存储链会被打断
- **证实（缺失）。** 今天令牌由 Worker 生成（`production-sandbox-execution-v2.ts:473-475`），并经 `register_preparation_control` RPC（`:482-487`）交给 agent-service 存进数据库，供 `readControl(plan)` 读回（`production-sandbox-control.ts:386`）。网关方案下「控制目录由执行账号建、网关内部使用」——那令牌谁生成、怎么回到 agent-service 的数据库？方案没写。若网关生成，回传链（套接字 → Worker → RPC → DB）要新建；若 Worker 仍生成，网关「建目录」就自相矛盾（目录名含 `control-<20位>`，由 Worker 现在算，`production-sandbox-execution-v2.ts:416-418`）。
- **建议：** 明确：令牌仍由 Worker 生成（保住现有 DB 链），网关只按 Worker 给的目录名建目录并起控制服务；「执行账号建」指的是目录创建动作发生在网关账号下。

### M4. 组权限方案对 umask 的依赖没写（推测）
- **推测。** 2770 只作用于方案里建的那一层目录；执行账号在 `work/` 里新建的子目录/文件按网关单元的 umask 生成，umask 022（主服务单元现值，`scripts/delivery-mode/packet-template/systemd/himawari-prod.service.draft:11`）会让嵌套目录变成 755——主服务「靠组访问」对子树失效，且方案明确不用 ACL，没有兜底。需要网关单元 `UMask=0002` + 目录 setgid 继承，并在真实账号测试里加「执行账号建的嵌套文件主服务必须可读写」的正反用例。

### M5. 现有 integration 套件会大面积失配，方案的测试清单没有列迁移（侧重发现）
- **证实（缺失）。** 控制/准备/证据相关的现有套件都是单账号模型：`test/integration/sandbox-preparation-control.test.ts`（多处以 Worker 建目录为前提）、`sandbox-preparation-seal.test.ts`、`sandbox-control-evidence.test.ts`、`sandbox-execution-v2.test.ts`、`sandbox-v2-worker-lifecycle.test.ts` 等（各文件大量 `privateRoot: root` 夹具）。控制目录创建从 Worker（`production-sandbox-execution-v2.ts:420`）移走、证据改走套接字后，这些都要重构。方案「纯测试」清单只列了新增项，没列这批改动。
- **建议：** 测试一节加「现有套件迁移清单」，并把「agent-service 控制通道经网关」加进纯测试（协议层可测，不需要真 root）。

### M6. 网关不可达窗口期，取消没有兜底（推测，行为可推断）
- **推测。** 网关崩溃时 `KillMode=control-group` 清场（systemd.kill 已核对）；但「崩溃到 systemd 完成清理」的窗口里，Worker 的 `killGroup`（`job-host.ts:130-135`，`catch {}` 吞错）跨 uid 永远 EPERM，等于没有兜底，只剩 deadline 计时。方案第 2 条的取消故事缺这个中间态。建议：Worker 对「cancel 发不出去/网关连接断」写显式日志与告警（对照 I-50 的教训：静默吞错查了一天）。

---

## 低严重度

- **L1.** `execution.accounts.mode` 是新配置键，方案没提它进哪个校验（配置 schema、`check:product-path-configuration`、还是新门槛），「生产只能 per-person」的检查没有落位（Q3 相关）。
- **L2.** root 所有的 `/etc/himawari/exec.json`：主服务（无 root）要读它来做块 4 的程序内用量，方案没写读取权限（0644 即可，但要写明）。
- **L3.** 磁盘镜像方案缺开机生命周期：loop 挂载要 systemd mount 单元 + 与网关单元的启动顺序依赖；在线扩容（ext4 resize2fs 可在线）与「主服务重启后镜像没挂上」的失败表现未写。
- **L4.** `useradd` 的账号名规则（`hx-<slot>` 全小写字母数字）意味着 slot 字符集必须受限——方案只说 6 位，没说字符集校验；nft `skuid` 需要数值 uid（开通工具解析，已核对先例 `scripts/operations/ci-runner/runners.sh:61-63` 的写法成立）。

---

## 核对无误的部分（不改的依据成立）

- A1/A2：单元草稿确有 `User=himawari-prod`、`NoNewPrivileges=yes`、`CapabilityBoundingSet=`，且无任何 `MemoryMax/CPUQuota/TasksMax`。
- A3：`forkJobHost` 恰好一定义两调用（`job-host-messages.ts:22`、`job-host.ts:93`、`job-host-session.ts:86`）。
- A4：`process.kill(-pid, "SIGKILL")` 外层 `catch {}`（`job-host.ts:130-135`）。
- A5/A6/A7/A8/A9/A10/A12/A13/A14：逐处核对原文属实（含 27 字节预算表、`/proc` 起点限额、runbook「采样不能证明硬配额」、ADR 0145:41 生产机规格、ADR 0117:114）。
- 我额外核对了一个方案没提但隐含依赖的点，结论是**安全的**：`processGroupPresent`（`process-identity.ts:53-63`）用 `kill(-pgid, 0)`，跨 uid 时 EPERM→「存在」、ESRCH→「不存在」，语义恰好保持，不用改。

---

## 如果由我来定

1. **先补文档再立项**：把 ADR 0234（或替代文档）落进仓库，否则砍掉所有「0234 要求」的硬约束（磁盘镜像方案推迟，第一版用实测 + 主服务程序内限流）。
2. **第一版接口必须包含三个被漏掉的消费端**：agent-service 控制通道（H1）、网关套接字准入（H2）、预热生命周期（H3）。任何一条没设计完就不动代码。
3. **网关协议先写成合同**：握手回报真实 pid/bootId、双向中继、stderr 尾、对端 uid 校验、断线语义，按 `job-host.ts` 的逐字段校验风格出合同包 + 双向用例，再写实现。
4. **令牌生成留在 Worker**，网关只按目录名建目录；slot 一次性分配、字符集受限、永不复用；per-person `privateRoot` 的绑定化进接口。
5. 管理页改上限的 root 应用器**推迟到第二版**——它是一条新的提权通道，而它的需求出处（ADR 0234 第 8 条）目前不存在。

## 必答问题

1. **前缀**：系统提示、工具定义、历史、遮盖都不动；但 per-person 工作区会改变最后一条消息里运行环境说明的「工作目录」行（`chat.ts:176`，`production-run-policy.ts:213-214`），变化仍只出现在末尾、只在变化时重发，满足只追加——前提是 slot 稳定。结论：基本合规，但方案第 9 条的「不改」表述错误，需改写并预告一次缓存失效；`check:prompt-prefix` 不受影响的判断成立（开发/测试仍是 same-user）。
2. **字节稳定性**：per-person 路径由固定 slot 确定性派生；错误文案固定；未见无序集合或时间进入模型可见内容（证据里的 `observedAt` 等不进上下文）。通过，附「slot 不可变」前提。
3. **自动检查**：方案列了反向用例（额度数字、目录放宽），机制可行；但 `execution.accounts.mode` 检查和「不写死额度数字」检查都没指明落在 `npm run check` 家族的哪一道；真实账号用例在 CI 跳过，跨账号路径 CI 覆盖为零（方案部分承认）；现有 integration 套件的重构未列（M5）。
4. **逐值核对**：slot（缺字符集/不可变规则）、`execution.accounts.mode`（缺 schema 落位）、控制令牌（生产者归属未写，M3）、per-person `privateRoot`（贯通缺失，M1）、磁盘镜像（缺挂载生命周期，L3）、exec.json（缺读取权限，L2）、`exec-ceilings.json`/nft 端口（两端校验齐全，通过）。后端校验核对到的问题是「方案没写两端怎么接」，与 I-73 的教训同型：清单/配置里的值必须能通过另一端现有校验，方案对 `sandbox-host-binding-v1` 和 `job-host-control` 的校验面完全没有接上。
