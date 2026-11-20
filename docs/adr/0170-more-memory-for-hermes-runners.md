---
status: superseded
document_type: adr
decision_status: superseded
supersedes: ""
superseded_by: "docs/adr/0173-hermes-runs-only-ci.md"
amends: "docs/adr/0171-two-runners-on-hermes.md"
date: "2026-11-05"
---

# ADR 0170：Hermes 上两个 runner 的内存上限从 6 GB 提到 9 GB

<a id="contents"></a>

## 阅读导航

- [背景](#context)
- [Andy 的原话](#owner-decisions)
- [决定](#decision)
- [与 ADR 0171 的关系](#amendments)
- [比较过的方案](#options)
- [后果](#consequences)
- [关联文档](#references)

<a id="context"></a>

## 背景

Hermes（家里的 Linux 服务器，16 GB 内存，4 核，固态盘）上的两个 GitHub 自托管 runner（替 GitHub 执行 CI 任务的程序）放在同一个资源组 `gh-runners.slice` 里。按 [ADR 0171](0171-two-runners-on-hermes.md)，两个合计内存最多 6 GB（软上限 `MemoryHigh=5632M`），每个最多 5 GB（软上限 4608M）。软上限的作用：资源组碰到它，系统就强行回收这一组的内存，组里的进程会变慢。

CI 任务在 Hermes 上比 GitHub 托管机器慢得多，要查原因（[ADR 0168](0168-longer-ci-job-limits-on-hermes.md) 决定第 4 条）。2026-11-05 Mac 上的会话在 Hermes 上用只读命令量到：

| 项目 | 两个 runner 都在跑任务时 | runner 服务停掉时 |
|---|---|---|
| 整机可用内存（`available`） | 9.2 GB | 9.8 GB |
| 交换空间已用 | 2.9 GB | 2.9 GB |
| runner 资源组占用 | 3.7 GB，其中程序自己占的（`anon`）0.53 GB，文件缓存（`file`）2.9 GB | 0.9 GB |
| 等磁盘的时间比例（`io` 压力 `some` / `full`，10 秒平均） | 90% / 66% | 2% / 1.6% |

另外：资源组碰到软上限的次数（`memory.events` 的 `high`）从 37835 涨到 51314；系统回收内存时清掉文件缓存，之后又从磁盘重读（重读约 120 万次）；没有进程因内存不足被杀。

由此判断（推断，依据是上面的数）：

- runner 内存不够用的不是程序本身，而是文件缓存。软上限把缓存不断清掉，同样的文件反复从磁盘读，造成磁盘排队。
- 磁盘排队主要是 runner 自己造成的：停掉 runner 后，等磁盘的时间从 90% 降到 2%。
- 整机在 runner 忙时还有 9.2 GB 可用；交换空间的 2.9 GB 在 runner 停掉时也一样，与 runner 无关。

[↑ 返回阅读导航](#contents)

<a id="owner-decisions"></a>

## Andy 的原话

- 2026-11-05，问题是“Hermes 慢主要是因为磁盘排队和内存上限太紧，要不要调高 runner 的内存上限或磁盘优先级？”回答：

  > 可以

[↑ 返回阅读导航](#contents)

<a id="decision"></a>

## 决定

1. `gh-runners.slice`：`MemoryHigh` 从 5632M 提到 8G，`MemoryMax` 从 6G 提到 9G。
2. 每个 runner 的服务（`gh-runner.service.in` 模板）：`MemoryHigh` 从 4608M 提到 6G，`MemoryMax` 从 5G 提到 7G。
3. CPU 上限、`CPUWeight=20`、`IOWeight=20`、`Nice=10` 和不用交换分区都不变。
4. 改完后在 Hermes 上用同样的命令再量一次，比较碰到软上限的次数、等磁盘的时间和任务时长；没有改善就改回来，并在这里记录。

[↑ 返回阅读导航](#contents)

<a id="amendments"></a>

## 与 ADR 0171 的关系

本 ADR 改动 ADR 0171 的两处：决定第 2 条里资源组的内存上限（6 GB 改为 9 GB），以及决定第 4 条所说每个 runner 的内存上限（5 GB 改为 7 GB）。CPU 上限和优先级不变，ADR 0171 的其他决定也不变。

[↑ 返回阅读导航](#contents)

<a id="options"></a>

## 比较过的方案

- **提高内存上限（选中）**：直接针对“缓存被反复清掉、再从磁盘重读”。runner 程序本身只占约 0.5 GB，多出来的主要是文件缓存，整机内存紧张时系统可以回收它，不会像程序内存那样挤垮别的服务。
- **提高磁盘优先级 `IOWeight`**：磁盘优先级只决定和别的服务抢磁盘时谁先。停掉 runner 后几乎不再等磁盘，说明不是别的服务在抢，调它帮助小，反而会让 Hermes 上的其他服务变慢。
- **同一时间只跑一个任务（停掉第二个 runner）**：每个任务能独占现在的 6 GB，但任务要排队。先试提高上限；量下来仍不好，再按 ADR 0171 决定第 8 条考虑撤掉第二个 runner。

[↑ 返回阅读导航](#contents)

<a id="consequences"></a>

## 后果

- 好处（待验证）：文件缓存不再被反复清掉，磁盘重读和排队减少，任务变快。
- 代价：runner 最多能占 9 GB。整机 16 GB，runner 忙时其他服务和系统还剩约 6 GB 以上，加上可回收的文件缓存。没有查 docker 容器（clickhouse、minio 跑在里面）自己的内存限制；如果之后其他服务变慢或交换空间明显增加，先把上限调回去。
- 生效要在 Hermes 上用一次临时 sudo，先暂停 runner，再重新运行 `install-runner.sh`，最后恢复（见 [已归档的 Runbook](https://github.com/sixianli/himawari-agent/blob/34de855ff109a53391cfc0d59706bcf44ba7f4a5/docs/archive/runbooks/2026-11-07-hermes-self-hosted-runner-runbook.md#install)）。

[↑ 返回阅读导航](#contents)

<a id="references"></a>

## 关联文档

- [ADR 0171：Hermes 上跑两个常驻 runner](0171-two-runners-on-hermes.md)
- [ADR 0168：放宽 Hermes 上 CI 任务的整体时限](0168-longer-ci-job-limits-on-hermes.md)
- [Hermes 自托管 runner 操作手册（已归档）](https://github.com/sixianli/himawari-agent/blob/34de855ff109a53391cfc0d59706bcf44ba7f4a5/docs/archive/runbooks/2026-11-07-hermes-self-hosted-runner-runbook.md)

[↑ 返回阅读导航](#contents)
