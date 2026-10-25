---
status: "active"
document_type: "backlog"
record_id: "BL-20261024-003"
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
# bash 非零退出时的提醒把“未核验”说成“可能已修改工作区”

## Summary

bash 命令以非零退出码结束时（错误码 `SANDBOX_COMMAND_EFFECT_UNVERIFIED`），Agent 给模型的 `effectNotice` 和页面的失败原因都写“命令可能已修改工作区文件”。`ls` 一个不存在的文件、`env | grep` 没有匹配，这类只读命令失败时，用户和模型看到的也是这句。2026-10-24 真实使用复盘第 5 项记录了这个现象（`.ci-output/handoff/2026-10-24-real-use-review-findings.md`，git 忽略的交接文件）：模型还得在回复里解释“这是统一的保守提醒”。bash 命令是不是只读，没法从命令文本静态判断，所以不按命令猜。

## Origin

- 2026-10-24 真实使用复盘第 5 项。

## Notes

- 2026-10-24 用户在方案文档里同意“只改措辞”：模型看到的改为“Himawari 没有核验这条命令是否改动了工作区；如果它会写入文件，继续前先检查目标文件”，页面的中、英、日三种文案改为“命令失败，未核验对工作区的影响”。不改协议、错误码和数据。备选方案（Worker 在 bash 前后比对工作区文件清单）没有采用：每条命令要多扫描一次，和首次工具调用提速的方向相反，工作区大时耗时不可控。
- 页面文案没有带退出码 N：页面的失败原因是按错误码查的固定文案，没有退出码参数。退出码仍在工具详情和模型看到的 `effectNotice` 里。
