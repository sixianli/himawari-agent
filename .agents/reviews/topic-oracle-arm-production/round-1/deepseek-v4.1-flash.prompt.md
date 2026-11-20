你是独立的方案设计者。
你能用的工具：read、grep、glob、websearch、webfetch，以及 git diff、git log、git show、git blame、git status 这几条 git 命令。不能修改任何文件，不能运行别的命令。可以用 websearch 搜索、用 webfetch 读网页；业界做法只认一手来源（官方文档、各大 AI 公司的工程文章、成熟开源项目的源码），每条都附网址。
下面只给了问题、目标和约束，没有给出任何人的方案；材料里如果提到某种做法，只作参考。先读代码弄清现状，再独立提出你认为最好的方案，不要假设已经有人想好了答案。
做法：先想清楚要回答哪几个问题、需要看哪些文件或资料，再直接去读这些地方；不要漫无目的地浏览代码，也不要用相同或相近的参数反复调用工具。读到的内容一旦足以下结论，就停止调用工具，写出结论；没读到的地方标「未核实」，不要为了查全而一直查下去。
列出的方案只是参考，请从问题本身出发，提出你认为更好的方案。
必答问题：
1. 这个改动会不会改变模型已经见过的请求开头？包括系统提示、工具定义、历史消息、遮盖结果。要求回答：发给模型的内容是不是仍然只在末尾追加，每轮会变的值是不是都在最后一条消息里。依据：[发给模型的内容只追加](../../.agents/instructions/prompt-prefix.md#rules)。
2. 这个改动会不会让同一段文字在不同请求里变成不同的字节（例如依赖前后文的遮盖、带时间的字段、无序的集合）？
3. 改动有没有对应的自动检查，反向用例是否真的会失败？
4. 改动产生或修改的每个值（标识、字段、配置键、清单项、序列化格式），每一个使用它的地方都能接受吗？逐个找到产生它的地方和使用它的地方，核对两端的校验，只看改动本身不够。依据：[I-73](../../docs/incidents-and-gates.md#incidents)，双模型复核只看了改动，没问“清单里的 id 能通过后端校验吗”。
输出格式：先列方案依赖的前提，每个前提附来源（文件:行或网址）和原话；再写方案本身、考虑过但不选的做法及原因、风险和反例、需要人拍板的取舍。把「读代码或来源证实的」和「推测」分开写。最后逐条回答必答问题。用简体中文。

---- 本次材料 ----
仓库就是当前目录，已检出 34f2e1411ce45e483eae0d3cbb3418343c0ad67e。
问题、目标和约束：
# 方案讨论材料：把 Himawari 生产从 x86-64 主机迁到 ARM64 主机

## 问题

Andy 要把生产从 Contabo 的 x86-64 云服务器迁到 Oracle 东京的 ARM64 虚拟机，第一阶段只做兼容性检查、部署、数据同步和验证，不切流量。2026-11-20 线程做兼容性检查时停下了：项目的出包、安装和封存流程只支持 x86-64 和“升级一台已在运行的生产机”，没有受支持的路径能在一台新的 ARM 机上装好并重新验收。请设计让生产能迁到这台 ARM 机所需的代码改动和运维步骤。

## 目标

1. 出包、安装、封存（生成安装回执）、启动前检查、上线前检查、回滚、清理这一整条链能以 linux-arm64 为目标平台，x86-64 的现有生产行为不变。
2. 能在一台从没装过 Himawari 的新主机上完成第一次安装和验收。
3. 第一阶段：在 ARM 机上装好、同步一份数据、在沙箱里验证问答、网络搜索、网页抓取、文件读写、记忆读写，不影响仍在服务的 Contabo。
4. 第二阶段（只设计不执行）：把流量和数据的主控权切到 ARM 机。

## Andy 定的约束（原话来自本次任务）

- 启动前检查 `cloud-protected-prepare` 的断言不许绕过、不许改代码跳过；要按项目自己的验收流程在新机器上重新验收、生成新机器的安装回执。项目没有受支持的流程就停下报告，不许自己发明绕法。
- cloudflared（Cloudflare 隧道客户端）的 token 绝不能在新机器上用 Contabo 那份启动：同一个 token 起第二个连接器会把生产真实流量分走。第一阶段的验证用单独的测试隧道或 SSH 端口转发。
- `himawari-heartbeat.timer`（每分钟向 hc-ping.com 报心跳）在并行期不在新机器上启用。
- 新机器副本上的定时任务和主动推送全部禁用；并行期不许发重复消息，不许和 Contabo 双写同一份数据。
- 数据同步用一致性备份（例如 SQLite 的 backup），同步后核对文件大小和关键表行数。
- 机密内容绝不打印。
- 部署方式照搬 Contabo 的 systemd 模型，不用 pm2。
- 新机器上已有别人负责的 CI runner 和服务，不能动。

## 项目规则（摘要，原文见括号里的文件）

- 大改动先出方案、和 Andy 讨论后才动代码（`.claude/rules/owner-standing-rules.md`）。
- 修根本原因，不加特殊情况或后备处理压症状；涉及第三方行为时按锁定版本查官方文档。
- 生产上线只能用 `scripts/delivery-mode/make-packet.py` 生成的上线包和 `scripts/delivery-mode/deploy.sh`，上线包不手工编辑（`.agents/instructions/delivery-mode.md` 的“快速模式”一节）。
- 服务器端的构建和测试不在 Andy 的 MacBook 上跑；测试在 Hermes（x86-64，Ubuntu 22.04）上跑。
- 禁止按 token 付费调用贵模型。

## 已核实的事实（线程 2026-11-20 读代码或在机器上实测）

代码（提交 `34f2e1411ce4`）：

- 安装脚本只认 x64：`scripts/delivery-mode/packet-template/install/__PKT_LABEL__-artifact-install.mjs:14` 和 `install/collect-installer-dependencies.mjs:15` 要求 `process.arch === "x64"`。
- 候选包只在 Hermes 上构建，只取 x64 产物：`scripts/delivery-mode/hermes/build-candidate.sh:17` 核对主机名，`:44-46` 只找 `linux-x64-abi127-<提交>-*-1.tar.gz`；`make-packet.py:509,552` 和 `run-packet-checks.py:166` 同样。
- Node 运行时不在包里：`packet-template/install/p5-materials.json:5` 是 `"nodeAlreadyInstalled": true`，`:6` 写死 x64 的 Node 摘要，这个摘要出现在 `packet-template/` 下 9 个文件里。
- `ci/toolchain-lock.json` 已经有 Node 22.22.3 和 Python 3.12.10 的 `linux-arm64` 条目。
- better-sqlite3 在构建机上从源码编译（`ci/toolchain-lock.json` 里它的 `"decision": "build"`，理由是不下载未校验的预编译包）；`rename-native` 是项目自己的 C 程序，`scripts/package-node-runtime.mjs` 在构建机上用 `cc` 编译。
- 包里的 `pi-tools/bin/` 由 `packet-template/acceptance/cloud/prepare-runtime-tools.py:49` 组装：node、`/usr/bin/bash`、`/usr/bin/rg` 从系统复制，`fd` 用 `acceptance/cloud/question-12-inputs.json:13` 钉住的 `fd-v10.5.0-x86_64-unknown-linux-musl`。
- 上线包生成要求目标机已有运行中的服务：`make-packet.py:329` `refuse('PACKET_SERVICE_NOT_ACTIVE', ...)`；上线前检查 `deploy-preflight.py:178` 也要求服务 active，并读旧的 `authority.json`。项目里没有“新主机第一次安装”的上线路径。
- 目标主机身份只来自实例文件 `scripts/delivery-mode/instances/andy-production.json`（地址、主机名），由 `make-packet.py` 渲染进模板。
- 封存脚本 `packet-template/signing/cloud-seal.mjs:342` 在只读目录清单里无条件写了 `/lib64` 并取真实路径；`:34` 核对主机名；`:195` 写死 `/usr/bin/bwrap` 等系统工具路径，`:204-208` 要求 `/usr/local/libexec/bubblewrap-0.11.2/bwrap` 和 AppArmor 配置 `/etc/apparmor.d/bwrap`、`/etc/apparmor.d/bwrap-0.11.2`；`:496-499` 把主机名、架构、内核版本写进回执。
- 启动前检查 `packet-template/signing/cloud-protected-prepare.mjs:38-41` 断言主机名、平台、架构、内核版本都等于回执。
- `deploy-preflight.py:16-17` 读 `/boot/grub/grub.cfg` 和 `/boot/grub/grubenv`，拦下“重启后进的内核不是当前内核”的上线。
- `docs/adr/0253-support-linux-arm64-for-test-and-qualification.md` 决定把 linux-arm64 支持为测试和资格验收平台、“线上不切换”，并计划由第 4 条（PR 3）让出包、安装和资格验收认 linux-arm64，ARM 包标为非生产候选；这一条没有落地。它的第 2 条已经在 `packages/testing/src/read-only-toolchain.mjs` 加了“可选的 `/lib64` 不存在时跳过”的函数，但只给测试夹具用。
- `scripts/platform-assumptions.json` 列出了全仓写死 `/lib64`、`linux-x64`、x64 架构、固定主机名的文件和次数，`npm run check:platform-assumptions` 按次数拦。
- `docs/runbooks/authority-transfer-runbook.md`：停机加密的主控权迁移（export、import、activate），目标的 authority epoch 和 fencing token 各等于源值加一，源先置为 `retired_pending_transfer`；迁移包不携带机器机密、可执行文件绑定或平台资格，目标机要先独立装好。
- `docs/runbooks/backup-restore-runbook.md` 只覆盖同机备份恢复。
- 主动推送：`runPolicy.proactive` 不配置时不创建轮询（`apps/agent-service/src/service-main.ts` 约 2000 行起的条件）；另有 `realEval`、`museIntake`；提醒（reminders）有没有能单独关的配置，未核实。

生产机（Contabo，只读查看）：x86_64，内核 `6.8.0-142-generic`；发布包 `/opt/himawari/releases/2026-11-15-twentyninth` 里的 Node v22.22.3、`better_sqlite3.node`、`onnxruntime_binding.node`（只有 `linux/x64`）、两份 `rename-native`、`pi-tools/bin/{node,bash,rg,fd}` 都是 x86_64；seccomp 辅助程序和 pi-tui 的原生文件已同时带 x64 和 arm64。Magpie（模型路由程序）是 `/opt/magpie/v0.1.2001/magpie`，x86_64。普通账号跑 `unshare -U -r true` 失败（`kernel.apparmor_restrict_unprivileged_userns = 1`），生产沙箱靠 `/etc/apparmor.d/bwrap*` 放行。

目标机（Oracle，`ubuntu@138.2.31.252`，只读查看）：主机名 `himawari-prod`，aarch64，Ubuntu 24.04.5，内核 `7.0.0-1013-oracle`，4 核、23 GiB 内存、162 GB 空闲；没有 `/lib64` 和 `/usr/lib64`；有 `/boot/grub/grub.cfg` 和 `grubenv`；`unattended-upgrades` 在运行，没有任何 apt hold；已装 `/usr/local/libexec/bubblewrap-0.11.2/bwrap` 和 `/etc/apparmor.d/bwrap`、`bwrap-0.11.2`，系统 bubblewrap 是 0.9.0；普通账号 `unshare -U -r true` 失败（同一个 AppArmor 限制），`bwrap --unshare-user --ro-bind / / true` 成功；正在运行 `gh-runner-arm-1`、`gh-runner-arm-2`（本项目的 GitHub CI，见 `docs/adr/0266-ci-policy-static-security-run-on-the-oracle-arm-machine.md`）、docker、`oracle-keepalive.service`（`stress-ng` 常驻占 7G 内存防止 Oracle 回收闲置机器）；端口 8400、3425、3430、20241 都空闲。

## 一手资料

- SQLite 文件跨架构可移植：“SQLite databases are portable across 32-bit and 64-bit machines and between big-endian and little-endian architectures.”（https://www.sqlite.org/onefile.html）
- Node 的 GNU/Linux arm64 是一级支持平台（https://github.com/nodejs/node/blob/main/BUILDING.md 平台表）；`https://nodejs.org/dist/v22.22.3/SHASUMS256.txt` 有 `node-v22.22.3-linux-arm64.tar.xz`。
- better-sqlite3 v12.11.1 的发行页有 `better-sqlite3-v12.11.1-node-v127-linux-arm64.tar.gz` 预编译包（https://github.com/WiseLibs/better-sqlite3/releases/tag/v12.11.1）。
- Magpie 有 v0.1.2001 的 `magpie-cli-linux-arm64` 发行物（https://github.com/yetone/magpie-releases/releases）。
- Cloudflare：同一条隧道的多个连接器是副本，请求按地理就近分给副本，“Replicas do not support traffic steering”（https://developers.cloudflare.com/cloudflare-one/networks/connectors/cloudflare-tunnel/configure-tunnels/tunnel-availability/）。

## 请回答

1. 代码要改哪些地方、分几个 PR、按什么顺序；每处说明修的是哪个根本原因。
2. ARM 的候选包在哪里、怎样构建，才能让产物可信、可复现，并且不把构建工具和测试动作带到生产账号里。
3. 新主机第一次安装和验收应该走什么流程，和现有的升级上线包是什么关系。
4. 第一阶段的数据同步和验证怎么做，怎样保证不双写、不重复发消息、不影响 Contabo；第二阶段切换的大致步骤。
5. 新机器和 CI runner 同机、内核会自动更新这两件事怎么处理。
6. 哪些地方需要 Andy 拍板，各自的取舍。
