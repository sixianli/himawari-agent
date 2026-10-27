---
status: "active"
document_type: "backlog"
record_id: "BL-20261027-010"
record_state: "open"
date: "2026-10-27"
updated: "2026-10-27"
priority: "normal"
item_type: "bug"
source_idea: ""
review_after: ""
promoted_to: ""
result: ""
reason: ""
supersedes: ""
superseded_by: ""
---
# 修好 Hermes 测试机上一直重启的 himawari.service

## Summary

Hermes 测试机的 himawari.service（测试入口 https://himawari-test.siyi.win 背后的服务，监听 127.0.0.1:18082）从约 2026-10-13 起启动即以退出码 1 失败、systemd 每次自动重启，2026-10-27 13:29 JST 读到重启计数 83008。测试账号能看到 systemd 的状态行，看不到程序自己的报错；服务配置和状态目录要 sudo 才能读。影响：生产改配置或改登录方式前没法按 BL-20261027-008 先在测试机上试通（2026-10-27 切换 Cloudflare Access 就因此直接上了生产）。要做：由 Andy 用 sudo 跑一段只读脚本取出最近一次启动的报错和配置摘要，判断是修还是停用这个服务，再决定测试机怎样承担“先试一遍”。

## Origin

- Captured directly.

## Notes

- Add evidence, constraints, and decisions here as the item is reviewed.
