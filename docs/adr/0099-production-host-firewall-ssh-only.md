---
status: active
document_type: adr
decision_status: accepted
supersedes: ""
superseded_by: ""
date: "2026-10-28"
covers: ""
verified_at: "1f73e976913bbac15088d045988be291fd60d8dd"
---

# ADR 0099：生产机启用主机防火墙，入站只放行 SSH

<a id="contents"></a>

## 阅读导航

- [背景](#context)
- [决定](#decision)
- [比较过的方案](#options)
- [业界做法](#industry)
- [后果](#consequences)
- [关联文档](#references)

<a id="context"></a>

## 背景

2026-10-28 的公网安全只读审计（检查 Himawari 公网入口和源站有没有绕过登录的路）发现：生产机 `84.247.157.41`（Contabo 的云服务器，Ubuntu 24.04）没有任何防火墙。`ufw`（Ubuntu 自带的防火墙管理工具）状态为 `inactive`，`iptables` 和 `ip6tables`（Linux 内核的包过滤规则）三条链默认全部放行，也没有 `nftables` 规则。

当时从公网只连得上 22 端口，原因只是机器上对外监听的程序恰好只有 `sshd`：Himawari 服务监听 `127.0.0.1:8400`，`cloudflared`（Cloudflare 隧道的客户端，网页流量经它从服务器主动连出到 Cloudflare 再回来）只监听本机。也就是说，安全靠的是“没人监听公网”。以后只要有任何程序监听 `0.0.0.0` 或 `[::]`，例如模型用 `bash` 工具起了一个临时服务、或者某个软件包默认开了端口，它就会直接暴露在公网上，绕过 Cloudflare Access（Cloudflare 的登录拦截，只放 Andy 的邮箱）。

Andy 2026-10-28 批准修复（“以上你说的安全动作都做”），并在本线程授权“允许改生产机防火墙”。

[↑ 返回阅读导航](#contents)

<a id="decision"></a>

## 决定

1. **在生产机上启用 `ufw`。** 入站默认拒绝，出站默认放行，转发默认拒绝；只放行 `22/tcp`（SSH 管理登录）。`/etc/default/ufw` 已是 `IPV6=yes`，同一条规则对 IPv4 和 IPv6 都生效。
2. **不开 80、443、8400。** 网页流量走 Cloudflare 隧道，是 `cloudflared` 主动向外连 Cloudflare 的 7844 端口，回包属于已建立的连接，`ufw` 默认放行；隧道不需要任何入站端口。
3. **SSH 不加 `ufw limit`。** `limit` 会拒绝 30 秒内超过 6 次的新连接，而上线脚本会连续开很多 `ssh` 连接，容易把自己挡在外面。SSH 已经只接受密钥登录，暴力猜密码没有意义。
4. **启用时防止把自己锁在外面。** 顺序是：备份现有规则 → 用 `systemd-run --on-active=10min ufw disable` 设一个 10 分钟后自动关闭防火墙的保险 → 先放行 22 再启用 → 保持旧连接，另开新 `ssh` 连接验证能登录 → 取消保险。SSH 和保险都失效时，用 Contabo 面板的 VNC 控制台以 `root` 登录执行 `ufw disable`。
5. **Contabo 面板防火墙暂不启用。** Contabo 2026 年起给每台 VPS 免费提供网络层防火墙，在服务器外面拦截，可以做第二道防线；它要 Andy 自己在面板操作，这次不做，留作可选。

执行记录（2026-10-28 10:41–10:43 JST）：备份在服务器 `/root/firewall-backup-20261028T014151Z/`（`iptables-save`、`ip6tables-save` 的输出为空，因为启用前没有任何规则；另有 `/etc/ufw` 和 `/etc/default/ufw` 的副本）。

[↑ 返回阅读导航](#contents)

<a id="options"></a>

## 比较过的方案

| 方案 | 好处 | 代价 | 结论 |
| --- | --- | --- | --- |
| A：维持现状，靠“只有 sshd 监听公网” | 不用改 | 任何新监听都会直接暴露，模型能执行命令，风险不是假设 | 不采用 |
| B：主机上启用 `ufw`，只放行 22 | Ubuntu 自带，规则简单，开机自动生效，Claude 可以按 ADR 0074 直接执行和验证 | 配错会锁死 SSH，要靠保险和 VNC 兜底 | 采用 |
| C：只用 Contabo 面板防火墙 | 在服务器外面拦，服务器配错也不影响 | 必须 Andy 手动在面板操作；Claude 无法验证和留档；面板配错同样锁死 | 暂不采用，可作为第二道 |
| D：直接写 `nftables` 规则 | 更灵活 | 要自己处理持久化、IPv6、ICMPv6 邻居发现等细节，容易漏 | 不采用 |
| E：SSH 只允许特定来源 IP | 攻击面更小 | Andy 的 Mac 没有固定公网 IP，换网络就登不上 | 不采用 |

[↑ 返回阅读导航](#contents)

<a id="industry"></a>

## 业界做法

- Cloudflare 隧道官方文档：`cloudflared` 只需要出站连接 7844 端口（TCP 和 UDP），不需要入站端口；推荐的做法是“阻止所有入站流量，只允许 `cloudflared` 的出站流量”，示例里唯一的入站规则是管理用的 SSH。[Cloudflare：Tunnel with firewall](https://developers.cloudflare.com/cloudflare-one/networks/connectors/cloudflare-tunnel/configure-tunnels/tunnel-with-firewall/)
- Ubuntu Server 官方文档：`ufw` 默认关闭，用 `ufw allow 22` 放行 SSH 后 `ufw enable` 启用，用 `ufw status verbose` 查看。[Ubuntu Server：Firewalls](https://ubuntu.com/server/docs/how-to/security/firewalls/)
- Contabo 官方博客：面板防火墙免费，在网络层位于服务器前面，启用后入站默认全部拦截，出站不限。[Contabo Firewall Is Here](https://contabo.com/blog/contabo-firewall/)

对比：Himawari 的做法与 Cloudflare 推荐的一致（入站只留 SSH）；没有像云厂商安全组那样在服务器外面再加一层，原因见[方案 C](#options)。

[↑ 返回阅读导航](#contents)

<a id="consequences"></a>

## 后果

- 好处：以后任何程序监听公网地址，外部都连不上；被拦的连接写进内核日志（`journalctl -k | grep "UFW BLOCK"`），启用后几分钟内就有 16 条外部探测被拦。
- 需要注意：以后真要对外开端口（例如不走隧道的服务），必须先 `ufw allow`；排查“外部连不上”时先看 `ufw status`。
- 已验证（2026-10-28）：从 Andy 的 Mac 探测 IPv4 的 22 通，80、443、8400、20241、3000、8080 不通；`ufw status verbose` 显示 22/tcp 的 IPv4 和 IPv6 规则；`iptables` 和 `ip6tables` 的 `INPUT` 默认策略都是 `DROP`；ufw.service 开机启用、`/etc/ufw/ufw.conf` 为 `ENABLED=yes`；新 `ssh` 连接能登录；`https://himawari.siyi.win/` 照常返回 302（跳转到 Access 登录）；`cloudflared` 就绪连接 4 条；`himawari-prod.service` 重启次数仍为 0。
- 没有验证：Andy 的 Mac 没有 IPv6 网络，IPv6 只能从服务器上看到规则生效，没有从外部实测；想在服务器临时起一个监听服务证明“新监听也被拦”，被会话的自动权限检查拦下，改用内核日志佐证；没有重启服务器实测开机后规则仍在（依据是 ufw.service 已启用和 `ENABLED=yes`）。

[↑ 返回阅读导航](#contents)

<a id="references"></a>

## 关联文档

- [SOURCE: https://github.com/sixianli/himawari-agent/blob/7d0ffcd52cbb69d4941871cf9bf08d93f3843da8/docs/adr/0074-claude-runs-production-deployments.md]
- [SOURCE: docs/runbooks/production-server-access-runbook.md#firewall]
- [SOURCE: docs/engineering-casebook.md#case-prod-firewall]

[↑ 返回阅读导航](#contents)
