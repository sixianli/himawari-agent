---
status: "active"
document_type: "backlog"
record_id: "BL-20261027-008"
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
# 生产改配置和改登录方式也走上线那套保护

## Summary

2026-10-27 把生产登录方式改成 Cloudflare Access 时停服约 9 分钟（工程案例 30）。要做：改登录方式先在 Hermes 测试机按生产同样的配置试通；生产上改配置、改身份这类操作，也要走上线用的同一套流程：停服前只读预检，失败时自动回滚，并且回滚后确认服务真的能用。

## Origin

- 2026-10-27 12:03 JST，协调方在这次停服后要求记下：登录切换必须先在 Hermes 测试机试通；改配置类操作也要走“停服前预检 + 失败自动回滚并验证可用”的同一套流程。

## Notes

这次手写的切换脚本漏掉了三件事，做这项时都要覆盖：

- 预检要按服务启动时的真实规则核对新配置。这次 `identity.kind` 改成 `cloudflare-access`，但 `publicMode` 还是 `false`；`apps/agent-service/src/service-main.ts` 只在 `publicMode` 为真、或者身份是 `built-in` 时才开网页端口，所以服务照常报“就绪”，网页却打不开。能在停服前用新版程序的配置解析和组装检查跑一遍新配置，就能提前发现。
- 启动时配置自相矛盾应当直接失败：配了 `http`、身份不是 `built-in`、`publicMode` 却是 `false` 时，现在服务不开端口也不报错。这是代码改动，另开合并请求，并配一个修复前失败、修复后通过的测试。
- 回滚只撤回本次改动，不整体换回服务运行时会改写的状态。这次回滚把整个数据库换回了改动前的备份，但服务在新配置下启动时已经把授权编号（fencing token，防止新旧两个进程同时写的递增编号）从 38 加到 39，并写进了数据库和 `/var/lib/himawari/state/authority.json` 两处；数据库退回 38、文件还是 39，启动检查报 `PRODUCTION_AUTHORITY_MIRROR_MISMATCH`。做法二选一：只用一条 SQL 把绑定行改回原值；或者连同 `authority.json` 一起从同一时刻的快照恢复。
- 回滚后要确认网页真的能用（例如 `/api/identity/v1/method` 返回 200），确认不了就停住，不要让 systemd 一直重启。
- 下一次改登录方式的具体配置：`publicMode` 改为 `true`（先读清它还会打开哪些启动检查，例如健康检查里多出的 `identity-trust`）、`identity` 按 Cloudflare Access 的十三个字段写；`owner_identity_bindings` 里主人那一行的 `external_subject_ref` 改为 `sha256:` 加上 sha256(`issuer` + `\0` + Access 用户编号)。先在 Hermes 上用 `himawari-test.siyi.win` 走一遍登录、对话、审批和测试通知。
