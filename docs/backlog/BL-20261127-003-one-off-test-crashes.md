---
status: "active"
document_type: "backlog"
record_id: "BL-20261127-003"
record_state: "open"
date: "2026-11-27"
updated: "2026-11-27"
priority: "low"
item_type: "bug"
source_idea: ""
review_after: ""
promoted_to: ""
result: ""
reason: ""
supersedes: ""
superseded_by: ""
---
# main 上各出现一次、原因未查明的测试崩溃

## Summary

CI 优化的第 9 号任务查 main 完整确认失败时，有两次失败各只出现过一次，日志不足以找到根因，也没法在本地复现。先记在这里；再出现一次就拿出来查。

## Origin

- 2026-11-27 Andy 给 CI 优化线程的第 9 号任务：“找出 main 完整确认失败的根因，每一类修掉或放进 Backlog”。

## Notes

- `production-queued-run-restart` 的测试进程报 `ERR_INTERNAL_ASSERTION: memory access out of bounds`。这是 Node 内部断言（WebAssembly 模块越界访问内存时会出现这种报错），不是测试断言；同一个测试在其他运行里都通过。
- `runtime-sandbox` 的 `job-command.unit.test` 报 `STACK_TRACE_ERROR`，只出现过一次。
- 两次都没有重跑才通过的记录，所以不属于第 8 号任务说的“只在重跑才过的测试”。
- 再出现时先做的事：取那次运行的完整日志和测试报告，看是同一个文件、同一个 Node 版本还是同一台机器类型（x64 或 ARM），再决定是测试的问题还是依赖的问题。
