# 作者说明：第 5 轮，整份 PR 完整复核

第 3 轮的 `--previous` 写错，复核链断了，所以这一轮对整份 PR 重新完整复核一次。

PR 内容：
1. 没有 `/lib64` 的主机（aarch64 Ubuntu）上，测试夹具生成只读目录清单时对 `/lib64` 做 realpath 会失败。新增 `packages/testing/src/read-only-toolchain.mjs` 的 `resolveReadOnlyToolchainPaths`：只对 `/lib64` 在 lstat 报 ENOENT 时跳过，其他错误照常抛出；四处调用方改用它；单元测试 9 个。ADR 0253 同步修订（ARM 工具进现有 ci/toolchain-lock.json、PR 1 范围、去重可关闭）；`scripts/platform-assumptions.json` 更新。
2. ARM 测试机试跑 policy 时三条 tooling 用例超过 5 秒：`test/tooling/prod-read.test.mjs` 两条的测试库改为不落盘、批量插入放一个事务；`test/tooling/review-gateway.test.mjs` “Magpie 起不来”那条不再做真实安装，直接给不存在的可执行文件路径。被测脚本和断言不变，没有加大时限。

前几轮已判为“可以更好”、不改的意见见 `.agents/reviews/pr-460/round-*/judgments.md`。

## 第 6 轮补充

本轮只因合并 origin/main 后 test/integration/sandbox-preparation-control.test.ts 的导入冲突需要重新对齐复核链：冲突解决为保留 main 的新导入并加上 resolveReadOnlyToolchainPaths 的导入。其余改动与第 5 轮相同。
