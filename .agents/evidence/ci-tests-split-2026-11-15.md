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

CI 服务器有 8 个 vCPU、22 GB 内存，三个检查 runner `ci-vps-1`、`ci-vps-2`、`ci-vps-3` 共用这台机器，三个合计内存最多 16 GB（[ci-vps-runner-runbook.md（已删除，固定链接）](https://github.com/sixianli/himawari-agent/blob/88e17c2430041266de223e41c4163c45d1a02369/docs/runbooks/ci-vps-runner-runbook.md) 第 17、38、67 行）。integration 每次最多开 3 个 worker（`scripts/ci/test-concurrency.mjs` 的 `maximum: 3`），unit 等其他项目只开 1 个，所以单个 tests 作业只用到这台机器的一部分。

同一次运行里 browser 作业 6 到 7 分钟就跑完，而 tests 作业在 `ci-vps-2` 上单独跑了约 50 分钟；这台机器上没有别的作业要跑，另外两个检查 runner 在 browser 作业跑完后空着。

## ARM 上 tooling 测试超时（2026-11-15）

ARM 机器是 4 核 24 GB（[ci-vps-runner-runbook.md（已删除，固定链接）](https://github.com/sixianli/himawari-agent/blob/88e17c2430041266de223e41c4163c45d1a02369/docs/runbooks/ci-vps-runner-runbook.md) 第 180 行“4 核 24 GB”），static 和 tooling 都在这台机器上跑（同一行“policy、static、tooling、security 四项检查写 `runs-on: ci-arm`”）。

- 上一次：run 43657965830 的 `full / tooling` 作业，`artifact.test.mjs`、`prod-read.test.mjs` 各一条测试超过 vitest 的 5 秒默认超时而失败。
- 这一次：run 43662602059 的 `full / tooling` 作业日志，失败的两条是 `prod-read.test.mjs > prod-read.sh lists capabilities as metadata only, running the script read-only` 和 `srt-version.test.mjs > SRT version single source passes the repository as checked in`，两条都是 `Error: STACK_TRACE_ERROR`。
- 两次都各有两条测试超时，失败的测试不全相同：两次都有 `prod-read.test.mjs`，另一条一次是 `artifact.test.mjs`、一次是 `srt-version.test.mjs`。
- 再下一次：run 43666353293（main 上 1baa489cf）的 `full / tooling` 作业没有任何测试失败，结论是 `success`，所以这些测试不是卡住，只是有时超过 5 秒。
- `test/tooling/` 下 101 个测试文件里，59 个起子进程（用 `spawnSync` 或 `execFileSync`），29 个建临时 git 仓库（`git init`），例如 `test/tooling/srt-version.test.mjs` 第 66 行 `execFileSync("git", ["init", "-q"], { cwd: root });`、`test/tooling/prod-read.test.mjs` 第 62 行 `const child = spawnSync("bash", [script, ...args], {`。

## 拆分前的写法（main 上 1baa489cf）

这个 PR 改掉了下面几处，原文抄在这里，供核对“拆分前”的说法。

`ci/policy.json` 第 98–110 行，tests 只有一个成员 `default`，依次跑五个项目：

```json
      "id": "tests",
      "needs": ["policy", "build"],
      "timeoutMinutes": 60,
      "members": [
        {
          "key": "default",
          "runner": "ci-vps",
          "os": "linux",
          "arch": "x64",
          "node": "22.22.3"
        }
      ],
      "projects": ["unit", "contracts", "integration", "e2e", "pi-compat"],
```

`.github/workflows/ci.yml` 第 233–236 行，tests 作业写死在一个 runner 上：

```yaml
  tests:
    name: tests
    if: ${{ github.event_name != 'pull_request' || github.event.pull_request.draft != true }}
    runs-on: ci-vps
```

`vitest.workspace.ts` 第 39–41 行，只有 integration 带 30 秒超时：

```ts
          ...(project.id === "integration"
            ? {
                testTimeout: 30_000,
```
