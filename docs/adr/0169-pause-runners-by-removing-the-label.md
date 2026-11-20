---
status: active
document_type: adr
decision_status: accepted
supersedes: ""
superseded_by: ""
amends: "docs/adr/0160-self-hosted-runner-on-hermes.md"
amended_by: "docs/adr/0176-ci-on-ovh-vps.md"
date: "2026-11-05"
---

# ADR 0169：暂停 runner 时先在 Mac 上去掉标签，再在 Hermes 上等空闲后停服务

<a id="contents"></a>

## 阅读导航

- [背景](#context)
- [Andy 的原话](#owner-decisions)
- [决定](#decision)
- [与 ADR 0160、0171 的关系](#amendments)
- [比较过的方案](#options)
- [后果](#consequences)
- [关联文档](#references)

<a id="context"></a>

## 背景

Hermes（家里的 Linux 服务器）上有两个常驻的 GitHub 自托管 runner（替 GitHub 执行 CI 任务的程序），见 [ADR 0160](0160-self-hosted-runner-on-hermes.md) 和 [ADR 0171](0171-two-runners-on-hermes.md)。在 Hermes 上跑受保护的第 3、4 层测试或出上线包之前要先暂停 runner。

原来的暂停脚本 `runner-pause.sh` 每 10 秒查一次，只有在同一次检查里两个 runner 都没有任务时才停服务。GitHub 上一直有任务排队时，runner 做完一个任务几秒内就领到下一个，这一刻几乎等不到。2026-11-05 部署前它就没停下来，最后经 Andy 同意直接 `systemctl stop`，打断了正在跑的 `build / linux-x64`。

已核对的事实：

- GitHub 只把任务派给标签匹配的 runner；派出后 60 秒内没被接收就重新排队；排队超过 24 小时任务失败；GitHub 不能保证常驻 runner 停机时不被派任务。来源：[Self-hosted runners reference](https://docs.github.com/en/actions/reference/runners/self-hosted-runners)，原文 “GitHub looks for a runner that matches the job's `runs-on` labels and groups.”、“If the runner doesn't pick up the assigned job within 60 seconds, the job is re-queued so that a new runner can accept it.”、“If the job remains queued for more than 24 hours, the job will fail.”、“In certain cases, GitHub cannot guarantee that jobs are not assigned to persistent runners while they are shut down.”
- 仓库级 runner 的单个自定义标签可以用 REST 接口去掉、加回，需要仓库管理员权限。来源：[REST API endpoints for self-hosted runners](https://docs.github.com/en/rest/actions/self-hosted-runners)。
- 两个 runner 注册时只带一个自定义标签 `hermes-home`（`scripts/operations/hermes-runner/register-runner.sh`），所有 CI 任务都是 `runs-on: hermes-home`。
- 有人公开过同样的做法：先去掉自定义标签，再等 `busy` 变成 `false`（[depau 的 gist](https://gist.github.com/depau/230fbf07f7d5c36a39208d88cbcc3c0d)，个人作品，不是官方来源）。
- 两条官方文档都没有写：runner 正在跑任务时去掉它的标签，这个任务会不会受影响。

方案先让 OpenCode 上的两个模型各自独立出方案，再审核整合后的方案，共花 0.16 美元。两个模型独立得出的主路线与本 ADR 相同；审核时指出的几处问题都已采纳（见决定第 2、3、5、6 条）。

[↑ 返回阅读导航](#contents)

<a id="owner-decisions"></a>

## Andy 的原话

- 2026-11-05，问题是“暂停开关是否按先在 Mac 上去掉 runner 标签、再等手上任务跑完的做法来？方案按规则要请 OpenCode 两个模型讨论，最多花约 0.8 美元，同意吗？”回答：

  > 同意

- 同一天，问题是“新脚本放在 Andy 账号目录里运行（不再开临时 sudo），还是换掉 `/srv/gh-runner/bin/` 里的；暂停失败时保持标签去掉、等手上任务跑完重试，还是把标签加回去？”回答：

  > 这两件事都按照你的推荐

[↑ 返回阅读导航](#contents)

<a id="decision"></a>

## 决定

1. **暂停和恢复的入口在 Andy 的 Mac 上**：`scripts/operations/hermes-runner/pause-runners.sh` 和 `resume-runners.sh`。它们用 Andy 已登录的 `gh` 改标签，用 `hermes-ssh.sh`、`hermes-upload.sh` 操作 Hermes。Hermes 上不放任何 GitHub 凭证。
2. **暂停先去标签，再等空闲，最后停服务。** 先对账：Hermes 上注册过的 runner 和 GitHub 上的同名 runner 一一对上，GitHub 上带 `hermes-home` 的 runner 也都在 Hermes 上，对不上就不改标签、不停服务（这时 Mac 侧已经把三个脚本传到 Hermes）。然后去掉这些 runner 的 `hermes-home` 标签并读一遍确认；有一个没去掉或读不全，就把已发出删除请求的都加回去、不碰 Hermes；这一步被打断时也一样加回。之后每 30 秒查 GitHub，两个都 `busy=false` 时在 Hermes 上运行 `runner-pause.sh --labels-removed 90`：连续 90 秒看不到 `Runner.Worker` 才停服务，看到就不停、Mac 侧接着等。等待上限是 `ci/policy.json` 里最大的 `timeoutMinutes` 加 5 分钟。
3. **一次远程调用不超过 300 秒。** `hermes-ssh.sh` 每次调用最多 300 秒，所以长时间的等待放在 Mac 侧，Hermes 上每次只观察 90 秒；脚本允许的上限是 180 秒，给串行停两个服务留出时间。
4. **暂停失败时标签保持去掉。** 到等待上限还有任务，或 Hermes 那一步出错时，标签不加回；没停的服务继续跑完手上的任务（Hermes 上可能已停掉一部分），打印 `RUNNER_PAUSE_INCOMPLETE labels=removed services=<每个服务当时的状态>`（等待阶段被打断时同样处理）。runner 不会再接新任务，重新运行暂停即可；运行恢复可以撤销。
5. **恢复先对账，再启服务，最后加标签。** 对账不一致就不启动、不加标签；对上了再在 Hermes 上启动已注册的服务，等 GitHub 显示它们 `online`，再加回 `hermes-home` 并读一遍确认；对账之后任何时候被打断，都报告各服务状态和每个 runner 的标签状态。
6. **不再单独在 Hermes 上暂停。** `runner-pause.sh` 不带 `--labels-removed` 时以退出码 64 拒绝；Hermes 上的脚本每次由 Mac 侧传到 `/home/andy/himawari-tests/hermes-runner/` 再运行，用的是现有的窄 sudo 规则（只能启停两个 runner 服务），不用再开临时 sudo。`install-runner.sh` 不再往 `/srv/gh-runner/bin/` 装脚本，删掉那里旧的三个脚本，目录空了就删掉目录。暂停和恢复共用一把锁，不能同时运行。

[↑ 返回阅读导航](#contents)

<a id="amendments"></a>

## 与 ADR 0160、0171 的关系

本 ADR 改动下面几处，其他决定不变：

- ADR 0160 决定第 5 条：受保护测试和出包之前仍要先暂停 runner，但入口从 Hermes 上的 `/srv/gh-runner/bin/runner-pause.sh` 改为 Mac 上的 `pause-runners.sh`，恢复改为 `resume-runners.sh`。
- ADR 0171 决定第 6 条“暂停等两个都没有任务再把两个都停掉”：改为先去标签，再等两个都空闲、连续观察 90 秒后停掉。
- ADR 0171 决定第 7 条的备份清单里仍有 `/srv/gh-runner/bin/`：现在安装时会删掉它，失败回滚时照样放回。

[↑ 返回阅读导航](#contents)

<a id="options"></a>

## 比较过的方案

- **去标签再等空闲（选中）**：GitHub 自己的派发规则保证不再派新任务（除了文档承认的少数情况），不需要在 Hermes 上放凭证。
- **只把等待上限调大**：根因是新任务不断进来，等多久都可能等不到。
- **直接 `systemctl stop`，或靠 SIGTERM 让 runner 自己收尾**：都会取消正在跑的任务（11-05 实际发生过）。
- **在任务开始钩子 `job-started.sh` 里检查暂停标记、让任务失败**：任务显示为失败而不是排队，要人手重跑。
- **一次性 runner，或在 Hermes 上调标签接口**：都要在 Hermes 上放有仓库管理权限的凭证，ADR 0171 已因此放弃。
- **改 workflow 换标签，或关掉 Actions**：动到 `ci/required` 相关的策略检查，影响面大。

[↑ 返回阅读导航](#contents)

<a id="consequences"></a>

## 后果

- 好处：排队再多也能在“最长任务时限 + 5 分钟”内停下，不打断正在跑的任务；暂停期间新任务排队，不显示失败。
- 代价：暂停和恢复只能在 Andy 的 Mac 上做；暂停可能要等一个多小时，代理要在后台运行；暂停超过 24 小时，排队的任务会被 GitHub 判为失败。
- 残余风险：GitHub 不保证常驻 runner 停机时绝对不被派任务；去标签加 90 秒观察把这个空档压小，但不是零。
- 2026-11-05 在 Hermes 上演示（Mac 上的会话，两个脚本在 macOS 自带的 bash 3.2 上运行，退出码都是 0）：去掉标签后新任务排队、没有派给这两个 runner；正在跑的 `static` 在去掉标签后继续跑了约 9 分钟，之后按 Andy 的要求手动取消，所以“一直跑到结束”没有验证；恢复后两个 runner 上线、加回标签，排队任务约 3.5 分钟后开始跑。
- 测试：`test/tooling/hermes-runner-scripts.test.mjs` 用假的 `gh` 和 `hermes-ssh.sh` 覆盖对账不一致、删除失败后加回、删除报成功但标签还在、GitHub 显示忙时不停、Hermes 上观察期内出现任务、等到上限、恢复时先上线再加标签、锁。

[↑ 返回阅读导航](#contents)

<a id="references"></a>

## 关联文档

- [ADR 0160：CI 改在 Hermes 上的自托管 runner 运行](0160-self-hosted-runner-on-hermes.md)
- [ADR 0171：Hermes 上跑两个常驻 runner](0171-two-runners-on-hermes.md)
- [ADR 0168：放宽 Hermes 上 CI 任务的整体时限](0168-longer-ci-job-limits-on-hermes.md)
- [Hermes 自托管 runner 操作手册（已归档）](https://github.com/sixianli/himawari-agent/blob/34de855ff109a53391cfc0d59706bcf44ba7f4a5/docs/archive/runbooks/2026-11-07-hermes-self-hosted-runner-runbook.md#pause-and-resume)

[↑ 返回阅读导航](#contents)
