---
status: "active"
document_type: "backlog"
record_id: "BL-20261027-003"
record_state: "done"
date: "2026-10-27"
updated: "2026-10-29"
priority: "high"
item_type: "bug"
source_idea: ""
review_after: ""
promoted_to: ""
result: "第十九版出包时第二次因旧依赖构建失败（docx-preview）后落地：scripts/delivery-mode/hermes/install-dependencies-if-changed.sh 在切提交后、构建前按 package-lock.json 摘要决定是否重装；DependencyReinstallTest 4 条测试覆盖，见事故清单 I-27"
reason: ""
supersedes: ""
superseded_by: ""
---
# 出包构建时依赖清单变了要自动重装依赖

## Summary

第十四版出包（2026-10-27）在 Hermes 构建一步失败：PR #49 新加了 web-push 依赖（网页推送用的 npm 包），但 Hermes 测试目录里的 node_modules（装好的依赖）还是旧的，scripts/delivery-mode/hermes/build-candidate.sh 只切到新提交就直接构建，不会因为 package-lock.json（锁定依赖版本的清单）变了而重装，于是构建找不到 web-push。当时手动跑 scripts/ci/install-dependencies.mjs 后才过。要做：build-candidate.sh 在切换提交后比较当前 package-lock.json 和上次安装时记下的摘要，不同就先跑 install-dependencies.mjs 再构建，并把是否重装写进 summary；加一个测试复现“锁文件变了但没重装”的情况。证据：第十四版第一次出包输出 `PACKET_REFUSED PACKET_HERMES_STEP_FAILED build exit=8`、`HERMES_BUILD_FAILED BUILD_NOT_PASSED`（第十四版上线线程）。

## Origin

- Captured directly.

## Notes

- Add evidence, constraints, and decisions here as the item is reviewed.
