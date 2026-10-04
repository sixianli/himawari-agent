---
status: "active"
document_type: "backlog"
record_id: "BL-20261004-001"
record_state: "open"
date: "2026-10-04"
updated: "2026-10-04"
priority: "low"
item_type: "maintenance"
source_idea: ""
review_after: ""
promoted_to: ""
result: ""
reason: ""
supersedes: ""
superseded_by: ""
---
# runtime-sandbox 手工资格脚本写死 macOS 的 /System，在 Linux 上无法运行

## Summary

packages/runtime-sandbox/scripts/ 下的 qualify-job-host.mjs、qualify-policy.mjs、probe-supervision.mjs 会无条件对包含 /System 的路径列表执行 realpath；/System 只在 macOS 上存在，所以在 Linux 上手工运行这些脚本时，一到这一步就会报 ENOENT 失败。probe-managed-tasks.mjs 在更早的检查里就要求必须是 macOS，不受影响。2026-10-04 工具执行第二轮 stop-02 查过：当前所有测试和 CI 都不会调用这四个脚本，只能手工运行。产品路径测试夹具里的同类问题已在 587c28a 修复，Linux 路径来源是 scripts/operations/hermes-three-fixes-seal.mjs。需要在 Linux 上做手工资格检查时，照同样的方式按平台选择路径。

## Origin

- Captured directly.

## Notes

- Add evidence, constraints, and decisions here as the item is reviewed.
