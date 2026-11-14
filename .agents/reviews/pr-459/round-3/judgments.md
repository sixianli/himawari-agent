# PR 459 第 3 轮逐条判断

1. linux-arm64 上 policy 检查会失败（模型：高）。成立，中：policy 会跑整个 tooling 测试项目，其中直接调构建、浏览器、覆盖率流程的测试在 ARM 上被新加的拒绝挡住。复现：用预加载脚本把 `scripts/ci` 和 `test/tooling` 看到的 `process.arch` 改成 arm64，6 个相关测试文件 135 条里 59 条失败。已改：新增 `test/tooling/artifact-host.mjs`，这 5 个测试文件和 gate-lifecycle.test.mjs 在不能产出构建产物的主机上把主机固定成 linux-x64 再跑；同样的模拟下 135 条全过。真机没跑过。
2. security 日志行可能带出 `security-exceptions` 的原始报错（模型：低）。成立，低。已改：只有固定错误码才写进日志。
3. 复核记录没加 gitleaks 白名单（模型：低，未核实）。不成立：秘密扫描和 `check:gitleaks` 都通过。
4. wheel 文件名按第一个连字符切（模型：低，稳健性）。成立，可以更好，不改：这是 wheel 规范的写法，不合规范的会被拒绝。

第 1 条是中，对修改再复核一轮。第 2 轮没有中、高意见，所以不算连续三轮没过。
