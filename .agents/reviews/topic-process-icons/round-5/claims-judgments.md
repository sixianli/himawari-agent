# ADR 0250 plan-claims 第 5 轮：4 条“找不到”的处理

- 3、4、5：说的是 PR 405 分支上的详细设计。这几条说法本来就不在 main 上，模型只读当前提交，所以找不到。线程用 `git show f7cbbf01:docs/execution/specs/2026-11-11-apple-device-body-design.md` 核过：第 220 行写了“怎样给每个工具加参数、怎样在执行前取走”。`git grep process-row-icons origin/main` 没有结果，说明还没合进 main。
- 17：“目前生产里没有这样的工具”是一句“不存在”的说法。线程用 `grep -rnE '\b(activity|activityIcon)\s*:\s*\{' apps/*/src packages/*/src` 核过，除了 tool-activity.ts 没有别的结果。
