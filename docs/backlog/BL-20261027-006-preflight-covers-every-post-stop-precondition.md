---
status: "active"
document_type: "backlog"
record_id: "BL-20261027-006"
record_state: "open"
date: "2026-10-27"
updated: "2026-10-27"
priority: "high"
item_type: "improvement"
source_idea: ""
review_after: ""
promoted_to: ""
result: ""
reason: ""
supersedes: ""
superseded_by: ""
---
# 上线前检查覆盖停服后每一步的前提条件

## Summary

第十四次上线时，停服后的 S6_READ 因为上一次失败留下的临时服务单元而失败，白停了一次服（见工程案例 29 的“后续”）。上线前检查（`scripts/delivery-mode/deploy-preflight.py`，停服前在生产机上做的只读核对）已经补了三项：临时单元名没被占用、目标目录都不存在、根分区空闲足够。要做：把停服后 S3 到 S8 各步脚本自己会检查、而停服前就能查的条件，全部搬到上线前检查里，查不过就不停服。

## Origin

- 2026-10-27 第十四次上线后，协调方要求列出 S3–S8 的全部前提条件并在停服前检查。

## Notes

逐个读过包里 S3–S8 的脚本，停服前就能只读核对、但目前只在停服后才查的条件有：

- 生产配置 `/etc/himawari/config.json` 的摘要等于包里冻结时记录的值；`config.json.next`、`capability-deployment.json.next` 这两个上次留下的半成品都不存在。
- systemd 单元文件 `himawari-prod.service` 的摘要和关键属性（User、Group、UMask 0022、NoNewPrivileges、KillMode mixed、TimeoutStopUSec 35s）符合预期；`himawari-prod.service.<名>.next` 不存在。
- `/opt/himawari/node/bin/node` 的摘要符合预期。
- 签名私钥和第一版公钥都在，权限符合预期。
- bwrap、AppArmor 配置和系统工具的身份（路径和摘要）与包里记录一致。
- 工作区目录及其 `files`、`repos` 子目录的设备号和 inode（文件系统给每个文件的编号）与包里记录一致。
- `worker-token.json` 属主 999、权限 0600。
- 状态目录和数据目录的属主正确；`/opt/himawari/operations` 的各级父目录属主为 root。
- 内核版本自 S6_ACCEPTANCE 起没有变化。

S6_READ 是停服后唯一用 `systemd-run` 起临时单元的步骤；停服后的脚本都不绑定也不检查端口，所以端口不用加。
