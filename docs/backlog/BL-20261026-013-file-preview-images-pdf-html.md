---
status: "active"
document_type: "backlog"
record_id: "BL-20261026-013"
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
# 文件预览支持图片、PDF 和网页渲染效果

## Summary

第三期右侧预览只能显示 Himawari 用写文件、改文件工具写出的文本文件，内容来自每一步的记录。命令生成的图片、PDF 和 Office 文件要新加一个按对话读工作目录文件的接口（检查这段对话的权限、只读、限大小）；网页文件要显示渲染后的效果，需要单独一个隔离的预览地址，因为控制中心的安全策略（style-src 'self'，没有 frame-src）会挡住网页自带的样式和内嵌框架。超过 64K 字的文件记录被截断，也要靠这个接口读全文。

## Origin

- Captured directly.

## Notes

- Add evidence, constraints, and decisions here as the item is reviewed.
