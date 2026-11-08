# PR 278 第 7 轮逐条判断

- m1 成立，中：新证据是本 Runbook 的 Evidence 一节要求把 journalctl 片段贴给 Claude。改为贴 Magpie 日志前先 grep 确认没有 k=。
- m2 成立，中：&& || 会把检查失败算成读不到。改为逐个路径打印 test -r 的退出码，1 才算通过，其他数字停下。
- m3 成立，中：Magpie 数据目录 /var/lib/magpie（服务的 WorkingDirectory 和 ReadWritePaths）存模型账号密钥，一并检查。限速和 iptables 属于生产加固，不在连接方法范围。
- l1、l2、l3 可以更好：只改措辞或补示例，不改事实。
- l4 不成立：cloudflared 只把 Himawari 网页发到公网（防火墙一节），连接配置里没有 3430；隧道能连本机端口不等于公网能访问 3430。
- l5 成立，低：补一句本节命令只由用户本人执行。
