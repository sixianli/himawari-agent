# 作者说明：PR 459 第 3 轮，看第 2 轮之后的修改

背景同前两轮：这个 PR 让固定工具链能装在 linux-arm64 上，工作流和策略都不动。第 2 轮没有中、高意见，但低的修改超过了记账的规模上限，所以再复核一轮。这一轮的增量里有两类修改。

一、对第 2 轮意见的修改（逐条判断在 `.agents/reviews/pr-459/round-2/judgments.md`）：

- `scripts/ci/install-tools.mjs`：linux-x64 和 linux-arm64 的 wheel 规则只认 manylinux、musllinux 的平台标签和 none-any；wheel 文件名的包名、版本两段必须等于锁里的 `name`、`version` 字段（包名把 `-`、`_`、`.` 归一后不分大小写比较）。
- `scripts/ci/run.mjs`：`runCheck` 在建输出目录之前，对 build、browser、coverage 先调 `artifactPlatformKey()`。
- 测试：`toolchain-platforms.test.mjs`、`runner-orchestration.test.mjs`、`toolchain.test.mjs`（只改标题）。

二、两处 CI 故障的修复，和 ARM 无关，因为所有 PR 的 CI 都被它挡住，放在这个 PR 一起合：

- `package.json` 的 `typecheck` 和 `scripts/ci/quality.mjs` 的两次 tsc：改成 `node --max-old-space-size=4096 node_modules/typescript/bin/tsc …`。起因：main 上 `tsc -p tsconfig.json` 用到约 2.1 到 2.5 GB 内存，超过 Node 默认的堆上限时以 134 退出（把上限压到 1800 MB 可以复现）。CI 机器的两个普通 runner 合用 18 GB 内存上限。测试：`run-all-checks.test.mjs`、`quality-local.test.mjs`。
- `scripts/ci/run.mjs`：security 检查里某一项扫描没通过时，往标准输出写一行 `security scan <哪一项>: <状态> <错误码>`，经 `redactText` 处理。起因：作业日志只有“2 passed, 1 failed”，看不出是哪一项。测试：`runner-orchestration.test.mjs`。

请重点核对：

1. 新的 wheel 规则和包名、版本校验，会不会拒绝现在锁文件里任何一个合法的 wheel（三个平台都看；注意 `ruamel.yaml.clib` 这类文件名里保留点号的包，以及 `Pygments`、`PyJWT` 这类大小写不同的包）。
2. `runCheck` 里新加的提前拒绝，在 linux-x64 和 macOS 上有没有任何行为变化；它放在 `selectCheck` 之前还是之后有没有问题。
3. `--max-old-space-size=4096`：`npm run typecheck` 在没有 `node_modules/typescript/bin/tsc` 的布局下会不会坏（工作区的依赖是否提升到根目录）；`quality.mjs` 里用下载的另一个版本的 Node 跑 tsc，这个参数放在脚本路径之前是否正确。
4. security 那一行输出会不会把扫描到的秘密或带秘密的报错原文写进日志（`entry.error` 可能取到哪些值，看 `scripts/ci/check-security.mjs`）。
