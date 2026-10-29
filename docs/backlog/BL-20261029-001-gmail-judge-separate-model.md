---
status: "active"
document_type: "backlog"
record_id: "BL-20261029-001"
record_state: "open"
date: "2026-10-29"
updated: "2026-10-29"
priority: "normal"
item_type: "enhancement"
source_idea: ""
review_after: ""
promoted_to: ""
result: ""
reason: ""
supersedes: ""
superseded_by: ""
---
# 邮件判断改用只在美欧运行的单独模型

## Summary

主模型改经 Magpie 后（ADR 0117），邮件判断与主对话共用路由组 himawari-main；其中 OpenCode Go 的 DeepSeek 需开启 Global 地区，邮件发件人、标题和摘要可能出美国和欧盟。要给邮件判断单独配一个只在美欧运行、零保留的模型（如 Go 的 GLM-5.3-Flash 路由组），现有 ConfiguredPiModelBindingPort 只允许一个主模型，需要先放开辅助模型的单独配置。

## Origin

- Captured directly.

## Notes

- Add evidence, constraints, and decisions here as the item is reviewed.
