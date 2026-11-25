---
status: active
document_type: adr
decision_status: accepted
supersedes: ""
superseded_by: ""
date: "2026-10-25"
covers: ".agents/instructions/delivery-mode.md"
verified_at: "1f73e976913bbac15088d045988be291fd60d8dd"
---

# ADR 0074：快速模式下由 Claude 直接执行生产上线、回滚和诊断

<a id="contents"></a>

## 阅读导航

- [背景](#context)
- [决定](#decision)
- [比较过的方案](#options)
- [后果](#consequences)
- [关联文档](#references)

<a id="context"></a>

## 背景

[ADR 0073](https://github.com/sixianli/himawari-agent/blob/baf02ebc4f376a27aa2a8d2871cc4a897a42c7e2/docs/adr/0073-fast-delivery-mode.md) 把上线压成一条命令，但仍由 Andy 在 MacBook 上执行，Claude 不登录生产机、不读生产配置和状态目录。第八次上线时，Andy 要亲自跑命令、把输出贴回对话。2026-10-25 他问为什么上线一定要经过他的 MacBook。我们给了三条路：Hermes 当发布机、生产机自己拉取、放开 Claude 直接登录生产机。14:41Z Andy 选了第三条（“选这个”），15:46Z 又说“你自己访问我的云服务吧，我授权了”。

实测：云端会话连不上生产机 `84.247.157.41` 的 22 端口。直连会超时，出网只走 HTTPS 代理，用代理转发 SSH 也被会话的权限检查拦下。生产机的 root 密钥和操作包都在 Andy 的 MacBook 上。

[↑ 返回阅读导航](#contents)

<a id="decision"></a>

## 决定

1. **Andy 在对话里亲口要求上线（例如“上线”），就是这次上线的授权。** Claude 在操作包和 root 密钥所在的机器上执行 `bash scripts/delivery-mode/deploy.sh <操作包目录>`；目前通过 Remote Control 在 MacBook 上执行。回滚同理，用 `rollback.sh <同一目录>`。
2. **脚本的输出 Claude 能自己读。** 任何步骤开始前，先经 SSH 预检：以 root 登上了正确的主机、服务 active、`/opt` 和状态盘的可用空间至少是操作包的两倍；预检不过就停，生产机一点不碰。全程日志写到 `<操作包>/run-logs/`，最后一行 `DEPLOY_RESULT {json}` 给出结果。
3. **出错先恢复服务。** `S2_STOP` 之前失败，旧版本一直在跑，不回滚；`S2_STOP` 及之后失败，立刻自动执行 `rollback.sh` 恢复旧版本，然后再查原因。
4. **生产访问范围。** 为了上线、回滚、诊断，Claude 可以用 `root` 或 `himawari-prod` 登录生产机，读 `/opt/himawari`、`/etc/himawari`、`/var/lib/himawari`。破坏性操作（停服、改配置、删数据）之前先核实证据、先备份；手写脚本的所有检查都放在停服之前；系统命令用绝对路径，例如 `/usr/sbin/runuser`。不打印、不带出、不提交生产密钥；不用生产账号跑测试；做完告诉 Andy 跑了什么。

[↑ 返回阅读导航](#contents)

<a id="options"></a>

## 比较过的方案

- **Hermes 当发布机**：不采用，至少现阶段不用。云端 Claude 要经 MacBook 上的 Tailscale 封装脚本才能到 Hermes，所以还是绕不开 MacBook。
- **生产机自己拉代码、自己出包**：作为下一步。这样能省掉 343MB 的上传，但出包程序目前只在 MacBook 的 `.ci-output` 里，要先搬进仓库。
- **生产机上装 GitHub 自托管 runner，云端触发**：暂不采用。本月 Actions 分钟已经用完；GitHub 宣布过对私有仓库的自托管 runner 按分钟收费，后来据报道推迟了，没能从官方核实，Andy 又不想在外围服务上花钱。

[↑ 返回阅读导航](#contents)

<a id="consequences"></a>

## 后果

- Andy 不用再贴命令和输出，但上线时 MacBook 要开着、不能睡眠，还要批准远程控制。
- 生产机的 root 权限交给了 Agent，没有人工复核这一道。靠预检、先备份、自动回滚兜底。
- 切回完整模式（`DELIVERY_MODE` 为 `full`）时，本 ADR 一并失效，恢复由 Andy 亲自执行生产命令。

[↑ 返回阅读导航](#contents)

<a id="references"></a>

## 关联文档

- [ADR 0073：用 `DELIVERY_MODE` 开关切换快速交付和完整流程](https://github.com/sixianli/himawari-agent/blob/baf02ebc4f376a27aa2a8d2871cc4a897a42c7e2/docs/adr/0073-fast-delivery-mode.md)
- [Delivery Mode 规则](../../.agents/instructions/delivery-mode.md#fast-mode)

[↑ 返回阅读导航](#contents)
