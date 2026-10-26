---
status: "active"
document_type: "backlog"
record_id: "BL-20261026-012"
record_state: "open"
date: "2026-10-26"
updated: "2026-10-26"
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
# 附件支持图片、PDF 和 Office 文件

## Summary

对话界面 v6 第二期的附件只支持 64 KB 以内的文本类文件（按 Pi 的 <file name> 格式拼进消息，见 ADR 0090）。图片要等 Andy 决定是否加一个能看图的模型；PDF、Word、Excel、PowerPoint 需要新的上传接口（约 10 MB、带同样的登录和防伪造请求检查）、服务端抽取文字并加密保存，消息里带附件引用，上下文投影时展开成文件块。

## Origin

- Captured directly.

## Notes

- Add evidence, constraints, and decisions here as the item is reviewed.
