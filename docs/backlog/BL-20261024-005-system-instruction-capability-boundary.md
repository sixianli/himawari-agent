---
status: "active"
document_type: "backlog"
record_id: "BL-20261024-005"
record_state: "open"
date: "2026-10-24"
updated: "2026-10-24"
priority: "normal"
item_type: "defect"
source_idea: ""
review_after: ""
promoted_to: ""
result: ""
reason: ""
supersedes: ""
superseded_by: ""
---
# 系统指令没告诉模型工作目录、沙箱无外网、有没有搜索工具

## Summary

2026-10-24 真实使用复盘第 1、6 项：生产没配公共搜索，模型问天气时在沙箱里 `curl` 失败，最后建议用户“给沙箱放行出站网络或配代理”；写文件时先猜了 `/var/lib/himawari/state/poem.txt`，被拒绝后才 `pwd`。系统指令只有配置里手写的 243 字，加上时间说明；时间说明末尾还固定写“使用真实查询，并核对来源日期”，没有搜索工具时也这样写，会把模型推向沙箱联网。

## Origin

- 2026-10-24 真实使用复盘第 1、6 项（`.ci-output/handoff/2026-10-24-real-use-review-findings.md`，git 忽略的交接文件）。

## Notes

- 2026-10-24 用户同意：系统指令末尾由配置自动生成“本轮能力边界”（沙箱无外网、coding 目录 Grant 的路径、有没有 web_search），“使用真实查询”只在有搜索时出现。路径从目录 Grant 读，不新增配置字段。
- 同日用户批准在生产配置加 `runPolicy.publicSearch` 开启搜索，随下一次生产变更执行；草稿在项目共享文件 `production-change-7/public-search-config-draft.md`，执行前要先只读读回生产登记的作用域合同。
- 可替换搜索供应商的改动在另一条分支（ADR 0071）。以后加上 web_fetch 时，这段能力说明要一起扩展。
