你是独立的方案设计者。
你能用的工具：read、grep、glob、websearch、webfetch，以及 git diff、git log、git show、git blame、git status 这几条 git 命令。不能修改任何文件，不能运行别的命令。可以用 websearch 搜索、用 webfetch 读网页；业界做法只认一手来源（官方文档、各大 AI 公司的工程文章、成熟开源项目的源码），每条都附网址。
下面只给了问题、目标和约束，没有给出任何人的方案；材料里如果提到某种做法，只作参考。先读代码弄清现状，再独立提出你认为最好的方案，不要假设已经有人想好了答案。
做法：先想清楚要回答哪几个问题、需要看哪些文件或资料，再直接去读这些地方；不要漫无目的地浏览代码，也不要用相同或相近的参数反复调用工具。读到的内容一旦足以下结论，就停止调用工具，写出结论；没读到的地方标「未核实」，不要为了查全而一直查下去。
列出的方案只是参考，请从问题本身出发，提出你认为更好的方案。
必答问题：
1. 这个改动会不会改变模型已经见过的请求开头？包括系统提示、工具定义、历史消息、遮盖结果。要求回答：发给模型的内容是不是仍然只在末尾追加，每轮会变的值是不是都在最后一条消息里。依据：[发给模型的内容只追加](../../.claude/rules/prompt-prefix.md#rules)。
2. 这个改动会不会让同一段文字在不同请求里变成不同的字节（例如依赖前后文的遮盖、带时间的字段、无序的集合）？
3. 改动有没有对应的自动检查，反向用例是否真的会失败？
4. 改动产生或修改的每个值（标识、字段、配置键、清单项、序列化格式），每一个使用它的地方都能接受吗？逐个找到产生它的地方和使用它的地方，核对两端的校验，只看改动本身不够。依据：[I-73](../../docs/incidents-and-gates.md#incidents)，双模型复核只看了改动，没问“清单里的 id 能通过后端校验吗”。
输出格式：先列方案依赖的前提，每个前提附来源（文件:行或网址）和原话；再写方案本身、考虑过但不选的做法及原因、风险和反例、需要人拍板的取舍。把「读代码或来源证实的」和「推测」分开写。最后逐条回答必答问题。用简体中文。

---- 本次材料 ----
仓库就是当前目录，已检出 2997b499a8b26037ff7545cfd5aefaee3b4e7be7。
问题、目标和约束：
# 问题：Himawari 同一台服务器上，怎样让每个人执行命令时用自己专属的系统账号，并有内存、CPU 的硬上限

## 背景

Himawari 是一个个人 Agent（一个服务，模型会调用工具，包括在沙箱里执行 bash 命令）。现在只服务一个主人（Andy）。Andy 已决定扩成 10 到 20 个受邀的人用，同一个程序、每人一个数据库文件、全部放在**唯一一台生产机**上（Andy 不想为此多租服务器）。这个任务只管其中一块：**每个人的命令在哪个系统账号下跑、怎样限制资源**。别的块（按人组装服务、登录找人、按人迁移、费用上限）由别的线程做。

## 已定的目标（Andy 同意，不用再讨论“要不要做”）

1. 每个人执行命令时，进程用这个人专属的系统账号（Linux 用户）运行。即使有人从沙箱里逃出来，逃出来的也只是那个专属账号，读不了任何人的数据库、密钥，也读不了别人的工作目录。
2. 每个账号有内存、CPU、进程数的硬上限（不是采样观察）。一个人把命令跑满，不能拖垮别人和主服务。
3. 上限的数值**不许写死在代码里**，要能由 Andy 配置；加人、改上限不能要求停服。
4. 加一个人不能要求重启主服务（现在设计的目标是：一条命令建好账号和目录，对方登录就能用）。

## 约束

- 唯一生产机：Ubuntu 24.04，4 个 CPU，约 8 GB 内存（`docs/adr/0145-*.md:41`）。Ubuntu 24.04 的 AppArmor 限制了非特权用户命名空间（`.agents/instructions/test-and-production-hosts.md` 里写了“带有 AppArmor 对用户命名空间的限制”），沙箱用 bubblewrap（用户命名空间）实现。
- 不为这件事多花钱，不上虚拟机每人一台（Andy 原话：只有一台生产机，不想再多花钱）。
- 这个任务只出代码和脚本，**不碰生产机**；生产机上的真实验证以后由别的线程在 Andy 授权下做。开发容器里能用 root 建用户、用 `setpriv` 以别的用户身份起进程，但没有 systemd 作 PID 1，也没有 bubblewrap。
- 发给模型的内容只能往后追加（`.claude/rules/prompt-prefix.md`）：这个任务不应该改变模型已经看到的请求开头。
- 不许写死能动态获取的值（清单、阈值、额度）。
- Andy 极在意钱和“多余的人工步骤”。他自己会运行 root 权限的部署脚本，但日常不想手动点。

## 已核对的现状（main 2997b49，所有路径相对仓库根）

- 主服务现在是一个 systemd 单元里的两个进程（Agent 和 Worker），都以同一个账号 `himawari-prod`（uid 999）运行，`NoNewPrivileges=yes`，`CapabilityBoundingSet=` 为空，没有 `MemoryMax`、`CPUQuota`、`TasksMax`：`scripts/delivery-mode/packet-template/systemd/himawari-prod.service.draft`。
- 用户命令的实际运行路径：Worker 用 `forkJobHost(request)`（`packages/runtime-sandbox/src/job-host-messages.ts:17-33`，Node 的 `child_process.fork`，带 IPC 通道）起一个 job-host 子进程，job-host 再用 Anthropic 的 sandbox-runtime（SRT，底层 bubblewrap）包起命令执行（`packages/runtime-sandbox/src/job-host-main.ts:565-576`）。所以**命令现在和 Worker、数据库、密钥目录是同一个 uid**。三处调用 `forkJobHost`：`job-host.ts:93`、`job-host-session.ts:86`，以及 job-host-main 里的 readiness 探针（`readiness-probe.ts:53` 直接 spawn）。
- Worker 取消任务靠 `process.kill(-pid, "SIGKILL")` 杀 job-host 的进程组（`job-host.ts:130-137`），跨账号时这一步会被拒绝。
- 沙箱策略（`packages/runtime-sandbox/src/policy.ts:156-191`）：`denyRead: ["/", ...protectedPaths]`，只允许读工作区、私有目录和只读工具链路径；写只允许工作区（可写时）和私有目录；网络走域名白名单（`strictAllowlist: true`）。
- 需要密钥的程序类能力，密钥由 Worker 在每次运行前读出，拼进 job-host 的标准输入 JSON（`apps/execution-worker/src/program-secret-injection.ts`），不是让沙箱自己读密钥目录。但 Worker 本身用 `SystemdProviderSecretSource(path.join(configuration.stateRoot, "secrets"))` 读整个密钥目录（`apps/execution-worker/src/production-worker-composition.ts:300`）。
- 很多地方检查“文件所有者必须是当前账号或 root”：`grep -rn "getuid\|\.uid" apps/*/src packages/*/src` 在 23 个文件里有 51 处，包括 `packages/platform-node/src/files/constrained-file-system.ts`、`pi-file-publication.ts`、`pi-output-export.ts`、`directory-move.ts`、`packages/runtime-sandbox/src/job-host-launch-decision.ts:148`、`job-host-control.ts`、`apps/agent-service/src/production-sandbox-control.ts` 等。工作区和私有目录的所有者如果变成别的账号，这些检查要一个个审。
- 私有目录（每个任务一个）由 Worker 创建（`apps/execution-worker/src/production-sandbox-execution-v2.ts:1094-1095`），任务结束后 Worker 删除（`production-srt-task-environment-backend.ts:289`）。
- 工作区授权记录里存绝对路径（`apps/agent-service/src/production-run-policy.ts:241-250`）。
- 沙箱对网络的限制由 job-host 里的出口代理实现（`packages/runtime-sandbox/src/egress-proxy-main.ts`、`network-egress.ts`）。主模型走本机的 Magpie（只监听本机，不检查访问密钥，`docs/adr/0117-*.md:114`），所以任何能连到本机端口的进程都能直接用 Andy 的模型额度。
- 运行手册写明：沙箱资源观察只是采样，不能证明硬配额（`docs/runbooks/install-start-stop-runbook.md:263`：“采样不能证明硬配额”）。
- 开发测试在 CI 自托管 runner（普通账号，不一定有 root 和 sudo）和 Hermes（Andy 的另一台 Linux 测试机）上跑；Mac 上不跑测试。

## 想请你回答

1. 怎样让命令真正用每人专属账号跑起来。主服务账号没有任何特权（`NoNewPrivileges`，空 capability 集合），所以“怎样在不给主服务提权的前提下换账号”是核心。请比较你能想到的办法（例如 systemd socket 激活的每人一个服务、systemd-run、polkit、setuid/sudo 小帮手、每人一个常驻 worker、容器、gVisor 等），说明各自的信任边界、延迟、运维负担、失败时怎样。
2. 目录和文件权限怎么分：数据库和密钥、工作区、私有目录、日志、临时文件各归谁、什么权限、主服务怎样读写工作区里别人（沙箱里的命令）产生的文件；加一个人不重启主服务的前提下，怎样让主服务和那个人的执行账号都能访问同一个工作区，而别的人的执行账号不能。
3. 资源硬上限怎么实现和配置（内存、CPU、进程数、磁盘、文件描述符、网络），超限时用户看到什么，怎样不让“一个人的 OOM 杀掉别人的进程或主服务”；数值放哪里、怎样让 Andy 改后生效、是否需要 root 才能生效。
4. 怎样防止执行账号连到主服务的内部端口和 Magpie（绕过按人用量上限），同时不破坏沙箱里正常的联网（域名白名单）。
5. 取消、超时、崩溃后的清理：怎样保证一个人的所有残留进程都被杀干净，Worker 与执行端的心跳和进程身份核验（`job-host.ts`、`process-identity.ts`）怎样适应。
6. 在开发容器和 CI 里怎样测试：哪些能用真实账号测，哪些只能在 Hermes 或生产机上测；怎样让“A 的账号读不到 B 的目录和数据库”变成会失败的自动检查，并带反向用例。
7. 失败、回滚：没有 systemd 单元、账号不存在、资源上限设错时，系统应拒绝启动还是退回同账号运行？
8. 有没有更好的、不在上面任何一种里的思路；以及这个任务里你觉得**风险最大、最该先实测**的三件事。
