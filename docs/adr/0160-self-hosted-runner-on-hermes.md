---
status: superseded
document_type: adr
decision_status: superseded
supersedes: "docs/adr/0092-pause-github-actions.md"
superseded_by: "docs/adr/0176-ci-on-ovh-vps.md"
date: "2026-11-04"
---

# ADR 0160：CI 改在 Hermes 上的自托管 runner 运行，macOS 检查暂停

<a id="contents"></a>

## 阅读导航

- [背景](#context)
- [Andy 的原话](#owner-decisions)
- [决定](#decision)
- [比较过的方案](#options)
- [后果](#consequences)
- [关联文档](#references)

<a id="context"></a>

## 背景

GitHub Actions（GitHub 自带的自动构建和测试服务，下文简称 CI）从 2026-10-26 起因为托管机器的分钟数用完而跑不起来，[ADR 0092](0092-pause-github-actions.md) 因此关掉了 Actions，质量门槛只靠每次提交前的本地快速模式检查。ADR 0092 当时也比较过在 Hermes（家里的 Linux 服务器，Ubuntu 22.04）上跑自托管 runner（装在自己机器上、替 GitHub 执行 CI 任务的程序），放弃的理由有两条：它会和 Hermes 上受保护的第 3、4 层测试、出上线包抢机器；Hermes 的根分区当时只剩约 7 GB。

2026-11-03 Andy 要求把 CI 改到 Hermes 上运行，恢复合并闸门，同时不花托管分钟数。到 2026-11-04 部署时，ADR 0092 的两条理由情况如下：

- 根分区可用约 19.4 GB（部署后实测），够放 runner 和它的工作目录；另加一道 8 GB 底线，低于它 runner 拒绝接新任务。
- 抢机器的问题仍然存在，用暂停开关处理：受保护测试或出包之前先停 runner，结束后再开（见[决定](#decision)第 5 条）。

CI 的检查规则写在 `ci/policy.json`（CI 策略文件，规定有哪些检查、每个检查跑在哪种机器上）里，由 `npm run check:ci-policy` 锁定。原先 Linux 检查跑在 GitHub 托管的 `ubuntu-24.04` 上，构建和测试还各有一份跑在托管的 `macos-15` 上。

[↑ 返回阅读导航](#contents)

<a id="owner-decisions"></a>

## Andy 的原话

- 2026-11-03，目标：

  > 目标是让 CI 改在家里的 Linux 服务器 Hermes Home（通过 `ssh hermes` 访问）上运行，恢复合并闸门，同时不消耗托管分钟数。

- 2026-11-04，问题是“Hermes 22.04 能否判定 ci/required、磁盘的做法、是否批准打开 Actions 总开关”，三项的推荐分别是：由 Hermes 22.04 的结果判定 `ci/required`；runner 放在根盘上，加 8 GB 底线；批准打开 Actions，时间放在验收 PR 推送之前，打开前再确认一次。回答：

  > 三项都按照你的推荐来

- 2026-11-04，问题是“按这三个条件继续部署吗？（暂停开关；部署后先试跑量时长、磁盘、超时；写新 ADR 取代 0092）”。回答：

  > 按条件继续

- 2026-11-04，Andy 先说以后还会在 macOS 上运行，然后问题是“macOS 任务：选 1（保留但暂不运行，ci/required 暂时只要求 Linux 任务）、2（继续用 GitHub 托管 Mac）还是 3（在一台 Mac 上再装 runner）？”。回答：

  > 选 1

[↑ 返回阅读导航](#contents)

<a id="decision"></a>

## 决定

1. **Linux 检查全部改在 Hermes 上跑。** `ci/policy.json` 里所有 Linux 成员的 `runner` 由 `ubuntu-24.04` 改为 `hermes-home`，`ci.yml` 和 `main.yml` 的 `runs-on` 同步改为 `hermes-home`。`hermes-home` 是只有这台 runner 才有的标签。检查名 `ci/required` 不变。
2. **由 Hermes 的 Ubuntu 22.04 结果判定 `ci/required`。** 生产服务器是 Ubuntu 24.04，所以 CI 通过不代表生产机上也通过；这一点和[测试主机规则](../../.agents/instructions/test-and-production-hosts.md)“一个平台的结果绝不能代替另一个平台”一致。
3. **macOS 的构建和测试保留定义，暂不运行。** 这两个成员在 `ci/policy.json` 里加上 `"paused": true`，不进 workflow 的任务矩阵，`ci/required` 和 `main` 分支的证据收集也不等它们的结果。只有 macOS 成员可以暂停，每个检查至少要有一个没暂停的成员，这两条由 `check:ci-policy` 强制。恢复办法：把 `paused` 去掉，再把这两个成员加回 `ci.yml` 的矩阵。恢复的条件是 Andy 决定了 macOS 检查在哪里跑（例如在一台 Mac 上装 runner，或者为托管 Mac 付费），并且那里的机器准备好。
4. **runner 的身份和限额。** runner 以专用系统用户 `gh-runner` 运行，不在 sudo 组或 docker 组里，看不到 `/data` 和 `/home`，防火墙规则禁止它访问局域网、Tailscale 地址和本机已有服务的端口。服务限额：CPU 最多两个核、内存最多 5 GB、不用交换分区，CPU 和磁盘读写的优先级低于 Hermes 上的其他服务。工作目录在根盘 `/srv/gh-runner/`，每个任务结束后删除它的检出，每天再清理一次三天前的残留。具体配置和操作步骤见 [Hermes 自托管 runner Runbook](https://github.com/sixianli/himawari-agent/blob/34de855ff109a53391cfc0d59706bcf44ba7f4a5/docs/archive/runbooks/2026-11-07-hermes-self-hosted-runner-runbook.md)。
5. **受保护测试和出包之前先暂停 runner。** 在 Hermes 上跑受保护的第 3、4 层测试或出上线包之前，先运行 `/srv/gh-runner/bin/runner-pause.sh`：它等正在跑的任务结束，再停掉 runner 服务；结束后运行 `/srv/gh-runner/bin/runner-resume.sh`。暂停期间新的 CI 任务在 GitHub 上排队，不会丢。
6. **让验收 PR 自己能通过闸门。** `ci/required` 用的是目标分支上那份 `ci/policy.json`，不是 PR 里的，所以改策略的 PR 会被旧策略判失败。按项目已有的做法（integration 和 coverage 两次策略迁移），`resolvePolicySource` 在读到目标分支上的策略时，只要它和改之前的托管写法完全一样（所有 Linux 成员是 `ubuntu-24.04`、macOS 成员是 `macos-15`、没有任何 `paused`），就把它升级成新写法；其他写法一律不动，照常校验。Andy 于 2026-11-04 选择了这个做法。
7. **Actions 总开关在验收 PR 推送之前打开**，打开前再向 Andy 确认一次。`quality.yml` 只能手动触发，其中的 `container` 任务要用 Docker，而 runner 用户按要求不能用 Docker，所以 `quality.yml` 继续用 GitHub 托管的 `ubuntu-24.04`；手动触发它会花托管分钟数。
8. **部署后先试跑一次**，记录每个任务的时长、磁盘峰值和有没有超时；不放宽任何测试时限。试跑结果出来之前，GitHub 规则集仍保持快速模式设置，不要求 `ci/required` 通过；要不要让规则集要求它，等试跑结果出来后由 Andy 决定。

[↑ 返回阅读导航](#contents)

<a id="options"></a>

## 比较过的方案

- **在 Hermes 上跑自托管 runner（选中）**：workflow 基本不变，GitHub 官方计费页写明自托管 runner 不花 Actions 分钟数。代价是 Hermes 多一份负载，要靠限额、低优先级和暂停开关挡住它对其他服务和受保护测试的影响；结果只代表 Ubuntu 22.04。
- **继续用 GitHub 托管机器，修好付费**：不用维护机器，但每月会再次用完免费额度，Andy 不打算为 CI 付费（见 ADR 0092）。
- **把 runner 装在云服务器 `84.247.157.41` 上**：那台机器跑着生产服务，CI 任务会和生产抢资源，不选。
- **macOS 检查继续用托管 Mac，或在 Mac 上再装一个 runner**：前者花钱最多（托管 Mac 每分钟价格约是 Linux 的十倍），后者要一台常开的 Mac；Andy 选择暂停。
- **验收 PR 不加策略升级，`ci/required` 预期失败，合入后再在 `main` 上验证**：不在防篡改保护上开口子，但验收 PR 自己过不了闸门；Andy 选择加升级。

[↑ 返回阅读导航](#contents)

<a id="consequences"></a>

## 后果

- 好处：CI 不再花托管分钟数；PR 重新有 `ci/required` 结果；Linux 检查和以前完全一样。
- 坏处：
  - 只有一台 runner，任务排队依次执行，一次 CI 的总时间比托管机器并行跑时长；具体多长要看试跑结果。
  - macOS 上的构建和测试暂时没人检查，Mac 上的行为一律算未验证。
  - Hermes 关机、断网或 runner 暂停时，CI 任务只能排队等待。
  - 策略升级这段代码在合入后不会再生效，但会一直留在 `check-policy.mjs` 里，和前两次迁移一样。
- 风险：GitHub 曾宣布从 2026-03-01 起向自托管 runner 按每分钟 0.002 美元收费，后来推迟了，但没说永远不收。一旦宣布开始收费，要先向 Andy 报出预计费用，按[花钱先问](../../.claude/rules/owner-standing-rules.md#money-and-models)处理。
- 后续：试跑完成后，由 Andy 决定规则集是否要求 `ci/required`；macOS 检查按[决定](#decision)第 3 条的条件恢复。

[↑ 返回阅读导航](#contents)

<a id="references"></a>

## 关联文档

- [SOURCE: docs/adr/0092-pause-github-actions.md]
- [hermes-self-hosted-runner-runbook.md（已删除，链接指向删除前的版本）](https://github.com/sixianli/himawari-agent/blob/34de855ff109a53391cfc0d59706bcf44ba7f4a5/docs/archive/runbooks/2026-11-07-hermes-self-hosted-runner-runbook.md)
- GitHub 官方计费页：[GitHub Actions billing](https://docs.github.com/en/billing/concepts/product-billing/github-actions)（“GitHub Actions usage is free for self-hosted runners”）
- GitHub 官方文档：[About self-hosted runners](https://docs.github.com/en/actions/hosting-your-own-runners/managing-self-hosted-runners/about-self-hosted-runners)
- GitHub 更新日志：[Update to GitHub Actions pricing](https://github.blog/changelog/2025-12-16-coming-soon-simpler-pricing-and-a-better-experience-for-github-actions/)（自托管 runner 收费推迟）
