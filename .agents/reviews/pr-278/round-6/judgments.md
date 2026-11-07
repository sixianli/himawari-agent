# PR 278 第 6 轮逐条判断

合并最新 main 后按规则再复核的一轮。

- d1 成立，中：前几轮判它不成立的依据只写在复核记录里，Runbook 正文没写出处，读者照样会被 ADR 0142 误导。改为在正文写明 Hermes 2026-11-01 装了 magpie-test，引端口快照文件，并说明 ADR 0142 写于安装前。
- d2 可以更好：Andy 的 Mac 上已按这些字段实际连通；完整 XML 和日志路径不改变事实。
- d3 成立，中：生产机上有无 sudo 的 himawari-ci 账号（.agents/instructions/test-and-production-hosts.md 第 9 行）。补一条只读检查，读得到就停下按授权处理。
- d4 可以更好：127.0.0.2 在 macOS 上要先给回环网卡加别名，是改 Andy 的系统设置；单独浏览器已经把 cookie 隔开。
- d5 不成立：cloudflared 隧道只转发 Himawari 网页（runbook 防火墙一节），不转发 3430；这一节没说过「公网连不到」以外的结论。
- d6、d7、d8 可以更好：同前几轮。
