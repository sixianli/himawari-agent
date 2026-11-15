# tests 作业拆分前的用时（2026-11-15）

来源：main 上 7ea1a6b6c 的 Main confirmation 运行（run 43657965830）里的 `full / tests` 作业（job 132643065942，runner `ci-vps-2`），作业日志末尾“失败诊断”里各项目命令的 `durationMs`。

| 项目 | 用时 |
| --- | --- |
| contracts | 110 秒（`"durationMs":110063`） |
| e2e | 6 秒（`"durationMs":5872`） |
| integration | 2021 秒（`"durationMs":2021486`，这一次有失败，已由 PR 537 修好） |
| pi-compat | 35 秒（`"durationMs":34800`） |
| unit | 596 秒（`"durationMs":596203`） |

作业从 00:33:15Z 开始、01:23:33Z 结束，共约 50 分钟，其中五个项目依次跑约 46 分钟，前面装工具、装依赖、取构建约 3 分钟。

同一次运行里，三个 browser 作业各用 6 到 7 分钟（另一次运行 run 43662602059：chromium 01:33:48Z–01:40:08Z，webkit 01:33:48Z–01:40:59Z）。

CI 服务器有 8 个 vCPU、22 GB 内存，三个检查 runner `ci-vps-1`、`ci-vps-2`、`ci-vps-3` 共用这台机器，三个合计内存最多 16 GB（`docs/runbooks/ci-vps-runner-runbook.md` 第 17、38、67 行）。integration 每次最多开 3 个 worker（`scripts/ci/test-concurrency.mjs` 的 `maximum: 3`），unit 等其他项目只开 1 个，所以单个 tests 作业只用到这台机器的一部分。

同一次运行里 browser 作业 6 到 7 分钟就跑完，而 tests 作业在 `ci-vps-2` 上单独跑了约 50 分钟；这台机器上没有别的作业要跑，另外两个检查 runner 在 browser 作业跑完后空着。

## ARM 上 tooling 测试超时（2026-11-15）

ARM 机器是 4 核 24 GB（`docs/runbooks/ci-vps-runner-runbook.md` 第 180 行“4 核 24 GB”），static 和 tooling 都在这台机器上跑（同一行“policy、static、tooling、security 四项检查写 `runs-on: ci-arm`”）。

- 上一次：run 43657965830 的 `full / tooling` 作业，`artifact.test.mjs`、`prod-read.test.mjs` 各一条测试超过 vitest 的 5 秒默认超时而失败。
- 这一次：run 43662602059 的 `full / tooling` 作业日志，失败的两条是 `prod-read.test.mjs > prod-read.sh lists capabilities as metadata only, running the script read-only` 和 `srt-version.test.mjs > SRT version single source passes the repository as checked in`，两条都是 `Error: STACK_TRACE_ERROR`。
- 两次都各有两条测试超时，失败的测试不全相同：两次都有 `prod-read.test.mjs`，另一条一次是 `artifact.test.mjs`、一次是 `srt-version.test.mjs`。
