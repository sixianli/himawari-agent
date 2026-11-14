# PR 439 第 3 轮作者说明

第 2 轮之后的修改（逐条判断见 `.agents/reviews/pr-439/round-2/judgments.md`）：

- 第 2 轮两条低严重度意见的修改（已用 `--accept-low` 记账）：`test/integration/sandbox-capability-qualification-lifecycle.test.ts` 的“证据不合契约”用例改成只清空 `guarantees`；补一条 `sandbox` 为 null、MCP 清单带沙箱证据被拒的用例。
- CI 的 policy 检查失败：`test/tooling/srt-version.test.mjs` 报 `SRT_VERSION_STALE`，因为两个测试文件里写了字面量 `srt:0.0.0-other`（用来表示“另一个运行时身份”）。改成 `other-runtime`，不再像一个 SRT 版本号。

约束：不改表；代码不写注释；不能只是把检查放宽。

列出的做法只是参考，不要局限于它，请从问题本身出发，提出你认为更好的做法。

请核对：
1. 这个改动会不会改变模型已经见过的请求开头？
2. 把字面量换成 `other-runtime` 后，两条用例还是不是在验证“运行时身份对不上被拒”，有没有因此变成由别的原因被拒。
3. 第 2 轮之后新增或修改的用例有没有写错、起不到作用的。
