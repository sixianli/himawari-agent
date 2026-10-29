---
status: "active"
document_type: "backlog"
record_id: "BL-20261029-004"
record_state: "open"
date: "2026-10-29"
updated: "2026-10-29"
priority: "low"
item_type: "enhancement"
source_idea: ""
review_after: ""
promoted_to: ""
result: ""
reason: ""
supersedes: ""
superseded_by: ""
---
# PDF 渲染常驻进程或预热，省掉每次约 2 秒的启动

## Summary

生产机实测（2026-10-29）：make_pdf.py 每次新起 Python 进程约 2.4–2.5 秒，其中只算渲染 0.36 秒，约 2.1 秒是启动 Python、导入 WeasyPrint 和加载字体。可考虑常驻渲染进程或预热，先看第十九版上线后真实做 PDF 的频率和等待感再定，见 ADR 0118。

## Origin

- Captured directly.

## Notes

- Add evidence, constraints, and decisions here as the item is reviewed.
