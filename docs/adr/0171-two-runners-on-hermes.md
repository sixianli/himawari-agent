---
status: superseded
document_type: adr
decision_status: superseded
supersedes: ""
superseded_by: "docs/adr/0176-ci-on-ovh-vps.md"
amends: "docs/adr/0160-self-hosted-runner-on-hermes.md"
date: "2026-11-05"
---

# ADR 0171：Hermes 上跑两个常驻 runner，合计最多 3 核 6 GB

<a id="contents"></a>

## 阅读导航

- [背景](#context)
- [Andy 的原话](#owner-decisions)
- [决定](#decision)
- [与 ADR 0160 的关系](#amendments)
- [比较过的方案](#options)
- [后果](#consequences)
- [关联文档](#references)

<a id="context"></a>

## 背景

[ADR 0160](0160-self-hosted-runner-on-hermes.md) 把 CI（GitHub Actions 上每次推送后自动跑的检查）改到了 Hermes（家里的 Linux 服务器，4 核、15 GB 内存）上的一个自托管 runner（装在自己机器上、替 GitHub 执行 CI 任务的程序）里。它在后果里写明：“只有一台 runner，任务排队依次执行”。几个线程同时推送时，后来的 PR 要等前一个 PR 的全部任务跑完。

一个 runner 一次只领一个任务；GitHub 把任务派给“在线、空闲、标签匹配”的 runner（[Self-hosted runners reference](https://docs.github.com/en/actions/reference/runners/self-hosted-runners)）。所以多一个同标签的 runner，就能同时跑两个任务。一次完整 CI 的 9 个任务有先后依赖（各任务的 `needs`），最多 4 到 5 个能同时跑，所以第二个 runner 带来的提速不到一倍。

2026-11-05 实测，现有 runner 跑一个任务时它的 cgroup（Linux 给一组进程计量和限制资源的分组）用到 4.7 GB，其中程序内存 1.47 GB，其余主要是文件缓存；`memory.events` 里没有被系统杀进程的记录。Hermes 的内核没有 `memory.peak`，单个任务的程序内存峰值还不知道。

[↑ 返回阅读导航](#contents)

<a id="owner-decisions"></a>

## Andy 的原话

- 2026-11-05，问“在 hermes 上多部署几个 runner，会不会加快速度？”和“各自独立账号是什么意思”之后：

  > 那就装两个 runner

- 2026-11-05，Claude 建议用两个常驻 runner（不用一次性 runner）、各自独立账号、合计 3 核 6 GB，方案讨论最多花 0.8 美元。回答：

  > 按照你的建议来，多花 0.8 美元，我许可

- 2026-11-05，问“磁盘下限从 8 GiB 提到 16 GiB，并按方案开始写代码吗？”。回答：

  > 同意，开始写

[↑ 返回阅读导航](#contents)

<a id="decision"></a>

## 决定

1. **第二个 runner 用独立账号。** 新增系统用户 `gh-runner-2`（不能登录，只属于自己的组），目录 `/srv/gh-runner-2/`，服务 `gh-runner-2.service`，注册名 `hermes-home-2`，标签仍是 `hermes-home`。workflow 和 `ci/policy.json` 不改，任务派给哪个空闲的 runner 都行。现有的 `gh-runner` 和 `hermes-home` 保留，不重新注册。
2. **两个 runner 共用一个资源上限。** 新增 systemd slice（把几个服务放进同一个资源分组、一起设上限的单元）`gh-runners.slice`：`CPUQuota=300%`、`MemoryHigh=5632M`、`MemoryMax=6G`、不用交换分区，`CPUWeight=20`、`IOWeight=20`。两个服务都放进这个 slice，各自的上限保持原来的 2 核、`MemoryMax=5G`。只有一个任务时它的上限和以前一样；两个同时跑时合计不超过 3 核、6 GB，Hermes 至少留 1 核。优先级权重写在 slice 上，因为服务自己的权重只在同一个 slice 内部分配，不决定 runner 和 Hermes 上其他服务谁先用（[systemd.resource-control](https://www.freedesktop.org/software/systemd/man/latest/systemd.resource-control.html)：“The available CPU time is split up among all units within one slice relative to their CPU time weight”）。
3. **两个服务从同一份模板生成。** 服务文件只有一份模板 `gh-runner.service.in`，安装时替换出账号、目录和名字，所以两个服务的加固项逐条相同；每个服务还用 `InaccessiblePaths` 藏起另一个 runner 的目录。
4. **防火墙和 sudo 规则按现存的全部 runner 账号整体生成。** 一张防火墙表，规则同时匹配两个账号；andy 的窄 sudo 规则列出两个服务各自的启动、停止、重启命令。安装和只卸第二个 runner 时都重新生成，不会只写一个账号而丢掉另一个的保护。
5. **磁盘下限从 8 GiB 提到 16 GiB。** 两个任务可能同时占用根盘，每个任务开始前可用空间低于 16 GiB 就拒绝它。
6. **暂停和恢复同时管两个 runner。** 暂停等两个都没有任务再把两个都停掉；查不出有没有任务时不停服务。恢复只启动已注册（服务已启用）的 runner。ADR 0160 决定第 5 条“受保护测试和出包之前先暂停 runner”不变，用的还是同一个暂停脚本。
7. **安装前先暂停、先备份。** 有 runner 服务在运行时安装脚本拒绝执行；动手前把安装会改动的服务文件、slice、`/etc/gh-runner/`、sudo 规则、`/srv/gh-runner/bin/` 和两个 runner 的 `hooks/` 目录复制到 `/var/backups/gh-runner/<时间>/`，并记下哪些原来不存在；中途失败或被中断时，原有的放回、新建的删掉，这次新建的账号、目录和开机启动设置也撤销，有放不回去的就打印 `RESTORE_INCOMPLETE` 并指出备份位置。注册脚本必须写明注册第几个 runner，免得 `--replace` 把现有的 `hermes-home` 换掉；两个 runner 用两个分别生成的注册令牌。
8. **试跑一周，判断标准先写定。**
   - 基线：迁到 Hermes 以来 GitHub 记录的各任务排队和运行时长。
   - 记录：每个任务的时长；多个 PR 同时排队时后一个 PR 的等待时间；slice 的 `memory.events` 里被系统杀进程的次数；每 5 分钟两个服务的程序内存；超时失败的次数。
   - 保留第二个 runner 的条件：多 PR 时等待时间的中位数下降至少 30%，没有被系统杀进程，超时失败不比基线多。
   - 不满足就只卸掉第二个 runner（`uninstall-runner.sh 2`）。

[↑ 返回阅读导航](#contents)

<a id="amendments"></a>

## 与 ADR 0160 的关系

本 ADR 改动 ADR 0160 的这几处，ADR 0160 的其他决定不变：

- 决定第 1 条“`hermes-home` 是只有这台 runner 才有的标签”：现在两个 runner 都有这个标签。
- 决定第 4 条的身份和限额：每个 runner 一个专用账号，各自最多 2 核、5 GB，两个合计最多 3 核、6 GB；工作目录分别在 `/srv/gh-runner/` 和 `/srv/gh-runner-2/`。
- 背景里的 8 GB 磁盘底线：改为 16 GiB。
- 后果里的“只有一台 runner，任务排队依次执行”：现在最多两个任务同时跑。

[↑ 返回阅读导航](#contents)

<a id="options"></a>

## 比较过的方案

- **两个常驻 runner、独立账号、共用 3 核 6 GB（选中）**：workflow 不改；两个任务互相读不到对方的文件和注册凭证；总资源有上限，不挤占 Hermes 上的其他服务。
- **一次性 runner（每个任务用完就注销，GitHub 推荐）**：要在 Hermes 上长期保存一个有仓库管理权限的凭证（[权限表](https://docs.github.com/en/rest/authentication/permissions-required-for-fine-grained-personal-access-tokens)：`generate-jitconfig | write`），而 [Secure use reference](https://docs.github.com/en/actions/reference/security/secure-use) 要求 runner 机器上的敏感信息“should be kept to a minimum”，并说在同一台硬件上反复用一次性 runner “might not be as effective as intended”。Andy 同意不用。
- **两个 runner 共用 `gh-runner` 账号**：最简单，但一个任务能改另一个 runner 的文件、读它的凭证。
- **每个 runner 内存降到 4 GB**：单个任务的上限比以前少 20%，而实测一个任务已经用到 4.7 GB。改为保持 5 GB，总量交给 slice。
- **slice 给 7.5 GB、2.8 核**：超出 Andy 同意的 3 核 6 GB；试跑出现被系统杀进程再提。
- **用文件锁给每个任务预留磁盘**：比固定 16 GiB 复杂，好处只在两个任务恰好同时开始时才有。
- **按任务类型分不同标签**：要改 workflow 和策略检查；试跑不达标时再考虑。

[↑ 返回阅读导航](#contents)

<a id="consequences"></a>

## 后果

- 好处：几个 PR 同时排队时，后面的 PR 不用等前一个 PR 的全部任务跑完；两个任务之间文件和凭证互相隔开。
- 坏处：
  - 两个任务同时跑时各自可用的内存更少（合计 6 GB），CPU 也要分（合计 3 核），单个任务可能比只有一个 runner 时慢。
  - 测试的并发数按整台机器的内存算，不读 cgroup 的上限（`scripts/ci/test-concurrency.mjs` 用 `totalmem()`），两个任务同时跑时可能顶到 6 GB 上限。这是原有的问题，试跑看到被系统杀进程再改。
  - Hermes 上多一个系统账号、一个服务、一个 slice 要维护。
- 后续：试跑一周后按[决定](#decision)第 8 条的标准判断保留还是卸掉第二个 runner，结果报给 Andy。

[↑ 返回阅读导航](#contents)

<a id="references"></a>

## 关联文档

- [SOURCE: docs/adr/0160-self-hosted-runner-on-hermes.md]
- [hermes-self-hosted-runner-runbook.md（已删除，链接指向删除前的版本）](https://github.com/sixianli/himawari-agent/blob/34de855ff109a53391cfc0d59706bcf44ba7f4a5/docs/archive/runbooks/2026-11-07-hermes-self-hosted-runner-runbook.md)
- GitHub 官方文档：[Self-hosted runners reference](https://docs.github.com/en/actions/reference/runners/self-hosted-runners)
- systemd 官方文档：[systemd.resource-control](https://www.freedesktop.org/software/systemd/man/latest/systemd.resource-control.html)
- Linux 内核文档：[Control Group v2](https://docs.kernel.org/admin-guide/cgroup-v2.html)
