---
status: "active"
document_type: "backlog"
record_id: "BL-20261027-005"
record_state: "open"
date: "2026-10-27"
updated: "2026-10-27"
priority: "normal"
item_type: "improvement"
source_idea: ""
review_after: ""
promoted_to: ""
result: ""
reason: ""
supersedes: ""
superseded_by: ""
---
# 上线走查按稳定的名字或测试编号找元素

## Summary

上线走查测试 test/integration/product-path-browser.test.ts 过去按界面上给人看的文字（例如输入框提示文字）找元素，文案一改走查就失败（第十四版出包，2026-10-27）。PR #54 已把输入框改成按无障碍名称“消息草稿”（i18n 键 threads.draft）找。要做：把走查里其余按显示文字定位的地方都改成按无障碍名称或专门的 data-testid（只给测试用的元素标记）定位，并约定这些名称和编号不随文案修改。

## Origin

- Captured directly.

## Notes

- Add evidence, constraints, and decisions here as the item is reviewed.
