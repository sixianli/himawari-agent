---
status: "active"
document_type: "backlog"
record_id: "BL-20261027-007"
record_state: "done"
date: "2026-10-27"
updated: "2026-10-27"
priority: "normal"
item_type: "bug"
source_idea: ""
review_after: ""
promoted_to: ""
result: "加进 INTENDED_CHANGES：#55 有意把配置模板的模型输入改成 text 和 image；2026-10-27 在 Hermes 复跑，另外 3 项里 2 项是临时脚本没把 node 放进 PATH，1 项（走查预检）在 Hermes 本机必然失败，因为它靠主机名不对来触发"
reason: ""
supersedes: ""
superseded_by: ""
---
# 出包模板回归测试跟上图片附件对配置模板的改动

## Summary

main（c8eb54b）上 scripts/delivery-mode/test_make_packet.py 的 test_twelfth_parameters_rebuild_the_frozen_twelfth_packet_except_intended_changes（拿参数重新生成第十二版包、和冻结的第十二版逐个文件比对的回归测试）失败：maintenance/production-shape-config-template.json（生产配置的模板）和第十二版不同，但不在测试的“有意改动”清单 INTENDED_CHANGES 里。这个文件最近一次由图片附件 PR #55（提交 455be86）修改，PR #57 之前就失败，2026-10-27 11:25 JST 在云端复现。要做：确认 #55 对这个模板的改动是有意的，然后把它加进 INTENDED_CHANGES；若不是有意的，改回模板。另外 Mac 线程在 Hermes 上报告的另外 3 项失败（test_config_expectations_follow_what_production_has ×2、test_a_walkthrough_preflight_failure_refuses_the_packet）在云端没有复现，修这一项时顺便在 Hermes 上复跑确认。

## Origin

- Captured directly.

## Notes

- Add evidence, constraints, and decisions here as the item is reviewed.
