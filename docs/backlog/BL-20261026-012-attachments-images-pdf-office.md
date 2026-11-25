---
status: "active"
document_type: "backlog"
record_id: "BL-20261026-012"
record_state: "open"
date: "2026-10-26"
updated: "2026-10-27"
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
# 附件支持扫描件和旧版 Office 文件

## Summary

对话界面 v6 第二期已经支持文本类文件、PDF、Word（.docx）、Excel（.xlsx）和 PowerPoint（.pptx）：网页在浏览器里把文件转成文字，经附件接口加密保存，消息里只带附件引用，发给模型时展开（见 [ADR 0090 的附件一节](../adr/0295-web-chat-interface.md)）。还没做的：

- 扫描件 PDF 和只有图片的文档：没有文字层，需要文字识别（OCR，从图片里认出文字），或者在浏览器里把每页画成图片，再按图片交给模型。
- 旧版 .doc、.xls、.ppt：二进制格式，浏览器里没有轻量的读取库，需要服务端转换。

## Origin

- Captured directly.

## Notes

- 2026-10-27：图片已经做了，见 [ADR 0093](../adr/0093-chat-attachments-images.md)，这一项只剩扫描件和旧版 Office 文件。
