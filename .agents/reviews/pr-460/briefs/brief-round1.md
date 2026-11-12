# 作者说明

目标：aarch64 Ubuntu 没有 /lib64，测试夹具对它做 realpath 会失败。新增 `packages/testing/src/read-only-toolchain.mjs` 的 `resolveReadOnlyToolchainPaths`，只对 `/lib64` 在 lstat 为 ENOENT 时跳过，其他错误照常抛出；四处调用方（product-path-harness、mac-sandbox-deployment、prepared-file-runner 测试、sandbox-preparation-control 测试）改用它。

约束：`isolation.ts` 不改（ARM 上 bwrap 带 `--symlink usr/lib64 /lib64` 探测退出码 0）；`cloud-seal.mjs`、探针及模板副本、`scripts/operations/` 封存脚本明确留给 PR 3；ADR 0253 同步修订（ARM 工具进现有 ci/toolchain-lock.json，PR 1 范围改写）；`scripts/platform-assumptions.json` 已用 `--write` 重新生成。

作者的说法：必需目录缺失、悬空链接、EACCES 都不会被当成“缺失”而吞掉；`mac-sandbox-deployment.ts` 用 `dedupe: false` 保持原来的清单。单元测试 8 个，`npm run check` 51 步通过。两个集成测试在 x86 云容器里改动前后同样有 31 个失败（没有预构建运行时），不是本改动引起。
