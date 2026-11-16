---
status: superseded
document_type: adr
decision_status: superseded
supersedes: "docs/adr/0170-more-memory-for-hermes-runners.md"
superseded_by: "docs/adr/0176-ci-on-ovh-vps.md"
amends: "docs/adr/0171-two-runners-on-hermes.md"
date: "2026-11-06"
---

# ADR 0173：Hermes 只跑 CI，两个 runner 不再限 CPU 和优先级，内存放宽到 14 GB

<a id="contents"></a>

## 阅读导航

- [背景](#context)
- [Andy 的原话](#owner-decisions)
- [决定](#decision)
- [与 ADR 0171、ADR 0170 的关系](#amendments)
- [比较过的方案](#options)
- [后果](#consequences)
- [关联文档](#references)

<a id="context"></a>

## 背景

Hermes（家里的 Linux 服务器，4 核，16 GB 内存，系统盘是固态盘）上跑着两个 GitHub 自托管 runner（替 GitHub 执行 CI 任务的程序），放在同一个资源组 `gh-runners.slice`（把几个服务放进同一个资源分组、一起设上限的 systemd 单元）里。按 [ADR 0171](0171-two-runners-on-hermes.md) 和 [ADR 0170](0170-more-memory-for-hermes-runners.md)，两个合计最多 3 个核、9 GB 内存；每个最多 2 个核、7 GB；CPU 和磁盘的优先级都压低（`CPUWeight=20`、`IOWeight=20`、`Nice=10`），好让 Hermes 上的其他服务先用。

2026-11-06 Hermes 上除了 runner 还跑着 38 个容器（langfuse、just-rag、firecrawl、feeding-me、flashanki、keycloak、mem0、监控等）和 `hermes-gateway`、flashanki 的后台进程等服务。Andy 决定 Hermes 只用来跑 CI，这些服务全部停掉。2026-11-06 10:25（JST）停完后在 Hermes 上量到：可用内存从 9.0 GB 升到 14 GB，交换空间占用从 3.2 GB 降到 42 MB，容器数为 0。

机器上不再有别的服务要保护以后，CPU 上限和低优先级只会让 CI 用不满机器。

[↑ 返回阅读导航](#contents)

<a id="owner-decisions"></a>

## Andy 的原话

- 2026-11-06，Andy 说：

  > 我现在是这么想的：hermes 这台机器只用来跑 CI，把所有的资源都给 CI

- 问“哪些服务可以停”和“要不要先做实验再停”时，回答：

  > 1 全部停掉
  > 2 不用做实验

- 问“要不要放宽 runner 自己的上限”时，回答：

  > hermes 全面放开给 CI 用

[↑ 返回阅读导航](#contents)

<a id="decision"></a>

## 决定

1. `gh-runners.slice`：去掉 `CPUQuota`、`CPUWeight`、`IOWeight`，两个 runner 可以用满 4 个核，CPU 和磁盘优先级回到系统默认；内存软上限 `MemoryHigh=13G`、硬上限 `MemoryMax=14G`。整机约 15.4 GiB，留约 1.4 GiB 给 ssh、tailscale、cloudflared、docker 守护进程和系统日志，让 runner 把自己的内存用满时还能远程登录。这不是硬保证：上限只管住 runner，组外的进程用量变大时，整机仍可能内存不足。
2. 每个 runner 的服务（`gh-runner.service.in` 模板）：去掉 `CPUQuota`、`CPUWeight`、`IOWeight`、`Nice`；`MemoryHigh=12G`、`MemoryMax=13G`。只有一个任务时它几乎能用满整组内存。
3. 不变的：不用交换分区（`MemorySwapMax=0`，换页会让系统盘排队）、进程数上限、全部安全加固（账号隔离、`ProtectProc`、`InaccessiblePaths=/data`、防火墙规则）。
4. 停掉的服务只是停止并取消开机自启，没有删除数据。停之前的清单记在 Hermes 的 `/home/andy/ci-only-20261106/`，要恢复时按清单启动。
5. 改完后在 Hermes 上量一次两个 runner 都忙时的内存、等磁盘时间和任务时长，和 ADR 0170 的数字比较。

[↑ 返回阅读导航](#contents)

<a id="amendments"></a>

## 与 ADR 0171、ADR 0170 的关系

- 取代 ADR 0170：它的内存上限（合计 9 GB、每个 7 GB）和“CPU 上限与优先级不变”都由本 ADR 的决定第 1、2 条代替。
- 修订 ADR 0171 决定第 2 条：资源组不再设 CPU 上限和低优先级，内存上限按本 ADR。ADR 0171 的其他决定不变。

[↑ 返回阅读导航](#contents)

<a id="options"></a>

## 比较过的方案

- **全部放开，只留内存硬上限（选中）**：机器上没有别的服务了，CPU 上限和低优先级没有要保护的对象。内存硬上限保留，是为了 CI 任务占满内存时系统先在资源组里杀进程，让 ssh 和 tailscale 还有内存可用，Andy 和代理还能登录；这不是硬保证（见决定第 1 条），CPU 和磁盘也没有给它们留份额，CI 占满时登录可能变慢。
- **连内存上限也去掉**：CI 吃光内存时内核可能杀掉 ssh 或 tailscale，Hermes 就连不上了，只能到现场处理。
- **先做实验再停服务**：Andy 明确说不做实验。

[↑ 返回阅读导航](#contents)

<a id="consequences"></a>

## 后果

- 好处（待验证）：CI 可以用满 4 个核和约 14 GB 内存，不再和其他服务抢磁盘。
- 代价：langfuse、just-rag、feeding-me、flashanki、keycloak、mem0、firecrawl、`hermes-gateway`、监控、X 自动发帖等服务全部停止，依赖它们的功能都不可用，直到把它们迁到别处或重新启动。
- 不能保证 CI 一定变快：2026-11-06 的采样显示，等磁盘时多半是 runner 自己在写盘，不全是被别的服务挤占（推断，没有用 `iostat` 核实）。
- 生效要在 Hermes 上用 sudo：先暂停 runner，再重新运行 `install-runner.sh`，最后恢复（见 [已归档的 Runbook](https://github.com/sixianli/himawari-agent/blob/34de855ff109a53391cfc0d59706bcf44ba7f4a5/docs/archive/runbooks/2026-11-07-hermes-self-hosted-runner-runbook.md#install)）。

[↑ 返回阅读导航](#contents)

<a id="references"></a>

## 关联文档

- [ADR 0171：Hermes 上跑两个常驻 runner](0171-two-runners-on-hermes.md)
- [ADR 0170：Hermes 上两个 runner 的内存上限从 6 GB 提到 9 GB](0170-more-memory-for-hermes-runners.md)
- [Hermes 自托管 runner 操作手册（已归档）](https://github.com/sixianli/himawari-agent/blob/34de855ff109a53391cfc0d59706bcf44ba7f4a5/docs/archive/runbooks/2026-11-07-hermes-self-hosted-runner-runbook.md)

[↑ 返回阅读导航](#contents)
