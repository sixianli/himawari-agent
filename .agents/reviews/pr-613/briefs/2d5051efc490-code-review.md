# PR 613 第 2 轮复核材料

第 1 轮（复核 cd7da40dc）的“会出错”意见已改，见 `.agents/reviews/pr-613/round-1/judgments.md`。改动在 641196132 和 2d5051efc：

- 意见 1：Python 归档的摘要改为按平台从 `ci/toolchain-lock.json` 读，字节数写进 `scripts/delivery-mode/platforms.json`（ARM 还没钉住，写 null，出包按 `PACKET_PLATFORM_UNPINNED` 拒绝）；`packet-template/install/p5-materials.json` 改用占位符，出包核对材料时按平台比摘要。
- 意见 4：出包前先校验平台字段的形状和服务账号的 uid/gid，不合格就拒绝。
- 意见 7：`run-packet-checks.py` 遇到缺失或不认识的平台名直接退出报错。
- 意见 2：ARM 渲染测试改名，并断言 x64 痕迹只留在 ADR 写明推到 PR 3 的三个探测副本目录里。
- 意见 5 和说法核对：ADR 0283 第 70 行改正“Node 也从工具链锁取”的错误说法；前提 3 的两个行号随合入 main 改正；前提 16 写清 ADR 0266 修订的范围。

验证（Hermes）：test_make_packet 148 个通过、test_collect_dependencies 3 个通过；用 891955719、d3d127c71、641196132 三份 `scripts/delivery-mode` 渲染第十二版参数，151 个文件完全相同。

请核对这些修改是否改好了第 1 轮的意见，重点看：新校验会不会误拒现有 x64 实例文件；`p5-materials.json` 的占位符在所有读它的路径上是否都被替换。
