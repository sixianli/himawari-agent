# 只改一个源码文件时 vitest 选出的相关测试数（2026-11-14，云端容器）

做法：在 `claude/project-thread-amclm4` 分支（786b67125）的干净检出上，`npm ci --ignore-scripts` 后，往一个源码文件末尾加一行 `export const __probe = 1;`，对每个测试项目运行 `node node_modules/vitest/vitest.mjs list --config vitest.workspace.ts --project <项目> --filesOnly --json=<文件> --changed HEAD`，数输出里的文件数，再还原。全量文件数用同样命令去掉 `--changed HEAD` 得到。

| 改动的文件 | unit | contracts | integration | e2e | pi-compat | tooling |
| --- | --- | --- | --- | --- | --- | --- |
| 全量 | 317 | 43 | 186 | - | - | - |
| packages/application/src/ports/memory-episodes.ts | 132 | 26 | 165 | 1 | 0 | 5 |
| packages/domain/src/index.ts | 149 | 26 | 166 | 1 | 0 | 5 |
| apps/agent-service/src/cache-hit-monitor.ts | 2 | 1 | 1 | 0 | 0 | 0 |

每个项目一次 `vitest list --changed` 用时 1 到 9 秒（integration 最慢）。

结论：改到被很多地方引用的核心包时，integration 仍要跑约九成；改到边缘文件时几乎不用跑。改到 `scripts/` 以外的源码时 tooling 通常只剩 0 到 5 个文件。
