# PR 291 第 1 轮复核：逐条判断

复核提交 336ff040，DeepSeek 0.1380 美元、GLM 0.0874 美元，合计 0.2253 美元。

## DeepSeek

- d1「e2e/pi-compat 测试失败会被记成 `infrastructure_failed`」：成立，会出错，中高（模型给“中”）。`scripts/ci/run.mjs` 的 `runPlainProjects` 在 `runTests` 非零时只抛错，`result` 停在初始的 `infrastructure_failed`、`exitCode: 1`；改前 `test` 分支会设 `failed` 和真实退出码（`git show 34843f52:scripts/ci/run.mjs` 第 469-473 行）。已修：覆盖率部分没失败时记 `failed` 和 e2e/pi-compat 的退出码，覆盖率也失败时保留覆盖率进程的退出码。新增两条用例；把修复换成 `if (false)` 后第一条失败（Hermes evidence4 `reverse-status rc=1`）。
- d2「`upgradeRetiredTestChecks` 的守卫比 ADR 说的窄」：成立，会出错，中高（模型给“低”；判高的理由：ADR 0181 决定 5 写“任何一个字段不同都原样返回”，代码却不比 coverage、required 的其他字段，后来的人会照 ADR 以为已经核对）。已修：coverage、required 两项也和 2026-11-08 main 的原样逐字段比对。新增 3 条反向用例（coverage 少一种输出、coverage 多一个项目、required 时限变了）；把守卫退回只比 test、node-floor 时这几条失败（evidence4 `reverse-guard rc=1`）。
- d3「升级链的真实历史组合没有测试」：成立，可以更好。临时核对：用 5daedc92 的 `ci/policy.json` 和 `ci/coverage-policy.json` 作基准走 `resolvePolicySource`，现有代码通过（evidence4 `focused rc=0`）。这条测试留在提交里，因为 d2 收紧了守卫，需要证明收紧后真正会走到这条链的覆盖率比较基准仍能升级；列给 Andy。
- d4「有几处文字与代码不一致」：成立，会出错，低（模型给“低”）。触发：策略作业集合不对时，报错文字说要 nine 个作业；后果：照样拒绝，只是数字写错，不会给出错误结果。设计文档那句写的是“初始 job 超时”，本身不算错，但补上了现行时限。已修。
- d5「60 分钟 job 时限可能不够（推测）」：不成立。Hermes 第 3 层运行里 e2e 1 个文件、pi-compat 15 个文件用时 25.7 秒（`.ci-output/layer3/coverage-default/tests/pi-compat.json` 的开始和结束时间）；原 test 作业的 33 分钟主要是 unit、integration，而它们本来就在 coverage 里跑。coverage 作业在 VPS 上是 32.6 分钟，加上约 1 分钟远低于 60 分钟。VPS 实测耗时等本 PR 的 CI 跑完记进 PR。

## GLM

- g1「中危（运行风险，「推测+计算」，非代码缺陷）」：同 d5，不成立，理由同上。
- g2「低危（代码与 ADR/作者说法不一致，实际利用面很窄）」：同 d2，成立，已修。
- g3「低危（误导性错误信息）」：同 d4，成立，已修；它另建议加一行注释说明超时名单为什么保留 test、node-floor，不采纳：项目规定不写代码注释，用意已写在 ADR 0181 和提交说明里。
- g4「信息项（已接受的后果，核对属实）」：不指出问题，不成立。

## 本轮另外修的

CI 的 policy 作业在 336ff040 上失败，原因是 `test/tooling/environment.test.mjs` 没跟上 main 的 4be522b3（`vitest.workspace.ts` 给 tooling 加了 `HIMAWARI_REVIEW_GATEWAY: ""`），改前的 34843f52 上同样失败。已改测试：接受并核对这个变量被清空；改回旧测试时失败（evidence5 `reverse-env rc=1`）。
