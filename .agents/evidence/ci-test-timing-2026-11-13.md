# 各测试项目的耗时（2026-11-13，云端容器，Node 22.23.4，不带覆盖率插桩）

命令：`npx vitest run --config vitest.workspace.ts --project <项目> --maxWorkers 2 --reporter=json`。表里是每个项目所有测试文件各自耗时的合计，和整项目的挂钟时间。云端容器的 Node 比锁定的 22.22.3 新，tooling、unit、integration 各有若干用例因此失败（原来就失败），失败用例的超时会把耗时算大，所以占比比绝对值可信。

| 项目 | 文件数 | 文件耗时合计（秒） | 挂钟时间（秒） |
| --- | --- | --- | --- |
| tooling | 101 | 1231 | 703 |
| integration | 未单独统计 | 未单独统计 | 617 |
| unit | 317 | 188 | 183 |
| contracts | 43 | 33 | 34 |
| pi-compat | 15 | 12 | 15 |
| e2e | 1 | 0 | 5 |

tooling 里最大的三个文件：`opencode-review.test.mjs` 417 秒、`opencode-review-merge-gate.test.mjs` 364 秒、`review-gateway.test.mjs` 222 秒，合计 1003 秒，约占 tooling 的 81%。

`ci/policy.json` 里 policy 检查的 `projects` 原来是 `["tooling"]`，coverage 检查的 `projects` 含 tooling：同一批测试在 policy 和 coverage 里各跑一遍。
