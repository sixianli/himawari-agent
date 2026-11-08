# PR 291 第 2 轮复核：逐条判断

复核 336ff040 之后到 aee93e10 的修改，只用 DeepSeek。Mac 上直连 OpenCode Go 两次都没有结果（第一次 19 步后服务不再响应、25 分钟超时，第二次 0 步；本机探测报 Go 本周额度用完）。Andy 2026-11-08 说“云端会话跑复核”，第三次由云端会话走 `--gateway magpie`，CodeBuddy 国际版接下全部 55 个请求，用了 7.65 积分，账本折算 0.0803 美元。账本累计 0.7056 美元（含两次中断运行的预留）。

## DeepSeek

- d1「coverage 作业 60 分钟预算现在要装下六个项目，存在超时风险」：不成立，和第 1 轮 d5、g1 是同一条，模型自己写明“没有运行数据，无法核实”，没有新证据，涉及的代码也没改。理由同第 1 轮：e2e、pi-compat 在 Hermes 上合计 25.7 秒，原 test 作业的时间主要花在本来就在 coverage 里跑的 unit、integration 上。VPS 实测耗时等本 PR 的 CI 跑完记进 PR。
- d2「`coverageFailed` 把 collectCoverage 和 compareCoverage 混在一起」：成立，会出错，低（模型给“低”）。覆盖率比较的准备步骤自己抛错、没有经过 `command` 时，`result` 没被任何一步写过，e2e、pi-compat 失败却因为 `coverageFailed` 为真而不写，结果停在初始的 `infrastructure_failed`、退出码 1。已修：不再看 `Promise.allSettled` 的结果，改成看此前有没有命令以非零退出（`details.commands`），有就保留那个命令写下的状态和退出码，没有才写 e2e、pi-compat 的。比较步骤里的命令失败时会经 `command` 写下状态，照样保留。新增一条用例：只有比较失败、e2e 和 pi-compat 退出码为 3，期望 `failed`、3；换回 aee93e10 的 `run.mjs` 时这条失败（Hermes evidence6 `reverse-run`）。
- d3「environment 测试没有真正证明宿主传入的 `HIMAWARI_REVIEW_GATEWAY` 会被清空」：成立，会出错，低（模型给“低”）。已修：宿主环境设成 `magpie`，仍期望 tooling 项目里是空字符串。
- d4「这次 PR 合并后，main 的 light 确认会退回 full CI」：不成立。模型自己写明退回 full CI 是安全的兜底、不需要改代码；策略字节变了就重跑一次完整 CI，是 main 确认本来的设计。
- d5「退役作业名仍留在升级辅助函数里，是有意为之」：不成立，只是确认这是有意保留，没有指出问题。

## 结论

成立的“会出错”只有两条低（d2、d3），修改只动 `scripts/ci/run.mjs` 和两个测试文件，按 `--accept-low 2` 记账，不再复核。
