---
status: "active"
document_type: "backlog"
record_id: "BL-20261027-001"
record_state: "open"
date: "2026-10-27"
updated: "2026-10-27"
priority: "high"
item_type: "bug"
source_idea: ""
review_after: ""
promoted_to: ""
result: ""
reason: ""
supersedes: ""
superseded_by: ""
---
# 上线前检查要按验收的 10 GiB 加安装占用判断硬盘

## Summary

第十三次上线（2026-10-26 15:52Z）第一次停在 S6_ACCEPTANCE：上线前检查 deploy-preflight.py 只要求 /opt 和状态目录空闲不少于包大小的 2 倍（MINIMUM_FREE_FACTOR = 2），当时 11.17 GB 通过；S1_INSTALL 装完新版本又用掉约 3 GB，剩 8.19 GB，而验收脚本 run-stage-03.py 要求根分区空闲不少于 10 GiB，于是报 ORIGINAL_G59_CLOUD_ROOT_FREE_PREFLIGHT_FAILED。服务没停，但白跑了约 8 分钟，还要人删目录后重来。要做：上线前检查第一步就按“10 GiB 加上 S1 实际要占的空间（这次约 3 GB，可由包内产物大小算出）”判断根分区，不够就在任何上线步骤之前停下并说明差多少；加一个测试复现这次的数字。证据：packet-05/run-logs/deploy-20261026T155202Z.log、生产机 thirteenth-20261026-evidence.attempt1-failed-20261026/step-s6_acceptance-*-result.json。

## Origin

- Captured directly.

## Notes

- Add evidence, constraints, and decisions here as the item is reviewed.
