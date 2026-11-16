---
status: superseded
document_type: adr
decision_status: superseded
supersedes: "docs/adr/0081-isolated-instance-per-person.md"
superseded_by: "docs/adr/0234-one-program-per-person-database-file.md"
date: "2026-10-26"
---

# ADR 0083：每人一个独立的 Himawari 实例，只邀请、不开放注册；Andy 的手机也走 Cloudflare 入口

<a id="contents"></a>

## 阅读导航

- [背景](#context)
- [决定](#decision)
- [比较过的方案](#options)
- [后果](#consequences)
- [关联文档](#references)

<a id="context"></a>

## 背景

2026-10-26 10:32 Andy 提出：Himawari 要能分享给老婆、朋友，以后也许给任何人用，每个人的对话、记忆和个人数据互相隔离，也就是常说的多租户（一套系统服务多个互相看不到对方数据的用户）。他不确定这是不是好需求。

线程读了当前 `main`（提交 `5c5feac`）的代码，查到的情况：

- 数据库 `<stateRoot>/data/product.sqlite` 里几乎每张产品表（对话、消息、运行记录、审批、授权、记忆、提醒）都已有 `owner_id` 和 `agent_id` 两列，记录这行数据属于哪个主人。
- 写死“只有一个主人”的地方在上层：配置只有一个 `ownerId` 和 `agentId`（`packages/platform-node/src/strict-configuration.ts`）；内置账号登录成功后总是返回配置里的那个主人（`packages/platform-node/src/built-in-identity.ts`）；Cloudflare Access 登录只允许绑定第一个身份（`packages/persistence-sqlite/src/sqlite-durable-operations.ts` 的 `bindFirstOwner`）；模型密钥、内容加密密钥和 Bark 推送密钥都在同一个 `secrets/` 目录（`apps/agent-service/src/service-main.ts`）；联网搜索授权的存储键按配置里的主人计算（`apps/agent-service/src/public-search-authorization.ts`）；每日整理和提醒推送只为配置里的主人运行；并发上限 `totalRuns` 和权限版本号 `authority_revision` 是整个服务一份。
- Himawari 会替使用者运行命令、读写文件。[ADR 0069](0069-trust-unprotected-runtime-like-claude-code.md) 的前提是使用者就是可信的主人。
- 生产只监听 `127.0.0.1:8400`，Andy 通过 ssh 隧道访问；家人朋友不会用 ssh 隧道。
- 模型费用不设上限（[ADR 0076](0076-no-model-cost-budget-limits.md)）。
- 2026-10-26 第十、第十一两版上线后生产都出现过“用不了”的事故。

线程查了一手资料（引文见[评估文档](https://claude.ai/artifact/77cUajUv5MWWHHMH8m2g1N)和[工程案例库对应案例](../engineering-casebook.md#case-multi-user)）：AWS SaaS Lens 把多租户分成 silo（每个租户独占资源）、pool（租户共用资源）和 bridge（两者混合）；Azure 指南说共用部署“typically rely on your application code and a tenant identifier that's in a database to keep each tenant's data separate”；Mem0、Zep 都按用户标识分开记忆，Mem0 文档提醒没传的标识不做限制；Cloudflare D1、Turso 推荐每个用户一个 SQLite 库。登录方面，NIST SP 800-63B-4 说“OTP authentication is not phishing-resistant”，passkey（通行密钥）才防钓鱼；OWASP 大模型应用十大风险的 LLM10 把“Denial of Wallet”（别人大量调用把你的模型费用刷爆）列为风险。

线程推荐了下面的方案。2026-10-26T11:12Z Andy 在线程里回复：“我按照最佳最佳方案来做，你上面说的最佳方案，你推荐的方案。”

本 ADR 取代 [ADR 0081](0081-isolated-instance-per-person.md)，只改了决定第 4 条的最后一句。原因：2026-10-26 Andy 问要不要做 iOS App，评估后定为手机端先做主屏网页应用和网页推送（[ADR 0082](0082-mobile-pwa-push-before-native-app.md)），前提是 Andy 的手机能直接打开生产，所以 Andy 自己的实例也要接 Cloudflare 入口，不能再只走 ssh 隧道。2026-10-26T13:05Z Andy 在决定卡片上选了“按推荐走（同意 1–7 条）”，其中第 2 条就是这个改动。其余背景、决定、备选和后果与 ADR 0081 相同。

[↑ 返回阅读导航](#contents)

<a id="decision"></a>

## 决定

1. **方向是“每人一个只属于自己的 Himawari”。** 不做几个人共用一份记忆或私人状态。这和 [PRD v0.1](../prd-v0.1.md) 的“如果未来提供多用户托管服务，每位用户拥有彼此隔离的私人 Agent”一致。
2. **第一步用独立实例（silo）。** 每个人一套独立的 stateRoot、数据库文件、`secrets/` 目录、配置文件、系统服务、系统账号和监听端口，先放在现有生产机上。每个实例内部仍然只有一个主人，所以 [ADR 0003](0003-single-logical-agent-authority.md)、[ADR 0020](0020-public-web-identity-gateway.md)、[ADR 0027](0027-built-in-owner-authentication.md) 在每个实例里照旧成立，不取代。先只给老婆开；她的实例稳定运行两周后，再给最多 2 位朋友开。
3. **只邀请，不开放注册。** 给谁开、什么时候停用都由 Andy 决定，由 Claude 开实例和账号。不做注册页、计费和防滥用。
4. **别人的实例用 Cloudflare Access 登录。** 实例前面接 Cloudflare Tunnel 和 Access 应用，Access 规则只放行 Andy 列出的邮箱，用邮箱一次性验证码登录；实例的 `identity.kind` 用 `cloudflare-access`，服务端照旧核对 Access 发的登录凭证（`packages/platform-node/src/identity-gateway.ts`）。必须先建好 Access 规则，再把网址接到服务器。Andy 自己的实例也接同样的 Cloudflare Tunnel 和 Access 入口，让他的手机能直接打开（[ADR 0082](0082-mobile-pwa-push-before-native-app.md) 第 2 条，Backlog 项 [BL-20261026-004](https://github.com/sixianli/himawari-agent/blob/208007462f99e16c5c8cd4daac2acc10fa9f5f36/docs/backlog/BL-20261026-004-production-cloudflare-entry-for-owner-phone.md)）；他的电脑仍可以用 ssh 隧道。
5. **别人的实例每人每月模型费用上限 10 美元，用模型网关的限额实现。** 2026-10-26T11:23Z Andy 说：“定为每个人十美元吧。”每个别人的实例用自己的一把 Vercel AI Gateway（模型网关；生产的对话模型和记忆嵌入都经它调用，见 `packages/runtime-pi/src/configured-model-binding.ts`、`packages/memory-engine/src/embedding.ts`）API key，给这把 key 设 10 美元、按月重置（每月 1 日 UTC 0 点）的预算，并打开用量达到 100% 时的邮件提醒，发给 Andy。用满后网关对这把 key 的请求返回 HTTP 402，直到下月重置或 Andy 调高额度。产品里不重新加预算代码，ADR 0076 不变：Andy 自己的实例不设上限，产品内的预算账本仍只记账。开工时要核对：别人实例的所有收费调用（对话、记忆嵌入、联网搜索）都走这把 key；网关返回 402 时页面明确显示“本月额度已用完”，而不是笼统的失败。
6. **开工条件。** 第十一版事故修好、新版用真实网页验收通过（对话、搜索、记忆页、设置页）、生产连续 7 天没有“用不了”级别的事故，并且上线脚本能按参数自动生成。条件没满足前不动代码和生产机。
7. **以后的两档。** 用户超过约 5 人，或者分别升级多个实例明显拖慢迭代时，再设计“一个实例按 `owner_id` 隔离”（pool），届时另写 ADR，并先写“用 A 的身份读不到 B 的数据”的隔离测试。对陌生人开放的 SaaS 现在不做；到 pool 阶段如需扩大范围，优先做“自己申请、Andy 批准”。passkey 登录作为以后的加强项。

[↑ 返回阅读导航](#contents)

<a id="options"></a>

## 比较过的方案

- **独立实例（silo，选中）**：几乎不改产品代码，隔离最彻底（不同文件、不同进程、不同系统账号），老婆几天内就能用；代价是每次上线要升级 N 份，内存和磁盘翻 N 倍，各实例版本可能不一致。
- **一个实例按 `owner_id` 隔离（pool）**：运维只有一份；但要改配置结构、登录、服务组装代码、后台任务、密钥、沙箱根目录和调度，这些正是最近两次事故发生的地方，粗估 2–4 周（未测量）。任何一个查询漏带 `owner_id` 就会泄露别人的记忆，SQLite 没有 PostgreSQL 那样的行级安全策略兜底，只能靠代码和测试。留到用户变多时再做。
- **对陌生人开放注册的 SaaS**：要做注册、计费、配额、防滥用、隐私合规和多台服务器，还要推翻“任何时刻只有一个活动权威”（ADR 0003），粗估 2–3 个月以上（未测量）；陌生人能刷爆模型费用，还能在放着 Andy 私人数据的机器上运行不可信的代码。不做。
- **在产品里重新加预算检查来限额**：要把 ADR 0076 删掉的 `budgets` 配置和准入比较加回来，代码多，而且当初正是这套累计上限把所有对话拦住；Vercel AI Gateway 已经支持按单把 API key 设预算（[文档](https://vercel.com/docs/ai-gateway/observability-and-spend/budgets)：“AI Gateway checks every budget in scope before each request and rejects further requests once a limit is exceeded, until the budget resets or you raise it.”），并支持按月重置和邮件提醒。不采用。
- **登录用内置账号（密码 + 手机验证码）**：合格，产品已有；但验证码不防钓鱼，朋友还要自己绑验证器。作为备选。
- **登录用 Tailscale 私有网络共享**：不暴露到公网；但每个客人都要有自己的 Tailscale 账号并安装客户端，对家人朋友太麻烦。不采用。

[↑ 返回阅读导航](#contents)

<a id="consequences"></a>

## 后果

- 好处：老婆和朋友的数据与 Andy 的数据在文件和进程层面分开；方向和登录方式定下来，开工时不用再讨论；数据库已有的 `owner_id` 让以后改成 pool 比从头做容易。
- 代价：Andy 自己的实例也多了一个经 Cloudflare 的对外入口。生产机要多跑几份服务，磁盘余量本来就紧（第十一次上线曾因只剩 10.5 GB 停下），开第二个实例前要先核算内存和磁盘；生产机多一个经 Cloudflare 的对外入口。
- 未验证：两个实例在同一台机器上的端口、沙箱目录、系统账号能否互不冲突。上线和回滚脚本已经从操作包读取服务名和 stateRoot（`scripts/delivery-mode/`），但生成操作包的工具在 Mac 的 `.ci-output` 里，没有核对。
- 后续：实现工作记在 Backlog 项 [BL-20261026-003](../backlog/BL-20261026-003-isolated-instance-per-person.md)；PRD v0.2 和架构文档在实现时再改，因为每个实例仍是单一主人，现有描述目前没有说错。

[↑ 返回阅读导航](#contents)

<a id="references"></a>

## 关联文档

- [SOURCE: docs/adr/0081-isolated-instance-per-person.md]
- [SOURCE: docs/adr/0082-mobile-pwa-push-before-native-app.md]
- [SOURCE: docs/ideas/IDEA-20261026-001-per-person-isolated-himawari.md]
- [SOURCE: docs/backlog/BL-20261026-003-isolated-instance-per-person.md]
- [SOURCE: docs/engineering-casebook.md#case-multi-user]
- [SOURCE: docs/adr/0069-trust-unprotected-runtime-like-claude-code.md]
- [SOURCE: docs/adr/0076-no-model-cost-budget-limits.md]
- 评估文档：<https://claude.ai/artifact/77cUajUv5MWWHHMH8m2g1N>

[↑ 返回阅读导航](#contents)
