---
status: active
document_type: adr
decision_status: accepted
supersedes: "docs/adr/0191-draft-pull-requests-run-fast-checks-only.md"
superseded_by: ""
amends: "docs/adr/0176-ci-on-ovh-vps.md, docs/adr/0238-ci-job-files-stay-on-the-ci-vps.md, docs/adr/0133-docs-check-removed-from-npm-run-check.md"
amended_by: "docs/adr/0256-gate-job-gets-its-own-runner.md"
date: "2026-11-11"
---

# ADR 0241：草稿 PR 不跑 CI，合并前等 CI 变绿，runner 保留 npm 缓存

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

CI（持续集成，每次推送后自动跑的检查）慢，主要慢在排队，检查本身不慢。2026-11-11 用 GitHub Actions 接口核对了三轮运行（42946115483、42933913757、40161488676）：一次 PR 运行真正跑检查约 33 分钟，从推送到出结果却要 5 小时 22 分到 6 小时 37 分。原因有三条：

- 草稿 PR 每推一次也要跑 4 个作业。按 [ADR 0191](0191-draft-pull-requests-run-fast-checks-only.md)，草稿上的汇总检查 `ci/required` 本来就必然失败，这些运行对合并没有用；`ci.yml` 共 1415 次运行只有 10 次成功。
- 新推送会取消旧运行，但汇总作业带 `always()`（不论上游成败都运行），被取消的运行照样排队等 runner（CI 服务器上替 GitHub 跑任务的程序），而且要装完工具才失败。
- 只改 PR 标题或正文（`edited` 事件）也会在非草稿 PR 上重跑整轮。

另外，快速模式下合并不等 CI（[交付模式](../../.agents/instructions/delivery-mode.md#fast-mode)），CI 只是事后报警：2026-11-10 起 main 上的 CI 每次都在启动前失败，30 多个提交合进去都没人发现。

别人怎么做：草稿 PR 用作业条件跳过、标成“准备合并”后再触发（[Parse Server PR 10610](https://github.com/parse-community/parse-server/pull/10610)）。但 GitHub 把被跳过的作业当成成功（[GitHub 文档：Status checks](https://docs.github.com/en/pull-requests/reference/status-checks)，原话 “A job that is skipped will report its status as ‘Success’”），所以汇总作业不能跟着跳过，否则草稿会显示成“通过”。

[↑ 返回阅读导航](#contents)

<a id="owner-decisions"></a>

## Andy 的原话

- 2026-11-11，最初的要求：“不要在我每做一个新功能的分支上都触发 CI，或者都触发完整的 CI”“同时又尽可能保证这个项目的交付质量”。
- 2026-11-11，问三项取舍（草稿 PR 完全不跑 CI、合并前要等 CI 变绿、runner 上保留 npm 依赖缓存）的建议，三项都建议做之后，答：“同意”。

[↑ 返回阅读导航](#contents)

<a id="decision"></a>

## 决定

1. **草稿 PR 不跑任何检查。**`ci.yml` 里除汇总作业以外的 6 个作业（`policy`、`static`、`build`、`browser`、`coverage`、`security`）都带同一个条件 `github.event_name != 'pull_request' || github.event.pull_request.draft != true`，草稿 PR 上全部跳过；main 调用、手动运行、非草稿 PR 照常运行。
2. **汇总作业第一步就判草稿和被取消的运行失败。**`ci/required` 仍带 `always()`，但第一步（在检出代码、装工具之前）是一段不依赖任何安装的 bash：草稿 PR 打印 `CI_DRAFT_UNVERIFIED` 并失败；任何上游作业的结果是 `cancelled` 时打印 `CI_UPSTREAM_CANCELLED` 并失败；两个值缺失或不是 `false` 时同样失败。这一步失败后，上传汇总结论和删除共享目录的步骤也不运行（条件是 `always() && steps.entry.outcome == 'success'`）；这修改了 [ADR 0238](0238-ci-job-files-stay-on-the-ci-vps.md) 决定第 1 条里 `remove` 的“`if: always()`，不论成败都删”：现在是入口检查通过后不论成败都删，入口检查失败时不删，被取消的运行留在 CI 服务器共享目录里的文件由每小时的清理在 6 小时后删掉。整轮被取消时，GitHub 也可能直接把汇总作业标成取消、入口检查根本不运行；两种结果都不是成功，合并和 main 的证据都不会把它当通过。草稿保持失败而不是跳过，是因为跳过会显示成功，还可能被 main 的轻量确认当成证据（`scripts/ci/main-evidence.mjs` 只认结论为成功的 PR 运行）。
3. **只改 PR 标题或正文不再触发 CI。**`pull_request` 事件只保留 `opened`、`synchronize`、`reopened`、`ready_for_review`，去掉 `edited`，并发组也去掉 `edited` 那一段。没有用“`edited` 时只在改了目标分支时才跑”的写法：那样只改标题的那一轮会把 `ci/required` 跳过，GitHub 会在同一个提交上记一个“成功”，盖掉之前真实的结果。改了 PR 的目标分支后，要推一个新提交（或关闭再重开 PR）才会重跑。
4. **合并前等 CI 变绿。**这修改了 [ADR 0176](0176-ci-on-ovh-vps.md) 和[交付模式](../../.agents/instructions/delivery-mode.md#fast-mode)里“合并进 `main` 不等待 `ci/required`”（ADR 0073 定、经 ADR 0080 由现行的 [ADR 0133](0133-docs-check-removed-from-npm-run-check.md) 继承的快速模式暂停规则里，“合并前等 CI”不再暂停）：快速模式下，合并前 PR 最新提交上的 `ci/required` 必须是成功；本地的基本检查照样必过。线程开始代码复核时就把 PR 标成“准备合并”，CI 和复核同时跑。CI 本身坏了（runner 停机、GitHub 故障或额度拦截、失败已确认与本 PR 无关）时，只有 Andy 明确说这次不等 CI，才能在 CI 没变绿时合并；线程把他的原话和 CI 失败的原因写进 PR 描述。规则集是否强制要求 `ci/required`，仍由 Andy 用 `scripts/delivery-mode/github-ruleset.sh` 决定，本决定只改代理的规矩。
5. **runner 上保留 npm 依赖缓存。**npm 下载缓存从每次检出都清掉的 `.ci-output/npm-cache` 挪到 runner 账号目录，并入 [ADR 0181](0181-persistent-verified-download-cache-on-runners.md) 的上限和清理；只缓存下载的包，不缓存 `node_modules`，better-sqlite3 照旧每次现编译并跑探针。这一条在后续 PR 里实现。
6. `scripts/ci/check-policy.mjs` 把第 1 到 3 条写成硬规则：6 个检查作业必须正好带草稿条件；汇总作业的第一步必须正好是那段入口检查；上传汇总结论和删除共享目录只能在入口检查通过后运行；事件类型和并发组必须正好是上面的写法。`test/tooling/policy.test.mjs` 有对应的反向用例，`test/tooling/ci-optimization.test.mjs` 实际执行入口检查那段 bash。

[↑ 返回阅读导航](#contents)

<a id="options"></a>

## 比较过的方案

- **草稿继续跑 `policy`、`static` 等快检查（ADR 0191 的做法）**：放弃。这就是 Andy 不接受的“每个分支都触发 CI”；线程本地已经跑 `npm run check`，草稿上再跑是重复。
- **汇总作业改成 `!cancelled()`**：放弃。被取消的运行会把汇总作业跳过，显示成成功。
- **草稿上让汇总作业也跳过**：放弃，同上，跳过算成功。
- **只在 `edited` 改了目标分支时重跑**：放弃，原因见决定第 3 条。
- **合并继续不等 CI**：放弃。CI 只能事后报警，main 连续 30 多次没跑 CI 都没人发现。

[↑ 返回阅读导航](#contents)

<a id="consequences"></a>

## 后果

- 草稿 PR 每次推送只占 runner 几秒（汇总作业的入口检查），队列里只剩准备合并的 PR 和 main。被取消的运行同样几秒内结束，或者整轮被 GitHub 标成取消。
- 草稿 PR 上没有任何服务器端反馈，只靠线程本地的基本检查；想看完整结果就把 PR 标成准备合并。
- 草稿上的 `ci/required` 仍显示失败，原因写在日志第一行 `CI_DRAFT_UNVERIFIED`，不用修。
- 合并要等 CI，所以 CI 一坏所有合并都会停下，直到修好或 Andy 说这次不等。2026-11-11 GitHub 产物额度被撑满期间就是这种情况（[ADR 0238](0238-ci-job-files-stay-on-the-ci-vps.md)）。
- 改了目标分支不会自动重跑，要推新提交。
- 被取消的运行留在共享目录里的文件过了 6 小时，在下一次每小时清理时删掉，最多约 7 小时（清理每小时一次，另有最多 5 分钟的随机延迟）。

[↑ 返回阅读导航](#contents)

<a id="references"></a>

## 关联文档

- [ADR 0133：快速模式的现行规则](0133-docs-check-removed-from-npm-run-check.md)
- [ADR 0176：CI 迁到 OVH VPS](0176-ci-on-ovh-vps.md)
- [ADR 0181：runner 上的持久下载缓存](0181-persistent-verified-download-cache-on-runners.md)
- [ADR 0191：草稿 PR 只跑快检查](0191-draft-pull-requests-run-fast-checks-only.md)（被本决定取代）
- [ADR 0238：CI 作业之间的文件放在 CI VPS 上](0238-ci-job-files-stay-on-the-ci-vps.md)
- [交付模式](../../.agents/instructions/delivery-mode.md)

[↑ 返回阅读导航](#contents)
