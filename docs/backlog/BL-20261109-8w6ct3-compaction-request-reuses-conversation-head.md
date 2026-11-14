---
status: "active"
document_type: "backlog"
record_id: "BL-20261109-8w6ct3"
record_state: "done"
date: "2026-11-09"
updated: "2026-11-10"
priority: "normal"
item_type: "enhancement"
source_idea: ""
review_after: ""
promoted_to: ""
result: "分两个 PR 做完：PR 346 修了冻结工具下压缩请求发不出去（事故 I-92）；第 2 步见 ADR 0207，摘要请求改用原对话的系统提示、工具和切点前的历史，测试 [COMPACT-2]。压缩触发点按模型配置另作第 3 步。"
reason: ""
supersedes: ""
superseded_by: ""
---
# 压缩请求沿用原对话开头以命中缓存

## Summary

Andy 2026-11-09 说写入待办。现状：Pi 压缩历史时单独请求一次模型，把整段对话改写成一条新用户消息、系统提示换成 Pi 自己的一段，开头和原对话对不上，整段历史按全价计算；Pi 1.5.0 压缩文档仍写明压缩请求不写缓存（docs/kv-cache-guide.md 已知差距第 1 条，.agents/instructions/prompt-prefix.md 第 13 条）。做法：用 Pi 的 session_before_compact 钩子自己组装压缩请求，沿用原对话的系统提示和工具，只在末尾追加“请总结”。前置条件：先合并 Pi 1.5.0 升级；动工前先用生产数据算每月压缩次数和能省的钱（按规则第 12 条比总输入费用），值得再做。

## Origin

- Captured directly.

## Notes

- Add evidence, constraints, and decisions here as the item is reviewed.
