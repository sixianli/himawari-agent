# ADR 0250 plan-claims 第 8 轮：3 条的处理

- 4：详细设计里 process-row-icons 这一段在 PR 405 分支上，不在当前提交里；`git grep -c process-row-icons HEAD -- docs/execution` 没有结果，所以“还没合进 main”成立。
- 6：f7cbbf01 在 PR 405 的提交里，用 `git show f7cbbf01:docs/execution/specs/2026-11-11-apple-device-body-design.md` 能读到那一段。
- 25：“不存在”的说法，线程用 `grep -rnE '\b(activity|activityIcon)\s*:\s*\{' apps/*/src packages/*/src` 核过，除 tool-activity.ts 外没有结果（同第 5 轮第 17 条）。
