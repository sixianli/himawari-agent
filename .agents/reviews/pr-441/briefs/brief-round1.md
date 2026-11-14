# PR 441 第 1 轮作者说明

问题：检查失败时，作业日志里只有“policy/default: failed (2503 passed, 1 failed)”一行，查不到是哪条用例失败。原因有两个：作业摘要没有 API 可读，云端代理只能读作业日志；写进摘要的 `.ci-output/public/diagnostics/` 只收截图和 trace（`scripts/ci/publish.mjs` 按扩展名分），命令日志在 `.ci-output/public/reports/`，放在 CI 服务器共享目录，汇总作业结束时删除。

改动：
- `scripts/ci/ci-summary.mjs`：新增可选参数 `--failed-logs <目录>`。`<目录>/result.json` 的 `status` 不是 `passed`（或文件读不出、不是 JSON）时，`renderFailedLogs` 用 `renderSummary` 渲染该目录下所有 `.log` 文件的最后 120 行（`FAILED_LOG_TAIL_LINES`），沿用原有的遮盖（`redactText`）、私钥标记整份不显示、控制字符替换、64 KiB 上限。`main` 把写进 `GITHUB_STEP_SUMMARY` 的同一份文字经 `logLines` 逐行加 `| ` 前缀后写到 stdout。
- `.github/workflows/ci.yml`：六个检查作业的摘要步骤加 `--failed-logs .ci-output/public/reports`。`scripts/ci/check-policy.mjs` 的逐字比对和 `test/tooling/policy.test.mjs` 同步。
- `quality.yml`、`main.yml` 的命令行不变，但它们的摘要内容现在也会打印到作业日志。
- 文档：ADR 0243 决定第 4 条加补充；设计文档一句。

约束：`reports/` 里的文件已经由 `publish.mjs` 遮盖过，且这一步只在 publish 成功后运行；日志内容来自 PR 的测试输出，不可信；`ci/required` 的汇总结论靠日志里的 `HIMAWARI_GATE_BEGIN/END` 标记取回（`scripts/ci/gate-log.mjs`），不能被伪造；不花 GitHub 的钱；代码不写注释。

请核对：
1. 这个改动会不会改变模型已经见过的请求开头？（只改 CI 脚本，请确认。）
2. 把不可信的日志内容打印到 stdout 是否安全：`| ` 前缀能不能挡住 GitHub 工作流命令（`::xxx::`、`##[xxx]`）；有没有不以换行分隔就能另起一行的字符（`\r`、U+2028 等，注意 `textTail` 已把控制字符换成 `?`、把 `\r\n` 归一）；会不会冒充或破坏 `gate-log.mjs` 的标记解析（检查作业和 `ci/required` 是不同作业，但 `main.yml` 的作业也调用 ci-summary）。
3. 会不会泄露密钥：`reports/` 下的 `.log` 是否都经过遮盖；`result.json` 读不出来时按失败显示是否合适。
4. `main.yml` 两个作业现在也把摘要打印到日志，`main-evidence.mjs discover` 读的是 PR 运行里 `ci/required` 作业的日志，会不会受影响。
5. 64 KiB 上限和 120 行是否会让作业日志过大；多个 `.log` 时排序和截断是否正确。
6. `check-policy.mjs` 的硬规则和 ADR、设计文档是否与代码一致。
