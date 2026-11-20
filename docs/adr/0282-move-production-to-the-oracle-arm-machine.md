---
status: active
document_type: adr
decision_status: proposed
supersedes: ""
superseded_by: ""
amends: "0253, 0266"
date: "2026-11-20"
---

# ADR 0282：生产迁到 Oracle 东京的 ARM 机器

<a id="contents"></a>

## 阅读导航

- [背景](#context)
- [前提](#premises)
- [决定（方案）](#decision)
- [两次模型审核的意见怎么处理](#review)
- [业界怎么做](#industry)
- [放弃的做法](#options)
- [Andy 的决定](#owner-decisions)
- [后果](#consequences)

<a id="context"></a>

## 背景

Andy 2026-11-20 要把生产从 Contabo 的 x86-64 云服务器迁到 Oracle 东京的 ARM64 虚拟机 `himawari-prod`（`ubuntu@138.2.31.252`），第一阶段只做兼容性检查、部署、数据同步和验证，不切流量。线程做兼容性检查时停下：出包、安装和封存（生成安装回执，即记录“这台机器、这个架构、这个内核上装的是哪些文件”的签名文件）只支持 x86-64，也只支持“升级一台已在运行的生产机”，没有受支持的路径能在一台新的 ARM 机上第一次装好并重新验收。Andy 的要求是：启动前检查不许绕过，没有受支持的流程就停下报告，不许自己发明绕法。

本 ADR 给出补上这条路所需的代码改动和运维步骤。方案经过 DeepSeek 独立出方案（`.agents/reviews/topic-oracle-arm-production/round-1/`）和审核线程方案（`round-2/`）两轮，线程逐条比较后整合成下文。

<a id="premises"></a>

## 前提

代码以提交 `34f2e1411ce4` 为准；机器情况是 2026-11-20 只读查看的结果。

1. 安装脚本只认 x64：`scripts/delivery-mode/packet-template/install/__PKT_LABEL__-artifact-install.mjs:14` 和 `install/collect-installer-dependencies.mjs:15`，原话 `process.arch === "x64"`。
2. 候选包只在 Hermes 上构建、只取 x64 产物：`scripts/delivery-mode/hermes/build-candidate.sh:44-46` 只找 `linux-x64-abi127-…` 的产物；`scripts/delivery-mode/make-packet.py:509,552` 和 `run-packet-checks.py:166` 同样只认 x64。
3. 出包要求目标机上服务已在运行：`make-packet.py:329`，原话 `refuse('PACKET_SERVICE_NOT_ACTIVE'`；`deploy-preflight.py:178` 也要求服务 active。项目里没有“新主机第一次安装”的路径。
4. Node 运行时不在包里：`packet-template/install/p5-materials.json:5`，原话 `"nodeAlreadyInstalled": true`，`:6` 写死 x64 的 Node 摘要。
5. 服务账号 uid 999、组 988 写死在多处：例如 `packet-template/install/S1-publish-and-install.py:61`，原话 `os.chown(evidence,999,988)`；目标机上 uid 999 已被 `ocarun`（Oracle Cloud Agent 的账号）占用，gid 988 已被 `gh-ci-share`（CI runner 的共享组）占用（目标机 `getent` 实测）。
6. 封存脚本要求主机签名公钥等于第一把钥匙：`packet-template/signing/cloud-seal.mjs:441`，原话 `qualification/first-20261007/host-qualification-public-key.pem`，`:446` 不等就报 `FIRST_SIGNING_KEY_REQUIRED`；签名私钥在主机本地 `qualification/signing/host-qualification-signing-key.pem`（`:436`）。
7. 启动前检查断言主机名、平台、架构、内核与回执一致：`packet-template/signing/cloud-protected-prepare.mjs:38-41`；回执里这几项由 `cloud-seal.mjs:496-499` 写入。
8. 封存脚本无条件把 `/lib64` 列进只读目录：`cloud-seal.mjs:342`，原话 `"/lib64"`；目标机没有 `/lib64`（实测）。
9. 上线前检查按正则抽取只读目录清单的字面数组：`deploy-preflight.py:83`，原话 `re.compile(r'readOnlyToolchainPaths: \[(.*?)protectedPaths: \['`。所以这个数组必须保持字面写法，不能改成函数调用。
10. `scripts/delivery-mode/probe-sources.json` 只登记 `job-host-main.js`、`sandbox-sdk.js`、`sandbox-sdk-worker.js` 三个构建文件的摘要，与只读目录清单无关。
11. 目录授权按主机核对：`apps/agent-service/src/production-run-policy.ts:257`，原话 `grant.hostId !== route.hostId`。复制到新主机的授权在新主机上会被判无效。
12. 感知提取不配置也会启动：`apps/agent-service/src/service-main.ts:2500`，原话 `configuration.runPolicy?.perception ?? PERCEPTION_CONFIGURATION_DEFAULTS`，`:3030` 是 `perceptionExtraction?.start();`。所以“配置里不写 `proactive`”关不掉全部后台任务。
13. 目标机 CI runner 的防火墙规则只拦私有网段和本机 22、111 端口：目标机 `nft list ruleset` 第 105-107 行，原话 `meta skuid { 994, 995 } fib daddr type local tcp dport { 22, 111 } reject`。runner 账号（跑 CI 任务的系统账号）能连到本机 8400 端口。
14. 目标机已装好下一个内核、等待重启：已装 `linux-image-7.0.0-1013-oracle` 和 `linux-image-7.0.0-1016-oracle`，`/var/run/reboot-required` 存在（实测）。上线前检查 `deploy-preflight.py:16-17` 读 GRUB 配置，会拦下“重启后进的内核不是当前内核”的上线。
15. 目标机没有持久化主机名的 cloud-init 配置：`/etc/cloud/cloud.cfg.d/` 下只有 `05_logging.cfg`、`90-cpc-grub.cfg`、`90_dpkg.cfg`、`99-oracle-compute-infra-datasource.cfg`、`99-oracle-compute-user-redirect.cfg`（实测）；CI 服务器的做法见 `docs/runbooks/ci-vps-runner-runbook.md`，原话 `/etc/cloud/cloud.cfg.d/99-ci-vps-hostname.cfg`（重启后保留主机名）。
16. ADR 0253 决定 linux-arm64 只做测试：`docs/adr/0253-support-linux-arm64-for-test-and-qualification.md:62`，原话“ARM 不进 GitHub 必过检查，也不切线上。”ADR 0266 已修订其中“不进必过检查”一处。
17. 主控权迁移流程：`docs/runbooks/authority-transfer-runbook.md:269-273`，目标的 epoch 和 fencing token（防止两台机器同时当主的递增编号）各等于源值加一；迁移包不带机器机密、可执行文件绑定或平台资格，目标机要先独立装好。
18. 工具链锁已有 ARM 条目：`ci/toolchain-lock.json` 有 Node 22.22.3 和 Python 3.12.10 的 `linux-arm64`；better-sqlite3 是 `"decision": "build"`（在构建机上从源码编译）。
19. Cloudflare 同一条隧道的多个连接器是副本，请求按就近分给副本，原话 “Replicas do not support traffic steering”（https://developers.cloudflare.com/cloudflare-one/networks/connectors/cloudflare-tunnel/configure-tunnels/tunnel-availability/）。
20. SQLite 文件跨架构可移植，原话 “SQLite databases are portable across 32-bit and 64-bit machines and between big-endian and little-endian architectures.”（https://www.sqlite.org/onefile.html）
21. 目标机内存 23 GiB；两个 runner 所在的 `gh-arm-runners.slice` 上限 `MemoryMax=19327352832`（18 GiB），`oracle-keepalive` 常驻约 7 GiB（目标机 `systemctl show` 实测）。两者都到上限时合计超过整机内存。

<a id="decision"></a>

## 决定（方案）

原则依据：用户主权（Andy 的约束不许绕）优先，其次边界与可逆性（验证副本绝不对外发消息、绝不碰生产数据和隧道）。

### 代码，分 5 个 PR，按顺序

1. **PR 1 目标平台和服务账号参数化。** 根本原因：平台和账号是写死的常量（前提 1、2、4、5、8）。实例文件 `scripts/delivery-mode/instances/*.json` 加 `platform`（`linux-x64` / `linux-arm64`）和服务账号的 uid、gid；`make-packet.py` 把它们渲染进模板，取代所有写死的 `x64`、`999`、`988`、x64 Node 摘要、x86_64 的 `fd`；Node 和 Python 按平台从 `ci/toolchain-lock.json` 取。`/lib64` 改为“不存在时不列入”，但只读目录清单仍保持字面数组（前提 9），在封存时过滤，不改上线前检查的解析方式。`scripts/platform-assumptions.json` 的次数随改动下调。验收：用现有 Contabo 实例文件重新出包，渲染出的每个文件除工具链锁摘要外字节不变（工具链锁的摘要会变，这一点如实写进 PR）。
2. **PR 2 ARM 候选的构建机。** 根本原因：构建脚本写死 Hermes 的主机名、x64 和 uid 1000（前提 2；`capture-build-source-inputs.template.mjs:115`）。构建机身份改为仓库里的构建机配置，x64 仍是 Hermes；ARM 在目标机上一个独立的构建账号里构建（[Andy 的决定](#owner-decisions)第 2 项）：没有 sudo，不在 runner 和服务账号的组里，读不到 `/var/lib/himawari` 和 `/etc/himawari`，产物经 `make-packet.py` 取走后由安装步骤按摘要核对。better-sqlite3 和 `rename-native` 在 ARM 构建机上原生编译，浏览器发布验收也在 ARM 上跑；不在 Hermes 上交叉编译，因为原生模块必须在真实 ARM 上验过。
3. **PR 3 新主机首装包。** 根本原因：项目只有“升级运行中的服务”这一条路（前提 3）。新增一种首装包，仍由 `make-packet.py` 生成、`deploy.sh` 执行，不手工编辑：
   - 第一步核对目标机“空”：服务单元不存在、`/var/lib/himawari` 和 `/opt/himawari` 不存在、端口 8400、3425、3430、20241 空闲；任何一项不满足就停。
   - 安装锁定版本的 Node，建服务账号（用实例文件里的 uid、gid），装服务单元，装 bwrap 的 AppArmor 配置（目标机已装，核对摘要）。
   - 在目标机上生成这台主机自己的签名钥匙对，公钥写进 `qualification/first-<日期>/`，作为这台主机的信任起点（前提 6）；私钥不离开主机，不复制 Contabo 的私钥。
   - 跑现有的验收，用 `cloud-seal` 生成新回执；首装时没有上一版运行记录，`cloud-seal` 对“上一版回读”这一项走首装分支，由包类型决定，不是开关。`cloud-protected-prepare` 一行不改。
   - 首装包不带数据，装完服务保持停止。
4. **PR 4 只做验证模式（validationOnly）。** 根本原因：后台任务是“没配置就不跑”和“没配置用默认值照跑”混在一起（前提 12），靠删配置键关不全。配置加 `validationOnly: true`，启动时按白名单只开问答、工具、记忆读写的接口，其他所有后台任务（主动推送、网页推送、Apple 推送、首页动态、感知提取、记忆整理、提醒投递、外部接入写入）一律不创建；健康接口报出“验证模式，已关闭的任务清单”。测试先写：反向用例是验证模式下到点的提醒不投递、不发任何推送。
5. **PR 5 运行手册和本 ADR 定稿。** 首装、数据同步、切换三份运行手册；本 ADR 由 `proposed` 改为 `accepted`，取代 ADR 0253 的“不切线上”。

### 运维第一阶段（代码合并后，验证完停下等 Andy）

1. 目标机准备：用 cloud-init 配置持久化主机名 `himawari-prod`（前提 15）；重启一次进已装好的内核，再锁定（`apt-mark hold` 内核和受检程序的包，关掉自动更新里的这些包和自动重启，[Andy 的决定](#owner-decisions)第 4 项）；在一张独立的 nftables 表里拒绝 runner 账号连本机 8400、3425、3430、20241（前提 13），不改 runner 已有的规则和服务单元；Himawari 的服务单元设 `MemoryMin` 和较高的 `CPUWeight`，内存和 CPU 紧张时先保生产（前提 21）。
2. 用首装包装好，得到新回执（主机名、arm64、内核版本）。
3. 数据：在 Contabo 上用 SQLite backup 做一致性拷贝，连同整个记忆目录经 SSH 传到目标机；核对文件大小、`PRAGMA integrity_check`、迁移账本最后一条、关键表行数、几份加密内容能解密。目录授权在新主机上会判无效（前提 11），记为预期结果，不改代码绕过。
4. 以 `validationOnly: true` 启动，不装心跳、不装 cloudflared，用 `ssh -L` 把目标机 127.0.0.1:8400 转到本地，验证问答、网络搜索、网页抓取、文件读写、记忆读写；同时确认 Contabo 状态不变、没有重复消息。
5. 验证完停服，报告 Andy。这份数据副本只用于验证，切换时丢弃重来。

### 第二阶段切换（只设计，Andy 同意后才做）

按主控权迁移流程（前提 17）：Contabo 停服、置为 `retired_pending_transfer`、导出；目标机清掉验证副本、导入（epoch 和 fencing token 各加一）、关掉 `validationOnly`、启动；Contabo 上停 cloudflared 和心跳，再在目标机上启用（先停旧再启新，任何时刻只有一个连接器，前提 19）；最后核对入站规则、OAuth 回调地址。回退办法：目标机停服后，按同一流程反向迁回 Contabo（epoch 再加一），Contabo 的安装在并行期保持原样不删。

<a id="review"></a>

## 两次模型审核的意见怎么处理

| 意见 | 结论 | 理由 |
| --- | --- | --- |
| 首装路径不存在，封存要求上一版回读 | 采纳 | 前提 3；已写进 PR 3 |
| uid/gid 写死且目标机已被占用 | 采纳 | 前提 5；PR 1 参数化，不在目标机上抢占 999/988 |
| 签名信任起点写死 `first-20261007` | 采纳 | 前提 6；PR 3 为新主机生成自己的钥匙 |
| 线程方案说要更新 `probe-sources.json` 是错的 | 采纳 | 前提 9、10；改为保持字面数组、封存时过滤 |
| 构建链写死 Hermes | 采纳 | PR 2 |
| 数据要带整个记忆目录、目录授权按主机核对 | 采纳 | 前提 11 |
| 只删配置键关不全后台任务，要白名单模式 | 采纳 | 前提 12；PR 4 |
| 和 CI 同机有网络、内存、组权限风险 | 采纳 | 前提 13、21 实测；Andy 定不移走 runner，改为同机隔离（决定第 1 项） |
| “x64 产出字节不变”可能不成立 | 部分采纳 | 工具链锁摘要会变；其余文件要求不变 |
| 内核、包名、GRUB、自动重启按实际锁 | 采纳 | 前提 14：下一个内核已装好待重启 |
| 切换清单补入站、隧道、OAuth、心跳顺序、回退 | 采纳 | 已写进第二阶段 |
| 数据核对加完整性检查、迁移账本、解密验证 | 采纳 | 已写进第一阶段第 3 步 |
| 主机名用 cloud-init 持久化 | 采纳 | 前提 15 |
| 用 GitHub 托管的 ARM runner 构建 | 不采纳 | 私有仓库按分钟收费，Andy 定过 CI 不用托管分钟数 |

<a id="industry"></a>

## 业界怎么做

- 同一条 Cloudflare 隧道的两个连接器会分走流量（前提 19），所以切换时先停旧连接器再启新的，并行期验证不用生产隧道。
- SQLite 文件跨架构可直接用（前提 20）；在线拷贝用 SQLite 的 backup 接口（https://www.sqlite.org/backup.html），拷完跑 `PRAGMA integrity_check`。
- GitHub 文档提醒自托管 runner 会执行仓库里的代码，不应和需要保护的东西放在一起（https://docs.github.com/en/actions/hosting-your-own-runners/managing-self-hosted-runners/about-self-hosted-runners ，原话未核对，定稿前补引）。

<a id="options"></a>

## 放弃的做法

- 手工在目标机上装好再走升级包：违反 Andy“不许自己发明绕法”的约束，也让回执无法证明首装内容。
- 复制 Contabo 的签名私钥到目标机：让两台机器能互相冒充，迁移失败时也分不清回执来自哪台。
- 在 Hermes 上交叉编译 ARM 原生模块：编得出来但没在 ARM 上跑过验收。
- 靠删配置键关后台任务：前提 12 证明关不全。

<a id="owner-decisions"></a>

## Andy 的决定

Andy 2026-11-20 回复，原话：“CI 的 runner 不要移走，其余的按照你的推荐”。

1. **生产和 CI runner 同机，runner 不移走。** runner 执行仓库里 PR 的代码，防火墙原本不拦它连本机 Himawari 端口（前提 13），两者合计内存可超过整机（前提 21）。所以同机长期靠三样隔离：独立 nftables 表拒绝 runner 账号连 Himawari 端口；Himawari 的数据和机密目录只给服务账号，runner 账号不在它的组里；Himawari 服务单元设 `MemoryMin` 和较高的 `CPUWeight`。代价：内存紧张时被系统回收或杀掉的是 CI 任务而不是生产，CI 偶尔会因此失败重跑。仓库私有、只有 Andy 和他的代理线程推送，这是接受这份风险的前提；以后若接受外部 PR，要重新评估。
2. **ARM 候选在目标机上一个独立的构建账号里构建**（见 PR 2）。
3. **本 ADR 取代 ADR 0253 的“线上不切换”。**
4. **内核：首装前重启一次进已装好的 `7.0.0-1016`，再锁定。** 重启会让两个 CI runner 中断几分钟，在没有 CI 任务时做。
5. **每台主机自己的签名钥匙：** 首装时在新主机生成，Contabo 的钥匙不复制。
6. **验证副本不用生产机密：** 第一阶段用另一把测试用的 Magpie 网关钥匙和搜索钥匙，需要 Andy 另开。

<a id="consequences"></a>

## 后果

- 出包链从此支持 linux-arm64 和首装，x64 的升级上线行为不变。
- 验证模式成为一个长期存在的启动模式，后加的后台任务必须登记进白名单之外的关闭清单，否则测试失败。
- 第一阶段完成前，Contabo 仍是唯一的生产；任何一步失败都只影响目标机。
