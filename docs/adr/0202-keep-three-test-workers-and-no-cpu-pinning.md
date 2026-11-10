---
status: active
document_type: adr
decision_status: accepted
supersedes: ""
superseded_by: ""
amends: "docs/adr/0176-ci-on-ovh-vps.md"
date: "2026-11-10"
---

# ADR 0202：integration 测试保持 3 个进程，不给 runner 绑定 CPU 核

<a id="contents"></a>

## 阅读导航

- [背景](#context)
- [Andy 的原话](#owner-decisions)
- [测量数据](#measurements)
- [决定](#decision)
- [后果](#consequences)
- [关联文档](#references)

<a id="context"></a>

## 背景

CI 在 OVH 租的云服务器（CI VPS，8 个虚拟 CPU 核、22 GB 内存）上跑，装了两个自托管 runner（替 GitHub 执行 CI 任务的程序）。`ci/policy.json` 里 integration 测试项目的进程数上限（`testProjects[integration].workerLimits.maximum`）是 3。要回答两个问题：把它提到 4 能不能明显加快？要不要给每个 runner 绑定 4 个核（runner 1 用 0 到 3 核，runner 2 用 4 到 7 核），免得两个 runner 抢核？后者会改 [ADR 0176](0176-ci-on-ovh-vps.md) 里的“不限 CPU”。

[↑ 返回阅读导航](#contents)

<a id="owner-decisions"></a>

## Andy 的原话

- 2026-11-10，问：每个 runner 要不要绑 4 个核（会改 ADR 0176 的“不限 CPU”）？我倾向不绑，因为 3 比 4 个进程只差 5%，绑核换不来明显收益。答：“不绑”。

[↑ 返回阅读导航](#owner-decisions)

<a id="measurements"></a>

## 测量数据

在 CI VPS 上用同一份代码，让 integration 测试跑 3 个进程和 4 个进程，两个 runner 同时各跑一份：

| 进程数 | 总耗时 | 失败 | 内存峰值 |
| --- | --- | --- | --- |
| 3 | 1173 秒 | 5 个，已知的环境相关失败 | 约 6.2 GB |
| 4 | 1115 秒 | 同样 5 个 | 约 6.7 GB |

- 4 个进程只快约 5%；没有出现内存不足被杀；两种设置下都有 1 个用例耗时 30 秒以上。
- 单个 runner 单独跑时多次测量互相差约 15%，噪声比 3 和 4 之间的差别还大，得不出结论。
- 测量文件在 CI VPS 的 `/home/ubuntu/measure/` 下（`dual-3-015038`、`dual-4-032333` 等），不入库。

[↑ 返回阅读导航](#measurements)

<a id="decision"></a>

## 决定

1. integration 测试的进程数上限保持 3，不改 `ci/policy.json`。4 个进程没有达到“明显更快”的接受条件，还多占约 0.5 GB 内存。
2. 不给 runner 绑定 CPU 核，[ADR 0176](0176-ci-on-ovh-vps.md) 的“不限 CPU”不变。

[↑ 返回阅读导航](#decision)

<a id="consequences"></a>

## 后果

- 排队的主要原因是 CI 轮数多、单轮耗时长，不是进程数；加快要靠少跑（草稿 PR 只跑快检查）或缩短最慢的用例，不靠调进程数或绑核。
- 以后要重新评估进程数，需要先把单 runner 测量的噪声降到比差别小，例如每组重复多次取中位数。

[↑ 返回阅读导航](#consequences)

<a id="references"></a>

## 关联文档

- [ADR 0176：CI 迁到 OVH VPS](0176-ci-on-ovh-vps.md)

[↑ 返回阅读导航](#references)
