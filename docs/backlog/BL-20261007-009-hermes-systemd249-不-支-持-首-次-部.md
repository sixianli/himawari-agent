---
status: "active"
document_type: "backlog"
record_id: "BL-20261007-009"
record_state: "done"
date: "2026-10-07"
updated: "2026-10-08"
priority: "high"
item_type: "verification-environment"
source_idea: ""
review_after: ""
promoted_to: ""
result: "用户G64取消Hermes和云端systemd离线检查；原失败保留，Node/Bash语法与实际ready、身份、握手检查继续保留，清单不再调用离线脚本。"
reason: ""
supersedes: ""
superseded_by: ""
---
# Hermes systemd249不支持首次部署离线检查的root参数

## 当前事实

`confirmed`：Hermes普通账号在新自有短scratch中执行现有 `verify-systemd-offline.sh`。`systemd-analyze --root=<模拟根> --man=no verify /etc/systemd/system/himawari-prod.service` 自然退出1，stderr为 `Option --root is only supported for cat-config right now.`。实际版本 `systemd 249 (249.11-0ubuntu3.22)`。这说明本次既定离线命令在Hermes不支持，不能据此判断unit无效或生产服务有缺陷。

## 原件和边界

[本次离线检查原件](../../.ci-output/tool-execution-audit/2026-09-28/round2/hermes-r69/p5/systemd-static-01/retained/)保留完整命令、版本、五个输入SHA、stdout/stderr和退出码。Node监督器语法与Bash语法为0；原检查要求systemd退出0且stderr为空，没有删除、弱化或改变这两项要求。没有注册、启动或停止任何服务，没有创建账号，没有连接云服务器，没有下载systemd或修改系统。

外层清理同样因同UID不可读进程拒绝删除，本次 `/tmp/hiY8S` 模拟根保留80415字节；相关原因见[BL-20261007-008](BL-20261007-008-同-账-号-不-可-读-进-程.md)。正式云服务器的systemd版本和解析结果未验证；Hermes语法通过不能代替真实成对启动与崩溃恢复。

## 待裁定

请Claude决定不改系统、不新下载且保留原unit与全部检查条件的Hermes离线验证办法，或明确后续另授权的环境适配。Codex未猜测替代命令，也未把脚本语法通过称为systemd离线检查通过。本条保持open，进入stop-09。

- [SOURCE: docs/runbooks/install-start-stop-runbook.md]

## 用户 G64 与 reply-09 的决定

用户 2026-10-08 原话：“这些无关紧要的事情，就算了吧，赶紧上线要紧”。[reply-09 第4节](../../.ci-output/handoff/2026-10-07-codex-round2-cloud-packet-claude-reply-09.md#4-bl-009不做-systemd-离线检查用户-g64)据此明确取消 systemd 离线检查：Hermes 和云端都不运行 `systemd-analyze verify`，清单移除 `verify-systemd-offline.sh`，不在别处补做。原参数错误、退出码和清理拒绝记录仍保留，不改写成检查通过。

Node 和 Bash 语法检查继续保留。首次正式 `systemctl start` 仍需当步用户授权，P9 随后核对 Agent/Worker 双方 ready、身份、握手与只监听 loopback；失败即按P9停止。重启算式仍保留。用户取消的是这一项离线检查，没有批准云端执行或跳过真实启动检查。
