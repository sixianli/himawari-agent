---
status: active
document_type: adr
decision_status: accepted
supersedes: ""
superseded_by: ""
amends: "docs/adr/0169-pause-runners-by-removing-the-label.md"
amended_by: "docs/adr/0256-gate-job-gets-its-own-runner.md"
date: "2026-11-06"
---

# ADR 0172：恢复 runner 时先加回标签，再启动服务

<a id="contents"></a>

## 阅读导航

- [背景](#context)
- [Andy 的原话](#owner-decisions)
- [决定](#decision)
- [与 ADR 0169 的关系](#amendments)
- [比较过的方案](#options)
- [后果](#consequences)
- [关联文档](#references)

<a id="context"></a>

## 背景

Hermes（家里的 Linux 服务器）上有两个 GitHub 自托管 runner（替 GitHub 执行 CI 任务的程序），名字是 `hermes-home` 和 `hermes-home-2`。CI 任务只派给带 `hermes-home` 标签（runner 身上的一个名字，任务按它挑选 runner）的 runner。按 [ADR 0169](0169-pause-runners-by-removing-the-label.md) 决定第 5 条，Mac 上的恢复脚本 `resume-runners.sh` 先启动 Hermes 上的服务，等 GitHub 显示 runner `online`（在线），最后才把标签加回去。

[ADR 0176](0176-ci-on-ovh-vps.md) 后来把 runner 搬到 OVH 租的 VPS（虚拟专用服务器），runner 改名 `ci-vps-1`、`ci-vps-2`，标签改为 `ci-vps`，脚本改放 `scripts/operations/ci-runner/`，但恢复脚本的顺序没变，所以本决定改的是 VPS 上的这份脚本。下面的现象是搬家前在 Hermes 上观察到的。

观察到的现象（在 Hermes 和 GitHub 上直接看到）：

- 2026-11-05 恢复后，两个 runner 在线、空闲、标签也在，排队的任务却不派下来。第二次连续 26 分钟没有派任务，当时有 18 个运行在排队。只重启 `gh-runner.service`，8 秒内两个 runner 都接到了任务。
- 2026-11-06 换上新的资源上限后恢复，同样要手动重启一个 runner，排队的任务才派下来。

原因是推断，没有找到 GitHub 的官方说明：runner 连上 GitHub 时，GitHub 按它当时带的标签去匹配排队的任务；之后再给在线的 runner 补加标签，不会让排队的任务重新匹配。重启时 runner 已经带着标签，所以马上接到任务，这和推断一致。actions/runner 仓库的 issue 592（<https://github.com/actions/runner/issues/592>）也有用户报告“任务排队之后才上线的 runner 接不到这个任务”，但那里没有官方结论。

[↑ 返回阅读导航](#contents)

<a id="owner-decisions"></a>

## Andy 的原话

- 2026-11-06，问“要不要单独开一个 PR 修恢复脚本，修法是先加标签、再启动服务”时，Andy 回答：

  > 修

[↑ 返回阅读导航](#contents)

<a id="decision"></a>

## 决定

`resume-runners.sh` 的顺序改为：

1. 对账，和以前一样；对不上就什么都不改。
2. 给每个缺标签的 runner 加回 `ci-vps`，再从 GitHub 读一遍。有任何一个没加上或读不到，打印 `RUNNER_RESUME_INCOMPLETE labels: <每个 runner 的标签状态>; services not started`，不启动服务，以退出码 1 结束。
3. 在 VPS 上运行 `runner-resume.sh` 启动已注册的服务。失败时打印 `RUNNER_RESUME_FAILED services=<各服务状态> labels=restored`，以退出码 1 结束。
4. 等 GitHub 显示所有 runner `online`，最多 5 分钟。到时间还没上线，打印 `RUNNER_RESUME_INCOMPLETE services=<各服务状态> labels=restored offline: <没上线的 runner>`，以退出码 2 结束。
5. 全部上线后打印 `RUNNER_RESUMED labels=restored`。

标签先加回去不会让任务派给停着的 runner：服务没启动时 runner 是 `offline`，GitHub 不会把任务派给离线的 runner，任务继续排队。所以第 3、4 步失败时不再把标签去掉。

对账之后任何时候被打断，仍然报告各服务状态和每个 runner 的标签状态，以退出码 130 结束。

[↑ 返回阅读导航](#contents)

<a id="amendments"></a>

## 与 ADR 0169 的关系

修订 ADR 0169 决定第 5 条“恢复先对账，再启服务，最后加标签”：顺序改为先对账、再加标签、最后启动服务。ADR 0169 的其他决定不变。

[↑ 返回阅读导航](#contents)

<a id="options"></a>

## 比较过的方案

- **先加标签、再启动服务（选中）**：runner 一连上 GitHub 就带着标签，和手动重启后能接到任务的情况一样。步骤没有变多。
- **仍然先启动后加标签，加完再重启一次服务**：也能让 runner 带着标签重新连上，但多一次启停；重启时如果已经派下了任务，会打断它。
- **不改，恢复后手动重启**：每次都要有人记得做，忘了就会让排队的任务一直不动。

[↑ 返回阅读导航](#contents)

<a id="consequences"></a>

## 后果

- 好处（待验证）：恢复后不用再手动重启 runner，排队的任务就会派下来。要在下一次真实的暂停和恢复时确认。
- 原因只是推断。如果新顺序下排队的任务仍然不派，说明原因不在加标签的时机，要回到“加完标签后重启一次”的方案。
- 测试：`test/tooling/ci-runner-scripts.test.mjs` 里 `resume-runners.sh` 的用例改为检查两个标签都在启动服务之前加上，并覆盖标签加不上或读不到时不启动、服务起不来或不上线时标签保留、两个时机被打断、标签已在时不重复加。

[↑ 返回阅读导航](#contents)

<a id="references"></a>

## 关联文档

- [ADR 0169：暂停 runner 时先在 Mac 上去掉标签，再在 Hermes 上等空闲后停服务](0169-pause-runners-by-removing-the-label.md)
- [ADR 0176：CI 搬到 OVH 的 VPS](0176-ci-on-ovh-vps.md)
- CI VPS 上的自托管 runner Runbook（运行手册已随 [ADR 0287](0287-ci-runs-on-github-hosted-runners.md) 删除，最后一版在提交 `88e17c24`）

[↑ 返回阅读导航](#contents)
