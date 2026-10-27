---
status: "active"
document_type: "backlog"
record_id: "BL-20261027-004"
record_state: "open"
date: "2026-10-27"
updated: "2026-10-27"
priority: "high"
item_type: "process"
source_idea: ""
review_after: ""
promoted_to: ""
result: ""
reason: ""
supersedes: ""
superseded_by: ""
---
# 改界面的 PR 合并前要跑上线走查

## Summary

第十四版出包（2026-10-27）在网页走查一步失败（HERMES_WALKTHROUGH_FAILED VITEST_EXIT 1）：PR #48 把输入框提示文字改成“查新闻、记小事、写首诗，都可以丢给我 🌻”，但上线走查测试 test/integration/product-path-browser.test.ts 还按旧提示文字找输入框。这个测试只在出包时由 scripts/delivery-mode/hermes/run-release-walkthrough.sh 运行，改界面的 PR 合并前没人跑它，所以问题拖到出包才暴露，又要再改一个 PR（#54）重新出包。要做二选一：改了 apps/control-center 界面的 PR 合并前必须跑一次这条走查测试；或者把走查用到的元素定位方式写进前端自己的单元测试，界面一改就在 PR 里失败。

## Origin

- Captured directly.

## Notes

- Add evidence, constraints, and decisions here as the item is reviewed.
