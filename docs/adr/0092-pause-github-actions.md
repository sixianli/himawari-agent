---
status: superseded
document_type: adr
decision_status: superseded
supersedes: ""
superseded_by: "docs/adr/0156-self-hosted-runner-on-hermes.md"
date: "2026-10-26"
---

# ADR 0092：停用 GitHub Actions，质量门槛只靠本地快速模式检查

<a id="contents"></a>

## 阅读导航

- [背景](#context)
- [决定](#decision)
- [比较过的方案](#options)
- [后果](#consequences)
- [关联文档](#references)

<a id="context"></a>

## 背景

GitHub Actions（GitHub 自带的自动构建和测试服务，下文简称 CI）从 2026-10-26 起一直跑不起来：每个任务开始前就失败，GitHub 提示账号“最近付款失败或需要提高花费上限”。Andy 的付款记录显示，唯一一笔是 2026-10-25 的 GitHub Pro 月费 4.40 美元，状态为成功，所以真正原因更可能是本月免费额度用完。GitHub 官方计费页写着 “usage is blocked once you use up your quota”，而 CI 每次都要在 macOS 上构建和测试，macOS 每分钟的价格约是 Linux 的十倍。这一点还要看 Billing 的 Usage 页才能确认（未核实）。所以每个 PR 都显示红叉，例如 PR #50 的 CI 第 195 次运行，从开始到失败只用了 7 秒。

快速模式（[ADR 0080](0080-document-governance-in-fast-mode.md)，规则在 [delivery-mode.md](../../.agents/instructions/delivery-mode.md)）下，合并进 `main` 本来就不等 CI，真正起作用的门槛是每次提交前的本地检查：相关测试、`npm run check`（其中包括 `npm run check:docs` 文档严格校验）、`npm run build`。CI 的红叉只是干扰，不能说明代码有问题。

2026-10-26 Andy 说不打算为 CI 付费（原话：“这个我不打算做，太费钱了吧！”），又问有没有 CI 的平替。比较完[比较过的方案](#options)后，Andy 于 2026-10-27 在选择卡片上选了“关掉 Actions，只靠本地检查”。

[↑ 返回阅读导航](#contents)

<a id="decision"></a>

## 决定

1. 在仓库设置里关掉 GitHub Actions：Settings → Actions → General → Actions permissions 选 “Disable actions”。关掉后不会再建 CI 运行，PR 上也就不会再出现红叉。这一步需要仓库管理员权限，由 Andy 来点。想恢复时在同一页面选回 “Allow all actions and reusable workflows”。
2. `.github/workflows/` 下的工作流文件、`ci/policy.json` 和 `npm run check:ci-policy` 一律不改。`check:ci-policy` 和 `test/tooling/` 下的测试锁定了工作流的触发方式，只改触发方式会让这些检查报错。不改文件，恢复时也就只需要打开开关。
3. 停用期间，质量门槛就是快速模式的本地检查，跑在云端服务器或 Hermes 上，从不在 MacBook 上跑。GitHub 规则集（ruleset）保持快速模式设置，不等 `ci/required`。
4. 切回完整模式（full）之前，必须先重新打开 Actions，或者另做一个决定。完整模式的规则集要求 `ci/required` 通过，Actions 关着时这项检查永远不会出现，所有合并都会被卡住。

[↑ 返回阅读导航](#contents)

<a id="options"></a>

## 比较过的方案

- **在 Hermes 上跑 GitHub 自托管 runner（在自己的机器上执行 GitHub 的 CI 任务）**：现有工作流基本不用改。GitHub 官方计费页写着 “GitHub Actions usage is free for self-hosted runners”。GitHub 原先宣布从 2026-03-01 起向自托管 runner 按每分钟 0.002 美元收费，后来宣布推迟，但没说永远不收。放弃的原因是 Hermes 还要出上线包、跑受保护的第 3、4 层测试，测试期间 Hermes 上有别的进程，这次测试就作废（[test-and-production-hosts.md](../../.agents/instructions/test-and-production-hosts.md)）；根分区也只剩约 7 GB。
- **在 Hermes 上自建 Woodpecker 或 Gitea Actions（开源 CI 服务）**：不花钱，但要多维护一个服务，和测试、出包抢 Hermes 的问题也一样，工作流还得重写。
- **GitLab 免费版**：每月只有 400 分钟计算时间，还要把仓库同步过去。
- **修好扣款，用 GitHub Pro 自带的每月 3000 分钟免费额度**：官方计费页写明 Pro 每月含 3000 分钟。可以把花费上限设为 0，超出额度就停，不会多花钱。但 CI 跑一次多少分钟没有测量过（未测量）；如果额度确实是被 macOS 任务用完的，重新打开后每个月仍会再次用完。
- **只把工作流改成手动触发（`workflow_dispatch`）**：同样不会再有红叉，但要同时改 `ci/policy.json`、`scripts/ci/check-policy.mjs`、`scripts/ci/main-workflow.mjs` 和多个测试，恢复时也要反着再改一遍，所以不选。

[↑ 返回阅读导航](#contents)

<a id="consequences"></a>

## 后果

- 好处：不花钱，PR 不再显示红叉，Hermes 不多一份负载，恢复只需打开一个开关。
- 坏处：CI 里只有 GitHub 才能跑的检查暂停了，主要是 `main` 合并后的确认运行（`main.yml`）和手动触发的质量运行（`quality.yml`）。所有检查是否真的跑过，只能看提交信息里的 `Fast-mode-checks:` 一行。
- 后续：切回完整模式时，按[决定](#decision)第 4 条先恢复 Actions。

[↑ 返回阅读导航](#contents)

<a id="references"></a>

## 关联文档

- [SOURCE: docs/adr/0080-document-governance-in-fast-mode.md]
- GitHub 官方计费页：[GitHub Actions billing](https://docs.github.com/en/billing/concepts/product-billing/github-actions)（“GitHub Actions usage is free for self-hosted runners”；Pro 每月 3000 分钟）
- GitHub 更新日志：[Update to GitHub Actions pricing](https://github.blog/changelog/2025-12-16-coming-soon-simpler-pricing-and-a-better-experience-for-github-actions/)（自托管 runner 收费推迟）
- GitLab 价格页：[GitLab pricing](https://about.gitlab.com/pricing/)（“400 compute minutes per month”）
