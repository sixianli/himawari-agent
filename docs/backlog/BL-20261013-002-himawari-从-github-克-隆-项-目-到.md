---
status: "active"
document_type: "backlog"
record_id: "BL-20261013-002"
record_state: "open"
date: "2026-10-13"
updated: "2026-10-13"
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
# Himawari 从 GitHub 克隆项目到授权目录并推送新分支

## Summary

用户 G90 采用生产授权根目录 /var/lib/himawari/workspace/，其中 repos/ 放代码项目；G91 决定第四次生产变更先不接入 GitHub。以后接入时：Himawari 把用户的 GitHub 仓库克隆到 repos/<项目名>/，改完推送到新分支由用户合并；推送仍按 ADR 0053 询问，并绑定仓库、分支和提交；GitHub 凭据由用户自己配置，Agent 不接触令牌内容。参照 Claude Code 云端会话和 Codex Cloud 的做法。

## Origin

- Captured directly.

## Notes

- Add evidence, constraints, and decisions here as the item is reviewed.
