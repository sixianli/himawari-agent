# 作者说明：PR 459 第 4 轮，只看对第 3 轮意见的修改

背景同前：这个 PR 让固定工具链能装在 linux-arm64 上，并让 linux-arm64 上明确拒绝会生成或读取构建产物的检查（build、browser、coverage）；ARM 机器之后只跑 policy、static、security。逐条判断在 `.agents/reviews/pr-459/round-3/judgments.md`。

这一轮的修改：

- 第 1 条（ARM 上 policy 检查里的 tooling 测试会失败）：新增 `test/tooling/artifact-host.mjs`，导出 `useArtifactCapableHost()`。它在测试文件开始前判断主机，如果不是 darwin-arm64 或 linux-x64，就把 `process.platform`、`process.arch` 临时改成 linux、x64，文件跑完恢复。`pipeline.test.mjs`、`runner.test.mjs`、`test-timeout-entry.test.mjs`、`runner-orchestration.test.mjs`、`quality-local.test.mjs`、`gate-lifecycle.test.mjs` 在文件顶层调用它。这些文件测的是构建、浏览器、覆盖率的流程，用的是假的执行函数，不依赖本机架构。验证办法：用预加载脚本把 `scripts/ci/` 和 `test/tooling/` 里读到的 `process.arch` 改成 arm64 跑这些文件，改之前 6 个文件 135 条里 59 条失败，改之后全过；整个 tooling 项目在这种模拟下和不模拟时相比，多出的失败只剩 review-gateway.test.mjs 的 5 条，那是模拟本身造成的（它按 arm64 下载了 Magpie 的可执行文件，在 x64 容器里跑不起来）；真 ARM 机器上没跑过。
- `runner-orchestration.test.mjs` 里模拟 linux-arm64 的那条用例，改 `process.platform`、`process.arch` 时不再展开原描述符（原描述符是访问器时会报错）。
- 第 2 条：`scripts/ci/run.mjs` 的 security 日志行只在 `entry.error` 是全大写加下划线的错误码时才带上它；测试加了一条 error 是报错原文的扫描项。

请重点核对：

1. `useArtifactCapableHost()` 在 linux-x64 和 macOS 上是不是完全不做事；它会不会让某条本来该在真实主机架构上验证的断言失去意义（逐个看这 5 个文件里读 `process.platform`、`process.arch` 的地方）。
2. 这 5 个文件之外，`test/tooling/` 里还有没有在 linux-arm64 上会因为 `artifactPlatformKey` 或别的平台判断而失败的测试（policy 检查跑的是 `ci/policy.json` 里 policy 的全部测试项目）。
3. 这些测试文件里有没有会启动真实子进程、依赖真实主机架构的用例，被改成 x64 后在 ARM 上反而出错（例如去找 x64 的可执行文件）。
4. security 日志行的错误码判断会不会把有用的固定错误码也丢掉。
