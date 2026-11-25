---
status: active
document_type: adr
decision_status: accepted
supersedes: ""
superseded_by: ""
amends: "docs/adr/0120-release-cleanup-on-every-deploy-and-space-preflight.md"
date: "2026-10-31"
covers: "scripts/delivery-mode/packet-template/acceptance/helpers/check-p5-scratch-cleanup.py, scripts/delivery-mode/release-cleanup.py, scripts/delivery-mode/test_release_cleanup.py"
verified_at: "1f73e976913bbac15088d045988be291fd60d8dd"
---

# ADR 0135：生产机 /tmp 里的验收失败现场最多留一份，上线成功后一份不留

<a id="contents"></a>

## 阅读导航

- [背景](#context)
- [业界做法](#industry)
- [决定](#decision)
- [放弃的做法](#options)
- [后果](#consequences)
- [关联文档](#references)

<a id="context"></a>

## 背景

[ADR 0120](0120-release-cleanup-on-every-deploy-and-space-preflight.md) 让每次上线自动清理 `/opt/himawari/releases` 和 `/var/tmp` 下的残留，但没有看 `/tmp`。上线的 S6 验收（在生产机上跑探针的一步）把草稿目录建在 `/tmp/h` 加 4 个字母数字（`scripts/delivery-mode/packet-template/acceptance/helpers/check-p5-scratch-cleanup.py` 第 93 行创建，`run-stage-03.py` 第 104 行校验名字）。验收通过时 `run-stage-03.py` 删掉它；验收失败时按设计保留，代码里写着 `FAILED_ACCEPTANCE_SCENE_RETAINED_NO_AUTOMATIC_DELETION`，只把清单和不超过 1 MiB 的文本拷进证据目录。

于是每失败一次就多留一个目录，没有上限，也没有任何东西回头删。2026-10-31 第二十二版上线停在 S6 之前，Mac 线程发现生产机 `/tmp` 里有 23 个这样的目录，合计约 5.4 GB（6 个各 860–937 MB），最早 10-22；其中 `/tmp/h31t4`（1.1 GB）是那次失败留下的。23 个目录和大小来自 Mac 线程导出的 `/tmp` 列表（项目共享目录 `tmp-listing-production-20261031.txt`），5.4 GB 是协调者转述 Mac 线程的合计，没有逐个相加核对。这是事故 [I-47](../incidents-and-gates.md#incidents)，和 I-33 同一类（上线只装不拆），缺口在另一个目录。

[↑ 返回阅读导航](#contents)

<a id="industry"></a>

## 业界做法

- systemd 的 tmpfiles.d 手册（https://www.freedesktop.org/software/systemd/man/latest/tmpfiles.d.html ，2026-10-31 打开）：清理按时间做，“If a file or directory is older than the current time minus the age field, it is deleted.”，时间取修改时间、访问时间和状态变更时间中最新的。这是按年龄清 `/tmp` 的通用办法，它不知道一个目录是不是最近一次失败的现场，也不知道上线结果。

[↑ 返回阅读导航](#contents)

<a id="decision"></a>

## 决定

1. 上线用的清理脚本（`scripts/delivery-mode/release-cleanup.py` 和远端的 `release-cleanup-remote.py`）加看 `/tmp`：名字符合 `h[A-Za-z0-9]{4}`、是真目录而不是符号链接、权限 0700、属主是 root 或 `himawari-prod`、没有进程在用的目录，按修改时间排序，只留最新的 N 份，其余删除。
2. N 的取值由 `deploy.sh` 决定：上线前那次清理为 1；上线成功后为 0；上线失败（旧版仍在服务或已回退）后为 1。所以任何时候最多留一份给人排查。
3. 上线前检查 `deploy-preflight.py` 新增 `TMP_SCRATCH_WITHIN_LIMIT`：清理之后 `/tmp` 里这类目录仍超过 1 个，就在停服之前停下，并打印 `PREFLIGHT_TMP_SCRATCH`。这样以后验收换了目录名或清理漏了，上线会被挡住，而不是悄悄涨到 5 GB。
4. 测试 `scripts/delivery-mode/test_release_cleanup.py` 比较清理的名字规则和验收创建、校验目录用的规则，两边对不上就失败。
5. 失败时保留现场的设计不变，只加上限。

[↑ 返回阅读导航](#contents)

<a id="options"></a>

## 放弃的做法

- 用 `systemd-tmpfiles` 定时按年龄删 `/tmp/h*`：不知道哪份是最近一次失败，可能删掉刚失败、人还没看的现场；在预检里卡不住；还要改生产机系统配置，需要另外授权。
- 失败时立刻删：失败现场是排查依据，设计上就保留。
- 把验收草稿目录移出 `/tmp`：目录名长度（10 字节）和位置被多处检查写死，改动面大，和“补清理”不成比例。

[↑ 返回阅读导航](#contents)

<a id="consequences"></a>

## 后果

- 每次上线结束后 `/tmp` 里最多一份失败现场（成功后为零），不再累积。
- 失败现场的清单和文本副本仍在证据目录，不受影响。
- 这个目录以外的 `/tmp` 内容（系统目录、不符合名字规则的文件）一律不碰。
- 现有 23 个目录已经由 Mac 线程在 Andy 授权后删掉，`/tmp` 剩 2.8 MB，根盘剩 63 GB（协调者转述 Mac 线程，生产机现场未由本线程核对）。

[↑ 返回阅读导航](#contents)

<a id="references"></a>

## 关联文档

- [ADR 0120：每次上线自动清理并按实测预检空间](0120-release-cleanup-on-every-deploy-and-space-preflight.md)
- [事故 I-47](../incidents-and-gates.md#incidents)
- [案例 65：生产机磁盘每次上线前都不够](../engineering-casebook.md#case-release-cleanup)

[↑ 返回阅读导航](#contents)
