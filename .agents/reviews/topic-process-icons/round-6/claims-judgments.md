# ADR 0250 plan-claims 第 6 轮：3 条的处理

- 3：详细设计在 PR 405 分支上，本来就不在当前提交里；`git grep process-row-icons origin/main` 没有结果。
- 21：这句是“放弃的做法”一节里的选项名，不是现状说法（同第 4 轮第 32 条）。
- 23：“不存在”的说法，线程用 `grep -rnE '\b(activity|activityIcon)\s*:\s*\{' apps/*/src packages/*/src` 核过，除 tool-activity.ts 外没有结果（同第 5 轮第 17 条）。
