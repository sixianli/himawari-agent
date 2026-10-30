---
status: "active"
document_type: "backlog"
record_id: "BL-20261027-002"
record_state: "done"
date: "2026-10-27"
updated: "2026-10-30"
priority: "normal"
item_type: "enhancement"
source_idea: ""
review_after: ""
promoted_to: ""
result: "没有装定时任务，改为 deploy.sh 在上线前检查之前、成功之后、失败但旧版仍在服务之后自动运行 release-cleanup.py：只留正在服务的版本和回退目标版本，/var/tmp 上线临时目录全删（只留正在服务那一版的操作包），旧证据目录删掉超过 10 MiB 的文件，删前存下小报告和日志，进程或配置在用的不删（Andy 2026-10-30 09:30 JST 项目指令即删除规则；ADR 0120、事故 I-33，测试 test_release_cleanup.py）。生产机上的第一次实际运行等下一次上线。"
reason: ""
supersedes: ""
superseded_by: ""
---
# 每天自动清理也要清生产机上线留下的临时目录

## Summary

每天 04:00 的自动清理（scripts/disk-hygiene/install-schedule.sh）只装在 Mac 和 Hermes 上，生产机没有。生产机 /var/tmp 里每次上线都会留下约 2 GB 的 himawari-<第几次>-<日期> 目录、几百 MB 的 <第几次>-packet-upload 目录，失败重试还会留下 .attemptN-failed-<日期> 改名目录；到 2026-10-26 根分区只剩 8.2 GB，第十三次上线因此卡住，删掉第一到第九版的 8 个目录（17.6 GB）后才上去。要做：给生产机加同样的定时清理，只删已经不在用的旧版本上线临时目录，保留当前版本和回退目标版本的目录、数据库、证据目录；删前记清单，删除要有 Andy 认可的规则。现存约 10 GB 旧目录（第十到十二版和第十三版第一次的改名目录）等 Andy 决定后再删。

## Origin

- Captured directly.

## Notes

- Add evidence, constraints, and decisions here as the item is reviewed.
