---
status: superseded
document_type: adr
decision_status: superseded
supersedes: "docs/adr/0160-self-hosted-runner-on-hermes.md, docs/adr/0171-two-runners-on-hermes.md, docs/adr/0173-hermes-runs-only-ci.md"
superseded_by: "docs/adr/0287-ci-runs-on-github-hosted-runners.md"
amends: "docs/adr/0168-longer-ci-job-limits-on-hermes.md, docs/adr/0169-pause-runners-by-removing-the-label.md"
date: "2026-11-07"
amended_by: "docs/adr/0241-draft-prs-skip-ci-and-merge-waits-for-green.md, docs/adr/0256-gate-job-gets-its-own-runner.md, docs/adr/0238-ci-job-files-stay-on-the-ci-vps.md"
---

# ADR 0176：CI 全部搬到 OVH 的 VPS 上，注销 Hermes 上的 runner

<a id="contents"></a>

## 阅读导航

- [背景](#context)
- [Andy 的原话](#owner-decisions)
- [决定](#decision)
- [与旧 ADR 的关系](#amendments)
- [比较过的方案](#options)
- [后果](#consequences)
- [关联文档](#references)

<a id="context"></a>

## 背景

按 [ADR 0160](0160-self-hosted-runner-on-hermes.md)，GitHub Actions 的 CI（持续集成，每次推送后自动跑的检查）在 Hermes（家里的 Linux 服务器，4 核、16 GB 内存、Ubuntu 22.04）上的两个自托管 runner（装在自己机器上、替 GitHub 执行 CI 任务的程序）里运行。Hermes 跑得慢：任务时限已经按 [ADR 0168](0168-longer-ci-job-limits-on-hermes.md) 放宽，Hermes 也按 [ADR 0173](0173-hermes-runs-only-ci.md) 停掉了其他服务，CI 仍然慢。2026-11-06 三个工作流（`ci.yml`、`main.yml`、`quality.yml`）都被手动停用，等新的 CI 服务器。

Andy 租了一台 OVH（法国的云服务商）的 VPS（按月租用的云服务器）。2026-11-06 核对到的情况：

- Ubuntu 24.04.4，内核 6.8，8 个 vCPU（虚拟 CPU 核），22 GB 内存，200 GB 磁盘；公网地址 `158.69.191.249`，另有一个 IPv6 公网地址；账号 `ubuntu` 有免密 sudo。已关掉 SSH 密码登录，防火墙 ufw 只放行 22 端口。
- 同一个测速脚本：单核比 Hermes 快约 40%，8 核总算力约为 Hermes 的 3 倍；4 KB 同步随机写约 8400 次/秒（Hermes 约 500 次/秒），4 KB 直读随机读约 7100 次/秒（Hermes 约 12800 次/秒）。
- 和生产服务器一样，系统开着 AppArmor（Ubuntu 自带的程序权限限制）对非特权用户命名空间的限制（`kernel.apparmor_restrict_unprivileged_userns = 1`），所以 bwrap（项目沙箱用的隔离程序）默认会被拒。

`quality.yml` 在 GitHub 自己的机器上跑，私有仓库会按分钟收费，所以它也一直停着。

[↑ 返回阅读导航](#contents)

<a id="owner-decisions"></a>

## Andy 的原话

2026-11-06：

问题：quality.yml 现在仍在 GitHub 自己的机器上跑，私有仓库会按分钟收费，是把它也搬到自己的服务器上，还是继续停着？

> 继续把它停掉啊，之后不是要全部弄到 OVH 的 VPS 上吗？

同一天：

问题：搬迁方案（推荐做法）：1. 加固 VPS：关掉密码登录，打开防火墙，只开 SSH 端口。2. 在 VPS 上建一个专用账号跑 runner，先装 2 个，跑一次完整 CI 再决定要不要加到 3 个。3. 仓库改动单独开一个 PR：runner 标签 hermes-home 改成不带“Hermes”的新名字，一开始就处理基准提交上还是旧名字的情况；quality.yml 改到 VPS 上跑；写新的 ADR 并更新相关文档；动工前先请 OpenCode 上的两个模型审方案，预计不到 0.5 美元。4. 切换步骤：VPS 上的 runner 上线后，重新打开那三个工作流，用一个 PR 跑一次完整 CI。全部通过后，注销 Hermes 上的两个 runner，不留作备用。选“按推荐做”就同时授权了加固 VPS 和注销 Hermes 上的 runner。

> 按推荐做

ADR 0168 放宽任务时限时（2026-11-05）：

问题：任务跑到上限就被取消，ADR 0160 规定“不放宽任何测试时限”，改不改？单条测试 5 秒超时怎么办？

> 那就改啊！Hermes 上本来就跑得慢，不放宽时限，永远就跑不了

> 一样的，放开时间限制

[↑ 返回阅读导航](#contents)

<a id="decision"></a>

## 决定

1. **Linux 的 CI 检查全部改在 VPS 上跑。** 新的 runner 标签是 `ci-vps`，两个 runner 叫 `ci-vps-1`、`ci-vps-2`，VPS 的主机名改为 `ci-vps`。`ci/policy.json` 里所有 Linux 成员的 `runner`、`ci.yml` 和 `main.yml` 的 `runs-on`、`.github/actionlint.yaml` 的自定义标签、`ci/policy.schema.json` 的取值范围都改成 `ci-vps`。标签只在 `scripts/ci/contracts.mjs` 的 `linuxRunnerLabel` 和 `scripts/operations/ci-runner/runners.sh` 的 `RUNNER_LABEL` 两处定义，`test/tooling/ci-runner-scripts.test.mjs` 检查两处一致。名字不带服务商，以后换机器不用再改标签。检查名 `ci/required` 不变。
2. **改标签的 PR 自己能过闸门。** `ci/required` 用目标分支上的 `ci/policy.json` 校验，而目标分支上还是 `hermes-home`。按 ADR 0160 决定第 6 条的做法，`scripts/ci/check-policy.mjs` 新增 `upgradeRunnerLabel`：只有基准策略整份恰好是旧写法（所有 Linux 成员是 `hermes-home` 且没有 `paused`，macOS 成员是 `macos-15` 且 `paused: true`，每个检查的时限等于当前规定的值）时，才把 Linux 成员改成 `ci-vps`；混写、macOS 没暂停或时限不对的一律不动，照常被校验拒绝。升级后的策略同时用来校验当前的 `ci.yml`，所以工作流里留一处 `hermes-home` 也会被拒。`policySha256` 仍按基准上的原始字节计算。
3. **runner 的隔离做法和 ADR 0160 一样。** 每个 runner 一个专用系统账号（`gh-runner`、`gh-runner-2`），不给 sudo，不进 docker 组，看不到 `/home`；防火墙规则对这两个账号拒绝私有网段、`169.254.0.0/16`（云主机的元数据服务地址），以及本机所有地址（不只是 `127.0.0.1`）上正在监听的 TCP 端口。改用“本机所有地址”是因为 VPS 的网卡上直接挂着公网 IPv4 和 IPv6 地址，sshd 在这些地址上监听，只挡回环地址挡不住。
4. **资源上限。** VPS 只跑 CI。两个 runner 合计 `MemoryHigh=19G`、`MemoryMax=20G`，每个 `MemoryHigh=14G`、`MemoryMax=15G`，给系统留约 2 GB；不用交换分区，不限 CPU。项目的测试并发上限（每个任务最多 3 个进程、每个约 2 GB）在这个内存下不会超额。先装两个，跑一次完整 CI 后再决定要不要加第三个。
5. **VPS 的一次性准备写成仓库里的脚本** `scripts/operations/ci-runner/prepare-vps.sh`，以 root 运行，可重复运行：装编译工具（`build-essential`，`better-sqlite3` 没有预编译包时要现场编译）、`unzip`、`xz-utils`、`bubblewrap`、`socat`、`ripgrep`；加一条 cloud-init 配置 `preserve_hostname: true`，让主机名重启后不被改回；关掉自动安全更新后的自动重启，免得任务中途被重启；在 `/etc/needrestart/conf.d/` 加一条配置，让自动安全更新之后不自动重启 runner 服务（needrestart 是升级库之后自动重启还在用旧库的服务的工具，Ubuntu 24.04 起默认自动重启；2026-11-07 它在升级 libc 等一百多个包后重启了两个 runner，把正在跑的 CI 任务杀掉了。做法按 [Ubuntu 官方说明](https://discourse.ubuntu.com/t/needrestart-changes-in-ubuntu-24-04-service-restarts/44671)：把服务名的正则写进 `$nrconf{override_rc}`，值为 0。代价是 runner 继续用旧库，直到下一次空闲时手动重启或整机重启）；按[安装与启停 Runbook](../runbooks/install-start-stop-runbook.md) 的做法新建并加载 `/etc/apparmor.d/bwrap`，只给系统的 bwrap 放开用户命名空间，不关全局开关；用和 `package-lock.json` 同一版本的 Playwright 1.62.1（脚本里写死版本号，从 npm 现装，不读锁文件的完整性校验）装好三种浏览器需要的系统库（`ci.yml` 里装浏览器不带 `--with-deps`，不需要 root）。2026-11-07 在 VPS 上运行通过，并重启核对过：主机名仍是 `ci-vps`，开关仍是 1，普通账号能用 bwrap 建立隔离环境，gcc 13 可用。
6. **CI 结果按 VPS 的 Ubuntu 24.04 判定。** 它和生产服务器同一个系统版本、同样有 AppArmor 限制，比 Hermes 的 22.04 更接近生产，但仍不是生产机上的验证。VPS 上的 bwrap 是系统自带的 0.9.0，不额外装更新的版本：Hermes 上 0.6.1 的 CI 已能通过。
   - runner 服务模板不再设 `ProtectKernelTunables=yes`（systemd 的一项限制，把 `/proc/sys` 等内核参数路径用只读挂载盖住）。2026-11-07 在 VPS 上复现：项目沙箱每次都用 bwrap 的 `--proc /proc` 给沙箱新挂一份 `/proc`，在 VPS 的内核 6.8、systemd 255 上，只要服务给 `/proc` 下面任何一处加了挂载（`/proc/sys`、`/proc/irq`、`/proc/kcore` 逐个试过），bwrap 就报 `Can't mount proc on /newroot/proc: Operation not permitted`，沙箱退出码 1，用户命令不启动；去掉这一项后同一组测试全部通过，其他加固项逐个去掉都不行。Hermes 上同一份配置不出错，原因没有核实（要 sudo 才能看服务内部的挂载）。这一项对 runner 这种非 root 账号几乎没有额外保护，因为这些内核参数本来只有 root 能改；留着它，就只能让沙箱改用沿用宿主 `/proc` 的较弱隔离。`test/tooling/ci-runner-scripts.test.mjs` 检查模板不再在 `/proc` 下加挂载。Andy 2026-11-07 同意去掉，当天已在 VPS 的两个 runner 服务上去掉并重启，原配置备份在 `/root/gh-runner.service.before-pkt-removal` 和 `/root/gh-runner-2.service.before-pkt-removal`。
7. **任务时限沿用 ADR 0168**（90、60、15 分钟）。上面的原话是 Andy 放宽时限的决定。VPS 上跑满一周后，按实际时长再定要不要收紧。
8. **`quality.yml` 继续停用，另开一个 PR 搬到 VPS。** 它的 `container` 任务要 Docker。docker 组等于给了 root 权限（Docker 官方文档原话：“The docker group grants root-level privileges to the user.”），合并闸门所在的这台 VPS 不给任何 runner 账号 docker 组。下一个 PR 里，不用 Docker 的任务改到 `ci-vps` 上跑，Chrome 和 Edge 由 root 事先装好；`container` 任务用另一个专用账号的 rootless Docker（Docker 官方的非 root 运行方式），或者暂时不跑，由 Andy 在那个 PR 时定。
9. **暂停和恢复照 [ADR 0169](0169-pause-runners-by-removing-the-label.md) 的做法**（先去标签、等空闲、再停服务），入口仍是 Mac 上的 `pause-runners.sh` 和 `resume-runners.sh`，只是改为直接 `ssh ubuntu@158.69.191.249`（可用环境变量 `CI_VPS_SSH` 改），每次远程命令先核对主机名是 `ci-vps`，远端目录是 `/home/ubuntu/ci-runner`。ADR 0169 决定第 3 条“一次远程调用不超过 300 秒”来自旧的 `hermes-ssh.sh` 包装脚本，直连 ssh 后不再有这个硬上限，只靠 ssh 的保活检测（`ServerAliveInterval=15`、`ServerAliveCountMax=4`，连接断了约 60 秒内退出）；远端一次等待仍由 `runner-pause.sh` 限制在 180 秒以内，长时间的等待仍放在 Mac 侧。VPS 上没有受保护的第 3、4 层测试，平时不需要暂停；暂停只在重新安装或维护 runner 时用。
10. **切换顺序。** VPS 准备好并注册 `ci-vps-1`、`ci-vps-2` 后，重新打开 `ci.yml`，让改标签的这个 PR 在 VPS 上完整跑一次 CI；全部通过后，在 Mac 上运行 `main` 上的旧版 `scripts/operations/hermes-runner/pause-runners.sh` 暂停 Hermes 的两个 runner，从 GitHub 删除它们的注册，再请 Andy 在 Hermes 上用 sudo 运行旧版 `uninstall-runner.sh all`（Andy 的账号平时没有 root）。卸载用 `main` 上的旧脚本，要在这个 PR 合并、旧脚本从仓库消失之前做。合并后打开 `main.yml`，确认 main 上的确认运行也在 VPS 上通过。
    - 实际顺序有改动：Andy 2026-11-07 要求立刻停掉 Hermes 上的 runner、把机器让回给测试，不等 VPS 跑通完整 CI，原话“现在就停掉吧，不需要看 CI 结果，只要能合上去就行”。当天已取消派给 Hermes 的 5 次运行，运行 `pause-runners.sh` 暂停两个 runner，并从 GitHub 删除了它们的注册（编号 21、22）。代价是：在这个 PR 合并之前，从旧 main 分出的分支的 CI 任务没有机器接，会一直排队，24 小时后被 GitHub 判失败；合并不等 CI 结果，所以不挡合并。完整 CI 改为合并后在 VPS 上对 `main` 统一跑一次。
11. **Hermes 不再跑 CI，但仍是合并前本地检查的测试主机**，[测试主机与生产主机](../../.agents/instructions/test-and-production-hosts.md)里对 Hermes 的规定不变。Hermes 的临时 sudo 脚本移到 `scripts/operations/hermes-grant-temp-sudo.sh`，Hermes 上的其他维护还要用它。

[↑ 返回阅读导航](#contents)

<a id="amendments"></a>

## 与旧 ADR 的关系

- 取代 ADR 0160：runner 不再放在 Hermes 上，CI 结果不再按 Ubuntu 22.04 判定。它仍然有效的部分已写进本 ADR：macOS 的构建和测试照旧暂停（`paused: true`）；改策略的 PR 用一次性升级函数过闸门（决定第 2 条）；在 Andy 决定规则集要求 `ci/required` 之前，合并不等 CI 结果。
- 取代 ADR 0171 和 ADR 0173：两个 runner 和内存上限改按本 ADR 决定第 4 条；Hermes 停掉的服务是否恢复与 CI 无关，由 Andy 另定。
- 修订 ADR 0168：时限的数字不变，但它的理由（Hermes 慢）不再成立，VPS 上跑满一周后再看（决定第 7 条）。
- 修订 ADR 0169：暂停和恢复的步骤不变，连接方式、标签和远端目录按本 ADR 决定第 9 条。

[↑ 返回阅读导航](#contents)

<a id="options"></a>

## 比较过的方案

- **标签沿用 `hermes-home`**：不用改任何策略和工作流，但项目要求同一个东西只用一个名字，机器已经不是 Hermes，留着这个名字以后会误导人和代理。
- **改名时不加升级函数，让这个 PR 的 `ci/required` 预期失败**：要等合并后才知道新策略能不能过，闸门在合并前就失去作用。ADR 0160 时 Andy 已经选过加升级函数的做法。
- **`quality.yml` 和 `ci.yml` 同一个 PR 搬**（Andy 批准的推荐方案原本这样写）：它要 Docker 和带品牌的浏览器，和“runner 账号不给 sudo、不进 docker 组”冲突，需要单独设计；拆开后合并闸门可以先恢复，`quality.yml` 只能手动触发、不影响合并。这是对已批准方案的偏离，已报告 Andy。
- **给 runner 账号 docker 组**：OpenCode 的两个模型独立出方案时都这样建议，理由是 rootless Docker 配置麻烦。没有采用：docker 组等于 root，任何一个 PR 里的代码都能借它拿到整台机器，包括注册令牌和别的 runner。
- **装更新的 bwrap 0.11.2**：Hermes 上 0.6.1 的 CI 能通过，没有证据说明 0.9.0 不够；要等出现只在旧版本上失败的测试再说。
- **Hermes 的 runner 留一周作备用**：Andy 选了全部通过后就注销、不留作备用。

[↑ 返回阅读导航](#contents)

<a id="consequences"></a>

## 后果

- 好处（待第一次完整 CI 验证）：CPU 约为 Hermes 的 3 倍，写盘快得多；系统版本和 AppArmor 限制与生产一致，CI 能更早发现只在 24.04 上出现的沙箱问题。
- 代价：VPS 是共享的物理机，速度可能波动；随机读比 Hermes 的固态盘慢，靠 22 GB 内存的文件缓存弥补。runner 账号能连外网（下载依赖必需），但连不到本机服务、私有网段和元数据服务。
- 第一次在 VPS 上完整运行时，如果有测试只在 VPS 上失败，先判断是 24.04 和 22.04 的差别（生产机也会遇到，要修代码或测试），还是 VPS 缺东西（补进准备脚本）；不把标签改回 Hermes。
- Hermes 的 runner 注销之后，要退回 Hermes 需要重新安装，旧脚本在 `main` 的历史里。
- `quality.yml` 停用期间，浏览器品牌和容器的检查不跑。

[↑ 返回阅读导航](#contents)

<a id="references"></a>

## 关联文档

- CI VPS 上的自托管 runner Runbook（运行手册已随 [ADR 0287](0287-ci-runs-on-github-hosted-runners.md) 删除，最后一版在提交 `88e17c24`）
- [ADR 0160：CI 改在 Hermes 上的自托管 runner 运行](0160-self-hosted-runner-on-hermes.md)
- [ADR 0168：放宽 CI 任务的整体时限](0168-longer-ci-job-limits-on-hermes.md)
- [ADR 0169：暂停 runner 时先去掉标签](0169-pause-runners-by-removing-the-label.md)
- [ADR 0174：CI 不用 GitHub 缓存，artifact 只保存 1 天](0174-no-github-cache-and-one-day-artifacts.md)
- Docker 官方文档 [Linux post-installation steps](https://docs.docker.com/engine/install/linux-postinstall/)、[Rootless mode](https://docs.docker.com/engine/security/rootless/)

[↑ 返回阅读导航](#contents)
